#!/usr/bin/env node
/**
 * helm-node CLI 入口（参数解析 + 命令分发）。
 *
 * - runNodeCli(argv, io) 为唯一测试/嵌入入口；直接运行时（argv[1] 实路径
 *   等于本模块实路径，兼容 pnpm bin symlink）才自动执行。
 * - 命令：connect / start / stop / restart / status / upgrade / service install|uninstall|status / --help。
 * - --json 全局生效：成功 stdout JSON，失败 stderr JSON 错误信封 + 非零退出码。
 * - 后台控制（跨平台，不依赖 /proc、不向任意 PID 发信号）：
 *   · 每次后台启动生成随机 instanceId；node.pid = { pid, instanceId, endpoint }
 *     （0600 原子写）。daemon 子进程自持控制 IPC（Unix: /tmp/helm-node-<hash>.sock；
 *     Windows: \\.\pipe\helm-node-<hash>），单行 JSON ≤4KiB、带空闲超时、验证
 *     instanceId，只接受 status/stop——绝不向无关进程发送信号或按键。
 *   · start -d 用 Node 原生 stdio IPC 上报就绪（helm-node.ready），子进程 argv
 *     只有 `start --data-dir <dir> [--hub <url>]`，无 token；token 一律从 0600
 *     node.json 读取。instanceId/endpoint 经 HELM_NODE_INSTANCE_ID /
 *     HELM_NODE_CONTROL_ENDPOINT 环境变量传递（本机实例控制信息，不进日志）。
 *   · stop 仅对通过 instanceId 验证的控制端点发 stop：daemon 先完成执行环境
 *     清理（handle.close）再确认退出，之后才删 pid 文件；控制通道不可达且
 *     pid 存活时显式失败并保留 pid 文件；pid 确已死亡才按 stale 清理。
 * - start -d 以 node.start.lock（O_CREAT|O_EXCL）防并发启动，持锁到 pid 留档
 *   完成；残留锁显式诊断，不静默删除。
 * - 前台 connect/start 注册前只输出「连接中」；state=registered 只来自真实
 *   daemon 注册 ACK，未完成为 starting；控制 server 仅供后台实例启动。
 * - 升级交接：受控 daemon 注入 prepareUpgradeReplacement（stdio IPC 拉起候选
 *   release、activate/activated 本机提交协议）；控制通道 upgrade 请求转发给
 *   handle.upgrade（本机可信源）；升级成功后旧 daemon 延迟退出让位。候选以
 *   HELM_NODE_UPGRADE_ATTEMPT + pendingActivation 启动，真实 registered 后保持
 *   IPC 等 activate，收到后校验 previousVersion/targetVersion 与本次升级上下文
 *   一致才 confirmUpgrade（不一致不提交并回拒）；激活后 handle.close 失败也
 *   如实记录失败退出码，不因已激活而吞错。
 * - 前台 start（无控制 env）成为稳定 launcher：自身保持活着并周期跟踪
 *   node.pid 指向的当前实例（升级换 pid 后自动跟踪新 daemon），SIGTERM/INT
 *   经控制通道停止当前实例并等待 stop 结果落定后才退出——systemd 主 PID 不因
 *   旧 daemon 退出而杀整个 cgroup。stop 与 pid 清理均按 instanceId CAS 校验。
 *
 * 实现分层：cli-context（io/pid 留档）、control（控制通道）、launcher（后台
 * 启动与跟踪）、daemon-process（守护进程运行主体）、commands/（各命令 handler）。
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { UsageError, type NodeCliIo } from './cli-context.js';
import { resolveServiceEntry } from './service-entry.js';
import { defaultSpawnDaemon } from './launcher.js';
import { COMMANDS } from './commands/index.js';
import type { ParsedCli } from './commands/shared.js';

// 历史导出（测试与 @helm/node 包出口依赖）：符号已迁移至分层模块，此处保持再导出。
export { defaultSpawnDaemon } from './launcher.js';
export { resolveServiceEntry } from './service-entry.js';
export { controlEndpoint, type DaemonReadyState } from './control.js';
export type { NodeCliIo, PidRecord } from './cli-context.js';

const USAGE = `helm-node — helm 跨平台受控节点守护进程

用法: helm-node <command> [options]

命令:
  connect <hubUrl> --token <token>   绑定 JOIN 令牌并前台运行（--once 仅尝试注册一次）
  start [-d|--daemon]                启动守护进程（-d 后台 detached，写 <dataDir>/node.pid）
  stop                               停止后台守护进程（经控制通道验证身份后优雅停止）
  restart                               重启后台守护进程（先确认停止成功再拉新进程）
  status                                输出身份绑定状态、后台进程与运行态摘要
  upgrade [--check] [--version <ver>]   自升级（--check 仅查询；执行需受管 daemon 在运行）
  doctor                                零副作用只读自检（身份 0600 / 权限 / Hub 连通 / Herdr IPC）
  service install|uninstall|status   开机自启服务管理（launchd / systemd --user / schtasks）

通用选项:
  --token <token>        JOIN 令牌（nodeId:secret）
  --hub <url>            Hub 地址
  --data-dir <dir>       数据目录（默认 $HELM_DATA_DIR 或 ~/.helm）
  --json                 机器可读 JSON 输出
  --once                 connect 模式下仅尝试注册一次即退出
  --version <ver>        upgrade 指定目标版本（严格 SemVer）
  --registry <url>       upgrade npm registry 源（默认官方或 HELM_NPM_REGISTRY）
  --check                upgrade 仅检查可用更新（不启动 daemon、不升级）
  --force                upgrade 强制（越过防降级/冷却期/同版本限制）
  --help, -h             显示帮助

环境变量: HELM_DATA_DIR（默认 ~/.helm）· HELM_HUB_URL · HERDR_SOCKET_PATH
`;

const VALUE_FLAGS = ['token', 'hub', 'data-dir', 'version', 'registry'] as const;
const BOOL_FLAGS = ['once', 'help', 'daemon', 'd', 'check', 'force'] as const;
/** 各命令合法的选项集合；未知选项/多余位置参数一律显式报错。 */
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  connect: new Set(['token', 'hub', 'data-dir', 'json', 'once']),
  start: new Set(['token', 'hub', 'data-dir', 'json', 'daemon', 'd']),
  stop: new Set(['data-dir', 'json']),
  restart: new Set(['hub', 'data-dir', 'json']),
  status: new Set(['data-dir', 'json']),
  upgrade: new Set(['version', 'registry', 'check', 'force', 'data-dir', 'json']),
  doctor: new Set(['hub', 'data-dir', 'json']),
  service: new Set(['hub', 'data-dir', 'json']),
};
/** 各命令位置参数个数（connect 可带 hubUrl；service 恰一个子命令；其余 0）。 */
const COMMAND_POSITIONALS: Record<string, { min: number; max: number }> = {
  connect: { min: 1, max: 1 },
  start: { min: 0, max: 0 },
  stop: { min: 0, max: 0 },
  restart: { min: 0, max: 0 },
  status: { min: 0, max: 0 },
  upgrade: { min: 0, max: 0 },
  doctor: { min: 0, max: 0 },
  service: { min: 1, max: 1 },
};

function parseCli(argv: readonly string[]): ParsedCli {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let json = false;
  let help = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      i += 1;
      continue;
    }
    if (token === '-d') {
      flags.set('daemon', true);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        let raw = eq === -1 ? undefined : token.slice(eq + 1);
        if (raw === undefined || raw === '') {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            throw new UsageError(`--${name} 缺少取值`);
          }
          raw = next;
          i += 1;
        }
        flags.set(name, raw);
      } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`未知选项 --${name}（helm-node --help 查看用法）`);
      }
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`未知选项 ${token}（helm-node --help 查看用法）`);
    }
    positional.push(token);
    i += 1;
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags, json, help };
}

/** 解析后校验：未知命令、多余位置参数、不属于该命令的选项都显式报错。 */
function validateCli(parsed: ParsedCli): void {
  if (parsed.help) return;
  if (parsed.command === '') {
    throw new UsageError('缺少命令（helm-node --help 查看用法）');
  }
  const allowed = COMMAND_FLAGS[parsed.command];
  if (allowed === undefined) {
    throw new UsageError(`未知命令：helm-node ${parsed.command}（helm-node --help 查看用法）`, 'unknown_command');
  }
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`命令 ${parsed.command} 不支持 --${name}（helm-node --help 查看用法）`);
    }
  }
  const range = COMMAND_POSITIONALS[parsed.command]!;
  if (parsed.positional.length < range.min || parsed.positional.length > range.max) {
    throw new UsageError(
      `命令 ${parsed.command} 需要 ${range.min === range.max ? String(range.min) : `${range.min}-${range.max}`} 个位置参数，实得 ${parsed.positional.length}（helm-node --help 查看用法）`,
    );
  }
  if (parsed.command === 'service') {
    const action = parsed.positional[0];
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      throw new UsageError(`service 需要 install|uninstall|status 子命令，实得 ${JSON.stringify(action ?? '(空)')}`);
    }
  }
  if (parsed.command === 'upgrade') {
    // --check 是纯查询：与指定/强制执行互斥，防误解为「检查并升级」。
    if (parsed.flags.get('check') === true && (parsed.flags.get('version') !== undefined || parsed.flags.get('force') === true)) {
      throw new UsageError('upgrade --check 与 --version/--force 互斥（--check 仅查询不执行升级）');
    }
  }
}

export async function runNodeCli(argv: readonly string[] = [], ioInput: Partial<NodeCliIo> = {}): Promise<number> {
  const io: NodeCliIo = {
    env: ioInput.env ?? process.env,
    out: ioInput.out ?? ((text) => process.stdout.write(text)),
    err: ioInput.err ?? ((text) => process.stderr.write(text)),
    spawnDaemon: ioInput.spawnDaemon,
    isAlive: ioInput.isAlive,
    ...(ioInput.readyTimeoutMs !== undefined ? { readyTimeoutMs: ioInput.readyTimeoutMs } : {}),
    ...(ioInput.serviceEntry !== undefined ? { serviceEntry: ioInput.serviceEntry } : {}),
  };
  const emit = (value: unknown): void => {
    io.out(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
    validateCli(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'usage_error';
    if (argv.includes('--json')) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  }

  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }

  const { resolveNodeDataDir } = await import('./daemon/index.js');
  const dataDir = resolveNodeDataDir(
    (typeof parsed.flags.get('data-dir') === 'string' ? (parsed.flags.get('data-dir') as string) : undefined) ??
      io.env?.['HELM_DATA_DIR'],
  );

  const emitError = (message: string, code: string): number => {
    if (parsed.json) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  };

  const handler = COMMANDS[parsed.command]!;
  try {
    return await handler({ io, parsed, dataDir, emit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'internal_error';
    return emitError(message, code);
  }
}

/** 直接运行判定：argv[1] 实路径 === 本模块实路径（兼容 pnpm .bin symlink 调用）。 */
export function isDirectRun(entryArgv = process.argv[1]): boolean {
  if (entryArgv === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(entryArgv));
    return self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runNodeCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
