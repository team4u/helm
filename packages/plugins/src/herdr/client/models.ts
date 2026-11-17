/**
 * Pure-function models for the builtin:herdr client (no React dependency):
 * filtering, stats and display helpers of the overview rows, consumed by the
 * index.tsx components and unit tests alike.
 *
 * No display copy lives here: label-bearing builders (outcome labels, owner /
 * status filter options) moved to copy.ts, which can resolve LocalizedText
 * against the host locale — models.ts stays importable standalone (tests
 * compile and import it without the shared @helm/plugin-client runtime).
 */
/** Single row of the overview doc (OverviewDoc.panes element; version 2 contract). */
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

/** URL deep-link filter params (sp.node / sp.owner / sp.status). */
export interface OverviewFilters {
  node: string
  owner: string
  status: string
}

export const DEFAULT_FILTERS: Readonly<OverviewFilters> = Object.freeze({ node: 'all', owner: 'all', status: 'all' })

/** Parse filters from ScreenProps.params: invalid values fall back to 'all'; no guessing beyond that. */
export function parseFilters(params: Readonly<Record<string, string>>): OverviewFilters {
  const pick = (raw: unknown, allowed: ReadonlyArray<string>): string =>
    typeof raw === 'string' && allowed.includes(raw) ? raw : 'all'
  return {
    node: typeof params['node'] === 'string' && params['node'] !== '' ? params['node'] : 'all',
    owner: pick(params['owner'], ['all', 'helm', 'human']),
    status: pick(params['status'], ['all', 'working', 'idle', 'blocked', 'done', 'unknown']),
  }
}

/** Filters -> setParams patch ('all' clears the key with undefined, keeping the URL minimal). */
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

/** The 23 Herdr CLI agent.start kind labels (the detect::agent_label universe). */
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

/** Row unique key: nodeId:paneId. */
export const paneRowKey = (row: Pick<OverviewPaneRow, 'nodeId' | 'paneId'>): string => `${row.nodeId}:${row.paneId}`

/** Row status badge tone (unknown statuses render neutrally, never guessed). */
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

/** Outcome badge tone for managed rows (labels resolve in copy.ts against the host locale). */
export function outcomeTone(outcome: string | undefined): string | undefined {
  switch (outcome) {
    case 'running':
      return 'accent'
    case 'keepalive':
      return 'neutral'
    case 'failed':
      return 'err'
    case 'settled':
      return 'ok'
    default:
      return undefined
  }
}

/** list action result -> paneKey to parentConversationId map (linked conversations of managed rows). */
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

/** read action result -> terminal snapshot text (JSON fallback when the text field is missing; never fakes an empty string). */
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
 * Whether the pane accepts a focus action:
 * 1. origin check: it must be helm-managed (row.ownedBy === 'helm') — human
 *    panes are not managed by builtin:herdr;
 * 2. state check: not already focused (!row.focused), the task has not
 *    settled (outcome !== 'settled') and the status is not done.
 */
export function canFocusPane(row: OverviewPaneRow): boolean {
  if (row.ownedBy !== 'helm') return false
  if (row.focused === true) return false
  if (row.outcome === 'settled') return false
  if (row.agentStatus === 'done') return false
  return true
}

/**
 * Whether the pane accepts a read-only snapshot:
 * 1. origin check: it must be helm-managed (row.ownedBy === 'helm') — human
 *    panes are not managed by builtin:herdr;
 * 2. state check: the task has not settled (outcome !== 'settled').
 */
export function canSnapshotPane(row: OverviewPaneRow): boolean {
  if (row.ownedBy !== 'helm') return false
  if (row.outcome === 'settled') return false
  return true
}

/** Ownership check: anything not managed by helm counts as human direct (strictly read-only diagnostics, no control actions). */
export function isHumanOwnedPane(row: Pick<OverviewPaneRow, 'ownedBy'>): boolean {
  return row.ownedBy !== 'helm'
}

export function paneLocationText(row: Pick<OverviewPaneRow, 'title' | 'label' | 'workspaceId'>): string | undefined {
  return row.title ?? row.label ?? row.workspaceId
}

export function paneCwdText(row: Pick<OverviewPaneRow, 'foregroundCwd' | 'cwd'>): string {
  return row.foregroundCwd ?? row.cwd ?? '—'
}
