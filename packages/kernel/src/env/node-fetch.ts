/**
 * 节点透传隧道的 HTTP/HTTPS 适配层：openTunnel（任意 TCP Duplex）之上的
 * fetch 适配器。
 *
 * - http:  隧道 Duplex 直接作为 node:http.request 的 createConnection；
 * - https: 在同一隧道 Duplex 上叠 node:tls.connect（servername 按目标
 *   hostname 设置，证书校验遵循 Node 默认 CA/verify 链），再把 TLS 流
 *   交给 node:http.request——绝不把裸 Duplex 塞给 https.request 假装 TLS；
 * - 不聚合 request/response body：请求体流式转发，响应体以
 *   Readable.toWeb(res) 交还（SSE/流式响应完整透传）；
 * - 隧道（Duplex）寿命绑定 Response body：EOF/cancel/error/连接关闭 才
 *   销毁，响应头到达绝不提前关隧道；HEAD/204/304 body 为 null 并立即释放；
 *   body 被弃置（不读不取消）时由 res close/error 与 GC 兜底销毁；
 * - AbortSignal 传播：请求期取消销毁 req 与隧道（duplex 的销毁驱动
 *   Response body 端 error/cancel）；
 * - 4xx/5xx 不是传输失败：原样构造 Response（含错误体），只有建隧道
 *   失败、socket 异常中断、超时才抛 HelmError。
 */

import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import { HelmError } from '@helm/protocol'

/** 本地（local 节点）TCP 直连缺省预算：与远端 registry.openTunnel 超时一致。 */
const LOCAL_TUNNEL_CONNECT_TIMEOUT_MS = 10_000

/**
 * 弃置 body 兜底：调用方拿到 Response 后既不读也不 cancel（如只查
 * status 的健康探测）时，pull/cancel 永不发生，隧道与调用方 signal 上的
 * abort 监听会滞留（local 滞留 localTunnels、remote 滞留 activeTunnels
 * 直到 dispose）。连接关闭路径已由 res close/error 监听确定性销毁；本
 * 注册表只覆盖「上游连接永不断开 + body 被 GC」的残余场景——best-effort，
 * 不保证及时（不引入会误杀 SSE 慢消费的空闲超时；Node 内部引用链若阻止
 * body 流回收则仍滞留至连接终结）。
 */
const abandonedBodies = new FinalizationRegistry<() => void>((settle) => {
  settle()
})

/**
 * local 节点的隧道实现：Hub 进程内 net.connect 直连（任意 host:port）。
 * abort/超时/错误显式抛 HelmError 并保证 socket 释放（绝不半泄漏）。
 */
export function connectLocalTunnel(host: string, port: number, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmError('aborted', '隧道建立已取消', 499, { host, port }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      finishErr(new HelmError(
        'node_tunnel_timeout',
        `连接 ${host}:${port} 超时（${LOCAL_TUNNEL_CONNECT_TIMEOUT_MS}ms）`,
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
      finishErr(new HelmError('aborted', '隧道建立已取消', 499, { host, port }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (signal?.aborted) {
        finishErr(new HelmError('aborted', '隧道建立已取消', 499, { host, port }))
        return
      }
      finishOk()
    })
    socket.once('error', (error: Error) => {
      finishErr(new HelmError(
        'node_tunnel_connect_failed',
        `连接 ${host}:${port} 失败：${error.message}`,
        502,
        { host, port },
      ))
    })
  })
}

/**
 * https：在已建立的隧道 TCP Duplex 上叠 TLS 握手（servername 按目标
 * hostname 驱动 SNI 与证书校验），返回 TLSSocket。绝不把裸 Duplex 交给
 * https.request 伪装 TLS。
 */
function tlsOverTunnel(tunnel: Duplex, host: string, signal?: AbortSignal): Promise<Duplex> {
  if (signal?.aborted) {
    return Promise.reject(new HelmError('aborted', 'TLS 握手已取消', 499, { host }))
  }
  return new Promise<Duplex>((resolve, reject) => {
    // IP 参与证书身份校验，但不能放进仅允许 DNS 名称的 SNI 扩展。
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
      fail(new HelmError('node_tunnel_timeout', `TLS 握手超时（${host}）`, 504, { host }))
    }, LOCAL_TUNNEL_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = (): void => {
      fail(new HelmError('aborted', 'TLS 握手已取消', 499, { host }))
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
        `TLS 握手失败（${host}）：${error.message}`,
        502,
        { host },
      ))
    })
    secure.once('close', () => {
      fail(new HelmError('node_tunnel_closed', `TLS 握手期间连接关闭（${host}）`, 502, { host }))
    })
    if (signal?.aborted) onAbort()
  })
}

/** tunnelRequestBody：body 直接流式转发（不聚合）；GET/HEAD/null 无 body。 */
function pipeRequestBody(request: Request, req: http.ClientRequest): void {
  if (request.body === null) { req.end(); return }
  const nodeStream = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
  nodeStream.on('error', (error) => {
    req.destroy(error instanceof Error ? error : new Error(String(error)))
  })
  // 上游提前响应或请求被取消时，停止读取调用者的上传流。
  req.once('close', () => nodeStream.destroy())
  nodeStream.pipe(req)
}

/** 经节点透传隧道执行单次 HTTP(S) 请求。openTunnel 是任意 TCP 原语，本函数
 * 只负责在其上适配 HTTP(S) 语义；生命周期：duplex 寿命绑定 Response body。 */
export async function tunnelFetch(
  openTunnel: (target: { host?: string; port: number }, signal?: AbortSignal) => Promise<Duplex>,
  nodeId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HelmError(
      'node_tunnel_connect_failed',
      `节点 fetch 仅支持 http/https（收到 ${url.protocol}）`,
      400,
      { nodeId, url: request.url },
    )
  }
  const isHttps = url.protocol === 'https:'
  const defaultPort = isHttps ? 443 : 80
  const port = url.port === '' ? defaultPort : Number(url.port)
  const hostname = url.hostname.replace(/^\[|\]$/g, '') // IPv6 文本去括号（net.connect 接受无括号形式）
  const signal = request.signal ?? undefined
  signal?.throwIfAborted()
  let tcp: Duplex | undefined
  try {
    tcp = await openTunnel({ host: hostname, port }, signal)
  } catch (error) {
    if (error instanceof HelmError) throw error
    throw new HelmError(
      'node_tunnel_connect_failed',
      `节点 ${nodeId} 隧道建立失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      { nodeId, url: request.url },
    )
  }
  let tunnel: Duplex = tcp
  if (isHttps) {
    try {
      tunnel = await tlsOverTunnel(tcp, hostname, signal)
    } catch (error) {
      // tls.connect 已销毁 secure；底层 tcp 需显式释放（防半泄漏）。
      tcp.destroy()
      if (error instanceof HelmError) throw error
      throw new HelmError(
        'node_tunnel_connect_failed',
        `节点 ${nodeId} TLS 建立失败：${error instanceof Error ? error.message : String(error)}`,
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
      // host/connection/content-length 由 node:http 重建；其余单值复制。
      if (name === 'host' || name === 'connection' || name === 'content-length') return
      headers[name] = value
    })
    // 隧道是单次短生命周期连接：显式要求响应后关闭（防上游 keep-alive
    // 让隧道 duplex 悬挂）；同时禁用压缩（node:http 不会自动解压，保留
    // 透传语义，插件拿到的就是原始字节）。
    headers['connection'] = 'close'
    headers['accept-encoding'] = headers['accept-encoding'] ?? 'identity'
    let responseSettled = false
    const req = http.request(
      {
        // createConnection 与缺省 agent 组合直接使用此流；不能使用
        // agent:false，它会另外创建 Agent 并要求流实现 net.Socket 方法。
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
        // HEAD/204/304 禁止 body（new Response(stream, {status:204}) 会 throw）。
        const nullBody = request.method === 'HEAD' || status === 204 || status === 304
        if (nullBody) {
          res.resume() // 丢弃（按 RFC 本就不该有 body）
          signal?.removeEventListener('abort', onAbort)
          responseSettled = true
          resolve(new Response(null, { status, headers: outHeaders }))
          // 无 body 可等：立即释放隧道。
          tunnel.destroy()
          return
        }
        // 用 pull 适配保留 Web Stream 背压，并把隧道寿命绑定到 body：
        // EOF/cancel/error 才销毁；响应头到达绝不提前 destroy（SSE 必须
        // 完整透传）。
        const source = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
        const reader = source.getReader()
        // 终结状态独立于 bodyStream 声明：FinalizationRegistry 的 held 值
        //（settle 闭包）绝不能引用 bodyStream，否则注册表会把 target 强持在
        // 手里，GC 永不发生、兜底永不触发。
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
        // 连接关闭即终结：close 时隧道不再有新数据——complete=true 的剩余
        // 字节已全部进入 res 缓冲（destroy 不影响后续读取），传输中断则 body
        // 再无干净终态。没人拉取时（如只查 status 的健康探测）这是唯一的
        // 确定性销毁点，不再等永不发生的 pull/cancel。error 监听同时防未处理
        // 'error' 崩进程（toWeb 的监听时序不做假设）。
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
        `节点 ${nodeId} 隧道请求失败：${error instanceof Error ? error.message : String(error)}`,
        502,
      )
    })
    const onAbort = (): void => {
      req.destroy()
      // duplex 的销毁驱动 Response body 端的 error/cancel。
      tunnel.destroy(new HelmError('aborted', '节点 fetch 已取消', 499, { nodeId, url: request.url }))
      reject(new HelmError('aborted', '节点 fetch 已取消', 499, { nodeId, url: request.url }))
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.once('close', () => {
      // 响应 body 可能仍在消费；其终结由 finishBody 移除 abort 监听。
      if (!responseSettled) signal?.removeEventListener('abort', onAbort)
    })
    if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) req.end()
    else pipeRequestBody(request, req)
  })
}
