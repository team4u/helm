/**
 * 边界字段校验：机械类型/形状/未知字段规则统一走 JSON Schema（AJV，
 * 与插件动作入参同一套 @helm/protocol 校验器），复杂跨字段语义与
 * 逐项业务断言保留手写；非法输入统一 400 validation_error。
 *
 * 不用 `as` 断言充当校验——schema 校验通过后的类型收窄会注明依据。
 */
import { HelmError, validateOrThrow, type JsonSchema } from '@helm/protocol'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
  type ProfileStarterPrompt,
} from '@helm/protocol'
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
/** ID_PATTERN 的 JSON Schema pattern 形态（AJV 以 ECMA-262 编译，同语义）。 */
const ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
/** 节点 ID 规则（字母数字开头，可含 . _ -，长度 1..128）。 */
export const NODE_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
/** 安全正整数上界：与 Number.isSafeInteger 同一口径（schema integer 不查安全界）。 */
const MAX_SAFE_INTEGER = 9007199254740991

export class ValidationError extends HelmError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details)
  }
}

/**
 * JSON Schema body 校验：复用 @helm/protocol 的 AJV 封装（编译缓存、
 * $async 拒绝、字段路径诊断），失败换抛 HTTP 边界的 ValidationError
 * （同一 400 validation_error 契约；消息含 instancePath 定位，details
 * 携带 AJV 错误清单）。schema 只做机械形状（类型/长度/枚举/未知字段），
 * 语义规则（跨字段互斥、trim 语义、路径绝对性等）留在调用方手写。
 */
export function assertBodySchema(schema: JsonSchema, value: unknown, what: string): void {
  try {
    validateOrThrow(schema, value, what)
  } catch (error) {
    if (error instanceof HelmError && error.code === 'validation_error') {
      throw new ValidationError(error.message, error.details)
    }
    throw error
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

/** 跨平台绝对路径：POSIX `/`、Windows 盘符 `^[a-zA-Z]:[\\/]` 与 UNC `^\\\\[^\\]+\\[^\\]+`。
 * 与 runtime/tools.ts 的 isAbsoluteTargetPath 同一语义（内核不依赖宿主平台
 * 规则判定远端/Windows 靶点路径形状）。 */
function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
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

/** 可选 nodeId 字段：非空字符串 + 节点 ID 格式（字母数字开头，可含 . _ -）。
 * 会话 init/patch 与 Profile body 共用同一规则（原先两份重复实现已合并）。 */
export function optionalNodeId(body: Record<string, unknown>): string | undefined {
  const value = body['nodeId']
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ValidationError('nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）')
  }
  return value
}

// ---------------------------------------------------------------------------
// 会话 body（init / patch / input / reset / compact / fork / withdraw）
// ---------------------------------------------------------------------------

/** init 与 patch 共用的可选字段（title/profileId/tags/nodeId/cwd 同一规则，原先两份重复已合并）。 */
function parseConversationCommonFields(body: Record<string, unknown>): ConversationInit {
  const out: ConversationInit = {}
  const title = optionalString(body, 'title', { maxLength: 200, minLength: 1 })
  if (title !== undefined) out.title = title
  const profileId = optionalString(body, 'profileId')
  if (profileId !== undefined) {
    if (!ID_PATTERN.test(profileId)) throw new ValidationError('profileId 需为合法标识符')
    out.profileId = profileId
  }
  const tags = optionalStringArray(body, 'tags')
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) {
      throw new ValidationError('tags 每项需为 1-64 字符')
    }
    out.tags = tags
  }
  const nodeId = optionalNodeId(body)
  if (nodeId !== undefined) out.nodeId = nodeId
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined) {
    if (!isCrossPlatformAbsolutePath(cwd)) {
      throw new ValidationError('cwd 需为绝对路径（POSIX / 开头、Windows 盘符 C:\\ 或 UNC \\\\server\\share）')
    }
    out.cwd = cwd
  }
  return out
}

export function parseConversationInit(body: Record<string, unknown>): ConversationInit {
  const init = parseConversationCommonFields(body)
  const parent = optionalNumber(body, 'parentConversationId')
  if (parent !== undefined) {
    if (!Number.isInteger(parent) || parent <= 0) {
      throw new ValidationError('parentConversationId 需为正整数')
    }
    init.parentConversationId = parent
  }
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new ValidationError('model 需为 provider/model 形式')
    init.model = model
  }
  rejectUnknownKeys(body, new Set([...Object.keys(init), 'nodeId']))
  return init
}

export function parseConversationPatch(body: Record<string, unknown>): ConversationPatch {
  const patch: ConversationPatch = parseConversationCommonFields(body)
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    // PATCH 专属语义：'' = 清除显式覆盖（重算 Profile/全局继承链）；
    // create（parseConversationInit）仍要求 provider/model，不接受空串。
    if (model !== '' && !/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new ValidationError("model 需为 provider/model 形式或空串（空串 = 清除覆盖）")
    }
    patch.model = model
  }
  const thinkingLevel = optionalEnum(body, 'thinkingLevel', ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
  if (thinkingLevel !== undefined) patch.thinkingLevel = thinkingLevel
  const unread = optionalBoolean(body, 'unread')
  if (unread !== undefined) patch.unread = unread
  const pinned = optionalBoolean(body, 'pinned')
  if (pinned !== undefined) patch.pinned = pinned
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('PATCH body 至少包含一个可更新字段')
  }
  rejectUnknownKeys(body, new Set(['title', 'profileId', 'tags', 'nodeId', 'cwd', 'model', 'thinkingLevel', 'unread', 'pinned']))
  return patch
}

const INPUT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 512 * 1024 },
    whenBusy: { enum: ['steer', 'followUp', 'reject'] },
    origin: { enum: ['human', 'agent', 'trigger'] },
    meta: { type: 'object' },
    attachments: { type: 'array', items: { type: 'string', pattern: ID_PATTERN_SOURCE } },
    replaceFromEntryId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
  },
  required: ['text'],
  additionalProperties: false,
}

export function parseInputBody(body: Record<string, unknown>): {
  text: string
  whenBusy?: WhenBusy
  origin?: InputOrigin
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
} {
  // 机械形状（text 类型/长度、枚举、附件 ID 格式、未知字段）走 schema；
  // meta 递归 JSON-safe 与附件去重/空数组语义是业务规则，手写保留。
  assertBodySchema(INPUT_BODY_SCHEMA, body, 'input body')
  const meta = parseMetaObject(body.meta)
  const attachments = parseAttachmentIds(body.attachments)
  return {
    text: body.text as string,
    ...(body.whenBusy !== undefined ? { whenBusy: body.whenBusy as WhenBusy } : {}),
    ...(body.origin !== undefined ? { origin: body.origin as InputOrigin } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(body.replaceFromEntryId !== undefined ? { replaceFromEntryId: body.replaceFromEntryId as number } : {}),
  }
}

/** 附件 ID 列表：逐项 ID_PATTERN 已由 schema 保证；此处只做去重与空数组视为未提供。 */
function parseAttachmentIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = [...new Set(raw as string[])]
  return ids.length > 0 ? ids : undefined
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

const ASK_ANSWER_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answers: { type: 'object', additionalProperties: { type: 'string' } },
    expectedStateSeq: { type: 'integer', minimum: 0 },
  },
  required: ['answers'],
  additionalProperties: false,
}

export function parseAskAnswerBody(body: Record<string, unknown>): {
  answers: Record<string, string>
  expectedStateSeq?: number
} {
  assertBodySchema(ASK_ANSWER_BODY_SCHEMA, body, 'ask answer body')
  return {
    answers: { ...(body.answers as Record<string, string>) },
    ...(body.expectedStateSeq !== undefined ? { expectedStateSeq: body.expectedStateSeq as number } : {}),
  }
}

// ---------------------------------------------------------------------------
// 会话上下文操作 body（reset / compact / fork / withdraw）：纯机械形状全走 schema
// ---------------------------------------------------------------------------

const CONVERSATION_RESET_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { handoff: { type: 'string', maxLength: 512 * 1024 } },
  additionalProperties: false,
}

/** POST /api/conversations/:id/reset：可选 handoff 文本。 */
export function parseConversationResetBody(body: Record<string, unknown>): { handoff?: string } {
  assertBodySchema(CONVERSATION_RESET_BODY_SCHEMA, body, 'reset body')
  return body.handoff !== undefined ? { handoff: body.handoff as string } : {}
}

const CONVERSATION_COMPACT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { instructions: { type: 'string', maxLength: 512 * 1024 } },
  additionalProperties: false,
}

/** POST /api/conversations/:id/compact：可选 instructions 文本。 */
export function parseConversationCompactBody(body: Record<string, unknown>): { instructions?: string } {
  assertBodySchema(CONVERSATION_COMPACT_BODY_SCHEMA, body, 'compact body')
  return body.instructions !== undefined ? { instructions: body.instructions as string } : {}
}

const CONVERSATION_FORK_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entryId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
    title: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['entryId'],
  additionalProperties: false,
}

/** POST /api/conversations/:id/fork：entryId 必填安全正整数；title 可选 1..200。 */
export function parseConversationForkBody(body: Record<string, unknown>): { entryId: number; title?: string } {
  assertBodySchema(CONVERSATION_FORK_BODY_SCHEMA, body, 'fork body')
  return {
    entryId: body.entryId as number,
    ...(body.title !== undefined ? { title: body.title as string } : {}),
  }
}

const CONVERSATION_WITHDRAW_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { submissionId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER } },
  required: ['submissionId'],
  additionalProperties: false,
}

/** POST /api/conversations/:id/withdraw：submissionId 必填安全正整数。 */
export function parseConversationWithdrawBody(body: Record<string, unknown>): { submissionId: number } {
  assertBodySchema(CONVERSATION_WITHDRAW_BODY_SCHEMA, body, 'withdraw body')
  return { submissionId: body.submissionId as number }
}

// ---------------------------------------------------------------------------
// Profile body（跨字段语义重，保持手写组合）
// ---------------------------------------------------------------------------

export function parseProfileBody(body: Record<string, unknown>, opts: { requireId: boolean }): Profile {
  const id = opts.requireId ? requireValidId(body, 'id') : optionalValidId(body, 'id')
  const name = optionalString(body, 'name')
  const model = optionalString(body, 'model')
  const thinkingLevel = optionalEnum(body, 'thinkingLevel', ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
  const tags = optionalStringArray(body, 'tags')
  // 技能白名单：字符串数组，元素须为合法 skill id，重复去重；未知/暂缺 id
  // 允许保存（运行时技能目录可能后装，与 ProfileService.validateProfileInput 同规）。
  const skillsRaw = optionalStringArray(body, 'skills')
  let skills: string[] | undefined
  if (skillsRaw !== undefined) {
    const seen = new Set<string>()
    for (const skillId of skillsRaw) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(skillId)) {
        throw new ValidationError(`skills 每项需为合法 skill id（字母数字开头，可含 . _ -，长度 1-64）: ${skillId}`)
      }
      seen.add(skillId)
    }
    skills = [...seen]
  }
  const runtime = parseProfileRuntime(body.runtime)
  const managedByPlugin = optionalString(body, 'managedByPlugin')
  if (managedByPlugin !== undefined && managedByPlugin.trim() === '') {
    throw new ValidationError('managedByPlugin 需为非空插件 ID')
  }
  const humanSelectable = optionalBoolean(body, 'humanSelectable')
  const starters = parseProfileStarters(body.starters)
  const system = optionalString(body, 'system', { maxLength: 512 * 1024 })
  rejectUnknownKeys(body, new Set(['id', 'name', 'model', 'thinkingLevel', 'nodeId', 'cwd', 'tags', 'skills', 'starters', 'runtime', 'managedByPlugin', 'humanSelectable', 'system']))
  const nodeId = optionalNodeId(body)
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined && cwd.length === 0) throw new ValidationError('cwd 需为非空字符串')
  const profile: Profile = { ...(id !== undefined ? { id } : {}) } as Profile
  if (name !== undefined) profile.name = name
  if (model !== undefined) {
    if (model !== '' && !/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new ValidationError('model 需为 provider/model 形式或空串')
    }
    if (model !== '') profile.model = model
  }
  if (thinkingLevel !== undefined && thinkingLevel !== '') profile.thinkingLevel = thinkingLevel
  if (nodeId !== undefined) profile.nodeId = nodeId
  if (cwd !== undefined) profile.cwd = cwd
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) throw new ValidationError('tags 每项需为 1-64 字符')
    profile.tags = tags
  }
  if (runtime !== undefined) profile.runtime = runtime
  if (skills !== undefined) profile.skills = skills
  if (managedByPlugin !== undefined) profile.managedByPlugin = managedByPlugin
  if (humanSelectable !== undefined) profile.humanSelectable = humanSelectable
  if (starters !== undefined) profile.starters = starters
  if (system !== undefined) profile.system = system
  return profile
}

/** Profile starters：与 ProfileService.validateProfileInput 同规的边界校验
 * （不在 HTTP 层丢弃非法项——服务层只会拒绝，不会修正）。 */
function parseProfileStarters(raw: unknown): ProfileStarterPrompt[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new ValidationError('starters 需为 { label, prompt } 对象数组')
  if (raw.length > PROFILE_STARTERS_MAX_ITEMS) {
    throw new ValidationError(`starters 最多 ${PROFILE_STARTERS_MAX_ITEMS} 项`)
  }
  const pointLength = (text: string): number => {
    let count = 0
    for (const _ of text) count += 1
    return count
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`starters[${index}] 需为 { label, prompt } 对象`)
    }
    if (Object.keys(item).some((key) => key !== 'label' && key !== 'prompt')) {
      throw new ValidationError(`starters[${index}] 仅接受 label 与 prompt 字段`)
    }
    const { label, prompt } = item as Record<string, unknown>
    if (typeof label !== 'string') throw new ValidationError(`starters[${index}].label 需为字符串`)
    if (typeof prompt !== 'string') throw new ValidationError(`starters[${index}].prompt 需为字符串`)
    const trimmed = label.trim()
    if (pointLength(trimmed) === 0) throw new ValidationError(`starters[${index}].label 去除首尾空白后不能为空`)
    if (pointLength(trimmed) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].label 最多 ${PROFILE_STARTER_LABEL_MAX_LENGTH} 个 Unicode 码点`)
    }
    if (prompt.trim() === '') throw new ValidationError(`starters[${index}].prompt 不能是纯空白`)
    if (pointLength(prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].prompt 最多 ${PROFILE_STARTER_PROMPT_MAX_LENGTH} 个 Unicode 码点`)
    }
    return { label: trimmed, prompt }
  })
}

function parseProfileRuntime(raw: unknown): ProfileRuntime | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('runtime 需为对象')
  }
  const runtime = raw as Record<string, unknown>
  rejectUnknownKeys(runtime, new Set(['kind', 'agent', 'args', 'nodeId', 'workspace', 'env']))
  // 内核零插件枚举硬编码：kind 只校验外部运行时标识格式，具体运行时是否
  // 被插件接管由 agent_spawn 钩子管道决定（与 services/profiles-skills.ts 同规）。
  if (
    typeof runtime.kind !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(runtime.kind)
  ) {
    throw new ValidationError('runtime.kind 需为外部运行时标识符（小写字母开头，可含 a-z 0-9 _ -，长度 1..32）')
  }
  if (typeof runtime.agent !== 'string' || runtime.agent.length === 0) {
    throw new ValidationError('runtime.agent 需为非空字符串')
  }
  const args = runtime.args
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    throw new ValidationError('runtime.args 需为字符串数组')
  }
  // nodeId / workspace：非空 string（缺省不限；空串拒绝）
  const nodeId = runtime.nodeId
  if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId.length === 0)) {
    throw new ValidationError('runtime.nodeId 需为非空字符串')
  }
  const workspace = runtime.workspace
  if (workspace !== undefined) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new ValidationError('runtime.workspace 需为非空字符串')
    }
    if (!isCrossPlatformAbsolutePath(workspace)) {
      throw new ValidationError('runtime.workspace 需为跨平台绝对路径（POSIX /、Windows 盘符或 UNC）')
    }
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
    kind: runtime.kind as string,
    agent: runtime.agent,
    ...(args !== undefined ? { args } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
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

// ---------------------------------------------------------------------------
// providers / credentials / actions / plugin config body
// ---------------------------------------------------------------------------

const PROVIDERS_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: ID_PATTERN_SOURCE },
          protocol: { enum: ['openai', 'anthropic'] },
          baseUrl: { type: 'string', pattern: '^https?://' },
          models: { type: 'array', items: { type: 'string' } },
          label: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'protocol', 'baseUrl', 'models', 'enabled'],
        additionalProperties: false,
      },
    },
  },
  required: ['providers'],
  additionalProperties: false,
}

/**
 * providers PUT body（对象形态）：{ providers: [...] }。数组形态由路由层
 * （parseProvidersBodyValue，CLI 完整原始数组约定）包装后复用本函数，
 * 两种形态走同一套逐项 schema 校验。
 */
export function parseProvidersBody(body: Record<string, unknown>): ProviderConfig[] {
  assertBodySchema(PROVIDERS_BODY_SCHEMA, body, 'providers body')
  const items = body.providers as Record<string, unknown>[]
  return items.map((p) => ({
    id: p.id as string,
    protocol: p.protocol as 'openai' | 'anthropic',
    baseUrl: p.baseUrl as string,
    models: p.models as string[],
    ...(p.label !== undefined ? { label: p.label as string } : {}),
    enabled: p.enabled as boolean,
  }))
}

const CREDENTIAL_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { value: { type: 'string', minLength: 1, maxLength: 64 * 1024 } },
  required: ['value'],
  additionalProperties: false,
}

export function parseCredentialBody(body: Record<string, unknown>): string {
  assertBodySchema(CREDENTIAL_BODY_SCHEMA, body, 'credential body')
  return body.value as string
}

const ACTION_INVOKE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    // input 为任意 JSON 值（含 null）；只要求键存在。
    input: true,
    conversationId: { type: 'integer', minimum: 1 },
  },
  required: ['input'],
  additionalProperties: false,
}

export function parseActionInvokeBody(body: Record<string, unknown>): {
  input: unknown
  conversationId?: number
} {
  assertBodySchema(ACTION_INVOKE_BODY_SCHEMA, body, 'action invoke body')
  return {
    input: body.input,
    ...(body.conversationId !== undefined ? { conversationId: body.conversationId as number } : {}),
  }
}

const PLUGIN_CONFIG_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    values: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
  },
  required: ['values'],
  additionalProperties: false,
}

export function parsePluginConfigBody(body: Record<string, unknown>): Record<string, unknown> {
  assertBodySchema(PLUGIN_CONFIG_BODY_SCHEMA, body, 'plugin config body')
  return { ...(body.values as Record<string, unknown>) }
}

/** 手写组合校验器（schema 未覆盖的跨字段规则）专用：拒绝未知字段。 */
export function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new ValidationError(`不支持的字段: ${unknown.join(', ')}`)
  }
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
