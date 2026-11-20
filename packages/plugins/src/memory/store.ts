/**
 * MemoryStore: the MEMORY.md file storage owned by the builtin:memory plugin.
 *
 * - Manages reads/writes and initialization of `<dataDir>/profiles/<profileId>/MEMORY.md`;
 * - Obtains the Profile directory, file lock, and atomic-write capability through public host ports,
 *   serialized by real path within the same Hub process, atomically flushed;
 * - Every write path enforces a uniform 64_000-character cap on the **merged** final content inside the file lock:
 *   concurrent calls cannot each "pre-read the old value + pass the check" and stack past the cap;
 *   over the limit it throws HelmxError('memory_limit_exceeded', 400) explicitly, never writing half a file.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HelmxError, type HelmxHostApi } from '@helmx/protocol'

type MemoryFileHost = Pick<HelmxHostApi, 'profiles' | 'withFileLock' | 'atomicWriteFile'>

async function readMemoryFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelmxError('not_found', `memory file does not exist: ${path}`, 404, { path })
    }
    throw error
  }
}

/** Content hash for the dream CAS (hex sha256 over utf-8; purely internal comparison key). */
function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** The builtin:memory plugin ID. */
export const MEMORY_PLUGIN_ID = 'builtin:memory' as const

/**
 * The MEMORY.md long-term-memory character cap (the single source of truth of this line of defense):
 * long-term memory is injected wholesale into the system prompt every turn; without a cap, per-call cost would grow unboundedly.
 */
export const MAX_MEMORY_CHARS = 64_000

/** Initial default content (a legal placeholder skeleton before the first memory). */
export const MEMORY_DEFAULT = ['# Memory', '', ''].join('\n')

/** The uniform over-limit rejection error. */
function memoryLimitError(
  profileId: string,
  wouldBe: number,
  mode: 'append' | 'replace',
  inputLength: number,
): HelmxError {
  return new HelmxError(
    'memory_limit_exceeded',
    `MEMORY.md would reach ${wouldBe} chars after the write, over the cap of ${MAX_MEMORY_CHARS}; please trim before writing (use a full replace to consolidate long-term memory)`,
    400,
    { profileId, wouldBe, limit: MAX_MEMORY_CHARS, mode, inputLength },
  )
}

export class MemoryStore {
  constructor(private readonly host: MemoryFileHost) {}

  private async memoryPath(profileId: string): Promise<string> {
    return join(await this.host.profiles.directory(profileId), 'MEMORY.md')
  }

  /**
   * Check and initialize MEMORY.md inside the file lock: write MEMORY_DEFAULT when absent.
   * Returns the current full text (returned as-is when it exists, never overwriting user content).
   */
  async ensureMemory(profileId: string): Promise<string> {
    const path = await this.memoryPath(profileId)
    return this.host.withFileLock(path, async () => {
      const current = await readMemoryFile(path).catch((err: unknown) => {
        if (err instanceof HelmxError && err.code === 'not_found') return undefined
        throw err
      })
      if (current !== undefined) return current
      await this.host.atomicWriteFile(path, MEMORY_DEFAULT)
      return MEMORY_DEFAULT
    })
  }

  /** Read the full text; a missing file throws not_found (callers distinguish lazy init from accidental deletion). */
  async getMemory(profileId: string): Promise<string> {
    return readMemoryFile(await this.memoryPath(profileId))
  }

  /** Read the full text together with its content hash (the CAS baseline for the dream write-back). */
  async readMemoryWithHash(profileId: string): Promise<{ content: string; hash: string }> {
    const content = await readMemoryFile(await this.memoryPath(profileId))
    return { content, hash: hashOf(content) }
  }

  /**
   * Atomically update MEMORY.md: replace swaps the whole content; append appends (keeping the trailing newline).
   * The append read-modify-write is serialized by an in-process shared lock on the file's real path.
   * The cap is enforced uniformly on the merged final content inside the lock (the single authoritative point).
   */
  async updateMemory(
    profileId: string,
    text: string,
    mode: 'append' | 'replace',
  ): Promise<string> {
    if (typeof text !== 'string') throw new Error('memory text must be a string')
    const path = await this.memoryPath(profileId)
    return this.host.withFileLock(path, async () => {
      let next: string
      if (mode === 'replace') {
        next = text
      } else {
        let current = ''
        try {
          current = await readMemoryFile(path)
        } catch (err) {
          if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
          // When MEMORY.md is missing, append starts from empty (the next write self-heals it).
        }
        next = current.endsWith('\n') || current === '' ? current + text : current + '\n' + text
      }
      if (next.length > MAX_MEMORY_CHARS) {
        throw memoryLimitError(profileId, next.length, mode, text.length)
      }
      await this.host.atomicWriteFile(path, next)
      return next
    })
  }

  /**
   * Dream CAS write-back: re-read + hash + cap check + atomic write all inside the SAME file lock
   * (never "check outside, write inside"). The current content is re-read inside the closure and
   * must hash exactly to expectedHash (captured when the dream started); a mismatch or a vanished
   * file resolves { applied: false } without writing — the caller keeps candidates and diagnostics
   * and never clobbers a concurrent human edit. The 64k cap is re-enforced on the final text here
   * as the last authoritative gate before the atomic write.
   *
   * `opts.guard` (policy from the dream engine, evaluated by the mechanism here): re-checked inside
   * the lock AFTER the hash re-validation and immediately before the write — a per-Profile memory
   * switch flipped while this call was waiting for the lock still resolves { applied: false,
   * guarded: true } without writing (distinct from a hash conflict).
   */
  async commitDreamMemory(
    profileId: string,
    expectedHash: string,
    next: string,
    opts?: { guard?: () => boolean },
  ): Promise<{ applied: boolean; guarded?: boolean }> {
    if (typeof next !== 'string') throw new Error('memory text must be a string')
    const path = await this.memoryPath(profileId)
    return this.host.withFileLock(path, async () => {
      let current: string
      try {
        current = await readMemoryFile(path)
      } catch (err) {
        if (err instanceof HelmxError && err.code === 'not_found') return { applied: false }
        throw err
      }
      if (hashOf(current) !== expectedHash) return { applied: false }
      if (opts?.guard !== undefined && !opts.guard()) return { applied: false, guarded: true }
      if (next.length > MAX_MEMORY_CHARS) {
        throw memoryLimitError(profileId, next.length, 'replace', next.length)
      }
      await this.host.atomicWriteFile(path, next)
      return { applied: true }
    })
  }
}
