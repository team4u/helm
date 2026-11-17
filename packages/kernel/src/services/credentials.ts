/**
 * CredentialService: manages model API keys and plugin secrets in `credentials.json` (always 0600).
 * `get()` is restricted to trusted in-process callers and must never be exposed over HTTP.
 * Read-modify-write operations serialize via two layers keyed by canonical `credentials.json` path:
 * in-process queue (`withFileLock`) + cross-process lock (`credentials.json.lock`, matching CLI protocol).
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
  /** Value after SecretStash redaction or raw secret (model API keys are stored directly without stashing). */
  value: string
  createdAt: string
  updatedAt: string
}

/**
 * Persisted shape of `credentials.json`. Unrecognized top-level keys (e.g. `cli: { hubUrl, token }`
 * written by the CLI) are preserved verbatim: this service only owns the `providers` and
 * `pluginSecrets` namespaces and must never discard other keys when writing back.
 */
export interface CredentialStore {
  providers: Record<string, StoredCredential>
  pluginSecrets: Record<string, Record<string, string>>
  /** Unknown top-level keys -> raw JSON values (preserved untouched when writing back). */
  [key: string]: unknown
}

/** Boundary validation for `providerId` / `pluginId`: prevents path traversal and JSON key injection. */
function assertId(kind: string, id: string): void {
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${kind} cannot be empty`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`invalid ${kind}: ${id}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate existing structure of known fields: entries under `providers` must be objects containing a string
 * `value`, and entries under `pluginSecrets` must be `string -> string` maps. Structural errors explicitly
 * throw `FileParseError` (with path and key name) rather than silently dropping and overwriting user credentials.
 * Unknown top-level keys make no shape assumptions and are preserved verbatim.
 */
function normalizeStore(raw: unknown, path: string): CredentialStore {
  if (raw === undefined) return { providers: {}, pluginSecrets: {} }
  if (!isPlainObject(raw)) {
    throw new FileParseError(path, 'invalid credentials.json structure (expected object)')
  }
  const providers: Record<string, StoredCredential> = {}
  const rawProviders = raw['providers']
  if (rawProviders !== undefined) {
    if (!isPlainObject(rawProviders)) {
      throw new FileParseError(path, 'invalid credentials.json providers field (expected object)')
    }
    for (const [id, value] of Object.entries(rawProviders)) {
      if (!isPlainObject(value)) {
        throw new FileParseError(
          path,
          `invalid credentials.json providers.${id} structure (expected { value, createdAt, updatedAt } object)`,
        )
      }
      if (typeof value['value'] !== 'string') {
        throw new FileParseError(path, `credentials.json providers.${id}.value is missing or not a string`)
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
        'invalid credentials.json pluginSecrets field (expected pluginId -> key -> value object)',
      )
    }
    for (const [pluginId, secrets] of Object.entries(rawPlugins)) {
      if (!isPlainObject(secrets)) {
        throw new FileParseError(
          path,
          `invalid credentials.json pluginSecrets.${pluginId} structure (expected key -> string object)`,
        )
      }
      const map: Record<string, string> = {}
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value !== 'string') {
          throw new FileParseError(
            path,
            `credentials.json pluginSecrets.${pluginId}.${key} must be a string`,
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

  /** List configured `providerId`s (IDs only, never secret values). */
  async list(): Promise<string[]> {
    const store = await this.readStore()
    return Object.keys(store.providers).sort()
  }

  /**
   * Read a provider API key (restricted to trusted in-process callers; must never be exposed by HTTP/CLI).
   */
  async get(providerId: string): Promise<string | undefined> {
    assertId('providerId', providerId)
    const store = await this.readStore()
    return store.providers[providerId]?.value
  }

  /** Set a provider API key (atomic write with mode 0600; never returns plaintext value). */
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

  /** Read a plugin secret (restricted to trusted in-process callers). */
  async getPluginSecret(pluginId: string, key: string): Promise<string | undefined> {
    assertId('pluginId', pluginId)
    if (typeof key !== 'string' || key === '') throw new Error('secret key name cannot be empty')
    const store = await this.readStore()
    return store.pluginSecrets[pluginId]?.[key]
  }

  /** Write a plugin secret (`secret: true` fields in configSchema route here automatically). */
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
   * Delete a single plugin secret (succeeds silently if absent: idempotent for rollback cleanup retries).
   * Remaining keys and other plugins' secrets are unaffected.
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

  /** Full store read (for internal diagnostics/export; contains plaintext, never exposed externally). */
  async readStore(): Promise<CredentialStore> {
    const raw = await readJsonFileOptional(this.path)
    const store = normalizeStore(raw, this.path)
    // Enforce 0600 on read too: repair overly permissive existing files immediately rather than waiting for next write.
    // Throw explicitly if repair fails rather than returning insecurely.
    if (raw !== undefined && !(await isPrivateMode(this.path))) {
      await chmod(this.path, 0o600)
      if (!(await isPrivateMode(this.path))) {
        throw new Error(`failed to repair credentials.json permissions (expected 0600): ${this.path}`)
      }
    }
    return store
  }

  private async persist(store: CredentialStore): Promise<void> {
    // Always 0600: hard permission invariant for secret files.
    await atomicWriteJson(this.path, store, { mode: 0o600 })
  }

  /** Two-layer serialization keyed by real path: in-process queue + cross-process file lock (shared with CLI). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.path, () => withProcessFileLock(this.path, fn))
  }
}

/** Expose credentials file path for permission assertions (without reading contents). */
export function credentialsPath(dataDir: string): string {
  return join(dataDir, 'credentials.json')
}

/** Read raw text (used by tests to assert plaintext never appears in other files). */
export async function readRawText(path: string): Promise<string> {
  return readTextFile(path)
}
