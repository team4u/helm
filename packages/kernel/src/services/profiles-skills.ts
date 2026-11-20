/**
 * ProfileService: manages `profiles/<id>/` (profile.json + SYSTEM.md).
 * Profile schema conforms to @helmx/protocol (id required; name/model/runtime/tags optional).
 * An empty or omitted model means unconfigured—runtime reports an explicit error rather than fabricating a default model in the service layer.
 * Long-term MEMORY.md is autonomously managed by the builtin:memory plugin and does not belong here.
 */
import { lstat, mkdir, readdir, readFile, realpath, rmdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  HelmxError,
  assertProfileId,
  assertSkillId,
  assertSafeSkillRelativePath,
  isJsonObject,
  isValidEnvName,
  isValidProfileId,
  parseSkillFrontmatter,
  type Profile,
  type ProfileChangedEvent,
  type ProfileStarterPrompt,
  type SkillSummary,
} from '@helmx/protocol'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
} from '@helmx/protocol'

export type { Profile, SkillSummary }
import {
  FileNotFoundError,
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'
import { withFileLock } from './file-lock.js'

// Re-export the shared skill contract so the kernel services entry keeps exposing it
// (existing in-repo consumers import from '../services/index.js').
export { assertSkillId, assertSafeSkillRelativePath, parseSkillFrontmatter } from '@helmx/protocol'

export const DEFAULT_PROFILE_ID = 'assistant'
const DEFAULT_PROFILE_NAME = 'person assist'
/** Valid thinking level enum values (aligned with pi-ai ModelThinkingLevel; declared independently so schema stays dependency-free). */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Layer 0 resident system prompt (top of the three-tier progressive disclosure): declares only identity and managed helmx
 * CLI awareness; command tables, generative UI component references, and other working details live in Layer 1/2
 * (skills/helmx-cli) instead of remaining permanently resident (skill catalog descriptions still carry minimal cost).
 * update_memory instructions are dynamically injected by the builtin:memory plugin based on the Profile toggle.
 */
export const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  'You are a personal assistant running on the Helmx microkernel.',
  '',
  '1. Managed bash provides the `helmx` CLI and conversation identity `HELMX_CONVERSATION_ID`; invoke commands with `--current` and `--json`.',
  '2. When `helmx-cli` is in the currently available skills directory, call `load_skill({ skillId: "helmx-cli" })` and read its references on demand before operating Helmx or answering host capability questions, verifying capabilities through command help and live state; skip this step if the skill is not in the currently available directory.',
  '3. Use Markdown for normal replies; extended output formats such as interactive cards or reusable micro-apps follow the currently available skill directory for this turn: when a skill description declares such a capability, call `load_skill` first to load its guide before outputting, and fall back to normal Markdown without referencing nonexistent guides if missing from the directory. When generating files for users to view on Web, register artifacts via `write(..., artifact: true)`, `register_artifact({ path })`, or `helmx artifacts put <path> --current`, and render them directly in your reply using `[filename](artifact:<id>)` or `![image](artifact:<id>)`. When an external command produces files, use an absolute output path on the target node and verify the expected file exists and is registered before delivering or cleaning up the source worktree.',
  '',
].join('\n')

function nowIso(): string {
  return new Date().toISOString()
}

function profileDir(dataDir: string, id: string): string {
  return join(dataDir, 'profiles', id)
}

/** Unicode code-point length (surrogate pairs count as 1, matching visual display width; canonical across contract). */
function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Validate a single starter prompt at the boundary: label is normalized by trimming, prompt preserves original text;
 * unknown fields are rejected (starters are user-editable data; silently dropping fields causes data loss in UI saves). */
function validateProfileStarter(item: unknown, at: string): ProfileStarterPrompt {
  if (!isJsonObject(item)) throw new Error(`${at} must be { label, prompt } object`)
  const label = item['label']
  const prompt = item['prompt']
  if (Object.keys(item).some((key) => key !== 'label' && key !== 'prompt')) {
    throw new Error(`${at} may only accept label and prompt fields`)
  }
  if (typeof label !== 'string') throw new Error(`${at}.label must be a string`)
  const normalizedLabel = label.trim()
  if (codePointLength(normalizedLabel) === 0) throw new Error(`${at}.label cannot be empty after trimming`)
  if (codePointLength(normalizedLabel) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    throw new Error(`${at}.label at most ${PROFILE_STARTER_LABEL_MAX_LENGTH} Unicode code points`)
  }
  if (typeof prompt !== 'string') throw new Error(`${at}.prompt must be a string`)
  if (prompt.trim() === '') throw new Error(`${at}.prompt cannot be pure whitespace`)
  if (codePointLength(prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    throw new Error(`${at}.prompt at most ${PROFILE_STARTER_PROMPT_MAX_LENGTH} Unicode code points (preserves original text without truncation)`)
  }
  return { label: normalizedLabel, prompt }
}

/** Validate Profile input at the boundary (shared by create/update); returns the normalized persistable shape. */
export function validateProfileInput(input: unknown): Profile {
  if (!isJsonObject(input)) throw new Error('profile must be an object')
  const id = input['id']
  if (typeof id !== 'string' || !isValidProfileId(id)) {
    throw new Error(`illegal profile id: ${String(id)} (only allows a-z 0-9 and hyphen)`)
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
    if (typeof model !== 'string') throw new Error(`profile '${id}' model must be a string`)
    profile.model = model
  }
  const thinkingLevel = input['thinkingLevel']
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.has(thinkingLevel)) {
      throw new Error(`profile '${id}' thinkingLevel is invalid (valid values: ${[...THINKING_LEVELS].join(' | ')})`)
    }
    profile.thinkingLevel = thinkingLevel
  }
  const nodeId = input['nodeId']
  if (nodeId !== undefined) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new Error(`profile '${id}' nodeId must be a non-empty string when present (compute node ID)`)
    }
    profile.nodeId = nodeId
  }
  const cwd = input['cwd']
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`profile '${id}' cwd must be a non-empty string when present (target platform absolute path)`)
    }
    profile.cwd = cwd
  }
  const tags = input['tags']
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`profile '${id}' tags must be a string array`)
    }
    profile.tags = [...tags] as string[]
  }
  // Skill allowlist: elements must be valid skill IDs; duplicates are deduplicated before persisting ([] is preserved
  // to disable all skills). Saving not-yet-installed IDs is permitted since skill directories are runtime state;
  // runtime checks availability uniformly via isSkillAvailable.
  const skills = input['skills']
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
      throw new Error(`profile '${id}' skills must be a string array (skill ID allowlist; defaults to all enabled, empty array disables all)`)
    }
    const deduped: string[] = []
    for (const skillId of skills) {
      assertSkillId(skillId)
      if (!deduped.includes(skillId)) deduped.push(skillId)
    }
    profile.skills = deduped
  }
  // Empty-conversation starter prompts: up to 6 items; label is trimmed, non-empty, and <=24 code points (persisted trimmed);
  // prompt must not be pure whitespace and preserves original text (<=4000 code points, never truncated).
  // An empty array [] is explicitly persisted (meaning "cleared custom starters, fall back to host defaults"); omitted leaves field unset.
  const starters = input['starters']
  if (starters !== undefined) {
    if (!Array.isArray(starters)) {
      throw new Error(`profile '${id}' starters must be an array of { label, prompt } objects`)
    }
    if (starters.length > PROFILE_STARTERS_MAX_ITEMS) {
      throw new Error(`profile '${id}' starters at most ${PROFILE_STARTERS_MAX_ITEMS} items`)
    }
    profile.starters = starters.map((item, index) => validateProfileStarter(item, `profile '${id}' starters[${index}]`))
  }
  const managedByPlugin = input['managedByPlugin']
  if (managedByPlugin !== undefined) {
    if (typeof managedByPlugin !== 'string' || managedByPlugin.trim() === '') {
      throw new Error(`profile '${id}' managedByPlugin must be a non-empty string when present (owning plugin ID)`)
    }
    profile.managedByPlugin = managedByPlugin
  }
  const humanSelectable = input['humanSelectable']
  if (humanSelectable !== undefined) {
    if (typeof humanSelectable !== 'boolean') {
      throw new Error(`profile '${id}' humanSelectable must be a boolean when present (false for singleton system roles, defaults to true)`)
    }
    profile.humanSelectable = humanSelectable
  }
  const restrictToCwd = input['restrictToCwd']
  if (restrictToCwd !== undefined) {
    if (typeof restrictToCwd !== 'boolean') {
      throw new Error(`profile '${id}' restrictToCwd must be a boolean when present (cwd guardrail for file tools, defaults to false)`)
    }
    profile.restrictToCwd = restrictToCwd
  }
  const runtime = input['runtime']
  if (runtime !== undefined) {
    if (!isJsonObject(runtime)) throw new Error(`profile '${id}' runtime must be an object`)
    const runtimeKeys = new Set(['kind', 'agent', 'args', 'nodeId', 'workspace', 'env'])
    for (const key of Object.keys(runtime)) {
      if (!runtimeKeys.has(key)) throw new Error(`profile '${id}' runtime contains unknown field '${key}'; refusing to ignore execution target`)
    }
    const kind = runtime['kind']
    const agent = runtime['agent']
    // Zero plugin enum hardcoding in kernel: kind only validates external runtime identifier format (lowercase namespace
    // identifier, e.g. 'herdr' / 'docker'); whether a plugin handles it is decided by the agent_spawn hook pipeline.
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {
      throw new Error(`profile '${id}' runtime.kind must be an external runtime identifier (starts with a-z, may contain a-z 0-9 _ -, length 1..32)`)
    }
    if (typeof agent !== 'string' || agent === '') {
      throw new Error(`profile '${id}' runtime.agent cannot be empty`)
    }
    const args = runtime['args']
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw new Error(`profile '${id}' runtime.args must be a string array`)
    }
    const nodeId = runtime['nodeId']
    if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId === '')) {
      throw new Error(`profile '${id}' runtime.nodeId must be a non-empty string when present (target compute node ID)`)
    }
    const workspace = runtime['workspace']
    if (workspace !== undefined) {
      if (typeof workspace !== 'string' || workspace === '') {
        throw new Error(`profile '${id}' runtime.workspace must be a non-empty string when present (absolute path)`)
      }
      // Cross-platform absolute paths (same semantics as isAbsoluteTargetPath in runtime/tools):
      // POSIX `/`, Windows drive `C:\\` / `C:/`, UNC `\\\\server\\share`.
      if (!(
        workspace.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(workspace) ||
        /^\\\\[^\\]+\\[^\\]+/.test(workspace)
      )) {
        throw new Error(`profile '${id}' runtime.workspace must be a cross-platform absolute path (POSIX /, Windows drive, or UNC), got '${workspace}'`)
      }
    }
    const env = runtime['env']
    if (env !== undefined) {
      if (!isJsonObject(env) || Object.keys(env).length === 0) {
        throw new Error(`profile '${id}' runtime.env must be a non-empty object when present`)
      }
      for (const [name, value] of Object.entries(env)) {
        if (!isValidEnvName(name)) {
          throw new Error(`profile '${id}' runtime.env key '${name}' must be a valid environment variable name`)
        }
        if (typeof value !== 'string') {
          throw new Error(`profile '${id}' runtime.env['${name}'] must be a string (store secrets in credentials/secret stash, not in profile)`)
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

/** Validate file asset against the current contract without guessing legacy formats or ignoring unknown execution fields. */
function normalizeProfile(value: unknown, id: string): Profile {
  if (!isJsonObject(value)) throw new Error(`profile.json has invalid structure: ${id}`)
  return validateProfileInput({ ...value, id })
}

/** Binding re-check dependency before deletion: HTTP layer injects conversation query so the service layer closes
 * the race window between route fast-path check, concurrent create/PATCH binding, and disk deletion. */
interface ProfileDeleteDeps {
  isProfileInUse(profileId: string): boolean | Promise<boolean>
}

/**
 * Optional event publish port (narrow structural slice of the runtime's EventHub):
 * ProfileService emits `profile.changed` after successful save/delete so connected
 * Web/CLI clients re-read the profile catalog. Omitted in pure-service tests.
 */
export interface ProfileServiceEvents {
  publish(type: 'profile.changed', payload: unknown): unknown
}

export class ProfileService {
  constructor(
    private readonly dataDir: string,
    private readonly events?: ProfileServiceEvents,
  ) {}

  /** Bootstrap the default assistant profile on first startup (returns existing profile unchanged without overwriting user edits). */
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

  /** Create or replace a profile (if system is provided, atomically syncs to SYSTEM.md without writing it into profile.json). */
  async save(input: unknown): Promise<Profile> {
    if (!isJsonObject(input)) throw new Error('profile must be an object')
    const rawSystem = input['system']
    if (rawSystem !== undefined && typeof rawSystem !== 'string') {
      throw new Error('profile system must be a string')
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
    // Emit only after all writes succeed: validateProfileInput already strips `system` (detail endpoints attach it on demand).
    this.events?.publish('profile.changed', { type: 'profile.changed', profile } satisfies ProfileChangedEvent)
    return profile
  }

  /**
   * Delete a profile; the default assistant profile is protected and cannot be deleted.
   * deps.isProfileInUse (optional): re-checks right before deleting on disk that no conversation binds this profile,
   * throwing 409 profile_in_use if bound (prevents TOCTOU races across awaits between route check and concurrent create/PATCH);
   * when omitted, only the default profile protection applies (caller is responsible for checking bindings).
   */
  async delete(id: string, deps?: ProfileDeleteDeps): Promise<void> {
    assertProfileId(id)
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error(`default profile '${DEFAULT_PROFILE_ID}' cannot be deleted`)
    }
    if (deps !== undefined && (await deps.isProfileInUse(id))) {
      throw new HelmxError('profile_in_use', `profile ${id} is still bound by conversations; unbind before deleting`, 409, {
        profileId: id,
      })
    }
    const existing = await this.get(id)
    await rm(profileDir(this.dataDir, id), { recursive: true, force: true })
    // Notify only for a profile that actually existed (delete on a missing id is an idempotent no-op and must not fabricate a removal event).
    if (existing !== undefined) {
      this.events?.publish('profile.changed', {
        type: 'profile.changed',
        profile: existing,
        removed: true,
      } satisfies ProfileChangedEvent)
    }
  }

  async getSystem(id: string): Promise<string> {
    assertProfileId(id)
    return readTextFile(join(profileDir(this.dataDir, id), 'SYSTEM.md'))
  }

  async updateSystem(id: string, text: string): Promise<string> {
    assertProfileId(id)
    if (typeof text !== 'string') throw new Error('system text must be a string')
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

// Skill id / in-bundle path / frontmatter validity rules are the cross-package contract in
// @helmx/protocol skill-contract.ts (single source of truth, shared with @helmx/plugins node skills).

/** Real-path containment check: child === parent or child sits underneath parent (both must already be realpathed). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent + sep)
}

/** Built-in plugin bootstrapped skill bundle asset: SKILL.md + references files. */
export interface BuiltinSkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

/** Recursively collect relative paths of regular files in a skill bundle. Skips hidden files/dirs starting with `.`
 * (.git/.gitignore, etc.), dependency/build artifact dirs (node_modules/__pycache__/dist, which would bloat the catalog
 * on engineering-style skill bundles), and symlinks (closing escape vectors).
 * Only collects paths passing assertSafeSkillRelativePath—sharing the exact same validity contract with load_skill
 * so every listed reference is guaranteed readable (paths with spaces/?/# are omitted for consistency). */
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
        out.push(assertSafeSkillRelativePath(relPath))
      } catch {
        // Invalid relative paths (spaces / special chars) cannot be read via load_skill; exclude from catalog.
      }
    }
  }
  return out.sort()
}

/**
 * Machine-level shared skills root (pi ecosystem skill library, `~/.agents/skills`): SkillService scans and loads
 * it read-only as an external source and never writes to it via writeFile/ensureSkill.
 * This is not a filesystem permission or tool sandbox; bash/read/write/edit still follow OS permissions.
 * Independent of HELMX_DATA_DIR; injected by production kernel assembly, excluded from SkillService by default.
 */
export function defaultExternalSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills')]
}

/** Determine whether a single-entry error under an external root should be skipped: schema/validation errors (plain Error without Node
 * errno code) and ENOENT (missing SKILL.md or directory) skip the entry; real IO errors (EACCES/EIO, etc.)
 * are rethrown rather than silently ignored. */
function isSkippableExternalEntryError(err: unknown): boolean {
  if (err instanceof FileNotFoundError) return true
  const code = (err as { code?: unknown }).code
  if (code === undefined) return true
  return code === 'ENOENT'
}

export class SkillService {
  /** Managed skill IDs bootstrapped via ensureSkill (in-process; normal write endpoints return 403). */
  private readonly managedSkillIds = new Set<string>()

  /** Owner-indexed skill IDs ensured this process: the in-memory declared set used to sweep retired same-owner skill
   * dirs (rename/retire residue). Accumulates across ensureSkill calls, so a rename performed only via live plugin
   * reload keeps the retired id until the next process start reconciles it; plugins with multiple services that
   * ensure skills sequentially see delete+recreate churn at most (source content is rewritten identically). */
  private readonly managedIdsByOwner = new Map<string, Set<string>>()

  private readonly dataDir: string

  /** External sources scanned and loaded read-only by SkillService and load_skill (ordered after dataDir). */
  private readonly externalRoots: readonly string[]

  /** External roots are omitted by default: this service deterministically scans the given directories,
   * and production kernel assembly injects machine-level shared roots via defaultExternalSkillRoots() (tests stay isolated). */
  constructor(dataDir: string, options?: { externalRoots?: readonly string[] }) {
    this.dataDir = dataDir
    this.externalRoots = options?.externalRoots ?? []
  }

  /** All skill summaries (merged from dataDir root + external shared roots, injected into load_skill catalog).
   * dataDir root keeps strict semantics: invalid IDs are skipped, broken frontmatter throws. Missing external root
   * ENOENT is treated as empty; malformed external entries (third-party content Helmx does not own) are skipped rather than
   * breaking the entire catalog. Deduplicated by id: dataDir always wins (managed skills can never be shadowed by external ones,
   * while placing a same-named skill in dataDir creates a local override); otherwise first declared root wins. Sorted stably by id. */
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
      // readdir succeeded so the root exists; normalize via realpath (for macOS /var symlink prefixes) before containment checks.
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
        // Missing shared root is treated as empty (pi skill library not installed), not an error.
        if ((err as { code?: string }).code === 'ENOENT') continue
        throw err
      }
      if (extEntries.length === 0) continue
      const extRootReal = await realpath(extRoot)
      for (const entry of extEntries) {
        if (byId.has(entry)) continue // dataDir (or earlier external root) entry takes precedence
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

  /** Safely read a file inside a skill bundle (defaults to SKILL.md); strictly blocks absolute paths, `..`, and symlink escapes.
   * Resolution order: dataDir -> each external shared root. If the skill dir is absent in one root, tries the next;
   * if missing across all roots, preserves FileNotFoundError (HTTP 404). Security check rejections
   * (symlink/escape/non-regular file) throw immediately from the matching root without falling back across roots.
   * Every root enforces identical three-layer defense: (1) reject symlinked skill dir itself;
   * (2) two-layer realpath containment check (skillDir realpath must stay inside its skills root);
   * (3) per-segment lstat rejecting symlinks and verifying target realpath stays inside skillDir. */
  async readFile(skillId: string, path = 'SKILL.md'): Promise<string> {
    assertSkillId(skillId)
    const rel = assertSafeSkillRelativePath(path)
    for (const skillsRoot of await this.resolveReadableRoots()) {
      const content = await this.readFileInRoot(skillsRoot, skillId, rel)
      if (content !== undefined) return content
    }
    throw new FileNotFoundError(join(this.dataDir, 'skills', skillId))
  }

  /** Resolve and read within a single root: returns file contents, or undefined if the skill directory does not exist in this root
   * (so lookup continues to the next root); if the skill exists here but the target file is missing, throws FileNotFoundError
   * (this root owns the skill and never falls back to another root). */
  private async readFileInRoot(skillsRoot: string, skillId: string, rel: string): Promise<string | undefined> {
    const root = join(skillsRoot, skillId)
    // Reject if the skill directory itself is a symlink (even if its target resolves inside skillsRoot).
    const rootStat = await lstat(root).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (rootStat === undefined) return undefined
    if (rootStat.isSymbolicLink()) {
      throw new Error(`skill directory is a symlink; refusing to read: ${skillId}`)
    }
    // Two-layer realpath containment check: skillDir realpath must stay within skillsRoot (prevents intermediate symlink escapes).
    const rootReal = await realpath(root)
    if (!isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points outside skills root): ${skillId}`)
    }
    const target = join(root, rel)
    // Per-segment lstat: reject any symlink along the path (symlinks could escape the skill directory).
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
        throw new Error(`refusing to read symlink (out-of-bounds protection): ${rel}`)
      }
    }
    const finalStat = await lstat(target)
    if (!finalStat.isFile()) throw new Error(`not a regular file: ${rel}`)
    // Final target realpath must remain inside skillDir (protects against TOCTOU directory-to-symlink swaps mid-read).
    const targetReal = await realpath(target)
    if (!isWithin(targetReal, rootReal)) {
      throw new Error(`target escapes skill directory (realpath outside skillDir): ${rel}`)
    }
    return readTextFile(target)
  }

  /** Resolve readable roots (normalized with realpath): dataDir skills root first, followed by external shared roots;
   * ENOENT is skipped (missing dataDir skills root no longer throws globally, so readFile uniformly surfaces FileNotFoundError);
   * dangling symlinks and other realpath errors are rethrown. */
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

  /** Create or overwrite a skill file (programmatic write entry, enforcing the same security checks).
   * Managed skills (built-in system assets registered by ensureSkill) are uniformly rejected at the service boundary.
   * Only writes to dataDir: calling writeFile for a skill name from an external shared root writes a dataDir copy
   * that shadows the external entry as a local override. This is not a filesystem write permission boundary;
   * generic tools such as bash/write/edit can still write arbitrary paths per OS permissions. */
  async writeFile(skillId: string, path: string, content: string): Promise<void> {
    assertSkillId(skillId)
    this.assertSkillMutable(skillId)
    const rel = assertSafeSkillRelativePath(path)
    const skillsRoot = await this.requireSkillsRoot()
    const root = join(skillsRoot, skillId)
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal !== undefined && !isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points outside skills root): ${skillId}`)
    }
    const target = join(root, rel)
    const existing = await lstat(target).catch(() => undefined)
    if (existing !== undefined && existing.isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink: ${rel}`)
    }
    await atomicWriteFile(target, content)
  }

  /**
   * Built-in plugin managed skill bootstrapper: skills/<id>/SKILL.md and references/* are managed system assets;
   * on every startup they are overwritten file-by-file from the source declarations (reverting stale files and manual
   * disk edits back to source) and missing files are added. Files whose byte contents already match are skipped
   * (by byte comparison, not mtime, avoiding atomic rename churn in AssetWatcher hot reload).
   *
   * Source-of-authority reconciliation (no phantom residue): reference files no longer declared by the asset are
   * pruned from the references tree, and skill dirs whose SKILL.md still claims this asset's managedByPlugin owner
   * but whose id the owner no longer declares this session (rename/retire residue, e.g. swarm-collab -> swarm) are
   * removed—otherwise retired content keeps serving stale manuals via load_skill forever. Scope stays narrow:
   * files elsewhere in the kept skill dir (outside SKILL.md/references) and dirs owned by plugins that ensured
   * nothing this session (disabled plugins) are left intact; the catalog already filters the latter.
   *
   * Security boundary unchanged: validate all reference paths up front (invalid assets write nothing);
   * verify every directory segment along skills/<id>, references, and nested reference dirs is not a symlink, resolving
   * the skills root via realpath just like readFile; existing targets must be regular files (rejecting symlinks/directories);
   * errors other than ENOENT are rethrown. Deletions walk with lstat semantics only (symlinks are unlinked, never
   * followed) and are confined to the verified skill dir / skills root by construction. Once added to managedSkillIds,
   * normal write endpoints reject with 403.
   */
  async ensureSkill(asset: BuiltinSkillAsset): Promise<void> {
    assertSkillId(asset.id)
    // Validate boundary up front: reject any invalid reference before creating directories or writing files.
    const references = Object.entries(asset.references).map(([name, content]) => ({
      rel: assertSafeSkillRelativePath(`references/${name}`),
      content,
    }))
    const skillsRoot = join(this.dataDir, 'skills')
    // Create skills root if missing (initial bootstrap); if it is a dangling symlink, realpath throws ENOENT
    // and mkdir fails with EEXIST, which propagates honestly without silently bypassing.
    let rootReal: string
    try {
      rootReal = await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      await mkdir(skillsRoot, { recursive: true })
      rootReal = await realpath(skillsRoot)
    }
    const dir = join(rootReal, asset.id)
    // Verify before mkdir that skills/<id>, references, and nested subdirectories contain no symlinks (prevents writing
    // outside skills root); a missing segment implies nothing exists underneath it yet.
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
    // Reconcile to the declared asset (see method JSDoc): prune retired references, sweep retired same-owner dirs.
    await pruneUndeclaredReferenceFiles(join(dir, 'references'), new Set(references.map((r) => r.rel)))
    const owner = parseSkillFrontmatter(asset.skillMd).managedByPlugin
    if (owner !== undefined) {
      const declared = this.managedIdsByOwner.get(owner) ?? new Set<string>()
      declared.add(asset.id)
      this.managedIdsByOwner.set(owner, declared)
      await removeRetiredManagedSkillDirs(rootReal, owner, declared)
    }
    this.managedSkillIds.add(asset.id)
  }

  /** Read-only guard for managed skills (403 managed_skill_readonly): source version at plugin startup is the sole
   * authority. Tracked in memory—rebuilt by ensureSkill on each startup without DB persistence
   * (user-created skills do not go through ensureSkill and are unaffected). */
  private assertSkillMutable(skillId: string): void {
    if (this.managedSkillIds.has(skillId)) {
      throw new HelmxError(
        'managed_skill_readonly',
        `skill '${skillId}' is a managed built-in plugin system asset and cannot be written or deleted via normal APIs (synced from source at plugin startup)`,
        403,
        { skillId },
      )
    }
  }

  /** Resolve skill asset directory coordinates (for host port, e.g. plugin bootstrap file completion): always points to
   * dataDir/skills/<id>, never resolving to an external source, preventing plugin startup side effects from modifying shared roots.
   * This is not a path permission boundary for generic commands; does not mkdir, leaving directory creation to callers. */
  async directory(id: string): Promise<string> {
    try {
      assertSkillId(id)
    } catch (err) {
      throw new HelmxError(
        'validation_error',
        `Invalid skill id: ${err instanceof Error ? err.message : String(err)}`,
        400,
        { skillId: id },
      )
    }
    return join(this.dataDir, 'skills', id)
  }

  /** Resolve the real path of the skills root (throws if missing; never lenient). */
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

  /** Summarize within a single root: returns undefined if the skill directory is missing (entry skipped in catalog)
   * or SKILL.md is missing (FileNotFoundError); malformed frontmatter is rethrown (callers decide strict throw for dataDir
   * vs skip policy for external roots). External roots forcibly strip managedByPlugin—shared roots may only host normal
   * shared skills and never let third-party files masquerade as host-managed plugin skills. */
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
 * Verify layer-by-layer that every existing segment from ancestor down to dir is a real directory (not a symlink);
 * a missing segment means nothing can exist under it yet, so stop and treat it as pending creation.
 * Prevents bootstrapping into targets outside the skills root when skills/<id> or references (including nested subdirs) is a symlink.
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
      throw new Error(`refusing to write through symlink directory: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`path segment is not a directory; refusing bootstrap: ${current}`)
    }
  }
}

/** Managed overwrite write: writes atomically if missing; if present, must be a regular file (symlinks/directories
 * are rejected). Skips writing when contents match the declaration (avoids atomic rename jitter in AssetWatcher),
 * otherwise atomically overwrites with the source version; rethrows any other IO errors. */
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
    throw new Error(`target already exists and is not a regular file; refusing write: ${path}`)
  }
  const current = await readFile(path, 'utf8').catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (current === content) return
  await atomicWriteFile(path, content)
}

/** Prune reference files under a managed skill's (already symlink-verified) references tree that the asset no longer
 * declares: retired references would otherwise linger forever and keep serving stale content through load_skill.
 * Dirents carry lstat semantics, so symlinks (file or directory) are unlinked directly and never followed; nested
 * directories left empty are pruned bottom-up, while the references root itself is kept (ensureSkill owns its
 * creation). Deletion stays inside the verified tree by construction (readdir names cannot be absolute or `..`). */
async function pruneUndeclaredReferenceFiles(referencesDir: string, declared: ReadonlySet<string>): Promise<void> {
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (entries === undefined) return
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target, rel)
        await rmdir(target).catch((err: unknown) => {
          const code = (err as { code?: string }).code
          if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err
        })
        continue
      }
      if (!declared.has(rel)) await rm(target, { force: true })
    }
  }
  // Paths are skill-dir-relative ('references/<name>'), matching the asset's declared reference keys.
  await walk(referencesDir, 'references')
}

/** Remove skill dirs that still claim `managedByPlugin: owner` in their SKILL.md frontmatter but are no longer in the
 * owner's declared set for this session (rename/retire residue). Symlinked entries and dirs without attributable
 * frontmatter (missing SKILL.md, other owners, unparseable frontmatter) are skipped—only unambiguous same-owner
 * residue is deleted. fs.rm with recursive+force unlinks symlinks without following, keeping deletion lstat-safe. */
async function removeRetiredManagedSkillDirs(
  skillsRoot: string,
  owner: string,
  declared: ReadonlySet<string>,
): Promise<void> {
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (entries === undefined) return
  for (const entry of entries) {
    // Dirent.isDirectory() is lstat-based: symlinked dirs (and files) fall through here and are never touched.
    if (!entry.isDirectory() || declared.has(entry.name)) continue
    const skillMd = await readFile(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8').catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (skillMd === undefined) continue
    let claimed: string | undefined
    try {
      claimed = parseSkillFrontmatter(skillMd).managedByPlugin
    } catch {
      continue // unattributable frontmatter is not ours to delete
    }
    if (claimed !== owner) continue
    await rm(join(skillsRoot, entry.name), { recursive: true, force: true })
  }
}

