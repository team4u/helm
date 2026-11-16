import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { AgentGateResult, AskFieldOption, Profile, RpcResult } from '@helm/protocol'
import type { BlockedSnapshotAnalysis } from './prompt-options.js'

/** One server, selected consistently for commands, files and event subscriptions. */
export interface HerdrTarget {
  /** Target compute node ID (defaults to local; 'local' explicitly means local). */
  nodeId?: string
  session?: string
  socketPath?: string
}

/**
 * Target node ID ('local' folds to undefined = local; anything else returned as-is).
 * Empty strings do not fold: entry validation (isValidNodeId) must reject them explicitly, never silently treat as local.
 */
export function targetNodeId(target: HerdrTarget | undefined): string | undefined {
  const id = target?.nodeId
  return id === undefined || id === 'local' ? undefined : id
}

/**
 * Cross-node channel: provided by the kernel EnvFabric public ports (nodeIpc / executionEnv) or a test
 * fixture; transport uses it to connect to the local Herdr IPC on the target node, read/write handoff files
 * and run Gates (thoroughly replacing ssh + python3 scripts).
 *
 * Endpoint semantics (the remote node resolves itself; never carry the Hub-local platform/dirs):
 * - `endpoint` is passed only when the target explicitly gives a socketPath (optional);
 * - `session` passes an explicit session name (optional);
 * - the target node itself resolves HERDR_SOCKET_PATH / platform config dirs and the endpoint form (UDS or
 *   Named Pipe); the Hub never imposes its local resolveSocketPath or endpointKind on the remote.
 *
 * Cancellation semantics: all methods accept a plain AbortSignal (same shape as the host public ports);
 * transport-internal file/command operations still derive via the SDK Context (see HerdrNodeEnv).
 */
export interface HerdrNodeChannel {
  /** Whether the node is online ('local' is always true). */
  isOnline(nodeId: string): boolean
  /** Get the node's registered reachable Hub URL (if any; auto-injected as HELM_HUB_URL for remote panes). */
  getNodeHubUrl?(nodeId: string): string | undefined
  /**
   * The node's trusted platform report (NodeRegistry registration fact, e.g. 'linux' / 'win32';
   * unreported / unreachable returns undefined): resolveCwd normalizes the cwd by the target
   * node's platform. When absent the remote platform is unknown (no guessing, no rewriting).
   */
  nodePlatform?(nodeId: string): string | undefined
  /** Execute a single local Herdr line-protocol IPC request on the target node (supports signal cancellation; cancels the underlying connection immediately). */
  ipcCall(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RpcResult<string>>
  /** Get the file and command execution environment on the target node. */
  envFor(nodeId: string, cwd: string): HerdrNodeEnv
  /**
   * Optional: remote node IPC event stream subscription.
   * A successful Promise resolve means the subscription request was confirmed by the target node (the ACK is consumed
   * and validated at the channel layer); afterwards onLine pushes only bare event frames, never a second fabricated ACK.
   */
  ipcSubscribe?(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string },
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
}

/**
 * The env contract of `HerdrNodeChannel.envFor`: a Pick of the SDK `ExecutionEnv` core subset.
 * NodeExecutionEnv / the host executionEnv port structures are assignable (no as-masking).
 */
export type HerdrNodeEnv = Pick<
  ExecutionEnv,
  'canonicalPath' | 'fileInfo' | 'readTextFile' | 'remove' | 'exec'
>

export interface HerdrCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type HerdrEvent =
  | {
      type:
        | 'pane.created'
        | 'pane.updated'
        | 'pane.closed'
        | 'pane.exited'
        | 'pane.focused'
        | 'pane.moved'
        | 'pane.agent_status_changed'
      paneId: string
    }
  | { type: 'tab.closed'; tabId: string; workspaceId: string; paneId?: never }
  | { type: 'workspace.closed'; workspaceId: string; paneId?: never }

/** Subscription options: paneIds appends a pane.agent_status_changed filter subscription per pane; signal cancels the whole subscription. */
export interface HerdrSubscribeOptions {
  paneIds?: string[]
  signal?: AbortSignal
}

/** Responses are unwrapped RPC results; each consumer validates its boundary shape. */
export interface HerdrTransport {
  call(target: HerdrTarget, method: string, params: Record<string, unknown>, options?: HerdrCallOptions): Promise<unknown>
  readOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<string>
  removeOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<void>
  runGate(target: HerdrTarget, command: string, cwd: string, signal?: AbortSignal, env?: Record<string, string>): Promise<AgentGateResult>
  /** Local event subscription. Errors terminate the stream and are reported to the owner. */
  subscribe(
    target: HerdrTarget,
    onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
    options?: HerdrSubscribeOptions,
  ): Promise<() => void>
}

export interface HerdrPluginDependencies {
  profiles: { get(id: string): Promise<Profile | undefined> }
  /**
   * External spawn environment variables: the target node's managed call-home set (managed HELM_*; by default no
   * parent-conversation stash secrets are carried -- minimal authorization for external panes).
   * nodeId is the actually chosen target node ('local' explicitly means local; never pass undefined for
   * kernel parent-conversation inheritance -- a parent bound to a remote node would mis-configure local panes onto the remote).
   * Parent-conversation secrets are injected by name only with explicit secretNames (must exist; missing throws explicitly);
   * never carry the whole inherited process environment.
   */
  buildSpawnEnv(
    conversationId: number,
    cwd: string,
    nodeId: string,
    options?: { secretNames?: string[] },
  ): Record<string, string>
  redact(text: string): string
  runLocalGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<AgentGateResult>
  /** Attachment artifact metadata resolution (incl. authorization checks; nonexistent/unauthorized throws HelmError). Optional injection. */
  getArtifact?: (
    id: string,
    conversationId: number,
  ) => Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }>
  /** Cross-node channel (injected by EnvFabric; when absent, remote targets fail explicitly, never silently falling back to local). */
  nodeChannel?: HerdrNodeChannel
  transport?: HerdrTransport
  /** Same-seq blocked backoff base and cap (shortened in tests; defaults 500ms / 4000ms). */
  blockedBackoffBaseMs?: number
  blockedBackoffCapMs?: number
  /** Approval polling interval (shortened in tests; default 100ms). */
  pollIntervalMs?: number
  /** Ask liveness poll transient-failure backoff base and cap (shortened in tests; production defaults 500ms / 4000ms). */
  askPollTransientBackoffBaseMs?: number
  askPollTransientBackoffCapMs?: number
  /** Post-abort cancellation backoff cap (shortened in tests; production default 3200ms). */
  abortCancelBackoffCapMs?: number
  /** md handoff stability recheck interval (shortened in tests; production default 300ms). */
  mdStableRecheckMs?: number
  /** Event subscription reconnect backoff base and cap (shortened in tests; production defaults 1000ms / 60000ms). */
  subscriptionRetryBaseMs?: number
  subscriptionRetryCapMs?: number
  /** Budget for waiting for the follow-up turn to start after a steer (shortened in tests; production default reuses startupTimeoutMs()). */
  steerWaitBudgetMs?: number
  /**
   * Optional: when the deterministic regex has not recognized a standard menu from the blocked snapshot,
   * invoke the conversation model to parse the redacted terminal snapshot and extract candidate keystroke options.
   * When analysis is undefined, attach a diagnostic (a redacted short diagnostic for notification/description only,
   * without snapshot or raw response text); on external signal cancellation, reject with the original error (propagates immediately, no fallback).
   */
  analyzeBlockedSnapshot?: (input: {
    snapshot: string
    conversationId: number
    signal?: AbortSignal
  }) => Promise<{ analysis: BlockedSnapshotAnalysis | undefined; diagnostic?: string }>
}

export type { BlockedSnapshotAiOption, BlockedSnapshotAnalysis } from './prompt-options.js'

/**
 * builtin:herdr's published steer control reference (execution meta control item):
 * the executor (executionInfoOf) and the plugin action registration share the same constant; the coordinates
 * correspond to the ExternalSteerRequest/Result contract in the plugins package's shared contracts module (contracts.ts).
 */
export const HERDR_STEER_CONTROLS = {
  pluginId: 'builtin:herdr',
  actionId: 'steer',
} as const

/** The minimal shape of ctx.host.createAsk (aligned with AskCreateSpec/AskResult). */
export interface CreateAskSpecLike {
  id?: string
  conversationId: number
  ownerPluginId: string
  title: string
  description?: string
  fields: Array<{
    name: string
    label: string
    type: 'text' | 'select' | 'confirm'
    options?: Array<AskFieldOption>
    required?: boolean
  }>
  expectedStateSeq?: number
}

export interface CreateAskResultLike {
  id: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers: Record<string, string>
}

export interface HerdrConfig {
  session: string
  socketPath: string
  startupTimeoutMs: number
}
