/**
 * 宿主 Web 专用格式化纯函数。
 * 插件共享的四件套（formatTime / formatCompactTimestamp / formatDurationMs /
 * formatBytes）唯一实现在 @helm/plugin-client；本模块 re-export 供宿主内部
 * 调用点统一从 lib/format 引用（单一实现，零复制）。
 */
export { formatBytes, formatCompactTimestamp, formatDurationMs, formatTime } from '@helm/plugin-client'

/** 错误转可读文本（通知 / 内联错误 / 连接失败提示共用）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 本地化完整日期时间（节点连接时间 / 健康采集时间等表单式展示）。 */
export function formatDateTime(ms: number | undefined, options?: { placeholder?: string }): string {
  if (ms === undefined) return options?.placeholder ?? '--'
  return new Date(ms).toLocaleString()
}

/**
 * 消息展示时刻（主聊天流极简时间）：
 * - 当天返回 "HH:mm"（如 "14:28"）；
 * - 跨天返回 "MM-DD HH:mm"（如 "11-10 14:28"）；
 * - 非法或缺失返回空串。
 * 支持传入可选 nowOrOptions 供单测与确定性时钟注入。
 */
export function formatMessageTime(
  ms: number | undefined,
  nowOrOptions?: number | { now?: number },
): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const nowMs = typeof nowOrOptions === 'number' ? nowOrOptions : (nowOrOptions?.now ?? Date.now())
  const nowDate = new Date(nowMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const isToday =
    d.getFullYear() === nowDate.getFullYear() &&
    d.getMonth() === nowDate.getMonth() &&
    d.getDate() === nowDate.getDate()
  if (isToday) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 完整日期时间戳 `YYYY-MM-DD HH:mm:ss`（消息悬停 Tooltip 完整本地化时间展示）；非法或缺失返回空串。 */
export function formatFullTimestamp(ms: number | undefined, options?: { placeholder?: string }): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return options?.placeholder ?? ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return options?.placeholder ?? ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
