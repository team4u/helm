/**
 * ProfileService：管理 `profiles/<id>/`（profile.json + SYSTEM.md + MEMORY.md）。
 * Profile 形状以 @helm/protocol 为准（id 必填，name/model/runtime/tags 可选）；
 * model 为空串或缺省表示「未配置」，由 runtime 显式报错，服务层不伪造默认模型。
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Profile, SkillSummary } from '@helm/protocol'

export type { Profile, SkillSummary }
import {
  FileNotFoundError,
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'

export const DEFAULT_PROFILE_ID = 'assistant'
export const DEFAULT_PROFILE_NAME = '个人助理'
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  '在此编写该 Profile 的系统提示词（SYSTEM.md）。',
  '',
].join('\n')
const MEMORY_DEFAULT = ['# Memory', '', ''].join('\n')

/** 校验 profile id：小写字母数字与连字符，防目录注入与路径穿越。 */
export function assertProfileId(id: string): void {
  if (!NAME_PATTERN.test(id)) {
    throw new Error(`非法 profile id: ${id}（仅允许 a-z 0-9 与连字符）`)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function profileDir(dataDir: string, id: string): string {
  return join(dataDir, 'profiles', id)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Profile 输入边界校验（新增/更新共用）；返回规范化后的可持久化形态。 */
export function validateProfileInput(input: unknown): Profile {
  if (!isPlainObject(input)) throw new Error('profile 必须是对象')
  const id = input['id']
  if (typeof id !== 'string' || !NAME_PATTERN.test(id)) {
    throw new Error(`非法 profile id: ${String(id)}（仅允许 a-z 0-9 与连字符）`)
  }
  const profile: Profile = { id }
  const name = input['name']
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`profile '${id}' name 不能为空`)
    }
    profile.name = name
  }
  const model = input['model']
  if (model !== undefined) {
    if (typeof model !== 'string') throw new Error(`profile '${id}' model 必须是字符串`)
    profile.model = model
  }
  const tags = input['tags']
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`profile '${id}' tags 必须是字符串数组`)
    }
    profile.tags = [...tags] as string[]
  }
  const runtime = input['runtime']
  if (runtime !== undefined) {
    if (!isPlainObject(runtime)) throw new Error(`profile '${id}' runtime 必须是对象`)
    const kind = runtime['kind']
    const agent = runtime['agent']
    if (kind !== 'herdr') throw new Error(`profile '${id}' runtime.kind 仅支持 'herdr'`)
    if (typeof agent !== 'string' || agent === '') {
      throw new Error(`profile '${id}' runtime.agent 不能为空`)
    }
    const args = runtime['args']
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw new Error(`profile '${id}' runtime.args 必须是字符串数组`)
    }
    profile.runtime = { kind, agent, ...(args !== undefined ? { args } : {}) }
  }
  return profile
}

/** 读取时容错规范化（旧/手工文件缺字段时补默认，不伪造 model）。 */
function normalizeProfile(value: unknown, id: string): Profile {
  if (!isPlainObject(value)) throw new Error(`profile.json 结构非法: ${id}`)
  return validateProfileInput({ ...value, id })
}

export class ProfileService {
  constructor(private readonly dataDir: string) {}

  /** 首次启动自举默认 assistant profile（已存在则原样返回，不覆盖用户改动）。 */
  async ensureDefault(): Promise<Profile> {
    const existing = await this.get(DEFAULT_PROFILE_ID)
    if (existing !== undefined) return existing
    const profile: Profile = {
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      tags: [DEFAULT_PROFILE_ID],
    }
    const dir = profileDir(this.dataDir, profile.id)
    await atomicWriteJson(join(dir, 'profile.json'), profile)
    await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
    await atomicWriteFile(join(dir, 'MEMORY.md'), MEMORY_DEFAULT)
    return profile
  }

  async list(): Promise<Profile[]> {
    const root = join(this.dataDir, 'profiles')
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
    const profiles: Profile[] = []
    for (const entry of entries) {
      const profile = await this.get(entry)
      if (profile !== undefined) profiles.push(profile)
    }
    profiles.sort((a, b) => a.id.localeCompare(b.id))
    return profiles
  }

  async get(id: string): Promise<Profile | undefined> {
    assertProfileId(id)
    const value = await readJsonFileOptional(join(profileDir(this.dataDir, id), 'profile.json'))
    if (value === undefined) return undefined
    return normalizeProfile(value, id)
  }

  /** 新建或整体保存 profile。输入先经边界校验。 */
  async save(input: unknown): Promise<Profile> {
    const profile = validateProfileInput(input)
    const dir = profileDir(this.dataDir, profile.id)
    const existing = await this.get(profile.id)
    await atomicWriteJson(join(dir, 'profile.json'), profile)
    if (existing === undefined) {
      await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
      await atomicWriteFile(join(dir, 'MEMORY.md'), MEMORY_DEFAULT)
    }
    return profile
  }

  /** 删除 profile；默认 assistant 受保护不可删除。 */
  async delete(id: string): Promise<void> {
    assertProfileId(id)
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error(`默认 profile '${DEFAULT_PROFILE_ID}' 不可删除`)
    }
    await rm(profileDir(this.dataDir, id), { recursive: true, force: true })
  }

  async getSystem(id: string): Promise<string> {
    assertProfileId(id)
    return readTextFile(join(profileDir(this.dataDir, id), 'SYSTEM.md'))
  }

  async getMemory(id: string): Promise<string> {
    assertProfileId(id)
    return readTextFile(join(profileDir(this.dataDir, id), 'MEMORY.md'))
  }

  /**
   * 原子更新 MEMORY.md：replace 整体替换；append 追加（保尾部换行）。
   * 通过 temp+rename 落盘，AssetWatcher 可实时感知且绝不见半截内容。
   */
  async updateMemory(
    id: string,
    text: string,
    mode: 'append' | 'replace' = 'append',
  ): Promise<string> {
    assertProfileId(id)
    if (typeof text !== 'string') throw new Error('memory 文本必须是字符串')
    const path = join(profileDir(this.dataDir, id), 'MEMORY.md')
    let next: string
    if (mode === 'replace') {
      next = text
    } else {
      let current = ''
      try {
        current = await readTextFile(path)
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) throw err
        // MEMORY.md 缺失时 append 视为从空开始（ensureDefault 已保证存在，兜底诚实创建）。
      }
      next = current.endsWith('\n') || current === '' ? current + text : current + '\n' + text
    }
    await atomicWriteFile(path, next)
    return next
  }
}

// ---------------------------------------------------------------------------
// SkillService
// ---------------------------------------------------------------------------

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** 真实路径包含判定：child === parent 或位于 parent 之下（均需已 realpath）。 */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent + sep)
}

export function assertSkillId(id: string): void {
  if (!SKILL_NAME_PATTERN.test(id)) {
    throw new Error(`非法 skill id: ${id}`)
  }
}

/**
 * 校验技能包内相对路径：禁止绝对路径、`..` 段、反斜杠、控制字符与空段。
 * 允许 `SKILL.md` 与 `references/...` 形式的嵌套相对路径。
 */
export function assertSafeRelativePath(input: string): string {
  if (input.includes('\\')) throw new Error(`非法路径（反斜杠）: ${input}`)
  if (input.includes('\0')) throw new Error('非法路径（含 NUL）')
  if (input === '' || input === '.') throw new Error('路径不能为空')
  if (input.startsWith('/')) throw new Error(`禁止绝对路径: ${input}`)
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') throw new Error(`非法路径段: ${input}`)
    if (seg === '..') throw new Error(`禁止路径穿越: ${input}`)
    if (/[\s\/?#]/.test(seg)) throw new Error(`非法路径段: ${input}`)
  }
  return input
}

/** 递归收集技能包内常规文件相对路径（符号链接与目录跳过，杜绝越界入口）。 */
async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const dir = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const entry of entries) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, relPath)))
    } else if (entry.isFile() && entry.name !== 'SKILL.md') {
      out.push(relPath)
    }
  }
  return out.sort()
}

export class SkillService {
  constructor(private readonly dataDir: string) {}

  /** 全部技能摘要（含参考子文件路径，供 load_skill 目录注入）。 */
  async list(): Promise<SkillSummary[]> {
    const skillsRoot = join(this.dataDir, 'skills')
    let entries: string[]
    try {
      entries = await readdir(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
    const skills: SkillSummary[] = []
    for (const entry of entries) {
      try {
        assertSkillId(entry)
      } catch {
        continue
      }
      const summary = await this.summarize(entry)
      if (summary !== undefined) skills.push(summary)
    }
    return skills
  }

  /** 安全读取技能包文件：缺省 SKILL.md；严格拦截绝对路径/`..`/软链越界。
   * 三层防御：① 技能目录自身软链直接拒绝；② realpath 双层包含校验
   * （skillDir 真实路径必须在 skills 根内）；③ 逐段拒绝符号链接并
   * 确认目标真实路径仍在 skillDir 内。
   */
  async readFile(skillId: string, path = 'SKILL.md'): Promise<string> {
    assertSkillId(skillId)
    const rel = assertSafeRelativePath(path)
    const skillsRoot = await this.requireSkillsRoot()
    const root = join(skillsRoot, skillId)
    // 技能目录本身是软链即拒绝（即使解析后仍在 skills 根内，也不放宽）。
    const rootStat = await lstat(root).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new FileNotFoundError(root)
      }
      throw err
    })
    if (rootStat.isSymbolicLink()) {
      throw new Error(`技能目录是符号链接，拒绝读取: ${skillId}`)
    }
    // 双层 realpath 包含校验：skillDir 真实路径必须在 skills 根内（防根内中转越界）。
    const rootReal = await realpath(root)
    if (!isWithin(rootReal, skillsRoot)) {
      throw new Error(`技能目录越界（软链指向 skills 根之外）: ${skillId}`)
    }
    const target = join(root, rel)
    // 逐段 lstat：路径上任何符号链接都拒绝（软链可能指向技能目录之外）。
    let current = root
    for (const seg of rel.split('/')) {
      current = join(current, seg)
      const s = await lstat(current).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new FileNotFoundError(target)
        }
        throw err
      })
      if (s.isSymbolicLink()) {
        throw new Error(`拒绝读取符号链接（防越界）: ${rel}`)
      }
    }
    const finalStat = await lstat(target)
    if (!finalStat.isFile()) throw new Error(`不是常规文件: ${rel}`)
    // 目标真实路径必须仍在 skillDir 内（对抗读取中途目录被替换为软链）。
    const targetReal = await realpath(target)
    if (!isWithin(targetReal, rootReal)) {
      throw new Error(`目标越出技能目录（realpath 不在 skillDir 内）: ${rel}`)
    }
    return readTextFile(target)
  }

  /** 创建/覆写技能文件（程序化写入入口，同样做安全校验）。 */
  async writeFile(skillId: string, path: string, content: string): Promise<void> {
    assertSkillId(skillId)
    const rel = assertSafeRelativePath(path)
    const skillsRoot = await this.requireSkillsRoot()
    const root = join(skillsRoot, skillId)
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal !== undefined && !isWithin(rootReal, skillsRoot)) {
      throw new Error(`技能目录越界（软链指向 skills 根之外）: ${skillId}`)
    }
    const target = join(root, rel)
    const existing = await lstat(target).catch(() => undefined)
    if (existing !== undefined && existing.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接: ${rel}`)
    }
    await atomicWriteFile(target, content)
  }

  /** 解析 skills 根的真实路径（不存在时抛错，绝不宽放）。 */
  private async requireSkillsRoot(): Promise<string> {
    const skillsRoot = join(this.dataDir, 'skills')
    try {
      return await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new FileNotFoundError(skillsRoot)
      }
      throw err
    }
  }

  private async summarize(id: string): Promise<SkillSummary | undefined> {
    const root = join(this.dataDir, 'skills', id)
    const skillMd = await this.readFile(id, 'SKILL.md').catch((err: unknown) => {
      if (err instanceof FileNotFoundError) return undefined
      throw err
    })
    if (skillMd === undefined) return undefined
    const { name, description } = parseSkillFrontmatter(skillMd)
    const references = await collectFiles(root)
    return {
      id,
      name: name || id,
      ...(description !== '' ? { description } : {}),
      references,
    }
  }
}

/** 解析 SKILL.md 顶部 YAML frontmatter 的 name/description（缺失时回退 id/空）。 */
export function parseSkillFrontmatter(text: string): {
  name: string
  description: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: '', description: '' }
  const body = match[1] ?? ''
  const fields = new Map<string, string>()
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m !== null && m[1] !== undefined) fields.set(m[1], (m[2] ?? '').trim())
  }
  return {
    name: fields.get('name') ?? '',
    description: fields.get('description') ?? '',
  }
}
