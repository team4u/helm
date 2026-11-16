/**
 * lifecycle command:connect(bind set+foreground run)/ start(background or subject to control)/ stop / restart / status.
 */
import { UsageError } from '../cli-context.js';
import { readPidRecord } from '../cli-context.js';
import { startDaemon } from '../launcher.js';
import { runDaemonProcess } from '../daemon-process.js';
import {
  flagString,
  readNodeIdentityStrict,
  resolveHubUrl,
  statusDaemon,
  stopDaemon,
  type CommandContext,
} from './shared.js';

export async function connectCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken, readNodeIdentity, runNodeDaemonHandle } = await import('../daemon/index.js');
  const hubUrl =
    parsed.positional[0] !== undefined && /^https?:\/\//.test(parsed.positional[0]!)
      ? parsed.positional[0]!
      : await resolveHubUrl(io, parsed, true);
  const token = flagString(parsed, 'token');
  if (token === undefined) throw new UsageError('connect need to --token <token>(JOIN token nodeId:secret)', 'missing_token');
  await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) throw new Error('identity after write failed to read (internal error)');
  if (parsed.flags.get('once') === true) {
    const handle = await runNodeDaemonHandle({ hubUrl, token }, { dataDir });
    const ok = await handle.waitUntilRegistered(15_000);
    await handle.close();
    emit({ ok, nodeId: identity.nodeId, hubUrl, dataDir, registered: ok });
    return ok ? 0 : 1;
  }
  return await runDaemonProcess({ io, json: parsed.json, dataDir, hubUrl, token, nodeId: identity.nodeId });
}

/** start -d: bind set (optional)→ background pull start → pid Profile. */
async function startDetached(ctx: CommandContext, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken, readNodeIdentity } = await import('../daemon/index.js');
  if (token !== undefined) {
    // empty address by bindIdentityFromJoinToken explicit reject (do not edit build fall back Hub).
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('background start need to Hub address (--hub or since bind set hubUrl)', 'missing_hub_url');
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  const message =
    readyState === 'registered'
      ? `daemon already start and complete Hub register (pid ${pid})`
      : `daemon already start (pid ${pid}), not yet complete Hub register:Hub temporary cannot reach when continuous backoff reconnect, diagnose see ${logPath}`;
  emit({ ok: true, pid, dataDir, hubUrl: effectiveHub, nodeId: identity.nodeId, logPath, state: readyState, message });
  return 0;
}

/** start subject to control pattern (start -d / upgrade handover parent process inject control env): directly run daemon this body. */
async function startControlled(ctx: CommandContext, control: { instanceId: string; endpoint: string }, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const effectiveToken = token ?? identity?.token;
  const effectiveHub = hubUrl !== '' ? hubUrl : identity?.hubUrl ?? '';
  if (effectiveToken === undefined || effectiveHub === '') {
    throw new UsageError(
      'start subject to control run need to since bind set identity or --token + --hub; or use start -d background start',
      'missing_identity',
    );
  }
  return await runDaemonProcess({
    io,
    json: parsed.json,
    dataDir,
    hubUrl: effectiveHub,
    token: effectiveToken,
    nodeId: identity?.nodeId ?? '?',
    control,
  });
}

export async function startCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const detached = parsed.flags.get('daemon') === true || parsed.flags.get('d') === true;
  const hubUrl = await resolveHubUrl(io, parsed, false);
  const token = flagString(parsed, 'token');
  if (detached) {
    return await startDetached(ctx, token, hubUrl);
  }
  // foreground start: subject to control background (by start -d / upgrade handover parent process inject
  // HELM_NODE_INSTANCE_ID / HELM_NODE_CONTROL_ENDPOINT) directly run daemon;
  // without control env pure foreground (systemd/launchd main process) into is stable launcher.
  const instanceId = io.env?.['HELM_NODE_INSTANCE_ID'];
  const endpoint = io.env?.['HELM_NODE_CONTROL_ENDPOINT'];
  if (instanceId !== undefined && instanceId !== '' && endpoint !== undefined && endpoint !== '') {
    return await startControlled(ctx, { instanceId, endpoint }, token, hubUrl);
  }
  // stable launcher: pull start subject to control daemon and trace when before instance, upgrade swap pid automatically with follow.
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  const { runForegroundLauncher } = await import('../launcher.js');
  if (token !== undefined && hubUrl !== '') {
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const launcherIdentity = await readNodeIdentityStrict(dataDir);
  const launcherHub = hubUrl !== '' ? hubUrl : launcherIdentity.hubUrl ?? '';
  if (launcherHub === '') throw new UsageError('launcher start need to Hub address (--hub or since bind set hubUrl)', 'missing_hub_url');
  return await runForegroundLauncher(io, dataDir, launcherHub, parsed.json);
}

export async function stopCommand(ctx: CommandContext): Promise<number> {
  const { io, dataDir, emit } = ctx;
  const stopped = await stopDaemon(io, dataDir);
  emit({ ok: true, stopped: true, outcome: stopped.outcome, pid: stopped.pid, dataDir });
  return 0;
}

export async function restartCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const hubUrl = await resolveHubUrl(io, parsed, false);
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('restart need to since bind set identity (helm-node connect); not found', 'missing_identity');
  const previous = await readPidRecord(dataDir);
  let previousPid: number | null = null;
  if (previous !== null) {
    previousPid = previous.pid;
    // stopDaemon stop failed will throws: never carries old process continue pull new process.
    await stopDaemon(io, dataDir);
  }
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  emit({
    ok: true,
    pid,
    dataDir,
    hubUrl: effectiveHub,
    nodeId: identity.nodeId,
    logPath,
    state: readyState,
    ...(previousPid !== null ? { previousPid } : {}),
  });
  return 0;
}

export async function statusCommand(ctx: CommandContext): Promise<number> {
  const { io, dataDir, emit } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const daemon = await statusDaemon(io, dataDir);
  // real run version priority:daemon control channel on report (real process getNodeVersion)
  // → local current.json(already choose version)→ itself package version (without live instance when honor bottom).
  const { resolveEffectiveNodeVersion } = await import('../daemon/upgrader.js');
  const version = daemon.version ?? (await resolveEffectiveNodeVersion(dataDir));
  emit({
    bound: identity !== null,
    ...(identity !== null ? { nodeId: identity.nodeId, hubUrl: identity.hubUrl ?? null } : {}),
    dataDir,
    version,
    pid: daemon.pid,
    pidAlive: daemon.pidAlive,
    ...(daemon.state !== undefined ? { state: daemon.state } : {}),
    ...(daemon.pidStale === true ? { pidStale: true } : {}),
    ...(daemon.detail !== undefined ? { detail: daemon.detail } : {}),
  });
  return 0;
}
