/**
 * Node http adapt:Web Request/Response and node:http convert + startHub.
 *
 * key semantics:
 * - SSE/persistent connection without buffer pass-through:Response body ReadableStream directly pipe to
 *   node res, do not whole stream buffer.
 * - client disconnect (res close)→ abort for should Fetch Request  signal,
 *   SSE implement based on this cancel subscribe, do not legacy listener/timer.
 * - hub.close(): actively abort all in-flight request signal (contains SSE), destroy all connect
 *   (closeAllConnections/closeIdleConnections), again await server.close();
 *   never dependency after placement kernel.events close,server.close do not pending.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { createHubHandler } from './hub.js'
import { createStaticServe } from './static.js'
import { HelmError } from '@helm/protocol'
import { attachNodeWsGateway, attachNodeTunnelGateway, type EnvFabric, type NodeWsGateway } from '../env/index.js'
import type { HubHandle, KernelRuntimeLike, StartHubOptions } from './contracts.js'

const DEFAULT_PORT = 3202
const DEFAULT_HOSTNAME = '127.0.0.1'

/** Node -> Web Request convert (contains body stream). */
export function toWebRequest(req: http.IncomingMessage, signal?: AbortSignal): Request {
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

/** Web Response -> node res write out (streaming, without whole stream buffer). */
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

export interface NodeHubHandle extends HubHandle {
  /** actual listen port (port 0 when is kernel allocate value). */
  readonly port: number
  readonly server: http.Server
}

export async function startHub(options: StartHubOptions): Promise<NodeHubHandle> {
  const { kernel, webDistDir } = options
  const handler = createHubHandler({ kernel, ...(webDistDir !== undefined ? { webDistDir } : {}) })
  // explicit designate static directory when start i.e. verify (fail fast): expires directory refuse start and to out structure diagnose
  //(and handler first request path same construct web_dist_invalid), do not etc. to first request only then expose
  if (typeof webDistDir === 'string') {
    try {
      await createStaticServe(webDistDir)
    } catch (err) {
      if (err instanceof HelmError) throw err
      throw new HelmError(
        'web_dist_invalid',
        `static hosting directory unavailable: ${webDistDir}(${err instanceof Error ? err.message : String(err)})`,
        500,
        { dir: webDistDir },
      )
    }
  }
  const port = options.port ?? DEFAULT_PORT
  const hostname = options.hostname ?? DEFAULT_HOSTNAME

  // in-flight request register table:close when actively abort(SSE assert subscribe key)
  const inflight = new Set<AbortController>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const controller = new AbortController()
      inflight.add(controller)
      // client disconnect:abort signal(SSE cancel subscribe,body read stop)
      res.on('close', () => controller.abort())
      try {
        const webRequest = await toWebRequest(req, controller.signal)
        const webResponse = await handler(webRequest)
        await writeWebResponse(webResponse, res)
      } catch (error) {
        // connect in-flight break/convert failed: exhaust force to out 500 message seal;res cannot write then static default.
        // res cannot write when static default only refer cannot again to client pass reach, server side log still such as record.
        console.error('[hub] node adapter error:', describeError(error))
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: { code: 'internal_error', message: 'server internal error' } }))
        }
      } finally {
        inflight.delete(controller)
      }
    })()
  })

  // across platform node bottom seat store in when hang connect /ws/node gateway (node WS+birpc register/heartbeat/event).
  const envFabric = (kernel as { envFabric?: EnvFabric }).envFabric
  const nodeGateway: NodeWsGateway | undefined = envFabric
    ? attachNodeWsGateway(server, { registry: envFabric.registry })
    : undefined
  // node pass-through tunnel independent gateway (/ws/node-tunnel; and /ws/node the same upgrade event by path stream).
  const tunnelGateway = envFabric ? attachNodeTunnelGateway(server, { registry: envFabric.registry }) : undefined

  // persistent connection keep-alive:SSE explicit do not timeout
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

  // listen after real URL back write runtime(port:0 when tool end point/CLI points to actual allocate address).
  // not provide port kernel skip; call back throws such as on throw (do not damage install succeeded).
  kernel.setHubUrl?.(url)

  return {
    url,
    get port() {
      return actualPort
    },
    server,
    async close() {
      // 0) first closure tunnel gateway, again closure /ws/node gateway (no longer accept node connect; disconnect hang in adapt layer before).
      await tunnelGateway?.close().catch(() => undefined)
      await nodeGateway?.close().catch(() => undefined)
      // 1) actively abort all in-flight request (SSE stream signal abort → cancel subscribe)
      for (const controller of inflight) controller.abort()
      inflight.clear()
      // 2) force destroy all connect (contains keep-alive idle and SSE leap connect)
      //    Node 18.2+:closeAllConnections;18.2 or fewer retreat closeIdleConnections.
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      // 3) stop accept new connect and wait for server.close return (now without suspended connect, must rapid complete)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  } satisfies NodeHubHandle
}

/** error can print form:Error take name+message+stack, other take String(). */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}
