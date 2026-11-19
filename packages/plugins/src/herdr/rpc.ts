/**
 * Herdr RPC result boundary validation: converge the unknown result unpacked by transport.call into
 * strongly-typed shapes. The official protocol is a snake_case enum with tag = "type" (herdr 0.9.5 /
 * protocol 22, verified against server source); any missing field / type mismatch throws explicitly at
 * this boundary as HelmxError('herdr_protocol_violation'), never silently degrading (no fabricated 0 / unknown /
 * empty strings); bad data must never become the authority for CAS or terminal-state decisions.
 */

import { HelmxError } from '@helmx/protocol'

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface HerdrTabInfo {
  tabId: string
  workspaceId: string
}

interface HerdrPaneInfo {
  paneId: string
  workspaceId: string
  tabId: string
  cwd?: string
}

interface HerdrWorktreeInfo {
  path: string
  branch?: string
}

export interface HerdrAgentInfo {
  paneId: string
  tabId: string
  workspaceId: string
  agent?: string
  name?: string
  /**
   * Official AgentInfo regular fields (optional; kept for the normal RPC shape, not required for steer).
   */
  terminalId?: string
  agentStatus: HerdrAgentStatus
  stateChangeSeq: number
  /** Real startup sequence: briefly unknown + launch_pending after agent.start (measured against the server). */
  launchPending?: boolean
  /** false when the official field is omitted; idle alone is not enough to accept a prompt. */
  interactiveReady: boolean
  focused?: boolean
  cwd?: string
  foregroundCwd?: string
}

interface TabCreated {
  tab: HerdrTabInfo
  rootPane: HerdrPaneInfo
}

interface WorktreeCreated {
  workspaceId: string
  tabId: string
  rootPane: HerdrPaneInfo
  worktree: HerdrWorktreeInfo
}

interface PaneRead {
  paneId: string
  text: string
}

const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asObject(result: unknown, method: string): Record<string, unknown> {
  if (!isObj(result)) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} returned a result that is not an object: ${JSON.stringify(result)?.slice(0, 200)}`,
      502,
      { method, result },
    )
  }
  return result
}

function expectType(result: unknown, method: string, expected: string): Record<string, unknown> {
  const obj = asObject(result, method)
  if (obj['type'] !== expected) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} returned result.type '${expected}' expected, got: ${JSON.stringify(obj['type'])}`,
      502,
      { method, expected, actual: obj['type'] },
    )
  }
  return obj
}

function reqString(obj: Record<string, unknown>, method: string, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} result field ${key} is missing or not a non-empty string`,
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

/** Strict status enum: unknown values are protocol violations (the server's AgentStatus has only five values). */
function parseStatus(v: unknown, method: string): HerdrAgentStatus {
  const status = AGENT_STATUSES.find((s) => s === v)
  if (status === undefined) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} has invalid agent_status: ${JSON.stringify(v)}`,
      502,
      { method, agentStatus: v },
    )
  }
  return status
}

/** seq is a strict non-negative integer (server u64): missing/decimal/negative/string are all violations; never fabricate 0. */
function parseSeq(v: unknown, method: string, field = 'state_change_seq'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} ${field} is missing or not a non-negative safe integer: ${String(v)}`,
      502,
      { method, field, resolvedType: typeof v },
    )
  }
  return v
}

function parseTab(obj: Record<string, unknown>, method: string): HerdrTabInfo {
  const tab = obj['tab']
  if (!isObj(tab)) {
    throw new HelmxError('herdr_protocol_violation', `${method} result is missing the tab object`, 502, { method })
  }
  return { tabId: reqString(tab, method, 'tab_id'), workspaceId: reqString(tab, method, 'workspace_id') }
}

function parsePane(obj: Record<string, unknown>, method: string, key = 'root_pane'): HerdrPaneInfo {
  const pane = obj[key]
  if (!isObj(pane)) {
    throw new HelmxError('herdr_protocol_violation', `${method} result is missing the ${key} object`, 502, { method, key })
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
    throw new HelmxError('herdr_protocol_violation', 'worktree.create result is missing the worktree object', 502, {})
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
    throw new HelmxError('herdr_protocol_violation', `${method} result is missing the agent object`, 502, { method })
  }
  return {
    paneId: reqString(agent, method, 'pane_id'),
    tabId: reqString(agent, method, 'tab_id'),
    workspaceId: reqString(agent, method, 'workspace_id'),
    agent: optString(agent, 'agent'),
    name: optString(agent, 'name'),
    terminalId: optString(agent, 'terminal_id'),
    agentStatus: parseStatus(agent['agent_status'], method),
    stateChangeSeq: parseSeq(agent['state_change_seq'], method),
    launchPending: optBool(agent, 'launch_pending'),
    interactiveReady: optBool(agent, 'interactive_ready') ?? false,
    focused: optBool(agent, 'focused'),
    cwd: optString(agent, 'cwd'),
    foregroundCwd: optString(agent, 'foreground_cwd'),
  }
}

/** Shared agent_info shape for agent.start / agent.get / agent.wait / agent.prompt. */
export function parseAgentResult(result: unknown, method: string, expected: string): HerdrAgentInfo {
  const obj = expectType(result, method, expected)
  return parseAgentInfo(obj['agent'], method)
}

/** agent.read -> {type:'pane_read', read:{pane_id, text, ...}} */
export function parsePaneRead(result: unknown): PaneRead {
  const obj = expectType(result, 'agent.read', 'pane_read')
  const read = obj['read']
  if (!isObj(read)) {
    throw new HelmxError('herdr_protocol_violation', 'agent.read result is missing the read object', 502, {})
  }
  const text = read['text']
  if (typeof text !== 'string') throw new HelmxError('herdr_protocol_violation', 'agent.read text must be a string', 502)
  return { paneId: reqString(read, 'agent.read', 'pane_id'), text }
}

function isOkResult(result: unknown): boolean {
  return isObj(result) && result['type'] === 'ok'
}

/**
 * The panes[] rows of session.snapshot (an official PaneInfo subset; server src/api/schema/
 * panes.rs:527-560). A pane has no state_change_seq (seq only exists in AgentInfo); a plain
 * shell's agent_status is officially unknown -- both are preserved as-is, never fabricated.
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
  /** All local panes (incl. human shells); agents covers only Agent terminals, joined by paneId. */
  panes: HerdrPaneSnapshotInfo[]
}

export function parseSessionSnapshot(result: unknown): SessionSnapshotData {
  const obj = expectType(result, 'session.snapshot', 'session_snapshot')
  const snapshot = obj['snapshot']
  if (!isObj(snapshot)) {
    throw new HelmxError('herdr_protocol_violation', 'session.snapshot result is missing the snapshot object', 502, {})
  }
  const agents = snapshot['agents']
  if (!Array.isArray(agents)) {
    throw new HelmxError('herdr_protocol_violation', 'session.snapshot.agents must be an array', 502, {})
  }
  const panes = snapshot['panes']
  if (!Array.isArray(panes)) {
    throw new HelmxError('herdr_protocol_violation', 'session.snapshot.panes must be an array', 502, {})
  }
  const parsedAgents = agents.map((a) => parseAgentInfo(a, 'session.snapshot'))
  const parsedPanes = panes.map((p) => parsePaneSnapshotInfo(p, 'session.snapshot'))
  for (const [name, rows] of [['agents', parsedAgents], ['panes', parsedPanes]] as const) {
    const ids = new Set<string>()
    for (const row of rows) {
      if (ids.has(row.paneId)) {
        throw new HelmxError('herdr_protocol_violation', `session.snapshot.${name} contains duplicate pane_id`, 502)
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
    throw new HelmxError('herdr_protocol_violation', `session.snapshot.panes.${key} must be a string`, 502)
  }
  return value
}

function parsePaneSnapshotInfo(pane: unknown, method: string): HerdrPaneSnapshotInfo {
  if (!isObj(pane)) {
    throw new HelmxError('herdr_protocol_violation', `${method}.panes items must be objects`, 502, {})
  }
  const focused = pane['focused']
  if (typeof focused !== 'boolean') {
    throw new HelmxError('herdr_protocol_violation', `${method}.panes item ${String(pane['pane_id'])} is missing the boolean focused field`, 502, {})
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
 * Results expected to be 'ok' (tab.close / workspace.close / send_keys / report_metadata --
 * verified line-by-line against server source). A non-ok result throws an explicit protocol violation -- never silently treated as success.
 */
export function assertOkResult(result: unknown, method: string): void {
  if (!isOkResult(result)) {
    throw new HelmxError(
      'herdr_protocol_violation',
      `${method} should return {type:'ok'}, got: ${JSON.stringify(result)?.slice(0, 200)}`,
      502,
      { method, result },
    )
  }
}

// ---------------------------------------------------------------
// Protocol-level CAS for agent.send_keys (helmx-side contract; awaiting Herdr server support)
//
// Current evidence (/root/code/herdr server source, herdr 0.9.5 / protocol 22, read-only verification):
// - `AgentSendKeysParams` is only `{target, keys}` (src/api/schema/agents.rs:18-22),
//   with no CAS field; serde has no deny_unknown_fields -- blindly sending extra fields would be
//   **silently ignored while keys are written anyway** by old servers, exactly reproducing the approval-bridge residual window this contract closes;
// - `ping` -> `{type:'pong', version, protocol, capabilities}` (src/api/server.rs:337-347 and
//   src/api/schema/server.rs:17-24) is the official capability channel, extensible forward-compatibly via serde(default) fields.
//
// Hence the helmx-side contract (a proposal; end-to-end effective once the Herdr server ships support):
// - Capability advertisement: pong.capabilities.`send_keys_expected_state_seq` === true;
// - Request field: agent.send_keys params add `expected_state_seq: u64` (same root as AgentInfo's
//   existing `state_change_seq`, following the protocol's snake_case convention);
// - Rejection semantics: when the server's current state_change_seq != expected_state_seq, return the wire error
//   `stale_state` and **write no keystrokes**.
// Until the server ships support, the executor rejects CAS-less key sends via the capability gate (never silently degrades).
// ---------------------------------------------------------------

/** The field name (wire name) in pong.capabilities advertising agent.send_keys CAS support. */
export const SEND_KEYS_CAS_CAPABILITY = 'send_keys_expected_state_seq'

/** Server CAS rejection error code (wire error.code; semantics = keys not sent). */
const STALE_STATE_ERROR_CODE = 'stale_state'

/** agent.send_keys request (helmx-internal camelCase; the wire form is converted by buildSendKeysParams). */
interface SendKeysRequest {
  target: string
  keys: string[]
  /** CAS expected watermark: must equal the authoritative state_change_seq observed by the approval entry. */
  expectedStateSeq: number
}

/** Build agent.send_keys wire params (boundary validation: invalid target/keys/seq rejected explicitly). */
export function buildSendKeysParams(request: SendKeysRequest): Record<string, unknown> {
  if (typeof request.target !== 'string' || request.target.length === 0) {
    throw new HelmxError('validation_error', 'agent.send_keys target must be a non-empty string', 400, { target: request.target })
  }
  if (
    !Array.isArray(request.keys) ||
    request.keys.length === 0 ||
    request.keys.some((key) => typeof key !== 'string' || key.length === 0)
  ) {
    throw new HelmxError('validation_error', 'agent.send_keys keys must be a non-empty string array', 400, { keys: request.keys })
  }
  if (typeof request.expectedStateSeq !== 'number' || !Number.isSafeInteger(request.expectedStateSeq) || request.expectedStateSeq < 0) {
    throw new HelmxError(
      'validation_error',
      `agent.send_keys expectedStateSeq must be a non-negative safe integer: ${String(request.expectedStateSeq)}`,
      400,
      { expectedStateSeq: request.expectedStateSeq },
    )
  }
  return { target: request.target, keys: [...request.keys], expected_state_seq: request.expectedStateSeq }
}

// ---------------------------------------------------------------
// agent.prompt in-flight steer (existing protocol; steer uses it with preflight semantics)
//
// Current evidence (/root/code/herdr server source, herdr 0.9.5 / protocol 22, read-only verification):
// - `AgentPromptParams` is only `{target, text, wait}` (src/api/schema/agents.rs:176-181),
//   with no guard fields; serde has no deny_unknown_fields -- helmx never blindly sends proposed extension fields
//   (old servers would silently ignore them, making verification pointless);
// - Server admission rejects blocked / launch_pending / no known_agent / non-foreground CLI before
//   writing any PTY bytes (wire errors agent_blocked / agent_not_ready /
//   agent_not_found etc., zero writes); a submission that just turned idle after a working precheck is continued as
//   a new turn;
// - Admission is not a commit-point atomic recheck (lifecycle may still change between paste and Enter) --
//   helmx honestly reports preflight semantics (guardLevel 'preflight'); never claim CAS.
//
// Steer delivery shape: {target: managed agentName, text} (no wait, no extra fields, single
// delivery without retry); outcome determinism is guaranteed by the unique handoff-file-name redirect (see executor).
// ---------------------------------------------------------------

/** Server capability summary parsed from ping -> pong. */
interface HerdrServerInfo {
  version: string
  protocol: number
  /** Whether agent.send_keys supports expected_state_seq CAS (capabilities strictly advertises true). */
  sendKeysCas: boolean
}

/**
 * Strict pong boundary validation (real shape: type='pong' + version + protocol + optional capabilities):
 * - version/protocol missing or type-mismatched -> herdr_protocol_violation (bad data must not become
 *   the basis for capability decisions);
 * - capabilities missing/null -> capabilities honestly treated as unsupported (old servers);
 * - a capability field present but not boolean -> violation; supported only on strict === true.
 */
export function parsePong(result: unknown): HerdrServerInfo {
  const obj = expectType(result, 'ping', 'pong')
  const info: HerdrServerInfo = {
    version: reqString(obj, 'ping', 'version'),
    protocol: parseSeq(obj['protocol'], 'ping', 'protocol'),
    sendKeysCas: false,
  }
  const capabilities = obj['capabilities']
  if (capabilities === undefined || capabilities === null) return info
  if (!isObj(capabilities)) {
    throw new HelmxError('herdr_protocol_violation', 'ping capabilities must be an object or null', 502, { capabilities })
  }
  const casValue = capabilities[SEND_KEYS_CAS_CAPABILITY]
  if (casValue !== undefined) {
    if (typeof casValue !== 'boolean') {
      throw new HelmxError(
        'herdr_protocol_violation',
        `ping capabilities.${SEND_KEYS_CAS_CAPABILITY} must be a boolean, got: ${JSON.stringify(casValue)}`,
        502,
        { value: casValue },
      )
    }
    info.sendKeysCas = casValue
  }
  return info
}

/**
 * Server CAS rejection detection: wire error.code === 'stale_state' (becomes HerdrTransportError.code
 * via transport raiseWireError; the structured check also tolerates the in-process HelmxError
 * shape). Semantics = keys not sent; callers must not treat it as a successful send.
 */
export function isStaleStateError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === STALE_STATE_ERROR_CODE
}
