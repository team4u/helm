/**
 * Hub 子进程运行器选择：显式命令 > 指定 node > Electron 内嵌 Node（ELECTRON_RUN_AS_NODE）
 * > 宿主 Node。候选运行器必须通过运行期能力探测（Node 版本 >= kernel floor 且 node:sqlite
 * 可用），探测结果如实记录；全部候选不可用时显式报错，绝不静默降级。
 *
 * 兼容性实测（2025-04，Electron 45.3.1 / 内嵌 Node 24.22.2）：
 * - ELECTRON_RUN_AS_NODE=1 下 node:sqlite 可用、native esbuild 可用、
 *   kernel dist/main.js 完整启动并优雅退出；
 * - utilityProcess 需完整 Electron app 上下文，无显示环境不可独立验证，
 *   骨架统一用 child_process（验证过的路径），utilityProcess 留作后续隔离增强。
 */
import { spawn } from 'node:child_process';
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';
import { buildHubChildEnv, resolveHubEntry } from './config.js';

/** kernel 对 Node 的最低要求（engines.node）。 */
export const KERNEL_NODE_FLOOR = '24.12.0';

/** 能力探测脚本：单行 JSON 输出（-e 直评，CJS require 语义在所有 Node 可用）。 */
const PROBE_SOURCE =
  "const r={node:process.versions.node,electron:process.versions.electron||null,sqlite:true};" +
  "try{require('node:sqlite')}catch(e){r.sqlite=false}" +
  'console.log(JSON.stringify(r));';

export interface RunnerProbe {
  node: string;
  electron: string | null;
  sqlite: boolean;
}

export type RunnerKind = 'custom' | 'electron-node' | 'host-node';

export interface RunnerInfo {
  kind: RunnerKind;
  /** 完整命令行（argv0 + 参数）。 */
  command: string[];
  /** 子进程环境（已含 Hub 变量；electron-node 额外含 ELECTRON_RUN_AS_NODE=1）。 */
  env: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** 未采用候选的说明（诚实记录决策链）。 */
  detail?: string;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** 候选运行器是否满足 kernel 运行需要（Node >= 24.12.0 且 node:sqlite 可用）。 */
export function probeMeetsFloor(probe: RunnerProbe): boolean {
  return probe.sqlite && compareSemver(probe.node, KERNEL_NODE_FLOOR) >= 0;
}

/**
 * 运行期探测单个可执行文件的 Node 能力。失败（无法执行 / 输出不可解析）显式抛
 * hub_runner_probe_failed，附输出尾部诊断。
 */
export async function probeRunner(
  executable: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunnerProbe> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return await new Promise<RunnerProbe>((resolve, reject) => {
    const child = spawn(executable, ['-e', PROBE_SOURCE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DesktopError('hub_runner_probe_failed', `运行器探测超时: ${executable}`, { executable, timeoutMs }));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DesktopError('hub_runner_probe_failed', `运行器无法执行: ${executable}（${error.message}）`, { executable }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (code === 0 && line !== undefined) {
        try {
          const parsed = JSON.parse(line) as Partial<RunnerProbe>;
          if (typeof parsed.node === 'string' && typeof parsed.sqlite === 'boolean') {
            resolve({ node: parsed.node, electron: typeof parsed.electron === 'string' ? parsed.electron : null, sqlite: parsed.sqlite });
            return;
          }
        } catch {
          // 落入下方统一诊断
        }
      }
      reject(
        new DesktopError('hub_runner_probe_failed', `运行器探测输出不可用: ${executable}`, {
          executable,
          code,
          stdoutTail: out.slice(-500),
          stderrTail: err.slice(-500),
        }),
      );
    });
  });
}

export interface SelectRunnerContext {
  /** 是否运行在 Electron 主进程内。 */
  isElectron: boolean;
  /** 当前进程可执行文件（Electron 下为 electron 二进制）。 */
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** 探测实现（测试注入口）。 */
  probe?: (executable: string, options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunnerProbe>;
  onSkip?: (kind: RunnerKind, reason: string) => void;
}

/**
 * 选择 Hub 子进程运行器。custom 命令不做能力探测（调用方自担语义）；
 * 其余候选逐一探测，采用第一个满足 kernel floor 的；全不可用显式报错。
 */
export async function selectRunner(config: DesktopConfig, ctx: SelectRunnerContext): Promise<RunnerInfo> {
  const entry = resolveHubEntry(config);
  const probe = ctx.probe ?? probeRunner;

  // 1) 显式全命令覆写：原样采用（HELM_DESKTOP_HUB_CMD）。
  if (config.hubCommand !== undefined) {
    return { kind: 'custom', command: [...config.hubCommand], env: buildHubChildEnv(config, ctx.env), detail: '显式命令覆写' };
  }
  const hubArgs = entry === null ? [] : [entry.entry];

  // 2) 显式 node 覆写：仍需能力探测（保证能跑 kernel）。
  if (config.hubNode !== undefined) {
    const result = await probe(config.hubNode, { env: ctx.env });
    if (!probeMeetsFloor(result)) {
      throw new DesktopError(
        'hub_runner_incapable',
        `指定运行器不满足 kernel 需要（Node >= ${KERNEL_NODE_FLOOR} 且 node:sqlite，实际 Node ${result.node}，sqlite=${result.sqlite}）`,
        { executable: config.hubNode },
      );
    }
    return { kind: 'host-node', command: [config.hubNode, ...hubArgs], env: buildHubChildEnv(config, ctx.env), nodeVersion: result.node, detail: '显式 node 覆写' };
  }

  // 3) Electron 内嵌 Node：自包含首选（不依赖宿主装 Node）。
  if (ctx.isElectron) {
    const electronEnv = { ...buildHubChildEnv(config, ctx.env), ELECTRON_RUN_AS_NODE: '1' };
    try {
      const result = await probe(ctx.execPath, { env: electronEnv });
      if (probeMeetsFloor(result)) {
        return {
          kind: 'electron-node',
          command: [ctx.execPath, ...hubArgs],
          env: electronEnv,
          nodeVersion: result.node,
          detail: `Electron 内嵌 Node ${result.node}（ELECTRON_RUN_AS_NODE）`,
        };
      }
      ctx.onSkip?.('electron-node', `内嵌 Node ${result.node} 不满足 floor（sqlite=${result.sqlite}）`);
    } catch (error) {
      ctx.onSkip?.('electron-node', error instanceof Error ? error.message : String(error));
    }
  }

  // 4) 宿主 Node（Electron 外即 process.execPath；Electron 内退回 PATH 的 node）。
  const hostNode = ctx.isElectron ? 'node' : ctx.execPath;
  const result = await probe(hostNode, { env: ctx.env });
  if (!probeMeetsFloor(result)) {
    throw new DesktopError(
      'hub_runner_incapable',
      `宿主 Node 不满足 kernel 需要（Node >= ${KERNEL_NODE_FLOOR} 且 node:sqlite，实际 Node ${result.node}，sqlite=${result.sqlite}）` +
        (ctx.isElectron ? '；Electron 内嵌 Node 亦不可用（见前置诊断）' : ''),
      { executable: hostNode },
    );
  }
  return {
    kind: 'host-node',
    command: [hostNode, ...hubArgs],
    env: buildHubChildEnv(config, ctx.env),
    nodeVersion: result.node,
    detail: ctx.isElectron ? 'Electron 内嵌 Node 不可用，回退宿主 node' : '宿主 Node',
  };
}
