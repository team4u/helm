/**
 * composerCompleter 数据源订阅 hook（始终随 Composer 挂载）：
 * - doc / sessionDoc 源：复用宿主既有公开文档与专用 SSE 订阅通道，按需订阅；
 * - action 源：150ms 防抖 + generation 防竞态；调用前核对 store.actions 真实
 *   manifest（存在且 idempotent:true 才放行）；query 携带真实 conversationId；
 * - 浮层关闭 / 切会话 / 停用源 / 换查询：generation 推进，晚到响应一律丢弃；
 * - 逐源错误显式收集（loading / 空态 / 错误可辨），单源失败不影响其他源。
 * 本模块只导出 hook 与纯类型（无组件），保持 .ts Fast Refresh 约定。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComposerCompleterSpec, ComposerCompletionItem, ConversationSummary } from '@helm/protocol'
import { useHelmStore } from '../lib/store-context.js'
import type { QualifiedUiSpec } from '../lib/types.js'
import {
  COMPLETION_QUERY_DEBOUNCE_MS,
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
  /** 源标识（pluginId/specId），逐源显式诊断。 */
  source: string
  message: string
}

export interface CompletionSourceSnapshot {
  /** 当前触发符在会话作用域内是否有注册源（false 时浮层不打开，输入不受拦截）。 */
  hasSources: boolean
  /** 查询过滤后的合并候选（已按 priority 源顺序稳定排列并去重）。 */
  items: MergedCompletionItem[]
  /** 过滤后候选总数（不含合并上限截断）。 */
  total: number
  /** 命中合并上限被截断（浮层需显式提示）。 */
  truncated: boolean
  /** 任一源仍在加载（doc 未到 / sessionDoc 未连 / action 防抖或请求在途）。 */
  loading: boolean
  errors: CompletionSourceError[]
}

const EMPTY_SNAPSHOT: CompletionSourceSnapshot = { hasSources: false, items: [], total: 0, truncated: false, loading: false, errors: [] }

interface ActionSourceState {
  loading: boolean
  /** `${pluginId}/${specId}` -> 合法候选。 */
  results: Record<string, ComposerCompletionItem[]>
  errors: Record<string, string>
}

const ACTION_IDLE: ActionSourceState = { loading: false, results: {}, errors: {} }

interface SessionDocTuple {
  pluginId: string
  docName: string
}

const EMPTY_SESSION_STATES: Array<{ tuple: SessionDocTuple; state: unknown }> = []
const sessionSnapshotCache = new WeakMap<(listener: () => void) => () => void, { keys: string; states: unknown[]; result: typeof EMPTY_SESSION_STATES }>()

type SessionDocSource = QualifiedUiSpec<ComposerCompleterSpec> & { spec: ComposerCompleterSpec & { source: { kind: 'sessionDoc'; name: string; itemsField: string } } }
type ActionSource = QualifiedUiSpec<ComposerCompleterSpec> & { spec: ComposerCompleterSpec & { source: { kind: 'action'; actionId: string; actionPluginId?: string } } }

export interface UseComposerCompletionSourcesInput {
  /** 当前触发 token（null = 浮层关闭，全部源停订、晚响应作废）。 */
  token: CompletionToken | null
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>>
  conversation: ConversationSummary
}

export function useComposerCompletionSources(input: UseComposerCompletionSourcesInput): CompletionSourceSnapshot {
  const { token, completers, conversation } = input
  const store = useHelmStore()
  const trigger = token === null ? null : token.trigger
  const query = token?.query ?? ''
  // '/' 走既有斜杠浮层三源逻辑；本 hook 只服务 '@' '#' ':' 的插件补全源。
  const active = trigger === '@' || trigger === '#' || trigger === ':'

  // ---- 活动源（trigger + scope 过滤，priority 降序稳定）；非活动时恒空数组 ----
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

  // ---- doc 源：按需触发 ensurePluginDoc（值随 store.pluginDocs 渲染期读取） ----
  const { ensurePluginDoc, pluginDocs, loadErrors } = store
  const docKey = useMemo(() => docSources.map((s) => `${s.pluginId}/${(s.spec.source as { name: string }).name}`).join('|'), [docSources])
  useEffect(() => {
    if (docKey === '') return
    for (const src of docSources) {
      const name = (src.spec.source as { name: string }).name
      if (!Object.hasOwn(pluginDocs, `${src.pluginId}/${name}`)) void ensurePluginDoc(src.pluginId, name)
    }
    // 仅依赖键集合与稳定回调；pluginDocs 值更新不重复触发（读取走渲染期）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, ensurePluginDoc, pluginDocs])

  // ---- sessionDoc 源：专用 SSE 通道合并订阅（快照引用稳定） ----
  const tuplesKey = useMemo(() => JSON.stringify(sessionDocSources.map((s) => ({ pluginId: s.pluginId, docName: s.spec.source.name }))), [sessionDocSources])
  const { subscribeSessionDoc, getSessionDocState } = store
  const subscribeSession = useCallback(
    (listener: () => void) => {
      const list = JSON.parse(tuplesKey) as SessionDocTuple[]
      if (list.length === 0) return () => {}
      const offs = list.map((t) => subscribeSessionDoc({ ...t, conversationId: conversation.id }, listener))
      return () => { for (const off of offs) off() }
    },
    [tuplesKey, conversation.id, subscribeSessionDoc],
  )
  const getSnapshot = useCallback(() => {
    const list = JSON.parse(tuplesKey) as SessionDocTuple[]
    if (list.length === 0) return EMPTY_SESSION_STATES
    const states = list.map((t) => getSessionDocState({ ...t, conversationId: conversation.id }))
    const cached = sessionSnapshotCache.get(subscribeSession)
    if (cached !== undefined && cached.keys === tuplesKey && states.every((s, i) => s === cached.states[i])) {
      return cached.result
    }
    const result = list.map((t, i) => ({ tuple: t, state: states[i] }))
    sessionSnapshotCache.set(subscribeSession, { keys: tuplesKey, states, result })
    return result
  }, [tuplesKey, conversation.id, getSessionDocState, subscribeSession])
  const sessionStates = useSyncExternalStore(subscribeSession, getSnapshot, () => EMPTY_SESSION_STATES)

  // ---- action 源：防抖 + generation 防竞态 ----
  const [actionState, setActionState] = useState<ActionSourceState>(ACTION_IDLE)
  const actionGeneration = useRef(0)
  const { invokePluginAction } = store
  const actions = store.actions
  useEffect(() => {
    const generation = ++actionGeneration.current
    if (sourceKey === '' || actionSources.length === 0) {
      setActionState(ACTION_IDLE)
      return
    }
    // 调用前核对真实 manifest：未注册或未声明 idempotent:true 一律拒绝（前端不伪造 nodeId/cwd）。
    const manifestErrors: Record<string, string> = {}
    for (const src of actionSources) {
      const target = src.spec.source.actionPluginId ?? src.pluginId
      const invalid = verifyCompletionActionManifest(actions, target, src.spec.source.actionId)
      if (invalid !== null) manifestErrors[`${src.pluginId}/${src.spec.id}`] = invalid
    }
    if (Object.keys(manifestErrors).length > 0) {
      setActionState({ loading: false, results: {}, errors: manifestErrors })
      return
    }
    setActionState((prev) => ({ loading: true, results: prev.results, errors: {} }))
    const timer = setTimeout(() => {
      void Promise.allSettled(
        actionSources.map((src) => {
          const target = src.spec.source.actionPluginId ?? src.pluginId
          return invokePluginAction(target, src.spec.source.actionId, { query, conversationId: conversation.id }, conversation.id)
        }),
      ).then((settled) => {
        if (generation !== actionGeneration.current) return
        const results: Record<string, ComposerCompletionItem[]> = {}
        const errors: Record<string, string> = {}
        settled.forEach((entry, index) => {
          const src = actionSources[index]!
          const key = `${src.pluginId}/${src.spec.id}`
          if (entry.status === 'rejected') {
            errors[key] = entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
            return
          }
          const parsed = parseCompletionActionResult(entry.value)
          if (parsed.items === null) errors[key] = parsed.error ?? '补全动作返回无效'
          else results[key] = parsed.items
        })
        setActionState({ loading: false, results, errors })
      })
    }, COMPLETION_QUERY_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      // generation 已由下一次 effect 推进；清理只停本定时器。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, query, conversation.id, invokePluginAction, actions, actionSources])

  // ---- 合并（渲染期纯计算）：各插件源按 priority 源顺序 ----
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
        const extracted = extractCompletionItems(pluginDocs[key], source.itemsField)
        if (extracted.error !== undefined) errors.push({ source: label, message: extracted.error })
        if (extracted.items !== null) groups.push({ pluginId: src.pluginId, items: filterByQuery(extracted.items, query) })
      } else {
        const loadError = loadErrors[`doc:${key}`]
        if (loadError !== undefined) errors.push({ source: label, message: `文档读取失败：${loadError}` })
        else loading = true
      }
    }

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
      const extracted = extractCompletionItems(state.value, itemsFieldOf(sessionDocSources, entry.tuple))
      if (extracted.error !== undefined) errors.push({ source: label, message: extracted.error })
      if (extracted.items !== null) groups.push({ pluginId: entry.tuple.pluginId, items: filterByQuery(extracted.items, query) })
    }

    for (const src of actionSources) {
      const key = `${src.pluginId}/${src.spec.id}`
      const error = actionState.errors[key]
      if (error !== undefined) {
        errors.push({ source: key, message: error })
        continue
      }
      const items = actionState.results[key]
      if (items !== undefined) {
        // 服务端已按 query 过滤，客户端不重复过滤（保留服务端模糊/拼音匹配语义）。
        groups.push({ pluginId: src.pluginId, items })
      } else if (actionState.loading) {
        loading = true
      }
    }

    const merged = mergeCompletionItems(groups)
    return { hasSources: sources.length > 0, items: merged.items, total: merged.total, truncated: merged.truncated, loading, errors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active, query, docSources, sessionDocSources, actionSources, pluginDocs, loadErrors, sessionStates, actionState])
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
