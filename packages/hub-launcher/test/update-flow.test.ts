/**
 * Update flow tests: staging strategy (verified download → npm layout → payload self-check),
 * commit sequencing (stop-before-commit), health-gated rollback with restart of the previous
 * release, blocked cooldown bookkeeping, downgrade/no-op guards, tarball installs, `.complete`
 * cache reuse, and update-lock exclusion. Uses the fake `UpdateCore` (test/fixtures.ts) standing
 * in for the generic `@helm/update` engine plus real detached fake-payload processes.
 */
import assert from 'node:assert/strict';
import { existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import {
  readBlockedRelease,
  readCurrentRelease,
  readPidRecord,
  readLaunchConfig,
  writeBlockedRelease,
  writePidRecord,
} from '../src/records.js';
import { performHubUpdate, checkHubUpgrade } from '../src/update.js';
import { stageHubRelease } from '../src/staging.js';
import { startHub, stopHub } from '../src/process.js';
import { UsageError } from '../src/io.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  freePort,
  getJson,
  spawnAlienProcess,
  waitUntilDead,
  writeFakePayload,
  type FakeUpdateCore,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

interface FlowHarness {
  root: string;
  io: ReturnType<typeof captureIo>['io'];
  core: FakeUpdateCore;
  payloads: Map<string, string>;
  addPayload(version: string, mode?: 'ok' | 'crash' | 'never-ready' | 'ignore-signal' | 'check-fail' | 'check-hang'): Promise<string>;
}

async function setupFlow(t: import('node:test').TestContext, latest = '1.1.0'): Promise<FlowHarness> {
  const root = useTempDir(t, 'helm-launcher-flow-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest, payloads });
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));
  const harness: FlowHarness = {
    root,
    io,
    core,
    payloads,
    addPayload: async (version, mode) => {
      const dir = await writeFakePayload({ dir: path.join(root, `payload-${version}`), pkgName: PKG, version, mode });
      payloads.set(version, dir);
      return dir;
    },
  };
  return harness;
}

function baseOptions(h: FlowHarness) {
  return {
    io: h.io,
    core: h.core,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    pollMs: 100,
  };
}

test('update installs a release even when nothing is running and clears blocked state', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t);
  await h.addPayload('1.1.0');
  await writeBlockedRelease(h.root, { version: '0.9.0', reason: 'old unrelated block', at: new Date().toISOString() });

  const outcome = await performHubUpdate({ ...baseOptions(h) });
  assert.equal(outcome.changed, true);
  assert.equal(outcome.previousVersion, null);
  assert.equal(outcome.restarted, false);
  assert.equal(outcome.started, false);

  const current = await readCurrentRelease(h.root);
  assert.ok(current !== null);
  assert.equal(current.version, '1.1.0');
  assert.ok(existsSync(current.entryPath));
  assert.match(path.relative(current.releaseDir, current.entryPath), /^node_modules/);
  assert.equal(await readBlockedRelease(h.root), null);
  // The install strategy: synthetic package.json + npm install with the ignore-scripts contract.
  assert.equal(h.core.npmCalls.length, 1);
  assert.equal(h.core.npmCalls[0]![0], 'install');
  assert.ok(h.core.npmCalls[0]!.includes('--ignore-scripts'));
  assert.ok(h.core.npmCalls[0]!.includes('--omit=dev'));
});

test('same-version update is a no-op and downgrades are rejected without --force', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.0.0');
  await h.addPayload('1.0.0');
  await performHubUpdate(baseOptions(h));
  const noop = await performHubUpdate(baseOptions(h));
  assert.equal(noop.changed, false);
  assert.equal(h.core.installCalls, 1);

  h.payloads.set('1.1.0', await h.addPayload('1.1.0'));
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.1.0' });
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'downgrade_rejected');
      return true;
    },
  );
  const forced = await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0', force: true });
  assert.equal(forced.changed, true);
  assert.equal((await readCurrentRelease(h.root))?.version, '1.0.0');
});

test('blocked cooldown suppresses the same version until expiry, another version, or --force', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.2.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.2.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' });
  await writeBlockedRelease(h.root, {
    version: '1.2.0',
    reason: 'candidate health check failed: simulated',
    at: new Date().toISOString(),
  });

  await assert.rejects(
    performHubUpdate({ ...baseOptions(h) }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'update_blocked_cooldown');
      return true;
    },
  );
  // Expired cooldown no longer blocks.
  await writeBlockedRelease(h.root, {
    version: '1.2.0',
    reason: 'candidate health check failed: simulated',
    at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
  });
  const ok = await performHubUpdate(baseOptions(h));
  assert.equal(ok.changed, true);
  assert.equal(await readBlockedRelease(h.root), null);

  // Active block again; --force bypasses.
  await writeBlockedRelease(h.root, { version: '1.2.0', reason: 'r', at: new Date().toISOString() });
  const forced = await performHubUpdate({ ...baseOptions(h), force: true });
  assert.equal(forced.changed, true);
});

test('staging failures change no state and write no blocked marker', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.1.0', 'check-fail');
  await assert.rejects(
    performHubUpdate(baseOptions(h)),
    /payload self-check failed with exit code 1/,
  );
  assert.equal(await readCurrentRelease(h.root), null);
  assert.equal(await readBlockedRelease(h.root), null);

  // A hanging self-check hits the staging timeout and terminates the check child.
  await h.addPayload('1.2.0', 'check-hang');
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), targetVersion: '1.2.0', payloadCheckTimeoutMs: 1_500 }),
    /payload self-check timed out/,
  );
  assert.equal(await readCurrentRelease(h.root), null);
});

test('tarball installs require an explicit version and stage from the local file', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t);
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), tarballPath: '/tmp/whatever.tgz' }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'tarball_requires_version');
      return true;
    },
  );

  const payloadDir = await h.addPayload('2.0.0');
  const tarballPath = path.join(h.root, 'local-payload.tgz');
  writeFileSync(tarballPath, 'fake local tarball bytes\n');
  h.core.registerLocalTarball(tarballPath, payloadDir);
  h.core.npmCalls.length = 0;
  const outcome = await performHubUpdate({
    ...baseOptions(h),
    tarballPath,
    targetVersion: '2.0.0',
  });
  assert.equal(outcome.changed, true);
  assert.equal((await readCurrentRelease(h.root))?.version, '2.0.0');
  assert.equal(h.core.npmCalls.length, 1);
  assert.equal(h.core.npmCalls[0]![1], tarballPath);
});

test('running update: old hub stops, new hub serves, pid/launch records follow', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0');
  const port = await freePort();
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0', launchFlags: { port } });
  // Start the old release through the lifecycle path, then update across it.
  const started = await startHub(h.root, h.io, { flags: { port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  const outcome = await performHubUpdate({ ...baseOptions(h), healthTimeoutMs: 10_000 });
  assert.equal(outcome.changed, true);
  assert.equal(outcome.restarted, true);
  assert.ok(outcome.pid !== undefined);
  t.after(() => cleanupPid(outcome.pid!));
  await waitUntilDead(started.pid); // the old process is gone
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' }); // same port, new version
  const pidRecord = await readPidRecord(h.root);
  assert.equal(pidRecord?.version, '1.1.0');
  assert.deepEqual(await readLaunchConfig(h.root), { port, host: '127.0.0.1' });
  await stopHub(h.root, h.io);
  await waitUntilDead(outcome.pid!);
});

test('failed candidate health check rolls the pointer back, restarts the old hub, and blocks the version', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0', 'never-ready');
  const port = await freePort();
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0', launchFlags: { port } });
  const old = await startHub(h.root, h.io, { flags: { port }, pollMs: 100 });
  t.after(() => cleanupPid(old.pid));

  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), healthTimeoutMs: 1_500 }),
    /rolled back to 1\.0\.0/,
  );
  // Pointer restored, old hub restarted on the same port and healthy again.
  assert.equal((await readCurrentRelease(h.root))?.version, '1.0.0');
  const restarted = await readPidRecord(h.root);
  assert.ok(restarted !== null);
  assert.notEqual(restarted.pid, old.pid);
  t.after(() => cleanupPid(restarted.pid));
  await waitUntilDead(old.pid);
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });
  // The failed version is blocked with a cooldown.
  const blocked = await readBlockedRelease(h.root);
  assert.equal(blocked?.version, '1.1.0');
  assert.match(blocked?.reason ?? '', /health/);
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h) }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'update_blocked_cooldown');
      return true;
    },
  );
  await stopHub(h.root, h.io);
  await waitUntilDead(restarted.pid);
});

test('a stop failure (unverifiable identity) aborts before any state change', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' });
  const alienPid = spawnAlienProcess();
  t.after(() => cleanupPid(alienPid));
  await writePidRecord(h.root, {
    pid: alienPid,
    version: '1.0.0',
    entryPath: '/nowhere/start.mjs',
    port: 3999,
    startedAt: new Date().toISOString(),
  });
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h) }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'hub_identity_unverifiable');
      return true;
    },
  );
  assert.equal((await readCurrentRelease(h.root))?.version, '1.0.0');
  assert.equal(await readBlockedRelease(h.root), null);
  process.kill(alienPid, 0); // untouched
});

test('concurrent updates are excluded by the update lock', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.1.0');
  const lockPath = path.join(h.root, 'update.lock');
  const fd = openSync(lockPath, 'wx');
  try {
    await assert.rejects(performHubUpdate(baseOptions(h)), /update already in progress/);
  } finally {
    closeSync(fd);
    unlinkSync(lockPath); // closing the fd does not remove the lock file
  }
  const ok = await performHubUpdate(baseOptions(h));
  assert.equal(ok.changed, true);
});

test('staged releases are reused via .complete revalidation instead of reinstalling', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' }); // install #1 (1.0.0)
  await performHubUpdate(baseOptions(h)); // install #2 (1.1.0 from latest)
  const firstCurrent = await readCurrentRelease(h.root);
  assert.ok(firstCurrent !== null);
  assert.equal(firstCurrent.version, '1.1.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0', force: true }); // install #3 (forced restage)
  const reused = await performHubUpdate(baseOptions(h)); // cache hit: revalidate, no new install
  assert.equal(reused.reusedCachedStage, true);
  assert.equal(h.core.installCalls, 3);
  assert.equal(h.core.revalidateCalls, 1);
  assert.equal(h.core.npmCalls.length, 3);
  const current = await readCurrentRelease(h.root);
  assert.ok(current !== null);
  assert.equal(current.version, '1.1.0');
  assert.equal(current.releaseDir, firstCurrent.releaseDir); // same immutable candidate
});

test('stageHubRelease validates the npm layout contract files', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.1.0');
  const payloadDir = await h.addPayload('1.1.0');
  // Sabotage: remove manifest.json from the fixture payload.
  await rm(path.join(payloadDir, 'manifest.json'));
  await assert.rejects(
    stageHubRelease({ io: h.io, core: h.core, root: h.root, version: '1.1.0', pkgName: PKG, registryUrl: 'https://registry.example.com' }),
    /missing its manifest\.json contract/,
  );
});

test('check reports current/latest/blocked without touching state', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, '1.2.0');
  await h.addPayload('1.0.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' });
  const result = await checkHubUpgrade({ io: h.io, core: h.core, root: h.root, pkgName: PKG });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked, null);
});
