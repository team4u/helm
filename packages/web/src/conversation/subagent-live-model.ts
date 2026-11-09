import type { WorkflowRunSummary } from '@helm/protocol'
import type { ToolTraceStatus } from './timeline-model.js'

/** 子会话卡片状态：优先真实 summary.status，无 summary 再退回父工具 toolStatus。 */
export type SubagentCardStatus = 'working' | 'blocked' | 'error' | 'done' | 'pending'

export interface SubagentBadge {
  status: SubagentCardStatus
  label: string
  badge: string
}

/** SubagentLiveCard 属性（纯类型放 .ts 模块，.tsx 组件文件只导出组件以保 Fast Refresh）。 */
export interface SubagentLiveCardProps {
  childConversationId: number
  toolStatus: ToolTraceStatus
  /** background: true 派生的后台工作流 run：工具行返回句柄后，真实执行态以 run 为准。 */
  backgroundRun?: WorkflowRunSummary
  /** 关联的隔离工作树；缺省时卡片回退 backgroundRun 节点上的 worktree。 */
  worktree?: { path: string; branch: string }
  /** 初始是否展开实时流（时间线默认 true；工作台总览默认仅 working 时展开，折叠态按需懒加载详情）。 */
  defaultExpanded?: boolean
  /** 点击“进入会话 / 并排查看”后的附加回调（例如工作台窄屏抽屉自动收起）。 */
  onNavigate?: () => void
}

/**
 * 卡片徽章状态：实时跟随子会话自身最新状态（summary.status），
 * 无 summary 时才以父工具 toolStatus 兜底；background: true 的 subagent
 * 工具行会立即返回句柄（toolStatus=done、子会话暂 idle），此后台 run
 * 的状态必须参与判定——run 仍在 running 时绝不提前显示“已完成”；
 * run failed/aborted 不得被子会话旧 idle 覆盖，blocked 按真实审批优先。
 */
export function subagentBadge(
  summaryStatus: string | undefined,
  toolStatus: ToolTraceStatus,
  backgroundRunStatus?: WorkflowRunSummary['status'],
): SubagentBadge {
  if (summaryStatus === 'blocked') return { status: 'blocked', label: '等待审批', badge: 'badge-warn' }
  if (summaryStatus === 'working') {
    return {
      status: 'working',
      label: backgroundRunStatus !== undefined ? '后台执行中' : '执行中',
      badge: 'badge-accent',
    }
  }
  // 关键：后台 run 仍在 running（如 gate 验收命令执行期、后台子会话刚启动）
  // 而子会话 summary 尚为 idle/done/undefined 时，绝不假完成。
  if (
    backgroundRunStatus === 'running' &&
    (summaryStatus === 'idle' || summaryStatus === 'done' || summaryStatus === undefined)
  ) {
    return { status: 'working', label: '后台运行中', badge: 'badge-accent' }
  }
  if (backgroundRunStatus === 'failed') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (backgroundRunStatus === 'aborted') return { status: 'error', label: '已中止', badge: 'badge-warn' }
  if (summaryStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (summaryStatus === 'done' || summaryStatus === 'idle') {
    // 子会话已 idle/done 但父工具行仍 running（前台 gate 验收 / 结构化输出
    // 修复期）：同一契约不假完成；仅父工具自身终态才显示完成/失败。
    if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
    if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
    return { status: 'done', label: '已完成', badge: 'badge-ok' }
  }
  // 无 summary（尚未出现在会话列表）：退回父工具状态。
  if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
  if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (toolStatus === 'done') return { status: 'done', label: '已完成', badge: 'badge-ok' }
  return { status: 'pending', label: '进行中', badge: 'badge-neutral' }
}

/** 工具 resultPreview 由 buildSubagentStreamLines 截到首行 100 字符；带省略号即视为被截断。 */
export function toolResultPreviewTruncated(preview: string): boolean {
  return preview.endsWith('…')
}

/**
 * 卡片头部紧凑标题：仅当 summary.title 是有意义的用户标题（非默认生成形态
 * 「子代理 N」/「子会话 N」）时返回，否则 undefined（头部只显示编号）。
 */
export function compactCardTitle(title: string | undefined, childConversationId: number): string | undefined {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') return undefined
  if (trimmed === `子代理 ${childConversationId}` || trimmed === `子会话 ${childConversationId}`) return undefined
  return trimmed
}

/** 滚动贴底判定：距底部不超过容差即视为贴底（供测试与组件共用同一语义）。 */
export const STICK_BOTTOM_TOLERANCE_PX = 36

export function isScrolledToBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_TOLERANCE_PX
}
