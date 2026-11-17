/**
 * composerCompleter source subscription hook (always mounted with the Composer):
 * - doc / sessionDoc sources: reuse the host's existing public docs and the
 *   dedicated SSE subscription channels, subscribing on demand;
 * - action sources: 150ms debounce + generation race guard; the real manifest
 *   in store.actions is verified before invoking (present and idempotent:true
 *   to pass); the query carries the real conversationId;
 * - popover closed / conversation switched / source disabled / query changed:
 *   the generation advances and late responses are always discarded;
 * - per-source errors are collected explicitly (loading / empty / error stay
 *   distinguishable); one failing source never affects the others.
 * This module exports only hooks and pure types (no components), honoring the
 * .ts Fast Refresh rule.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComposerCompleterSpec, ComposerCompletionItem, ConversationSummary } from '@helm/protocol/browser'
import {
  useCatalogActions,
  useLoadErrorsMap,
  usePluginDocsState,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { QualifiedUiSpec } from '../lib/types.js'
import {
  COMPLETION_QUERY_DEBOUNCE_MS,
  buildCompletionActionCall,
  completersForTrigger,
  extractCompletionItems,
  filterByQuery,
  mergeCompletionItems,
  parseCompletionActionResult,
  verifyCompletionActionManifest,
  type CompletionToken,
  type MergedCompletionItem,
} from './composer-completion-model.js'

export interface CompletionSourceError {
  /** Source identifier (pluginId/specId) for explicit per-source diagnosis. */
  source: string
  message: string
}

export interface CompletionSourceSnapshot {
  /** Whether the current trigger has registered sources in the conversation
   * scope (false: the popover stays closed, input is never intercepted). */
  hasSources: boolean
  /** Query-filtered merged candidates (stably ordered by source priority and
   * deduplicated). */
  items: MergedCompletionItem[]
  /** Filtered candidate total (excluding the merge-cap truncation). */
  total: number
  /** Hit the merge cap and was truncated (the popover must say so). */
  truncated: boolean
  /** Any source still loading (doc not arrived / sessionDoc not connected /
   * action debouncing or request in flight). */
  loading: boolean
  errors: CompletionSourceError[]
}

const EMPTY_SNAPSHOT: CompletionSourceSnapshot = { hasSources: false, items: [], total: 0, truncated: false, loading: false, errors: [] }

interface ActionSourceState {
  loading: boolean
  contextKey: string
  /** `${pluginId}/${specId}` -> valid candidates. */
  results: Record<string, ComposerCompletionItem[]>
  errors: Record<string, string>
}

const ACTION_IDLE: ActionSourceState = { loading: false, contextKey: '', results: {}, errors: {} }

interface SessionDocTuple {
  pluginId: string
  docName: string
}

const EMPTY_SESSION_STATES: Array<{ tuple: SessionDocTuple; state: unknown }> = []
const sessionSnapshotCache = new WeakMap<(listener: () => void) => () => void, { keys: string; states: unknown[]; result: typeof EMPTY_SESSION_STATES }>()

type SessionDocSource = QualifiedUiSpec<ComposerCompleterSpec> & { spec: ComposerCompleterSpec & { source: { kind: 'sessionDoc'; name: string; itemsField: string } } }
type ActionSource = QualifiedUiSpec<ComposerCompleterSpec> & { spec: ComposerCompleterSpec & { source: { kind: 'action'; actionId: string; actionPluginId?: string } } }

export interface UseComposerCompletionSourcesInput {
  /** Current trigger token (null = popover closed: all sources unsubscribed,
   * late responses void). */
  token: CompletionToken | null
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>>
  conversation?: ConversationSummary
  /** Used by profileId-capable action sources when no conversation exists
   * (standby draft state). */
  profileId?: string
}

export function useComposerCompletionSources(input: UseComposerCompletionSourcesInput): CompletionSourceSnapshot {
  const { token, completers, conversation, profileId } = input
  const conversationId = conversation?.id
  const contextKey = `${conversationId ?? ''}:${profileId ?? ''}`
  const pluginDocs = usePluginDocsState()
  const loadErrors = useLoadErrorsMap()
  const actions = useCatalogActions()
  const {
    ensurePluginDoc,
    subscribeSessionDoc,
    getSessionDocState,
    invokePluginAction,
  } = useStoreActions()
  const { t } = useWebLocale()
  const trigger = token === null ? null : token.trigger
  const query = token?.query ?? ''
  // '/' goes through the existing slash popover's three-source logic; this
  // hook only serves the '@' '#' ':' plugin completion sources.
  const active = trigger === '@' || trigger === '#' || trigger === ':'

  // ---- Active sources (trigger + scope filter, stable priority desc); a
  // constant empty array while inactive ----
  const sources = useMemo(
    () => (active && trigger !== null ? completersForTrigger(completers, trigger, conversation) : []),
    [active, trigger, completers, conversation],
  )
  const sourceKey = useMemo(
    () => sources.map((s) => `${s.pluginId}/${s.spec.id}:${JSON.stringify(s.spec.source)}`).join('|'),
    [sources],
  )
  const docSources = useMemo(() => sources.filter((s) => s.spec.source.kind === 'doc'), [sources])
  const sessionDocSources = useMemo(
    () => sources.filter((s) => s.spec.source.kind === 'sessionDoc') as SessionDocSource[],
    [sources],
  )
  const actionSources = useMemo(
    () => sources.filter((s) => s.spec.source.kind === 'action') as ActionSource[],
    [sources],
  )

  // ---- doc sources: trigger ensurePluginDoc on demand (values are read at
  // render time from pluginDocs) ----
  const docKey = useMemo(() => docSources.map((s) => `${s.pluginId}/${(s.spec.source as { name: string }).name}`).join('|'), [docSources])
  useEffect(() => {
    if (docKey === '') return
    for (const src of docSources) {
      const name = (src.spec.source as { name: string }).name
      if (!Object.hasOwn(pluginDocs, `${src.pluginId}/${name}`)) void ensurePluginDoc(src.pluginId, name)
    }
    // Only the key set and stable callbacks are deps; pluginDocs value updates
    // never re-trigger (values are read at render time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, ensurePluginDoc, pluginDocs])

  // ---- sessionDoc sources: dedicated SSE channel merged subscription
  // (stable snapshot identity; never subscribed without a conversation) ----
  const tuplesKey = useMemo(() => JSON.stringify(sessionDocSources.map((s) => ({ pluginId: s.pluginId, docName: s.spec.source.name }))), [sessionDocSources])
  const subscribeSession = useCallback(
    (listener: () => void) => {
      const list = JSON.parse(tuplesKey) as SessionDocTuple[]
      if (list.length === 0 || conversationId === undefined) return () => {}
      const offs = list.map((t) => subscribeSessionDoc({ ...t, conversationId }, listener))
      return () => { for (const off of offs) off() }
    },
    [tuplesKey, conversationId, subscribeSessionDoc],
  )
  const getSnapshot = useCallback(() => {
    const list = JSON.parse(tuplesKey) as SessionDocTuple[]
    if (list.length === 0 || conversationId === undefined) return EMPTY_SESSION_STATES
    const states = list.map((t) => getSessionDocState({ ...t, conversationId }))
    const cached = sessionSnapshotCache.get(subscribeSession)
    if (cached !== undefined && cached.keys === tuplesKey && states.every((s, i) => s === cached.states[i])) {
      return cached.result
    }
    const result = list.map((t, i) => ({ tuple: t, state: states[i] }))
    sessionSnapshotCache.set(subscribeSession, { keys: tuplesKey, states, result })
    return result
  }, [tuplesKey, conversationId, getSessionDocState, subscribeSession])
  const sessionStates = useSyncExternalStore(subscribeSession, getSnapshot, () => EMPTY_SESSION_STATES)

  // ---- action sources: debounce + generation race guard ----
  const [actionState, setActionState] = useState<ActionSourceState>(ACTION_IDLE)
  const actionGeneration = useRef(0)
  useEffect(() => {
    const generation = ++actionGeneration.current
    if (sourceKey === '' || actionSources.length === 0) {
      setActionState(ACTION_IDLE)
      return
    }
    // Verify the real manifest and the input plan before invoking (unregistered
    // / non-idempotent / conversation-required without one are all rejected
    // explicitly).
    const manifestErrors: Record<string, string> = {}
    const runnable: Array<{
      src: ActionSource
      target: string
      key: string
      input: Record<string, unknown>
      conversationId?: number
    }> = []
    for (const src of actionSources) {
      const target = src.spec.source.actionPluginId ?? src.pluginId
      const key = `${src.pluginId}/${src.spec.id}`
      const invalid = verifyCompletionActionManifest(actions, target, src.spec.source.actionId, t)
      if (invalid !== null) {
        manifestErrors[key] = invalid
        continue
      }
      const manifest = actions.find((a) => a.pluginId === target && a.id === src.spec.source.actionId)!
      const plan = buildCompletionActionCall(manifest, query, { conversationId, profileId }, t)
      if (plan.input === null) {
        manifestErrors[key] = plan.error ?? t('composer.completion.fallbackUnsupported')
        continue
      }
      runnable.push({
        src,
        target,
        key,
        input: plan.input,
        ...(plan.conversationId !== undefined ? { conversationId: plan.conversationId } : {}),
      })
    }
    if (runnable.length === 0) {
      setActionState({ loading: false, contextKey, results: {}, errors: manifestErrors })
      return
    }
    setActionState((prev) => ({
      loading: true,
      contextKey,
      results: prev.contextKey === contextKey ? prev.results : {},
      errors: manifestErrors,
    }))
    const timer = setTimeout(() => {
      void Promise.allSettled(
        runnable.map((entry) =>
          invokePluginAction(entry.target, entry.src.spec.source.actionId, entry.input, entry.conversationId),
        ),
      ).then((settled) => {
        if (generation !== actionGeneration.current) return
        const results: Record<string, ComposerCompletionItem[]> = {}
        const errors: Record<string, string> = { ...manifestErrors }
        settled.forEach((entry, index) => {
          const item = runnable[index]!
          if (entry.status === 'rejected') {
            errors[item.key] = entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
            return
          }
          const parsed = parseCompletionActionResult(entry.value, t)
          if (parsed.items === null) errors[item.key] = parsed.error ?? t('composer.completion.fallbackInvalidResult')
          else results[item.key] = parsed.items
        })
        setActionState({ loading: false, contextKey, results, errors })
      })
    }, COMPLETION_QUERY_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      // The generation has already been advanced by the next effect run; this
      // cleanup only stops this timer.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, query, contextKey, conversationId, profileId, invokePluginAction, actions, actionSources, t])

  // ---- Merge (pure render-time computation): plugin sources in priority order ----
  return useMemo(() => {
    if (token === null || !active) return EMPTY_SNAPSHOT
    const groups: Array<{ pluginId: string; items: ComposerCompletionItem[] | null }> = []
    const errors: CompletionSourceError[] = []
    let loading = false

    for (const src of docSources) {
      const source = src.spec.source as { kind: 'doc'; name: string; itemsField: string }
      const key = `${src.pluginId}/${source.name}`
      const label = `${src.pluginId}/${src.spec.id}`
      if (Object.hasOwn(pluginDocs, key)) {
        const extracted = extractCompletionItems(pluginDocs[key], source.itemsField, t)
        if (extracted.error !== undefined) errors.push({ source: label, message: extracted.error })
        if (extracted.items !== null) groups.push({ pluginId: src.pluginId, items: filterByQuery(extracted.items, query) })
      } else {
        const loadError = loadErrors[`doc:${key}`]
        if (loadError !== undefined) errors.push({ source: label, message: t('composer.completion.docLoadFailed', { error: loadError }) })
        else loading = true
      }
    }

    if (conversationId === undefined) {
      for (const src of sessionDocSources) {
        errors.push({
          source: `${src.pluginId}/${src.spec.id}`,
          message: t('composer.completion.sessionDocNeedsConversation'),
        })
      }
    } else {
      for (const entry of sessionStates) {
        const label = `${entry.tuple.pluginId}/${entry.tuple.docName}`
        const state = entry.state as { value?: unknown; hasValue: boolean; error?: string }
        if (state.error !== undefined) {
          errors.push({ source: label, message: state.error })
          continue
        }
        if (!state.hasValue) {
          loading = true
          continue
        }
        const extracted = extractCompletionItems(state.value, itemsFieldOf(sessionDocSources, entry.tuple), t)
        if (extracted.error !== undefined) errors.push({ source: label, message: extracted.error })
        if (extracted.items !== null) groups.push({ pluginId: entry.tuple.pluginId, items: filterByQuery(extracted.items, query) })
      }
    }

    for (const src of actionSources) {
      const key = `${src.pluginId}/${src.spec.id}`
      const error = actionState.errors[key]
      if (error !== undefined) {
        errors.push({ source: key, message: error })
        continue
      }
      const items = actionState.contextKey === contextKey ? actionState.results[key] : undefined
      if (items !== undefined) {
        // The server already filtered by query; the client does not filter
        // again (preserving server-side fuzzy / pinyin matching semantics).
        groups.push({ pluginId: src.pluginId, items })
      } else if (actionState.loading) {
        loading = true
      }
    }

    const merged = mergeCompletionItems(groups)
    return { hasSources: sources.length > 0, items: merged.items, total: merged.total, truncated: merged.truncated, loading, errors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active, query, conversationId, contextKey, docSources, sessionDocSources, actionSources, pluginDocs, loadErrors, sessionStates, actionState, t])
}

function itemsFieldOf(
  sources: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>>,
  tuple: SessionDocTuple,
): string {
  for (const src of sources) {
    const source = src.spec.source as { kind: string; name: string; itemsField?: string }
    if (source.kind === 'sessionDoc' && src.pluginId === tuple.pluginId && source.name === tuple.docName) {
      return source.itemsField ?? ''
    }
  }
  return ''
}
