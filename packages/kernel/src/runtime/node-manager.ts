/**
 * node manage: token sign / CLI bin install / disk and health count / NodeInfo piece together install /
 * node upgrade state machine / across node command execute.
 *
 * from runtime.ts split out (on emperor class one responsibility cluster). mechanism layer: excludes any business role concept;
 * upgrade wait for via EnvFabric registry  beginUpgrade waiter and node RPC race.
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

/** local disk count background refresh interval (unref timer, do not block exit). */
const LOCAL_DISK_REFRESH_MS = 30_000

export interface NodeManagerOptions {
  readonly dataDir: string
  readonly envFabric: EnvFabric
  readonly configSvc: ConfigService
  readonly stash: SecretStash
  readonly toolDeps: HelmToolDeps
  readonly events: { publish(type: 'notification', payload: unknown): void; publish(type: 'node.changed', payload: unknown): void }
  /** node upgrade wait for commit confirm timeout (milli second; default 120000). */
  readonly nodeUpgradeTimeoutMs: number
}

/**
 * node RpcResult original shape (conn.rpc.nodeCheckUpgrade return type shape reference).
 * validate unify via semver.ts  unwrap* function (illegal shape 502, never pass-through dirty data).
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
  /** config.json in register node sign record (nodeId -> sha256(token)). */
  private readonly nodeTokenIndex = new Map<string, string>()
  /** helm CLI wrap script directory (ensureCliBinDir generate after non-empty). */
  private cliBinDirValue: string | undefined = undefined
  /** local node disk count cache (fs.statfs async collect; sync snapshot directly re- use). */
  private localDiskStats: { diskFreeBytes: number; diskTotalBytes: number } | undefined
  /** local disk count background refresh timer (unref;close when clean up). */
  private localDiskRefreshTimer: NodeJS.Timeout | undefined
  /** local disk count in-flight refresh (singleflight, guard against heavy stack add). */
  private localDiskRefreshing: Promise<void> = Promise.resolve()
  /** automatically upgrade dedupe: same node once process lifecycle only automatically attempt one round. */
  readonly #autoUpgradeAttempted = new Set<string>()

  /** conversation metadata parse (host inject store.getConv + 404 semantics). */
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

  /** HELM_AUTO_UPGRADE_NODES=1 explicit open start only then automatically upgrade (default closure). */
  private get autoUpgradeEnabled(): boolean {
    return process.env['HELM_AUTO_UPGRADE_NODES'] === '1'
  }

  get cliBinDir(): string | undefined {
    return this.cliBinDirValue
  }

  // ------------------------------------------------------------------
  // sign table (config.json.nodes)
  // ------------------------------------------------------------------

  /** load config.json  nodes sign table (nodeId -> sha256(token)); corrupt explicit on throw. */
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
        throw new HelmError('config_corrupt', `config.json.nodes['${nodeId}'] must be a non-empty string summary`, 500)
      }
      this.nodeTokenIndex.set(nodeId, digest)
    }
  }

  /** when before sign table write back config.json.nodes. */
  private async persistNodeTokens(): Promise<void> {
    const nodes: Record<string, string> = {}
    for (const [nodeId, digest] of this.nodeTokenIndex) nodes[nodeId] = digest
    await this.configSvc.update({ nodes })
  }

  hasNode(nodeId: string): boolean {
    return this.nodeTokenIndex.has(nodeId)
  }

  /** sign summary now read (EnvFabric fail-closed authentication consume;nodeId -> sha256(token)). */
  nodeDigestOf(nodeId: string): string | undefined {
    return this.nodeTokenIndex.get(nodeId)
  }

  /** sign node access token: plaintext token only this time return, server side only store sha256. */
  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_issue_local', "local is inside create node, no need to access token", 400, { nodeId })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      throw new HelmError(
        'validation_error',
        'nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/' +
          '(character parent number open head, can contains . _ -, most long 128 character)',
        400,
        { nodeId },
      )
    }
    const secret = randomBytes(24).toString('base64url')
    const token = `${nodeId}:${secret}`
    this.nodeTokenIndex.set(nodeId, sha256hex(token))
    await this.persistNodeTokens()
    // plaintext token out station redaction (never written to the database/enter model context/appear in log).
    this.stash.addRedaction(token)
    this.stash.addRedaction(secret)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: this.envFabric.isOnline(nodeId) },
    })
    return { nodeId, token, createdAt: Date.now() }
  }

  /** remove node: from sign table delete and immediately pinch assert in-flight WS connect. */
  async removeNode(nodeId: string): Promise<void> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_remove_local_node', 'local is inside create node, cannot remove', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `node missing:${nodeId}`, 404, { nodeId })
    }
    this.nodeTokenIndex.delete(nodeId)
    await this.persistNodeTokens()
    // first pinch assert in-flight connect (may trigger onNodeChanged offline call back; that when nodeTokenIndex
    // deleted, call back side will skip), again unify publish carries removed: true remove event.
    this.envFabric.registry.disconnect(nodeId)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: false },
      removed: true,
    })
  }

  // ------------------------------------------------------------------
  // CLI bin wrap script
  // ------------------------------------------------------------------

  /**
   * in dataDir under generate <dataDir>/bin wrap script directory (make managed child process in PATH in
   * directly run helm command,--current semantics open box i.e. through):
   * - POSIX host:helm = `#!/bin/sh` exec direct tune (cli-shim.buildPosixHostShim);
   * - win32 host:helm.cmd = cmd.exe wrapper(history behavior do not change);helm = for
   *   WSL / Git Bash  POSIX shim- - runtime via wslpath/cygpath only parse
   *   node.exe can execute file, entry keep Windows path; failed to parse explicit diagnose and
   *   127 exit, never fall back Linux node(cli-shim.buildWindowsPosixShim).
   * idempotent: content change when heavy write, permission constant 0o755.platform/execPath default take when before
   * process (test inject simulated win32 host; generate logic all in cli-shim.ts pure function).
   */
  async ensureCliBinDir(
    override: { platform?: NodeJS.Platform; execPath?: string } = {},
  ): Promise<void> {
    const platform = override.platform ?? process.platform
    const execPath = override.execPath ?? process.execPath
    const binDir = join(this.dataDir, 'bin')
    const helmPath = join(binDir, 'helm')
    // Electron host inject:Hub with ELECTRON_RUN_AS_NODE runtime process.execPath is
    // Electron two enter system, generate CLI wrapper must same carry ELECTRON_RUN_AS_NODE=1,
    // otherwise wrapper exec out is GUI process while non- Node CLI. only inject this a must want field,
    // does not Electron environment leak leak to all shell.
    const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
    let plan: CliShimPlan
    // explicit CLI entry (install package payload layout without packages/cli directory, on trace push lead will empty;
    // by desktop main proxy points to <release>/cli/dist/index.js). only accept single entry file path.
    const explicitEntry = process.env.HELM_CLI_ENTRY
    if (explicitEntry) {
      plan = { execPath, entryArgs: [explicitEntry], ...(env ? { env } : {}) }
    } else {
      // tsx CLI and repository CLI entry: with when before module location push lead (source code run and dist run same construct).
      const kernelDir = dirname(fileURLToPath(import.meta.url))
      const repoRoot = this.resolveRepoRoot(kernelDir)
      const compiledCli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
      const sourceCli = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
      const compiled = await access(compiledCli).then(() => true, () => false)
      // source code kernel must match set source code CLI, avoid old dist command table and new protocol contract mix use.
      const useCompiled = basename(dirname(kernelDir)) !== 'src' && compiled
      plan = {
        execPath,
        entryArgs: useCompiled
          ? [compiledCli]
          : [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), sourceCli],
        ...(env ? { env } : {}),
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
      // wrap script generate failed do not block assert kernel start (managed child process still available absolute path),
      // but explicit notify (not silently swallow).
      this.events.publish('notification', {
        level: 'warning',
        title: 'helm CLI wrap script generate failed',
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  /** from kernel module location push lead repository (src/runtime -> on trace two level;dist same construct). */
  private resolveRepoRoot(kernelDir: string): string {
    // src/runtime or dist/runtime → packages/kernel/<x> → repository.
    return dirname(dirname(dirname(dirname(kernelDir))))
  }

  // ------------------------------------------------------------------
  // local disk / health count
  // ------------------------------------------------------------------

  /** single time fs.statfs(dataDir) collect local disk empty between (on failure keep on time cache, do not block assert list). */
  private async refreshLocalDiskStats(): Promise<void> {
    try {
      const st = await statfs(this.dataDir)
      this.localDiskStats = {
        diskFreeBytes: Number(st.bavail) * Number(st.bsize),
        diskTotalBytes: Number(st.blocks) * Number(st.bsize),
      }
    } catch {
      // disk count failed does not affect node list body (health disk field default),
      // keep most near once valid cache.
    }
  }

  /** async refresh local disk cache (singleflight); first time invoke also after startup stage set when refresh. */
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

  /** local node real-time health snapshot (memory/load real-time collect; disk use most near once cache). */
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
   * register node (byom) NodeInfo piece together install:onNodeChanged event and listNodesSync
   * shared use the same implement (field expand rule same source, eliminate two where duplicate).
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

  /** local node NodeInfo(version constant take Hub itself; health is real-time snapshot). */
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

  /** node list: first items constant is local; then is config.json register node and real-time online state. */
  async listNodes(): Promise<NodeInfo[]> {
    await this.ensureLocalDiskStats()
    return this.listNodesSync()
  }

  /** sync edition (SSE snapshot provider use; and listNodes the same data source). */
  listNodesSync(): NodeInfo[] {
    const out: NodeInfo[] = [this.localNodeInfo()]
    for (const nodeId of this.nodeTokenIndex.keys()) {
      out.push(this.byomNodeInfo(nodeId, this.envFabric.registry.get(nodeId)))
    }
    return out
  }

  // ------------------------------------------------------------------
  // node upgrade (check / upgrade state machine)
  // ------------------------------------------------------------------

  /** upgrade pre-:local reject, unknown 404, offline 409; return when before online connect. */
  private requireUpgradableConnection(nodeId: string): { version?: string; rpc: NodeEnvRpcFunctions } {
    if (nodeId === 'local') {
      throw new HelmError('cannot_upgrade_local', 'local and Hub same process, upgrade Hub i.e. upgrade local', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `node missing:${nodeId}`, 404, { nodeId })
    }
    const conn = this.envFabric.registry.get(nodeId)
    if (conn === undefined) {
      throw new HelmError('node_offline', `node offline:${nodeId}`, 409, { nodeId })
    }
    return conn
  }

  /**
   * check node available update (GET /api/nodes/:id/upgrade/check): pass-through node RPC
   * nodeCheckUpgrade and validate RpcResult and result boundary.
   * - local:400(unsupported); unknown node:404; offline:409;
   * - node unsupported upgrade:501;RpcResult structure failed/result illegal:400/502.
   */
  async checkNodeUpgrade(nodeId: string, input: NodeUpgradeCheckInput = {}): Promise<NodeUpgradeCheckResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeCheckUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `node ${nodeId} unsupported upgrade (old edition @helm/node)`, 501, { nodeId })
    }
    let result: UpgradeRpcCheck
    try {
      result = await conn.rpc.nodeCheckUpgrade(input)
    } catch (error) {
      throw new HelmError(
        'node_upgrade_unavailable',
        `node ${nodeId} upgrade check transfer failed:${error instanceof Error ? error.message : String(error)}`,
        502,
        { nodeId },
      )
    }
    return unwrapUpgradeCheckRpc(nodeId, result)
  }

  /**
   * trigger node upgrade (POST /api/nodes/:id/upgrade):
   * 1. parse precise targetVersion(explicit version specification; empty target first check take latest);
   *    previousVersion take self node on report when before version; missing when first check take its real
   *    currentVersion(never fabricate 'unknown'- - that forever does not match commit);
   * 2. generate random attemptId, first install register table upgrade wait for, again tune conn.rpc.nodeUpgrade;
   *    and wait for result/timeout truly race(RPC forever long do not return when whole still has boundary, never hang
   *    30min birpc pre- compute), late to RPC result produces no unhandled rejection;
   * 3. node explicit return without operation and legal (ok/upgraded:false)→ cancel wait for and such as return;
   * 4. node structure failed / result illegal → cancel wait for and errors; original socket transfer disconnect →
   *    continue etc. commit, never false succeeded; timeout not confirm → 502 explicit result not confirm;
   * 5. any non- commit terminate path unify finally clean up wait for (never let after continue upgrade forever long busy).
   */
  async upgradeNode(
    nodeId: string,
    input: { targetVersion?: string; registryUrl?: string; force?: boolean } = {},
  ): Promise<NodeUpgradeResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `node ${nodeId} unsupported upgrade (old edition @helm/node)`, 501, { nodeId })
    }
    const { targetVersion, previousVersion } = await this.resolveUpgradeVersions(nodeId, conn.version, input)
    const attemptId = randomBytes(16).toString('hex')
    const waiter = this.envFabric.registry.beginUpgrade(nodeId, {
      attemptId,
      targetVersion,
      previousVersion,
      timeoutMs: this.NODE_UPGRADE_TIMEOUT_MS,
    })
    // all non- commit terminate path unify clean up wait for (otherwise after continue upgrade forever long busy).
    const finallyCancel = (): void => {
      waiter.cancel(new HelmError('node_upgrade_cancelled', `node ${nodeId} upgrade wait for already final`, 502))
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

  /** target and base allow version parse: explicit specification; missing via check RPC take real value (never fabricate). */
  private async resolveUpgradeVersions(
    nodeId: string,
    nodeVersion: string | undefined,
    input: { targetVersion?: string; registryUrl?: string },
  ): Promise<{ targetVersion: string; previousVersion: string }> {
    // explicit target version:trim + remove single v prefix + strictly SemVer; specification after used to
    // attempt create,RPC invoke and commit for account (three way same source).
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
   * single time upgrade attempt compute (upgradeNode split out phase function; embed set cap 4 layer).
   *
   * race semantics constraint:RPC and wait for (commit / timeout) only race once; after continue terminal state one rule
   * only await commitPromise(wait for self carries timer, has boundary); never duplicate race already
   * settle  rpcPromise(it instant between replay the same failed value, will disconnect etc. commitmistakenly judge into
   * terminal state failed).birpc $close will first placement $closed again reject in-flight invoke;ws-gateway
   *  onGeneralError return true will the reject swallow into resolve(undefined).
   * therefore only when reply is undefined and this time invoke which use rpc instance already indeed close when only then archive is
   * transfer interrupt (choose top replace old socket must via chain), rotate is rpcError continue etc. commit;
   * the rest illegal reply still by invalid shape 502, never let any illegal value unbounded wait for.
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
              'nodeUpgrade in-flight invoke because old socket by top replace while close (birpc $close  reject by onGeneralError swallow into resolve(undefined))',
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
    // RPC complete but by commit first to mask when, late to branch will not again by read - - already in on way
    // then inside catch is ordinary value, without unhandled rejection risk.
    const first = await Promise.race([commitPromise, rpcPromise])
    if (first.kind === 'commit') {
      return first.value
    }
    if (first.kind === 'waiterError') {
      // wait for already final (timeout/cancel) while RPC not first back: upgrade result not confirm.
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, first.error, 'result not confirm')
    }
    if (first.kind === 'rpcError') {
      // transfer layer disconnect (old socket by choose top replace when must however occur): is not terminal state - - continue
      // etc. commit(choose register after with attemptId for account).
      const failure = first.error instanceof Error ? first.error.message : String(first.error)
      const settled = await commitPromise
      if (settled.kind === 'commit') return settled.value
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, `upgrade trigger failed and not confirm (transfer interrupt):${failure}`)
    }
    // first.kind === 'rpc': node structure reply (validate after by without operation / already start stream).
    return this.settleStructuredRpcReply(nodeId, { targetVersion, attemptId, input }, commitPromise, first.value)
  }

  /** result not confirm error unify construct (502; attach attemptId and target version diagnose). */
  private unconfirmedError(nodeId: string, targetVersion: string, attemptId: string, cause: unknown, lead: string): HelmError {
    const message = cause instanceof Error ? cause.message : String(cause)
    return new HelmError(
      'node_upgrade_unconfirmed',
      `node ${nodeId} upgrade to ${targetVersion} ${lead}:${message}`,
      502,
      { nodeId, attemptId, targetVersion },
    )
  }

  /** node structure reply compute: illegal shape 502 / structure reject original errors / without operation core for / already start etc. commit. */
  private async settleStructuredRpcReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    commitPromise: Promise<{ kind: 'commit'; value: NodeUpgradeResult } | { kind: 'waiterError'; error: unknown }>,
    rpcResult: unknown,
  ): Promise<NodeUpgradeResult> {
    const { targetVersion, attemptId, input } = plan
    // first validate RpcResult shape (object / boolean ok / legal value or legal error.code+message), illegal by 502 reject.
    if (!isRpcResultEnvelope(rpcResult)) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} upgrade return illegal RpcResult(non- object or ok/error shape error):${safeJson(rpcResult)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (rpcResult.ok !== true) {
      // node structure reject (not_supported / invalid / ...): explicit errors.
      throw rpcFailureToHelmError(nodeId, 'upgrade', rpcResult.error as { code: string; message: string })
    }
    const value = validateUpgradeResult(nodeId, rpcResult.value as NodeUpgradeResult)
    if (!value.ok) {
      throw new HelmError('node_upgrade_failed', `node ${nodeId} return upgrade not complete`, 502, { nodeId, attemptId, targetVersion })
    }
    if (value.upgraded === false) {
      return this.settleNoOpReply(nodeId, plan, value)
    }
    // node report already start upgrade stream process: unique can message terminal state is wait for match commit.
    // same only await commitPromise(timer has boundary, never heavy race already settle  rpc).
    const settled = await commitPromise
    if (settled.kind === 'commit') return settled.value
    throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, 'result not confirm')
  }

  /** without operation reply core for (force semantics under missing legal without operation; version must and fixed target consistent). */
  private settleNoOpReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    value: NodeUpgradeResult,
  ): NodeUpgradeResult {
    const { targetVersion, attemptId, input } = plan
    // node explicit without operation (already is target version etc.): must ok:true and previous/target
    // all equals this time fixed target (otherwise node lie report, never let through);force semantics under missing
    // legal without operation (force heavy install must has result), one rule by illegal result 502 reject.
    if (input.force === true) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} force upgrade return without operation result (force do not accept without operation):${safeJson(value)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (value.previousVersion !== targetVersion || value.targetVersion !== targetVersion) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `node ${nodeId} upgrade without operation result and fixed target inconsistent (expectation previous/target all is ${targetVersion}, got previous=${value.previousVersion},target=${value.targetVersion})`,
        502,
        { nodeId, attemptId, targetVersion, result: value },
      )
    }
    return value
  }

  /**
   * node enable automatically upgrade (HELM_AUTO_UPGRADE_NODES=1): strictly SemVer after Hub
   * only then trigger; dedupe (same node once); failed only warning notify, never block register.
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
        title: `node ${nodeId} automatically failed to upgrade`,
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  // ------------------------------------------------------------------
  // across node command execute (execEnv)
  // ------------------------------------------------------------------

  /**
   * across node command execute (POST /api/env/exec): in target (nodeId, cwd) execute command.
   * remote node offline when 409 node_offline(never fall back local);onChunk one by one chunk back put
   * stdout/stderr(NDJSON streaming pattern use);signal pass broadcast cancel (kill remote process tree).
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
      // streaming pattern: one by one chunk call back pass-through (client self row rate limiting);Hub side aggregate pre- compute by
      // runShell  STREAM_AGGREGATE_LIMIT_BYTES unify converge (old 64MiB all text
      // duplicate is memory leak leak) - - streaming client already receives all one by one chunk output, terminal state output
      // only act diagnose aggregate, over limit explicit output_limit_exceeded(does not change frame protocol).
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
   * target parse: explicit nodeId/cwd > conversation bind set (nodeId, cwd) > 'local'/Hub cwd.
   * default parameter never mistakenly run Hub: carries conversationId when inherit the conversation remote bind set.
   * cwd absolute by target shape decide (POSIX / and Windows symbol/UNC all legal),
   * symbol each other for (C:relative) reject; never use Hub host isAbsolute refuse Windows path.
   * cwd then by target node platform specification (win32 target on POSIX view rotate Windows path;
   * platform unknown do not guess; cannot mapping bare POSIX  validation_error and keep original cwd).
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
        `cwd must be absolute path (POSIX / open head or Windows symbol/UNC; reject symbol each other for and relative path. receives ${String(cwd)})`,
        400,
        { cwd },
      )
    }
    // target platform aware cwd specification (and runShell the same original language, do not in this another write rule):
    // local use Hub host platform, remote only use register register platform (offline/not on report → platform
    // unknown, original pass-through do not guess, by under way online check to out real reason);win32 target on
    // WSL / Git Bash POSIX view rotate specification Windows path, cannot mapping bare POSIX 
    // explicit validation_error(keep original cwd).
    const platformInfo = targetPlatformForNode(this.envFabric, nodeId)
    if (cwd !== undefined) {
      const cwdNorm = normalizePathForTarget(cwd, platformInfo)
      if (!cwdNorm.ok) {
        throw new HelmError(
          'validation_error',
          `cwd cannot specification to target node platform:${cwdNorm.reason}`,
          400,
          { cwd, pathCode: cwdNorm.code },
        )
      }
      cwd = cwdNorm.path
    }
    // remote and not to set cwd: reject blind run (node daemon dataDir is not user intent target;
    // security target: default parameter never remote conversation command mistakenly run Hub or random directory).
    if (nodeId !== 'local' && cwd === undefined) {
      throw new HelmError(
        'validation_error',
        `remote node ${nodeId} execute must explicit cwd or bind set conversation (reject blind run node by default directory)`,
        400,
        { nodeId },
      )
    }
    if (nodeId !== 'local' && !this.envFabric.isOnline(nodeId)) {
      throw new HelmError('node_offline', `node ${nodeId} offline or not access, reject execute (never fall back local machine)`, 409, {
        nodeId,
      })
    }
    return { nodeId, cwd }
  }

  /** closure stop: clean up disk count timer and wait for in-flight refresh complete. */
  async dispose(): Promise<void> {
    if (this.localDiskRefreshTimer !== undefined) {
      clearInterval(this.localDiskRefreshTimer)
      this.localDiskRefreshTimer = undefined
    }
    await this.localDiskRefreshing
  }
}

/** RpcResult boundary shape decide (upgrade structure reply stream use; detailed validate in unwrap / validate system column). */
function isRpcResultEnvelope(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}
