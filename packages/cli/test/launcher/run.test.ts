/**
 * Foreground attach tests (`helmx start`, no -d): bootstrap-install on first use, attach with
 * log streaming, signal-driven shutdown through the held child handle (platform-independent
 * ownership proof), refusal to adopt foreign hubs, and honest exit-1 on unexpected hub death.
 * The update loop no longer exists here — proactive updates are covered by update-flow tests.
 */
import assert from 'node:assert/strict';
import { appendFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helmx/test-kit/node';
import { writeCurrentRelease } from '@helmx/env-io';
import { readPidRecord } from '../../src/launcher/records.js';
import { runHubForeground } from '../../src/launcher/run.js';
import { UsageError } from '../../src/launcher/io.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  freePort,
  getJson,
  spawnAlienProcess,
  waitUntilDead,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

interface AttachHarness {
  root: string;
  io: ReturnType<typeof captureIo>['io'];
  outText: () => string;
  errText: () => string;
  core: ReturnType<typeof createFakeCore>;
  spec: { pkgName: string; latest: string; payloads: Map<string, string> };
  port: number;
  dataDir: string;
  addPayload(version: string): Promise<void>;
  options(extra?: Record<string, unknown>): Parameters<typeof runHubForeground>[0];
}

function newShutdown(): { promise: Promise<void>; request: () => void } {
  let request!: () => void;
  const promise = new Promise<void>((resolve) => {
    request = () => resolve(undefined);
  });
  return { promise, request };
}

async function setupAttach(t: import('node:test').TestContext, root: string, latest = '1.0.0'): Promise<AttachHarness> {
  const spec = { pkgName: PKG, latest, payloads: new Map<string, string>() };
  const core = createFakeCore(spec);
  const captured = captureIo(sanitizedHostEnv({ HELMX_PAYLOAD_PACKAGE: PKG }));
  const port = await freePort();
  const harness: AttachHarness = {
    root,
    io: captured.io,
    outText: captured.outText,
    errText: captured.errText,
    core,
    spec,
    port,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    addPayload: async (version) => {
      const dir = await writeFakePayload({
        dir: path.join(root, `payload-${version}`),
        pkgName: PKG,
        version,
      });
      spec.payloads.set(version, dir);
    },
    options: (extra = {}) => ({
      io: captured.io,
      root,
      pkgName: PKG,
      registryUrl: 'https://registry.example.com',
      launchFlags: { port, dataDir: harness.dataDir },
      core,
      ...extra,
    }),
  };
  return harness;
}

/** Poll until the captured stdout contains `needle` (output lines land after internal records). */
async function waitForText(outText: () => string, needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (outText().includes(needle)) return;
    if (Date.now() >= deadline) throw new Error(`output never contained "${needle}"; got: ${outText()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Poll until the pid record lands (readiness precedes the record write by a few ms). */
async function waitForPidRecord(root: string, timeoutMs = 10_000): Promise<NonNullable<Awaited<ReturnType<typeof readPidRecord>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readPidRecord(root);
    if (record !== null) return record;
    if (Date.now() >= deadline) throw new Error(`hub pid record did not appear within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('attach installs on first use, streams the banner, and stops cleanly on shutdown signal', { timeout: 60_000 }, async (t) => {
  const h = await setupAttach(t, useTempDir(t, 'helmx-attach-install-'));
  await h.addPayload('1.0.0');
  const shutdown = newShutdown();
  const done = runHubForeground({ ...h.options(), shutdownSignal: shutdown.promise });

  const record = await waitForPidRecord(h.root);
  t.after(() => cleanupPid(record.pid));
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  assert.match(h.outText(), /no release installed under/);
  await waitForText(h.outText, `hub 1.0.0 running: pid ${record.pid}`);

  shutdown.request();
  assert.equal(await done, 0);
  assert.match(h.errText(), /launcher stopping.*: hub pid \d+ stopped/);
  await waitUntilDead(record.pid);
  assert.equal(await readPidRecord(h.root), null, 'pid record is cleaned after the held-handle stop');
});

test('attach streams log lines appended after readiness', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-attach-stream-');
  const payloadDir = await writeFakePayload({ dir: path.join(root, 'fixture-payload'), pkgName: PKG, version: '2.0.0' });
  const releaseDir = path.join(root, 'releases', '2.0.0', 'fixture');
  const entryPath = path.join(releaseDir, 'node_modules', ...PKG.split('/'), 'start.mjs');
  await cp(payloadDir, path.dirname(entryPath), { recursive: true });
  await writeCurrentRelease(root, { version: '2.0.0', updatedAt: new Date().toISOString(), entries: { entryPath } });

  const spec = { pkgName: PKG, latest: '2.0.0', payloads: new Map<string, string>() };
  const captured = captureIo(sanitizedHostEnv({ HELMX_PAYLOAD_PACKAGE: PKG }));
  const port = await freePort();
  const shutdown = newShutdown();
  const done = runHubForeground({
    io: captured.io,
    root,
    pkgName: PKG,
    launchFlags: { port, dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`) },
    core: createFakeCore(spec),
    shutdownSignal: shutdown.promise,
  });

  const record = await waitForPidRecord(root);
  t.after(() => cleanupPid(record.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '2.0.0' });

  // Appended hub log output reaches the operator's terminal through the attach loop.
  const logPath = path.join(root, 'logs', 'hub.log');
  await appendFile(logPath, 'TRACEME-ATTACH-MARKER\n');
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (captured.outText().includes('TRACEME-ATTACH-MARKER')) break;
    if (Date.now() >= deadline) throw new Error('appended log line was never streamed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  shutdown.request();
  assert.equal(await done, 0);
  await waitUntilDead(record.pid);
});

test('attach refuses to adopt a hub it did not start', { timeout: 60_000 }, async (t) => {
  const h = await setupAttach(t, useTempDir(t, 'helmx-attach-refuse-'));
  await h.addPayload('1.0.0');
  const alienPid = spawnAlienProcess();
  t.after(() => cleanupPid(alienPid));
  // A live pid record pointing at a foreign process is the adoption attempt.
  const { writePidRecord } = await import('../../src/launcher/records.js');
  await writePidRecord(h.root, {
    pid: alienPid,
    version: '0.9.0',
    entryPath: '/nowhere/start.mjs',
    port: h.port,
    startedAt: new Date().toISOString(),
  });
  await assert.rejects(runHubForeground(h.options()), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, 'run_refuses_existing_hub');
    return true;
  });
});

test('an unexpected hub death ends the attach with exit 1 and the log pointer', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-attach-death-');
  const payloadDir = await writeFakePayload({ dir: path.join(root, 'fixture-payload'), pkgName: PKG, version: '1.0.0' });
  const releaseDir = path.join(root, 'releases', '1.0.0', 'fixture');
  const entryPath = path.join(releaseDir, 'node_modules', ...PKG.split('/'), 'start.mjs');
  await cp(payloadDir, path.dirname(entryPath), { recursive: true });
  await writeCurrentRelease(root, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath } });

  const captured = captureIo(sanitizedHostEnv({ HELMX_PAYLOAD_PACKAGE: PKG }));
  const port = await freePort();
  const done = runHubForeground({
    io: captured.io,
    root,
    pkgName: PKG,
    launchFlags: { port, dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`) },
    core: createFakeCore({ pkgName: PKG, latest: '1.0.0', payloads: new Map() }),
  });

  const record = await waitForPidRecord(root);
  t.after(() => cleanupPid(record.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  cleanupPid(record.pid); // kill the wrapper: the hub dies under the attach
  assert.equal(await done, 1);
  assert.match(captured.errText(), /the hub process exited \(pid \d+\)/);
  assert.match(captured.errText(), /hub\.log/);
});
