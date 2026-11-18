/**
 * Update flow tests: staging strategy (verified download → npm layout → manifest/nodeEngines
 * gates → payload self-check), commit sequencing (atomic lifecycle window, stop-before-commit),
 * readiness-gated rollback with restart of the previous release, blocked cooldown bookkeeping,
 * downgrade/no-op guards, tarball installs, `.complete` cache reuse via the real engine, and
 * update-lock exclusion. Policy tests use the port fake (real engine staging, fixture
 * registry/npm); golden-path tests run the REAL production extractor against `npm pack`
 * artifacts through a fake registry with correct sha512 SRI metadata.
 */
import assert from 'node:assert/strict';
import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { readBlockedRelease, readCurrentRelease, writeBlockedRelease, writeCurrentRelease } from '@helm/update';
import { readPidRecord, readLaunchConfig, writePidRecord } from '../src/records.js';
import { performHubUpdate, checkHubUpgrade } from '../src/update.js';
import { stageHubRelease } from '../src/staging.js';
import { startHub, stopHub } from '../src/process.js';
import { UsageError } from '../src/io.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  createFakeRegistry,
  fixtureTarballPacker,
  freePort,
  getJson,
  packPayloadTarball,
  spawnAlienProcess,
  waitUntilDead,
  writeFakePayload,
  type FakePayloadMode,
  type FakeUpdateCore,
} from './fixtures.js';

/** Shared in-process packer for local-tarball tests (real package/-rooted archives). */
const packFixture = (() => {
  const pack = fixtureTarballPacker();
  return (root: string, version: string): Promise<string> => pack(path.join(root, `payload-${version}`));
})();

const PKG = '@fake/hub-payload';

interface FlowHarness {
  root: string;
  io: ReturnType<typeof captureIo>['io'];
  core: FakeUpdateCore;
  payloads: Map<string, string>;
  addPayload(version: string, mode?: FakePayloadMode, nodeEngines?: string): Promise<string>;
}

async function setupFlow(t: import('node:test').TestContext, root: string, latest = '1.1.0'): Promise<FlowHarness> {
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest, payloads });
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));
  const harness: FlowHarness = {
    root,
    io,
    core,
    payloads,
    addPayload: async (version, mode, nodeEngines) => {
      const dir = await writeFakePayload({
        dir: path.join(root, `payload-${version}`),
        pkgName: PKG,
        version,
        mode,
        ...(nodeEngines !== undefined ? { nodeEngines } : {}),
      });
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
    // Outside the install root on purpose: the program/data separation guard rejects nesting.
    dataDir: path.join(path.dirname(h.root), `${path.basename(h.root)}-user-data`),
    pollMs: 100,
  };
}

test('update installs a release even when nothing is running and clears blocked state', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'));
  await h.addPayload('1.1.0');
  await writeBlockedRelease(h.root, { version: '0.9.0', reason: 'old unrelated block', at: new Date().toISOString() });

  const outcome = await performHubUpdate(baseOptions(h));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.previousVersion, null);
  assert.equal(outcome.restarted, false);
  assert.equal(outcome.started, false);

  const current = await readCurrentRelease(h.root);
  assert.ok(current !== null);
  assert.equal(current.version, '1.1.0');
  assert.ok(current.entries['entryPath'] !== undefined);
  assert.ok(existsSync(current.entries['entryPath']!));
  // The staged candidate is the unpacked payload at the release root (npm-pack layout).
  assert.match(path.relative(h.root, current.entries['entryPath']!), /^releases[/\\]1\.1\.0[/\\][^/]+[/\\]start\.mjs$/);
  assert.equal(await readBlockedRelease(h.root), null);
  // The install strategy: unpack-first + plain `npm install` with the ignore-scripts contract
  // (no tarball spec argument — the payload is already unpacked in the staging root).
  assert.equal(h.core.npmCalls.length, 1);
  assert.equal(h.core.npmCalls[0]![0], 'install');
  assert.ok(h.core.npmCalls[0]!.includes('--ignore-scripts'));
  assert.ok(h.core.npmCalls[0]!.includes('--omit=dev'));
});

test('same-version update is a no-op and downgrades are rejected without --force', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.0.0');
  await h.addPayload('1.0.0');
  await performHubUpdate(baseOptions(h));
  const noop = await performHubUpdate(baseOptions(h));
  assert.equal(noop.changed, false);
  assert.equal(h.core.npmCalls.length, 1);

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
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.2.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.2.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' });
  await writeBlockedRelease(h.root, {
    version: '1.2.0',
    reason: 'candidate readiness failed: simulated',
    at: new Date().toISOString(),
  });

  await assert.rejects(
    performHubUpdate(baseOptions(h)),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'update_blocked_cooldown');
      return true;
    },
  );
  // Expired cooldown no longer blocks.
  await writeBlockedRelease(h.root, {
    version: '1.2.0',
    reason: 'candidate readiness failed: simulated',
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
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
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
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'));
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), tarballPath: '/tmp/whatever.tgz' }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'tarball_requires_version');
      return true;
    },
  );

  await h.addPayload('2.0.0');
  // A real package/-rooted tarball: the local channel copies it in and unpacks it for real.
  const tarballPath = await packFixture(h.root, '2.0.0');
  const outcome = await performHubUpdate({
    ...baseOptions(h),
    tarballPath,
    targetVersion: '2.0.0',
  });
  assert.equal(outcome.changed, true);
  assert.equal((await readCurrentRelease(h.root))?.version, '2.0.0');
  assert.equal(h.core.npmCalls.length, 1);
  const current = await readCurrentRelease(h.root);
  assert.ok(current !== null);
  assert.match(path.relative(h.root, current.entries['entryPath']!), /^releases[/\\]2\.0\.0[/\\][^/]+[/\\]start\.mjs$/);
});

test('running update: old hub stops, new hub serves, pid/launch records follow', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
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

test('failed candidate readiness rolls the pointer back, restarts the old hub, and blocks the version', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
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
  // Pointer restored, old hub restarted on the same port and serving again.
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
  assert.match(blocked?.reason ?? '', /readiness/);
  await assert.rejects(
    performHubUpdate(baseOptions(h)),
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
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
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
    performHubUpdate(baseOptions(h)),
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

test('concurrent updates are excluded by the engine upgrade lock', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
  await h.addPayload('1.1.0');
  const lockPath = path.join(h.root, 'upgrade.lock');
  const fd = openSync(lockPath, 'wx');
  try {
    await assert.rejects(performHubUpdate(baseOptions(h)), /upgrade already in progress/);
  } finally {
    closeSync(fd);
    unlinkSync(lockPath); // closing the fd does not remove the lock file
  }
  const ok = await performHubUpdate(baseOptions(h));
  assert.equal(ok.changed, true);
});

test('staged releases are reused via the engine .complete cache instead of reinstalling', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' }); // install #1 (1.0.0)
  await performHubUpdate(baseOptions(h)); // install #2 (1.1.0 from latest)
  const firstCurrent = await readCurrentRelease(h.root);
  assert.ok(firstCurrent !== null);
  assert.equal(firstCurrent.version, '1.1.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0', force: true }); // install #3 (forced restage)
  h.core.npmCalls.length = 0;
  const reused = await performHubUpdate(baseOptions(h)); // cache hit: no new npm install
  assert.equal(h.core.npmCalls.length, 0);
  const current = await readCurrentRelease(h.root);
  assert.ok(current !== null);
  assert.equal(current.version, '1.1.0');
  assert.equal(current.entries['entryPath'], firstCurrent.entries['entryPath']); // same immutable candidate
});

test('cache reuse revalidates the candidate: a post-staging mutation never commits', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-cachereval-'), '1.1.0');
  await h.addPayload('1.0.0');
  const first = await stageHubRelease({ ...baseOptions(h), version: '1.0.0' });
  assert.equal(first.reusedCached, false);
  const releaseDir = first.releaseDir;

  // Leg 1 — package identity tamper: the engine's entry-existence reuse check passes, but the
  // launcher's offline verification rejects the mutated manifest before anything commits.
  const manifestPath = path.join(releaseDir, 'manifest.json');
  const originalManifest = await import('node:fs/promises').then((fsp) => fsp.readFile(manifestPath, 'utf8'));
  await import('node:fs/promises').then((fsp) =>
    fsp.writeFile(manifestPath, JSON.stringify({ name: PKG, version: '9.9.9' })),
  );
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.0.0' }),
    /unpacked payload manifest mismatch: expected @fake\/hub-payload@1\.0\.0, got @fake\/hub-payload@9\.9\.9/,
  );
  await import('node:fs/promises').then((fsp) => fsp.writeFile(manifestPath, originalManifest, 'utf8'));

  // Untampered: the same cached candidate verifies and is reused (no new npm install).
  h.core.npmCalls.length = 0;
  const clean = await stageHubRelease({ ...baseOptions(h), version: '1.0.0' });
  assert.equal(clean.reusedCached, true);
  assert.equal(clean.releaseDir, releaseDir);
  assert.equal(h.core.npmCalls.length, 0);

  // Leg 2 — dependency-closure tamper: removing the installed inner file: dependency passes the
  // layout check but `start.mjs check` (which imports it) refuses the candidate.
  const depDir = path.join(releaseDir, 'node_modules', 'fixture-inner-dep');
  const depBackup = path.join(path.dirname(releaseDir), 'inner-dep-backup');
  await import('node:fs/promises').then((fsp) => fsp.rename(depDir, depBackup));
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.0.0' }),
    /payload self-check failed with exit code 3/,
  );
  await import('node:fs/promises').then((fsp) => fsp.rename(depBackup, depDir));
});

test('staging enforces the manifest nodeEngines floor against the launcher Node', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
  await h.addPayload('1.1.0', 'ok', '>=99.0.0');
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.1.0' }),
    /requires Node >= 99\.0\.0 but this launcher runs Node/,
  );
  // A floor below the injected runtime passes; an uninterpretable range is explicit.
  await h.addPayload('1.2.0', 'ok', '>=18.0.0');
  const staged = await stageHubRelease({ ...baseOptions(h), version: '1.2.0', nodeVersion: '20.1.0' });
  assert.equal(staged.version, '1.2.0');
  await h.addPayload('1.3.0', 'ok', '^24');
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.3.0' }),
    /not a supported ">=x\.y\.z" floor/,
  );
});

test('staging refuses install/data nesting via the effective data directory', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
  await h.addPayload('1.1.0');
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.1.0', dataDir: path.join(h.root, 'data-inside') }),
    /must not overlap/,
  );
  await assert.rejects(
    performHubUpdate({ ...baseOptions(h), launchFlags: { dataDir: path.join(h.root, 'nested-data') } }),
    /must not overlap/,
  );
});

test('staging validates the npm layout contract files', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.1.0');
  const payloadDir = await h.addPayload('1.1.0');
  // Sabotage: remove manifest.json from the fixture payload.
  await rm(path.join(payloadDir, 'manifest.json'));
  await assert.rejects(
    stageHubRelease({ ...baseOptions(h), version: '1.1.0' }),
    /missing its manifest\.json contract/,
  );
});

test('check reports current/latest/blocked without touching state', { timeout: 60_000 }, async (t) => {
  const h = await setupFlow(t, useTempDir(t, 'helm-launcher-flow-'), '1.2.0');
  await h.addPayload('1.0.0');
  await performHubUpdate({ ...baseOptions(h), targetVersion: '1.0.0' });
  const result = await checkHubUpgrade({ io: h.io, root: h.root, pkgName: PKG, core: h.core });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked, null);
});

test('golden path: real npm pack tarball stages through the production extractor (registry channel)', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-golden-');
  const registry = await createFakeRegistry(PKG, '2.1.0');
  const payloadDir = await writeFakePayload({ dir: path.join(root, 'fixture-payload'), pkgName: PKG, version: '2.1.0' });
  await registry.serve('2.1.0', await packPayloadTarball(payloadDir));
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));

  const staged = await stageHubRelease({
    io,
    root,
    version: '2.1.0',
    pkgName: PKG,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    registryUrl: registry.registryUrl,
    fetchFn: registry.fetchImpl,
  });
  assert.equal(staged.version, '2.1.0');
  assert.ok(existsSync(staged.entryPath));
  // The packed artifact was unpacked to the candidate root (npm-pack layout, stripped prefix).
  assert.match(path.relative(root, staged.entryPath), /^releases[/\\]2\.1\.0[/\\][^/]+[/\\]start\.mjs$/);
  assert.equal(staged.reusedCached, false);

  // Corrupt-integrity metadata is rejected by the production verification chain.
  const badSri = 'sha512-' + 'A'.repeat(86) + '=';
  const tamperedPayload = await writeFakePayload({ dir: path.join(root, 'fixture-221'), pkgName: PKG, version: '2.2.0' });
  await registry.serve('2.2.0', await packPayloadTarball(tamperedPayload), { integrity: badSri });
  await assert.rejects(
    stageHubRelease({
      io,
      root,
      version: '2.2.0',
      pkgName: PKG,
      dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
      registryUrl: registry.registryUrl,
      fetchFn: registry.fetchImpl,
    }),
    /sha512 integrity check failed/,
  );
});

test('golden path: local --tarball of a real npm pack artifact installs and self-checks', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-goldentgz-');
  const payloadDir = await writeFakePayload({ dir: path.join(root, 'fixture-payload'), pkgName: PKG, version: '3.0.0' });
  const tarballPath = await packPayloadTarball(payloadDir);
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));

  const staged = await stageHubRelease({
    io,
    root,
    version: '3.0.0',
    pkgName: PKG,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    tarballPath,
  });
  assert.equal(staged.version, '3.0.0');
  assert.ok(existsSync(staged.entryPath));

  // The staged candidate runs for real through the production entry: banner-gated start + stop.
  await writeCurrentRelease(root, {
    version: '3.0.0',
    updatedAt: new Date().toISOString(),
    entries: { entryPath: staged.entryPath },
  });
  const port = await freePort();
  const started = await startHub(root, io, { flags: { port }, pollMs: 100 });
  t.after(() => cleanupPid(started.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '3.0.0' });
  await stopHub(root, io);
  await waitUntilDead(started.pid);
});
