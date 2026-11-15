/**
 * builtin:workflow 插件 client 纯逻辑：统一执行树的节点展示摘要——标题、
 * 紧凑行总耗时解析、前线活动与后代审批摘要（零 React/DOM 依赖）。
 */
import type { ExecutionNode } from './model-execution-tree.ts'
import { compactCardTitle } from './model-subagent-card.ts'
import { firstLineOf } from './model-format.ts'
import { resolveNodeElapsedMs, resolveRunElapsedMs } from './model-run.ts'

/**
 * 执行树紧凑行总耗时：优先 runNode 真实边界（running 用 startedAt + nowMs
 * 动态推进、结算用 durationMs 定格）；无 runNode 的容器行（深层 workflow /
 * external）与会话行携带的后台 run 用 run 边界；纯会话节点无本轮可靠起点
 * （会话 createdAt 不是本轮边界）时返回 undefined，不伪造。
 */
export function resolveExecutionNodeElapsedMs(
  node: Pick<ExecutionNode, 'run' | 'runNode'>,
  nowMs?: number,
): number | undefined {
  if (node.runNode !== undefined) return resolveNodeElapsedMs(node.runNode, nowMs)
  if (node.run !== undefined) return resolveRunElapsedMs(node.run, nowMs)
  return undefined
}

/** 节点展示标题：用户标题 > run 节点 label / prompt > 会话与 run 兜底描述（不虚构）。 */
export function executionNodeTitle(node: ExecutionNode): string {
  const label = node.label ?? node.runNode?.label
  if (node.kind === 'conversation') {
    const custom = compactCardTitle(node.summary?.title, node.conversationId ?? 0)
    if (custom !== undefined) return custom
    if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') return firstLineOf(label, 60)
    const prompt = node.runNode?.prompt
    if (prompt !== undefined && prompt.trim() !== '') return firstLineOf(prompt, 60)
    return `子会话 #${node.conversationId}`
  }
  if (label !== undefined && label.trim() !== '') return firstLineOf(label, 60)
  return node.run?.name ?? '外部执行'
}

/** 前线活动条目：子树内正在执行节点的单行摘要。 */
export interface ExecutionFrontlineItem {
  key: string
  conversationId?: number
  text: string
}

function executionFrontlineText(node: ExecutionNode, hasDeeper: boolean): string | undefined {
  if (node.status !== 'working') return undefined
  if (node.kind === 'conversation') {
    const doing = node.summary?.doing?.trim()
    if (doing !== undefined && doing !== '') return `#${node.conversationId} ${doing}`
    // 无自身 doing 且子树已有更深前线：不再以兑底文案重复占位（父级等待状态不抢占）
    return hasDeeper ? undefined : `#${node.conversationId} 执行中`
  }
  // 容器（workflow / external run）的自身执行即其子节点：子树已有更深前线时跳过
  return hasDeeper ? undefined : `${node.runNode?.label ?? node.label ?? node.run?.name ?? node.key} 执行中`
}

/**
 * 前线活动摘要：后序深度优先（最深活跃前线优先），至多 limit 条；同一节点
 * key 只收集一次（多历史引用不重复）。自身实际工作（doing）保留在更深前线之后。
 */
export function collectExecutionFrontline(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 2,
): ExecutionFrontlineItem[] {
  const items: ExecutionFrontlineItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      const before = items.length
      visit(node.children)
      if (items.length >= limit) return
      if (seen.has(node.key)) continue
      const text = executionFrontlineText(node, items.length > before)
      if (text !== undefined) {
        seen.add(node.key)
        items.push({
          key: node.key,
          text,
          ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
        })
      }
    }
  }
  visit(nodes)
  return items
}

/** 后代审批条目（pendingAsk 标题不在会话列表数据中，仅以会话标识如实呈现）。 */
export interface ExecutionApprovalItem {
  key: string
  conversationId?: number
  text: string
}

/**
 * 后代审批摘要：子树内 blocked 会话节点（pendingAskCount>0 或 status=blocked，
 * 均在构树叶状态中归一为 blocked），至多 limit 条；同一节点 key 不重复。
 */
export function collectExecutionApprovals(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 3,
): ExecutionApprovalItem[] {
  const items: ExecutionApprovalItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      if (
        node.status === 'blocked' && node.kind === 'conversation' && node.conversationId !== undefined &&
        !seen.has(node.key)
      ) {
        seen.add(node.key)
        const title = compactCardTitle(node.summary?.title, node.conversationId)
        items.push({
          key: node.key,
          conversationId: node.conversationId,
          text: title !== undefined ? `#${node.conversationId} ${title}` : `#${node.conversationId} 等待审批`,
        })
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return items
}
