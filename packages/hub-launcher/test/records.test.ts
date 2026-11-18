/**
 * State-record domain tests: layout/env resolution, current/blocked/pid/launch record validation,
 * corruption discipline (explicit errors, `null` only on ENOENT), CAS pid-file removal, and launch
 * configuration precedence.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir } from '@helm/test-kit/node';
import {
  isBlockedActive,
  readBlockedRelease,
  readCurrentRelease,
  readJsonRecord,
  readPidRecord,
  removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  persistableLaunchConfig,
  writeBlockedRelease,
  writeCurrentRelease,
  writePidRecord,
} from '../src/records.js';
import {
  resolveBlockedCooldownMs,
  resolveInstallRoot,
  resolvePayloadPackageName,
  resolveRegistryUrl,
  pathsOf,
} from '../src/layout.js';

test('current.json round-trips and rejects invalid shapes explicitly', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-current-');
  assert.equal(await readCurrentRelease(root), null);
  const record = {
    version: '1.2.3',
    releaseDir: path.join(root, 'releases', '1.2.3', 'uuid'),
    entryPath: path.join(root, 'releases', '1.2.3', 'uuid', 'node_modules', '@team4u', 'helm-hub', 'start.mjs'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeCurrentRelease(root, record);
  assert.deepEqual(await readCurrentRelease(root), record);

  writeFileSync(pathsOf(root).currentPath, '{ not json', 'utf8');
  await assert.rejects(readCurrentRelease(root), /current\.json is corrupt/);

  writeFileSync(
    pathsOf(root).currentPath,
    JSON.stringify({ version: '1.0', releaseDir: '/x', entryPath: '/y', updatedAt: 'z' }),
    'utf8',
  );
  await assert.rejects(readCurrentRelease(root), /failed validation.*invalid SemVer/);

  await assert.rejects(writeCurrentRelease(root, { ...record, version: 'v1.0.0' }), /invalid SemVer/);

  if (process.platform !== 'win32') {
    assert.equal(statSync(pathsOf(root).currentPath).mode & 0o777, 0o600);
  }
});

test('blocked record round-trips and the cooldown gate behaves deterministically', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-blocked-');
  assert.equal(await readBlockedRelease(root), null);
  const blocked = { version: '2.0.0', reason: 'candidate health check failed: boom', at: '2026-01-01T00:00:00.000Z' };
  await writeBlockedRelease(root, blocked);
  assert.deepEqual(await readBlockedRelease(root), blocked);

  const later = new Date('2026-01-01T00:20:00.000Z');
  const muchLater = new Date('2026-01-01T01:00:00.000Z');
  assert.equal(isBlockedActive(blocked, later, 30 * 60_000), true);
  assert.equal(isBlockedActive(blocked, muchLater, 30 * 60_000), false);
  assert.equal(isBlockedActive({ ...blocked, at: 'not-a-date' }, later, 30 * 60_000), true);

  writeFileSync(pathsOf(root).blockedPath, '[]', 'utf8');
  await assert.rejects(readBlockedRelease(root), /failed validation/);
});

test('hub.pid validates strictly and CAS removal only deletes matching records', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-pid-');
  const record = {
    pid: 4242,
    version: '1.0.0',
    entryPath: '/opt/hub/start.mjs',
    port: 3202,
    host: '127.0.0.1',
    dataDir: '/home/u/.helm',
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  await writePidRecord(root, record);
  assert.deepEqual(await readPidRecord(root), record);

  writeFileSync(pathsOf(root).pidPath, JSON.stringify({ ...record, pid: 0 }), 'utf8');
  await assert.rejects(readPidRecord(root), /"pid".*positive integer/);
  writeFileSync(pathsOf(root).pidPath, JSON.stringify({ ...record, port: 99999 }), 'utf8');
  await assert.rejects(readPidRecord(root), /"port".*between 1 and 65535/);

  await writePidRecord(root, record);
  const replacement = { ...record, pid: 9999 };
  await writePidRecord(root, replacement);
  // The record on disk no longer matches `record`; CAS removal must refuse and keep the file.
  assert.equal(await removePidFileIfMatch(root, record), false);
  assert.deepEqual(await readPidRecord(root), replacement);
  assert.equal(await removePidFileIfMatch(root, replacement), true);
  assert.equal(await readPidRecord(root), null);
});

test('launch config resolution precedence: flags > env > saved > defaults', { timeout: 60_000 }, () => {
  const resolved = resolveEffectiveLaunchConfig({
    flags: { port: 4100 },
    env: { HELM_HOST: '0.0.0.0', HELM_DATA_DIR: '/data/env' },
    saved: { port: 4200, host: '127.0.0.1', dataDir: '/data/saved', model: 'm-saved' },
  });
  assert.equal(resolved.port, 4100);
  assert.equal(resolved.host, '0.0.0.0');
  assert.equal(resolved.dataDir, '/data/env');
  assert.equal(resolved.model, 'm-saved');

  const defaults = resolveEffectiveLaunchConfig({ env: {}, saved: null });
  assert.equal(defaults.port, 3202);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.dataDir, undefined);

  assert.deepEqual(persistableLaunchConfig({ port: 3300, host: '127.0.0.1' }), {
    port: 3300,
    host: '127.0.0.1',
  });

  assert.throws(() => resolveEffectiveLaunchConfig({ env: { HELM_PORT: 'nope' } }), /HELM_PORT/);
  const disabled = resolveEffectiveLaunchConfig({ env: { HELM_WEB_DIST_DIR: 'false' } });
  assert.equal(disabled.webDistDir, 'false');
});

test('layout and env resolution follow documented defaults with explicit validation', { timeout: 60_000 }, () => {
  assert.equal(resolveInstallRoot({ HELM_HUB_INSTALL_ROOT: '/opt/hub-root' }), '/opt/hub-root');
  assert.equal(resolveInstallRoot({}), path.join(os.homedir(), '.helm-hub'));

  assert.equal(resolveRegistryUrl({}), 'https://registry.npmjs.org');
  assert.equal(resolveRegistryUrl({ HELM_NPM_REGISTRY: 'https://mirror.example.com///' }), 'https://mirror.example.com');
  assert.equal(resolveRegistryUrl({}, 'https://custom.example.com'), 'https://custom.example.com');
  assert.throws(() => resolveRegistryUrl({}, 'ftp://bad'), /invalid npm registry URL/);

  assert.equal(resolvePayloadPackageName({}), '@team4u/helm-hub');
  assert.equal(resolvePayloadPackageName({ HELM_PAYLOAD_PACKAGE: '@scope/pkg' }), '@scope/pkg');
  assert.throws(() => resolvePayloadPackageName({ HELM_PAYLOAD_PACKAGE: 'not a name!' }), /invalid payload package name/);

  assert.equal(resolveBlockedCooldownMs({}), 30 * 60_000);
  assert.equal(resolveBlockedCooldownMs({ HELM_HUB_BLOCKED_COOLDOWN_MS: '5000' }), 5000);
  assert.throws(() => resolveBlockedCooldownMs({ HELM_HUB_BLOCKED_COOLDOWN_MS: '-1' }), /invalid HELM_HUB_BLOCKED_COOLDOWN_MS/);

  const paths = pathsOf('/opt/root');
  assert.equal(paths.releasesDir, path.join('/opt/root', 'releases'));
  assert.equal(paths.pidPath, path.join('/opt/root', 'hub.pid'));
  assert.equal(paths.hubLogPath, path.join('/opt/root', 'logs', 'hub.log'));
});

test('readJsonRecord returns null only on ENOENT and wraps read failures explicitly', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-json-');
  const file = path.join(root, 'rec.json');
  assert.equal(await readJsonRecord(file, (raw) => raw, 'rec.json'), null);
  // Reading a directory (not a missing file) is an I/O failure, not a "missing record".
  mkdirSync(path.join(root, 'as-directory.json'), { recursive: true });
  await assert.rejects(
    readJsonRecord(path.join(root, 'as-directory.json'), (raw) => raw, 'as-directory.json'),
    /failed to read/,
  );
  writeFileSync(file, 'null', 'utf8');
  assert.equal(await readJsonRecord(file, (raw) => raw, 'rec.json'), null);
  writeFileSync(file, '{"a":1}', 'utf8');
  assert.deepEqual(await readJsonRecord(file, (raw: unknown) => {
    const rec = raw as { a?: unknown };
    if (typeof rec.a !== 'number') throw new Error('expected numeric a');
    return { a: rec.a };
  }, 'rec.json'), { a: 1 });
});
