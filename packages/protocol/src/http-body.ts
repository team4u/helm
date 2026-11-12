/**
 * HTTP 边界基础设施：body 读取与限制（内核与插件共享的唯一实现）。
 *
 * 纯 Web Request API，不依赖 Node 内置模块。超限必须取消 reader
 * （否则连接悬挂）并显式抛 413，绝不静默截断当成功。
 */
import { HelmError } from './error.js'

export class BodyError extends HelmError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
  }
}

export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyError('body_too_large', `请求体超过上限 ${maxBytes} 字节`, 413)
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > maxBytes) {
        // 必须取消 reader，否则连接悬挂。
        await reader.cancel().catch(() => {})
        throw new BodyError('body_too_large', `请求体超过上限 ${maxBytes} 字节`, 413)
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
