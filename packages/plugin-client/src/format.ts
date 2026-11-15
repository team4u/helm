/**
 * 插件 client.tsx 与宿主共享的格式化纯函数（无任何宿主依赖）。
 * 进制与舍入规则与宿主时间线/节点弹窗统一（宿主经本包复用，不再各持一份实现）。
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

/** 毫秒时长人类可读摘要（工具耗时 / 工作流总耗时）；非法或缺失返回空串。
 * 档位：<1s 整毫秒；<60s 一位小数秒；<1h `XmYs`；>=1h `XhYm`（分钟粒度）。
 * 拆分前先按总秒数四舍五入，任何档位都不产生进位假值（`60.0s` / `1m60s` /
 * `59m60s`）；短时精度契约保持不变（`1.5s` / `5.0s` / `2m5s`）。 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  // 一位小数秒档：舍入后会触达 60.0s 的边界（>=59_950ms）交给分/时档拆分。
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
  }
  return `${Math.floor(totalSeconds / 3600)}h${Math.floor((totalSeconds % 3600) / 60)}m`
}

/** 紧凑时间戳 `MM-DD HH:mm:ss`（日志式展示，如 Herdr 快照时间）；0 / 缺失返回占位符。 */
export function formatCompactTimestamp(ms: number, options?: { placeholder?: string }): string {
  if (!ms) return options?.placeholder ?? '未知'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 紧凑日期时间 `MM-DD HH:mm`（表格展示，如配额刷新时间 / Worker 创建时间）；本地时区，非法或缺失返回空串。 */
export function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
