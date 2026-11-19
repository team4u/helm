/**
 * Atomic file writes: the single shared implementation for `@helmx/kernel`, `@helmx/node`, and
 * `@helmx/plugin-build` (formerly three private copies with drifting semantics).
 *
 * Unified semantics — the strongest defense of every legacy implementation:
 * - sibling temp file `.<uuid>.tmp` in the target directory (same filesystem => rename is atomic,
 *   unique names prevent concurrent writer collisions);
 * - `0600` by default (`mode` option overrides) so credentials and secrets never leak permissions
 *   via temp files; rename carries the temp inode's mode to the final target;
 * - data is flushed and `fsync`ed before rename, so a crash mid-write never leaves a half-written
 *   target behind (the old target stays intact until the atomic flip);
 * - the requested mode is additionally forced via explicit `chmod` on the temp (POSIX only), so no
 *   process umask can weaken it — Windows ACLs do not map POSIX bits, where chmod is meaningless;
 * - rename retries transient lock errors with bounded exponential backoff (see below).
 *
 * Retryable rename codes — merged from all legacy implementations and retried on every platform,
 * bounded by `RENAME_BUSY_TOTAL_MS`; on exhaustion the original error (errno `code` intact) is
 * rethrown with retry diagnostics appended, never silently downgraded:
 * - `EPERM`: Windows returns EPERM when renaming over a file held open without FILE_SHARE_DELETE
 *   (antivirus, search indexer, concurrent reader); POSIX only yields it for real faults, where the
 *   bounded retry merely delays the same honest error;
 * - `EACCES`: Windows share violations may also surface as EACCES for the same handle-lock reason;
 *   on POSIX it is normally a genuine permission fault and fails after the bounded window instead;
 * - `EBUSY`: Linux/BSD filesystems in active use (FUSE, some network/overlay mounts) can reject
 *   renames with EBUSY transiently; Windows maps certain share violations to it as well.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Bounded backoff parameters when the target rename hits transient file locks (concurrent readers / AV / indexer). */
const RENAME_BUSY_TOTAL_MS = 1_500
const RENAME_BUSY_INITIAL_POLL_MS = 5
const RENAME_BUSY_MAX_POLL_MS = 50

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Options shared by every atomic write entry point. */
export interface AtomicWriteOptions {
  /** Permission bits forced on the final target (default `0600`); POSIX only, ignored on Windows. */
  mode?: number
}

function isTransientRenameLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE_RENAME_CODES.has(code)
}

/** Appends retry diagnostics to the thrown error so transient locks stay distinguishable from permission faults. */
function annotateRetryExhaustion(err: unknown, retries: number, startedAt: number): void {
  if (retries > 0 && err instanceof Error) {
    const elapsed = Date.now() - startedAt
    try {
      err.message = `${err.message} (rename target transiently locked; still failed after ${retries} retries / ${elapsed}ms)`
    } catch {
      /* preserve original error if message is read-only */
    }
  }
}

/**
 * Atomic rename replacement with bounded exponential backoff (5 -> 50ms, ~1.5s total) for transient
 * target locks, preserving the original `ErrnoException` (`code` intact) when exhausted.
 * Exported for sibling-primitive consumers (e.g. kernel `copyFilePrivate`).
 */
export async function renameAtomically(tmp: string, targetPath: string): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + RENAME_BUSY_TOTAL_MS
  let retries = 0
  for (;;) {
    try {
      await fsp.rename(tmp, targetPath)
      return
    } catch (err) {
      if (!isTransientRenameLock(err) || Date.now() >= deadline) {
        annotateRetryExhaustion(err, retries, startedAt)
        throw err
      }
      const delayMs = Math.min(RENAME_BUSY_MAX_POLL_MS, RENAME_BUSY_INITIAL_POLL_MS * 2 ** retries)
      retries += 1
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function sleepSyncMs(ms: number): void {
  // `Atomics.wait` is the only true synchronous sleep in JavaScript: it parks the current thread
  // without yielding to the event loop, which is exactly what the sync hot path (plugin-build client
  // compiler artifact writes) needs between rename retries. Unlike browsers, Node.js permits it on
  // the main thread; the park is bounded by RENAME_BUSY_TOTAL_MS and only ever entered on transient
  // rename contention, so the block is short, rare, and self-terminating.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Sync twin of `renameAtomically` for callers that cannot await (compiler hot path). */
function renameAtomicallySync(tmp: string, targetPath: string): void {
  const startedAt = Date.now()
  const deadline = startedAt + RENAME_BUSY_TOTAL_MS
  let retries = 0
  for (;;) {
    try {
      fs.renameSync(tmp, targetPath)
      return
    } catch (err) {
      if (!isTransientRenameLock(err) || Date.now() >= deadline) {
        annotateRetryExhaustion(err, retries, startedAt)
        throw err
      }
      const delayMs = Math.min(RENAME_BUSY_MAX_POLL_MS, RENAME_BUSY_INITIAL_POLL_MS * 2 ** retries)
      retries += 1
      sleepSyncMs(delayMs)
    }
  }
}

/** Hidden sibling temp name: unique per write, dot-prefixed so directory scans skip crash leftovers. */
function tempPathFor(path: string): string {
  return join(dirname(path), `.${randomUUID()}.tmp`)
}

/**
 * Atomic file write (async): temp (random UUID, `mode` default 0600) -> fsync -> forced chmod (POSIX)
 * -> rename with bounded transient-lock retry. Crashes never half-truncate; failures clean the temp.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  const mode = opts?.mode ?? 0o600
  const handle = await fsp.open(tmp, 'w', mode)
  let handleClosed = false
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
      // The rename below carries this temp inode (and its mode) to the target; forcing the mode
      // explicitly keeps a restrictive umask from weakening the requested permission.
      if (process.platform !== 'win32') await handle.chmod(mode)
    } finally {
      await handle.close()
      handleClosed = true
    }
    await renameAtomically(tmp, path)
  } catch (err) {
    if (!handleClosed) await handle.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Atomic file write (sync): same semantics as `atomicWriteFile` for hot paths that cannot await
 * (plugin-build client compiler artifact writes). Blocks only on transient rename contention.
 */
export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  const mode = opts?.mode ?? 0o600
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    if (process.platform !== 'win32') fs.fchmodSync(fd, mode)
    fs.closeSync(fd)
    fd = undefined
    renameAtomicallySync(tmp, path)
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore close failure so the original error propagates */
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure so the original error propagates */
    }
    throw err
  }
}

/** Atomic JSON write (UTF-8, 2-space indent, trailing newline for deterministic human diffs). */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'
  await atomicWriteFile(path, text, opts)
}
