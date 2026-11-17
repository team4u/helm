/**
 * Daemon runtime loop shared by foreground `connect` and controlled background `start`:
 * - Prints "connecting" before registration completes; "registered" is reported only after Hub ACK.
 * - In controlled mode (`control`), starts the control IPC server before connecting so `status`
 *   works even before registration, reports readiness over stdio IPC (`helm-node.ready`), and on
 *   `stop` aborts, awaits `handle.close()`, replies, and closes the control server.
 * - In upgrade candidate mode (`HELM_NODE_PENDING_ACTIVATION`), holds parent stdio IPC after
 *   registration until `helm-node.activate` arrives and passes context validation (`awaitActivate`).
 * - Always cleans up `handle`, control server, and signal listeners on exit.
 */
import process from 'node:process';
import { logPathOf, readPidRecord, writePidRecord, removePidFile, type NodeCliIo } from './cli-context.js';
import {
  controlEndpoint,
  createControlServer,
  type ControlServer,
  type DaemonReadyState,
  UPGRADE_EXIT_DELAY_MS,
} from './control.js';
import {
  CANDIDATE_ACTIVATE_WAIT_MS,
  parseActivateMessage,
  parseUpgradeHandoffEnv,
  prepareNodeReplacement,
  type ActivateMessage,
  type CandidateUpgradeHandoff,
} from './daemon/upgrade-handoff.js';

/** Lazy type alias for the daemon handle so entry-layer code does not statically pull in `daemon/index`. */
type DaemonHandle = Awaited<ReturnType<(typeof import('./daemon/index.js'))['runNodeDaemonHandle']>>;

/** Hook SIGINT/SIGTERM to `controller.abort()` and return a cleanup callback. */
function forwardSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

/** Report readiness to the parent process; candidates keep IPC open until activation completes. */
function reportReady(control: { instanceId: string } | undefined, pendingActivation: boolean, state: DaemonReadyState): void {
  if (control === undefined || process.send === undefined) return;
  try {
    process.send({
      type: 'helm-node.ready',
      pid: process.pid,
      instanceId: control.instanceId,
      state,
    } satisfies { type: 'helm-node.ready'; pid: number; instanceId: string; state: DaemonReadyState });
  } catch {
    // Parent IPC channel already closed; normal controlled instances keep running and reconnecting.
  }
  if (!pendingActivation) {
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

type ActivateCheck = { kind: 'accept' } | { kind: 'reject'; reason: string; abort: boolean };

/** Verify that the activate message's PID, attemptId, and version context match this candidate process. */
function checkActivate(activate: ActivateMessage, handoff: CandidateUpgradeHandoff, selfPid: number): ActivateCheck {
  if (activate.pid !== selfPid || (handoff.attemptId !== undefined && activate.attemptId !== handoff.attemptId)) {
    return { kind: 'reject', reason: 'activate context does not match this candidate process', abort: false };
  }
  if (
    handoff.previousVersion === undefined ||
    handoff.targetVersion === undefined ||
    activate.previousVersion !== handoff.previousVersion ||
    activate.version !== handoff.targetVersion
  ) {
    return {
      kind: 'reject',
      abort: true, // Context mismatch: never commit; exit so the parent rolls back safely.
      reason:
        `upgrade context mismatch: activate previousVersion=${activate.previousVersion} version=${activate.version}, ` +
        `candidate env previousVersion=${handoff.previousVersion ?? '(missing)'} targetVersion=${handoff.targetVersion ?? '(missing)'}`,
    };
  }
  return { kind: 'accept' };
}

/** Notify parent that activation was rejected (best-effort; ignored if parent disconnected). */
function sendRejected(attemptId: string, reason: string): void {
  try {
    process.send?.({ type: 'helm-node.activate-rejected', attemptId, reason });
  } catch {
    // Parent disconnected.
  }
}

/** Call `confirmUpgrade` locally, notify parent `activated`, and detach parent IPC. */
async function confirmAndDetach(handle: DaemonHandle | undefined, activate: ActivateMessage, abort: () => void): Promise<void> {
  try {
    if (handle !== undefined) {
      await handle.confirmUpgrade({
        attemptId: activate.attemptId,
        version: activate.version,
        previousVersion: activate.previousVersion,
        pid: activate.pid,
      });
    }
    try {
      process.send?.({ type: 'helm-node.activated', attemptId: activate.attemptId });
    } catch {
      // Parent lost the ACK, but local activation succeeded; candidate stays alive and retries Hub commit.
    }
    // Detach parent IPC so the parent exiting cannot affect the newly activated candidate.
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // Already disconnected.
    }
  } catch (error) {
    sendRejected(activate.attemptId, error instanceof Error ? error.message : String(error));
    abort(); // confirmUpgrade failed: candidate exits so parent rolls back safely.
  }
}

/**
 * Wait for `helm-node.activate` in candidate mode; rejects on parent disconnect or timeout so an
 * unactivated candidate exits instead of claiming success to the Hub.
 */
function awaitActivate(handle: DaemonHandle | undefined, handoff: CandidateUpgradeHandoff, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string): void => {
      cleanup();
      reject(new Error(`candidate failed waiting for activation: ${reason} (unactivated candidate exiting)`));
    };
    const onMessage = (message: unknown): void => {
      const activate = parseActivateMessage(message);
      if (activate === undefined) return;
      const check = checkActivate(activate, handoff, process.pid);
      if (check.kind === 'reject') {
        cleanup();
        sendRejected(activate.attemptId, check.reason);
        if (check.abort) controller.abort();
        resolve();
        return;
      }
      cleanup();
      void confirmAndDetach(handle, activate, () => controller.abort());
      resolve();
    };
    const onDisconnect = (): void => fail('parent IPC channel disconnected');
    const timer = setTimeout(() => fail(`activation wait timed out (${CANDIDATE_ACTIVATE_WAIT_MS}ms)`), CANDIDATE_ACTIVATE_WAIT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

/** Prefetch the daemon's own package version for synchronous `status` reporting; returns undefined on failure. */
async function prefetchNodeVersion(): Promise<string | undefined> {
  try {
    const { getNodeVersion } = await import('./daemon/upgrader.js');
    return getNodeVersion();
  } catch {
    return undefined;
  }
}

/** Start the per-instance control server before connecting so `status` is available immediately. */
async function setupControlServer(args: {
  control: { instanceId: string; endpoint: string };
  handle: () => DaemonHandle | undefined;
  daemonState: () => DaemonReadyState;
  controller: AbortController;
  detachSignals: () => void;
  isUpgrading: () => boolean;
}): Promise<ControlServer> {
  let reportedVersion: string | undefined;
  const server = createControlServer({
    endpoint: args.control.endpoint,
    instanceId: args.control.instanceId,
    onStatus: () => ({
      pid: process.pid,
      state: args.daemonState(),
      ...(reportedVersion !== undefined ? { version: reportedVersion } : {}),
    }),
    onStop: async (): Promise<void> => {
      args.controller.abort();
      const handle = args.handle();
      if (handle !== undefined) await handle.close();
    },
    onUpgrade: (input: unknown): Promise<unknown> => {
      const handle = args.handle();
      if (handle === undefined) return Promise.reject(new Error('daemon not ready; rejecting upgrade request'));
      const record = (input ?? {}) as Record<string, unknown>;
      return handle.upgrade(
        {
          ...(typeof record['targetVersion'] === 'string' ? { targetVersion: record['targetVersion'] } : {}),
          ...(typeof record['registryUrl'] === 'string' ? { registryUrl: record['registryUrl'] } : {}),
          ...(record['force'] === true ? { force: true } : {}),
        },
        true,
      );
    },
    isUpgrading: args.isUpgrading,
  });
  reportedVersion = await prefetchNodeVersion();
  try {
    await server.listening;
  } catch (error) {
    args.detachSignals();
    throw new Error(
      `control channel failed to listen (${args.control.endpoint}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return server;
}

/** Wait until `controller.signal` aborts (resolves immediately if already aborted). */
function waitAborted(controller: AbortController): Promise<void> {
  return new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Clean up daemon handle and control server; propagates `handle.close()` failures as non-zero exit. */
async function cleanupDaemonRun(handle: DaemonHandle | undefined, controlServer: ControlServer | undefined): Promise<string | undefined> {
  let stopFailure: string | undefined;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      stopFailure = error instanceof Error ? error.message : String(error);
    }
  }
  await controlServer?.close();
  return stopFailure;
}

export async function runDaemonProcess(options: {
  io: NodeCliIo;
  json: boolean;
  dataDir: string;
  hubUrl: string;
  token: string;
  nodeId: string;
  control?: { instanceId: string; endpoint: string };
}): Promise<number> {
  const { io, json, dataDir, hubUrl, token, nodeId, control } = options;
  const { runNodeDaemonHandle } = await import('./daemon/index.js');
  const controller = new AbortController();
  const detachSignals = forwardSignals(controller);
  let handle: DaemonHandle | undefined;
  let stopFailure: string | undefined;

  const handoff = parseUpgradeHandoffEnv(io.env);
  const pendingActivation = io.env?.['HELM_NODE_PENDING_ACTIVATION'] === '1' && handoff !== undefined;
  let upgradeReplaced = false;

  let controlServer: ControlServer | undefined;
  if (control !== undefined) {
    controlServer = await setupControlServer({
      control,
      handle: () => handle,
      daemonState: () => (handle !== undefined && handle.isConnected() ? 'registered' : 'starting'),
      controller,
      detachSignals,
      isUpgrading: () => handle?.isUpgrading() === true || upgradeReplaced,
    });
  }

  if (!json && control === undefined) {
    io.out(`helm-node connecting to ${hubUrl} (nodeId=${nodeId}); will begin serving once registration completes (Ctrl+C to exit)\n`);
  }
  try {
    handle = await runNodeDaemonHandle(
      { hubUrl, token },
      {
        dataDir,
        // Only controlled instances support upgrade handoffs.
        ...(control !== undefined
          ? {
              prepareUpgradeReplacement: (release, context) =>
                prepareNodeReplacement(release, context, {
                  dataDir,
                  hubUrl,
                  logPath: logPathOf(dataDir),
                  controlEndpoint,
                  readPidRecord: () => readPidRecord(dataDir),
                  writePidRecord: (record) => writePidRecord(dataDir, record),
                  removePidFile: () => removePidFile(dataDir),
                }),
              onUpgradeReplaced: () => {
                upgradeReplaced = true;
                // Delay exit briefly so the upgrade control response flushes cleanly.
                setTimeout(() => controller.abort(), UPGRADE_EXIT_DELAY_MS).unref?.();
              },
            }
          : {}),
        ...(handoff !== undefined ? { upgradeAttemptId: handoff.attemptId } : {}),
        ...(pendingActivation ? { pendingActivation: true } : {}),
      },
    );
    const registered = await handle.waitUntilRegistered(10_000);
    if (control !== undefined) {
      reportReady(control, pendingActivation, registered ? 'registered' : 'starting');
    } else if (!json) {
      io.out(
        registered
          ? `registered and ready (${hubUrl})\n`
          : 'registration pending (daemon will keep reconnecting with backoff if Hub is unreachable); see stderr logs\n',
      );
    }
    if (pendingActivation) {
      // Unregistered candidates must not activate; exit so the parent rolls back cleanly.
      if (!registered) {
        throw new Error('upgrade candidate did not complete Hub registration (state=starting); refusing to await activation');
      }
      await awaitActivate(handle, handoff!, controller);
    }
    await waitAborted(controller);
  } finally {
    stopFailure = await cleanupDaemonRun(handle, controlServer);
    detachSignals();
  }
  return stopFailure === undefined ? 0 : 1;
}
