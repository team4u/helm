/**
 * SSE encode:text/event-stream frame write (event: + data:), once flush.
 * keep streaming without buffer semantics: each frame independent encode + enqueue, do not whole stream accumulate batch.
 */

export interface SseSink {
  send(event: string, data: unknown): void
  close(): void
}

export function openSse(controller: ReadableStreamDefaultController<Uint8Array>): SseSink {
  const encoder = new TextEncoder()
  const send = (event: string, data: unknown): void => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  }
  return {
    send,
    close() {
      try {
        controller.close()
      } catch {
        // already close: idempotent.
      }
    },
  }
}
