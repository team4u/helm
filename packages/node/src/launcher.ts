/**
 * 后台启动与跟踪：start 锁、detached spawn（stdio IPC 就绪上报）与前台稳定
 * launcher（systemd/launchd 主进程）。
 *
 * - start 并发锁（O_CREAT|O_EXCL）覆盖「已有实例验证 → spawn → pid 留档」全程；
 * - 已有 pid 先走控制通道验证：活的真守护进程拒绝重复启动；pid 存活但通道
 *   不可达（无法证实可安全覆盖）同样拒绝；确已死亡才清理 pid 继续启动；
 * - 前台稳定 launcher：周期通过 node.pid + 控制通道验证跟踪当前实例（升级
 *   换 pid 后自动跟踪新 daemon）；SIGTERM/INT 经控制通道停止当前实例并等待
 *   stop 结果落定后才退出——systemd 主 PID 不因旧 daemon 退出而杀整个 cgroup。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import process from 'node:process';
import {
  isAliveOf,
  logPathOf,
  pidPath,
  readPidRecord,
  removePidFile,
  removePidFileIfMatch,
  startLockPath,
  waitForExit,
  writePidRecord,
  type NodeCliIo,
  type PidRecord,
  UsageError,
} from './cli-context.js';
import { cliSelfEntry } from './service-entry.js';
import {
  controlEndpoint,
  controlRequest,
  CONTROL_STOP_TIMEOUT_MS,
  CONTROL_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  STOP_EXIT_TIMEOUT_MS,
  type ControlServer,
  type DaemonReadyState,
} from './control.js';

// ---------------------------------------------------------------------------
// 后台启动：start 锁 + detached spawn（stdio IPC 就绪上报）
// ---------------------------------------------------------------------------

/** launcher 跟踪当前实例的轮询间隔。 */
const LAUNCHER_POLL_MS = 2_000;

/** 后台子进程就绪上报协议（Node 原生 stdio IPC）：{ type:'helm-node.ready', pid, instanceId, state }。 */
function parseReadyMessage(message: unknown, instanceId: string): DaemonReadyState | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helm-node.ready' || record['instanceId'] !== instanceId) return null;
  return record['state'] === 'registered' ? 'registered' : 'starting';
}

/**
 * 后台启动默认实现（导出供测试复用）：
 * 1. 打开 node.log（失败显式报错，绝不带坏 fd 启动）；
 * 2. detached spawn：stdio = ['ignore', logFd, logFd, 'ipc']——就绪经 Node 原生
 *    IPC channel 上报，跨平台无需握手 socket；argv 无 token；instanceId/endpoint
 *    经环境变量传递；
 * 3. ready / spawn error / 子进程退出三方竞速，外加总超时；
 * 4. 任一结局后立即清理父侧 fd/IPC channel/timer/listener，不留孤儿句柄。
 */
export async function defaultSpawnDaemon(options: {
  nodePath: string;
  args: readonly string[];
  execArgv: readonly string[];
  dataDir: string;
  env: NodeJS.ProcessEnv;
  instanceId: string;
  endpoint: string;
  readyTimeoutMs?: number;
}): Promise<{ pid: number; readyState: DaemonReadyState; logPath: string }> {
  const { nodePath, args, execArgv, dataDir, env, instanceId } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  await fsp.mkdir(dataDir, { recursive: true });
  const logFile = logPathOf(dataDir);

  let logHandle: fsp.FileHandle;
  try {
    logHandle = await fsp.open(logFile, 'a');
  } catch (error) {
    throw new Error(`打开日志文件失败（${logFile}）：${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    // instanceId/endpoint 已在 env 中（startDaemon 注入）：不再重复拼装。
    const childEnv = { ...env }
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'HELM_TOKEN') delete childEnv[key]
    child = spawn(nodePath, [...execArgv, ...args], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`后台进程 spawn 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  type Outcome =
    | { kind: 'ready'; state: DaemonReadyState }
    | { kind: 'error'; error: Error }
    | { kind: 'exit'; code: number | null }
    | { kind: 'timeout' };
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const finish = (value: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(value);
    };
    const onMessage = (message: unknown): void => {
      const state = parseReadyMessage(message, instanceId);
      if (state !== null) finish({ kind: 'ready', state });
    };
    const onError = (error: Error): void => finish({ kind: 'error', error });
    const onExit = (code: number | null): void => finish({ kind: 'exit', code });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), readyTimeoutMs);
    timer.unref?.();
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });

  const detachChannel = (): void => {
    try {
      if (child.connected) child.disconnect();
    } catch {
      // 已断开。
    }
  };

  if (outcome.kind === 'ready') {
    detachChannel();
    child.unref();
    await logHandle.close().catch(() => undefined);
    if (child.pid === undefined) {
      throw new Error('后台进程就绪上报后 pid 不可用（内部错误）');
    }
    return { pid: child.pid, readyState: outcome.state, logPath: logFile };
  }

  // 失败路径：停止本次持有的 ChildProcess（自有子进程），保留诊断日志。
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出。
  }
  detachChannel();
  child.unref();
  await logHandle.close().catch(() => undefined);
  const reason =
    outcome.kind === 'error'
      ? `后台进程启动失败（spawn error）：${outcome.error.message}`
      : outcome.kind === 'exit'
        ? `后台进程启动后立即退出（code=${outcome.code ?? 'null'}）`
        : `后台进程 ${readyTimeoutMs}ms 内未上报就绪（helm-node.ready）`;
  const tail = await readLogTail(logFile, 40);
  throw new Error(`${reason}${tail !== '' ? `\n--- ${logFile} 最后 40 行 ---\n${tail}` : ''}`);
}

/**
 * start 并发锁（O_CREAT|O_EXCL）：持锁覆盖「已有实例验证 → spawn → pid 留档」
 * 全程；所有分支释放；残留锁显式诊断（不静默删——可能是另一 start 在途）。
 */
async function withStartLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = startLockPath(dataDir);
  await fsp.mkdir(dataDir, { recursive: true });
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `并发启动冲突：${lockPath} 已存在（另一 helm-node start 正在进行，或上次启动异常退出残留）；确认无并发启动后删除该文件重试`,
      );
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.unlink(lockPath).catch(() => undefined);
  }
}

async function readLogTail(logFile: string, maxLines: number): Promise<string> {
  try {
    const text = await fsp.readFile(logFile, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** 后台子进程与父进程同源 tsx 编译环境所需的 execArgv（--require/--import loader 等）。 */
function inheritExecArgv(): string[] {
  return process.execArgv.filter((arg) => !/^-{1,2}(inspect|debug|cpu-prof|heap-prof)(-brk)?(-[a-z-]+)?(=.*)?$/.test(arg));
}

/**
 * 解析后台启动目标：current.json 优先（已升级后必须运行新 release 入口，
 * 坏 current 显式报错）；无 current 回退固定 launcher（自身入口，不绑任何
 * release）。同时返回 cliBinDir（有 current 时注入 HELM_CLI_BIN_DIR）。
 */
async function resolveDaemonLaunchTarget(
  dataDir: string,
  selfEntry: string,
): Promise<{ entryPath: string; cliBinDir?: string }> {
  const { readCurrentRelease } = await import('./daemon/upgrader.js');
  const current = await readCurrentRelease(dataDir);
  if (current === null) return { entryPath: selfEntry };
  try {
    await fsp.access(current.entryPath);
  } catch {
    throw new Error(
      `current.json 指向的入口不存在（${current.entryPath}，version ${current.version}）：升级产物可能已损坏；请修复 current.json 或重新升级，拒绝回退旧入口启动`,
    );
  }
  return { entryPath: current.entryPath, ...(current.cliBinDir !== undefined ? { cliBinDir: current.cliBinDir } : {}) };
}

/** 已有 pid 留档验证：活的真守护进程/pid 存活但不可达均拒绝；确已死亡清理后放行。 */
async function assertNoLiveInstance(io: NodeCliIo, dataDir: string): Promise<void> {
  const isAlive = isAliveOf(io);
  const existing = await readPidRecord(dataDir);
  if (existing === null) return;
  const response = await controlRequest(existing.endpoint, { type: 'status', instanceId: existing.instanceId });
  if (response !== null && response.ok === true) {
    throw new UsageError(
      `守护进程已在运行（pid ${response.pid}，state ${response.state ?? 'unknown'}，pid 文件 ${pidPath(dataDir)}）；拒绝重复启动，如需重启请用 helm-node restart`,
      'already_running',
    );
  }
  if (isAlive(existing.pid)) {
    throw new UsageError(
      `pid ${existing.pid} 存活但控制通道不可达（endpoint ${existing.endpoint}）：无法证实可安全覆盖，拒绝启动；请先 helm-node stop，或人工确认进程身份后删除 ${pidPath(dataDir)}`,
      'control_unreachable',
    );
  }
  // pid 确已死亡：留档过期，清理后继续。
  await removePidFile(dataDir);
}

/**
 * 后台启动入口：持 start 锁完成「已有实例验证 → spawn + 就绪确认 → pid 留档」。
 */
export async function startDaemon(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
): Promise<{ pid: number; logPath: string; readyState: DaemonReadyState }> {
  const isAlive = isAliveOf(io);
  return await withStartLock(dataDir, async () => {
    await assertNoLiveInstance(io, dataDir);
    const instanceId = randomBytes(16).toString('hex');
    const endpoint = controlEndpoint(dataDir, instanceId);
    const spawnDaemon = io.spawnDaemon ?? defaultSpawnDaemon;
    // current release 优先：已升级后 start 必须拉新入口，不能继续跑旧 launcher。
    const target = await resolveDaemonLaunchTarget(dataDir, cliSelfEntry());
    const args = [target.entryPath, 'start', '--data-dir', dataDir];
    if (effectiveHub !== '') args.push('--hub', effectiveHub);
    const { pid, readyState, logPath } = await spawnDaemon({
      nodePath: process.execPath,
      args,
      // 固定 launcher（自身入口）继承同源编译环境；release 入口是编译产物，不带 loader。
      execArgv: target.entryPath === cliSelfEntry() ? inheritExecArgv() : [],
      dataDir,
      // 控制标识经 env 传递（spawnDaemon 收到的 env 即子进程完整 env）。
      env: {
        ...process.env,
        ...(io.env ?? {}),
        HELM_NODE_INSTANCE_ID: instanceId,
        HELM_NODE_CONTROL_ENDPOINT: endpoint,
        ...(target.cliBinDir !== undefined ? { HELM_CLI_BIN_DIR: target.cliBinDir } : {}),
      },
      instanceId,
      endpoint,
      ...(io.readyTimeoutMs !== undefined ? { readyTimeoutMs: io.readyTimeoutMs } : {}),
    });
    try {
      await writePidRecord(dataDir, { pid, instanceId, endpoint });
    } catch (error) {
      const stopped = await controlRequest(endpoint, { type: 'stop', instanceId }, CONTROL_STOP_TIMEOUT_MS, { pid, instanceId })
      if (!stopped?.ok || !(await waitForExit(pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
        throw new AggregateError([error], `PID 留档失败且后台进程 ${pid} 无法确认停止，需人工诊断`)
      }
      // 仅当留档仍指向本次实例才删（可能已被其他写入者接管，不误删他人留档）。
      await removePidFileIfMatch(dataDir, { pid, instanceId, endpoint });
      throw error
    }
    return { pid, logPath, readyState };
  });
}

// ---------------------------------------------------------------------------
// 前台稳定 launcher
// ---------------------------------------------------------------------------

/** launcher 关闭链：经控制通道停止当前实例并等待结果落定（不早退）。 */
async function stopTrackedInstance(io: NodeCliIo, dataDir: string, record: PidRecord): Promise<string | undefined> {
  const response = await controlRequest(
    record.endpoint,
    { type: 'stop', instanceId: record.instanceId },
    CONTROL_STOP_TIMEOUT_MS,
    { pid: record.pid, instanceId: record.instanceId },
  );
  if (response === null || response.ok !== true) {
    return `停止守护进程失败（pid ${record.pid}，endpoint ${record.endpoint}）：${
      response === null ? '控制通道不可达' : response.error ?? 'unknown'
    }；守护进程继续运行，可用 helm-node stop 停止`;
  }
  // 等 stop 结果落定：daemon 真实退出且 pid 留档被 CAS 清理后才返回。
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAliveOf(io)))) {
    return `pid ${record.pid} 在 ${STOP_EXIT_TIMEOUT_MS}ms 内未退出；pid 文件保留供诊断`;
  }
  await removePidFileIfMatch(dataDir, record);
  return undefined;
}

/**
 * 前台稳定 launcher（无控制 env 的 start，systemd/launchd 主进程）：
 * - 调用 startDaemon 拉起受控后台子进程，自身保持存活；
 * - 周期通过 node.pid + 控制通道验证跟踪当前实例：升级换 pid 后自动跟踪
 *   新 daemon（新进程由旧 daemon 经升级交接拉起并改写 pid 留档）；
 * - SIGTERM/INT 经控制通道停止当前实例（验证 pid/instanceId 一致）后退出，
 *   绝不向未经身份验证的进程发信号；
 */
export async function runForegroundLauncher(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
  json: boolean,
): Promise<number> {
  const isAlive = isAliveOf(io);
  // env 覆盖优先于 io 注入：真实子进程 launcher 无法接 io，只能经 env 缩短轮询。
  const envPollMs = Number(io.env?.HELM_NODE_LAUNCHER_POLL_MS ?? '')
  const pollMs = Number.isFinite(envPollMs) && envPollMs > 0 ? envPollMs : (io.launcherPollMs ?? LAUNCHER_POLL_MS)
  const started = await startDaemon(io, dataDir, effectiveHub);
  if (!json) {
    io.out(`helm-node launcher：守护进程 pid ${started.pid}；launcher 保持存活跟踪，Ctrl+C 停止\n`);
  }
  let stopError: string | undefined;
  /** 关闭链 promise：信号触发后启动，返回前必须 await 落定（不让 systemd 早退）。 */
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string): void => {
    if (shutdownPromise !== undefined) return;
    shutdownPromise = (async () => {
      try {
        // 跟踪当前实例：升级后 node.pid 已指向新 daemon（旧 daemon 已退出）。
        const record = await readPidRecord(dataDir);
        if (record !== null && isAlive(record.pid)) {
          const error = await stopTrackedInstance(io, dataDir, record);
          if (error !== undefined) {
            stopError = `launcher 收到 ${reason}，但 ${error}`;
            return;
          }
        }
      } catch (error) {
        stopError = `launcher 关闭异常：${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  };
  const onSigint = (): void => shutdown('SIGINT');
  const onSigterm = (): void => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  // 跟踪循环：留档消失或长期不可验证时如实退出（服务管理器会重启诊断）。
  for (;;) {
    if (shutdownPromise !== undefined) break;
    let record: PidRecord | null;
    try {
      record = await readPidRecord(dataDir);
    } catch (error) {
      stopError = `launcher 读 pid 留档失败：${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    if (record === null) {
      // 守护进程已停（stop 后 pid 文件被删）：launcher 任务完成退出。
      break;
    }
    if (!isAlive(record.pid)) {
      const response = await controlRequest(
        record.endpoint,
        { type: 'status', instanceId: record.instanceId },
        CONTROL_TIMEOUT_MS,
        { pid: record.pid, instanceId: record.instanceId },
      ).catch(() => null);
      if (response !== null && response.ok === true) {
        // pid 复用罕见窗口：留档一致且控制端点验证通过，继续跟踪。
      } else {
        stopError = `守护进程 pid ${record.pid} 已退出且控制通道不可验证；launcher 退出（可用 helm-node start 重启）`;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // 信号监听器清理（finally 语义）；信号触发的关闭链必须 await 落定后才返回
  // （stop 结果确认、pid CAS 清理完成，不让 systemd 在 daemon 退出前早退）；
  // 循环自退路径（留档消失/不可验证）无需停止实例，直接返回。
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  if (shutdownPromise !== undefined) await shutdownPromise;
  if (stopError !== undefined) io.err(`error: ${stopError}\n`);
  return stopError === undefined ? 0 : 1;
}
