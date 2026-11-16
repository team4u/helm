#!/usr/bin/env node
/**
 * helm CLI main entry.
 * - runCli(argv, options) is unique test/embed entry; directly runtime (import.meta.url === argv[1]) only then execute.
 * - command dispatch: core static table takes precedence precise match execute; only when without core match when only then pull /api/actions
 *   build motion state command (now only then do conflict validate and explicit errors). core manage side (plugins disable etc.)
 *   forever do not because broken plugin manifest while unavailable - - fault isolated.
 * - --json global takes effect: succeeded stdout JSON, failed stderr JSON + non-zero exit code.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { CommandContext, CommandSpec } from './commands/index.js'
import { coreCommands } from './commands/index.js'
import { loadDynamicCommands } from './actions.js'
import { HubClient, resolveEndpoint } from './hub-client.js'
import { buildIo, type Io, type RunCliOptions } from './options.js'
import { CliError, describeError, errorEnvelope } from './errors.js'
import { dataDirFor, loadCliCredential } from './credentials.js'

export interface CompletedRun {
  exitCode: number
}

function isDirectRun(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    const self = fileURLToPath(import.meta.url)
    const entry = path.resolve(process.argv[1]!)
    return realpathSync(self) === realpathSync(entry)
  } catch {
    return false
  }
}

function printHelp(
  io: Io,
  core: readonly CommandSpec[],
  dynamic: readonly CommandSpec[],
  diagnostics: readonly string[],
): void {
  io.out('helm - extreme simple durable microkernel person assist CLI(and Web API same right)\n\n')
  io.out('use method: helm <command> [subcommand] [--flags] [--json]\n\n')
  io.out('global option:\n')
  io.out('  --json            machine can read JSON output (stdout; error is stderr + non-zero exit code)\n')
  io.out('  --help, -h        show help\n\n')
  io.out('core command (contains across node execute and original HTTP escape generate cabin):\n')
  for (const cmd of core) {
    const positional = cmd.positional ? ` ${cmd.positional}` : ''
    io.out(`  ${cmd.path.join(' ')}${positional}\n    ${cmd.description}\n`)
    for (const flag of cmd.flags ?? []) {
      const req = flag.required ? '(required)' : ''
      io.out(`    --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
    }
  }
  if (dynamic.length > 0) {
    io.out('\nplugin command (by GET /api/actions motion state generate):\n')
    for (const cmd of dynamic) {
      const positional = cmd.positional ? ` ${cmd.positional}` : ''
      io.out(`  ${cmd.path.join(' ')}${positional}\n    ${cmd.description}\n`)
      for (const flag of cmd.flags ?? []) {
        if (flag.name === 'input' || flag.name === 'current') continue
        io.out(`    --${flag.name} <${flag.type}>${flag.help ? `  ${flag.help}` : ''}\n`)
      }
    }
  } else {
    io.out('\n(when before not get to plugin action command; not start Hub, not login or without available action when such as this)\n')
  }
  io.out('\nenvironment variable: HELM_HUB_URL(by default http://127.0.0.1:3202). HELM_TOKEN . HELM_DATA_DIR(by default ~/.helm). HELM_CONVERSATION_ID(--current)\n')
  io.out('across node: helm nodes list|issue|remove manage compute node;helm env exec --node <id> -- <cmd...> across node direct hold;helm api <method> <path> original HTTP\n')
  for (const d of diagnostics) io.err(`helm: ${d}\n`)
}

/**
 * strip global --json/-h/--help(can appear in any location);`--` after content original keep,
 * by command level parse handle (`send 1 -- --json` should `--json` when text send).
 */
function extractGlobals(argv: readonly string[]): { rest: string[]; json: boolean; help: boolean } {
  const rest: string[] = []
  let json = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (token === '--json') json = true
    else if (token === '--help' || token === '-h') help = true
    else rest.push(token)
  }
  return { rest, json, help }
}

const isOptionLike = (token: string): boolean => token.startsWith('-') && token !== '-' && token !== '--'

/** find precise match command; without precise match when return negative consumed means need to more many sub- command. */
function matchCommand(
  commands: readonly CommandSpec[],
  tokens: readonly string[],
): { command: CommandSpec; consumed: number } | undefined {
  const maxDepth = Math.min(tokens.length, Math.max(...commands.map((c) => c.path.length)))
  // first try most long path (deep command takes precedence, avoid parent path swallow sub- command)
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const exact = commands.filter((c) => c.path.length === prefix.length && c.path.every((seg, i) => seg === prefix[i]))
    if (exact.length > 0) return { command: exact[0]!, consumed: depth }
  }
  // without precise match: try most long public prefix do sub- command hint
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const partial = commands.filter((c) => c.path.length > prefix.length && c.path.slice(0, prefix.length).every((seg, i) => seg === prefix[i]))
    if (partial.length > 0) {
      return { command: partial[0]!, consumed: -1 } // -1 = need to more many sub- command, only errors use
    }
  }
  return undefined
}

function printCommandDetail(io: Io, cmd: CommandSpec): void {
  io.out(`${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}\n  ${cmd.description}\n`)
  for (const flag of cmd.flags ?? []) {
    const req = flag.required ? '(required)' : ''
    io.out(`  --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
  }
}

/**
 * read credentials and build HubClient; credentials corrupt when throws (do not swallow into without credentials).
 * HELM_TOKEN takes precedence: explicit to out when short route disk, do not trigger touch any credentials file.
 */
async function hubFromEnv(env: NodeJS.ProcessEnv, dataDir: string, io: Io): Promise<HubClient> {
  if (env['HELM_TOKEN']) {
    return new HubClient(resolveEndpoint(env, {}), io)
  }
  const credential = await loadCliCredential(dataDir)
  return new HubClient(resolveEndpoint(env, credential), io)
}

export async function runCli(argv: readonly string[] = [], options: RunCliOptions = {}): Promise<number> {
  const io = buildIo(options)
  const { rest, json, help } = extractGlobals(argv)
  const emitError = (described: ReturnType<typeof describeError>): number => {
    if (json) io.err(`${JSON.stringify(errorEnvelope(described))}\n`)
    else io.err(`error: ${described.message}\n`)
    return described.exitCode
  }

  const core = coreCommands()
  const corePaths = core.map((c) => c.path)
  const env = options.env ?? process.env
  const dataDir = dataDirFor(env)

  const makeContext = (): CommandContext => {
    const clientHolder: { client?: HubClient } = {}
    return {
      io,
      env,
      json,
      args: [],
      dataDir,
      cwd: options.cwd ?? process.cwd(),
      async hub() {
        if (!clientHolder.client) clientHolder.client = await hubFromEnv(env, dataDir, io)
        return clientHolder.client
      },
    }
  }

  // static command help also only dependency static declaration,Hub or plugin fault must not drag manage side.
  if (help && rest.length > 0) {
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed > 0) {
      printCommandDetail(io, matched.command)
      return 0
    }
  }

  // help/without command scenario: core help forever available; motion state command and credentials diagnose exhaust force while is, separate present
  if (rest.length === 0 || help) {
    const diagnostics: string[] = []
    let dynamic: CommandSpec[] = []
    const loadDynamic = async (): Promise<CommandSpec[]> => {
      if (dynamic.length > 0) return dynamic
      dynamic = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
      return dynamic
    }
    try {
      await loadDynamic()
    } catch (err) {
      // help must not because Hub/credentials/manifest issue failed: fall back is core help + independent diagnose row (stderr)
      diagnostics.push(`motion state plugin command unavailable:${describeError(err).message}`)
    }
    if (rest.length === 0) {
      // helm --json separate use belongs to illegal combine (help is pure text, do not fabricate JSON output)
      if (json) return emitError(describeError(new CliError('missing command (helm --help view use method)', 'missing_command')))
      printHelp(io, core, dynamic, diagnostics)
      return 0
    }
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed >= 0) {
      const cmd = matched.command
      printCommandDetail(io, cmd)
    } else {
      // non- core command help: exhaust force pull motion state command render its flag note (contains --input fall back note)
      let dynamicMatched: CommandSpec | undefined
      try {
        const dyn = await loadDynamic()
        const dm = matchCommand(dyn, rest)
        if (dm && dm.consumed >= 0) dynamicMatched = dm.command
      } catch (err) {
        diagnostics.push(`motion state plugin command unavailable:${describeError(err).message}`)
      }
      if (dynamicMatched !== undefined) printCommandDetail(io, dynamicMatched)
      else printHelp(io, core, dynamic, diagnostics)
    }
    return 0
  }

  // core command precise match i.e. directly execute (manage side fault isolated).
  // note: do not in this mention before reject need to more many sub- command prefix match - - if broken plugin declaration same name parent path
  // preempt core sub- command (such as motion state ["asks"] obscure core asks list), must in pull manifest after only then can decide,
  // therefore prefix match continue away motion state path and in that in validate.
  const coreMatched = matchCommand(core, rest)
  if (coreMatched !== undefined && coreMatched.consumed > 0) {
    const ctx = makeContext()
    ctx.args = rest.slice(coreMatched.consumed)
    try {
      await coreMatched.command.run(ctx)
      return 0
    } catch (err) {
      return emitError(describeError(err))
    }
  }

  // without core precise match only then parse motion state command (pull /api/actions + conflict validate, illegal explicit errors).
  // note: if store in need to more many sub- command core prefix match (such as helm asks list  asks),
  // motion state parent path declaration may obscure core sub- command - - now must in execute before reject, do not let broken plugin smoke name take over.
  const corePartial = coreMatched !== undefined && coreMatched.consumed < 0 ? coreMatched.command.path : undefined
  let dynamicSpecs: CommandSpec[]
  try {
    dynamicSpecs = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
  } catch (err) {
    return emitError(describeError(err))
  }
  const matched = matchCommand([...core, ...dynamicSpecs], rest)
  if (!matched || matched.consumed < 0) {
    const head = rest.filter((t) => !isOptionLike(t)).slice(0, 2).join(' ')
    return emitError(describeError(new CliError(`unknown command:helm ${head || '(empty)'}(helm --help list available commands)`, 'unknown_command')))
  }
  // motion state command obscure core command (all etc. or prefix): explicit reject, never static default let through smoke name execute
  const isDynamic = !core.some((c) => c === matched.command)
  if (isDynamic && corePartial !== undefined) {
    const joined = matched.command.path.join(' ')
    return emitError(describeError(new CliError(
      `plugin action command "helm ${joined}" preempt core command "helm ${corePartial.join(' ')}" path: reject execute (check plugin cli.command declaration)`,
      'command_conflict',
    )))
  }
  const ctx = makeContext()
  ctx.args = rest.slice(matched.consumed)
  try {
    await matched.command.run(ctx)
    return 0
  } catch (err) {
    return emitError(describeError(err))
  }
}

if (isDirectRun()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
