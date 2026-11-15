/**
 * 事件载荷边界校验（纯函数；自 events.ts 拆出，可独立单测）。
 *
 * 纪律（迁移前语义原样保持）：
 * - publish 侧统一 JSON 校验 + 脱敏（字符串与字段名都过 redact），payload 非法
 *   直接抛 HelmError，绝不静默降级；core 类型入参同时接受调用方直接 payload 与
 *   完整事件信封（如 PluginHost emitEvent('plugin.changed', {type, plugin})），
 *   信封只拆包不二次嵌套；未知 type 走 CustomHelmEvent {type, payload} 原样
 *   透传，不伪装成 notification；
 * - 「可缺不可错」：可选字段存在即校验，类型不符同样抛错，不静默修正
 *   （如 notification 的非法 level 不折回 'info'）。
 */

import { HelmError } from '@helm/protocol'
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CustomHelmEvent,
  HelmEvent,
  HelmSnapshot,
  NodeInfo,
  PublicPluginDoc,
  PublicPluginSessionDoc,
  SecretLifetime,
} from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { validateSecretLifetime } from '../services/secret-stash.js'

const CONVERSATION_STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'error'])
const ASK_STATUSES = new Set(['pending', 'answered', 'cancelled', 'superseded'])
const ASK_FIELD_TYPES = new Set(['text', 'select', 'confirm'])

/**
 * 递归剔除值为 undefined 的可选字段。
 * 仅对 plain object / array 递归；其余值（含 Date/Map 等非法 JSON 值）原样返回，
 * 由 redactJsonValue 在 JSON 边界统一拒绝，不做静默转换。
 * 已在访问路径上的对象原样返回（真循环留给 redactJsonValue 显式抛错，不在这里无限递归）。
 */
export function pruneUndefined(value: unknown, visiting: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      return value.map((v) => pruneUndefined(v, visiting))
    } finally {
      visiting.delete(value)
    }
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[k] = pruneUndefined(v, visiting)
      }
      return out
    } finally {
      visiting.delete(value)
    }
  }
  return value
}

/**
 * conversation.upsert 载荷校验：事件消费方（web live-state / cli / 协议类型）
 * 实际读取的 ConversationSummary 核心字段；可选字段存在即校验，类型不符同样抛错
 *（可缺不可错）。
 */
function assertConversationSummaryShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'conversation.upsert 需要 ConversationSummary 形状的 conversation', 500)
  }
  const conv = value as Record<string, unknown>
  if (
    !Number.isInteger(conv['id']) ||
    typeof conv['title'] !== 'string' ||
    typeof conv['profileId'] !== 'string' ||
    !Array.isArray(conv['tags']) ||
    !conv['tags'].every((tag) => typeof tag === 'string') ||
    typeof conv['cwd'] !== 'string' ||
    typeof conv['model'] !== 'string' ||
    typeof conv['thinkingLevel'] !== 'string' ||
    !CONVERSATION_STATUSES.has(conv['status'] as string) ||
    !Number.isInteger(conv['stateChangeSeq']) ||
    !Number.isInteger(conv['completionSeq']) ||
    typeof conv['unread'] !== 'boolean' ||
    typeof conv['pinned'] !== 'boolean' ||
    !Number.isInteger(conv['pendingAskCount']) ||
    !Number.isFinite(conv['createdAt']) ||
    !Number.isFinite(conv['updatedAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert 需要 ConversationSummary 形状的 conversation（id/title/profileId/tags/cwd/model/thinkingLevel/status/stateChangeSeq/completionSeq/unread/pinned/pendingAskCount/createdAt/updatedAt）',
      500,
    )
  }
  if (
    (conv['parentConversationId'] !== undefined && !Number.isInteger(conv['parentConversationId'])) ||
    (conv['parentToolCallId'] !== undefined && typeof conv['parentToolCallId'] !== 'string') ||
    (conv['ownedBy'] !== undefined &&
      conv['ownedBy'] !== 'human' &&
      conv['ownedBy'] !== 'helm' &&
      conv['ownedBy'] !== 'bot') ||
    (conv['nodeId'] !== undefined && typeof conv['nodeId'] !== 'string') ||
    (conv['thinkingLevelOverride'] !== undefined && typeof conv['thinkingLevelOverride'] !== 'string') ||
    (conv['doing'] !== undefined && typeof conv['doing'] !== 'string') ||
    (conv['lastError'] !== undefined && typeof conv['lastError'] !== 'string') ||
    (conv['contextUsage'] !== undefined && !isContextUsageShape(conv['contextUsage']))
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert 的可选字段（parentConversationId/parentToolCallId/ownedBy/nodeId/thinkingLevelOverride/doing/lastError/contextUsage）存在时类型必须合法',
      500,
    )
  }
}

/** contextUsage 形状校验（可缺不可错；契约收敛为 tokens/contextWindow/compacting
 * 三字段，未知字段拒绝——不留死字段；tokens 为 null 表示上下文未知；速率类
 * 指标不随用量携带，由可选插件策略层自行展示）。 */
function isContextUsageShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const usage = value as Record<string, unknown>
  if (
    !Object.keys(usage).every(
      (key) => key === 'tokens' || key === 'contextWindow' || key === 'compacting',
    )
  ) {
    return false
  }
  if (
    usage['tokens'] !== null &&
    (typeof usage['tokens'] !== 'number' || !Number.isFinite(usage['tokens']) || usage['tokens'] < 0)
  ) {
    return false
  }
  if (
    usage['contextWindow'] !== undefined &&
    (typeof usage['contextWindow'] !== 'number' ||
      !Number.isFinite(usage['contextWindow']) ||
      usage['contextWindow'] <= 0)
  ) {
    return false
  }
  if (usage['compacting'] !== undefined && typeof usage['compacting'] !== 'boolean') {
    return false
  }
  return true
}

/** conversation.live 的通用流式 generation 事实形状（可缺不可错）：
 * taskId / attempt 正整数（身份不可伪造）；message.content 为数组且仅含
 * 受限块形状；usage.output 正有限数。非法即拒绝，不静默降级。 */
function isLiveGenerationShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const generation = value as Record<string, unknown>
  if (
    !Object.keys(generation).every(
      (key) => key === 'taskId' || key === 'attempt' || key === 'message',
    )
  ) {
    return false
  }
  if (
    typeof generation['taskId'] !== 'number' ||
    !Number.isInteger(generation['taskId']) ||
    generation['taskId'] <= 0
  ) {
    return false
  }
  if (
    typeof generation['attempt'] !== 'number' ||
    !Number.isInteger(generation['attempt']) ||
    generation['attempt'] <= 0
  ) {
    return false
  }
  const message = generation['message']
  if (message === undefined) return true
  if (message === null || typeof message !== 'object') return false
  const m = message as Record<string, unknown>
  if (!Object.keys(m).every((key) => key === 'content' || key === 'usage')) return false
  if (!Array.isArray(m['content'])) return false
  for (const block of m['content']) {
    if (block === null || typeof block !== 'object') return false
    const b = block as Record<string, unknown>
    if (b['type'] === 'text') {
      if (typeof b['text'] !== 'string' || !Object.keys(b).every((k) => k === 'type' || k === 'text')) return false
    } else if (b['type'] === 'thinking') {
      if (typeof b['thinking'] !== 'string' || !Object.keys(b).every((k) => k === 'type' || k === 'thinking')) return false
    } else if (b['type'] === 'toolCall') {
      if (
        typeof b['name'] !== 'string' ||
        !Object.keys(b).every((k) => k === 'type' || k === 'name' || k === 'arguments')
      ) {
        return false
      }
    } else {
      return false
    }
  }
  const usage = m['usage']
  if (usage === undefined) return true
  if (usage === null || typeof usage !== 'object') return false
  const u = usage as Record<string, unknown>
  if (!Object.keys(u).every((key) => key === 'output')) return false
  return typeof u['output'] === 'number' && Number.isFinite(u['output']) && u['output'] > 0
}

/** ask.upsert 载荷校验：AskSpec 核心字段形状（业务级规则由 createAsk 的 validateAskSpec 把守）。 */
function assertAskSpecShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'ask.upsert 需要 AskSpec 形状的 ask', 500)
  }
  const ask = value as Record<string, unknown>
  if (
    typeof ask['id'] !== 'string' ||
    ask['id'] === '' ||
    !Number.isInteger(ask['conversationId']) ||
    typeof ask['title'] !== 'string' ||
    ask['title'] === '' ||
    !Array.isArray(ask['fields']) ||
    ask['fields'].length === 0 ||
    !ASK_STATUSES.has(ask['status'] as string) ||
    !Number.isFinite(ask['createdAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'ask.upsert 需要 AskSpec 形状的 ask（id/conversationId/title/fields/status/createdAt）',
      500,
    )
  }
  for (const field of ask['fields']) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof (field as Record<string, unknown>)['name'] !== 'string' ||
      typeof (field as Record<string, unknown>)['label'] !== 'string' ||
      !ASK_FIELD_TYPES.has((field as Record<string, unknown>)['type'] as string)
    ) {
      throw new HelmError('invalid_event', 'ask.upsert 的 field 需要 { name: string; label: string; type: text|select|confirm } 形状', 500)
    }
    const f = field as Record<string, unknown>
    if (f['secretLifetime'] !== undefined) {
      if (f['secret'] !== true) throw new HelmError('invalid_event', 'ask.upsert 的 secretLifetime 仅允许用于 secret 字段', 500)
      try {
        validateSecretLifetime(f['secretLifetime'] as SecretLifetime, 'ask.upsert field.secretLifetime')
      } catch (error) {
        throw new HelmError('invalid_event', error instanceof Error ? error.message : 'ask.upsert field.secretLifetime 格式无效', 500)
      }
    }
    if (f['type'] === 'select' && (!Array.isArray(f['options']) || f['options'].length === 0)) {
      throw new HelmError('invalid_event', 'ask.upsert 的 select 字段需要非空 options（与 createAsk 校验一致）', 500)
    }
    if (
      (f['options'] !== undefined &&
        (!Array.isArray(f['options']) ||
          !f['options'].every(
            (o) => o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>)['label'] === 'string' && typeof (o as Record<string, unknown>)['value'] === 'string',
          ))) ||
      (f['secret'] !== undefined && typeof f['secret'] !== 'boolean') ||
      (f['required'] !== undefined && typeof f['required'] !== 'boolean')
    ) {
      throw new HelmError('invalid_event', 'ask.upsert 的 field 可选字段（options/secret/required）存在时类型必须合法', 500)
    }
  }
  if (
    (ask['ownerPluginId'] !== undefined && typeof ask['ownerPluginId'] !== 'string') ||
    (ask['description'] !== undefined && typeof ask['description'] !== 'string') ||
    (ask['expectedStateSeq'] !== undefined && !Number.isInteger(ask['expectedStateSeq']))
  ) {
    throw new HelmError('invalid_event', 'ask.upsert 的可选字段（ownerPluginId/description/expectedStateSeq）存在时类型必须合法', 500)
  }
}

/**
 * 把 (type, payload) 组装为协议 HelmEvent；先 prune 可选 undefined，再整体递归
 * JSON 脱敏（字符串值与字段名都过 redact）。core 类型接受直接 payload 或完整
 * 事件信封；未知 type 走 CustomHelmEvent {type, payload} 原样透传（不伪报成
 * notification）；任何非法 JSON 值（循环、Date、Map 等）或 core 类型字段形状不符
 * 均抛 HelmError 不静默降级、不静默修正。
 */
export function assembleHelmEvent(
  type: string,
  payload: unknown,
  redact: (text: string) => string,
): HelmEvent {
  if (typeof type !== 'string' || type.length === 0) {
    throw new HelmError('invalid_event', '事件 type 必须是非空字符串', 500)
  }
  const clean = pruneUndefined(payload, new WeakSet())
  const redacted = redactJsonValue(clean, (t) => redact(t))
  const record =
    redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : undefined

  // 完整事件信封（payload 自带同名的 type 字段）：拆包取各类型专属字段，不二次嵌套。
  const envelope = record !== undefined && record['type'] === type ? record : undefined

  switch (type) {
    case 'conversation.upsert': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversation = source?.['conversation'] ?? source
      assertConversationSummaryShape(conversation)
      return { type, conversation: conversation as ConversationSummary }
    }
    case 'conversation.deleted': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversationId = Number(source?.['conversationId'])
      if (!Number.isInteger(conversationId)) {
        throw new HelmError('invalid_event', 'conversation.deleted 需要 number conversationId', 500)
      }
      return { type, conversationId }
    }
    case 'conversation.entry': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversationId = Number(source?.['conversationId'])
      const entry = source?.['entry']
      if (!Number.isInteger(conversationId)) {
        throw new HelmError('invalid_event', 'conversation.entry 需要 number conversationId', 500)
      }
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { kind?: unknown }).kind !== 'string'
      ) {
        throw new HelmError(
          'invalid_event',
          'conversation.entry 需要 { id: string; kind: string; ... } 形状的 entry',
          500,
        )
      }
      const taskId = (entry as { taskId?: unknown }).taskId
      if (
        taskId !== undefined &&
        (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0)
      ) {
        throw new HelmError('invalid_event', 'conversation.entry 的 taskId 必须是正整数（可缺不可错）', 500)
      }
      return { type, conversationId, entry: entry as ConversationEntry }
    }
    case 'conversation.live': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const live = source?.['live']
      if (
        live === null ||
        typeof live !== 'object' ||
        !Number.isInteger((live as { conversationId?: unknown }).conversationId) ||
        typeof (live as { text?: unknown }).text !== 'string' ||
        !Array.isArray((live as { tools?: unknown }).tools) ||
        !Number.isFinite((live as { updatedAt?: unknown }).updatedAt)
      ) {
        throw new HelmError(
          'invalid_event',
          'conversation.live 需要 { conversationId, text, tools, updatedAt } 形状的 live',
          500,
        )
      }
      const generation = (live as { generation?: unknown }).generation
      if (generation !== undefined && !isLiveGenerationShape(generation)) {
        throw new HelmError(
          'invalid_event',
          'conversation.live 的 generation 需要 { taskId: 正整数, attempt: 正整数, message?: { content, usage? } } 形状',
          500,
        )
      }
      return { type, live: live as ConversationLive }
    }
    case 'ask.upsert': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const ask = source?.['ask'] ?? source
      assertAskSpecShape(ask)
      return { type, ask: ask as AskSpec }
    }
    case 'ask.resolved': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const askId = source?.['askId']
      const status = source?.['status']
      if (typeof askId !== 'string' || (status !== 'answered' && status !== 'cancelled' && status !== 'superseded')) {
        throw new HelmError('invalid_event', 'ask.resolved 需要 string askId 与合法 status', 500)
      }
      return { type, askId, status }
    }
    case 'plugin.changed': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const plugin = source?.['plugin']
      const ui = source?.['ui']
      if (
        plugin === null ||
        typeof plugin !== 'object' ||
        typeof (plugin as { id?: unknown }).id !== 'string' ||
        !Array.isArray(ui)
      ) {
        throw new HelmError(
          'invalid_event',
          'plugin.changed 需要 { plugin: PluginSummary; ui: PluginUiContribution[] }（停用/卸载时 ui 为空数组）',
          500,
        )
      }
      return { type, plugin: plugin as HelmSnapshot['plugins'][number], ui: ui as HelmSnapshot['ui'] }
    }
    case 'plugin.doc.updated': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const doc = source?.['doc']
      if (
        doc === null ||
        typeof doc !== 'object' ||
        typeof (doc as { pluginId?: unknown }).pluginId !== 'string' ||
        typeof (doc as { name?: unknown }).name !== 'string' ||
        !('value' in (doc as Record<string, unknown>))
      ) {
        throw new HelmError(
          'invalid_event',
          'plugin.doc.updated 需要 { pluginId: string; name: string; value } 形状的 doc',
          500,
        )
      }
      return { type, doc: doc as PublicPluginDoc }
    }
    case 'plugin.session_doc.updated': {
      // 全局流防御性拒绝：会话文档事件只允许专用流（SessionDocEventHub），
      // 误投全局广播属于契约违约，显式报错而不是降级透传（防写放大回归）。
      throw new HelmError(
        'invalid_event',
        'plugin.session_doc.updated 不允许进入全局事件流（仅专用会话文档 SSE）',
        500,
      )
    }
    case 'node.changed': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const node = source?.['node']
      const removed = source?.['removed']
      if (
        node === null ||
        typeof node !== 'object' ||
        typeof (node as { id?: unknown }).id !== 'string' ||
        (node as { id?: unknown }).id === '' ||
        ((node as { kind?: unknown }).kind !== 'local' && (node as { kind?: unknown }).kind !== 'byom') ||
        typeof (node as { online?: unknown }).online !== 'boolean'
      ) {
        throw new HelmError(
          'invalid_event',
          "node.changed 需要 { node: { id: string; kind: 'local' | 'byom'; online: boolean; ... } } 形状（removed 可选）",
          500,
        )
      }
      if (removed !== undefined && typeof removed !== 'boolean') {
        throw new HelmError('invalid_event', 'node.changed 的 removed 若有必须为 boolean', 500)
      }
      return {
        type,
        node: node as NodeInfo,
        ...(typeof removed === 'boolean' ? { removed } : {}),
      }
    }
    case 'notification': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const level = source?.['level']
      const title = source?.['title']
      const body = source?.['body']
      const conversationId = source?.['conversationId']
      if (level !== 'info' && level !== 'warning' && level !== 'error') {
        throw new HelmError('invalid_event', "notification 需要 level 为 'info' | 'warning' | 'error'", 500)
      }
      if (typeof title !== 'string' || title === '') {
        throw new HelmError('invalid_event', 'notification 需要 title 为非空字符串', 500)
      }
      if (body !== undefined && typeof body !== 'string') {
        throw new HelmError('invalid_event', 'notification 的 body 若有必须为 string', 500)
      }
      if (conversationId !== undefined && (typeof conversationId !== 'number' || !Number.isInteger(conversationId))) {
        throw new HelmError('invalid_event', 'notification 的 conversationId 若有必须为整数', 500)
      }
      return {
        type,
        level,
        title,
        ...(body !== undefined ? { body } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
      }
    }
    default: {
      // CustomHelmEvent：未知 type 原样透传，不伪报成 notification。
      const custom: CustomHelmEvent = { type: String(type), payload: redacted }
      return custom
    }
  }
}

/**
 * plugin.session_doc.updated 载荷边界校验（SessionDocEventHub.dispatch 用）：
 * 先做形状门禁（doc 为 null/非对象时不得进入任何字段读取），再校验三元组
 * 字段与 deleted 约束；返回已验证的 doc（脱敏由调用方完成）。
 */
export function assertSessionDocUpdateShape(payload: unknown): PublicPluginSessionDoc {
  const source = (payload ?? undefined) as { type?: unknown; doc?: unknown } | undefined
  const doc = source?.['doc']
  if (doc === null || typeof doc !== 'object') {
    throw new HelmError(
      'invalid_event',
      'plugin.session_doc.updated 需要 { pluginId: string; name: string; conversationId: number; value } 形状的 doc',
      500,
    )
  }
  const record = doc as Record<string, unknown>
  const pluginId = record['pluginId']
  const name = record['name']
  const conversationId = record['conversationId']
  if (
    typeof pluginId !== 'string' ||
    pluginId === '' ||
    typeof name !== 'string' ||
    name === '' ||
    typeof conversationId !== 'number' ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0 ||
    !('value' in record)
  ) {
    throw new HelmError(
      'invalid_event',
      'plugin.session_doc.updated 需要 { pluginId: string; name: string; conversationId: number; value } 形状的 doc',
      500,
    )
  }
  if (record['deleted'] !== undefined && record['deleted'] !== true) {
    throw new HelmError('invalid_event', 'plugin.session_doc.updated 的 deleted 若有必须为 true', 500)
  }
  return doc as PublicPluginSessionDoc
}
