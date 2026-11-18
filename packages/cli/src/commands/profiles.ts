/**
 * Profile commands: profiles list/get/create/update/delete.
 *
 * PUT /api/profiles/:id uses full-replacement semantics (profiles.save overwrites profile.json):
 * - updates using semantic flags must GET the full Profile first, merge, and PUT so untouched
 *   bindings like nodeId/cwd/model are never dropped (otherwise later conversations fall back to local);
 * - the full system text returned by GET is stripped and not sent back unless --system[-file] is explicitly given;
 *   MEMORY.md long-term memory is managed by builtin:memory (helm memory get/set/configure);
 * - --input alone performs an explicit full replacement (without GET); combined with semantic flags it serves as a merge layer;
 * - create has no prior config to merge and constructs a new object from semantic flags / --input directly.
 */
import type { Profile } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import type { HubClient } from '../hub-client.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseNoFlags,
  printResult,
  readTextFileFlag,
  requirePositional,
} from './shared.js'

/** Semantic flags -> Profile fields (--system[-file]/--skills/--all-skills/--starters are handled separately when building payload). */
const PROFILE_FIELD_FLAGS: ReadonlyArray<{ flag: string; key: string }> = [
  { flag: 'name', key: 'name' },
  { flag: 'model', key: 'model' },
  { flag: 'thinking', key: 'thinkingLevel' },
  { flag: 'node', key: 'nodeId' },
  { flag: 'cwd', key: 'cwd' },
]

const DOC_FLAGS = ['system', 'system-file'] as const
const SKILLS_FLAGS = ['skills', 'all-skills'] as const
const STARTERS_FLAGS = ['starters'] as const
const BOOLEAN_FLAGS = ['restrict-to-cwd'] as const

const semanticFlags: FlagSpec[] = [
  { name: 'input', type: 'json', help: 'Profile JSON (when used alone on update = full replacement; with semantic flags = merge layer)' },
  ...PROFILE_FIELD_FLAGS.map(({ flag }) => ({ name: flag, type: 'string' }) as FlagSpec),
  { name: 'system', type: 'string', help: 'full SYSTEM.md text' },
  { name: 'system-file', type: 'string', help: 'read SYSTEM.md from local file' },
  { name: 'skills', type: 'json', help: 'skill allowlist JSON string array (e.g. \'["git-commit"]\'; [] disables all skills; mutually exclusive with --all-skills)' },
  { name: 'all-skills', type: 'boolean', help: 'remove skills key to restore all available skills (mutually exclusive with --skills)' },
  { name: 'starters', type: 'json', help: 'blank conversation starter prompts JSON array (e.g. \'[{"label":"Weekly report","prompt":"..."}]\', max 6 items; [] clears to defaults)' },
  { name: 'restrict-to-cwd', type: 'boolean', help: 'restrict file tools (read/write/edit/register_artifact) and subagent cwd to the conversation working directory (guardrail, not an OS sandbox; --restrict-to-cwd=false disables)' },
]

const PARSE_FLAGS_SPEC = semanticFlags.map((f) => ({ ...f }))

/** Whether any semantic flag (excluding --input) was provided. */
function hasSemanticFlags(flags: Map<string, unknown>): boolean {
  return (
    PROFILE_FIELD_FLAGS.some(({ flag }) => flags.has(flag)) ||
    DOC_FLAGS.some((flag) => flags.has(flag)) ||
    SKILLS_FLAGS.some((flag) => flags.has(flag)) ||
    STARTERS_FLAGS.some((flag) => flags.has(flag)) ||
    BOOLEAN_FLAGS.some((flag) => flags.has(flag))
  )
}

/** Local validation for --skills/--all-skills: mutually exclusive + string array (reject before making HTTP calls). */
function validateSkillsFlags(flags: Map<string, unknown>): void {
  const hasSkills = flags.has('skills')
  const hasAll = flags.get('all-skills') === true
  if (hasSkills && hasAll) {
    throw new CliError('--skills and --all-skills are mutually exclusive', 'conflicting_flags')
  }
  if (hasSkills) {
    const raw = flags.get('skills')
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
      throw new CliError('--skills must be a JSON string array (e.g. --skills \'["git-commit"]\', empty array [] disables all skills)', 'invalid_flag_value')
    }
  }
}

/** Apply --skills/--all-skills to body (already validated; writes allowlist or deletes key to restore all). */
function applySkillsFlags(flags: Map<string, unknown>, body: Record<string, unknown>): void {
  if (flags.has('skills')) {
    body['skills'] = flags.get('skills')
  } else if (flags.get('all-skills') === true) {
    // Restore undefined = all currently available skills: explicitly delete key under full-replacement contract
    delete body['skills']
  }
}

/** Local validation for --starters: array of { label, prompt } objects (reject before making HTTP calls).
 * Matches Hub boundary rules: trimmed label non-empty <=24 code points, non-whitespace prompt <=4000 code points, max 6 items. */
function validateStartersFlag(flags: Map<string, unknown>): void {
  if (!flags.has('starters')) return
  const raw = flags.get('starters')
  if (!Array.isArray(raw)) {
    throw new CliError("--starters must be a JSON array (e.g. --starters '[{\"label\":\"Weekly report\",\"prompt\":\"...\"}]', empty array [] clears)", 'invalid_flag_value')
  }
  const codePoints = (text: string): number => {
    let count = 0
    for (const _ of text) count += 1
    return count
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new CliError(`--starters[${i}] must be a { label, prompt } object`, 'invalid_flag_value')
    }
    for (const key of Object.keys(item)) {
      if (key !== 'label' && key !== 'prompt') {
        throw new CliError(`--starters[${i}] only accepts label and prompt fields (unknown field '${key}')`, 'invalid_flag_value')
      }
    }
    const { label, prompt } = item as Record<string, unknown>
    if (typeof label !== 'string') throw new CliError(`--starters[${i}].label must be a string`, 'invalid_flag_value')
    if (typeof prompt !== 'string') throw new CliError(`--starters[${i}].prompt must be a string`, 'invalid_flag_value')
    if (label.trim() === '') throw new CliError(`--starters[${i}].label cannot be empty after trimming`, 'invalid_flag_value')
    if (codePoints(label.trim()) > 24) throw new CliError(`--starters[${i}].label can have at most 24 Unicode code points`, 'invalid_flag_value')
    if (prompt.trim() === '') throw new CliError(`--starters[${i}].prompt cannot be whitespace-only`, 'invalid_flag_value')
    if (codePoints(prompt) > 4000) throw new CliError(`--starters[${i}].prompt can have at most 4000 Unicode code points`, 'invalid_flag_value')
  }
  if (raw.length > 6) throw new CliError('--starters supports at most 6 items', 'invalid_flag_value')
}

/** Apply --starters to body: write only when explicitly passed ([] writes empty array to clear and restore defaults). */
function applyStartersFlag(flags: Map<string, unknown>, body: Record<string, unknown>): void {
  if (flags.has('starters')) body['starters'] = flags.get('starters')
}

/** Apply semantic flags to body (write only when given; inline overrides -file when both are passed). */
async function applySemanticFlags(flags: Map<string, unknown>, body: Record<string, unknown>): Promise<void> {
  for (const { flag, key } of PROFILE_FIELD_FLAGS) {
    const v = flagValue<string>(flags, flag)
    if (v !== undefined) body[key] = v
  }
  const systemInline = flagValue<string>(flags, 'system')
  if (systemInline !== undefined) body.system = systemInline
  else {
    const systemFile = flagValue<string>(flags, 'system-file')
    if (systemFile !== undefined) body.system = await readTextFileFlag(systemFile, 'system-file')
  }
  applySkillsFlags(flags, body)
  applyStartersFlag(flags, body)
  // Boolean semantic flags: write only when explicitly passed (full-replacement merge preserves the rest).
  const restrictToCwd = flags.get('restrict-to-cwd')
  if (restrictToCwd !== undefined) body['restrictToCwd'] = restrictToCwd
}

/**
 * Base object for update merges: GET full Profile and strip full system text
 * (sending system back on PUT rewrites SYSTEM.md; only write when --system[-file] is explicit).
 * Rethrows GET error envelope as-is if the Profile does not exist (cannot blind-edit under full replacement).
 */
async function fetchProfileBase(hub: HubClient, id: string): Promise<Record<string, unknown>> {
  const current = await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`)
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new CliError(`Hub response is not a Profile object (GET /api/profiles/${id})`, 'invalid_response')
  }
  const base: Record<string, unknown> = { ...current }
  delete base['system']
  return base
}

export function profilesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['profiles', 'list'],
    description: 'List Profiles (GET /api/profiles)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<Profile[]>('/api/profiles'))
    },
  })

  cmds.push({
    path: ['profiles', 'get'],
    description: 'Get a Profile (GET /api/profiles/:id)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`))
    },
  })

  cmds.push({
    path: ['profiles', 'create'],
    description: 'Create a Profile (POST /api/profiles; semantic flags or --input)',
    flags: semanticFlags,
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(PARSE_FLAGS_SPEC, ctx.args)
      const id = parsed.positionals[0]
      assertNoExtraPositionals(parsed.positionals, 1)
      validateSkillsFlags(parsed.flags)
      validateStartersFlag(parsed.flags)
      const hasInput = parsed.flags.has('input')
      if (!hasInput && !hasSemanticFlags(parsed.flags)) {
        throw new CliError(
          'no fields provided: pass --input <json> or semantic flags (--name/--model/--node/--cwd/--system[-file]/--skills/--all-skills/--starters/--restrict-to-cwd) (profiles create)',
          'missing_update_fields',
        )
      }
      const body: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      await applySemanticFlags(parsed.flags, body)
      if (id !== undefined) {
        if (typeof body['id'] === 'string' && body['id'] !== id) {
          throw new CliError(`positional id "${id}" does not match id "${String(body['id'])}" in --input`, 'invalid_flag_value')
        }
        body['id'] = id
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<Profile>('/api/profiles', body))
    },
  })

  cmds.push({
    path: ['profiles', 'update'],
    description: 'Update a Profile (PUT /api/profiles/:id full replacement; semantic flags auto-GET and merge to preserve untouched fields, --input alone replaces in full)',
    flags: semanticFlags,
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(PARSE_FLAGS_SPEC, ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      validateSkillsFlags(parsed.flags)
      validateStartersFlag(parsed.flags)
      const hasInput = parsed.flags.has('input')
      const semantic = hasSemanticFlags(parsed.flags)
      if (!hasInput && !semantic) {
        throw new CliError(
          'no fields provided: pass --input <json> or semantic flags (--name/--model/--node/--cwd/--system[-file]/--skills/--all-skills/--starters/--restrict-to-cwd) (profiles update)',
          'missing_update_fields',
        )
      }
      const hub = await ctx.hub()
      let body: Record<string, unknown>
      if (semantic) {
        // Full-replacement contract: GET and merge first so untouched fields (nodeId/cwd/model/tags/runtime...) are preserved
        body = await fetchProfileBase(hub, id)
        if (hasInput) Object.assign(body, coerceMetaFlag(parsed.flags.get('input'), 'input'))
        await applySemanticFlags(parsed.flags, body)
      } else {
        // --input alone: explicit full replacement (caller guarantees completeness)
        body = coerceMetaFlag(parsed.flags.get('input'), 'input')
      }
      body['id'] = id
      printResult(ctx, await hub.put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, body))
    },
  })

  cmds.push({
    path: ['profiles', 'delete'],
    description: 'Delete a Profile (DELETE /api/profiles/:id)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/profiles/${encodeURIComponent(id)}`))
    },
  })

  return cmds
}
