/** Auth commands: setup / login / status. */
import type { AuthStatus } from '@helmx/protocol'
import { parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult, authAndSave, resolvePasswordFlag } from './shared.js'

export function authCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  const passwordFlag = { name: 'password', type: 'string', help: 'admin password; reads a line from stdin when omitted and stdin is not a TTY' } as const

  cmds.push({
    path: ['setup'],
    description: 'Initialize the admin password and log in (POST /api/auth/setup)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/setup', password)
    },
  })

  cmds.push({
    path: ['login'],
    description: 'Log in and save credentials (POST /api/auth/login)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/login', password)
    },
  })

  cmds.push({
    path: ['status'],
    description: 'View authentication status (GET /api/auth/status)',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      // auth:'optional': sends any saved token (so Hub reports actual authenticated state), while still allowing unauthenticated status checks
      const res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      printResult(ctx, res)
    },
  })

  return cmds
}
