/**
 * ProfileService：管理 `profiles/<id>/`（profile.json + SYSTEM.md + MEMORY.md）。
 * Profile 形状以 @helm/protocol 为准（id 必填，name/model/runtime/tags 可选）；
 * model 为空串或缺省表示「未配置」，由 runtime 显式报错，服务层不伪造默认模型。
 */
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { HelmError, type Profile, type SkillSummary } from '@helm/protocol'
import { isValidEnvName } from './secret-stash.js'

export type { Profile, SkillSummary }
import {
  FileNotFoundError,
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'
import { withFileLock } from './file-lock.js'

export const DEFAULT_PROFILE_ID = 'assistant'
export const DEFAULT_PROFILE_NAME = '个人助理'
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 思考档位合法枚举（与 pi-ai ModelThinkingLevel 同源；schema 无运行时依赖，此处独立声明）。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * MEMORY.md 长期记忆字符上限（防线单一事实来源）：
 * 长期记忆逐回合全量注入系统提示，无上限会让每次调用成本无界增长。
 * 所有服务层写入路径（updateMemory / save(memory)）在文件锁内合并后统一
 * 强制；assistant 插件注入侧另有截断 + 显式说明兜底（存量外部手改文件）。
 */
export const MAX_MEMORY_CHARS = 64_000
/**
 * Layer 0 常驻系统提示（三层渐进式披露的最顶层）：只声明身份与受管 helm
 * CLI 环境直觉；命令表、生成式 UI 组件字典等工作细节下沉 Layer 1/2
 *（skills/helm-cli），详细手册不常驻（目录描述仍有少量成本）。
 */
export const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  '你是运行在 Helm 微内核上的个人助理。',
  '',
  '1. 受管 bash 已提供 `helm` CLI 与会话身份 `HELM_CONVERSATION_ID`，可用 `--current` 与 `--json` 调用。',
  '2. 操作 Helm 或回答宿主能力问题前，先 `load_skill({ skillId: "helm-cli" })` 并按需读取 references，通过命令帮助与实际状态核实能力。',
  '3. 普通回复用 Markdown；需要交互展示时再读取 UI 手册。生成文件供用户在 Web 查看时，用 write(..., artifact: true) 或 helm artifacts put <path> --current 登记产物，并在回复中用 [文件名](artifact:<id>) 或 ![图片](artifact:<id>) 直接渲染。',
  '4. 用 `update_memory` 保存稳定的用户偏好与约定。',
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

/** 上限拒绝统一错误（code/status 与 assistant update_memory 契约一致）。 */
function memoryLimitError(
  profileId: string,
  wouldBe: number,
  mode: 'append' | 'replace' | 'save',
  extra: { maxChars: number; inputLength?: number } = { maxChars: MAX_MEMORY_CHARS },
): HelmError {
  return new HelmError(
    'memory_limit_exceeded',
    `MEMORY.md 写入后达 ${wouldBe} 字符，超过上限 ${extra.maxChars}；请精简后再写入（长期记忆请整体 replace 整理）`,
    400,
    { profileId, wouldBe, limit: extra.maxChars, ...(mode !== 'save' ? { mode } : {}), ...(extra.inputLength !== undefined ? { inputLength: extra.inputLength } : {}) },
  )
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
  const thinkingLevel = input['thinkingLevel']
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.has(thinkingLevel)) {
      throw new Error(`profile '${id}' thinkingLevel 非法（合法值：${[...THINKING_LEVELS].join(' | ')}）`)
    }
    profile.thinkingLevel = thinkingLevel
  }
  const nodeId = input['nodeId']
  if (nodeId !== undefined) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new Error(`profile '${id}' nodeId 若存在必须是非空字符串（计算节点 ID）`)
    }
    profile.nodeId = nodeId
  }
  const cwd = input['cwd']
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`profile '${id}' cwd 若存在必须是非空字符串（目标平台绝对路径）`)
    }
    profile.cwd = cwd
  }
  const tags = input['tags']
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`profile '${id}' tags 必须是字符串数组`)
    }
    profile.tags = [...tags] as string[]
  }
  const managedByPlugin = input['managedByPlugin']
  if (managedByPlugin !== undefined) {
    if (typeof managedByPlugin !== 'string' || managedByPlugin.trim() === '') {
      throw new Error(`profile '${id}' managedByPlugin 若存在必须是非空字符串（托管插件 ID）`)
    }
    profile.managedByPlugin = managedByPlugin
  }
  const humanSelectable = input['humanSelectable']
  if (humanSelectable !== undefined) {
    if (typeof humanSelectable !== 'boolean') {
      throw new Error(`profile '${id}' humanSelectable 若存在必须是布尔值（常驻单例角色置 false，缺省 true）`)
    }
    profile.humanSelectable = humanSelectable
  }
  const runtime = input['runtime']
  if (runtime !== undefined) {
    if (!isPlainObject(runtime)) throw new Error(`profile '${id}' runtime 必须是对象`)
    const runtimeKeys = new Set(['kind', 'agent', 'args', 'nodeId', 'workspace', 'env'])
    for (const key of Object.keys(runtime)) {
      if (!runtimeKeys.has(key)) throw new Error(`profile '${id}' runtime 含未知字段 '${key}'，拒绝忽略执行靶点`)
    }
    const kind = runtime['kind']
    const agent = runtime['agent']
    // 内核零插件枚举硬编码：kind 只校验外部运行时标识格式（命名空间小写
    // 标识符，如 'herdr' / 'docker'），具体运行时是否被插件接管由
    // agent_spawn 钩子管道决定，内核不点名任何插件。
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {
      throw new Error(`profile '${id}' runtime.kind 需为外部运行时标识符（小写字母开头，可含 a-z 0-9 _ -，长度 1..32）`)
    }
    if (typeof agent !== 'string' || agent === '') {
      throw new Error(`profile '${id}' runtime.agent 不能为空`)
    }
    const args = runtime['args']
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw new Error(`profile '${id}' runtime.args 必须是字符串数组`)
    }
    const nodeId = runtime['nodeId']
    if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId === '')) {
      throw new Error(`profile '${id}' runtime.nodeId 若存在必须是非空字符串（目标计算节点标识）`)
    }
    const workspace = runtime['workspace']
    if (workspace !== undefined) {
      if (typeof workspace !== 'string' || workspace === '') {
        throw new Error(`profile '${id}' runtime.workspace 若存在必须是非空字符串（绝对路径）`)
      }
      // 跨平台绝对路径（与 runtime/tools.ts isAbsoluteTargetPath 同语义）：
      // POSIX `/`、Windows 盘符 `C:\\` / `C:/`、UNC `\\\\server\\share`。
      if (!(
        workspace.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(workspace) ||
        /^\\\\[^\\]+\\[^\\]+/.test(workspace)
      )) {
        throw new Error(`profile '${id}' runtime.workspace 必须是跨平台绝对路径（POSIX /、Windows 盘符或 UNC），当前为 '${workspace}'`)
      }
    }
    const env = runtime['env']
    if (env !== undefined) {
      if (!isPlainObject(env) || Object.keys(env).length === 0) {
        throw new Error(`profile '${id}' runtime.env 若存在必须是非空对象`)
      }
      for (const [name, value] of Object.entries(env)) {
        if (!isValidEnvName(name)) {
          throw new Error(`profile '${id}' runtime.env 的键 '${name}' 必须是合法环境变量名`)
        }
        if (typeof value !== 'string') {
          throw new Error(`profile '${id}' runtime.env['${name}'] 必须是字符串（如需机密请用 credentials/secret stash，不入 profile）`)
        }
      }
    }
    profile.runtime = {
      kind,
      agent,
      ...(args !== undefined ? { args } : {}),
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(env !== undefined ? { env: { ...(env as Record<string, string>) } } : {}),
    }
  }
  return profile
}

/** 文件资产按当前契约校验，不推测旧格式或忽略未知执行字段。 */
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

  /** 新建或整体保存 profile（若携带 system / memory 则原子同步至 SYSTEM.md / MEMORY.md，不写入 profile.json）。 */
  async save(input: unknown): Promise<Profile> {
    if (!isPlainObject(input)) throw new Error('profile 必须是对象')
    const rawSystem = input['system']
    if (rawSystem !== undefined && typeof rawSystem !== 'string') {
      throw new Error('profile system 必须是字符串')
    }
    const rawMemory = input['memory']
    if (rawMemory !== undefined && typeof rawMemory !== 'string') {
      throw new Error('profile memory 必须是字符串')
    }
    const profile = validateProfileInput(input)
    // 管理员显式导入也受同一上限约束（写入前先拒，避免 profile.json 已写而
    // MEMORY.md 被拒的半截 save）；锁内 updateMemory 仍会复核（防并发窗口）。
    if (rawMemory !== undefined && rawMemory.length > MAX_MEMORY_CHARS) {
      throw memoryLimitError(profile.id, rawMemory.length, 'save')
    }
    const dir = profileDir(this.dataDir, profile.id)
    const existing = await this.get(profile.id)
    await atomicWriteJson(join(dir, 'profile.json'), profile)
    if (rawSystem !== undefined) {
      await this.updateSystem(profile.id, rawSystem)
    } else if (existing === undefined) {
      await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
    }
    if (rawMemory !== undefined) {
      await this.updateMemory(profile.id, rawMemory, 'replace', { maxChars: MAX_MEMORY_CHARS })
    } else if (existing === undefined) {
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

  async updateSystem(id: string, text: string): Promise<string> {
    assertProfileId(id)
    if (typeof text !== 'string') throw new Error('system 文本必须是字符串')
    const path = join(profileDir(this.dataDir, id), 'SYSTEM.md')
    return withFileLock(path, async () => {
      await atomicWriteFile(path, text)
      return text
    })
  }

  async getMemory(id: string): Promise<string> {
    assertProfileId(id)
    return readTextFile(join(profileDir(this.dataDir, id), 'MEMORY.md'))
  }

  /**
   * 原子更新 MEMORY.md：replace 整体替换；append 追加（保尾部换行）。
   * append 的读改写按该文件真实路径加进程内共享锁串行化——多个
   * ProfileService 实例并发 append 也不会读到同一旧内容后互相覆盖。
   * options.maxChars 上限在锁内对**合并后**的最终内容统一强制：并发调用
   * 不可能各自「预读旧值 + 检查通过」后叠加突破上限（大小防线唯一权威点）。
   * 通过 temp+rename 落盘，AssetWatcher 可实时感知且绝不见半截内容。
   */
  async updateMemory(
    id: string,
    text: string,
    mode: 'append' | 'replace' = 'append',
    options?: { maxChars?: number },
  ): Promise<string> {
    assertProfileId(id)
    if (typeof text !== 'string') throw new Error('memory 文本必须是字符串')
    if (options?.maxChars !== undefined && (!Number.isInteger(options.maxChars) || options.maxChars <= 0)) {
      throw new Error(`maxChars 必须是正整数（收到 ${String(options.maxChars)}）`)
    }
    const path = join(profileDir(this.dataDir, id), 'MEMORY.md')
    return withFileLock(path, async () => {
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
      // 锁内合并后检查：并发 append 的最终内容在此处串行判定，突破即整体拒绝
      //（不写半截文件），绝不出现「各自预读检查通过、落盘叠加超限」的竞态。
      if (options?.maxChars !== undefined && next.length > options.maxChars) {
        throw memoryLimitError(id, next.length, mode, { maxChars: options.maxChars, inputLength: text.length })
      }
      await atomicWriteFile(path, next)
      return next
    })
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

/** 内置插件自举的技能包资产：SKILL.md + references 子文件内容。 */
export interface BuiltinSkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
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
  /** ensureSkill 自举登记的受管技能 id（进程内；常规写入口统一 403 拒绝）。 */
  private readonly managedSkillIds = new Set<string>()

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

  /** 创建/覆写技能文件（程序化写入入口，同样做安全校验）。
   * 受管技能（ensureSkill 自举登记的内置系统资产）在服务边界统一拒绝。 */
  async writeFile(skillId: string, path: string, content: string): Promise<void> {
    assertSkillId(skillId)
    this.assertSkillMutable(skillId)
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

  /**
   * 内置插件受管技能自举：skills/<id>/SKILL.md 与 references/* 是受管系统
   * 资产，每次启动以源码声明的版本为准逐文件覆盖回写（磁盘上的旧文件与
   * 手工修改一律回到源码版本），缺失文件补齐；不删除技能目录中的其他
   * 文件。内容一致的文件跳过写入（按字节内容比较、不按 mtime，避免原子
   * rename 触发 AssetWatcher 热加载抖动）。
   *
   * 安全边界不变：reference 路径先整体校验（非法资产不产生任何部分文件）；
   * 写入前逐层确认 skills/<id>、references 与嵌套 reference 目录均非符号
   * 链接，skills 根与 readFile 同经 realpath 解析（根软链可接受）；已有
   * 目标必须是常规文件（软链/目录冒充即拒绝）；ENOENT 之外的错误如实
   * 上抛。登记进 managedSkillIds 后，常规写入口统一 403 拒绝。
   */
  async ensureSkill(asset: BuiltinSkillAsset): Promise<void> {
    assertSkillId(asset.id)
    // 边界先行：任何非法 reference 都在任何目录创建/文件写入之前整体拒绝。
    const references = Object.entries(asset.references).map(([name, content]) => ({
      rel: assertSafeRelativePath(`references/${name}`),
      content,
    }))
    const skillsRoot = join(this.dataDir, 'skills')
    // skills 根不存在时补建（首次自举）；悬空软链 realpath 得 ENOENT 而
    // mkdir 撞 EEXIST，如实上抛，不静默绕过。
    let rootReal: string
    try {
      rootReal = await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      await mkdir(skillsRoot, { recursive: true })
      rootReal = await realpath(skillsRoot)
    }
    const dir = join(rootReal, asset.id)
    // 建目录前逐层确认 skills/<id>、references 与嵌套目录不含软链（防向
    // skills 根之外写入）；段缺失即待创建，其下不可能再有内容。
    await assertRealDirs(rootReal, join(dir, 'references'))
    for (const { rel } of references) {
      await assertRealDirs(rootReal, dirname(join(dir, rel)))
    }
    await mkdir(join(dir, 'references'), { recursive: true })
    for (const { rel } of references) {
      await mkdir(dirname(join(dir, rel)), { recursive: true })
    }
    await writeManagedFile(join(dir, 'SKILL.md'), asset.skillMd)
    for (const { rel, content } of references) {
      await writeManagedFile(join(dir, rel), content)
    }
    this.managedSkillIds.add(asset.id)
  }

  /** 受管技能统一只读防护（403 managed_skill_readonly）：内容唯一权威是
   * 插件启动时的源码版本。进程内登记——每次启动 ensureSkill 重建，不落
   * 库（用户自建技能不经 ensureSkill，不受影响）。 */
  private assertSkillMutable(skillId: string): void {
    if (this.managedSkillIds.has(skillId)) {
      throw new HelmError(
        'managed_skill_readonly',
        `技能 '${skillId}' 是内置插件受管系统资产，禁止经常规接口写入或删除（插件启动时自动以源码版本覆盖同步）`,
        403,
        { skillId },
      )
    }
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
    const { name, description, managedByPlugin } = parseSkillFrontmatter(skillMd)
    const references = await collectFiles(root)
    return {
      id,
      name: name || id,
      ...(description !== '' ? { description } : {}),
      ...(managedByPlugin !== undefined ? { managedByPlugin } : {}),
      references,
    }
  }
}

/**
 * 逐层确认 ancestor 之下至 dir 的每个已存在段均为真实目录（非符号链接）；
 * 段缺失即其后不可能存在，视为待创建并停止。防止 skills/<id> 或
 * references（含嵌套子目录）为软链时把自举资产写到 skills 根之外。
 */
async function assertRealDirs(ancestor: string, dir: string): Promise<void> {
  let current = ancestor
  for (const seg of relative(ancestor, dir).split(sep)) {
    if (seg === '') continue
    current = join(current, seg)
    const st = await lstat(current).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (st === undefined) return
    if (st.isSymbolicLink()) {
      throw new Error(`拒绝经符号链接目录写入: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`路径段不是目录，拒绝自举: ${current}`)
    }
  }
}

/** 受管覆盖写：目标缺失即原子写入；已存在必须是常规文件（软链/目录均
 * 拒绝），内容与声明一致时跳过写入（避免原子 rename 抖动 watcher），
 * 不一致则原子覆盖为源码版本；其他 IO 错误如实上抛。 */
async function writeManagedFile(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (existing === undefined) {
    await atomicWriteFile(path, content)
    return
  }
  if (!existing.isFile()) {
    throw new Error(`目标已存在且不是常规文件，拒绝写入: ${path}`)
  }
  const current = await readFile(path, 'utf8').catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (current === content) return
  await atomicWriteFile(path, content)
}

/** 解析 SKILL.md 顶部 YAML frontmatter 的 name/description/managedByPlugin（缺失时回退 id/空）。
 * 仅接受当前字段名 managedByPlugin（无历史别名兼容）；键存在但值为空属非法形状，
 * 显式报错而非伪造无主数据（诚实失败，不静默降级）。 */
export function parseSkillFrontmatter(text: string): {
  name: string
  description: string
  managedByPlugin?: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: '', description: '' }
  const body = match[1] ?? ''
  const fields = new Map<string, string>()
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m !== null && m[1] !== undefined) fields.set(m[1], (m[2] ?? '').trim())
  }
  const managedRaw = fields.get('managedByPlugin')
  if (managedRaw !== undefined && managedRaw === '') {
    throw new Error(`SKILL.md frontmatter managedByPlugin 值为空（键存在则必须是非空插件 ID）`)
  }
  return {
    name: fields.get('name') ?? '',
    description: fields.get('description') ?? '',
    ...(managedRaw !== undefined ? { managedByPlugin: managedRaw } : {}),
  }
}
