/**
 * 命令层公共基座：命令上下文契约与跨命令小助手。
 * 仅依赖 cli-context / launcher / control，不 import 任何具体命令模块——
 * 保持命令文件之间的零横向依赖。
 */
import { UsageError, type NodeCliIo } from '../cli-context.js';
import { readPidRecord } from '../cli-context.js';
import { readNodeIdentity } from '../daemon/index.js';
import path from 'node:path';

/** 解析后的命令行（入口 parseCli 产物，命令层只读）。 */
export interface ParsedCli {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
  help: boolean;
}

/** 命令上下文：入口层构建，各命令 handler 消费。 */
export interface CommandContext {
  io: NodeCliIo;
  parsed: ParsedCli;
  dataDir: string;
  /** 成功输出（文本直通 / JSON 序列化 + 换行）。 */
  emit: (value: unknown) => void;
}

export const flagString = (parsed: ParsedCli, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** Hub 地址解析：位置/--hub/env HELM_HUB_URL；requireUrl 时缺失显式报错。 */
export async function resolveHubUrl(io: NodeCliIo, parsed: ParsedCli, requireUrl: boolean): Promise<string> {
  const explicit = flagString(parsed, 'hub');
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = io.env?.['HELM_HUB_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (requireUrl) {
    throw new UsageError('缺少 Hub 地址：请提供位置参数 <hubUrl>、--hub <url> 或环境变量 HELM_HUB_URL', 'missing_hub_url');
  }
  return '';
}

/** 读身份；缺失显式报错（后台/前台启动共用）。 */
export async function readNodeIdentityStrict(dataDir: string): Promise<{ nodeId: string; token: string; hubUrl?: string }> {
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) {
    throw new UsageError(
      `未找到节点身份（${path.join(dataDir, 'node.json')}）。请先 helm-node connect <hubUrl> --token <token> 绑定`,
      'missing_identity',
    );
  }
  return identity;
}

/** 查询后台实例状态：控制通道 OK → 真实运行态；不可达 → pid 存活则 unknown，否则 stale。 */
export async function statusDaemon(io: NodeCliIo, dataDir: string): Promise<{
  pid: number | null;
  pidAlive: boolean;
  state?: import('../control.js').DaemonReadyState | 'unknown';
  pidStale?: boolean;
  /** daemon 真实上报的运行版本（仅控制通道可达时有）。 */
  version?: string;
  detail?: string;
}> {
  const { controlRequest, CONTROL_TIMEOUT_MS } = await import('../control.js');
  const { isAliveOf } = await import('../cli-context.js');
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) return { pid: null, pidAlive: false };
  const response = await controlRequest(record.endpoint, { type: 'status', instanceId: record.instanceId }, CONTROL_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  if (response !== null && response.ok === true) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: response.state === 'registered' ? 'registered' : 'starting',
      version: typeof response.version === 'string' && response.version !== '' ? response.version : undefined,
    };
  }
  if (isAlive(record.pid)) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: 'unknown',
      detail: `控制通道不可达（endpoint ${record.endpoint}）：pid 存活但无法确认守护进程运行状态`,
    };
  }
  return { pid: record.pid, pidAlive: false, pidStale: true, detail: 'pid 文件残留（进程已退出）待清理' };
}

/**
 * 停止后台守护进程：仅对通过 instanceId 验证的控制端点发 stop（绝不向任意 PID
 * 发信号/按键）。stop 被接受后等进程真实退出才删 pid 文件；通道不可达但 pid
 * 存活 → 显式失败并保留 pid；pid 确已死亡 → 按 stale 清理。
 */
export async function stopDaemon(io: NodeCliIo, dataDir: string): Promise<{ outcome: 'stopped' | 'stale'; pid: number }> {
  const { controlRequest, CONTROL_STOP_TIMEOUT_MS, STOP_EXIT_TIMEOUT_MS } = await import('../control.js');
  const { isAliveOf, pidPath, removePidFileIfMatch, waitForExit } = await import('../cli-context.js');
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(`未找到 pid 文件（${pidPath(dataDir)}）：后台守护进程未在运行`, 'not_running');
  }
  const response = await controlRequest(record.endpoint, { type: 'stop', instanceId: record.instanceId }, CONTROL_STOP_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  if (response === null || response.ok !== true) {
    const reason =
      response === null
        ? `控制通道不可达（endpoint ${record.endpoint}）`
        : `控制端点拒绝停止（${response.error ?? 'unknown'}，endpoint ${record.endpoint}）`;
    if (isAlive(record.pid)) {
      throw new Error(
        `${reason}，且 pid ${record.pid} 仍存活：拒绝向未经身份验证的进程发送信号；pid 文件已保留（${pidPath(dataDir)}）供诊断`,
      );
    }
    // pid 确已死亡且留档未被新实例接管，才按 stale CAS 清理。
    await removePidFileIfMatch(dataDir, record);
    return { outcome: 'stale', pid: record.pid };
  }
  // stop 已被接受且完成了执行环境清理：等进程真实退出后才删 pid 文件。
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
    throw new Error(
      `stop 已被接受但 pid ${record.pid} 在 ${STOP_EXIT_TIMEOUT_MS}ms 内未退出：保留 pid 文件（${pidPath(dataDir)}）供诊断`,
    );
  }
  // CAS：仅当留档仍指向被停实例时才删（期间可能已被升级/新实例接管）。
  await removePidFileIfMatch(dataDir, record);
  return { outcome: 'stopped', pid: record.pid };
}
