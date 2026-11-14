/**
 * Linux AppImage 退出残留子进程收敛（纯模块：fs / 信号 / 时钟可注入，零 Electron 依赖）。
 *
 * Why：AppImage 运行时在主进程退出后卸载 squashfs，仍存活的子进程（受管 Hub、
 * Chromium zygote 等）再触碰挂载点文件即 SIGBUS。常规退出已由 main.ts quit() await
 * supervisor.stop()；本模块只在进程 'exit' 事件内做同步最后兜底（exit 内无事件循环，
 * 用 Atomics.wait 同步睡眠）。完整安全不变量与诚实边界见 packages/desktop/README.md
 * 「Linux 桌面身份与退出收敛」，行为逐条锁定于 test/linux-exit-children.test.ts。
 */
import { readdirSync, readFileSync } from 'node:fs';

export type SweepSignal = 'SIGTERM' | 'SIGKILL';

export interface ExitSweepDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Electron 打包态（app.isPackaged）；纯 Node 无从权威判定，默认 false。 */
  isPackaged: boolean;
  selfPid: number;
  parentPid: number;
  readdirSync(path: string): string[];
  readFileSync(path: string): string;
  killSync(pid: number, signal: SweepSignal): void;
  nowMs(): number;
  sleepSync(ms: number): void;
  log(message: string): void;
}

export interface ExitSweepSummary {
  captured: number;
  signaledTerm: number;
  signaledKill: number;
}

/** TERM 宽限与 KILL 收尾预算（毫秒），全体子进程共享，不随数量翻倍。 */
export const SWEEP_TERM_GRACE_MS = 3_000;
export const SWEEP_KILL_GRACE_MS = 500;

const POLL_INTERVAL_MS = 25;
const TASK_DIR = '/proc/self/task';
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function defaultExitSweepDeps(): ExitSweepDeps {
  return {
    platform: process.platform,
    env: process.env,
    isPackaged: false,
    selfPid: process.pid,
    parentPid: process.ppid,
    readdirSync: (path) => readdirSync(path),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    killSync: (pid, signal) => { process.kill(pid, signal); },
    nowMs: () => performance.now(),
    sleepSync: (ms) => { try { Atomics.wait(sleepCell, 0, 0, ms); } catch { /* 平台不允许同步等待时退化为忙轮询，时钟预算仍有效 */ } },
    log: (message) => { process.stderr.write(`[helm-desktop] ${message}\n`); },
  };
}

/**
 * 是否应安装兜底：Linux + 打包态 + AppImage 运行时注入的非空 APPIMAGE。
 * 只看 APPIMAGE 不够——开发态 Electron 可能继承宿主 AppImage（如 VSCode.AppImage）的环境。
 */
export function linuxAppImageExitSweepNeeded(deps: Pick<ExitSweepDeps, 'platform' | 'env' | 'isPackaged'>): boolean {
  if (deps.platform !== 'linux' || deps.isPackaged !== true) return false;
  const appImage = deps.env['APPIMAGE'];
  return typeof appImage === 'string' && appImage !== '';
}

interface ProcStat {
  state: string;
  ppid: number;
  starttime: number;
}

interface ChildTarget {
  pid: number;
  starttime: number;
}

/** /proc/<pid>/stat；comm 可含空格与括号，字段从最后一个 ')' 之后起算（第 22 字段偏移 19）。 */
function readStat(deps: ExitSweepDeps, pid: number): ProcStat | null {
  let text: string;
  try { text = deps.readFileSync(`/proc/${pid}/stat`); } catch { return null; }
  const close = text.lastIndexOf(')');
  if (close < 0 || Number.parseInt(text, 10) !== pid) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const starttime = Number(fields[19]);
  if (state === undefined || state === '' || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(starttime)) return null;
  return { state, ppid, starttime };
}

/** 目标是否仍是捕获时的那个直接子进程；任何偏差都按放弃处理，绝不补刀。 */
function stillOwned(deps: ExitSweepDeps, target: ChildTarget, stat: ProcStat): boolean {
  return stat.ppid === deps.selfPid && stat.starttime === target.starttime;
}

/** 枚举直接子进程并逐个鉴权；子孙清单目录整体读不到 → null（放弃，绝不盲杀）。 */
function captureDirectChildren(deps: ExitSweepDeps): ChildTarget[] | null {
  let tids: string[];
  try { tids = deps.readdirSync(TASK_DIR); } catch { return null; }
  const candidates = new Set<number>();
  for (const tid of tids) {
    if (!/^\d+$/.test(tid)) continue;
    let text: string;
    try { text = deps.readFileSync(`${TASK_DIR}/${tid}/children`); } catch { continue; } // 线程并发退出属正常
    for (const token of text.split(/\s+/)) {
      if (token === '') continue;
      const pid = Number(token);
      if (Number.isSafeInteger(pid) && pid > 0) candidates.add(pid);
    }
  }
  const targets: ChildTarget[] = [];
  for (const pid of candidates) {
    if (pid === deps.selfPid || pid === deps.parentPid) continue;
    const stat = readStat(deps, pid);
    if (stat === null) continue; // 读不到 → 跳过
    if (stat.state === 'Z') continue; // 僵尸已释放
    if (stat.ppid !== deps.selfPid) continue; // reparent / 枚举竞态
    targets.push({ pid, starttime: stat.starttime });
  }
  return targets;
}

/**
 * 目标是否已了结：消失、僵尸（exit 内无人 waitpid，属正常态）、或 PID 已易主/复用
 * （starttime / ppid 变化）都视作了结，避免对着复用 PID 白等满预算。
 */
function isSettled(deps: ExitSweepDeps, target: ChildTarget, settled: Set<number>): boolean {
  if (settled.has(target.pid)) return true;
  const stat = readStat(deps, target.pid);
  if (stat === null || stat.state === 'Z' || !stillOwned(deps, target, stat)) {
    settled.add(target.pid);
    return true;
  }
  return false;
}

/** 复核归属 + starttime 后定向发信号。 */
function signalVerified(deps: ExitSweepDeps, targets: readonly ChildTarget[], signal: SweepSignal, settled: Set<number>): number {
  let signaled = 0;
  for (const target of targets) {
    if (settled.has(target.pid)) continue;
    const stat = readStat(deps, target.pid);
    if (stat === null || stat.state === 'Z' || !stillOwned(deps, target, stat)) {
      settled.add(target.pid);
      continue;
    }
    try {
      deps.killSync(target.pid, signal);
      signaled += 1;
    } catch {
      settled.add(target.pid); // ESRCH=已退出；其余错误也不再重试
    }
  }
  return signaled;
}

function waitUntilSettled(deps: ExitSweepDeps, targets: readonly ChildTarget[], settled: Set<number>, deadlineMs: number): void {
  for (;;) {
    if (targets.every((target) => isSettled(deps, target, settled))) return;
    const remaining = deadlineMs - deps.nowMs();
    if (remaining <= 0) return;
    deps.sleepSync(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/** 同步收敛直接子进程（进程 exit 事件内调用；预算耗尽即返回让进程退出）。 */
export function sweepOwnedExitChildren(deps: ExitSweepDeps): ExitSweepSummary {
  const targets = captureDirectChildren(deps);
  if (targets === null || targets.length === 0) {
    return { captured: targets?.length ?? 0, signaledTerm: 0, signaledKill: 0 };
  }
  const settled = new Set<number>();
  const signaledTerm = signalVerified(deps, targets, 'SIGTERM', settled);
  waitUntilSettled(deps, targets, settled, deps.nowMs() + SWEEP_TERM_GRACE_MS);
  const survivors = targets.filter((target) => !isSettled(deps, target, settled));
  const signaledKill = survivors.length === 0 ? 0 : signalVerified(deps, survivors, 'SIGKILL', settled);
  if (survivors.length > 0) waitUntilSettled(deps, survivors, settled, deps.nowMs() + SWEEP_KILL_GRACE_MS);
  const summary: ExitSweepSummary = { captured: targets.length, signaledTerm, signaledKill };
  deps.log(`Linux 退出兜底：直接子进程 ${summary.captured} 个，TERM ${summary.signaledTerm}、KILL ${summary.signaledKill}`);
  return summary;
}

/** 注册进程 'exit' 兜底；条件不满足时返回 false，不读 /proc、不加监听。 */
export function installLinuxExitChildSweep(overrides: Partial<ExitSweepDeps> = {}): boolean {
  const deps: ExitSweepDeps = { ...defaultExitSweepDeps(), ...overrides };
  if (!linuxAppImageExitSweepNeeded(deps)) return false;
  process.on('exit', () => {
    try { sweepOwnedExitChildren(deps); } catch { /* 兜底自身绝不阻止退出 */ }
  });
  return true;
}
