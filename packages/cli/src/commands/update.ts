import path from 'node:path'
import { isStrictSemver } from '@helmx/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, parsePositiveInt, type CommandSpec } from './shared.js'

const flags = [
  { name: 'check', type: 'boolean', help: 'check the channel without installing or restarting' },
  { name: 'watch', type: 'boolean', help: 'run the local Hub in the foreground with automatic updates (checks every 15 minutes by default)' },
  { name: 'status', type: 'boolean', help: 'show the local Hub installation and process status' },
  { name: 'stop', type: 'boolean', help: 'stop the local Hub when its process identity can be verified' },
  { name: 'channel', type: 'string', help: 'npm dist-tag to follow, such as latest or beta' },
  { name: 'version', type: 'string', help: 'install an exact Hub version' },
  { name: 'tarball', type: 'string', help: 'install a local Hub archive with --version' },
  { name: 'force', type: 'boolean', help: 'reinstall, allow a downgrade, or update even when the Hub is busy' },
  { name: 'registry', type: 'string', help: 'override the npm registry' },
  { name: 'interval-ms', type: 'string', help: 'automatic check interval in milliseconds, with --watch' },
  { name: 'port', type: 'string', help: 'local Hub listen port' },
  { name: 'host', type: 'string', help: 'local Hub listen address' },
  { name: 'data-dir', type: 'string', help: 'local Hub data directory' },
  { name: 'model', type: 'string', help: 'local Hub default model' },
  { name: 'web-dist-dir', type: 'string', help: 'local Web assets directory, or false to disable static hosting' },
  { name: 'health-timeout', type: 'string', help: 'Hub readiness timeout in milliseconds' },
] as const satisfies readonly FlagSpec[]

const modes = ['check', 'watch', 'status', 'stop'] as const
const launchOptions = ['port', 'host', 'data-dir', 'model', 'web-dist-dir', 'health-timeout'] as const
const allowedOptions = {
  check: ['registry', 'channel'],
  watch: ['registry', 'channel', 'interval-ms', ...launchOptions],
  update: ['registry', 'channel', 'version', 'tarball', 'force', ...launchOptions],
  status: [],
  stop: [],
} satisfies Record<string, readonly string[]>

export const updateCommand: CommandSpec = {
  path: ['update'],
  description: 'Install or update the local Helmx Hub (works while the Hub is stopped)',
  flags,
  async run(ctx) {
    const parsed = parseFlags(flags, ctx.args)
    assertNoExtraPositionals(parsed.positionals, 0)
    const selected = modes.filter((mode) => parsed.flags.get(mode) === true)
    if (selected.length > 1) {
      throw new CliError('choose only one of --check, --watch, --status, or --stop', 'conflicting_flags')
    }
    const mode = selected[0] ?? 'update'
    const allowed: readonly string[] = allowedOptions[mode]
    for (const name of parsed.flags.keys()) {
      if (!modes.some((candidate) => candidate === name) && !allowed.includes(name)) {
        throw new CliError(`--${name} is not supported with --${mode}`, 'invalid_option_for_command')
      }
    }
    const read = (name: string): string | undefined => {
      const value = flagValue<string>(parsed.flags, name)
      if (value?.trim() === '') throw new CliError(`--${name} requires a non-empty value`, 'invalid_flag_value')
      return value
    }
    const number = (name: string, max: number): number | undefined => {
      const value = read(name)
      if (value === undefined) return undefined
      const result = parsePositiveInt(value, `--${name}`, 'invalid_flag_value')
      if (result > max) throw new CliError(`--${name} must be at most ${max}`, 'invalid_flag_value')
      return result
    }
    const version = read('version')
    const tag = read('channel')
    const tarball = read('tarball')
    if (version !== undefined && !isStrictSemver(version)) {
      throw new CliError('--version requires strict SemVer, such as 1.2.3', 'invalid_version')
    }
    if (tarball !== undefined && version === undefined) {
      throw new CliError('--tarball requires --version', 'tarball_requires_version')
    }
    if (tag !== undefined && version !== undefined) {
      throw new CliError('--channel and --version are mutually exclusive', 'conflicting_flags')
    }

    const { cmdCheck, cmdRun, cmdStatus, cmdStop, cmdUpdate, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
    const handlers = { check: cmdCheck, watch: cmdRun, status: cmdStatus, stop: cmdStop, update: cmdUpdate }
    const dataDir = read('data-dir')
    try {
      return await handlers[mode]({ io: ctx.io, root: resolveInstallRoot(ctx.env), fetchFn: ctx.io.fetchImpl }, {
        version,
        tag,
        tarball: tarball === undefined ? undefined : path.resolve(ctx.cwd, tarball),
        registry: read('registry'),
        force: parsed.flags.get('force') === true,
        json: ctx.json,
        intervalMs: number('interval-ms', 2_147_483_647),
        port: number('port', 65_535),
        host: read('host'),
        dataDir: dataDir === undefined ? undefined : path.resolve(ctx.cwd, dataDir),
        model: read('model'),
        webDistDir: read('web-dist-dir'),
        healthTimeoutMs: number('health-timeout', 2_147_483_647),
      })
    } catch (error) {
      if (error instanceof UsageError) throw new CliError(error.message, error.code)
      throw error
    }
  },
}
