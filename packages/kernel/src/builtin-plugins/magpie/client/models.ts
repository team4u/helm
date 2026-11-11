/**
 * builtin:magpie 插件 client.tsx 纯数据模型（无组件导出，保 Fast Refresh 契约）。
 *
 * doc 形状与 magpie/contracts.ts MagpieStatusDoc 契约同构；宽容解析，
 * doc 未到达时返回安全缺省，不虚构数据。
 */

/** MagpieStatusDoc 展示字段子集。 */
export interface MagpieStatusView {
  gatewayUrl: string
  configuredRoot: boolean
  local: boolean
  reachable: boolean
  modelCount: number
  groupCount: number
  lastRefreshedAt?: number
  lastError?: string
  summaryText: string
  quotas: Array<{ provider: string; account?: string; windowLabel?: string; remainingPercent: number; resetText?: string }>
  routes: Array<{ group: string; strategy?: string; provider?: string; model?: string; timestamp?: string }>
  diagnostics: string[]
}

const EMPTY: MagpieStatusView = {
  gatewayUrl: '',
  configuredRoot: false,
  local: true,
  reachable: false,
  modelCount: 0,
  groupCount: 0,
  summaryText: '',
  quotas: [],
  routes: [],
  diagnostics: [],
}

/** 宽容读取 status doc（缺失字段回落安全缺省）。 */
export function parseStatus(doc: MagpieStatusView | undefined): MagpieStatusView {
  if (doc === undefined || typeof doc !== 'object') return EMPTY
  return {
    gatewayUrl: typeof doc.gatewayUrl === 'string' ? doc.gatewayUrl : '',
    configuredRoot: doc.configuredRoot === true,
    local: doc.local !== false,
    reachable: doc.reachable === true,
    modelCount: typeof doc.modelCount === 'number' ? doc.modelCount : 0,
    groupCount: typeof doc.groupCount === 'number' ? doc.groupCount : 0,
    lastRefreshedAt: typeof doc.lastRefreshedAt === 'number' ? doc.lastRefreshedAt : undefined,
    lastError: typeof doc.lastError === 'string' ? doc.lastError : undefined,
    summaryText: typeof doc.summaryText === 'string' ? doc.summaryText : '',
    quotas: Array.isArray(doc.quotas) ? doc.quotas : [],
    routes: Array.isArray(doc.routes) ? doc.routes : [],
    diagnostics: Array.isArray(doc.diagnostics) ? doc.diagnostics.filter((d) => typeof d === 'string') : [],
  }
}

/** 展示用紧凑时间（本地时区；缺失返回空串）。 */
export function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 布尔展示：是 / 否。 */
export function boolLabel(value: boolean): string {
  return value ? '是' : '否'
}

/** 配额剩余百分比色调（<20% 警戒）。 */
export function quotaTone(remainingPercent: number): 'ok' | 'warn' | 'err' {
  if (remainingPercent < 5) return 'err'
  if (remainingPercent < 20) return 'warn'
  return 'ok'
}
