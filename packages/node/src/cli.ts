#!/usr/bin/env node
/**
 * helm-node CLI entry (parameter parse + command dispatch).
 *
 * - runNodeCli(argv, io) is unique test/embed entry; directly runtime (argv[1] path
 *   equals this module path, compatibility pnpm bin symlink) only then automatically execute.
 * - command:connect / start / stop / restart / status / upgrade / service install|uninstall|status / --help.
 * - --json global takes effect: succeeded stdout JSON, failed stderr JSON error message seal + non-zero exit code.
 * - background control (across platform, independent of /proc, do not to any PID signal):
 *   . each time background start generate random instanceId;node.pid = { pid, instanceId, endpoint }
 *     (0600 atomic write).daemon child process self hold control IPC(Unix: /tmp/helm-node-<hash>.sock;
 *     Windows: \\.\pipe\helm-node-<hash>), single row JSON ≤4KiB, carries idle timeout, verify
 *     instanceId, only accept status/stop- - never to without closure process send signal or keystroke.
 *   . start -d use Node original generate stdio IPC on report ready (helm-node.ready), child process argv
 *     only `start --data-dir <dir> [--hub <url>]`, without token;token one rule from 0600
 *     node.json read.instanceId/endpoint via HELM_NODE_INSTANCE_ID /
 *     HELM_NODE_CONTROL_ENDPOINT environment variable pass (local machine instance control information, does not enter log).
 *   . stop only for via instanceId verify control end point stop:daemon first complete execute environment
 *     clean up (handle.close) again confirm exit, after only then delete pid file; control channel cannot reach and
 *     pid store when explicit failed and keep pid file;pid indeed already death only then by stale clean up.
 * - start -d with node.start.lock(O_CREAT|O_EXCL) guard against concurrency start, hold lock to pid Profile
 *   complete; leftover lock explicit diagnose, not silently delete.
 * - foreground connect/start register before only output connect in;state=registered only from real
 *   daemon register ACK, not complete is starting; control server only supply background instance start.
 * - upgrade handover: subject to control daemon inject prepareUpgradeReplacement(stdio IPC pull start choose
 *   release,activate/activated local machine commit protocol); control channel upgrade request forwarding to
 *   handle.upgrade(local machine can message source); upgrade after success old daemon latency exit let. choose with
 *   HELM_NODE_UPGRADE_ATTEMPT + pendingActivation start, real registered after keep
 *   IPC etc. activate, receives after validate previousVersion/targetVersion and this time upgrade context
 *   consistent only then confirmUpgrade(inconsistent do not commit and back refuse); activate after handle.close failed also
 *   such as record failed exit code, do not because already activate while swallow wrong.
 * - foreground start(without control env) into is stable launcher: itself keep and cycle trace
 *   node.pid points to when before instance (upgrade swap pid after automatically trace new daemon),SIGTERM/INT
 *   via control channel stop when before instance and wait for stop result set after only then exit - -systemd main PID do not because
 *   old daemon exit while kill the whole cgroup.stop and pid clean up all by instanceId CAS validate.
 *
 * implement layer:cli-context(io/pid Profile),control(control channel),launcher(background
 * start and trace),daemon-process(daemon run body),commands/(each command handler).
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

// history export (test and @helm/node package exit dependency): symbol already migration until layer module, this where keep again export.
export { defaultSpawnDaemon } from './launcher.js';
export { resolveServiceEntry } from './service-entry.js';
export { controlEndpoint, type DaemonReadyState } from './control.js';
export type { NodeCliIo, PidRecord } from './cli-context.js';

const USAGE = `helm-node - helm across platform subject to control node daemon

use method: helm-node <command> [options]

command:
  connect <hubUrl> --token <token>   bind set JOIN token and foreground run (--once only attempt register once)
  start [-d|--daemon]                start daemon (-d background detached, write <dataDir>/node.pid)
  stop                               stop background daemon (via control channel verify identity after graceful stop)
  restart                               after restart stage daemon (first confirm stop succeeded again pull new process)
  status                                output identity bind set state, background process and run state summary
  upgrade [--check] [--version <ver>]   self upgrade (--check only query; execute must managed daemon in run)
  doctor                                zero side effect only read self inspect (identity 0600 / permission / Hub connect through / Herdr IPC)
  service install|uninstall|status   open machine self start service manage (launchd / systemd --user / schtasks)

through use option:
  --token <token>        JOIN token (nodeId:secret)
  --hub <url>            Hub address
  --data-dir <dir>       data directory (by default $HELM_DATA_DIR or ~/.helm)
  --json                 machine can read JSON output
  --once                 connect pattern under only attempt register once i.e. exit
  --version <ver>        upgrade designate target version (strictly SemVer)
  --registry <url>       upgrade npm registry source (by default official or HELM_NPM_REGISTRY)
  --check                upgrade only check available update (do not start daemon, do not upgrade)
  --force                upgrade force (exceeds guard against fall back/cool down phase/same version restrict)
  --help, -h             show help

environment variable: HELM_DATA_DIR(by default ~/.helm). HELM_HUB_URL . HERDR_SOCKET_PATH
`;

const VALUE_FLAGS = ['token', 'hub', 'data-dir', 'version', 'registry'] as const;
const BOOL_FLAGS = ['once', 'help', 'daemon', 'd', 'check', 'force'] as const;
/** each command legal option set; unknown option/redundant location parameter one rule explicit errors. */
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
/** each command location parameter count (connect can carries hubUrl;service exactly a sub- command; the rest 0). */
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
            throw new UsageError(`--${name} missing value`);
          }
          raw = next;
          i += 1;
        }
        flags.set(name, raw);
      } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`unknown option --${name}(helm-node --help view use method)`);
      }
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`unknown option ${token}(helm-node --help view use method)`);
    }
    positional.push(token);
    i += 1;
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags, json, help };
}

/** parse after validate: unknown command, redundant location parameter, do not belongs to the command option all explicit errors. */
function validateCli(parsed: ParsedCli): void {
  if (parsed.help) return;
  if (parsed.command === '') {
    throw new UsageError('missing command (helm-node --help view use method)');
  }
  const allowed = COMMAND_FLAGS[parsed.command];
  if (allowed === undefined) {
    throw new UsageError(`unknown command:helm-node ${parsed.command}(helm-node --help view use method)`, 'unknown_command');
  }
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`command ${parsed.command} unsupported --${name}(helm-node --help view use method)`);
    }
  }
  const range = COMMAND_POSITIONALS[parsed.command]!;
  if (parsed.positional.length < range.min || parsed.positional.length > range.max) {
    throw new UsageError(
      `command ${parsed.command} need to ${range.min === range.max ? String(range.min) : `${range.min}-${range.max}`} location parameter, got ${parsed.positional.length}(helm-node --help view use method)`,
    );
  }
  if (parsed.command === 'service') {
    const action = parsed.positional[0];
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      throw new UsageError(`service need to install|uninstall|status sub- command, got ${JSON.stringify(action ?? '(empty)')}`);
    }
  }
  if (parsed.command === 'upgrade') {
    // --check is pure query: and designate/force execute mutual exclusion, guard against mistakenly solve is check and upgrade.
    if (parsed.flags.get('check') === true && (parsed.flags.get('version') !== undefined || parsed.flags.get('force') === true)) {
      throw new UsageError('upgrade --check and --version/--force mutual exclusion (--check only query do not execute upgrade)');
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

/** directly run decide:argv[1] path === this module path (compatibility pnpm .bin symlink invoke). */
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
