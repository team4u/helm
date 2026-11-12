/**
 * 节点透传隧道独立网关：/ws/node-tunnel。
 *
 * 与 /ws/node（birpc 控制面）不同，本网关只承载「首帧 JSON 认证 → 之后
 * 纯字节管道」的隧道连接：
 * - 首帧必须是 NodeTunnelHello（无 type 字段）且 ≤ 4096 字节；非法 JSON/
 *   结构不符/鉴权失败/pending 不存在或不匹配 → 回 NodeTunnelControl error
 *   帧后关闭（诚实拒绝，不静默挂死）；error 之后绝不进入数据期；
 * - 首帧超时：从不发 hello 的连接在时限（缺省 10s，对照 /ws/node 的
 *   registerTimeoutMs）后 close(4001)，防恶意/异常客户端堆积空闲连接；
 * - 成功路径：**先认证 + 一次性匹配 + epoch 复查全通过（acceptTunnel），
 *   再发 {type:'ok'}，随后 createWebSocketStream 交棒 grantTunnel**——
 *   ok 帧绝不早于认证；grantTunnel 发现 pending 已定格失败时销毁交来的
 *   流（registry 内防泄漏），本网关亦不残留任何资源；
 * - 交棒后停止一切 JSON 解析：后续帧只走 Duplex 字节流（数据期单帧上限
 *   由 wss maxPayload 界定，远大于首帧 4096 限制）。
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws'
import type { NodeTunnelControl, NodeTunnelErrorCode, NodeTunnelHello } from '@helm/protocol'
import type { NodeRegistry } from './registry.js'

export interface NodeTunnelGatewayOptions {
  registry: NodeRegistry
  path?: string
  /** 首帧 hello 超时（毫秒），缺省 10s（对照 /ws/node 网关）。 */
  helloTimeoutMs?: number
  log?: (message: string) => void
}

export interface NodeTunnelGateway {
  close(): Promise<void>
}

const HELLO_MAX_BYTES = 4096

/** 首帧 hello 超时缺省（对照 ws-gateway 的 registerTimeoutMs=10s）。 */
const DEFAULT_HELLO_TIMEOUT_MS = 10_000

const isHello = (data: unknown): data is NodeTunnelHello =>
  data !== null && typeof data === 'object' && !Array.isArray(data) &&
  typeof (data as Record<string, unknown>)['tunnelId'] === 'string' &&
  typeof (data as Record<string, unknown>)['nodeId'] === 'string' &&
  typeof (data as Record<string, unknown>)['token'] === 'string'

export function attachNodeTunnelGateway(server: HttpServer, options: NodeTunnelGatewayOptions): NodeTunnelGateway {
  const {
    registry,
    path = '/ws/node-tunnel',
    helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
    log = (message: string) => console.error(`[helm] node tunnel gateway: ${message}`),
  } = options
  // 数据期单帧上限 1MiB（daemon 侧 stream 写侧 HWM 自适应分帧）；
  // 首帧 hello 另行独立校验 ≤ 4096 字节。
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let closing: Promise<void> | undefined

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) return
    if (closing) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws))
  }
  // 复用同一 server 的 upgrade 事件流（与 /ws/node 网关按 pathname 分流）。
  server.on('upgrade', onUpgrade)

  function fail(ws: WebSocket, code: NodeTunnelErrorCode, message: string): void {
    const frame: NodeTunnelControl = { type: 'error', code, message }
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // 发送失败即随关闭回收。
    }
    ws.close(4004, 'tunnel rejected')
  }

  function handleConnection(ws: WebSocket): void {
    // 首帧超时：从不发 hello 的连接到时关闭（不静默挂死，也不无限堆积）。
    const helloTimer = setTimeout(() => ws.close(4001, 'tunnel hello timeout'), helloTimeoutMs)
    const onFirstFrame = (raw: unknown): void => {
      clearTimeout(helloTimer)
      const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw as Buffer).length
      if (bytes > HELLO_MAX_BYTES) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', `隧道首帧超过 ${HELLO_MAX_BYTES} 字节上限`)
        return
      }
      let data: unknown
      try {
        data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8'))
      } catch {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', '隧道首帧不是合法 JSON')
        return
      }
      if (!isHello(data)) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', '隧道首帧不是合法 hello')
        return
      }
      const hello = data
      ws.removeListener('message', onFirstFrame)
      void registry.acceptTunnel(hello.nodeId, hello.token, hello.tunnelId).then((accepted) => {
        if (!accepted) {
          // 认证/一次性匹配/epoch 复查任一失败：error 帧 + 关闭（ok 从未发出，
          // 不进入数据期；此连接从未建 stream，无资源需要回收）。
          fail(ws, 'permission_denied', '隧道拒绝：tunnelId 无效、节点换代或鉴权失败')
          return
        }
        // 全部通过：先发 ok（节点侧据此开始转发字节），再建 stream、交棒。
        // grantTunnel 发现 pending 已定格失败（超时/abort 刚好插队）时会
        // 销毁交来的流——此处再关 ws 兜底，两侧都不泄漏。
        const okFrame: NodeTunnelControl = { type: 'ok' }
        try {
          ws.send(JSON.stringify(okFrame))
        } catch {
          ws.terminate()
          return
        }
        const stream = createWebSocketStream(ws)
        registry.grantTunnel(hello.tunnelId, stream)
      }).catch((error: unknown) => {
        log(`隧道交接失败：${error instanceof Error ? error.message : String(error)}`)
        fail(ws, 'unknown', '隧道交接失败')
      })
    }
    ws.on('message', onFirstFrame)
    ws.once('close', () => {
      clearTimeout(helloTimer)
      ws.removeListener('message', onFirstFrame)
    })
    ws.once('error', (error) => {
      log(`隧道连接错误：${error instanceof Error ? error.message : String(error)}`)
      clearTimeout(helloTimer)
      ws.removeListener('message', onFirstFrame)
      ws.terminate()
    })
  }

  return {
    close() {
      if (!closing) closing = (async () => {
        server.removeListener('upgrade', onUpgrade)
        for (const socket of wss.clients) socket.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}
