/**
 * 同构测试辅助基座（`@helm/test-kit` 主入口）。
 * 严禁导入任何 `node:*` 模块，确保浏览器 / happy-dom / Node 测试均可安全复用。
 */

import type { ConversationSummary, PluginSummary, Profile } from '@helm/protocol/browser'

/** 构造用于测试的会话摘要 DTO，默认提供所有必填字段。 */
export function makeConversationSummary(
  overrides: Partial<ConversationSummary> & { id?: number } = {},
): ConversationSummary {
  const id = overrides.id ?? 1
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 构造用于测试的 Profile DTO。 */
export function makeProfile(
  overrides: Partial<Profile> & { id?: string } = {},
): Profile {
  const id = overrides.id ?? 'assistant'
  return {
    id,
    name: id,
    ...overrides,
  }
}

/** 构造用于测试的 PluginSummary DTO，默认提供所有必填字段。 */
export function makePluginSummary(
  overrides: Partial<PluginSummary> & { id?: string } = {},
): PluginSummary {
  const id = overrides.id ?? 'test:plugin'
  return {
    id,
    name: overrides.name ?? id,
    version: '0.1.0',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
    ...overrides,
  }
}

/** 可从外部手动兑现或拒绝的延迟 Promise 句柄。 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err?: unknown) => void
}

/** 创建一个可在异步边界外显式控制的 deferred Promise。 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 同构毫秒级延时（基于 globalThis.setTimeout，无 node:* 依赖）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

/** `waitFor` 轮询选项。 */
export interface WaitForOptions {
  timeoutMs?: number
  intervalMs?: number
  message?: string
}

/** 轮询等待条件成立，超时后抛出包含上下文信息的 Error。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(options.message ?? `waitFor 超时（${timeoutMs}ms 内条件未成立）`)
    }
    await sleep(Math.max(0, Math.min(intervalMs, remaining)))
  }
}

/** 构造标准 JSON HTTP Response（默认 200）。 */
export function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers)
  if (!merged.has('content-type')) {
    merged.set('content-type', 'application/json')
  }
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: merged,
  })
}

/** 断言异步操作抛出匹配指定错误码（及可选 HTTP 状态码）的错误并返回捕获对象。 */
export async function assertRejectsCode(
  fn: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<unknown> {
  let caught: unknown
  let rejected = false
  try {
    await fn()
  } catch (error) {
    rejected = true
    caught = error
  }
  if (!rejected) {
    throw new Error(`预期抛出错误码 ${code}，但操作成功返回`)
  }
  const actual =
    caught !== null && typeof caught === 'object'
      ? (caught as { code?: unknown; status?: unknown; message?: unknown })
      : undefined
  if (actual?.code !== code) {
    throw new Error(
      `预期错误码 ${code}，实际为 ${String(actual?.code)}（${String(actual?.message ?? caught)}）`,
    )
  }
  if (status !== undefined && actual.status !== status) {
    throw new Error(`预期错误状态码 ${status}，实际为 ${String(actual.status)}`)
  }
  return caught
}
