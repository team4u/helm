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
import { createStaticServe } from './static.js'
import { HelmError } from '@helm/protocol'
import { attachNodeWsGateway, type EnvFabric, type NodeWsGateway } from '../env/index.js'
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
  const { kernel, workflows, webDistDir } = options
  const handler = createHubHandler({ kernel, workflows, ...(webDistDir !== undefined ? { webDistDir } : {}) })
  // 显式指定静态目录时启动即验证（fail fast）：失效目录拒启并给出结构化诊断
  //（与 handler 首请求路径同构的 web_dist_invalid），不等到首个请求才暴露
  if (typeof webDistDir === 'string') {
    try {
      await createStaticServe(webDistDir)
    } catch (err) {
      if (err instanceof HelmError) throw err
      throw new HelmError(
        'web_dist_invalid',
        `静态托管目录不可用: ${webDistDir}（${err instanceof Error ? err.message : String(err)}）`,
        500,
        { dir: webDistDir },
      )
    }
  }
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
      } catch (error) {
        // 连接在途断裂/转换失败：尽力给出 500 信封；res 不可写则静默。
        // res 不可写时的静默仅指「无法再向客户端传达」，服务端日志仍如实记录。
        console.error('[hub] node adapter error:', describeError(error))
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

  // 跨平台节点底座存在时挂接 /ws/node 网关（节点 WS+birpc 注册/心跳/事件）。
  const envFabric = (kernel as { envFabric?: EnvFabric }).envFabric
  const nodeGateway: NodeWsGateway | undefined = envFabric
    ? attachNodeWsGateway(server, { registry: envFabric.registry })
    : undefined

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
  const url = `http://${hostname}:${actualPort}`

  // 监听后把真实 URL 回写 runtime（port:0 时工具端点/CLI 指向实际分配地址）。
  // 未提供端口的 kernel 跳过；回调抛错如实上抛（不伤装成功）。
  kernel.setHubUrl?.(url)

  return {
    url,
    get port() {
      return actualPort
    },
    server,
    async close() {
      // 0) 先关 /ws/node 网关（不再接受节点连接；断开挂在适配层之前）。
      await nodeGateway?.close().catch(() => undefined)
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

/** 错误可打印形态：Error 取 name+message+stack，其他取 String()。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}
