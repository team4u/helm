/**
 * Profile domain:profiles list/get/create/update/delete.
 *
 * PUT /api/profiles/:id is whole replace contract (profiles.save all amount override profile.json):
 * - update semantics flag path must first GET complete Profile merge after PUT- - only change --name also do not lose
 *   nodeId/cwd/model etc. bind set field (otherwise after continue conversation mistakenly run local);
 * - GET response carries back system all text do not back pass (only explicit --system[-file] only then write);
 *   MEMORY.md long phase memory by builtin:memory plugin manage (helm memory get/set/configure).
 * - --input separate use = explicit all amount replace (do not GET); and semantics flag combine when as merge layer, field do not lose.
 * - create without since has config can merge, semantics flag / --input directly construct new object.
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

/** semantics flag -> Profile field (--system[-file]/--skills/--all-skills/--starters in should use phase separate handle). */
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

const semanticFlags: FlagSpec[] = [
  { name: 'input', type: 'json', help: 'Profile JSON(update separate use=all amount replace; and semantics flag combine then as merge layer)' },
  ...PROFILE_FIELD_FLAGS.map(({ flag }) => ({ name: flag, type: 'string' }) as FlagSpec),
  { name: 'system', type: 'string', help: 'SYSTEM.md all text' },
  { name: 'system-file', type: 'string', help: 'SYSTEM.md from local file read' },
  { name: 'skills', type: 'json', help: 'skill blank name single JSON string array (such as \'["git-commit"]\';[] disable all skill; and --all-skills mutual exclusion)' },
  { name: 'all-skills', type: 'boolean', help: 'delete skills key restore all available skill (and --skills mutual exclusion)' },
  { name: 'starters', type: 'json', help: 'whitespace conversation quote lead term JSON array (such as \'[{"label":"write weekly report","prompt":"..."}]\', at most 6 items;[] empty restore by default)' },
]

const PARSE_FLAGS_SPEC = semanticFlags.map((f) => ({ ...f }))

/** is otherwise to out any one semantics flag(excludes --input). */
function hasSemanticFlags(flags: Map<string, unknown>): boolean {
  return (
    PROFILE_FIELD_FLAGS.some(({ flag }) => flags.has(flag)) ||
    DOC_FLAGS.some((flag) => flags.has(flag)) ||
    SKILLS_FLAGS.some((flag) => flags.has(flag)) ||
    STARTERS_FLAGS.some((flag) => flags.has(flag))
  )
}

/** --skills/--all-skills local validate: mutual exclusion + string array (in any HTTP request before reject). */
function validateSkillsFlags(flags: Map<string, unknown>): void {
  const hasSkills = flags.has('skills')
  const hasAll = flags.get('all-skills') === true
  if (hasSkills && hasAll) {
    throw new CliError('--skills and --all-skills mutual exclusion (two choose one)', 'conflicting_flags')
  }
  if (hasSkills) {
    const raw = flags.get('skills')
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
      throw new CliError('--skills must be JSON string array (such as --skills \'["git-commit"]\', empty array [] disable all skill)', 'invalid_flag_value')
    }
  }
}

/** --skills/--all-skills should use to body(invoke before already validate; write blank name single or delete key restore all). */
function applySkillsFlags(flags: Map<string, unknown>, body: Record<string, unknown>): void {
  if (flags.has('skills')) {
    body['skills'] = flags.get('skills')
  } else if (flags.get('all-skills') === true) {
    // restore undefined = all when before available skill: whole replace contract under explicit delete key
    delete body['skills']
  }
}

/** --starters local validate:{ label, prompt } object array (in any HTTP request before reject).
 * and Hub boundary same rule:label trim non-empty ≤24 code point,prompt non- pure whitespace ≤4000 code point, at most 6 items. */
function validateStartersFlag(flags: Map<string, unknown>): void {
  if (!flags.has('starters')) return
  const raw = flags.get('starters')
  if (!Array.isArray(raw)) {
    throw new CliError("--starters must be JSON array (such as --starters '[{\"label\":\"write weekly report\",\"prompt\":\"...\"}]', empty array [] empty)", 'invalid_flag_value')
  }
  const codePoints = (text: string): number => {
    let count = 0
    for (const _ of text) count += 1
    return count
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new CliError(`--starters[${i}] must be { label, prompt } object`, 'invalid_flag_value')
    }
    for (const key of Object.keys(item)) {
      if (key !== 'label' && key !== 'prompt') {
        throw new CliError(`--starters[${i}] only accept label and prompt field (unknown field '${key}')`, 'invalid_flag_value')
      }
    }
    const { label, prompt } = item as Record<string, unknown>
    if (typeof label !== 'string') throw new CliError(`--starters[${i}].label must be a string`, 'invalid_flag_value')
    if (typeof prompt !== 'string') throw new CliError(`--starters[${i}].prompt must be a string`, 'invalid_flag_value')
    if (label.trim() === '') throw new CliError(`--starters[${i}].label cannot be empty after trimming`, 'invalid_flag_value')
    if (codePoints(label.trim()) > 24) throw new CliError(`--starters[${i}].label at most 24  Unicode code point`, 'invalid_flag_value')
    if (prompt.trim() === '') throw new CliError(`--starters[${i}].prompt cannot be pure whitespace`, 'invalid_flag_value')
    if (codePoints(prompt) > 4000) throw new CliError(`--starters[${i}].prompt at most 4000  Unicode code point`, 'invalid_flag_value')
  }
  if (raw.length > 6) throw new CliError('--starters at most 6 items', 'invalid_flag_value')
}

/** --starters should use to body: explicit to flag only then write key ([] same write=empty restore by default). */
function applyStartersFlag(flags: Map<string, unknown>, body: Record<string, unknown>): void {
  if (flags.has('starters')) body['starters'] = flags.get('starters')
}

/** semantics flag should use to body(explicit to out only then write key;-file and inline same to when inline takes precedence). */
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
}

/**
 * update merge base bottom:GET complete Profile and strip system all text
 * (PUT back pass will leads to whole file heavy write; only explicit --system[-file] only then write).
 * Profile missing when GET error message seal such as on throw (whole replace contract under cannot blind change).
 */
async function fetchProfileBase(hub: HubClient, id: string): Promise<Record<string, unknown>> {
  const current = await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`)
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new CliError(`Hub response non- Profile shape (GET /api/profiles/${id})`, 'invalid_response')
  }
  const base: Record<string, unknown> = { ...current }
  delete base['system']
  return base
}

export function profilesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['profiles', 'list'],
    description: 'column out Profile(GET /api/profiles)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<Profile[]>('/api/profiles'))
    },
  })

  cmds.push({
    path: ['profiles', 'get'],
    description: 'view Profile(GET /api/profiles/:id)',
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
    description: 'create Profile(POST /api/profiles; semantics flag or --input)',
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
          'not provide any field:--input <json> or semantics flag(--name/--model/--node/--cwd/--system[-file]/--skills/--all-skills/--starters) (profiles create)',
          'missing_update_fields',
        )
      }
      const body: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      await applySemanticFlags(parsed.flags, body)
      if (id !== undefined) {
        if (typeof body['id'] === 'string' && body['id'] !== id) {
          throw new CliError(`location parameter id "${id}" and --input in id "${String(body['id'])}" inconsistent`, 'invalid_flag_value')
        }
        body['id'] = id
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<Profile>('/api/profiles', body))
    },
  })

  cmds.push({
    path: ['profiles', 'update'],
    description: 'update Profile(PUT /api/profiles/:id whole replace; semantics flag automatically GET merge guard against lose field,--input separate use is all amount replace)',
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
          'not provide any field:--input <json> or semantics flag(--name/--model/--node/--cwd/--system[-file]/--skills/--all-skills/--starters) (profiles update)',
          'missing_update_fields',
        )
      }
      const hub = await ctx.hub()
      let body: Record<string, unknown>
      if (semantic) {
        // whole replace contract: first GET complete merge - - not trigger and field (nodeId/cwd/model/tags/runtime...) all keep
        body = await fetchProfileBase(hub, id)
        if (hasInput) Object.assign(body, coerceMetaFlag(parsed.flags.get('input'), 'input'))
        await applySemanticFlags(parsed.flags, body)
      } else {
        // --input separate use: explicit all amount replace (caller self verify complete)
        body = coerceMetaFlag(parsed.flags.get('input'), 'input')
      }
      body['id'] = id
      printResult(ctx, await hub.put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, body))
    },
  })

  cmds.push({
    path: ['profiles', 'delete'],
    description: 'delete Profile(DELETE /api/profiles/:id)',
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
