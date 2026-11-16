/**
 * HTTP Mock Hub test helper (`@helm/test-kit/http`).
 * Starts a real HTTP server bound to an ephemeral `127.0.0.1` port, records request hit history,
 * and supports structured responses, Web `Response` passthrough, streaming endpoints, and
 * automatic lifecycle cleanup.
 */

import http from 'node:http'
import type { MaybePromise } from '@helm/protocol/browser'
import type { CleanupRegistrar } from './node.js'

/** Snapshot of a single recorded request hit on the mock Hub. */
export interface MockHttpHit {
  method: string
  path: string
  body?: unknown
  rawBody?: Buffer
  authorization?: string
  headers: http.IncomingHttpHeaders
}

/** Structured response description returned by a mock route. */
export interface MockRouteResult {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** Route handler; may return a structured result or a Web `Response`, or write `res` manually and return `null` / `void`. */
export type MockRouteHandler = (
  body: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => MaybePromise<MockRouteResult | Response | null | void>

/** `startMockHub` options. */
export interface StartMockHubOptions {
  /** Action list returned by default from `GET /api/actions` (effective when `routes` does not explicitly override that route). */
  defaultActions?: readonly unknown[]
  /** Pass a registrar such as `TestContext` to close the server automatically when the test ends. */
  autoRegisterCleanup?: CleanupRegistrar
}

/** Running mock Hub handle. */
export interface MockHubHandle {
  url: string
  hits: MockHttpHit[]
  recorded: { hits: MockHttpHit[] }
  close: () => Promise<void>
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseBody(rawBuf: Buffer): unknown {
  if (rawBuf.length === 0) return undefined
  const text = rawBuf.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function writeWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const outHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    outHeaders[key] = value
  })
  res.writeHead(response.status, outHeaders)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

function writeRouteResult(res: http.ServerResponse, result: MockRouteResult | null | void): void {
  if (result === null || result === undefined) {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(204)
      res.end()
    }
    return
  }
  const status = result.status ?? 200
  const headers: Record<string, string> = { ...(result.headers ?? {}) }
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  if (result.body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  if (typeof result.body === 'string') {
    if (!hasContentType) headers['content-type'] = 'text/plain; charset=utf-8'
    res.writeHead(status, headers)
    res.end(result.body)
    return
  }
  if (Buffer.isBuffer(result.body) || result.body instanceof Uint8Array) {
    if (!hasContentType) headers['content-type'] = 'application/octet-stream'
    res.writeHead(status, headers)
    res.end(result.body)
    return
  }
  if (!hasContentType) headers['content-type'] = 'application/json'
  res.writeHead(status, headers)
  res.end(JSON.stringify(result.body))
}

/**
 * Start a mock Hub HTTP server that routes requests by `"METHOD /path?query"` and records every hit.
 * Automatically stubs `GET /api/actions` unless `routes` explicitly overrides it.
 */
export async function startMockHub(
  routes: Record<string, MockRouteHandler>,
  options: StartMockHubOptions = {},
): Promise<MockHubHandle> {
  const allRoutes: Record<string, MockRouteHandler> = {
    'GET /api/actions': () => ({ body: [...(options.defaultActions ?? [])] }),
    ...routes,
  }
  const hits: MockHttpHit[] = []

  const server = http.createServer((req, res) => {
    void (async () => {
      const rawBuf = await readRequestBody(req)
      const body = parseBody(rawBuf)
      const method = req.method ?? 'GET'
      const path = req.url ?? '/'
      const authorization =
        typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
      hits.push({
        method,
        path,
        body,
        ...(rawBuf.length > 0 ? { rawBody: rawBuf } : {}),
        authorization,
        headers: { ...req.headers },
      })

      const key = `${method} ${path}`
      const handler = allRoutes[key]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `no route for ${key}` } }))
        return
      }

      const result = await handler(body, req, res)
      if (result instanceof Response) {
        await writeWebResponse(res, result)
        return
      }
      writeRouteResult(res, result)
    })().catch((error: unknown) => {
      if (!res.headersSent && !res.writableEnded) {
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'mock_hub_error', message } }))
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('MockHub failed to bind a valid local port')
  }

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (!closing) {
      closing = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // Proactively release keep-alive idle connections (e.g. undici fetch pools) so close() does not drag or hang.
        server.closeIdleConnections?.()
      })
    }
    return closing
  }

  if (options.autoRegisterCleanup) {
    options.autoRegisterCleanup.after(close)
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    recorded: { hits },
    close,
  }
}
