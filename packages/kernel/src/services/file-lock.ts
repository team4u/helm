/**
 * process inside by real path sharing file serial.
 * is what do not use instance level queue:AuthService internal,runtime, plugin each new 
 * ConfigService / CredentialService is different instance, instance queue block do not across instance
 * concurrency read the same old file after mutual each other override. with real path is key process level lock only then can let
 * the same dataDir all instance serial read change write.
 * process inside mutual exclusion see withFileLock; across process mutual exclusion see withProcessFileLock.
 * cannot heavy:fn internal must not again for the same path add lock (will deadlock).
 */
import { realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

const locks = new Map<string, Promise<unknown>>()

/** lock key archive one: takes precedence real path (dataDir is symlink when different write method still sharing the same lock). */
async function lockKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined)
  if (real !== undefined) return real
  const dirReal = await realpath(dirname(path)).catch(() => undefined)
  if (dirReal !== undefined) return join(dirReal, basename(path))
  return resolve(path)
}

/** with path is mutual exclusion key serial execute fn; same key all invoke (across instance) strictly by order queue up. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(path)
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  // tail part compute after clean up, guard against long phase run process Map without boundary increase long.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

// ---------------------------------------------------------------------------
// across process file lock: the same file may by multiple Hub/manage process read change write,
// only process inside serial block do not across process concurrency read the same old file after mutual each other override.
// lock protocol:
//   lock file is <target file>.lock,O_EXCL create, content first token segment is holder PID(ten enter system).
//   only in PID confirm death (ESRCH) when treated as stale break except and retry; do not by store when long strong split
//   (legal hold lock may only is slow). broken lock content/cannot decide when explicit errors, never guess.
//   release only delete itself hold has lock file (guard against mistakenly delete other person tight connect create new lock).
//   cannot heavy: same process inside first via withFileLock serial, again enter this lock.
// ---------------------------------------------------------------------------

const PROCESS_LOCK_WAIT_MS = 10_000
const PROCESS_LOCK_POLL_MS = 25
/** lock file just create but content not yet write completely wide limit phase: phase inside empty/half truncate content treated as is now write. */
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
 * across process arrange other lock under execute fn; lock file is `${path}.lock`.
 * and CLI lock implement protocol compatibility: both sides can mutual each other queue up, mutual exclusion the same target file.
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
        throw new Error(`cannot create lock file (${lockFile}):${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // take lock failed: only in holder PID confirm death when break except stale lock (do not by store when long strong split)
    try {
      const raw = await readFile(lockFile, 'utf8')
      const holder = parseLockOwner(raw)
      if (holder === undefined) {
        // concurrency process just with open('wx') create lock file but not yet write completely holder record:mtime distance now
        // < 1500ms treated as is now write, wait for retry while non- mistakenly judge lock corrupt (mistakenly judge will break except health lock);
        // wide limit phase still cannot parse only then is true corrupt, explicit errors (honest discipline).
        const stats = await stat(lockFile)
        if (Date.now() - stats.mtimeMs >= FRESH_LOCK_GRACE_MS) {
          throw new Error(`lock file content corrupt (${lockFile}):${JSON.stringify(raw.slice(0, 120))}`)
        }
      } else if (holder.pid !== undefined && !(await isProcessAlive(holder.pid))) {
        // holder already exit: atomic preempt (unlink and after continue wx create between still has race, failed i.e. retry)
        await rm(lockFile, { force: true })
        continue
      }
    } catch (err) {
      // lock just by release when re- contend grab; permission,IO and content corrupt all must explicit failed.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (Date.now() > deadline) {
      throw new Error(`file by concurrency write, wait for lock timeout (${lockFile})`)
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
      /* release failed to holder death after stale break except, do not mask business result */
    }
  }
}
