/** Proactive local Hub update command (`claude update` semantics: check -> stage -> apply). */
import path from 'node:path'
import { isStrictSemver } from '@helmx/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, parsePositiveInt, type CommandSpec } from './shared.js'

const flags = [
  { name: 'check', type: 'boolean', help: 'check the channel without installing or restarting' },
  { name: 'channel', type: 'string', help: 'npm dist-tag to follow, such as latest or beta' },
  { name: 'version', type: 'string', help: 'install an exact Hub version' },
  { name: 'tarball', type: 'string', help: 'install a local Hub archive with --version' },
  { name: 'force', type: 'boolean', help: 'reinstall, allow a downgrade, or update even when the Hub is busy' },
  { name: 'registry', type: 'string', help: 'override the npm registry' },
  { name: 'port', type: 'string', help: 'local Hub listen port' },
  { name: 'host', type: 'string', help: 'local Hub listen address' },
  { name: 'data-dir', type: 'string', help: 'local Hub data directory' },
  { name: 'model', type: 'string', help: 'local Hub default model' },
  { name: 'web-dist-dir', type: 'string', help: 'local Web assets directory, or false to disable static hosting' },
  { name: 'health-timeout', type: 'string', help: 'Hub readiness timeout in milliseconds' },
] as const satisfies readonly FlagSpec[]

export const updateCommand: CommandSpec = {
  path: ['update'],
  description: 'Update the local Hub payload now and restart it (installs when nothing is committed)',
  flags,
  async run(ctx) {
    const parsed = parseFlags(flags, ctx.args)
    assertNoExtraPositionals(parsed.positionals, 0)
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
    const checkOnly = parsed.flags.get('check') === true
    // Mode-scoped flag validation (mirrors the old mode table): --check is read-only, so target
    // and launch flags are rejected instead of silently ignored.
    const checkAllowed = new Set(['check', 'channel', 'registry', 'json', 'help'])
    if (checkOnly) {
      for (const name of parsed.flags.keys()) {
        if (!checkAllowed.has(name)) {
          throw new CliError(`--${name} is not supported with --check`, 'invalid_option_for_command')
        }
      }
    }

    const { cmdCheck, cmdUpdate, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
    const dataDir = read('data-dir')
    const commandFlags = {
      version,
      tag,
      tarball: tarball === undefined ? undefined : path.resolve(ctx.cwd, tarball),
      registry: read('registry'),
      force: parsed.flags.get('force') === true,
      json: ctx.json,
      port: number('port', 65_535),
      host: read('host'),
      dataDir: dataDir === undefined ? undefined : path.resolve(ctx.cwd, dataDir),
      model: read('model'),
      webDistDir: read('web-dist-dir'),
      healthTimeoutMs: number('health-timeout', 2_147_483_647),
    }
    const launcherCtx = { io: ctx.io, root: resolveInstallRoot(ctx.env), ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}) }
    try {
      return await (checkOnly ? cmdCheck(launcherCtx, commandFlags) : cmdUpdate(launcherCtx, commandFlags))
    } catch (error) {
      if (error instanceof UsageError) throw new CliError(error.message, error.code)
      throw error
    }
  },
}
