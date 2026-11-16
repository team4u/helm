/**
 * SSE stream pair create sharing original language (EventHub.response and SessionDocEventHub.response re- use).
 *
 * - encodeSseChunk: publish/subscribe path unify encode (the same byte enter ring and all subscribe);
 * - byteBoundedWrite: byte level has boundary back press (hwm=0 under desiredSize constant is -queue up byte count,
 *   over limit i.e. slow client decide, return false by caller closure stream, never static default lose frame);
 * - sseResponse: unify ReadableStream(hwm=0 + byteLength count amount) and response head construct.
 */

/** SSE chunk encode (single one instance; publish once,ring, replay and all subscribe re- use the same byte). */
const SSE_ENCODER = new TextEncoder()

export function encodeSseChunk(name: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** idle heartbeat note release row (pre- encode sharing;SSE parse ignore, do not fabricate business event). */
export const KEEPALIVE_CHUNK: Uint8Array = SSE_ENCODER.encode(': keepalive\n\n')

/** SSE response head (two event side the same set). */
const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * byte level has boundary back press write:controller missing/already closure or queue up byte + this frame exceeds pre- compute when return
 * false(slow client, by caller explicit closure stream);enqueue throws same return false.
 */
export function byteBoundedWrite(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  closed: boolean,
  chunk: Uint8Array,
  maxPendingBytes: number,
): boolean {
  if (controller === undefined || closed) return false
  // byte level has boundary back press:desiredSize = -queue up byte count (hwm=0); over limit i.e. slow client.
  const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
  if (queuedBytes + chunk.byteLength > maxPendingBytes) return false
  try {
    controller.enqueue(chunk)
    return true
  } catch {
    return false
  }
}

/** idempotent close stream control (already closure close again closure do not throw). */
export function closeControllerQuietly(controller: ReadableStreamDefaultController<Uint8Array> | undefined): void {
  try {
    controller?.close()
  } catch {
    // already closure: idempotent.
  }
}

/** unify SSE response construct:hwm=0(desiredSize constant is -queue up byte count, supply back press decide;
 * pull only in queue empty and store in pending read when trigger)+ byteLength count amount + standard response head. */
export function sseResponse(source: UnderlyingSource<Uint8Array>): Response {
  const stream = new ReadableStream<Uint8Array>(
    source,
    { highWaterMark: 0, size: (c) => c.byteLength } satisfies QueuingStrategy<Uint8Array>,
  )
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS })
}
