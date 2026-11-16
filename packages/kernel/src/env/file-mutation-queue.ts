/**
 * target node file mutual exclusion queue (align pi-durable  withFileMutationQueue).
 *
 * is what need to: kernel write/edit and plugin self define file read change write in the same Hub process inside concurrency
 * when (the same turn, many conversation, background service), mutual each other read the same old content after each write back will lose update.
 * with file system id + canonical path is key process level queue let all caller strictly queue up.
 *
 * and pi-durable closure system (semantics align, implement independent):
 * - pi-durable  tools/write,tools/edit internal use the same algorithm
 *   withFileMutationQueue serial, but the function not from package exports expose (deep import
 *   violate reverse wrap boundary), and helm  write/edit is kernel self carries tool, do not via SDK tool;
 * - therefore this module in helm process inside provide the same semantics queue, and kernel write/edit and
 *   plugin API(EnvFabric.withFileMutationQueue) all connect to this a implement on.
 *
 * lock contract:
 * - key = `${file system id}\u0000${canonical path}`;local bottom seat id constant is 'node:local'
 *   (Hub local machine file system), remote bottom seat id is 'remote:<nodeId>'(each node one stage file
 *   system) - - different node same shape path day however different key, mutual non-blocking;
 * - canonical:realpath parse symlink alias (different write method points to the same file sharing one lock);
 *   new file (still missing) take most near store in ancestor canonical + remaining segment concatenate, guarantee
 *   create it writeand after editsame key; whole chain all missing when retreat is
 *   term method absolute path (process inside still mutual exclusion; across process without lock promise, see under);
 * - only lock fn execute window (read-change-write), do not lock without closure file, non-blocking read operation;
 * - queue item by chain tail compute self clean up: by cancel queue up immediately release execute right, but its Map occupy
 *   keep to before order compute after only then disappear - - never mention before delete still in run header lock (otherwise after continue new task
 *   will and hold lock concurrency); long run process without leak leak;
 * - queue up in by cancel: and before order task competition wait for,signal first to immediately reject (do not etc. before order, do not execute
 *   fn),abort listener regardless of remove to all clean up;
 * - cannot heavy: the same async chain (AsyncLocalStorage pass broadcast) inside for the same key embed set queue immediately
 *   explicit errors `file_mutation_queue_reentrant`, never static default hang die.fn inside directly invoke underlying
 *   writeFile(no longer time queue) legal; bypass this process async chain start embed set (such as independent HTTP
 *   request call back bypass back) cannot detect, still by ordinary queue up semantics wait for.
 *
 * honest boundary (does not promise):
 * - is not for bash / other process lock - -shell and external tool still may concurrency change file;
 * - is not across process/across Hub distributed style lock: the same remote node such as has second Hub process access,
 *   two Hub each queue mutual invisible. when before deploy model a node only connect a Hub;
 * - can message plugin still can directly node:fs / bash bypass this queue (without sandbox promise).
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileError } from '@earendil-works/pi-durable/env'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** each file chain tail (Promise<void>: chain on before order task all compute i.e. resolve, never reject). */
const queues = new Map<string, Promise<void>>()

/** internal/test queue notify listener (never enter env/index public exports). */
const enqueueListeners = new Set<(event: { key: string; waiting: boolean }) => void>()

/** when before async chain hold has lock key collection (embed set heavy detect). */
const activeKeys = new AsyncLocalStorage<Set<string>>()

/** env failed to invoke on throw (Result model archive one is exception, error such as pass broadcast do not swallow). */
async function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): Promise<T> {
  if (result.ok) return result.value
  throw result.error
}

/**
 * canonical path: file missing when takecanonical parent directory + filename one by one level on trace
 * (symlink directory under new file and create it write / after continue edit same key).ENOTDIR
 * (path in a certain segment is file while non- directory,pi-durable and node side local-env mapping
 * not_directory) and ENOENT same by missing on trace: and localCanonical and kernel
 * tool probe chain consistent, otherwise the same `/already exists file/x` path will in two entry compute out different key
 *(local direct connect on trace,env entry throws), double lock and errors fork all by this while come.
 */
async function canonicalPath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
  const direct = await env.canonicalPath(absolutePath, context)
  if (direct.ok) return direct.value
  if (direct.error.code === 'not_supported') return absolutePath
  if (direct.error.code !== 'not_found' && direct.error.code !== 'not_directory') throw direct.error
  // environment by isolate symbol split path: name may contains other file system isolate symbol character.
  const parent = await unwrapOrThrow(await env.joinPath([absolutePath, '..'], context))
  if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath
  const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1))
  if (name === '') return absolutePath
  const parentCanonical = await canonicalPath(env, parent, context)
  return unwrapOrThrow(await env.joinPath([parentCanonical, name], context))
}

/** queue key: file system id + canonical path. */
async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const absolute = await unwrapOrThrow(await env.absolutePath(path, context))
  return `${env.id}\u0000${await canonicalPath(env, absolute, context)}`
}

/**
 * local canonical: and canonicalPath same semantics, directly use node:fs realpath.
 * only ENOENT / ENOTDIR(path component missing) by missing on trace concatenate;EACCES / EIO etc.
 * such as on throw (swallow will real fault disguise into missing, violate reverse honest discipline).
 */
async function localCanonical(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(absolutePath)
    // terminate: parent i.e. itself (realpath('/') failed illness state file system), never again recursion.
    if (parent === absolutePath) return absolutePath
    return join(await localCanonical(parent), basename(absolutePath))
  }
}

/** heavy detect: same key already by when before async chain hold has when immediately explicit errors (never static default hang die). */
function assertNotReentrant(key: string): void {
  if (activeKeys.getStore()?.has(key)) {
    const canonical = key.split('\u0000')[1] ?? key
    throw new Error(
      `file_mutation_queue_reentrant: path ${canonical} mutual exclusion queue cannot heavy - -fn inside must not again for the same file queue` +
        '(common into because: hold lock window inside invoke same will for the file queue write/edit; please in lock outside start, or change is in fn inside directly underlying write)',
    )
  }
}

/** in hold has keyasync context in execute fn(supply embed set invoke heavy detect). */
async function runWithKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const store = new Set(activeKeys.getStore())
  store.add(key)
  return activeKeys.run(store, fn)
}

/**
 * sharing scheduling core (env / local two entry unique implement, eliminate duplicate):
 * - occupy after and before order task competition signal: queue up in by cancel immediately reject (do not etc. before order, do not execute
 *   fn),abort listener regardless of remove to all clean up; before order first compute then enter execute window, window inside
 *   cancel hand over by fn itself signal semantics;
 * - finally without condition release this (done),Map item delete only in chain tail itself compute after - -
 *   by cancel queue up occupy follow before order compute self however disappear, never mention before delete still in run header lock.
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
  // chain tail compute (before order complete + this release) after only then allows delete Map item.
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
 * the same file (canonical) change strictly serial; queue up in cancel immediately reject (see runQueued).
 * concurrency same file invoke bykey parse complete order queue up (and pi-durable consistent).
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
 * local Hub disk file mutual exclusion queue (and via ExecutionEnv  local bottom seat same key empty between:
 * key prefix same is 'node:local',canonical algorithm consistent, therefore two kinds of entry mutual exclusion).
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

/** queue inside now store item count (diagnose/test inside omit; does not enter env/index public exports). */
export function fileMutationQueueSize(): number {
  return queues.size
}

/** subscribe queue queue event (diagnose/test inside omit; does not enter env/index public exports): task complete canonical parse and hang queues after sync trigger. */
export function onFileMutationEnqueue(listener: (event: { key: string; waiting: boolean }) => void): () => void {
  enqueueListeners.add(listener)
  return () => {
    enqueueListeners.delete(listener)
  }
}
