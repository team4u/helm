/**
 * `config.json` service: serializes in-process reads/writes by canonical real file path,
 * preventing multiple modules (including freshly instantiated `ConfigService` objects) from
 * overwriting each other's keys or colliding between concurrent reads and renames.
 * Secrets (other than password hashes) must never be written here; they belong in `credentials.json`.
 */
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicWriteJson,
  readJsonFileOptional,
} from './atomic-file.js'
import { withFileLock } from './file-lock.js'

type Json = Record<string, unknown>
type InvalidationListener = (canonicalPath: string) => void

/**
 * Shared write-generation counters and invalidation listeners keyed by canonical path:
 * incremented on every successful `updateBy` write or `invalidateCache`, allowing upstream caches
 * (like `AuthService`) to validate snapshots with zero syscalls and match generations inside the
 * lock to prevent concurrent dirty backfills.
 */
const configGenerations = new Map<string, number>()
const invalidationListeners = new Set<InvalidationListener>()

/** Register config invalidation listener (module-level registry so `AuthService` can clear snapshots without per-instance leaks). */
export function onConfigInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

function bumpGeneration(canonicalPath: string): number {
  const next = (configGenerations.get(canonicalPath) ?? 0) + 1
  configGenerations.set(canonicalPath, next)
  for (const listener of invalidationListeners) {
    try {
      listener(canonicalPath)
    } catch {
      /* cache invalidation notifications must not break the primary write path */
    }
  }
  return next
}

export class ConfigService {
  private readonly dataDir: string
  private readonly path: string
  /** Canonical path cached after first resolution so hot paths don't open Windows directory handles on every `realpath`. */
  private canonicalPathCache: string | undefined

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.path = join(dataDir, 'config.json')
  }

  /** Resolve real path to `config.json` under `dataDir`; returns undefined if `dataDir` does not exist yet. */
  async getCanonicalPath(): Promise<string | undefined> {
    if (this.canonicalPathCache !== undefined) return this.canonicalPathCache
    const realDir = await realpath(this.dataDir).catch(() => undefined)
    if (realDir === undefined) return undefined
    this.canonicalPathCache = join(realDir, 'config.json')
    return this.canonicalPathCache
  }

  /** Read the latest known write generation in memory for a canonical path (zero syscalls). */
  getGenerationSync(canonicalPath: string): number {
    return configGenerations.get(canonicalPath) ?? 0
  }

  private async readUnlocked(): Promise<Json> {
    const value = await readJsonFileOptional(this.path)
    if (value === undefined) return {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`invalid config.json structure (expected object): ${this.path}`)
    }
    return value as Json
  }

  /**
   * Read current config (returns `{}` if missing; corrupt JSON throws explicitly rather than resetting silently).
   * Shares the in-process file lock with `updateBy` so read handles don't collide with atomic renames.
   */
  get(): Promise<Json> {
    return withFileLock(this.path, () => this.readUnlocked())
  }

  /** Atomically read config paired with its write generation inside the lock (for upstream cache backfill guards). */
  getWithGeneration(): Promise<{
    config: Json
    generation: number
    canonicalPath: string | undefined
  }> {
    return withFileLock(this.path, async () => {
      const config = await this.readUnlocked()
      const canonicalPath = await this.getCanonicalPath()
      const generation =
        canonicalPath !== undefined ? (configGenerations.get(canonicalPath) ?? 0) : 0
      return { config, generation, canonicalPath }
    })
  }

  /** Invalidate upstream derived caches after external edits/deletes of `config.json` (enters the same file lock to serialize with reads). */
  invalidateCache(): Promise<void> {
    return withFileLock(this.path, async () => {
      const prev = this.canonicalPathCache
      this.canonicalPathCache = undefined
      const current = await this.getCanonicalPath()
      if (prev !== undefined && prev !== current) bumpGeneration(prev)
      if (current !== undefined) bumpGeneration(current)
    })
  }

  /**
   * Serialized atomic update: object patches shallow-merge onto the latest content while keeping other keys;
   * function arguments delegate to `updateBy` (in-lock read-modify-write callback).
   * Locking by `config.json` canonical path across instances places the whole `read -> modify -> write` inside
   * one critical section, preventing concurrent stale-snapshot overwrites.
   * Dispatching objects vs functions explicitly is mandatory: spreading a function as `{ ...fn }` has no
   * enumerable properties and would silently drop all callback changes.
   */
  update(patch: Json | ((current: Json) => Json)): Promise<Json> {
    return typeof patch === 'function'
      ? this.updateBy(patch)
      : this.updateBy((current) => ({ ...current, ...patch }))
  }

  /**
   * Callback-style read-modify-write: `mutate` runs synchronously inside the lock against the freshest disk
   * state with zero gap between read and write, preventing stale snapshots outside the lock from overwriting
   * concurrent updates—callers never observe stale `current`. `mutate` must be synchronous and return the
   * next value directly (async side effects are not covered by the lock).
   */
  updateBy(mutate: (current: Json) => Json): Promise<Json> {
    return withFileLock(this.path, async () => {
      const current = await this.readUnlocked()
      const next = mutate(current)
      await atomicWriteJson(this.path, next)
      const key = await this.getCanonicalPath()
      if (key !== undefined) bumpGeneration(key)
      return next
    })
  }
}
