/** 模型网关与服务端凭据域：providers list/set、credentials list/set/delete。 */
import type { CredentialSummary, ProviderConfig } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parseNoFlags, printResult, requireJsonInput, requirePositional } from './shared.js'

export function providersCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['providers', 'list'],
    description: '列出模型网关（GET /api/providers）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ProviderConfig[]>('/api/providers'))
    },
  })

  cmds.push({
    path: ['providers', 'set'],
    description: '整体替换模型网关列表（PUT /api/providers；完整数组，严禁含密钥）',
    flags: [{ name: 'input', type: 'json', required: true, help: 'ProviderConfig[] JSON' }],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      const input = requireJsonInput(parsed.flags)
      if (!Array.isArray(input)) throw new CliError('--input 需为完整 JSON 数组（ProviderConfig[]）', 'invalid_flag_value')
      const hub = await ctx.hub()
      printResult(ctx, await hub.put<ProviderConfig[]>('/api/providers', input))
    },
  })

  cmds.push({
    path: ['credentials', 'list'],
    description: '列出服务端凭据（GET /api/credentials；仅 keys 与 configured）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<CredentialSummary[]>('/api/credentials'))
    },
  })

  cmds.push({
    path: ['credentials', 'set'],
    description: '写入服务端凭据（PUT /api/credentials/:id；明文不回读）',
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
    description: '删除服务端凭据（DELETE /api/credentials/:id）',
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
