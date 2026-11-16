/**
 * Isomorphic test helper foundations (`@helm/test-kit` main entry).
 * Never import any `node:*` module so browser / happy-dom / Node tests can reuse it safely.
 */

import type { ConversationSummary, PluginSummary, Profile } from '@helm/protocol/browser'

/** Build a ConversationSummary DTO for tests, providing every required field by default. */
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

/** Build a Profile DTO for tests. */
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

/** Build a PluginSummary DTO for tests, providing every required field by default. */
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

/** Deferred promise handle that can be resolved or rejected manually from outside. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err?: unknown) => void
}

/** Create a deferred Promise that can be explicitly controlled across async boundaries. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Isomorphic millisecond sleep (based on globalThis.setTimeout, no node:* dependency). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

/** `waitFor` polling options. */
export interface WaitForOptions {
  timeoutMs?: number
  intervalMs?: number
  message?: string
}

/** Poll until the condition holds; on timeout throw an Error carrying context information. */
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
      throw new Error(options.message ?? `waitFor timed out after ${timeoutMs}ms (condition never held)`)
    }
    await sleep(Math.max(0, Math.min(intervalMs, remaining)))
  }
}

/** Build a standard JSON HTTP Response (defaults to 200). */
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

/** Assert an async operation rejects with an error matching the given code (and optional HTTP status); return the caught error. */
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
    throw new Error(`expected rejection with error code ${code}, but the operation resolved successfully`)
  }
  const actual =
    caught !== null && typeof caught === 'object'
      ? (caught as { code?: unknown; status?: unknown; message?: unknown })
      : undefined
  if (actual?.code !== code) {
    throw new Error(
      `expected error code ${code}, got ${String(actual?.code)} (${String(actual?.message ?? caught)})`,
    )
  }
  if (status !== undefined && actual.status !== status) {
    throw new Error(`expected error status ${status}, got ${String(actual.status)}`)
  }
  return caught
}
