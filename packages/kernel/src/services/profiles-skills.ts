/**
 * ProfileService：管理 `profiles/<id>/`（profile.json + SYSTEM.md）。
 * Profile 形状以 @helm/protocol 为准（id 必填，name/model/runtime/tags 可选）；
 * model 为空串或缺省表示「未配置」，由 runtime 显式报错，服务层不伪造默认模型。
 * MEMORY.md 长期记忆由 builtin:memory 插件自治管理，不进本服务。
 */
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { HelmError, type Profile, type ProfileStarterPrompt, type SkillSummary } from '@helm/protocol'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
} from '@helm/protocol'
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
 * Layer 0 常驻系统提示（三层渐进式披露的最顶层）：只声明身份与受管 helm
 * CLI 环境直觉；命令表、生成式 UI 组件字典等工作细节下沉 Layer 1/2
 *（skills/helm-cli），详细手册不常驻（目录描述仍有少量成本）。
 * update_memory 使用指引由 builtin:memory 插件按 Profile 开关动态注入。
 */
export const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  '你是运行在 Helm 微内核上的个人助理。',
  '',
  '1. 受管 bash 已提供 `helm` CLI 与会话身份 `HELM_CONVERSATION_ID`，可用 `--current` 与 `--json` 调用。',
  '2. 当前可用技能含 helm-cli 时，操作 Helm 或回答宿主能力问题前，先 `load_skill({ skillId: "helm-cli" })` 并按需读取 references，通过命令帮助与实际状态核实能力；该技能不在当前可用目录中时跳过此步。',
  '3. 普通回复用 Markdown；交互式卡片/表单等富展示能力由可用技能目录中的 generative-ui 技能提供，可反复使用的全栈微应用构建与发布由 app-builder 技能提供：目录中存在时按其指引输出，不在时用普通 Markdown，不引用不存在的手册。生成文件供用户在 Web 查看时，用 write(..., artifact: true) 或 helm artifacts put <path> --current 登记产物，并在回复中用 [文件名](artifact:<id>) 或 ![图片](artifact:<id>) 直接渲染。',
  '',
].join('\n')

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

/** Unicode 码点长度（代理对计 1，与展示宽度直觉一致；契约统一口径）。 */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 单条引导词边界校验：label 规范化为 trim 形态，prompt 保留原文；
 * 未知字段拒绝（引导词是用户可编辑数据，静默丢字段会造成 UI 保存后丢内容）。 */
export function validateProfileStarter(item: unknown, at: string): ProfileStarterPrompt {
  if (!isPlainObject(item)) throw new Error(`${at} 必须是 { label, prompt } 对象`)
  const label = item['label']
  const prompt = item['prompt']
  if (Object.keys(item).some((key) => key !== 'label' && key !== 'prompt')) {
    throw new Error(`${at} 仅接受 label 与 prompt 字段`)
  }
  if (typeof label !== 'string') throw new Error(`${at}.label 必须是字符串`)
  const normalizedLabel = label.trim()
  if (codePointLength(normalizedLabel) === 0) throw new Error(`${at}.label 去除首尾空白后不能为空`)
  if (codePointLength(normalizedLabel) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    throw new Error(`${at}.label 最多 ${PROFILE_STARTER_LABEL_MAX_LENGTH} 个 Unicode 码点`)
  }
  if (typeof prompt !== 'string') throw new Error(`${at}.prompt 必须是字符串`)
  if (prompt.trim() === '') throw new Error(`${at}.prompt 不能是纯空白`)
  if (codePointLength(prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    throw new Error(`${at}.prompt 最多 ${PROFILE_STARTER_PROMPT_MAX_LENGTH} 个 Unicode 码点（保留原文，不截断）`)
  }
  return { label: normalizedLabel, prompt }
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
  // 技能白名单：元素必须是合法 skill id；重复项规范化去重后持久化（保留 []，
  // 空数组表示禁用全部技能）。允许保存尚未安装的 id——技能目录是运行时
  // 状态（可后装），配置阶段不强求存在；运行时按 isSkillAvailable 统一判定。
  const skills = input['skills']
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
      throw new Error(`profile '${id}' skills 必须是字符串数组（skill id 白名单；缺省全部可用，空数组禁用全部）`)
    }
    const deduped: string[] = []
    for (const skillId of skills) {
      assertSkillId(skillId)
      if (!deduped.includes(skillId)) deduped.push(skillId)
    }
    profile.skills = deduped
  }
  // 空白会话引导词：最多六项；label trim 后非空且 ≤24 码点（规范化为 trim
  // 形态持久化），prompt 非纯空白且保留原文（≤4000 码点，不截断）。
  // 空数组 [] 显式保留（表示「清空自定义，回宿主默认提示」），缺省不写字段。
  const starters = input['starters']
  if (starters !== undefined) {
    if (!Array.isArray(starters)) {
      throw new Error(`profile '${id}' starters 必须是 { label, prompt } 对象数组`)
    }
    if (starters.length > PROFILE_STARTERS_MAX_ITEMS) {
      throw new Error(`profile '${id}' starters 最多 ${PROFILE_STARTERS_MAX_ITEMS} 项`)
    }
    profile.starters = starters.map((item, index) => validateProfileStarter(item, `profile '${id}' starters[${index}]`))
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

/** 删除前绑定复核依赖：HTTP 层注入会话面查询，服务层兑底关闭
 * 「路由快速路径检查 → 并发创建/PATCH 绑定 → 删除落盘」交错窗口。 */
export interface ProfileDeleteDeps {
  isProfileInUse(profileId: string): boolean | Promise<boolean>
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

  /** 新建或整体保存 profile（若携带 system 则原子同步至 SYSTEM.md，不写入 profile.json）。 */
  async save(input: unknown): Promise<Profile> {
    if (!isPlainObject(input)) throw new Error('profile 必须是对象')
    const rawSystem = input['system']
    if (rawSystem !== undefined && typeof rawSystem !== 'string') {
      throw new Error('profile system 必须是字符串')
    }
    const profile = validateProfileInput(input)
    const dir = profileDir(this.dataDir, profile.id)
    const existing = await this.get(profile.id)
    await atomicWriteJson(join(dir, 'profile.json'), profile)
    if (rawSystem !== undefined) {
      await this.updateSystem(profile.id, rawSystem)
    } else if (existing === undefined) {
      await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
    }
    return profile
  }

  /**
   * 删除 profile；默认 assistant 受保护不可删除。
   * deps.isProfileInUse（可选）：删除落盘前最后一刻复核无会话绑定，有则
   * 409 profile_in_use——路由层快速路径检查与删除之间隔多个 await，并发
   * 创建/PATCH 绑定可在窗口内穿过；不注入时仅保留默认 profile 保护
   * （调用方自行保证无绑定）。
   */
  async delete(id: string, deps?: ProfileDeleteDeps): Promise<void> {
    assertProfileId(id)
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error(`默认 profile '${DEFAULT_PROFILE_ID}' 不可删除`)
    }
    if (deps !== undefined && (await deps.isProfileInUse(id))) {
      throw new HelmError('profile_in_use', `profile ${id} 仍被会话绑定，先解绑再删除`, 409, {
        profileId: id,
      })
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

/** 递归收集技能包内常规文件相对路径。跳过：以 `.` 开头的隐藏文件/目录
 * （.git/.gitignore 等）、依赖与构建产物目录（node_modules/__pycache__/dist，
 * 工程型技能包直接扫会把整个依赖树塞爆目录）与符号链接（杜绝越界入口）；
 * 仅收集能通过 assertSafeRelativePath 校验的路径——目录与 load_skill 共用
 * 同一合法口径，保证列出的每个 reference 都真实可读（含空格/?/# 等字符
 * 的路径直接不列，防言行不一）。 */
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
    if (entry.name.startsWith('.')) continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'dist') continue
      out.push(...(await collectFiles(root, relPath)))
    } else if (entry.isFile() && entry.name !== 'SKILL.md') {
      try {
        out.push(assertSafeRelativePath(relPath))
      } catch {
        // 非法相对路径（空格/特殊字符）无法经 load_skill 读取，不进目录。
      }
    }
  }
  return out.sort()
}

/**
 * 机器级共享只读技能根（pi 生态技能库，`~/.agents/skills`）：helm 只读
 * 合入，不写不删。与 HELM_DATA_DIR 互相独立（各表一个来源根）；由生产
 * 内核组装时注入，SkillService 自身缺省不含（保持给定目录的确定性）。
 */
export function defaultExternalSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills')]
}

/** external 根单条目错误的跳过判定：形状/校验类错误（普通 Error，无 Node
 * 错误码）与 ENOENT（SKILL.md/目录缺失）跳过该条目；真实 IO 错误
 * （EACCES/EIO 等 code 非 ENOENT）如实上抛，不静默降级。 */
function isSkippableExternalEntryError(err: unknown): boolean {
  if (err instanceof FileNotFoundError) return true
  const code = (err as { code?: unknown }).code
  if (code === undefined) return true
  return code === 'ENOENT'
}

export class SkillService {
  /** ensureSkill 自举登记的受管技能 id（进程内；常规写入口统一 403 拒绝）。 */
  private readonly managedSkillIds = new Set<string>()

  private readonly dataDir: string

  /** 只读合入的外部共享根（排在 dataDir 之后的解析顺序）。 */
  private readonly externalRoots: readonly string[]

  /** 缺省不含外部根：本服务是「给定目录的纯确定性扫描」，机器级共享根由
   * 生产内核组装时经 defaultExternalSkillRoots() 注入（测试天然隔离）。 */
  constructor(dataDir: string, options?: { externalRoots?: readonly string[] }) {
    this.dataDir = dataDir
    this.externalRoots = options?.externalRoots ?? []
  }

  /** 全部技能摘要（dataDir 根 + 外部共享根合并，供 load_skill 目录注入）。
   * dataDir 根语义不变：非法 id 跳过、坏 frontmatter 如实抛错。外部根整体
   * ENOENT 视为空；单条目坏数据（第三方内容，helm 不拥有其质量）跳过不
   * 拖垮整个目录——与 dataDir 的严格抛错语义刻意不同。按 id 去重：
   * dataDir 条目绝对优先（受管技能永不被外部同名遮蔽；用户往 dataDir 放
   * 同名技能即形成「本地覆盖」），其后按根声明顺序取首个。按 id 稳定排序。 */
  async list(): Promise<SkillSummary[]> {
    const byId = new Map<string, SkillSummary>()
    const dataRoot = join(this.dataDir, 'skills')
    let dataEntries: string[]
    try {
      dataEntries = await readdir(dataRoot)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') dataEntries = []
      else throw err
    }
    if (dataEntries.length > 0) {
      // readdir 成功即根存在；realpath 归一（macOS /var 等软链前缀）供包含校验。
      const dataRootReal = await realpath(dataRoot)
      for (const entry of dataEntries) {
        try {
          assertSkillId(entry)
        } catch {
          continue
        }
        const summary = await this.summarizeInRoot(dataRootReal, entry)
        if (summary !== undefined) byId.set(entry, summary)
      }
    }
    for (const extRoot of this.externalRoots) {
      let extEntries: string[]
      try {
        extEntries = await readdir(extRoot)
      } catch (err) {
        // 共享根不存在视为空（未安装 pi 技能库），不报错。
        if ((err as { code?: string }).code === 'ENOENT') continue
        throw err
      }
      if (extEntries.length === 0) continue
      const extRootReal = await realpath(extRoot)
      for (const entry of extEntries) {
        if (byId.has(entry)) continue // dataDir（或先序外部根）条目优先
        try {
          assertSkillId(entry)
          const summary = await this.summarizeInRoot(extRootReal, entry, 'agents')
          if (summary !== undefined) byId.set(entry, summary)
        } catch (err) {
          if (isSkippableExternalEntryError(err)) continue
          throw err
        }
      }
    }
    const skills = [...byId.values()]
    skills.sort((a, b) => a.id.localeCompare(b.id))
    return skills
  }

  /** 安全读取技能包文件：缺省 SKILL.md；严格拦截绝对路径/`..`/软链越界。
   * 解析顺序 dataDir → 各外部共享根：技能目录在某根不存在则试下一根，
   * 全部根都无此技能维持 FileNotFoundError（HTTP 404 口径不变）；安全校验
   * 拒绝（软链/越界/非常规文件）在命中根立即上抛，绝不跨根回退。每根的
   * 校验强度与 dataDir 策略完全一致——三层防御：① 技能目录自身软链直接
   * 拒绝；② realpath 双层包含校验（skillDir 真实路径必须在所属 skills 根
   * 内）；③ 逐段拒绝符号链接并确认目标真实路径仍在 skillDir 内。
   */
  async readFile(skillId: string, path = 'SKILL.md'): Promise<string> {
    assertSkillId(skillId)
    const rel = assertSafeRelativePath(path)
    for (const skillsRoot of await this.resolveReadableRoots()) {
      const content = await this.readFileInRoot(skillsRoot, skillId, rel)
      if (content !== undefined) return content
    }
    throw new FileNotFoundError(join(this.dataDir, 'skills', skillId))
  }

  /** 单根内解析读取：返回文件内容；技能目录在该根不存在时返回 undefined
   * （继续下一根）；技能存在但目标文件缺失抛 FileNotFoundError（该根条目
   * 已生效，不跨根回退）。 */
  private async readFileInRoot(skillsRoot: string, skillId: string, rel: string): Promise<string | undefined> {
    const root = join(skillsRoot, skillId)
    // 技能目录本身是软链即拒绝（即使解析后仍在 skills 根内，也不放宽）。
    const rootStat = await lstat(root).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (rootStat === undefined) return undefined
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

  /** 可读根解析（realpath 归一）：dataDir skills 根在前，其后依次外部共享
   * 根；根 ENOENT 跳过（dataDir 根缺失不再全局抛错，最终由 readFile 统一
   * FileNotFoundError）；悬空软链等其他 realpath 错误如实上抛。 */
  private async resolveReadableRoots(): Promise<string[]> {
    const roots: string[] = []
    for (const raw of [join(this.dataDir, 'skills'), ...this.externalRoots]) {
      const real = await realpath(raw).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'ENOENT') return undefined
        throw err
      })
      if (real !== undefined) roots.push(real)
    }
    return roots
  }

  /** 创建/覆写技能文件（程序化写入入口，同样做安全校验）。
   * 受管技能（ensureSkill 自举登记的内置系统资产）在服务边界统一拒绝。
   * 只写 dataDir 根：对外部共享根同名技能调 writeFile 会写入 dataDir 副本
   * 从而遮蔽外部条目——这是有意的「本地覆盖」机制，外部根自身永不落写。 */
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

  /** 技能资产目录坐标（宿主端口用，如插件自举补齐文件）：始终指向
   * dataDir/skills/<id>，不解析到外部共享只读根。调用方可能通过
   * atomicWriteFile 补齐资产；将共享根路径返回给它会绕过 writeFile 的
   * 只写 dataDir 约束。宿主不 mkdir，缺省路径由调用方按需创建。 */
  async directory(id: string): Promise<string> {
    try {
      assertSkillId(id)
    } catch (err) {
      throw new HelmError(
        'validation_error',
        `Skill id 非法：${err instanceof Error ? err.message : String(err)}`,
        400,
        { skillId: id },
      )
    }
    return join(this.dataDir, 'skills', id)
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

  /** 单根摘要：技能目录缺失返回 undefined（目录跳过该条目）；SKILL.md 缺失
   * （FileNotFoundError）同样返回 undefined；frontmatter 坏数据如实上抛
   * （由调用方决定 dataDir 严格抛错或外部根跳过策略）。外部根强制剥离
   * managedByPlugin——共享根只可能是普通共享技能，绝不允许第三方文件
   * 伪装成宿主受管插件技能。 */
  private async summarizeInRoot(skillsRoot: string, id: string, source?: 'agents'): Promise<SkillSummary | undefined> {
    const skillMd = await this.readFileInRoot(skillsRoot, id, 'SKILL.md').catch((err: unknown) => {
      if (err instanceof FileNotFoundError) return undefined
      throw err
    })
    if (skillMd === undefined) return undefined
    const { name, description, managedByPlugin } = parseSkillFrontmatter(skillMd)
    const references = await collectFiles(join(skillsRoot, id))
    return {
      id,
      name: name || id,
      ...(description !== '' ? { description } : {}),
      ...(source === undefined && managedByPlugin !== undefined ? { managedByPlugin } : {}),
      references,
      ...(source !== undefined ? { source } : {}),
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

/** 剥离 YAML 单行标量首尾对称的单/双引号（双引号还原 \" 与 \\ 转义，
 * 单引号还原 '' 转义；不对称引号原样保留，不伪造解析）。 */
function stripQuotedScalar(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first !== '"' || last !== '"') && (first !== "'" || last !== "'")) return value
  const inner = value.slice(1, -1)
  if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return inner.replace(/''/g, "'")
}

/** 解析 SKILL.md 顶部 YAML frontmatter 的 name/description/managedByPlugin（缺失时回退 id/空）。
 * 仅接受当前字段名 managedByPlugin（无历史别名兼容）；键存在但值为空属非法形状，
 * 显式报错而非伪造无主数据（诚实失败，不静默降级）。
 * 值语法覆盖 pi 生态共享技能库（~/.agents/skills）真实数据的最小集：单行
 * 标量（剥首尾对称引号）与块标量——折叠型 > / >-（连续缩进行 trim 后以
 * 空格拼接，适合长描述单行化）与保留型 | / |-（去公共缩进后以换行拼接）；
 * 其余高级 YAML 语法（锚点/列表/嵌套等）不支持。 */
export function parseSkillFrontmatter(text: string): {
  name: string
  description: string
  managedByPlugin?: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: '', description: '' }
  const body = match[1] ?? ''
  const fields = new Map<string, string>()
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m === null || m[1] === undefined) continue
    const key = m[1]
    const inline = (m[2] ?? '').trim()
    // 块标量：> / >- / | / |- 后续连续缩进行（浅于首个非空行缩进即块结束）为值体。
    if (inline === '>' || inline === '>-' || inline === '|' || inline === '|-') {
      const block: string[] = []
      let indent = -1
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j]!
        if (raw.trim() === '') {
          block.push('')
          continue
        }
        const leading = raw.length - raw.trimStart().length
        if (indent === -1) indent = leading
        if (leading < indent) break
        block.push(raw.slice(indent))
        i = j
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop()
      const value = inline.startsWith('>')
        ? block.map((l) => l.trim()).filter((l) => l !== '').join(' ')
        : block.join('\n')
      fields.set(key, value.trim())
      continue
    }
    fields.set(key, stripQuotedScalar(inline))
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
