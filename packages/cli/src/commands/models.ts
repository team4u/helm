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

/** models default flag 声明。 */
const DEFAULT_FLAGS: readonly FlagSpec[] = [
  { name: 'set', type: 'string', help: '设置全局默认模型（provider/model；空串清除）' },
  { name: 'thinking', type: 'string', help: '设置全局默认思考档位（off/minimal/low/medium/high/xhigh/max；空串清除）' },
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
      path: ['models', 'default'],
      description: '查看或设置全局默认模型与思考档位（GET/PUT /api/models/default）',
      flags: DEFAULT_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(DEFAULT_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const hub = await ctx.hub()
        const set = parsed.flags.get('set') as string | undefined
        const thinking = parsed.flags.get('thinking') as string | undefined
        if (set === undefined && thinking === undefined) {
          printResult(ctx, await hub.get<{ defaultModel: string; defaultThinkingLevel: string }>('/api/models/default'))
          return
        }
        printResult(ctx, await hub.put<{ ok: boolean; defaultModel: string; defaultThinkingLevel: string }>('/api/models/default', {
          ...(set !== undefined ? { model: set } : {}),
          ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
        }))
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
