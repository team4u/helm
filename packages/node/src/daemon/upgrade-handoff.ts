/**
 * helm-node 升级交接 IPC（CLI 侧，运行在旧 daemon 进程内）。
 *
 * 协议（Node 原生 stdio IPC，单通道三阶段）：
 *  1) 候选真实 registered 后上报 {type:'helm-node.ready', pid, instanceId,
 *     state:'registered'}；state 为 starting 一律视为未就绪（升级要求真实
 *     注册，不允许带病提交）；
 *  2) commit() 是唯一提交点：先原子写新 node.pid（内存备份旧记录），再发
 *     {type:'helm-node.activate', attemptId, version, previousVersion, pid}，
 *     等候选本机 {type:'helm-node.activated'} 确认才 resolve——Hub ACK 不作
 *     为本机 IPC 成功条件（候选侧 confirmUpgrade 本地落地后异步重试 Hub）；
 *  3) activate 发出后确认丢失（断开/超时/候选退出）只抛
 *     UpgradeCommitUnconfirmedError：绝不 kill 候选、绝不回滚 pid——候选
 *     可能已向 Hub 上报提交，反向回滚会让已成功的升级被撤销。
 *
 * 确定性未提交（候选显式 activate-rejected，或 activate 尚未发出的任何失败）
 * 才允许 abort()：杀自有 child 并按 instanceId CAS 还原旧 pid；留档已被他人
 * 接管时不动（绝不误删他人的 node.pid）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { UpgradeCommitUnconfirmedError, type PreparedNodeReplacement, type StagedNodeRelease } from './upgrader.js';

/** 候选就绪预算：覆盖 Hub 短暂不可达时的数次退避重连（与候选侧注册等待同量级）。 */
export const CANDIDATE_READY_TIMEOUT_MS = 150_000;
/** activate 发出后等待本机 activated 确认的预算。 */
export const ACTIVATE_ACK_TIMEOUT_MS = 30_000;

/** 升级交接上下文（与引擎 prepareReplacement 回调的 context 同源）。 */
export interface UpgradeHandoffContext {
  attemptId: string;
  previousVersion: string;
  targetVersion: string;
}

/** pid 留档内容（与 cli.ts 的 PidRecord 结构一致，避免循环依赖单独声明）。 */
export interface HandoffPidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

export interface PrepareNodeReplacementOptions {
  dataDir: string;
  hubUrl: string;
  /** 候选日志落点（与守护进程共用 node.log）。 */
  logPath: string;
  controlEndpoint(dataDir: string, instanceId: string): string;
  readPidRecord(): Promise<HandoffPidRecord | null>;
  writePidRecord(record: HandoffPidRecord): Promise<void>;
  removePidFile(): Promise<void>;
  /** 候选基础环境（缺省 process.env；测试可注入）。 */
  env?: NodeJS.ProcessEnv;
  /** node 可执行（缺省 process.execPath；测试注入）。 */
  execPath?: string;
  readyTimeoutMs?: number;
  activateAckTimeoutMs?: number;
}

/** 候选侧协议消息（与 cli.ts 候选分支约定一致；测试 fixture 同步实现）。 */
export interface ActivateMessage {
  type: 'helm-node.activate';
  attemptId: string;
  version: string;
  previousVersion: string;
  pid: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** 有界日志尾读：只读文件末尾最多 64KiB，再取最后 maxLines 行（日志再大也不全量读入）。 */
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
 * 准备替换 daemon：以受控后台方式拉起候选 release 入口（无 tsx loader、全新
 * instanceId/endpoint、不继承父控制 env、清 HELM_VERSION_OVERRIDE），候选真实
 * registered 后返回 {pid, commit, abort}。native stdio IPC 保留到本机提交完成。
 */
export async function prepareNodeReplacement(
  release: StagedNodeRelease,
  context: UpgradeHandoffContext,
  options: PrepareNodeReplacementOptions,
): Promise<PreparedNodeReplacement> {
  if (options.hubUrl === '') {
    throw new Error('升级交接需要 Hub 地址（候选守护进程据此注册）');
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? CANDIDATE_READY_TIMEOUT_MS;
  const activateAckTimeoutMs = options.activateAckTimeoutMs ?? ACTIVATE_ACK_TIMEOUT_MS;
  const instanceId = randomBytes(16).toString('hex');
  const endpoint = options.controlEndpoint(options.dataDir, instanceId);
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // 候选拥有独立控制身份：不复用父 instanceId/endpoint；清版本覆盖确保上报
  // 真实运行版本；去 NODE_OPTIONS 防 dev 父进程向编译产物注入 tsx loader。
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
    throw new Error(`打开候选日志文件失败（${options.logPath}）：${error instanceof Error ? error.message : String(error)}`);
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
    throw new Error(`候选守护进程 spawn 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const killChild = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出。
    }
    try {
      if (child.connected) child.disconnect();
    } catch {
      // 已断开。
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
        ? `候选上报 starting：升级要求真实 registered（attemptId ${context.attemptId}），拒绝带病提交`
        : ready.kind === 'error'
          ? `候选守护进程启动失败（spawn error）：${ready.error.message}`
          : ready.kind === 'exit'
            ? `候选守护进程启动后立即退出（code=${ready.code ?? 'null'}）`
            : `候选 ${readyTimeoutMs}ms 内未上报 registered 就绪`;
    const tail = await readLogTailBounded(options.logPath, 40);
    throw new Error(`${reason}${tail !== '' ? `\n--- ${options.logPath} 最后 40 行 ---\n${tail}` : ''}`);
  }
  if (child.pid === undefined) {
    killChild();
    await logHandle.close().catch(() => undefined);
    throw new Error('候选就绪后 pid 不可用（内部错误）');
  }
  const candidatePid = child.pid;
  // 父侧日志 fd 已 dup 进子进程：候选存活期间持有写端，父侧可关闭。
  await logHandle.close().catch(() => undefined);
  child.unref();

  // —— activate/ack 状态机 ————————————————————————————————————————
  type Phase = 'ready' | 'activating' | 'activated' | 'rejected' | 'lost' | 'dead';
  let phase: Phase = 'ready';
  let activateSent = false;
  let pidWritten = false;
  let oldRecord: HandoffPidRecord | null = null;
  let rejectReason = '';
  type AckOutcome = 'activated' | 'rejected' | 'lost' | 'dead' | 'timeout';
  let settleAck: ((outcome: AckOutcome) => void) | undefined;
  const finishAck = (outcome: AckOutcome): void => {
    if (phase !== 'activating') return;
    phase = outcome === 'activated' ? 'activated' : outcome === 'rejected' ? 'rejected' : outcome === 'dead' ? 'dead' : 'lost';
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
    if (phase === 'activating') finishAck('dead');
    else if (phase === 'ready') phase = 'dead';
  });
  child.once('disconnect', () => {
    if (phase === 'activating') finishAck('lost');
  });

  const commit = async (): Promise<void> => {
    if (phase === 'activated') return; // 幂等
    if (phase !== 'ready') {
      throw new Error(`候选不在可提交状态（${phase}${phase === 'dead' ? '：候选已退出' : ''}），activate 未发出`);
    }
    if (!child.connected) {
      phase = 'dead';
      throw new Error('候选 IPC 通道已断开（activate 未发出，安全回滚）');
    }
    // 提交点前奏：备份旧留档并原子写新记录；旧记录用于 abort 的 CAS 还原。
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
          if (error !== undefined && error !== null) finishAck('lost'); // 写通道失败：送达状态未知，按丢失处理
        });
      } catch {
        finishAck('lost');
      }
    });
    if (outcome === 'activated') {
      try {
        if (child.connected) child.disconnect();
      } catch {
        // 已断开。
      }
      child.unref();
      return;
    }
    if (outcome === 'rejected') {
      throw new Error(`候选拒绝激活：${rejectReason}（未提交，安全回滚）`);
    }
    if (outcome === 'dead') {
      throw new UpgradeCommitUnconfirmedError(`候选在激活确认前退出（activate 已发出，可能已完成本机提交），不回滚`);
    }
    if (outcome === 'timeout') {
      throw new UpgradeCommitUnconfirmedError(`等待 activated 确认超时（${activateAckTimeoutMs}ms，activate 已发出），不回滚`);
    }
    throw new UpgradeCommitUnconfirmedError('activate 已发出但本机 IPC 确认丢失（通道断开），不回滚');
  };

  const abort = async (): Promise<void> => {
    if (phase === 'activated') {
      throw new Error('候选已激活：拒绝 abort（不得回滚已提交的替换）');
    }
    if (activateSent && phase !== 'rejected') {
      throw new Error('activate 已发出且未收到显式拒绝：拒绝 abort（不得杀候选或回滚 pid）');
    }
    killChild();
    if (pidWritten) {
      // instanceId CAS：只有留档仍指向本候选时才还原，已被他人接管则不动。
      const current = await options.readPidRecord().catch(() => null);
      if (current !== null && current.instanceId === instanceId) {
        if (oldRecord !== null) await options.writePidRecord(oldRecord);
        else await options.removePidFile();
      }
    }
  };

  return { pid: candidatePid, commit, abort };
}
