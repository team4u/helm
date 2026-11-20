/** Local Hub lifecycle commands: start / stop / restart (mirrors `helmx-node start -d` semantics). */
import path from 'node:path'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, parsePositiveInt, type CommandSpec } from './shared.js'

const launchFlags = [
  { name: 'port', type: 'string', help: 'local Hub listen port' },
  { name: 'host', type: 'string', help: 'local Hub listen address' },
  { name: 'data-dir', type: 'string', help: 'local Hub data directory' },
  { name: 'model', type: 'string', help: 'local Hub default model' },
  { name: 'web-dist-dir', type: 'string', help: 'local Web assets directory, or false to disable static hosting' },
  { name: 'health-timeout', type: 'string', help: 'Hub readiness timeout in milliseconds' },
] as const satisfies readonly FlagSpec[]

const read = (flags: Map<string, unknown>, name: string): string | undefined => {
  const value = flagValue<string>(flags, name)
  if (value?.trim() === '') throw new CliError(`--${name} requires a non-empty value`, 'invalid_flag_value')
  return value
}

const number = (flags: Map<string, unknown>, name: string, max: number): number | undefined => {
  const value = read(flags, name)
  if (value === undefined) return undefined
  const result = parsePositiveInt(value, `--${name}`, 'invalid_flag_value')
  if (result > max) throw new CliError(`--${name} must be at most ${max}`, 'invalid_flag_value')
  return result
}

const dataDirOf = (flags: Map<string, unknown>, cwd: string): string | undefined => {
  const value = read(flags, 'data-dir')
  return value === undefined ? undefined : path.resolve(cwd, value)
}

export const startCommands: CommandSpec[] = [
  {
    path: ['start'],
    description: 'Start the local Helmx Hub (installs the payload first when nothing is committed yet)',
    flags: [
      { name: 'detached', type: 'boolean', help: 'run in the background (-d; default: foreground with Ctrl+C to stop)' },
      { name: 'channel', type: 'string', help: 'npm dist-tag used for the bootstrap install (default latest)' },
      { name: 'registry', type: 'string', help: 'override the npm registry' },
      ...launchFlags,
    ],
    async run(ctx) {
      // `-d` alias (mirrors `helmx-node start -d`): translate before strict long-flag parsing.
      const argv = ctx.args.map((token) => (token === '-d' ? '--detached' : token))
      const parsed = parseFlags(
        [
          { name: 'detached', type: 'boolean', help: '' },
          { name: 'channel', type: 'string', help: '' },
          { name: 'registry', type: 'string', help: '' },
          ...launchFlags,
        ],
        argv,
      )
      assertNoExtraPositionals(parsed.positionals, 0)
      const { cmdStart, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
      try {
        return await cmdStart(
          { io: ctx.io, root: resolveInstallRoot(ctx.env), ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}) },
          {
            detached: parsed.flags.get('detached') === true,
            tag: read(parsed.flags, 'channel'),
            registry: read(parsed.flags, 'registry'),
            json: ctx.json,
            port: number(parsed.flags, 'port', 65_535),
            host: read(parsed.flags, 'host'),
            dataDir: dataDirOf(parsed.flags, ctx.cwd),
            model: read(parsed.flags, 'model'),
            webDistDir: read(parsed.flags, 'web-dist-dir'),
            healthTimeoutMs: number(parsed.flags, 'health-timeout', 2_147_483_647),
          },
        )
      } catch (error) {
        if (error instanceof UsageError) throw new CliError(error.message, error.code)
        throw error
      }
    },
  },
  {
    path: ['stop'],
    description: 'Stop the local Hub gracefully (verified control channel first, pid identity proof fallback)',
    flags: [],
    async run(ctx) {
      const parsed = parseFlags([], ctx.args)
      assertNoExtraPositionals(parsed.positionals, 0)
      const { cmdStop, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
      try {
        return await cmdStop({ io: ctx.io, root: resolveInstallRoot(ctx.env) }, { json: ctx.json })
      } catch (error) {
        if (error instanceof UsageError) throw new CliError(error.message, error.code)
        throw error
      }
    },
  },
  {
    path: ['restart'],
    description: 'Restart the local Hub (graceful stop, then start detached with the sticky launch configuration)',
    flags: [
      { name: 'channel', type: 'string', help: 'npm dist-tag used for a bootstrap install when none is committed' },
      { name: 'registry', type: 'string', help: 'override the npm registry' },
      ...launchFlags,
    ],
    async run(ctx) {
      const parsed = parseFlags(
        [
          { name: 'channel', type: 'string', help: '' },
          { name: 'registry', type: 'string', help: '' },
          ...launchFlags,
        ],
        ctx.args,
      )
      assertNoExtraPositionals(parsed.positionals, 0)
      const { cmdRestart, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
      try {
        return await cmdRestart(
          { io: ctx.io, root: resolveInstallRoot(ctx.env), ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}) },
          {
            tag: read(parsed.flags, 'channel'),
            registry: read(parsed.flags, 'registry'),
            json: ctx.json,
            port: number(parsed.flags, 'port', 65_535),
            host: read(parsed.flags, 'host'),
            dataDir: dataDirOf(parsed.flags, ctx.cwd),
            model: read(parsed.flags, 'model'),
            webDistDir: read(parsed.flags, 'web-dist-dir'),
            healthTimeoutMs: number(parsed.flags, 'health-timeout', 2_147_483_647),
          },
        )
      } catch (error) {
        if (error instanceof UsageError) throw new CliError(error.message, error.code)
        throw error
      }
    },
  },
]
