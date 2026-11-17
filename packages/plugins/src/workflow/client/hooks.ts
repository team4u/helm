/**
 * Data hooks for the builtin:workflow plugin (sharing the host store, zero
 * private dependencies). models.ts keeps pure functions only; hook
 * dependencies live in this file for index.tsx components to consume.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  useConversation,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
  useSharedNowMs,
} from '@helm/plugin-client'
import { isScrolledToBottom } from './model-format.ts'
import { parseSavedWorkflowList } from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'
import { libListInvalid, runResultInspectFailed } from './copy.ts'

/** Follow streaming output only while the user stays pinned to the bottom; never steal scroll position after scrolling up into history. */
export function useStreamFollow(content: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const onScroll = useCallback(() => {
    if (ref.current !== null) follow.current = isScrolledToBottom(ref.current)
  }, [])
  useEffect(() => {
    if (follow.current && ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight
  }, [content])
  return { ref, onScroll }
}

/** Shared 1Hz stopwatch (SSR first frame returns undefined; client shares a single module-level ticker across all active cards). */
export function useElapsedNowMs(active: boolean): number | undefined {
  return useSharedNowMs(active)
}

/** Workflow library loading state: list action + generation guard (reloads never splice stale responses). */
interface WorkflowLibraryState {
  items: SavedWorkflowView[] | undefined
  error: string | undefined
  loading: boolean
  reload: () => Promise<void>
}

/** Load the saved workflow catalog (list action; strict parsing — structurally invalid fails explicitly, never fabricated). */
export function useWorkflowLibrary(): WorkflowLibraryState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [items, setItems] = useState<SavedWorkflowView[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('list')
      if (generation.current !== current) return
      const parsed = parseSavedWorkflowList(raw)
      if (parsed === undefined) {
        setError(libListInvalid(locale))
      } else {
        setItems(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [ctx, locale])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, error, loading, reload }
}

interface InspectedRunResultState {
  hasResult: boolean
  hasResolvedValue: boolean
  result: unknown
  loading: boolean
  error: string | undefined
}

/**
 * On-demand full result loader for slimmed projected runs (`hasResult: true`
 * with `result: undefined`): calls `inspect` once when expanded and caches per
 * `(run.id, run.updatedAt)` with generation race protection.
 */
export function useInspectedRunResult(
  run: Pick<WorkflowRunSummary, 'id' | 'updatedAt' | 'result' | 'hasResult'>,
  open: boolean,
): InspectedRunResultState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const cacheKey = `${run.id}:${run.updatedAt}`
  const [cached, setCached] = useState<{ key: string; value: unknown } | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const generation = useRef(0)

  const hasInline = run.result !== undefined
  const hasAnyResult = hasInline || run.hasResult === true
  const isCached = cached?.key === cacheKey

  useEffect(() => {
    if (!open || hasInline || run.hasResult !== true || isCached) {
      setLoading(false)
      return
    }
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction('inspect', { runId: run.id })
      .then((raw) => {
        if (generation.current !== current) return
        if (
          raw === null ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          (raw as Record<string, unknown>)['run'] === null ||
          typeof (raw as Record<string, unknown>)['run'] !== 'object' ||
          Array.isArray((raw as Record<string, unknown>)['run'])
        ) {
          setError(runResultInspectFailed('invalid inspect payload', locale))
          return
        }
        const inspectedRun = (raw as { run: Record<string, unknown> }).run
        setCached({ key: cacheKey, value: inspectedRun['result'] })
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(runResultInspectFailed(err instanceof Error ? err.message : String(err), locale))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [open, hasInline, run.hasResult, run.id, cacheKey, isCached, ctx, locale])

  return {
    hasResult: hasAnyResult,
    hasResolvedValue: hasInline || isCached,
    result: hasInline ? run.result : isCached ? cached.value : undefined,
    loading,
    error,
  }
}

export { useConversation, useConversations, usePluginContext, usePluginDoc, usePluginSessionDoc }
