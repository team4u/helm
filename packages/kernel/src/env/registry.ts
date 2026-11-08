/**
 * 跨平台计算节点连接注册表：Hub 侧 /ws/node 的 WS+birpc 连接池。
 *
 * 安全语义（每条均有真实测试）：
 * - **fail-closed 鉴权**：未提供 authenticate 回调时拒绝一切注册（缺省
 *   拒绝，绝不缺省放行）；
 * - **原子发布**：连接对象（含 birpc 代理）完全就绪（鉴权通过 + rpc 绑定）
 *   后才登记并唤醒等待者——等待者绝不会拿到半成品/undefined；
 * - **心跳/输出绑定当前连接**：noteHeartbeat(nodeId, socket) 只刷新「该
 *   连接注册的 nodeId」；onEnvExecOutput 只接受已注册连接的事件——未注册
 *   连接不能保活别人的节点，也不能伪造/注入其他节点的输出；
 * - **输出按节点路由**：dispatch 按 nodeId 找该节点全部 env 实例的 sink
 *   （同节点多会话并发 env 互不串扰，跨节点事件直接丢弃）；
 * - **IPC 订阅按 (nodeId, subscribeId) 精确路由**：节点回调 onIpcEvent /
 *   onIpcClosed 只分发到对应订阅者，订阅者关闭即摘除；
 * - **替换/TTL/关闭都真正断开**：同 nodeId 新连接顶掉旧连接时关闭旧
 *   socket + $close 旧 rpc；心跳超时与 registry.close() 同样关闭 socket，
 *   不只删 Map（防半开连接继续发事件）；
 * - 鉴权期间 socket 已关闭 → 不发布幽灵连接；
 * - disconnect(nodeId)：API 删除身份时立即断开当前 ws+rpc。
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { WebSocket as WsSocket } from 'ws'
import type { BirpcReturn } from 'birpc'
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeHealthSnapshot,
  NodeHeartbeatInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeRegisterInput,
  NodeUpgradeResult,
} from '@helm/protocol'
import type { Context } from '@earendil-works/chord/context'

/** 节点侧供 Hub 调用的函数集（env RPC 全集 + 连接控制）。 */
export type NodeSideFunctions = NodeEnvRpcFunctions & {
  register(input: NodeRegisterInput): Promise<{ ok: boolean; heartbeatMs: number; reason?: string }>
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
}

/** 非负有限数值校验（NaN/Infinity/负数/非数值一律非法）。 */
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** 有限数值校验（允许负值，loadAvg 理论非负但按「有限数」契约校验）。 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 边界校验：外部节点上报的健康快照在进入注册表前过滤。
 * 必填字段（collectedAt / uptimeSec / loadAvg / memFreeBytes / memTotalBytes）
 * 任一非法即整体丢弃（返回 undefined，不抛异常、不信任未校验的脏字段）；
 * 可选磁盘字段非法时仅忽略该字段。
 */
export function sanitizeNodeHealth(raw: unknown): NodeHealthSnapshot | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (!isNonNegativeFinite(o['collectedAt'])) return undefined
  if (!isNonNegativeFinite(o['uptimeSec'])) return undefined
  const load = o['loadAvg']
  if (
    !Array.isArray(load) ||
    load.length !== 3 ||
    !load.every((v) => isFiniteNumber(v))
  ) {
    return undefined
  }
  if (!isNonNegativeFinite(o['memFreeBytes'])) return undefined
  if (!isNonNegativeFinite(o['memTotalBytes'])) return undefined
  const health: NodeHealthSnapshot = {
    collectedAt: o['collectedAt'],
    uptimeSec: o['uptimeSec'],
    loadAvg: [load[0]!, load[1]!, load[2]!],
    memFreeBytes: o['memFreeBytes'],
    memTotalBytes: o['memTotalBytes'],
  }
  if (isNonNegativeFinite(o['diskFreeBytes'])) health.diskFreeBytes = o['diskFreeBytes']
  if (isNonNegativeFinite(o['diskTotalBytes'])) health.diskTotalBytes = o['diskTotalBytes']
  return health
}

export interface NodeConnection {
  nodeId: string
  /** 调用节点侧函数的代理（env RPC + register/heartbeat）。 */
  rpc: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
  socket: WsSocket
  connectedAt: number
  lastSeenAt: number
  hostname: string
  platform: string
  /** 节点上报的软件版本（非法/未提供时不保存）。 */
  version?: string
  /** 升级候选携带的尝试 ID（心跳 commit 按它对账）。 */
  upgradeAttemptId?: string
  /** 节点端配置的 Hub 地址（远端受管子进程回连用）。 */
  hubUrl?: string
  /** 最近一次注册或心跳捎带的健康快照（边界校验后的可信数据）。 */
  health?: NodeHealthSnapshot
}

/** Hub 侧本地函数（每连接一份，绑定该连接的注册身份）。 */
export interface HubConnectionLocal {
  onEnvExecOutput(event: EnvExecOutputEvent): void
  onIpcEvent(event: NodeIpcEvent): void
  onIpcClosed(event: NodeIpcClosedEvent): void
}

export interface RegisterOutcome {
  accepted: boolean
  reason?: string
  /** 期望的心跳间隔（毫秒）。 */
  heartbeatMs?: number
}

export interface NodeRegistryOptions {
  /** 心跳超时（毫秒）判离线；缺省 45s。 */
  heartbeatTimeoutMs?: number
  /** register 应答给节点的心跳间隔；缺省 15s。 */
  heartbeatIntervalMs?: number
  /**
   * 节点 token 校验（sha256(wholeToken) 比对等；由外部签发表提供）。
   * **缺省拒绝一切注册（fail-closed）**。
   */
  authenticate: (nodeId: string, token: string) => boolean | Promise<boolean>
}

interface Waiter {
  nodeId: string
  resolve: (rpc: NodeEnvRpcFunctions | undefined) => void
  cancelled: () => void
}

/** 升级等待器：有界内存承诺，仅由匹配的心跳 commit resolve。 */
interface UpgradeWaiter {
  nodeId: string
  attemptId: string
  targetVersion: string
  previousVersion: string
  resolve: (result: NodeUpgradeResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** beginUpgrade 返回的受控等待器句柄。 */
export interface UpgradeWaiterHandle {
  /** 升级终态：仅匹配心跳 commit resolve 成功；超时/取消/断开 reject。 */
  result: Promise<NodeUpgradeResult>
  /** 主动取消（清理等待器；reason 作为 rejection 原因）。 */
  cancel(reason?: Error): void
}

/** IPC 订阅回调集。 */
export interface IpcSink {
  onEvent: (line: string) => void
  onClosed: (error?: string) => void
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** 同节点并发升级等待拒绝（调用方映射为 409）。 */
export class HelmUpgradeBusyError extends Error {}
/** 升级等待超时（未收到匹配 commit）。 */
export class HelmUpgradeTimeoutError extends Error {}
/** 升级等待被主动取消。 */
export class HelmUpgradeCancelledError extends Error {}

/** timing-safe 令牌校验回调（签发表存 sha256(wholeToken) 十六进制）。 */
export function tokenAuthenticator(
  sha256HexOf: (nodeId: string) => string | undefined,
): (nodeId: string, token: string) => boolean {
  return (nodeId, token) => {
    const expected = sha256HexOf(nodeId)
    if (expected === undefined) return false
    return safeEqual(sha256hex(token), expected)
  }
}

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class NodeRegistry {
  readonly #connections = new Map<string, NodeConnection>()
  readonly #waiters = new Set<Waiter>()
  readonly #heartbeatIntervalMs: number
  readonly #heartbeatTimeoutMs: number
  readonly #authenticate: (nodeId: string, token: string) => boolean | Promise<boolean>
  readonly #nodeChangedListeners = new Set<(nodeId: string, online: boolean) => void>()
  /** 每节点的输出 sink 列表（同节点多 env 实例）。 */
  readonly #outputSinks = new Map<string, Set<(event: EnvExecOutputEvent) => void>>()
  /** IPC 订阅路由：nodeId -> subscribeId -> sink。 */
  readonly #ipcSinks = new Map<string, Map<string, IpcSink>>()
  /** 每节点至多一个在途升级等待器。 */
  readonly #upgradeWaiters = new Map<string, UpgradeWaiter>()
  /** 节点撤销 epoch：每次 evict/disconnect/替换递增；在途注册醒后必须校验。 */
  readonly #nodeEpoch = new Map<string, number>()
  #sweeper: NodeJS.Timeout | undefined
  #closed = false

  constructor(options: NodeRegistryOptions) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000
    // fail-closed：无鉴权回调 → 一律拒绝。
    this.#authenticate = options.authenticate ?? (() => false)
  }

  get heartbeatIntervalMs(): number {
    return this.#heartbeatIntervalMs
  }

  list(): NodeConnection[] {
    return [...this.#connections.values()].map((c) => ({ ...c }))
  }

  get(nodeId: string): NodeConnection | undefined {
    const conn = this.#connections.get(nodeId)
    return conn === undefined ? undefined : { ...conn }
  }

  /** 节点上下线回调（KernelRuntime 据此发布 node.changed SSE 事件）。 */
  onNodeChanged(listener: (nodeId: string, online: boolean) => void): () => void {
    this.#nodeChangedListeners.add(listener)
    return () => {
      this.#nodeChangedListeners.delete(listener)
    }
  }

  /** 注册输出 sink（按节点；fabric 为该节点每个 env 实例登记）。 */
  addOutputSink(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void {
    let set = this.#outputSinks.get(nodeId)
    if (set === undefined) {
      set = new Set()
      this.#outputSinks.set(nodeId, set)
    }
    set.add(sink)
  }

  removeOutputSink(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void {
    this.#outputSinks.get(nodeId)?.delete(sink)
  }

  /** 注册 IPC 订阅回调（nodeId + subscribeId 精确路由）。 */
  addIpcSink(nodeId: string, subscribeId: string, sink: IpcSink): void {
    let map = this.#ipcSinks.get(nodeId)
    if (map === undefined) {
      map = new Map()
      this.#ipcSinks.set(nodeId, map)
    }
    map.set(subscribeId, sink)
  }

  removeIpcSink(nodeId: string, subscribeId: string): void {
    this.#ipcSinks.get(nodeId)?.delete(subscribeId)
  }

  #dispatchIpcEvent(nodeId: string, event: NodeIpcEvent): void {
    this.#ipcSinks.get(nodeId)?.get(event.subscribeId)?.onEvent(event.line)
  }

  #dispatchIpcClosed(nodeId: string, event: NodeIpcClosedEvent): void {
    const map = this.#ipcSinks.get(nodeId)
    if (map === undefined) return
    const sink = map.get(event.subscribeId)
    if (sink === undefined) return
    map.delete(event.subscribeId)
    sink.onClosed(event.error)
  }

  /**
   * 节点 WS 连接的注册入口（ws-gateway 在连接层调用；birpc 代理由网关
   * 建立，经 attach 参数传入——代理的本地端即 hub 侧函数，输出/心跳/
   * IPC 事件绑定本连接）。鉴权通过且代理绑定完成后**原子**发布。
   */
  async register(
    socket: WsSocket,
    input: NodeRegisterInput,
    attach: (local: HubConnectionLocal) => BirpcReturn<NodeSideFunctions, HubConnectionLocal>,
  ): Promise<RegisterOutcome> {
    if (this.#closed) return { accepted: false, reason: 'registry closed' }
    const { nodeId, token, hostname, platform, hubUrl, version, upgradeAttemptId } = input ?? ({} as NodeRegisterInput)
    if (typeof nodeId !== 'string' || nodeId === 'local' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      return { accepted: false, reason: 'invalid nodeId' }
    }
    if (typeof token !== 'string' || token.length === 0) return { accepted: false, reason: 'missing token' }
    // 边界校验：version / upgradeAttemptId 要么缺省要么非空字符串；
    // 非法类型/空串显式拒绝注册（不静默丢弃——那会破坏升级对账身份）。
    if (version !== undefined && (typeof version !== 'string' || version === '')) {
      return { accepted: false, reason: 'invalid version' }
    }
    if (upgradeAttemptId !== undefined && (typeof upgradeAttemptId !== 'string' || upgradeAttemptId === '')) {
      return { accepted: false, reason: 'invalid upgradeAttemptId' }
    }
    // 撤销 epoch 快照：鉴权 await 期间 removeNode/轮换/顶替都会递增，
    // 迟到的 resolve(true) 不再把被撤销的旧连接发布在线。
    const epochAtStart = this.#epochOf(nodeId)
    let valid = false
    try {
      valid = await this.#authenticate(nodeId, token)
    } catch {
      valid = false
    }
    if (!valid) return { accepted: false, reason: 'invalid token' }
    // 鉴权期间连接可能已断：不发布幽灵连接。
    if (socket.readyState !== socket.OPEN) return { accepted: false, reason: 'connection closed during auth' }
    if (this.#closed) return { accepted: false, reason: 'registry closed' }
    // 撤销红线：鉴权在途期间发生过 evict/disconnect（removeNode、令牌轮换、
    // 新连接顶替）→ 本注册已失效，拒绝发布（旧连接绝不重上线）。
    if (this.#epochOf(nodeId) !== epochAtStart) {
      return { accepted: false, reason: 'register superseded by revoke/replace' }
    }

    // 建立代理：本地函数绑定本连接与发布代（未发布前/被撤销后事件全部丢弃）。
    let publishEpoch = epochAtStart
    let published = false
    const isLive = (): boolean =>
      published && this.#epochOf(nodeId) === publishEpoch && this.#connections.get(nodeId)?.rpc === rpc
    let rpc!: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
    rpc = attach({
      onEnvExecOutput: (event) => {
        if (!isLive()) return // 撤销/顶替后的迟到输出不污染新代
        this.#dispatchOutput(nodeId, event)
      },
      onIpcEvent: (event) => {
        if (!isLive()) return
        this.#dispatchIpcEvent(nodeId, event)
      },
      onIpcClosed: (event) => {
        if (!isLive()) return
        this.#dispatchIpcClosed(nodeId, event)
      },
    })

    // 顶掉旧连接：真正关闭旧 socket + rpc（不只删 Map），并推进 epoch
    //（旧代的迟到事件从此一律丢弃）。
    const prev = this.#connections.get(nodeId)
    if (prev !== undefined) this.#evict(nodeId, prev, 'replaced')
    publishEpoch = this.#epochOf(nodeId)

    const health = sanitizeNodeHealth(input?.health)
    const conn: NodeConnection = {
      nodeId,
      rpc,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      hostname: typeof hostname === 'string' ? hostname : '',
      platform: typeof platform === 'string' ? platform : '',
      ...(version !== undefined ? { version } : {}),
      ...(upgradeAttemptId !== undefined ? { upgradeAttemptId } : {}),
      ...(typeof hubUrl === 'string' && hubUrl !== '' ? { hubUrl } : {}),
      ...(health !== undefined ? { health } : {}),
    }
    this.#connections.set(nodeId, conn)
    published = true

    const gone = (): void => this.#evict(nodeId, conn, socket.readyState === socket.CLOSED ? 'closed' : 'error')
    socket.once('close', gone)
    socket.once('error', gone)

    this.#wakeWaiters(nodeId) // 完全就绪后才唤醒
    this.#notifyNodeChanged(nodeId, true)
    this.#ensureSweeper()
    return { accepted: true, heartbeatMs: this.#heartbeatIntervalMs }
  }

  /**
   * 创建升级等待器：返回的 result 仅由匹配的心跳 upgradeCommit resolve；
   * 超时 / cancel() / registry.close() reject（原 socket 传输断开不终结
   * 等待器——升级本身就伴随候选顶替旧连接）。同节点并发升级等待显式拒绝。
   * register 不 resolve 等待器——候选注册只携带 attemptId，真正的成功
   * 确认只能来自候选自己的 commit 心跳。
   */
  beginUpgrade(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#closed) throw new Error('registry closed')
    if (this.#upgradeWaiters.has(nodeId)) {
      throw new HelmUpgradeBusyError(`节点 ${nodeId} 已有在途升级等待器`)
    }
    let waiter: UpgradeWaiter | undefined
    const result = new Promise<NodeUpgradeResult>((resolve, reject) => {
      waiter = {
        nodeId,
        attemptId: params.attemptId,
        targetVersion: params.targetVersion,
        previousVersion: params.previousVersion,
        resolve,
        reject,
        timer: setTimeout(() => {
          const w = this.#upgradeWaiters.get(nodeId)
          if (w !== undefined && w.attemptId === params.attemptId) {
            this.#upgradeWaiters.delete(nodeId)
            w.reject(new HelmUpgradeTimeoutError(
              `节点 ${nodeId} 升级到 ${params.targetVersion} 未在 ${params.timeoutMs}ms 内确认`,
            ))
          }
        }, params.timeoutMs),
      }
      waiter.timer.unref?.()
      this.#upgradeWaiters.set(nodeId, waiter)
    })
    // 防未处理 rejection：调用方始终 await result，但保险起见吞掉观察者缺位。
    result.catch(() => undefined)
    return {
      result,
      cancel: (reason?: Error) => {
        const w = this.#upgradeWaiters.get(nodeId)
        if (w === undefined || w.attemptId !== params.attemptId) return
        clearTimeout(w.timer)
        this.#upgradeWaiters.delete(nodeId)
        w.reject(reason ?? new HelmUpgradeCancelledError(`节点 ${nodeId} 升级等待已取消`))
      },
    }
  }

  /** 测试内省：节点是否存在在途升级等待器。 */
  hasUpgradeWaiter(nodeId: string): boolean {
    return this.#upgradeWaiters.has(nodeId)
  }

  /**
   * 升级心跳 commit 处理（noteHeartbeat 内部调用；已验证 conn 是当前连接），
   * 返回值即心跳 ACK：
   * - 仅 conn.upgradeAttemptId === commit.attemptId（候选以该 attempt 注册）
   *   且 conn.version === commit.version（候选确实运行目标版本）才合法；
   * - 合法且存在等待器时再核实 targetVersion / previousVersion 完全
   *   一致才 resolve（pid 正整数），不一致不倒灌别的 attempt，且 ACK false
   *   （节点据此重试/回滚，绝不误以为 Hub 已确认）；
   * - 合法但无等待器（如本机 CLI 升级后重连）视为已接受（true）。
   */
  #applyUpgradeCommit(nodeId: string, conn: NodeConnection, commit: unknown): boolean {
    if (commit === null || typeof commit !== 'object' || Array.isArray(commit)) {
      return false
    }
    const c = commit as Record<string, unknown>
    const { attemptId, version, previousVersion, pid } = c
    if (typeof attemptId !== 'string' || attemptId === '' || typeof version !== 'string' || version === '') {
      return false
    }
    if (typeof previousVersion !== 'string' || previousVersion === '') {
      return false
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return false
    }
    // 当前连接必须以该 attempt 注册且已运行目标版本（伪造/过期的 commit 拒绝）。
    if (conn.upgradeAttemptId !== attemptId || conn.version !== version) {
      return false
    }
    const waiter = this.#upgradeWaiters.get(nodeId)
    if (waiter === undefined) return true
    // 等待器与 commit 必须完全同源：不同 attempt/版本的迟到 commit 不倒灌。
    if (
      waiter.attemptId !== attemptId ||
      waiter.targetVersion !== version ||
      waiter.previousVersion !== previousVersion
    ) {
      return false
    }
    clearTimeout(waiter.timer)
    this.#upgradeWaiters.delete(nodeId)
    waiter.resolve({
      ok: true,
      previousVersion,
      targetVersion: version,
      upgraded: true,
      pid,
    })
    return true
  }

  /** 心跳：仅当 nodeId 与发送连接的注册身份一致才刷新；携带合法健康
   * 快照时同步覆盖 conn.health（非法快照忽略、不影响 lastSeenAt 刷新；
   * birpc 缺省尾参会序列化为 null，同样按无载荷处理）。携带 upgradeCommit
   * 时 ACK 反映 commit 真实接受结果（非法/不匹配 → false）；普通心跳
   * （无 commit）恒 true。 */
  noteHeartbeat(nodeId: string, fromSocket: WsSocket, input?: NodeHeartbeatInput): boolean {
    const conn = this.#connections.get(nodeId)
    if (conn === undefined || conn.socket !== fromSocket) return false
    conn.lastSeenAt = Date.now()
    if (input !== undefined && input !== null) {
      const health = sanitizeNodeHealth(input.health)
      if (health !== undefined) conn.health = health
      if (input.upgradeCommit !== undefined && input.upgradeCommit !== null) {
        return this.#applyUpgradeCommit(nodeId, conn, input.upgradeCommit)
      }
    }
    return true
  }

  /** 立即断开指定节点（API 删除身份时调用）。幂等。
   *
   * 撤销红线：即使当前无已发布连接，也递增撤销 epoch——鉴权在途的注册
   * （await authenticate 未醒）在醒来后必须被拒，绝不把被撤销的旧连接
   * 发布在线（removeNode/令牌轮换语义）。 */
  disconnect(nodeId: string): void {
    const conn = this.#connections.get(nodeId)
    if (conn !== undefined) {
      this.#evict(nodeId, conn, 'revoked')
      return
    }
    // 无已发布连接：仍推进 epoch 使在途注册失效。
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
  }

  /** disconnect 的别名（语义化：吊销身份）。 */
  revoke(nodeId: string): void {
    this.disconnect(nodeId)
  }

  #dispatchOutput(nodeId: string, event: EnvExecOutputEvent): void {
    const sinks = this.#outputSinks.get(nodeId)
    if (sinks === undefined) return
    for (const sink of sinks) {
      try {
        sink(event)
      } catch {
        // 单个 sink 故障不影响其他。
      }
    }
  }

  /** 当前撤销 epoch（缺省 0；evict/disconnect/替换递增）。 */
  #epochOf(nodeId: string): number {
    return this.#nodeEpoch.get(nodeId) ?? 0
  }

  #notifyNodeChanged(nodeId: string, online: boolean): void {
    for (const listener of [...this.#nodeChangedListeners]) {
      try {
        listener(nodeId, online)
      } catch {
        // 监听器故障不影响注册表自身。
      }
    }
  }

  #evict(nodeId: string, conn: NodeConnection, reason: string): void {
    if (this.#connections.get(nodeId) !== conn) return
    this.#connections.delete(nodeId)
    // 升级等待器不在断开时清理：升级过程本身就伴随旧 socket 关闭、
    // 候选新连接顶替；成功确认只能来自候选的 commit 心跳。等待器由
    // cancel / 超时 / registry.close / 匹配 commit 终结，绝不因断开假终态。
    // 撤销 epoch 递增：在途注册（鉴权 await 中）与本代迟到事件全部失效。
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
    try {
      conn.rpc.$close()
    } catch {
      // 已关闭。
    }
    if (conn.socket.readyState === conn.socket.OPEN || conn.socket.readyState === conn.socket.CONNECTING) {
      try {
        conn.socket.close(1000, reason)
      } catch {
        // 忽略。
      }
    }
    // 断开时终结该节点全部 IPC 订阅（连接已失，订阅不再有事件来源）。
    const ipcMap = this.#ipcSinks.get(nodeId)
    if (ipcMap !== undefined) {
      const sinks = [...ipcMap.values()]
      ipcMap.clear()
      for (const sink of sinks) {
        try {
          sink.onClosed(`node ${nodeId} disconnected`)
        } catch {
          // 订阅者回调故障不影响其他订阅者。
        }
      }
    }
    this.#notifyNodeChanged(nodeId, false)
    this.#wakeWaiters(nodeId)
  }

  #wakeWaiters(nodeId: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.nodeId !== nodeId) continue
      this.#waiters.delete(waiter)
      const conn = this.#connections.get(nodeId)
      waiter.resolve(conn !== undefined ? conn.rpc : undefined)
    }
  }

  /** 等待节点重新在线；context 取消时返回 undefined。 */
  async waitForNodeOnline(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions | undefined> {
    if (this.#closed || context.abortSignal?.aborted) return undefined
    const existing = this.#connections.get(nodeId)
    if (existing !== undefined) return existing.rpc
    const waiter: Waiter = {
      nodeId,
      resolve: () => undefined,
      cancelled: () => undefined,
    }
    const promise = new Promise<NodeEnvRpcFunctions | undefined>((resolve) => {
      waiter.resolve = resolve
    })
    const cancelPromise = new Promise<undefined>((resolve) => {
      waiter.cancelled = () => resolve(undefined)
    })
    const signal = context.abortSignal
    const onAbort = () => waiter.cancelled()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.#waiters.add(waiter)
    try {
      return await Promise.race([promise, cancelPromise])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.#waiters.delete(waiter)
    }
  }

  /** 供 fabric 实现 NodeRpcResolver。 */
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined {
    return this.#connections.get(nodeId)?.rpc
  }

  #ensureSweeper(): void {
    if (this.#sweeper !== undefined || this.#closed) return
    this.#sweeper = setInterval(() => {
      const now = Date.now()
      for (const [nodeId, conn] of [...this.#connections]) {
        if (now - conn.lastSeenAt > this.#heartbeatTimeoutMs) {
          this.#evict(nodeId, conn, 'heartbeat timeout')
        }
      }
    }, Math.min(10_000, this.#heartbeatTimeoutMs))
    this.#sweeper.unref()
  }

  /** 关闭注册表：断开全部连接（关 socket + rpc）、唤醒等待者、清空 sink。 */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    for (const [nodeId, waiter] of [...this.#upgradeWaiters]) {
      clearTimeout(waiter.timer)
      this.#upgradeWaiters.delete(nodeId)
      waiter.reject(new HelmUpgradeCancelledError('registry closed'))
    }
    for (const [nodeId, conn] of [...this.#connections]) {
      this.#evict(nodeId, conn, 'registry closed')
    }
    this.#connections.clear()
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter)
      waiter.resolve(undefined)
    }
    this.#outputSinks.clear()
    this.#ipcSinks.clear()
    this.#nodeEpoch.clear()
    this.#nodeChangedListeners.clear()
  }
}

export type { NodeRegisterInput }
export type { NodeHealthSnapshot, NodeHeartbeatInput } from '@helm/protocol'
