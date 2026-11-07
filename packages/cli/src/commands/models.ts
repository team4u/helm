/** 模型域：models list / providers。 */
import type { ModelProviderSummary } from '@helm/protocol'
import { parseNoFlags, printResult } from './shared.js'
import type { CommandContext, CommandSpec } from './shared.js'

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: '列出可用模型（GET /api/models）',
      async run(ctx: CommandContext) {
        parseNoFlags(ctx)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<unknown[]>('/api/models'))
      },
    },
    {
      path: ['models', 'providers'],
      description: '列出 PI 供应商与认证方式（GET /api/models/providers）',
      async run(ctx: CommandContext) {
        parseNoFlags(ctx)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<ModelProviderSummary[]>('/api/models/providers'))
      },
    },
  ]
}
