/**
 * npm payload update: false registry / sha512 complete / stage-activate-reject lifecycle /
 * pendingandpreviousstate / failed rollback / corrupt manifest(contains registry meta inconsistent)/ install inject /
 * fail-closed concurrency lock / cannot change uuid release / containment / Windows path form reject /
 * SemVer fall back do not mistakenly report / state file contract all override.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopError } from '../src/errors.js';
import { resolveDesktopConfig } from '../src/config.js';
import { createPayloadUpdater, NpmPayloadUpdater, type NpmPayloadUpdaterOptions, type PayloadInfo } from '../src/updater.js';
import type { NpmInstaller } from '../src/npm-installer.js';
import { HostNpmInstaller } from '../src/npm-installer.js';
import {
  buildFixtureTarball,
  FakeNpmInstaller,
  FakeNpmRegistry,
  FIXTURE_DEP,
  FIXTURE_PACKAGE,
  sha512Integrity,
  type TarEntry,
} from './helpers-payload.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };

interface TestContext {
  dataDir: string;
  registry: FakeNpmRegistry;
}

async function withContext(fn: (ctx: TestContext) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-updater-'));
  const registry = await FakeNpmRegistry.start();
  try {
    await fn({ dataDir, registry });
  } finally {
    await registry.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function makeUpdater(ctx: TestContext, overrides: Partial<NpmPayloadUpdaterOptions> = {}): NpmPayloadUpdater {
  return new NpmPayloadUpdater({
    packageName: FIXTURE_PACKAGE,
    registry: ctx.registry.url,
    payloadRoot: path.join(ctx.dataDir, 'payload'),
    npmInstaller: new FakeNpmInstaller(),
    ...overrides,
  });
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  check?: (error: DesktopError) => void,
): Promise<DesktopError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DesktopError, `expectation DesktopError(${code}), actual: ${String(caught)}`);
  assert.equal(caught.code, code);
  check?.(caught);
  return caught;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- install main link:stage → pending → activate → current / previous ----

test('install main link:stage only write pending;activate write current(first time without previous); duplicate stage idempotent', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    const status = await updater.check();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.current, null);
    assert.equal(status.latest?.version, '1.0.0');
    assert.equal(status.latest?.entryPath, undefined);

    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(info.name, FIXTURE_PACKAGE);
    assert.deepEqual(info.entryArgs, []);
    assert.ok(info.releaseDir !== undefined && existsSync(info.releaseDir));
    assert.ok(info.entryPath !== undefined && existsSync(info.entryPath));
    assert.ok(info.entryPath!.endsWith(path.join('hub', 'dist', 'main.js')), 'entry must be manifest.entries.hub while non- start.mjs');
    assert.ok(existsSync(path.join(info.releaseDir!, 'node_modules', FIXTURE_DEP)), 'dependency must install in promote rise after release directory inside');
    assert.equal(installer.calls.length, 1);
    // release directory is cannot change uuid directory:releases/<name>/<version>/<uuid>
    assert.match(info.releaseDir!.split(path.sep).join('/'), new RegExp(`releases/${FIXTURE_PACKAGE}/1\\.0\\.0/[0-9a-f]{16}$`));

    // stage only write pending, do not write current.
    assert.ok(existsSync(path.join(payloadRoot, 'pending.json')));
    assert.ok(!existsSync(path.join(payloadRoot, 'current.json')));
    const pending = updater.resolvePending();
    assert.deepEqual(
      { name: pending?.name, version: pending?.version, releaseDir: pending?.releaseDir, entryPath: pending?.entryPath },
      { name: info.name, version: info.version, releaseDir: info.releaseDir, entryPath: info.entryPath },
    );
    assert.equal(updater.resolveCurrent(), null, 'stage after current still is empty');
    assert.equal(updater.resolvePrevious(), null);

    await updater.activate(info);
    const current = updater.resolveCurrent();
    assert.deepEqual(
      { name: current?.name, version: current?.version, entryPath: current?.entryPath },
      { name: info.name, version: info.version, entryPath: info.entryPath },
    );
    assert.ok(existsSync(path.join(payloadRoot, 'current.json')));
    assert.equal(updater.resolvePending(), null, 'activate after the same pending clear');
    assert.equal(updater.resolvePrevious(), null, 'first time activate without previous');

    // check idempotent:up_to_date.
    const again = await updater.check();
    assert.equal(again.updateAvailable, false);
    assert.equal(again.reason, 'up_to_date');

    // same version duplicate stage: hit current fast path, does not repeat download/install, do not destroy current.
    const restage = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    assert.equal(restage.version, '1.0.0');
    assert.equal(installer.calls.length, 1);
    assert.equal(restage.releaseDir, current!.releaseDir, 'current fast path re- use since has release directory');
    assert.ok(updater.resolvePending() !== null, 'duplicate stage re- register pending supply decide protocol');
    await updater.activate(restage);
    assert.equal(updater.resolvePrevious(), null, 'same releaseDir again activate produces no previous');
    assert.equal(updater.resolveCurrent()!.version, '1.0.0');
  });
});

// ---- sha512 complete ----

test('sha512 complete: tamper tarball → tarball_integrity_mismatch, do not release, do not write current/pending, record blocked', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: sha512Integrity(Buffer.from('tampered')) });
    const updater = makeUpdater(ctx);

    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'tarball_integrity_mismatch');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'releases')), 'must not produce out release directory');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')), 'must not write current.json');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')), 'must not write pending.json');
    const status = await updater.check();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.reason, 'latest_blocked');
    assert.equal(status.blocked?.code, 'tarball_integrity_mismatch');
  });
});

// ---- failed rollback: when before version do not by break ----

test('failed rollback: new version stage verify failed → current/entry keep old version,blocked record,staging empty', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const good = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(good);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
    const goodRelease = updater.resolveCurrent()!.releaseDir!;

    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0', corrupt: 'checksums' }));
    const status = await updater.check();
    assert.equal(status.updateAvailable, true);

    const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'payload_check_failed', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
      assert.ok(tail.includes('checksum inconsistent'), `diagnose must contains fixture stderr tail part, actual: ${tail}`);
    });
    assert.equal((error.details as { releaseDir?: string }).releaseDir?.includes('staging'), true, 'failed occur in staging zone');

    const current = updater.resolveCurrent();
    assert.equal(current?.version, '1.0.0', 'current must still is 1.0.0');
    assert.ok(existsSync(current!.entryPath!), 'old entry file must completely well');
    assert.equal(current!.releaseDir, goodRelease, 'old release directory do not by move/delete');
    const versionDir = path.join(ctx.dataDir, 'payload', 'releases', FIXTURE_PACKAGE, '2.0.0');
    assert.ok(!existsSync(versionDir), 'failed version must not promote rise');
    const staging = path.join(ctx.dataDir, 'payload', 'staging');
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging must clean up');
    assert.equal(updater.resolvePending(), null, 'failed after without pending');

    const blockedStatus = await updater.check();
    assert.equal(blockedStatus.updateAvailable, false);
    assert.equal(blockedStatus.reason, 'latest_blocked');

    // after continue health version still can install; activate after previous save 1.0.0 baseline; old blocked record keep.
    ctx.registry.publish('2.0.1', buildFixtureTarball({ version: '2.0.1' }));
    const repaired = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(repaired.version, '2.0.1');
    await updater.activate(repaired);
    assert.equal(updater.resolveCurrent()?.version, '2.0.1');
    const previous = updater.resolvePrevious();
    assert.equal(previous?.version, '1.0.0', 'activate must save old baseline');
    assert.equal(previous?.releaseDir, goodRelease);
    const blocked = readJson(path.join(ctx.dataDir, 'payload', 'blocked.json')) as { entries: Record<string, unknown> };
    assert.ok(`${FIXTURE_PACKAGE}@2.0.0` in blocked.entries, '2.0.0  blocked record keep');
    assert.ok(!(`${FIXTURE_PACKAGE}@2.0.1` in blocked.entries), 'install succeeded must solve except the version blocked');
  });
});

// ---- corrupt manifest(contains registry meta and manifest name/version inconsistent) ----

test('corrupt manifest: illegal JSON / formatVersion / kernel missing / kernel points to launcher / manifest and registry meta  name/version inconsistent all explicit reject', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const cases: Array<{ version: string; corrupt: NonNullable<Parameters<typeof buildFixtureTarball>[0]['corrupt']>; expectCode: string }> = [
      { version: '1.1.0', corrupt: 'manifest-json', expectCode: 'payload_manifest_invalid' },
      { version: '1.2.0', corrupt: 'format-version', expectCode: 'payload_manifest_invalid' },
      { version: '1.3.0', corrupt: 'entry-missing', expectCode: 'payload_manifest_invalid' },
      { version: '1.4.0', corrupt: 'hub-is-launcher', expectCode: 'payload_manifest_invalid' },
      { version: '1.5.0', corrupt: 'manifest-name', expectCode: 'payload_manifest_invalid' },
      { version: '1.6.0', corrupt: 'manifest-version', expectCode: 'payload_manifest_invalid' },
    ];
    for (const [index, item] of cases.entries()) {
      ctx.registry.publish(item.version, buildFixtureTarball({ version: item.version, corrupt: item.corrupt }), {
        asLatest: index === cases.length - 1,
      });
    }
    const updater = makeUpdater(ctx);
    for (const item of cases) {
      const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: item.version }), item.expectCode);
      if (item.corrupt === 'manifest-name' || item.corrupt === 'manifest-version') {
        const problems = (error.details as { problems?: string[] }).problems ?? [];
        assert.ok(
          problems.some((p) => p.includes('registry metadata inconsistent')),
          `meta consistency issue must explicit column out, actual: ${problems.join('; ')}`,
        );
      }
    }
    // meta inconsistent belong system product defect: heavy install same version must by block assert and points to original error code.
    const mismatchCase = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '1.5.0' }), 'updater_version_blocked');
    assert.equal((mismatchCase.details as { blocked?: { code?: string } }).blocked?.code, 'payload_manifest_invalid');
  });
});

// ---- dependency and install inject ----

test('dependency missing and without install → payload_deps_missing(do not record blocked); inject install after succeeded', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const noInstaller = new NpmPayloadUpdater({
      packageName: FIXTURE_PACKAGE,
      registry: ctx.registry.url,
      payloadRoot: path.join(ctx.dataDir, 'payload'),
    });
    await rejectsWith(noInstaller.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'payload_deps_missing', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
      assert.ok(tail.includes(FIXTURE_DEP), `diagnose must column out missing dependency, actual: ${tail}`);
    });
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')));
    const status = await noInstaller.check();
    assert.equal(status.updateAvailable, true, 'dependency missing belong environment config, must not block assert version');

    const withInstaller = makeUpdater(ctx);
    const info = await withInstaller.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

test('vendored payload(tarball self carries node_modules)→ do not invoke install directly via', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0', vendoredDeps: [FIXTURE_DEP] }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(installer.calls.length, 0, 'vendored scenario must not invoke install');
  });
});

test('inject install failed → npm_install_failed original on throw,current/pending do not', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const failing: NpmInstaller = {
      id: 'failing',
      async install() {
        throw new DesktopError('npm_install_failed', 'boom', { stderrTail: ['ECONNREFUSED registry'] });
      },
    };
    const updater = makeUpdater(ctx, { npmInstaller: failing });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'npm_install_failed');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')));
  });
});

// ---- stage / activate / reject lifecycle ----

test('reject: record blocked, keep current, clear the same pending, do not modify any release directory', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);

    const staged = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(updater.resolveCurrent()?.version, '1.0.0', 'stage new version do not motion current');

    await updater.reject(staged, new DesktopError('payload_check_failed', 'start health check failed', { stderrTail: ['ECONNREFUSED 127.0.0.1:3202'] }));
    assert.equal(updater.resolvePending(), null, 'reject after pending clear');
    assert.equal(updater.resolveCurrent()?.version, '1.0.0', 'reject keep current');
    assert.ok(existsSync(staged.releaseDir!), 'reject do not delete by refuse version release directory');
    assert.ok(existsSync(baseline.releaseDir!), 'reject do not motion baseline release directory');
    const blocked = readJson(path.join(payloadRoot, 'blocked.json')) as { entries: Record<string, { code: string; stderrTail?: string[] }> };
    assert.equal(blocked.entries[`${FIXTURE_PACKAGE}@2.0.0`]?.code, 'payload_check_failed');
    assert.deepEqual(blocked.entries[`${FIXTURE_PACKAGE}@2.0.0`]?.stderrTail, ['ECONNREFUSED 127.0.0.1:3202']);

    // non- DesktopError also such as record (code unify payload_rejected).
    ctx.registry.publish('2.1.0', buildFixtureTarball({ version: '2.1.0' }));
    const staged2 = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.1.0' });
    await updater.reject(staged2, new Error('window start i.e. crash'));
    const blocked2 = readJson(path.join(payloadRoot, 'blocked.json')) as { entries: Record<string, { code: string }> };
    assert.equal(blocked2.entries[`${FIXTURE_PACKAGE}@2.1.0`]?.code, 'payload_rejected');

    // by refuse version again stage must by block assert.
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' }), 'updater_version_blocked');
    // reject reference illegal explicit reject.
    await rejectsWith(updater.reject({ name: 'other', version: '1.0.0' }, new Error('x')), 'payload_reject_invalid');
    await rejectsWith(updater.reject({ name: FIXTURE_PACKAGE, version: 'not-semver' }, new Error('x')), 'payload_reject_invalid');
  });
});

test('activate: reference by tamper (escape/across package/entry inconsistent)→ payload_activate_invalid,current do not change', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });

    const outside: PayloadInfo = { ...info, releaseDir: path.join(ctx.dataDir, 'elsewhere') };
    await rejectsWith(updater.activate(outside), 'payload_activate_invalid');
    const winPath: PayloadInfo = { ...info, releaseDir: 'C:\\evil\\payload' };
    await rejectsWith(updater.activate(winPath), 'payload_activate_invalid');
    const wrongPkg: PayloadInfo = { ...info, name: 'other-payload' };
    await rejectsWith(updater.activate(wrongPkg), 'payload_activate_invalid');
    const wrongEntry: PayloadInfo = { ...info, entryPath: path.join(info.releaseDir!, 'start.mjs') };
    await rejectsWith(updater.activate(wrongEntry), 'payload_activate_invalid', (e) => {
      const problems = (e.details as { problems?: string[] }).problems ?? [];
      assert.ok(problems.some((p) => p.includes('entries.hub inconsistent')), `entry inconsistent must explicit column out, actual: ${problems.join('; ')}`);
    });
    assert.equal(updater.resolveCurrent(), null, 'activate failed do not write current');
    assert.ok(updater.resolvePending() !== null, 'activate failed keep pending await correct decide protocol');

    await updater.activate(info);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
  });
});

// ---- atomic promote rise failed: old current and version directory keep ----

test('atomic promote rise failed: version directory by occupy file block → payload_promote_failed,current/since has version directory keep', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);

    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    // use occupy file block 2.0.0 version directory create (mkdirSync EEXIST).
    const versionDir = path.join(ctx.dataDir, 'payload', 'releases', FIXTURE_PACKAGE, '2.0.0');
    mkdirSync(path.dirname(versionDir), { recursive: true });
    writeFileSync(versionDir, 'blocked-by-placeholder');

    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' }), 'payload_promote_failed');
    const current = updater.resolveCurrent();
    assert.equal(current?.version, '1.0.0', 'current keep old version');
    assert.ok(existsSync(current!.entryPath!), 'old entry completely well');
    assert.ok(existsSync(baseline.releaseDir!), 'old release directory do not by break');
    assert.equal(updater.resolvePending(), null, 'promote rise failed without pending');
    const staging = path.join(ctx.dataDir, 'payload', 'staging');
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging must clean up');
  });
});

// ---- concurrency lock (fail-closed: never take over) ----

test('concurrency lock: same process concurrency stage serial, fast path converge is single time download/install', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const [a, b] = await Promise.all([
      updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }),
      updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }),
    ]);
    assert.equal(a.releaseDir, b.releaseDir);
    assert.equal(installer.calls.length, 1, 'second concurrency request must hit fast path while non- duplicate install');
  });
});

test('lock fail-closed: lock (real store process hold lock) has boundary wait for after explicit diagnose, never stealthily lock', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const payloadRoot = path.join(ctx.dataDir, 'payload');
    mkdirSync(payloadRoot, { recursive: true });
    const lockPath = path.join(payloadRoot, '.lock');

    // real store process hold has lock 8 second (wait for its real after again start install, avoid test race).
    const holder = spawn(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, at: Date.now() })); setTimeout(() => {}, 8000);`,
    ]);
    try {
      const holderReady = Date.now() + 5_000;
      while (!existsSync(lockPath)) {
        if (Date.now() > holderReady) throw new Error('lock holder not can lock file');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const updater = makeUpdater(ctx, { lockTimeoutMs: 500 });
      const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout', (e) => {
        assert.match(e.message, /fail-closed do not automatically take over/);
        assert.match(e.message, /manually delete/);
      });
      assert.equal((error.details as { holder?: { pid?: number } }).holder?.pid, holder.pid, 'diagnose must contains real holder pid');
      assert.ok(existsSync(lockPath), 'never delete other person hold has lock');
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('close', resolve));
    }

    // holder exit but not clean up (crash legacy):same do not take over,human remove after restore.
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, at: Date.now() }));
    const deadLockUpdater = makeUpdater(ctx, { lockTimeoutMs: 300 });
    await rejectsWith(deadLockUpdater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout', (e) => {
      assert.match(e.message, /fail-closed/);
    });
    assert.ok(existsSync(lockPath), 'die pid crash legacy lock also do not automatically delete');

    rmSync(lockPath, { force: true });
    const info = await deadLockUpdater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

test('lock fail-closed: content illegal lock file same only diagnose do not delete', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const payloadRoot = path.join(ctx.dataDir, 'payload');
    mkdirSync(payloadRoot, { recursive: true });
    const lockPath = path.join(payloadRoot, '.lock');
    writeFileSync(lockPath, 'not-json-at-all');
    const updater = makeUpdater(ctx, { lockTimeoutMs: 300 });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout');
    assert.equal(readFileSync(lockPath, 'utf8'), 'not-json-at-all', 'illegal content lock file keep original await human where placement');
    rmSync(lockPath, { force: true });
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

// ---- tar containment ----

test('tar containment: absolute path / .. through exceeds / non- package prefix item all explicit reject', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const attacks: Array<{ version: string; entry: TarEntry; code: string }> = [
      { version: '1.1.0', entry: { name: 'package/../../escape.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.2.0', entry: { name: '../outside.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.3.0', entry: { name: '/abs/escape.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.4.0', entry: { name: 'no-prefix.txt', content: 'x' }, code: 'tar_entry_prefix' },
      { version: '1.5.0', entry: { name: 'package\\win-escape.txt', content: 'x' }, code: 'tar_entry_invalid' },
    ];
    for (const [index, attack] of attacks.entries()) {
      ctx.registry.publish(
        attack.version,
        buildFixtureTarball({ version: attack.version, extraEntries: [attack.entry] }),
        { asLatest: index === attacks.length - 1 },
      );
    }
    const updater = makeUpdater(ctx);
    for (const attack of attacks) {
      await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: attack.version }), attack.code);
    }
    // attack item absolute without may write to dataDir of outside (same batch legal item only in staging inside, and already clean up).
    assert.ok(!existsSync(path.join(ctx.dataDir, 'escape.txt')));
    assert.ok(!existsSync(path.join(ctx.dataDir, '..', 'outside.txt')));
    assert.ok(!existsSync('/abs'));
  });
});

// ---- registry metadata boundary ----

test('registry metadata:sha1 integrity / non- SemVer version / unknown version / metadata timeout explicit reject', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: 'sha1-abcdef' });
    const updater = makeUpdater(ctx);
    await rejectsWith(updater.check(), 'registry_metadata_invalid', (e) => {
      assert.ok(((e.details as { problems?: string[] }).problems ?? []).some((p) => p.includes('sha512')));
    });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '9.9.9' }), 'registry_metadata_invalid');
    // non- SemVer version number (missing patch segment) explicit reject.
    ctx.registry.publish('1.0', buildFixtureTarball({ version: '1.0' }));
    await rejectsWith(updater.check(), 'registry_metadata_invalid', (e) => {
      assert.ok(((e.details as { problems?: string[] }).problems ?? []).some((p) => p.includes('SemVer')));
    });

    ctx.registry.setMetadataDelayMs(2_000);
    const slow = makeUpdater(ctx, { metadataTimeoutMs: 300 });
    await rejectsWith(slow.check(), 'registry_metadata_failed');
    ctx.registry.setMetadataDelayMs(0);
  });
});

// ---- check update decide (SemVer:latest fall back do not mistakenly report; lock version by user intent) ----

test('check update decide: trace latest when registry fall back do not mistakenly report up_to_date of outside state;prerelease priority correct', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);

    // latest fall back to more low version: is not update.
    ctx.registry.publish('0.9.0', buildFixtureTarball({ version: '0.9.0' }));
    let status = await updater.check();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.reason, 'up_to_date');
    assert.equal(status.latest?.version, '0.9.0');

    // same version: is not update.
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, false);

    // more high version prerelease < same number release:1.1.0 greater than 1.1.0-rc.1.
    ctx.registry.publish('1.1.0-rc.1', buildFixtureTarball({ version: '1.1.0-rc.1' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'prerelease high at current treated as update');
    const rcInfo = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.1.0-rc.1' });
    await updater.activate(rcInfo);
    ctx.registry.publish('1.1.0-rc.2', buildFixtureTarball({ version: '1.1.0-rc.2' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'rc.2 > rc.1');
    ctx.registry.publish('1.1.0', buildFixtureTarball({ version: '1.1.0' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'release > prerelease');
    const release = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(release);
    ctx.registry.publish('1.1.0-beta.9', buildFixtureTarball({ version: '1.1.0-beta.9' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, false, 'beta < release do not mistakenly report');
  });
});

test('check update decide: explicit lock version (pinnedVersion) allows by user intent fall back swap install', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);
    assert.equal(updater.resolveCurrent()?.version, '2.0.0');

    // registry latest move back low version after, lock to more low version: user explicit intent, judge is can update.
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const pinned = makeUpdater(ctx, { pinnedVersion: '1.0.0' });
    const status = await pinned.check();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latest?.version, '1.0.0');
    const downgrade = await pinned.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await pinned.activate(downgrade);
    assert.equal(pinned.resolveCurrent()?.version, '1.0.0');
    const again = await pinned.check();
    assert.equal(again.updateAvailable, false);
    assert.equal(again.reason, 'up_to_date');
  });
});

// ---- state file contract (strictly re- verify:manifest consistent + Windows path form reject) ----

test('resolveCurrent:current.json corrupt / system product missing / manifest or path inconsistent explicit errors, not silently when empty state', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);

    const payloadRoot = path.join(ctx.dataDir, 'payload');
    const currentFile = path.join(payloadRoot, 'current.json');
    const original = readFileSync(currentFile, 'utf8');
    writeFileSync(currentFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'updater_state_corrupt');
    await rejectsWith(updater.check(), 'updater_state_corrupt');
    writeFileSync(currentFile, original);

    // entry by external delete → current_payload_invalid(while non- return null).
    const current = updater.resolveCurrent();
    rmSync(current!.entryPath!);
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');
    // restore entry, continue path form attack.
    mkdirSync(path.dirname(current!.entryPath!), { recursive: true });
    writeFileSync(current!.entryPath!, '// restored\n');

    const base = readJson(currentFile);
    const win32Paths = ['C:\\evil\\payload', 'C:evil-relative', '\\\\server\\share', '/tmp/with\\backslash'];
    for (const evil of win32Paths) {
      writeJson(currentFile, { ...base, releaseDir: evil });
      await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid', (e) => {
        const problems = (e.details as { problems?: string[] }).problems ?? [];
        assert.ok(problems.length > 0, `Windows form path must by refuse: ${evil}`);
      });
    }

    // entryPath escape releaseDir.
    writeJson(currentFile, { ...base, entryPath: path.join(payloadRoot, 'current.json') });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');

    // state version and release manifest version inconsistent.
    writeJson(currentFile, { ...base, version: '9.9.9' });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid', (e) => {
      const problems = (e.details as { problems?: string[] }).problems ?? [];
      assert.ok(problems.some((p) => p.includes('manifest version')), `manifest version inconsistent must explicit column out, actual: ${problems.join('; ')}`);
    });

    // release directory inside manifest tamper (version change) same in re- verify when expose.
    writeJson(currentFile, base);
    const manifestFile = path.join(base['releaseDir'] as string, 'manifest.json');
    const manifest = readJson(manifestFile);
    writeJson(manifestFile, { ...manifest, version: '7.7.7' });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');
    writeJson(manifestFile, manifest);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
  });
});

test('resolvePending / resolvePrevious: missing → null; corrupt → updater_state_corrupt;activate before after semantics correct', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    assert.equal(updater.resolvePending(), null);
    assert.equal(updater.resolvePrevious(), null);

    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);
    const staged = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(updater.resolvePending()?.version, '2.0.0');

    const pendingFile = path.join(payloadRoot, 'pending.json');
    writeFileSync(pendingFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolvePending()), 'updater_state_corrupt');
    rmSync(pendingFile, { force: true });

    const stagedAgain = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(stagedAgain.version, '2.0.0');
    await updater.activate(stagedAgain);
    assert.equal(updater.resolvePrevious()?.version, '1.0.0');

    const previousFile = path.join(payloadRoot, 'previous.json');
    writeFileSync(previousFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolvePrevious()), 'updater_state_corrupt');
    rmSync(previousFile, { force: true });
  });
});

test('target package name inconsistent / version note symbol illegal → explicit reject', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const updater = makeUpdater(ctx);
    await rejectsWith(updater.stage({ name: 'other-package', version: '1.0.0' }), 'updater_target_mismatch');
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '../evil' }), 'registry_metadata_invalid');
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '1.0' }), 'registry_metadata_invalid');
  });
});

// ---- work vendor (not config) ----

test('createPayloadUpdater: not config package name → honest unconfigured all set', { timeout: 60_000 }, async () => {
  const updater = createPayloadUpdater(resolveDesktopConfig(BASE_ENV));
  assert.equal(updater.id, 'unconfigured');
  const status = await updater.check();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.reason, 'updater_not_configured');
  assert.equal(updater.resolveCurrent(), null);
  assert.equal(updater.resolvePending(), null);
  assert.equal(updater.resolvePrevious(), null);
  await rejectsWith(updater.stage({ name: 'any', version: 'latest' }), 'updater_not_configured');
  await rejectsWith(updater.activate({ name: 'any', version: '1.0.0' }), 'updater_not_configured');
  await rejectsWith(updater.reject({ name: 'any', version: '1.0.0' }, new Error('x')), 'updater_not_configured');
});

// ---- HostNpmInstaller:npm-cli.js parse / --ignore-scripts / timeout wait for close ----

test('HostNpmInstaller: by default command via node direct run execPath beside npm-cli.js, attach --ignore-scripts', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    // fabricate Node install layout:<dir>/node(real node symlink)+ node_modules/npm/bin/npm-cli.js.
    const executable = path.join(dir, path.basename(process.execPath));
    symlinkSync(process.execPath, executable);
    const npmCli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, 'process.exit(7);\n');
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({ execPath: executable });
    assert.match(installer.id, /npm-cli\.js/);
    const error = await rejectsWith(
      installer.install(payloadRoot),
      'npm_install_failed',
      (e) => {
        const argv = (e.details as { argv?: string[] }).argv ?? [];
        assert.ok(argv.includes('--ignore-scripts'), `must carry --ignore-scripts, actual: ${argv.join(' ')}`);
        assert.ok(argv[0] === executable && argv[1] === npmCli, 'must via node directly execute npm-cli.js');
      },
    );
    assert.match(error.message, /exit 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller:execPath beside without npm layout → npm_installer_unavailable explicit errors (attach refer quote)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    symlinkSync(process.execPath, path.join(dir, 'node'));
    const installer = new HostNpmInstaller({ execPath: path.join(dir, 'node') });
    assert.match(installer.id, /npm-cli\.js not found/);
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    await rejectsWith(installer.install(payloadRoot), 'npm_installer_unavailable', (e) => {
      assert.match(e.message, /npm-cli\.js/);
      assert.match(e.message, /explicit inject|host Node/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller: timeout SIGKILL after wait for close only then end (do not mention before release install lock)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 400,
      killGraceMs: 5_000,
    });
    const startedAt = Date.now();
    await rejectsWith(installer.install(payloadRoot), 'npm_install_failed', (e) => {
      assert.match(e.message, /timeout/);
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 400, `timeout decide must not early at timeoutMs, actual ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller: explicit command original use, failed attach stderr tail part diagnose', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({
      command: [process.execPath, '-e', 'console.error("boom-line"); process.exit(3);'],
    });
    await rejectsWith(installer.install(payloadRoot), 'npm_install_failed', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail ?? [];
      assert.ok(tail.includes('boom-line'), `stderr tail part must follow error attach out, actual: ${tail.join('\\n')}`);
    });
    // explicit inject self define command on success normal resolve.
    const ok = new HostNpmInstaller({ command: [process.execPath, '-e', 'process.exit(0);'] });
    await ok.install(payloadRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
