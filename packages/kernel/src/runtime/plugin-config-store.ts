/**
 * HelmPluginConfigStore：PluginHost 配置持久化桥（runtime 专属 helper）。
 *
 * - 非 secret 字段 → config.json `plugins.<pluginId>`（ConfigService 原子写，
 *   只更新本插件键，保留其他插件与其他顶层键）；
 * - secret 字段（schema `secret: true`）→ credentials.json `pluginSecrets`
 *   （CredentialService，恒 0600，绝不落入 config.json）；
 * - 插件启停状态 → config.json `pluginEnabled` 映射（与 `plugins` 配置、
 *   credentials 完全分离；缺失表示从未持久化过，交由 PluginHost 回落到声明值）；
 * - `get` 同步返回两侧合并的有效配置（load 时预热内存镜像，写路径同步维持）；
 * - `set` 按 schema 完整校验（未知字段 / 类型 / required），只持久化用户显式
 *   覆写值（不固化 schema.default），值 null 表示重置回默认（删除磁盘键）；
 * - 凭据或配置文件损坏时 `load()` 显式上抛（open 失败），绝不 catch 吞错后
 *   假装读写成功（诚实性纪律）。
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
  return new HelmError('validation_error', `插件 ${pluginId} 配置校验失败：${message}`, 400, {
    pluginId,
  })
}

/** 写时嵌套字段损坏：原样拒绝，绝不静默用 {} 重建（会吞掉既有数据）。 */
function corrupt(field: string, detail: string): HelmError {
  return new HelmError('config_corrupt', `config.json ${field} 字段结构非法（${detail}），拒绝写入`, 500)
}

interface Mirror {
  /** config.json plugins.<id> 的非 secret 有效配置。 */
  plain: Map<string, Record<string, unknown>>
  /** credentials.json pluginSecrets.<id>。 */
  secrets: Map<string, Record<string, string>>
  /** config.json pluginEnabled 映射（布尔；缺项 = 从未持久化）。 */
  enabled: Map<string, boolean>
}

export class HelmPluginConfigStore implements PluginConfigStore {
  private readonly configService: ConfigService
  private readonly credentialService: CredentialService
  private readonly mirror: Mirror = { plain: new Map(), secrets: new Map(), enabled: new Map() }
  /** 写路径串行化（进程内）；文件层另有 ConfigService/CredentialService 各自锁。 */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: { config: ConfigService; credentials: CredentialService }) {
    this.configService = options.config
    this.credentialService = options.credentials
  }

  /**
   * 启动预热：读 config.json 与 credentials.json 建立同步镜像。
   * 任一文件结构损坏（FileParseError）显式上抛。
   */
  async load(): Promise<void> {
    const cfg = await this.configService.get()
    const plugins = cfg['plugins']
    if (plugins !== undefined) {
      if (!isPlainObject(plugins)) {
        throw new HelmError('config_corrupt', 'config.json plugins 字段结构非法（应为对象）', 500)
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
          'config.json pluginEnabled 字段结构非法（应为 pluginId → 布尔 对象）',
          500,
        )
      }
      for (const [id, value] of Object.entries(pluginEnabled)) {
        if (typeof value !== 'boolean') {
          throw new HelmError(
            'config_corrupt',
            `config.json pluginEnabled.${id} 必须是布尔值（实际：${typeof value}）`,
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

  /** 合并有效配置：非 secret（config.json）+ secret（credentials.json 覆盖同名字段）。 */
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
    if (!isPlainObject(value)) throw invalid(pluginId, '配置值必须是对象')

    const existingPlain = this.mirror.plain.get(pluginId) ?? {}
    const existingSecrets = this.mirror.secrets.get(pluginId) ?? {}
    /** 本次写入后的最终存储状态（required 校验基于合并后事实）。 */
    const nextPlain: Record<string, unknown> = { ...existingPlain }
    const nextSecrets: Record<string, string> = { ...existingSecrets }
    /** 待从磁盘删除的键（null 重置），按 secret 归属分桶。 */
    const removePlain: string[] = []
    const removeSecrets: string[] = []

    for (const [key, fieldValue] of Object.entries(value)) {
      const field = schema[key]
      if (field === undefined) throw invalid(pluginId, `未知配置字段 ${key}（未在 configSchema 声明）`)
      if (fieldValue === null) {
        // null = 清除显式配置（重置回 default；由读取侧合成，磁盘只删不写）。
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
        if (typeof fieldValue !== 'string') throw invalid(pluginId, `字段 ${key} 是 secret，必须是字符串`)
        nextSecrets[key] = fieldValue
      } else if (typeof fieldValue !== expected) {
        throw invalid(pluginId, `字段 ${key} 类型应为 ${expected}`)
      } else {
        if (typeof fieldValue === 'number') {
          if (!Number.isFinite(fieldValue)) throw invalid(pluginId, `字段 ${key} 必须是有限数值`)
          if (field.integer === true && !Number.isInteger(fieldValue)) throw invalid(pluginId, `字段 ${key} 必须是整数`)
          if (field.minimum !== undefined && fieldValue < field.minimum) throw invalid(pluginId, `字段 ${key} 不能小于 ${field.minimum}`)
          if (field.maximum !== undefined && fieldValue > field.maximum) throw invalid(pluginId, `字段 ${key} 不能大于 ${field.maximum}`)
        }
        nextPlain[key] = fieldValue
      }
    }

    // required 校验：合并本次修改后的最终存储必须包含必填且无 default 的字段
    //（default 字段可缺省，由读取侧合成回退）。不再把 field.default 固化到磁盘。
    for (const [key, field] of Object.entries(schema)) {
      if (field.required !== true || field.default !== undefined) continue
      const stored = field.secret === true ? nextSecrets[key] : nextPlain[key]
      const empty = field.secret === true
        ? typeof stored !== 'string' || stored.length === 0
        : stored === undefined || stored === null || stored === ''
      if (empty) throw invalid(pluginId, `缺少必填字段 ${key}`)
    }

    // 先持久化再更新镜像（失败不污染内存视角，错误显式上抛）。
    // 读改写全程在 ConfigService 同一把文件锁内以回调完成：只动本插件
    // 嵌套键，锁外无旧快照，间隙的其它模块写入不会被覆盖。
    const plainTouched = Object.keys(nextPlain).length > 0 || removePlain.length > 0
    if (plainTouched) {
      await this.configService.updateBy((current) => {
        const plugins = current['plugins']
        if (plugins !== undefined && !isPlainObject(plugins)) {
          throw corrupt('plugins', `应为对象，实际：${typeof plugins}`)
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

    // 同步内存镜像（与磁盘一致：写入合并 + null 删除；空桶清理）。
    if (plainTouched) {
      if (Object.keys(nextPlain).length === 0) this.mirror.plain.delete(pluginId)
      else this.mirror.plain.set(pluginId, { ...nextPlain })
    }
    if (Object.keys(nextSecrets).length === 0) this.mirror.secrets.delete(pluginId)
    else this.mirror.secrets.set(pluginId, { ...nextSecrets })
  }

  /** 插件启停状态读取（同步缓存；undefined = 从未持久化）。 */
  getEnabled(pluginId: string): boolean | undefined {
    return this.mirror.enabled.get(pluginId)
  }

  /**
   * 持久化插件启停状态：写 config.json pluginEnabled.<pluginId>（只更新本键，
   * 保留其他插件启停与全部既有键），成功后同步镜像。写失败显式抛出，镜像
   * 不变（下次 getEnabled 仍返回旧值，与磁盘一致）。
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new HelmError(
        'validation_error',
        `插件 ${pluginId} 启停状态必须是布尔值（实际：${typeof enabled}）`,
        400,
        { pluginId },
      )
    }
    const task = this.writeChain.then(() => this.applyEnabled(pluginId, enabled))
    this.writeChain = task.catch(() => undefined)
    return task
  }

  private async applyEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // 锁内读改写：基于最新磁盘状态只更新 pluginEnabled.<pluginId>，间隙的
    // 其它模块写入（auth/model/其他插件）不会被锁外旧快照覆盖；损坏显式
    // config_corrupt，绝不用 {} 重建。
    await this.configService.updateBy((current) => {
      const existing = current['pluginEnabled']
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt('pluginEnabled', `应为 pluginId → 布尔 对象，实际：${typeof existing}`)
      }
      if (isPlainObject(existing)) {
        for (const [id, value] of Object.entries(existing)) {
          if (typeof value !== 'boolean') {
            throw corrupt('pluginEnabled', `${id} 必须是布尔值（实际：${typeof value}）`)
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
