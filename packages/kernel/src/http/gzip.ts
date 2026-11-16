/**
 * 出站响应 gzip（Hub handler 层统一出口）。
 *
 * 策略：
 * - 仅压缩 application/json 响应（SSE text/event-stream、NDJSON 流、二进制
 *   产物与静态资源均不在此层；静态资源由 static.ts 按扩展名自行压缩）；
 * - 客户端 Accept-Encoding 含 gzip（q>0）才压缩；HEAD、无 body、已带
 *   content-encoding 的响应一律原样返回；
 * - 阈值以下（GZIP_MIN_BYTES）或压缩无收益（>= 原文）不压缩；
 * - 压缩后重建响应：清除旧 content-length 再写入压缩后字节数，Node 适配层
 *   原样透传；Vary 合并既有值（如 CORS 写入的 Origin）与 Accept-Encoding；
 * - 压缩失败回退 identity（同一字节、客户端可接受，非内容降级）。
 */
import { gzipSync } from 'node:zlib'

/** JSON 响应压缩阈值（字节）：低于此值压缩收益不抵 CPU 与 TLS 固定开销。 */
export const GZIP_MIN_BYTES = 1024

/** 解析 Accept-Encoding 是否接受 gzip（含 x-gzip 别名；q=0 视为拒绝）。 */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get('accept-encoding')
  if (header === null) return false
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';')
    const token = tokenRaw?.trim().toLowerCase()
    if (token !== 'gzip' && token !== 'x-gzip') continue
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='))
    if (q !== undefined) {
      const weight = Number(q.slice(2))
      if (!Number.isFinite(weight) || weight === 0) continue
    }
    return true
  }
  return false
}

/** Headers 上合并 Vary 与 Accept-Encoding（保留既有条目如 Origin，不重复）。 */
export function mergeVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get('vary')
  if (existing === null) {
    headers.set('vary', 'Accept-Encoding')
    return
  }
  const tokens = existing
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '')
  if (!tokens.includes('accept-encoding')) {
    headers.set('vary', `${existing}, Accept-Encoding`)
  }
}

/**
 * 条件压缩 JSON 响应（hub.ts 在 withCors 之后调用，保证 Vary 合并看得到
 * CORS 写入的 Origin）。
 *
 * 缓存语义：所有可压缩的 application/json 响应（无论本次是否实际压缩：
 * HEAD / 客户端不接受 gzip / 低于阈值 / 无压缩收益）统一合并
 * `Vary: Accept-Encoding`——同一 URL 存在两种编码表示，缺 Vary 的
 * identity 响应可能被代理缓存跨编码复用。
 *
 * body 安全：尺寸探测与压缩一律读 `response.clone()`，原响应 body 绝不
 * 消费；仅压缩成功时才以压缩字节重建 Response（清除旧 content-length 后
 * 写入压缩后长度）。
 */
export async function gzipJsonResponse(request: Request, response: Response): Promise<Response> {
  if (response.headers.has('content-encoding')) return response
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return response
  // 统一 Vary（直接改写原响应头，body 未动；与 withCors 同一手法）
  mergeVaryAcceptEncoding(response.headers)
  if (request.method === 'HEAD') return response
  if (response.body === null) return response
  if (!acceptsGzip(request)) return response
  const raw = new Uint8Array(await response.clone().arrayBuffer())
  if (raw.byteLength < GZIP_MIN_BYTES) return response
  let compressed: Uint8Array
  try {
    compressed = gzipSync(raw)
  } catch {
    // zlib 对合法缓冲区不会失败；万一失败，identity 编码对客户端始终可接受
    //（同一字节、非内容降级）。
    return response
  }
  if (compressed.byteLength >= raw.byteLength) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-length', String(compressed.byteLength))
  headers.set('content-encoding', 'gzip')
  mergeVaryAcceptEncoding(headers)
  // new Uint8Array(...) 归一 BodyInit 类型（与 static.ts 同一口径）。
  return new Response(new Uint8Array(compressed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
