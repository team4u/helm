/**
 * Shared SSE stream primitives (reused by EventHub.response and SessionDocEventHub.response).
 *
 * - encodeSseChunk: unified encoder along the publish/subscribe path (exact same bytes enter the ring and all subscribers);
 * - byteBoundedWrite: byte-bounded backpressure (under hwm=0, desiredSize equals -queuedBytes;
 *   exceeding the cap flags a slow client and returns false so the caller closes the stream rather than silently dropping frames);
 * - sseResponse: unified ReadableStream (hwm=0 + byteLength sizing) and response headers builder.
 */

/** SSE chunk encoder (single instance; publish, ring, replay, and all subscribers share the exact same bytes). */
const SSE_ENCODER = new TextEncoder()

export function encodeSseChunk(name: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Idle keepalive comment line (pre-encoded shared buffer; ignored by SSE parsers and never fabricates business events). */
export const KEEPALIVE_CHUNK: Uint8Array = SSE_ENCODER.encode(': keepalive\n\n')

/** SSE response headers (identical across both event streams). */
const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * Byte-bounded backpressure write: returns false when the controller is missing/closed or queued bytes + this frame
 * exceed the budget (slow client; caller explicitly closes the stream), and likewise returns false if enqueue throws.
 */
export function byteBoundedWrite(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  closed: boolean,
  chunk: Uint8Array,
  maxPendingBytes: number,
): boolean {
  if (controller === undefined || closed) return false
  // Byte-bounded backpressure: desiredSize = -queuedBytes under hwm=0; exceeding budget means slow client.
  const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
  if (queuedBytes + chunk.byteLength > maxPendingBytes) return false
  try {
    controller.enqueue(chunk)
    return true
  } catch {
    return false
  }
}

/** Idempotently close a stream controller (closing an already-closed controller does not throw). */
export function closeControllerQuietly(controller: ReadableStreamDefaultController<Uint8Array> | undefined): void {
  try {
    controller?.close()
  } catch {
    // Already closed: idempotent.
  }
}

/** Unified SSE response builder: hwm=0 (desiredSize equals -queuedBytes for backpressure detection, pulling only when
 * the queue is empty and a read is pending) + byteLength sizing + standard response headers. */
export function sseResponse(source: UnderlyingSource<Uint8Array>): Response {
  const stream = new ReadableStream<Uint8Array>(
    source,
    { highWaterMark: 0, size: (c) => c.byteLength } satisfies QueuingStrategy<Uint8Array>,
  )
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS })
}
