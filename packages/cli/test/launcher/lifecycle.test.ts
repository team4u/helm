/**
 * Process lifecycle tests: real detached processes against fake payloads — start readiness gating
 * on the `Helmx Hub: ` listen line (including preceding log lines, stale banners from previous
 * runs, and wrong-port banners), pid/launch persistence, duplicate-start refusal,
 * identity-verified stop with escalation, stale pid cleanup, failure diagnostics, restart, the
 * install/data isolation guard, and the shared lifecycle lock.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helmx/test-kit/node';
import { writeCurrentRelease } from '@helmx/env-io';
import { readLaunchConfig, readPidRecord, writePidRecord } from '../../src/launcher/records.js';
import { readRunningHub, startHub, stopHub, withLifecycleLock } from '../../src/launcher/process.js';
import { UsageError } from '../../src/launcher/io.js';
import {
  captureIo,
  cleanupPid,
  freePort,
  getJson,
  spawnAlienProcess,
  waitUntilDead,
  writeFakePayload,
  type FakePayloadMode,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

interface Harness {
  root: string;
  payloadDir: string;
  port: number;
}

async function setupInstalledRelease(
  t: import('node:test').TestContext,
  root: string,
  options?: { mode?: FakePayloadMode; version?: string },
): Promise<Harness> {
  const version = options?.version ?? '1.0.0';
  const payloadDir = await writeFakePayload({
    dir: path.join(root, 'fixture-payload'),
    pkgName: PKG,
    version,
    mode: options?.mode ?? 'ok',
  });
  // Commit the fixture as the current release (the staging path is covered in update-flow tests).
  const releaseDir = path.join(root, 'releases', version, 'fixture');
  const entryPath = path.join(releaseDir, 'node_modules', ...PKG.split('/'), 'start.mjs');
  await cp(payloadDir, path.dirname(entryPath), { recursive: true });
  await writeCurrentRelease(root, { version, updatedAt: new Date().toISOString(), entries: { entryPath } });
  return { root, payloadDir, port: await freePort() };
}

test('start refuses when no release is installed', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-norel-');
  const { io } = captureIo(sanitizedHostEnv());
  await assert.rejects(startHub(root, io, { flags: { port: await freePort() } }), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'no_release_installed');
    return true;
  });
});

test('start becomes ready via the listen banner, persists pid + launch config, and refuses double starts', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const { io } = captureIo(sanitizedHostEnv());
  const started = await startHub(h.root, io, { flags: { port: h.port, dataDir: '/tmp/helmx-launcher-data' }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  assert.equal(started.version, '1.0.0');
  assert.equal(started.url, `http://127.0.0.1:${h.port}`);
  // The banner follows preceding log lines in the same stream (#72 multiline case): readiness
  // still resolves and the server is genuinely serving.
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  assert.deepEqual(await getJson(h.port, '/api/auth/status'), { configured: true, authenticated: false });
  assert.deepEqual(started.health, { configured: true, authenticated: false });
  assert.match(readFileSync(path.join(h.root, 'logs', 'hub.log'), 'utf8'), new RegExp(`^Helmx Hub: http://127\\.0\\.0\\.1:${h.port}`, 'm'));

  const pidRecord = await readPidRecord(h.root);
  assert.ok(pidRecord !== null);
  assert.equal(pidRecord.pid, started.pid);
  assert.equal(pidRecord.port, h.port);
  assert.equal(pidRecord.dataDir, '/tmp/helmx-launcher-data');

  const launch = await readLaunchConfig(h.root);
  assert.deepEqual(launch, { port: h.port, host: '127.0.0.1', dataDir: '/tmp/helmx-launcher-data' });

  await assert.rejects(startHub(h.root, io, { flags: { port: h.port } }), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'hub_already_running');
    return true;
  });

  const stopped = await stopHub(h.root, io, { stopTimeoutMs: 5_000 });
  assert.equal(stopped.wasRunning, true);
  assert.equal(stopped.escalated, false);
  await waitUntilDead(started.pid);
  assert.equal(await readPidRecord(h.root), null);
});

test('a stale banner from a previous run in hub.log never satisfies readiness', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const { io } = captureIo(sanitizedHostEnv());
  // Pre-existing log content including an old banner line for the SAME port: only bytes appended
  // after spawn count, so readiness must still wait for the fresh banner.
  const logPath = path.join(h.root, 'logs', 'hub.log');
  mkdirSync(path.join(h.root, 'logs'), { recursive: true });
  appendFileSync(logPath, `[old run] Helmx Hub: http://127.0.0.1:${h.port}\n[old run] shutting down\n`);
  const started = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  // The server is genuinely up (a false-ready off the stale line would leave this unanswered).
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  await stopHub(h.root, io);
  await waitUntilDead(started.pid);
});

test('a banner naming a different port is not this candidate readiness', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'), { mode: 'wrong-port-banner' });
  const { io } = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(h.root, io, { flags: { port: h.port }, healthTimeoutMs: 1_500, pollMs: 100 }),
    /readiness timed out.*no "Helmx Hub: " listen line/s,
  );
  assert.equal(await readPidRecord(h.root), null);
  assert.match(readFileSync(path.join(h.root, 'logs', 'hub.log'), 'utf8'), /Helmx Hub: http:\/\/127\.0\.0\.1:1\b/);
});

test('start rejects a data directory nested inside the install root (and vice versa)', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const nested = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(h.root, nested.io, { flags: { port: h.port, dataDir: path.join(h.root, 'data') }, pollMs: 100 }),
    /must not overlap/,
  );
  assert.equal(await readPidRecord(h.root), null);

  const enclosing = useTempDir(t, 'helmx-launcher-enclose-');
  const payloadDir = await writeFakePayload({ dir: path.join(enclosing, 'fixture'), pkgName: PKG, version: '1.0.0' });
  const releaseDir = path.join(enclosing, 'programs', 'releases', '1.0.0', 'fixture');
  const entryPath = path.join(releaseDir, 'node_modules', ...PKG.split('/'), 'start.mjs');
  await cp(payloadDir, path.dirname(entryPath), { recursive: true });
  await writeCurrentRelease(enclosing, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath } });
  const { io } = captureIo(sanitizedHostEnv({ HELMX_DATA_DIR: enclosing }));
  await assert.rejects(startHub(enclosing, io, { flags: { port: h.port }, pollMs: 100 }), /must not overlap/);
});

test('stop is a clean no-op when nothing runs and cleans dead pid records', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-stopnoop-');
  const { io } = captureIo(sanitizedHostEnv());
  const stopped = await stopHub(root, io);
  assert.equal(stopped.wasRunning, false);
  assert.equal(stopped.cleanedStalePid, false);

  await writeFakePayload({ dir: path.join(root, 'fixture'), pkgName: PKG, version: '1.0.0' });
  // A pid record whose process is long dead (huge pid cannot be alive).
  await writePidRecord(root, {
    pid: 2_000_000_000,
    version: '1.0.0',
    entryPath: '/nowhere/start.mjs',
    port: 3999,
    startedAt: new Date().toISOString(),
  });
  const cleaned = await stopHub(root, io);
  assert.equal(cleaned.wasRunning, false);
  assert.equal(cleaned.cleanedStalePid, true);
  assert.equal(await readPidRecord(root), null);
});

test('stop refuses to signal a live pid whose health endpoint is unreachable', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-alien-');
  const { io } = captureIo(sanitizedHostEnv());
  const alienPid = spawnAlienProcess();
  t.after(() => cleanupPid(alienPid));
  await writePidRecord(root, {
    pid: alienPid,
    version: '1.0.0',
    entryPath: '/nowhere/start.mjs',
    port: 3999,
    startedAt: new Date().toISOString(),
  });
  await assert.rejects(stopHub(root, io), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'hub_identity_unverifiable');
    return true;
  });
  // The alien process must still be alive (nothing was signalled).
  process.kill(alienPid, 0);
  const pidRecord = await readPidRecord(root);
  assert.ok(pidRecord !== null);
});

test('stop refuses a live pid whose recorded start time no longer matches (pid reuse)', {
  timeout: 60_000,
  // The start-time identity proof is Linux /proc only; other platforms fall back to the health gate.
  skip: process.platform !== 'linux' ? 'pid start-time identity proof requires Linux /proc' : false,
}, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-reuse-'));
  const { io } = captureIo(sanitizedHostEnv());
  const started = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  const record = await readPidRecord(h.root);
  assert.ok(record !== null);
  assert.ok(typeof record.startTime === 'number', 'a Linux spawn records the start time');

  // Health answers fine, but a tampered/stale start time proves the pid is not the recorded hub:
  // signalling must be refused even though the port serves hub-shaped responses.
  await writePidRecord(h.root, { ...record, startTime: record.startTime! + 1 });
  await assert.rejects(stopHub(h.root, io), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'hub_identity_unverifiable');
    assert.match(error.message, /no longer matches the recorded process start time/);
    return true;
  });
  process.kill(started.pid, 0); // untouched
  assert.ok((await readPidRecord(h.root)) !== null, 'pid record retained for manual verification');

  // The honest record stops normally (proof by start time outranks the health probe).
  await writePidRecord(h.root, record);
  const stopped = await stopHub(h.root, io);
  assert.equal(stopped.wasRunning, true);
  await waitUntilDead(started.pid);
});

test('stop escalates to process-tree termination when SIGTERM is ignored', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'), { mode: 'ignore-signal' });
  const { io } = captureIo(sanitizedHostEnv());
  const started = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  const stopped = await stopHub(h.root, io, { stopTimeoutMs: 800, escalationWaitMs: 5_000 });
  assert.equal(stopped.wasRunning, true);
  assert.equal(stopped.escalated, true);
  await waitUntilDead(started.pid);
  assert.equal(await readPidRecord(h.root), null);
});

test('start failure paths never leave a pid record and surface hub log tails', { timeout: 60_000 }, async (t) => {
  const neverReady = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'), { mode: 'never-ready' });
  const ioNever = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(neverReady.root, ioNever.io, { flags: { port: neverReady.port }, healthTimeoutMs: 1_500, pollMs: 100 }),
    /hub failed to become ready:.*readiness timed out.*last 40 lines/s,
  );
  assert.equal(await readPidRecord(neverReady.root), null);
  assert.ok(existsSync(path.join(neverReady.root, 'logs', 'hub.log')));
  assert.match(readFileSync(path.join(neverReady.root, 'logs', 'hub.log'), 'utf8'), /never becoming ready/);

  const crash = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'), { mode: 'crash' });
  const ioCrash = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(crash.root, ioCrash.io, { flags: { port: crash.port }, healthTimeoutMs: 3_000, pollMs: 100 }),
    /exited before reporting readiness.*code=3/s,
  );
  assert.equal(await readPidRecord(crash.root), null);
});

test('restart cycle: stop then start reports the new pid and version', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const { io } = captureIo(sanitizedHostEnv());
  const first = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(first.pid));
  const stopped = await stopHub(h.root, io);
  assert.equal(stopped.wasRunning, true);
  const second = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(second.pid));
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.version, '1.0.0');
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  await stopHub(h.root, io);
  await waitUntilDead(second.pid);
});

test('status snapshot distinguishes healthy, dead, and absent states', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const { io } = captureIo(sanitizedHostEnv());
  assert.equal(await readRunningHub(h.root, io), null);

  const started = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  const running = await readRunningHub(h.root, io);
  assert.ok(running !== null);
  assert.equal(running.alive, true);
  assert.deepEqual(running.health, { configured: true, authenticated: false });

  process.kill(started.pid, 'SIGKILL');
  await waitUntilDead(started.pid);
  const dead = await readRunningHub(h.root, io);
  assert.ok(dead !== null);
  assert.equal(dead.alive, false);
  assert.equal(dead.health, null);
});

test('lifecycle lock excludes concurrent lifecycle operations', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, useTempDir(t, 'helmx-launcher-life-'));
  const { io } = captureIo(sanitizedHostEnv());
  await withLifecycleLock(h.root, async () => {
    await assert.rejects(startHub(h.root, io, { flags: { port: h.port } }), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'lifecycle_lock_busy');
      return true;
    });
    await assert.rejects(stopHub(h.root, io), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'lifecycle_lock_busy');
      return true;
    });
  });
  // Lock released afterwards: start works again.
  const started = await startHub(h.root, io, { flags: { port: h.port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  await stopHub(h.root, io);
  await waitUntilDead(started.pid);
});
