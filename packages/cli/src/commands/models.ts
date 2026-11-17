/** Model commands: models list / default / providers / refresh / filter. */
import type { ModelCatalog, ModelProviderSummary, ModelProvidersRefreshResult, SetModelFilterBody } from '@helm/protocol'
import { parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, printResult } from './shared.js'
import type { CommandContext, CommandSpec } from './shared.js'

/** Flag specs for models refresh (--provider is optional; --json is handled globally). */
const REFRESH_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'refresh only the specified provider (defaults to all dynamic providers)' },
]

/** Flag specs for models default. */
const DEFAULT_FLAGS: readonly FlagSpec[] = [
  { name: 'set', type: 'string', help: 'set global default model (provider/model; empty string to clear)' },
  { name: 'thinking', type: 'string', help: 'set global default thinking level (off/minimal/low/medium/high/xhigh/max; empty string to clear)' },
  { name: 'compaction', type: 'string', help: 'set global compaction model (provider/model; empty string to clear)' },
]

/** Flag specs for models filter (--disable is repeatable; --clear empties the provider's disabled list). */
const FILTER_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'target provider ID (only omitted when clearing all disabled entries)' },
  { name: 'disable', type: 'string', repeated: true, help: 'model ID to disable (repeatable; replaces the full disabled list for that provider)' },
  { name: 'clear', type: 'boolean', help: 'clear the disabled list for that provider (with --provider; clears all if omitted)' },
]

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: 'List available models (GET /api/models)',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        const catalog = await hub.get<ModelCatalog>('/api/models')
        printResult(ctx, ctx.json ? catalog : catalog.models)
      },
    },
    {
      path: ['models', 'default'],
      description: 'View or set global default model, thinking level, and compaction model (GET/PUT /api/models/default)',
      flags: DEFAULT_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(DEFAULT_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const hub = await ctx.hub()
        const set = parsed.flags.get('set') as string | undefined
        const thinking = parsed.flags.get('thinking') as string | undefined
        const compaction = parsed.flags.get('compaction') as string | undefined
        if (set === undefined && thinking === undefined && compaction === undefined) {
          printResult(
            ctx,
            await hub.get<{ defaultModel: string; defaultThinkingLevel: string; defaultCompactionModel: string }>('/api/models/default'),
          )
          return
        }
        printResult(
          ctx,
          await hub.put<{ ok: boolean; defaultModel: string; defaultThinkingLevel: string; defaultCompactionModel: string }>(
            '/api/models/default',
            {
              ...(set !== undefined ? { model: set } : {}),
              ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
              ...(compaction !== undefined ? { compactionModel: compaction } : {}),
            },
          ),
        )
      },
    },
    {
      path: ['models', 'providers'],
      description: 'List Pi providers and authentication methods (GET /api/models/providers)',
      async run(ctx: CommandContext) {
        parseFlags([], ctx.args)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<ModelProviderSummary[]>('/api/models/providers'))
      },
    },
    {
      path: ['models', 'refresh'],
      description: 'Refresh dynamic model catalog (POST /api/models/refresh)',
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
      description: 'View or set disabled models (GET/PUT /api/models/filter)',
      flags: FILTER_FLAGS,
      async run(ctx: CommandContext) {
        const parsed = parseFlags(FILTER_FLAGS, ctx.args)
        assertNoExtraPositionals(parsed.positionals, 0)
        const hub = await ctx.hub()
        const provider = parsed.flags.get('provider') as string | undefined
        const disable = (parsed.flags.get('disable') as string[] | undefined) ?? []
        const clear = parsed.flags.get('clear') === true

        // Read mode: without any write flags, display disabled models from the current catalog.
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
              ? 'no disabled models'
              : disabled.map((m) => `${m.provider}/${m.modelId}`),
          )
          return
        }

        if (clear && disable.length > 0) {
          throw new CliError('--clear and --disable are mutually exclusive', 'invalid_flag_value')
        }
        const body: SetModelFilterBody = clear
          ? { ...(provider !== undefined ? { provider } : {}), disabledModels: [] }
          : { ...(provider !== undefined ? { provider } : {}), disabledModels: disable }
        if (provider === undefined && disable.length > 0) {
          throw new CliError('without --provider, only clearing all disabled entries is supported (cannot pass --disable)', 'invalid_flag_value')
        }
        printResult(ctx, await hub.put<{ ok: boolean; catalog: ModelCatalog }>('/api/models/filter', body))
      },
    },
  ]
}
