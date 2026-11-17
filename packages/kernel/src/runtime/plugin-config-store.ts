/**
 * `HelmPluginConfigStore`: persistent configuration bridge for `PluginHost` (dedicated runtime helper).
 *
 * - Non-secret fields -> `config.json` `plugins.<pluginId>` (`ConfigService` atomic write,
 *   updating only this plugin's key while preserving other plugins and top-level keys);
 * - Secret fields (schema `secret: true`) -> `credentials.json` `pluginSecrets`
 *   (`CredentialService`, always `0600`, never written to `config.json`);
 * - Plugin enable/disable state -> `config.json` `pluginEnabled` map (kept separate from `plugins` config
 *   and credentials; missing means never persisted, so `PluginHost` falls back to manifest declaration);
 * - `get` synchronously returns merged effective config (in-memory mirror warmed on `load()`, kept in sync on writes);
 * - `set` validates thoroughly against schema (unknown fields / types / required), persisting only explicit
 *   user overrides (never materializing `schema.default`), with `null` resetting to default (deletes key on disk);
 * - On corrupted credentials or config file, `load()` propagates the error explicitly (fails startup) rather than
 *   swallowing errors and pretending reads/writes succeeded (honesty discipline).
 */

import {
  HelmError,
  type PluginConfigFieldSchema,
} from '@helm/protocol'
import type { PluginConfigStore } from '../plugins/plugin-host.js'
import type { ConfigService } from '../services/config.js'
import type { CredentialService } from '../services/credentials.js'

const TYPE_OF: Record<PluginConfigFieldSchema['type'], 'string' | 'number' | 'boolean'> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(pluginId: string, message: string): HelmError {
  return new HelmError('validation_error', `Plugin '${pluginId}' config validation failed: ${message}`, 400, {
    pluginId,
  })
}

/** Corrupted nested field encountered during write: reject cleanly instead of overwriting existing data with `{}`. */
function corrupt(field: string, detail: string): HelmError {
  return new HelmError('config_corrupt', `config.json field '${field}' has invalid structure (${detail}); write rejected`, 500)
}

interface Mirror {
  /** Effective non-secret config under `config.json` `plugins.<id>`. */
  plain: Map<string, Record<string, unknown>>
  /** `credentials.json` `pluginSecrets.<id>`. */
  secrets: Map<string, Record<string, string>>
  /** `config.json` `pluginEnabled` map (booleans; missing entries = never persisted). */
  enabled: Map<string, boolean>
}

export class HelmPluginConfigStore implements PluginConfigStore {
  private readonly configService: ConfigService
  private readonly credentialService: CredentialService
  private readonly mirror: Mirror = { plain: new Map(), secrets: new Map(), enabled: new Map() }
  /** In-process write serialization; file-level locking is also enforced individually by ConfigService/CredentialService. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: { config: ConfigService; credentials: CredentialService }) {
    this.configService = options.config
    this.credentialService = options.credentials
  }

  /**
   * Startup warmup: read `config.json` and `credentials.json` to populate the synchronous mirror.
   * Any structural corruption (`FileParseError`) propagates explicitly.
   */
  async load(): Promise<void> {
    const cfg = await this.configService.get()
    const plugins = cfg['plugins']
    if (plugins !== undefined) {
      if (!isPlainObject(plugins)) {
        throw new HelmError('config_corrupt', 'config.json field "plugins" has invalid structure (expected object)', 500)
      }
      for (const [id, value] of Object.entries(plugins)) {
        if (isPlainObject(value)) this.mirror.plain.set(id, { ...value })
      }
    }
    const pluginEnabled = cfg['pluginEnabled']
    if (pluginEnabled !== undefined) {
      if (!isPlainObject(pluginEnabled)) {
        throw new HelmError(
          'config_corrupt',
          'config.json field "pluginEnabled" has invalid structure (expected pluginId -> boolean object)',
          500,
        )
      }
      for (const [id, value] of Object.entries(pluginEnabled)) {
        if (typeof value !== 'boolean') {
          throw new HelmError(
            'config_corrupt',
            `config.json pluginEnabled.${id} must be a boolean (got ${typeof value})`,
            500,
          )
        }
        this.mirror.enabled.set(id, value)
      }
    }
    const store = await this.credentialService.readStore()
    for (const [id, secrets] of Object.entries(store.pluginSecrets)) {
      this.mirror.secrets.set(id, { ...secrets })
    }
  }

  /** Merged effective config: non-secret (`config.json`) + secrets (`credentials.json`, overriding same-named fields). */
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.mirror.plain.get(pluginId) ?? {}), ...(this.mirror.secrets.get(pluginId) ?? {}) }
  }

  set(
    pluginId: string,
    value: Record<string, unknown>,
    schema: Record<string, PluginConfigFieldSchema>,
  ): Promise<void> {
    const task = this.writeChain.then(() => this.apply(pluginId, value, schema))
    this.writeChain = task.catch(() => undefined)
    return task
  }

  private async apply(
    pluginId: string,
    value: Record<string, unknown>,
    schema: Record<string, PluginConfigFieldSchema>,
  ): Promise<void> {
    if (!isPlainObject(value)) throw invalid(pluginId, 'config value must be an object')

    const existingPlain = this.mirror.plain.get(pluginId) ?? {}
    const existingSecrets = this.mirror.secrets.get(pluginId) ?? {}
    /** Final post-write state (required-field check evaluates merged final state). */
    const nextPlain: Record<string, unknown> = { ...existingPlain }
    const nextSecrets: Record<string, string> = { ...existingSecrets }
    /** Keys to delete from disk (`null` resets), bucketed by secret flag. */
    const removePlain: string[] = []
    const removeSecrets: string[] = []

    for (const [key, fieldValue] of Object.entries(value)) {
      const field = schema[key]
      if (field === undefined) throw invalid(pluginId, `unknown config field '${key}' (not declared in configSchema)`)
      if (fieldValue === null) {
        // `null` clears explicit config (resets to default; merged at read time, simply deleted on disk).
        if (field.secret === true) {
          delete nextSecrets[key]
          removeSecrets.push(key)
        } else {
          delete nextPlain[key]
          removePlain.push(key)
        }
        continue
      }
      const expected = TYPE_OF[field.type]
      if (field.secret === true) {
        if (typeof fieldValue !== 'string') throw invalid(pluginId, `field '${key}' is secret and must be a string`)
        nextSecrets[key] = fieldValue
      } else if (typeof fieldValue !== expected) {
        throw invalid(pluginId, `field '${key}' must be of type ${expected}`)
      } else {
        if (typeof fieldValue === 'number') {
          if (!Number.isFinite(fieldValue)) throw invalid(pluginId, `field '${key}' must be a finite number`)
          if (field.integer === true && !Number.isInteger(fieldValue)) throw invalid(pluginId, `field '${key}' must be an integer`)
          if (field.minimum !== undefined && fieldValue < field.minimum) throw invalid(pluginId, `field '${key}' must be >= ${field.minimum}`)
          if (field.maximum !== undefined && fieldValue > field.maximum) throw invalid(pluginId, `field '${key}' must be <= ${field.maximum}`)
        }
        nextPlain[key] = fieldValue
      }
    }

    // Required-field check: final merged state must contain all required fields without defaults
    // (fields with defaults can be omitted and fall back at read time; defaults are never persisted to disk).
    for (const [key, field] of Object.entries(schema)) {
      if (field.required !== true || field.default !== undefined) continue
      const stored = field.secret === true ? nextSecrets[key] : nextPlain[key]
      const empty = field.secret === true
        ? typeof stored !== 'string' || stored.length === 0
        : stored === undefined || stored === null || stored === ''
      if (empty) throw invalid(pluginId, `missing required field '${key}'`)
    }

    // Persist first, then update mirror (failures propagate cleanly without polluting the in-memory view).
    // Read-modify-write executes inside ConfigService's file lock callback so only this plugin's nested key
    // is touched, avoiding stale snapshots outside the lock and concurrent overwrites from other modules.
    const plainTouched = Object.keys(nextPlain).length > 0 || removePlain.length > 0
    if (plainTouched) {
      await this.configService.updateBy((current) => {
        const plugins = current['plugins']
        if (plugins !== undefined && !isPlainObject(plugins)) {
          throw corrupt('plugins', `expected object, got ${typeof plugins}`)
        }
        const merged = isPlainObject(plugins) ? plugins : {}
        const bucket = { ...(isPlainObject(merged[pluginId]) ? (merged[pluginId] as Record<string, unknown>) : {}), ...nextPlain }
        for (const key of removePlain) delete bucket[key]
        if (Object.keys(bucket).length === 0) delete merged[pluginId]
        else merged[pluginId] = bucket
        return { ...current, plugins: merged }
      })
    }
    for (const [key, secret] of Object.entries(value)) {
      if (secret === null) continue
      const field = schema[key]
      if (field?.secret === true && typeof secret === 'string') {
        await this.credentialService.setPluginSecret(pluginId, key, secret)
      }
    }
    for (const key of removeSecrets) {
      await this.credentialService.deletePluginSecret(pluginId, key)
    }

    // Sync in-memory mirror to match disk (write merges + null deletes; empty buckets removed).
    if (plainTouched) {
      if (Object.keys(nextPlain).length === 0) this.mirror.plain.delete(pluginId)
      else this.mirror.plain.set(pluginId, { ...nextPlain })
    }
    if (Object.keys(nextSecrets).length === 0) this.mirror.secrets.delete(pluginId)
    else this.mirror.secrets.set(pluginId, { ...nextSecrets })
  }

  /** Read plugin enabled state (synchronous cache; `undefined` = never persisted). */
  getEnabled(pluginId: string): boolean | undefined {
    return this.mirror.enabled.get(pluginId)
  }

  /**
   * Persist plugin enabled state: writes `config.json` `pluginEnabled.<pluginId>` (updates only this key,
   * preserving other plugins and all existing keys) and updates the mirror upon success. Failures propagate
   * without mutating the mirror (so subsequent `getEnabled` stays consistent with disk).
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new HelmError(
        'validation_error',
        `Plugin '${pluginId}' enabled state must be a boolean (got ${typeof enabled})`,
        400,
        { pluginId },
      )
    }
    const task = this.writeChain.then(() => this.applyEnabled(pluginId, enabled))
    this.writeChain = task.catch(() => undefined)
    return task
  }

  private async applyEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // Locked read-modify-write: updates only pluginEnabled.<pluginId> on the latest disk state so concurrent
    // writes from other modules are not clobbered; corruption fails with config_corrupt rather than rebuilding `{}`.
    await this.configService.updateBy((current) => {
      const existing = current['pluginEnabled']
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt('pluginEnabled', `expected pluginId -> boolean object, got ${typeof existing}`)
      }
      if (isPlainObject(existing)) {
        for (const [id, value] of Object.entries(existing)) {
          if (typeof value !== 'boolean') {
            throw corrupt('pluginEnabled', `'${id}' must be a boolean (got ${typeof value})`)
          }
        }
      }
      return {
        ...current,
        pluginEnabled: { ...(isPlainObject(existing) ? existing : {}), [pluginId]: enabled },
      }
    })
    this.mirror.enabled.set(pluginId, enabled)
  }
}
