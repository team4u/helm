import type { WorkflowPhaseSection } from './model-run.ts'

export const SPIN = 'spin-slow'
export const RUN_LABEL: Record<string, string> = {
  running: '执行中', completed: '已完成', failed: '失败', aborted: '已中止',
}
export const RUN_BADGE: Record<string, string> = {
  running: 'badge-accent', completed: 'badge-ok', failed: 'badge-err', aborted: 'badge-warn',
}
export const NODE_LABEL: Record<string, string> = {
  pending: '待执行', running: '运行中', done: '完成', failed: '失败', skipped: '跳过',
}
export const NODE_BADGE: Record<string, string> = {
  pending: 'badge-neutral', running: 'badge-accent', done: 'badge-ok', failed: 'badge-err', skipped: 'badge-neutral',
}
export const PHASE_ICON: Record<WorkflowPhaseSection['status'], string> = {
  pending: 'circle', running: 'loader', done: 'check', failed: 'x',
}
/** 统一执行树节点状态展示（ExecutionNodeStatus 五值枚举）。 */
export const EXECUTION_LABEL: Record<string, string> = {
  blocked: '等待审批', error: '异常', working: '执行中', done: '已完成', pending: '进行中',
}
export const EXECUTION_BADGE: Record<string, string> = {
  blocked: 'badge-warn', error: 'badge-err', working: 'badge-accent', done: 'badge-ok', pending: 'badge-neutral',
}
export const EXECUTION_ICON: Record<string, string> = {
  blocked: 'clock', error: 'x', working: 'loader', done: 'check', pending: 'circle',
}
