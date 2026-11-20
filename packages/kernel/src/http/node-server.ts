/**
 * Node http adapter: Web Request/Response <-> node:http conversion + `startHub`.
 *
 * Key semantics:
 * - Unbuffered SSE / long-lived streams: Response body ReadableStream pipes directly to
 *   node `res` without buffering the whole stream.
 * - Client disconnect (`res` close) aborts the corresponding Fetch Request `signal`;
 *   SSE implementations rely on this to cancel subscriptions with zero leaked listeners or timers.
 * - `hub.close()`: actively aborts all in-flight request signals (including SSE), destroys all
 *   connections (`closeAllConnections`/`closeIdleConnections`), then awaits `server.close()`;
 *   never depends on downstream `kernel.events.close()` so `server.close` never hangs.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { createHubHandler } from './hub.js'
import { createStaticServe } from './static.js'
import { HelmxError } from '@helmx/protocol'
import { attachNodeWsGateway, attachNodeTunnelGateway, type EnvFabric, type NodeWsGateway } from '../env/index.js'
import type { HubHandle, KernelRuntimeLike, StartHubOptions } from './contracts.js'

const DEFAULT_PORT = 3202
const DEFAULT_HOSTNAME = '127.0.0.1'

/** Node -> Web Request conversion (including body stream). */
function toWebRequest(req: http.IncomingMessage, signal?: AbortSignal): Request {
  const host = req.headers.host ?? 'localhost'
  const url = `http://${host}${req.url ?? '/'}`
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v)
    } else {
      headers.set(name, value)
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody
    ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>)
    : undefined
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body, duplex: 'half' as const } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })
}

/** Web Response -> node res writer (streaming, without whole-stream buffering). */
export async function writeWebResponse(webResponse: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  webResponse.headers.forEach((value, name) => {
    if (name === 'set-cookie') {
      headers[name] = [...(headers[name] as string[] ?? []), value]
    } else {
      headers[name] = value
    }
  })
  res.writeHead(webResponse.status, webResponse.statusText || undefined, headers)
  if (webResponse.body === null) {
    res.end()
    return
  }
  const nodeStream = Readable.fromWeb(webResponse.body as Parameters<typeof Readable.fromWeb>[0])
  await new Promise<void>((resolve, reject) => {
    nodeStream.on('error', reject)
    res.on('close', () => {
      nodeStream.destroy()
      resolve()
    })
    nodeStream.pipe(res)
    nodeStream.on('end', () => resolve())
  })
}

interface NodeHubHandle extends HubHandle {
  /** Actual listening port (kernel-assigned port when `port: 0`). */
  readonly port: number
  readonly server: http.Server
}

export async function startHub(options: StartHubOptions): Promise<NodeHubHandle> {
  const { kernel, webDistDir } = options
  const handler = createHubHandler({
    kernel,
    ...(webDistDir !== undefined ? { webDistDir } : {}),
    ...(options.productRoutes !== undefined ? { productRoutes: options.productRoutes } : {}),
  })
  // Validate explicit static directory eagerly at startup (fail fast): invalid dir refuses to start
  // with a structured diagnostic (matching `web_dist_invalid` on first-request path) rather than deferring failure.
  if (typeof webDistDir === 'string') {
    try {
      await createStaticServe(webDistDir)
    } catch (err) {
      if (err instanceof HelmxError) throw err
      throw new HelmxError(
        'web_dist_invalid',
        `static hosting directory unavailable: ${webDistDir} (${err instanceof Error ? err.message : String(err)})`,
        500,
        { dir: webDistDir },
      )
    }
  }
  const port = options.port ?? DEFAULT_PORT
  const hostname = options.hostname ?? DEFAULT_HOSTNAME

  // In-flight request registry: actively aborted on `close()` (critical for tearing down SSE subscriptions)
  const inflight = new Set<AbortController>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const controller = new AbortController()
      inflight.add(controller)
      // Client disconnect: abort signal (cancels SSE subscriptions and body reads)
      res.on('close', () => controller.abort())
      try {
        const webRequest = await toWebRequest(req, controller.signal)
        const webResponse = await handler(webRequest)
        await writeWebResponse(webResponse, res)
      } catch (error) {
        // Mid-connection failure or conversion error: best-effort 500 envelope; ignore writes if `res` is no longer writable,
        // though still log server-side diagnostics.
        console.error('[hub] node adapter error:', describeError(error))
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: { code: 'internal_error', message: 'internal server error' } }))
        }
      } finally {
        inflight.delete(controller)
      }
    })()
  })

  // Attach `/ws/node` gateway when cross-platform node fabric is available (node WS + birpc registration/heartbeat/events).
  const envFabric = (kernel as { envFabric?: EnvFabric }).envFabric
  const nodeGateway: NodeWsGateway | undefined = envFabric
    ? attachNodeWsGateway(server, { registry: envFabric.registry })
    : undefined
  // Separate gateway for node passthrough tunnels (`/ws/node-tunnel`, sharing the upgrade event by path routing with `/ws/node`).
  const tunnelGateway = envFabric ? attachNodeTunnelGateway(server, { registry: envFabric.registry }) : undefined

  // Long-lived connection keep-alive: disable requestTimeout explicitly for SSE
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const actualPort = address.port
  const url = `http://${hostname}:${actualPort}`

  // Write the actual listening URL back to runtime (so `port: 0` tool endpoints / CLI point to the real port).
  // Skipped if runtime omits the port; rethrow callback failures rather than swallowing them.
  kernel.setHubUrl?.(url)

  return {
    url,
    get port() {
      return actualPort
    },
    server,
    async close() {
      // 0) Close tunnel gateway first, then `/ws/node` gateway (stop accepting new node connections before tearing down adapter).
      await tunnelGateway?.close().catch(() => undefined)
      await nodeGateway?.close().catch(() => undefined)
      // 1) Actively abort all in-flight requests (aborts SSE stream signals -> cancels subscriptions)
      for (const controller of inflight) controller.abort()
      inflight.clear()
      // 2) Force-close all sockets (including keep-alive idle and open SSE connections)
      //    Node 18.2+: closeAllConnections; fall back to closeIdleConnections on older runtimes.
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      // 3) Stop accepting new connections and await server.close (with no lingering sockets, completes immediately)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  } satisfies NodeHubHandle
}

/** Printable error summary: name + message + stack for Error instances, String() otherwise. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}
