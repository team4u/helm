/**
 * once question answer domain:helm ask = internal create conversation + commit input + wait for answer.
 * only re- use existing end point (POST /api/conversations + POST .../input?wait=1), no new HTTP side.
 * stdout by default only output answer text (script pipeline friend well); error keep conversation and in error message seal to out can inspect conversation ID.
 */
import type { ConversationInputResult, ConversationSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, coerceTags, printPlainText, printResult } from './shared.js'

const askFlags: FlagSpec[] = [
  { name: 'profile', type: 'string', help: 'use Profile ID' },
  { name: 'title', type: 'string', help: 'conversation title (default by server side naming; convenient at append trace)' },
  { name: 'cwd', type: 'string', help: 'conversation work directory (absolute path)' },
  { name: 'model', type: 'string', help: 'explicit override model provider/model' },
  { name: 'tags', type: 'string', help: 'conversation tag (JSON array or comma isolate)' },
  { name: 'timeout', type: 'number', help: 'wait for answer timeout milli second count (default unbounded wait for)' },
  { name: 'delete-on-success', type: 'boolean', help: 'succeeded acquire answer after delete conversation; any failed keep diagnose conversation' },
]

/** combine prompt: location parameter and pipeline stdin with empty row concatenate, whitespace fragment does not participate. */
function combinePrompt(positional: string | undefined, stdinText: string | undefined): string {
  const parts: string[] = []
  if (positional !== undefined && positional.trim() !== '') parts.push(positional)
  if (stdinText !== undefined && stdinText.trim() !== '') parts.push(stdinText)
  return parts.join('\n\n')
}

/**
 * failed after append conversation remove to hint and carry conversationId(conversation already create i.e. keep, never static default clean up).
 * keep original code/exitCode,details merge conversationId supply script consume.
 */
function rethrowWithConversation(err: unknown, conversationId: number, lead: string): never {
  const hint = `${lead}(conversation #${conversationId} already keep:helm conversations get ${conversationId} troubleshoot / helm conversations delete ${conversationId} clean up)`
  if (err instanceof CliError) {
    const base = err.details !== null && typeof err.details === 'object' && !Array.isArray(err.details)
      ? { ...(err.details as Record<string, unknown>) }
      : {}
    base.conversationId = conversationId
    throw new CliError(`${err.message}${hint}`, err.code, err.exitCode, base)
  }
  throw new CliError(`${err instanceof Error ? err.message : String(err)}${hint}`, 'internal_error', 1, {
    conversationId,
  })
}

/**
 * boundary strong validate wait response:text is protocol right threat answer (kernel first stash.redact again return),
 * CLI no longer from entry.model heavy piece together. any distortion shape structure explicit invalid_response(details carries conversation ID).
 */
function validateWaitResult(raw: unknown, conversationId: number): ConversationInputResult {
  const invalid = (reason: string): CliError =>
    new CliError(`Hub wait for answer response illegal:${reason}`, 'invalid_response', 1, { conversationId })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`must be JSON object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.conversationId !== 'number' || r.conversationId !== conversationId) {
    throw invalid(`conversationId should be ${conversationId}, got ${JSON.stringify(r.conversationId)}`)
  }
  if (typeof r.submissionId !== 'string' || r.submissionId === '') throw invalid('submissionId must be a non-empty string')
  if (typeof r.text !== 'string') throw invalid(`text must be a string (allows empty string), got ${typeof r.text}`)
  const entry = r.entry
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('entry must be JSON object')
  const e = entry as Record<string, unknown>
  if (typeof e.id !== 'string' || e.id === '') throw invalid('entry.id must be a non-empty string')
  if (typeof e.kind !== 'string' || e.kind === '') throw invalid('entry.kind must be a non-empty string')
  return raw as ConversationInputResult
}

export function askCommands(): CommandSpec[] {
  return [
    {
      path: ['ask'],
      description: 'once question answer: internal create conversation, commit input and wait for answer (stdin pipeline content and prompt)',
      flags: askFlags,
      positional: '[text]',
      async run(ctx: CommandContext) {
        const parsed = parseFlags(askFlags, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 1)
        const timeoutMs = flagValue<number>(parsed.flags, 'timeout')
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
          throw new CliError(`--timeout must be a positive integer milli second, got "${timeoutMs}"`, 'invalid_flag_value')
        }
        // prompt = location parameter + pipeline stdin(non- TTY only then read; two at least its one, whitespace do not compute)
        const stdinText = ctx.io.stdin.isTTY ? undefined : await ctx.io.stdin.readAll()
        const prompt = combinePrompt(parsed.positionals[0], stdinText)
        if (prompt === '') {
          throw new CliError('missing mention question content: provide <text> location parameter, or via stdin pipeline input', 'empty_input')
        }

        // 1) create conversation (on failure still without conversation, original on throw)
        const createBody: Record<string, unknown> = {}
        for (const [flag, key] of [
          ['title', 'title'],
          ['profile', 'profileId'],
          ['cwd', 'cwd'],
          ['model', 'model'],
        ] as const) {
          const v = flagValue<string>(parsed.flags, flag)
          if (v !== undefined) createBody[key] = v
        }
        const tags = flagValue<string>(parsed.flags, 'tags')
        if (tags !== undefined) createBody.tags = coerceTags(tags)
        const hub = await ctx.hub()
        const created = await hub.post<ConversationSummary>('/api/conversations', createBody)
        if (
          created === null || typeof created !== 'object' ||
          typeof created.id !== 'number' || !Number.isSafeInteger(created.id) || created.id <= 0
        ) {
          throw new CliError('Hub create conversation response missing correct security integer id', 'invalid_response')
        }
        const conversationId = created.id

        // 2) commit and wait for answer (whenBusy:reject- - all new conversation must not has in-flight turn, busy i.e. explicit failed)
        let result: ConversationInputResult
        try {
          const raw = await hub.request<unknown>(
            'POST',
            `/api/conversations/${conversationId}/input?wait=1`,
            { body: { text: prompt, whenBusy: 'reject' }, timeoutMs: timeoutMs ?? 0 },
          )
          result = validateWaitResult(raw, conversationId)
        } catch (err) {
          rethrowWithConversation(err, conversationId, '')
        }

        // 3) optional: only in wait response validate via after delete conversation; failed to delete keep conversation and explicit errors
        let deleted = false
        if (parsed.flags.get('delete-on-success') === true) {
          try {
            await hub.delete(`/api/conversations/${conversationId}`)
            deleted = true
          } catch (err) {
            rethrowWithConversation(err, conversationId, 'answer already acquire, but conversation failed to delete')
          }
        }

        const answer = result.text
        if (ctx.json) {
          printResult(ctx, {
            conversationId,
            submissionId: result.submissionId,
            entryId: result.entry.id,
            answer,
            deleted,
          })
          return
        }
        // person class pattern:stdout only output answer text (empty answer output empty, do not fabricate content)
        if (answer !== '') printPlainText(ctx, answer)
      },
    },
  ]
}
