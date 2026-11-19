import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helmx/test-kit/node';
import { readCurrentRelease } from '@helmx/env-io';
import { cmdCheck, cmdStatus, cmdStop, cmdUpdate } from '../../src/launcher/commands.js';
import { defaultUpdateCore } from '../../src/launcher/update-core.js';
import { readPidRecord } from '../../src/launcher/records.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  createFakeRegistry,
  fixtureTarballPacker,
  freePort,
  getJson,
  waitUntilDead,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

function ioWith(root: string) {
  return captureIo(sanitizedHostEnv({ HELMX_HUB_INSTALL_ROOT: root, HELMX_PAYLOAD_PACKAGE: PKG }));
}

test('the production update core is really bound to the shared engine', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-realcore-');
  const core = defaultUpdateCore();
  // Real engine staging semantics behind the port: immutable `<uuid>` candidate, engine-format
  // `.complete` marker, entries resolved inside the release.
  const staged = await core.stageRelease(root, '1.0.0', async (stagingDir) => {
    writeFileSync(path.join(stagingDir, 'start.mjs'), '#!/usr/bin/env node\n');
    return { entryPath: 'start.mjs' };
  });
  assert.ok(existsSync(staged.entries['entryPath']!));
  assert.match(path.relative(root, staged.releaseDir), /^releases[/\\]1\.0\.0[/\\][0-9a-f-]{36}$/);
  const marker = JSON.parse(readFileSync(path.join(root, 'releases', '1.0.0', '.complete'), 'utf8')) as {
    origin: string;
    candidateDir: string;
  };
  assert.equal(marker.origin, 'extractor');
  assert.equal(marker.candidateDir, staged.releaseDir);
});

test('check with a fake core reports current/latest as JSON and text', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-clicheck-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '2.0.0', payloads });
  const json = ioWith(root);
  assert.equal(await cmdCheck({ root, io: json.io, core }, { json: true }), 0);
  const payload = JSON.parse(json.outText()) as { currentVersion: string | null; latestVersion: string; updateAvailable: boolean };
  assert.equal(payload.currentVersion, null);
  assert.equal(payload.latestVersion, '2.0.0');
  assert.equal(payload.updateAvailable, true);

  const text = ioWith(root);
  assert.equal(await cmdCheck({ root, io: text.io, core }, {}), 0);
  assert.match(text.outText(), /latest:\s+2\.0\.0/);
  assert.match(text.outText(), /update:\s+available/);
});

test('local control: install and start, report status, upgrade, and stop', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-clie2e-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '1.1.0', payloads });
  const port = await freePort();

  await writeFakePayload({ dir: path.join(root, 'payload-1.0.0'), pkgName: PKG, version: '1.0.0' });
  const tarballPath = await fixtureTarballPacker()(path.join(root, 'payload-1.0.0'));
  await writeFakePayload({ dir: path.join(root, 'payload-1.1.0'), pkgName: PKG, version: '1.1.0' });
  payloads.set('1.1.0', path.join(root, 'payload-1.1.0'));

  const dataDir = useTempDir(t, 'helmx-launcher-local-data-');
  const install = ioWith(root);
  assert.equal(await cmdUpdate({ root, io: install.io, core }, { tarball: tarballPath, version: '1.0.0', port, dataDir }), 0);
  assert.match(install.outText(), /updated: \(none\) -> 1\.0\.0/);

  assert.match(install.outText(), /hub started \(pid \d+/);
  const pidRecord = await readPidRecord(root);
  assert.ok(pidRecord !== null);
  t.after(() => cleanupPid(pidRecord.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  const status = ioWith(root);
  assert.equal(await cmdStatus({ root, io: status.io, core }, { json: true }), 0);
  const statusPayload = JSON.parse(status.outText()) as {
    current: { version: string };
    running: { pid: number; version: string; alive: boolean; healthy: boolean };
    launch: { port: number };
  };
  assert.equal(statusPayload.current.version, '1.0.0');
  assert.equal(statusPayload.running.alive, true);
  assert.equal(statusPayload.running.healthy, true);
  assert.equal(statusPayload.launch.port, port);

  const update = ioWith(root);
  assert.equal(await cmdUpdate({ root, io: update.io, core }, { dataDir }), 0);
  assert.match(update.outText(), /1\.0\.0 -> 1\.1\.0/);
  assert.match(update.outText(), /hub restarted/);
  const updatedPid = await readPidRecord(root);
  assert.ok(updatedPid !== null);
  t.after(() => cleanupPid(updatedPid.pid));
  await waitUntilDead(pidRecord.pid);
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' });

  const stop = ioWith(root);
  assert.equal(await cmdStop({ root, io: stop.io, core }, { json: true }), 0);
  const stopPayload = JSON.parse(stop.outText()) as {
    ok: boolean;
    wasRunning: boolean;
    pid?: number;
    escalated: boolean;
    cleanedStalePid: boolean;
  };
  assert.equal(stopPayload.ok, true);
  assert.equal(stopPayload.wasRunning, true);
  assert.equal(stopPayload.escalated, false);
  assert.equal(stopPayload.cleanedStalePid, false);
  assert.equal(typeof stopPayload.pid, 'number');
  await waitUntilDead(updatedPid.pid);
  assert.equal(await readPidRecord(root), null);
});

test('CLI check routes the registry through the fetchFn seam against the real engine core', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-clireal-');
  const registry = await createFakeRegistry(PKG, '9.9.9');
  const captured = ioWith(root);
  assert.equal(await cmdCheck({ root, io: captured.io, fetchFn: registry.fetchImpl }, { json: true, registry: registry.registryUrl }), 0);
  const payload = JSON.parse(captured.outText()) as { currentVersion: string | null; latestVersion: string };
  assert.equal(payload.currentVersion, null);
  assert.equal(payload.latestVersion, '9.9.9');
  assert.equal(await readCurrentRelease(root), null); // no state touched
});
