/**
 * 通用格式化纯函数（字节 / 时长 / 日期时间 / 错误文本）。
 * 全仓唯一实现：时间线、节点弹窗、Herdr 总览等界面共用，进制与舍入规则统一。
 */

/**
 * 字节数人类可读化：1024 进制 + KiB / MiB / GiB 正确标注。
 * 舍入规则统一：数值 < 100 保留一位小数，>= 100 取整；小于 1 KiB 四舍五入到整数 B。
 * 占位符可参数化（时间线用 '-'，节点弹窗用 '--'），进制与标签绝不因调用方而异。
 */
export function formatBytes(bytes: number | undefined, options?: { placeholder?: string }): string {
  const placeholder = options?.placeholder ?? '--'
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return placeholder
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** 毫秒时长摘要（工具耗时 / 工作流节点耗时）；非法或缺失返回空串。 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

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

/** 紧凑时间戳 `MM-DD HH:mm:ss`（日志式展示，如 Herdr 快照时间）；0 / 缺失返回占位符。 */
export function formatCompactTimestamp(ms: number, options?: { placeholder?: string }): string {
  if (!ms) return options?.placeholder ?? '未知'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
