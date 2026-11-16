/**
 * node pass-through tunnel independent gateway:/ws/node-tunnel.
 *
 * and /ws/node(birpc control side) different, this gateway only bear load first frame JSON recognize verify → after
 * pure byte pipeline tunnel connect:
 * - first frame must be NodeTunnelHello(without type field) and ≤ 4096 byte; illegal JSON/
 *   structure do not symbol/authentication failed/pending missing or does not match → back NodeTunnelControl error
 *   frame after close (honest reject, not silently hang die);error after never enter data phase;
 * - first frame timeout: never hello connect in when limit (default 10s, compare /ws/node 
 *   registerTimeoutMs) after close(4001), guard against malicious/exception client heap accumulate idle connect;
 * - succeeded path:**first recognize verify + once match + epoch re- inspect all via (acceptTunnel),
 *   again {type:'ok'}, then createWebSocketStream hand over fine grantTunnel**- -
 *   ok frame never early at recognize verify;grantTunnel discover pending already set format on failure destroy hand over come
 *   stream (registry inside guard against leak leak), this gateway also leaves no residue any asset;
 * - hand over fine after stop everything JSON parse: after continue frame only away Duplex byte stream (data phase single frame cap
 *   by wss maxPayload boundary set, far greater than first frame 4096 restrict).
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws'
import type { NodeTunnelControl, NodeTunnelErrorCode, NodeTunnelHello } from '@helm/protocol'
import type { NodeRegistry } from './registry.js'

export interface NodeTunnelGatewayOptions {
  registry: NodeRegistry
  path?: string
  /** first frame hello timeout (milli second), default 10s(compare /ws/node gateway). */
  helloTimeoutMs?: number
  log?: (message: string) => void
}

export interface NodeTunnelGateway {
  close(): Promise<void>
}

const HELLO_MAX_BYTES = 4096

/** first frame hello timeout default (compare ws-gateway  registerTimeoutMs=10s). */
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
  // data phase single frame cap 1MiB(daemon side stream write side HWM self fit should frame);
  // first frame hello another row independent validate ≤ 4096 byte.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let closing: Promise<void> | undefined

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) return
    if (closing) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws))
  }
  // re- use the same server  upgrade event stream (and /ws/node gateway by pathname stream).
  server.on('upgrade', onUpgrade)

  function fail(ws: WebSocket, code: NodeTunnelErrorCode, message: string): void {
    const frame: NodeTunnelControl = { type: 'error', code, message }
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // failed to send i.e. follow close reclaim.
    }
    ws.close(4004, 'tunnel rejected')
  }

  function handleConnection(ws: WebSocket): void {
    // first frame timeout: never hello connect to when close (not silently hang die, also do not unbounded heap accumulate).
    const helloTimer = setTimeout(() => ws.close(4001, 'tunnel hello timeout'), helloTimeoutMs)
    const onFirstFrame = (raw: unknown): void => {
      clearTimeout(helloTimer)
      const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw as Buffer).length
      if (bytes > HELLO_MAX_BYTES) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', `tunnel first frame exceeds ${HELLO_MAX_BYTES} byte cap`)
        return
      }
      let data: unknown
      try {
        data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8'))
      } catch {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', 'tunnel first frame is not legal JSON')
        return
      }
      if (!isHello(data)) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', 'tunnel first frame is not legal hello')
        return
      }
      const hello = data
      ws.removeListener('message', onFirstFrame)
      void registry.acceptTunnel(hello.nodeId, hello.token, hello.tunnelId).then((accepted) => {
        if (!accepted) {
          // recognize verify/once match/epoch re- inspect any one failed:error frame + close (ok from not out,
          // does not enter data phase; this connect from not create stream, without asset need to reclaim).
          fail(ws, 'permission_denied', 'tunnel reject:tunnelId invalid, node swap proxy or authentication failed')
          return
        }
        // all via: first ok(node side based on this start forwarding byte), again create stream, hand over fine.
        // grantTunnel discover pending already set format failed (timeout/abort just well insert queue) when will
        // destroy hand over come stream - - this where again closure ws fall back, two side all without leaking.
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
        log(`tunnel handover failed:${error instanceof Error ? error.message : String(error)}`)
        fail(ws, 'unknown', 'tunnel handover failed')
      })
    }
    ws.on('message', onFirstFrame)
    ws.once('close', () => {
      clearTimeout(helloTimer)
      ws.removeListener('message', onFirstFrame)
    })
    ws.once('error', (error) => {
      log(`tunnel connect error:${error instanceof Error ? error.message : String(error)}`)
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
