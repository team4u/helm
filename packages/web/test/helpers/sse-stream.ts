/**
 * 测试专用「snapshot 后挂起」的 SSE 流工厂（/api/events 与 sessionDoc events 桩共用）。
 *
 * 真实内核 SSE 长连接发出 snapshot 后长期保持打开；测试的 fetch mock 若原样
 * 挂起且不响应请求的 AbortSignal，HelmStoreProvider 卸载时只 abort signal，
 * 仍在 `readSseChunkWithDeadline` 挂起的 reader.read() 要空等 idleTimeoutMs
 * （60s）看门狗才解开——每个用例卸载后进程都多挂 60 秒。
 *
 * 本工厂把流与 fetch 的 AbortSignal 联动：abort（或消费端 cancel）立即关闭
 * 流并解绑监听，挂起的 read 以 done 解开，用例随即收尾。返回的 send 在流
 * 终结后自动变为 no-op（迟到事件安全丢弃），不改变「snapshot 后长连接挂起」
 * 的测试语义。
 */

export type SseFrameSender = (frame: Uint8Array) => void

export interface HangingEventStreamOptions {
  /** fetch init.signal：abort 时关闭流（容忍 null/undefined，视为无信号性挂起）。 */
  signal?: AbortSignal | null
  /** 流终结（abort / 消费端 cancel / emit 抛错）回调：清空外部持有的 send。 */
  onTeardown?: () => void
}

export function hangingEventStream(
  emit: (send: SseFrameSender) => void | Promise<void>,
  options: HangingEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  const signal = options.signal ?? undefined
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  const send: SseFrameSender = (frame) => {
    if (ended) return
    controller?.enqueue(frame)
  }
  /** 终结流：幂等；先摘除 controller 再关闭，终结后 send 失效并解绑 abort 监听。 */
  const finish = (): void => {
    if (ended) return
    ended = true
    const c = controller
    controller = undefined
    options.onTeardown?.()
    if (signal !== undefined) signal.removeEventListener('abort', finish)
    try { c?.close() } catch { /* 已关闭/已取消：幂等 */ }
  }
  if (signal !== undefined) signal.addEventListener('abort', finish, { once: true })
  return new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c
      try {
        await emit(send)
      } catch (error) {
        ended = true
        controller = undefined
        options.onTeardown?.()
        if (signal !== undefined) signal.removeEventListener('abort', finish)
        try { c.error(error instanceof Error ? error : new Error('测试 SSE 流 emit 失败')) } catch { /* 幂等 */ }
        return
      }
      // emit 期间（如延迟 snapshot）可能已 abort：补终结，避免漏关流。
      if (signal?.aborted) finish()
    },
    cancel() { finish() },
  })
}