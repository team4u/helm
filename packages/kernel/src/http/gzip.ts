/**
 * out station response gzip(Hub handler layer unify exit).
 *
 * policy:
 * - only compress application/json response (SSE text/event-stream,NDJSON stream, two enter system
 *   artifact and static assets all do not in this layer; static assets by static.ts by extension self row compress);
 * - client Accept-Encoding contains gzip(q>0) only then compress;HEAD, without body, already carries
 *   content-encoding response one rule original return;
 * - threshold or fewer (GZIP_MIN_BYTES) or compress without benefit (>= original text) do not compress;
 * - compress after rebuild response: clear old content-length again write compress after byte count,Node adapt layer
 *   original pass-through;Vary merge since has value (such as CORS write Origin) and Accept-Encoding;
 * - compress failed fall back identity(the same byte, client can accept, non- content fall back).
 */
import { gzipSync } from 'node:zlib'

/** JSON response compress threshold (byte): low at this value compress benefit do not arrive CPU and TLS fixed overhead. */
export const GZIP_MIN_BYTES = 1024

/** parse Accept-Encoding is otherwise accept gzip(contains x-gzip alias;q=0 treated as reject). */
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

/** Headers on merge Vary and Accept-Encoding(keep since has item such as Origin, does not repeat). */
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
 * condition compress JSON response (hub.ts in withCors after invoke, guarantee Vary merge see obtain to
 * CORS write Origin).
 *
 * cache semantics: all can compress application/json response (regardless of this time is otherwise actual compress:
 * HEAD / client do not accept gzip / low at threshold / without compress benefit) unify merge
 * `Vary: Accept-Encoding`- - the same URL store in two kinds of encode means, missing Vary 
 * identity response may by proxy cache across encode re- use.
 *
 * body security: size probe and compress one rule read `response.clone()`, original response body never
 * consume; only compress on success only then with compress byte rebuild Response(clear old content-length after
 * write compress after length).
 */
export async function gzipJsonResponse(request: Request, response: Response): Promise<Response> {
  if (response.headers.has('content-encoding')) return response
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return response
  // unify Vary(directly change write original response head,body not motion; and withCors the same manually method)
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
    // zlib for legal buffer zone will not failed; in case failed,identity encode for client always can accept
    //(the same byte, non- content fall back).
    return response
  }
  if (compressed.byteLength >= raw.byteLength) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-length', String(compressed.byteLength))
  headers.set('content-encoding', 'gzip')
  mergeVaryAcceptEncoding(headers)
  // new Uint8Array(...) archive one BodyInit type (and static.ts the same opening path).
  return new Response(new Uint8Array(compressed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
