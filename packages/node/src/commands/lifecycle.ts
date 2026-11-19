/**
 * Lifecycle commands: `connect` (bind + foreground), `start` (detached or controlled/launcher),
 * `stop`, `restart`, and `status`.
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
  if (token === undefined) throw new UsageError('connect requires --token <token> (JOIN token nodeId:secret)', 'missing_token');
  await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) throw new Error('failed to read identity after writing it (internal error)');
  if (parsed.flags.get('once') === true) {
    const handle = await runNodeDaemonHandle({ hubUrl, token }, { dataDir });
    const ok = await handle.waitUntilRegistered(15_000);
    await handle.close();
    emit({ ok, nodeId: identity.nodeId, hubUrl, dataDir, registered: ok });
    return ok ? 0 : 1;
  }
  return await runDaemonProcess({ io, json: parsed.json, dataDir, hubUrl, token, nodeId: identity.nodeId });
}

/** `start -d`: bind identity (optional) -> spawn detached daemon -> record `node.pid`. */
async function startDetached(ctx: CommandContext, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  if (token !== undefined) {
    // Empty hubUrl is explicitly rejected by bindIdentityFromJoinToken.
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('detached start requires a Hub URL (--hub or bound hubUrl)', 'missing_hub_url');
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  const message =
    readyState === 'registered'
      ? `daemon started and registered with Hub (pid ${pid})`
      : `daemon started (pid ${pid}), registration not yet complete: will keep reconnecting with backoff if Hub is unreachable; check logs at ${logPath}`;
  emit({ ok: true, pid, dataDir, hubUrl: effectiveHub, nodeId: identity.nodeId, logPath, state: readyState, message });
  return 0;
}

/** Controlled `start` invoked by `start -d` or upgrade handoff with control env vars injected. */
async function startControlled(ctx: CommandContext, control: { instanceId: string; endpoint: string }, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const effectiveToken = token ?? identity?.token;
  const effectiveHub = hubUrl !== '' ? hubUrl : identity?.hubUrl ?? '';
  if (effectiveToken === undefined || effectiveHub === '') {
    throw new UsageError(
      'controlled start requires a bound identity or --token + --hub; or use start -d to run in background',
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
  // Controlled child (spawned with HELMX_NODE_INSTANCE_ID / HELMX_NODE_CONTROL_ENDPOINT) runs the daemon directly;
  // plain foreground `start` (systemd/launchd main process) enters the foreground launcher loop.
  const instanceId = io.env?.['HELMX_NODE_INSTANCE_ID'];
  const endpoint = io.env?.['HELMX_NODE_CONTROL_ENDPOINT'];
  if (instanceId !== undefined && instanceId !== '' && endpoint !== undefined && endpoint !== '') {
    return await startControlled(ctx, { instanceId, endpoint }, token, hubUrl);
  }
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  const { runForegroundLauncher } = await import('../launcher.js');
  if (token !== undefined && hubUrl !== '') {
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const launcherIdentity = await readNodeIdentityStrict(dataDir);
  const launcherHub = hubUrl !== '' ? hubUrl : launcherIdentity.hubUrl ?? '';
  if (launcherHub === '') throw new UsageError('launcher start requires a Hub URL (--hub or bound hubUrl)', 'missing_hub_url');
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
  if (effectiveHub === '') throw new UsageError('restart requires a bound Hub URL (run helmx-node connect first)', 'missing_identity');
  const previous = await readPidRecord(dataDir);
  let previousPid: number | null = null;
  if (previous !== null) {
    previousPid = previous.pid;
    // stopDaemon throws on failure so we never spawn a second process alongside a live one.
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
  // Version priority: live daemon control-channel report -> staged current.json -> package.json.
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
