/**
 * Shared command-layer context and cross-command helpers.
 * Depends only on `cli-context`, `control`, and `daemon`, keeping command handlers decoupled.
 */
import { UsageError, type NodeCliIo } from '../cli-context.js';
import { readPidRecord } from '../cli-context.js';
import { readNodeIdentity } from '../daemon/index.js';
import path from 'node:path';

/** Parsed CLI arguments produced by `parseCli`. */
export interface ParsedCli {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
  help: boolean;
}

/** Command handler execution context. */
export interface CommandContext {
  io: NodeCliIo;
  parsed: ParsedCli;
  dataDir: string;
  /** Emit output (raw string or pretty-printed JSON followed by a newline). */
  emit: (value: unknown) => void;
}

export const flagString = (parsed: ParsedCli, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** Resolve Hub URL from `--hub` or `HELMX_HUB_URL`; throws `missing_hub_url` when `requireUrl` is true. */
export async function resolveHubUrl(io: NodeCliIo, parsed: ParsedCli, requireUrl: boolean): Promise<string> {
  const explicit = flagString(parsed, 'hub');
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = io.env?.['HELMX_HUB_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (requireUrl) {
    throw new UsageError('missing Hub URL: pass positional <hubUrl>, --hub <url>, or HELMX_HUB_URL', 'missing_hub_url');
  }
  return '';
}

/** Read bound node identity, throwing `missing_identity` if absent. */
export async function readNodeIdentityStrict(dataDir: string): Promise<{ nodeId: string; token: string; hubUrl?: string }> {
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) {
    throw new UsageError(
      `node identity not found (${path.join(dataDir, 'node.json')}); bind one first with helmx-node connect <hubUrl> --token <token>`,
      'missing_identity',
    );
  }
  return identity;
}

/** Query background instance status via the control channel, falling back to PID liveness / stale state. */
export async function statusDaemon(io: NodeCliIo, dataDir: string): Promise<{
  pid: number | null;
  pidAlive: boolean;
  state?: import('../control.js').DaemonReadyState | 'unknown';
  pidStale?: boolean;
  /** Running version reported by the daemon over the control channel. */
  version?: string;
  detail?: string;
}> {
  const { controlRequest, CONTROL_TIMEOUT_MS } = await import('../control.js');
  const { isAliveOf } = await import('../cli-context.js');
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) return { pid: null, pidAlive: false };
  const response = await controlRequest(record.endpoint, { type: 'status', instanceId: record.instanceId }, CONTROL_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  if (response !== null && response.ok === true) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: response.state === 'registered' ? 'registered' : 'starting',
      version: typeof response.version === 'string' && response.version !== '' ? response.version : undefined,
    };
  }
  if (isAlive(record.pid)) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: 'unknown',
      detail: `control channel unreachable (endpoint ${record.endpoint}): pid is alive but daemon state cannot be verified`,
    };
  }
  return { pid: record.pid, pidAlive: false, pidStale: true, detail: 'stale pid file (process already exited) awaiting cleanup' };
}

/**
 * Stop the background daemon via the instanceId-verified control endpoint (never sends signals to
 * unverified PIDs). Cleans up `node.pid` via CAS only after confirming process exit or stale death.
 */
export async function stopDaemon(io: NodeCliIo, dataDir: string): Promise<{ outcome: 'stopped' | 'stale'; pid: number }> {
  const { controlRequest, CONTROL_STOP_TIMEOUT_MS, STOP_EXIT_TIMEOUT_MS } = await import('../control.js');
  const { isAliveOf, pidPath, removePidFileIfMatch, waitForExit } = await import('../cli-context.js');
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(`pid file not found (${pidPath(dataDir)}): background daemon is not running`, 'not_running');
  }
  const response = await controlRequest(record.endpoint, { type: 'stop', instanceId: record.instanceId }, CONTROL_STOP_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  if (response === null || response.ok !== true) {
    const reason =
      response === null
        ? `control channel unreachable (endpoint ${record.endpoint})`
        : `control endpoint rejected stop (${response.error ?? 'unknown'}, endpoint ${record.endpoint})`;
    if (isAlive(record.pid)) {
      throw new Error(
        `${reason}, and pid ${record.pid} is still alive: refusing to signal an unverified process; pid file preserved (${pidPath(dataDir)}) for diagnostics`,
      );
    }
    // Process is confirmed dead and `node.pid` was not taken over; clean up as stale via CAS.
    await removePidFileIfMatch(dataDir, record);
    return { outcome: 'stale', pid: record.pid };
  }
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
    throw new Error(
      `stop was accepted, but pid ${record.pid} did not exit within ${STOP_EXIT_TIMEOUT_MS}ms: preserving pid file (${pidPath(dataDir)}) for diagnostics`,
    );
  }
  await removePidFileIfMatch(dataDir, record);
  return { outcome: 'stopped', pid: record.pid };
}
