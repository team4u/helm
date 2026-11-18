/**
 * Supervised `run` lifecycle tests (in-process against the port fake, plus one real-process E2E):
 *
 * - initial install + start when nothing is committed, periodic dist-tag checks, and graceful
 *   shutdown that stops the hub the launcher itself spawned (pid record cleaned, exit 0);
 * - a flipped registry latest restarts the hub onto the new version across ticks;
 * - a failing check or a bad candidate keeps the previous hub serving (rollback + blocked
 *   cooldown are surfaced as tick errors, never as launcher exits);
 * - an already-running hub is refused (ownership discipline: this launcher only supervises
 *   processes it spawned); an unexpected supervised-hub death ends the launcher with exit 1;
 * - the E2E spawns the real CLI (`main.ts run`) against a local HTTP registry serving nested
 *   `file:./dep.tgz` payloads, watches a real version switch, and verifies SIGINT shuts down the
 *   spawned hub (POSIX only — Windows cannot deliver test signals this way).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { readBlockedRelease, readCurrentRelease } from '@helm/update';
import { readPidRecord } from '../src/records.js';
import { startHub, stopHub } from '../src/process.js';
import { runSupervised } from '../src/run.js';
import { UsageError } from '../src/io.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  freePort,
  getJson,
  prepareNestedDepPayload,
  sriOf,
  waitUntilDead,
  writeFakePayload,
  type FakePayloadMode,
  type FakeUpdateCore,
} from './fixtures.js';

const PKG = '@fake/hub-payload';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface RunHarness {
  root: string;
  io: ReturnType<typeof captureIo>['io'];
  outText: () => string;
  errText: () => string;
  core: FakeUpdateCore;
  spec: { pkgName: string; latest: string; payloads: Map<string, string>; failLatest?: Error };
  port: number;
  dataDir: string;
  addPayload(version: string, mode?: FakePayloadMode): Promise<void>;
  options(extra?: Record<string, unknown>): Parameters<typeof runSupervised>[0];
}

function newShutdown(): { promise: Promise<void>; request: () => void } {
  let request!: () => void;
  const promise = new Promise<void>((resolve) => {
    request = () => resolve(undefined);
  });
  return { promise, request };
}

async function setupRun(t: import('node:test').TestContext, root: string, latest = '1.0.0'): Promise<RunHarness> {
  const spec = { pkgName: PKG, latest, payloads: new Map<string, string>() };
  const core = createFakeCore(spec);
  const captured = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));
  const port = await freePort();
  const harness: RunHarness = {
    root,
    io: captured.io,
    outText: captured.outText,
    errText: captured.errText,
    core,
    spec,
    port,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    addPayload: async (version, mode) => {
      const dir = await writeFakePayload({
        dir: path.join(root, `payload-${version}`),
        pkgName: PKG,
        version,
        ...(mode !== undefined ? { mode } : {}),
      });
      spec.payloads.set(version, dir);
    },
    options: (extra = {}) => ({
      io: captured.io,
      root,
      pkgName: PKG,
      registryUrl: 'https://registry.example.com',
      intervalMs: 250,
      pollMs: 50,
      launchFlags: { port, dataDir: harness.dataDir },
      core,
      ...extra,
    }),
  };
  return harness;
}

/** Poll until `probe` returns true (bounded); shared for post-race deterministic waits. */
async function waitForCondition(probe: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) throw new Error(`${label} did not happen within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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

async function waitForVersion(port: number, version: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = (await getJson(port, '/__version', 1_000)) as { version: string };
      if (body.version === version) return;
    } catch {
      // between restarts; keep polling
    }
    if (Date.now() >= deadline) throw new Error(`hub did not serve version ${version} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('run installs, starts, keeps up to date, and shuts its own hub down cleanly', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-run-'));
  await h.addPayload('1.0.0');
  const shutdown = newShutdown();

  const done = runSupervised({ ...h.options(), shutdownSignal: shutdown.promise });
  t.after(() => shutdown.request());
  await waitForVersion(h.port, '1.0.0');
  const record = await waitForPidRecord(h.root);
  t.after(() => cleanupPid(record.pid));
  const hubPid = record.pid;

  // At least one up-to-date tick happens before shutdown.
  await new Promise((resolve) => setTimeout(resolve, 600));
  shutdown.request();
  assert.equal(await done, 0);

  await waitUntilDead(hubPid);
  assert.equal(await readPidRecord(h.root), null);
  assert.match(h.outText(), /installed \(none\) -> 1\.0\.0/);
  assert.match(h.outText(), /supervising: update checks every 250ms against tag "latest"/);
});

test('a flipped registry latest restarts the hub onto the new version across ticks', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-runflip-'));
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0');
  const shutdown = newShutdown();

  const done = runSupervised({ ...h.options(), shutdownSignal: shutdown.promise });
  t.after(() => shutdown.request());
  await waitForVersion(h.port, '1.0.0');
  const firstPid = (await waitForPidRecord(h.root)).pid;
  t.after(() => cleanupPid(firstPid));

  h.spec.latest = '1.1.0';
  await waitForVersion(h.port, '1.1.0');
  await waitForCondition(async () => /updated 1\.0\.0 -> 1\.1\.0; hub restarted/.test(h.outText()), 'update line printed');
  const secondRecord = await waitForPidRecord(h.root);
  t.after(() => cleanupPid(secondRecord.pid));
  assert.notEqual(secondRecord.pid, firstPid);
  await waitUntilDead(firstPid);
  assert.equal((await readCurrentRelease(h.root))?.version, '1.1.0');
  assert.match(h.outText(), /updated 1\.0\.0 -> 1\.1\.0; hub restarted/);

  shutdown.request();
  assert.equal(await done, 0);
  await waitUntilDead(secondRecord.pid);
  assert.equal(await readPidRecord(h.root), null);
});

test('a beta dist-tag switches versions while `latest` stays unchanged (and vice versa)', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-runbeta-');
  const spec = {
    pkgName: PKG,
    latest: '1.0.0',
    payloads: new Map<string, string>(),
    latestByTag: {} as Record<string, string>,
  };
  const core = createFakeCore(spec);
  const captured = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));
  const port = await freePort();
  const dataDir = path.join(path.dirname(root), `${path.basename(root)}-user-data`);
  await writeFakePayload({ dir: path.join(root, 'payload-1.0.0'), pkgName: PKG, version: '1.0.0' });
  spec.payloads.set('1.0.0', path.join(root, 'payload-1.0.0'));
  await writeFakePayload({ dir: path.join(root, 'payload-2.0.0-beta.1'), pkgName: PKG, version: '2.0.0-beta.1' });
  spec.payloads.set('2.0.0-beta.1', path.join(root, 'payload-2.0.0-beta.1'));

  // Default tag: the loop must stay idle while only the beta channel moves.
  const idleShutdown = newShutdown();
  const idle = runSupervised({
    io: captured.io,
    root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 250,
    pollMs: 50,
    launchFlags: { port, dataDir },
    core,
    shutdownSignal: idleShutdown.promise,
  });
  t.after(() => idleShutdown.request());
  await waitForVersion(port, '1.0.0');
  const firstRecord = await waitForPidRecord(root);
  t.after(() => cleanupPid(firstRecord.pid));
  spec.latestByTag['beta'] = '2.0.0-beta.1';
  await new Promise((resolve) => setTimeout(resolve, 900)); // several ticks, channel ignored
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });
  assert.doesNotMatch(captured.outText(), /updated/);
  idleShutdown.request();
  assert.equal(await idle, 0);
  await waitUntilDead(firstRecord.pid);

  // Same state, --tag beta: the periodic CHECK queries beta and the loop switches to it even
  // though `latest` is unchanged (the #116/#130 tag-propagation regression).
  const second = newShutdown();
  const beta = runSupervised({
    io: captured.io,
    root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    intervalMs: 250,
    pollMs: 50,
    tag: 'beta',
    launchFlags: { port, dataDir },
    core,
    shutdownSignal: second.promise,
  });
  await waitForVersion(port, '2.0.0-beta.1', 30_000);
  await waitForCondition(
    async () => /updated 1\.0\.0 -> 2\.0\.0-beta\.1; hub restarted/.test(captured.outText()),
    'beta update line printed',
  );
  const betaRecord = await waitForPidRecord(root);
  t.after(() => cleanupPid(betaRecord.pid));
  assert.equal((await readCurrentRelease(root))?.version, '2.0.0-beta.1');
  assert.ok(core.tagsSeen.includes('beta'));
  second.request();
  assert.equal(await beta, 0);
  await waitUntilDead(betaRecord.pid);
  assert.equal(await readPidRecord(root), null);
});

test('an external verified stop of the supervised hub ends the run with exit 1 (no fight)', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-runext-'));
  await h.addPayload('1.0.0');

  const done = runSupervised(h.options());
  await waitForVersion(h.port, '1.0.0');
  const record = await waitForPidRecord(h.root);

  // Cross-process `stop` with a valid start-time identity (Linux record) legitimately stops the
  // supervised hub; the launcher must not fight over the instance and exits with diagnostics.
  await stopHub(h.root, h.io);
  await waitUntilDead(record.pid);
  assert.equal(await done, 1);
  assert.match(h.errText(), /the supervised hub process exited unexpectedly/);
  assert.equal(await readPidRecord(h.root), null);
});

test('failing update checks keep the previous hub serving and the loop alive', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-runfail-'));
  await h.addPayload('1.0.0');
  const shutdown = newShutdown();

  const done = runSupervised({ ...h.options(), shutdownSignal: shutdown.promise });
  t.after(() => shutdown.request());
  await waitForVersion(h.port, '1.0.0');
  const record = await waitForPidRecord(h.root);
  t.after(() => cleanupPid(record.pid));

  h.spec.failLatest = new Error('registry unreachable (simulated)');
  await new Promise((resolve) => setTimeout(resolve, 900)); // several failed ticks
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });
  assert.match(h.errText(), /update cycle failed; keeping 1\.0\.0 running: registry unreachable \(simulated\)/);

  shutdown.request();
  assert.equal(await done, 0);
  await waitUntilDead(record.pid);
});

test('a bad candidate rolls back inside the run loop and keeps the old hub serving', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-runrb-'));
  await h.addPayload('1.0.0');
  await h.addPayload('1.1.0', 'never-ready');
  const shutdown = newShutdown();

  const done = runSupervised({ ...h.options(), healthTimeoutMs: 1_500, shutdownSignal: shutdown.promise });
  t.after(() => shutdown.request());
  await waitForVersion(h.port, '1.0.0');
  const firstPid = (await waitForPidRecord(h.root)).pid;
  t.after(() => cleanupPid(firstPid));

  h.spec.latest = '1.1.0';
  // The failed candidate rolls back deterministically: pointer restored, version blocked, and the
  // old hub serving again (the update cycle spans stop→commit→failed start→rollback→restart).
  await waitForCondition(
    async () => (await readCurrentRelease(h.root))?.version === '1.0.0' && (await readBlockedRelease(h.root))?.version === '1.1.0',
    'rollback to 1.0.0 with blocked 1.1.0',
    30_000,
  );
  await waitForCondition(
    async () => {
      try {
        return ((await getJson(h.port, '/__version', 1_000)) as { version: string }).version === '1.0.0';
      } catch {
        return false;
      }
    },
    'old hub serving again after rollback',
    20_000,
  );
  const blocked = await readBlockedRelease(h.root);
  assert.equal(blocked?.version, '1.1.0');
  assert.match(h.errText(), /update cycle failed; keeping 1\.0\.0 running: candidate 1\.1\.0 failed to become ready/);
  assert.match(h.errText(), /rolled back to 1\.0\.0/);
  // Subsequent ticks hit the blocked cooldown and stay alive (logged, not fatal).
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.match(h.errText(), /update_blocked_cooldown|update cycle failed/);
  assert.deepEqual(await getJson(h.port, '/__version'), { version: '1.0.0' });

  shutdown.request();
  assert.equal(await done, 0);
  const finalRecord = await readPidRecord(h.root);
  assert.ok(finalRecord === null);
});

test('run refuses to adopt a hub it did not start', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-runadopt-'));
  await h.addPayload('1.0.0');
  const { performHubUpdate } = await import('../src/update.js');
  await performHubUpdate({
    io: h.io,
    core: h.core,
    root: h.root,
    pkgName: PKG,
    registryUrl: 'https://registry.example.com',
    targetVersion: '1.0.0',
    launchFlags: { port: h.port, dataDir: h.dataDir },
  });
  const started = await startHub(h.root, h.io, { flags: { port: h.port, dataDir: h.dataDir }, pollMs: 50 });
  t.after(() => cleanupPid(started.pid));

  await assert.rejects(
    runSupervised(h.options()),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, 'run_refuses_existing_hub');
      assert.match(error.message, /a hub is already running \(pid \d+[^)]*\) that this launcher did not start/);
      return true;
    },
  );
  await stopHub(h.root, h.io);
  await waitUntilDead(started.pid);
});

test('an unexpected supervised-hub death ends the launcher with exit 1 and the log pointer', { timeout: 60_000 }, async (t) => {
  const h = await setupRun(t, useTempDir(t, 'helm-launcher-rundie-'));
  await h.addPayload('1.0.0');

  const done = runSupervised(h.options());
  await waitForVersion(h.port, '1.0.0');
  const record = await waitForPidRecord(h.root);

  process.kill(record.pid, 'SIGKILL');
  assert.equal(await done, 1);
  assert.match(h.errText(), /the supervised hub process exited unexpectedly/);
  assert.match(h.errText(), /logs[/\\]hub\.log/);
});

/**
 * Real-process E2E: the actual CLI supervises a real hub against a local HTTP registry serving
 * nested `file:./dep.tgz` payloads (real npm staging both times), a real mid-run version switch,
 * and a SIGINT that must shut down the hub the launcher spawned.
 */
test('e2e: real CLI run against a local HTTP registry switches versions and stops on SIGINT', {
  timeout: 180_000,
  skip: process.platform === 'win32'
    ? 'signal-mediated shutdown semantics are POSIX (Windows cannot deliver test signals to the spawned CLI)'
    : false,
}, async (t) => {
  const root = useTempDir(t, 'helm-launcher-rune2e-');
  const dataDir = path.join(path.dirname(root), `${path.basename(root)}-user-data`);
  const hubPort = await freePort();
  const registryPort = await freePort();

  const v1Tarball = await prepareNestedDepPayload(root, '1.0.0', PKG);
  const v2Tarball = await prepareNestedDepPayload(root, '1.1.0', PKG);
  const served = new Map<string, { file: string; integrity: string }>([
    ['1.0.0', { file: v1Tarball, integrity: await sriOf(v1Tarball) }],
  ]);
  let latest = '1.0.0';

  const registry: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const tarballMatch = /\/tarball\/([^/]+)$/.exec(url);
    if (tarballMatch !== null) {
      const entry = served.get(decodeURIComponent(tarballMatch[1]!));
      if (entry === undefined) {
        res.writeHead(404);
        res.end('no such tarball');
        return;
      }
      fsp.readFile(entry.file).then(
        (bytes) => {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(bytes);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
      return;
    }
    const versionMatch = new RegExp(`^/${PKG}/([^/]+)$`).exec(url);
    if (versionMatch === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const requested = decodeURIComponent(versionMatch[1]!);
    if (requested === 'latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: PKG, version: latest }));
      return;
    }
    const entry = served.get(requested);
    if (entry === undefined) {
      res.writeHead(404);
      res.end('version not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: PKG,
        version: requested,
        dist: {
          integrity: entry.integrity,
          tarball: `http://127.0.0.1:${registryPort}/tarball/${encodeURIComponent(requested)}`,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => registry.listen(registryPort, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));

  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entryFile = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts');
  let stdout = '';
  let stderr = '';
  const child: ChildProcess = spawn(
    process.execPath,
    [
      tsxCli,
      entryFile,
      'update',
      '--watch',
      '--interval-ms',
      '500',
      '--registry',
      `http://127.0.0.1:${registryPort}`,
      '--port',
      String(hubPort),
      '--data-dir',
      dataDir,
      '--health-timeout',
      '30000',
    ],
    {
      env: sanitizedHostEnv({ HELM_HUB_INSTALL_ROOT: root, HELM_PAYLOAD_PACKAGE: PKG }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  const dump = (): string => `launcher stdout:\n${stdout}\nlauncher stderr:\n${stderr}`;

  let hubPid: number | undefined;
  try {
    await waitForVersion(hubPort, '1.0.0', 60_000);
    hubPid = (await waitForPidRecord(root, 10_000)).pid;
    await waitForCondition(async () => /installed \(none\) -> 1\.0\.0; hub started/.test(stdout), 'install line printed', 10_000);

    // Real mid-run switch: stage 1.1.0 (nested dep again) and restart across a tick.
    served.set('1.1.0', { file: v2Tarball, integrity: await sriOf(v2Tarball) });
    latest = '1.1.0';
    await waitForVersion(hubPort, '1.1.0', 60_000);
    await waitForCondition(async () => /updated 1\.0\.0 -> 1\.1\.0; hub restarted/.test(stdout), 'updated line printed', 10_000);
    const switched = (await waitForPidRecord(root, 10_000)).pid;
    assert.ok(switched !== hubPid, dump());
    t.after(() => cleanupPid(switched));

    // SIGINT must stop the hub this launcher spawned and exit 0.
    child.kill('SIGINT');
    assert.equal(await exit, 0, dump());
    await waitForCondition(async () => /launcher stopping: received SIGINT/.test(stderr), 'stopping line printed', 10_000);
    await waitUntilDead(switched);
    assert.equal(await readPidRecord(root), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (hubPid !== undefined) cleanupPid(hubPid);
    const leftover = await readPidRecord(root);
    if (leftover !== null) cleanupPid(leftover.pid);
  }
});
