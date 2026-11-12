/**
 * Hub 侧 TCP 端口转发（前台 MVP）：在 Hub 主机上按需监听 listenHost:listenPort，
 * 每个入站连接经 EnvFabric.openTunnel 建立到目标节点 targetHost:targetPort 的
 * 任意 TCP 隧道并双向 pipe。
 *
 * 生命周期（前台租约，与 CLI 前台命令对齐）：
 * - **持有者模型**：创建后若未在 leaseTimeoutMs 内绑定监控事件流（acquireLease）
 *   自动停止（CLI 被杀/DELETE 失败时监听器不残留）；绑定后最后一个持有者
 *   释放（releaseLease，监控流断开/cancel 时调用）即停止；只读 list/get
 *   不是持有者；显式 stop() / 宿主 close 同样停止；
 * - 事件（connections/errors/stopped）经回调上报（HTTP 层转 NDJSON）；
 * - 同一 listen 地址冲突（EADDRINUSE）显式失败；stop 幂等（共享关闭 Promise，
 *   并发/重复调用等同一结果）；start 的 listen 与 stop 并发时 close 返回后
 *   绝不发布新监听会话。
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { HelmError, type NodeForwardEvent, type NodeForwardInput, type NodeForwardSession } from '@helm/protocol'
import type { Duplex } from 'node:stream'
import type { EnvFabric } from './fabric.js'

export type { NodeForwardEvent, NodeForwardInput, NodeForwardSession } from '@helm/protocol'

/** 缺省前台租约期限：创建后未绑定事件流即自动停止（CLI 仅需一次流请求）。 */
export const NODE_FORWARD_LEASE_TIMEOUT_MS = 15_000

/** 校验 host：非空、无控制字符/空白、≤255（hostname 或 IP 文本）。 */
function validateHost(raw: unknown, what: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 255 ||
    raw.trim() !== raw ||
    /\s/.test(raw)
  ) {
    throw new HelmError('validation_error', `${what} 需为非空、无空白的字符串（≤255 字符）`, 400, { value: raw })
  }
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      throw new HelmError('validation_error', `${what} 不得含控制字符`, 400, { value: raw })
    }
  }
  return raw
}

function validatePort(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 65535) {
    throw new HelmError('validation_error', `${what} 需为 1..65535 的安全整数`, 400, { value: raw })
  }
  return raw
}

export function parseNodeForwardInput(raw: Record<string, unknown>): NodeForwardInput {
  const listenHost = validateHost(raw['listenHost'], 'listenHost')
  const listenPort = validatePort(raw['listenPort'], 'listenPort')
  const targetPort = validatePort(raw['targetPort'], 'targetPort')
  const targetHost = raw['targetHost'] === undefined ? undefined : validateHost(raw['targetHost'], 'targetHost')
  return { listenHost, listenPort, ...(targetHost === undefined ? {} : { targetHost }), targetPort }
}

interface ActiveForward {
  session: NodeForwardSession
  server: net.Server
  /** 活动隧道 duplex（stop 时统一销毁）。 */
  tunnels: Set<Duplex>
  events: EventEmitter
  /** 终止等待器（监控流关闭用；stop 时在终态帧后调用）。 */
  stopWaiters: Set<() => void>
  /** 持有者数（监控事件流绑定 +1 / 断开 -1；归零且曾绑定即停止）。 */
  holders: number
  /** 租约定时器：创建后未及时绑定持有者即自动停止。 */
  leaseTimer: NodeJS.Timeout | undefined
  /** 幂等关闭：并发/重复 stop 共享同一 Promise。 */
  stopPromise: Promise<void> | undefined
  sessionRemoved: boolean
  stopped(): boolean
  stop(reason: string): Promise<void>
}

export class NodeForwardService {
  readonly #fabric: EnvFabric
  readonly #forwards = new Map<string, ActiveForward>()
  #closed = false

  constructor(
    fabric: EnvFabric,
    private readonly leaseTimeoutMs: number = NODE_FORWARD_LEASE_TIMEOUT_MS,
  ) {
    this.#fabric = fabric
  }

  /** 创建转发（前台命令生命周期）：监听失败显式失败；成功返回会话。 */
  async start(nodeId: string, input: NodeForwardInput): Promise<NodeForwardSession> {
    if (this.#closed) throw new HelmError('node_offline', '转发服务已关闭', 409)
    const forwardId = `fwd-${cryptoRandomUUID()}`
    const targetHost = input.targetHost ?? '127.0.0.1'
    const session: NodeForwardSession = {
      forwardId,
      nodeId,
      listenHost: input.listenHost,
      listenPort: input.listenPort,
      targetHost,
      targetPort: input.targetPort,
      activeConnections: 0,
      totalConnections: 0,
    }
    const tunnels = new Set<Duplex>()
    /** 建连在途的 abort 控制器（stop 时统一取消，防残留建立）。 */
    const pendingOpens = new Set<AbortController>()
    const events = new EventEmitter()

    const server = net.createServer((socket) => {
      if (forward.sessionRemoved) { socket.destroy(); return }
      socket.on('error', () => undefined) // 防未处理 error 崩进程；真实清理在 cleanup
      session.totalConnections += 1
      // 建连期即绑 socket 生命周期：客户端先断开时立即取消在途建立，
      // 迟到的 tunnel 直接销毁（不 pipe、不登记）。
      const controller = new AbortController()
      pendingOpens.add(controller)
      let socketGone = false
      const onSocketGone = (): void => {
        socketGone = true
        controller.abort()
      }
      socket.once('close', onSocketGone)
      socket.once('error', onSocketGone)
      void (async () => {
        let tunnel: Duplex | undefined
        try {
          tunnel = await this.#fabric.openTunnel(nodeId, { host: targetHost, port: input.targetPort }, controller.signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!socketGone) {
            session.lastError = message
            events.emit('event', { type: 'error', message } satisfies NodeForwardEvent)
          }
          socket.destroy()
          return
        } finally {
          pendingOpens.delete(controller)
          socket.removeListener('close', onSocketGone)
          socket.removeListener('error', onSocketGone)
        }
        // 建连期间客户端已断开或转发已停止：迟到 tunnel 立即销毁，不登记。
        if (socketGone || forward.sessionRemoved) { tunnel.destroy(); socket.destroy(); return }
        tunnels.add(tunnel)
        session.activeConnections += 1
        events.emit('event', { type: 'connection', count: session.activeConnections } satisfies NodeForwardEvent)
        // 恰好一次清理：socket/tunnel 任一 close/error 都进入同一收敛点，
        // 不重复 decrement（否则会吃掉其他活动连接的计数）。
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          socket.removeListener('close', cleanup)
          socket.removeListener('error', cleanup)
          tunnel!.removeListener('close', cleanup)
          tunnel!.removeListener('error', cleanup)
          tunnels.delete(tunnel!)
          session.activeConnections = Math.max(0, session.activeConnections - 1)
          socket.destroy()
          tunnel!.destroy()
        }
        socket.once('close', cleanup)
        socket.once('error', cleanup)
        tunnel!.once('close', cleanup)
        tunnel!.once('error', cleanup)
        socket.pipe(tunnel)
        tunnel.pipe(socket)
      })()
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new HelmError(
          'node_forward_listen_failed',
          `监听 ${input.listenHost}:${input.listenPort} 失败：${error.message}`,
          409,
          { listenHost: input.listenHost, listenPort: input.listenPort },
        ))
      }
      server.once('error', onError)
      server.listen(input.listenPort, input.listenHost, () => {
        server.removeListener('error', onError)
        // listen 之后的运行期错误如实记录（不崩进程）。
        server.on('error', (error) => {
          session.lastError = error.message
          events.emit('event', { type: 'error', message: error.message } satisfies NodeForwardEvent)
        })
        resolve()
      })
    })

    // listen 完成后与 stop 并发：close/服务已关停期间绝不发布新监听会话。
    if (this.#closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new HelmError('node_offline', '转发服务已关闭', 409)
    }

    const forward: ActiveForward = {
      session,
      server,
      tunnels,
      events,
      stopWaiters: new Set(),
      holders: 0,
      leaseTimer: undefined,
      stopPromise: undefined,
      sessionRemoved: false,
      stopped: () => forward.stopPromise !== undefined,
      // 箭头函数：this 即 service（闭包捕获），供内部摘除登记。
      stop: (reason: string): Promise<void> => {
        // 幂等：并发/重复调用共享同一关闭 Promise（后续调用不再「立即返回」，
        // 而是等同一关闭完成）。
        if (forward.stopPromise !== undefined) return forward.stopPromise
        forward.sessionRemoved = true
        if (forward.leaseTimer !== undefined) clearTimeout(forward.leaseTimer)
        forward.stopPromise = (async () => {
          // 终态帧先行（监控流收到后由 stopWaiters 正常关闭，不悬挂），
          // 再取消全部在途建连（迟到 tunnel 由各连接分支自行销毁，不登记）。
          forward.events.emit('event', { type: 'stopped' } satisfies NodeForwardEvent)
          for (const waiter of [...forward.stopWaiters]) waiter()
          forward.stopWaiters.clear()
          for (const controller of [...pendingOpens]) controller.abort()
          pendingOpens.clear()
          for (const tunnel of [...forward.tunnels]) tunnel.destroy()
          forward.tunnels.clear()
          await new Promise<void>((resolve) => forward.server.close(() => resolve()))
          this.#forwards.delete(forwardId)
          void reason
          forward.events.removeAllListeners()
        })()
        return forward.stopPromise
      },
    }
    this.#forwards.set(forwardId, forward)
    // 前台租约：创建后未在期限内绑定持有者（acquireLease）即自动停止。
    forward.leaseTimer = setTimeout(() => {
      if (forward.holders === 0 && !forward.stopped()) {
        void forward.stop('lease_timeout').catch(() => undefined)
      }
    }, this.leaseTimeoutMs)
    forward.leaseTimer.unref?.()
    events.emit('event', { type: 'started', listenHost: session.listenHost, listenPort: session.listenPort } satisfies NodeForwardEvent)
    return { ...session }
  }

  /** 订阅事件（监控流用）；返回退订函数。 */
  onEvent(forwardId: string, listener: (event: NodeForwardEvent) => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `转发 ${forwardId} 不存在`, 404, { forwardId })
    forward.events.on('event', listener)
    return () => forward.events.removeListener('event', listener)
  }

  /**
   * 绑定持有者（前台租约）：监控事件流建立时调用——清除创建租约定时器、
   * holders +1。返回释放函数（监控流断开/cancel 时调用）：holders -1，
   * 归零即停止转发（最后一个持有者离开即关闭监听器）。对已停止转发无操作。
   */
  acquireLease(forwardId: string): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `转发 ${forwardId} 不存在`, 404, { forwardId })
    if (forward.stopped()) return () => undefined
    if (forward.leaseTimer !== undefined) {
      clearTimeout(forward.leaseTimer)
      forward.leaseTimer = undefined
    }
    forward.holders += 1
    return () => {
      if (forward.stopped()) return
      forward.holders = Math.max(0, forward.holders - 1)
      if (forward.holders === 0) {
        void forward.stop('last_holder_released').catch(() => undefined)
      }
    }
  }

  /**
   * 订阅终止通知（监控流正常结束用；终态 stopped 帧之后调用）：转发已停止
   * 或已摘除时以微任务立即回调（订阅竞态安全）；返回退订函数。转发从未
   * 存在时同样保守立即回调（监控流收尾优先；GET 详情会先 404）。
   */
  onStopped(forwardId: string, listener: () => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined || forward.stopped()) {
      queueMicrotask(listener)
      return () => undefined
    }
    forward.stopWaiters.add(listener)
    return () => {
      forward.stopWaiters.delete(listener)
    }
  }

  get(forwardId: string): NodeForwardSession | undefined {
    const forward = this.#forwards.get(forwardId)
    return forward === undefined ? undefined : { ...forward.session }
  }

  list(): NodeForwardSession[] {
    return [...this.#forwards.values()].map((f) => ({ ...f.session }))
  }

  /** 停止转发（幂等：共享同一关闭 Promise）。 */
  async stop(forwardId: string): Promise<void> {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `转发 ${forwardId} 不存在`, 404, { forwardId })
    await forward.stop('explicit')
  }

  /** 关闭全部转发（宿主 close / dispose）。 */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#forwards.values()].map((f) => f.stop('service_closed')))
  }
}
