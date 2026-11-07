/**
 * 边界字段校验：每个 HTTP body 字段显式检查类型与形状，
 * 不用 `as` 断言充当校验；非法输入统一 400 validation_error。
 */
import { HelmError } from '@helm/protocol'
import type {
  ConversationInit,
  ConversationPatch,
  InputOrigin,
  Profile,
  ProfileRuntime,
  ProviderConfig,
  WhenBusy,
} from '@helm/protocol'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class ValidationError extends HelmError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details)
  }
}

export function requireString(body: Record<string, unknown>, field: string, opts?: { maxLength?: number; minLength?: number }): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 需为字符串`)
  }
  if (opts?.minLength !== undefined && value.length < opts.minLength) {
    throw new ValidationError(`${field} 长度需 >= ${opts.minLength}`)
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    throw new ValidationError(`${field} 长度需 <= ${opts.maxLength}`)
  }
  return value
}

export function optionalString(body: Record<string, unknown>, field: string, opts?: { maxLength?: number; minLength?: number }): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined
  return requireString(body, field, opts)
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 需为有限数字`)
  }
  return value
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} 需为 boolean`)
  }
  return value
}

export function optionalEnum<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} 需为 ${allowed.join(' | ')}`)
  }
  return value as T
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} 需为字符串数组`)
  }
  return value as string[]
}

/** 路径参数里的数字 ID：非纯数字直接 400，不给服务层。 */
export function parseIdParam(raw: string, field = 'id'): number {
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${field} 需为正整数`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ValidationError(`${field} 需为正整数`)
  }
  return n
}

/** 标识符参数（askId / pluginId / actionId / runId / profileId / artifactId）。 */
export function requireIdParam(raw: string, field: string): string {
  if (!ID_PATTERN.test(raw)) {
    throw new ValidationError(`${field} 需为合法标识符（字母数字开头，可含 . _ : -）`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// 组合校验器
// ---------------------------------------------------------------------------

export function parseConversationInit(body: Record<string, unknown>): ConversationInit {
  const init: ConversationInit = {}
  const title = optionalString(body, 'title', { maxLength: 200, minLength: 1 })
  if (title !== undefined) init.title = title
  const profileId = optionalString(body, 'profileId')
  if (profileId !== undefined) {
    if (!ID_PATTERN.test(profileId)) throw new ValidationError('profileId 需为合法标识符')
    init.profileId = profileId
  }
  const tags = optionalStringArray(body, 'tags')
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) {
      throw new ValidationError('tags 每项需为 1-64 字符')
    }
    init.tags = tags
  }
  const parent = optionalNumber(body, 'parentConversationId')
  if (parent !== undefined) {
    if (!Number.isInteger(parent) || parent <= 0) {
      throw new ValidationError('parentConversationId 需为正整数')
    }
    init.parentConversationId = parent
  }
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined) {
    if (!cwd.startsWith('/')) throw new ValidationError('cwd 需为绝对路径')
    init.cwd = cwd
  }
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(model)) throw new ValidationError('model 需为 provider/model 形式')
    init.model = model
  }
  rejectUnknownKeys(body, new Set(Object.keys(init)))
  return init
}

export function parseConversationPatch(body: Record<string, unknown>): ConversationPatch {
  const patch: ConversationPatch = {}
  const title = optionalString(body, 'title', { maxLength: 200, minLength: 1 })
  if (title !== undefined) patch.title = title
  const profileId = optionalString(body, 'profileId')
  if (profileId !== undefined) {
    if (!ID_PATTERN.test(profileId)) throw new ValidationError('profileId 需为合法标识符')
    patch.profileId = profileId
  }
  const tags = optionalStringArray(body, 'tags')
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) {
      throw new ValidationError('tags 每项需为 1-64 字符')
    }
    patch.tags = tags
  }
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined) {
    if (!cwd.startsWith('/')) throw new ValidationError('cwd 需为绝对路径')
    patch.cwd = cwd
  }
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    // PATCH 专属语义：'' = 清除显式覆盖（重算 Profile/全局继承链）；
    // create（parseConversationInit）仍要求 provider/model，不接受空串。
    if (model !== '' && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
      throw new ValidationError("model 需为 provider/model 形式或空串（空串 = 清除覆盖）")
    }
    patch.model = model
  }
  const unread = optionalBoolean(body, 'unread')
  if (unread !== undefined) patch.unread = unread
  const pinned = optionalBoolean(body, 'pinned')
  if (pinned !== undefined) patch.pinned = pinned
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('PATCH body 至少包含一个可更新字段')
  }
  rejectUnknownKeys(body, new Set(['title', 'profileId', 'tags', 'cwd', 'model', 'unread', 'pinned']))
  return patch
}

export function parseInputBody(body: Record<string, unknown>): {
  text: string
  whenBusy?: WhenBusy
  origin?: InputOrigin
  meta?: Record<string, unknown>
  attachments?: string[]
} {
  const text = requireString(body, 'text', { maxLength: 512 * 1024 })
  const whenBusy = optionalEnum(body, 'whenBusy', ['steer', 'followUp', 'reject'] as const)
  const origin = optionalEnum(body, 'origin', ['human', 'agent', 'trigger'] as const)
  const meta = parseMetaObject(body.meta)
  const attachments = parseAttachmentIds(body.attachments)
  rejectUnknownKeys(body, new Set(['text', 'whenBusy', 'origin', 'meta', 'attachments']))
  return {
    text,
    ...(whenBusy !== undefined ? { whenBusy } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
}

/** 附件 ID 列表：字符串数组，逐项须满足 ID_PATTERN，去重；空数组视为未提供。 */
function parseAttachmentIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new ValidationError('attachments 需为字符串数组')
  }
  const ids = raw as string[]
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) {
      throw new ValidationError(`attachments 含非法产物 ID：${id}`)
    }
  }
  const unique = [...new Set(ids)]
  return unique.length > 0 ? unique : undefined
}

/** 纯 JSON 对象校验（非对象 JSON——数组/标量拒绝）；逐值递归验证 JSON-safe。 */
function parseMetaObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('meta 需为 JSON 对象')
  }
  assertJsonSafe('meta', raw as Record<string, unknown>)
  return structuredClone(raw) as Record<string, unknown>
}

/** 递归 JSON-safe 校验：undefined/函数/循环等非 JSON 值在边界拒绝。 */
function assertJsonSafe(path: string, value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new ValidationError(`${path} 含非 JSON 值（${typeof value}）`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(`${path}[${i}]`, item))
    return
  }
  if (typeof value === 'object') {
    // 拒绝原型链污染对象：仅接受 plain object 与已克隆安全形态
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(`${path} 仅接受纯 JSON 对象`)
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(`${path}.${key}`, item)
    }
  }
}

export function parseAskAnswerBody(body: Record<string, unknown>): {
  answers: Record<string, string>
  expectedStateSeq?: number
} {
  const raw = body.answers
  if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('answers 需为对象')
  }
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new ValidationError(`answers.${key} 需为字符串`)
    }
    answers[key] = value
  }
  const seq = optionalNumber(body, 'expectedStateSeq')
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 0)) {
    throw new ValidationError('expectedStateSeq 需为非负整数')
  }
  rejectUnknownKeys(body, new Set(['answers', 'expectedStateSeq']))
  return { answers, ...(seq !== undefined ? { expectedStateSeq: seq } : {}) }
}

export function parseProfileBody(body: Record<string, unknown>, opts: { requireId: boolean }): Profile {
  const id = opts.requireId ? requireValidId(body, 'id') : optionalValidId(body, 'id')
  const name = optionalString(body, 'name')
  const model = optionalString(body, 'model')
  const tags = optionalStringArray(body, 'tags')
  const runtime = parseProfileRuntime(body.runtime)
  rejectUnknownKeys(body, new Set(['id', 'name', 'model', 'tags', 'runtime']))
  const profile: Profile = { ...(id !== undefined ? { id } : {}) } as Profile
  if (name !== undefined) profile.name = name
  if (model !== undefined) {
    if (model !== '' && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
      throw new ValidationError('model 需为 provider/model 形式或空串')
    }
    if (model !== '') profile.model = model
  }
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) throw new ValidationError('tags 每项需为 1-64 字符')
    profile.tags = tags
  }
  if (runtime !== undefined) profile.runtime = runtime
  return profile
}

function parseProfileRuntime(raw: unknown): ProfileRuntime | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('runtime 需为对象')
  }
  const runtime = raw as Record<string, unknown>
  rejectUnknownKeys(runtime, new Set(['kind', 'agent', 'args', 'machine', 'workspace', 'env']))
  if (runtime.kind !== 'herdr') throw new ValidationError("runtime.kind 当前仅支持 'herdr'")
  if (typeof runtime.agent !== 'string' || runtime.agent.length === 0) {
    throw new ValidationError('runtime.agent 需为非空字符串')
  }
  const args = runtime.args
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    throw new ValidationError('runtime.args 需为字符串数组')
  }
  // machine / workspace：非空 string（缺省不限；空串拒绝）
  const machine = runtime.machine
  if (machine !== undefined && (typeof machine !== 'string' || machine.length === 0)) {
    throw new ValidationError('runtime.machine 需为非空字符串')
  }
  const workspace = runtime.workspace
  if (workspace !== undefined && (typeof workspace !== 'string' || workspace.length === 0)) {
    throw new ValidationError('runtime.workspace 需为非空字符串')
  }
  // env：string -> string 映射；键非空，值一律字符串
  const env = runtime.env
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new ValidationError('runtime.env 需为字符串映射对象')
    }
    for (const [key, value] of Object.entries(env)) {
      if (key.length === 0) throw new ValidationError('runtime.env 键需为非空字符串')
      if (typeof value !== 'string') throw new ValidationError(`runtime.env.${key} 需为字符串`)
    }
  }
  return {
    kind: 'herdr',
    agent: runtime.agent,
    ...(args !== undefined ? { args } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(env !== undefined ? { env: { ...(env as Record<string, string>) } } : {}),
  }
}

function requireValidId(body: Record<string, unknown>, field: string): string {
  const id = requireString(body, field)
  if (!ID_PATTERN.test(id)) throw new ValidationError(`${field} 需为合法标识符`)
  return id
}

function optionalValidId(body: Record<string, unknown>, field: string): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined
  return requireValidId(body, field)
}

/**
 * providers PUT body（对象形态）：{ providers: [...] }。数组形态由路由层
 * （parseProvidersBodyValue，CLI 完整原始数组约定）色装后复用本函数，
 * 两种形态走同一套逐项严格校验。
 */
export function parseProvidersBody(body: Record<string, unknown>): ProviderConfig[] {
  const raw = body.providers
  if (!Array.isArray(raw)) {
    throw new ValidationError('body 需为 { providers: [...] }')
  }
  rejectUnknownKeys(body, new Set(['providers']))
  const out: ProviderConfig[] = []
  let index = 0
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`providers[${index}] 需为对象`)
    }
    const p = item as Record<string, unknown>
    const id = p.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ValidationError(`providers[${index}].id 需为合法标识符`)
    }
    const protocol = p.protocol
    if (protocol !== 'openai' && protocol !== 'anthropic') {
      throw new ValidationError(`providers[${index}].protocol 需为 'openai' | 'anthropic'`)
    }
    const baseUrl = p.baseUrl
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
      throw new ValidationError(`providers[${index}].baseUrl 需为 http(s) URL`)
    }
    const models = p.models
    if (!Array.isArray(models) || models.some((m) => typeof m !== 'string')) {
      throw new ValidationError(`providers[${index}].models 需为字符串数组`)
    }
    const label = p.label
    if (label !== undefined && typeof label !== 'string') {
      throw new ValidationError(`providers[${index}].label 需为字符串`)
    }
    const enabled = p.enabled
    if (typeof enabled !== 'boolean') {
      throw new ValidationError(`providers[${index}].enabled 需为 boolean`)
    }
    rejectUnknownKeys(p, new Set(['id', 'protocol', 'baseUrl', 'models', 'label', 'enabled']))
    out.push({
      id,
      protocol,
      baseUrl,
      models: models as string[],
      ...(label !== undefined ? { label } : {}),
      enabled,
    })
    index++
  }
  return out
}

export function parseCredentialBody(body: Record<string, unknown>): string {
  const value = requireString(body, 'value', { minLength: 1, maxLength: 64 * 1024 })
  rejectUnknownKeys(body, new Set(['value']))
  return value
}

export function parseActionInvokeBody(body: Record<string, unknown>): {
  input: unknown
  conversationId?: number
} {
  if (!('input' in body)) {
    throw new ValidationError('body 需包含 input 字段')
  }
  rejectUnknownKeys(body, new Set(['input', 'conversationId']))
  const conversationId = optionalNumber(body, 'conversationId')
  if (conversationId !== undefined && (!Number.isInteger(conversationId) || conversationId <= 0)) {
    throw new ValidationError('conversationId 需为正整数')
  }
  return { input: body.input, ...(conversationId !== undefined ? { conversationId } : {}) }
}

export function parseWorkflowRunBody(body: Record<string, unknown>) {
  const name = optionalString(body, 'name')
  const script = optionalString(body, 'script')
  const scriptPath = optionalString(body, 'scriptPath')
  const resumeFromRunId = optionalString(body, 'resumeFromRunId')
  const conversationIdRaw = optionalNumber(body, 'conversationId')
  if (conversationIdRaw !== undefined && (!Number.isInteger(conversationIdRaw) || conversationIdRaw <= 0)) {
    throw new ValidationError('conversationId 需为正整数')
  }
  const sources = [name, script, scriptPath].filter((v) => v !== undefined).length
  if (sources !== 1) {
    throw new ValidationError('name / script / scriptPath 必须恰好提供一个')
  }
  if (name !== undefined && !ID_PATTERN.test(name)) {
    throw new ValidationError('name 需为合法标识符')
  }
  if (scriptPath !== undefined && !scriptPath.startsWith('/')) {
    throw new ValidationError('scriptPath 需为绝对路径')
  }
  rejectUnknownKeys(body, new Set(['name', 'script', 'scriptPath', 'args', 'resumeFromRunId', 'conversationId']))
  return {
    ...(name !== undefined ? { name } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...('args' in body ? { args: body.args } : {}),
    ...(resumeFromRunId !== undefined ? { resumeFromRunId } : {}),
    ...(conversationIdRaw !== undefined ? { conversationId: conversationIdRaw } : {}),
  }
}

export function parsePluginConfigBody(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.values
  if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('body 需为 { values: object }')
  }
  rejectUnknownKeys(body, new Set(['values']))
  const values: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      values[k] = v
    } else {
      throw new ValidationError(`values.${k} 需为标量`)
    }
  }
  return values
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new ValidationError(`不支持的字段: ${unknown.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// 会话上下文操作 body（reset / compact / fork）
// ---------------------------------------------------------------------------

/** POST /api/conversations/:id/reset：可选 handoff 文本。 */
export function parseConversationResetBody(body: Record<string, unknown>): { handoff?: string } {
  const handoff = optionalString(body, 'handoff', { maxLength: 512 * 1024 })
  rejectUnknownKeys(body, new Set(['handoff']))
  return handoff !== undefined ? { handoff } : {}
}

/** POST /api/conversations/:id/compact：可选 instructions 文本。 */
export function parseConversationCompactBody(body: Record<string, unknown>): { instructions?: string } {
  const instructions = optionalString(body, 'instructions', { maxLength: 512 * 1024 })
  rejectUnknownKeys(body, new Set(['instructions']))
  return instructions !== undefined ? { instructions } : {}
}

/** POST /api/conversations/:id/fork：entryId 必填正整数；title 可选 1..200。 */
export function parseConversationForkBody(body: Record<string, unknown>): { entryId: number; title?: string } {
  const raw = body.entryId
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ValidationError('entryId 需为正整数')
  }
  const title = optionalString(body, 'title', { minLength: 1, maxLength: 200 })
  rejectUnknownKeys(body, new Set(['entryId', 'title']))
  return { entryId: raw, ...(title !== undefined ? { title } : {}) }
}

// ---------------------------------------------------------------------------
// Query 解析（GET /api/conversations/:id）
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 500

/** 会话详情分页参数：limit 正整数≤上限；cursor 非空原始字符串（不透明透传）。 */
export function parseDetailPagination(url: URL): { limit?: number; cursor?: string } {
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(Number(limitRaw)) || Number(limitRaw) < 1) {
      throw new ValidationError('limit 需为正整数')
    }
    limit = Number(limitRaw)
    if (limit > MAX_PAGE_LIMIT) {
      throw new ValidationError(`limit 需 <= ${MAX_PAGE_LIMIT}`)
    }
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  if (cursor !== undefined && cursor.length === 0) {
    throw new ValidationError('cursor 需为非空字符串')
  }
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) }
}

/** 插件公共文档名（GET /api/plugins/:id/docs/:name）：标识符约束同 doc 声明。 */
export function parseDocNameParam(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new ValidationError('doc name 需为合法标识符（字母数字开头，可含 . _ -）')
  }
  return raw
}
