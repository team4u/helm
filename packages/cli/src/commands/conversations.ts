/**
 * 会话域：conversations list/get/create/update/delete/reset/compact/fork、
 * send、abort、events watch。create/update 支持 --node <nodeId> 绑定计算节点。
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
  printPlainText,
  printResult,
  requirePositional,
  resolveConversationTarget,
  validateEnum,
} from './shared.js'

const WHEN_BUSY = ['steer', 'followUp', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const

const convFlags: FlagSpec[] = [{ name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID' }]

export function conversationsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  // ---- events watch（全局 SSE，与 conversations 域共享打印辅助）----
  cmds.push({
    path: ['events', 'watch'],
    description: '订阅全局 SSE 事件流（GET /api/events；首帧 snapshot + 增量）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const controller = new AbortController()
      const onSignal = () => controller.abort()
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      const render = (event: string, payload: unknown): void => {
        if (ctx.json) {
          // NDJSON：snapshot 帧与增量帧均原样输出（每行一个 JSON）
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          const snap = payload as { seq?: number; conversations?: unknown[]; pendingAsks?: unknown[]; plugins?: unknown[] }
          ctx.io.out(
            `快照 seq=${snap.seq ?? '?'} 会话=${snap.conversations?.length ?? 0} 待答=${snap.pendingAsks?.length ?? 0} 插件=${snap.plugins?.length ?? 0}\n`,
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
              // 畸形帧：诊断到 stderr 后跳过，不中断流（keepalive 等噪声合法）
              ctx.io.err(`helm: 忽略非 JSON SSE 帧（${data.slice(0, 120)}）\n`)
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
    description: '列出会话（GET /api/conversations）',
    flags: [
      { name: 'profile', type: 'string', help: '按 profileId 过滤' },
      { name: 'status', type: 'string', help: '按状态过滤（working|blocked|done|idle|error）' },
      { name: 'tag', type: 'string', help: '按 tag 过滤' },
    ],
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'profile', type: 'string' },
          { name: 'status', type: 'string' },
          { name: 'tag', type: 'string' },
        ],
        ctx.args,
      )
      assertNoExtraPositionals(parsed.positionals, 0)
      const query = new URLSearchParams()
      const profile = flagValue<string>(parsed.flags, 'profile')
      const status = flagValue<string>(parsed.flags, 'status')
      const tag = flagValue<string>(parsed.flags, 'tag')
      if (profile !== undefined) query.set('profileId', profile)
      if (status !== undefined) {
        if (!['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
          throw new CliError(`--status 需为 working|blocked|done|idle|error，实得 "${status}"`, 'invalid_flag_value')
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
    description: '查看会话详情（GET /api/conversations/:id；含分页时间线）',
    flags: [
      ...convFlags,
      { name: 'limit', type: 'number', help: '时间线条数上限（缺省 50）' },
      { name: 'cursor', type: 'string', help: '分页游标（上次响应 nextCursor 原样回传）' },
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
          throw new CliError(`--limit 需为正整数，实得 "${limit}"`, 'invalid_flag_value')
        }
        query.set('limit', String(limit))
      }
      if (cursor !== undefined) query.set('cursor', cursor)
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<unknown>(`/api/conversations/${id}${qs}`))
    },
  })

  // ---- conversations create（支持 --node 绑定计算节点）----
  cmds.push({
    path: ['conversations', 'create'],
    description: '创建会话（POST /api/conversations；--node 绑定计算节点）',
    flags: [
      { name: 'title', type: 'string' },
      { name: 'profile-id', type: 'string' },
      { name: 'node', type: 'string', help: '绑定的计算节点 ID（缺省继承 Profile 或 local）' },
      { name: 'cwd', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'tags', type: 'string', help: 'JSON 数组或逗号分隔' },
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

  // ---- conversations update（支持 --node 切换计算节点）----
  cmds.push({
    path: ['conversations', 'update'],
    description: '更新会话（PATCH /api/conversations/:id；--node 切换计算节点）',
    flags: [
      ...convFlags,
      { name: 'title', type: 'string' },
      { name: 'model', type: 'string', help: '显式覆盖模型 provider/model；空串（--model= 或 --model ""）清除覆盖并重算继承链' },
      { name: 'thinking', type: 'string', help: '思考档位 off/minimal/low/medium/high/xhigh/max；空串清除覆盖并继承 Profile / 全局' },
      { name: 'profile-id', type: 'string' },
      { name: 'node', type: 'string', help: '切换绑定的计算节点 ID' },
      { name: 'cwd', type: 'string', help: '切换目标节点视角工作目录' },
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
        throw new CliError('未提供任何更新字段（--title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread）', 'missing_update_fields')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.patch<ConversationSummary>(`/api/conversations/${id}`, body))
    },
  })

  // ---- conversations delete ----
  cmds.push({
    path: ['conversations', 'delete'],
    description: '删除会话（DELETE /api/conversations/:id；#1 受保护）',
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
    description: '重置会话上下文（POST /api/conversations/:id/reset；新上下文以 handoff 开始）',
    flags: [...convFlags, { name: 'handoff', type: 'string', help: '重置后作为首条用户消息的交接文本' }],
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
    description: '手动压缩会话上下文（POST /api/conversations/:id/compact；后台摘要任务）',
    flags: [...convFlags, { name: 'instructions', type: 'string', help: '压缩摘要自定义指令' }],
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
    description: '从指定条目分叉会话（POST /api/conversations/:id/fork）',
    flags: [
      ...convFlags,
      { name: 'entry-id', type: 'number', required: true, help: '分叉起点条目 ID' },
      { name: 'title', type: 'string', help: '新会话标题（缺省「<源标题> (分叉)」）' },
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
        throw new CliError('--entry-id 需为正整数', 'invalid_flag_value')
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
    description: '向会话提交输入（POST /api/conversations/:id/input；--wait 等待本次回答）',
    flags: [
      ...convFlags,
      enumFlag('when-busy', WHEN_BUSY, '会话正忙时策略，默认 steer'),
      enumFlag('origin', ORIGINS, '输入来源，默认 human'),
      { name: 'meta', type: 'json', help: '自由元数据 JSON 对象（随输入传递到 turn_settled）' },
      { name: 'attach', type: 'string', help: '挂载产物 ID（多个用逗号分隔）' },
      { name: 'wait', type: 'boolean', help: '等待本次输入的回答（?wait=1；成功返回 ConversationInputResult）' },
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
        throw new CliError(`多余位置参数：${parsed.positionals.slice(textIndex + 1).join(' ')}（text 含空格请加引号）`, 'unexpected_positional')
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
      const hub = await ctx.hub()
      const wait = parsed.flags.get('wait') === true
      const result = await hub.request<unknown>(
        'POST',
        `/api/conversations/${id}/input${wait ? '?wait=1' : ''}`,
        { body, ...(wait ? { timeoutMs: 0 } : {}) },
      )
      if (wait && !ctx.json) {
        // 人类模式：等待成功直出回答文本（entry.model 内 assistant 文本块）
        const answer = assistantTextOfResult(result)
        printPlainText(ctx, answer !== '' ? answer : JSON.stringify(result))
        return
      }
      printResult(ctx, result)
    },
  })

  // ---- abort ----
  cmds.push({
    path: ['abort'],
    description: '中止会话当前回合（POST /api/conversations/:id/abort）',
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

/** ConversationInputResult.entry.model -> assistant 回答文本块拼接。 */
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

/** SSE 增量事件的人类可读单行摘要。 */
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
