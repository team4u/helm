/**
 * Profile 编辑器纯数据模型（ProfileEditorModal 消费）。
 *
 * 保存语义与真实 HTTP 层一致：PUT /profiles/:id 经 routes.ts 调
 * profiles.save({...profile, id})，validateProfileInput 后整体重写
 * profile.json——省略的基础字段即被删除，而不是保留旧值。因此：
 * - 基础配置（name/model/nodeId/cwd/tags/runtime）无论是否修改，一律
 *   提交规范化后的完整形态：用户只改展示名也绝不丢执行节点与运行时；
 * - system 是按需的文件更新而非整体替换：仅在用户显式编辑（或新建）时
 *   提交全文。MEMORY.md 由 builtin:memory 插件自治管理，不经本模型。
 */

import type { Profile, ProfileRuntime } from '@helm/protocol'

export interface EnvPair {
  key: string
  value: string
}

export interface ProfileDraft {
  profile: Profile
  /** 加载时的基线快照：dirty 判断与规范化对比的基准。 */
  baseline: Profile
  /** 用户显式编辑过的大文本字段（system）。 */
  editedFields: Set<'system'>
}

export function profileIdValid(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

export function tagsToText(tags: string[] | undefined): string {
  return (tags ?? []).join(', ')
}

export function textToTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function envToPairs(env: Record<string, string> | undefined): EnvPair[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
}

export function pairsToEnv(pairs: EnvPair[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const p of pairs) {
    const k = p.key.trim()
    if (k) env[k] = p.value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/** Args 多行编辑文本 -> 参数数组：每行一个参数，仅去除行首尾空白，保留参数内部空格。 */
export function argsTextToArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 参数数组 -> 多行编辑文本。 */
export function argsToText(args: string[] | undefined): string {
  return (args ?? []).join('\n')
}

/**
 * runtime 规范化：nodeId / workspace 空白归一后为空则省略；env 空省略；
 * args 仅去除每项首尾空白（保留内部空格），空数组省略。
 */
export function normalizeRuntime(runtime: ProfileRuntime | undefined): ProfileRuntime | undefined {
  if (runtime === undefined) return undefined
  const normalized: ProfileRuntime = { kind: runtime.kind, agent: runtime.agent }
  const args = (runtime.args ?? []).map((a) => a.trim()).filter((a) => a.length > 0)
  if (args.length > 0) normalized.args = args
  const nodeId = runtime.nodeId?.trim()
  if (nodeId) normalized.nodeId = nodeId
  const workspace = runtime.workspace?.trim()
  if (workspace) normalized.workspace = workspace
  const env = pairsToEnv(envToPairs(runtime.env))
  if (env) normalized.env = env
  return normalized
}

export function createDraft(profile: Profile): ProfileDraft {
  return { profile, baseline: profile, editedFields: new Set() }
}

/** 编辑基础字段（id / name / model / nodeId / cwd / tags / runtime 整体替换）。 */
export function editProfileField(draft: ProfileDraft, patch: Partial<Profile>): ProfileDraft {
  return { ...draft, profile: { ...draft.profile, ...patch } }
}

/** 编辑 runtime（传 undefined 表示关闭外部运行时）。 */
export function editRuntime(draft: ProfileDraft, runtime: Profile['runtime']): ProfileDraft {
  return editProfileField(draft, { runtime })
}

/** 编辑大文本字段（system）：标记为已编辑，保存时会提交全文。 */
export function editBigText(draft: ProfileDraft, field: 'system', value: string): ProfileDraft {
  const edited = new Set(draft.editedFields)
  edited.add(field)
  return { ...draft, profile: { ...draft.profile, [field]: value }, editedFields: edited }
}

export function isDraftDirty(draft: ProfileDraft): boolean {
  if (draft.editedFields.size > 0) return true
  return JSON.stringify(normalizeProfileConfig(draft.profile)) !== JSON.stringify(normalizeProfileConfig(draft.baseline))
}

/**
 * 规范化基础配置（PUT 整体替换的载荷骨架）：
 * - name / model / nodeId / cwd trim 后非空才保留——空值归一为省略，
 *   在整体替换语义下即「删除覆盖」（nodeId/cwd 回退默认 local）；
 * - tags 恒为数组：空数组原样提交（整体替换语义下可清空）；
 * - skills 全量保留并保持 undefined / [] / 白名单三态差异：undefined 表示
 *   全部可用（省略键），[] 显式禁用全部技能，非空数组为白名单——未编辑
 *   也不得丢，且绝不把三者互相归一（[] 是用户显式选择，不是空值）；
 * - runtime 规范化，undefined 保持省略（关闭外部运行时）。
 *
 * 逐字段显式构造（不 spread Profile）：system 永不混入载荷，
 * 杜绝旧大文本快照随基础字段泄漏写回。
 */
function normalizeProfileConfig(profile: Profile): Profile {
  const config: Profile = { id: profile.id, tags: [...(profile.tags ?? [])] }
  const name = profile.name?.trim()
  if (name) config.name = name
  const model = profile.model?.trim()
  if (model) config.model = model
  if (profile.thinkingLevel) config.thinkingLevel = profile.thinkingLevel
  const nodeId = profile.nodeId?.trim()
  if (nodeId) config.nodeId = nodeId
  const cwd = profile.cwd?.trim()
  if (cwd) config.cwd = cwd
  const runtime = normalizeRuntime(profile.runtime)
  if (runtime) config.runtime = runtime
  if (profile.skills !== undefined) config.skills = [...profile.skills]
  if (profile.managedByPlugin !== undefined) config.managedByPlugin = profile.managedByPlugin
  if (profile.humanSelectable !== undefined) config.humanSelectable = profile.humanSelectable
  return config
}

/**
 * 保存载荷：完整基础配置（isNew 与更新同构，均为整体替换）+ 按需大文本。
 * system 仅在新建或用户显式编辑过时提交全文；否则省略，让 HTTP 层跳过
 * 对应文件，保护弹窗打开期间 Agent 新写入的内容。
 */
export function buildProfileSavePayload(draft: ProfileDraft, opts: { isNew: boolean }): Profile {
  const payload = normalizeProfileConfig(draft.profile)
  if (opts.isNew || draft.editedFields.has('system')) payload.system = draft.profile.system ?? ''
  return payload
}
