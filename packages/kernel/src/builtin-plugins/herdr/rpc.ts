/**
 * Herdr RPC 结果边界校验：把 transport.call 解包的 unknown result 收敛为
 * 强类型形状。官方协议为 tag = "type" 的 snake_case 枚举（herdr 0.9.5 /
 * protocol 22，服务端源码核实）；任何字段缺失/类型不符都在本边界显式抛
 * HelmError('herdr_protocol_violation')，绝不静默降级（不伪造 0 / unknown /
 * 空串），坏数据不得成为 CAS 或终态判断的权威。
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
  /** 真实启动序列：agent.start 后短暂 unknown + launch_pending（服务端实测）。 */
  launchPending?: boolean
  /** 官方字段省略时为 false；idle 本身不足以接受 prompt。 */
  interactiveReady: boolean
  focused?: boolean
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

const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const

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

function optBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  return typeof obj[key] === 'boolean' ? (obj[key] as boolean) : undefined
}

/** 状态严格枚举：未知值是协议违约（服务端 AgentStatus 仅五值）。 */
function parseStatus(v: unknown, method: string): HerdrAgentStatus {
  const status = AGENT_STATUSES.find((s) => s === v)
  if (status === undefined) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} agent_status 非法：${JSON.stringify(v)}`,
      502,
      { method, agentStatus: v },
    )
  }
  return status
}

/** seq 严格非负整数（服务端 u64）：缺失/小数/负数/字符串都是违约，绝不伪造 0。 */
function parseSeq(v: unknown, method: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new HelmError(
      'herdr_protocol_violation',
      `${method} state_change_seq 缺失或非非负安全整数：${String(v)}`,
      502,
      { method, resolvedType: typeof v },
    )
  }
  return v
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
    agentStatus: parseStatus(agent['agent_status'], method),
    stateChangeSeq: parseSeq(agent['state_change_seq'], method),
    launchPending: optBool(agent, 'launch_pending'),
    interactiveReady: optBool(agent, 'interactive_ready') ?? false,
    focused: optBool(agent, 'focused'),
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
  const text = read['text']
  if (typeof text !== 'string') throw new HelmError('herdr_protocol_violation', 'agent.read text 必须是字符串', 502)
  return { paneId: reqString(read, 'agent.read', 'pane_id'), text }
}

export function isOkResult(result: unknown): boolean {
  return isObj(result) && result['type'] === 'ok'
}

/**
 * session.snapshot 的 panes[] 行（官方 PaneInfo 子集；服务端 src/api/schema/
 * panes.rs:527-560）。pane 无 state_change_seq（seq 只在 AgentInfo），普通
 * shell 的 agent_status 官方为 unknown——两者都如实保留，绝不伪造。
 */
export interface HerdrPaneSnapshotInfo {
  paneId: string
  workspaceId: string
  tabId: string
  focused: boolean
  agentStatus: HerdrAgentStatus
  cwd?: string
  foregroundCwd?: string
  label?: string
  agent?: string
  title?: string
}

/** session.snapshot -> {type:'session_snapshot', snapshot:{agents, panes, tabs, workspaces}} */
export interface SessionSnapshotData {
  agents: HerdrAgentInfo[]
  /** 全部本机窗格（含人类 shell）；agents 仅 Agent 终端，按 paneId join。 */
  panes: HerdrPaneSnapshotInfo[]
}

export function parseSessionSnapshot(result: unknown): SessionSnapshotData {
  const obj = expectType(result, 'session.snapshot', 'session_snapshot')
  const snapshot = obj['snapshot']
  if (!isObj(snapshot)) {
    throw new HelmError('herdr_protocol_violation', 'session.snapshot 结果缺少 snapshot 对象', 502, {})
  }
  const agents = snapshot['agents']
  if (!Array.isArray(agents)) {
    throw new HelmError('herdr_protocol_violation', 'session.snapshot.agents 必须是数组', 502, {})
  }
  const panes = snapshot['panes']
  if (!Array.isArray(panes)) {
    throw new HelmError('herdr_protocol_violation', 'session.snapshot.panes 必须是数组', 502, {})
  }
  const parsedAgents = agents.map((a) => parseAgentInfo(a, 'session.snapshot'))
  const parsedPanes = panes.map((p) => parsePaneSnapshotInfo(p, 'session.snapshot'))
  for (const [name, rows] of [['agents', parsedAgents], ['panes', parsedPanes]] as const) {
    const ids = new Set<string>()
    for (const row of rows) {
      if (ids.has(row.paneId)) {
        throw new HelmError('herdr_protocol_violation', `session.snapshot.${name} 含重复 pane_id`, 502)
      }
      ids.add(row.paneId)
    }
  }
  return { agents: parsedAgents, panes: parsedPanes }
}

function snapshotString(pane: Record<string, unknown>, key: string): string | undefined {
  const value = pane[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new HelmError('herdr_protocol_violation', `session.snapshot.panes.${key} 必须是字符串`, 502)
  }
  return value
}

function parsePaneSnapshotInfo(pane: unknown, method: string): HerdrPaneSnapshotInfo {
  if (!isObj(pane)) {
    throw new HelmError('herdr_protocol_violation', `${method}.panes 项必须是对象`, 502, {})
  }
  const focused = pane['focused']
  if (typeof focused !== 'boolean') {
    throw new HelmError('herdr_protocol_violation', `${method}.panes 项 ${String(pane['pane_id'])} 缺少 focused 布尔字段`, 502, {})
  }
  return {
    paneId: reqString(pane, method, 'pane_id'),
    workspaceId: reqString(pane, method, 'workspace_id'),
    tabId: reqString(pane, method, 'tab_id'),
    focused,
    agentStatus: parseStatus(pane['agent_status'], method),
    cwd: snapshotString(pane, 'cwd'),
    foregroundCwd: snapshotString(pane, 'foreground_cwd'),
    label: snapshotString(pane, 'label'),
    agent: snapshotString(pane, 'agent'),
    title: snapshotString(pane, 'title'),
  }
}

/**
 * 预期 'ok' 的结果（tab.close / workspace.close / send_keys / report_metadata——
 * 服务端源码逐条核实）。非 ok 显式抛协议违约——绝不把失败静默当成功。
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
