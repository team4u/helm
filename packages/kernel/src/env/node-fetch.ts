/**
 * node pass-through tunnel HTTP/HTTPS adapt layer:openTunnel(any TCP Duplex) of on
 * fetch adapt.
 *
 * - http:  tunnel Duplex directly as node:http.request  createConnection;
 * - https: in the same tunnel Duplex on stack node:tls.connect(servername by target
 *   hostname settings, certificate validate follow Node by default CA/verify chain), again TLS stream
 *   hand over to node:http.request- - never bare Duplex stuff to https.request pretend TLS;
 * - do not aggregate request/response body: request body streaming forwarding, response body with
 *   Readable.toWeb(res) hand over also (SSE/streaming response complete pass-through);
 * - tunnel (Duplex) lifetime bind set Response body:EOF/cancel/error/connect close only then
 *   destroy, response head reach never mention before closure tunnel;HEAD/204/304 body is null and immediately release;
 *   body by abandon placement (do not read do not cancel) when by res close/error and GC fall back destroy;
 * - AbortSignal pass broadcast: request phase cancel destroy req and tunnel (duplex destroy drive
 *   Response body end error/cancel);
 * - 4xx/5xx is not transfer failed: original construct Response(contains error body), only create tunnel
 *   failed,socket exception interrupt, timeout only then throw HelmError.
 */

import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import { HelmError } from '@helm/protocol'

/** local (local node)TCP direct connect default pre- compute: and remote registry.openTunnel timeout consistent. */
const LOCAL_TUNNEL_CONNECT_TIMEOUT_MS = 10_000

/**
 * abandon placement body fall back: caller gets Response after since do not read also do not cancel(such as only inspect
 * status health probe) when,pull/cancel forever do not occur, tunnel and caller signal on
 * abort listen will lag (local lag localTunnels,remote lag activeTunnels
 * until dispose). connect close path already by res close/error listen determinism destroy; this
 * register table only override upstream connect forever do not disconnect + body by GCleftover remaining scenario - -best-effort,
 * do not guarantee and when (does not introduce will mistakenly kill SSE slow consume idle timeout;Node internal reference chain if block stop
 * body stream reclaim then still lag until connect final).
 */
const abandonedBodies = new FinalizationRegistry<() => void>((settle) => {
  settle()
})

/**
 * local node tunnel implement:Hub process inside net.connect direct connect (any host:port).
 * abort/timeout/error explicit throw HelmError and guarantee socket release (never half leak leak).
 */
export function connectLocalTunnel(host: string, port: number, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmError('aborted', 'tunnel establish cancelled', 499, { host, port }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      finishErr(new HelmError(
        'node_tunnel_timeout',
        `connect ${host}:${port} timeout (${LOCAL_TUNNEL_CONNECT_TIMEOUT_MS}ms)`,
        504,
        { host, port },
      ))
    }, LOCAL_TUNNEL_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    const finishOk = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(socket)
    }
    const finishErr = (error: HelmError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(error)
    }
    const onAbort = (): void => {
      finishErr(new HelmError('aborted', 'tunnel establish cancelled', 499, { host, port }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (signal?.aborted) {
        finishErr(new HelmError('aborted', 'tunnel establish cancelled', 499, { host, port }))
        return
      }
      finishOk()
    })
    socket.once('error', (error: Error) => {
      finishErr(new HelmError(
        'node_tunnel_connect_failed',
        `connect ${host}:${port} failed:${error.message}`,
        502,
        { host, port },
      ))
    })
  })
}

/**
 * https: in already establish tunnel TCP Duplex on stack TLS grasp manually (servername by target
 * hostname drive SNI and certificate validate), return TLSSocket. never bare Duplex hand over to
 * https.request disguise TLS.
 */
function tlsOverTunnel(tunnel: Duplex, host: string, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmError('aborted', 'TLS grasp manually cancelled', 499, { host }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    // IP reference and certificate identity validate, but cannot put enter only allows DNS name SNI extend.
    const secure = tls.connect({ socket: tunnel, host, ...(net.isIP(host) === 0 ? { servername: host } : {}) })
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: HelmError): void => {
      if (settled) return
      settled = true
      cleanup()
      secure.destroy()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new HelmError('node_tunnel_timeout', `TLS grasp manually timeout (${host})`, 504, { host }))
    }, LOCAL_TUNNEL_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = (): void => {
      fail(new HelmError('aborted', 'TLS grasp manually cancelled', 499, { host }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secure)
    })
    secure.once('error', (error: Error) => {
      fail(new HelmError(
        'node_tunnel_connect_failed',
        `TLS grasp manually failed (${host}):${error.message}`,
        502,
        { host },
      ))
    })
    secure.once('close', () => {
      fail(new HelmError('node_tunnel_closed', `TLS grasp manually during connect close (${host})`, 502, { host }))
    })
    if (signal?.aborted) onAbort()
  })
}

/** tunnelRequestBody:body directly streaming forwarding (do not aggregate);GET/HEAD/null without body. */
function pipeRequestBody(request: Request, req: http.ClientRequest): void {
  if (request.body === null) { req.end(); return }
  const nodeStream = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
  nodeStream.on('error', (error) => {
    req.destroy(error instanceof Error ? error : new Error(String(error)))
  })
  // upstream mention before response or request by cancel when, stop read invoke upload stream.
  req.once('close', () => nodeStream.destroy())
  nodeStream.pipe(req)
}

/** via node pass-through tunnel execute single time HTTP(S) request.openTunnel is any TCP original language, this function
 * only negative duty in its on adapt HTTP(S) semantics; lifecycle:duplex lifetime bind set Response body. */
export async function tunnelFetch(
  openTunnel: (target: { host?: string; port: number }, signal?: AbortSignal) => Promise<Duplex>,
  nodeId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HelmError(
      'node_tunnel_connect_failed',
      `node fetch only support http/https(receives ${url.protocol})`,
      400,
      { nodeId, url: request.url },
    )
  }
  const isHttps = url.protocol === 'https:'
  const defaultPort = isHttps ? 443 : 80
  const port = url.port === '' ? defaultPort : Number(url.port)
  const hostname = url.hostname.replace(/^\[|\]$/g, '') // IPv6 text remove parentheses (net.connect accept without parentheses form)
  const signal = request.signal ?? undefined
  signal?.throwIfAborted()
  let tcp: Duplex | undefined
  try {
    tcp = await openTunnel({ host: hostname, port }, signal)
  } catch (error) {
    if (error instanceof HelmError) throw error
    throw new HelmError(
      'node_tunnel_connect_failed',
      `node ${nodeId} tunnel establish failed:${error instanceof Error ? error.message : String(error)}`,
      502,
      { nodeId, url: request.url },
    )
  }
  let tunnel: Duplex = tcp
  if (isHttps) {
    try {
      tunnel = await tlsOverTunnel(tcp, hostname, signal)
    } catch (error) {
      // tls.connect already destroy secure; underlying tcp must explicit release (guard against half leak leak).
      tcp.destroy()
      if (error instanceof HelmError) throw error
      throw new HelmError(
        'node_tunnel_connect_failed',
        `node ${nodeId} TLS establish failed:${error instanceof Error ? error.message : String(error)}`,
        502,
        { nodeId, url: request.url },
      )
    }
  }

  return await new Promise<Response>((resolve, reject) => {
    const failTunnel = (code: string, message: string, status: number): void => {
      const error = new HelmError(code, message, status, { nodeId, url: request.url })
      tunnel.destroy(error)
      reject(error)
    }
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      // host/connection/content-length by node:http rebuild; the rest single value duplicate.
      if (name === 'host' || name === 'connection' || name === 'content-length') return
      headers[name] = value
    })
    // tunnel is single time short lifecycle connect: explicit want seek response after close (guard against upstream keep-alive
    // let tunnel duplex pending); also disable compress (node:http will not automatically decompress, keep
    // pass-through semantics, plugin gets is exactly original byte).
    headers['connection'] = 'close'
    headers['accept-encoding'] = headers['accept-encoding'] ?? 'identity'
    let responseSettled = false
    const req = http.request(
      {
        // createConnection and default agent combine directly use this stream; cannot use
        // agent:false, it will additionally create Agent and want seek stream implement net.Socket method.
        createConnection: () => tunnel,
        agent: undefined,
        protocol: 'http:',
        host: hostname,
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 502
        const outHeaders = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          for (const v of Array.isArray(value) ? value : [value]) outHeaders.append(name, v)
        }
        // HEAD/204/304 forbidden body(new Response(stream, {status:204}) will throw).
        const nullBody = request.method === 'HEAD' || status === 204 || status === 304
        if (nullBody) {
          res.resume() // discard (by RFC this then do not the has body)
          signal?.removeEventListener('abort', onAbort)
          responseSettled = true
          resolve(new Response(null, { status, headers: outHeaders }))
          // without body can etc.: immediately release tunnel.
          tunnel.destroy()
          return
        }
        // use pull adapt keep Web Stream back press, and tunnel lifetime bind set to body:
        // EOF/cancel/error only then destroy; response head reach never mention before destroy(SSE must
        // complete pass-through).
        const source = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
        const reader = source.getReader()
        // final state independent at bodyStream declaration:FinalizationRegistry  held value
        //(settle closed package) never can reference bodyStream, otherwise register table will target strong hold in
        // manually in,GC forever do not occur, fall back forever does not trigger.
        const state = { ended: false, tunnel, signal, onAbort }
        const settle = (): void => {
          if (state.ended) return
          state.ended = true
          state.signal?.removeEventListener('abort', state.onAbort)
          state.tunnel.destroy()
        }
        const finishBody = (): void => {
          if (state.ended) return
          abandonedBodies.unregister(bodyStream)
          settle()
        }
        const bodyStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) {
                finishBody()
                controller.close()
                return
              }
              if (value !== undefined) controller.enqueue(value)
            } catch (error) {
              finishBody()
              controller.error(error)
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason)
            } finally {
              finishBody()
            }
          },
        })
        abandonedBodies.register(bodyStream, settle, bodyStream)
        // connect close i.e. final:close when tunnel no longer has new data - -complete=true remaining
        // byte already all enter res buffer (destroy does not affect after continue read), transfer interrupt then body
        // again without clean terminal state. not person pull when (such as only inspect status health probe) this is unique
        // determinism destroy point, no longer etc. forever do not occur pull/cancel.error listen also guard against not handle
        // 'error' crash process (toWeb listen when order does not assume).
        res.once('error', finishBody)
        res.once('close', finishBody)
        responseSettled = true
        resolve(new Response(bodyStream, { status, headers: outHeaders }))
      },
    )
    req.once('error', (error) => {
      if (responseSettled) return
      failTunnel(
        'node_tunnel_closed',
        `node ${nodeId} tunnel request failed:${error instanceof Error ? error.message : String(error)}`,
        502,
      )
    })
    const onAbort = (): void => {
      req.destroy()
      // duplex destroy drive Response body end error/cancel.
      tunnel.destroy(new HelmError('aborted', 'node fetch cancelled', 499, { nodeId, url: request.url }))
      reject(new HelmError('aborted', 'node fetch cancelled', 499, { nodeId, url: request.url }))
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.once('close', () => {
      // response body may still in consume; its final by finishBody remove abort listen.
      if (!responseSettled) signal?.removeEventListener('abort', onAbort)
    })
    if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) req.end()
    else pipeRequestBody(request, req)
  })
}
