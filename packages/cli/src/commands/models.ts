/** model domain:models list / default / providers / refresh / filter. */
import type { ModelCatalog, ModelProviderSummary, ModelProvidersRefreshResult, SetModelFilterBody } from '@helm/protocol'
import { parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, printResult } from './shared.js'
import type { CommandContext, CommandSpec } from './shared.js'

/** models refresh flag declaration (--provider optional single choose;--json by global layer handle). */
const REFRESH_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'only refresh designate provider (default refresh all motion state provider)' },
]

/** models default flag declaration. */
const DEFAULT_FLAGS: readonly FlagSpec[] = [
  { name: 'set', type: 'string', help: 'settings global by default model (provider/model; empty string clear)' },
  { name: 'thinking', type: 'string', help: 'settings global by default think Profile (off/minimal/low/medium/high/xhigh/max; empty string clear)' },
]

/** models filter flag declaration (--disable can duplicate;--clear placement empty the provider disable collection). */
const FILTER_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'target provider id(default when only allows empty all disable items)' },
  { name: 'disable', type: 'string', repeated: true, help: 'disable model id(can duplicate; all amount replace the provider disable collection)' },
  { name: 'clear', type: 'boolean', help: 'empty the provider disable collection (and --provider pair; without --provider when empty all)' },
]

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: 'column out available model (GET /api/models)',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        const catalog = await hub.get<ModelCatalog>('/api/models')
        printResult(ctx, ctx.json ? catalog : catalog.models)
      },
    },
    {
      path: ['models', 'default'],
      description: 'view or settings global by default model and think Profile (GET/PUT /api/models/default)',
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
      description: 'column out PI provider and recognize verify way (GET /api/models/providers)',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<ModelProviderSummary[]>('/api/models/providers'))
      },
    },
    {
      path: ['models', 'refresh'],
      description: 'refresh motion state model directory (POST /api/models/refresh)',
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
      description: 'view or settings model disable collection (GET/PUT /api/models/filter)',
      flags: FILTER_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(FILTER_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const hub = await ctx.hub()
        const provider = parsed.flags.get('provider') as string | undefined
        const disable = (parsed.flags.get('disable') as string[] | undefined) ?? []
        const clear = parsed.flags.get('clear') === true

        // read pattern: without any write flag, render when before directory in disabled model.
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
              ? 'when before no disabled model'
              : disabled.map((m) => `${m.provider}/${m.modelId}`),
          )
          return
        }

        if (clear && disable.length > 0) {
          throw new CliError('--clear and --disable mutual exclusion', 'invalid_flag_value')
        }
        const body: SetModelFilterBody = clear
          ? { ...(provider !== undefined ? { provider } : {}), disabledModels: [] }
          : { ...(provider !== undefined ? { provider } : {}), disabledModels: disable }
        if (provider === undefined && disable.length > 0) {
          throw new CliError('not designate --provider when only can empty all disable items (cannot carry --disable)', 'invalid_flag_value')
        }
        printResult(ctx, await hub.put<{ ok: boolean; catalog: ModelCatalog }>('/api/models/filter', body))
      },
    },
  ]
}
