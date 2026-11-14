import {
  HelmError,
  type ConversationEntry,
  type TurnOutcome,
} from '@helm/protocol'
import {
  RECALL_DOC_NAME,
  SUPERAGENT_PLUGIN_ID,
  isFiniteTime,
  isPlainObject,
  isPosIntId,
  type RecallGraphDoc,
} from './contracts.js'

export const SETTLED_OUTCOMES = new Set(['completed', 'failed', 'aborted'])

export const RECALL_ARTIFACT_KEYS = ['id', 'conversationId', 'name', 'path', 'mimeType', 'size', 'createdAt'] as const

export function assertRecallDoc(value: unknown): void {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.nodes)) {
    throw new HelmError(
      'superagent_doc_corrupt',
      `插件 doc ${RECALL_DOC_NAME} 结构非法（期望 { version: 1, nodes: [] }）`,
      500,
      { pluginId: SUPERAGENT_PLUGIN_ID },
    )
  }
  const seenIds = new Set<string>()
  for (const n of value.nodes) {
    if (
      !isPlainObject(n) ||
      typeof n.id !== 'string' ||
      n.id === '' ||
      !isPosIntId(n.conversationId) ||
      typeof n.profileId !== 'string' ||
      n.profileId.trim() === '' ||
      typeof n.completionSeq !== 'number' ||
      !Number.isInteger(n.completionSeq) ||
      n.completionSeq < 0 ||
      !Array.isArray(n.inputIds) ||
      n.inputIds.length === 0 ||
      n.inputIds.some((v) => typeof v !== 'string' || v === '') ||
      new Set(n.inputIds).size !== n.inputIds.length ||
      typeof n.outcome !== 'string' ||
      !SETTLED_OUTCOMES.has(n.outcome) ||
      typeof n.summary !== 'string' ||
      !Array.isArray(n.keywords) ||
      n.keywords.some((k) => typeof k !== 'string') ||
      !isFiniteTime(n.createdAt) ||
      !Array.isArray(n.artifacts) ||
      n.artifacts.some((a) => {
        if (!isPlainObject(a)) return true
        for (const key of RECALL_ARTIFACT_KEYS) {
          if (!Object.hasOwn(a, key)) return true
        }
        return (
          typeof a.id !== 'string' ||
          !isPosIntId(a.conversationId) ||
          typeof a.name !== 'string' ||
          typeof a.path !== 'string' ||
          typeof a.mimeType !== 'string' ||
          typeof a.size !== 'number' ||
          !Number.isFinite(a.size) ||
          a.size < 0 ||
          !isFiniteTime(a.createdAt)
        )
      })
    ) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${RECALL_DOC_NAME}.nodes 含非法节点（期望 RecallNode 真实契约）`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    if (seenIds.has(n.id)) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${RECALL_DOC_NAME}.nodes 重复节点 id '${n.id}'`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    seenIds.add(n.id)
  }
}

/** helm.rewind 截断标记携带的被覆盖输入 ID（omittedInputIds）；载荷非法返回 undefined。 */
export function rewindOmittedInputIds(entry: ConversationEntry): string[] | undefined {
  if (entry.kind !== 'helm.rewind') return undefined
  const data = entry.data as { omittedInputIds?: unknown } | undefined
  const raw = data?.omittedInputIds
  if (!Array.isArray(raw)) return undefined
  const ids: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || v === '') return undefined
    ids.push(v)
  }
  return ids
}

/**
 * 从 RecallGraph 删除指定会话中 inputIds 与给定集合相交的节点（原地 doc 写回）。
 * 返回被删除的节点 ID（供诊断与测试断言）；doc 无相交节点时零写回。
 */
export function removeRecallNodesByInputs(
  handle: { get(): unknown; set(value: unknown): void },
  conversationId: number,
  omittedInputIds: ReadonlySet<string>,
): string[] {
  if (omittedInputIds.size === 0) return []
  const doc = handle.get()
  assertRecallDoc(doc)
  const nodes = (doc as RecallGraphDoc).nodes
  const removed: string[] = []
  const kept = nodes.filter((n) => {
    if (n.conversationId !== conversationId) return true
    const hit = n.inputIds.some((id) => omittedInputIds.has(id))
    if (hit) removed.push(n.id)
    return !hit
  })
  if (removed.length > 0) handle.set({ version: 1, nodes: kept })
  return removed
}

/** recall doc 是否已含指定节点 ID（读入即验证）。 */
export function recallHasNode(docRaw: unknown, nodeId: string): boolean {
  assertRecallDoc(docRaw)
  return (docRaw as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id === nodeId)
}

/** updateRecallDoc 输入：RecallNode 的结构化形状（不要求索引签名）。 */
export interface RecallNodeInput {
  id: string
  conversationId: number
  profileId: string
  completionSeq: number
  inputIds: string[]
  outcome: TurnOutcome | string
  summary: string
  artifacts: unknown[]
  keywords: string[]
  createdAt: number
}

/** 去重写入：同 id 节点已存在返回 false（不重复追加）；写入时复查防并发。 */
export function updateRecallDoc(
  handle: { get(): unknown; set(value: unknown): void },
  node: RecallNodeInput,
): boolean {
  const doc = handle.get()
  assertRecallDoc(doc)
  if (!SETTLED_OUTCOMES.has(node.outcome)) {
    throw new HelmError('validation_error', `outcome 必须是 completed|failed|aborted（收到 ${node.outcome}）`, 400, {})
  }
  const current = doc as { version: 1; nodes: Array<{ id: string }> }
  if (current.nodes.some((n) => n.id === node.id)) return false
  // 写入前对产物节点整体校验：破损节点在边界显式拒绝，绝不落库读不回的数据。
  assertRecallDoc({ version: 1, nodes: [...current.nodes, node] })
  handle.set({ version: 1, nodes: [...current.nodes, node] })
  return true
}

/** 关键词检索：query 分词（空白/逗号），全部命中（AND）才返回；倒序（新在前）。 */
export function searchRecallNodes(docRaw: unknown, query: string, limit: number): unknown[] {
  assertRecallDoc(docRaw)
  const nodes = (docRaw as { nodes: unknown[] }).nodes
  const terms = query.split(/[\s,]+/).filter((t) => t !== '')
  const matched =
    terms.length === 0
      ? nodes
      : nodes.filter((n) => {
          const node = n as { id?: string; profileId?: string; summary?: string; keywords?: string[] }
          const haystack = [node.id ?? '', node.profileId ?? '', node.summary ?? '', ...(node.keywords ?? [])]
            .join('\n')
            .toLowerCase()
          return terms.every((t) => haystack.includes(t.toLowerCase()))
        })
  return matched.slice(-limit).reverse()
}
