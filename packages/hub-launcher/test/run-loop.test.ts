/**
 * Scheduled auto-update loop tests (the `run` command core): bootstrap (install when absent,
 * start or adopt the running hub), periodic dist-tag checks that upgrade a live Hub across a
 * version bump (real detached processes, graceful stop → commit → banner-gated start),
 * resilience (registry outage keeps the running Hub serving and retries), and the graceful
 * shutdown path (abort → identity-verified stop of the owned hub).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { readCurrentRelease } from '@helm/update';
import { readPidRecord } from '../src/records.js';
import { readRunningHub, startHub } from '../src/process.js';
import { performHubUpdate } from '../src/update.js';
import { runLauncherLoop, type RunLoopEvent } from '../src/run.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  freePort,
  getJson,
  waitUntilDead,
  writeFakePayload,
  type FakeUpdateCore,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

interface LoopHarness {
  root: string;
  io: ReturnType<typeof captureIo>['io'];
  core: FakeUpdateCore;
  payloads: Map<string, string>;
}

async function setupLoop(t: import('node:test').TestContext, root: string, latest: string): Promise<LoopHarness> {
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest, payloads });
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));
  return { root, io, core, payloads };
}

async function addPayload(h: LoopHarness, version: string): Promise<void> {
  const dir = await writeFakePayload({ dir: path.join(h.root, `payload-${version}`), pkgName: PKG, version });
  h.payloads.set(version, dir);
}

/** Poll until `predicate` holds over the collected events (or fail after the budget). */
async function waitForEvent<T>(
  events: RunLoopEvent[],
  predicate: (event: RunLoopEvent) => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const event of events) {
      const hit = predicate(event);
      if (hit !== undefined) return hit;
    }
    if (Date.now() >= deadline) throw new Error(`expected loop event not observed within ${timeoutMs}ms (saw: ${events.map((e) => e.type).join(', ') || 'nothing'})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('run loop bootstraps, auto-updates across a dist-tag bump, and stops the owned hub on abort', { timeout: 60_000 }, async (t) => {
  const h = await setupLoop(t, useTempDir(t, 'helm-launcher-run-'), '1.0.0');
  await addPayload(h, '1.0.0');
  await addPayload(h, '1.1.0');
  const port = await freePort();
  const events: RunLoopEvent[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort()); // never leave the loop pending on an assertion failure

  const loop = runLauncherLoop({
    io: h.io,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 300,
    launchFlags: { port },
    core: h.core,
    pollMs: 100,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'no-update') {
        // Advance the channel after the first settled cycle: the next one must upgrade the hub.
        h.core.setLatest('1.1.0');
      }
    },
  });

  const started = await waitForEvent(events, (event) => (event.type === 'started' ? event : undefined));
  t.after(() => cleanupPid(started.pid));
  const updated = await waitForEvent(events, (event) => (event.type === 'updated' ? event : undefined));
  t.after(() => cleanupPid(updated.pid));

  // While the loop is still supervising: the new release is committed and genuinely serving.
  assert.equal((await readCurrentRelease(h.root))?.version, '1.1.0');
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' });
  await waitUntilDead(started.pid); // the 1.0.0 process was replaced
  assert.equal(updated.pid > 0, true);

  controller.abort();
  const summary = await loop;
  assert.equal(summary.updates, 1);
  assert.ok(summary.cycles >= 2);
  assert.equal(summary.stoppedHub, true);
  assert.equal(summary.lastError, undefined);
  await waitUntilDead(updated.pid);
  assert.equal(await readPidRecord(h.root), null); // graceful shutdown cleaned the record
  assert.deepEqual(
    events.filter((event) => event.type === 'installed' || event.type === 'stopped').map((event) => event.type),
    ['installed', 'stopped'],
  );
});

test('run loop adopts an already-running hub instead of double-starting it', { timeout: 60_000 }, async (t) => {
  const h = await setupLoop(t, useTempDir(t, 'helm-launcher-run-'), '1.0.0');
  await addPayload(h, '1.0.0');
  const port = await freePort();
  const events: RunLoopEvent[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort()); // never leave the loop pending on an assertion failure

  // Install and start outside the loop (the user's own `update` + `start`).
  await performHubUpdate({
    io: h.io,
    core: h.core,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    targetVersion: '1.0.0',
    launchFlags: { port },
  });
  const running = await startHub(h.root, h.io, { flags: { port }, pollMs: 100 });
  t.after(() => cleanupPid(running.pid));

  const summary = await runLauncherLoop({
    io: h.io,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 5_000,
    core: h.core,
    pollMs: 100,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'already-running' || event.type === 'no-update') {
        controller.abort();
      }
    },
  });

  const adopted = await waitForEvent(events, (event) => (event.type === 'already-running' ? event : undefined));
  assert.equal(adopted.pid, running.pid); // same process, not a second hub
  assert.equal(summary.updates, 0);
  assert.equal(summary.stoppedHub, true); // shutdown still owns the stop
  await waitUntilDead(running.pid);
  assert.equal(await readPidRecord(h.root), null);
});

test('registry outages keep the running hub serving; the loop retries and recovers', { timeout: 60_000 }, async (t) => {
  const h = await setupLoop(t, useTempDir(t, 'helm-launcher-run-'), '1.0.0');
  await addPayload(h, '1.0.0');
  await addPayload(h, '1.1.0');
  const port = await freePort();
  const events: RunLoopEvent[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort()); // never leave the loop pending on an assertion failure
  h.core.setFailLatest(new Error('simulated registry outage'));

  const loop = runLauncherLoop({
    io: h.io,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 300,
    launchFlags: { port },
    core: h.core,
    pollMs: 100,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'check-failed') {
        h.core.setFailLatest(undefined);
        h.core.setLatest('1.1.0');
      }
    },
  });

  // The bootstrap install and start both fail during the outage (nothing is installed yet);
  // the loop keeps retrying and recovers once the registry answers again.
  const bootstrapFailure = await waitForEvent(events, (event) => (event.type === 'update-failed' ? event : undefined));
  assert.match(bootstrapFailure.error, /simulated registry outage/);
  const startFailure = await waitForEvent(events, (event) => (event.type === 'start-failed' ? event : undefined));
  assert.match(startFailure.error, /no hub release installed/);
  const failure = await waitForEvent(events, (event) => (event.type === 'check-failed' ? event : undefined));
  assert.match(failure.error, /simulated registry outage/);
  const updated = await waitForEvent(events, (event) => (event.type === 'updated' ? event : undefined));
  t.after(() => cleanupPid(updated.pid));
  assert.equal((await readCurrentRelease(h.root))?.version, '1.1.0');
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' });

  controller.abort();
  const summary = await loop;
  assert.equal(summary.updates, 1);
  assert.equal(summary.stoppedHub, true);
  await waitUntilDead(updated.pid);
});

test('status of a run-managed hub is observable while the loop is idle between cycles', { timeout: 60_000 }, async (t) => {
  const h = await setupLoop(t, useTempDir(t, 'helm-launcher-run-'), '1.0.0');
  await addPayload(h, '1.0.0');
  const port = await freePort();
  const events: RunLoopEvent[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort()); // never leave the loop pending on an assertion failure

  const loopPromise = runLauncherLoop({
    io: h.io,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 30_000,
    launchFlags: { port },
    core: h.core,
    pollMs: 100,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  const started = await waitForEvent(events, (event) => (event.type === 'started' ? event : undefined));
  t.after(() => cleanupPid(started.pid));

  // Between cycles the ordinary read-only surface reports the run-managed hub.
  const running = await readRunningHub(h.root, h.io);
  assert.ok(running !== null);
  assert.equal(running.alive, true);
  assert.deepEqual(running.health, { configured: true, authenticated: false });

  controller.abort();
  const summary = await loopPromise;
  assert.equal(summary.stoppedHub, true);
  await waitUntilDead(started.pid);
});
