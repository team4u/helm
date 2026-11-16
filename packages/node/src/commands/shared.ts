/**
 * command layer public base seat: command context contract and across command small assist manually.
 * only dependency cli-context / launcher / control, do not import any specific command module - -
 * keep command file between zero horizontal dependency.
 */
import { UsageError, type NodeCliIo } from '../cli-context.js';
import { readPidRecord } from '../cli-context.js';
import { readNodeIdentity } from '../daemon/index.js';
import path from 'node:path';

/** parse after command line (entry parseCli artifact, command layer only read). */
export interface ParsedCli {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
  help: boolean;
}

/** command context: entry layer build, each command handler consume. */
export interface CommandContext {
  io: NodeCliIo;
  parsed: ParsedCli;
  dataDir: string;
  /** succeeded output (text direct through / JSON serialization + newline). */
  emit: (value: unknown) => void;
}

export const flagString = (parsed: ParsedCli, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** Hub address parse: location/--hub/env HELM_HUB_URL;requireUrl when missing explicit errors. */
export async function resolveHubUrl(io: NodeCliIo, parsed: ParsedCli, requireUrl: boolean): Promise<string> {
  const explicit = flagString(parsed, 'hub');
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = io.env?.['HELM_HUB_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (requireUrl) {
    throw new UsageError('missing Hub address: please provide location parameter <hubUrl>,--hub <url> or environment variable HELM_HUB_URL', 'missing_hub_url');
  }
  return '';
}

/** read identity; missing explicit errors (background/foreground start shared use). */
export async function readNodeIdentityStrict(dataDir: string): Promise<{ nodeId: string; token: string; hubUrl?: string }> {
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) {
    throw new UsageError(
      `not found node identity (${path.join(dataDir, 'node.json')}). please first helm-node connect <hubUrl> --token <token> bind set`,
      'missing_identity',
    );
  }
  return identity;
}

/** query background instance state: control channel OK → real run state; cannot reach → pid store then unknown, otherwise stale. */
export async function statusDaemon(io: NodeCliIo, dataDir: string): Promise<{
  pid: number | null;
  pidAlive: boolean;
  state?: import('../control.js').DaemonReadyState | 'unknown';
  pidStale?: boolean;
  /** daemon real on report run version (only control channel can reach when has). */
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
      detail: `control channel cannot reach (endpoint ${record.endpoint}):pid store but cannot confirm daemon run state`,
    };
  }
  return { pid: record.pid, pidAlive: false, pidStale: true, detail: 'pid file leftover (process already exit) await clean up' };
}

/**
 * stop background daemon: only for via instanceId verify control end point stop(never to any PID
 * signal/keystroke).stop by accept after etc. process real exit only then delete pid file; channel cannot reach but pid
 * store → explicit failed and keep pid;pid indeed already death → by stale clean up.
 */
export async function stopDaemon(io: NodeCliIo, dataDir: string): Promise<{ outcome: 'stopped' | 'stale'; pid: number }> {
  const { controlRequest, CONTROL_STOP_TIMEOUT_MS, STOP_EXIT_TIMEOUT_MS } = await import('../control.js');
  const { isAliveOf, pidPath, removePidFileIfMatch, waitForExit } = await import('../cli-context.js');
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(`not found pid file (${pidPath(dataDir)}): background daemon not in run`, 'not_running');
  }
  const response = await controlRequest(record.endpoint, { type: 'stop', instanceId: record.instanceId }, CONTROL_STOP_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  if (response === null || response.ok !== true) {
    const reason =
      response === null
        ? `control channel cannot reach (endpoint ${record.endpoint})`
        : `control end point reject stop (${response.error ?? 'unknown'},endpoint ${record.endpoint})`;
    if (isAlive(record.pid)) {
      throw new Error(
        `${reason}, and pid ${record.pid} still store: reject to not via identity verify process send signal;pid file already keep (${pidPath(dataDir)}) supply diagnose`,
      );
    }
    // pid indeed already death and Profile not by new instance take over, only then by stale CAS clean up.
    await removePidFileIfMatch(dataDir, record);
    return { outcome: 'stale', pid: record.pid };
  }
  // stop already by accept and complete execute environment clean up: etc. process real exit after only then delete pid file.
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
    throw new Error(
      `stop already by accept but pid ${record.pid} in ${STOP_EXIT_TIMEOUT_MS}ms inside not exit: keep pid file (${pidPath(dataDir)}) supply diagnose`,
    );
  }
  // CAS: only when Profile still points to by stop instance when only then delete (during may already by upgrade/new instance take over).
  await removePidFileIfMatch(dataDir, record);
  return { outcome: 'stopped', pid: record.pid };
}
