/**
 * Linux AppImage exit fall back (pure logic): inject false procfs / signal / virtual clock, never trigger touch host process.
 * override:TERM→KILL upgrade and sharing pre- compute, zombie skip,comm contains space parentheses stat parse, many thread
 * children dedupe, itself/parent process exclude,PID re- use and reparent do not patch blade and do not blank etc. pre- compute, failed to read do not blind kill,
 * ESRCH view act exit, non- AppImage / not bundle (contains inherit host APPIMAGE)/ Windows / macOS do not install do not read proc.
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
  isPackaged?: boolean;
  tasks?: Record<string, string>;
  tasksThrows?: boolean;
  procs?: Record<number, FakeProc>;
}

/** construct /proc/<pid>/stat form text:comm can contains space/parentheses,starttime in ')' after 20 . */
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
    isPackaged: options.isPackaged ?? true,
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

test('TERM after i.e. exit child process: only TERM, zero wait for', { timeout: 60_000 }, () => {
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

test('TERM do not heed child process 3s after upgrade KILL, total pre- compute 3.5s seal top and many child process sharing (do not follow amount translate multiple)', { timeout: 60_000 }, () => {
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

test('zombie child process do not signal also without waiting', { timeout: 60_000 }, () => {
  const h = makeHarness({ procs: { 200: { state: 'Z' } }, tasks: { [String(SELF)]: '200' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
  assert.equal(h.now(), 0);
});

test('stat comm contains space and parentheses still correct parse (contains tail part parentheses)', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { comm: 'he(lm chi)ld' }, 201: { comm: 'chi)' } };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200 201' } });
  for (const pid of [200, 201]) procs[pid]!.onTerm = () => { delete procs[pid]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.signaledTerm, 2);
  assert.deepEqual(h.kills.map((k) => k.pid).sort(), [200, 201]);
});

test('many thread children duplicate report the same child process when dedupe, only once signal', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {}, 201: {} };
  const h = makeHarness({ procs, tasks: { '100': '200 201', '101': '200', '102': '200 201' } });
  for (const pid of [200, 201]) procs[pid]!.onTerm = () => { delete procs[pid]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 2);
  assert.equal(summary.signaledTerm, 2);
  assert.equal(h.kills.filter((k) => k.pid === 200).length, 1);
});

test('enumeration result exclude itself and parent process', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: `${PARENT} ${SELF} 200` } });
  procs[200]!.onTerm = () => { delete procs[200]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 1);
  assert.deepEqual(h.kills.map((k) => k.pid), [200]);
});

test('TERM after PID by re- use (starttime change) no longer patch blade KILL', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { starttime: 42 } };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { procs[200]!.starttime = 999; }; // exit after same PID by new process occupy
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills, [{ pid: 200, signal: 'SIGTERM' }]);
  assert.equal(summary.signaledKill, 0);
  assert.equal(h.now(), 0, 'starttime already change should immediately view act, do not blank etc. full TERM wide limit');
});

test('TERM after reparent(ppid change) do not patch blade KILL, immediately view act', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { procs[200]!.ppid = 1; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM']);
  assert.equal(summary.signaledKill, 0);
  assert.equal(h.now(), 0, 'ppid already change should immediately view act, do not blank etc. full TERM wide limit');
});

test('catch when already non- directly child process (ppid≠self) do not handle', { timeout: 60_000 }, () => {
  const h = makeHarness({ procs: { 200: { ppid: 1 } }, tasks: { [String(SELF)]: '200' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
});

test('killSync throw ESRCH view act already exit, non-blocking do not patch blade', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  let attempts = 0;
  h.deps.killSync = () => { attempts += 1; throw new Error('kill ESRCH'); };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(attempts, 1);
  assert.equal(summary.signaledTerm, 0);
  assert.equal(h.now(), 0);
});

test('descendant manifest directory whole failed to read: abandon and never signal', { timeout: 60_000 }, () => {
  const h = makeHarness({ tasksThrows: true, procs: { 200: {} } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.equal(summary.captured, 0);
  assert.deepEqual(h.kills, []);
  assert.equal(h.now(), 0);
});

test('child process stat failed to read: skip the target, never blind kill', { timeout: 60_000 }, () => {
  const procs: Record<number, FakeProc> = { 200: { statThrows: true }, 201: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200 201' } });
  procs[201]!.onTerm = () => { delete procs[201]; };
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(h.kills.map((k) => k.pid), [201]);
  assert.equal(summary.captured, 1);
});

test('without child process when zero signal zero wait for (common rule exit common state path)', { timeout: 60_000 }, () => {
  const h = makeHarness({ tasks: { [String(SELF)]: '' } });
  const summary = sweepOwnedExitChildren(h.deps);
  assert.deepEqual(summary, { captured: 0, signaledTerm: 0, signaledKill: 0 });
  assert.equal(h.now(), 0);
});

test('linuxAppImageExitSweepNeeded: only Linux + bundle state + non-empty APPIMAGE', { timeout: 60_000 }, () => {
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', isPackaged: true, env: { APPIMAGE: '/x/Helm.AppImage' } }), true);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', isPackaged: true, env: { APPIMAGE: '' } }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', isPackaged: true, env: {} }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'linux', isPackaged: false, env: { APPIMAGE: '/x/Helm.AppImage' } }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'win32', isPackaged: true, env: { APPIMAGE: '/x/Helm.AppImage' } }), false);
  assert.equal(linuxAppImageExitSweepNeeded({ platform: 'darwin', isPackaged: true, env: { APPIMAGE: '/x/Helm.AppImage' } }), false);
});

test('non- AppImage / not bundle / Windows / macOS: do not install fall back, do not read /proc, do not add listen', { timeout: 60_000 }, () => {
  const cases: Array<[NodeJS.Platform, boolean, Record<string, string | undefined>]> = [
    ['linux', true, {}],
    ['linux', true, { APPIMAGE: '' }],
    ['linux', false, { APPIMAGE: '/x/VSCode.AppImage' }], // development state inherit host AppImage environment
    ['win32', true, { APPIMAGE: '/x/Helm.AppImage' }],
    ['darwin', true, { APPIMAGE: '/x/Helm.AppImage' }],
  ];
  for (const [platform, isPackaged, env] of cases) {
    const before = process.listeners('exit');
    let fsTouched = false;
    const installed = installLinuxExitChildSweep({
      platform,
      isPackaged,
      env,
      readdirSync: () => { fsTouched = true; return []; },
      readFileSync: () => { fsTouched = true; return ''; },
    });
    assert.equal(installed, false, `${platform} isPackaged=${isPackaged} ${JSON.stringify(env)} must not install`);
    assert.equal(fsTouched, false, 'condition do not satisfy when must not read /proc');
    assert.equal(process.listeners('exit').length, before.length, 'must not register exit listen');
  }
});

test('AppImage Linux: install exit listen, exit call back execute sync fall back', { timeout: 60_000 }, () => {
  const before = process.listeners('exit');
  const procs: Record<number, FakeProc> = { 200: {} };
  const h = makeHarness({ procs, tasks: { [String(SELF)]: '200' } });
  procs[200]!.onTerm = () => { delete procs[200]; };
  const installed = installLinuxExitChildSweep({ ...h.deps });
  const added = process.listeners('exit').find((listener) => !before.includes(listener));
  assert.equal(installed, true);
  assert.ok(added !== undefined, 'should new increase exit listen');
  try {
    (added as (code?: number) => void)();
    assert.deepEqual(h.kills, [{ pid: 200, signal: 'SIGTERM' }]);
  } finally {
    process.removeListener('exit', added);
  }
});
