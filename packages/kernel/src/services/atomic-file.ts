/**
 * atomic file write and carries boundary error information security read.
 * write path: temp file (random uuid name + 0600)→ fsync → rename, crash do not half truncate content;
 * 0600 ensure credentials etc. secret content will not via temp file leak leak permission.
 */
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows on rename replace target by read way (concurrency read/kill toxic/index) short temporary occupy when has boundary backoff parameter. */
const RENAME_BUSY_TOTAL_MS = 1_500
const RENAME_BUSY_INITIAL_POLL_MS = 5
const RENAME_BUSY_MAX_POLL_MS = 50

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`file missing: ${path}`)
    this.name = 'FileNotFoundError'
  }
}

export class FileParseError extends Error {
  constructor(
    path: string,
    public readonly cause: unknown,
  ) {
    super(`JSON failed to parse: ${path}: ${String(cause)}`)
    this.name = 'FileParseError'
  }
}

/**
 * Windows instantaneous occupy decide: target by read/scan during rename will short temporary EPERM/EACCES/EBUSY,
 * has boundary backoff retry i.e. can commit. other platform these code belongs to real permission/mount error, immediately failed.
 */
function isTransientRenameBusy(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * rename atomic replace; only Windows instantaneous occupy when exponential backoff (5→50ms, total window about 1.5s),
 * exhausted still keep original ErrnoException(contains code), only append retry diagnose convenient at zone permission error.
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
            err.message = `${err.message}(Windows target file instantaneous occupy, already retry ${retries} time / ${elapsed}ms still failed)`
          } catch {
            /* message cannot write when keep original error */
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

/** atomic write file:temp(random uuid, 0600) → fsync → rename.exclusive guard against concurrency heavy name. */
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

/** atomic write JSON(UTF-8,2 space shrink enter, stable key order convenient at human review and diff). */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'
  await atomicWriteFile(path, text, opts)
}

/** read UTF-8 text; missing throw FileNotFoundError(contains path, not silently return empty). */
export async function readTextFile(path: string): Promise<string> {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch (err) {
    if (isNoSuchFileError(err)) throw new FileNotFoundError(path)
    throw err
  }
}

/** read and parse JSON; missing throw FileNotFoundError, corrupt throw FileParseError(all contains path). */
export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readTextFile(path)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new FileParseError(path, err)
  }
}

/** read optional JSON: missing return undefined, corrupt still throw FileParseError(honest expose). */
export async function readJsonFileOptional(path: string): Promise<unknown> {
  try {
    return await readJsonFile(path)
  } catch (err) {
    if (err instanceof FileNotFoundError) return undefined
    throw err
  }
}

/** duplicate file (keep target 0600, used to artifacts accept source file). */
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
  // rename keep source pattern; secret boundary unify converge is 0600(POSIX chmod for Windows without intent meaning, skip).
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
 * decide path when before pattern is otherwise excludes group/other permission (i.e. private).
 *
 * Windows  NTFS/ACL do not bear load POSIX group/other ,Node stat.mode only reverse reflect
 * only read;0600 semantics unavailable, directly treated as private (and node/doctor.ts platform convention consistent).
 * non- Windows still strictly validate: pattern contains group/other i.e. non- private.
 */
export async function isPrivateMode(path: string): Promise<boolean> {
  // even if Windows do not check POSIX mode, also want first stat, avoid file disappear or permission error static default treated as private.
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
