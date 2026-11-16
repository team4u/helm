/**
 * conversation domain:conversations list/get/create/update/delete/reset/compact/fork,
 * send,abort,events watch.create/update support --node <nodeId> bind set compute node.
 */
import type { ConversationSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  coerceTags,
  enumFlag,
  parseNoFlags,
  parsePositiveInt,
  printPlainText,
  printResult,
  requirePositional,
  resolveConversationTarget,
  validateEnum,
} from './shared.js'

const WHEN_BUSY = ['steer', 'followUp', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const

const convFlags: FlagSpec[] = [{ name: 'current', type: 'boolean', help: 'use env HELM_CONVERSATION_ID' }]

export function conversationsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  // ---- events watch(global SSE, and conversations domain sharing print auxiliary)----
  cmds.push({
    path: ['events', 'watch'],
    description: 'subscribe global SSE event stream (GET /api/events; first frame snapshot + incremental)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const controller = new AbortController()
      const onSignal = () => controller.abort()
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      const render = (event: string, payload: unknown): void => {
        if (ctx.json) {
          // NDJSON:snapshot frame and incremental frame all original output (each row a JSON)
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          const snap = payload as { seq?: number; conversations?: unknown[]; pendingAsks?: unknown[]; plugins?: unknown[] }
          ctx.io.out(
            `snapshot seq=${snap.seq ?? '?'} conversation=${snap.conversations?.length ?? 0} await answer=${snap.pendingAsks?.length ?? 0} plugin=${snap.plugins?.length ?? 0}\n`,
          )
          return
        }
        ctx.io.out(`${summarizeEvent(payload)}\n`)
      }
      try {
        await hub.streamEvents({
          signal: controller.signal,
          onFrame: ({ event, data }) => {
            let payload: unknown
            try {
              payload = JSON.parse(data)
            } catch {
              // distortion shape frame: diagnose to stderr after skip, without interruption stream (keepalive etc. noise legal)
              ctx.io.err(`helm: ignore non- JSON SSE frame (${data.slice(0, 120)})\n`)
              return
            }
            render(event, payload)
          },
        })
      } catch (err) {
        if (err instanceof CliError && err.code === 'aborted') return
        throw err
      } finally {
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
      }
    },
  })

  // ---- conversations list ----
  cmds.push({
    path: ['conversations', 'list'],
    description: 'column out conversation (GET /api/conversations; by default only top-level conversation,--all contains sub-conversation,--parent precise directly sub-conversation)',
    flags: [
      { name: 'profile', type: 'string', help: 'by profileId filter' },
      { name: 'status', type: 'string', help: 'by state filter (working|blocked|done|idle|error)' },
      { name: 'tag', type: 'string', help: 'by tag filter' },
      { name: 'all', type: 'boolean', help: 'column out all conversation (contains subagent etc. derive sub-conversation; by default only top-level)' },
      { name: 'parent', type: 'number', help: 'only column out the conversation directly sub-conversation' },
    ],
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'profile', type: 'string' },
          { name: 'status', type: 'string' },
          { name: 'tag', type: 'string' },
          { name: 'all', type: 'boolean' },
          { name: 'parent', type: 'number' },
        ],
        ctx.args,
      )
      assertNoExtraPositionals(parsed.positionals, 0)
      const query = new URLSearchParams()
      const profile = flagValue<string>(parsed.flags, 'profile')
      const status = flagValue<string>(parsed.flags, 'status')
      const tag = flagValue<string>(parsed.flags, 'tag')
      const all = parsed.flags.get('all') === true
      const parent = flagValue<number>(parsed.flags, 'parent')
      if (all && parsed.flags.has('parent')) {
        throw new CliError('--all and --parent mutual exclusion: all amount column out and precise sub-conversation filter cannot also designate', 'invalid_flag_value')
      }
      if (parent !== undefined) {
        if (!Number.isInteger(parent) || parent < 1) {
          throw new CliError(`--parent must be a positive integer conversation ID, got "${parent}"`, 'invalid_flag_value')
        }
        query.set('parent', String(parent))
      } else if (all) {
        query.set('all', '1')
      }
      if (profile !== undefined) query.set('profileId', profile)
      if (status !== undefined) {
        if (!['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
          throw new CliError(`--status must be working|blocked|done|idle|error, got "${status}"`, 'invalid_flag_value')
        }
        query.set('status', status)
      }
      if (tag !== undefined) query.set('tag', tag)
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ConversationSummary[]>(`/api/conversations${qs}`))
    },
  })

  // ---- conversations get ----
  cmds.push({
    path: ['conversations', 'get'],
    description: 'view conversation detail situation (GET /api/conversations/:id; contains page timeline)',
    flags: [
      ...convFlags,
      { name: 'limit', type: 'number', help: 'timeline count cap (default 50)' },
      { name: 'cursor', type: 'string', help: 'page cursor (on time response nextCursor original back pass)' },
    ],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'limit', type: 'number' },
          { name: 'cursor', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const query = new URLSearchParams()
      const limit = flagValue<number>(parsed.flags, 'limit')
      const cursor = flagValue<string>(parsed.flags, 'cursor')
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new CliError(`--limit must be a positive integer, got "${limit}"`, 'invalid_flag_value')
        }
        query.set('limit', String(limit))
      }
      if (cursor !== undefined) query.set('cursor', cursor)
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<unknown>(`/api/conversations/${id}${qs}`))
    },
  })

  // ---- conversations entry(single timeline item all text)----
  cmds.push({
    path: ['conversations', 'entry'],
    description: 'view single timeline item (GET /api/conversations/:id/entries/:entryId; detail situation throw shadow truncate after not truncate original text)',
    flags: convFlags,
    positional: '[id] <entryId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const first = parsed.positionals[0]
      const second = parsed.positionals[1]
      assertNoExtraPositionals(parsed.positionals, 2)
      if (second === undefined && first === undefined) {
        throw new CliError('missing <entryId> location parameter ([id] <entryId>, conversation target available --current)', 'missing_positional')
      }
      // single positional treated as entryId: conversation target must from --current(or env).
      const id = resolveConversationTarget(parsed.flags, second === undefined ? undefined : first, ctx.env)
      const entryId = parsePositiveInt((second ?? first) as string, 'entryId')
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<unknown>(`/api/conversations/${id}/entries/${entryId}`))
    },
  })

  // ---- conversations create(support --node bind set compute node)----
  cmds.push({
    path: ['conversations', 'create'],
    description: 'create conversation (POST /api/conversations;--node bind set compute node)',
    flags: [
      { name: 'title', type: 'string' },
      { name: 'profile-id', type: 'string' },
      { name: 'node', type: 'string', help: 'bind set compute node ID(default inherit Profile or local)' },
      { name: 'cwd', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'tags', type: 'string', help: 'JSON array or comma isolate' },
    ],
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'title', type: 'string' },
          { name: 'profile-id', type: 'string' },
          { name: 'node', type: 'string' },
          { name: 'cwd', type: 'string' },
          { name: 'model', type: 'string' },
          { name: 'tags', type: 'string' },
        ],
        ctx.args,
      )
      assertNoExtraPositionals(parsed.positionals, 0)
      const body: Record<string, unknown> = {}
      for (const [flag, key] of [
        ['title', 'title'],
        ['profile-id', 'profileId'],
        ['node', 'nodeId'],
        ['cwd', 'cwd'],
        ['model', 'model'],
      ] as const) {
        const v = flagValue<string>(parsed.flags, flag)
        if (v !== undefined) body[key] = v
      }
      const tags = flagValue<string>(parsed.flags, 'tags')
      if (tags !== undefined) body.tags = coerceTags(tags)
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<ConversationSummary>('/api/conversations', body))
    },
  })

  // ---- conversations update(support --node switch compute node)----
  cmds.push({
    path: ['conversations', 'update'],
    description: 'update conversation (PATCH /api/conversations/:id;--node switch compute node)',
    flags: [
      ...convFlags,
      { name: 'title', type: 'string' },
      { name: 'model', type: 'string', help: 'explicit override model provider/model; empty string (--model= or --model "") clear override and heavy compute inherit chain' },
      { name: 'thinking', type: 'string', help: 'think Profile off/minimal/low/medium/high/xhigh/max; empty string clear override and inherit Profile / global' },
      { name: 'profile-id', type: 'string' },
      { name: 'node', type: 'string', help: 'switch bind set compute node ID' },
      { name: 'cwd', type: 'string', help: 'switch target node perspective work directory' },
      { name: 'pinned', type: 'boolean' },
      { name: 'unread', type: 'boolean' },
    ],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'title', type: 'string' },
          { name: 'model', type: 'string' },
          { name: 'thinking', type: 'string' },
          { name: 'profile-id', type: 'string' },
          { name: 'node', type: 'string' },
          { name: 'cwd', type: 'string' },
          { name: 'pinned', type: 'boolean' },
          { name: 'unread', type: 'boolean' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const body: Record<string, unknown> = {}
      for (const [flag, key] of [
        ['title', 'title'],
        ['model', 'model'],
        ['profile-id', 'profileId'],
        ['node', 'nodeId'],
        ['cwd', 'cwd'],
        ['thinking', 'thinkingLevel'],
      ] as const) {
        const v = flagValue<string>(parsed.flags, flag)
        if (v !== undefined) body[key] = v
      }
      for (const key of ['pinned', 'unread'] as const) {
        const v = parsed.flags.get(key)
        if (v !== undefined) body[key] = v
      }
      if (Object.keys(body).length === 0) {
        throw new CliError('not provide any update field (--title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread)', 'missing_update_fields')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.patch<ConversationSummary>(`/api/conversations/${id}`, body))
    },
  })

  // ---- conversations delete ----
  cmds.push({
    path: ['conversations', 'delete'],
    description: 'delete conversation (DELETE /api/conversations/:id; plugin manage right conversation subject to protect)',
    flags: convFlags,
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/conversations/${id}`))
    },
  })

  // ---- conversations reset ----
  cmds.push({
    path: ['conversations', 'reset'],
    description: 'reset conversation context (POST /api/conversations/:id/reset; new context with handoff start)',
    flags: [...convFlags, { name: 'handoff', type: 'string', help: 'reset after as first user message handover text' }],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'handoff', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const body: Record<string, unknown> = {}
      const handoff = flagValue<string>(parsed.flags, 'handoff')
      if (handoff !== undefined) body.handoff = handoff
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<ConversationSummary>(`/api/conversations/${id}/reset`, body))
    },
  })

  // ---- conversations compact ----
  cmds.push({
    path: ['conversations', 'compact'],
    description: 'manually compress conversation context (POST /api/conversations/:id/compact; background summary task)',
    flags: [...convFlags, { name: 'instructions', type: 'string', help: 'compress summary self define instruction' }],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'instructions', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const body: Record<string, unknown> = {}
      const instructions = flagValue<string>(parsed.flags, 'instructions')
      if (instructions !== undefined) body.instructions = instructions
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/compact`, body))
    },
  })

  // ---- conversations fork ----
  cmds.push({
    path: ['conversations', 'fork'],
    description: 'from designate item fork conversation (POST /api/conversations/:id/fork)',
    flags: [
      ...convFlags,
      { name: 'entry-id', type: 'number', required: true, help: 'fork start point item ID' },
      { name: 'title', type: 'string', help: 'new conversation title (default<source title> (fork))' },
    ],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'entry-id', type: 'number', required: true },
          { name: 'title', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const entryId = flagValue<number>(parsed.flags, 'entry-id')
      if (entryId === undefined || !Number.isInteger(entryId) || entryId <= 0) {
        throw new CliError('--entry-id must be a positive integer', 'invalid_flag_value')
      }
      const body: Record<string, unknown> = { entryId }
      const title = flagValue<string>(parsed.flags, 'title')
      if (title !== undefined) body.title = title
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<ConversationSummary>(`/api/conversations/${id}/fork`, body))
    },
  })

  // ---- send ----
  cmds.push({
    path: ['send'],
    description: 'to conversation commit input (POST /api/conversations/:id/input;--wait wait for this time answer)',
    flags: [
      ...convFlags,
      enumFlag('when-busy', WHEN_BUSY, 'conversation correct busy when policy, by default steer'),
      enumFlag('origin', ORIGINS, 'input source, by default human'),
      { name: 'meta', type: 'json', help: 'self by metadata JSON object (follow input pass to turn_settled)' },
      { name: 'attach', type: 'string', help: 'mount artifact ID(multiple use comma isolate)' },
      { name: 'replace-from', type: 'number', help: 'from designate history item ID start override heavy (truncate the and after continue context)' },
      { name: 'wait', type: 'boolean', help: 'wait for this time input answer (?wait=1; succeeded return ConversationInputResult)' },
    ],
    positional: '[id] <text>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'when-busy', type: 'string' },
          { name: 'origin', type: 'string' },
          { name: 'meta', type: 'json' },
          { name: 'attach', type: 'string' },
          { name: 'replace-from', type: 'number' },
          { name: 'wait', type: 'boolean' },
        ],
        ctx.args,
      )
      const useCurrent = parsed.flags.get('current') === true
      const id = useCurrent
        ? resolveConversationTarget(parsed.flags, undefined, ctx.env)
        : resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      const textIndex = useCurrent ? 0 : 1
      const text = requirePositional(parsed.positionals, textIndex, 'text', 'missing_text')
      if (parsed.positionals.length > textIndex + 1) {
        throw new CliError(`redundant location parameter:${parsed.positionals.slice(textIndex + 1).join(' ')}(text contains space please add quotes)`, 'unexpected_positional')
      }
      const body: Record<string, unknown> = { text }
      const whenBusy = flagValue<string>(parsed.flags, 'when-busy')
      const origin = flagValue<string>(parsed.flags, 'origin')
      if (whenBusy !== undefined) body.whenBusy = validateEnum(whenBusy, WHEN_BUSY, 'when-busy')
      if (origin !== undefined) body.origin = validateEnum(origin, ORIGINS, 'origin')
      if (parsed.flags.has('meta')) body.meta = coerceMetaFlag(parsed.flags.get('meta'), 'meta')
      const attachRaw = flagValue<string>(parsed.flags, 'attach')
      if (attachRaw !== undefined) {
        const attachIds = attachRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        if (attachIds.length > 0) body.attachments = attachIds
      }
      const replaceFrom = flagValue<number>(parsed.flags, 'replace-from')
      if (replaceFrom !== undefined) {
        if (!Number.isInteger(replaceFrom) || replaceFrom <= 0) {
          throw new CliError(`--replace-from must be a positive integer, got "${replaceFrom}"`, 'invalid_flag_value')
        }
        body.replaceFromEntryId = replaceFrom
      }
      const hub = await ctx.hub()
      const wait = parsed.flags.get('wait') === true
      const result = await hub.request<unknown>(
        'POST',
        `/api/conversations/${id}/input${wait ? '?wait=1' : ''}`,
        { body, ...(wait ? { timeoutMs: 0 } : {}) },
      )
      if (wait && !ctx.json) {
        // person class pattern: wait for succeeded direct out answer text (entry.model inside assistant text chunk)
        const answer = assistantTextOfResult(result)
        printPlainText(ctx, answer !== '' ? answer : JSON.stringify(result))
        return
      }
      printResult(ctx, result)
    },
  })

  // ---- conversations withdraw ----
  cmds.push({
    path: ['conversations', 'withdraw'],
    description: 'withdraw back queue up in input (POST /api/conversations/:id/withdraw)',
    flags: [...convFlags, { name: 'submission-id', type: 'number', required: true, help: 'await withdraw back queue up commit ID' }],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'submission-id', type: 'number', required: true },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const submissionId = flagValue<number>(parsed.flags, 'submission-id')
      if (submissionId === undefined || !Number.isInteger(submissionId) || submissionId <= 0) {
        throw new CliError('--submission-id must be a positive integer', 'invalid_flag_value')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/withdraw`, { submissionId }))
    },
  })

  // ---- abort ----
  cmds.push({
    path: ['abort'],
    description: 'abort conversation when before turn (POST /api/conversations/:id/abort)',
    flags: convFlags,
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/abort`))
    },
  })

  return cmds
}

/** ConversationInputResult.entry.model -> assistant answer text chunk concatenate. */
function assistantTextOfResult(result: unknown): string {
  if (result === null || typeof result !== 'object') return ''
  const entry = (result as { entry?: { model?: unknown } }).entry
  if (!entry || !Array.isArray(entry.model)) return ''
  const parts: string[] = []
  for (const message of entry.model) {
    if (message === null || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text)
      }
    }
  }
  return parts.join('\n')
}

/** SSE incremental event person class can read single row summary. */
function summarizeEvent(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload)
  const frame = payload as { seq?: unknown; event?: Record<string, unknown> & { type?: string } }
  const seq = typeof frame.seq === 'number' ? frame.seq : '?'
  const event = frame.event
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    return `${seq}  ${JSON.stringify(payload)}`
  }
  let extra = ''
  switch (event.type) {
    case 'conversation.upsert': {
      const c = event.conversation as { id?: number; title?: string; status?: string } | undefined
      extra = `#${c?.id ?? '?'} ${c?.title ?? ''} (${c?.status ?? '?'})`
      break
    }
    case 'conversation.deleted':
      extra = `#${String(event.conversationId ?? '?')}`
      break
    case 'ask.upsert': {
      const a = event.ask as { id?: string; title?: string } | undefined
      extra = `${a?.id ?? '?'} ${a?.title ?? ''}`
      break
    }
    case 'ask.resolved':
      extra = `${String(event.askId ?? '?')} -> ${String(event.status ?? '?')}`
      break
    case 'plugin.changed': {
      const p = event.plugin as { id?: string } | undefined
      extra = String(p?.id ?? '?')
      break
    }
    case 'notification':
      extra = String(event.title ?? '')
      break
    default:
      extra = JSON.stringify(event)
  }
  return `${seq}  ${event.type}  ${extra}`
}
