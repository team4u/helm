/**
 * 节点侧 TCP 隧道处理器（nodeTunnelOpen / nodeTunnelAbort）：Hub 请求在
 * 节点侧向目标 host:port（host 缺省 127.0.0.1，由本节点解析与连接）建立
 * TCP，与 daemon 层注入的 openTunnelStream 双工流（WS 隧道，hubUrl/token
 * 等凭据由 daemon 层封闭）双向 pipe——本层零凭据。draining/disposed 拒绝
 * 新隧道（draining 为 node_draining，disposed 为 aborted）；TCP 在隧道
 * 握手期间 pause，pipe 后不丢首包；dispose 销毁全部隧道 TCP/双工流并等待
 * settle。受理守卫与 dispose 排空接线由 env-rpc-server 组装。
 */

import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { RpcEnvError, RpcResult } from '@helm/protocol';
import { drainingRejection, invalidInput, isRecord, rpcFail } from './env-rpc-shared.js';

/** 隧道建立（TCP connect + 双工流握手）总预算，自受理起算（非分段叠加）。 */
const TUNNEL_OPEN_DEFAULT_MS = 15_000;
/** 目标 host 缺省值：节点本机回环（与既有 loopback 语义兼容）。 */
const TUNNEL_DEFAULT_HOST = '127.0.0.1';
/** host 上限：IPv6 文本形式最长约 45 字符，主机名一般 ≤253；适度留余。 */
const TUNNEL_HOST_MAX_CHARS = 255;

/**
 * host 边界校验：非空字符串、≤255 字符、无控制字符/首尾空白；
 * 非法即抛 invalid（绝不静默改写或回退回环）。
 */
const assertValidTunnelHost = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > TUNNEL_HOST_MAX_CHARS) {
    throw Object.assign(
      new Error(`nodeTunnelOpen host must be a non-empty string of 1..${TUNNEL_HOST_MAX_CHARS} characters`),
      { code: 'invalid' },
    );
  }
  // 控制字符（含 NUL/CR/LF/Tab）与任何空白（含内部空格）一律拒绝：
  // 主机名不允许空白（防解析歧义与注入）。
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x20) {
      throw Object.assign(new Error('nodeTunnelOpen host must not contain control or whitespace characters'), { code: 'invalid' });
    }
  }
  if (raw.trim() !== raw) {
    throw Object.assign(new Error('nodeTunnelOpen host must not have leading/trailing whitespace'), { code: 'invalid' });
  }
  return raw;
};

interface ActiveTunnel {
  tunnelId: string;
  tcp: net.Socket;
  duplex?: Duplex;
  /** 建连取消器：握手中 abort 立即失败，不等到预算耗尽。 */
  controller: AbortController;
  /** 双端销毁后 resolve（dispose 排空用）。 */
  lifecycle: Promise<void>;
  settle(): void;
}

/** 隧道处理器依赖（宿主注入的传输与连接生命周期状态查询）。 */
export interface TunnelHandlerOptions {
  /**
   * 打开隧道双工流（daemon 层注入：连接 Hub 的 /ws/node-tunnel 并完成握手）。
   * signal 用于取消在途建连（nodeTunnelAbort / dispose）：实现应尽快
   * reject 并销毁底层资源；本层只消费双工流，零凭据。
   */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
  /** 宿主 disposed 状态查询（连接级终态：拒新为 aborted）。 */
  isDisposed(): boolean;
  /** 宿主 draining 状态查询（升级排空：拒新为 node_draining）。 */
  isDraining(): boolean;
}

/** 隧道处理器句柄：RPC 实现面 + dispose 销毁钩子与排空内省。 */
export interface TunnelHandler {
  /** 打开隧道（严格校验入参；draining/disposed/connect 失败结构化拒新）。 */
  nodeTunnelOpen(raw: unknown): Promise<RpcResult<null>>;
  /** 取消在途隧道（握手中或已建立）：销毁该隧道的 TCP/WS 并立即返回。 */
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** dispose 钩子：销毁全部隧道 TCP/双工流并结算生命周期（teardown 幂等）。 */
  destroyAllTunnels(): void;
  /** 在途隧道数量（排空内省；含 TCP 已发起未完成握手的隧道）。 */
  getActiveTunnelCount(): number;
  /** dispose 排空等待的隧道生命周期 promise 集合（活引用，排空时展开快照）。 */
  getTunnelWaiters(): Set<Promise<void>>;
}

/** 创建隧道处理器：一个连接代一个实例，状态互不共享。 */
export function createTunnelHandler(options: TunnelHandlerOptions): TunnelHandler {
  const { openTunnelStream, isDisposed, isDraining } = options;
  const activeTunnels = new Map<string, ActiveTunnel>();
  const tunnelWaiters = new Set<Promise<void>>();

  const newTunnel = (tunnelId: string, tcp: net.Socket): ActiveTunnel => {
    let settle!: () => void;
    const lifecycle = new Promise<void>((resolve) => { settle = resolve; });
    const tunnel: ActiveTunnel = { tunnelId, tcp, controller: new AbortController(), lifecycle, settle };
    tunnelWaiters.add(lifecycle);
    activeTunnels.set(tunnelId, tunnel);
    return tunnel;
  };

  /** 销毁单个隧道（幂等）：abort 建连、销毁 TCP/双工流并结算生命周期。 */
  const teardownTunnel = (tunnel: ActiveTunnel): void => {
    if (activeTunnels.get(tunnel.tunnelId) !== tunnel) return;
    activeTunnels.delete(tunnel.tunnelId);
    tunnel.controller.abort(new Error('tunnel aborted'));
    try { tunnel.tcp.destroy(); } catch { /* 已销毁 */ }
    if (tunnel.duplex !== undefined) {
      // duplexify 无 error 监听时 destroy 会以未处理 'error' 崩进程；
      // 兑底监听后 destroy（同步抛出与异步 rejection 均吸收）。
      tunnel.duplex.once('error', () => undefined);
      try { void Promise.resolve(tunnel.duplex.destroy()).catch(() => undefined); } catch { /* 同步抛出 */ }
    }
    tunnelWaiters.delete(tunnel.lifecycle);
    tunnel.settle();
  };

  const nodeTunnelOpenCore = async (raw: unknown): Promise<RpcResult<null>> => {
    // 边界严格校验：plain object、字段白名单、值域——未知字段一律拒绝。
    if (!isRecord(raw) || Array.isArray(raw)) return invalidInput('nodeTunnelOpen input must be a plain object');
    const unknownFields = Object.keys(raw).filter(
      (key) => key !== 'tunnelId' && key !== 'port' && key !== 'timeoutMs' && key !== 'host',
    );
    if (unknownFields.length > 0) {
      return invalidInput(`nodeTunnelOpen rejects unknown field(s): ${unknownFields.join(', ')}`);
    }
    const tunnelId = raw['tunnelId'];
    if (typeof tunnelId !== 'string' || tunnelId.length === 0 || tunnelId.length > 128) {
      return invalidInput('nodeTunnelOpen tunnelId must be a string of 1..128 characters');
    }
    const port = raw['port'];
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return invalidInput('nodeTunnelOpen port must be a safe integer within 1..65535');
    }
    let host: string;
    try {
      host = assertValidTunnelHost(raw['host']) ?? TUNNEL_DEFAULT_HOST;
    } catch (error) {
      return rpcFail(error);
    }
    const rawTimeout = raw['timeoutMs'];
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
      return invalidInput('nodeTunnelOpen timeoutMs must be a positive finite number when present');
    }
    if (typeof openTunnelStream !== 'function') {
      return {
        ok: false,
        error: { code: 'not_supported', message: 'node daemon 未配置隧道传输（openTunnelStream 缺失），拒绝 nodeTunnelOpen：不伪造隧道' },
      };
    }
    if (activeTunnels.has(tunnelId)) {
      return invalidInput(`nodeTunnelOpen tunnelId is already active: ${JSON.stringify(tunnelId)}`);
    }
    if (isDraining() || isDisposed()) {
      return {
        ok: false,
        // draining 拒新为稳定码 node_draining；disposed 是连接级终态，保持 aborted。
        error: isDisposed()
          ? { code: 'aborted', message: 'server disposed' }
          : drainingRejection('tunnels'),
      };
    }
    // 总预算自受理起算（TCP connect 与 WS 握手共用，非各 15s）。
    const budgetMs = typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : TUNNEL_OPEN_DEFAULT_MS;
    // 目标 host:port 由 Hub 指定：节点负责解析与连接（net.connect 支持主机名与 IP 文本）。
    const target = `${host}:${port}`;
    const tcp = net.connect({ host, port });
    const tunnel = newTunnel(tunnelId, tcp);
    // 统一 settle：整个建立过程（TCP connect + WS 握手）只结算一次。
    let settled = false;
    let settleResult: (result: RpcResult<null>) => void = () => undefined;
    const rpcResult = new Promise<RpcResult<null>>((resolve) => { settleResult = resolve; });
    const settleOnce = (result: RpcResult<null>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      settleResult(result);
    };
    // TCP 错误归一 connect_failed（protocol NodeTunnelErrorCode；系统码保留在 message，不外溢到 code）。
    const connectFailed = (detail: string): RpcEnvError => ({
      code: 'connect_failed',
      message: `tunnel TCP connect to ${target} failed: ${detail}`,
    });
    const budgetTimer = setTimeout(() => {
      settleOnce({ ok: false, error: { code: 'timeout', message: `tunnel open timed out after ${budgetMs}ms (${target})` } });
      teardownTunnel(tunnel);
    }, budgetMs);
    // error 自 socket 创建起挂统一处理（connect 成功后不摘除）：握手等待期/
    // pipe 期的 socket 错误统一 settle+teardown，绝不未捕获崩进程。
    const onTcpError = (error: Error): void => {
      if (activeTunnels.get(tunnelId) !== tunnel) return;
      settleOnce({ ok: false, error: connectFailed(error.message) });
      teardownTunnel(tunnel);
    };
    tcp.on('error', onTcpError);
    // TCP 连接（共用总预算）：失败/超时销毁并返回结构化错误（如端口拒绝）。
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once('connect', () => resolve());
        // onTcpError 已统一 settle；此处仅防 promise 悬挂。
        tcp.once('error', (error) => reject(connectFailed(error.message)));
        tunnel.controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('tunnel aborted'), { code: 'aborted' })),
          { once: true },
        );
      });
    } catch {
      // abort（nodeTunnelAbort/dispose）或连接失败：细节已 settle；teardown
      // 后如实返回（abort 语义优先，未 settle 的极端路径按连接失败兜底）。
      if (!settled) {
        settleOnce(
          tunnel.controller.signal.aborted
            ? { ok: false, error: { code: 'aborted', message: 'tunnel aborted' } }
            : { ok: false, error: connectFailed('connection failed') },
        );
      }
      teardownTunnel(tunnel);
      return await rpcResult;
    }
    // 暂停 TCP：openTunnelStream 握手期间缓冲对端首批数据，pipe 后不丢首包。
    tcp.pause();
    // 双工流握手（共用总预算，传 signal：abort 立即失败不等预算；迟到
    // resolve 的流立即销毁防泄漏）。
    let handshakeDone = false;
    const streamPromise = Promise.resolve(openTunnelStream(tunnelId, tunnel.controller.signal));
    void streamPromise.then(
      (late) => { if (handshakeDone || activeTunnels.get(tunnelId) !== tunnel) late.destroy(); },
      () => undefined, // 失败路径由下方 await 分支统一处理
    );
    let duplex: Duplex;
    try {
      duplex = await new Promise<Duplex>((resolve, reject) => {
        tunnel.controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('tunnel aborted'), { code: 'aborted' })),
          { once: true },
        );
        streamPromise.then(
          (stream) => resolve(stream),
          (error) => reject(error),
        );
      });
    } catch (error) {
      handshakeDone = true;
      settleOnce(rpcFail(error));
      teardownTunnel(tunnel);
      return await rpcResult;
    }
    if (settled || activeTunnels.get(tunnelId) !== tunnel) {
      // 建连期间已超时/abort：迟到到达的流立即销毁，绝不 pipe 到已销毁 TCP。
      handshakeDone = true;
      duplex.destroy();
      return await rpcResult;
    }
    handshakeDone = true;
    tunnel.duplex = duplex;
    settleOnce({ ok: true, value: null });
    // 正常结束走 pipe 的 end 语义：对端 end → duplex readable end →
    // duplex.pipe(tcp) 触发 tcp.end()（flush 完整响应后 FIN）→ close 销毁
    // 双端；error/close/aborted 才立即销毁两端，不掐断 flush 中的数据。
    const teardown = (): void => teardownTunnel(tunnel);
    duplex.once('error', teardown);
    duplex.once('close', teardown);
    duplex.once('aborted', teardown);
    tcp.pipe(duplex);
    duplex.pipe(tcp);
    return await rpcResult;
  };

  const teardownTunnelById = (tunnelId: string): void => {
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel === undefined) return;
    teardownTunnel(tunnel);
  };

  /** 取消在途隧道（握手中或已建立）：立即销毁 TCP/WS 并返回。 */
  const nodeTunnelAbort = async (tunnelId: string): Promise<void> => {
    teardownTunnelById(tunnelId);
  };

  return {
    nodeTunnelOpen: nodeTunnelOpenCore,
    nodeTunnelAbort,
    destroyAllTunnels: () => {
      for (const tunnel of [...activeTunnels.values()]) teardownTunnel(tunnel);
    },
    getActiveTunnelCount: () => activeTunnels.size,
    getTunnelWaiters: () => tunnelWaiters,
  };
}
