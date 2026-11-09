/**
 * 守护进程运行主体（前台 connect/start 与受控后台共用）：
 * - 注册前只输出「连接中」；registered 只来自真实 daemon 注册 ACK，未完成为 starting；
 * - 受控模式（control）：先监听控制 server（daemon 未就绪也能应答 status/拒绝伪造
 *   stop），daemon 注册结果落定后经 stdio IPC 上报 ready 并 disconnect；stop 请求
 *   → abort → handle.close()（等待执行环境清理）→ 应答 → 关 server 与 socket；
 * - 升级候选模式（HELM_NODE_PENDING_ACTIVATION）：真实 registered 后保持 IPC
 *   等 activate，收到且上下文一致才 confirmUpgrade（详见 awaitActivate）；
 * - 退出路径 finally 清理全部资源（handle、控制 server、信号监听器）。
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

/** 守护进程句柄（延迟 import 的类型别名；避免入口层静态依赖 daemon）。 */
type DaemonHandle = Awaited<ReturnType<(typeof import('./daemon/index.js'))['runNodeDaemonHandle']>>;

/** 前台信号接管：返回卸载函数（try/finally 保证监听器清理）。 */
function forwardSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

/** 就绪上报（受控实例向父进程；候选保持 IPC 等 activate 不 disconnect）。 */
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
    // 父侧 channel 已关闭：普通受控实例忽略（守护进程继续存活重连）。
  }
  if (!pendingActivation) {
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // 已断开。
    }
  }
}

/** 候选收到的 activate 与自身上下文核对的结论。 */
type ActivateCheck = { kind: 'accept' } | { kind: 'reject'; reason: string; abort: boolean };

/** 核对 activate：pid/attemptId/升级版本上下文不一致的候选绝不提交。 */
function checkActivate(activate: ActivateMessage, handoff: CandidateUpgradeHandoff, selfPid: number): ActivateCheck {
  if (activate.pid !== selfPid || (handoff.attemptId !== undefined && activate.attemptId !== handoff.attemptId)) {
    return { kind: 'reject', reason: 'activate 上下文与本进程不一致', abort: false };
  }
  // 升级上下文核对：activate 携带的 previousVersion/version 必须与候选启动
  // env 注入的本次升级上下文完全一致，不一致绝不 confirmUpgrade。
  if (
    handoff.previousVersion === undefined ||
    handoff.targetVersion === undefined ||
    activate.previousVersion !== handoff.previousVersion ||
    activate.version !== handoff.targetVersion
  ) {
    return {
      kind: 'reject',
      abort: true, // 上下文不匹配：不提交，候选退出交父侧安全回滚
      reason:
        `升级上下文不一致：activate previousVersion=${activate.previousVersion} version=${activate.version}` +
        `，候选 env previousVersion=${handoff.previousVersion ?? '(缺失)'} targetVersion=${handoff.targetVersion ?? '(缺失)'}`,
    };
  }
  return { kind: 'accept' };
}

/** 向父进程发送 activate-rejected（父侧断开时静默）。 */
function sendRejected(attemptId: string, reason: string): void {
  try {
    process.send?.({ type: 'helm-node.activate-rejected', attemptId, reason });
  } catch {
    // 父侧已断开。
  }
}

/** 候选确认激活：confirmUpgrade 本地提交后回 activated 并脱离父 IPC。 */
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
      // 父侧 ACK 丢失：本机已激活，候选继续存活（幂等重试 Hub commit）。
    }
    // 脱离父 IPC：激活后父退出不影响候选。
    try {
      if (process.connected && process.disconnect !== undefined) process.disconnect();
    } catch {
      // 已断开。
    }
  } catch (error) {
    sendRejected(activate.attemptId, error instanceof Error ? error.message : String(error));
    abort(); // confirmUpgrade 失败：候选自行退出，父侧安全回滚
  }
}

/**
 * 候选等 activate：父断开/超时拒绝（未激活即退出，不向 Hub 伪装已提交）；
 * 收到合法 activate 后核对上下文——不一致回拒（上下文不匹配同时退出交父侧
 * 回滚），一致则 confirmUpgrade 回 activated 并脱离父 IPC。
 */
function awaitActivate(handle: DaemonHandle | undefined, handoff: CandidateUpgradeHandoff, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string): void => {
      cleanup();
      reject(new Error(`候选等待激活失败：${reason}（未激活即退出，不向 Hub 伪装已提交）`));
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
    const onDisconnect = (): void => fail('父 IPC 通道断开');
    const timer = setTimeout(() => fail(`等待 activate 超时（${CANDIDATE_ACTIVATE_WAIT_MS}ms）`), CANDIDATE_ACTIVATE_WAIT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

/** 真实运行版本预取（current.json 优先）；失败静默省略版本字段。 */
async function prefetchNodeVersion(): Promise<string | undefined> {
  try {
    const { getNodeVersion } = await import('./daemon/upgrader.js');
    return getNodeVersion();
  } catch {
    return undefined;
  }
}

/** 搭建并监听控制 server：版本监听前预取一次（status 响应同步读取，避免每请求动态 import）。 */
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
    // 升级请求（本机可信源）：转发 handle.upgrade；响应附 pid/instanceId/result。
    onUpgrade: (input: unknown): Promise<unknown> => {
      const handle = args.handle();
      if (handle === undefined) return Promise.reject(new Error('daemon 未就绪，拒绝升级请求'));
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
      `控制通道监听失败（${args.control.endpoint}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return server;
}

/** 等待中止信号落定（已中止立即返回）。 */
function waitAborted(controller: AbortController): Promise<void> {
  return new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** 资源清理：handle.close 失败如实记录为失败退出码，不因已激活而吞错。 */
async function cleanupDaemonRun(handle: DaemonHandle | undefined, controlServer: ControlServer | undefined): Promise<string | undefined> {
  let stopFailure: string | undefined;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      // 候选已激活后的 close 异常不影响已提交流程（Hub commit 幂等重试）。
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

  // 升级候选模式：真实 registered 后保持 stdio IPC 等 activate；父断开/超时退出。
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
    io.out(`helm-node 连接中 ${hubUrl}（nodeId=${nodeId}）；注册完成后开始工作，Ctrl+C 退出\n`);
  }
  try {
    handle = await runNodeDaemonHandle(
      { hubUrl, token },
      {
        dataDir,
        // 受控实例才接入升级交接（前台 connect 无 prepare 时升级 unsupported）。
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
                // 延迟退出：给升级响应冲刷留余量，之后旧 daemon 优雅让位。
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
      // 就绪上报：父进程据此写 pid 留档；父已退出时忽略（守护进程继续存活重连）。
      reportReady(control, pendingActivation, registered ? 'registered' : 'starting');
    } else if (!json) {
      io.out(
        registered
          ? `已注册并开始工作（${hubUrl}）\n`
          : '尚未完成注册（Hub 暂不可达时守护进程将持续退避重连），诊断见 stderr 日志\n',
      );
    }
    if (pendingActivation) {
      // 候选：starting 不可提交——如实退出（父侧按启动失败回滚），绝不伪装就绪。
      if (!registered) {
        throw new Error('升级候选未完成真实注册（starting），拒绝进入待激活等待');
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
