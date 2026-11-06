/**
 * ProviderService：管理 providers.json（自定义模型网关清单）。
 * 铁律：本文件绝不包含密钥字段；API Key 一律经 CredentialService 存
 * credentials.json。结构校验在边界完成，密钥字段显式剥离/拒绝。
 * ProviderConfig 形状以 @helm/protocol 为准。
 */
import type { ProviderConfig } from '@helm/protocol'

export type { ProviderConfig }
import { join } from 'node:path'
import { atomicWriteJson, readJsonFileOptional } from './atomic-file.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** provider id 边界校验：字母数字开头，防路径符号跨目录。 */
export function assertProviderId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`非法 provider id: ${id}`)
  }
}

/** 边界校验单个 provider 配置；出现密钥字段直接拒绝（防止密钥混入 JSON）。 */
export function validateProviderConfig(input: unknown): ProviderConfig {
  if (!isPlainObject(input)) throw new Error('provider 配置必须是对象')
  for (const banned of ['apiKey', 'api_key', 'secret', 'token', 'password', 'credential']) {
    if (input[banned] !== undefined) {
      throw new Error(
        `provider 配置禁止包含密钥字段 '${banned}'（密钥请存 credentials.json）`,
      )
    }
  }
  const rawId = input['id']
  if (typeof rawId !== 'string') {
    throw new Error(`provider id 必须是字符串: ${String(rawId)}`)
  }
  assertProviderId(rawId)
  const id: string = rawId
  const protocol = input['protocol']
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new Error(`provider '${id}' protocol 必须是 'openai' | 'anthropic'`)
  }
  const baseUrl = input['baseUrl']
  if (typeof baseUrl !== 'string' || !/^https?:\/\/.+/.test(baseUrl)) {
    throw new Error(`provider '${id}' baseUrl 必须是 http(s) URL`)
  }
  const baseUrlStr: string = baseUrl
  const models = input['models']
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((m) => typeof m !== 'string' || m === '')
  ) {
    throw new Error(`provider '${id}' models 必须是非空字符串数组`)
  }
  const modelIds = models as string[]
  const enabled = input['enabled']
  if (typeof enabled !== 'boolean') {
    throw new Error(`provider '${id}' enabled 必须是布尔值`)
  }
  const label = input['label']
  if (label !== undefined && (typeof label !== 'string' || label === '')) {
    throw new Error(`provider '${id}' label 必须是非空字符串`)
  }
  const config: ProviderConfig = { id, protocol, baseUrl: baseUrlStr, models: [...modelIds], enabled }
  if (typeof label === 'string') config.label = label
  return config
}

function normalize(raw: unknown): ProviderConfig[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) throw new Error('providers.json 结构非法（应为对象）')
  const list = raw['providers']
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('providers.json providers 字段必须是数组')
  return list.map((item) => validateProviderConfig(item))
}

export class ProviderService {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.path = join(dataDir, 'providers.json')
  }

  async list(): Promise<ProviderConfig[]> {
    return normalize(await readJsonFileOptional(this.path))
  }

  async get(id: string): Promise<ProviderConfig | undefined> {
    assertProviderId(id)
    return (await this.list()).find((p) => p.id === id)
  }

  /** 全量保存（HTTP 代理预定 save(array) 全量语义：逐项校验后整体落盘）。 */
  async save(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
    if (!Array.isArray(providers)) throw new Error('providers 必须是数组')
    const validated = providers.map((p) => validateProviderConfig(p))
    const ids = new Set<string>()
    for (const p of validated) {
      if (ids.has(p.id)) throw new Error(`provider id 重复: ${p.id}`)
      ids.add(p.id)
    }
    await this.enqueue(async () => {
      await atomicWriteJson(this.path, { providers: validated })
    })
    return validated
  }

  /** 删除单个 provider；不存在时抛错（不静默成功）。 */
  async delete(id: string): Promise<void> {
    assertProviderId(id)
    await this.enqueue(async () => {
      const current = normalize(await readJsonFileOptional(this.path))
      const next = current.filter((p) => p.id !== id)
      if (next.length === current.length) {
        throw new Error(`provider 不存在: ${id}`)
      }
      await atomicWriteJson(this.path, { providers: next })
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}
