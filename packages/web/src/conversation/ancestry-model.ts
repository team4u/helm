import type { ConversationSummary } from '@helm/protocol'

/**
 * 会话祖谱纯函数模型：仅依赖 HelmStore 的 conversations 摘要列表推导
 * 父链与子树，不做任何请求，也不引入平行路由状态。
 */

/** 父链防御上限：摘要脏数据（环/超深）时安全截断，绝不递归失控。 */
export const MAX_ANCESTRY_DEPTH = 32

/**
 * 沿 parentConversationId 向上构建祖先链（根在前、直接父级在尾，不含自身）。
 * 父摘要缺失时仍保留该级 ID（可渲染 #id 胶囊）；环与超深安全截断。
 * seed 允许调用方补种当前会话摘要（如仅加载到 detail 的场景）。
 */
export function buildAncestorChain(
  conversations: ConversationSummary[],
  conversationId: number,
  seed?: ConversationSummary,
): number[] {
  const byId = new Map<number, ConversationSummary>()
  for (const conv of conversations) {
    if (!byId.has(conv.id)) byId.set(conv.id, conv)
  }
  if (seed !== undefined && !byId.has(seed.id)) byId.set(seed.id, seed)

  const chain: number[] = []
  const visited = new Set<number>([conversationId])
  let current = byId.get(conversationId)
  while (current !== undefined && current.parentConversationId !== undefined && chain.length < MAX_ANCESTRY_DEPTH) {
    const parentId = current.parentConversationId
    if (visited.has(parentId)) break
    visited.add(parentId)
    chain.push(parentId)
    current = byId.get(parentId)
  }
  // 上行收集为「最近祖先在前」；统一反转为根在前，与面包屑渲染顺序一致。
  chain.reverse()
  return chain
}

/**
 * 收集 conversationId 及其全部后代 ID（含自身），供 AskDock 聚合
 * 「当前会话 + 后代会话」的 pending asks；环防御，重复父子边只访问一次。
 */
export function collectSubtreeIds(conversations: ConversationSummary[], conversationId: number): Set<number> {
  const childrenOf = new Map<number, number[]>()
  for (const conv of conversations) {
    if (conv.parentConversationId === undefined) continue
    const siblings = childrenOf.get(conv.parentConversationId)
    if (siblings === undefined) childrenOf.set(conv.parentConversationId, [conv.id])
    else siblings.push(conv.id)
  }
  const subtree = new Set<number>([conversationId])
  const queue = [conversationId]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of childrenOf.get(parent) ?? []) {
      if (subtree.has(child)) continue
      subtree.add(child)
      queue.push(child)
    }
  }
  return subtree
}
