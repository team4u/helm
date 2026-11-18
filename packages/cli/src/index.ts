#!/usr/bin/env node
/**
 * helm CLI main entry point.
 * - runCli(argv, options) is the sole test/embed entry; direct CLI invocation executes only when import.meta.url === argv[1].
 * - Command dispatch: core static commands match exactly with top priority; /api/actions is fetched to build
 *   dynamic commands only when no core command matches (and conflicts are validated and reported there).
 *   Core management commands (such as `plugins disable`) never break due to a bad plugin manifest — fault-isolated.
 * - --json applies globally: stdout JSON on success, stderr JSON + non-zero exit code on failure.
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
  io.out('helm — minimalist durable microkernel personal assistant CLI (parity with the Web API)\n\n')
  io.out('Usage: helm <command> [subcommand] [--flags] [--json]\n\n')
  io.out('Global options:\n')
  io.out('  --json            machine-readable JSON output (stdout; errors on stderr + non-zero exit code)\n')
  io.out('  --help, -h        show help\n\n')
  io.out('Core commands (including cross-node execution and raw HTTP escape hatch):\n')
  for (const cmd of core) {
    const positional = cmd.positional ? ` ${cmd.positional}` : ''
    io.out(`  ${cmd.path.join(' ')}${positional}\n    ${cmd.description}\n`)
    for (const flag of cmd.flags ?? []) {
      const req = flag.required ? ' (required)' : ''
      io.out(`    --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
    }
  }
  if (dynamic.length > 0) {
    io.out('\nPlugin commands (dynamically generated from GET /api/actions):\n')
    for (const cmd of dynamic) {
      const positional = cmd.positional ? ` ${cmd.positional}` : ''
      io.out(`  ${cmd.path.join(' ')}${positional}\n    ${cmd.description}\n`)
      for (const flag of cmd.flags ?? []) {
        if (flag.name === 'input' || flag.name === 'current') continue
        io.out(`    --${flag.name} <${flag.type}>${flag.help ? `  ${flag.help}` : ''}\n`)
      }
    }
  } else {
    io.out('\n(No plugin action commands fetched; expected when the Hub is stopped, not logged in, or no actions are available)\n')
  }
  io.out('\nEnvironment variables: HELM_HUB_URL (default http://127.0.0.1:3202) · HELM_TOKEN · HELM_DATA_DIR (default ~/.helm) · HELM_CONVERSATION_ID (--current)\n')
  io.out('Cross-node: helm nodes list|issue|remove manage compute nodes; helm env exec --node <id> -- <cmd...> run across nodes; helm api <method> <path> raw HTTP\n')
  for (const d of diagnostics) io.err(`helm: ${d}\n`)
}

/**
 * Strip global --json/-h/--help (allowed at any position); anything after `--` is kept verbatim
 * for command-level parsing (so `send 1 -- --json` sends `--json` as message text).
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

/** Find an exact command match; return negative consumed count when more subcommands are needed. */
function matchCommand(
  commands: readonly CommandSpec[],
  tokens: readonly string[],
): { command: CommandSpec; consumed: number } | undefined {
  const maxDepth = Math.min(tokens.length, Math.max(...commands.map((c) => c.path.length)))
  // Try longest path first (deep commands take precedence so parent paths do not swallow subcommands)
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const exact = commands.filter((c) => c.path.length === prefix.length && c.path.every((seg, i) => seg === prefix[i]))
    if (exact.length > 0) return { command: exact[0]!, consumed: depth }
  }
  // No exact match: try longest common prefix to hint that a subcommand is missing
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const partial = commands.filter((c) => c.path.length > prefix.length && c.path.slice(0, prefix.length).every((seg, i) => seg === prefix[i]))
    if (partial.length > 0) {
      return { command: partial[0]!, consumed: -1 } // -1 = needs more subcommands, used for error reporting only
    }
  }
  return undefined
}

function printCommandDetail(io: Io, cmd: CommandSpec): void {
  io.out(`${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}\n  ${cmd.description}\n`)
  for (const flag of cmd.flags ?? []) {
    const req = flag.required ? ' (required)' : ''
    io.out(`  --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
  }
}

/**
 * Load credentials and build a HubClient; throws on corrupt credentials rather than treating them as missing.
 * HELM_TOKEN takes precedence: when explicitly set, short-circuit disk access without touching credential files.
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

  // Help for static commands depends only on static declarations; Hub/plugin failures must not block management help.
  if (help && rest.length > 0) {
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed > 0) {
      printCommandDetail(io, matched.command)
      return 0
    }
  }

  // Help / bare invocation: core help is always available; dynamic commands and credential diagnostics are best-effort and shown separately
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
      // Help must never fail due to Hub/credential/manifest issues: fall back to core help + separate diagnostic line (stderr)
      diagnostics.push(`dynamic plugin commands unavailable: ${describeError(err).message}`)
    }
    if (rest.length === 0) {
      // Bare `helm --json` is invalid (help is plain text; never fabricate JSON output)
      if (json) return emitError(describeError(new CliError('missing command (run helm --help for usage)', 'missing_command')))
      printHelp(io, core, dynamic, diagnostics)
      return 0
    }
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed >= 0) {
      const cmd = matched.command
      printCommandDetail(io, cmd)
    } else {
      // Non-core command help: best-effort fetch of dynamic commands to show flag help (including --input fallback notes)
      let dynamicMatched: CommandSpec | undefined
      try {
        const dyn = await loadDynamic()
        const dm = matchCommand(dyn, rest)
        if (dm && dm.consumed >= 0) dynamicMatched = dm.command
      } catch (err) {
        diagnostics.push(`dynamic plugin commands unavailable: ${describeError(err).message}`)
      }
      if (dynamicMatched !== undefined) printCommandDetail(io, dynamicMatched)
      else printHelp(io, core, dynamic, diagnostics)
    }
    return 0
  }

  // Execute exact core command match immediately (management plane fault-isolated).
  // Note: do not reject partial subcommand prefix matches here — if a broken plugin registers a parent path
  // shadowing a core subcommand (e.g. dynamic ["asks"] shadowing `asks list`), we must detect and reject it after loading the manifest.
  const coreMatched = matchCommand(core, rest)
  if (coreMatched !== undefined && coreMatched.consumed > 0) {
    const ctx = makeContext()
    ctx.args = rest.slice(coreMatched.consumed)
    try {
      return (await coreMatched.command.run(ctx)) ?? 0
    } catch (err) {
      return emitError(describeError(err))
    }
  }

  // No exact core match: resolve dynamic commands (/api/actions + conflict check; invalid cases fail explicitly).
  // Note: if a core prefix needing more subcommands exists (e.g. `asks` from `helm asks list`),
  // a dynamic parent-path declaration could shadow the core subcommand — reject before execution.
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
    return emitError(describeError(new CliError(`unknown command: helm ${head || '(empty)'} (run helm --help for available commands)`, 'unknown_command')))
  }
  // Dynamic command shadowing a core command (exact or prefix): reject explicitly rather than executing under an alias
  const isDynamic = !core.some((c) => c === matched.command)
  if (isDynamic && corePartial !== undefined) {
    const joined = matched.command.path.join(' ')
    return emitError(describeError(new CliError(
      `plugin action command "helm ${joined}" shadows core command path "helm ${corePartial.join(' ')}": execution refused (check plugin cli.command declaration)`,
      'command_conflict',
    )))
  }
  const ctx = makeContext()
  ctx.args = rest.slice(matched.consumed)
  try {
    return (await matched.command.run(ctx)) ?? 0
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
