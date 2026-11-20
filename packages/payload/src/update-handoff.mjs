#!/usr/bin/env node
/**
 * Zero-config update handoff for a payload-managed Hub (spawned detached by the Hub's
 * `/api/hub-update/apply`, or manually for recovery). One shot, release-locked to the CURRENT
 * release directory (it imports `@helmx/env-io` from the payload's own node_modules, so its
 * code version matches the release it is replacing).
 *
 * Sequence (env-driven contract; every step fails loudly, never silently degrades):
 *   1. grace delay — let the apply HTTP response flush before stopping anything;
 *   2. stop the running Hub over its control channel (verified `instanceId`; the only supported
 *      stop path — this script never signals PIDs it cannot prove);
 *   3. commit `current.json` to the staged target (entries carried in `update-ready.json`);
 *   4. start the target release detached (stdio -> `logs/hub.log`), gate readiness on the
 *      `Helmx Hub: <url>` listen line, then persist `hub.pid` (+ Linux start-time proof);
 *   5. on any post-commit failure: restore the previous `current.json` verbatim, restart the
 *      previous release, write `update-blocked.json`, exit 1 with diagnostics;
 *      on success: clear the blocked marker and `update-ready.json`, exit 0.
 *
 * Environment inputs (all required unless noted):
 *   HELMX_HANDOFF_ROOT               install root (releases/, state, logs)
 *   HELMX_HANDOFF_TARGET             strict-SemVer target version
 *   HELMX_HANDOFF_ENTRY              absolute payload entry (start.mjs) of the target
 *   HELMX_HANDOFF_RELEASE_DIR        absolute staged release dir (for record keeping)
 *   HELMX_HANDOFF_DATA_DIR           hub data directory (log tail context)
 *   HELMX_HANDOFF_CONTROL_ENDPOINT   control channel endpoint of the running hub
 *   HELMX_HANDOFF_CONTROL_INSTANCE_ID  control channel instanceId
 *   HELMX_HANDOFF_LAUNCH_ID          fresh launch id for the new hub process
 *   HELMX_HANDOFF_GRACE_MS           optional grace override (default 2000)
 *   HELMX_HANDOFF_TEST_*             test hooks: fast timeouts, no-spawn dry runs
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  controlRequest,
  readCurrentRelease,
  writeCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  readUpdateReady,
  clearUpdateReady,
} = require('@helmx/env-io');

const ROOT = process.env.HELMX_HANDOFF_ROOT ?? '';
const TARGET = process.env.HELMX_HANDOFF_TARGET ?? '';
const ENTRY = process.env.HELMX_HANDOFF_ENTRY ?? '';
const RELEASE_DIR = process.env.HELMX_HANDOFF_RELEASE_DIR ?? '';
const DATA_DIR = process.env.HELMX_HANDOFF_DATA_DIR ?? '';
const CONTROL_ENDPOINT = process.env.HELMX_HANDOFF_CONTROL_ENDPOINT ?? '';
const CONTROL_INSTANCE_ID = process.env.HELMX_HANDOFF_CONTROL_INSTANCE_ID ?? '';
const LAUNCH_ID = process.env.HELMX_HANDOFF_LAUNCH_ID ?? '';
const GRACE_MS = Number(process.env.HELMX_HANDOFF_GRACE_MS ?? '2000');
const READY_TIMEOUT_MS = Number(process.env.HELMX_HANDOFF_TEST_READY_TIMEOUT_MS ?? '60000');
const LOG = path.join(ROOT, 'logs', 'handoff.log');

const fail = (message) => {
  log(`FAILED: ${message}`);
  process.exit(1);
};

function log(line) {
  const stamped = `[handoff ${new Date().toISOString()}] ${line}`;
  process.stderr.write(`${stamped}\n`);
  fsp.appendFile(LOG, `${stamped}\n`, 'utf8').catch(() => undefined);
}

const isStrictSemver = (value) => /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/.test(value);

function validateEnv() {
  const required = [
    ['HELMX_HANDOFF_ROOT', ROOT],
    ['HELMX_HANDOFF_TARGET', TARGET],
    ['HELMX_HANDOFF_ENTRY', ENTRY],
    ['HELMX_HANDOFF_RELEASE_DIR', RELEASE_DIR],
    ['HELMX_HANDOFF_CONTROL_ENDPOINT', CONTROL_ENDPOINT],
    ['HELMX_HANDOFF_CONTROL_INSTANCE_ID', CONTROL_INSTANCE_ID],
  ];
  for (const [name, value] of required) {
    if (value === '') fail(`missing required environment variable ${name}`);
  }
  if (!isStrictSemver(TARGET)) fail(`HELMX_HANDOFF_TARGET is not strict SemVer: "${TARGET}"`);
}

async function readProcessStartTime(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ticks)) return null;
    const hz = Number(process.env.HELMX_HANDOFF_TEST_CLK_TCK ?? 100);
    return Math.floor(ticks * 1000 / hz);
  } catch {
    return null;
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

/** Stop the hub over the verified control channel and wait for the recorded pid to exit. */
async function stopRunningHub() {
  const control = await readHubControl();
  if (control === null) {
    fail(`no hub control record in data directory "${DATA_DIR}" — cannot prove ownership of the running hub; refusing to continue`);
  }
  const reply = await controlRequest(
    CONTROL_ENDPOINT,
    { type: 'stop', instanceId: CONTROL_INSTANCE_ID },
    Number(process.env.HELMX_HANDOFF_TEST_STOP_TIMEOUT_MS ?? '15000'),
    { instanceId: CONTROL_INSTANCE_ID },
  );
  if (reply === null || reply.ok !== true) {
    fail(`control-channel stop was not accepted (${reply === null ? 'no reply' : `error: ${reply.error ?? 'unknown'}`}); nothing was committed`);
  }
  const exited = await waitForPidExit(control.pid, Number(process.env.HELMX_HANDOFF_TEST_STOP_TIMEOUT_MS ?? '15000'));
  if (!exited) {
    fail(`hub pid ${control.pid} accepted the stop but did not exit within the budget; nothing was committed`);
  }
  log(`stopped hub pid ${control.pid} over the control channel`);
}

async function readHubControl() {
  if (DATA_DIR === '') return null;
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, 'hub-control.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.instanceId !== CONTROL_INSTANCE_ID || parsed.endpoint !== CONTROL_ENDPOINT) return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid };
  } catch {
    return null;
  }
}

/** Start a release detached and gate on its listen line; returns { pid, url }. */
async function startRelease(entry, version) {
  const logDir = path.join(ROOT, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  const hubLog = path.join(logDir, 'hub.log');
  const logHandle = await fsp.open(hubLog, 'a');
  const startOffset = (await logHandle.stat()).size;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HELMX_HANDOFF_')) delete childEnv[key];
  }
  delete childEnv.HELMX_HUB_ACTIVITY_LAUNCH_ID;
  childEnv.HELMX_HUB_ACTIVITY_LAUNCH_ID = LAUNCH_ID;
  childEnv.HELMX_HUB_INSTALL_ROOT = ROOT;
  const child = spawn(process.execPath, [entry, 'start'], {
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    env: childEnv,
  });
  await logHandle.close().catch(() => undefined);
  if (child.pid === undefined) throw new Error('spawn produced no pid');
  child.unref();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let scanned = '';
  let offset = startOffset;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) throw new Error(`hub process exited before readiness (version ${version})`);
    const chunk = await fsp.readFile(hubLog, 'utf8').then((text) => text.slice(offset), () => '');
    offset += Buffer.byteLength(chunk, 'utf8');
    scanned = (scanned + chunk).slice(-200000);
    const match = /^Helmx Hub: (\S+)\s*$/gm.exec(scanned);
    if (match !== null) {
      return { pid: child.pid, url: match[1] };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`hub readiness timed out after ${READY_TIMEOUT_MS}ms (version ${version}, log: ${hubLog})`);
}

/** Persist the launcher's hub.pid contract for a freshly started release. */
async function writePidRecord(pid, version, entry, url) {
  const port = Number(new URL(url).port);
  const record = {
    pid,
    launchId: LAUNCH_ID,
    version,
    entryPath: entry,
    port,
    startedAt: new Date().toISOString(),
  };
  const startTime = await readProcessStartTime(pid);
  if (startTime !== null) record.startTime = startTime;
  await fsp.writeFile(path.join(ROOT, 'hub.pid'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  validateEnv();
  await fsp.mkdir(path.dirname(LOG), { recursive: true });
  log(`handoff started: target ${TARGET} (root ${ROOT})`);

  const ready = await readUpdateReady(ROOT).catch(() => null);
  if (ready === null || ready.version !== TARGET) {
    fail(`update-ready.json does not describe target ${TARGET} (found: ${ready === null ? 'none' : ready.version}); refusing to switch`);
  }

  const graceMs = Number.isFinite(GRACE_MS) && GRACE_MS >= 0 ? GRACE_MS : 2000;
  if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));

  const previous = await readCurrentRelease(ROOT);
  if (previous === null) fail('no current release to roll back to; the CLI owns bootstrap installs');

  await stopRunningHub();

  // Commit the staged target (entries carried by the ready record).
  try {
    await writeCurrentRelease(ROOT, {
      version: TARGET,
      updatedAt: new Date().toISOString(),
      entries: { entryPath: ready.entryPath },
    });
    log(`committed current.json -> ${TARGET}`);
  } catch (error) {
    fail(`commit failed (${error instanceof Error ? error.message : String(error)}); the hub is stopped and the pointer is untouched — restart manually`);
  }

  try {
    const started = await startRelease(ENTRY, TARGET);
    await writePidRecord(started.pid, TARGET, ENTRY, started.url);
    await clearBlockedRelease(ROOT);
    await clearUpdateReady(ROOT);
    log(`switch complete: ${previous.version} -> ${TARGET} (pid ${started.pid}, ${started.url})`);
    process.exit(0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`target failed to serve: ${reason}; rolling back to ${previous.version}`);
    let rollbackNote = 'rollback start failed — restart manually';
    try {
      const restoredEntry = await resolvePreviousEntry(previous);
      const restored = await startRelease(restoredEntry, previous.version);
      await writeCurrentRelease(ROOT, previous);
      await writePidRecord(restored.pid, previous.version, restoredEntry, restored.url);
      rollbackNote = `rolled back to ${previous.version} (pid ${restored.pid})`;
    } catch (rollbackError) {
      rollbackNote = `rollback failed too: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
    await writeBlockedRelease(ROOT, {
      version: TARGET,
      reason: `handoff: ${reason}; ${rollbackNote}`,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    fail(`${reason}; ${rollbackNote}`);
  }
}

/** Resolve the previous release's absolute entry from its committed relative entry path. */
async function resolvePreviousEntry(previous) {
  const releaseDir = path.join(ROOT, 'releases', previous.version);
  const relative = previous.entries.entryPath;
  const absolute = path.isAbsolute(relative) ? relative : path.join(releaseDir, relative);
  const entryStat = await fsp.stat(absolute).then(() => absolute).catch(() => null);
  if (entryStat === null) throw new Error(`previous release entry missing: ${absolute}`);
  return entryStat;
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
