/**
 * ProfileService: manage `profiles/<id>/`(profile.json + SYSTEM.md).
 * Profile shape with @helm/protocol is allow (id required,name/model/runtime/tags optional);
 * model is empty string or default means not config, by runtime explicit errors, service layer do not fabricate by default model.
 * MEMORY.md long phase memory by builtin:memory plugin self govern manage, does not enter this service.
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
export const DEFAULT_PROFILE_NAME = 'person assist'
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** think Profile legal enumeration (and pi-ai ModelThinkingLevel same source;schema without runtime dependency, this where independent declaration). */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Layer 0 common resident system hint (three layer gradually enter style disclose most top-level): only declaration identity and managed helm
 * CLI environment direct feel; command table, generate style UI component dictionary etc. work detail push down Layer 1/2
 *(skills/helm-cli), detailed manual do not common resident (directory description still has few amount cost).
 * update_memory use refer quote by builtin:memory plugin by Profile switch motion state inject.
 */
export const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  'you is run in Helm microkernel on person assist.',
  '',
  '1. managed bash already provide `helm` CLI and conversation identity `HELM_CONVERSATION_ID`, available `--current` and `--json` invoke.',
  '2. when before available skill contains helm-cli when, operation Helm or answer host capability issue before, first `load_skill({ skillId: "helm-cli" })` and on demand read references, via command help and actual state verify capability; the skill do not in when before available directory in when skip this step.',
  '3. ordinary back re- use Markdown; interaction style card, can re- use micro app etc. extend output form with when turn available skill directory is allow: skill description declaration provide this class capability when, first load_skill load its refer quote again output, directory in missing when use ordinary Markdown, do not reference missing manual. generate file supply user in Web view when, use write(..., artifact: true),register_artifact({ path }) or helm artifacts put <path> --current register artifact, and in back re- in use [filename](artifact:<id>) or ![diagram piece](artifact:<id>) directly render. external command generate file when use target node on absolute output path, confirm pre- phase file store in and register after success again deliver or clean up source worktree.',
  '',
].join('\n')

/** validate profile id: small write character parent number and hyphen, guard against directory inject and path through exceeds. */
export function assertProfileId(id: string): void {
  if (!NAME_PATTERN.test(id)) {
    throw new Error(`illegal profile id: ${id}(only allows a-z 0-9 and hyphen)`)
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

/** Unicode code point length (proxy for count 1, and render width direct feel consistent; contract unify opening path). */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** single quote lead term boundary validate:label specification is trim form,prompt keep original text;
 * unknown field reject (quote lead term is user can edit data, static default lose field will build into UI save after lose content). */
export function validateProfileStarter(item: unknown, at: string): ProfileStarterPrompt {
  if (!isPlainObject(item)) throw new Error(`${at} must be { label, prompt } object`)
  const label = item['label']
  const prompt = item['prompt']
  if (Object.keys(item).some((key) => key !== 'label' && key !== 'prompt')) {
    throw new Error(`${at} only accept label and prompt field`)
  }
  if (typeof label !== 'string') throw new Error(`${at}.label must be string`)
  const normalizedLabel = label.trim()
  if (codePointLength(normalizedLabel) === 0) throw new Error(`${at}.label cannot be empty after trimming`)
  if (codePointLength(normalizedLabel) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    throw new Error(`${at}.label at most ${PROFILE_STARTER_LABEL_MAX_LENGTH}  Unicode code point`)
  }
  if (typeof prompt !== 'string') throw new Error(`${at}.prompt must be string`)
  if (prompt.trim() === '') throw new Error(`${at}.prompt cannot be pure whitespace`)
  if (codePointLength(prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    throw new Error(`${at}.prompt at most ${PROFILE_STARTER_PROMPT_MAX_LENGTH}  Unicode code point (keep original text, do not truncate)`)
  }
  return { label: normalizedLabel, prompt }
}

/** Profile input boundary validate (new increase/update shared use); return specification after can persist form. */
export function validateProfileInput(input: unknown): Profile {
  if (!isPlainObject(input)) throw new Error('profile must be object')
  const id = input['id']
  if (typeof id !== 'string' || !NAME_PATTERN.test(id)) {
    throw new Error(`illegal profile id: ${String(id)}(only allows a-z 0-9 and hyphen)`)
  }
  const profile: Profile = { id }
  const name = input['name']
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`profile '${id}' name cannot be empty`)
    }
    profile.name = name
  }
  const model = input['model']
  if (model !== undefined) {
    if (typeof model !== 'string') throw new Error(`profile '${id}' model must be string`)
    profile.model = model
  }
  const thinkingLevel = input['thinkingLevel']
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.has(thinkingLevel)) {
      throw new Error(`profile '${id}' thinkingLevel illegal (legal value:${[...THINKING_LEVELS].join(' | ')})`)
    }
    profile.thinkingLevel = thinkingLevel
  }
  const nodeId = input['nodeId']
  if (nodeId !== undefined) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new Error(`profile '${id}' nodeId if store in must be non-empty string (compute node ID)`)
    }
    profile.nodeId = nodeId
  }
  const cwd = input['cwd']
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`profile '${id}' cwd if store in must be non-empty string (target platform absolute path)`)
    }
    profile.cwd = cwd
  }
  const tags = input['tags']
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`profile '${id}' tags must be string array`)
    }
    profile.tags = [...tags] as string[]
  }
  // skill blank name single: element must be legal skill id; duplicate items specification dedupe after persist (keep [],
  // empty array means disable all skill). allows save not yet install id- - skill directory is runtime
  // state (can after install), config phase do not strong seek store in; runtime by isSkillAvailable unify decide.
  const skills = input['skills']
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
      throw new Error(`profile '${id}' skills must be string array (skill id blank name single; default all available, empty array disable all)`)
    }
    const deduped: string[] = []
    for (const skillId of skills) {
      assertSkillId(skillId)
      if (!deduped.includes(skillId)) deduped.push(skillId)
    }
    profile.skills = deduped
  }
  // whitespace conversation quote lead term: at most six items;label trim after non-empty and ≤24 code point (specification is trim
  // form persist),prompt non- pure whitespace and keep original text (≤4000 code point, do not truncate).
  // empty array [] explicit keep (means empty self define, back host by default hint), default do not write field.
  const starters = input['starters']
  if (starters !== undefined) {
    if (!Array.isArray(starters)) {
      throw new Error(`profile '${id}' starters must be { label, prompt } object array`)
    }
    if (starters.length > PROFILE_STARTERS_MAX_ITEMS) {
      throw new Error(`profile '${id}' starters at most ${PROFILE_STARTERS_MAX_ITEMS} items`)
    }
    profile.starters = starters.map((item, index) => validateProfileStarter(item, `profile '${id}' starters[${index}]`))
  }
  const managedByPlugin = input['managedByPlugin']
  if (managedByPlugin !== undefined) {
    if (typeof managedByPlugin !== 'string' || managedByPlugin.trim() === '') {
      throw new Error(`profile '${id}' managedByPlugin if store in must be non-empty string (hosting plugin ID)`)
    }
    profile.managedByPlugin = managedByPlugin
  }
  const humanSelectable = input['humanSelectable']
  if (humanSelectable !== undefined) {
    if (typeof humanSelectable !== 'boolean') {
      throw new Error(`profile '${id}' humanSelectable if store in must be boolean value (common resident single example role placement false, default true)`)
    }
    profile.humanSelectable = humanSelectable
  }
  const runtime = input['runtime']
  if (runtime !== undefined) {
    if (!isPlainObject(runtime)) throw new Error(`profile '${id}' runtime must be object`)
    const runtimeKeys = new Set(['kind', 'agent', 'args', 'nodeId', 'workspace', 'env'])
    for (const key of Object.keys(runtime)) {
      if (!runtimeKeys.has(key)) throw new Error(`profile '${id}' runtime contains unknown field '${key}', reject ignore execute target`)
    }
    const kind = runtime['kind']
    const agent = runtime['agent']
    // kernel zero plugin enumeration hard encode:kind only validate external runtime identifier format (naming empty between small write
    // identifier symbol, such as 'herdr' / 'docker'), specific runtime is otherwise by plugin take over by
    // agent_spawn hook pipeline decide, kernel do not point name any plugin.
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {
      throw new Error(`profile '${id}' runtime.kind must be external runtime identifier symbol (small write character parent open head, can contains a-z 0-9 _ -, length 1..32)`)
    }
    if (typeof agent !== 'string' || agent === '') {
      throw new Error(`profile '${id}' runtime.agent cannot be empty`)
    }
    const args = runtime['args']
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw new Error(`profile '${id}' runtime.args must be string array`)
    }
    const nodeId = runtime['nodeId']
    if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId === '')) {
      throw new Error(`profile '${id}' runtime.nodeId if store in must be non-empty string (target compute node identifier)`)
    }
    const workspace = runtime['workspace']
    if (workspace !== undefined) {
      if (typeof workspace !== 'string' || workspace === '') {
        throw new Error(`profile '${id}' runtime.workspace if store in must be non-empty string (absolute path)`)
      }
      // across platform absolute path (and runtime/tools.ts isAbsoluteTargetPath same semantics):
      // POSIX `/`,Windows symbol `C:\\` / `C:/`,UNC `\\\\server\\share`.
      if (!(
        workspace.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(workspace) ||
        /^\\\\[^\\]+\\[^\\]+/.test(workspace)
      )) {
        throw new Error(`profile '${id}' runtime.workspace must be across platform absolute path (POSIX /,Windows symbol or UNC), when before is '${workspace}'`)
      }
    }
    const env = runtime['env']
    if (env !== undefined) {
      if (!isPlainObject(env) || Object.keys(env).length === 0) {
        throw new Error(`profile '${id}' runtime.env if store in must be non-empty object`)
      }
      for (const [name, value] of Object.entries(env)) {
        if (!isValidEnvName(name)) {
          throw new Error(`profile '${id}' runtime.env key '${name}' must be legal environment variable name`)
        }
        if (typeof value !== 'string') {
          throw new Error(`profile '${id}' runtime.env['${name}'] must be string (such as must secret please use credentials/secret stash, do not profile)`)
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

/** file asset by when before contract validate, do not push test old format or ignore unknown execute field. */
function normalizeProfile(value: unknown, id: string): Profile {
  if (!isPlainObject(value)) throw new Error(`profile.json structure illegal: ${id}`)
  return validateProfileInput({ ...value, id })
}

/** before deletion bind set re-check dependency:HTTP layer inject conversation side query, service layer honor bottom close
 * routing fast path check → concurrency create/PATCH bind set → delete hand over wrong window. */
export interface ProfileDeleteDeps {
  isProfileInUse(profileId: string): boolean | Promise<boolean>
}

export class ProfileService {
  constructor(private readonly dataDir: string) {}

  /** first time start self raise by default assistant profile(already exists then original return, does not override user change). */
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

  /** creates new or whole save profile(if carry system then atomic sync until SYSTEM.md, do not write profile.json). */
  async save(input: unknown): Promise<Profile> {
    if (!isPlainObject(input)) throw new Error('profile must be object')
    const rawSystem = input['system']
    if (rawSystem !== undefined && typeof rawSystem !== 'string') {
      throw new Error('profile system must be string')
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
   * delete profile; by default assistant subject to protect cannot delete.
   * deps.isProfileInUse(optional): delete before finally one moment re-check without conversation bind set, has then
   * 409 profile_in_use- - routing layer fast path check and delete between isolate multiple await, concurrency
   * create/PATCH bind set can in window inside through; do not inject when only keep by default profile protect
   * (caller self row guarantee without bind set).
   */
  async delete(id: string, deps?: ProfileDeleteDeps): Promise<void> {
    assertProfileId(id)
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error(`by default profile '${DEFAULT_PROFILE_ID}' cannot delete`)
    }
    if (deps !== undefined && (await deps.isProfileInUse(id))) {
      throw new HelmError('profile_in_use', `profile ${id} still by conversation bind set, first solve bind again delete`, 409, {
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
    if (typeof text !== 'string') throw new Error('system text must be string')
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

/** real path contains decide:child === parent or at parent of under (all must already realpath). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent + sep)
}

export function assertSkillId(id: string): void {
  if (!SKILL_NAME_PATTERN.test(id)) {
    throw new Error(`illegal skill id: ${id}`)
  }
}

/** built-in plugin self raise skill package asset:SKILL.md + references sub- file content. */
export interface BuiltinSkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

/**
 * validate skill package inside relative path: forbidden absolute path,`..` segment, backslash, control character and empty segment.
 * allows `SKILL.md` and `references/...` form embed set relative path.
 */
export function assertSafeRelativePath(input: string): string {
  if (input.includes('\\')) throw new Error(`illegal path (backslash): ${input}`)
  if (input.includes('\0')) throw new Error('illegal path (contains NUL)')
  if (input === '' || input === '.') throw new Error('path cannot be empty')
  if (input.startsWith('/')) throw new Error(`forbidden absolute path: ${input}`)
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') throw new Error(`illegal path segment: ${input}`)
    if (seg === '..') throw new Error(`forbidden path through exceeds: ${input}`)
    if (/[\s\/?#]/.test(seg)) throw new Error(`illegal path segment: ${input}`)
  }
  return input
}

/** recursion collect skill package inside common rule file relative path. skip: with `.` open head hide file/directory
 * (.git/.gitignore etc.), dependency and build artifact directory (node_modules/__pycache__/dist,
 * project type skill package directly scan will the whole dependency tree stuff explode directory) and symlink (eliminate out of bounds entry);
 * only collect can via assertSafeRelativePath validate path - - directory and load_skill shared use
 * the same legal opening path, guarantee column out each reference all real can read (contains space/?/# etc. character
 * path directly do not column, guard against say row do not one). */
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
        // illegal relative path (space/special character) cannot via load_skill read, does not enter directory.
      }
    }
  }
  return out.sort()
}

/**
 * machine level sharing skill (pi generate state skill store,`~/.agents/skills`):SkillService its
 * as external source only read scan and load, do not via this service writeFile/ensureSkill write.
 * this is not file system permission or command tool sandbox;bash/read/write/edit still by OS permission access.
 * and HELM_DATA_DIR independent; by produce kernel group install when inject,SkillService itself default excludes.
 */
export function defaultExternalSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills')]
}

/** external single item error skip decide: shape/validate class error (ordinary Error, without Node
 * error code) and ENOENT(SKILL.md/directory missing) skip the item; real IO error
 * (EACCES/EIO etc. code non- ENOENT) such as on throw, not silently fall back. */
function isSkippableExternalEntryError(err: unknown): boolean {
  if (err instanceof FileNotFoundError) return true
  const code = (err as { code?: unknown }).code
  if (code === undefined) return true
  return code === 'ENOENT'
}

export class SkillService {
  /** ensureSkill self raise register managed skill id(process inside; common rule write opening unify 403 reject). */
  private readonly managedSkillIds = new Set<string>()

  private readonly dataDir: string

  /** only supply SkillService scan and load_skill read external source (arrange in dataDir after). */
  private readonly externalRoots: readonly string[]

  /** default excludes external: this service is to set directory pure determinism scan, machine level sharing by
   * produce kernel group install when via defaultExternalSkillRoots() inject (test day however isolated). */
  constructor(dataDir: string, options?: { externalRoots?: readonly string[] }) {
    this.dataDir = dataDir
    this.externalRoots = options?.externalRoots ?? []
  }

  /** all skill summary (dataDir  + external sharing merge, supply load_skill directory inject).
   * dataDir semantics do not change: illegal id skip, broken frontmatter such as throws. external whole
   * ENOENT treated as empty; single item broken data (third way content,helm do not own its quality) skip do not
   * drag collapse the whole directory - - and dataDir strictly throws semantics moment intent different. by id dedupe:
   * dataDir item absolute takes precedence (managed skill forever do not by external same name obscure; user to dataDir put
   * same name skill i.e. shape into local override), its after by declaration order take first. by id stable sort. */
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
      // readdir succeeded i.e. store in;realpath archive one (macOS /var etc. symlink prefix) supply contains validate.
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
        // sharing missing treated as empty (not installed pi skill store), do not errors.
        if ((err as { code?: string }).code === 'ENOENT') continue
        throw err
      }
      if (extEntries.length === 0) continue
      const extRootReal = await realpath(extRoot)
      for (const entry of extEntries) {
        if (byId.has(entry)) continue // dataDir(or first order external) item takes precedence
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

  /** security read skill package file: default SKILL.md; strictly intercept absolute path/`..`/symlink out of bounds.
   * parse order dataDir → each external sharing: skill directory in a certain missing then try under one,
   * all all without this skill dimension hold FileNotFoundError(HTTP 404 opening path do not change); security validate
   * reject (symlink/out of bounds/very rule file) in hit immediately on throw, never across fall back. each
   * validate strong and dataDir policy fully consistent - - three layer guard against defend:① skill directory itself symlink directly
   * reject;② realpath two-layer contains validate (skillDir real path must in which belong skills 
   * inside);③ one by one segment reject symlink and confirm target real path still in skillDir inside.
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

  /** single inside parse read: return file content; skill directory in the missing when return undefined
   * (continue under one); skill store in but target file missing throw FileNotFoundError(the item
   * already takes effect, do not across fall back). */
  private async readFileInRoot(skillsRoot: string, skillId: string, rel: string): Promise<string | undefined> {
    const root = join(skillsRoot, skillId)
    // skill directory itself is symlink i.e. reject (even if parse after still in skills inside, also do not put wide).
    const rootStat = await lstat(root).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (rootStat === undefined) return undefined
    if (rootStat.isSymbolicLink()) {
      throw new Error(`skill directory is symlink, reject read: ${skillId}`)
    }
    // two-layer realpath contains validate:skillDir real path must in skills inside (guard against inside in rotate out of bounds).
    const rootReal = await realpath(root)
    if (!isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points to skills of outside): ${skillId}`)
    }
    const target = join(root, rel)
    // one by one segment lstat: path on any symlink all reject (symlink may points to skill directory of outside).
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
        throw new Error(`reject read symlink (guard against out of bounds): ${rel}`)
      }
    }
    const finalStat = await lstat(target)
    if (!finalStat.isFile()) throw new Error(`is not common rule file: ${rel}`)
    // target real path must still in skillDir inside (resist read in route directory by replace is symlink).
    const targetReal = await realpath(target)
    if (!isWithin(targetReal, rootReal)) {
      throw new Error(`target exceeds out skill directory (realpath do not in skillDir inside): ${rel}`)
    }
    return readTextFile(target)
  }

  /** can read parse (realpath archive one):dataDir skills in before, its after in order external sharing
   * ; ENOENT skip (dataDir missing no longer global throws, eventually by readFile unify
   * FileNotFoundError); dangling symlink etc. other realpath error such as on throw. */
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

  /** create/override skill file (program write entry, same do security validate).
   * managed skill (ensureSkill self raise register inside placement system asset) in service boundary unify reject.
   * this service only write dataDir : for external sharing same name skill tune writeFile will write dataDir
   * copy from while obscure external item, shape into local override. this is not file system write permission boundary;
   * bash/write/edit etc. through use tool still can by OS permission directly write any path. */
  async writeFile(skillId: string, path: string, content: string): Promise<void> {
    assertSkillId(skillId)
    this.assertSkillMutable(skillId)
    const rel = assertSafeRelativePath(path)
    const skillsRoot = await this.requireSkillsRoot()
    const root = join(skillsRoot, skillId)
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal !== undefined && !isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points to skills of outside): ${skillId}`)
    }
    const target = join(root, rel)
    const existing = await lstat(target).catch(() => undefined)
    if (existing !== undefined && existing.isSymbolicLink()) {
      throw new Error(`reject override symlink: ${rel}`)
    }
    await atomicWriteFile(target, content)
  }

  /**
   * built-in plugin managed skill self raise:skills/<id>/SKILL.md and references/* is managed system
   * asset, each time start with source code declaration version is allow one by one file override back write (disk on old file and
   * manually work modify one rule back to source code version), missing file patch complete; do not delete skill directory in other
   * file. content consistent file skip write (by byte content compare, do not by mtime, avoid atomic
   * rename trigger AssetWatcher hot load jitter).
   *
   * security boundary do not change:reference path first whole validate (illegal asset produces no part file);
   * before write one by one layer confirm skills/<id>,references and embed set reference directory all non- symbol
   * link,skills and readFile same via realpath parse (symlink can accept); already has
   * target must be common rule file (symlink/directory smoke fill i.e. reject);ENOENT of outside error such as
   * on throw. register enter managedSkillIds after, common rule write opening unify 403 reject.
   */
  async ensureSkill(asset: BuiltinSkillAsset): Promise<void> {
    assertSkillId(asset.id)
    // boundary first row: any illegal reference all in any directory create/file write before whole reject.
    const references = Object.entries(asset.references).map(([name, content]) => ({
      rel: assertSafeRelativePath(`references/${name}`),
      content,
    }))
    const skillsRoot = join(this.dataDir, 'skills')
    // skills missing when patch create (first time self raise); dangling symlink realpath obtain ENOENT while
    // mkdir collide EEXIST, such as on throw, not silently bypass.
    let rootReal: string
    try {
      rootReal = await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      await mkdir(skillsRoot, { recursive: true })
      rootReal = await realpath(skillsRoot)
    }
    const dir = join(rootReal, asset.id)
    // create directory before one by one layer confirm skills/<id>,references and embed set directory excludes symlink (guard against to
    // skills of outside write); segment missing i.e. await create, its under cannot can again has content.
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

  /** managed skill unify only read protect (403 managed_skill_readonly): content unique right threat is
   * plugin at startup source code version. process inside register - - each time start ensureSkill rebuild, do not
   * store (user self create skill do not via ensureSkill, do not subject to affect). */
  private assertSkillMutable(skillId: string): void {
    if (this.managedSkillIds.has(skillId)) {
      throw new HelmError(
        'managed_skill_readonly',
        `skill '${skillId}' is built-in plugin managed system asset, forbidden frequently rule interface write or delete (plugin at startup automatically with source code version override sync)`,
        403,
        { skillId },
      )
    }
  }

  /** skill asset directory coordinates (host port use, such as plugin self raise patch complete file): always points to
   * dataDir/skills/<id>, do not parse to external source. caller may via atomicWriteFile
   * automatically patch complete managed asset; avoid plugin start side effect change write sharing source. this where is not through use command
   * path permission boundary; host do not mkdir, default path by caller on demand create. */
  async directory(id: string): Promise<string> {
    try {
      assertSkillId(id)
    } catch (err) {
      throw new HelmError(
        'validation_error',
        `Skill id illegal:${err instanceof Error ? err.message : String(err)}`,
        400,
        { skillId: id },
      )
    }
    return join(this.dataDir, 'skills', id)
  }

  /** parse skills real path (missing when throws, never wide put). */
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

  /** single summary: skill directory missing return undefined(directory skip the item);SKILL.md missing
   * (FileNotFoundError) same return undefined;frontmatter broken data such as on throw
   * (by caller decide dataDir strictly throws or external skip policy). external force strip
   * managedByPlugin- - sharing only may is ordinary sharing skill, never allows third way file
   * disguise into host managed plugin skill. */
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
 * one by one layer confirm ancestor of under until dir each already exists segment all is real directory (non- symlink);
 * segment missing i.e. its after cannot can store in, treated as await create and stop. guard against skills/<id> or
 * references(contains embed set subdirectory) is symlink when self raise asset write to skills of outside.
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
      throw new Error(`reject via symlink directory write: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`path segment is not directory, reject self raise: ${current}`)
    }
  }
}

/** managed override write: target missing i.e. atomic write; already exists must be common rule file (symlink/directory all
 * reject), content and declaration consistent when skip write (avoid atomic rename jitter watcher),
 * inconsistent then atomic override is source code version; other IO error such as on throw. */
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
    throw new Error(`target already exists and is not common rule file, reject write: ${path}`)
  }
  const current = await readFile(path, 'utf8').catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (current === content) return
  await atomicWriteFile(path, content)
}

/** strip YAML single row mark amount first tail for call single/double quotes (double quotes restore \" and \\ escaping,
 * single quotes restore '' escaping; do not for call quotes original keep, do not fabricate parse). */
function stripQuotedScalar(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first !== '"' || last !== '"') && (first !== "'" || last !== "'")) return value
  const inner = value.slice(1, -1)
  if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return inner.replace(/''/g, "'")
}

/** parse SKILL.md top part YAML frontmatter  name/description/managedByPlugin(missing when fall back id/empty).
 * only accept when before field name managedByPlugin(without history alias compatibility); key store in but value is empty belong illegal shape,
 * explicit errors while non- fabricate without main data (honest failed, not silently fall back).
 * value language method override pi generate state sharing skill store (~/.agents/skills) real data most small collection: single row
 * mark amount (strip first tail for call quotes) and chunk mark amount - - collapse type > / >-(connect continue shrink enter row trim after with
 * space concatenate, fit long description single row) and keep type | / |-(remove public shrink enter after with newline concatenate);
 * the rest high level YAML language method (anchor/list/embed set etc.) unsupported. */
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
    // chunk mark amount:> / >- / | / |- after continue connect continue shrink enter row (shallow at first non-empty row shrink enter i.e. chunk end) is value body.
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
    throw new Error(`SKILL.md frontmatter managedByPlugin value is empty (key store in then must be non-empty plugin ID)`)
  }
  return {
    name: fields.get('name') ?? '',
    description: fields.get('description') ?? '',
    ...(managedRaw !== undefined ? { managedByPlugin: managedRaw } : {}),
  }
}
