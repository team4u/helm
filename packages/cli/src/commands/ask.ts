/**
 * 一次性问答域：helm ask = 内部创建会话 + 提交输入 + 等待回答。
 * 只复用现有端点（POST /api/conversations + POST .../input?wait=1），不新增 HTTP 面。
 * stdout 默认只输出回答文本（脚本管道友好）；错误保留会话并在错误信封给出可查会话 ID。
 */
import type { ConversationInputResult, ConversationSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, coerceTags, printPlainText, printResult } from './shared.js'

const askFlags: FlagSpec[] = [
  { name: 'profile', type: 'string', help: '使用的 Profile ID' },
  { name: 'title', type: 'string', help: '会话标题（缺省由服务端命名；便于追溯）' },
  { name: 'cwd', type: 'string', help: '会话工作目录（绝对路径）' },
  { name: 'model', type: 'string', help: '显式覆盖模型 provider/model' },
  { name: 'tags', type: 'string', help: '会话标签（JSON 数组或逗号分隔）' },
  { name: 'timeout', type: 'number', help: '等待回答的超时毫秒数（缺省无限等待）' },
  { name: 'delete-on-success', type: 'boolean', help: '成功取得回答后删除会话；任何失败保留诊断会话' },
]

/** 组合 prompt：位置参数与管道 stdin 以空行拼接，空白片段不参与。 */
function combinePrompt(positional: string | undefined, stdinText: string | undefined): string {
  const parts: string[] = []
  if (positional !== undefined && positional.trim() !== '') parts.push(positional)
  if (stdinText !== undefined && stdinText.trim() !== '') parts.push(stdinText)
  return parts.join('\n\n')
}

/**
 * 失败后追加会话去向提示并携带 conversationId（会话已创建即保留，绝不静默清理）。
 * 保留原 code/exitCode，details 合并 conversationId 供脚本消费。
 */
function rethrowWithConversation(err: unknown, conversationId: number, lead: string): never {
  const hint = `${lead}（会话 #${conversationId} 已保留：helm conversations get ${conversationId} 排查 / helm conversations delete ${conversationId} 清理）`
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

/** ConversationInputResult.entry.model -> assistant 回答文本块拼接（防御式解析）。 */
function assistantTextOf(entry: ConversationInputResult['entry'] | undefined): string {
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

export function askCommands(): CommandSpec[] {
  return [
    {
      path: ['ask'],
      description: '一次性问答：内部创建会话、提交输入并等待回答（stdin 管道内容并入 prompt）',
      flags: askFlags,
      positional: '[text]',
      async run(ctx: CommandContext) {
        const parsed = parseFlags(askFlags, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 1)
        const timeoutMs = flagValue<number>(parsed.flags, 'timeout')
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
          throw new CliError(`--timeout 需为正整数毫秒，实得 "${timeoutMs}"`, 'invalid_flag_value')
        }
        // prompt = 位置参数 + 管道 stdin（非 TTY 才读取；二者至少其一，空白不算）
        const stdinText = ctx.io.stdin.isTTY ? undefined : await ctx.io.stdin.readAll()
        const prompt = combinePrompt(parsed.positionals[0], stdinText)
        if (prompt === '') {
          throw new CliError('缺少提问内容：提供 <text> 位置参数，或经 stdin 管道输入', 'empty_input')
        }

        // 1) 创建会话（失败时尚无会话，原样上抛）
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
        if (created === null || typeof created !== 'object' || typeof created.id !== 'number') {
          throw new CliError('Hub 创建会话响应缺 number 字段 id', 'invalid_response')
        }
        const conversationId = created.id

        // 2) 提交并等待回答（whenBusy:reject——全新会话不应有在途回合，忙即显式失败）
        let result: ConversationInputResult
        try {
          result = await hub.request<ConversationInputResult>(
            'POST',
            `/api/conversations/${conversationId}/input?wait=1`,
            { body: { text: prompt, whenBusy: 'reject' }, timeoutMs: timeoutMs ?? 0 },
          )
        } catch (err) {
          rethrowWithConversation(err, conversationId, '')
        }

        // 3) 可选：仅在成功取得回答后删除会话；删除失败保留会话并显式报错
        let deleted = false
        if (parsed.flags.get('delete-on-success') === true) {
          try {
            await hub.delete(`/api/conversations/${conversationId}`)
            deleted = true
          } catch (err) {
            rethrowWithConversation(err, conversationId, '回答已取得，但会话删除失败')
          }
        }

        const answer = assistantTextOf(result?.entry)
        if (ctx.json) {
          printResult(ctx, {
            conversationId,
            submissionId: result?.submissionId,
            entryId: result?.entry?.id,
            answer,
            deleted,
          })
          return
        }
        // 人类模式：stdout 只输出回答文本（空回答输出空，不伪造内容）
        if (answer !== '') printPlainText(ctx, answer)
      },
    },
  ]
}
