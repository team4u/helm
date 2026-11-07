/** 模型域：models list。 */
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
  ]
}
