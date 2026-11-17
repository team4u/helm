/** Full-text search command: search <query>. */
import { parseFlags } from '../args.js'
import { CliError } from '../errors.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult } from './shared.js'

export function searchCommands(): CommandSpec[] {
  return [
    {
      path: ['search'],
      description: 'Full-text search across conversations (GET /api/search?q=)',
      positional: '<query>',
      async run(ctx: CommandContext) {
        const parsed = parseFlags([], ctx.args)
        const query = parsed.positionals.join(' ')
        if (!query) throw new CliError('missing <query> positional argument', 'missing_query')
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<unknown[]>(`/api/search?q=${encodeURIComponent(query)}`))
      },
    },
  ]
}
