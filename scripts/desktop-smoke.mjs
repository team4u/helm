#!/usr/bin/env node
/**
 * Packaged desktop App smoke wrapper (cross-platform, pure Node built-ins, zero third-party deps).
 *
 * Responsibility boundary: this script only handles "locate the unpacked executable -> launch in
 * an isolated environment -> kill the process tree on timeout -> judge by the smoke.json
 * artifact"; the Electron-internal self-check (renderer DOM load, screenshot, writing
 * smoke.json) is owned by the App's own implementation of the --smoke-test / --smoke-output
 * arguments.
 *
 * Honest verdicts: trust neither the exit code alone nor the mere existence of the json —
 * passing requires the App to exit 0 AND ok === true in smoke.json; on timeout or abnormal
 * exit the stdout/stderr logs and any produced report files are kept for upload diagnostics.
 *
 * Usage:
 *   node scripts/desktop-smoke.mjs --packaged [--port <n>] [--release-dir <dir>] [--out <dir>] [--timeout <ms>]
 *     --packaged      Smoke-test the electron-builder unpacked output (both dist:dir / dist produce *-unpacked).
 *     --port          Hub port, default 3202; isolated testing only (e.g. pass --port=32020
 *                     explicitly when a real user Hub already listens on local 3202). No silent
 *                     port switching: if the preflight probe finds the port occupied it fails
 *                     immediately (never attach to an existing service — that could hit a real
 *                     Hub); switching ports only happens via an explicit human-provided flag.
 *     --release-dir   Root dir of the unpacked output, default packages/desktop/release (electron-builder.yml output).
 *     --out           Report dir (smoke.json / screenshot / stdout.log / stderr.log / data/), default <release-dir>/smoke;
 *                     cleared and rebuilt on every run so CI can upload the whole directory.
 *     --timeout       Milliseconds, default 60_000; on timeout the whole process tree is killed and the run fails.
 *
 * Environment constraints (aligned with the repo port rules):
 *   - HELM_DATA_DIR is pinned to the <out>/data temp dir and never touches ~/.helm;
 *   - HELM_PORT is pinned to the --port value (default 3202, this repo's port); no dynamic port
 *     picking, never touching 3000/3001/3002/3101/3102; a preflight check before spawn confirms
 *     the port is free, otherwise the run fails;
 *   - On Linux running as root outside CI, append --no-sandbox (the only legal way to start
 *     Electron as local root); CI runners are non-root and do not pass it, staying close to the
 *     real user environment.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 3202;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 40;

function usage(code) {
  const text = [
    'Usage: node scripts/desktop-smoke.mjs --packaged [--port <n>] [--release-dir <dir>] [--out <dir>] [--timeout <ms>]',
    '  --packaged     Smoke-test the electron-builder unpacked App (linux-unpacked / mac/*.app / win-unpacked)',
    '  --port         Hub port (default 3202; when local 3202 is occupied pass a test port explicitly, e.g. --port=32020; never switched silently)',
    '  --release-dir  Root dir of the unpacked output (default packages/desktop/release)',
    '  --out          Report output dir (default <release-dir>/smoke; cleared and rebuilt before the run)',
    '  --timeout      Timeout in milliseconds (default 60000); on timeout the process tree is killed and the run fails',
  ].join('\n');
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { packaged: false, port: DEFAULT_PORT, releaseDir: undefined, out: undefined, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--packaged') opts.packaged = true;
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--release-dir') opts.releaseDir = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') usage(0);
    else {
      console.error(`[desktop-smoke] unknown argument: ${arg}`);
      usage(2);
    }
  }
  if (!opts.packaged) {
    console.error('[desktop-smoke] missing --packaged: only smoke-testing packaged unpacked builds is supported today (for dev mode use pnpm --filter @helm/desktop run smoke).');
    usage(2);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535 || [3000, 3001, 3002, 3101, 3102].includes(opts.port)) {
    console.error(`[desktop-smoke] invalid --port value: ${opts.port}`);
    usage(2);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    console.error(`[desktop-smoke] invalid --timeout value: ${argv.join(' ')}`);
    usage(2);
  }
  return opts;
}

/** Return platform-specific candidate relative paths of the unpacked executable (electron-builder productName: Helm). */
function executableCandidates() {
  switch (process.platform) {
    case 'linux':
      // Prefer productName, fall back to the lowercase package-name form; probe both so we
      // never lie about electron-builder naming details.
      return ['linux-unpacked/helm-desktop', 'linux-unpacked/Helm', 'linux-unpacked/helm'];
    case 'darwin':
      // Regular single-arch builds output mac/; also cover legacy directory shapes from
      // parallel multi-arch builds.
      return [
        'mac/Helm.app/Contents/MacOS/Helm',
        'mac-arm64/Helm.app/Contents/MacOS/Helm',
        'mac_arm64/Helm.app/Contents/MacOS/Helm',
        'mac-universal/Helm.app/Contents/MacOS/Helm',
      ];
    case 'win32':
      return ['win-unpacked/Helm.exe'];
    default:
      return [];
  }
}

function locateExecutable(releaseDir) {
  const tried = [];
  for (const rel of executableCandidates()) {
    const full = path.join(releaseDir, ...rel.split('/'));
    tried.push(full);
    if (existsSync(full)) return full;
  }
  console.error(`[desktop-smoke] unpacked executable not found (platform ${process.platform}). Probed:`);
  for (const p of tried) console.error(`  - ${p}`);
  console.error('Run pnpm --filter @helm/desktop run dist:dir (or dist) first to produce the unpacked output.');
  process.exit(2);
}

/** --no-sandbox is allowed only for Linux root outside CI; CI runners are non-root and do not pass it to stay close to the real environment. */
function needsNoSandbox() {
  if (process.platform !== 'linux') return false;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  return !process.env['CI'];
}

/** Kill the whole process tree: POSIX uses session-group signals (spawn detached), Windows uses taskkill /T. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    if (child.pid != null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function tail(file, lines = LOG_TAIL_LINES) {
  try {
    const content = readFileSync(file, 'utf8').trimEnd();
    if (content.length === 0) return '(empty)';
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '(unreadable)';
  }
}

function fail(outDir, message) {
  console.error(`[desktop-smoke] FAILED: ${message}`);
  console.error(`--- stdout.log last ${LOG_TAIL_LINES} lines (${path.join(outDir, 'stdout.log')}) ---`);
  console.error(tail(path.join(outDir, 'stdout.log')));
  console.error(`--- stderr.log last ${LOG_TAIL_LINES} lines (${path.join(outDir, 'stderr.log')}) ---`);
  console.error(tail(path.join(outDir, 'stderr.log')));
  console.error(`Full report directory: ${outDir}`);
  process.exit(1);
}

function runChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    let graceTimer;
    let timedOut = false;
    // On timeout kill the tree first; if no exit event arrives within 5s after the kill,
    // settle forcibly (report honestly on zombies/unkillable processes instead of hanging).
    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      graceTimer = setTimeout(() => finish({ code: null, signal: null, timedOut: true, killedAfterTimeout: true }), 5_000);
    }, timeoutMs);
    child.once('close', (code, signal) => finish({ code, signal, timedOut }));
    child.once('error', (error) => finish({ error, code: null, signal: null, timedOut: false }));
  });
}

function validateSmokeJson(outDir) {
  const smokePath = path.join(outDir, 'smoke.json');
  if (!existsSync(smokePath)) {
    fail(outDir, `App did not produce ${smokePath} (the --smoke-test self-check did not run or wrote no report)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(smokePath, 'utf8'));
  } catch (error) {
    fail(outDir, `smoke.json is not valid JSON: ${error.message}`);
  }
  // The verdict comes entirely from the report artifact, never trusting the exit code alone:
  // ok = the overall self-check verdict, nativeCompiler = the workflow/mermaid native
  // compilers are genuinely usable (a missing or false value counts as failure, no downgrade).
  if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
    fail(outDir, `smoke.json verdict failed (expected ok:true): ${JSON.stringify(parsed)}`);
  }
  for (const field of ['nativeCompiler', 'rendererIsolated', 'portReleased']) {
    if (parsed[field] !== true) fail(outDir, `smoke.json lacks a passing ${field} check: ${JSON.stringify(parsed)}`);
  }
  const screenshot = path.join(outDir, 'window.png');
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) fail(outDir, 'window screenshot window.png was not produced');
  return parsed;
}

/** After preflight passes: launch the App, wait for exit, write logs, and judge by smoke.json. */
function runSmoke(exe, appArgs, env, outDir, opts) {
  const stdoutLog = createWriteStream(path.join(outDir, 'stdout.log'), { flags: 'a' });
  const stderrLog = createWriteStream(path.join(outDir, 'stderr.log'), { flags: 'a' });
  // detached (POSIX) creates a new session group so a timeout kill also takes down Hub child processes.
  const child = spawn(exe, appArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk) => {
    stdoutLog.write(chunk);
    process.stdout.write(`[app] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    stderrLog.write(chunk);
    process.stderr.write(`[app] ${chunk}`);
  });

  runChild(child, opts.timeoutMs).then(async (result) => {
    await Promise.all([
      new Promise((resolve) => stdoutLog.end(resolve)),
      new Promise((resolve) => stderrLog.end(resolve)),
    ]);
    if (result.error) {
      fail(outDir, `failed to start ${exe}: ${result.error.message}`);
    }
    if (result.timedOut) {
      fail(outDir, `timed out (>${opts.timeoutMs}ms), process tree killed; the App did not finish its self-check within the deadline`);
    }
    if (result.code !== 0) {
      fail(outDir, `App exited with a non-zero code (code=${result.code} signal=${result.signal ?? 'null'})`);
    }
    const report = validateSmokeJson(outDir);
    const artifacts = readdirSync(outDir).filter((name) => !name.startsWith('data-'));
    console.log(`[desktop-smoke] smoke.json: ${JSON.stringify(report)}`);
    console.log(`[desktop-smoke] report files: ${artifacts.join(', ')}`);
    console.log('[desktop-smoke] SMOKE PASS (packaged App self-check passed)');
    process.exit(0);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const releaseDir = path.resolve(opts.releaseDir ?? path.join(repoRoot, 'packages', 'desktop', 'release'));
  const outDir = path.resolve(opts.out ?? path.join(releaseDir, 'smoke'));

  const exe = locateExecutable(releaseDir);

  // Only remove report files created by this script; the data dir is newly created each run so
  // other files in a user-specified directory are never deleted.
  mkdirSync(outDir, { recursive: true });
  for (const file of ['smoke.json', 'window.png', 'stdout.log', 'stderr.log']) rmSync(path.join(outDir, file), { force: true });
  const dataDir = mkdtempSync(path.join(outDir, 'data-'));

  const appArgs = ['--smoke-test', `--smoke-output=${outDir}`];
  // Xvfb provides no real GPU; force software compositing to avoid UnknownVizError from capturePage.
  if (process.platform === 'linux') appArgs.push('--disable-gpu');
  if (needsNoSandbox()) appArgs.unshift('--no-sandbox');

  // Pin the port and data dir explicitly: never inherit HELM_PORT/HELM_DATA_DIR drift from the host environment.
  const port = String(opts.port);
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HELM_/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_PATH'));
  const env = { ...baseEnv, HELM_DATA_DIR: dataDir, HELM_DESKTOP_DATA_DIR: dataDir, HELM_CWD: dataDir, HELM_PORT: port, HELM_DESKTOP_PORT: port };

  console.log(`[desktop-smoke] executable: ${exe}`);
  console.log(`[desktop-smoke] args: ${appArgs.join(' ')}`);
  console.log(`[desktop-smoke] HELM_PORT=${port} HELM_DATA_DIR=${dataDir}`);
  console.log(`[desktop-smoke] timeout: ${opts.timeoutMs}ms, report dir: ${outDir}`);

  // Port preflight: refuse immediately when occupied — the App's attach-or-spawn semantics
  // would attach to whatever already listens on the port (possibly a real local user Hub),
  // testing neither the packaged App and possibly hurting the other side; never silently pick
  // another port; switching ports must come from an explicit human-provided --port.
  preflightPortFree(opts.port).then(
    () => runSmoke(exe, appArgs, env, outDir, opts),
    (error) => {
      fail(outDir, `Port ${opts.port} is already in use (${error.message}): refusing to attach to an existing service. When a real Hub listens on local 3202, pass an explicit test --port (e.g. --port=32020).`);
    },
  );
}

/** Probe that the port is free: binding in listen state counts as free (released immediately); a bind failure means it is occupied. */
function preflightPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

main();
