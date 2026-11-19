/**
 * State-record domain tests: layout/env resolution, pid/launch record validation and corruption
 * discipline (explicit errors, `null` only on ENOENT), CAS pid-file removal, launch configuration
 * precedence, and the engine-format `current.json` access used by start (`current.ts`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir } from '@helm/test-kit/node';
import { readCurrentRelease, writeCurrentRelease } from '@helm/env-io';
import {
  isBlockedActive,
  parseLinuxStartTime,
  readPidRecord,
  readProcessStartTime,
  removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  persistableLaunchConfig,
  writePidRecord,
} from '../../src/launcher/records.js';
import { readCurrentEntry } from '../../src/launcher/current.js';
import {
  assertDistTag,
  assertInstallIsolation,
  defaultHubDataDir,
  pathsOf,
  resolveInstallRoot,
  resolvePayloadPackageName,
  resolveRegistryUrl,
  resolveBlockedCooldownMs,
  resolveUpdateIntervalMs,
  resolveUpdateTag,
} from '../../src/launcher/layout.js';
import { UsageError } from '../../src/launcher/io.js';

test('hub.pid round-trips and rejects invalid shapes explicitly', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-pid-');
  assert.equal(await readPidRecord(root), null);

  const record = {
    pid: 12345,
    version: '1.2.3',
    entryPath: '/opt/releases/1.2.3/uuid/node_modules/@team4u/helm-hub/start.mjs',
    port: 3202,
    host: '127.0.0.1',
    dataDir: '/home/u/.helm',
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  await writePidRecord(root, record);
  assert.deepEqual(await readPidRecord(root), record);

  await assert.rejects(writePidRecord(root, { ...record, pid: 0 }), /pid.*positive integer/);
  await assert.rejects(writePidRecord(root, { ...record, version: 'not-semver' }), /invalid SemVer/);
  await assert.rejects(writePidRecord(root, { ...record, port: 99999 }), /integer port/);
  await assert.rejects(writePidRecord(root, { ...record, startTime: -1 }), /startTime.*non-negative integer/);

  // The Linux pid-reuse proof round-trips as an optional field.
  const withStart = { ...record, startTime: 123456 };
  await writePidRecord(root, withStart);
  assert.deepEqual(await readPidRecord(root), withStart);

  writeFileSync(pathsOf(root).pidPath, '{corrupt', 'utf8');
  await assert.rejects(readPidRecord(root), /hub\.pid is corrupt/);
});

test('Linux /proc start time parsing counts fields after the comm segment only', { timeout: 60_000 }, async () => {
  // comm may contain spaces and parentheses; field 22 (start time) sits after the final ')'.
  // comm may contain spaces and parentheses; field 22 (start time) sits after the final ')'.
  // Fields #4..#21 are 18 dummies, then #22 is the start time.
  const tail = `${Array.from({ length: 18 }, (_, i) => i + 1).join(' ')} 424242 18`;
  assert.equal(parseLinuxStartTime(`1234 (node) R ${tail}\n`), 424242);
  assert.equal(parseLinuxStartTime(`7 (weird ) name) S ${Array.from({ length: 18 }, () => 0).join(' ')} 99\n`), 99);
  assert.equal(parseLinuxStartTime('no-stat-line'), null);
  assert.equal(parseLinuxStartTime('1 (init) S not enough fields'), null);
  // The live reader proves a real pid's start time on Linux and reports null-shaped absence elsewhere.
  const live = await readProcessStartTime(process.pid);
  if (process.platform === 'linux') {
    assert.ok(typeof live === 'number' && live >= 0);
  } else {
    assert.equal(live, null);
  }
});

test('removePidFileIfMatch only removes an unchanged record (compare-and-swap)', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-pidcas-');
  const record = {
    pid: 4711,
    version: '1.0.0',
    entryPath: '/x/start.mjs',
    port: 3202,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  await writePidRecord(root, record);
  await writePidRecord(root, { ...record, pid: 4712 }); // replaced concurrently
  assert.equal(await removePidFileIfMatch(root, record), false);
  assert.ok((await readPidRecord(root)) !== null);
  assert.equal(await removePidFileIfMatch(root, { ...record, pid: 4712 }), true);
  assert.equal(await readPidRecord(root), null);
});

test('blocked cooldown boundaries: unparseable timestamps keep blocking', { timeout: 60_000 }, () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const blocked = { version: '1.0.0', reason: 'r', at: '2026-01-01T11:00:00Z' }; // 60 minutes elapsed
  assert.equal(isBlockedActive(blocked, now, 61 * 60_000), true); // still within cooldown
  assert.equal(isBlockedActive(blocked, now, 60 * 60_000), false); // exactly at the boundary
  assert.equal(isBlockedActive(blocked, now, 59 * 60_000), false); // past the cooldown
  assert.equal(isBlockedActive({ ...blocked, at: 'garbage' }, now, 60_000), true);
});

test('launch configuration precedence: flags > env > saved > defaults; web-dist false handling', { timeout: 60_000 }, () => {
  assert.deepEqual(
    resolveEffectiveLaunchConfig({
      flags: { port: 4001, host: '0.0.0.0', dataDir: '/d/flags' },
      env: { HELM_PORT: '4002', HELM_HOST: '127.0.0.2', HELM_DATA_DIR: '/d/env' },
      saved: { port: 4003, host: '127.0.0.3', dataDir: '/d/saved', model: 'm-saved' },
    }),
    { port: 4001, host: '0.0.0.0', dataDir: '/d/flags', model: 'm-saved' },
  );
  assert.deepEqual(
    resolveEffectiveLaunchConfig({ env: { HELM_PORT: '4002', HELM_DATA_DIR: '/d/env' }, saved: null }),
    { port: 4002, host: '127.0.0.1', dataDir: '/d/env' },
  );
  assert.deepEqual(resolveEffectiveLaunchConfig({ env: {} }), { port: 3202, host: '127.0.0.1' });
  assert.throws(() => resolveEffectiveLaunchConfig({ env: { HELM_PORT: 'abc' } }), /HELM_PORT/);
  // HELM_WEB_DIST_DIR=false explicitly disables static hosting; a path passes through.
  assert.deepEqual(
    resolveEffectiveLaunchConfig({ env: { HELM_WEB_DIST_DIR: 'false' } }),
    { port: 3202, host: '127.0.0.1', webDistDir: 'false' },
  );
  assert.deepEqual(
    resolveEffectiveLaunchConfig({ env: { HELM_WEB_DIST_DIR: '/w/dist' } }),
    { port: 3202, host: '127.0.0.1', webDistDir: '/w/dist' },
  );
  assert.deepEqual(persistableLaunchConfig({ port: 5, host: 'h', dataDir: '/d' }), {
    port: 5,
    host: 'h',
    dataDir: '/d',
  });
});

test('current entry access: engine record shape, entryPath extraction, explicit failures', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-current-');
  await assert.rejects(readCurrentEntry(root), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'no_release_installed');
    return true;
  });

  const entryPath = path.join(root, 'releases', '1.2.3', 'uuid', 'node_modules', '@fake', 'hub-payload', 'start.mjs');
  await writeCurrentRelease(root, {
    version: '1.2.3',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath },
  });
  const current = await readCurrentEntry(root);
  assert.equal(current.version, '1.2.3');
  assert.equal(current.entryPath, entryPath);
  assert.deepEqual(current.record.entries, { entryPath });

  // Missing entryPath key is an explicit contract failure, never a guess.
  await writeCurrentRelease(root, {
    version: '1.2.3',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { hub: entryPath },
  });
  await assert.rejects(readCurrentEntry(root), /entries\.entryPath is missing or invalid/);
  const engineRecord = await readCurrentRelease(root);
  assert.ok(engineRecord !== null);
  assert.equal(engineRecord.entries['hub'], entryPath);
});

test('layout helpers: update interval, dist-tag channels, and their invalid forms', { timeout: 60_000 }, () => {
  assert.equal(resolveUpdateIntervalMs({}), 15 * 60 * 1000);
  assert.equal(resolveUpdateIntervalMs({ HELM_HUB_UPDATE_INTERVAL_MS: '5000' }), 5000);
  assert.throws(() => resolveUpdateIntervalMs({ HELM_HUB_UPDATE_INTERVAL_MS: '0' }), /invalid HELM_HUB_UPDATE_INTERVAL_MS/);
  assert.throws(() => resolveUpdateIntervalMs({ HELM_HUB_UPDATE_INTERVAL_MS: 'abc' }), /invalid HELM_HUB_UPDATE_INTERVAL_MS/);

  assert.equal(resolveUpdateTag({}), 'latest');
  assert.equal(resolveUpdateTag({ HELM_HUB_UPDATE_TAG: 'beta' }), 'beta');
  assert.throws(() => resolveUpdateTag({ HELM_HUB_UPDATE_TAG: '../evil' }), /invalid dist-tag/);
  assert.throws(() => assertDistTag('1.2.3'), /looks like a version, not a dist-tag/);
  assert.throws(() => assertDistTag('foo bar'), /invalid dist-tag/);
  assert.equal(assertDistTag('beta-1.0'), 'beta-1.0');
});

test('layout helpers: install root, registry, package name, cooldown env', { timeout: 60_000 }, () => {
  assert.equal(resolveInstallRoot({ HELM_HUB_INSTALL_ROOT: '/opt/hub' }), '/opt/hub');
  assert.equal(resolveInstallRoot({ HELM_HUB_INSTALL_ROOT: '/opt/hub/' }), '/opt/hub');
  assert.match(resolveInstallRoot({}), /\/\.helm-hub$/);
  assert.equal(resolveRegistryUrl({}, 'https://registry.example.com/'), 'https://registry.example.com');
  assert.equal(resolveRegistryUrl({ HELM_NPM_REGISTRY: 'https://mirror.example.com' }), 'https://mirror.example.com');
  assert.throws(() => resolveRegistryUrl({}, 'ftp://bad'), /invalid npm registry URL/);
  assert.equal(resolvePayloadPackageName({}), '@team4u/helm-hub');
  assert.equal(resolvePayloadPackageName({ HELM_PAYLOAD_PACKAGE: '@acme/payload' }), '@acme/payload');
  assert.throws(() => resolvePayloadPackageName({ HELM_PAYLOAD_PACKAGE: 'not a name' }), /invalid payload package name/);
  assert.equal(resolveBlockedCooldownMs({}), 30 * 60_000);
  assert.equal(resolveBlockedCooldownMs({ HELM_UPGRADE_BLOCK_COOLDOWN_MS: '5000' }), 5000);
  assert.throws(() => resolveBlockedCooldownMs({ HELM_UPGRADE_BLOCK_COOLDOWN_MS: '-1' }), /invalid HELM_UPGRADE_BLOCK_COOLDOWN_MS/);
  assert.match(defaultHubDataDir({}), /\/\.helm$/);
  assert.equal(defaultHubDataDir({ HELM_DATA_DIR: '/data/helm' }), '/data/helm');
});

test('install/data isolation guard rejects nesting in both directions', { timeout: 60_000 }, (t) => {
  const root = useTempDir(t, 'helm-launcher-isol-');
  const dataInside = path.join(root, 'data');
  assert.throws(() => assertInstallIsolation(root, dataInside, {}), /must not overlap/);
  const outsideData = path.join(path.dirname(root), 'helm-data-elsewhere');
  assert.ok(assertInstallIsolation(root, outsideData, {}) === undefined);
  // Implicit default from env.
  assert.throws(() => assertInstallIsolation(root, undefined, { HELM_DATA_DIR: path.join(root, 'nested') }), /must not overlap/);
  // Install root inside the data directory is equally rejected.
  const dataDir = path.join(root, 'userdata');
  const installInside = path.join(dataDir, 'programs', 'helm-hub');
  mkdirSync(installInside, { recursive: true });
  assert.throws(() => assertInstallIsolation(installInside, dataDir, {}), /must not overlap/);
});
