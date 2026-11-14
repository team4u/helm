/**
 * Linux AppImage 退出兜底（纯逻辑）：注入假 procfs / 信号 / 虚拟时钟，绝不触碰宿主进程。
 * 覆盖：TERM→KILL 升级与共享预算、僵尸跳过、comm 含空格括号的 stat 解析、多线程
 * children 去重、自己/父进程排除、PID 复用与 reparent 不补刀、读取失败不盲杀、
 * ESRCH 视作退出、非 AppImage / Windows / macOS 不安装不读 proc。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  installLinuxExitChildSweep,
  linuxAppImageExitSweepNeeded,
  sweepOwnedExitChildren,
  SWEEP_KILL_GRACE_MS,
  SWEEP_TERM_GRACE_MS,
  type ExitSweepDeps,
} from '../src/linux-exit-children.js';

const SELF = 100;
const PARENT = 90;

interface FakeProc {
  comm?: string;
  state?: string;
  ppid?: number;
  starttime?: number;
  statThrows?: boolean;
  onTerm?: () => void;
}

interface Harness {
  deps: ExitSweepDeps;
  kills: Array<{ pid: number; signal: string }>;
  now: () => number;
}

interface HarnessOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  tasks?: Record<string, string>;
  tasksThrows?: boolean;
  procs?: Record<number, FakeProc>;
}

/** 构造 /proc/<pid>/stat 形态文本：comm 可含空格/括号，starttime 落在 ')' 后第 20 位。 */
function statLine(pid: number, proc: FakeProc): string {
  const comm = proc.comm ?? 'hub-runner';
  const fields = [
    proc.state ?? 'S',
    String(proc.ppid ?? SELF),
    ...Array.from({ length: 17 }, () => '0'),
    String(proc.starttime ?? 42),
  ];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const procs = options.procs ?? {};
  const tasks = options.tasks ?? { [String(SELF)]: '' };
  const kills: Array<{ pid: number; signal: string }> = [];
  let now = 0;
  const deps: ExitSweepDeps = {
    platform: options.platform ?? 'linux',
    env: options.env ?? { APPIMAGE: '/opt/Helm.AppImage' },
    selfPid: SELF,
    parentPid: PARENT,
    readdirSync: (path) => {
      if (path !== '/proc/self/task' || options.tasksThrows === true) throw new Error(`ENOENT: ${path}`);
      return Object.keys(tasks);
    },
    readFileSync: (path) => {
      const children = /^\/proc\/self\/task\/(\d+)\/children$/.exec(path);
      if (children !== null) {
        const content: string | undefined = tasks[children[1] ?? ''];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      }
      const stat = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (stat !== null) {
        const pid = Number(stat[1]);
        const proc: FakeProc | undefined = procs[pid];
        if (proc === undefined || proc.statThrows === true) throw new Error(`ENOENT: ${path}`);
        return statLine(pid, proc);
      }
      throw new Error(`ENOENT: ${path}`);
    },
    killSync: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === 'SIGTERM') procs[pid]?.onTerm?.();
    },
    nowMs: () => now,
    sleepSync: (ms) => { now += ms; },
    log: () => {},
  };
  return { deps, kills, now: () => now };
}

test('TERM 后即退出的子进程：只发 TERM，零等待', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { delete procs[200]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills, [{ pid: 200, signal: 'SIGTERM' }]);
  assert.equal(summary.captured, 1);
  assert.equal(summary.signaledTerm, 1);
  assert.equal(summary.signaledKill, 0);
  assert.equal(h.now(), 0);
});

test('TERM 不理睬的子进程 3s 后升级 KILL，总预算 3.5s 封顶且多子进程共享（不随数量翻倍）', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {}, 201: {}, 202: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200 201 202' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 3);
  assert.equal(summary.signaledTerm, 3);
  assert.equal(summary.signaledKill, 3);
  assert.equal(h.now(), SWEEP_TERM_GRACE_MS + SWEEP_KILL_GRACE_MS);
  const firstKill = h.kills.findIndex((k) => k.signal === 'SIGKILL');
  assert.ok(firstKill >= 3);
  assert.ok(h.kills.slice(0, firstKill).every((k) => k.signal === 'SIGTERM'));
});

test('僵尸子进程不发信号也不等待', { timeout: 60_000 }, () => {
  const h = makeHarness({ procs: { 200: { state: 'Z' } }, tasks: { [String(SELF)]: '200' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
  assert.equal(h.now(), 0);
});

test('stat comm 含空格与括号仍正确解析（含尾部括号）', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { comm: 'he(lm chi)ld' }, 201: { comm: 'chi)' } };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200 201' } });
  for (const pid of [200, 201]) procs[pid]!.onTerm = () => { delete procs[pid]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.signaledTerm, 2);
  assert.deepEqual(h.kills.map((k) => k.pid).sort(), [200, 201]);
});

test('多线程 children 重复报告同一子进程时去重，只发一次信号', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {}, 201: {} };
  const h = makeHarness({ procs, tasks: { '100': '200 201', '101': '200', '102': '200 201' } });
  for (const pid of [200, 201]) procs[pid]!.onTerm = () => { delete procs[pid]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 2);
  assert.equal(summary.signaledTerm, 2);
  assert.equal(h.kills.filter((k) => k.pid === 200).length, 1);
});

test('枚举结果排除自己与父进程', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: `${PARENT} ${SELF} 200` } });
  procs[200]!.onTerm = () => { delete procs[200]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 1);
  assert.deepEqual(h.kills.map((k) => k.pid), [200]);
});

test('TERM 后 PID 被复用（starttime 变化）不再补刀 KILL', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { starttime: 42 } };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { procs[200]!.starttime = 999; }; // 退出后同 PID 被新进程占用
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills, [{ pid: 200, signal: 'SIGTERM' }]);
  assert.equal(summary.signaledKill, 0);
  assert.equal(h.now(), SWEEP_TERM_GRACE_MS); // KILL 阶段鉴权失败即放弃，不再等待
});

test('TERM 后 reparent（ppid 变化）不补刀 KILL', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { procs[200]!.ppid = 1; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM']);
  assert.equal(summary.signaledKill, 0);
});

test('捕获时已非直接子进程（ppid≠self）不处理', { timeout: 60_000 }, () => {
  const h = makeHarness({ procs: { 200: { ppid: 1 } }, tasks: { [String(SELF)]: '200' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
});

test('killSync 抛 ESRCH 视作已退出，不阻塞不补刀', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  let attempts = 0;
  h.deps.killSync = () => { attempts += 1; throw new Error('kill ESRCH'); };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(attempts, 1);
  assert.equal(summary.signaledTerm, 0);
  assert.equal(h.now(), 0);
});

test('子孙清单目录整体读取失败：放弃且绝不发信号', { timeout: 60_000 }, () => {
  const h = makeHarness({ tasksThrows: true, procs: { 200: {} } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
  assert.equal(h.now(), 0);
});

test('子进程 stat 读取失败：跳过该目标，绝不盲杀', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { statThrows: true }, 201: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200 201' } });
  procs[201]!.onTerm = () => { delete procs[201]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills.map((k) => k.pid), [201]);
  assert.equal(summary.captured, 1);
});

test('无子进程时零信号零等待（常规退出的常态路径）', { timeout: 60_000 }, () => {
  const h = makeHarness({ tasks: { [String(SELF)]: '' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(summary, { captured: 0, signaledTerm: 0, signaledKill: 0 });
  assert.equal(h.now(), 0);
});

test('linuxAppImageExitSweepNeeded：仅 Linux + 非空 APPIMAGE', { timeout: 60_000 }, () => {
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', env: { APPIMAGE: '/x/Helm.AppImage' } }), true);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', env: { APPIMAGE: '' } }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', env: {} }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'win32', env: { APPIMAGE: '/x/Helm.AppImage' } }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'darwin', env: { APPIMAGE: '/x/Helm.AppImage' } }), false);
});

test('非 AppImage Linux / Windows / macOS：不安装兜底、不读 /proc、不加监听', { timeout: 60_000 }, () => {
  const cases: Array<[NodeJS.Platform, Record<string, string | undefined>]> = [
    ['linux', {}],
    ['linux', { APPIMAGE: '' }],
    ['win32', { APPIMAGE: '/x/Helm.AppImage' }],
    ['darwin', { APPIMAGE: '/x/Helm.AppImage' }],
  ];
  for (const [platform, env] of cases) {
    const before = process.listeners('exit');
    let fsTouched = false;
    const installed = installLinuxExitChildSweep({
      platform,
      env,
      readdirSync: () => { fsTouched = true; return []; },
      readFileSync: () => { fsTouched = true; return ''; },
    });
    assert.equal(installed, false, `${platform} ${JSON.stringify(env)} 不应安装`);
    assert.equal(fsTouched, false, '条件不满足时不得读 /proc');
    assert.equal(process.listeners('exit').length, before.length, '不得注册 exit 监听');
  }
});

test('AppImage Linux：安装 exit 监听，退出回调执行同步兜底', { timeout: 60_000 }, () => {
  const before = process.listeners('exit');
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { delete procs[200]; };
  const installed = installLinuxExitChildSweep({ ...h.deps });
  const added = process.listeners('exit').find((listener) => !before.includes(listener));
  assert.equal(installed, true);
  assert.ok(added !== undefined, '应新增 exit 监听');
  try {
    (added as (code?: number) => void)();
    assert.deepEqual(h.kills, [{ pid: 200, signal: 'SIGTERM' }]);
  } finally {
    process.removeListener('exit', added);
  }
});
