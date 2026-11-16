/**
 * helm-node upgrade handover IPC(CLI side, run in old daemon process inside).
 *
 * protocol (Node original generate stdio IPC, single channel three phase):
 *  1) choose real registered after on report {type:'helm-node.ready', pid, instanceId,
 *     state:'registered'};state is starting one rule treated as not ready (upgrade want seek real
 *     register, disallows carries illness commit);
 *  2) commit() is unique commit point: first atomic write new node.pid(memory backup old record), again
 *     {type:'helm-node.activate', attemptId, version, previousVersion, pid},
 *     etc. choose local machine {type:'helm-node.activated'} confirm only then resolve- -Hub ACK do not act
 *     is local machine IPC succeeded condition (choose side confirmUpgrade local persisted after async retry Hub);
 *  3) activate out after confirm lose two class:
 *     - failed to write (send throws/call back carries wrong) = determine not send reach: choose never may activate or
 *       to Hub commit, throw ordinary error away security rollback (abort kill choose + CAS restore old pid,
 *       old host continue service), do not 10 minute pendingActivation empty window;
 *     - already write but back hold lose (disconnect/timeout/choose exit) = send reach state unknown: only throw
 *       UpgradeCommitUnconfirmedError, never kill choose, never rollback pid- - choose
 *       may already to Hub on report commit, reverse rollback will let already succeeded upgrade by undo.
 *
 * determinism uncommitted (choose explicit activate-rejected,activate failed to write, or activate
 * not yet out any failed) only then allows abort(): kill self has child and by instanceId CAS
 * restore old pid; Profile already by other person take over when do not motion (never mistakenly delete other person node.pid).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { UpgradeCommitUnconfirmedError, type PreparedNodeReplacement, type StagedNodeRelease } from './upgrader.js';

/** choose ready pre- compute: override Hub short temporary cannot reach when count time backoff reconnect (and choose side register wait for same amount level). */
export const CANDIDATE_READY_TIMEOUT_MS = 150_000;
/** activate out after wait for local machine activated confirm pre- compute. */
export const ACTIVATE_ACK_TIMEOUT_MS = 30_000;
/** choose wait for activate total pre- compute (parent process commit point in arrange empty after, this in take wide headroom cap). */
export const CANDIDATE_ACTIVATE_WAIT_MS = 10 * 60_000;

/** upgrade handover context (and engine prepareReplacement call back context same source). */
export interface UpgradeHandoffContext {
  attemptId: string;
  previousVersion: string;
  targetVersion: string;
}

/** pid Profile content (and cli.ts  PidRecord structure consistent, avoid loop dependency separate declaration). */
export interface HandoffPidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

export interface PrepareNodeReplacementOptions {
  dataDir: string;
  hubUrl: string;
  /** choose log point (and daemon shared use node.log). */
  logPath: string;
  controlEndpoint(dataDir: string, instanceId: string): string;
  readPidRecord(): Promise<HandoffPidRecord | null>;
  writePidRecord(record: HandoffPidRecord): Promise<void>;
  removePidFile(): Promise<void>;
  /** choose basis environment (default process.env; test can inject). */
  env?: NodeJS.ProcessEnv;
  /** node can execute (default process.execPath; test inject). */
  execPath?: string;
  readyTimeoutMs?: number;
  activateAckTimeoutMs?: number;
}
/** choose side protocol message (and parent side commit() out ActivateMessage the same contract). */
export interface ActivateMessage {
  type: 'helm-node.activate';
  attemptId: string;
  version: string;
  previousVersion: string;
  pid: number;
}

/** choose start env inject upgrade context (prepareNodeReplacement write, choose process parse). */
export interface CandidateUpgradeHandoff {
  attemptId: string;
  previousVersion?: string;
  targetVersion?: string;
}

/**
 * choose side parse start env inject upgrade context:HELM_NODE_UPGRADE_ATTEMPT missing i.e.
 * non- choose (return undefined);previousVersion/targetVersion optional pass-through.
 */
export function parseUpgradeHandoffEnv(env: NodeJS.ProcessEnv | undefined): CandidateUpgradeHandoff | undefined {
  const attemptId = env?.['HELM_NODE_UPGRADE_ATTEMPT'];
  if (attemptId === undefined || attemptId === '') return undefined;
  const previousVersion = env?.['HELM_NODE_UPGRADE_PREVIOUS_VERSION'];
  const targetVersion = env?.['HELM_NODE_UPGRADE_TARGET_VERSION'];
  return {
    attemptId,
    ...(previousVersion !== undefined && previousVersion !== '' ? { previousVersion } : {}),
    ...(targetVersion !== undefined && targetVersion !== '' ? { targetVersion } : {}),
  };
}

/** activate message boundary validate (choose side): complete commit context, field missing/type illegal one rule reject. */
export function parseActivateMessage(message: unknown): ActivateMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helm-node.activate') return undefined;
  const { attemptId, version, previousVersion, pid } = record;
  if (typeof attemptId !== 'string' || attemptId === '') return undefined;
  if (typeof version !== 'string' || version === '') return undefined;
  if (typeof previousVersion !== 'string' || previousVersion === '') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return { type: 'helm-node.activate', attemptId, version, previousVersion, pid };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** has boundary log tail read: only read file tail at most 64KiB, again take finally maxLines row (log again large also do not all amount read). */
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
 * prepare replace daemon: with subject to control background way pull start choose release entry (without tsx loader, all new
 * instanceId/endpoint, do not inherit parent control env, clean HELM_VERSION_OVERRIDE), choose real
 * registered after return {pid, commit, abort}.native stdio IPC keep to local machine commit complete.
 */
export async function prepareNodeReplacement(
  release: StagedNodeRelease,
  context: UpgradeHandoffContext,
  options: PrepareNodeReplacementOptions,
): Promise<PreparedNodeReplacement> {
  if (options.hubUrl === '') {
    throw new Error('upgrade handover need to Hub address (choose daemon based on this register)');
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? CANDIDATE_READY_TIMEOUT_MS;
  const activateAckTimeoutMs = options.activateAckTimeoutMs ?? ACTIVATE_ACK_TIMEOUT_MS;
  const instanceId = randomBytes(16).toString('hex');
  const endpoint = options.controlEndpoint(options.dataDir, instanceId);
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // choose own independent control identity: do not re- use parent instanceId/endpoint; clean version override ensure on report
  // real run version; remove NODE_OPTIONS guard against dev parent process to compile artifact inject tsx loader.
  delete childEnv['HELM_NODE_INSTANCE_ID'];
  delete childEnv['HELM_NODE_CONTROL_ENDPOINT'];
  delete childEnv['HELM_NODE_PENDING_ACTIVATION'];
  delete childEnv['HELM_VERSION_OVERRIDE'];
  delete childEnv['NODE_OPTIONS'];
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'HELM_TOKEN') delete childEnv[key];
  }
  childEnv['HELM_CLI_BIN_DIR'] = release.cliBinDir;
  childEnv['HELM_NODE_UPGRADE_ATTEMPT'] = context.attemptId;
  childEnv['HELM_NODE_UPGRADE_PREVIOUS_VERSION'] = context.previousVersion;
  childEnv['HELM_NODE_UPGRADE_TARGET_VERSION'] = context.targetVersion;
  childEnv['HELM_NODE_PENDING_ACTIVATION'] = '1';
  childEnv['HELM_NODE_INSTANCE_ID'] = instanceId;
  childEnv['HELM_NODE_CONTROL_ENDPOINT'] = endpoint;

  await fsp.mkdir(options.dataDir, { recursive: true });
  let logHandle: fsp.FileHandle;
  try {
    logHandle = await fsp.open(options.logPath, 'a');
  } catch (error) {
    throw new Error(`open choose log file failed (${options.logPath}):${error instanceof Error ? error.message : String(error)}`);
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
    throw new Error(`choose daemon spawn failed:${error instanceof Error ? error.message : String(error)}`);
  }

  const killChild = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exit.
    }
    try {
      if (child.connected) child.disconnect();
    } catch {
      // disconnected.
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
      if (!isRecord(message) || message['type'] !== 'helm-node.ready') return;
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
        ? `choose on report starting: upgrade want seek real registered(attemptId ${context.attemptId}), reject carries illness commit`
        : ready.kind === 'error'
          ? `choose daemon failed to start (spawn error):${ready.error.message}`
          : ready.kind === 'exit'
            ? `choose daemon after startup immediately exit (code=${ready.code ?? 'null'})`
            : `choose ${readyTimeoutMs}ms inside not on report registered ready`;
    const tail = await readLogTailBounded(options.logPath, 40);
    throw new Error(`${reason}${tail !== '' ? `\n--- ${options.logPath} finally 40 row ---\n${tail}` : ''}`);
  }
  if (child.pid === undefined) {
    killChild();
    await logHandle.close().catch(() => undefined);
    throw new Error('choose ready after pid unavailable (internal error)');
  }
  const candidatePid = child.pid;
  // parent side log fd already dup enter child process: choose store during hold has write end, parent side can close.
  await logHandle.close().catch(() => undefined);
  child.unref();

  // - - activate/ack state machine - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  type Phase = 'ready' | 'activating' | 'activated' | 'rejected' | 'unsent' | 'lost' | 'dead';
  let phase: Phase = 'ready';
  let activateSent = false;
  /** activate write result:undefined= not out or call back not back;true= already write channel;false= failed to write (determine not send reach). */
  let activateWritten: boolean | undefined;
  /** write call back not back when choose exit: etc. call back set (failed→unsent; succeeded→dead). */
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
    if (message['type'] === 'helm-node.activated') finishAck('activated');
    else if (message['type'] === 'helm-node.activate-rejected') {
      rejectReason = asString(message['reason']) ?? 'unknown';
      finishAck('rejected');
    }
  };
  child.on('message', onAckMessage);
  child.once('exit', () => {
    if (phase === 'activating') {
      // write result not back when do not immediately set: channel close will trigger send call back (failed→unsent
      // security rollback; succeeded→dead by not confirm handle); already write then directly by choose exit handle.
      if (activateWritten === true) finishAck('dead');
      else exitWhileWritePending = true;
    } else if (phase === 'ready') phase = 'dead';
  });
  // disconnect do not directly set is lost: channel close will trigger send call back to out determine write result
  //(failed→unsent; succeeded→etc. activated or timeout by not confirm handle), avoid determine not
  // send reach mistakenly archive send reach state unknown while abandon fast rollback.

  const commit = async (): Promise<void> => {
    if (phase === 'activated') return; // idempotent
    if (phase !== 'ready') {
      throw new Error(`choose do not in can commit state (${phase}${phase === 'dead' ? ': choose already exit or IPC channel disconnect' : ''}),activate not out`);
    }
    if (!child.connected) {
      phase = 'dead';
      throw new Error('choose IPC channel disconnected (activate not out, security rollback)');
    }
    // commit point before rhythm: backup old Profile and atomic write new record; old record used to abort  CAS restore.
    oldRecord = await options.readPidRecord();
    await options.writePidRecord({ pid: candidatePid, instanceId, endpoint });
    pidWritten = true;

    phase = 'activating';
    const activate: ActivateMessage = {
      type: 'helm-node.activate',
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
          // write result set: failed = determine not send reach (unsent, security rollback); succeeded but choose
          // already exit = by not confirm handle (may committed after crash).
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
        finishAck('unsent'); // sync throws: message not written channel, determine not send reach
      }
    });
    if (outcome === 'activated') {
      try {
        if (child.connected) child.disconnect();
      } catch {
        // disconnected.
      }
      child.unref();
      return;
    }
    if (outcome === 'rejected') {
      throw new Error(`choose reject activate:${rejectReason}(uncommitted, security rollback)`);
    }
    if (outcome === 'unsent') {
      throw new Error(`activate write choose IPC channel failed (${unsentReason}, determine not send reach, choose cannot can committed), security rollback`);
    }
    if (outcome === 'dead') {
      throw new UpgradeCommitUnconfirmedError(`choose in activate confirm before exit (activate already write, may completed local machine commit), do not rollback`);
    }
    if (outcome === 'timeout') {
      throw new UpgradeCommitUnconfirmedError(`wait for activated confirm timeout (${activateAckTimeoutMs}ms,activate already write), do not rollback`);
    }
    throw new UpgradeCommitUnconfirmedError('activate already write but local machine IPC confirm lose (channel disconnect), do not rollback');
  };

  const abort = async (): Promise<void> => {
    if (phase === 'activated') {
      throw new Error('choose already activate: reject abort(must not rollback committed replace)');
    }
    // activate already write channel (send reach state unknown or already send reach) and not received explicit reject: reject
    // abort. failed to write (unsent) and explicit reject the same belongs to determine inactive, allows security rollback.
    if (activateSent && activateWritten !== false && phase !== 'rejected') {
      throw new Error('activate already out and not received explicit reject: reject abort(must not kill choose or rollback pid)');
    }
    killChild();
    if (pidWritten) {
      // instanceId CAS: only Profile still points to this choose when only then restore, already by other person take over then do not motion.
      const current = await options.readPidRecord().catch(() => null);
      if (current !== null && current.instanceId === instanceId) {
        if (oldRecord !== null) await options.writePidRecord(oldRecord);
        else await options.removePidFile();
      }
    }
  };

  return { pid: candidatePid, commit, abort };
}
