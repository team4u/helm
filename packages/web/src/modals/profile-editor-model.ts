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
  /** 加载时的基线快照；save 仅提交相对基线变过的字段。 */
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
  return /^[a-z0-9-]+$/.test(id)
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

/** 基础字段（不含 system / memory）：仅当与基线不同才写入载荷。 */
function putBaseField(payload: Profile, baseline: Profile, profile: Profile, key: 'name' | 'model' | 'tags'): void {
  if (key === 'model') {
    const value = typeof profile.model === 'string' ? profile.model.trim() : profile.model
    if (!sameValue(value, baseline.model) && value !== '') {
      payload.model = value
    }
    return
  }
  if (key === 'name') {
    const value = typeof profile.name === 'string' ? profile.name.trim() : profile.name
    if (!sameValue(value === '' ? undefined : value, baseline.name) && value !== '') {
      payload.name = value
    }
    return
  }
  const nextTags = profile.tags ?? []
  if (nextTags.length > 0 && nextTags.join('\u0000') !== (baseline.tags ?? []).join('\u0000')) {
    payload.tags = nextTags
  }
}

/**
 * 保存载荷：
 * - 新建：全量提交（含当前 system / memory 文本）；
 * - 更新：基础字段按基线 diff 提交；system / memory 仅在用户显式编辑过
 *   时提交——否则省略，让 HTTP 层跳过对应文件，保护弹窗打开期间
 *   Agent 新写入的记忆不被旧快照覆盖。
 */
export function buildProfileSavePayload(draft: ProfileDraft, opts: { isNew: boolean }): Profile {
  const { profile, baseline, editedFields } = draft
  const payload: Profile = { id: profile.id }
  putBaseField(payload, baseline, profile, 'name')
  putBaseField(payload, baseline, profile, 'model')
  putBaseField(payload, baseline, profile, 'tags')
  if (JSON.stringify(normalizeRuntime(profile.runtime)) !== JSON.stringify(normalizeRuntime(baseline.runtime))) {
    payload.runtime = normalizeRuntime(profile.runtime)
  }
  if (opts.isNew) {
    payload.system = profile.system ?? ''
    payload.memory = profile.memory ?? ''
    return payload
  }
  if (editedFields.has('system')) payload.system = profile.system ?? ''
  if (editedFields.has('memory')) payload.memory = profile.memory ?? ''
  return payload
}
