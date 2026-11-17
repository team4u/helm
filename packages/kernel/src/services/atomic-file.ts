/**
 * Atomic file writes and safe reads with contextual error messages.
 * Write path: temp file (random UUID name + 0600) -> fsync -> rename so crashes never half-truncate;
 * 0600 ensures credentials and secrets never leak permissions via temp files.
 */
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Bounded backoff parameters when Windows target rename hits transient file locks (concurrent reads / AV / indexer). */
const RENAME_BUSY_TOTAL_MS = 1_500
const RENAME_BUSY_INITIAL_POLL_MS = 5
const RENAME_BUSY_MAX_POLL_MS = 50

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`file not found: ${path}`)
    this.name = 'FileNotFoundError'
  }
}

export class FileParseError extends Error {
  constructor(
    path: string,
    public readonly cause: unknown,
  ) {
    super(`failed to parse JSON in ${path}: ${String(cause)}`)
    this.name = 'FileParseError'
  }
}

/**
 * Windows transient-busy check: renaming over a file being read/scanned briefly returns EPERM/EACCES/EBUSY,
 * which succeeds after bounded backoff. On other platforms these codes indicate real permission/mount faults.
 */
function isTransientRenameBusy(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * Atomic rename replacement; applies exponential backoff (5 -> 50ms, ~1.5s total) only for Windows
 * transient busy locks, preserving the original ErrnoException (`code` intact) when exhausted and
 * appending retry diagnostics to distinguish transient locks from permission failures.
 */
async function renameAtomically(tmp: string, targetPath: string): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + RENAME_BUSY_TOTAL_MS
  let retries = 0
  for (;;) {
    try {
      await fsp.rename(tmp, targetPath)
      return
    } catch (err) {
      if (!isTransientRenameBusy(err) || Date.now() >= deadline) {
        if (retries > 0 && err instanceof Error) {
          const elapsed = Date.now() - startedAt
          try {
            err.message = `${err.message} (Windows target file transiently locked; still failed after ${retries} retries / ${elapsed}ms)`
          } catch {
            /* preserve original error if message is read-only */
          }
        }
        throw err
      }
      const delayMs = Math.min(RENAME_BUSY_MAX_POLL_MS, RENAME_BUSY_INITIAL_POLL_MS * 2 ** retries)
      retries += 1
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** Atomic file write: temp (random UUID, 0600) -> fsync -> rename; unique temp names prevent concurrent collisions. */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  const mode = opts?.mode ?? 0o600
  const handle = await fsp.open(tmp, 'w', mode)
  let handleClosed = false
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
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

/** Atomic JSON write (UTF-8, 2-space indent, deterministic key formatting for human diffs). */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'
  await atomicWriteFile(path, text, opts)
}

/** Read UTF-8 text; missing files throw `FileNotFoundError` with path (never returns empty silently). */
export async function readTextFile(path: string): Promise<string> {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch (err) {
    if (isNoSuchFileError(err)) throw new FileNotFoundError(path)
    throw err
  }
}

/** Read and parse JSON; missing files throw `FileNotFoundError`, corrupt JSON throws `FileParseError` (both include path). */
export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readTextFile(path)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new FileParseError(path, err)
  }
}

/** Read optional JSON: missing files return undefined, corrupt JSON still throws `FileParseError` honestly. */
export async function readJsonFileOptional(path: string): Promise<unknown> {
  try {
    return await readJsonFile(path)
  } catch (err) {
    if (err instanceof FileNotFoundError) return undefined
    throw err
  }
}

/** Copy file securely (enforces 0600 on destination; used when ingesting artifact source files). */
export async function copyFilePrivate(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.${randomUUID()}.tmp`)
  try {
    await fsp.copyFile(src, tmp)
    await renameAtomically(tmp, dest)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  // Rename preserves source file permissions; force 0600 on secret boundaries (POSIX chmod is meaningless on Windows).
  if (process.platform !== 'win32') {
    const handle = await fsp.open(dest, 'r')
    try {
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
  }
}

/**
 * Determine whether a file's current permissions exclude group/other access (i.e. private).
 *
 * Windows NTFS/ACLs do not map POSIX group/other bits (`stat.mode` only reflects read-only, making 0600
 * checks unavailable), so treat Windows files as private (consistent with `node/doctor.ts`).
 * Non-Windows platforms enforce strictly: any group/other bits set counts as non-private.
 */
export async function isPrivateMode(path: string): Promise<boolean> {
  // Stat even on Windows before returning, so missing files or permission errors never pass silently as private.
  const s = await fsp.stat(path)
  if (process.platform === 'win32') return true
  return (s.mode & 0o077) === 0
}

function isNoSuchFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}
