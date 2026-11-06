/**
 * Node http 适配：Web Request/Response 与 node:http 的转换 + startHub。
 *
 * 关键语义：
 * - SSE/长连接无缓冲透传：Response body ReadableStream 直接 pipe 到
 *   node res，不整流缓冲。
 * - 客户端断开（res close）→ abort 对应 Fetch Request 的 signal，
 *   SSE 实现据此取消订阅，不遗留 listener/timer。
 * - hub.close()：主动 abort 全部在途请求信号（含 SSE），销毁全部连接
 *   （closeAllConnections/closeIdleConnections），再 await server.close()；
 *   绝不依赖后置的 kernel.events 关闭，server.close 不悬挂。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { createHubHandler } from './hub.js'
import type { HubHandle, KernelRuntimeLike, StartHubOptions, WorkflowServiceLike } from './contracts.js'

const DEFAULT_PORT = 3202
const DEFAULT_HOSTNAME = '127.0.0.1'

/** Node -> Web Request 转换（含 body 流）。 */
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

/** Web Response -> node res 写出（流式，无整流缓冲）。 */
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
  /** 实际监听端口（port 0 时为内核分配值）。 */
  readonly port: number
  readonly server: http.Server
}

export async function startHub(options: StartHubOptions): Promise<NodeHubHandle> {
  const { kernel, workflows } = options
  const handler = createHubHandler(kernel, workflows)
  const port = options.port ?? DEFAULT_PORT
  const hostname = options.hostname ?? DEFAULT_HOSTNAME

  // 在途请求注册表：close 时主动 abort（SSE 断订阅的关键）
  const inflight = new Set<AbortController>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const controller = new AbortController()
      inflight.add(controller)
      // 客户端断开：abort signal（SSE 取消订阅、body 读取停止）
      res.on('close', () => controller.abort())
      try {
        const webRequest = await toWebRequest(req, controller.signal)
        const webResponse = await handler(webRequest)
        await writeWebResponse(webResponse, res)
      } catch {
        // 连接在途断裂/转换失败：尽力给出 500 信封；res 不可写则静默。
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: { code: 'internal_error', message: '服务器内部错误' } }))
        }
      } finally {
        inflight.delete(controller)
      }
    })()
  })

  // 长连接保活：SSE 显式不超时
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

  return {
    url: `http://${hostname}:${actualPort}`,
    get port() {
      return actualPort
    },
    server,
    async close() {
      // 1) 主动 abort 全部在途请求（SSE 流的 signal abort → 取消订阅）
      for (const controller of inflight) controller.abort()
      inflight.clear()
      // 2) 强制销毁全部连接（含 keep-alive 空闲与 SSE 活跃连接）
      //    Node 18.2+：closeAllConnections；18.2 以下退化 closeIdleConnections。
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      // 3) 停止接受新连接并等待 server.close 返回（此时无挂起连接，必迅速完成）
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  } satisfies NodeHubHandle
}
