/** authentication domain:setup / login / status. */
import type { AuthStatus } from '@helm/protocol'
import { parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult, authAndSave, resolvePasswordFlag } from './shared.js'

export function authCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  const passwordFlag = { name: 'password', type: 'string', help: 'manage member password; default and stdin non- TTY when read one row' } as const

  cmds.push({
    path: ['setup'],
    description: 'initialize manage member password and login (POST /api/auth/setup)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/setup', password)
    },
  })

  cmds.push({
    path: ['login'],
    description: 'login and save credentials (POST /api/auth/login)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/login', password)
    },
  })

  cmds.push({
    path: ['status'],
    description: 'view authentication state (GET /api/auth/status)',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      // auth:'optional': already store token attach carries (Hub based on this back real authenticated), without token also can probe configured
      const res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      printResult(ctx, res)
    },
  })

  return cmds
}
