/** Auth commands: setup / login / status. */
import { existsSync } from 'node:fs'
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
    description: 'View authentication status (GET /api/auth/status) plus the local Hub lifecycle snapshot',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      // auth:'optional': sends any saved token (so Hub reports actual authenticated state), while still allowing unauthenticated status checks
      const res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      // Local Hub snapshot: only when an install root exists on this machine (machines that only
      // drive a remote Hub keep the original shape); the remote answer and the local process
      // view are honest about being different things.
      const { readLocalHubSnapshot, resolveInstallRoot } = await import('../launcher/index.js')
      const installRoot = resolveInstallRoot(ctx.env)
      const snapshot = existsSync(installRoot)
        ? await readLocalHubSnapshot({
            io: { env: ctx.env, out: () => {}, err: () => {} },
            root: installRoot,
            ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}),
          })
        : null
      if (ctx.json) {
        printResult(ctx, { ...res, ...(snapshot !== null ? { localHub: snapshot } : {}) })
        return
      }
      printResult(ctx, res)
      const lines: string[] = []
      if (snapshot !== null && snapshot.current !== null) {
        const running =
          snapshot.running !== null && snapshot.running.alive
            ? `running (pid ${snapshot.running.pid}, ${snapshot.running.version}) on port ${snapshot.running.port}${snapshot.running.healthy ? '' : ' (health probe failed)'}`
            : snapshot.running !== null
              ? 'recorded but not alive (stale pid record)'
              : 'not running'
        lines.push(`local hub:  ${running}`)
        lines.push(`installed:  ${snapshot.current.version} (updated ${snapshot.current.updatedAt})`)
        if (snapshot.blocked !== null) {
          lines.push(`blocked:    ${snapshot.blocked.version} since ${snapshot.blocked.at} (${snapshot.blocked.reason})`)
        }
        lines.push(`log:        ${snapshot.logFile}`)
      } else {
        lines.push('local hub:  not installed (helmx start)')
      }
      ctx.io.out(`${lines.join('\n')}\n`)
    },
  })

  return cmds
}
