#!/usr/bin/env node
/**
 * `helm-hub-launcher` CLI: argument parsing and command dispatch for the local Hub launcher.
 *
 * - `runLauncherCli(argv, io, updateCore?)` is the sole testable entrypoint; direct execution is
 *   guarded in `main.ts` (supporting pnpm `.bin` symlinks).
 * - Commands: `check`, `update`, `start`, `stop`, `restart`, `status`, `--help`.
 * - `--json` applies globally: JSON on stdout for success, a JSON error envelope on stderr with
 *   exit code 1.
 * - Unknown options or extra positional arguments fail explicitly (never silently ignored).
 */
import { resolveInstallRoot } from './layout.js';
import { defaultLauncherIo, UsageError, type LauncherIo } from './io.js';
import { resolveUpdateCore, type UpdateCore } from './update-core.js';
import {
  cmdCheck,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUpdate,
  type CommandFlags,
} from './commands.js';

const USAGE = `helm-hub-launcher - stable local launcher and updater for the Helm Hub npm payload

Usage: helm-hub-launcher <command> [options]

Commands:
  check                          Query the registry for the latest payload version (no state changes)
  update                         Stage, commit, and (when running) restart onto a new release with
                                 health-gated rollback; --tarball installs a local payload archive
  start [--port N] [--host H]    Start the committed release detached and wait for readiness
  stop                           Stop the running Hub gracefully (identity-verified, then escalate)
  restart                        Stop (if running) then start
  status                         Show installed/running/blocked state summary

Options:
  --version <ver>        Target payload version for update (strict SemVer; required with --tarball)
  --tarball <path>       Install from a local payload .tgz instead of the registry
  --registry <url>       npm registry (defaults to HELM_NPM_REGISTRY or registry.npmjs.org)
  --force                Bypass same-version no-op, downgrade guard, and blocked cooldown
  --start                Start the Hub after updating even when it was not running
  --port <port>          Hub listen port (default 3202; persisted to launch.json after first start)
  --host <host>          Hub listen address (default 127.0.0.1)
  --data-dir <dir>       Hub data directory (~/.helm by default; user data, never touched here)
  --model <model>        Default model id forwarded to the Hub (HELM_MODEL)
  --web-dist-dir <dir>   Static web dist directory; 'false' disables static hosting
  --health-timeout <ms>  Readiness budget when starting the Hub (default 60000)
  --json                 Machine-readable JSON output
  --help, -h             Show this help

Install layout (program state, strictly separate from Hub user data in ~/.helm):
  <installRoot>/releases/<ver>/<uuid>/   immutable staged payload candidates
  <installRoot>/current.json             committed release pointer
  <installRoot>/update-blocked.json      cooldown marker for a failed candidate
  <installRoot>/hub.pid + logs/hub.log   detached process identity and output

Environment: HELM_HUB_INSTALL_ROOT (default ~/.helm-hub), HELM_PORT, HELM_HOST, HELM_DATA_DIR,
HELM_MODEL, HELM_WEB_DIST_DIR, HELM_NPM_REGISTRY, HELM_PAYLOAD_PACKAGE (default @team4u/helm-hub),
HELM_HUB_BLOCKED_COOLDOWN_MS (default 1800000).

Cross-platform: graceful stop is POSIX-first; on Windows SIGTERM terminates without handlers, so
stop degrades to a short grace period before process-tree escalation (taskkill /F /T).
`;

const VALUE_FLAGS = new Set([
  'version',
  'tarball',
  'registry',
  'port',
  'host',
  'data-dir',
  'model',
  'web-dist-dir',
  'health-timeout',
]);
const BOOL_FLAGS = new Set(['force', 'start', 'json', 'help', 'h']);

/** Allowed options per command (beyond --json/--help); unknown options fail explicitly. */
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  check: new Set(['registry']),
  update: new Set(['version', 'registry', 'tarball', 'force', 'start', 'health-timeout', 'port', 'host', 'data-dir', 'model', 'web-dist-dir']),
  start: new Set(['port', 'host', 'data-dir', 'model', 'web-dist-dir', 'health-timeout']),
  stop: new Set(),
  restart: new Set(['port', 'host', 'data-dir', 'model', 'web-dist-dir', 'health-timeout']),
  status: new Set(),
};
const COMMANDS = new Set(Object.keys(COMMAND_FLAGS));

interface ParsedArgs {
  command: string;
  flags: CommandFlags;
}

function parseIntFlag(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} expects a positive integer (got "${value}")`, 'invalid_flag_value');
  }
  return parsed;
}

export function parseLauncherArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: CommandFlags = {};
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eqIndex = arg.indexOf('=');
    const name = (eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex)).toLowerCase();
    if (name === '') throw new UsageError(`empty option name in "${arg}"`, 'unknown_option');
    const value = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    if (seen.has(name)) throw new UsageError(`duplicate option --${name}`, 'duplicate_option');
    seen.add(name);
    if (VALUE_FLAGS.has(name)) {
      let raw = value;
      if (raw === undefined) {
        i += 1;
        if (i >= argv.length) throw new UsageError(`--${name} expects a value`, 'missing_option_value');
        raw = argv[i]!;
      }
      switch (name) {
        case 'version':
          flags.version = raw;
          break;
        case 'tarball':
          flags.tarball = raw;
          break;
        case 'registry':
          flags.registry = raw;
          break;
        case 'host':
          flags.host = raw;
          break;
        case 'data-dir':
          flags.dataDir = raw;
          break;
        case 'model':
          flags.model = raw;
          break;
        case 'web-dist-dir':
          flags.webDistDir = raw;
          break;
        case 'port':
          flags.port = parseIntFlag('port', raw);
          break;
        case 'health-timeout':
          flags.healthTimeoutMs = parseIntFlag('health-timeout', raw);
          break;
      }
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new UsageError(`--${name} does not take a value`, 'invalid_flag_value');
      switch (name) {
        case 'force':
          flags.force = true;
          break;
        case 'start':
          flags.start = true;
          break;
        case 'json':
          flags.json = true;
          break;
        case 'help':
        case 'h':
          flags.help = true;
          break;
      }
      continue;
    }
    throw new UsageError(`unknown option --${name}`, 'unknown_option');
  }
  if (flags.help !== true) {
    if (positional.length === 0) throw new UsageError(`missing command\n\n${USAGE}`, 'missing_command');
    if (positional.length > 1) {
      throw new UsageError(`unexpected extra arguments: ${positional.slice(1).join(' ')}`, 'unexpected_arguments');
    }
  }
  const command = positional[0] ?? 'help';
  if (flags.help !== true && !COMMANDS.has(command)) {
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`, 'unknown_command');
  }
  if (flags.help !== true) {
    for (const name of seen) {
      const allowed = COMMAND_FLAGS[command]!;
      if (name === 'json' || name === 'help' || name === 'h') continue;
      if (!allowed.has(name)) {
        throw new UsageError(`--${name} is not valid for command "${command}"`, 'invalid_option_for_command');
      }
    }
  }
  return { command, flags };
}

export async function runLauncherCli(
  argv: readonly string[],
  io: LauncherIo = defaultLauncherIo(),
  updateCore?: UpdateCore | null,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseLauncherArgs(argv);
  } catch (error) {
    return emitError(io, error, parsedJsonHints(argv));
  }
  if (parsed.flags.help === true) {
    io.out(USAGE);
    return 0;
  }
  const ctx = {
    io,
    root: resolveInstallRoot(io.env),
    core: updateCore !== undefined ? updateCore : resolveUpdateCore(),
  };
  try {
    switch (parsed.command) {
      case 'check':
        return await cmdCheck(ctx, parsed.flags);
      case 'update':
        return await cmdUpdate(ctx, parsed.flags);
      case 'start':
        return await cmdStart(ctx, parsed.flags);
      case 'stop':
        return await cmdStop(ctx, parsed.flags);
      case 'restart':
        return await cmdRestart(ctx, parsed.flags);
      case 'status':
        return await cmdStatus(ctx, parsed.flags);
      default:
        throw new UsageError(`unknown command "${parsed.command}"`, 'unknown_command');
    }
  } catch (error) {
    return emitError(io, error, parsed.flags.json === true);
  }
}

function parsedJsonHints(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--json' || arg.startsWith('--json='));
}

function emitError(io: LauncherIo, error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsageError ? error.code : 'launcher_error';
  if (json) {
    io.err(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
  } else {
    io.err(`error: ${message}\n`);
  }
  return 1;
}

export { USAGE };
