/**
 * Node management: token issuance / CLI bin installation / disk and health stats / NodeInfo assembly /
 * node upgrade state machine / cross-node command execution.
 *
 * Extracted from runtime.ts (splitting an oversized class into a focused responsibility cluster). Mechanism layer:
 * contains no business role concepts; upgrade waiting relies on EnvFabric registry's beginUpgrade waiter racing node RPC.
 */
import { randomBytes } from 'node:crypto'
import { hostname, loadavg, freemem, totalmem, uptime } from 'node:os'
import { access, chmod, mkdir, readFile, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type EnvExecRequest, type EnvExecResponse, type NodeEnvRpcFunctions, type NodeHealthSnapshot, type NodeInfo, type NodeIssuedToken, type NodeUpgradeCheckInput, type NodeUpgradeCheckResult, type NodeUpgradeResult, type RpcResult } from '@helm/protocol'
import { sha256hex, type EnvFabric } from '../env/index.js'
import type { ConfigService } from '../services/index.js'
import type { SecretStash } from '../services/index.js'
import { isAbsoluteTargetPath, runShell } from './tools.js'
import { invalidPathText, normalizePathForTarget, targetPlatformForNode } from './target-platform.js'
import { buildPosixHostShim, buildWindowsCmdWrapper, buildWindowsPosixShim, type CliShimPlan } from './cli-shim.js'
import type { HelmToolDeps } from './tool-deps.js'
import { compareStrictSemVer, hubVersion, isStrictSemVer, normalizeExplicitVersion, rpcFailureToHelmError, safeJson, unwrapUpgradeCheckRpc, unwrapUpgradeRpc, validateUpgradeCheckResult, validateUpgradeResult } from './semver.js'

/** Background refresh interval for local disk stats (unref timer, never blocks process exit). */
const LOCAL_DISK_REFRESH_MS = 30_000

interface NodeManagerOptions {
  readonly dataDir: string
  readonly envFabric: EnvFabric
  readonly configSvc: ConfigService
  readonly stash: SecretStash
  readonly toolDeps: HelmToolDeps
  readonly events: { publish(type: 'notification', payload: unknown): void; publish(type: 'node.changed', payload: unknown): void }
  /** Node upgrade confirmation timeout in milliseconds (default 120000). */
  readonly nodeUpgradeTimeoutMs: number
}

/**
 * Raw node RpcResult shapes (type reference for conn.rpc.nodeCheckUpgrade returns).
 * Validated uniformly via unwrap* helpers in semver.ts (invalid shapes yield 502, never passing through dirty data).
 */
type UpgradeRpcCheck = RpcResult<NodeUpgradeCheckResult>
type UpgradeRpcResult = RpcResult<NodeUpgradeResult>

export class NodeManager {
  private readonly dataDir: string
  readonly envFabric: EnvFabric
  private readonly configSvc: ConfigService
  private readonly stash: SecretStash
  private readonly toolDeps: HelmToolDeps
  private readonly events: NodeManagerOptions['events']
  readonly NODE_UPGRADE_TIMEOUT_MS: number
  /** Node token index registered in config.json (nodeId -> sha256(token)). */
  private readonly nodeTokenIndex = new Map<string, string>()
  /** helm CLI wrapper script directory (populated after ensureCliBinDir completes). */
  private cliBinDirValue: string | undefined = undefined
  /** Cached local node disk stats (collected asynchronously via fs.statfs; reused by synchronous snapshots). */
  private localDiskStats: { diskFreeBytes: number; diskTotalBytes: number } | undefined
  /** Background refresh timer for local disk stats (unref'd; cleaned up on close). */
  private localDiskRefreshTimer: NodeJS.Timeout | undefined
  /** In-flight local disk stats refresh (singleflight to prevent stacking). */
  private localDiskRefreshing: Promise<void> = Promise.resolve()
  /** Auto-upgrade deduplication: attempt at most one automatic upgrade round per node per process lifecycle. */
  readonly #autoUpgradeAttempted = new Set<string>()

  /** Conversation metadata resolver (host injects store.getConv + 404 semantics). */
  private readonly convOf: (conversationId: number) => { nodeId?: string; cwd: string }

  constructor(options: NodeManagerOptions & { convOf: (conversationId: number) => { nodeId?: string; cwd: string } }) {
    this.dataDir = options.dataDir
    this.envFabric = options.envFabric
    this.configSvc = options.configSvc
    this.stash = options.stash
    this.toolDeps = options.toolDeps
    this.events = options.events
    this.NODE_UPGRADE_TIMEOUT_MS = options.nodeUpgradeTimeoutMs
    this.convOf = options.convOf
  }

  /** Auto-upgrade runs only when HELM_AUTO_UPGRADE_NODES=1 is explicitly enabled (disabled by default). */
  private get autoUpgradeEnabled(): boolean {
    return process.env['HELM_AUTO_UPGRADE_NODES'] === '1'
  }

  get cliBinDir(): string | undefined {
    return this.cliBinDirValue
  }

  // ------------------------------------------------------------------
  // Token registry (config.json.nodes)
  // ------------------------------------------------------------------

  /** Load config.json nodes token table (nodeId -> sha256(token)); throws explicitly if corrupted. */
  async loadNodeTokens(): Promise<void> {
    const config = await this.configSvc.get()
    const nodes = config['nodes']
    this.nodeTokenIndex.clear()
    if (nodes === undefined) return
    if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
      throw new HelmError('config_corrupt', 'config.json.nodes must be an object (nodeId -> sha256(token))', 500)
    }
    for (const [nodeId, digest] of Object.entries(nodes as Record<string, unknown>)) {
      if (typeof digest !== 'string' || digest === '') {
        throw new HelmError('config_corrupt', `config.json.nodes['${nodeId}'] must be a non-empty digest string`, 500)
      }
      this.nodeTokenIndex.set(nodeId, digest)
    }
  }

  /** Persist current token table back to config.json.nodes. */
  private async persistNodeTokens(): Promise<void> {
    const nodes: Record<string, string> = {}
    for (const [nodeId, digest] of this.nodeTokenIndex) nodes[nodeId] = digest
    await this.configSvc.update({ nodes })
  }

  hasNode(nodeId: string): boolean {
    return this.nodeTokenIndex.has(nodeId)
  }

  /** Read token digest directly (consumed by EnvFabric fail-closed authentication; nodeId -> sha256(token)). */
  nodeDigestOf(nodeId: string): string | undefined {
    return this.nodeTokenIndex.get(nodeId)
  }

  /** Issue a node access token: plaintext token is returned only this once; the server retains only sha256. */
  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_issue_local', 'local is a built-in node and does not need an access token', 400, { nodeId })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      throw new HelmError(
        'validation_error',
        'nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ ' +
          '(must start with an alphanumeric character, may contain . _ -, max length 128)',
        400,
        { nodeId },
      )
    }
    const secret = randomBytes(24).toString('base64url')
    const token = `${nodeId}:${secret}`
    this.nodeTokenIndex.set(nodeId, sha256hex(token))
    await this.persistNodeTokens()
    // Outbound secret redaction for plaintext token (never written to DB, injected into model context, or logged).
    this.stash.addRedaction(token)
    this.stash.addRedaction(secret)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: this.envFabric.isOnline(nodeId) },
    })
    return { nodeId, token, createdAt: Date.now() }
  }

  /** Remove a node: deletes from token table and immediately severs any in-flight WS connection. */
  async removeNode(nodeId: string): Promise<void> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_remove_local_node', 'local is a built-in node and cannot be removed', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `node not found: ${nodeId}`, 404, { nodeId })
    }
    this.nodeTokenIndex.delete(nodeId)
    await this.persistNodeTokens()
    // Sever any in-flight connection first (may fire onNodeChanged offline callback, which skips because
    // nodeTokenIndex no longer has the entry), then emit the unified removal event with removed: true.
    this.envFabric.registry.disconnect(nodeId)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: false },
      removed: true,
    })
  }

  // ------------------------------------------------------------------
  // CLI bin wrapper scripts
  // ------------------------------------------------------------------

  /**
   * Generate `<dataDir>/bin` wrapper scripts so managed child processes can run `helm` directly via PATH
   * with `--current` semantics working out of the box:
   * - POSIX host: `helm` = `#!/bin/sh` exec shim (cli-shim.buildPosixHostShim);
   * - win32 host: `helm.cmd` = cmd.exe wrapper (preserves existing behavior); `helm` = POSIX shim for
   *   WSL / Git Bash—resolves via wslpath/cygpath to a binary runnable by node.exe while keeping the Windows entry path,
   *   emitting an explicit diagnostic and exiting 127 on resolution failure rather than falling back to Linux node (cli-shim.buildWindowsPosixShim).
   * Idempotent: overwrites only when contents change, always chmods 0o755. Defaults platform/execPath to current process
   * (tests inject simulated win32 hosts; generation logic lives in pure helpers in cli-shim.ts).
   */
  async ensureCliBinDir(
    override: { platform?: NodeJS.Platform; execPath?: string } = {},
  ): Promise<void> {
    const platform = override.platform ?? process.platform
    const execPath = override.execPath ?? process.execPath
    const binDir = join(this.dataDir, 'bin')
    const helmPath = join(binDir, 'helm')
    let plan: CliShimPlan
    // Explicit CLI entry (packaged payload layouts have no packages/cli directory, so upward lookup would find nothing).
    // Accepts only a single entry file path.
    const explicitEntry = process.env.HELM_CLI_ENTRY
    if (explicitEntry) {
      plan = { execPath, entryArgs: [explicitEntry] }
    } else {
      // Dev tsx CLI and repo CLI entry: inferred from current module location (works identically in src and dist runs).
      const kernelDir = dirname(fileURLToPath(import.meta.url))
      const repoRoot = this.resolveRepoRoot(kernelDir)
      const compiledCli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
      const sourceCli = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
      const compiled = await access(compiledCli).then(() => true, () => false)
      // Source kernel must pair with source CLI so stale dist command tables never mix with newer protocol contracts.
      const useCompiled = basename(dirname(kernelDir)) !== 'src' && compiled
      plan = {
        execPath,
        entryArgs: useCompiled
          ? [compiledCli]
          : [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), sourceCli],
      }
    }
    const script =
      platform === 'win32' ? buildWindowsPosixShim(plan) : buildPosixHostShim(plan)
    try {
      await mkdir(binDir, { recursive: true })
      const existing = await readFile(helmPath, 'utf8').catch(() => undefined)
      if (existing !== script) {
        await writeFile(helmPath, script, 'utf8')
      }
      await chmod(helmPath, 0o755)
      if (platform === 'win32') {
        await writeFile(join(binDir, 'helm.cmd'), buildWindowsCmdWrapper(plan), 'utf8')
      }
      this.cliBinDirValue = binDir
    } catch (error) {
      // Wrapper generation failure must not block kernel startup (managed child processes can still invoke by absolute path),
      // but always notify explicitly rather than swallowing silently.
      this.events.publish('notification', {
        level: 'warning',
        title: 'Failed to generate helm CLI wrapper script',
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  /** Infer repository root from kernel module location (src/runtime or dist/runtime -> up two levels). */
  private resolveRepoRoot(kernelDir: string): string {
    // src/runtime or dist/runtime -> packages/kernel/<x> -> repository root.
    return dirname(dirname(dirname(dirname(kernelDir))))
  }

  // ------------------------------------------------------------------
  // Local disk / health stats
  // ------------------------------------------------------------------

  /** Collect local disk space once via fs.statfs(dataDir) (retains previous cache on error so list is never blocked). */
  private async refreshLocalDiskStats(): Promise<void> {
    try {
      const st = await statfs(this.dataDir)
      this.localDiskStats = {
        diskFreeBytes: Number(st.bavail) * Number(st.bsize),
        diskTotalBytes: Number(st.blocks) * Number(st.bsize),
      }
    } catch {
      // Disk stat failure does not fail the node list itself (health disk fields stay omitted); keep the last valid cached sample.
    }
  }

  /** Asynchronously refresh local disk cache (singleflight); first call also schedules periodic background refreshes. */
  ensureLocalDiskStats(): Promise<void> {
    this.localDiskRefreshing = this.localDiskRefreshing.then(() => this.refreshLocalDiskStats())
    if (this.localDiskRefreshTimer === undefined) {
      this.localDiskRefreshTimer = setInterval(
        () => void this.ensureLocalDiskStats(),
        LOCAL_DISK_REFRESH_MS,
      )
      this.localDiskRefreshTimer.unref()
    }
    return this.localDiskRefreshing
  }

  /** Live health snapshot for the local node (memory/load sampled live; disk uses the most recent cached sample). */
  private localHealthSnapshot(): NodeHealthSnapshot {
    const [la1, la5, la15] = loadavg()
    const health: NodeHealthSnapshot = {
      collectedAt: Date.now(),
      uptimeSec: uptime(),
      loadAvg: [la1 ?? 0, la5 ?? 0, la15 ?? 0],
      memFreeBytes: freemem(),
      memTotalBytes: totalmem(),
    }
    const disk = this.localDiskStats
    if (disk !== undefined) {
      health.diskFreeBytes = disk.diskFreeBytes
      health.diskTotalBytes = disk.diskTotalBytes
    }
    return health
  }

  /**
   * Assemble NodeInfo for a registered (byom) node: shared by onNodeChanged events and listNodesSync
   * (single source of truth for optional field projection, eliminating duplicate assembly logic).
   */
  byomNodeInfo(nodeId: string, conn: { hostname?: string; platform?: string; version?: string; hubUrl?: string; connectedAt?: number; lastSeenAt?: number; health?: NodeHealthSnapshot } | undefined): NodeInfo {
    return {
      id: nodeId,
      kind: 'byom',
      online: conn !== undefined,
      ...(conn?.hostname !== undefined ? { hostname: conn.hostname } : {}),
      ...(conn?.platform !== undefined ? { platform: conn.platform } : {}),
      ...(conn?.version !== undefined ? { version: conn.version } : {}),
      ...(conn?.hubUrl !== undefined ? { hubUrl: conn.hubUrl } : {}),
      ...(conn?.connectedAt !== undefined ? { connectedAt: conn.connectedAt } : {}),
      ...(conn?.lastSeenAt !== undefined ? { lastSeenAt: conn.lastSeenAt } : {}),
      ...(conn?.health !== undefined ? { health: conn.health } : {}),
    }
  }

  /** Local node NodeInfo (version always comes from Hub itself; health is a live snapshot). */
  localNodeInfo(): NodeInfo {
    return {
      id: 'local',
      kind: 'local',
      online: true,
      hostname: hostname(),
      platform: process.platform,
      version: hubVersion(),
      health: this.localHealthSnapshot(),
    }
  }

  /** List nodes: local is always first, followed by registered nodes from config.json and their live online status. */
  async listNodes(): Promise<NodeInfo[]> {
    await this.ensureLocalDiskStats()
    return this.listNodesSync()
  }

  /** Synchronous variant (used by SSE snapshot provider; shares the exact same data source as listNodes). */
  listNodesSync(): NodeInfo[] {
    const out: NodeInfo[] = [this.localNodeInfo()]
    for (const nodeId of this.nodeTokenIndex.keys()) {
      out.push(this.byomNodeInfo(nodeId, this.envFabric.registry.get(nodeId)))
    }
    return out
  }

  // ------------------------------------------------------------------
  // Node upgrade (check / upgrade state machine)
  // ------------------------------------------------------------------

  /** Upgrade preflight: reject local, 404 unknown, 409 offline; returns current online connection. */
  private requireUpgradableConnection(nodeId: string): { version?: string; rpc: NodeEnvRpcFunctions } {
    if (nodeId === 'local') {
      throw new HelmError('cannot_upgrade_local', 'local runs in-process with Hub; upgrade Hub to upgrade local', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `node not found: ${nodeId}`, 404, { nodeId })
    }
    const conn = this.envFabric.registry.get(nodeId)
    if (conn === undefined) {
      throw new HelmError('node_offline', `node offline: ${nodeId}`, 409, { nodeId })
    }
    return conn
  }

  /**
   * Check available updates for a node (GET /api/nodes/:id/upgrade/check): forwards nodeCheckUpgrade RPC
   * and validates both RpcResult and payload boundaries.
   * - local: 400 (unsupported); unknown node: 404; offline: 409;
   * - node does not support upgrades: 501; RPC transport error / invalid result: 400/502.
   */
  async checkNodeUpgrade(nodeId: string, input: NodeUpgradeCheckInput = {}): Promise<NodeUpgradeCheckResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeCheckUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `node ${nodeId} does not support upgrades (outdated @helm/node)`, 501, { nodeId })
    }
    let result: UpgradeRpcCheck
    try {
      result = await conn.rpc.nodeCheckUpgrade(input)
    } catch (error) {
      throw new HelmError(
        'node_upgrade_unavailable',
        `node ${nodeId} upgrade check call failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
        { nodeId },
      )
    }
    return unwrapUpgradeCheckRpc(nodeId, result)
  }

  /**
   * Trigger a node upgrade (POST /api/nodes/:id/upgrade):
   * 1. Resolve exact targetVersion (normalize explicit version; if omitted, check first and pick latest);
   *    resolve previousVersion from the node's reported current version (check if missing, never fabricate 'unknown'
   *    which would never match commit confirmation);
   * 2. Generate a random attemptId, arm the registry upgrade waiter first, then invoke conn.rpc.nodeUpgrade
   *    and race it directly against timeout (bounded even if RPC hangs instead of waiting for birpc's 30m default),
   *    avoiding unhandled rejections if the RPC settles late;
   * 3. Valid no-op return (ok/upgraded:false) -> cancel waiter and return verbatim;
   * 4. RPC failure / invalid result -> cancel waiter and fail; underlying socket disconnect -> keep waiting for
   *    commit confirmation rather than faking success; timeout without confirmation -> 502 unconfirmed error;
   * 5. All non-commit exit paths clean up the waiter in finally (never leaving future upgrades permanently busy).
   */
  async upgradeNode(
    nodeId: string,
    input: { targetVersion?: string; registryUrl?: string; force?: boolean } = {},
  ): Promise<NodeUpgradeResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `node ${nodeId} does not support upgrades (outdated @helm/node)`, 501, { nodeId })
    }
    const { targetVersion, previousVersion } = await this.resolveUpgradeVersions(nodeId, conn.version, input)
    const attemptId = randomBytes(16).toString('hex')
    const waiter = this.envFabric.registry.beginUpgrade(nodeId, {
      attemptId,
      targetVersion,
      previousVersion,
      timeoutMs: this.NODE_UPGRADE_TIMEOUT_MS,
    })
    // Ensure non-commit exit paths always clean up the waiter so future upgrades do not stay locked.
    const finallyCancel = (): void => {
      waiter.cancel(new HelmError('node_upgrade_cancelled', `upgrade waiter for node ${nodeId} terminated`, 502))
    }
    try {
      return await this.settleUpgradeAttempt(nodeId, conn, {
        targetVersion,
        attemptId,
        input,
        waiter,
      })
    } finally {
      finallyCancel()
    }
  }

  /** Resolve target and baseline versions: normalize explicit target, or fetch missing values via check RPC (never fabricates). */
  private async resolveUpgradeVersions(
    nodeId: string,
    nodeVersion: string | undefined,
    input: { targetVersion?: string; registryUrl?: string },
  ): Promise<{ targetVersion: string; previousVersion: string }> {
    // Explicit target version: trim + strip single v prefix + strict SemVer; normalized value is used consistently
    // for attempt creation, RPC call, and commit reconciliation (all three share the same source).
    const explicitTarget =
      input.targetVersion !== undefined && input.targetVersion !== ''
        ? normalizeExplicitVersion(input.targetVersion)
        : undefined
    let targetVersion = explicitTarget
    let previousVersion = nodeVersion !== undefined && isStrictSemVer(nodeVersion) ? nodeVersion : undefined
    if (targetVersion === undefined || previousVersion === undefined) {
      const check = await this.checkNodeUpgrade(nodeId, {
        ...(input.registryUrl !== undefined ? { registryUrl: input.registryUrl } : {}),
      })
      if (targetVersion === undefined) targetVersion = normalizeExplicitVersion(check.latestVersion)
      if (previousVersion === undefined) previousVersion = normalizeExplicitVersion(check.currentVersion)
    }
    return { targetVersion: targetVersion!, previousVersion: previousVersion! }
  }

  /**
   * Settle a single upgrade attempt (extracted from upgradeNode to cap nesting depth at 4 levels).
   *
   * Race semantics invariant: RPC and waiter (commit / timeout) race only once; afterward only commitPromise is awaited
   * (the waiter owns its bounded timer); never re-race an already-settled rpcPromise (which replays the same failure
   * immediately and would prematurely turn a post-disconnect wait-for-commit into a terminal failure).
   * birpc $close sets $closed first and rejects in-flight calls; ws-gateway's onGeneralError returning true swallows that
   * rejection into resolve(undefined). Thus only when reply is undefined AND the rpc instance used for this call is actually
   * closed do we treat it as transport interruption (e.g. preempted by new connection on old socket) and wait for commit;
   * any other invalid reply still fails 502 instead of hanging.
   */
  private async settleUpgradeAttempt(
    nodeId: string,
    conn: { version?: string; rpc: NodeEnvRpcFunctions },
    plan: {
      targetVersion: string
      attemptId: string
      input: { targetVersion?: string; registryUrl?: string; force?: boolean }
      waiter: { result: Promise<NodeUpgradeResult> }
    },
  ): Promise<NodeUpgradeResult> {
    const { targetVersion, attemptId, input, waiter } = plan
    const rpcTransport = conn.rpc as NodeEnvRpcFunctions & { readonly $closed?: boolean }
    const nodeUpgradeCall = rpcTransport.nodeUpgrade!
    const rpcPromise = Promise.resolve(
      nodeUpgradeCall({
        targetVersion,
        ...(input.registryUrl !== undefined ? { registryUrl: input.registryUrl } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        attemptId,
      }),
    ).then(
      (value) => {
        if ((value as unknown) === undefined && rpcTransport.$closed === true) {
          return {
            kind: 'rpcError' as const,
            error: new Error(
              'in-flight nodeUpgrade call closed because the old socket was preempted (birpc $close rejection was swallowed into undefined by onGeneralError)',
            ),
          }
        }
        return { kind: 'rpc' as const, value }
      },
      (error: unknown) => ({ kind: 'rpcError' as const, error }),
    )
    const commitPromise = waiter.result.then(
      (value) => ({ kind: 'commit' as const, value }),
      (error: unknown) => ({ kind: 'waiterError' as const, error }),
    )
    // When RPC finishes after commit wins the race, the losing branch isn't read again, so pre-attaching `.then`
    // turns any late rejection into a plain value with zero unhandled-rejection risk.
    const first = await Promise.race([commitPromise, rpcPromise])
    if (first.kind === 'commit') {
      return first.value
    }
    if (first.kind === 'waiterError') {
      // Waiter terminated (timeout/cancel) before RPC returned: upgrade result unconfirmed.
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, first.error, 'result unconfirmed')
    }
    if (first.kind === 'rpcError') {
      // Transport disconnected (expected when old socket is preempted by reconnecting process): not terminal—keep waiting
      // for commit (new connection registers with attemptId).
      const failure = first.error instanceof Error ? first.error.message : String(first.error)
      const settled = await commitPromise
      if (settled.kind === 'commit') return settled.value
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, `upgrade trigger failed and unconfirmed (transport disconnected): ${failure}`)
    }
    // first.kind === 'rpc': structured reply from node (validate and handle no-op vs started upgrade).
    return this.settleStructuredRpcReply(nodeId, { targetVersion, attemptId, input }, commitPromise, first.value)
  }

  /** Construct unified unconfirmed-result error (502; attaches attemptId and targetVersion diagnostics). */
  private unconfirmedError(nodeId: string, targetVersion: string, attemptId: string, cause: unknown, lead: string): HelmError {
    const message = cause instanceof Error ? cause.message : String(cause)
    return new HelmError(
      'node_upgrade_unconfirmed',
      `node ${nodeId} upgrade to ${targetVersion} ${lead}: ${message}`,
      502,
      { nodeId, attemptId, targetVersion },
    )
  }

  /** Settle structured RPC reply from node: 502 invalid shape / rethrow structured rejection / verify no-op / wait for commit if started. */
  private async settleStructuredRpcReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    commitPromise: Promise<{ kind: 'commit'; value: NodeUpgradeResult } | { kind: 'waiterError'; error: unknown }>,
    rpcResult: unknown,
  ): Promise<NodeUpgradeResult> {
    const { targetVersion, attemptId, input } = plan
    // Validate RpcResult envelope first (object / boolean ok / valid value or error.code+message); invalid shapes fail with 502.
    if (!isRpcResultEnvelope(rpcResult)) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} upgrade returned invalid RpcResult (non-object or malformed ok/error): ${safeJson(rpcResult)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (rpcResult.ok !== true) {
      // Node returned a structured rejection (not_supported / invalid / ...): fail explicitly.
      throw rpcFailureToHelmError(nodeId, 'upgrade', rpcResult.error as { code: string; message: string })
    }
    const value = validateUpgradeResult(nodeId, rpcResult.value as NodeUpgradeResult)
    if (!value.ok) {
      throw new HelmError('node_upgrade_failed', `node ${nodeId} reported upgrade incomplete`, 502, { nodeId, attemptId, targetVersion })
    }
    if (value.upgraded === false) {
      return this.settleNoOpReply(nodeId, plan, value)
    }
    // Node reported upgrade workflow started: the only valid terminal confirmation is a matching commit.
    // Await only commitPromise here (waiter carries its own bounded timer; never re-race an already-settled RPC).
    const settled = await commitPromise
    if (settled.kind === 'commit') return settled.value
    throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, 'result unconfirmed')
  }

  /** Verify a no-op reply (no valid no-op under force; reported versions must match the pinned target). */
  private settleNoOpReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    value: NodeUpgradeResult,
  ): NodeUpgradeResult {
    const { targetVersion, attemptId, input } = plan
    // Node explicitly reported no-op (e.g. already at target version): requires ok:true and both previous/target
    // matching the pinned target (never trust mismatched reports); under force there is no valid no-op
    // (force reinstall must produce an upgrade), so reject unconditionally with 502.
    if (input.force === true) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} returned a no-op result for a forced upgrade (force does not accept no-op): ${safeJson(value)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (value.previousVersion !== targetVersion || value.targetVersion !== targetVersion) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} upgrade no-op result does not match pinned target (expected previous/target=${targetVersion}, got previous=${value.previousVersion}, target=${value.targetVersion})`,
        502,
        { nodeId, attemptId, targetVersion, result: value },
      )
    }
    return value
  }

  /**
   * Auto-upgrade eligible nodes when HELM_AUTO_UPGRADE_NODES=1: triggers only when strict SemVer lags behind Hub;
   * deduplicated (once per node); failures emit a warning notification without blocking registration.
   */
  async autoUpgradeIfEligible(nodeId: string, version: string | undefined): Promise<void> {
    if (!this.autoUpgradeEnabled) return
    if (this.#autoUpgradeAttempted.has(nodeId)) return
    if (version === undefined || !isStrictSemVer(version)) return
    const hub = hubVersion()
    if (compareStrictSemVer(version, hub) >= 0) return
    this.#autoUpgradeAttempted.add(nodeId)
    try {
      await this.upgradeNode(nodeId, { targetVersion: hub })
    } catch (error) {
      this.events.publish('notification', {
        level: 'warning',
        title: `Auto-upgrade failed for node ${nodeId}`,
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  // ------------------------------------------------------------------
  // Cross-node command execution (execEnv)
  // ------------------------------------------------------------------

  /**
   * Cross-node command execution (POST /api/env/exec): runs a command on target (nodeId, cwd).
   * Returns 409 node_offline if remote node is offline (never falls back to local); onChunk streams stdout/stderr
   * chunks (for NDJSON streaming mode); signal propagates cancellation (killing the remote process tree).
   */
  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    if (typeof req.command !== 'string' && !Array.isArray(req.command)) {
      throw new HelmError('validation_error', 'command must be a string or string array', 400)
    }
    const { nodeId, cwd } = this.resolveExecTarget(req)
    const result = await runShell(this.toolDeps, req.command as string, {
      ...(cwd !== undefined ? { cwd } : {}),
      nodeId,
      conversationId: req.conversationId,
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      signal,
      // Streaming mode: forward chunk callbacks (caller handles throttling); Hub-side aggregate cap matches
      // runShell's STREAM_AGGREGATE_LIMIT_BYTES (avoiding redundant 64 MiB buffering leaks—streaming clients
      // already receive all chunks, and terminal output only aggregates for diagnostics, throwing output_limit_exceeded
      // if exceeded without changing the frame protocol).
      ...(onChunk !== undefined ? { onOutputChunk: onChunk } : {}),
    })
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
      timedOut: result.timedOut,
    }
  }

  /**
   * Target resolution: explicit nodeId/cwd > conversation binding (nodeId, cwd) > 'local'/Hub cwd.
   * Default arguments never accidentally execute on Hub: when conversationId is provided, inherit its remote binding.
   * cwd absoluteness follows target rules (POSIX / and Windows drive/UNC are valid), rejecting drive-relative paths
   * (C:relative) without wrongly using Hub's path.isAbsolute to reject Windows paths.
   * cwd is then normalized for the target node's platform (POSIX paths on a win32 target convert to Windows paths;
   * unknown platforms are left untouched without guessing; unmappable bare POSIX roots return validation_error with original cwd).
   */
  resolveExecTarget(req: { nodeId?: string; cwd?: string; conversationId?: number }): { nodeId: string; cwd: string | undefined } {
    let nodeId = req.nodeId
    let cwd = req.cwd
    if (req.conversationId !== undefined) {
      const meta = this.convOf(req.conversationId)
      if (nodeId === undefined) nodeId = meta.nodeId ?? 'local'
      if (cwd === undefined) cwd = meta.cwd
    }
    nodeId = nodeId ?? 'local'
    if (cwd === undefined) cwd = nodeId === 'local' ? this.toolDeps.defaultCwd : undefined
    if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsoluteTargetPath(cwd))) {
      throw new HelmError(
        'validation_error',
        `cwd must be an absolute path (starting with POSIX / or Windows drive/UNC; drive-relative and relative paths are rejected; got ${String(cwd)})`,
        400,
        { cwd },
      )
    }
    // Target-platform-aware cwd normalization (same primitive as runShell, avoiding duplicate rules):
    // local uses Hub host platform; remote uses registered platform (offline/unreported yields unknown platform and passes
    // through without guessing so the subsequent online check surfaces the real cause); on win32 targets, WSL / Git Bash
    // POSIX paths normalize to Windows paths, while unmappable bare POSIX roots fail with validation_error (preserving original cwd).
    const platformInfo = targetPlatformForNode(this.envFabric, nodeId)
    if (cwd !== undefined) {
      const cwdNorm = normalizePathForTarget(cwd, platformInfo)
      if (!cwdNorm.ok) {
        throw new HelmError(
          'validation_error',
          `cwd cannot be normalized for target node platform: ${cwdNorm.reason}`,
          400,
          { cwd, pathCode: cwdNorm.code },
        )
      }
      cwd = cwdNorm.path
    }
    // Remote target with unset cwd: forbid blind execution (node daemon dataDir is not the user's intended workspace;
    // security invariant: default parameters must never silently run on Hub or an arbitrary directory).
    if (nodeId !== 'local' && cwd === undefined) {
      throw new HelmError(
        'validation_error',
        `executing on remote node ${nodeId} requires an explicit cwd or bound conversation (blind execution in node default directory is rejected)`,
        400,
        { nodeId },
      )
    }
    if (nodeId !== 'local' && !this.envFabric.isOnline(nodeId)) {
      throw new HelmError('node_offline', `node ${nodeId} is offline or unreachable; execution rejected (never falls back to local)`, 409, {
        nodeId,
      })
    }
    return { nodeId, cwd }
  }

  /** Dispose: clear disk stats timer and await any in-flight refresh. */
  async dispose(): Promise<void> {
    if (this.localDiskRefreshTimer !== undefined) {
      clearInterval(this.localDiskRefreshTimer)
      this.localDiskRefreshTimer = undefined
    }
    await this.localDiskRefreshing
  }
}

/** RpcResult boundary shape predicate (used by upgrade structured reply flow; detailed checks live in unwrap / validate helpers). */
function isRpcResultEnvelope(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}
