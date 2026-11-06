/**
 * config.json 配置服务：串行化读改写，避免多个模块并发覆盖彼此的键。
 * 机密内容（密码哈希之外的 secret 明文）不得写入本文件，由 credentials.json 承载。
 */
import { join } from 'node:path'
import {
  atomicWriteJson,
  readJsonFileOptional,
} from './atomic-file.js'

type Json = Record<string, unknown>

export class ConfigService {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.path = join(dataDir, 'config.json')
  }

  /** 读取当前配置（无文件返回空对象；损坏 JSON 显式抛错，不静默重置）。 */
  async get(): Promise<Json> {
    const value = await readJsonFileOptional(this.path)
    if (value === undefined) return {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`config.json 结构非法（应为对象）: ${this.path}`)
    }
    return value as Json
  }

  /** 串行化原子更新：在最新内容基础上套用 patch，保留其他键。 */
  update(patch: Json): Promise<Json> {
    return this.enqueue(async () => {
      const current = await this.get()
      const next = { ...current, ...patch }
      await atomicWriteJson(this.path, next)
      return next
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}
