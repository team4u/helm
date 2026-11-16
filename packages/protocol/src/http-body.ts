/**
 * HTTP boundary infrastructure: body reading and limits (the single implementation shared by kernel and plugins).
 *
 * Pure Web Request API with no Node builtin dependencies. Exceeding the limit must cancel the reader
 * (otherwise the connection hangs) and explicitly throw 413; never silently truncate and pretend success.
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
    throw new BodyError('body_too_large', `Request body exceeds the ${maxBytes}-byte limit`, 413)
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
        // The reader must be cancelled, otherwise the connection hangs.
        await reader.cancel().catch(() => {})
        throw new BodyError('body_too_large', `Request body exceeds the ${maxBytes}-byte limit`, 413)
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
