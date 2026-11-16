/**
 * config.json 配置服务：按真实文件路径共享的进程内串行化读写，
 * 防止多个模块（含各自 new 出的实例）并发覆盖彼此的键，或同进程读写撞上 rename。
 * 机密内容（密码哈希之外的 secret 明文）不得写入本文件，由 credentials.json 承载。
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
 * 按归一化真实路径共享的写入代数与失效监听：
 * 每次 updateBy 写盘成功或 invalidateCache 时递增，供 AuthService 等上层缓存
 * 以零系统调用判定快照有效性，并在锁内原子配对防并发脏回填。
 */
const configGenerations = new Map<string, number>()
const invalidationListeners = new Set<InvalidationListener>()

/** 注册配置失效监听（模块级注册，供 AuthService 清理快照，避免 per-instance 泄漏）。 */
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
      /* 缓存失效通知不阻断主写路径 */
    }
  }
  return next
}

export class ConfigService {
  private readonly dataDir: string
  private readonly path: string
  /** 首次成功解析后的规范路径缓存，避免热路径每次调 realpath 在 Windows 上开目录句柄。 */
  private canonicalPathCache: string | undefined

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.path = join(dataDir, 'config.json')
  }

  /** 获取当前 dataDir 对应 config.json 的真实路径；目录尚不存在返回 undefined。 */
  async getCanonicalPath(): Promise<string | undefined> {
    if (this.canonicalPathCache !== undefined) return this.canonicalPathCache
    const realDir = await realpath(this.dataDir).catch(() => undefined)
    if (realDir === undefined) return undefined
    this.canonicalPathCache = join(realDir, 'config.json')
    return this.canonicalPathCache
  }

  /** 纯内存读取指定规范路径的最新已知代数（零系统调用）。 */
  getGenerationSync(canonicalPath: string): number {
    return configGenerations.get(canonicalPath) ?? 0
  }

  private async readUnlocked(): Promise<Json> {
    const value = await readJsonFileOptional(this.path)
    if (value === undefined) return {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`config.json 结构非法（应为对象）: ${this.path}`)
    }
    return value as Json
  }

  /**
   * 读取当前配置（无文件返回空对象；损坏 JSON 显式抛错，不静默重置）。
   * 纳入与 updateBy 同一把进程内文件锁，防止同进程内读句柄撞上写入 rename。
   */
  get(): Promise<Json> {
    return withFileLock(this.path, () => this.readUnlocked())
  }

  /** 锁内原子配对读取配置与写入代数（供上层快照缓存防并发脏回填）。 */
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

  /** 外部手动改写/删除 config.json 后失效上层派生缓存（进同一文件锁保证与读取原子排序）。 */
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
   * 串行化原子更新：对象 patch 在最新内容基础上浅合并，保留其他键；
   * 传入函数则等价 updateBy（锁内读改写回调）。
   * 锁以 config.json 真实路径为 key，跨实例共享；update 全过程（读→改→写）
   * 都在锁内，杜绝并发读到同一旧配置后互相覆盖。
   * 对象与函数分流是必须的：函数被当对象展开无可枚举属性，会静默丢弃
   * 全部回调改动（诚实性纪律——显式拒绝而不是静默丢写）。
   */
  update(patch: Json | ((current: Json) => Json)): Promise<Json> {
    return typeof patch === 'function'
      ? this.updateBy(patch)
      : this.updateBy((current) => ({ ...current, ...patch }))
  }

  /**
   * 回调形态读改写：mutate 在锁内基于最新磁盘状态同步执行，读写同锁无间隙。
   * 跨实例并发写不再可能被调用方锁外的旧快照覆盖——调用方永远看不到
   * 陈旧 current。mutate 必须同步：返回值直接落盘，异步副作用不在保证范围。
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
