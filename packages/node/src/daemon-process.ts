/**
 * daemon run body (foreground connect/start and subject to control background shared use):
 * - register before only output connect in;registered only from real daemon register ACK, not complete is starting;
 * - subject to control pattern (control): first listen control server(daemon not ready also can reply status/reject fabricate
 *   stop),daemon register result set after via stdio IPC on report ready and disconnect;stop request
 *   → abort → handle.close()(wait for execute environment clean up)→ reply → closure server and socket;
 * - upgrade choose pattern (HELM_NODE_PENDING_ACTIVATION): real registered after keep IPC
 *   etc. activate, receives and context consistent only then confirmUpgrade(detail see awaitActivate);
 * - exit path finally clean up all asset (handle, control server, signal listener).
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

/** daemon handle (latency import type alias; avoid entry layer static dependency daemon). */
type DaemonHandle = Awaited<ReturnType<(typeof import('./daemon/index.js'))['runNodeDaemonHandle']>>;

/** foreground signal take over: return unload function (try/finally guarantee listener clean up). */
function forwardSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

/** ready on report (subject to control instance to parent process; choose keep IPC etc. activate do not disconnect). */
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
    // parent side channel already close: ordinary subject to control instance ignore (daemon continue store reconnect).
  }
  if (!pendingActivation) {
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // disconnected.
    }
  }
}

/** choose receives activate and itself context core for conclusion. */
type ActivateCheck = { kind: 'accept' } | { kind: 'reject'; reason: string; abort: boolean };

/** core for activate:pid/attemptId/upgrade version context inconsistent choose never commit. */
function checkActivate(activate: ActivateMessage, handoff: CandidateUpgradeHandoff, selfPid: number): ActivateCheck {
  if (activate.pid !== selfPid || (handoff.attemptId !== undefined && activate.attemptId !== handoff.attemptId)) {
    return { kind: 'reject', reason: 'activate context and this process inconsistent', abort: false };
  }
  // upgrade context core for:activate carry previousVersion/version must and choose start
  // env inject this time upgrade context fully consistent, inconsistent never confirmUpgrade.
  if (
    handoff.previousVersion === undefined ||
    handoff.targetVersion === undefined ||
    activate.previousVersion !== handoff.previousVersion ||
    activate.version !== handoff.targetVersion
  ) {
    return {
      kind: 'reject',
      abort: true, // context does not match: do not commit, choose exit hand over parent side security rollback
      reason:
        `upgrade context inconsistent:activate previousVersion=${activate.previousVersion} version=${activate.version}` +
        `, choose env previousVersion=${handoff.previousVersion ?? '(missing)'} targetVersion=${handoff.targetVersion ?? '(missing)'}`,
    };
  }
  return { kind: 'accept' };
}

/** to parent process send activate-rejected(parent side on disconnect static default). */
function sendRejected(attemptId: string, reason: string): void {
  try {
    process.send?.({ type: 'helm-node.activate-rejected', attemptId, reason });
  } catch {
    // parent side disconnected.
  }
}

/** choose confirm activate:confirmUpgrade local after commit back activated and detach parent IPC. */
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
      // parent side ACK lose: local machine already activate, choose continue store (idempotent retry Hub commit).
    }
    // detach parent IPC: activate after parent exit does not affect choose.
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // disconnected.
    }
  } catch (error) {
    sendRejected(activate.attemptId, error instanceof Error ? error.message : String(error));
    abort(); // confirmUpgrade failed: choose self row exit, parent side security rollback
  }
}

/**
 * choose etc. activate: parent disconnect/timeout reject (inactive i.e. exit, do not to Hub disguise committed);
 * receives legal activate after core for context - - inconsistent back refuse (context does not match also exit hand over parent side
 * rollback), consistent then confirmUpgrade back activated and detach parent IPC.
 */
function awaitActivate(handle: DaemonHandle | undefined, handoff: CandidateUpgradeHandoff, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string): void => {
      cleanup();
      reject(new Error(`choose wait for activate failed:${reason}(inactive i.e. exit, do not to Hub disguise committed)`));
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
    const onDisconnect = (): void => fail('parent IPC channel disconnect');
    const timer = setTimeout(() => fail(`wait for activate timeout (${CANDIDATE_ACTIVATE_WAIT_MS}ms)`), CANDIDATE_ACTIVATE_WAIT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

/** real run version pre- take (current.json takes precedence); failed static default omit version field. */
async function prefetchNodeVersion(): Promise<string | undefined> {
  try {
    const { getNodeVersion } = await import('./daemon/upgrader.js');
    return getNodeVersion();
  } catch {
    return undefined;
  }
}

/** pair create and listen control server: version listen before pre- take once (status response sync read, avoid each request motion state import). */
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
    // upgrade request (local machine can message source): forwarding handle.upgrade; response attach pid/instanceId/result.
    onUpgrade: (input: unknown): Promise<unknown> => {
      const handle = args.handle();
      if (handle === undefined) return Promise.reject(new Error('daemon not ready, reject upgrade request'));
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
      `control channel listen failed (${args.control.endpoint}):${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return server;
}

/** wait for abort signal set (already abort immediately return). */
function waitAborted(controller: AbortController): Promise<void> {
  return new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** asset clean up:handle.close failed such as record is failed exit code, do not because already activate while swallow wrong. */
async function cleanupDaemonRun(handle: DaemonHandle | undefined, controlServer: ControlServer | undefined): Promise<string | undefined> {
  let stopFailure: string | undefined;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      // choose already activate after close exception does not affect committed stream process (Hub commit idempotent retry).
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

  // upgrade choose pattern: real registered after keep stdio IPC etc. activate; parent disconnect/timeout exit.
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
    io.out(`helm-node connect in ${hubUrl}(nodeId=${nodeId}); register after completion start work,Ctrl+C exit\n`);
  }
  try {
    handle = await runNodeDaemonHandle(
      { hubUrl, token },
      {
        dataDir,
        // subject to control instance only then access upgrade handover (foreground connect without prepare when upgrade unsupported).
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
                // latency exit: to upgrade response conflict refresh remaining amount, after old daemon graceful let.
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
      // ready on report: parent process based on this write pid Profile; parent already on exit ignore (daemon continue store reconnect).
      reportReady(control, pendingActivation, registered ? 'registered' : 'starting');
    } else if (!json) {
      io.out(
        registered
          ? `registered and start work (${hubUrl})\n`
          : 'not yet complete register (Hub temporary cannot reach when daemon continuous backoff reconnect), diagnose see stderr log\n',
      );
    }
    if (pendingActivation) {
      // choose:starting cannot commit - - such as exit (parent side by failed to start rollback), never disguise ready.
      if (!registered) {
        throw new Error('upgrade choose not complete real register (starting), reject enter await activate wait for');
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
