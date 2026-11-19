/**
 * Target-node file mutation mutex queue (aligned with `pi-durable`'s `withFileMutationQueue`).
 *
 * Why needed: when kernel `write`/`edit` tools and plugin custom read-modify-write handlers execute
 * concurrently in the same Hub process (same turn, multiple conversations, background services),
 * reading the same stale content and writing back concurrently would lose updates. A per-process
 * queue keyed by `filesystemId + canonicalPath` strictly serializes all callers.
 *
 * Relationship to `pi-durable` (aligned semantics, independent implementation):
 * - `pi-durable`'s `tools/write` and `tools/edit` serialize via its internal `withFileMutationQueue`,
 *   which is not exported from package entrypoints (deep imports violate package boundaries), and
 *   helmx's `write`/`edit` are kernel-owned tools rather than SDK tools;
 * - This module provides the identical queue semantics inside the helmx process so both kernel
 *   `write`/`edit` and the plugin API (`EnvFabric.withFileMutationQueue`) share one implementation.
 *
 * Lock contract:
 * - Key = `${fsId}\u0000${canonicalPath}`; local backend is always `'node:local'` (Hub local FS)
 *   and remote backends are `'remote:<nodeId>'` (each node has its own FS), so identical paths on
 *   different nodes never block each other;
 * - Canonicalization: `realpath` resolves symlinks (different aliases to the same file share one lock);
 *   new files (not yet existing) use the nearest existing ancestor's canonical path joined with the
 *   remaining segments, ensuring creation (`write`) and subsequent `edit` share one key; if the entire
 *   chain is absent, falls back to lexical absolute path (still mutually exclusive in-process; no
 *   cross-process lock guarantee, see below);
 * - Only holds the queue over `fn` (the read-modify-write window); never holds locks across unrelated
 *   files or blocks read-only operations;
 * - Self-cleaning tail promises: cancelled queued tasks release execution immediately, while their Map
 *   slot stays until predecessors settle—never deleting the slot prematurely while the head still holds
 *   the lock (otherwise a new task could run concurrently with the lock holder); zero leak over long runs;
 * - Cancellation while queued: races against `previous` so an aborted `signal` rejects immediately
 *   without waiting for predecessors or running `fn`, and cleans up abort listeners either way;
 * - Non-reentrant: re-entering the queue for the same key within the same async chain (tracked via
 *   `AsyncLocalStorage`) fails immediately with `file_mutation_queue_reentrant` instead of deadlocking
 *   silently. Calling low-level `writeFile` directly inside `fn` (without re-queuing) is legal;
 *   nested calls across separate async chains (e.g. a separate HTTP callback) cannot be detected and
 *   serialize normally.
 *
 * Honest boundaries (not guaranteed):
 * - Does not lock bash or other OS processes—shell and external tools can still race on files;
 * - Not a distributed lock across processes/Hubs: if two Hub processes connect to the same remote node,
 *   their queues are invisible to each other (the current deployment model assumes one Hub per node);
 * - Trusted plugins can still bypass this queue via `node:fs` or `bash` directly (no sandbox promise).
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileError } from '@earendil-works/pi-durable/env'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Each file's queue tail (Promise<void>: resolves once all preceding tasks settle; never rejects). */
const queues = new Map<string, Promise<void>>()

/** Internal/test queue-enqueue notification listeners (never exported from `env/index`). */
const enqueueListeners = new Set<(event: { key: string; waiting: boolean }) => void>()

/** Set of lock keys held by the current async chain (used for nested reentrancy detection). */
const activeKeys = new AsyncLocalStorage<Set<string>>()

/** Rethrow env Result errors as exceptions so callers propagate failures rather than swallowing them. */
async function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): Promise<T> {
  if (result.ok) return result.value
  throw result.error
}

/**
 * Canonical path resolution: if the target does not exist, walk up to the canonical parent directory
 * and append the basename so new file creation (`write`) and subsequent `edit`s under symlinked dirs
 * share one key. Both `ENOTDIR` (an intermediate path segment is a file rather than a directory, mapped
 * to `not_directory` by `pi-durable` and node local-env) and `ENOENT` walk upward just like `localCanonical`
 * and kernel tool probe chains—otherwise `/existing-file/x` would yield divergent results across entrypoints
 * (local walks up while env throws), causing split locks and inconsistent errors.
 */
async function canonicalPath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
  const direct = await env.canonicalPath(absolutePath, context)
  if (direct.ok) return direct.value
  if (direct.error.code === 'not_supported') return absolutePath
  if (direct.error.code !== 'not_found' && direct.error.code !== 'not_directory') throw direct.error
  // Join/split via env so segment separators match the target filesystem.
  const parent = await unwrapOrThrow(await env.joinPath([absolutePath, '..'], context))
  if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath
  const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1))
  if (name === '') return absolutePath
  const parentCanonical = await canonicalPath(env, parent, context)
  return unwrapOrThrow(await env.joinPath([parentCanonical, name], context))
}

/** Queue key: filesystem id + canonical path. */
async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const absolute = await unwrapOrThrow(await env.absolutePath(path, context))
  return `${env.id}\u0000${await canonicalPath(env, absolute, context)}`
}

/**
 * Local canonicalization: matches `canonicalPath` semantics using `node:fs` `realpath`.
 * Walks upward only on `ENOENT` / `ENOTDIR` (missing path component); real I/O errors (`EACCES`, `EIO`,
 * etc.) are rethrown so real faults are never masked as missing paths.
 */
async function localCanonical(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(absolutePath)
    // Termination condition: parent equals self (pathological filesystem where `realpath('/')` fails); stop recursing.
    if (parent === absolutePath) return absolutePath
    return join(await localCanonical(parent), basename(absolutePath))
  }
}

/** Reentrancy check: fail immediately with a clear error if the current async chain already holds this key (never hang silently). */
function assertNotReentrant(key: string): void {
  if (activeKeys.getStore()?.has(key)) {
    const canonical = key.split('\u0000')[1] ?? key
    throw new Error(
      `file_mutation_queue_reentrant: mutation queue for path ${canonical} is non-reentrant—fn must not re-queue the same file ` +
        '(common cause: calling write/edit tools on the same file inside a held lock; acquire outside the lock or write directly inside fn)',
    )
  }
}

/** Execute `fn` within an async context recording `key` as held (for nested reentrancy detection). */
async function runWithKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const store = new Set(activeKeys.getStore())
  store.add(key)
  return activeKeys.run(store, fn)
}

/**
 * Shared scheduling core (single implementation for both `env` and `local` entrypoints):
 * - Races predecessor completion against `signal`: aborts while queued reject immediately without waiting
 *   for predecessors or running `fn`, and always clean up the abort listener; once predecessors finish and
 *   execution enters `fn`, cancellation follows `fn`'s own signal semantics;
 * - Unconditionally releases its slot (`done`) in `finally`, while the Map entry is removed only after
 *   the chain tail settles—cancelled entries wait for predecessors before disappearing so the active lock
 *   holder's Map entry is never evicted early.
 */
async function runQueued<T>(
  key: string,
  previous: Promise<void>,
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  assertNotReentrant(key)
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = queues.has(key)
  const tail = previous.then(() => done)
  queues.set(key, tail)
  for (const listener of [...enqueueListeners]) {
    listener({ key, waiting })
  }
  // Delete Map entry only after the chain tail settles (predecessors + this release).
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  try {
    if (signal === undefined) {
      await previous
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException('This operation was aborted', 'AbortError'))
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        void previous.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    return await runWithKey(key, fn)
  } finally {
    release()
  }
}

/**
 * Strictly serialize mutations to the same canonical file; cancellations while queued reject immediately (see `runQueued`).
 * Concurrent calls targeting the same file queue in order of key resolution completion (matching `pi-durable`).
 */
export async function envWithFileMutationQueue<T>(
  env: ExecutionEnv,
  path: string,
  fn: () => Promise<T>,
  context: Context,
): Promise<T> {
  const key = await mutationKey(env, path, context)
  const previous = queues.get(key) ?? Promise.resolve()
  return runQueued(key, previous, fn, context.abortSignal)
}

/**
 * Local Hub disk file mutation queue (shares key namespace `'node:local'` and canonicalization rules
 * with `ExecutionEnv`'s local backend, so both entrypoints serialize against each other).
 */
export async function localWithFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = `node:local\u0000${await localCanonical(absolutePath)}`
  const previous = queues.get(key) ?? Promise.resolve()
  return runQueued(key, previous, fn, signal)
}

/** Current queue size (diagnostics/testing only; not exported from `env/index`). */
export function fileMutationQueueSize(): number {
  return queues.size
}

/** Subscribe to queue enqueue events (diagnostics/testing only; not exported from `env/index`): fires synchronously right after key resolution and queue insertion. */
export function onFileMutationEnqueue(listener: (event: { key: string; waiting: boolean }) => void): () => void {
  enqueueListeners.add(listener)
  return () => {
    enqueueListeners.delete(listener)
  }
}
