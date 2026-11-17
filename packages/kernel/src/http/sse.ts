/**
 * SSE encoder: writes `text/event-stream` frames (`event:` + `data:`) and flushes each immediately.
 * Unbuffered streaming semantics: each frame is encoded and enqueued independently without whole-stream buffering.
 */

interface SseSink {
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
        // already closed: idempotent.
      }
    },
  }
}
