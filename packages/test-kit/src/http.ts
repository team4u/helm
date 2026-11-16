/**
 * HTTP Mock Hub 测试辅助（`@helm/test-kit/http`）。
 * 启动绑定 `127.0.0.1` 临时端口的真实 HTTP server，记录请求命中历史并支持结构化响应、
 * Web `Response` 透传、流式端点与自动生命周期清理。
 */

import http from 'node:http'
import type { MaybePromise } from '@helm/protocol/browser'
import type { CleanupRegistrar } from './node.js'

/** 模拟 Hub 记录的单次请求命中快照。 */
export interface MockHttpHit {
  method: string
  path: string
  body?: unknown
  rawBody?: Buffer
  authorization?: string
  headers: http.IncomingHttpHeaders
}

/** 模拟路由返回的结构化响应描述。 */
export interface MockRouteResult {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** 路由处理函数；可返回结构化结果、Web `Response`，或手工写 `res` 后返回 `null` / `void`。 */
export type MockRouteHandler = (
  body: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => MaybePromise<MockRouteResult | Response | null | void>

/** `startMockHub` 配置项。 */
export interface StartMockHubOptions {
  /** `GET /api/actions` 默认返回的动作清单（当 `routes` 未显式覆盖该路由时生效）。 */
  defaultActions?: readonly unknown[]
  /** 传入 `TestContext` 等注册器后，测试结束时自动关闭 server。 */
  autoRegisterCleanup?: CleanupRegistrar
}

/** 模拟 Hub 运行句柄。 */
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
 * 启动模拟 Hub HTTP server，按 `"METHOD /path?query"` 路由请求并记录全部命中。
 * 除非 `routes` 显式覆盖，否则自动 stub `GET /api/actions`。
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
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${key}` } }))
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
    throw new Error('MockHub 未能绑定有效的本机端口')
  }

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (!closing) {
      closing = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // 主动释放 keep-alive 空闲连接（如 undici fetch 连接池），避免 close 拖延或挂起。
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
