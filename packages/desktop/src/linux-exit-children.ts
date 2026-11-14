/**
 * Linux AppImage 退出残留子进程收敛（纯模块：fs / 信号 / 时钟全部可注入，零 Electron 依赖）。
 *
 * 背景：AppImage 运行时把 squashfs 挂载到临时目录，主进程退出后随即卸载；仍存活的
 * 子进程（受管 Hub、Chromium zygote 等原生后代）再触碰挂载点内的文件即 SIGBUS，
 * 还会拖住挂载点残留。常规退出路径（main.ts quit()）已 await 受管 Hub 的优雅停止；
 * 本模块只在进程 'exit' 事件内做同步最后兜底，覆盖 app.exit / process.exit / 自然退出
 * 三类路径。
 *
 * 安全不变量（与 test/linux-exit-children.test.ts 一一对应）：
 * - 仅 Linux + AppImage（AppImage 运行时注入的 APPIMAGE 环境变量）才安装；其余平台
 *   与开发形态零开销、不读 /proc、退出不多等一毫秒；
 * - 只处理 /proc/self/task/<tid>/children 枚举到的直接子进程，绝不按进程名全机搜索；
 *   外部附着的 Hub 不是本进程子进程，天然不会被触碰；
 * - 排除自己与父进程；每次发信号前复核 /proc/<pid>/stat 的 ppid 归属与 starttime，
 *   PID 复用 / reparent 易主的目标一律放弃，绝不补刀；
 * - 僵尸（state Z）视作已释放：不发信号、不等待（exit 事件内无人 waitpid，属正常态）；
 * - 任何 /proc 读取或解析失败只跳过该目标或整体放弃，绝不盲发信号；
 * - 总预算 TERM 3s + KILL 500ms，全体子进程共享同一预算（不随数量翻倍）。
 *
 * 诚实边界：exit 事件内无事件循环，等待用 Atomics.wait 同步睡眠；主进程自身被
 * SIGKILL 或原生崩溃时没有事件回调，本兜底无能为力。
 */
import { readdirSync, readFileSync } from 'node:fs';

export type SweepSignal = 'SIGTERM' | 'SIGKILL';

export interface ExitSweepDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
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

/** 是否应安装兜底：仅 Linux 且运行在 AppImage 内（运行时注入 APPIMAGE，解包目录无此变量）。 */
export function linuxAppImageExitSweepNeeded(deps: Pick<ExitSweepDeps, 'platform' | 'env'>): boolean {
  return deps.platform === 'linux' && typeof deps.env['APPIMAGE'] === 'string' && deps.env['APPIMAGE'] !== '';
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

/** 读 /proc/<pid>/stat；comm 可含空格与括号，字段从最后一个 ')' 之后起算。 */
function readStat(deps: ExitSweepDeps, pid: number): ProcStat | null {
  let text: string;
  try { text = deps.readFileSync(`/proc/${pid}/stat`); } catch { return null; }
  const close = text.lastIndexOf(')');
  if (close < 0 || Number.parseInt(text, 10) !== pid) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const starttime = Number(fields[19]); // stat 第 22 字段；state 是第 3 字段，故偏移 22-3=19
  if (state === undefined || state === '' || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(starttime)) return null;
  return { state, ppid, starttime };
}

/** 枚举直接子进程并逐个鉴权；子孙清单目录整体读不到 → 返回 null（放弃，绝不盲杀）。 */
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
    if (pid === deps.selfPid || pid === deps.parentPid) continue; // 排除自己与父进程
    const stat = readStat(deps, pid);
    if (stat === null) continue; // 读不到 → 跳过该目标
    if (stat.state === 'Z') continue; // 僵尸已释放
    if (stat.ppid !== deps.selfPid) continue; // 非直接子进程（reparent / 枚举竞态）
    targets.push({ pid, starttime: stat.starttime });
  }
  return targets;
}

function isGone(deps: ExitSweepDeps, target: ChildTarget, gone: Set<number>): boolean {
  if (gone.has(target.pid)) return true;
  const stat = readStat(deps, target.pid);
  if (stat === null || stat.state === 'Z') {
    gone.add(target.pid);
    return true;
  }
  return false;
}

/** 复核归属 + starttime 后定向发信号；不可复核或已易主的目标标记放弃，绝不补刀。 */
function signalVerified(deps: ExitSweepDeps, targets: readonly ChildTarget[], signal: SweepSignal, gone: Set<number>): number {
  let signaled = 0;
  for (const target of targets) {
    if (gone.has(target.pid)) continue;
    const stat = readStat(deps, target.pid);
    if (stat === null || stat.state === 'Z' || stat.ppid !== deps.selfPid || stat.starttime !== target.starttime) {
      gone.add(target.pid); // 已消失 / 僵尸 / PID 复用 / reparent：全部放弃
      continue;
    }
    try {
      deps.killSync(target.pid, signal);
      signaled += 1;
    } catch {
      gone.add(target.pid); // ESRCH=已退出；其余错误也不再重试
    }
  }
  return signaled;
}

function waitUntilGone(deps: ExitSweepDeps, targets: readonly ChildTarget[], gone: Set<number>, deadlineMs: number): void {
  for (;;) {
    if (targets.every((target) => isGone(deps, target, gone))) return;
    const remaining = deadlineMs - deps.nowMs();
    if (remaining <= 0) return;
    deps.sleepSync(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/** 同步收敛直接子进程（进程 exit 事件内调用；无 await，预算耗尽即返回让进程退出）。 */
export function sweepOwnedExitChildren(deps: ExitSweepDeps): ExitSweepSummary {
  const targets = captureDirectChildren(deps);
  if (targets === null || targets.length === 0) {
    return { captured: targets?.length ?? 0, signaledTerm: 0, signaledKill: 0 };
  }
  const gone = new Set<number>();
  const signaledTerm = signalVerified(deps, targets, 'SIGTERM', gone);
  waitUntilGone(deps, targets, gone, deps.nowMs() + SWEEP_TERM_GRACE_MS);
  const survivors = targets.filter((target) => !isGone(deps, target, gone));
  const signaledKill = survivors.length === 0 ? 0 : signalVerified(deps, survivors, 'SIGKILL', gone);
  if (survivors.length > 0) waitUntilGone(deps, survivors, gone, deps.nowMs() + SWEEP_KILL_GRACE_MS);
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
