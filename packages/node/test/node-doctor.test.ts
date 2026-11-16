/**
 * helm-node doctor / health snapshot / stdio Drain hard timeout protect test:
 * - collectNodeHealth: basis metric and disk field legal; directory missing fall back homedir;
 * - createNodeDaemon:register and heartbeat real carry health snapshot;
 * - NodeEnvRpcServer:detached descendant process continuous to inherit stdout write when,
 *   envAbortExec / timeout after execOnce in abortDrainGraceMs inside force compute,
 *   dispose() do not hang die;
 * - helm-node doctor [--json]: not bind set identity / 0644 permission / root permission warn /
 *   real WS Hub mock under rttMs and secret without leaking.
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

/** polling wait for can observe condition into establish (alternative fixed sleep), timeout explicit failed. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out:${what}` });

// ---------------------------------------------------------------------------
// 1. collectNodeHealth
// ---------------------------------------------------------------------------

test('collectNodeHealth: return legal basis metric and disk empty between field', { timeout: 60_000 }, async () => {
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
  // statfs in Linux/macOS available: disk field should collect to and together
  if (snapshot.diskFreeBytes !== undefined && snapshot.diskTotalBytes !== undefined) {
    assert.ok(snapshot.diskFreeBytes > 0);
    assert.ok(snapshot.diskTotalBytes > 0);
    assert.ok(snapshot.diskFreeBytes <= snapshot.diskTotalBytes);
  }
  // designate directory store in: by the directory which in mount point collect
  const dir = await tempDir('helm-node-health-');
  try {
    const targeted = await collectNodeHealth(dir);
    assert.ok(targeted.collectedAt > 0);
    if (targeted.diskFreeBytes !== undefined) assert.ok(targeted.diskFreeBytes > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // directory missing: fall back homedir, never throw
  const fallback = await collectNodeHealth(path.join(dir, 'no-such-dir'));
  assert.ok(fallback.uptimeSec >= 0);
  if (fallback.diskFreeBytes !== undefined) assert.ok(fallback.diskFreeBytes > 0);
});

// ---------------------------------------------------------------------------
// 2. createNodeDaemon:register / heartbeat carry health snapshot (real WS Hub mock)
// ---------------------------------------------------------------------------

interface DoctorHubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: { nodeId: string; input?: NodeHeartbeatInput }[];
  close(): Promise<void>;
}

/** real http.Server + WebSocketServer simulated Hub /ws/node: record register/heartbeat. */
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
              // ignore illegal frame.
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

test('createNodeDaemon:register and heartbeat real carry health snapshot', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-health-');
  const token = 'health-node:secret-1';
  const hub = await startDoctorHub(token);
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'health-node', token },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'should complete register');
    assert.equal(hub.registrations.length, 1);
    const registerHealth = hub.registrations[0]?.health;
    assert.ok(registerHealth !== undefined, 'register should carry health snapshot');
    assert.ok(registerHealth!.uptimeSec >= 0);
    assert.ok(Number.isFinite(registerHealth!.memTotalBytes) && registerHealth!.memTotalBytes > 0);
    if (registerHealth!.diskTotalBytes !== undefined) assert.ok(registerHealth!.diskTotalBytes > 0);
    assert.ok(Math.abs(registerHealth!.collectedAt - Date.now()) < 60_000);

    // etc. at least once heartbeat (heartbeatMs=100ms)
    await waitFor(() => hub.heartbeats.length >= 1, 10_000, 'at least once heartbeat');
    assert.ok(hub.heartbeats.length >= 1, 'should receives heartbeat');
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
// 3. stdio Drain hard timeout protect:detached descendant process continuous write stdout
// ---------------------------------------------------------------------------

/**
 * with detached: true derive descendant process: descendant process each 20ms to inherit stdout continuous write,5s after
 * self row exit (self restrict avoid test legacy orphan child process; also cannot short - - want hot abort/timeout 
 * kill window, and runner must etc. pipeline arrange empty only then will wrap-up); parent process 1s after exit, descendant process continue drag
 * pipeline fd- - simulated real orphan child descendant process hang die scenario.
 */
const ORPHAN_PROGRAM = [
  "const cp = require('node:child_process');",
  "const childCode = 'const t0 = Date.now(); setInterval(() => { if (Date.now() - t0 > 5000) process.exit(0); process.stdout.write(String(Date.now() % 10)); }, 20);';",
  "cp.spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();",
  "setTimeout(() => {}, 1000);",
].join(' ');

test('envAbortExec after 500ms Drain protect: descendant process drag stdout do not hang die', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-abort-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const pending = server.envExec({
      execId: 'drain-abort',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 60,
    });
    // etc. parent process spawn completely descendant process and exit (descendant process continuous to inherit pipeline write)
    await delay(300);
    assert.equal(server.getActiveExecCount(), 1, 'exec should still in-flight (by descendant process pipeline drag)');
    await server.envAbortExec('drain-abort');
    const result = await pending;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, 'should failed compute');
    assert.equal(!result.ok && result.error.code, 'aborted', 'error code should be aborted');
    if (!result.ok) {
      assert.match(result.error.message, /aborted|drain/i);
    }
    assert.ok(elapsed < 10_000, `abort after should in Drain wide limit phase inside compute (actual ${elapsed}ms)`);
    // dispose do not hang die
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose must not hang die');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('command timeout after Drain protect: force timeout compute and dispose do not hang die', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-timeout-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const result = await server.envExec({
      execId: 'drain-timeout',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 1, // 1s timeout + 200ms Drain wide limit
    });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, 'should failed compute');
    assert.equal(!result.ok && result.error.code, 'timeout', 'error code should be timeout');
    if (!result.ok) {
      assert.match(result.error.message, /timed out after 1 seconds/);
    }
    assert.ok(elapsed < 10_000, `timeout after should in Drain wide limit phase inside compute (actual ${elapsed}ms)`);
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose must not hang die');
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
    // strip except host managed HELM_* variable:doctor  Hub probe target (HELM_HUB_URL takes precedence
    // level high at identity file) and token semantics only by test fixture decide.
    env: { ...sanitizedHostEnv(), ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('doctor: not bind set identity when ok=false and exit code 1', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-none-');
  try {
    // Herdr IPC check must avoid read to real ~/.config/herdr: points to isolated path
    const result = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(result.code, 1, `expectation exit code 1, got ${result.code}(out=${result.out})`);
    const report = JSON.parse(result.out) as { ok: boolean; checks: { id: string; status: string }[] };
    assert.equal(report.ok, false);
    const identity = report.checks.find((c) => c.id === 'identity');
    assert.equal(identity?.status, 'error');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor:node.json permission 0644 when identity report error(exit code 1;Windows without POSIX mode skip)', { timeout: 60_000 }, async () => {
  if (process.platform === 'win32') return; // NTFS away ACL,stat.mode do not express 0644, produce logic already for win32 exemption
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
    // non- json pattern same available
    const textResult = await runCli(['doctor', '--data-dir', dir], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(textResult.code, 1);
    assert.match(textResult.out, /identity/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor:root permission warn but identity and Hub normal when whole ok=true(exit code 0)', { timeout: 60_000 }, async () => {
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
    assert.match(privilege?.message ?? '', /root or exempt sudo/);
    assert.equal(report.checks.find((c) => c.id === 'identity')?.status, 'ok');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'ok');
    assert.equal(report.ok, true, 'warn does not affect whole ok');

    const result = await runCli(
      ['doctor', '--data-dir', dir, '--json'],
      { HERDR_SOCKET_PATH: path.join(dir, 'no.sock'), HELM_DOCTOR_TEST: '1' },
    );
    // CLI cannot inject checkPrivilege:hub check with real WS probe (identity and Hub all normal).
    // the assertion only verify CLI exit code and warn items in identity/Hub normal when whole ok.
    assert.equal(result.code, report.ok ? 0 : 1);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor: real WS Hub mock under hub items only read probe (zero register, zero top replace) and token never appear', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-doctor-hub-');
  const token = 'doctor-hub-node:secret-1';
  // same nodeId already has online connect:register will its top replace (evict) - - only read probe never can send register.
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
  assert.match(hubCheck?.message ?? '', /do not validate token/);
  const details = (hubCheck?.details ?? {}) as { rttMs?: number; hubUrl?: string };
  assert.equal(typeof details.rttMs, 'number');
  assert.ok(details.rttMs! >= 0);
  assert.equal(details.hubUrl, hub.url);
  // only read hard rule:Hub side never receives register(same nodeId register will evict online guard)
  assert.equal(hub.registrations.length, 0, 'doctor must not send register');
  // report all text never appear token(secret)
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(token), false, 'report in must not appear token');
  assert.equal(serialized.includes('secret-1'), false);
  // CLI --json output same without leaking
  const cli = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
  assert.equal(cli.code, 0, cli.out + cli.err);
  assert.equal(cli.out.includes(token), false, 'CLI output must not appear token');
  const cliReport = JSON.parse(cli.out) as { ok: boolean; hubUrl: string };
  assert.equal(cliReport.ok, true);
  assert.equal(cliReport.hubUrl, hub.url);
});

test('doctor: online daemon same nodeId when probe do not interference its connect (do not assert connect, do not heavy register)', { timeout: 60_000 }, async (t) => {
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
    // doctor from disk read identity: patch write node.json(daemon create path do not).
    await writeNodeIdentity(dir, { nodeId: 'doctor-live-node', token, hubUrl: hub.url });
    const registrationsBefore = hub.registrations.length;

    // in daemon online when execute doctor: only read probe must not quote assert connect reconnect (old implement will with same
    // nodeId register top online connect, real Hub side i.e. evict + in-flight command by kill).
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(daemon.isConnected(), true, 'doctor must not interference online daemon connect');
    assert.equal(hub.registrations.length, registrationsBefore, 'must not trigger re- register');
    await delay(300);
    assert.equal(daemon.isConnected(), true, 'probe after connect keep stable');
  } finally {
    // fixture  hub.close only closure most new connect:daemon must first closure (otherwise server.close
    // wait for daemon connect pending).
    await daemon.close().catch(() => undefined);
  }
});

test('doctor:Hub cannot reach when hub items report error(grasp manually failed such as present)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-dead-');
  try {
    // port 1 on without service: grasp manually immediately failed (connect reject)
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

test('doctor:herdr_ipc end point can reach when ok, cannot reach when info', { timeout: 60_000 }, async () => {
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
    // can reach:ok
    const reachable = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: sockPath },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcOk = reachable.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcOk?.status, 'ok', JSON.stringify(reachable.checks));
    assert.equal((ipcOk?.details as { endpoint?: string } | undefined)?.endpoint, sockPath);

    // cannot reach:info(optional capability do not block assert)
    const missing = await runNodeDoctor({
      dataDir: dir,
      env: { ...sanitizedHostEnv(), HERDR_SOCKET_PATH: path.join(dir, 'missing.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcInfo = missing.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcInfo?.status, 'info');
    assert.match(ipcInfo?.message ?? '', /not detect to run in Herdr IPC/);
    assert.equal(missing.ok, true, 'info does not affect whole ok');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
