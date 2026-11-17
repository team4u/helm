#!/usr/bin/env node
/**
 * `helm-node` CLI entrypoint (argument parsing and command dispatch).
 *
 * - `runNodeCli(argv, io)` is the sole testable/embeddable entrypoint; direct execution runs only
 *   when `argv[1]` resolves to this module (supporting pnpm `.bin` symlinks).
 * - Commands: `connect`, `start`, `stop`, `restart`, `status`, `upgrade`, `doctor`, `service`, `--help`.
 * - `--json` applies globally: JSON on stdout for success, JSON error envelope on stderr with exit code 1.
 * - Background control uses a per-instance IPC endpoint (`pid + instanceId + endpoint` in `node.pid`)
 *   instead of blindly sending signals to arbitrary PIDs.
 * - `start -d` reports readiness over native Node stdio IPC (`helm-node.ready`) and reads tokens from
 *   `0600` `node.json` (never passing tokens in argv).
 * - Foreground `start` without control env vars acts as a stable launcher (for systemd/launchd),
 *   tracking `node.pid` across upgrade handoffs and stopping the active instance cleanly on SIGTERM/SIGINT.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { UsageError, type NodeCliIo } from './cli-context.js';
import { resolveServiceEntry } from './service-entry.js';
import { defaultSpawnDaemon } from './launcher.js';
import { COMMANDS } from './commands/index.js';
import type { ParsedCli } from './commands/shared.js';

// Re-exported for tests and `@helm/node` consumers after modularization.
export { defaultSpawnDaemon } from './launcher.js';
export { resolveServiceEntry } from './service-entry.js';
export { controlEndpoint, type DaemonReadyState } from './control.js';
export type { NodeCliIo, PidRecord } from './cli-context.js';

const USAGE = `helm-node - cross-platform managed node daemon for helm

Usage: helm-node <command> [options]

Commands:
  connect <hubUrl> --token <token>      Bind JOIN token and run in foreground (--once exits after one attempt)
  start [-d|--daemon]                   Start daemon (-d runs detached in background, writing <dataDir>/node.pid)
  stop                                  Stop background daemon gracefully via verified control channel
  restart                               Restart background daemon (stops cleanly before starting replacement)
  status                                Show identity binding, background process, and runtime state summary
  upgrade [--check] [--version <ver>]   Self-upgrade (--check only queries; executing requires a managed daemon)
  doctor                                Read-only diagnostics (identity 0600 / privileges / Hub reachability / Herdr IPC)
  service install|uninstall|status      Manage OS startup service (launchd / systemd --user / schtasks)

Options:
  --token <token>        JOIN token (nodeId:secret)
  --hub <url>            Hub URL
  --data-dir <dir>       Data directory (defaults to $HELM_DATA_DIR or ~/.helm)
  --json                 Machine-readable JSON output
  --once                 In connect mode, exit immediately after the first registration attempt
  --version <ver>        Target version for upgrade (strict SemVer)
  --registry <url>       npm registry URL for upgrade (defaults to official or HELM_NPM_REGISTRY)
  --check                Check available updates without starting a daemon or upgrading
  --force                Force upgrade (bypass downgrade guard, cooldown, and same-version check)
  --help, -h             Show this help

Environment variables: HELM_DATA_DIR (default ~/.helm), HELM_HUB_URL, HERDR_SOCKET_PATH
`;

const VALUE_FLAGS = ['token', 'hub', 'data-dir', 'version', 'registry'] as const;
const BOOL_FLAGS = ['once', 'help', 'daemon', 'd', 'check', 'force'] as const;
/** Allowed options per command; unknown options or extra positional arguments fail explicitly. */
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  connect: new Set(['token', 'hub', 'data-dir', 'json', 'once']),
  start: new Set(['token', 'hub', 'data-dir', 'json', 'daemon', 'd']),
  stop: new Set(['data-dir', 'json']),
  restart: new Set(['hub', 'data-dir', 'json']),
  status: new Set(['data-dir', 'json']),
  upgrade: new Set(['version', 'registry', 'check', 'force', 'data-dir', 'json']),
  doctor: new Set(['hub', 'data-dir', 'json']),
  service: new Set(['hub', 'data-dir', 'json']),
};
/** Expected positional argument counts per command. */
const COMMAND_POSITIONALS: Record<string, { min: number; max: number }> = {
  connect: { min: 1, max: 1 },
  start: { min: 0, max: 0 },
  stop: { min: 0, max: 0 },
  restart: { min: 0, max: 0 },
  status: { min: 0, max: 0 },
  upgrade: { min: 0, max: 0 },
  doctor: { min: 0, max: 0 },
  service: { min: 1, max: 1 },
};

function parseCli(argv: readonly string[]): ParsedCli {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let json = false;
  let help = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      i += 1;
      continue;
    }
    if (token === '-d') {
      flags.set('daemon', true);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        let raw = eq === -1 ? undefined : token.slice(eq + 1);
        if (raw === undefined || raw === '') {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            throw new UsageError(`--${name} requires a value`);
          }
          raw = next;
          i += 1;
        }
        flags.set(name, raw);
      } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`unknown option --${name} (run helm-node --help for usage)`);
      }
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`unknown option ${token} (run helm-node --help for usage)`);
    }
    positional.push(token);
    i += 1;
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags, json, help };
}

/** Validate parsed CLI command, allowed flags, positional counts, and mutual exclusions. */
function validateCli(parsed: ParsedCli): void {
  if (parsed.help) return;
  if (parsed.command === '') {
    throw new UsageError('missing command (run helm-node --help for usage)');
  }
  const allowed = COMMAND_FLAGS[parsed.command];
  if (allowed === undefined) {
    throw new UsageError(`unknown command: helm-node ${parsed.command} (run helm-node --help for usage)`, 'unknown_command');
  }
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`command ${parsed.command} does not support --${name} (run helm-node --help for usage)`);
    }
  }
  const range = COMMAND_POSITIONALS[parsed.command]!;
  if (parsed.positional.length < range.min || parsed.positional.length > range.max) {
    throw new UsageError(
      `command ${parsed.command} expects ${range.min === range.max ? String(range.min) : `${range.min}-${range.max}`} positional argument(s), got ${parsed.positional.length} (run helm-node --help for usage)`,
    );
  }
  if (parsed.command === 'service') {
    const action = parsed.positional[0];
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      throw new UsageError(`service requires subcommand install|uninstall|status, got ${JSON.stringify(action ?? '(empty)')}`);
    }
  }
  if (parsed.command === 'upgrade') {
    // `--check` is read-only; forbid combining with `--version` or `--force` to avoid ambiguity.
    if (parsed.flags.get('check') === true && (parsed.flags.get('version') !== undefined || parsed.flags.get('force') === true)) {
      throw new UsageError('upgrade --check is mutually exclusive with --version and --force (--check only queries)');
    }
  }
}

export async function runNodeCli(argv: readonly string[] = [], ioInput: Partial<NodeCliIo> = {}): Promise<number> {
  const io: NodeCliIo = {
    env: ioInput.env ?? process.env,
    out: ioInput.out ?? ((text) => process.stdout.write(text)),
    err: ioInput.err ?? ((text) => process.stderr.write(text)),
    spawnDaemon: ioInput.spawnDaemon,
    isAlive: ioInput.isAlive,
    ...(ioInput.readyTimeoutMs !== undefined ? { readyTimeoutMs: ioInput.readyTimeoutMs } : {}),
    ...(ioInput.serviceEntry !== undefined ? { serviceEntry: ioInput.serviceEntry } : {}),
  };
  const emit = (value: unknown): void => {
    io.out(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
    validateCli(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'usage_error';
    if (argv.includes('--json')) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  }

  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }

  const { resolveNodeDataDir } = await import('./daemon/index.js');
  const dataDir = resolveNodeDataDir(
    (typeof parsed.flags.get('data-dir') === 'string' ? (parsed.flags.get('data-dir') as string) : undefined) ??
      io.env?.['HELM_DATA_DIR'],
  );

  const emitError = (message: string, code: string): number => {
    if (parsed.json) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  };

  const handler = COMMANDS[parsed.command]!;
  try {
    return await handler({ io, parsed, dataDir, emit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'internal_error';
    return emitError(message, code);
  }
}

/** Returns true when `entryArgv` resolves to this module (supporting pnpm `.bin` symlinks). */
export function isDirectRun(entryArgv = process.argv[1]): boolean {
  if (entryArgv === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(entryArgv));
    return self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runNodeCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
