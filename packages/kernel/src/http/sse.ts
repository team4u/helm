/**
 * SSE 编码：text/event-stream 帧写入（event: + data:），一次性 flush。
 * 保持流式无缓冲语义：每帧独立 encode + enqueue，不整流攒批。
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
        // 已关闭：幂等。
      }
    },
  }
}
