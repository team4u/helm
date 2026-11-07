/**
 * 配额读取（GET /v1/magpie/quotas）→ 展示行投影。
 * 与 pi-magpie v0.1.6 quota.ts 的展示语义一致（纯投影，无副作用）。
 */

/** 单个配额窗口。 */
export interface QuotaWindow {
  name?: string
  /** 窗口已用百分比 0-100。 */
  used?: number
  /** 窗口剩余百分比 0-100。 */
  remaining?: number
  resetsAt?: string
  /** 供应商原始表述（如 "0 / 6900"）。 */
  display?: string
}

/** 单个订阅 / 计划 / 密钥的配额卡片。 */
export interface QuotaEntry {
  provider?: string
  name?: string
  kind?: string
  plan?: string
  user?: string
  windows?: QuotaWindow[]
  until?: string
  resets?: { count?: number; until?: string }
  error?: string
  readAt?: string
  asOf?: string
}

/** 窗口剩余百分比；vendor 未给出时 undefined。 */
export function remainingPercent(window: QuotaWindow): number | undefined {
  if (typeof window.remaining === 'number' && Number.isFinite(window.remaining)) {
    return Math.max(0, Math.min(100, window.remaining))
  }
  if (typeof window.used === 'number' && Number.isFinite(window.used)) {
    return Math.max(0, Math.min(100, 100 - window.used))
  }
  return undefined
}

/** 窗口文本：供应商原始表述优先，否则剩余百分比。 */
export function windowText(window: QuotaWindow): string {
  const display = window.display?.trim()
  if (display) return display
  const remaining = remainingPercent(window)
  return remaining === undefined ? '?' : `${Math.round(remaining)}%`
}

/** 重置时间的人读形式（相对时长）。 */
export function formatReset(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - now
  if (left <= 60_000) return 'now'
  const minutes = Math.round(left / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return `${hours}h`
  const days = Math.round(left / 86_400_000)
  if (days < 7) return `${days}d`
  return new Date(at).toISOString().slice(0, 10)
}

/** 展示行：单个窗口 → status doc 行（remainingPercent -1 表示未知）。 */
export interface QuotaRow {
  provider: string
  account?: string
  remainingPercent: number
  resetText?: string
  windowLabel?: string
}

/** 全部配额卡片 → 展示行（每窗口一行；无 windows 的卡片输出一行 -1）。 */
export function quotaRows(entries: readonly QuotaEntry[], now = Date.now()): QuotaRow[] {
  const rows: QuotaRow[] = []
  for (const entry of entries) {
    const provider = entry.provider?.trim() || entry.name?.trim() || 'provider'
    const account = entry.user?.trim() || entry.plan?.trim() || undefined
    const windows = entry.windows ?? []
    if (windows.length === 0) {
      rows.push({
        provider,
        ...(account !== undefined ? { account } : {}),
        remainingPercent: -1,
        ...(entry.error?.trim() ? { windowLabel: `error: ${entry.error.trim().slice(0, 120)}` } : {}),
      })
      continue
    }
    for (const window of windows) {
      const remaining = remainingPercent(window)
      const reset = formatReset(window.resetsAt, now)
      rows.push({
        provider,
        ...(account !== undefined ? { account } : {}),
        remainingPercent: remaining === undefined ? -1 : Math.round(remaining),
        ...(reset !== undefined ? { resetText: reset } : {}),
        ...(window.name?.trim() ? { windowLabel: window.name.trim() } : {}),
      })
    }
  }
  return rows
}
