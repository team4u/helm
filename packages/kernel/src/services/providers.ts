/**
 * ProviderService: manage providers.json(self define model gateway manifest).
 * iron rule: this file never contains secret key field;API Key one rule via CredentialService store
 * credentials.json. structure validate in boundary complete, secret key field explicit strip/reject.
 * ProviderConfig shape with @helm/protocol is allow.
 */
import type { ProviderConfig } from '@helm/protocol'

export type { ProviderConfig }
import { join } from 'node:path'
import { atomicWriteJson, readJsonFileOptional } from './atomic-file.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** provider id boundary validate: character parent number open head, guard against path symbol across directory. */
export function assertProviderId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`illegal provider id: ${id}`)
  }
}

/** boundary validate single provider config; appear secret key field directly reject (guard against secret key mix JSON). */
export function validateProviderConfig(input: unknown): ProviderConfig {
  if (!isPlainObject(input)) throw new Error('provider config must be object')
  for (const banned of ['apiKey', 'api_key', 'secret', 'token', 'password', 'credential']) {
    if (input[banned] !== undefined) {
      throw new Error(
        `provider config forbidden contains secret key field '${banned}'(secret key please store credentials.json)`,
      )
    }
  }
  const rawId = input['id']
  if (typeof rawId !== 'string') {
    throw new Error(`provider id must be string: ${String(rawId)}`)
  }
  assertProviderId(rawId)
  const id: string = rawId
  const protocol = input['protocol']
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new Error(`provider '${id}' protocol must be 'openai' | 'anthropic'`)
  }
  const baseUrl = input['baseUrl']
  if (typeof baseUrl !== 'string' || !/^https?:\/\/.+/.test(baseUrl)) {
    throw new Error(`provider '${id}' baseUrl must be http(s) URL`)
  }
  const baseUrlStr: string = baseUrl
  const models = input['models']
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((m) => typeof m !== 'string' || m === '')
  ) {
    throw new Error(`provider '${id}' models must be non-empty string array`)
  }
  const modelIds = models as string[]
  const enabled = input['enabled']
  if (typeof enabled !== 'boolean') {
    throw new Error(`provider '${id}' enabled must be boolean value`)
  }
  const label = input['label']
  if (label !== undefined && (typeof label !== 'string' || label === '')) {
    throw new Error(`provider '${id}' label must be non-empty string`)
  }
  const config: ProviderConfig = { id, protocol, baseUrl: baseUrlStr, models: [...modelIds], enabled }
  if (typeof label === 'string') config.label = label
  return config
}

function normalize(raw: unknown): ProviderConfig[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) throw new Error('providers.json structure illegal (should be object)')
  const list = raw['providers']
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('providers.json providers field must be array')
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

  /** all amount save (HTTP proxy pre- set save(array) all amount semantics: one by one items validate after whole). */
  async save(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
    if (!Array.isArray(providers)) throw new Error('providers must be array')
    const validated = providers.map((p) => validateProviderConfig(p))
    const ids = new Set<string>()
    for (const p of validated) {
      if (ids.has(p.id)) throw new Error(`provider id duplicate: ${p.id}`)
      ids.add(p.id)
    }
    await this.enqueue(async () => {
      await atomicWriteJson(this.path, { providers: validated })
    })
    return validated
  }

  /** delete single provider; missing when throws (not silently succeeded). */
  async delete(id: string): Promise<void> {
    assertProviderId(id)
    await this.enqueue(async () => {
      const current = normalize(await readJsonFileOptional(this.path))
      const next = current.filter((p) => p.id !== id)
      if (next.length === current.length) {
        throw new Error(`provider missing: ${id}`)
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
