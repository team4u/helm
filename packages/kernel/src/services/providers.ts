/**
 * ProviderService: manages providers.json (custom model gateway manifest).
 * Iron rule: this file must never contain secret fields; API keys are stored exclusively in
 * credentials.json via CredentialService. Structural validation happens at the boundary, and secret fields are explicitly stripped/rejected.
 * ProviderConfig shape conforms to @helmx/protocol.
 */
import { isJsonObject, type ProviderConfig } from '@helmx/protocol'

export type { ProviderConfig }
import { join } from 'node:path'
import { atomicWriteJson, readJsonFileOptional } from './atomic-file.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Provider ID boundary validation: must start with an alphanumeric character to prevent path traversal across directories. */
function assertProviderId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`illegal provider id: ${id}`)
  }
}

/** Validate a single provider config at the boundary; immediately reject any secret fields (prevents secrets leaking into JSON). */
function validateProviderConfig(input: unknown): ProviderConfig {
  if (!isJsonObject(input)) throw new Error('provider config must be an object')
  for (const banned of ['apiKey', 'api_key', 'secret', 'token', 'password', 'credential']) {
    if (input[banned] !== undefined) {
      throw new Error(
        `provider config must not contain secret field '${banned}' (store secrets in credentials.json)`,
      )
    }
  }
  const rawId = input['id']
  if (typeof rawId !== 'string') {
    throw new Error(`provider id must be a string: ${String(rawId)}`)
  }
  assertProviderId(rawId)
  const id: string = rawId
  const protocol = input['protocol']
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new Error(`provider '${id}' protocol must be 'openai' | 'anthropic'`)
  }
  const baseUrl = input['baseUrl']
  if (typeof baseUrl !== 'string' || !/^https?:\/\/.+/.test(baseUrl)) {
    throw new Error(`provider '${id}' baseUrl must be an http(s) URL`)
  }
  const baseUrlStr: string = baseUrl
  const models = input['models']
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((m) => typeof m !== 'string' || m === '')
  ) {
    throw new Error(`provider '${id}' models must be a non-empty string array`)
  }
  const modelIds = models as string[]
  const enabled = input['enabled']
  if (typeof enabled !== 'boolean') {
    throw new Error(`provider '${id}' enabled must be a boolean`)
  }
  const label = input['label']
  if (label !== undefined && (typeof label !== 'string' || label === '')) {
    throw new Error(`provider '${id}' label must be a non-empty string`)
  }
  const config: ProviderConfig = { id, protocol, baseUrl: baseUrlStr, models: [...modelIds], enabled }
  if (typeof label === 'string') config.label = label
  return config
}

function normalize(raw: unknown): ProviderConfig[] {
  if (raw === undefined) return []
  if (!isJsonObject(raw)) throw new Error('providers.json structure is invalid (expected an object)')
  const list = raw['providers']
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('providers.json providers field must be an array')
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

  /** Full save (matches HTTP PUT save(array) semantics: validate every item before writing atomically). */
  async save(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
    if (!Array.isArray(providers)) throw new Error('providers must be an array')
    const validated = providers.map((p) => validateProviderConfig(p))
    const ids = new Set<string>()
    for (const p of validated) {
      if (ids.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`)
      ids.add(p.id)
    }
    await this.enqueue(async () => {
      await atomicWriteJson(this.path, { providers: validated })
    })
    return validated
  }

  /** Delete a single provider; throws if not found (never succeeds silently). */
  async delete(id: string): Promise<void> {
    assertProviderId(id)
    await this.enqueue(async () => {
      const current = normalize(await readJsonFileOptional(this.path))
      const next = current.filter((p) => p.id !== id)
      if (next.length === current.length) {
        throw new Error(`provider not found: ${id}`)
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
