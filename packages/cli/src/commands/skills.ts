/** Skills commands: skills list / read.
 *
 * Scope model (physical coordinates; the action call never carries conversationId):
 * - No flags: Hub global catalog semantics (GET /api/skills), unchanged.
 * - --current: resolve the conversation id from HELMX_CONVERSATION_ID, read that
 *   conversation's (nodeId, cwd) via GET /api/conversations/:id, then call the
 *   builtin:profile action with explicit coordinates only. The CLI never guesses a
 *   cwd locally, and no conversation context is attached to the action call —
 *   keeping the call shape identical to the explicit --node/--cwd surface.
 * - --node <id> + --cwd <dir>: explicit physical coordinates written into the action
 *   input (trusted CLI surface, same trust level as `helmx api`); the two flags must
 *   appear together and are mutually exclusive with --current.
 * Scoped calls go through the plugin action endpoints (POST /api/actions/...) so the
 * CLI adds no server contract beyond the standard action mapping; responses are
 * boundary-validated here (external input) and failures surface verbatim.
 */
import type { SkillSummary } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { HubClient } from '../hub-client.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printPlainText, printResult, requirePositional, resolveConversationTarget } from './shared.js'
import { printText } from '../output.js'

/** Scoped skill access runs through builtin:profile plugin actions (no static server contract added by the CLI). */
const SKILL_CATALOG_ACTION_PATH = `/api/actions/${encodeURIComponent('builtin:profile')}/skill_catalog`
const SKILL_READ_ACTION_PATH = `/api/actions/${encodeURIComponent('builtin:profile')}/skill_read`

/** Skill scope flags shared by `skills list` and `skills read`. */
const SKILL_SCOPE_FLAGS = [
  { name: 'current', type: 'boolean' as const, help: 'scope to the current conversation workspace (reads HELMX_CONVERSATION_ID and resolves its nodeId/cwd first)' },
  { name: 'node', type: 'string' as const, help: 'explicit workspace node id (requires --cwd; mutually exclusive with --current)' },
  { name: 'cwd', type: 'string' as const, help: 'explicit workspace directory on that node (requires --node; mutually exclusive with --current)' },
]

/** Resolved skill scope: explicit physical coordinates (conversation-derived or passed verbatim). */
interface SkillScope {
  nodeId: string
  cwd: string
}

/**
 * Resolve the skill scope from --current / --node / --cwd:
 * undefined keeps the Hub global semantics; --node and --cwd must appear as a pair;
 * --current never combines with explicit coordinates (one scope per call, never merged).
 * --current reads the conversation's real (nodeId, cwd) from the Hub — the CLI must
 * not invent a local cwd, and a conversation without a bound workspace fails explicitly.
 */
async function resolveSkillScope(flags: Map<string, unknown>, env: NodeJS.ProcessEnv, hub: HubClient): Promise<SkillScope | undefined> {
  const current = flags.get('current') === true
  const nodeId = flagValue<string>(flags, 'node')
  const cwd = flagValue<string>(flags, 'cwd')
  if (current && (nodeId !== undefined || cwd !== undefined)) {
    throw new CliError('--current cannot be combined with --node/--cwd: pick one skill scope per call', 'conflicting_flags')
  }
  if (nodeId !== undefined && nodeId.trim() === '') {
    throw new CliError('--node must be a non-empty node id', 'invalid_flag_value')
  }
  if (cwd !== undefined && cwd.trim() === '') {
    throw new CliError('--cwd must be a non-empty workspace directory', 'invalid_flag_value')
  }
  if ((nodeId !== undefined) !== (cwd !== undefined)) {
    throw new CliError('--node and --cwd must be provided together to select an explicit workspace skill scope', 'missing_required_flag')
  }
  if (current) {
    const conversationId = resolveConversationTarget(flags, undefined, env)
    // limit=1 keeps the detail payload light: only the summary's nodeId/cwd are read here
    const detail = await hub.get<Record<string, unknown>>(`/api/conversations/${conversationId}?limit=1`)
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
      throw new CliError(`conversation ${conversationId} returned an invalid response (expected a detail object)`, 'invalid_response')
    }
    const convCwd = detail['cwd']
    if (typeof convCwd !== 'string' || convCwd.trim() === '') {
      throw new CliError(
        `conversation ${conversationId} has no bound workspace directory (cwd), so its workspace skill scope cannot be selected`,
        'conversation_without_cwd',
      )
    }
    const convNodeId = detail['nodeId']
    if (convNodeId !== undefined && typeof convNodeId !== 'string') {
      throw new CliError(`conversation ${conversationId} returned an invalid nodeId (expected a string)`, 'invalid_response')
    }
    return { nodeId: convNodeId !== undefined && convNodeId !== '' ? convNodeId : 'local', cwd: convCwd }
  }
  if (nodeId !== undefined && cwd !== undefined) return { nodeId, cwd }
  return undefined
}

/** Boundary-validated skill_catalog action output (external HTTP input: shape-checked before use). */
interface SkillCatalogResult {
  nodeId: string
  cwd: string
  skills: SkillSummary[]
  shadowedNodeSkillIds: string[]
  nodeUnavailable?: string
}

/** Validate a skill_catalog response at the CLI boundary; illegal shapes fail explicitly. */
function parseSkillCatalogResult(raw: unknown): SkillCatalogResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('skill_catalog action returned an invalid response (expected an object)', 'invalid_response')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj['nodeId'] !== 'string' || typeof obj['cwd'] !== 'string') {
    throw new CliError('skill_catalog action returned an invalid response (expected string nodeId/cwd)', 'invalid_response')
  }
  if (!Array.isArray(obj['skills']) || !obj['skills'].every(isSkillSummaryShape)) {
    throw new CliError('skill_catalog action returned an invalid response (expected a skills array of {id,name,...})', 'invalid_response')
  }
  if (!Array.isArray(obj['shadowedNodeSkillIds']) || !obj['shadowedNodeSkillIds'].every((x) => typeof x === 'string')) {
    throw new CliError('skill_catalog action returned an invalid response (expected a shadowedNodeSkillIds string array)', 'invalid_response')
  }
  if (obj['nodeUnavailable'] !== undefined && typeof obj['nodeUnavailable'] !== 'string') {
    throw new CliError('skill_catalog action returned an invalid response (nodeUnavailable must be a string when present)', 'invalid_response')
  }
  return {
    nodeId: obj['nodeId'],
    cwd: obj['cwd'],
    skills: obj['skills'] as SkillSummary[],
    shadowedNodeSkillIds: obj['shadowedNodeSkillIds'] as string[],
    ...(obj['nodeUnavailable'] !== undefined ? { nodeUnavailable: obj['nodeUnavailable'] as string } : {}),
  }
}

/** Minimal structural check for a SkillSummary entry (id/name strings, references array). */
function isSkillSummaryShape(value: unknown): value is SkillSummary {
  if (value === null || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return typeof s['id'] === 'string' && typeof s['name'] === 'string' && Array.isArray(s['references'])
}

export function skillsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['skills', 'list'],
    description: 'List available skills: Hub global catalog (GET /api/skills); --current or --node+--cwd scope to a conversation workspace via the builtin:profile skill_catalog action',
    flags: SKILL_SCOPE_FLAGS,
    async run(ctx: CommandContext) {
      const parsed = parseFlags(SKILL_SCOPE_FLAGS, ctx.args)
      const hub = await ctx.hub()
      const scope = await resolveSkillScope(parsed.flags, ctx.env, hub)
      if (scope === undefined) {
        printResult(ctx, await hub.get<SkillSummary[]>('/api/skills'))
        return
      }
      const result = parseSkillCatalogResult(await hub.post(SKILL_CATALOG_ACTION_PATH, { input: { nodeId: scope.nodeId, cwd: scope.cwd } }))
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      printText(ctx.io, `scope: node=${result.nodeId} cwd=${result.cwd}`)
      printResult(ctx, result.skills)
      if (result.shadowedNodeSkillIds.length > 0) {
        printText(ctx.io, `node skills shadowed by same-name Hub/agents versions: ${result.shadowedNodeSkillIds.join(', ')}`)
      }
      if (result.nodeUnavailable !== undefined) {
        printText(ctx.io, `node skill library unavailable: ${result.nodeUnavailable}`)
      }
    },
  })

  cmds.push({
    path: ['skills', 'read'],
    description: 'Read a skill document (GET /api/skills/:id[?path=]; defaults to SKILL.md); --current or --node+--cwd read from a conversation workspace via the builtin:profile skill_read action',
    flags: [
      { name: 'path', type: 'string', help: "relative path to a file within the skill directory, e.g. 'references/xxx.md'" },
      ...SKILL_SCOPE_FLAGS,
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'path', type: 'string' },
          ...SKILL_SCOPE_FLAGS,
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      const p = flagValue<string>(parsed.flags, 'path')
      const hub = await ctx.hub()
      const scope = await resolveSkillScope(parsed.flags, ctx.env, hub)
      if (scope === undefined) {
        const query = p ? `?path=${encodeURIComponent(p)}` : ''
        const res = await hub.get<{ text: string }>(`/api/skills/${encodeURIComponent(id)}${query}`)
        if (typeof res?.text !== 'string') {
          throw new CliError('Hub returned an invalid skills read response (expected { text })', 'invalid_response')
        }
        if (ctx.json) printResult(ctx, res)
        else printPlainText(ctx, res.text)
        return
      }
      const input: Record<string, unknown> = { nodeId: scope.nodeId, cwd: scope.cwd, skillId: id }
      if (p !== undefined) input['path'] = p
      const res = await hub.post<{ text: string }>(SKILL_READ_ACTION_PATH, { input })
      if (typeof res?.text !== 'string') {
        throw new CliError('skill_read action returned an invalid response (expected { text })', 'invalid_response')
      }
      if (ctx.json) printResult(ctx, res)
      else printPlainText(ctx, res.text)
    },
  })

  return cmds
}
