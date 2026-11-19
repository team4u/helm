#!/usr/bin/env node
/**
 * Cross-platform test entry point (Windows is the primary target environment).
 *
 * Why it exists: the real runtime is Windows, where Unix `timeout 180s` is unavailable and
 * unreliable; this script provides the same protection in userspace via plain Node spawn:
 * - Spawn this repo's locally installed tsx CLI directly (node <tsx/cli.mjs>); no gambling
 *   on shell aliases / npx / PATH;
 * - Per-test timeouts keep Node's native `--test-timeout=20000`, overridden per file by the
 *   tests' own `{ timeout: 60_000 }` declarations;
 * - The whole suite gets a total timeout (default 10 minutes, covering the measured ~217s
 *   full run on Windows); on timeout the full process tree is killed:
 *   Windows uses `taskkill /PID <pid> /T /F`, POSIX uses a detached process group + SIGTERM
 *   then SIGKILL after a grace period;
 * - Normal exits pass the exit code through as-is; a signal-killed child exits 128+signal;
 *   the total timeout exits 124 (GNU timeout convention);
 * - On forced termination the leader's exit does not settle immediately: grandchildren
 *   inside tsx's detached process group may ignore SIGTERM, so the KILL_GRACE_MS SIGKILL
 *   escalation and the LAST_RESORT cap stay armed, and we exit only after polling the owned
 *   process group drains (Windows has no group signals; taskkill /T /F already killed the
 *   tree, so it exits immediately) — no orphans, no infinite timers.
 *
 * Environment: HELMX_TEST_SUITE_TIMEOUT_MS overrides the total timeout (milliseconds,
 * positive integer).
 * Argument passthrough: every CLI argument this script receives is appended verbatim to the
 * tsx / node test runner (globs included).
 *
 * Note: pnpm test:force-exit additionally appends `--test-force-exit`, strictly for
 * diagnosing hung tests; a known side effect cancels 5 legitimate act() tests in
 * packages/web/test/composer-slash-skills.test.ts, so it is never the default test path.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
// The last-resort backstop when no exit event arrives even after the kill: this wrapper
// always exits non-zero instead of hanging or exiting 0.
const LAST_RESORT_MS = 15000;

// This script lives at <repo root>/scripts/; anchoring to the repo root keeps dependency
// resolution working no matter the cwd it is invoked from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveTsxCLI() {
  // Anchor to the repo root (the script sits at <root>/scripts/) so any cwd (e.g. an IDE)
  // resolves this repo's tsx.
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
  const cli = path.resolve(path.dirname(pkgPath), bin ?? 'dist/cli.mjs');
  if (!existsSync(cli)) {
    console.error(`[run-tests] local tsx CLI not found: ${cli} (run pnpm install first)`);
    process.exit(1);
  }
  return cli;
}

// pnpm's .bin shim stuffs node_modules/.pnpm/node_modules into NODE_PATH, which external
// plugins dynamically loaded from a tmpdir in tests rely on to resolve @helmx/protocol;
// when bypassing the shim and calling cli.mjs directly, rebuilding the equivalent is enough
// — no need to enumerate every .pnpm entry.
function pnpmFallbackNodePath() {
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  const fallback = path.join(pnpmDir, 'node_modules');
  return existsSync(fallback) ? fallback : '';
}

function suiteTimeoutMs() {
  const raw = process.env.HELMX_TEST_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SUITE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    console.error(`[run-tests] invalid HELMX_TEST_SUITE_TIMEOUT_MS (positive integer ms required): ${raw}`);
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
// At tsx runtime the @helmx/kernel / @helmx/plugins workspace packages resolve to sources:
// this keeps a single module identity with tests importing kernel/plugin sources via
// relative paths (otherwise the dual dist/source identity silently corrupts things like
// instanceof errors mapping to 500s); build artifacts are unaffected.
if (childEnv.TSX_TSCONFIG_PATH === undefined) {
  childEnv.TSX_TSCONFIG_PATH = path.join(repoRoot, 'tsconfig.dev.json');
}

// Inject the V8 heap cap and the safe-test-assert preload (never inject any HELMX_* vars).
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

// No shell involved: arguments pass through one by one, immune to string-concatenation
// injection; globs are expanded by tsx / the node test runner.
const child = spawn(process.execPath, runnerArgs, {
  stdio: 'inherit',
  env: childEnv,
  cwd: repoRoot,
  detached: process.platform !== 'win32', // POSIX detached process group, so kill(-pid) can take down the whole tree
});

// POSIX parent-death watchdog: prevents orphaned test process groups (PPID=1) if
// run-tests.mjs itself is SIGKILLed.
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
          // Process group has drained
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
    // Ignore closed pipes
  }
}

let suiteTimer = null;
let graceTimer = null;
let lastResortTimer = null;
let groupWatchTimer = null;
// Lock the exit code when this script itself terminates the run (total timeout / forwarded
// signal), so later exit events cannot overwrite it.
let forcedExitCode = null;

const GROUP_POLL_MS = 100;

// Whether the owned test process group (tsx's own PGID) still has members: the leader's
// exit does not mean the group stopped — grandchildren may ignore SIGTERM; only ESRCH
// counts as drained (EPERM etc. conservatively count as alive).
function groupAlive() {
  if (process.platform === 'win32') return false; // Windows has no group signals; tree kill is taskkill /T /F's job
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
    // Even if taskkill fails: the LAST_RESORT backstop still exits this process non-zero.
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Nothing to do if the process group is already gone.
    }
    graceTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Same as above.
      }
    }, KILL_GRACE_MS);
  }
}

function terminate(reason, exitCode, signal = 'SIGTERM') {
  if (forcedExitCode !== null) return;
  forcedExitCode = exitCode;
  if (suiteTimer) clearTimeout(suiteTimer);
  console.error(`[run-tests] ${reason}; terminating the test process tree (pid ${child.pid})`);
  killTree(signal);
  lastResortTimer = setTimeout(() => {
    console.error('[run-tests] no exit event long after termination; forcing exit.');
    disarmWatchdog();
    process.exit(forcedExitCode);
  }, LAST_RESORT_MS);
}

child.on('error', (err) => {
  clearTimers();
  console.error('[run-tests] failed to start the test process:', err);
  disarmWatchdog();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  if (forcedExitCode !== null) {
    // Forced-termination path: the leader's (tsx) exit does not mean the owned group has
    // drained — grandchildren may ignore SIGTERM. Do not clearTimers: keep the
    // KILL_GRACE_MS SIGKILL escalation and the LAST_RESORT cap, and exit only after polling
    // shows the group drained. Windows has no group signals; taskkill /T /F already killed
    // the tree, so exit immediately.
    if (process.platform === 'win32') {
      console.error(`[run-tests] force-terminated after ${elapsed}s, exiting ${forcedExitCode}`);
      disarmWatchdog();
      process.exit(forcedExitCode);
    }
    if (groupWatchTimer !== null) return;
    groupWatchTimer = setInterval(() => {
      if (!groupAlive()) {
        console.error(
          // Report drainage only after the owned test process group has exited.
          `[run-tests] force-terminated after ${((Date.now() - startMs) / 1000).toFixed(1)}s, ` +
            `owned test process group drained, exiting ${forcedExitCode}`,
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
    console.error(`[run-tests] suite finished in ${elapsed}s, exit code ${code}`);
    process.exit(code);
  }
  const signalExit = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }[signal] ?? 1;
  console.error(`[run-tests] suite killed by signal ${signal} after ${elapsed}s, exiting ${signalExit}`);
  process.exit(signalExit);
});

// On POSIX the child lives in its own process group, so terminal/session signals are not
// delivered automatically and must be forwarded explicitly; the Windows console broadcasts
// Ctrl+C, and forwarding stays as an idempotent backstop.
process.on('SIGHUP', () => terminate('received SIGHUP', 129, 'SIGHUP'));
process.on('SIGINT', () => terminate('received SIGINT', 130, 'SIGINT'));
process.on('SIGQUIT', () => terminate('received SIGQUIT', 131, 'SIGQUIT'));
process.on('SIGTERM', () => terminate('received SIGTERM', 143, 'SIGTERM'));

suiteTimer = setTimeout(() => {
  terminate(`suite total timeout (${timeoutMs}ms; tunable via HELMX_TEST_SUITE_TIMEOUT_MS)`, 124);
}, timeoutMs);
