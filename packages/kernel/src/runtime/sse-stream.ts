/**
 * SSE 流搭建共享原语（EventHub.response 与 SessionDocEventHub.response 复用）。
 *
 * - encodeSseChunk：发布/订阅路径统一编码（同一份字节进 ring 与全部订阅者）；
 * - byteBoundedWrite：字节级有界背压（hwm=0 下 desiredSize 恒为 -排队字节数，
 *   超限即慢客户端判定，返回 false 由调用方关流，绝不静默丢帧）；
 * - sseResponse：统一 ReadableStream（hwm=0 + byteLength 计量）与响应头构造。
 */

/** SSE chunk 编码器（单一实例；发布一次，ring、重放与全部订阅者复用同一份字节）。 */
const SSE_ENCODER = new TextEncoder()

export function encodeSseChunk(name: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** 空闲心跳注释行（预编码共享；SSE 解析器忽略，不伪造业务事件）。 */
export const KEEPALIVE_CHUNK: Uint8Array = SSE_ENCODER.encode(': keepalive\n\n')

/** SSE 响应头（两个事件面同一套）。 */
const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * 字节级有界背压写入：controller 缺失/已关或排队字节 + 本帧超过预算时返回
 * false（慢客户端，由调用方显式关流）；enqueue 抛错同样返回 false。
 */
export function byteBoundedWrite(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  closed: boolean,
  chunk: Uint8Array,
  maxPendingBytes: number,
): boolean {
  if (controller === undefined || closed) return false
  // 字节级有界背压：desiredSize = -排队字节数（hwm=0）；超限即慢客户端。
  const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
  if (queuedBytes + chunk.byteLength > maxPendingBytes) return false
  try {
    controller.enqueue(chunk)
    return true
  } catch {
    return false
  }
}

/** 幂等关闭流控制器（已关的 close 再关不抛）。 */
export function closeControllerQuietly(controller: ReadableStreamDefaultController<Uint8Array> | undefined): void {
  try {
    controller?.close()
  } catch {
    // 已关：幂等。
  }
}

/** 统一 SSE 响应构造：hwm=0（desiredSize 恒为 -排队字节数，供背压判定；
 * pull 仅在队列空且存在 pending read 时触发）+ byteLength 计量 + 标准响应头。 */
export function sseResponse(source: UnderlyingSource<Uint8Array>): Response {
  const stream = new ReadableStream<Uint8Array>(
    source,
    { highWaterMark: 0, size: (c) => c.byteLength } satisfies QueuingStrategy<Uint8Array>,
  )
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS })
}
