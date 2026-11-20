/** OS startup service management for the local Hub (`launchd` / `systemd --user` / `schtasks`). */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOsService, uninstallOsService, getOsServiceStatus, type OsServiceProfile, type OsServiceStatus } from '@helmx/env-io'
import { flagValue, parseFlags } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, requirePositional, type CommandSpec } from './shared.js'

const ACTIONS = ['install', 'uninstall', 'status'] as const
type ServiceAction = (typeof ACTIONS)[number]

/** The `helmx` CLI entrypoint this process runs from (dist/index.js — services need compiled entries). */
function cliSelfEntry(): string {
  return fileURLToPath(import.meta.url)
}

/** Hub service identity and invocation: `helmx start` in the foreground under the OS supervisor. */
function hubServiceProfile(dataDir: string, explicitDataDir?: string): OsServiceProfile {
  return {
    darwinLabel: 'ai.helmx.hub',
    linuxUnit: 'helmx-hub.service',
    winTask: 'HelmxHub',
    description: 'Helmx Hub',
    cliArgs: ['start', ...(explicitDataDir !== undefined && explicitDataDir !== '' ? ['--data-dir', dataDir] : [])],
    logPath: path.join(dataDir, 'hub-service.log'),
  }
}

async function runServiceAction(action: ServiceAction, ctx: Parameters<NonNullable<CommandSpec['run']>>[0], dataDirFlag: string | undefined): Promise<number> {
  const dataDir = dataDirFlag !== undefined ? path.resolve(ctx.cwd, dataDirFlag) : (ctx.env.HELMX_DATA_DIR && ctx.env.HELMX_DATA_DIR !== '' ? ctx.env.HELMX_DATA_DIR : path.join(await import('node:os').then((os) => os.homedir()), '.helmx'))
  const entry = cliSelfEntry()
  if (action === 'install') {
    const result = await installOsService(entry, dataDir, hubServiceProfile(dataDir, dataDirFlag))
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify({ action, ...result }, null, 2)}\n`)
    } else {
      ctx.io.out(`${result.message}\nconfig: ${result.configPath}\n${result.targetPath !== undefined ? `active:  ${result.targetPath}\n` : ''}the service runs "helmx start" (foreground); the OS supervisor restarts it on failure and at login\n`)
    }
    return result.ok ? 0 : 1
  }
  if (action === 'uninstall') {
    const result = await uninstallOsService(entry, dataDir, hubServiceProfile(dataDir))
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify({ action, ...result }, null, 2)}\n`)
    } else {
      ctx.io.out(`${result.message}\n`)
    }
    return result.ok ? 0 : 1
  }
  const status: OsServiceStatus = await getOsServiceStatus(entry, dataDir, hubServiceProfile(dataDir))
  if (ctx.json) {
    ctx.io.out(`${JSON.stringify({ action, ...status }, null, 2)}\n`)
    return 0
  }
  const lines = [
    `platform:  ${status.platform}`,
    `installed: ${status.installed === null ? 'unknown (query failed)' : status.installed ? 'yes' : 'no'}`,
    `running:   ${status.running}`,
    `config:    ${status.configPath}`,
  ]
  if (status.detail !== undefined && status.detail !== '') lines.push(status.detail)
  ctx.io.out(`${lines.join('\n')}\n`)
  return 0
}

export const serviceCommands: CommandSpec[] = [
  {
    path: ['service'],
    description: 'Manage the OS startup service for the local Hub (install | uninstall | status)',
    positional: '<install|uninstall|status>',
    flags: [{ name: 'data-dir', type: 'string', help: 'Hub data directory the service runs with (default ~/.helmx or HELMX_DATA_DIR)' }],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'data-dir', type: 'string' }], ctx.args)
      assertNoExtraPositionals(parsed.positionals, 1)
      const action = requirePositional(parsed.positionals, 0, 'service action (install | uninstall | status)')
      if (!ACTIONS.includes(action as ServiceAction)) {
        throw new CliError(`unknown service action "${action}" (expected install, uninstall, or status)`, 'invalid_argument')
      }
      const value = flagValue<string>(parsed.flags, 'data-dir')
      if (value?.trim() === '') throw new CliError('--data-dir requires a non-empty value', 'invalid_flag_value')
      return await runServiceAction(action as ServiceAction, ctx, value)
    },
  },
]
