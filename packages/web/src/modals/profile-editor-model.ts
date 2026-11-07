/**
 * Profile 编辑器纯数据模型（ProfileEditorModal 消费）。
 *
 * 保存语义与 HTTP 层约定一致：POST/PUT body 中省略 system / memory 字段
 * 表示「不动对应文件」。编辑器打开期间 Agent 可能仍在追加 MEMORY.md
 * （update_memory），因此编辑器以「加载基线 + 逐字段 dirty」方式构造
 * 载荷：未修改的大文本字段省略，绝不把弹窗打开瞬间的旧快照整篇写回。
 */

import type { Profile, ProfileRuntime } from '@helm/protocol'

export interface EnvPair {
  key: string
  value: string
}

export interface ProfileDraft {
  profile: Profile
  /** 加载时的基线快照，用于 dirty 判断。 */
  baseline: Profile
  /** 用户显式编辑过的大文本字段（system / memory）。 */
  editedFields: Set<'system' | 'memory'>
}

/** 值相等（用于基础字段 dirty 判断；undefined 与空串视为等价缺省）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined && (b === undefined || b === '')) return true
  if (b === undefined && (a === undefined || a === '')) return true
  return a === b
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
 * runtime 规范化：machine / workspace 空白归一后为空则省略；env 空省略；
 * args 仅去除每项首尾空白（保留内部空格），空数组省略。
 */
export function normalizeRuntime(runtime: ProfileRuntime | undefined): ProfileRuntime | undefined {
  if (runtime === undefined) return undefined
  const normalized: ProfileRuntime = { kind: runtime.kind, agent: runtime.agent }
  const args = (runtime.args ?? []).map((a) => a.trim()).filter((a) => a.length > 0)
  if (args.length > 0) normalized.args = args
  const machine = runtime.machine?.trim()
  if (machine) normalized.machine = machine
  const workspace = runtime.workspace?.trim()
  if (workspace) normalized.workspace = workspace
  const env = pairsToEnv(envToPairs(runtime.env))
  if (env) normalized.env = env
  return normalized
}

export function createDraft(profile: Profile): ProfileDraft {
  return { profile, baseline: profile, editedFields: new Set() }
}

/** 编辑基础字段（id / name / model / tags / runtime 整体替换）。 */
export function editProfileField(draft: ProfileDraft, patch: Partial<Profile>): ProfileDraft {
  return { ...draft, profile: { ...draft.profile, ...patch } }
}

/** 编辑 runtime（传 undefined 表示关闭外部运行时）。 */
export function editRuntime(draft: ProfileDraft, runtime: Profile['runtime']): ProfileDraft {
  return editProfileField(draft, { runtime })
}

/** 编辑大文本字段（system / memory）：标记为已编辑，保存时会提交全文。 */
export function editBigText(draft: ProfileDraft, field: 'system' | 'memory', value: string): ProfileDraft {
  const edited = new Set(draft.editedFields)
  edited.add(field)
  return { ...draft, profile: { ...draft.profile, [field]: value }, editedFields: edited }
}

export function isDraftDirty(draft: ProfileDraft): boolean {
  const { profile, baseline, editedFields } = draft
  if (editedFields.size > 0) return true
  if (!sameValue(profile.name, baseline.name)) return true
  if (!sameValue(profile.model, baseline.model)) return true
  if ((profile.tags ?? []).join('\u0000') !== (baseline.tags ?? []).join('\u0000')) return true
  return JSON.stringify(normalizeRuntime(profile.runtime)) !== JSON.stringify(normalizeRuntime(baseline.runtime))
}

/**
 * PUT 整体替换 profile.json，因此基础字段必须完整发送。
 * SYSTEM.md/MEMORY.md 则是可选文件更新，只有用户编辑过才发送，
 * 避免修改显示名时覆盖 Agent 在后台追加的新记忆。
 */
export function buildProfileSavePayload(draft: ProfileDraft, opts: { isNew: boolean }): Profile {
  const { profile, editedFields } = draft
  const payload: Profile = { id: profile.id }
  if (profile.name?.trim()) payload.name = profile.name.trim()
  if (profile.model?.trim()) payload.model = profile.model.trim()
  if (profile.tags !== undefined) payload.tags = [...profile.tags]
  const runtime = normalizeRuntime(profile.runtime)
  if (runtime) payload.runtime = runtime
  if (opts.isNew || editedFields.has('system')) payload.system = profile.system ?? ''
  if (opts.isNew || editedFields.has('memory')) payload.memory = profile.memory ?? ''
  return payload
}
