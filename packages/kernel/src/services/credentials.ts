/**
 * CredentialService: manage credentials.json(constant 0600) in model API Key
 * and plugin secret.get() only limit process inside can message caller use, never via HTTP expose.
 * read change write by credentials.json real path two-layer serial: process inside sharing queue (withFileLock)
 * + across process lock (credentials.json.lock, and CLI mutual recognize the same protocol), across instance mutual exclusion.
 */
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileNotFoundError,
  FileParseError,
  atomicWriteJson,
  isPrivateMode,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'
import { withFileLock, withProcessFileLock } from './file-lock.js'

export interface StoredCredential {
  /** via SecretStash redaction after value or original value (model API Key do not occupy, directly store value). */
  value: string
  createdAt: string
  updatedAt: string
}

/**
 * credentials.json persist form. known key with outside top-level key (such as CLI write
 * `cli: { hubUrl, token }`) original keep: this service only own providers/pluginSecrets
 * two naming empty between, must not in write back when discard other person key.
 */
export interface CredentialStore {
  providers: Record<string, StoredCredential>
  pluginSecrets: Record<string, Record<string, string>>
  /** unknown top-level key → original JSON value (write back keep do not motion). */
  [key: string]: unknown
}

/** providerId / pluginId boundary validate: guard against path and JSON key inject. */
function assertId(kind: string, id: string): void {
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${kind} cannot be empty`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`illegal ${kind}: ${id}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * validate known field since has structure:providers under each items must be contains string value object,
 * pluginSecrets under each items must be string→string mapping. structure illegal explicit throw
 * FileParseError(contains path and key name), never static default discard after override - - that will swallow user credentials.
 * unknown top-level key does not shape assume, original keep.
 */
function normalizeStore(raw: unknown, path: string): CredentialStore {
  if (raw === undefined) return { providers: {}, pluginSecrets: {} }
  if (!isPlainObject(raw)) {
    throw new FileParseError(path, 'credentials.json structure illegal (should be object)')
  }
  const providers: Record<string, StoredCredential> = {}
  const rawProviders = raw['providers']
  if (rawProviders !== undefined) {
    if (!isPlainObject(rawProviders)) {
      throw new FileParseError(path, 'credentials.json providers field structure illegal (should be object)')
    }
    for (const [id, value] of Object.entries(rawProviders)) {
      if (!isPlainObject(value)) {
        throw new FileParseError(
          path,
          `credentials.json providers.${id} structure illegal (should be { value, createdAt, updatedAt } object)`,
        )
      }
      if (typeof value['value'] !== 'string') {
        throw new FileParseError(path, `credentials.json providers.${id}.value missing or non- string`)
      }
      providers[id] = {
        value: value['value'],
        createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
        updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
      }
    }
  }
  const pluginSecrets: Record<string, Record<string, string>> = {}
  const rawPlugins = raw['pluginSecrets']
  if (rawPlugins !== undefined) {
    if (!isPlainObject(rawPlugins)) {
      throw new FileParseError(
        path,
        'credentials.json pluginSecrets field structure illegal (should be pluginId → key name → value object)',
      )
    }
    for (const [pluginId, secrets] of Object.entries(rawPlugins)) {
      if (!isPlainObject(secrets)) {
        throw new FileParseError(
          path,
          `credentials.json pluginSecrets.${pluginId} structure illegal (should be key name → string object)`,
        )
      }
      const map: Record<string, string> = {}
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value !== 'string') {
          throw new FileParseError(
            path,
            `credentials.json pluginSecrets.${pluginId}.${key} must be string`,
          )
        }
        map[key] = value
      }
      pluginSecrets[pluginId] = map
    }
  }
  const store: CredentialStore = { providers, pluginSecrets }
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'providers' && key !== 'pluginSecrets') store[key] = value
  }
  return store
}

export class CredentialService {
  private readonly path: string

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, 'credentials.json')
  }

  /** column out already config providerId(only ID, never contains value). */
  async list(): Promise<string[]> {
    const store = await this.readStore()
    return Object.keys(store.providers).sort()
  }

  /**
   * read provider API Key(only process inside can message caller;HTTP/CLI must not expose).
   */
  async get(providerId: string): Promise<string | undefined> {
    assertId('providerId', providerId)
    const store = await this.readStore()
    return store.providers[providerId]?.value
  }

  /** settings provider API Key(0600 atomic write, never back visible value). */
  async set(providerId: string, value: string): Promise<void> {
    assertId('providerId', providerId)
    if (typeof value !== 'string' || value === '') {
      throw new Error('credential value cannot be empty')
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

  /** read plugin secret(only process inside can message caller). */
  async getPluginSecret(pluginId: string, key: string): Promise<string | undefined> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret key name cannot be empty')
    const store = await this.readStore()
    return store.pluginSecrets[pluginId]?.[key]
  }

  /** write plugin secret(configSchema in secret:true field automatically to this in). */
  async setPluginSecret(pluginId: string, key: string, value: string): Promise<void> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret key name cannot be empty')
    if (typeof value !== 'string' || value === '') throw new Error('secret value cannot be empty')
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

  /**
   * precise delete single plugin secret(missing when static default succeeded: idempotent semantics, caller rollback path
   * allows duplicate clean up). the rest key and same plugin other secret do not subject to affect.
   */
  async deletePluginSecret(pluginId: string, key: string): Promise<void> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret key name cannot be empty')
    await this.enqueue(async () => {
      const store = await this.readStore()
      const bucket = store.pluginSecrets[pluginId]
      if (bucket === undefined || bucket[key] === undefined) return
      delete bucket[key]
      if (Object.keys(bucket).length === 0) delete store.pluginSecrets[pluginId]
      await this.persist(store)
    })
  }

  /** all amount read (process inside diagnose/export use; contains plaintext, never outside). */
  async readStore(): Promise<CredentialStore> {
    const raw = await readJsonFileOptional(this.path)
    const store = normalizeStore(raw, this.path)
    // read path same converge 0600: already has file by put wide permission when immediately fix, while is not etc. to under time write.
    // fix failed explicit throws, never static default carries illness return.
    if (raw !== undefined && !(await isPrivateMode(this.path))) {
      await chmod(this.path, 0o600)
      if (!(await isPrivateMode(this.path))) {
        throw new Error(`credentials.json permission fix failed (should 0600): ${this.path}`)
      }
    }
    return store
  }

  private async persist(store: CredentialStore): Promise<void> {
    // constant 0600: secret file permission hard rule.
    await atomicWriteJson(this.path, store, { mode: 0o600 })
  }

  /** by real path two-layer serial read change write: process inside queue + across process lock (and CLI mutual recognize). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.path, () => withProcessFileLock(this.path, fn))
  }
}

/** expose path constant supply permission assertion (do not read content). */
export function credentialsPath(dataDir: string): string {
  return join(dataDir, 'credentials.json')
}

/** only read text (test assertion plaintext do not other file when use). */
export async function readRawText(path: string): Promise<string> {
  return readTextFile(path)
}
