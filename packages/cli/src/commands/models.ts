/** 模型域：models list / providers / refresh。 */
import type { ModelProviderSummary, ModelProvidersRefreshResult } from '@helm/protocol'
import { parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, printResult } from './shared.js'
import type { CommandContext, CommandSpec } from './shared.js'

/** models refresh flag 声明（--provider 可选单选；--json 由全局层处理）。 */
const REFRESH_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: '仅刷新指定供应商（缺省刷新全部动态供应商）' },
]

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: '列出可用模型（GET /api/models）',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<unknown[]>('/api/models'))
      },
    },
    {
      path: ['models', 'providers'],
      description: '列出 PI 供应商与认证方式（GET /api/models/providers）',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<ModelProviderSummary[]>('/api/models/providers'))
      },
    },
    {
      path: ['models', 'refresh'],
      description: '刷新动态模型目录（POST /api/models/refresh）',
      flags: REFRESH_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(REFRESH_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const provider = parsed.flags.get('provider') as string | undefined
        const hub = await ctx.hub()
        const result = await hub.post<ModelProvidersRefreshResult>('/api/models/refresh', {
          ...(provider !== undefined ? { provider } : {}),
        })
        printResult(ctx, result)
      },
    },
  ]
}
