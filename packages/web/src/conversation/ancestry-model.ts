import type { ConversationSummary } from '@helmx/protocol/browser'

/**
 * 会话亲子关系纯函数模型：仅依赖 HelmxStore 的 conversations 摘要列表推导
 * 子树收集，不做任何请求，也不引入平行路由状态。
 */

/** 亲子链防御上限：摘要脏数据（环/超深）时安全截断，绝不递归失控。 */
export const MAX_ANCESTRY_DEPTH = 32

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
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index]!
    for (const child of childrenOf.get(parent) ?? []) {
      if (subtree.has(child)) continue
      subtree.add(child)
      queue.push(child)
    }
  }
  return subtree
}
