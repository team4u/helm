/** 模型域：models list / default / providers / refresh / filter。 */
import type { ModelCatalog, ModelProviderSummary, ModelProvidersRefreshResult, SetModelFilterBody } from '@helm/protocol'
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

/** models filter flag 声明（--disable 可重复；--clear 置空该 provider 的禁用集）。 */
const FILTER_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: '目标供应商 id（缺省时仅允许清空全部禁用项）' },
  { name: 'disable', type: 'string', repeated: true, help: '禁用的模型 id（可重复；全量替换该 provider 的禁用集）' },
  { name: 'clear', type: 'boolean', help: '清空该 provider 的禁用集（与 --provider 搭配；无 --provider 时清空全部）' },
]

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: '列出可用模型（GET /api/models）',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        const catalog = await hub.get<ModelCatalog>('/api/models')
        printResult(ctx, ctx.json ? catalog : catalog.models)
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
    {
      path: ['models', 'filter'],
      description: '查看或设置模型禁用集（GET/PUT /api/models/filter）',
      flags: FILTER_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(FILTER_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const hub = await ctx.hub()
        const provider = parsed.flags.get('provider') as string | undefined
        const disable = (parsed.flags.get('disable') as string[] | undefined) ?? []
        const clear = parsed.flags.get('clear') === true

        // 读模式：无任何写入 flag，展示当前目录中 disabled 的模型。
        if (provider === undefined && disable.length === 0 && !clear) {
          const catalog = await hub.get<ModelCatalog>('/api/models')
          if (ctx.json) {
            printResult(ctx, catalog)
            return
          }
          const disabled = catalog.models.filter((m) => m.disabled === true)
          printResult(
            ctx,
            disabled.length === 0
              ? '当前没有已禁用的模型'
              : disabled.map((m) => `${m.provider}/${m.modelId}`),
          )
          return
        }

        if (clear && disable.length > 0) {
          throw new CliError('--clear 与 --disable 互斥', 'invalid_flag_value')
        }
        const body: SetModelFilterBody = clear
          ? { ...(provider !== undefined ? { provider } : {}), disabledModels: [] }
          : { ...(provider !== undefined ? { provider } : {}), disabledModels: disable }
        if (provider === undefined && disable.length > 0) {
          throw new CliError('未指定 --provider 时只能清空全部禁用项（不可携带 --disable）', 'invalid_flag_value')
        }
        printResult(ctx, await hub.put<{ ok: boolean; catalog: ModelCatalog }>('/api/models/filter', body))
      },
    },
  ]
}
