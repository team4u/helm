/**
 * CredentialService：管理 credentials.json（恒 0600）中的模型 API Key
 * 与插件 secret。get() 仅限进程内可信调用方使用，绝不经 HTTP 暴露。
 */
import { join } from 'node:path'
import {
  FileNotFoundError,
  atomicWriteJson,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'

export interface StoredCredential {
  /** 经 SecretStash 脱敏后的值或原始值（模型 API Key 不占位，直接存值）。 */
  value: string
  createdAt: string
  updatedAt: string
}

/** credentials.json 持久化形态。 */
export interface CredentialStore {
  /** 模型网关 API Key：providerId → 值。 */
  providers: Record<string, StoredCredential>
  /** 插件 secret：pluginId → 键名 → 值。 */
  pluginSecrets: Record<string, Record<string, string>>
}

const EMPTY_STORE: CredentialStore = { providers: {}, pluginSecrets: {} }

/** providerId / pluginId 边界校验：防路径与 JSON 键注入。 */
function assertId(kind: string, id: string): void {
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${kind} 不能为空`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`非法 ${kind}: ${id}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStore(raw: unknown): CredentialStore {
  if (raw === undefined) return { providers: {}, pluginSecrets: {} }
  if (!isPlainObject(raw)) {
    throw new Error('credentials.json 结构非法（应为对象）')
  }
  const providers: Record<string, StoredCredential> = {}
  const rawProviders = raw['providers']
  if (rawProviders !== undefined) {
    if (!isPlainObject(rawProviders)) {
      throw new Error('credentials.json providers 字段结构非法')
    }
    for (const [id, value] of Object.entries(rawProviders)) {
      if (isPlainObject(value) && typeof value['value'] === 'string') {
        providers[id] = {
          value: value['value'],
          createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
          updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
        }
      }
    }
  }
  const pluginSecrets: Record<string, Record<string, string>> = {}
  const rawPlugins = raw['pluginSecrets']
  if (rawPlugins !== undefined) {
    if (!isPlainObject(rawPlugins)) {
      throw new Error('credentials.json pluginSecrets 字段结构非法')
    }
    for (const [pluginId, secrets] of Object.entries(rawPlugins)) {
      if (!isPlainObject(secrets)) continue
      const map: Record<string, string> = {}
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string') map[key] = value
      }
      pluginSecrets[pluginId] = map
    }
  }
  return { providers, pluginSecrets }
}

export class CredentialService {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, 'credentials.json')
  }

  /** 列出已配置的 providerId（只有 ID，绝不包含值）。 */
  async list(): Promise<string[]> {
    const store = await this.readStore()
    return Object.keys(store.providers).sort()
  }

  /**
   * 读取 provider API Key（仅进程内可信调用方；HTTP/CLI 不得暴露）。
   */
  async get(providerId: string): Promise<string | undefined> {
    assertId('providerId', providerId)
    const store = await this.readStore()
    return store.providers[providerId]?.value
  }

  /** 设置 provider API Key（0600 原子写，绝不回显值）。 */
  async set(providerId: string, value: string): Promise<void> {
    assertId('providerId', providerId)
    if (typeof value !== 'string' || value === '') {
      throw new Error('credential 值不能为空')
    }
    await this.enqueue(async () => {
      const store = await this.readStore()
      const existing = store.providers[providerId]
      const now = new Date().toISOString()
      store.providers[providerId] = {
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await this.persist(store)
    })
  }

  async delete(providerId: string): Promise<void> {
    assertId('providerId', providerId)
    await this.enqueue(async () => {
      const store = await this.readStore()
      if (store.providers[providerId] === undefined) {
        throw new FileNotFoundError(providerId)
      }
      delete store.providers[providerId]
      await this.persist(store)
    })
  }

  /** 读取插件 secret（仅进程内可信调用方）。 */
  async getPluginSecret(pluginId: string, key: string): Promise<string | undefined> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret 键名不能为空')
    const store = await this.readStore()
    return store.pluginSecrets[pluginId]?.[key]
  }

  /** 写入插件 secret（configSchema 中 secret:true 的字段自动落到这里）。 */
  async setPluginSecret(pluginId: string, key: string, value: string): Promise<void> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret 键名不能为空')
    if (typeof value !== 'string' || value === '') throw new Error('secret 值不能为空')
    await this.enqueue(async () => {
      const store = await this.readStore()
      const bucket = store.pluginSecrets[pluginId] ?? {}
      bucket[key] = value
      store.pluginSecrets[pluginId] = bucket
      await this.persist(store)
    })
  }

  async deletePluginSecrets(pluginId: string): Promise<void> {
    assertId('pluginId', pluginId)
    await this.enqueue(async () => {
      const store = await this.readStore()
      delete store.pluginSecrets[pluginId]
      await this.persist(store)
    })
  }

  /** 全量读取（进程内诊断/导出用；含明文，绝不外发）。 */
  async readStore(): Promise<CredentialStore> {
    const raw = await readJsonFileOptional(this.path)
    return normalizeStore(raw)
  }

  private async persist(store: CredentialStore): Promise<void> {
    // 恒 0600：机密文件权限红线。
    await atomicWriteJson(this.path, store, { mode: 0o600 })
  }

  /** 串行化读改写，防止并发 set/delete 互相覆盖。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** 暴露路径常量供权限断言（不读取内容）。 */
export function credentialsPath(dataDir: string): string {
  return join(dataDir, 'credentials.json')
}

/** 仅读文本（测试断言明文不落其他文件时使用）。 */
export async function readRawText(path: string): Promise<string> {
  return readTextFile(path)
}
