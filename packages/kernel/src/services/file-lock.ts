/**
 * In-process file serialization keyed by canonical real path.
 * Why not per-instance queues: AuthService, runtime, and plugins each instantiate separate
 * ConfigService / CredentialService objects, and per-instance queues wouldn't stop concurrent
 * reads of stale files across instances from overwriting each other. Keying a process-wide lock
 * by canonical real path ensures all instances for the same `dataDir` serialize reads/writes.
 * See `withFileLock` for in-process mutex; see `withProcessFileLock` for cross-process mutex.
 * Non-reentrant: `fn` must never acquire the lock for the same path again (deadlock).
 */
import { realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

const locks = new Map<string, Promise<unknown>>()

/** Normalize lock key: prefer realpath (so symlinked `dataDir` aliases share the exact same lock). */
async function lockKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined)
  if (real !== undefined) return real
  const dirReal = await realpath(dirname(path)).catch(() => undefined)
  if (dirReal !== undefined) return join(dirReal, basename(path))
  return resolve(path)
}

/** Execute `fn` serially under a mutex keyed by `path`; concurrent calls across instances queue in order. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(path)
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  // Clean up Map entry after tail settles to prevent unbounded growth in long-running processes.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

// ---------------------------------------------------------------------------
// Cross-process file lock: the same file may be read-modify-written by multiple Hub/CLI processes,
// so in-process serialization alone won't prevent cross-process stale-read overwrites.
// Lock protocol:
//   Lock file is `<target>.lock`, created with O_EXCL; first token is holder PID (decimal).
//   Breaks stale locks and retries only after confirming PID is dead (ESRCH)—never force-breaks
//   purely on age (valid holders can simply be slow). Corrupt/unparseable lock files fail explicitly.
//   Only removes its own lock file on release (prevents deleting a lock newly acquired by someone else).
//   Non-reentrant: same process enters `withFileLock` first before acquiring this lock.
// ---------------------------------------------------------------------------

const PROCESS_LOCK_WAIT_MS = 10_000
const PROCESS_LOCK_POLL_MS = 25
/** Grace window right after lock creation before content finishes flushing (empty/partial content treated as in-flight write). */
const FRESH_LOCK_GRACE_MS = 1_500

interface LockOwner {
  pid: number | undefined
}

function parseLockOwner(text: string): LockOwner | undefined {
  const head = text.trim().split(/\s+/)[0] ?? ''
  if (!/^\d+$/.test(head)) return undefined
  return { pid: Number(head) }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Execute `fn` while holding a cross-process exclusive lock (`${path}.lock`).
 * Protocol-compatible with the CLI lock implementation so both sides queue and mutually exclude cleanly.
 */
export async function withProcessFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${path}.lock`
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + PROCESS_LOCK_WAIT_MS
  for (;;) {
    try {
      await writeFile(lockFile, `${owner}\n`, { flag: 'wx', mode: 0o600 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`failed to create lock file (${lockFile}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Contention: break stale lock only if holder PID is confirmed dead (never force-break solely by age)
    try {
      const raw = await readFile(lockFile, 'utf8')
      const holder = parseLockOwner(raw)
      if (holder === undefined) {
        // Concurrent process may have just created the file via open('wx') before flushing owner record:
        // within 1500ms of mtime treat as in-flight write and retry rather than misdiagnosing as corrupt
        // (which would break a live lock); past the grace window it is genuinely corrupt and fails explicitly.
        const stats = await stat(lockFile)
        if (Date.now() - stats.mtimeMs >= FRESH_LOCK_GRACE_MS) {
          throw new Error(`corrupt lock file content (${lockFile}): ${JSON.stringify(raw.slice(0, 120))}`)
        }
      } else if (holder.pid !== undefined && !(await isProcessAlive(holder.pid))) {
        // Holder exited: unlink stale lock and retry (another racer may still win the next `wx` attempt)
        await rm(lockFile, { force: true })
        continue
      }
    } catch (err) {
      // Lock was just released when ENOENT occurs: contend again; permission/IO/corruption errors must fail explicitly.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for concurrent file lock (${lockFile})`)
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_LOCK_POLL_MS))
  }
  try {
    return await fn()
  } finally {
    try {
      const raw = await readFile(lockFile, 'utf8')
      if (raw.trim() === owner) await rm(lockFile, { force: true })
    } catch {
      /* if release fails, stale lock will be cleaned once holder exits; never mask business result */
    }
  }
}
