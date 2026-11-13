/**
 * 节点管理器：令牌签发 / CLI bin 安装 / 磁盘与健康统计 / NodeInfo 拼装 /
 * 节点升级状态机 / 跨节点命令执行。
 *
 * 从 runtime.ts 拆出（上帝类第一职责簇）。机制层：不含任何业务角色概念；
 * 升级等待经 EnvFabric registry 的 beginUpgrade waiter 与节点 RPC race。
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

/** local 磁盘统计后台刷新间隔（unref 定时器，不阻退出）。 */
const LOCAL_DISK_REFRESH_MS = 30_000

export interface NodeManagerOptions {
  readonly dataDir: string
  readonly envFabric: EnvFabric
  readonly configSvc: ConfigService
  readonly stash: SecretStash
  readonly toolDeps: HelmToolDeps
  readonly events: { publish(type: 'notification', payload: unknown): void; publish(type: 'node.changed', payload: unknown): void }
  /** 节点升级等待 commit 确认超时（毫秒；缺省 120000）。 */
  readonly nodeUpgradeTimeoutMs: number
}

/**
 * 节点 RpcResult 原始形状（conn.rpc.nodeCheckUpgrade 的返回类型形参化）。
 * 校验统一经 semver.ts 的 unwrap* 函数（非法形状 502，绝不透传脏数据）。
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
  /** config.json 中登记的节点签发记录（nodeId -> sha256(token)）。 */
  private readonly nodeTokenIndex = new Map<string, string>()
  /** helm CLI 包装脚本目录（ensureCliBinDir 生成后非空）。 */
  private cliBinDirValue: string | undefined = undefined
  /** local 节点磁盘统计缓存（fs.statfs 异步采集；同步快照直接复用）。 */
  private localDiskStats: { diskFreeBytes: number; diskTotalBytes: number } | undefined
  /** local 磁盘统计后台刷新定时器（unref；close 时清理）。 */
  private localDiskRefreshTimer: NodeJS.Timeout | undefined
  /** local 磁盘统计在途刷新（singleflight，防重入叠加）。 */
  private localDiskRefreshing: Promise<void> = Promise.resolve()
  /** 自动升级去重：同节点一次进程生命周期只自动尝试一轮。 */
  readonly #autoUpgradeAttempted = new Set<string>()

  /** 会话元数据解析（宿主注入 store.getConv + 404 语义）。 */
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

  /** HELM_AUTO_UPGRADE_NODES=1 显式开启才自动升级（缺省关）。 */
  private get autoUpgradeEnabled(): boolean {
    return process.env['HELM_AUTO_UPGRADE_NODES'] === '1'
  }

  get cliBinDir(): string | undefined {
    return this.cliBinDirValue
  }

  // ------------------------------------------------------------------
  // 签发表（config.json.nodes）
  // ------------------------------------------------------------------

  /** 加载 config.json 的 nodes 签发表（nodeId -> sha256(token)）；损坏显式上抛。 */
  async loadNodeTokens(): Promise<void> {
    const config = await this.configSvc.get()
    const nodes = config['nodes']
    this.nodeTokenIndex.clear()
    if (nodes === undefined) return
    if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
      throw new HelmError('config_corrupt', 'config.json.nodes 需为对象（nodeId -> sha256(token)）', 500)
    }
    for (const [nodeId, digest] of Object.entries(nodes as Record<string, unknown>)) {
      if (typeof digest !== 'string' || digest === '') {
        throw new HelmError('config_corrupt', `config.json.nodes['${nodeId}'] 需为非空字符串摘要`, 500)
      }
      this.nodeTokenIndex.set(nodeId, digest)
    }
  }

  /** 把当前签发表写回 config.json.nodes。 */
  private async persistNodeTokens(): Promise<void> {
    const nodes: Record<string, string> = {}
    for (const [nodeId, digest] of this.nodeTokenIndex) nodes[nodeId] = digest
    await this.configSvc.update({ nodes })
  }

  hasNode(nodeId: string): boolean {
    return this.nodeTokenIndex.has(nodeId)
  }

  /** 签发摘要现读（EnvFabric fail-closed 鉴权器消费；nodeId -> sha256(token)）。 */
  nodeDigestOf(nodeId: string): string | undefined {
    return this.nodeTokenIndex.get(nodeId)
  }

  /** 签发节点接入令牌：明文 token 仅本次返回，服务端只存 sha256。 */
  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_issue_local', "local 是内建节点，无需接入令牌", 400, { nodeId })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      throw new HelmError(
        'validation_error',
        'nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/' +
          '（字母数字开头，可含 . _ -，最长 128 字符）',
        400,
        { nodeId },
      )
    }
    const secret = randomBytes(24).toString('base64url')
    const token = `${nodeId}:${secret}`
    this.nodeTokenIndex.set(nodeId, sha256hex(token))
    await this.persistNodeTokens()
    // 明文 token 入出站脱敏（绝不落库/进模型上下文/出现在日志）。
    this.stash.addRedaction(token)
    this.stash.addRedaction(secret)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: this.envFabric.isOnline(nodeId) },
    })
    return { nodeId, token, createdAt: Date.now() }
  }

  /** 移除节点：从签发表删除并立即掐断在途 WS 连接。 */
  async removeNode(nodeId: string): Promise<void> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_remove_local_node', 'local 是内建节点，不可移除', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `节点不存在：${nodeId}`, 404, { nodeId })
    }
    this.nodeTokenIndex.delete(nodeId)
    await this.persistNodeTokens()
    // 先掐断在途连接（可能触发 onNodeChanged 离线回调；彼时 nodeTokenIndex
    // 已删除，回调侧会跳过），再统一发布带 removed: true 的移除事件。
    this.envFabric.registry.disconnect(nodeId)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: false },
      removed: true,
    })
  }

  // ------------------------------------------------------------------
  // CLI bin 包装脚本
  // ------------------------------------------------------------------

  /**
   * 在 dataDir 下生成 <dataDir>/bin 包装脚本目录（使受管子进程在 PATH 中
   * 直接运行 helm 命令，--current 语义开箱即通）：
   * - POSIX host：helm = `#!/bin/sh` exec 直调（cli-shim.buildPosixHostShim）；
   * - win32 host：helm.cmd = cmd.exe wrapper（历史行为不变）；helm = 面向
   *   WSL / Git Bash 的 POSIX shim——运行时经 wslpath/cygpath 仅解析
   *   node.exe 可执行文件，入口保持 Windows 路径；解析失败显式诊断并
   *   127 退出，绝不回退 Linux node（cli-shim.buildWindowsPosixShim）。
   * 幂等：内容变化时重写，权限恒 0o755。platform/execPath 缺省取当前
   * 进程（测试注入模拟 win32 host；生成逻辑全部在 cli-shim.ts 纯函数）。
   */
  async ensureCliBinDir(
    override: { platform?: NodeJS.Platform; execPath?: string } = {},
  ): Promise<void> {
    const platform = override.platform ?? process.platform
    const execPath = override.execPath ?? process.execPath
    const binDir = join(this.dataDir, 'bin')
    const helmPath = join(binDir, 'helm')
    // Electron 宿主注入：Hub 以 ELECTRON_RUN_AS_NODE 运行时 process.execPath 是
    // Electron 二进制，生成的 CLI wrapper 必须同样携带 ELECTRON_RUN_AS_NODE=1，
    // 否则 wrapper exec 出的是 GUI 进程而非 Node CLI。仅注入这一个必要字段，
    // 不把 Electron 环境泄漏给全部 shell。
    const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
    let plan: CliShimPlan
    // 显式 CLI 入口（安装包 payload 布局无 packages/cli 目录，上溯推导会落空；
    // 由桌面主代理指向 <release>/cli/dist/index.js）。只接受单入口文件路径。
    const explicitEntry = process.env.HELM_CLI_ENTRY
    if (explicitEntry) {
      plan = { execPath, entryArgs: [explicitEntry], ...(env ? { env } : {}) }
    } else {
      // tsx CLI 与仓库 CLI 入口：以当前模块位置推导（源码运行与 dist 运行同构）。
      const kernelDir = dirname(fileURLToPath(import.meta.url))
      const repoRoot = this.resolveRepoRoot(kernelDir)
      const compiledCli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
      const sourceCli = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
      const compiled = await access(compiledCli).then(() => true, () => false)
      // 源码内核必须配套源码 CLI，避免旧 dist 命令表与新 protocol 契约混用。
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
      // 包装脚本生成失败不阻断内核启动（受管子进程仍可用绝对路径），
      // 但显式通知（不静默吞）。
      this.events.publish('notification', {
        level: 'warning',
        title: 'helm CLI 包装脚本生成失败',
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  /** 从 kernel 模块位置推导仓库根（src/runtime -> 上溯两级；dist 同构）。 */
  private resolveRepoRoot(kernelDir: string): string {
    // src/runtime 或 dist/runtime → packages/kernel/<x> → 仓库根。
    return dirname(dirname(dirname(dirname(kernelDir))))
  }

  // ------------------------------------------------------------------
  // local 磁盘 / 健康统计
  // ------------------------------------------------------------------

  /** 单次 fs.statfs(dataDir) 采集 local 磁盘空间（失败时保留上次缓存，不阻断列表）。 */
  private async refreshLocalDiskStats(): Promise<void> {
    try {
      const st = await statfs(this.dataDir)
      this.localDiskStats = {
        diskFreeBytes: Number(st.bavail) * Number(st.bsize),
        diskTotalBytes: Number(st.blocks) * Number(st.bsize),
      }
    } catch {
      // 磁盘统计失败不影响节点列表主体（health 磁盘字段缺省），
      // 保留最近一次有效缓存。
    }
  }

  /** 异步刷新 local 磁盘缓存（singleflight）；首次调用同时启动后台定时刷新。 */
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

  /** local 节点实时健康快照（内存/负载实时采集；磁盘用最近一次缓存）。 */
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
   * 登记节点（byom）的 NodeInfo 拼装：onNodeChanged 事件与 listNodesSync
   * 共用同一实现（字段展开规则同源，消除两处重复）。
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

  /** local 节点 NodeInfo（版本恒取 Hub 自身；健康为实时快照）。 */
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

  /** 节点列表：首项恒为 local；随后为 config.json 登记节点与实时在线状态。 */
  async listNodes(): Promise<NodeInfo[]> {
    await this.ensureLocalDiskStats()
    return this.listNodesSync()
  }

  /** 同步版（SSE snapshot provider 用；与 listNodes 同一数据源）。 */
  listNodesSync(): NodeInfo[] {
    const out: NodeInfo[] = [this.localNodeInfo()]
    for (const nodeId of this.nodeTokenIndex.keys()) {
      out.push(this.byomNodeInfo(nodeId, this.envFabric.registry.get(nodeId)))
    }
    return out
  }

  // ------------------------------------------------------------------
  // 节点升级（check / upgrade 状态机）
  // ------------------------------------------------------------------

  /** 升级前置：local 拒绝、未知 404、离线 409；返回当前在线连接。 */
  private requireUpgradableConnection(nodeId: string): { version?: string; rpc: NodeEnvRpcFunctions } {
    if (nodeId === 'local') {
      throw new HelmError('cannot_upgrade_local', 'local 与 Hub 同进程，升级 Hub 即升级 local', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `节点不存在：${nodeId}`, 404, { nodeId })
    }
    const conn = this.envFabric.registry.get(nodeId)
    if (conn === undefined) {
      throw new HelmError('node_offline', `节点离线：${nodeId}`, 409, { nodeId })
    }
    return conn
  }

  /**
   * 检查节点可用更新（GET /api/nodes/:id/upgrade/check）：透传节点 RPC
   * nodeCheckUpgrade 并校验 RpcResult 与结果边界。
   * - local：400（不支持）；未知节点：404；离线：409；
   * - 节点不支持升级：501；RpcResult 结构化失败/结果非法：400/502。
   */
  async checkNodeUpgrade(nodeId: string, input: NodeUpgradeCheckInput = {}): Promise<NodeUpgradeCheckResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeCheckUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `节点 ${nodeId} 不支持升级（旧版 @helm/node）`, 501, { nodeId })
    }
    let result: UpgradeRpcCheck
    try {
      result = await conn.rpc.nodeCheckUpgrade(input)
    } catch (error) {
      throw new HelmError(
        'node_upgrade_unavailable',
        `节点 ${nodeId} 升级检查传输失败：${error instanceof Error ? error.message : String(error)}`,
        502,
        { nodeId },
      )
    }
    return unwrapUpgradeCheckRpc(nodeId, result)
  }

  /**
   * 触发节点升级（POST /api/nodes/:id/upgrade）：
   * 1. 解析精确 targetVersion（显式版本规范化；空目标先 check 取 latest）；
   *    previousVersion 取自节点上报的当前版本；缺失时先 check 取其真实
   *    currentVersion（绝不伪造 'unknown'——那永不匹配 commit）；
   * 2. 生成随机 attemptId，先安装注册表升级等待器，再调 conn.rpc.nodeUpgrade；
   *    与等待器结果/超时真正 race（RPC 永久不返回时整体仍有界，绝不挂
   *    30min birpc 预算），迟到 RPC 结果不产生 unhandled rejection；
   * 3. 节点明确返回「无操作且合法」（ok/upgraded:false）→ 取消等待并如实返回；
   * 4. 节点结构化失败 / 结果非法 → 取消等待并报错；原 socket 传输断开 →
   *    继续等 commit，绝不假成功；超时未确认 → 502 显式「结果未确认」；
   * 5. 任何非 commit 终止路径统一 finally 清理等待器（绝不让后续升级永久 busy）。
   */
  async upgradeNode(
    nodeId: string,
    input: { targetVersion?: string; registryUrl?: string; force?: boolean } = {},
  ): Promise<NodeUpgradeResult> {
    const conn = this.requireUpgradableConnection(nodeId)
    if (conn.rpc.nodeUpgrade === undefined) {
      throw new HelmError('node_upgrade_not_supported', `节点 ${nodeId} 不支持升级（旧版 @helm/node）`, 501, { nodeId })
    }
    const { targetVersion, previousVersion } = await this.resolveUpgradeVersions(nodeId, conn.version, input)
    const attemptId = randomBytes(16).toString('hex')
    const waiter = this.envFabric.registry.beginUpgrade(nodeId, {
      attemptId,
      targetVersion,
      previousVersion,
      timeoutMs: this.NODE_UPGRADE_TIMEOUT_MS,
    })
    // 所有非 commit 终止路径统一清理等待器（否则后续升级永久 busy）。
    const finallyCancel = (): void => {
      waiter.cancel(new HelmError('node_upgrade_cancelled', `节点 ${nodeId} 升级等待已终结`, 502))
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

  /** 目标与基准版本解析：显式规范化；缺失经 check RPC 取真实值（绝不伪造）。 */
  private async resolveUpgradeVersions(
    nodeId: string,
    nodeVersion: string | undefined,
    input: { targetVersion?: string; registryUrl?: string },
  ): Promise<{ targetVersion: string; previousVersion: string }> {
    // 显式目标版本：trim + 去单个 v 前缀 + 严格 SemVer；规范化后用于
    // attempt 创建、RPC 调用与 commit 对账（三方同源）。
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
   * 单次升级 attempt 的结算（upgradeNode 拆出的阶段函数；嵌套上限 4 层）。
   *
   * race 语义约束：RPC 与等待器（commit / 超时）只 race 一次；后续终态一律
   * 只 await commitPromise（等待器自带 timer，有界）；绝不重复 race 已
   * settle 的 rpcPromise（它瞬间重放同一败值，会把「断开等 commit」误判成
   * 终态失败）。birpc $close 会先置 $closed 再 reject 在途调用；ws-gateway
   * 的 onGeneralError 返回 true 会把该 reject 吞成 resolve(undefined)。
   * 因此仅当「应答为 undefined 且本次调用所用 rpc 实例已确实关闭」时才归为
   * 传输中断（候选顶替旧 socket 的必经链），转为 rpcError 继续等 commit；
   * 其余非法应答仍按 invalid shape 502，绝不让任意非法值无限等待。
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
              'nodeUpgrade 在途调用因旧 socket 被顶替而关闭（birpc $close 的 reject 被 onGeneralError 吞成 resolve(undefined)）',
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
    // RPC 完成但被 commit 先到掩盖时，迟到分支不会再被读取——已在上方
    // then 内捕获为普通值，无 unhandled rejection 风险。
    const first = await Promise.race([commitPromise, rpcPromise])
    if (first.kind === 'commit') {
      return first.value
    }
    if (first.kind === 'waiterError') {
      // 等待器已终结（超时/取消）而 RPC 未先回：升级结果未确认。
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, first.error, '结果未确认')
    }
    if (first.kind === 'rpcError') {
      // 传输层断开（旧 socket 被候选顶替时必然发生）：不是终态——继续
      // 等 commit（候选注册后以 attemptId 对账）。
      const failure = first.error instanceof Error ? first.error.message : String(first.error)
      const settled = await commitPromise
      if (settled.kind === 'commit') return settled.value
      throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, `升级触发失败且未确认（传输中断）：${failure}`)
    }
    // first.kind === 'rpc'：节点结构化应答（校验后按无操作 / 已启动分流）。
    return this.settleStructuredRpcReply(nodeId, { targetVersion, attemptId, input }, commitPromise, first.value)
  }

  /** 「结果未确认」错误统一构造（502；附 attemptId 与目标版本诊断）。 */
  private unconfirmedError(nodeId: string, targetVersion: string, attemptId: string, cause: unknown, lead: string): HelmError {
    const message = cause instanceof Error ? cause.message : String(cause)
    return new HelmError(
      'node_upgrade_unconfirmed',
      `节点 ${nodeId} 升级到 ${targetVersion} ${lead}：${message}`,
      502,
      { nodeId, attemptId, targetVersion },
    )
  }

  /** 节点结构化应答结算：非法形状 502 / 结构化拒绝原样报错 / 无操作核对 / 已启动等 commit。 */
  private async settleStructuredRpcReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    commitPromise: Promise<{ kind: 'commit'; value: NodeUpgradeResult } | { kind: 'waiterError'; error: unknown }>,
    rpcResult: unknown,
  ): Promise<NodeUpgradeResult> {
    const { targetVersion, attemptId, input } = plan
    // 先校验 RpcResult 形状（对象 / boolean ok / 合法 value 或合法 error.code+message），非法按 502 拒绝。
    if (!isRpcResultEnvelope(rpcResult)) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `节点 ${nodeId} 升级返回非法 RpcResult（非对象或 ok/error 形状错误）：${safeJson(rpcResult)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (rpcResult.ok !== true) {
      // 节点结构化拒绝（not_supported / invalid / ...）：显式报错。
      throw rpcFailureToHelmError(nodeId, '升级', rpcResult.error as { code: string; message: string })
    }
    const value = validateUpgradeResult(nodeId, rpcResult.value as NodeUpgradeResult)
    if (!value.ok) {
      throw new HelmError('node_upgrade_failed', `节点 ${nodeId} 返回升级未完成`, 502, { nodeId, attemptId, targetVersion })
    }
    if (value.upgraded === false) {
      return this.settleNoOpReply(nodeId, plan, value)
    }
    // 节点报告已启动升级流程：唯一可信终态是等待器的匹配 commit。
    // 同样只 await commitPromise（timer 有界，绝不重 race 已 settle 的 rpc）。
    const settled = await commitPromise
    if (settled.kind === 'commit') return settled.value
    throw this.unconfirmedError(nodeId, targetVersion, attemptId, settled.error, '结果未确认')
  }

  /** 无操作应答核对（force 语义下不存在合法无操作；版本必须与固定目标一致）。 */
  private settleNoOpReply(
    nodeId: string,
    plan: { targetVersion: string; attemptId: string; input: { force?: boolean } },
    value: NodeUpgradeResult,
  ): NodeUpgradeResult {
    const { targetVersion, attemptId, input } = plan
    // 节点明确无操作（已是目标版本等）：必须 ok:true 且 previous/target
    // 均等于本次固定目标（否则节点谎报，绝不放行）；force 语义下不存在
    // 合法无操作（强制重装必有结果），一律按非法结果 502 拒绝。
    if (input.force === true) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `节点 ${nodeId} force 升级返回无操作结果（force 不接受无操作）：${safeJson(value)}`,
        502,
        { nodeId, attemptId, targetVersion },
      )
    }
    if (value.previousVersion !== targetVersion || value.targetVersion !== targetVersion) {
      throw new HelmError(
        'node_upgrade_invalid_result',
        `节点 ${nodeId} 升级无操作结果与固定目标不一致（期望 previous/target 均为 ${targetVersion}，实得 previous=${value.previousVersion}，target=${value.targetVersion}）`,
        502,
        { nodeId, attemptId, targetVersion, result: value },
      )
    }
    return value
  }

  /**
   * 节点上线自动升级（HELM_AUTO_UPGRADE_NODES=1）：严格 SemVer 落后 Hub
   * 才触发；去重（同节点一次）；失败只发 warning 通知，绝不阻塞注册。
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
        title: `节点 ${nodeId} 自动升级失败`,
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  // ------------------------------------------------------------------
  // 跨节点命令执行（execEnv）
  // ------------------------------------------------------------------

  /**
   * 跨节点命令执行（POST /api/env/exec）：在目标 (nodeId, cwd) 执行命令。
   * 远端节点离线时 409 node_offline（绝不回退 local）；onChunk 逐块回放
   * stdout/stderr（NDJSON 流式模式用）；signal 传播取消（杀远端进程树）。
   */
  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    if (typeof req.command !== 'string' && !Array.isArray(req.command)) {
      throw new HelmError('validation_error', 'command 需为字符串或字符串数组', 400)
    }
    const { nodeId, cwd } = this.resolveExecTarget(req)
    const result = await runShell(this.toolDeps, req.command as string, {
      ...(cwd !== undefined ? { cwd } : {}),
      nodeId,
      conversationId: req.conversationId,
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      signal,
      // 流式模式：逐块回调透传（客户端自行限流）；Hub 侧聚合预算由
      // runShell 的 STREAM_AGGREGATE_LIMIT_BYTES 统一收敛（旧 64MiB 全文
      // 复制是内存泄漏）——流式客户端已收到全部逐块输出，终态 output
      // 仅作诊断聚合，超限显式 output_limit_exceeded（不改变帧协议）。
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
   * 靶点解析：显式 nodeId/cwd > 会话绑定 (nodeId, cwd) > 'local'/Hub cwd。
   * 缺省参数绝不误跑 Hub：带 conversationId 时继承该会话的远端绑定。
   * cwd 绝对性按目标形状判定（POSIX / 与 Windows 盘符/UNC 均合法），
   * 盘符相对（C:relative）拒绝；绝不用 Hub 宿主 isAbsolute 拒 Windows 路径。
   * cwd 随后按目标节点平台规范化（win32 目标上 POSIX 视图转 Windows 路径；
   * 平台未知不猜；无法映射的裸 POSIX 根 validation_error 并保留原始 cwd）。
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
        `cwd 需为绝对路径（POSIX / 开头或 Windows 盘符/UNC；拒绝盘符相对与相对路径。收到 ${String(cwd)}）`,
        400,
        { cwd },
      )
    }
    // 目标平台感知的 cwd 规范化（与 runShell 同一原语，不在此另写规则）：
    // local 用 Hub 宿主平台，远端仅用注册登记平台（离线/未上报 → 平台
    // 未知，原样透传不猜，由下方在线检查给出真实原因）；win32 目标上
    // WSL / Git Bash POSIX 视图转规范 Windows 路径，无法映射的裸 POSIX 根
    // 显式 validation_error（保留原始 cwd）。
    const platformInfo = targetPlatformForNode(this.envFabric, nodeId)
    if (cwd !== undefined) {
      const cwdNorm = normalizePathForTarget(cwd, platformInfo)
      if (!cwdNorm.ok) {
        throw new HelmError(
          'validation_error',
          `cwd 无法规范化到目标节点平台：${cwdNorm.reason}`,
          400,
          { cwd, pathCode: cwdNorm.code },
        )
      }
      cwd = cwdNorm.path
    }
    // 远端且未给定 cwd：拒绝盲跑（节点守护进程 dataDir 不是用户的意图靶点；
    // 安全目标：缺省参数绝不把远端会话命令误跑 Hub 或随机目录）。
    if (nodeId !== 'local' && cwd === undefined) {
      throw new HelmError(
        'validation_error',
        `远端节点 ${nodeId} 执行需显式 cwd 或绑定会话（拒绝盲跑节点默认目录）`,
        400,
        { nodeId },
      )
    }
    if (nodeId !== 'local' && !this.envFabric.isOnline(nodeId)) {
      throw new HelmError('node_offline', `节点 ${nodeId} 离线或未接入，拒绝执行（绝不回退本机）`, 409, {
        nodeId,
      })
    }
    return { nodeId, cwd }
  }

  /** 关停：清理磁盘统计定时器并等待在途刷新完成。 */
  async dispose(): Promise<void> {
    if (this.localDiskRefreshTimer !== undefined) {
      clearInterval(this.localDiskRefreshTimer)
      this.localDiskRefreshTimer = undefined
    }
    await this.localDiskRefreshing
  }
}

/** RpcResult 边界形状判定（升级结构化应答分流用；详细校验在 unwrap / validate 系列）。 */
function isRpcResultEnvelope(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}
