/**
 * 生命周期命令：connect（绑定+前台运行）/ start（后台或受控）/ stop / restart / status。
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
  if (token === undefined) throw new UsageError('connect 需要 --token <token>（JOIN 令牌 nodeId:secret）', 'missing_token');
  await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) throw new Error('身份写入后读取失败（内部错误）');
  if (parsed.flags.get('once') === true) {
    const handle = await runNodeDaemonHandle({ hubUrl, token }, { dataDir });
    const ok = await handle.waitUntilRegistered(15_000);
    await handle.close();
    emit({ ok, nodeId: identity.nodeId, hubUrl, dataDir, registered: ok });
    return ok ? 0 : 1;
  }
  return await runDaemonProcess({ io, json: parsed.json, dataDir, hubUrl, token, nodeId: identity.nodeId });
}

/** start -d：绑定（可选）→ 后台拉起 → pid 留档。 */
async function startDetached(ctx: CommandContext, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken, readNodeIdentity } = await import('../daemon/index.js');
  if (token !== undefined) {
    // 空地址由 bindIdentityFromJoinToken 显式拒绝（不编造回退 Hub）。
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('后台启动需要 Hub 地址（--hub 或既绑定的 hubUrl）', 'missing_hub_url');
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  const message =
    readyState === 'registered'
      ? `守护进程已启动并完成 Hub 注册（pid ${pid}）`
      : `守护进程已启动（pid ${pid}），尚未完成 Hub 注册：Hub 暂不可达时将持续退避重连，诊断见 ${logPath}`;
  emit({ ok: true, pid, dataDir, hubUrl: effectiveHub, nodeId: identity.nodeId, logPath, state: readyState, message });
  return 0;
}

/** start 受控模式（start -d / 升级交接父进程注入控制 env）：直接运行 daemon 本体。 */
async function startControlled(ctx: CommandContext, control: { instanceId: string; endpoint: string }, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const effectiveToken = token ?? identity?.token;
  const effectiveHub = hubUrl !== '' ? hubUrl : identity?.hubUrl ?? '';
  if (effectiveToken === undefined || effectiveHub === '') {
    throw new UsageError(
      'start 受控运行需要既绑定的身份或 --token + --hub；或使用 start -d 后台启动',
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
  // 前台 start：受控后台（由 start -d / 升级交接父进程注入
  // HELM_NODE_INSTANCE_ID / HELM_NODE_CONTROL_ENDPOINT）直接运行 daemon；
  // 无控制 env 的纯前台（systemd/launchd 主进程）成为稳定 launcher。
  const instanceId = io.env?.['HELM_NODE_INSTANCE_ID'];
  const endpoint = io.env?.['HELM_NODE_CONTROL_ENDPOINT'];
  if (instanceId !== undefined && instanceId !== '' && endpoint !== undefined && endpoint !== '') {
    return await startControlled(ctx, { instanceId, endpoint }, token, hubUrl);
  }
  // 稳定 launcher：拉起受控 daemon 并跟踪当前实例，升级换 pid 自动跟随。
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  const { runForegroundLauncher } = await import('../launcher.js');
  if (token !== undefined && hubUrl !== '') {
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const launcherIdentity = await readNodeIdentityStrict(dataDir);
  const launcherHub = hubUrl !== '' ? hubUrl : launcherIdentity.hubUrl ?? '';
  if (launcherHub === '') throw new UsageError('launcher 启动需要 Hub 地址（--hub 或既绑定的 hubUrl）', 'missing_hub_url');
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
  if (effectiveHub === '') throw new UsageError('restart 需要既绑定身份（helm-node connect）；未找到', 'missing_identity');
  const previous = await readPidRecord(dataDir);
  let previousPid: number | null = null;
  if (previous !== null) {
    previousPid = previous.pid;
    // stopDaemon 停止失败会抛错：绝不带着旧进程继续拉新进程。
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
  // 真实运行版本优先级：daemon 控制通道上报（真实进程 getNodeVersion）
  // → 本地 current.json（已选择版本）→ 自身包版本（无 live 实例时的兑底）。
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
