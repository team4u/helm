/**
 * Acceptance review tests for `helmx-node` CLI background control (portable control IPC contract).
 *
 * Exercises real multi-process lifecycles: detached daemon child processes (stdio IPC readiness +
 * persistent control UDS) and a real Hub fixture (`http.Server` + `WebSocketServer` + `birpc`).
 * Dedicated CLI subprocess cases verify cross-process control while in-process entry calls pinpoint
 * edge conditions.
 *
 * Covers:
 * 1. `start -d` / `stop` / `status` / `restart` end-to-end: `state=registered` originates strictly
 *    from a genuine Hub ACK, `stop` terminates the process and removes PID files, and `status`
 *    truthfully reports `unknown` with diagnostics;
 * 2. Security boundaries: no tokens in argv/env, unknown instance nonces rejected without killing
 *    processes, unreachable control channel with live PID fails explicitly while preserving PID files,
 *    and duplicate starts reject;
 * 3. Honest failures: spawn failure and immediate child exit never report false success; new `node.pid`
 *    schema validation;
 * 4. `service`: prefers compiled `dist/` entry and prompts `pnpm build` when missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helmx/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helmx/protocol';
import { sanitizedHostEnv } from './helpers/sanitized-env.js';
import { bindIdentityFromJoinToken } from '../src/daemon/index.js';
import { isDirectRun, runNodeCli, type NodeCliIo } from '../src/cli.js';
import {
  getNodeServiceStatus,
  installNodeService,
  renderServiceSpec,
  uninstallNodeService,
  type ServiceExec,
} from '../src/daemon/service.js';

interface Captured {
  out: string;
  err: string;
  code: number;
}

/** In-memory I/O entry; complements (and does not replace) standalone CLI child-process tests. */
async function runCli(argv: string[], io: Partial<NodeCliIo> = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    // Strip host-managed HELMX_* variables so CLI startup reflects only test argv and node.json.
    env: sanitizedHostEnv(),
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...io,
  });
  return { out, err, code };
}

// ---------------------------------------------------------------------------
// Hub fixture: real http.Server + WebSocketServer + birpc
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: { nodeId: string; token: string }[];
  close(): Promise<void>;
}

async function startHubFixture(options: { expectedToken: string; reject?: boolean }): Promise<HubFixture> {
  const registrations: { nodeId: string; token: string }[] = [];
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
      const local = {
        register(input: { nodeId: string; token: string }): { ok: boolean; heartbeatMs: number } {
          registrations.push({ nodeId: input.nodeId, token: input.token });
          if (options.reject || input.token !== options.expectedToken) {
            setTimeout(() => {
              if (pendingSocket !== undefined && pendingSocket.readyState === WebSocket.OPEN) {
                pendingSocket.close(4003, 'invalid token');
              }
            }, 30);
            return { ok: false, heartbeatMs: 0 };
          }
          return { ok: true, heartbeatMs: 60_000 };
        },
        heartbeat(): boolean {
          return true;
        },
        onEnvExecOutput(_event: EnvExecOutputEvent): void {
          // Env forwarding is not exercised in this suite.
        },
      };
      const rpc = createBirpc(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
            try {
              const parsed: unknown = JSON.parse(text);
              if (parsed !== null && typeof parsed === 'object') callback(parsed);
            } catch {
              // Ignore non-JSON frames.
            }
          });
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
      });
      void rpc;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

/** Probe child liveness via `process.kill(pid, 0)`. */
const realIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until condition holds (supports async predicates), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, intervalMs: 100, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// 1. End-to-end: start -d / status / stop / restart (real multi-process + Hub)
// ---------------------------------------------------------------------------

test('start -d / status / stop: registered comes from genuine ACK, stop exits cleanly and removes pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-lifecycle-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-lc:s3cret' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-lc:s3cret', hub.url);

  // CLI process A: background start
  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 0, start.err);
  const payload = JSON.parse(start.out) as { ok: boolean; pid: number; state: string; logPath: string };
  assert.equal(payload.ok, true);
  assert.ok(payload.pid > 0);
  assert.equal(payload.state, 'registered', 'state must come from real registration ACK when Hub is reachable');

  // Hub received registration
  await waitFor(() => hub.registrations.length >= 1, 10_000, 'Hub receives registration');

  // node.pid new contract: pid + instanceId + endpoint, 0600
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
    pid: number;
    instanceId: string;
    endpoint: string;
  };
  assert.equal(record.pid, payload.pid);
  assert.match(record.instanceId, /^[0-9a-f]{32}$/);
  assert.match(record.endpoint, /^\/tmp\/helmx-node-[0-9a-f]{16}\.sock$/);
  const pidStat = await fs.stat(path.join(dir, 'node.pid'));
  // Skip 0600 mode check on Windows (NTFS uses ACLs instead of POSIX modes).
  if (process.platform !== 'win32') assert.equal(pidStat.mode & 0o777, 0o600);
  assert.ok(realIsAlive(record.pid), 'daemon should genuinely be alive');

  // Control endpoint socket file exists on disk
  await waitFor(() => fs.stat(record.endpoint).then(() => true, () => false), 5_000, 'control socket created');

  // Calling status again reports actual live running state.
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
  const statusPayload = JSON.parse(status.out) as { pid: number; pidAlive: boolean; state: string };
  assert.equal(statusPayload.pid, record.pid);
  assert.equal(statusPayload.pidAlive, true);
  assert.equal(statusPayload.state, 'registered');

  // stop requests graceful cleanup via IPC and verifies pid/socket removal.
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(JSON.parse(stop.out).outcome, 'stopped');
  assert.equal(realIsAlive(record.pid), false, 'process should actually exit via control-channel stop');
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid file should be removed');
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    'control socket should be removed',
  );

  // status after stop shows no running background daemon
  const after = await runCli(['status', '--data-dir', dir, '--json']);
  const afterPayload = JSON.parse(after.out) as { pid: number | null; pidAlive: boolean };
  assert.equal(afterPayload.pid, null);
  assert.equal(afterPayload.pidAlive, false);
});

test('three independent CLI child processes can start, query, and stop the same daemon instance', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-cli-processes-');
  const hub = await startHubFixture({ expectedToken: 'cli-process:s' });
  t.after(async () => { await runCli(['stop', '--data-dir', dir, '--json']); await hub.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await bindIdentityFromJoinToken(dir, 'cli-process:s', hub.url);
  const childCli = (args: string[]): Promise<Captured> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args, '--data-dir', dir, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...sanitizedHostEnv(), HELMX_HUB_URL: hub.url } });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString() });
    child.stderr.on('data', (chunk) => { err += chunk.toString() });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI child process did not exit within budget')) }, 20_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error) });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }) });
  });
  const started = await childCli(['start', '-d']);
  assert.equal(started.code, 0, started.err);
  assert.equal(JSON.parse(started.out).state, 'registered');
  const status = await childCli(['status']);
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).state, 'registered');
  const stopped = await childCli(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(JSON.parse(stopped.out).outcome, 'stopped');
  await assert.rejects(fs.stat(path.join(dir, 'node.pid')), { code: 'ENOENT' });
});

test('restart: old instance exits cleanly over control channel and new instance registers', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-restart-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-rst:s' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-rst:s', hub.url);

  const first = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(first.code, 0, first.err);
  const firstPid = (JSON.parse(first.out) as { pid: number }).pid;

  const restarted = await runCli(['restart', '--data-dir', dir, '--json']);
  assert.equal(restarted.code, 0, restarted.err);
  const payload = JSON.parse(restarted.out) as { ok: boolean; pid: number; previousPid: number; state: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.previousPid, firstPid);
  assert.notEqual(payload.pid, firstPid);
  assert.equal(payload.state, 'registered');
  assert.equal(realIsAlive(firstPid), false, 'old process should have exited');
  assert.ok(realIsAlive(payload.pid), 'new process should be alive');

  // After restart old socket is removed and new socket responds
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { pid: number; state: string };
  assert.equal(statusPayload.pid, payload.pid);
  assert.equal(statusPayload.state, 'registered');
});

test('start -d reports state=starting truthfully when Hub is unreachable without claiming registered', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-startd-offline-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // Nothing listens on 127.0.0.1:1 (daemon keeps backing off and retrying)
  await bindIdentityFromJoinToken(dir, 'rev-off:s', 'http://127.0.0.1:1');

  const r = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { ok: boolean; pid: number; state: string; message: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'starting');
  assert.match(payload.message, /not yet complete/);
  assert.ok(realIsAlive(payload.pid), 'daemon should remain alive and reconnect while offline');

  // status also reports starting
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { state: string };
  assert.equal(statusPayload.state, 'starting');
});

// ---------------------------------------------------------------------------
// 2. Security boundaries: no token in argv/env, unknown nonce rejection, keep pid when unreachable, reject duplicate start
// ---------------------------------------------------------------------------

test('start -d passes no token in argv or env; child argv contains only start --data-dir [--hub]', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-notoken-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-nt:s3cret' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-nt:s3cret', hub.url);

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedArgs: readonly string[] = [];
  const { defaultSpawnDaemon } = await import('../src/cli.js');
  const wrappedSpawn: NonNullable<NodeCliIo['spawnDaemon']> = async (options) => {
    capturedEnv = options.env;
    capturedArgs = options.args;
    return await defaultSpawnDaemon(options);
  };

  const r = await runCli(['start', '-d', '--data-dir', dir, '--json'], { spawnDaemon: wrappedSpawn });
  assert.equal(r.code, 0, r.err);
  // No token in argv: only CLI entry + start --data-dir <dir> (token read from node.json)
  assert.ok(!JSON.stringify(capturedArgs).includes('s3cret'), 'argv must not contain token secret');
  assert.ok(!JSON.stringify(capturedArgs).includes('rev-nt:'), 'argv must not contain token prefix');
  assert.ok(capturedArgs.includes('start'));
  assert.ok(capturedArgs.includes(dir));
  // No token in env (instanceId/endpoint are local control metadata)
  assert.ok(!JSON.stringify(capturedEnv ?? {}).includes('s3cret'), 'env must not contain token secret');
  assert.ok((capturedEnv?.['HELMX_NODE_INSTANCE_ID'] ?? '').length >= 16, 'instanceId passed via env');
  assert.ok((capturedEnv?.['HELMX_NODE_CONTROL_ENDPOINT'] ?? '').length > 0, 'endpoint passed via env');
});

test('control channel rejects unknown instance nonce without harming unrelated processes and preserves pid file', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-nonce-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-nonce:s' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-nonce:s', hub.url);

  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 0, start.err);
  const pid = (JSON.parse(start.out) as { pid: number }).pid;
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
    pid: number;
    instanceId: string;
    endpoint: string;
  };

  // Stop sent directly to real control endpoint with wrong nonce must reject with instance_mismatch without harming process
  const hostile = await new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
    let buffer = '';
    const socket = net.connect(record.endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 5_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'stop', instanceId: 'deadbeef'.repeat(4) })}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as { ok: boolean; error?: string });
      } catch {
        resolve(null);
      }
      socket.destroy();
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  assert.ok(hostile !== null, 'control endpoint should respond');
  assert.equal(hostile!.ok, false);
  assert.equal(hostile!.error, 'instance_mismatch');
  await waitFor(() => realIsAlive(pid), 2_000, 'process must stay alive on wrong nonce');

  // pid file remains intact and legitimate stop still works
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(realIsAlive(pid), false);
});

test('duplicate start is rejected after control channel verification (already_running)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-dup-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-dup:s' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-dup:s', hub.url);

  const first = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(first.code, 0, first.err);
  const pid = (JSON.parse(first.out) as { pid: number }).pid;

  const dup = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(dup.code, 1);
  assert.equal(JSON.parse(dup.err).error.code, 'already_running');
  assert.ok(realIsAlive(pid), 'duplicate start attempt must not disrupt running instance');

  // Lock is released (subsequent stop works normally)
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
});

test('unreachable control channel with live pid rejects both stop and start while keeping pid file', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-unreach-');
  t.after(async () => {
    // Cleanup removes dir since pid points to this live test process
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-unreach:s', 'http://127.0.0.1:1');
  // Placeholder pid targeting current live test process with nonexistent socket endpoint
  const fakeEndpoint = path.join(dir, 'no-such.sock');
  await fs.writeFile(
    path.join(dir, 'node.pid'),
    JSON.stringify({ pid: process.pid, instanceId: 'a'.repeat(32), endpoint: fakeEndpoint }) + '\n',
    'utf8',
  );

  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 1);
  const stopEnvelope = JSON.parse(stop.err) as { error: { message: string } };
  assert.match(stopEnvelope.error.message, /control channel unreachable/);
  assert.match(stopEnvelope.error.message, /refusing to signal an unverified process/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid file must be preserved');

  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 1);
  const startEnvelope = JSON.parse(start.err) as { error: { message: string } };
  assert.match(startEnvelope.error.message, /control channel is unreachable|cannot verify identity safely/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid file must be preserved');
});

test('dead pid: stop cleans up as stale and start recovers normally', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-stale-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // Obtain an exited pid via a short-lived child process
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const deadPid = await new Promise<number>((resolve) => {
    dead.once('exit', () => resolve(dead.pid ?? 0));
  });
  assert.ok(deadPid > 0);
  const fakeEndpoint = path.join(dir, 'no-such.sock');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'node.pid'),
    JSON.stringify({ pid: deadPid, instanceId: 'b'.repeat(32), endpoint: fakeEndpoint }) + '\n',
    'utf8',
  );

  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(JSON.parse(stop.out).outcome, 'stale');
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false);
});

test('corrupt pid file and leftover start lock fail explicitly without silent removal', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-badpid-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // Legacy plain-numeric pid file: invalid schema errors explicitly
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
  const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(legacy.code, 1);
  assert.match(JSON.parse(legacy.err).error.message, /invalid|corrupt/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'must not silently remove');

  // Corrupt JSON
  await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
  const broken = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(broken.code, 1);
  assert.match(JSON.parse(broken.err).error.message, /corrupt/);

  // Leftover start lock: explicit diagnostic without silent deletion; stop still respects existing corrupt pid
  await fs.writeFile(path.join(dir, 'node.start.lock'), '', 'utf8');
  const lockStop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(lockStop.code, 1); // Corrupt pid file still causes explicit failure
  const hub = await startHubFixture({ expectedToken: 'rev-lock:s' });
  t.after(async () => {
    await hub.close();
  });
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  await bindIdentityFromJoinToken(dir, 'rev-lock:s', hub.url);
  const lockStart = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(lockStart.code, 1);
  assert.match(JSON.parse(lockStart.err).error.message, /concurrent start conflict|node\.start\.lock/);
  assert.equal(await fs.stat(path.join(dir, 'node.start.lock')).then(() => true, () => false), true, 'leftover lock must not be silently removed');
});

// ---------------------------------------------------------------------------
// 3. Honest failures: spawn failure / immediate child exit / ready timeout
// ---------------------------------------------------------------------------

test('start -d fails explicitly on missing node binary without fake success', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-spawn-err-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-spawn:s', 'http://127.0.0.1:1');
  const badSpawn: NonNullable<NodeCliIo['spawnDaemon']> = async (options) => {
    const { spawn } = await import('node:child_process');
    const child = spawn(options.nodePath.replace(/node$/, 'node-no-such-bin'), options.args, {
      detached: true,
      stdio: 'ignore',
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => reject(error));
      if (child.pid !== undefined) resolve(child.pid);
    });
    return { pid, readyState: 'starting', logPath: path.join(options.dataDir, 'node.log') };
  };
  const r = await runCli(['start', '-d', '--data-dir', dir, '--json'], { spawnDaemon: badSpawn });
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /spawn|failed to start|ENOENT/);
  // No pid file written on failure
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false);
});

test('start -d fails with log tail on immediate child exit without writing pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-exit:s', 'http://127.0.0.1:1');
  // Use real defaultSpawnDaemon pointing to missing entry: child exits immediately before ready report
  const { defaultSpawnDaemon } = await import('../src/cli.js');
  const badEntry: NonNullable<NodeCliIo['spawnDaemon']> = async (options) => {
    const args = [...options.args];
    args[0] = path.join(options.dataDir, 'no-such-entry.js');
    return await defaultSpawnDaemon({ ...options, args, readyTimeoutMs: 15_000 });
  };
  const r = await runCli(['start', '-d', '--data-dir', dir, '--json'], {
    spawnDaemon: badEntry,
    readyTimeoutMs: 15_000,
  });
  assert.equal(r.code, 1);
  const message = JSON.parse(r.err).error.message as string;
  assert.ok(/exited immediately|did not report ready/.test(message), `should report immediate exit or ready timeout: ${message}`);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'immediate exit must not write pid');
});

test('start -d fails explicitly when node.log cannot be opened (blocked by directory)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-logfail-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'node.log'), { recursive: true }); // Directory named node.log blocks open
  await bindIdentityFromJoinToken(dataDir, 'rev-log:s', 'http://127.0.0.1:1');
  const r = await runCli(['start', '-d', '--data-dir', dataDir, '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /failed to open log file/);
});

// ---------------------------------------------------------------------------
// 4. Clean child IPC exit after startup (no orphan control socket or token leaks)
// ---------------------------------------------------------------------------

test('start -d clean start/stop leaves no orphan control socket and leaks no token into node.log', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-clean-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-clean:s3cret-value' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'rev-clean:s3cret-value', hub.url);

  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 0, start.err);
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as { endpoint: string };
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  // Control socket for this instance is cleaned up (scoped so parallel tests do not interfere)
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    'control socket should be removed',
  );
  assert.notEqual(record.endpoint, undefined);
  // Log must not leak token
  const log = await fs.readFile(path.join(dir, 'node.log'), 'utf8').catch(() => '');
  assert.ok(!log.includes('s3cret-value'), 'node.log must not contain token secret');
});

// ---------------------------------------------------------------------------
// 5. Service entry selection: compiled dist takes precedence; prompts pnpm build when missing
// ---------------------------------------------------------------------------

test('service install entry prefers dist and prompts pnpm build when running from source without dist', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-svc-entry-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const { resolveServiceEntry } = await import('../src/cli.js');
  // Source entry without dist artifact in isolated temp dir -> explicit pnpm build prompt
  const pkgSrc = path.join(dir, 'pkg', 'src', 'cli.ts');
  await fs.mkdir(path.dirname(pkgSrc), { recursive: true });
  await fs.writeFile(pkgSrc, '', 'utf8');
  assert.throws(() => resolveServiceEntry(pkgSrc), /pnpm build|compiled artifact/);
  // Fabricated dist artifact exists -> returns dist path
  const distDir = path.join(dir, 'pkg', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  const fakeDist = path.join(distDir, 'cli.js');
  await fs.writeFile(fakeDist, '', 'utf8');
  const resolved = resolveServiceEntry(pkgSrc);
  assert.equal(resolved, fakeDist);
  // serviceEntry override (CLI trusts injected path without existence probe)
  const r = await runCli(['service', 'status', '--data-dir', dir, '--json'], { serviceEntry: fakeDist });
  assert.equal(r.code, 0, r.err);
});

test('connect foreground prints connecting before registration, ready state after, and exits cleanly on Ctrl+C', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-connect-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'rev-conn:s' });
  t.after(async () => {
    await hub.close();
  });
  const outputs: string[] = [];
  const runPromise = runCli(['connect', hub.url, '--token', 'rev-conn:s', '--data-dir', dir], {
    out: (text) => {
      outputs.push(text);
      // After registered banner prints, simulate Ctrl+C (forwardSignals handles cleanup)
      if (text.includes('registered')) {
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 200);
      }
    },
  });
  const r = await runPromise;
  assert.equal(r.code, 0, r.err);
  assert.match(outputs[0] ?? '', /connecting/, 'first line must say connecting rather than connected');
  assert.ok(outputs.some((text) => text.includes('registered and ready')));
  assert.ok(!outputs.some((text) => text.includes('connected ')), 'must not print bogus connected status');
});

test('connect --once exits after single attempt and reports auth rejection truthfully', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-once-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'right:s', reject: true });
  t.after(async () => {
    await hub.close();
  });
  const r = await runCli(['connect', hub.url, '--token', 'wrong:s', '--data-dir', dir, '--once', '--json']);
  assert.equal(r.code, 1);
  const payload = JSON.parse(r.out) as { ok: boolean; registered: boolean };
  assert.equal(payload.ok, false);
  assert.equal(payload.registered, false);
});

// ---------------------------------------------------------------------------
// 6. service: step-by-step verification with injected executor (zero host side effects via temp serviceHome)
// ---------------------------------------------------------------------------

const okExec: ServiceExec = {
  run: async () => ({ code: 0, stdout: 'active', stderr: '' }),
};
const failExec: ServiceExec = {
  run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
};

test('install places targetPath under temp serviceHome with zero host side effects', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-svc-');
  const home = await tempDir('helmx-review-svc-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');
  const installed = await installNodeService(cliEntry, dir, {
    execCommand: okExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(installed.ok, true, installed.message);
  assert.ok(installed.targetPath!.startsWith(home), `targetPath must fall inside serviceHome: ${installed.targetPath}`);
  assert.equal(
    await fs.stat(installed.targetPath!).then(() => true, () => false),
    true,
    'active platform unit file should be written',
  );

  const status = await getNodeServiceStatus(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  assert.equal(status.installed, true);
  assert.equal(status.running, 'running');

  const uninstalled = await uninstallNodeService(cliEntry, dir, {
    execCommand: okExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(uninstalled.ok, true, uninstalled.message);
  assert.equal(
    await fs.stat(installed.targetPath!).then(() => true, () => false),
    false,
    'active platform unit file should be deleted after uninstall',
  );
});

test('install fails explicitly when daemon-reload or registration fails and preserves config', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-svc-cmdfail-');
  const home = await tempDir('helmx-review-svc-cmdfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // daemon-reload failure (systemctl command fails)
  const reloadFail: ServiceExec = {
    run: async (_cmd, args) => {
      if (args.includes('daemon-reload')) return { code: 1, stdout: '', stderr: 'reload failed' };
      return { code: 0, stdout: 'active', stderr: '' };
    },
  };
  await assert.rejects(
    installNodeService(cliEntry, dir, { execCommand: reloadFail, platform: 'linux', serviceHome: home }),
    /daemon-reload|reload failed/,
  );
  // Staged config copy preserved for diagnosis and retry
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helmx-node.service')).then(() => true, () => false),
    true,
  );

  // Registration command failure
  await assert.rejects(
    installNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /service registration|permission denied/,
  );
});

test('uninstall preserves configs and throws when deregistration fails instead of pretending uninstalled', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-svc-unfail-');
  const home = await tempDir('helmx-review-svc-unfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');
  // Install cleanly first
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  // Deregistration fails
  await assert.rejects(
    uninstallNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /platform deregistration failed|permission denied/,
  );
  // Config files preserved (including active platform file)
  assert.equal(
    await fs.stat(path.join(home, '.config/systemd/user/helmx-node.service')).then(() => true, () => false),
    true,
  );
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helmx-node.service')).then(() => true, () => false),
    true,
  );
});

test('status distinguishes installed/running/unknown and diagnoses query failures explicitly', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-svc-status-');
  const home = await tempDir('helmx-review-svc-status-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // Not installed: installed=false even if status command says active
  const notInstalled = await getNodeServiceStatus(cliEntry, dir, {
    execCommand: okExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(notInstalled.installed, false);
  assert.match(notInstalled.detail ?? '', /active unit file is missing/);

  // Installed + active -> running
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  const running = await getNodeServiceStatus(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  assert.equal(running.installed, true);
  assert.equal(running.running, 'running');

  // Installed + inactive -> stopped
  const inactiveExec: ServiceExec = {
    run: async () => ({ code: 3, stdout: 'inactive', stderr: '' }),
  };
  const stoppedStatus = await getNodeServiceStatus(cliEntry, dir, {
    execCommand: inactiveExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(stoppedStatus.installed, true);
  assert.equal(stoppedStatus.running, 'stopped');

  // Query command fails -> unknown + explicit diagnostic
  const brokenExec: ServiceExec = {
    run: async () => ({ code: null, stdout: '', stderr: 'systemctl: command not found' }),
  };
  const unknownStatus = await getNodeServiceStatus(cliEntry, dir, {
    execCommand: brokenExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(unknownStatus.installed, true);
  assert.equal(unknownStatus.running, 'unknown');
  assert.match(unknownStatus.detail ?? '', /status query command failed/);
});

test('renderServiceSpec applies serviceHome override across platforms and rejects unsupported ones', { timeout: 60_000 }, () => {
  const opts = { cliEntryPath: '/opt/cli.js', dataDir: '/opt/data', serviceHome: '/srv/fake-home' } as const;
  assert.equal(renderServiceSpec({ ...opts, platform: 'darwin' }).targetPath, '/srv/fake-home/Library/LaunchAgents/ai.helmx.node.plist');
  assert.equal(renderServiceSpec({ ...opts, platform: 'linux' }).targetPath, '/srv/fake-home/.config/systemd/user/helmx-node.service');
  // Win32 rendering normalizes separators to the TARGET platform (`\`), mirroring how linux/darwin
  // specs always render POSIX paths regardless of the host running the renderer.
  assert.equal(renderServiceSpec({ ...opts, platform: 'win32' }).targetPath, '\\srv\\fake-home\\HelmxNode.xml');
  assert.throws(() => renderServiceSpec({ ...opts, platform: 'sunos' }), /unsupported platform/);
});

test('unknown command with --json emits error envelope and rejects trailing args', { timeout: 60_000 }, async () => {
  const r = await runCli(['bogus', 'extra', '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'unknown_command');
  assert.match(envelope.error.message, /unknown command/);
});

test('isDirectRun resolves real path when invoked via pnpm symlink (bin smoke)', { timeout: 60_000 }, async () => {
  const selfPath = new URL(import.meta.url).pathname;
  assert.equal(isDirectRun(selfPath), false, 'test file is not the CLI entry');
  assert.equal(isDirectRun('/definitely/not/this/file.js'), false);
  assert.equal(isDirectRun(undefined), false);
});
