#!/usr/bin/env node
/**
 * across platform test entry (Windows is main target environment).
 *
 * is what store in: real run environment is Windows,Unix `timeout 180s` in Windows on unavailable also cannot rely;
 * this script use pure Node spawn in user state provide same etc. protect:
 * - directly spawn this repository local install tsx CLI(node <tsx/cli.mjs>), independent of shell alias / npx / PATH touch transport air;
 * - single test timeout along use Node original generate `--test-timeout=20000`, by each test file itself declaration `{ timeout: 60_000 }` override;
 * - the whole set piece settings total timeout (by default 10 minute, override Windows measured about 217s all amount time cost), timeout after kill complete process tree:
 *   Windows use `taskkill /PID <pid> /T /F`,POSIX use independent process group + SIGTERM, wide limit after SIGKILL;
 * - normal exit original pass-through exit code; child process by signal terminate when by 128+signal exit; total timeout with 124 exit (GNU timeout convention);
 * - actively terminate (forced path) when leader exit do not immediately compute:tsx independent process group inside may still has ignore SIGTERM
 *   descendant process, keep KILL_GRACE_MS  SIGKILL upgrade and LAST_RESORT seal top, polling owned process group
 *   arrange empty after only then retreat (Windows without group signal,taskkill /T /F already kill tree, dimension hold i.e. retreat), do not orphan child also do not hang unbounded timer.
 *
 * environment variable:HELM_TEST_SUITE_TIMEOUT_MS override total timeout (milli second, positive integer).
 * parameter pass-through: this script receives all CLI parameter original append to tsx / node test runner(contains glob).
 *
 * note:pnpm test:force-exit in this basis on append `--test-force-exit`, only used to diagnose suspended test;
 * known side effect is will cancel packages/web/test/composer-slash-skills.test.ts in 5 legal act() test,
 * therefore never as by default test approach.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
// decide kill tree after still not received exit event finally fall back, guarantee this wrap process definitely with non- 0 exit while is not hang or retreat 0.
const LAST_RESORT_MS = 15000;

// this script at <repository>/scripts/, anchor set repository guarantee from any cwd invoke all can parse to this repository dependency.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveTsxCLI() {
  // anchor set repository (script at <root>/scripts/), guarantee from any cwd invoke (such as IDE) all can parse to this repository tsx.
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
  const cli = path.resolve(path.dirname(pkgPath), bin ?? 'dist/cli.mjs');
  if (!existsSync(cli)) {
    console.error(`[run-tests] not found local tsx CLI: ${cli}(please first pnpm install)`);
    process.exit(1);
  }
  return cli;
}

// pnpm  .bin shim will node_modules/.pnpm/node_modules stuff enter NODE_PATH,
// test in from tmpdir motion state load external plugin dependency it parse @helm/protocol;
// bypass shim directly tune cli.mjs when rebuild etc. price environment i.e. can, exempt remove enumeration all .pnpm item.
function pnpmFallbackNodePath() {
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  const fallback = path.join(pnpmDir, 'node_modules');
  return existsSync(fallback) ? fallback : '';
}

function suiteTimeoutMs() {
  const raw = process.env.HELM_TEST_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SUITE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    console.error(`[run-tests] invalid HELM_TEST_SUITE_TIMEOUT_MS(must positive integer milli second): ${raw}`);
    process.exit(2);
  }
  return n;
}

const startMs = Date.now();
const tsxCli = resolveTsxCLI();
const timeoutMs = suiteTimeoutMs();
const forwardArgs = process.argv.slice(2);

const childEnv = { ...process.env };
const fallback = pnpmFallbackNodePath();
if (fallback) {
  childEnv.NODE_PATH = process.env.NODE_PATH
    ? fallback + path.delimiter + process.env.NODE_PATH
    : fallback;
}
// tsx run phase @helm/kernel / @helm/plugins work zone package parse to source code: and test directly each other for
// import kernel/plugins source code keep single module identity (otherwise dist and source double identity will let
// instanceof error mapping into 500 etc. static default wrong chaotic); build artifact do not subject to affect.
if (childEnv.TSX_TSCONFIG_PATH === undefined) {
  childEnv.TSX_TSCONFIG_PATH = path.join(repoRoot, 'tsconfig.dev.json');
}

// inject V8 heap cap and safe-test-assert preload(forbidden inject any HELM_* variable).
{
  const preloadUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'safe-test-assert.mjs')).href;
  const existing = childEnv.NODE_OPTIONS?.trim() ?? '';
  const parts = existing ? [existing] : [];
  if (!/(?:^|\s)--max-old-space-size(?:=|\s|$)/.test(existing)) {
    parts.push('--max-old-space-size=1536');
  }
  const importFlag = `--import=${preloadUrl}`;
  if (!existing.includes(importFlag)) {
    parts.push(importFlag);
  }
  childEnv.NODE_OPTIONS = parts.join(' ');
}

const runnerArgs = [
  tsxCli,
  '--test',
  '--test-timeout=20000',
  ...forwardArgs,
];

// without shell reference and: parameter one by one pass-through, day however exempt epidemic string concatenate inject;glob hand over to tsx / node test runner expand.
const child = spawn(process.execPath, runnerArgs, {
  stdio: 'inherit',
  env: childEnv,
  cwd: repoRoot,
  detached: process.platform !== 'win32', // POSIX independent process group, only then can use kill(-pid) kill the whole tree
});

// POSIX parent process expose kill watchdog: guard against run-tests.mjs by SIGKILL after under PPID=1 orphan child test process group.
let watchdog = null;
if (process.platform !== 'win32' && child.pid != null) {
  const watchdogEnv = { ...process.env };
  delete watchdogEnv.NODE_OPTIONS;
  const watchdogScript = `
    const pid = ${child.pid};
    let ok = false;
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('ok')) {
        ok = true;
        process.exit(0);
      }
    });
    process.stdin.on('end', () => {
      if (ok) process.exit(0);
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (err) {
        if (err && err.code === 'ESRCH') process.exit(0);
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // process group already arrange empty
        }
        process.exit(0);
      }, 1000);
    });
  `;
  watchdog = spawn(process.execPath, ['-e', watchdogScript], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: watchdogEnv,
    detached: true,
  });
  watchdog.on('error', () => {});
  watchdog.stdin?.on('error', () => {});
  watchdog.unref();
}

function disarmWatchdog() {
  if (!watchdog?.stdin || watchdog.stdin.destroyed) return;
  try {
    watchdog.stdin.end('ok');
  } catch {
    // ignore already close pipeline
  }
}

let suiteTimer = null;
let graceTimer = null;
let lastResortTimer = null;
let groupWatchTimer = null;
// by this script actively terminate (total timeout / forwarding signal) when lock exit code, guard against after continue exit event override.
let forcedExitCode = null;

const GROUP_POLL_MS = 100;

// owned test process group (tsx independent PGID) is otherwise still has member:leader exit does not mean whole group stop,
// descendant process may ignore SIGTERM; only ESRCH treated as arrange empty (EPERM etc. keep guard by store).
function groupAlive() {
  if (process.platform === 'win32') return false; // Windows without group signal, tree kill by taskkill /T /F negative duty
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function clearTimers() {
  for (const t of [suiteTimer, graceTimer, lastResortTimer]) {
    if (t) clearTimeout(t);
  }
  suiteTimer = graceTimer = lastResortTimer = null;
}

function killTree(signal) {
  if (child.pid == null) return;
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    tk.on('error', (err) => console.error('[run-tests] taskkill failed to start:', err.message));
    // taskkill failed also without hinder:LAST_RESORT fall back guarantee this process by non- 0 exit.
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // process group already disappear then without matter can do.
    }
    graceTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // same on.
      }
    }, KILL_GRACE_MS);
  }
}

function terminate(reason, exitCode, signal = 'SIGTERM') {
  if (forcedExitCode !== null) return;
  forcedExitCode = exitCode;
  if (suiteTimer) clearTimeout(suiteTimer);
  console.error(`[run-tests] ${reason}, terminate test process tree (pid ${child.pid})`);
  killTree(signal);
  lastResortTimer = setTimeout(() => {
    console.error('[run-tests] terminate after late late not received exit event, force exit.');
    disarmWatchdog();
    process.exit(forcedExitCode);
  }, LAST_RESORT_MS);
}

child.on('error', (err) => {
  clearTimers();
  console.error('[run-tests] start test process failed:', err);
  disarmWatchdog();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  if (forcedExitCode !== null) {
    // force terminate path:leader(tsx) exit does not mean owned group arrange empty - - descendant process may ignore SIGTERM.
    // do not clearTimers: keep KILL_GRACE_MS  SIGKILL upgrade and LAST_RESORT seal top,
    // polling group arrange empty after only then retreat.Windows without group signal,taskkill /T /F already kill tree, dimension hold i.e. retreat.
    if (process.platform === 'win32') {
      console.error(`[run-tests] already force terminate, time cost ${elapsed}s, exit ${forcedExitCode}`);
      disarmWatchdog();
      process.exit(forcedExitCode);
    }
    if (groupWatchTimer !== null) return;
    groupWatchTimer = setInterval(() => {
      if (!groupAlive()) {
        console.error(
          `[run-tests] already force terminate, time cost ${((Date.now() - startMs) / 1000).toFixed(1)}s,` +
            `owned test process group already arrange empty, exit ${forcedExitCode}`,
        );
        disarmWatchdog();
        process.exit(forcedExitCode);
      }
    }, GROUP_POLL_MS);
    return;
  }
  clearTimers();
  disarmWatchdog();
  if (code !== null) {
    console.error(`[run-tests] set piece ${elapsed}s end, exit code ${code}`);
    process.exit(code);
  }
  const signalExit = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }[signal] ?? 1;
  console.error(`[run-tests] set piece ${elapsed}s by signal ${signal} terminate, exit ${signalExit}`);
  process.exit(signalExit);
});

// POSIX under child process in independent process group, terminal/conversation signal will not automatically send reach, must explicit forwarding;Windows control stage will broadcast Ctrl+C, forwarding is idempotent fall back.
process.on('SIGHUP', () => terminate('receives SIGHUP', 129, 'SIGHUP'));
process.on('SIGINT', () => terminate('receives SIGINT', 130, 'SIGINT'));
process.on('SIGQUIT', () => terminate('receives SIGQUIT', 131, 'SIGQUIT'));
process.on('SIGTERM', () => terminate('receives SIGTERM', 143, 'SIGTERM'));

suiteTimer = setTimeout(() => {
  terminate(`set piece total timeout (${timeoutMs}ms, available HELM_TEST_SUITE_TIMEOUT_MS adjust)`, 124);
}, timeoutMs);
