/**
 * Web 宿主格式化入口；共享实现统一由 @helm/plugin-client 提供。
 */
export {
  formatBytes,
  formatCompactTimestamp,
  formatDurationMs,
  formatTime,
} from '@helm/plugin-client'

/** 错误转可读文本（通知 / 内联错误 / 连接失败提示共用）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * tokens 紧凑人类可读（严格抄 pi agent footer formatTokens 分档，与会话用量展示同源）：
 * <1000 原值；<10000 一位小数 k；<1M 四舍五入 k；<10M 一位小数 M；之后四舍五入 M。
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
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
