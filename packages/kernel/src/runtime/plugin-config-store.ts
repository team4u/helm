/**
 * HelmPluginConfigStore:PluginHost config persist bridge (runtime dedicated belong helper).
 *
 * - non- secret field → config.json `plugins.<pluginId>`(ConfigService atomic write,
 *   only update this plugin key, keep other plugin and other top-level key);
 * - secret field (schema `secret: true`)→ credentials.json `pluginSecrets`
 *   (CredentialService, constant 0600, never config.json);
 * - plugin start stop state → config.json `pluginEnabled` mapping (and `plugins` config,
 *   credentials fully separate; missing means from not persisted, hand over by PluginHost back to declaration value);
 * - `get` sync return two side merge valid config (load when warm up memory mirror, write path sync dimension hold);
 * - `set` by schema complete validate (unknown field / type / required), only persist user explicit
 *   override value (do not solid schema.default), value null means reset back by default (delete disk key);
 * - credentials or config file corrupt when `load()` explicit on throw (open failed), never catch swallow wrong after
 *   pretend read write succeeded (honest discipline).
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
  return new HelmError('validation_error', `plugin ${pluginId} config validation failed:${message}`, 400, {
    pluginId,
  })
}

/** write when embed set field corrupt: original reject, never static default use {} rebuild (will swallow since has data). */
function corrupt(field: string, detail: string): HelmError {
  return new HelmError('config_corrupt', `config.json ${field} field structure illegal (${detail}), reject write`, 500)
}

interface Mirror {
  /** config.json plugins.<id> non- secret valid config. */
  plain: Map<string, Record<string, unknown>>
  /** credentials.json pluginSecrets.<id>. */
  secrets: Map<string, Record<string, string>>
  /** config.json pluginEnabled mapping (boolean; missing items = from not persisted). */
  enabled: Map<string, boolean>
}

export class HelmPluginConfigStore implements PluginConfigStore {
  private readonly configService: ConfigService
  private readonly credentialService: CredentialService
  private readonly mirror: Mirror = { plain: new Map(), secrets: new Map(), enabled: new Map() }
  /** write path serial (process inside); file layer another has ConfigService/CredentialService each lock. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: { config: ConfigService; credentials: CredentialService }) {
    this.configService = options.config
    this.credentialService = options.credentials
  }

  /**
   * start warm up: read config.json and credentials.json establish sync mirror.
   * any one file structure corrupt (FileParseError) explicit on throw.
   */
  async load(): Promise<void> {
    const cfg = await this.configService.get()
    const plugins = cfg['plugins']
    if (plugins !== undefined) {
      if (!isPlainObject(plugins)) {
        throw new HelmError('config_corrupt', 'config.json plugins field structure illegal (should be object)', 500)
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
          'config.json pluginEnabled field structure illegal (should be pluginId → boolean object)',
          500,
        )
      }
      for (const [id, value] of Object.entries(pluginEnabled)) {
        if (typeof value !== 'boolean') {
          throw new HelmError(
            'config_corrupt',
            `config.json pluginEnabled.${id} must be boolean value (actual:${typeof value})`,
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

  /** merge valid config: non- secret(config.json)+ secret(credentials.json override same name segment). */
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
    if (!isPlainObject(value)) throw invalid(pluginId, 'config value must be object')

    const existingPlain = this.mirror.plain.get(pluginId) ?? {}
    const existingSecrets = this.mirror.secrets.get(pluginId) ?? {}
    /** this time after write eventually store state (required validate based on merge after fact). */
    const nextPlain: Record<string, unknown> = { ...existingPlain }
    const nextSecrets: Record<string, string> = { ...existingSecrets }
    /** await from disk delete key (null reset), by secret ownership bucket. */
    const removePlain: string[] = []
    const removeSecrets: string[] = []

    for (const [key, fieldValue] of Object.entries(value)) {
      const field = schema[key]
      if (field === undefined) throw invalid(pluginId, `unknown config field ${key}(not in configSchema declaration)`)
      if (fieldValue === null) {
        // null = clear explicit config (reset back default; by read side together into, disk only delete do not write).
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
        if (typeof fieldValue !== 'string') throw invalid(pluginId, `field ${key} is secret, must be string`)
        nextSecrets[key] = fieldValue
      } else if (typeof fieldValue !== expected) {
        throw invalid(pluginId, `field ${key} type should be ${expected}`)
      } else {
        if (typeof fieldValue === 'number') {
          if (!Number.isFinite(fieldValue)) throw invalid(pluginId, `field ${key} must be finite count value`)
          if (field.integer === true && !Number.isInteger(fieldValue)) throw invalid(pluginId, `field ${key} must be integer`)
          if (field.minimum !== undefined && fieldValue < field.minimum) throw invalid(pluginId, `field ${key} cannot less than ${field.minimum}`)
          if (field.maximum !== undefined && fieldValue > field.maximum) throw invalid(pluginId, `field ${key} cannot greater than ${field.maximum}`)
        }
        nextPlain[key] = fieldValue
      }
    }

    // required validate: merge this time modify after eventually store must contains required and without default field
    //(default field can default, by read side together into fall back). no longer field.default solid to disk.
    for (const [key, field] of Object.entries(schema)) {
      if (field.required !== true || field.default !== undefined) continue
      const stored = field.secret === true ? nextSecrets[key] : nextPlain[key]
      const empty = field.secret === true
        ? typeof stored !== 'string' || stored.length === 0
        : stored === undefined || stored === null || stored === ''
      if (empty) throw invalid(pluginId, `missing required field ${key}`)
    }

    // first persist again update mirror (failed do not pollute memory perspective, error explicit on throw).
    // read change write all process in ConfigService the same file lock inside with call back complete: only motion this plugin
    // embed set key, lock outside without old snapshot, between gap other module write will not by override.
    const plainTouched = Object.keys(nextPlain).length > 0 || removePlain.length > 0
    if (plainTouched) {
      await this.configService.updateBy((current) => {
        const plugins = current['plugins']
        if (plugins !== undefined && !isPlainObject(plugins)) {
          throw corrupt('plugins', `should be object, actual:${typeof plugins}`)
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

    // sync memory mirror (and disk consistent: write merge + null delete; empty bucket clean up).
    if (plainTouched) {
      if (Object.keys(nextPlain).length === 0) this.mirror.plain.delete(pluginId)
      else this.mirror.plain.set(pluginId, { ...nextPlain })
    }
    if (Object.keys(nextSecrets).length === 0) this.mirror.secrets.delete(pluginId)
    else this.mirror.secrets.set(pluginId, { ...nextSecrets })
  }

  /** plugin start stop state read (sync cache;undefined = from not persisted). */
  getEnabled(pluginId: string): boolean | undefined {
    return this.mirror.enabled.get(pluginId)
  }

  /**
   * persist plugin start stop state: write config.json pluginEnabled.<pluginId>(only update this key,
   * keep other plugin start stop and all since has key), after success sync mirror. write failed explicit throw, mirror
   * do not change (under time getEnabled still return old value, and disk consistent).
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new HelmError(
        'validation_error',
        `plugin ${pluginId} start stop state must be boolean value (actual:${typeof enabled})`,
        400,
        { pluginId },
      )
    }
    const task = this.writeChain.then(() => this.applyEnabled(pluginId, enabled))
    this.writeChain = task.catch(() => undefined)
    return task
  }

  private async applyEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // lock inside read change write: based on most new disk state only update pluginEnabled.<pluginId>, between gap
    // other module write (auth/model/other plugin) will not by lock outside old snapshot override; corrupt explicit
    // config_corrupt, never use {} rebuild.
    await this.configService.updateBy((current) => {
      const existing = current['pluginEnabled']
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt('pluginEnabled', `should be pluginId → boolean object, actual:${typeof existing}`)
      }
      if (isPlainObject(existing)) {
        for (const [id, value] of Object.entries(existing)) {
          if (typeof value !== 'boolean') {
            throw corrupt('pluginEnabled', `${id} must be boolean value (actual:${typeof value})`)
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
