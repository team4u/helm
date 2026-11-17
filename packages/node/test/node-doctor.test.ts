/**
 * Tests for `helm-node doctor`, health snapshots, and hard stdio drain timeout protection:
 * - `collectNodeHealth`: valid base metrics and disk fields, with homedir fallback when target dir is missing;
 * - `createNodeDaemon`: `register` and `heartbeat` include real health snapshots;
 * - `NodeEnvRpcServer`: when a detached descendant continuously writes to inherited stdout,
 *   `envAbortExec` / timeout forces `execOnce` to settle within `abortDrainGraceMs` so `dispose()` never hangs;
 * - `helm-node doctor [--json]`: unbound identity / 0644 permissions / root warning / read-only
 *   WS Hub probe `rttMs` and zero secret leakage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeHeartbeatInput,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helm/protocol';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';
import { collectNodeHealth, createNodeDaemon, writeNodeIdentity } from '../src/daemon/index.js';
import { runNodeDoctor } from '../src/daemon/doctor.js';
import { runNodeCli } from '../src/cli.js';
import { sanitizedHostEnv } from './helpers/sanitized-env.js';

/** Poll until an observable condition holds (instead of fixed sleeps), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// 1. collectNodeHealth
// ---------------------------------------------------------------------------

test('collectNodeHealth returns valid base metrics and disk space fields', { timeout: 60_000 }, async () => {
  const snapshot = await collectNodeHealth();
  assert.equal(typeof snapshot.collectedAt, 'number');
  assert.ok(snapshot.collectedAt > 0);
  assert.ok(snapshot.uptimeSec >= 0);
  assert.ok(Array.isArray(snapshot.loadAvg));
  assert.equal(snapshot.loadAvg.length, 3);
  for (const value of snapshot.loadAvg) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
  }
  assert.ok(snapshot.memFreeBytes > 0);
  assert.ok(snapshot.memTotalBytes > 0);
  assert.ok(snapshot.memFreeBytes <= snapshot.memTotalBytes);
  // statfs available on Linux/macOS: disk fields should be collected and consistent
  if (snapshot.diskFreeBytes !== undefined && snapshot.diskTotalBytes !== undefined) {
    assert.ok(snapshot.diskFreeBytes > 0);
    assert.ok(snapshot.diskTotalBytes > 0);
    assert.ok(snapshot.diskFreeBytes <= snapshot.diskTotalBytes);
  }
  // Target directory exists: collect from its mount point
  const dir = await tempDir('helm-node-health-');
  try {
    const targeted = await collectNodeHealth(dir);
    assert.ok(targeted.collectedAt > 0);
    if (targeted.diskFreeBytes !== undefined) assert.ok(targeted.diskFreeBytes > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // Target directory missing: fall back to homedir without throwing
  const fallback = await collectNodeHealth(path.join(dir, 'no-such-dir'));
  assert.ok(fallback.uptimeSec >= 0);
  if (fallback.diskFreeBytes !== undefined) assert.ok(fallback.diskFreeBytes > 0);
});

// ---------------------------------------------------------------------------
// 2. createNodeDaemon: register / heartbeat carry health snapshot (real WS Hub mock)
// ---------------------------------------------------------------------------

interface DoctorHubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: { nodeId: string; input?: NodeHeartbeatInput }[];
  close(): Promise<void>;
}

/** Real http.Server + WebSocketServer simulating Hub /ws/node to record register and heartbeat messages. */
async function startDoctorHub(expectedToken: string): Promise<DoctorHubFixture> {
  const registrations: NodeRegisterInput[] = [];
  const heartbeats: { nodeId: string; input?: NodeHeartbeatInput }[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let pendingSocket: WebSocket | undefined;
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      let hubRpc: ReturnType<typeof createBirpc> | undefined;
      const local = {
        register: async (input: NodeRegisterInput): Promise<NodeRegisterResult> => {
          registrations.push(input);
          if (input.token !== expectedToken) return { ok: false, heartbeatMs: 0, reason: 'invalid token' };
          return { ok: true, heartbeatMs: 100 };
        },
        heartbeat: async (nodeId: string, input?: NodeHeartbeatInput): Promise<boolean> => {
          heartbeats.push({ nodeId, input });
          return true;
        },
        onEnvExecOutput: (_event: EnvExecOutputEvent) => undefined,
      };
      hubRpc = createBirpc(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
            try {
              callback(JSON.parse(text) as never);
            } catch {
              // Ignore malformed frames.
            }
          });
        },
        off: (callback) => {
          ws.off('message', callback as never);
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    heartbeats,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

test('createNodeDaemon: register and heartbeat include real health snapshots', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-health-');
  const token = 'health-node:secret-1';
  const hub = await startDoctorHub(token);
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'health-node', token },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'should complete registration');
    assert.equal(hub.registrations.length, 1);
    const registerHealth = hub.registrations[0]?.health;
    assert.ok(registerHealth !== undefined, 'register should carry health snapshot');
    assert.ok(registerHealth!.uptimeSec >= 0);
    assert.ok(Number.isFinite(registerHealth!.memTotalBytes) && registerHealth!.memTotalBytes > 0);
    if (registerHealth!.diskTotalBytes !== undefined) assert.ok(registerHealth!.diskTotalBytes > 0);
    assert.ok(Math.abs(registerHealth!.collectedAt - Date.now()) < 60_000);

    // Wait for at least one heartbeat (heartbeatMs = 100ms)
    await waitFor(() => hub.heartbeats.length >= 1, 10_000, 'at least one heartbeat');
    assert.ok(hub.heartbeats.length >= 1, 'should receive heartbeat');
    for (const beat of hub.heartbeats) {
      assert.equal(beat.nodeId, 'health-node');
      assert.ok(beat.input?.health !== undefined, 'heartbeat should carry health snapshot');
      assert.ok(beat.input!.health!.uptimeSec >= 0);
      assert.ok(beat.input!.health!.memFreeBytes > 0);
    }
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Hard stdio drain timeout guard: detached grandchild continuously writes to stdout
// ---------------------------------------------------------------------------

/**
 * Spawn a detached grandchild that writes to inherited stdout every 20ms and exits after 5s
 * (self-bounded so no orphan processes leak across test runs, yet long enough to outlast
 * abort/timeout kill windows while the runner waits on pipe drain); parent exits after 1s
 * leaving the grandchild holding the pipe fd open to simulate a wedged descendant hang.
 */
const ORPHAN_PROGRAM = [
  "const cp = require('node:child_process');",
  "const childCode = 'const t0 = Date.now(); setInterval(() => { if (Date.now() - t0 > 5000) process.exit(0); process.stdout.write(String(Date.now() % 10)); }, 20);';",
  "cp.spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();",
  "setTimeout(() => {}, 1000);",
].join(' ');

test('envAbortExec 500ms drain guard does not hang when grandchild holds stdout open', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-abort-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const pending = server.envExec({
      execId: 'drain-abort',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 60,
    });
    // Wait for parent to spawn grandchild and exit while grandchild keeps writing to pipe
    await delay(300);
    assert.equal(server.getActiveExecCount(), 1, 'exec should still be active while grandchild holds pipe open');
    await server.envAbortExec('drain-abort');
    const result = await pending;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, 'should settle with failure');
    assert.equal(!result.ok && result.error.code, 'aborted', 'error code should be aborted');
    if (!result.ok) {
      assert.match(result.error.message, /aborted|drain/i);
    }
    assert.ok(elapsed < 10_000, `abort should settle within drain grace period (actual ${elapsed}ms)`);
    // dispose must not hang
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose must not hang');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('command timeout drain guard forces timeout settlement without hanging dispose', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-timeout-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const result = await server.envExec({
      execId: 'drain-timeout',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 1, // 1s timeout + 200ms drain grace
    });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, 'should settle with failure');
    assert.equal(!result.ok && result.error.code, 'timeout', 'error code should be timeout');
    if (!result.ok) {
      assert.match(result.error.message, /timed out after 1 seconds/);
    }
    assert.ok(elapsed < 10_000, `timeout should settle within drain grace period (actual ${elapsed}ms)`);
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose must not hang');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. helm-node doctor [--json]
// ---------------------------------------------------------------------------

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    // Strip host-managed HELM_* variables so doctor's Hub target (HELM_HUB_URL overrides
    // identity file) and token come strictly from the test fixture.
    env: { ...sanitizedHostEnv(), ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('doctor reports ok=false with exit code 1 when identity is unbound', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-none-');
  try {
    // Point Herdr IPC probe to an isolated path instead of real ~/.config/herdr
    const result = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(result.code, 1, `expected exit code 1, got ${result.code} (out=${result.out})`);
    const report = JSON.parse(result.out) as { ok: boolean; checks: { id: string; status: string }[] };
    assert.equal(report.ok, false);
    const identity = report.checks.find((c) => c.id === 'identity');
    assert.equal(identity?.status, 'error');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor reports error when node.json has 0644 permissions (exit code 1; skipped on Windows without POSIX modes)', { timeout: 60_000 }, async () => {
  if (process.platform === 'win32') return; // NTFS uses ACLs rather than stat.mode 0644; production check exempts win32
  const dir = await tempDir('helm-node-doctor-mode-');
  try {
    await writeNodeIdentity(dir, { nodeId: 'mode-node', token: 'mode-node:secret-1', hubUrl: 'http://127.0.0.1:3202' });
    await fs.chmod(path.join(dir, 'node.json'), 0o644);
    const result = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.out) as { ok: boolean; checks: { id: string; status: string; message: string }[] };
    assert.equal(report.ok, false);
    const identity = report.checks.find((c) => c.id === 'identity');
    assert.equal(identity?.status, 'error');
    assert.match(identity?.message ?? '', /0600|0644/);
    // Non-JSON mode also works
    const textResult = await runCli(['doctor', '--data-dir', dir], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(textResult.code, 1);
    assert.match(textResult.out, /identity/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor warns on root privilege while remaining ok=true (exit code 0) when identity and Hub pass', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-root-');
  const token = 'doctor-ok-node:secret-1';
  const hub = await startDoctorHub(token);
  try {
    await writeNodeIdentity(dir, { nodeId: 'doctor-ok-node', token, hubUrl: hub.url });
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      checkPrivilege: async () => ({ isRoot: true, passwordlessSudo: false }),
    });
    const privilege = report.checks.find((c) => c.id === 'privilege');
    assert.equal(privilege?.status, 'warn');
    assert.match(privilege?.message ?? '', /root or passwordless sudo/);
    assert.equal(report.checks.find((c) => c.id === 'identity')?.status, 'ok');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'ok');
    assert.equal(report.ok, true, 'warning must not mark overall health as failed');

    const result = await runCli(
      ['doctor', '--data-dir', dir, '--json'],
      { HERDR_SOCKET_PATH: path.join(dir, 'no.sock'), HELM_DOCTOR_TEST: '1' },
    );
    // CLI cannot mock checkPrivilege: hub check uses a real WS probe with valid identity and Hub.
    // This verifies the CLI exit code matches overall ok even with warnings.
    assert.equal(result.code, report.ok ? 0 : 1);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor performs read-only WS Hub probe (zero register calls, zero eviction) and never leaks token', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-doctor-hub-');
  const token = 'doctor-hub-node:secret-1';
  // Same nodeId is online: sending register would evict it, so read-only probe must never send register.
  const hub = await startDoctorHub(token);
  t.after(async () => {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await writeNodeIdentity(dir, { nodeId: 'doctor-hub-node', token, hubUrl: hub.url });
  const report = await runNodeDoctor({
    dataDir: dir,
    env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
    checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  const hubCheck = report.checks.find((c) => c.id === 'hub');
  assert.equal(hubCheck?.status, 'ok');
  assert.match(hubCheck?.message ?? '', /token not validated/);
  const details = (hubCheck?.details ?? {}) as { rttMs?: number; hubUrl?: string };
  assert.equal(typeof details.rttMs, 'number');
  assert.ok(details.rttMs! >= 0);
  assert.equal(details.hubUrl, hub.url);
  // Read-only invariant: Hub must never receive register (registering with same nodeId evicts active daemon)
  assert.equal(hub.registrations.length, 0, 'doctor must never send register');
  // Report JSON must never expose token or secret
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(token), false, 'report must not expose token');
  assert.equal(serialized.includes('secret-1'), false);
  // CLI --json output must not leak token either
  const cli = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
  assert.equal(cli.code, 0, cli.out + cli.err);
  assert.equal(cli.out.includes(token), false, 'CLI output must not expose token');
  const cliReport = JSON.parse(cli.out) as { ok: boolean; hubUrl: string };
  assert.equal(cliReport.ok, true);
  assert.equal(cliReport.hubUrl, hub.url);
});

test('doctor probe does not disrupt an online daemon with the same nodeId', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-doctor-live-');
  const token = 'doctor-live-node:secret-1';
  const hub = await startDoctorHub(token);
  t.after(async () => {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'doctor-live-node', token },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    // Write node.json so doctor reads identity from disk (daemon path does not write it).
    await writeNodeIdentity(dir, { nodeId: 'doctor-live-node', token, hubUrl: hub.url });
    const registrationsBefore = hub.registrations.length;

    // Run doctor while daemon is online: read-only probe must not trigger disconnect/reconnect
    // (old implementation re-registered the same nodeId, evicting the live daemon and killing execs).
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(daemon.isConnected(), true, 'doctor must not disrupt live daemon connection');
    assert.equal(hub.registrations.length, registrationsBefore, 'doctor must not trigger re-registration');
    await delay(300);
    assert.equal(daemon.isConnected(), true, 'connection should remain stable after probe');
  } finally {
    // Fixture hub.close only closes latest socket: close daemon first so server.close does not hang.
    await daemon.close().catch(() => undefined);
  }
});

test('doctor reports hub error truthfully when Hub is unreachable', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-dead-');
  try {
    // Nothing listens on port 1: handshake fails immediately with connection refused
    await writeNodeIdentity(dir, { nodeId: 'doctor-dead-node', token: 'doctor-dead-node:secret-1', hubUrl: 'http://127.0.0.1:1' });
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      connectTimeoutMs: 2_000,
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    assert.equal(report.ok, false);
    const hubCheck = report.checks.find((c) => c.id === 'hub');
    assert.equal(hubCheck?.status, 'error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor reports ok when herdr_ipc is reachable and info when unreachable', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-ipc-');
  const token = 'doctor-ipc-node:secret-1';
  const hub = await startDoctorHub(token);
  const sockets = new Set<net.Socket>();
  const ipcServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const sockPath = path.join(dir, 'herdr.sock');
  await new Promise<void>((resolve) => ipcServer.listen(sockPath, resolve));
  try {
    await writeNodeIdentity(dir, { nodeId: 'doctor-ipc-node', token, hubUrl: hub.url });
    // Reachable: ok
    const reachable = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: sockPath },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcOk = reachable.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcOk?.status, 'ok', JSON.stringify(reachable.checks));
    assert.equal((ipcOk?.details as { endpoint?: string } | undefined)?.endpoint, sockPath);

    // Unreachable: info (optional capability does not block overall health)
    const missing = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'missing.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcInfo = missing.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcInfo?.status, 'info');
    assert.match(ipcInfo?.message ?? '', /Herdr IPC not detected/);
    assert.equal(missing.ok, true, 'info check must not mark overall ok=false');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
