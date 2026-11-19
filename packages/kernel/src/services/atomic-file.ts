/**
 * Atomic file writes and safe reads with contextual error messages.
 * Write path delegates to the shared `@helmx/env-io` primitive (`atomicWriteFile` / `atomicWriteJson`):
 * hidden temp file (random UUID + 0600, forced against umask) -> fsync -> rename with bounded
 * transient-lock retry, so crashes never half-truncate and credentials never leak permissions
 * via temp files.
 */
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameAtomically } from '@helmx/env-io'

export { atomicWriteFile, atomicWriteJson } from '@helmx/env-io'

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
