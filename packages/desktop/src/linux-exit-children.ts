/**
 * Linux AppImage exit leftover child process converge (pure module:fs / signal / clock can inject, zero Electron dependency).
 *
 * Why:AppImage runtime in main process exit after unload squashfs, still store child process (managed Hub,
 * Chromium zygote etc.) again trigger touch mount point file i.e. SIGBUS. common rule exit already by main.ts quit() await
 * supervisor.stop(); this module only in process 'exit' event inside do sync finally fall back (exit inside without event loop,
 * use Atomics.wait sync sleep). complete security invariant and honest boundary see packages/desktop/README.md
 * Linux desktop identity and exit converge, behavior one by one lock at test/linux-exit-children.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';

export type SweepSignal = 'SIGTERM' | 'SIGKILL';

export interface ExitSweepDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Electron bundle state (app.isPackaged); pure Node without from right threat decide, by default false. */
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

/** TERM wide limit and KILL wrap-up pre- compute (milli second), all body child process sharing, do not follow amount translate multiple. */
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
    sleepSync: (ms) => { try { Atomics.wait(sleepCell, 0, 0, ms); } catch { /* platform disallows sync while waiting retreat is busy polling, clock pre- compute still valid */ } },
    log: (message) => { process.stderr.write(`[helm-desktop] ${message}\n`); },
  };
}

/**
 * is otherwise should install fall back:Linux + bundle state + AppImage runtime inject non-empty APPIMAGE.
 * only see APPIMAGE do not enough - - development state Electron may inherit host AppImage(such as VSCode.AppImage) environment.
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

/** /proc/<pid>/stat;comm can contains space and parentheses, field from finally a ')' after start compute ( 22 field offset 19). */
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

/** target is otherwise still is catch when that directly child process; any bias difference all by abandon handle, never patch blade. */
function stillOwned(deps: ExitSweepDeps, target: ChildTarget, stat: ProcStat): boolean {
  return stat.ppid === deps.selfPid && stat.starttime === target.starttime;
}

/** enumeration directly child process and one by one authentication; descendant manifest directory whole read fewer than → null(abandon, never blind kill). */
function captureDirectChildren(deps: ExitSweepDeps): ChildTarget[] | null {
  let tids: string[];
  try { tids = deps.readdirSync(TASK_DIR); } catch { return null; }
  const candidates = new Set<number>();
  for (const tid of tids) {
    if (!/^\d+$/.test(tid)) continue;
    let text: string;
    try { text = deps.readFileSync(`${TASK_DIR}/${tid}/children`); } catch { continue; } // thread concurrency exit belong normal
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
    if (stat === null) continue; // read fewer than → skip
    if (stat.state === 'Z') continue; // zombie already release
    if (stat.ppid !== deps.selfPid) continue; // reparent / enumeration race
    targets.push({ pid, starttime: stat.starttime });
  }
  return targets;
}

/**
 * target is otherwise already: disappear, zombie (exit inside without person waitpid, belong normal state), or PID already easy main/re- use
 * (starttime / ppid change) all view act, avoid for re- use PID blank etc. full pre- compute.
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

/** re-check ownership + starttime after set to signal. */
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
      settled.add(target.pid); // ESRCH=already exit; the rest error also no longer retry
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

/** sync converge directly child process (process exit event inside invoke; pre- compute exhausted i.e. return let process exit). */
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
  deps.log(`Linux exit fall back: directly child process ${summary.captured} ,TERM ${summary.signaledTerm},KILL ${summary.signaledKill}`);
  return summary;
}

/** register process 'exit' fall back; condition do not satisfy when return false, do not read /proc, do not add listen. */
export function installLinuxExitChildSweep(overrides: Partial<ExitSweepDeps> = {}): boolean {
  const deps: ExitSweepDeps = { ...defaultExitSweepDeps(), ...overrides };
  if (!linuxAppImageExitSweepNeeded(deps)) return false;
  process.on('exit', () => {
    try { sweepOwnedExitChildren(deps); } catch { /* fall back itself never block stop exit */ }
  });
  return true;
}
