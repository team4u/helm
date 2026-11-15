/**
 * Hub 子进程运行器选择：显式命令 > 指定 node > Electron 内嵌 Node（ELECTRON_RUN_AS_NODE）
 * > 宿主 Node。候选运行器必须通过运行期能力探测（Node 版本 >= kernel floor 且 node:sqlite
 * 可用），探测结果如实记录；全部候选不可用时显式报错，绝不静默降级。
 *
 * 兼容性实测（Electron 45.3.1 / 内嵌 Node 24.22.2）：
 * - ELECTRON_RUN_AS_NODE=1 下 node:sqlite 可用、native esbuild 可用、
 *   kernel dist/main.js 完整启动并优雅退出；
 * - utilityProcess 需完整 Electron app 上下文，无显示环境不可独立验证，
 *   骨架统一用 child_process（验证过的路径），utilityProcess 留作后续隔离增强。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';
import { buildHubChildEnv, resolveHubEntry } from './config.js';

/** kernel 对 Node 的最低要求（engines.node）。 */
export const KERNEL_NODE_FLOOR = '24.12.0';

// ---- 严格 SemVer（desktop 本地唯一实现） ----

/**
 * desktop 不依赖任何工作区包（独立 Electron 壳，见 package.json），无法直接
 * 引用 @helm/protocol/semver；在此保留与其同契约的本地实现，供 runners 的
 * Node floor 判定与 updater 的版本契约共用（契约以 @helm/protocol/semver 为准）。
 */
const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 非法版本号进入需要严格 SemVer 的路径时抛出；调用方显式处理，不静默吞掉。 */
export class SemverFormatError extends Error {
  constructor(text: string) {
    super(`非法严格 SemVer："${text}"（要求 x.y.z[-pre][+build]，不允许 v 前缀）`);
    this.name = 'SemverFormatError';
  }
}

/** 是否为严格 SemVer（不抛错版本，供「是否合法」判断场景）。 */
export function isStrictSemver(text: string): boolean {
  return STRICT_SEMVER_RE.test(text);
}

/**
 * 严格 SemVer 优先级比较：-1 / 0 / 1；任一侧非法抛 SemverFormatError（显式拒绝）。
 * 预发布优先级：正式版 > 预发布；数字标识按数值且 < 字母数字标识；字母段 ASCII 字典序；
 * build metadata 按规范不参与比较。
 */
export function compareStrictSemver(a: string, b: string): number {
  if (!isStrictSemver(a)) throw new SemverFormatError(a);
  if (!isStrictSemver(b)) throw new SemverFormatError(b);
  const pa = a.match(STRICT_SEMVER_RE)!;
  const pb = b.match(STRICT_SEMVER_RE)!;
  const coreA = [Number(pa[1]), Number(pa[2]), Number(pa[3])] as const;
  const coreB = [Number(pb[1]), Number(pb[2]), Number(pb[3])] as const;
  for (let i = 0; i < 3; i++) {
    if (coreA[i]! > coreB[i]!) return 1;
    if (coreA[i]! < coreB[i]!) return -1;
  }
  const preA = pa[4] === undefined ? [] : pa[4].split('.');
  const preB = pb[4] === undefined ? [] : pb[4].split('.');
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    const sa = preA[i];
    const sb = preB[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined;
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined;
    if (na !== undefined && nb !== undefined) return na > nb ? 1 : -1;
    if (na !== undefined) return -1;
    if (nb !== undefined) return 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * 候选运行器是否满足 kernel 运行需要（Node >= 24.12.0 且 node:sqlite 可用）。
 * 严格 SemVer 口径：版本非法或 floor 同号的预发布（如 24.12.0-nightly）均不达标，
 * 由调用方以 hub_runner_incapable 显式拒绝并如实上报探测到的版本。
 */
export function probeMeetsFloor(probe: RunnerProbe): boolean {
  return probe.sqlite && isStrictSemver(probe.node) && compareStrictSemver(probe.node, KERNEL_NODE_FLOOR) >= 0;
}

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
  /** 打包后通过真实文件启动 IPC 桥，避免 Node 直接执行 ASAR 内的脚本。 */
  childWrapper?: string;
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
  // resolveHubEntry 的 payload source 可携带附加参数（如 start.mjs 需要 start 子命令），
  // hub-entry source 恒无参数；custom 命令原样整体采用。
  const hubArgs = entry === null ? [] : [ctx.childWrapper ?? fileURLToPath(new URL('../dist/hub-child.js', import.meta.url)), entry.entry, ...entry.args];

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
