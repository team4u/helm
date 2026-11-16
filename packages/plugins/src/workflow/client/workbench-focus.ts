/**
 * builtin:workflow 插件内工作台运行定位总线（纯内存状态 + 订阅，零 React/DOM 依赖）。
 *
 * 用于时间线单行轨迹（WorkflowToolView / SubagentToolView 外部执行）或底部活动条
 * 点击后，精准通知 WorkflowWorkbenchPanel 打开并展开指定 run.id 的完整详情视图；
 * 若工作台尚未挂载则先缓存请求，待挂载首帧读取并消费，兼容 React StrictMode。
 */

export interface WorkbenchRunFocusRequest {
  conversationId: number
  runId: string
  seq: number
}

type FocusListener = (request: WorkbenchRunFocusRequest) => void

let pendingFocus: WorkbenchRunFocusRequest | undefined
let focusSeq = 0
const listeners = new Set<FocusListener>()

/** 请求右侧工作台聚焦并展开指定会话的某次 run.id。 */
export function requestWorkbenchRunFocus(conversationId: number, runId: string): void {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || runId === '') return
  focusSeq += 1
  const request: WorkbenchRunFocusRequest = { conversationId, runId, seq: focusSeq }
  pendingFocus = request
  for (const listener of [...listeners]) {
    listener(request)
  }
}

/** 非破坏性读取当前会话是否存在待处理的 run 聚焦请求（SSR 安全）。 */
export function peekWorkbenchRunFocus(conversationId: number): WorkbenchRunFocusRequest | undefined {
  return pendingFocus?.conversationId === conversationId ? pendingFocus : undefined
}

/** 清除当前会话（可选精确匹配 runId）的待处理聚焦请求。 */
export function clearWorkbenchRunFocus(conversationId: number, runId?: string): void {
  if (pendingFocus === undefined || pendingFocus.conversationId !== conversationId) return
  if (runId !== undefined && pendingFocus.runId !== runId) return
  pendingFocus = undefined
}

/** 订阅后续聚焦请求（供已挂载的 WorkflowWorkbenchPanel 实时跳转）。 */
export function subscribeWorkbenchRunFocus(listener: FocusListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
