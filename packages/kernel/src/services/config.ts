/**
 * config.json 配置服务：按真实文件路径共享的进程内串行化读改写，
 * 防止多个模块（含各自 new 出的实例）并发覆盖彼此的键。
 * 机密内容（密码哈希之外的 secret 明文）不得写入本文件，由 credentials.json 承载。
 */
import { join } from 'node:path'
import {
  atomicWriteJson,
  readJsonFileOptional,
} from './atomic-file.js'
import { withFileLock } from './file-lock.js'

type Json = Record<string, unknown>

export class ConfigService {
  private readonly path: string

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

  /**
   * 串行化原子更新：在最新内容基础上套用 patch，保留其他键。
   * 锁以 config.json 真实路径为 key，跨实例共享；update 全过程（读→改→写）
   * 都在锁内，杜绝并发读到同一旧配置后互相覆盖。
   */
  update(patch: Json): Promise<Json> {
    return withFileLock(this.path, async () => {
      const current = await this.get()
      const next = { ...current, ...patch }
      await atomicWriteJson(this.path, next)
      return next
    })
  }
}
