/**
 * `helmx-node` upgrade handoff over native Node stdio IPC (CLI side, inside the old daemon).
 *
 * Three-phase protocol:
 * 1) Candidate reports `{ type: 'helmx-node.ready', pid, instanceId, state: 'registered' }`;
 *    `state: 'starting'` is treated as unready (upgrades require live Hub registration).
 * 2) `commit()` atomically writes `node.pid`, sends `{ type: 'helmx-node.activate', ... }`, and
 *    waits for local `{ type: 'helmx-node.activated' }` confirmation (independent of Hub ACK).
 * 3) Post-send confirmation failures fall into two buckets:
 *    - Write failure (message definitely never sent): throws regular Error so the caller rolls back safely;
 *    - Unconfirmed after write (disconnect/timeout/candidate exit): throws `UpgradeCommitUnconfirmedError`
 *      and **never** kills the candidate or rolls back `node.pid`, since the candidate may already have committed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { UpgradeCommitUnconfirmedError, type PreparedNodeReplacement, type StagedNodeRelease } from './upgrader.js';

/** Candidate ready timeout, sized to cover backoff reconnects if the Hub is briefly unreachable. */
export const CANDIDATE_READY_TIMEOUT_MS = 150_000;
/** Timeout waiting for local `helmx-node.activated` ACK after sending `activate`. */
export const ACTIVATE_ACK_TIMEOUT_MS = 30_000;
/** Maximum time a candidate waits for `helmx-node.activate` after reporting ready. */
export const CANDIDATE_ACTIVATE_WAIT_MS = 10 * 60_000;

export interface UpgradeHandoffContext {
  attemptId: string;
  previousVersion: string;
  targetVersion: string;
}

export interface HandoffPidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

export interface PrepareNodeReplacementOptions {
  dataDir: string;
  hubUrl: string;
  logPath: string;
  controlEndpoint(dataDir: string, instanceId: string): string;
  readPidRecord(): Promise<HandoffPidRecord | null>;
  writePidRecord(record: HandoffPidRecord): Promise<void>;
  removePidFile(): Promise<void>;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  readyTimeoutMs?: number;
  activateAckTimeoutMs?: number;
}

export interface ActivateMessage {
  type: 'helmx-node.activate';
  attemptId: string;
  version: string;
  previousVersion: string;
  pid: number;
}

export interface CandidateUpgradeHandoff {
  attemptId: string;
  previousVersion?: string;
  targetVersion?: string;
}

/** Parse upgrade context injected into the candidate's environment (`undefined` for normal daemons). */
export function parseUpgradeHandoffEnv(env: NodeJS.ProcessEnv | undefined): CandidateUpgradeHandoff | undefined {
  const attemptId = env?.['HELMX_NODE_UPGRADE_ATTEMPT'];
  if (attemptId === undefined || attemptId === '') return undefined;
  const previousVersion = env?.['HELMX_NODE_UPGRADE_PREVIOUS_VERSION'];
  const targetVersion = env?.['HELMX_NODE_UPGRADE_TARGET_VERSION'];
  return {
    attemptId,
    ...(previousVersion !== undefined && previousVersion !== '' ? { previousVersion } : {}),
    ...(targetVersion !== undefined && targetVersion !== '' ? { targetVersion } : {}),
  };
}

/** Validate incoming `helmx-node.activate` message on the candidate side. */
export function parseActivateMessage(message: unknown): ActivateMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helmx-node.activate') return undefined;
  const { attemptId, version, previousVersion, pid } = record;
  if (typeof attemptId !== 'string' || attemptId === '') return undefined;
  if (typeof version !== 'string' || version === '') return undefined;
  if (typeof previousVersion !== 'string' || previousVersion === '') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return { type: 'helmx-node.activate', attemptId, version, previousVersion, pid };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Read at most the last 64 KiB of `logFile` and return up to `maxLines` lines. */
export async function readLogTailBounded(logFile: string, maxLines: number): Promise<string> {
  const maxBytes = 64 * 1024;
  try {
    const handle = await fsp.open(logFile, 'r');
    try {
      const size = await handle.stat().then((stat) => stat.size).catch(() => 0);
      const readBytes = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(readBytes);
      if (readBytes > 0) await handle.read(buffer, 0, readBytes, size - readBytes);
      return buffer.toString('utf8').split('\n').filter((line) => line !== '').slice(-maxLines).join('\n');
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return '';
  }
}

/**
 * Spawn a controlled candidate daemon from the staged release, wait for real Hub registration,
 * and return `{ pid, commit, abort }`.
 */
export async function prepareNodeReplacement(
  release: StagedNodeRelease,
  context: UpgradeHandoffContext,
  options: PrepareNodeReplacementOptions,
): Promise<PreparedNodeReplacement> {
  if (options.hubUrl === '') {
    throw new Error('upgrade handoff requires a Hub URL so the candidate daemon can register');
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? CANDIDATE_READY_TIMEOUT_MS;
  const activateAckTimeoutMs = options.activateAckTimeoutMs ?? ACTIVATE_ACK_TIMEOUT_MS;
  const instanceId = randomBytes(16).toString('hex');
  const endpoint = options.controlEndpoint(options.dataDir, instanceId);
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // Isolate candidate control/version env vars and strip NODE_OPTIONS so dev tsx loaders don't leak into compiled releases.
  delete childEnv['HELMX_NODE_INSTANCE_ID'];
  delete childEnv['HELMX_NODE_CONTROL_ENDPOINT'];
  delete childEnv['HELMX_NODE_PENDING_ACTIVATION'];
  delete childEnv['HELMX_VERSION_OVERRIDE'];
  delete childEnv['NODE_OPTIONS'];
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'HELMX_TOKEN') delete childEnv[key];
  }
  childEnv['HELMX_CLI_BIN_DIR'] = release.cliBinDir;
  childEnv['HELMX_NODE_UPGRADE_ATTEMPT'] = context.attemptId;
  childEnv['HELMX_NODE_UPGRADE_PREVIOUS_VERSION'] = context.previousVersion;
  childEnv['HELMX_NODE_UPGRADE_TARGET_VERSION'] = context.targetVersion;
  childEnv['HELMX_NODE_PENDING_ACTIVATION'] = '1';
  childEnv['HELMX_NODE_INSTANCE_ID'] = instanceId;
  childEnv['HELMX_NODE_CONTROL_ENDPOINT'] = endpoint;

  await fsp.mkdir(options.dataDir, { recursive: true });
  let logHandle: fsp.FileHandle;
  try {
    logHandle = await fsp.open(options.logPath, 'a');
  } catch (error) {
    throw new Error(`failed to open candidate log file (${options.logPath}): ${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ChildProcess;
  try {
    child = spawn(options.execPath ?? process.execPath, [release.entryPath, 'start', '--data-dir', options.dataDir, '--hub', options.hubUrl], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`failed to spawn candidate daemon: ${error instanceof Error ? error.message : String(error)}`);
  }

  const killChild = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
    try {
      if (child.connected) child.disconnect();
    } catch {
      // Already disconnected.
    }
    child.unref();
  };

  type ReadyOutcome =
    | { kind: 'ready' }
    | { kind: 'starting' }
    | { kind: 'exit'; code: number | null }
    | { kind: 'error'; error: Error }
    | { kind: 'timeout' };
  const ready = await new Promise<ReadyOutcome>((resolve) => {
    let settled = false;
    const finish = (value: ReadyOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(value);
    };
    const onMessage = (message: unknown): void => {
      if (!isRecord(message) || message['type'] !== 'helmx-node.ready') return;
      if (asString(message['instanceId']) !== instanceId) return;
      if (message['pid'] !== child.pid) return;
      if (message['state'] === 'registered') finish({ kind: 'ready' });
      else if (message['state'] === 'starting') finish({ kind: 'starting' });
    };
    const onError = (error: Error): void => finish({ kind: 'error', error });
    const onExit = (code: number | null): void => finish({ kind: 'exit', code });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), readyTimeoutMs);
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });

  if (ready.kind !== 'ready') {
    killChild();
    await logHandle.close().catch(() => undefined);
    const reason =
      ready.kind === 'starting'
        ? `candidate reported state=starting: upgrade requires state=registered (attemptId ${context.attemptId})`
        : ready.kind === 'error'
          ? `candidate daemon failed to start (spawn error): ${ready.error.message}`
          : ready.kind === 'exit'
            ? `candidate daemon exited immediately after startup (code=${ready.code ?? 'null'})`
            : `candidate did not report registered readiness within ${readyTimeoutMs}ms`;
    const tail = await readLogTailBounded(options.logPath, 40);
    throw new Error(`${reason}${tail !== '' ? `\n--- ${options.logPath} last 40 lines ---\n${tail}` : ''}`);
  }
  if (child.pid === undefined) {
    killChild();
    await logHandle.close().catch(() => undefined);
    throw new Error('candidate pid unavailable after reporting ready (internal error)');
  }
  const candidatePid = child.pid;
  await logHandle.close().catch(() => undefined);
  child.unref();

  type Phase = 'ready' | 'activating' | 'activated' | 'rejected' | 'unsent' | 'lost' | 'dead';
  let phase: Phase = 'ready';
  let activateSent = false;
  /** `undefined` = pending callback, `true` = written to IPC channel, `false` = failed before send. */
  let activateWritten: boolean | undefined;
  let exitWhileWritePending = false;
  let pidWritten = false;
  let oldRecord: HandoffPidRecord | null = null;
  let rejectReason = '';
  let unsentReason = '';
  type AckOutcome = 'activated' | 'rejected' | 'unsent' | 'lost' | 'dead' | 'timeout';
  let settleAck: ((outcome: AckOutcome) => void) | undefined;
  const finishAck = (outcome: AckOutcome): void => {
    if (phase !== 'activating') return;
    phase =
      outcome === 'activated' ? 'activated'
        : outcome === 'rejected' ? 'rejected'
          : outcome === 'unsent' ? 'unsent'
            : outcome === 'dead' ? 'dead'
              : 'lost';
    settleAck?.(outcome);
    settleAck = undefined;
  };
  const onAckMessage = (message: unknown): void => {
    if (!isRecord(message)) return;
    const attempt = asString(message['attemptId']);
    if (attempt !== context.attemptId) return;
    if (message['type'] === 'helmx-node.activated') finishAck('activated');
    else if (message['type'] === 'helmx-node.activate-rejected') {
      rejectReason = asString(message['reason']) ?? 'unknown';
      finishAck('rejected');
    }
  };
  child.on('message', onAckMessage);
  child.once('exit', () => {
    if (phase === 'activating') {
      if (activateWritten === true) finishAck('dead');
      else exitWhileWritePending = true;
    } else if (phase === 'ready') phase = 'dead';
  });

  const commit = async (): Promise<void> => {
    if (phase === 'activated') return;
    if (phase !== 'ready') {
      throw new Error(`candidate is not ready to commit (${phase}${phase === 'dead' ? ': candidate exited or IPC disconnected' : ''}); activate not sent`);
    }
    if (!child.connected) {
      phase = 'dead';
      throw new Error('candidate IPC channel disconnected before activate was sent; rolling back safely');
    }
    oldRecord = await options.readPidRecord();
    await options.writePidRecord({ pid: candidatePid, instanceId, endpoint });
    pidWritten = true;

    phase = 'activating';
    const activate: ActivateMessage = {
      type: 'helmx-node.activate',
      attemptId: context.attemptId,
      version: context.targetVersion,
      previousVersion: context.previousVersion,
      pid: candidatePid,
    };
    const outcome = await new Promise<AckOutcome>((resolve) => {
      settleAck = resolve;
      const timer = setTimeout(() => finishAck('timeout'), activateAckTimeoutMs);
      const originalSettle = settleAck;
      settleAck = (value) => {
        clearTimeout(timer);
        originalSettle(value);
      };
      activateSent = true;
      try {
        child.send(activate, (error) => {
          if (error !== undefined && error !== null) {
            unsentReason = error.message;
            finishAck('unsent');
            return;
          }
          activateWritten = true;
          if (exitWhileWritePending) finishAck('dead');
        });
      } catch (error) {
        unsentReason = error instanceof Error ? error.message : String(error);
        finishAck('unsent');
      }
    });
    if (outcome === 'activated') {
      try {
        if (child.connected) child.disconnect();
      } catch {
        // Already disconnected.
      }
      child.unref();
      return;
    }
    if (outcome === 'rejected') {
      throw new Error(`candidate rejected activation: ${rejectReason} (uncommitted; rolling back safely)`);
    }
    if (outcome === 'unsent') {
      throw new Error(`failed to write activate message to candidate IPC (${unsentReason}; guaranteed undelivered); rolling back safely`);
    }
    if (outcome === 'dead') {
      throw new UpgradeCommitUnconfirmedError('candidate exited before confirming activation (activate was written and may have committed locally); refusing rollback');
    }
    if (outcome === 'timeout') {
      throw new UpgradeCommitUnconfirmedError(`timed out waiting for activated confirmation (${activateAckTimeoutMs}ms; activate was written); refusing rollback`);
    }
    throw new UpgradeCommitUnconfirmedError('activate was written, but local IPC confirmation was lost (channel disconnected); refusing rollback');
  };

  const abort = async (): Promise<void> => {
    if (phase === 'activated') {
      throw new Error('candidate already activated: refusing abort (must not roll back committed replacement)');
    }
    if (activateSent && activateWritten !== false && phase !== 'rejected') {
      throw new Error('activate was sent without an explicit rejection: refusing abort (must not kill candidate or roll back pid)');
    }
    killChild();
    if (pidWritten) {
      const current = await options.readPidRecord().catch(() => null);
      if (current !== null && current.instanceId === instanceId) {
        if (oldRecord !== null) await options.writePidRecord(oldRecord);
        else await options.removePidFile();
      }
    }
  };

  return { pid: candidatePid, commit, abort };
}
