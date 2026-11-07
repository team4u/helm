/**
 * 零副作用只读自检（helm-node doctor）。
 *
 * 四项检查全部只读（零磁盘写入、零破坏性操作）：
 * 1. identity：`<dataDir>/node.json` 存在、结构合法（readNodeIdentity）且
 *    非 win32 平台权限位为 0600；文件缺失/损坏/权限过宽均报 error 并给修复
 *    提示，绝不输出 token；
 * 2. privilege：当前账户为 root 或具备免密 sudo 时显式 warn（Agent bash 将
 *    拥有整机最高权限，生产/边缘环境建议受限账户），否则 ok；
 * 3. hub：向 hubUrl 发起一次真实 /ws/node?nodeId=<id> 握手并调用 register
 *    （附带健康快照），测量 RTT 后立即关闭连接；失败或未配置报 error；
 * 4. herdr_ipc：解析本机 Herdr IPC 端点并 net.connect（1s 超时）探测可达性；
 *    socket 不存在/未运行仅标 info（可选能力，不阻断基础节点执行）。
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createBirpc } from 'birpc';
import type { NodeRegisterResult } from '@helm/protocol';
import { resolveHerdrIpcEndpoint } from './env-rpc-server.js';
import { collectNodeHealth, readNodeIdentity, resolveNodeDataDir, type HubSideFunctions } from './index.js';

export type NodeDoctorCheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface NodeDoctorCheck {
  id: 'identity' | 'privilege' | 'hub' | 'herdr_ipc';
  status: NodeDoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface NodeDoctorReport {
  ok: boolean;
  dataDir: string;
  nodeId?: string;
  hubUrl?: string;
  checks: NodeDoctorCheck[];
}

export interface NodeDoctorOptions {
  dataDir?: string;
  hubUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试可注入权限探测（缺省检查 process.getuid?.() === 0 或 `sudo -n true`）。 */
  checkPrivilege?: () => Promise<{ isRoot: boolean; passwordlessSudo: boolean }>;
  /** Hub 连通性探测超时（毫秒，默认 5000）。 */
  connectTimeoutMs?: number;
}

/** 免密 sudo 探测超时。 */
const SUDO_PROBE_TIMEOUT_MS = 1_500;
/** Herdr IPC 探测超时。 */
const HERDR_IPC_PROBE_TIMEOUT_MS = 1_000;

/** 运行 `sudo -n true`（绝不交互等待密码）；超时/失败均按不具备免密 sudo 处理。 */
async function probePasswordlessSudo(env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('sudo', ['-n', 'true'], {
        stdio: 'ignore',
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
      finish(false);
    }, SUDO_PROBE_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

/** identity 检查：存在性 + 结构合法性（复用 readNodeIdentity）+ 非 win32 权限位 0600。 */
async function checkIdentity(dataDir: string): Promise<NodeDoctorCheck & { identity: Awaited<ReturnType<typeof readNodeIdentity>> }> {
  const file = path.join(dataDir, 'node.json');
  let identity: Awaited<ReturnType<typeof readNodeIdentity>> = null;
  try {
    identity = await readNodeIdentity(dataDir);
  } catch (error) {
    return {
      id: 'identity',
      status: 'error',
      message: `节点身份文件无法读取（${error instanceof Error ? error.message : String(error)}）；请人工确认后删除 ${file} 并重新 helm-node connect <hubUrl> --token <token> 绑定`,
      identity,
    };
  }
  if (identity === null) {
    return {
      id: 'identity',
      status: 'error',
      message: `未找到节点身份文件 ${file}；请先 helm-node connect <hubUrl> --token <token> 绑定 JOIN 令牌`,
      identity,
    };
  }
  if (process.platform !== 'win32') {
    let mode: number;
    try {
      mode = (await fs.stat(file)).mode & 0o777;
    } catch (error) {
      return {
        id: 'identity',
        status: 'error',
        message: `无法读取身份文件权限（${file}）：${error instanceof Error ? error.message : String(error)}`,
        identity,
      };
    }
    if (mode !== 0o600) {
      return {
        id: 'identity',
        status: 'error',
        message: `节点身份文件权限为 ${mode.toString(8).padStart(3, '0')}，要求 0600（含机密 token 不得对其他用户可读）；请执行 chmod 600 ${file} 修复`,
        details: { nodeId: identity.nodeId, mode: mode.toString(8).padStart(3, '0') },
        identity,
      };
    }
    return {
      id: 'identity',
      status: 'ok',
      message: `节点身份有效（nodeId=${identity.nodeId}，权限 0600）`,
      details: { nodeId: identity.nodeId, mode: '0600' },
      identity,
    };
  }
  return {
    id: 'identity',
    status: 'ok',
    message: `节点身份有效（nodeId=${identity.nodeId}）`,
    details: { nodeId: identity.nodeId },
    identity,
  };
}

/** privilege 检查：root / 免密 sudo 即 warn（诚实告知 Agent bash 权限边界）。 */
async function checkPrivilege(
  env: NodeJS.ProcessEnv,
  injected?: () => Promise<{ isRoot: boolean; passwordlessSudo: boolean }>,
): Promise<NodeDoctorCheck> {
  let probe: { isRoot: boolean; passwordlessSudo: boolean };
  if (injected !== undefined) {
    probe = await injected();
  } else {
    const isRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
    const passwordlessSudo = !isRoot && process.platform !== 'win32' && (await probePasswordlessSudo(env));
    probe = { isRoot, passwordlessSudo };
  }
  if (probe.isRoot || probe.passwordlessSudo) {
    return {
      id: 'privilege',
      status: 'warn',
      message:
        '当前账户具备 root 或免密 sudo 权限，Agent 执行 bash 工具将拥有整机最高权限；生产/边缘环境建议使用受限账户运行',
      details: { isRoot: probe.isRoot, passwordlessSudo: probe.passwordlessSudo },
    };
  }
  return { id: 'privilege', status: 'ok', message: '当前账户不具备 root 或免密 sudo 权限（受限权限运行）' };
}

/** hub 检查：真实 /ws/node 握手 + register（附健康快照），测量 RTT 后立即关闭。 */
async function checkHub(
  hubUrl: string,
  nodeId: string,
  token: string,
  dataDir: string,
  connectTimeoutMs: number,
): Promise<NodeDoctorCheck & { heartbeatMs?: number }> {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return { id: 'hub', status: 'error', message: `Hub 地址无法解析：${hubUrl}` };
  }
  const wsUrl = `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}${parsed.pathname.replace(/\/+$/, '')}/ws/node?nodeId=${encodeURIComponent(nodeId)}`;
  const health = await collectNodeHealth(dataDir).catch(() => undefined);
  return await new Promise<NodeDoctorCheck & { heartbeatMs?: number }>((resolve) => {
    let settled = false;
    let hubRpc: ReturnType<typeof createBirpc<HubSideFunctions, object>> | undefined;
    const started = Date.now();
    const socket = new WebSocket(wsUrl);
    const finish = (check: NodeDoctorCheck & { heartbeatMs?: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        hubRpc?.$close();
      } catch {
        // 已关闭。
      }
      try {
        socket.terminate();
      } catch {
        // 已关闭。
      }
      resolve(check);
    };
    const timer = setTimeout(
      () => finish({ id: 'hub', status: 'error', message: `Hub 连通性探测超时（${connectTimeoutMs}ms）：${hubUrl}` }),
      connectTimeoutMs,
    );
    socket.once('open', () => {
      hubRpc = createBirpc<HubSideFunctions, object>(
        {
          register: async () => ({ ok: true, heartbeatMs: 15_000 }),
          heartbeat: async () => true,
          onEnvExecOutput: () => undefined,
        },
        {
          post: (data) => {
            if (socket.readyState !== WebSocket.OPEN) throw new Error('ws closed');
            socket.send(JSON.stringify(data));
          },
          on: (callback) => {
            socket.on('message', (raw) => {
              const text = typeof raw === 'string' ? String(raw) : Buffer.from(raw as ArrayBuffer).toString('utf8');
              try {
                callback(JSON.parse(text) as never);
              } catch {
                // 非法帧按无响应处理，由外层超时兜底。
              }
            });
          },
          off: (callback) => {
            socket.off('message', callback as never);
          },
          serialize: (data) => data,
          deserialize: (data) => data as never,
        },
      );
      void hubRpc
        .register({
          nodeId,
          token,
          hostname: os.hostname(),
          platform: process.platform,
          hubUrl,
          ...(health !== undefined ? { health } : {}),
        })
        .then((result: NodeRegisterResult) => {
          const rttMs = Date.now() - started;
          if (result?.ok === true) {
            finish({
              id: 'hub',
              status: 'ok',
              message: `Hub 连通正常（${hubUrl}，往返 ${rttMs}ms）`,
              details: { hubUrl, rttMs, heartbeatMs: result.heartbeatMs },
              heartbeatMs: result.heartbeatMs,
            });
            return;
          }
          finish({
            id: 'hub',
            status: 'error',
            message: `Hub 注册被拒绝（${result?.reason ?? 'invalid token'}）：${hubUrl}`,
            details: { hubUrl },
          });
        })
        .catch((error: unknown) => {
          finish({
            id: 'hub',
            status: 'error',
            message: `Hub 注册调用失败（${error instanceof Error ? error.message : String(error)}）：${hubUrl}`,
            details: { hubUrl },
          });
        });
    });
    socket.once('unexpected-response', (_req, res) => {
      try {
        res.resume();
      } catch {
        // 忽略。
      }
      finish({ id: 'hub', status: 'error', message: `Hub 拒绝 WebSocket 握手（HTTP ${res.statusCode}）：${hubUrl}`, details: { hubUrl } });
    });
    socket.once('error', (error) => {
      finish({
        id: 'hub',
        status: 'error',
        message: `Hub 连接失败（${error instanceof Error ? error.message : String(error)}）：${hubUrl}`,
        details: { hubUrl },
      });
    });
    socket.once('close', () => {
      if (!settled) {
        finish({ id: 'hub', status: 'error', message: `Hub 连接在注册完成前关闭：${hubUrl}`, details: { hubUrl } });
      }
    });
  });
}

/** herdr_ipc 检查：解析端点并探测可达（socket 缺失仅 info，可选能力）。 */
async function checkHerdrIpc(env: NodeJS.ProcessEnv): Promise<NodeDoctorCheck> {
  let endpoint: string;
  try {
    endpoint = resolveHerdrIpcEndpoint({}, { getEnv: (k: string) => env[k] });
  } catch (error) {
    return {
      id: 'herdr_ipc',
      status: 'info',
      message: `无法解析 Herdr IPC 端点：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return await new Promise<NodeDoctorCheck>((resolve) => {
    let settled = false;
    const socket = net.connect(endpoint);
    const finish = (check: NodeDoctorCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(check);
    };
    const timer = setTimeout(
      () => finish({ id: 'herdr_ipc', status: 'info', message: '未检测到运行中的 Herdr IPC（可选能力，不影响基础节点执行）', details: { endpoint } }),
      HERDR_IPC_PROBE_TIMEOUT_MS,
    );
    socket.once('connect', () => {
      finish({ id: 'herdr_ipc', status: 'ok', message: `Herdr IPC 可达（${endpoint}）`, details: { endpoint } });
    });
    socket.once('error', () => {
      finish({ id: 'herdr_ipc', status: 'info', message: '未检测到运行中的 Herdr IPC（可选能力，不影响基础节点执行）', details: { endpoint } });
    });
  });
}

/**
 * 执行只读自检并返回报告：ok 当且仅当没有任何 check.status === 'error'
 * （warn 与 info 不置 false）。hubUrl 解析优先级：显式参数 > env.HELM_HUB_URL
 * > identity.hubUrl。
 */
export async function runNodeDoctor(options: NodeDoctorOptions = {}): Promise<NodeDoctorReport> {
  const env = options.env ?? process.env;
  const dataDir = resolveNodeDataDir(options.dataDir);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const checks: NodeDoctorCheck[] = [];

  const identityCheck = await checkIdentity(dataDir);
  // 内部 identity 快照（含 token）仅用于后续检查，绝不进入对外报告。
  const { identity: _identity, ...identityPublic } = identityCheck;
  void _identity;
  checks.push(identityPublic);
  const identity = identityCheck.identity;

  checks.push(await checkPrivilege(env, options.checkPrivilege));

  const explicitHub = options.hubUrl !== undefined && options.hubUrl !== '' ? options.hubUrl : undefined;
  const envHub = env['HELM_HUB_URL'] !== undefined && env['HELM_HUB_URL'] !== '' ? env['HELM_HUB_URL'] : undefined;
  const hubUrl = explicitHub ?? envHub ?? identity?.hubUrl;
  if (identity === null || hubUrl === undefined || hubUrl === '') {
    checks.push({
      id: 'hub',
      status: 'error',
      message:
        identity === null
          ? '身份无效，无法进行 Hub 连通性探测'
          : '未配置 Hub 地址（--hub、环境变量 HELM_HUB_URL 或既绑定身份的 hubUrl）',
    });
  } else {
    checks.push(await checkHub(hubUrl, identity.nodeId, identity.token, dataDir, connectTimeoutMs));
  }

  checks.push(await checkHerdrIpc(env));

  return {
    ok: !checks.some((check) => check.status === 'error'),
    dataDir,
    ...(identity !== null ? { nodeId: identity.nodeId } : {}),
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    checks,
  };
}
