/**
 * Dedicated gateway for node passthrough tunnels: `/ws/node-tunnel`.
 *
 * Unlike `/ws/node` (birpc control plane), this gateway only performs first-frame JSON auth
 * and then switches to a raw byte-stream tunnel:
 * - The first frame must be a `NodeTunnelHello` (without a `type` field) and `<= 4096` bytes;
 *   invalid JSON, shape mismatch, auth failure, or missing/mismatched pending entry sends a
 *   `NodeTunnelControl` error frame then closes (honest rejection, never silently hangs), and
 *   errors never enter the data phase;
 * - First-frame timeout: closes connections that never send `hello` within the deadline (default 10s,
 *   matching `/ws/node`'s `registerTimeoutMs`) with 4001 to prevent idle connection accumulation;
 * - Success path: **auth + single-use match + epoch recheck must all pass (`acceptTunnel`) before
 *   sending `{ type: 'ok' }` and handing the `createWebSocketStream` Duplex to `grantTunnel`**—the `ok`
 *   frame is never sent prior to authentication; if `grantTunnel` sees pending already failed to settle,
 *   it destroys the incoming stream (no registry leak) and the gateway retains zero leaked resources;
 * - After handoff, all JSON parsing stops: subsequent frames flow strictly over the Duplex byte stream
 *   (data-phase single-frame limit is governed by `wss maxPayload`, far larger than the 4096-byte hello cap).
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws'
import type { NodeTunnelControl, NodeTunnelErrorCode, NodeTunnelHello } from '@helm/protocol'
import type { NodeRegistry } from './registry.js'

export interface NodeTunnelGatewayOptions {
  registry: NodeRegistry
  path?: string
  /** First-frame hello timeout (ms), defaults to 10s (matching `/ws/node` gateway). */
  helloTimeoutMs?: number
  log?: (message: string) => void
}

export interface NodeTunnelGateway {
  close(): Promise<void>
}

const HELLO_MAX_BYTES = 4096

/** Default first-frame hello timeout (matches `ws-gateway` `registerTimeoutMs = 10s`). */
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
  // Data-phase frame cap is 1 MiB (daemon stream writer HWM stays aligned with frames);
  // first-frame hello is independently capped at <= 4096 bytes.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let closing: Promise<void> | undefined

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) return
    if (closing) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws))
  }
  // Share the same server `upgrade` event stream (demuxed by pathname with `/ws/node` gateway).
  server.on('upgrade', onUpgrade)

  function fail(ws: WebSocket, code: NodeTunnelErrorCode, message: string): void {
    const frame: NodeTunnelControl = { type: 'error', code, message }
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // Send failure is cleaned up on close.
    }
    ws.close(4004, 'tunnel rejected')
  }

  function handleConnection(ws: WebSocket): void {
    // First-frame timeout: close connections that never send hello (no silent hang, no unbounded accumulation).
    const helloTimer = setTimeout(() => ws.close(4001, 'tunnel hello timeout'), helloTimeoutMs)
    const onFirstFrame = (raw: unknown): void => {
      clearTimeout(helloTimer)
      const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw as Buffer).length
      if (bytes > HELLO_MAX_BYTES) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', `tunnel first frame exceeds ${HELLO_MAX_BYTES}-byte limit`)
        return
      }
      let data: unknown
      try {
        data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8'))
      } catch {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', 'tunnel first frame is not valid JSON')
        return
      }
      if (!isHello(data)) {
        ws.removeListener('message', onFirstFrame)
        fail(ws, 'invalid', 'tunnel first frame is not a valid hello')
        return
      }
      const hello = data
      ws.removeListener('message', onFirstFrame)
      void registry.acceptTunnel(hello.nodeId, hello.token, hello.tunnelId).then((accepted) => {
        if (!accepted) {
          // Auth / single-use match / epoch recheck failed: error frame + close (never emits ok,
          // never enters data phase; no stream created so nothing to reclaim).
          fail(ws, 'permission_denied', 'tunnel rejected: invalid tunnelId, superseded node, or auth failure')
          return
        }
        // Passed: send ok first (signals node to begin forwarding bytes), then create stream and hand off.
        // If grantTunnel finds pending already failed (race with timeout/abort), it destroys the incoming stream;
        // ws close/error fallback here ensures zero leaks on both ends.
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
        log(`tunnel handoff failed: ${error instanceof Error ? error.message : String(error)}`)
        fail(ws, 'unknown', 'tunnel handoff failed')
      })
    }
    ws.on('message', onFirstFrame)
    ws.once('close', () => {
      clearTimeout(helloTimer)
      ws.removeListener('message', onFirstFrame)
    })
    ws.once('error', (error) => {
      log(`tunnel connection error: ${error instanceof Error ? error.message : String(error)}`)
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
