/**
 * config.json config service: by real file path sharing process inside serial read write,
 * guard against multiple module (contains each new out instance) concurrency override each other key, or same process read write collide on rename.
 * secret content (password hash of outside secret plaintext) must not write this file, by credentials.json bear load.
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
 * by archive one real path sharing write proxy count and expires listen:
 * each time updateBy write succeeded or invalidateCache when pass increase, supply AuthService etc. on layer cache
 * with zero system invoke decide snapshot valid, and in lock inside atomic match for guard against concurrency dirty back fill.
 */
const configGenerations = new Map<string, number>()
const invalidationListeners = new Set<InvalidationListener>()

/** register config expires listen (module level register, supply AuthService clean up snapshot, avoid per-instance leak leak). */
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
      /* cache expires notify do not block assert main write path */
    }
  }
  return next
}

export class ConfigService {
  private readonly dataDir: string
  private readonly path: string
  /** first time succeeded parse after canonical path cache, avoid hot path each time tune realpath in Windows on open directory handle. */
  private canonicalPathCache: string | undefined

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.path = join(dataDir, 'config.json')
  }

  /** get when before dataDir for should config.json real path; directory still missing return undefined. */
  async getCanonicalPath(): Promise<string | undefined> {
    if (this.canonicalPathCache !== undefined) return this.canonicalPathCache
    const realDir = await realpath(this.dataDir).catch(() => undefined)
    if (realDir === undefined) return undefined
    this.canonicalPathCache = join(realDir, 'config.json')
    return this.canonicalPathCache
  }

  /** in-memory read designate canonical path most new known proxy count (zero system invoke). */
  getGenerationSync(canonicalPath: string): number {
    return configGenerations.get(canonicalPath) ?? 0
  }

  private async readUnlocked(): Promise<Json> {
    const value = await readJsonFileOptional(this.path)
    if (value === undefined) return {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`config.json structure illegal (should be object): ${this.path}`)
    }
    return value as Json
  }

  /**
   * read when before config (without file return empty object; corrupt JSON explicit throws, not silently reset).
   * accept and updateBy the same process inside file lock, guard against same process inside read handle collide on write rename.
   */
  get(): Promise<Json> {
    return withFileLock(this.path, () => this.readUnlocked())
  }

  /** lock inside atomic match for read config and write proxy count (supply on layer snapshot cache guard against concurrency dirty back fill). */
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

  /** external manually change write/delete config.json after expires on layer derive cache (enter the same file lock guarantee and read atomic sort). */
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
   * serial atomic update: object patch in most new content basis on shallow merge, keep other key;
   * pass function then etc. price updateBy(lock inside read change write call back).
   * lock with config.json real path is key, across instance sharing;update all process (read→change→write)
   * all in lock inside, eliminate concurrency read to the same old config after mutual each other override.
   * object and function stream is must: function by when object expand without can enumeration property, will static default discard
   * all call back change (honest discipline - - explicit reject while is not static default lose write).
   */
  update(patch: Json | ((current: Json) => Json)): Promise<Json> {
    return typeof patch === 'function'
      ? this.updateBy(patch)
      : this.updateBy((current) => ({ ...current, ...patch }))
  }

  /**
   * call back form read change write:mutate in lock inside based on most new disk state sync execute, read write same lock without between gap.
   * across instance concurrency write no longer may by caller lock outside old snapshot override - - caller forever see fewer than
   * stale current.mutate must sync: return value directly, async side effect do not in guarantee scope.
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
