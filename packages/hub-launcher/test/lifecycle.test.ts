/**
 * Process lifecycle tests: real detached processes against fake payloads — start readiness gating,
 * pid/launch persistence, duplicate-start refusal, identity-verified stop with escalation, stale
 * pid cleanup, health-failure diagnostics, and restart.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import {
  readCurrentRelease,
  readLaunchConfig,
  readPidRecord,
  writeCurrentRelease,
  writePidRecord,
} from '../src/records.js';
import { readRunningHub, startHub, stopHub } from '../src/process.js';
import { UsageError } from '../src/io.js';
import {
  captureIo,
  cleanupPid,
  freePort,
  getJson,
  spawnAlienProcess,
  waitUntilDead,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

interface Harness {
  root: string;
  payloadDir: string;
  port: number;
}

async function setupInstalledRelease(
  t: import('node:test').TestContext,
  options?: { mode?: 'ok' | 'crash' | 'never-ready' | 'ignore-signal'; version?: string },
): Promise<Harness> {
  const root = useTempDir(t, 'helm-launcher-life-');
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
  await writeCurrentRelease(root, { version, releaseDir, entryPath, updatedAt: new Date().toISOString() });
  return { root, payloadDir, port: await freePort() };
}

test('start refuses when no release is installed', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-norel-');
  const { io } = captureIo(sanitizedHostEnv());
  await assert.rejects(startHub(root, io, { flags: { port: await freePort() } }), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'no_release_installed');
    return true;
  });
});

test('start becomes healthy, persists pid + launch config, and refuses double starts', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t);
  const { io } = captureIo(sanitizedHostEnv());
  const started = await startHub(h.root, io, { flags: { port: h.port, dataDir: '/tmp/helm-launcher-data' }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  assert.equal(started.version, '1.0.0');
  assert.match(started.url, new RegExp(`http://127\\.0\\.0\\.1:${h.port}`));
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  assert.deepEqual(await getJson(h.port, '/api/auth/status'), { configured: true, authenticated: false });

  const pidRecord = await readPidRecord(h.root);
  assert.ok(pidRecord !== null);
  assert.equal(pidRecord.pid, started.pid);
  assert.equal(pidRecord.port, h.port);
  assert.equal(pidRecord.dataDir, '/tmp/helm-launcher-data');

  const launch = await readLaunchConfig(h.root);
  assert.deepEqual(launch, { port: h.port, host: '127.0.0.1', dataDir: '/tmp/helm-launcher-data' });

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

test('stop is a clean no-op when nothing runs and cleans dead pid records', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-stopnoop-');
  const { io } = captureIo(sanitizedHostEnv());
  const stopped = await stopHub(root, io);
  assert.equal(stopped.wasRunning, false);
  assert.equal(stopped.cleanedStalePid, false);

  const current = await readCurrentRelease(root);
  assert.equal(current, null);
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
  const root = useTempDir(t, 'helm-launcher-alien-');
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

test('stop escalates to process-tree termination when SIGTERM is ignored', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t, { mode: 'ignore-signal' });
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
  const neverReady = await setupInstalledRelease(t, { mode: 'never-ready' });
  const ioNever = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(neverReady.root, ioNever.io, { flags: { port: neverReady.port }, healthTimeoutMs: 1_500, pollMs: 100 }),
    /hub failed to become healthy:.*last 40 lines/s,
  );
  assert.equal(await readPidRecord(neverReady.root), null);
  assert.ok(existsSync(path.join(neverReady.root, 'logs', 'hub.log')));
  assert.match(readFileSync(path.join(neverReady.root, 'logs', 'hub.log'), 'utf8'), /never becoming ready/);

  const crash = await setupInstalledRelease(t, { mode: 'crash' });
  const ioCrash = captureIo(sanitizedHostEnv());
  await assert.rejects(
    startHub(crash.root, ioCrash.io, { flags: { port: crash.port }, healthTimeoutMs: 3_000, pollMs: 100 }),
    /exited before becoming healthy.*code=3/s,
  );
  assert.equal(await readPidRecord(crash.root), null);
});

test('restart cycle: stop then start reports the new pid and version', { timeout: 60_000 }, async (t) => {
  const h = await setupInstalledRelease(t);
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
  const h = await setupInstalledRelease(t);
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
