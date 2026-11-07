/** 鉴权域：setup / login / status。 */
import type { AuthStatus } from '@helm/protocol'
import { parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult, authAndSave, resolvePasswordFlag } from './shared.js'

export function authCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  const passwordFlag = { name: 'password', type: 'string', help: '管理员密码；缺省且 stdin 非 TTY 时读一行' } as const

  cmds.push({
    path: ['setup'],
    description: '初始化管理员密码并登录（POST /api/auth/setup）',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/setup', password)
    },
  })

  cmds.push({
    path: ['login'],
    description: '登录并保存凭据（POST /api/auth/login）',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'password', type: 'string' }], ctx.args)
      const password = await resolvePasswordFlag(ctx, parsed.flags)
      await authAndSave(ctx, '/api/auth/login', password)
    },
  })

  cmds.push({
    path: ['status'],
    description: '查看鉴权状态（GET /api/auth/status）',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      // auth:'optional'：已存 token 附带（Hub 据此回真实 authenticated），无 token 也可探测 configured
      const res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      printResult(ctx, res)
    },
  })

  return cmds
}
