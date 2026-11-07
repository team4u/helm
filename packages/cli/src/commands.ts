/** 核心命令表：每个命令 = 路径 + flag 声明 + 一次 HTTP 调用，零业务特判。 */
import type { AskSpec, AuthStatus, AuthToken, CredentialSummary, ProviderConfig, Profile, SkillSummary, ConversationSummary, ArtifactMetadata, PluginSummary, ActionManifest, WorkflowRunSummary, WorkflowRunRequest } from '@helm/protocol'
import { CliError } from './errors.js'
import type { HubClient } from './hub-client.js'
import type { Io } from './options.js'
import { printText, printValue } from './output.js'
import { credentialsPath, updateCliCredentials } from './credentials.js'
import { flagValue, parseFlags, type FlagSpec } from './args.js'

export interface CommandContext {
  io: Io
  env: NodeJS.ProcessEnv
  json: boolean
  args: string[]
  dataDir: string
  hub(): Promise<HubClient>
}

export interface CommandSpec {
  path: readonly string[]
  description: string
  flags?: readonly FlagSpec[]
  /** 位置参数说明（仅帮助展示）。 */
  positional?: string
  run(ctx: CommandContext): Promise<void>
}

// ---------------------------------------------------------------------------
// 公共小助手
// ---------------------------------------------------------------------------

export function parsePositiveInt(raw: string, what: string): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
    throw new CliError(`${what} 需为正整数，实得 "${raw}"`, 'invalid_id')
  }
  return Number(trimmed)
}

/**
 * 解析会话目标：显式位置 ID 或 --current（读 HELM_CONVERSATION_ID）。
 * 二者均缺失/非法时显式报错；同时给出时显式优先。
 */
export function resolveConversationTarget(
  flags: Map<string, unknown>,
  positionalId: string | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (positionalId !== undefined) return parsePositiveInt(positionalId, '会话 ID')
  if (flags.get('current') === true) {
    const raw = env['HELM_CONVERSATION_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current 需要 env HELM_CONVERSATION_ID（当前未设置）', 'current_conversation_missing')
    }
    return parsePositiveInt(raw, 'HELM_CONVERSATION_ID')
  }
  throw new CliError('缺少会话目标：提供显式 <id> 或 --current（读 HELM_CONVERSATION_ID）', 'missing_conversation_target')
}

/** --tags：接受 JSON 数组或逗号分隔字符串。 */
function coerceTags(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new CliError('--tags JSON 需为字符串数组', 'invalid_flag_value')
    }
    return parsed as string[]
  }
  if (typeof raw !== 'string') throw new CliError('--tags 需为 JSON 数组或逗号分隔字符串', 'invalid_flag_value')
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** --meta：JSON 对象（非对象 JSON 拒绝；边界校验在 Hub）。 */
function coerceMetaFlag(raw: unknown, flagName: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`--${flagName} 需为 JSON 对象`, 'invalid_flag_value')
  }
  return raw as Record<string, unknown>
}

/** --input：必填 JSON。 */
function requireJsonInput(flags: Map<string, unknown>): unknown {
  const value = flags.get('input')
  if (value === undefined) throw new CliError('缺少必填选项 --input <json>', 'missing_required_flag')
  return value
}

/** stdin 读一行密码（仅非 TTY；TTY 下提示改用 --password，绝不交互阻塞）。 */
async function readPasswordFromStdin(): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    // readline 已去除行尾；不再 trim——密码中的首尾空格是用户输入的一部分
    return await rl.question('')
  } finally {
    rl.close()
  }
}

/** setup/login 共用：换 token 并把 cli 凭据原子写入 credentials.json（请求本身无需鉴权）。 */
async function authAndSave(ctx: CommandContext, path: '/api/auth/setup' | '/api/auth/login', password: string): Promise<void> {
  const hub = await ctx.hub()
  const { token } = await hub.request<AuthToken>('POST', path, { body: { password }, auth: false })
  if (typeof token !== 'string' || token.length === 0) {
    throw new CliError('Hub 未返回 token（响应缺 string 字段 token）', 'invalid_response')
  }
  await updateCliCredentials(ctx.dataDir, { hubUrl: hub.baseUrl, token })
  if (ctx.json) {
    printValue(ctx.io, { token }, true)
  } else {
    ctx.io.out(`已登录 ${hub.baseUrl}（凭据已写入 ${credentialsPath(ctx.dataDir)}）\n`)
  }
}

// ---------------------------------------------------------------------------
// 命令定义
// ---------------------------------------------------------------------------

const WHEN_BUSY = ['steer', 'followUp', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const

function enumFlag<T extends readonly string[]>(name: string, values: T, help: string): FlagSpec {
  return { name, type: 'string', help: `${help}（${values.join('|')}）` }
}

function validateEnum(raw: unknown, values: readonly string[], flagName: string): string {
  if (typeof raw !== 'string' || !values.includes(raw)) {
    throw new CliError(`--${flagName} 需为 ${values.join('|')}，实得 "${String(raw)}"`, 'invalid_flag_value')
  }
  return raw
}

export function coreCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  // ---- 鉴权 ----
  cmds.push({
    path: ['setup'],
    description: '初始化管理员密码并登录（POST /api/auth/setup）',
    flags: [{ name: 'password', type: 'string', help: '管理员密码；缺省且 stdin 非 TTY 时读一行' }],
    async run(ctx) {
      const raw = flagValue<string>(parseFlags([{ name: 'password', type: 'string' }], ctx.args).flags, 'password')
      const password = raw ?? (process.stdin.isTTY ? undefined : await readPasswordFromStdin())
      if (!password) {
        throw new CliError('缺少密码：提供 --password <password>，或经 stdin 传入（TTY 下必须显式 --password）', 'missing_password')
      }
      await authAndSave(ctx, '/api/auth/setup', password)
    },
  })

  cmds.push({
    path: ['login'],
    description: '登录并保存凭据（POST /api/auth/login）',
    flags: [{ name: 'password', type: 'string', help: '管理员密码；缺省且 stdin 非 TTY 时读一行' }],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const raw = flagValue<string>(parsed.flags, 'password')
      const password = raw ?? (process.stdin.isTTY ? undefined : await readPasswordFromStdin())
      if (!password) {
        throw new CliError('缺少密码：提供 --password <password>，或经 stdin 传入（TTY 下必须显式 --password）', 'missing_password')
      }
      await authAndSave(ctx, '/api/auth/login', password)
    },
  })

  cmds.push({
    path: ['status'],
    description: '查看鉴权状态（GET /api/auth/status）',
    async run(ctx) {
      const hub = await ctx.hub()
      // auth:'optional'：已存 token 附带（Hub 据此回真实 authenticated），无 token 也可探测 configured
      const res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      printValue(ctx.io, res, ctx.json)
    },
  })

  // ---- 事件流 ----
  cmds.push({
    path: ['events', 'watch'],
    description: '订阅全局 SSE 事件流（GET /api/events；首帧 snapshot + 增量）',
    async run(ctx) {
      parseFlags([], ctx.args)
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

  // ---- 会话 ----
  const convFlags: FlagSpec[] = [{ name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID' }]

  cmds.push({
    path: ['conversations', 'list'],
    description: '列出会话（GET /api/conversations）',
    flags: [
      { name: 'profile', type: 'string', help: '按 profileId 过滤' },
      { name: 'status', type: 'string', help: '按状态过滤（working|blocked|done|idle|error）' },
      { name: 'tag', type: 'string', help: '按 tag 过滤' },
    ],
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'profile', type: 'string' },
          { name: 'status', type: 'string' },
          { name: 'tag', type: 'string' },
        ],
        ctx.args,
      )
      if (parsed.positionals.length > 0) throw new CliError(`多余位置参数：${parsed.positionals.join(' ')}`, 'unexpected_positional')
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
      printValue(ctx.io, await hub.get<ConversationSummary[]>(`/api/conversations${qs}`), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'get'],
    description: '查看会话详情（GET /api/conversations/:id；含分页时间线）',
    flags: [
      ...convFlags,
      { name: 'limit', type: 'number', help: '时间线条数上限（缺省 50）' },
      { name: 'cursor', type: 'string', help: '分页游标（上次响应 nextCursor 原样回传）' },
    ],
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'limit', type: 'number' },
          { name: 'cursor', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
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
      printValue(ctx.io, await hub.get<unknown>(`/api/conversations/${id}${qs}`), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'create'],
    description: '创建会话（POST /api/conversations）',
    flags: [
      { name: 'title', type: 'string' },
      { name: 'profile-id', type: 'string' },
      { name: 'cwd', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'tags', type: 'string', help: 'JSON 数组或逗号分隔' },
    ],
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'title', type: 'string' },
          { name: 'profile-id', type: 'string' },
          { name: 'cwd', type: 'string' },
          { name: 'model', type: 'string' },
          { name: 'tags', type: 'string' },
        ],
        ctx.args,
      )
      if (parsed.positionals.length > 0) throw new CliError(`多余位置参数：${parsed.positionals.join(' ')}`, 'unexpected_positional')
      const body: Record<string, unknown> = {}
      const title = flagValue<string>(parsed.flags, 'title')
      const profileId = flagValue<string>(parsed.flags, 'profile-id')
      const cwd = flagValue<string>(parsed.flags, 'cwd')
      const model = flagValue<string>(parsed.flags, 'model')
      const tags = flagValue<string>(parsed.flags, 'tags')
      if (title !== undefined) body.title = title
      if (profileId !== undefined) body.profileId = profileId
      if (cwd !== undefined) body.cwd = cwd
      if (model !== undefined) body.model = model
      if (tags !== undefined) body.tags = coerceTags(tags)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<ConversationSummary>('/api/conversations', body), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'update'],
    description: '更新会话（PATCH /api/conversations/:id）',
    flags: [
      ...convFlags,
      { name: 'title', type: 'string' },
      { name: 'model', type: 'string', help: '显式覆盖模型 provider/model；空串（--model= 或 --model ""）清除覆盖并重算继承链' },
      { name: 'profile-id', type: 'string' },
      { name: 'pinned', type: 'boolean' },
      { name: 'unread', type: 'boolean' },
    ],
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'title', type: 'string' },
          { name: 'model', type: 'string' },
          { name: 'profile-id', type: 'string' },
          { name: 'pinned', type: 'boolean' },
          { name: 'unread', type: 'boolean' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const body: Record<string, unknown> = {}
      for (const [flag, key] of [
        ['title', 'title'],
        ['model', 'model'],
        ['profile-id', 'profileId'],
      ] as const) {
        const v = flagValue<string>(parsed.flags, flag)
        if (v !== undefined) body[key] = v
      }
      for (const key of ['pinned', 'unread'] as const) {
        const v = parsed.flags.get(key)
        if (v !== undefined) body[key] = v
      }
      if (Object.keys(body).length === 0) throw new CliError('未提供任何更新字段（--title/--model/--profile-id/--pinned/--unread）', 'missing_update_fields')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.patch<ConversationSummary>(`/api/conversations/${id}`, body), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'delete'],
    description: '删除会话（DELETE /api/conversations/:id；#1 受保护）',
    flags: convFlags,
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.delete<unknown>(`/api/conversations/${id}`), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'reset'],
    description: '重置会话上下文（POST /api/conversations/:id/reset；新上下文以 handoff 开始）',
    flags: [...convFlags, { name: 'handoff', type: 'string', help: '重置后作为首条用户消息的交接文本' }],
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'handoff', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const body: Record<string, unknown> = {}
      const handoff = flagValue<string>(parsed.flags, 'handoff')
      if (handoff !== undefined) body.handoff = handoff
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<ConversationSummary>(`/api/conversations/${id}/reset`, body), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'compact'],
    description: '手动压缩会话上下文（POST /api/conversations/:id/compact；后台摘要任务）',
    flags: [...convFlags, { name: 'instructions', type: 'string', help: '压缩摘要自定义指令' }],
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'instructions', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const body: Record<string, unknown> = {}
      const instructions = flagValue<string>(parsed.flags, 'instructions')
      if (instructions !== undefined) body.instructions = instructions
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/conversations/${id}/compact`, body), ctx.json)
    },
  })

  cmds.push({
    path: ['conversations', 'fork'],
    description: '从指定条目分叉会话（POST /api/conversations/:id/fork）',
    flags: [
      ...convFlags,
      { name: 'entry-id', type: 'number', required: true, help: '分叉起点条目 ID' },
      { name: 'title', type: 'string', help: '新会话标题（缺省「<源标题> (分叉)」）' },
    ],
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'entry-id', type: 'number', required: true },
          { name: 'title', type: 'string' },
        ],
        ctx.args,
      )
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const entryId = flagValue<number>(parsed.flags, 'entry-id')
      if (entryId === undefined || !Number.isInteger(entryId) || entryId <= 0) {
        throw new CliError('--entry-id 需为正整数', 'invalid_flag_value')
      }
      const body: Record<string, unknown> = { entryId }
      const title = flagValue<string>(parsed.flags, 'title')
      if (title !== undefined) body.title = title
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<ConversationSummary>(`/api/conversations/${id}/fork`, body), ctx.json)
    },
  })

  cmds.push({
    path: ['send'],
    description: '向会话提交输入（POST /api/conversations/:id/input；--wait 等待本次回答）',
    flags: [
      ...convFlags,
      enumFlag('when-busy', WHEN_BUSY, '会话正忙时策略'),
      enumFlag('origin', ORIGINS, '输入来源，默认 human'),
      { name: 'meta', type: 'json', help: '自由元数据 JSON 对象（随输入传递到 turn_settled）' },
      { name: 'attach', type: 'string', help: '挂载产物 ID（多个用逗号分隔）' },
      { name: 'wait', type: 'boolean', help: '等待本次输入的回答（?wait=1；成功返回 ConversationInputResult）' },
    ],
    positional: '[id] <text>',
    async run(ctx) {
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
      const id = useCurrent ? resolveConversationTarget(parsed.flags, undefined, ctx.env) : resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      const textIndex = useCurrent ? 0 : 1
      const text = parsed.positionals[textIndex]
      if (text === undefined) throw new CliError('缺少 <text> 位置参数', 'missing_text')
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
        printText(ctx.io, answer !== '' ? answer : JSON.stringify(result))
        return
      }
      printValue(ctx.io, result, ctx.json)
    },
  })

  cmds.push({
    path: ['abort'],
    description: '中止会话当前回合（POST /api/conversations/:id/abort）',
    flags: convFlags,
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/conversations/${id}/abort`), ctx.json)
    },
  })

  // ---- AskDoc ----
  cmds.push({
    path: ['asks', 'list'],
    description: '列出待答提问（GET /api/asks）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<AskSpec[]>('/api/asks'), ctx.json)
    },
  })

  cmds.push({
    path: ['asks', 'answer'],
    description: '提交提问答案（POST /api/asks/:id/answer；支持 CAS）',
    flags: [
      { name: 'answers', type: 'json', required: true, help: 'fieldName -> 答案 JSON 对象' },
      { name: 'expected-state-seq', type: 'number', help: 'CAS 水位线，已推进则 superseded' },
    ],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'answers', type: 'json', required: true },
          { name: 'expected-state-seq', type: 'number' },
        ],
        ctx.args,
      )
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const answers = parsed.flags.get('answers')
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new CliError('--answers 需为 JSON 对象（fieldName -> 答案）', 'invalid_flag_value')
      }
      const body: Record<string, unknown> = { answers }
      const seq = flagValue<number>(parsed.flags, 'expected-state-seq')
      if (seq !== undefined) body.expectedStateSeq = seq
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/answer`, body), ctx.json)
    },
  })

  cmds.push({
    path: ['asks', 'cancel'],
    description: '取消提问（POST /api/asks/:id/cancel）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/cancel`), ctx.json)
    },
  })

  // ---- Profiles ----
  cmds.push({
    path: ['profiles', 'list'],
    description: '列出 Profile（GET /api/profiles）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<Profile[]>('/api/profiles'), ctx.json)
    },
  })

  cmds.push({
    path: ['profiles', 'get'],
    description: '查看 Profile（GET /api/profiles/:id）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`), ctx.json)
    },
  })

  cmds.push({
    path: ['profiles', 'create'],
    description: '创建 Profile（POST /api/profiles）',
    flags: [{ name: 'input', type: 'json', required: true, help: 'Profile JSON' }],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<Profile>('/api/profiles', requireJsonInput(parsed.flags)), ctx.json)
    },
  })

  cmds.push({
    path: ['profiles', 'update'],
    description: '更新 Profile（PUT /api/profiles/:id）',
    flags: [{ name: 'input', type: 'json', required: true, help: 'Profile JSON' }],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, requireJsonInput(parsed.flags)), ctx.json)
    },
  })

  cmds.push({
    path: ['profiles', 'delete'],
    description: '删除 Profile（DELETE /api/profiles/:id）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.delete<unknown>(`/api/profiles/${encodeURIComponent(id)}`), ctx.json)
    },
  })

  // ---- Providers ----
  cmds.push({
    path: ['providers', 'list'],
    description: '列出模型网关（GET /api/providers）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<ProviderConfig[]>('/api/providers'), ctx.json)
    },
  })

  cmds.push({
    path: ['providers', 'set'],
    description: '整体替换模型网关列表（PUT /api/providers；完整数组，严禁含密钥）',
    flags: [{ name: 'input', type: 'json', required: true, help: 'ProviderConfig[] JSON' }],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      const input = requireJsonInput(parsed.flags)
      if (!Array.isArray(input)) throw new CliError('--input 需为完整 JSON 数组（ProviderConfig[]）', 'invalid_flag_value')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.put<ProviderConfig[]>('/api/providers', input), ctx.json)
    },
  })

  // ---- 服务端凭据 ----
  cmds.push({
    path: ['credentials', 'list'],
    description: '列出服务端凭据（GET /api/credentials；仅 keys 与 configured）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<CredentialSummary[]>('/api/credentials'), ctx.json)
    },
  })

  cmds.push({
    path: ['credentials', 'set'],
    description: '写入服务端凭据（PUT /api/credentials/:id；明文不回读）',
    flags: [{ name: 'value', type: 'string', required: true }],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'value', type: 'string', required: true }], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.put<unknown>(`/api/credentials/${encodeURIComponent(id)}`, { value: flagValue<string>(parsed.flags, 'value') }), ctx.json)
    },
  })

  cmds.push({
    path: ['credentials', 'delete'],
    description: '删除服务端凭据（DELETE /api/credentials/:id）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.delete<unknown>(`/api/credentials/${encodeURIComponent(id)}`), ctx.json)
    },
  })

  // ---- Models / Skills ----
  cmds.push({
    path: ['models', 'list'],
    description: '列出可用模型（GET /api/models）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<unknown[]>('/api/models'), ctx.json)
    },
  })

  cmds.push({
    path: ['skills', 'list'],
    description: '列出技能（GET /api/skills）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<SkillSummary[]>('/api/skills'), ctx.json)
    },
  })

  cmds.push({
    path: ['skills', 'read'],
    description: '读取技能文档（GET /api/skills/:id[?path=]；默认 SKILL.md）',
    flags: [{ name: 'path', type: 'string', help: "子文件相对路径，如 'references/xxx.md'" }],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'path', type: 'string' }], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const p = flagValue<string>(parsed.flags, 'path')
      const query = p ? `?path=${encodeURIComponent(p)}` : ''
      const hub = await ctx.hub()
      const res = await hub.get<{ text: string }>(`/api/skills/${encodeURIComponent(id)}${query}`)
      if (typeof res?.text !== 'string') {
        throw new CliError('Hub 响应非 {text} 形状（skills read）', 'invalid_response')
      }
      if (ctx.json) printValue(ctx.io, res, true)
      else printText(ctx.io, res.text)
    },
  })

  // ---- Artifacts / Search ----
  cmds.push({
    path: ['artifacts', 'list'],
    description: '列出会话产物（GET /api/conversations/:id/artifacts）',
    flags: convFlags,
    positional: '[id]',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<ArtifactMetadata[]>(`/api/conversations/${id}/artifacts`), ctx.json)
    },
  })

  cmds.push({
    path: ['artifacts', 'put'],
    description: '上传本地文件为会话产物（POST /api/conversations/:id/artifacts）',
    flags: [
      ...convFlags,
      { name: 'name', type: 'string', help: '自定义产物名（缺省用本地文件名）' },
      { name: 'mime-type', type: 'string', help: '显式 MIME 类型' },
    ],
    positional: '<filePath> [id]',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'name', type: 'string' },
          { name: 'mime-type', type: 'string' },
        ],
        ctx.args,
      )
      const filePath = parsed.positionals[0]
      if (filePath === undefined) throw new CliError('缺少 <filePath> 位置参数', 'missing_file_path')
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[1], ctx.env)
      if (parsed.positionals.length > 2) {
        throw new CliError(`多余位置参数：${parsed.positionals.slice(2).join(' ')}`, 'unexpected_positional')
      }
      const pathMod = await import('node:path')
      const fsp = await import('node:fs/promises')
      let bytes: Uint8Array
      try {
        const st = await fsp.stat(filePath)
        if (!st.isFile()) {
          throw new CliError(`上传源不是常规文件（目录/设备）：${filePath}`, 'read_failed')
        }
        const buffer = await fsp.readFile(filePath)
        bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
      } catch (err) {
        if (err instanceof CliError) throw err
        throw new CliError(
          `读取上传文件失败（${filePath}）：${err instanceof Error ? err.message : String(err)}`,
          'read_failed',
        )
      }
      const fileName = flagValue<string>(parsed.flags, 'name') ?? pathMod.basename(filePath)
      const mimeType = flagValue<string>(parsed.flags, 'mime-type')
      const hub = await ctx.hub()
      const metadata = await hub.uploadArtifact(id, fileName, bytes, mimeType)
      printValue(ctx.io, metadata, ctx.json)
    },
  })

  cmds.push({
    path: ['artifacts', 'get'],
    description: '读取产物内容（GET /api/artifacts/:id/content；文本直出，二进制需 --output）',
    flags: [{ name: 'output', type: 'string', help: '二进制落盘路径' }],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'output', type: 'string' }], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const output = flagValue<string>(parsed.flags, 'output')
      const hub = await ctx.hub()
      const response = await hub.raw(`/api/artifacts/${encodeURIComponent(id)}/content`)
      const contentType = response.headers.get('content-type') ?? ''
      const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('yaml') || contentType === ''
      if (output !== undefined) {
        const fsp = await import('node:fs/promises')
        try {
          await fsp.writeFile(output, Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          throw new CliError(`写入 ${output} 失败：${err instanceof Error ? err.message : String(err)}`, 'write_failed')
        }
        if (ctx.json) printValue(ctx.io, { written: output, bytes: response.headers.get('content-length') }, true)
        else ctx.io.out(`已写入 ${output}\n`)
        return
      }
      if (!isText) {
        throw new CliError(`产物为二进制（${contentType || '未知类型'}）：使用 --output <path> 落盘`, 'binary_content_requires_output')
      }
      const text = await response.text()
      if (ctx.json) printValue(ctx.io, text, true)
      else printText(ctx.io, text)
    },
  })

  cmds.push({
    path: ['search'],
    description: '全文检索（GET /api/search?q=）',
    positional: '<query>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const query = parsed.positionals.join(' ')
      if (!query) throw new CliError('缺少 <query> 位置参数', 'missing_query')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<unknown[]>(`/api/search?q=${encodeURIComponent(query)}`), ctx.json)
    },
  })

  // ---- Plugins / Actions ----
  cmds.push({
    path: ['plugins', 'list'],
    description: '列出插件（GET /api/plugins）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<PluginSummary[]>('/api/plugins'), ctx.json)
    },
  })

  cmds.push({
    path: ['plugins', 'enable'],
    description: '启用插件（POST /api/plugins/:id/enable）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/enable`), ctx.json)
    },
  })

  cmds.push({
    path: ['plugins', 'disable'],
    description: '停用插件（POST /api/plugins/:id/disable）',
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/disable`), ctx.json)
    },
  })

  cmds.push({
    path: ['plugins', 'config'],
    description: '查看/更新插件配置（GET 返回 {values,schema}；PUT 发送 {values}）',
    flags: [{ name: 'input', type: 'json', help: '提供即 PUT {values:<input>}' }],
    positional: '<id>',
    async run(ctx) {
      const parsed = parseFlags([{ name: 'input', type: 'json' }], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <id> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/config`
      if (parsed.flags.has('input')) {
        printValue(ctx.io, await hub.put<unknown>(path, { values: parsed.flags.get('input') }), ctx.json)
      } else {
        printValue(ctx.io, await hub.get<unknown>(path), ctx.json)
      }
    },
  })

  cmds.push({
    path: ['plugins', 'doc'],
    description: '读取插件公共文档（GET /api/plugins/:id/docs/:name；私有/不存在 404）',
    positional: '<pluginId> <name>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const pluginId = parsed.positionals[0]
      const name = parsed.positionals[1]
      if (pluginId === undefined || name === undefined) {
        throw new CliError('缺少位置参数：plugins doc <pluginId> <name>', 'missing_id')
      }
      if (parsed.positionals.length > 2) throw new CliError(`多余位置参数：${parsed.positionals.slice(2).join(' ')}`, 'unexpected_positional')
      const hub = await ctx.hub()
      const doc = await hub.get<{ pluginId: string; name: string; value: unknown }>(
        `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`,
      )
      if (ctx.json) {
        printValue(ctx.io, doc, true)
        return
      }
      // 人类模式：文档名 + 值（JSON 保真；文本值直出）
      if (typeof doc.value === 'string') {
        ctx.io.out(`${doc.name}\n`)
        printText(ctx.io, doc.value)
        return
      }
      printValue(ctx.io, doc.value, false)
    },
  })

  cmds.push({
    path: ['actions', 'list'],
    description: '列出插件动作清单（GET /api/actions）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<ActionManifest[]>('/api/actions'), ctx.json)
    },
  })

  // ---- Workflows ----
  cmds.push({
    path: ['workflows', 'list'],
    description: '列出已保存工作流（GET /api/workflows）',
    async run(ctx) {
      parseFlags([], ctx.args)
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<unknown[]>('/api/workflows'), ctx.json)
    },
  })

  cmds.push({
    path: ['workflows', 'run'],
    description: '运行工作流（POST /api/workflows/run；--wait 等待终态）',
    flags: [
      { name: 'args', type: 'json', help: '原样传给脚本的 args' },
      { name: 'resume-from-run-id', type: 'string', help: '断点重放 runId' },
      { name: 'current', type: 'boolean', help: '绑定 env HELM_CONVERSATION_ID 会话' },
      { name: 'wait', type: 'boolean', help: '等待终态（?wait=1；failed/aborted 非零退出）' },
    ],
    positional: '<nameOrFile>',
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'args', type: 'json' },
          { name: 'resume-from-run-id', type: 'string' },
          { name: 'current', type: 'boolean' },
          { name: 'wait', type: 'boolean' },
        ],
        ctx.args,
      )
      const target = parsed.positionals[0]
      if (target === undefined) throw new CliError('缺少 <nameOrFile> 位置参数', 'missing_target')
      if (parsed.positionals.length > 1) throw new CliError(`多余位置参数：${parsed.positionals.slice(1).join(' ')}`, 'unexpected_positional')
      const body: Record<string, unknown> = {}
      // CLI 层判断文件/名称：存在即本机文件（发绝对路径 scriptPath），否则视为已保存名称
      const fsp = await import('node:fs/promises')
      const pathMod = await import('node:path')
      let isFile = false
      try {
        const st = await fsp.stat(target)
        isFile = st.isFile()
      } catch {
        isFile = false
      }
      if (isFile) body.scriptPath = pathMod.resolve(target)
      else body.name = target
      const args = parsed.flags.get('args')
      if (args !== undefined) body.args = args
      const resume = flagValue<string>(parsed.flags, 'resume-from-run-id')
      if (resume !== undefined) body.resumeFromRunId = resume
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const wait = parsed.flags.get('wait') === true
      const hub = await ctx.hub()
      const summary = await hub.request<WorkflowRunSummary>(
        'POST',
        `/api/workflows/run${wait ? '?wait=1' : ''}`,
        { body: body satisfies WorkflowRunRequest, ...(wait ? { timeoutMs: 0 } : {}) },
      )
      // --wait：终态 failed/aborted 已由 Hub 错误信封转为 CliError 非零退出；
      // 此处只剩 completed。人类模式输出终端摘要行 + result（不把空 result 当成功文本）。
      if (wait && !ctx.json) {
        ctx.io.out(`run ${summary.id} ${summary.status}\n`)
        if (summary.result !== undefined) printValue(ctx.io, summary.result, false)
        return
      }
      printValue(ctx.io, summary, ctx.json)
    },
  })

  cmds.push({
    path: ['workflows', 'runs'],
    description: '列出工作流运行（GET /api/workflows/runs；可选 --current 过滤本会话）',
    flags: [...convFlags],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      if (parsed.positionals.length > 0) throw new CliError(`多余位置参数：${parsed.positionals.join(' ')}（查单个 run 用 helm workflows inspect <runId>）`, 'unexpected_positional')
      let qs = ''
      if (parsed.flags.get('current') === true) {
        const conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
        qs = `?conversationId=${conversationId}`
      }
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<WorkflowRunSummary[]>(`/api/workflows/runs${qs}`), ctx.json)
    },
  })

  cmds.push({
    path: ['workflows', 'inspect'],
    description: '查看工作流运行（GET /api/workflows/runs/:runId）',
    positional: '<runId>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <runId> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.get<WorkflowRunSummary>(`/api/workflows/runs/${encodeURIComponent(id)}`), ctx.json)
    },
  })

  cmds.push({
    path: ['workflows', 'abort'],
    description: '中止工作流运行（POST /api/workflows/runs/:runId/abort）',
    positional: '<runId>',
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      const id = parsed.positionals[0]
      if (id === undefined) throw new CliError('缺少 <runId> 位置参数', 'missing_id')
      const hub = await ctx.hub()
      printValue(ctx.io, await hub.post<unknown>(`/api/workflows/runs/${encodeURIComponent(id)}/abort`), ctx.json)
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
