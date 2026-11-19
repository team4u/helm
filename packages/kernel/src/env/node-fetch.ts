/**
 * Node passthrough tunnel HTTP/HTTPS adapter: adapts `fetch` over `openTunnel` (arbitrary TCP Duplex).
 *
 * - http: passes the tunnel Duplex directly as `createConnection` to `node:http.request`;
 * - https: stacks `node:tls.connect` onto the tunnel Duplex (`servername` set from target hostname,
 *   certificate validation uses Node's default CA/verify chain), then hands the TLS stream to `node:http.request`
 *   (never pass a bare Duplex directly to `https.request` pretending to be TLS);
 * - Never buffers request/response bodies: request body is piped as a stream and response body is returned
 *   via `Readable.toWeb(res)` (SSE/streaming responses pass through verbatim);
 * - Tunnel (Duplex) lifetime is tied to the Response body: destroyed only on EOF/cancel/error/connection close,
 *   never prematurely when response headers arrive; HEAD/204/304 have null bodies and release immediately;
 *   abandoned bodies (neither read nor cancelled) are cleaned up via `res` close/error and GC fallback;
 * - AbortSignal propagation: cancelling during request destroys `req` and the tunnel (driving Response body
 *   termination via error/cancel);
 * - 4xx/5xx are not transport failures: return the Response as-is; only tunnel establishment failures,
 *   socket drops, and timeouts throw HelmxError.
 */

import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import { HelmxError } from '@helmx/protocol'

/** Default local TCP connect timeout: matches remote `registry.openTunnel` timeout. */
const LOCAL_TUNNEL_CONNECT_TIMEOUT_MS = 10_000

/**
 * Fallback cleanup for abandoned bodies: when callers receive a Response and neither read nor cancel it
 * (e.g. status-only health checks), pull/cancel never runs, keeping the tunnel and caller abort listener
 * pinned (locally in `localTunnels`, remotely in `activeTunnels` until dispose). Connection-close paths are
 * already deterministically destroyed by `res` close/error listeners; this registry only covers the corner
 * case where an upstream server never disconnects and the body is GC'd—best-effort with no timing guarantee
 * (avoids introducing idle timeouts that would kill slow SSE consumers; if Node internal references pin the
 * stream, cleanup still waits until connection close).
 */
const abandonedBodies = new FinalizationRegistry<() => void>((settle) => {
  settle()
})

/**
 * Local node tunnel implementation: connects directly via `net.connect` inside the Hub process (arbitrary host:port).
 * Throws HelmxError explicitly on abort/timeout/error and guarantees socket release (never leaks half-open sockets).
 */
export function connectLocalTunnel(host: string, port: number, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmxError('aborted', 'tunnel establishment cancelled', 499, { host, port }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      finishErr(new HelmxError(
        'node_tunnel_timeout',
        `connect ${host}:${port} timed out (${LOCAL_TUNNEL_CONNECT_TIMEOUT_MS}ms)`,
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
    const finishErr = (error: HelmxError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(error)
    }
    const onAbort = (): void => {
      finishErr(new HelmxError('aborted', 'tunnel establishment cancelled', 499, { host, port }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (signal?.aborted) {
        finishErr(new HelmxError('aborted', 'tunnel establishment cancelled', 499, { host, port }))
        return
      }
      finishOk()
    })
    socket.once('error', (error: Error) => {
      finishErr(new HelmxError(
        'node_tunnel_connect_failed',
        `connect ${host}:${port} failed: ${error.message}`,
        502,
        { host, port },
      ))
    })
  })
}

/**
 * HTTPS: stack a TLS handshake on top of an established tunnel TCP Duplex (`servername` from target hostname
 * drives SNI and certificate verification), returning the `TLSSocket`. Never pass a bare Duplex to `https.request`.
 */
function tlsOverTunnel(tunnel: Duplex, host: string, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmxError('aborted', 'TLS handshake cancelled', 499, { host }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    // IP literals participate in certificate SAN checks, but SNI extension only accepts DNS hostnames.
    const secure = tls.connect({ socket: tunnel, host, ...(net.isIP(host) === 0 ? { servername: host } : {}) })
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: HelmxError): void => {
      if (settled) return
      settled = true
      cleanup()
      secure.destroy()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new HelmxError('node_tunnel_timeout', `TLS handshake timed out (${host})`, 504, { host }))
    }, LOCAL_TUNNEL_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = (): void => {
      fail(new HelmxError('aborted', 'TLS handshake cancelled', 499, { host }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secure)
    })
    secure.once('error', (error: Error) => {
      fail(new HelmxError(
        'node_tunnel_connect_failed',
        `TLS handshake failed (${host}): ${error.message}`,
        502,
        { host },
      ))
    })
    secure.once('close', () => {
      fail(new HelmxError('node_tunnel_closed', `connection closed during TLS handshake (${host})`, 502, { host }))
    })
    if (signal?.aborted) onAbort()
  })
}

/** Stream request body directly without buffering; GET/HEAD/null have no body. */
function pipeRequestBody(request: Request, req: http.ClientRequest): void {
  if (request.body === null) { req.end(); return }
  const nodeStream = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
  nodeStream.on('error', (error) => {
    req.destroy(error instanceof Error ? error : new Error(String(error)))
  })
  // Stop reading upload stream if upstream responds early or request is cancelled.
  req.once('close', () => nodeStream.destroy())
  nodeStream.pipe(req)
}

/**
 * Execute a single HTTP(S) request over a node passthrough tunnel. `openTunnel` is an arbitrary TCP
 * primitive; this function only layers HTTP(S) semantics on top, binding duplex lifetime to the Response body.
 */
export async function tunnelFetch(
  openTunnel: (target: { host?: string; port: number }, signal?: AbortSignal) => Promise<Duplex>,
  nodeId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HelmxError(
      'node_tunnel_connect_failed',
      `node fetch only supports http/https (got ${url.protocol})`,
      400,
      { nodeId, url: request.url },
    )
  }
  const isHttps = url.protocol === 'https:'
  const defaultPort = isHttps ? 443 : 80
  const port = url.port === '' ? defaultPort : Number(url.port)
  const hostname = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets (`net.connect` expects unbracketed IPv6)
  const signal = request.signal ?? undefined
  signal?.throwIfAborted()
  let tcp: Duplex | undefined
  try {
    tcp = await openTunnel({ host: hostname, port }, signal)
  } catch (error) {
    if (error instanceof HelmxError) throw error
    throw new HelmxError(
      'node_tunnel_connect_failed',
      `node ${nodeId} tunnel establishment failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      { nodeId, url: request.url },
    )
  }
  let tunnel: Duplex = tcp
  if (isHttps) {
    try {
      tunnel = await tlsOverTunnel(tcp, hostname, signal)
    } catch (error) {
      // `tls.connect` destroys `secure` on failure, so explicitly destroy underlying `tcp` to prevent socket leaks.
      tcp.destroy()
      if (error instanceof HelmxError) throw error
      throw new HelmxError(
        'node_tunnel_connect_failed',
        `node ${nodeId} TLS establishment failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
        { nodeId, url: request.url },
      )
    }
  }

  return await new Promise<Response>((resolve, reject) => {
    const failTunnel = (code: string, message: string, status: number): void => {
      const error = new HelmxError(code, message, status, { nodeId, url: request.url })
      tunnel.destroy(error)
      reject(error)
    }
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      // host/connection/content-length are reconstructed by node:http; copy all other headers verbatim.
      if (name === 'host' || name === 'connection' || name === 'content-length') return
      headers[name] = value
    })
    // Tunnels are single-use short-lived connections: explicitly request close after response (prevents
    // upstream keep-alive from hanging the duplex), and avoid automatic compression (node:http does not
    // auto-decompress, preserving passthrough semantics so plugins receive exact upstream bytes).
    headers['connection'] = 'close'
    headers['accept-encoding'] = headers['accept-encoding'] ?? 'identity'
    let responseSettled = false
    const req = http.request(
      {
        // Combine createConnection with the default agent to use this stream directly; avoid `agent: false`,
        // which allocates a new Agent and expects extra `net.Socket` methods on the stream.
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
        // HEAD/204/304 forbid a response body (`new Response(stream, { status: 204 })` throws).
        const nullBody = request.method === 'HEAD' || status === 204 || status === 304
        if (nullBody) {
          res.resume() // drain (no body per RFC)
          signal?.removeEventListener('abort', onAbort)
          responseSettled = true
          resolve(new Response(null, { status, headers: outHeaders }))
          // No body to wait on: release the tunnel immediately.
          tunnel.destroy()
          return
        }
        // Adapt via pull to preserve Web Stream backpressure and tie tunnel lifetime to the body:
        // destroy only on EOF/cancel/error, never early when headers arrive (SSE must pass through intact).
        const source = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
        const reader = source.getReader()
        // Finalization state must remain independent of `bodyStream`: the FinalizationRegistry held value
        // (`settle` closure) must never reference `bodyStream`, otherwise the registry keeps the target strongly
        // reachable, preventing GC and ensuring the fallback never fires.
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
        // Connection close is terminal: once closed, no more data arrives on the tunnel—if `complete=true`,
        // remaining bytes are already buffered in `res` (destroying does not hurt reading); if truncated, the
        // body has no clean completion left. When callers don't pull (e.g. status-only health checks), this is
        // the sole deterministic cleanup point instead of waiting for pull/cancel. Listening for `error` also
        // prevents unhandled `'error'` crashes (never assume listener order inside `toWeb`).
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
        `node ${nodeId} tunnel request failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      )
    })
    const onAbort = (): void => {
      req.destroy()
      // Destroying duplex drives Response body error/cancel.
      tunnel.destroy(new HelmxError('aborted', 'node fetch cancelled', 499, { nodeId, url: request.url }))
      reject(new HelmxError('aborted', 'node fetch cancelled', 499, { nodeId, url: request.url }))
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.once('close', () => {
      // Response body may still be consuming; `finishBody` removes the abort listener in that case.
      if (!responseSettled) signal?.removeEventListener('abort', onAbort)
    })
    if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) req.end()
    else pipeRequestBody(request, req)
  })
}
