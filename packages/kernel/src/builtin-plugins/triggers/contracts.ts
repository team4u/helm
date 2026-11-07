/**
 * builtin:triggers 共享契约：依赖端口、公共 doc 形状与边界验证。
 *
 * 设计（§4.4）：
 * - cron 与 webhook 共用同一 dispatchTrigger helper（目标解析见 delivery.ts）；
 * - public doc 只存元数据（绝不存 secret）；HMAC secret 落
 *   credentials.json pluginSecrets['builtin:triggers']['webhook:<id>']（0600），
 *   并经 stash.addRedaction 全局脱敏；
 * - 组合层依赖（credentials/stash/profiles/isClosing/flushDocs）由 app.ts
 *   显式注入，不经通用 ctx.host 扩张（机制与策略分离）。
 */
import { HelmError } from '@helm/protocol'
import type {
  ConversationSummary,
  ExternalTriggerEnvelope,
  HelmPluginContext,
  PluginDefinition,
} from '@helm/protocol'
import type { CredentialService } from '../../services/credentials.js'
import type { SecretStash } from '../../services/secret-stash.js'

export const TRIGGERS_PLUGIN_ID = 'builtin:triggers'

/** webhook secret 在 credentials.json 的键名（pluginSecrets 命名空间内）。 */
export function webhookSecretKey(id: string): string {
  return `webhook:${id}`
}

/** secret 边界校验：非空、限长、无控制字符（HMAC 共享秘密不必含控制字符）。 */
export function assertWebhookSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new HelmError('validation_error', 'webhook secret 不能为空', 400, {})
  }
  if (secret.length > 512) {
    throw new HelmError('validation_error', `webhook secret 过长（≤512 字符，实际 ${secret.length}）`, 400, {})
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new HelmError('validation_error', 'webhook secret 不允许包含控制字符', 400, {})
  }
  return secret
}

/** 触发器 id：非空、限长、url-safe（cron/webhook 共用，允许 a-z A-Z 0-9 _ -）。 */
export function assertTriggerId(kind: 'cron' | 'webhook', id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new HelmError(
      'validation_error',
      `${kind} id 非法（1..64 字符，仅允许字母数字 _ -，收到：${JSON.stringify(id)}）`,
      400,
      { kind, id: String(id) },
    )
  }
  return id
}

/** threadKey：1..200 字符（与 superagent 订阅约束一致）。 */
export function assertThreadKey(key: string): string {
  if (key.length === 0 || key.length > 200) {
    throw new HelmError('validation_error', `threadKey 非法（1..200 字符，收到 ${key.length}）`, 400, {})
  }
  return key
}

/** 描述文本上限（doc 可读性边界）。 */
export const MAX_DESCRIPTION = 500

export function assertDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION) {
    throw new HelmError('validation_error', `description 过长（≤${MAX_DESCRIPTION} 字符）`, 400, {})
  }
  return description
}

/** 目标 Profile 存在性端口（ProfileService 的最小面）。 */
export interface ProfileLookup {
  get(id: string): Promise<{ id: string } | undefined>
}

/** 组合层注入依赖（app.ts 提供；测试可替换）。 */
export interface TriggersDependencies {
  credentials: Pick<CredentialService, 'getPluginSecret' | 'setPluginSecret' | 'deletePluginSecret'>
  stash: { addRedaction(value: string): () => void }
  profiles: ProfileLookup
  /** runtime 关闭中标志：webhook 路由 / dispatch 前检查，防 close 期新回合。 */
  isClosing(): boolean
  /** doc 镜像排队持久化的真实冲刷（kernel.documentStore.flush）。 */
  flushDocs(): Promise<void>
  /** cron 模块注册入口（并行契约：registerCron(ctx, { dispatchTrigger, flush })）。 */
  registerCron: (ctx: HelmPluginContext, deps: CronDeps) => void
}

/** registerCron 依赖端口（cron.ts 实现，triggers.ts 组装）。 */
export interface CronDeps {
  dispatchTrigger(event: ExternalTriggerEnvelope, targetProfileId?: string): Promise<void>
  flush(): Promise<void>
}

// ---------------------------------------------------------------------------
// webhook 公共 doc 形状与边界验证（无 secret，仅元数据）
// ---------------------------------------------------------------------------

export interface WebhookMeta {
  id: string
  /** 协作契约：以布尔表达 secret 已配置（true），绝不含 secret 原文。 */
  hasSecret: boolean
  description?: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  createdAt: number
}

export interface WebhooksDoc {
  webhooks: WebhookMeta[]
}

export const EMPTY_WEBHOOKS_DOC: WebhooksDoc = { webhooks: [] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

const docCorrupt = (detail: string): HelmError =>
  new HelmError('triggers_doc_corrupt', `插件 doc webhooks ${detail}`, 500, { pluginId: TRIGGERS_PLUGIN_ID })

function assertWebhookMeta(raw: unknown): void {
  if (!isPlainObject(raw)) throw docCorrupt('含非对象条目')
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) {
    throw docCorrupt(`条目 id 非法：${JSON.stringify(raw.id)}`)
  }
  // hasSecret 契约：create 只写 true；缺省/false 均属旧开发 doc 或污染——
  // 开发阶段不兼容旧 doc、无迁移，显式报错（绝不静默补字段修复）。
  if (raw.hasSecret !== true) {
    throw docCorrupt(`条目 ${raw.id} 缺少 hasSecret: true（doc 以布尔表达 secret 已配置；不兼容旧开发 doc，无迁移）`)
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION)) {
    throw docCorrupt(`条目 ${raw.id} description 非字符串或超过 ${MAX_DESCRIPTION} 字符`)
  }
  if (raw.targetConversationId !== undefined && !isPosInt(raw.targetConversationId)) {
    throw docCorrupt(`条目 ${raw.id} targetConversationId 非正整数`)
  }
  if (raw.targetProfileId !== undefined && (typeof raw.targetProfileId !== 'string' || raw.targetProfileId.length === 0 || raw.targetProfileId.length > 64)) {
    throw docCorrupt(`条目 ${raw.id} targetProfileId 非法（1..64 字符）`)
  }
  // 目标互斥与创建输入同契约（delivery 层同样拒绝双目标）。
  if (raw.targetConversationId !== undefined && raw.targetProfileId !== undefined) {
    throw docCorrupt(`条目 ${raw.id} targetConversationId 与 targetProfileId 不允许同时存在`)
  }
  if (raw.threadKey !== undefined && (typeof raw.threadKey !== 'string' || raw.threadKey.length === 0 || raw.threadKey.length > 200)) {
    throw docCorrupt(`条目 ${raw.id} threadKey 非法（1..200 字符）`)
  }
  if (!isFiniteTime(raw.createdAt)) throw docCorrupt(`条目 ${raw.id} createdAt 非法`)
  // 秘密红线：doc 绝不含 secret 字段（读入即验证，历史污染显式报错）
  if ('secret' in raw) {
    throw docCorrupt(`条目 ${raw.id} 含 secret 字段（doc 只存元数据；secret 在 credentials.json）`)
  }
}

/** webhooks doc 读入边界验证：损坏显式 error，绝不静默重建。 */
export function assertWebhooksDoc(value: unknown): WebhooksDoc {
  if (!isPlainObject(value) || !Array.isArray(value.webhooks)) {
    throw docCorrupt('结构非法（期望 { webhooks: [] }）')
  }
  const seen = new Set<string>()
  for (const item of value.webhooks) {
    assertWebhookMeta(item)
    const id = (item as WebhookMeta).id
    if (seen.has(id)) throw docCorrupt(`重复条目 id '${id}'`)
    seen.add(id)
  }
  return value as unknown as WebhooksDoc
}

/** 元数据脱视图：action/doc 输出统一经此剥离（当前形状即全量，收口备将来扩字段）。 */
export function webhookPublicMeta(meta: WebhookMeta): WebhookMeta {
  const { id, hasSecret, description, targetConversationId, targetProfileId, threadKey, createdAt } = meta
  return {
    id,
    hasSecret,
    ...(description !== undefined ? { description } : {}),
    ...(targetConversationId !== undefined ? { targetConversationId } : {}),
    ...(targetProfileId !== undefined ? { targetProfileId } : {}),
    ...(threadKey !== undefined ? { threadKey } : {}),
    createdAt,
  }
}

// ---------------------------------------------------------------------------
// dispatch helper 共享目标类型
// ---------------------------------------------------------------------------

/** delivery.ts 的目标解析输入（cron job / webhook meta 共用）。 */
export interface TriggerTarget {
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
}

/** 会话查询端口（ctx.host 的最小面，便于测试）。 */
export interface ConversationLookup {
  listConversations(filter?: { profileId?: string }): ConversationSummary[]
  getConversation(id: number): ConversationSummary
  createConversation(init: { title?: string; profileId?: string }): Promise<ConversationSummary>
}

export type TriggersPluginFactory = (deps: TriggersDependencies) => PluginDefinition
