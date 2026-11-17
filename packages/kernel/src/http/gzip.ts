/**
 * Outbound response gzip compression (unified exit in the Hub handler layer).
 *
 * Policy:
 * - Only compress application/json responses (SSE text/event-stream, NDJSON streams, binary artifacts,
 *   and static assets are excluded here; static assets are compressed on demand by static.ts);
 * - Compress only when the client Accept-Encoding includes gzip (q>0); HEAD requests, bodyless responses,
 *   and responses that already carry content-encoding are returned verbatim;
 * - Skip compression at or below GZIP_MIN_BYTES or when compressed output is not smaller than raw bytes;
 * - Rebuild the Response after compression: replace content-length with the compressed byte count so the
 *   Node adapter passes it through verbatim; merge Vary with existing values (e.g. Origin from CORS) and Accept-Encoding;
 * - On compression failure, fall back to identity (identical bytes, always accepted by clients; no content fallback).
 */
import { gzipSync } from 'node:zlib'

/** JSON response compression threshold (bytes): below this, compression gains do not outweigh CPU and TLS framing overhead. */
const GZIP_MIN_BYTES = 1024

/** Parse Accept-Encoding to determine whether gzip is accepted (including x-gzip alias; q=0 means rejected). */
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

/** Merge Accept-Encoding into the Vary header (preserving existing values such as Origin without duplicating). */
function mergeVaryAcceptEncoding(headers: Headers): void {
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
 * Conditionally gzip-compress JSON responses (called after withCors in hub.ts so Vary merging sees
 * any Origin header added by CORS).
 *
 * Cache semantics: every compressible application/json response (even when sent uncompressed due to HEAD,
 * client not accepting gzip, below threshold, or no size savings) gets `Vary: Accept-Encoding` merged—the same
 * URL has two representations, and omitting Vary would allow proxies to reuse an identity response across encodings.
 *
 * Body safety: size probing and compression always read `response.clone()`, leaving the original body intact;
 * only when compression succeeds and shrinks the payload is the Response rebuilt with compressed bytes.
 */
export async function gzipJsonResponse(request: Request, response: Response): Promise<Response> {
  if (response.headers.has('content-encoding')) return response
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return response
  // Always merge Vary (mutates original response headers directly without touching body, matching withCors)
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
    // zlib will not fail for valid buffers; if it ever does, identity encoding is always acceptable to clients
    // (identical bytes, not a content fallback).
    return response
  }
  if (compressed.byteLength >= raw.byteLength) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-length', String(compressed.byteLength))
  headers.set('content-encoding', 'gzip')
  mergeVaryAcceptEncoding(headers)
  // Wrap in `new Uint8Array(...)` to normalize BodyInit typing (matches static.ts).
  return new Response(new Uint8Array(compressed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
