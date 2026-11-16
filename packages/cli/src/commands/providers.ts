/** model gateway and server side credentials domain:providers list/set,credentials list/set/delete. */
import type { CredentialSummary, ProviderConfig } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parseNoFlags, printResult, requireJsonInput, requirePositional } from './shared.js'

export function providersCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['providers', 'list'],
    description: 'column out model gateway (GET /api/providers)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ProviderConfig[]>('/api/providers'))
    },
  })

  cmds.push({
    path: ['providers', 'set'],
    description: 'whole replace model gateway list (PUT /api/providers; complete array, strictly forbidden contains secret key)',
    flags: [{ name: 'input', type: 'json', required: true, help: 'ProviderConfig[] JSON' }],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      const input = requireJsonInput(parsed.flags)
      if (!Array.isArray(input)) throw new CliError('--input must be complete JSON array (ProviderConfig[])', 'invalid_flag_value')
      const hub = await ctx.hub()
      printResult(ctx, await hub.put<ProviderConfig[]>('/api/providers', input))
    },
  })

  cmds.push({
    path: ['credentials', 'list'],
    description: 'column out server side credentials (GET /api/credentials; only keys and configured)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<CredentialSummary[]>('/api/credentials'))
    },
  })

  cmds.push({
    path: ['credentials', 'set'],
    description: 'write server side credentials (PUT /api/credentials/:id; plaintext do not back read)',
    flags: [{ name: 'value', type: 'string', required: true }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'value', type: 'string', required: true }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.put<unknown>(`/api/credentials/${encodeURIComponent(id)}`, { value: flagValue<string>(parsed.flags, 'value') }))
    },
  })

  cmds.push({
    path: ['credentials', 'delete'],
    description: 'delete server side credentials (DELETE /api/credentials/:id)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/credentials/${encodeURIComponent(id)}`))
    },
  })

  return cmds
}
