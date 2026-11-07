/**
 * Herdr RPC 结果边界校验：把 transport.call 解包的 unknown result 收敛为
 * 强类型形状。官方协议为 tag = "type" 的 snake_case 枚举（herdr 0.9.5 /
 * protocol 22，服务端源码核实）；任何字段缺失/类型不符都在本边界显式抛
 * HelmError('herdr_protocol_violation')，绝不静默降级或猜测。
 */

import { HelmError } from '@helm/protocol'

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface HerdrTabInfo {
  tabId: string
  workspaceId: string
}

export interface HerdrPaneInfo {
  paneId: string
  workspaceId: string
  tabId: string
  cwd?: string
}

export interface HerdrWorktreeInfo {
  path: string
  branch?: string
}

export interface HerdrAgentInfo {
  paneId: string
  tabId: string
  workspaceId: string
  agent?: string
  name?: string
  agentStatus: HerdrAgentStatus
  stateChangeSeq: number
  cwd?: string
  foregroundCwd?: string
}

export interface TabCreated {
  tab: HerdrTabInfo
  rootPane: HerdrPaneInfo
}

export interface WorktreeCreated {
  workspaceId: string
  tabId: string
  rootPane: HerdrPaneInfo
  worktree: HerdrWorktreeInfo
}

export interface PaneRead {
  paneId: string
  text: string
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asObject(result: unknown, method: string): Record<string, unknown> {
  if (!isObj(result)) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} 返回的 result 不是对象：${JSON.stringify(result)?.slice(0, 200)}`,
      502,
      { method, result },
    )
  }
  return result
}

function expectType(result: unknown, method: string, expected: string): Record<string, unknown> {
  const obj = asObject(result, method)
  if (obj['type'] !== expected) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} 返回的 result.type 应为 '${expected}'，实际：${JSON.stringify(obj['type'])}`,
      502,
      { method, expected, actual: obj['type'] },
    )
  }
  return obj
}

function reqString(obj: Record<string, unknown>, method: string, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} 结果字段 ${key} 缺失或非非空字符串`,
      502,
      { method, key, value: v },
    )
  }
  return v
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function parseStatus(v: unknown): HerdrAgentStatus {
  return v === 'idle' || v === 'working' || v === 'blocked' || v === 'done' || v === 'unknown' ? v : 'unknown'
}

function parseSeq(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0
}

function parseTab(obj: Record<string, unknown>, method: string): HerdrTabInfo {
  const tab = obj['tab']
  if (!isObj(tab)) {
    throw new HelmError('herdr_protocol_violation', `${method} 结果缺少 tab 对象`, 502, { method })
  }
  return { tabId: reqString(tab, method, 'tab_id'), workspaceId: reqString(tab, method, 'workspace_id') }
}

function parsePane(obj: Record<string, unknown>, method: string, key = 'root_pane'): HerdrPaneInfo {
  const pane = obj[key]
  if (!isObj(pane)) {
    throw new HelmError('herdr_protocol_violation', `${method} 结果缺少 ${key} 对象`, 502, { method, key })
  }
  return {
    paneId: reqString(pane, method, 'pane_id'),
    workspaceId: reqString(pane, method, 'workspace_id'),
    tabId: reqString(pane, method, 'tab_id'),
    cwd: optString(pane, 'cwd'),
  }
}

/** tab.create -> {type:'tab_created', tab, root_pane} */
export function parseTabCreated(result: unknown): TabCreated {
  const obj = expectType(result, 'tab.create', 'tab_created')
  return { tab: parseTab(obj, 'tab.create'), rootPane: parsePane(obj, 'tab.create') }
}

/** worktree.create -> {type:'worktree_created', workspace, tab, root_pane, worktree} */
export function parseWorktreeCreated(result: unknown): WorktreeCreated {
  const obj = expectType(result, 'worktree.create', 'worktree_created')
  const worktree = obj['worktree']
  if (!isObj(worktree)) {
    throw new HelmError('herdr_protocol_violation', 'worktree.create 结果缺少 worktree 对象', 502, {})
  }
  return {
    workspaceId: reqString(asObject(obj['workspace'], 'worktree.create'), 'worktree.create', 'workspace_id'),
    tabId: parseTab(obj, 'worktree.create').tabId,
    rootPane: parsePane(obj, 'worktree.create'),
    worktree: {
      path: reqString(worktree, 'worktree.create', 'path'),
      branch: optString(worktree, 'branch'),
    },
  }
}

function parseAgentInfo(agent: unknown, method: string): HerdrAgentInfo {
  if (!isObj(agent)) {
    throw new HelmError('herdr_protocol_violation', `${method} 结果缺少 agent 对象`, 502, { method })
  }
  return {
    paneId: reqString(agent, method, 'pane_id'),
    tabId: reqString(agent, method, 'tab_id'),
    workspaceId: reqString(agent, method, 'workspace_id'),
    agent: optString(agent, 'agent'),
    name: optString(agent, 'name'),
    agentStatus: parseStatus(agent['agent_status']),
    stateChangeSeq: parseSeq(agent['state_change_seq']),
    cwd: optString(agent, 'cwd'),
    foregroundCwd: optString(agent, 'foreground_cwd'),
  }
}

/** agent.start / agent.get / agent.wait / agent.prompt 共用的 agent_info 形状。 */
export function parseAgentResult(result: unknown, method: string, expected: string): HerdrAgentInfo {
  const obj = expectType(result, method, expected)
  return parseAgentInfo(obj['agent'], method)
}

/** agent.read -> {type:'pane_read', read:{pane_id, text, ...}} */
export function parsePaneRead(result: unknown): PaneRead {
  const obj = expectType(result, 'agent.read', 'pane_read')
  const read = obj['read']
  if (!isObj(read)) {
    throw new HelmError('herdr_protocol_violation', 'agent.read 结果缺少 read 对象', 502, {})
  }
  return { paneId: reqString(read, 'agent.read', 'pane_id'), text: typeof read['text'] === 'string' ? read['text'] : '' }
}

export function isOkResult(result: unknown): boolean {
  return isObj(result) && result['type'] === 'ok'
}

/** session.snapshot -> {type:'session_snapshot', snapshot:{agents, panes, tabs, workspaces}} */
export interface SessionSnapshotAgents {
  agents: HerdrAgentInfo[]
}

export function parseSessionSnapshot(result: unknown): SessionSnapshotAgents {
  const obj = expectType(result, 'session.snapshot', 'session_snapshot')
  const snapshot = obj['snapshot']
  if (!isObj(snapshot)) {
    throw new HelmError('herdr_protocol_violation', 'session.snapshot 结果缺少 snapshot 对象', 502, {})
  }
  const agents = snapshot['agents']
  if (!Array.isArray(agents)) {
    throw new HelmError('herdr_protocol_violation', 'session.snapshot.agents 必须是数组', 502, {})
  }
  return { agents: agents.map((a) => parseAgentInfo(a, 'session.snapshot')) }
}

/**
 * 预期 'ok' 的结果（tab.close / workspace.close / send_keys / report_metadata）。
 * 非 ok 显式抛协议违约——绝不把失败静默当成功（诚实性纪律）。
 */
export function assertOkResult(result: unknown, method: string): void {
  if (!isOkResult(result)) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} 应返回 {type:'ok'}，实际：${JSON.stringify(result)?.slice(0, 200)}`,
      502,
      { method, result },
    )
  }
}
