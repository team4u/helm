/**
 * Hub 侧 TCP 端口转发（前台 MVP）：在 Hub 主机上按需监听 listenHost:listenPort，
 * 每个入站连接经 EnvFabric.openTunnel 建立到目标节点 targetHost:targetPort 的
 * 任意 TCP 隧道并双向 pipe。
 *
 * 生命周期约定（与 CLI 前台命令对齐）：
 * - 监听器只在显式命令期间存在：创建后由调用方持有（监控流断开 / stop() /
 *   宿主 close）即整体关闭，绝不残留；
 * - 事件流（connections / errors）经回调上报（HTTP 层转 NDJSON）；
 * - 同一 listen 地址冲突（EADDRINUSE）显式失败；stop 幂等。
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type { Duplex } from 'node:stream'
import type { EnvFabric } from './fabric.js'

export interface NodeForwardInput {
  /** Hub 侧监听地址（如 127.0.0.1 / 0.0.0.0；严格校验）。 */
  listenHost: string
  /** Hub 侧监听端口（1..65535；0 不可用——显式端口才能转发）。 */
  listenPort: number
  /** 目标主机（节点视角；省略默认 127.0.0.1）。 */
  targetHost?: string
  /** 目标端口（1..65535）。 */
  targetPort: number
}

export interface NodeForwardSession {
  forwardId: string
  nodeId: string
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  activeConnections: number
  totalConnections: number
  lastError?: string
}

export type NodeForwardEvent =
  | { type: 'started'; listenHost: string; listenPort: number }
  | { type: 'connection'; count: number }
  | { type: 'error'; message: string }
  /** 终态帧：stop() 先发本帧再关停（监控流据此正常结束，不悬挂）。 */
  | { type: 'stopped' }

/** 校验 listenHost：非空、无控制字符/首尾空白、≤255（hostname 或 IP 文本）。 */
function validateHost(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255 || raw.trim() !== raw) {
    throw new HelmError('validation_error', `${what} 需为非空、无首尾空白的字符串（≤255 字符）`, 400, { value: raw })
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
  stopped: boolean
  stop(): Promise<void>
}

export class NodeForwardService {
  readonly #fabric: EnvFabric
  readonly #forwards = new Map<string, ActiveForward>()
  #closed = false

  constructor(fabric: EnvFabric) {
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
    let stopped = false

    const server = net.createServer((socket) => {
      if (stopped) { socket.destroy(); return }
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
        if (socketGone || stopped) { tunnel.destroy(); socket.destroy(); return }
        tunnels.add(tunnel)
        session.activeConnections += 1
        events.emit('event', { type: 'connection', count: session.activeConnections } satisfies NodeForwardEvent)
        const cleanup = (): void => {
          tunnels.delete(tunnel!)
          session.activeConnections = Math.max(0, session.activeConnections - 1)
          socket.destroy()
          tunnel!.destroy()
        }
        socket.once('close', cleanup)
        socket.once('error', cleanup)
        tunnel.once('close', cleanup)
        tunnel.once('error', cleanup)
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

    const forward: ActiveForward = {
      session,
      server,
      tunnels,
      events,
      stopWaiters: new Set(),
      stopped: false,
      stop: async () => {
        if (stopped) return
        stopped = true
        // 终态帧先行（监控流收到后由 stopWaiters 正常关闭，不悬挂），
        // 再取消全部在途建连（迟到 tunnel 由各连接分支自行销毁，不登记）。
        events.emit('event', { type: 'stopped' } satisfies NodeForwardEvent)
        for (const waiter of [...forward.stopWaiters]) waiter()
        forward.stopWaiters.clear()
        for (const controller of [...pendingOpens]) controller.abort()
        pendingOpens.clear()
        for (const tunnel of [...tunnels]) tunnel.destroy()
        tunnels.clear()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        this.#forwards.delete(forwardId)
        events.removeAllListeners()
      },
    }
    this.#forwards.set(forwardId, forward)
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
   * 订阅终止通知（监控流正常结束用；终态 stopped 帧之后调用）：转发已停止
   * 或已摘除时以微任务立即回调（订阅竞态安全）；返回退订函数。转发从未
   * 存在时仍 404（与 onEvent 同口径）。
   */
  onStopped(forwardId: string, listener: () => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) {
      // 会话已摘除（stop 完成）或从未存在：无法区分时保守立即回调
      //（监控流收尾优先；对从未存在的 forwardId 无害——流会先经 getNodeForward 404）。
      queueMicrotask(listener)
      return () => undefined
    }
    if (forward.stopped) {
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

  /** 停止转发（幂等）。 */
  async stop(forwardId: string): Promise<void> {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `转发 ${forwardId} 不存在`, 404, { forwardId })
    await forward.stop()
  }

  /** 关闭全部转发（宿主 close / dispose）。 */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#forwards.values()].map((f) => f.stop()))
  }
}
