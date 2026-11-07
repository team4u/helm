/** 节点网关：每条连接只有一个 birpc 实例，控制面与环境 RPC 共用它。 */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type { NodeHeartbeatInput, NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import type { HubConnectionLocal, NodeRegistry, NodeSideFunctions } from './registry.js'

export interface NodeWsGatewayOptions {
  registry: NodeRegistry
  path?: string
  registerTimeoutMs?: number
  log?: (message: string) => void
}
export interface NodeWsGateway { readonly onlineCount: number; close(): Promise<void> }

export function attachNodeWsGateway(server: HttpServer, options: NodeWsGatewayOptions): NodeWsGateway {
  const { registry, path = '/ws/node', registerTimeoutMs = 10_000, log = () => undefined } = options
  const wss = new WebSocketServer({ noServer: true })
  let closing: Promise<void> | undefined
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) return
    if (closing) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, url.searchParams.get('nodeId')))
  }
  server.on('upgrade', onUpgrade)

  function handleConnection(ws: WebSocket, routedNodeId: string | null): void {
    let callbacks: HubConnectionLocal | undefined
    let registering = false
    let registered = false
    const registerTimer = setTimeout(() => ws.close(4001, 'register timeout'), registerTimeoutMs)
    const local = {
      async register(input: NodeRegisterInput): Promise<NodeRegisterResult> {
        if (registering || registered || !input || (routedNodeId !== null && routedNodeId !== input.nodeId)) {
          ws.close(4003, 'invalid registration')
          return { ok: false, heartbeatMs: 0, reason: 'invalid registration' }
        }
        registering = true
        const outcome = await registry.register(ws, input, (bound) => { callbacks = bound; return rpc })
        registering = false
        if (!outcome.accepted) {
          setTimeout(() => ws.close(4003, 'register rejected'), 10).unref()
          return { ok: false, heartbeatMs: 0, reason: outcome.reason }
        }
        registered = true
        clearTimeout(registerTimer)
        return { ok: true, heartbeatMs: outcome.heartbeatMs ?? registry.heartbeatIntervalMs }
      },
      heartbeat: (nodeId: string, input?: NodeHeartbeatInput) => registry.noteHeartbeat(nodeId, ws, input),
      onEnvExecOutput: (event: Parameters<HubConnectionLocal['onEnvExecOutput']>[0]) => callbacks?.onEnvExecOutput(event),
      onIpcEvent: (event: Parameters<HubConnectionLocal['onIpcEvent']>[0]) => callbacks?.onIpcEvent(event),
      onIpcClosed: (event: Parameters<HubConnectionLocal['onIpcClosed']>[0]) => callbacks?.onIpcClosed(event),
    }
    const rpc = createBirpc<NodeSideFunctions, typeof local>(local, {
      post: (data) => {
        if (ws.readyState !== ws.OPEN) throw new Error('node connection closed')
        ws.send(JSON.stringify(data))
      },
      on: (dispatch) => {
        ws.on('message', (raw) => {
          let data: unknown
          try { data = JSON.parse(raw.toString()) } catch { ws.close(1007, 'invalid JSON'); return }
          if (!data || typeof data !== 'object' || Array.isArray(data)) { ws.close(1007, 'invalid RPC frame'); return }
          void dispatch(data)
        })
      },
      // 仅在连接已非 OPEN（发送失败导致断开）时终止连接：单次消息发送错误
      //（如临时背压）不直接掐断健康连接，交由后续发送或 close 事件处理。
      onGeneralError: (error, type) => {
        log(`节点 RPC 传输失败（${type}）：${error instanceof Error ? error.message : String(error)}`)
        if (ws.readyState !== ws.OPEN) ws.terminate()
        return true
      },
      serialize: (data) => data,
      deserialize: (data) => data as never,
      timeout: 30 * 60 * 1000,
    })
    const cleanup = (): void => { clearTimeout(registerTimer); rpc.$close() }
    ws.once('close', cleanup)
    ws.once('error', () => { cleanup(); ws.terminate() })
  }
  return {
    get onlineCount() { return registry.list().length },
    close() {
      if (!closing) closing = (async () => {
        server.removeListener('upgrade', onUpgrade)
        for (const socket of wss.clients) socket.terminate()
        await registry.close()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}
