import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helmx/test-kit/node';
import { readCurrentRelease } from '@helmx/env-io';
import { cmdCheck, cmdStart, cmdStop, cmdRestart, cmdUpdate, readLocalHubSnapshot } from '../../src/launcher/commands.js';
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
  spawnAlienProcess,
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
  const statusPayload = await readLocalHubSnapshot({ root, io: status.io });
  assert.ok(statusPayload !== null);
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

test('stop prefers the verified control channel when the hub wrote a control record', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-chanstop-');
  const dataDir = useTempDir(t, 'helmx-launcher-chanstop-data-');
  const { createControlServer, atomicWriteJson, controlEndpoint } = await import('@helmx/env-io');
  const { writePidRecord } = await import('../../src/launcher/records.js');

  // A stand-in "hub": a live process recorded in hub.pid plus a real control server whose stop
  // handler performs the graceful shutdown (killing the stand-in).
  const alienPid = spawnAlienProcess();
  t.after(() => cleanupPid(alienPid));
  const instanceId = 'd'.repeat(32);
  const endpoint = controlEndpoint(dataDir, instanceId, 'helmx-hub');
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: alienPid, state: 'serving', version: '1.0.0' }),
    onStop: async () => {
      process.kill(alienPid, 'SIGTERM');
    },
  });
  await server.listening;
  t.after(() => server.close());
  await atomicWriteJson(path.join(dataDir, 'hub-control.json'), {
    instanceId,
    endpoint,
    pid: alienPid,
    version: '1.0.0',
    port: 4_321,
    startedAt: new Date().toISOString(),
  }, { mode: 0o600 });
  await writePidRecord(root, {
    pid: alienPid,
    version: '1.0.0',
    entryPath: '/nowhere/start.mjs',
    port: 4_321,
    dataDir,
    startedAt: new Date().toISOString(),
  });

  const io = ioWith(root);
  assert.equal(await cmdStop({ root, io: io.io }, { json: true }), 0);
  const payload = JSON.parse(io.outText()) as { ok: boolean; wasRunning: boolean; via: string; pid: number };
  assert.equal(payload.ok, true);
  assert.equal(payload.wasRunning, true);
  assert.equal(payload.via, 'control-channel');
  await waitUntilDead(alienPid);
  assert.equal(await readPidRecord(root), null, 'pid record removed after the channel stop');
});

test('start -d starts detached and restart stops then starts with a fresh pid', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-startd-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '1.0.0', payloads });
  const port = await freePort();

  await writeFakePayload({ dir: path.join(root, 'payload-1.0.0'), pkgName: PKG, version: '1.0.0' });
  const tarballPath = await fixtureTarballPacker()(path.join(root, 'payload-1.0.0'));
  const dataDir = useTempDir(t, 'helmx-launcher-startd-data-');

  const install = ioWith(root);
  assert.equal(
    await cmdUpdate({ root, io: install.io, core }, { tarball: tarballPath, version: '1.0.0', port, dataDir }),
    0,
  );
  const firstPid = (await readPidRecord(root))!.pid;
  t.after(() => cleanupPid(firstPid));

  // restart: stops the running hub (pid-proof fallback — the fake payload has no channel) and
  // starts detached again with the sticky launch configuration.
  const restart = ioWith(root);
  assert.equal(await cmdRestart({ root, io: restart.io, core }, {}), 0);
  assert.match(restart.outText(), /hub pid \d+ stopped/);
  assert.match(restart.outText(), /hub started \(pid \d+/);
  const secondPid = (await readPidRecord(root))!.pid;
  assert.notEqual(secondPid, firstPid);
  t.after(() => cleanupPid(secondPid));
  await waitUntilDead(firstPid);
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  const stop = ioWith(root);
  assert.equal(await cmdStop({ root, io: stop.io, core }, {}), 0);
  assert.match(stop.outText(), /hub pid \d+ stopped/);
  await waitUntilDead(secondPid);
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
