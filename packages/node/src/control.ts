/**
 * 实例控制通道：跨平台端点命名、单请求客户端与 daemon 侧 IPC server。
 *
 * - 端点：sha256(dataDir+instanceId) 短 hash；Unix UDS / Windows named pipe；
 * - 协议：单行 JSON ≤64KiB、带空闲/请求预算、验证 instanceId，只接受
 *   status/stop/upgrade——绝不向无关进程发送信号或按键；
 * - 客户端连接失败/超时/响应非法一律返回 null（调用方区分「不可达」与
 *   「被拒绝」）；ok 响应附带期望 pid/instanceId 时校验一致性。
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import { UsageError } from './cli-context.js';

/** 后台守护进程就绪状态：registered=已完成 Hub 注册；starting=进程存活持续重连（可诊断）。 */
export type DaemonReadyState = 'registered' | 'starting';

/** 就绪上报总预算。 */
export const READY_TIMEOUT_MS = 45_000;
/** 控制通道连接/响应/空闲预算（status 查询、stop 请求的通道层上限）。 */
export const CONTROL_TIMEOUT_MS = 5_000;
/** stop 请求总预算：daemon 需先完成 handle.close 执行环境清理再应答。 */
export const CONTROL_STOP_TIMEOUT_MS = 15_000;
/** 控制协议单行上限（字节）；upgrade 请求携带 input，适当增大。 */
export const CONTROL_MAX_LINE_BYTES = 64_096;
/** upgrade 请求总预算：必须大于安装最长时限（npm install 10 分钟）。 */
export const CONTROL_UPGRADE_TIMEOUT_MS = 11 * 60_000;
/** stop 被接受后等待进程真实退出的上限。 */
export const STOP_EXIT_TIMEOUT_MS = 10_000;
/** 旧 daemon 升级提交后延迟退出的时间：给响应冲刷留余量。 */
export const UPGRADE_EXIT_DELAY_MS = 100;

/**
 * 控制端点：sha256(dataDir + instanceId) 短 hash 命名，避免路径超长与碰撞。
 * Unix: /tmp/helm-node-<hash>.sock；Windows: \\.\pipe\helm-node-<hash>。
 */
export function controlEndpoint(dataDir: string, instanceId: string): string {
  const hash = createHash('sha256').update(`${dataDir}\0${instanceId}`).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\helm-node-${hash}` : `/tmp/helm-node-${hash}.sock`;
}

/** 控制通道响应：ok=true 时含真实 pid/instanceId/state；ok=false 时含 error；upgrade 附 result。 */
export interface ControlResponse {
  ok: boolean;
  pid?: number;
  instanceId?: string;
  state?: DaemonReadyState | 'stopping';
  /** status 响应附带的运行版本（daemon 真实上报，经 getNodeVersion 读取）。 */
  version?: string;
  result?: unknown;
  error?: string;
}

/** 控制通道请求载荷（upgrade 携带升级入参）。 */
export interface ControlRequest {
  type: 'status' | 'stop' | 'upgrade';
  instanceId: string;
  input?: unknown;
}

/**
 * 控制通道客户端：单连接单请求（一行 JSON 请求、一行 JSON 响应）。
 * 连接失败/超时/响应非法一律返回 null（调用方区分「不可达」与「被拒绝」）；
 * ok 响应附带期望 pid/instanceId 时验证一致性（本机凭据不能误停另一实例）。
 */
export async function controlRequest(
  endpoint: string,
  request: ControlRequest,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
  expect?: { pid?: number; instanceId?: string },
): Promise<ControlResponse | null> {
  return await new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = net.connect(endpoint);
    const finish = (value: ControlResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_MAX_LINE_BYTES) { finish(null); return }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      if (line === '') return;
      try {
        const parsed = JSON.parse(line) as ControlResponse;
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
          finish(null);
          return;
        }
        // 身份验证：ok 响应必须来自留档指向的同一实例（pid/instanceId 不一致
        // 视为无效响应——本机凭据不能误操作另一实例）。
        if (parsed.ok === true && expect !== undefined) {
          if (expect.pid !== undefined && parsed.pid !== expect.pid) { finish(null); return }
          if (expect.instanceId !== undefined && parsed.instanceId !== expect.instanceId) { finish(null); return }
        }
        finish(parsed);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
  });
}

/**
 * 控制通道 upgrade 响应结果校验（边界处 Schema 校验）：必须是含 ok===true、
 * 布尔 upgraded、非空字符串 previousVersion/targetVersion、正整数 pid（新实例）
 * 的对象；不合法或 ok:false 抛 UsageError，绝不把非法产物当成功输出。
 */
export function validateUpgradeResult(
  raw: unknown,
): { previousVersion: string; targetVersion: string; upgraded: boolean; pid?: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError('升级响应 result 不是合法对象（拒绝伪造成功，请用 helm-node status 核实实际状态）', 'invalid_upgrade_result');
  }
  const record = raw as Record<string, unknown>;
  if (record['ok'] !== true) {
    throw new UsageError(
      `升级响应结果 ok 不为 true（${JSON.stringify(record['ok'] ?? '(缺失)')}，拒绝伪造成功）`,
      'invalid_upgrade_result',
    );
  }
  if (typeof record['upgraded'] !== 'boolean') {
    throw new UsageError('升级响应结果缺少布尔 upgraded 字段（拒绝伪造成功）', 'invalid_upgrade_result');
  }
  for (const key of ['previousVersion', 'targetVersion'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string) === '') {
      throw new UsageError(`升级响应结果缺少非空字符串 ${key}（拒绝伪造成功）`, 'invalid_upgrade_result');
    }
  }
  const pid = record['pid'];
  if ((record['upgraded'] || pid !== undefined) && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new UsageError('升级响应结果缺少新实例正整数 pid（拒绝伪造成功）', 'invalid_upgrade_result');
  }
  return {
    previousVersion: record['previousVersion'] as string,
    targetVersion: record['targetVersion'] as string,
    upgraded: record['upgraded'] as boolean,
    ...(typeof pid === 'number' ? { pid } : {}),
  };
}

/** daemon 侧控制 server：只接受 status/stop/upgrade；instanceId 不匹配一律拒绝且不影响进程。 */
export interface ControlServer {
  listening: Promise<void>;
  close(): Promise<void>;
}

export function createControlServer(options: {
  endpoint: string;
  instanceId: string;
  onStatus: () => { pid: number; state: DaemonReadyState; version?: string };
  onStop: () => Promise<void>;
  /** 升级请求（本机可信源）；返回结果随响应透传，升级在途时拒绝 stop/restart。 */
  onUpgrade?: (input: unknown) => Promise<unknown>;
  /** 升级在途探测（busy 时拒绝 stop/restart，旧控制端点继续可用）。 */
  isUpgrading?: () => boolean;
}): ControlServer {
  const { endpoint, instanceId, onStatus, onStop, onUpgrade, isUpgrading } = options;
  const sockets = new Set<net.Socket>();
  let stopping = false;
  let closed = false;
  /** stop 处理链（含应答冲刷与自清理）：close() 必须先等它完成，防应答被销毁。 */
  let stopChain: Promise<void> | undefined;
  const socketFile = process.platform === 'win32' ? undefined : endpoint;

  const closeSelf = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close 回调在 server 未监听/已关时可能不同步返回：兜底立即 resolve。
      if (!server.listening) resolve();
    });
    if (socketFile !== undefined) await fsp.rm(socketFile, { force: true }).catch(() => undefined);
  };

  /** stop 处理链：等应答真正冲刷到对端后再关 server（destroy 会丢弃未冲刷缓冲）。 */
  const runStopAndClose = async (socket: net.Socket, replyAndWait: (payload: Record<string, unknown>) => Promise<void>): Promise<void> => {
    try {
      await onStop();
      await replyAndWait({ ok: true, pid: process.pid, instanceId, state: 'stopping' });
    } catch (error) {
      await replyAndWait({
        ok: false,
        error: `stop 清理失败：${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined);
    }
    socket.destroy();
    await closeSelf();
  };

  /** upgrade 应答链：长驻执行并等待冲刷（预算远大于 idle 超时）。 */
  const runUpgradeReply = async (
    socket: net.Socket,
    replyAndWait: (payload: Record<string, unknown>) => Promise<void>,
    input: unknown,
  ): Promise<void> => {
    try {
      const result = await onUpgrade?.(input);
      await replyAndWait({ ok: true, pid: process.pid, instanceId, state: onStatus().state, result });
    } catch (error) {
      await replyAndWait({
        ok: false,
        pid: process.pid,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    socket.destroy();
  };

  const server = net.createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => { clearTimeout(idle); sockets.delete(socket) });
    let buffer = '';
    let handled = false;
    const idle = setTimeout(() => socket.destroy(), CONTROL_TIMEOUT_MS);
    const reply = (payload: Record<string, unknown>): void => {
      try {
        socket.end(`${JSON.stringify(payload)}\n`);
      } catch {
        socket.destroy();
      }
    };
    /** 同 reply，但等待数据真正冲刷（stop/upgrade 路径销毁 socket 前必须保证应答可达）。 */
    const replyAndWait = (payload: Record<string, unknown>): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(done, 1_000);
        fallback.unref?.();
        try {
          socket.end(`${JSON.stringify(payload)}\n`, done);
        } catch {
          done();
        }
      });
    socket.on('error', () => {
      clearTimeout(idle);
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_MAX_LINE_BYTES) { clearTimeout(idle); socket.destroy(); return }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      if (handled) return;
      handled = true;
      clearTimeout(idle);
      const line = buffer.slice(0, nl).trim();
      let request: { type?: unknown; instanceId?: unknown; input?: unknown };
      try {
        request = JSON.parse(line) as { type?: unknown; instanceId?: unknown; input?: unknown };
      } catch {
        reply({ ok: false, error: 'bad_request' });
        return;
      }
      // 身份门槛：instanceId 不一致一律拒绝（绝不触发停止，防误杀无关实例）。
      if (request === null || typeof request !== 'object' || request.instanceId !== instanceId) {
        reply({ ok: false, error: 'instance_mismatch' });
        return;
      }
      if (request.type === 'status') {
        const snapshot = onStatus();
        reply({ ok: true, pid: snapshot.pid, instanceId, state: snapshot.state, ...(snapshot.version !== undefined ? { version: snapshot.version } : {}) });
        return;
      }
      if (request.type === 'stop') {
        if (stopping) {
          reply({ ok: false, error: 'stopping' });
          return;
        }
        // 升级在途：明确拒绝 stop（候选可能已接管职责），旧控制端点继续可用。
        if (isUpgrading?.() === true) {
          reply({ ok: false, error: 'upgrade_in_progress' });
          return;
        }
        stopping = true;
        server.close(() => undefined); // 立即停止接受新连接；存量连接由本分支应答
        stopChain = runStopAndClose(socket, replyAndWait);
        return;
      }
      if (request.type === 'upgrade') {
        // 升级预算远大于 idle 超时：受理后先清 idle，长驻到应答完成。
        if (onUpgrade === undefined) {
          reply({ ok: false, error: 'upgrade_not_supported' });
          return;
        }
        if (stopping) {
          reply({ ok: false, error: 'stopping' });
          return;
        }
        clearTimeout(idle);
        void runUpgradeReply(socket, replyAndWait, (request as { input?: unknown }).input);
        return;
      }
      reply({ ok: false, error: 'unknown_command' });
    });
  });

  const listening = new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  return {
    listening,
    close: async (): Promise<void> => {
      // 先等在途 stop 链（含应答冲刷）完成，再硬清理——否则应答会被销毁丢失。
      if (stopChain !== undefined) await stopChain.catch(() => undefined);
      await closeSelf();
    },
  };
}
