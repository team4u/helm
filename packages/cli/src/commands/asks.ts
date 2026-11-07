/** AskDoc 域：asks list / answer / cancel。 */
import type { AskSpec } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requirePositional } from './shared.js'

export function asksCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['asks', 'list'],
    description: '列出待答提问（GET /api/asks）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<AskSpec[]>('/api/asks'))
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
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'answers', type: 'json', required: true },
          { name: 'expected-state-seq', type: 'number' },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const answers = parsed.flags.get('answers')
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new CliError('--answers 需为 JSON 对象（fieldName -> 答案）', 'invalid_flag_value')
      }
      const body: Record<string, unknown> = { answers }
      const seq = flagValue<number>(parsed.flags, 'expected-state-seq')
      if (seq !== undefined) body.expectedStateSeq = seq
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/answer`, body))
    },
  })

  cmds.push({
    path: ['asks', 'cancel'],
    description: '取消提问（POST /api/asks/:id/cancel）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/cancel`))
    },
  })

  return cmds
}
