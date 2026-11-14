/**
 * builtin:herdr 插件 client 纯函数模型（无 React 依赖）：
 * 总览行的筛选、统计与展示辅助，供 index.tsx 组件与单测共同消费。
 */

/** 总览文档单行（OverviewDoc.panes 元素；version 2 契约）。 */
export interface OverviewPaneRow {
  nodeId: string
  paneId: string
  tabId: string
  workspaceId: string
  ownedBy: 'helm' | 'human'
  agentStatus: string
  cwd?: string
  foregroundCwd?: string
  label?: string
  title?: string
  agent?: string
  agentName?: string
  focused?: boolean
  outcome?: string
  pendingAsk?: boolean
}

export interface OverviewDoc {
  version: 2
  updatedAt: number
  stale: boolean
  error?: string
  panes: OverviewPaneRow[]
  asks: Array<{ paneId: string; nodeId: string; seq: number; phase: string }>
}

/** URL 深链筛选参数（sp.node / sp.owner / sp.status）。 */
export interface OverviewFilters {
  node: string
  owner: string
  status: string
}

export const DEFAULT_FILTERS: Readonly<OverviewFilters> = Object.freeze({ node: 'all', owner: 'all', status: 'all' })

/** 从 ScreenProps.params 解析筛选器：非法值回退 'all'，不做任何静默改写之外的猜测。 */
export function parseFilters(params: Readonly<Record<string, string>>): OverviewFilters {
  const pick = (raw: unknown, allowed: ReadonlyArray<string>): string =>
    typeof raw === 'string' && allowed.includes(raw) ? raw : 'all'
  return {
    node: typeof params['node'] === 'string' && params['node'] !== '' ? params['node'] : 'all',
    owner: pick(params['owner'], ['all', 'helm', 'human']),
    status: pick(params['status'], ['all', 'working', 'idle', 'blocked', 'done', 'unknown']),
  }
}

/** 筛选器 -> setParams patch（'all' 以 undefined 清除对应键，保持 URL 最小）。 */
export function filtersToParamsPatch(filters: OverviewFilters): Record<string, string | undefined> {
  return {
    node: filters.node !== 'all' ? filters.node : undefined,
    owner: filters.owner !== 'all' ? filters.owner : undefined,
    status: filters.status !== 'all' ? filters.status : undefined,
  }
}

export function filterPanes(panes: OverviewPaneRow[], filters: OverviewFilters): OverviewPaneRow[] {
  return panes.filter((p) => {
    if (filters.node !== 'all' && p.nodeId !== filters.node) return false
    if (filters.owner !== 'all' && p.ownedBy !== filters.owner) return false
    if (filters.status !== 'all' && p.agentStatus !== filters.status) return false
    return true
  })
}

export interface OverviewStats {
  total: number
  working: number
  blocked: number
  nodes: number
}

export function computeStats(panes: OverviewPaneRow[], nodes: string[]): OverviewStats {
  return {
    total: panes.length,
    working: panes.filter((p) => p.agentStatus === 'working').length,
    blocked: panes.filter((p) => p.agentStatus === 'blocked').length,
    nodes: nodes.length,
  }
}

export function collectNodes(panes: OverviewPaneRow[]): string[] {
  return [...new Set(panes.map((p) => p.nodeId))].sort()
}

/** Herdr 23 种 CLI agent.start kind 标签（detect::agent_label 全集）。 */
export const HERDR_AGENT_SUGGESTIONS: ReadonlyArray<string> = [
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'maki',
  'muse',
]

/** 行唯一键：nodeId:paneId。 */
export const paneRowKey = (row: Pick<OverviewPaneRow, 'nodeId' | 'paneId'>): string => `${row.nodeId}:${row.paneId}`

/** 行状态徽章色调（未知状态中性展示，不猜测）。 */
export function agentStatusTone(status: string): string {
  switch (status) {
    case 'working':
      return 'accent'
    case 'blocked':
      return 'warn'
    case 'done':
      return 'ok'
    default:
      return 'neutral'
  }
}

/** 受管行任务终态标签（仅 outcome 存在时展示）。 */
export function outcomeLabel(outcome: string | undefined): { label: string; tone: string } | undefined {
  switch (outcome) {
    case 'running':
      return { label: '运行中', tone: 'accent' }
    case 'keepalive':
      return { label: '保活', tone: 'neutral' }
    case 'failed':
      return { label: '失败', tone: 'err' }
    case 'settled':
      return { label: '已收尾', tone: 'ok' }
    default:
      return undefined
  }
}

/** list 动作结果 -> paneKey 到 parentConversationId 的映射（受管行关联会话）。 */
export function parseManagedMap(result: unknown): Record<string, number> {
  const map: Record<string, number> = {}
  if (result === null || typeof result !== 'object' || !Array.isArray((result as { panes?: unknown }).panes)) return map
  for (const p of (result as { panes: Array<Record<string, unknown>> }).panes) {
    const paneId = typeof p['paneId'] === 'string' ? p['paneId'] : undefined
    const nodeId = typeof p['nodeId'] === 'string' ? p['nodeId'] : 'local'
    const parent = p['parentConversationId']
    if (paneId !== undefined && typeof parent === 'number' && Number.isSafeInteger(parent)) {
      map[`${nodeId}:${paneId}`] = parent
    }
  }
  return map
}

/** read 动作结果 -> 终端快照文本（text 字段缺失时 JSON 序列化兜底，不伪造空串）。 */
export function parseReadText(result: unknown): string {
  if (result !== null && typeof result === 'object' && 'text' in (result as Record<string, unknown>)) {
    const text = (result as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  try {
    return JSON.stringify(result) ?? '—'
  } catch {
    return String(result)
  }
}

/**
 * 是否可对窗格执行聚焦操作：
 * 1. 来源校验：必须由 helm 受管（row.ownedBy === 'helm'），human 窗格不由 builtin:herdr 管理；
 * 2. 状态校验：当前尚未聚焦（!row.focused），任务未收尾（outcome !== 'settled'），且非 done 状态。
 */
export function canFocusPane(row: OverviewPaneRow): boolean {
  if (row.ownedBy !== 'helm') return false
  if (row.focused === true) return false
  if (row.outcome === 'settled') return false
  if (row.agentStatus === 'done') return false
  return true
}

/**
 * 是否可读取窗格快照：
 * 1. 来源校验：必须由 helm 受管（row.ownedBy === 'helm'），human 窗格不由 builtin:herdr 管理；
 * 2. 状态校验：任务未收尾（outcome !== 'settled'）。
 */
export function canSnapshotPane(row: OverviewPaneRow): boolean {
  if (row.ownedBy !== 'helm') return false
  if (row.outcome === 'settled') return false
  return true
}

