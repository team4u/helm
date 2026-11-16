/**
 * helm-node CLI background control review review test (convenient carry control IPC contract verify).
 *
 * all away real many process: real detached child process (stdio IPC ready on report + durable control
 * UDS)+ real Hub fixture(http.Server + WebSocketServer + birpc).
 * independent CLI child process case verify across process control, the rest case via process inside entry locate boundary behavior.
 *
 * override:
 * 1. start -d / stop / status / restart all link: ready state semantics (registered only
 *    from real ACK),stop after process real exit and pid file delete,status present unknown
 *    and diagnose;
 * 2. security boundary:argv/env without token; unknown instance nonce reject and do not kill process; control channel cannot
 *    reach but pid store when stop/start explicit failed and keep pid file; duplicate start reject;
 * 3. failed such as:spawn failed, child process i.e. retreat do not fake succeeded;node.pid new contract validate;
 * 4. service: template/install behavior archive service test; this where only verify CLI entry choose compile artifact
 *    (source code run without dist artifact when explicit hint pnpm build).
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
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helm/protocol';
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

/** memory IO entry; and real child process CLI test respectively override, cannot mutual each other alternative. */
async function runCli(argv: string[], io: Partial<NodeCliIo> = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    // strip except host managed HELM_* variable: by test CLI start identity/Hub/data directory semantics only by
    // test explicit argv and node.json identity decide, do not by host conversation environment hijack.
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
          // this file do not test env forwarding.
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
              // non- JSON frame.
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

/** read child process store state (real process.kill(pid, 0)). */
const realIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** wait for condition into establish (real apply test polling, non- fixed sleep; condition can async). */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, intervalMs: 100, message: `wait timed out:${what}` });

// ---------------------------------------------------------------------------
// 1. all link:start -d / status / stop / restart(real many process + real Hub)
// ---------------------------------------------------------------------------

test('start -d / status / stop:registered from real register,stop after real exit and clean pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-lifecycle-');
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
  assert.equal(payload.state, 'registered', 'can reach Hub under state must from real register ACK');

  // Hub indeed receives register
  await waitFor(() => hub.registrations.length >= 1, 10_000, 'Hub receives register');

  // node.pid new contract:pid + instanceId + endpoint,0600
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
    pid: number;
    instanceId: string;
    endpoint: string;
  };
  assert.equal(record.pid, payload.pid);
  assert.match(record.instanceId, /^[0-9a-f]{32}$/);
  assert.match(record.endpoint, /^\/tmp\/helm-node-[0-9a-f]{16}\.sock$/);
  const pidStat = await fs.stat(path.join(dir, 'node.pid'));
  // Windows without POSIX mode(NTFS away ACL), skip 0600 pattern assertion.
  if (process.platform !== 'win32') assert.equal(pidStat.mode & 0o777, 0o600);
  assert.ok(realIsAlive(record.pid), 'daemon should real store');

  // control end point socket file real store in
  await waitFor(() => fs.stat(record.endpoint).then(() => true, () => false), 5_000, 'control socket ');

  // again invoke entry:status present real run state.
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
  const statusPayload = JSON.parse(status.out) as { pid: number; pidAlive: boolean; state: string };
  assert.equal(statusPayload.pid, record.pid);
  assert.equal(statusPayload.pidAlive, true);
  assert.equal(statusPayload.state, 'registered');

  // stop via IPC request background process clean up, confirm pid and socket Profile disappear.
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(JSON.parse(stop.out).outcome, 'stopped');
  assert.equal(realIsAlive(record.pid), false, 'process should real exit (via control channel graceful stop)');
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid file should delete');
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    'control socket should clean up',
  );

  // stop after status back to without background process
  const after = await runCli(['status', '--data-dir', dir, '--json']);
  const afterPayload = JSON.parse(after.out) as { pid: number | null; pidAlive: boolean };
  assert.equal(afterPayload.pid, null);
  assert.equal(afterPayload.pidAlive, false);
});

test('three independent CLI child process can start, query and stop the same background node instance', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-cli-processes-');
  const hub = await startHubFixture({ expectedToken: 'cli-process:s' });
  t.after(async () => { await runCli(['stop', '--data-dir', dir, '--json']); await hub.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await bindIdentityFromJoinToken(dir, 'cli-process:s', hub.url);
  const childCli = (args: string[]): Promise<Captured> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args, '--data-dir', dir, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...sanitizedHostEnv(), HELM_HUB_URL: hub.url } });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString() });
    child.stderr.on('data', (chunk) => { err += chunk.toString() });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI child process not in pre- compute inside exit')) }, 20_000);
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

test('restart: old instance via control channel real exit, new instance register succeeded', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-restart-');
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
  assert.equal(realIsAlive(firstPid), false, 'old process should already real exit');
  assert.ok(realIsAlive(payload.pid), 'new process should store');

  // restart after old instance control socket already clean, new socket can inspect
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { pid: number; state: string };
  assert.equal(statusPayload.pid, payload.pid);
  assert.equal(statusPayload.state, 'registered');
});

test('start -d:Hub cannot reach when state=starting(such as present offline run state, do not fake call registered)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-startd-offline-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 127.0.0.1:1 port will not accept connect (daemon will continuous backoff reconnect)
  await bindIdentityFromJoinToken(dir, 'rev-off:s', 'http://127.0.0.1:1');

  const r = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { ok: boolean; pid: number; state: string; message: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'starting');
  assert.match(payload.message, /not yet complete/);
  assert.ok(realIsAlive(payload.pid), 'offline when daemon should store reconnect');

  // status same present starting
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { state: string };
  assert.equal(statusPayload.state, 'starting');
});

// ---------------------------------------------------------------------------
// 2. security boundary: without token argv/env; unknown nonce reject; cannot reach keep pid; duplicate start reject
// ---------------------------------------------------------------------------

test('start -d:argv and env all without token; child process argv only start --data-dir [--hub]', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-notoken-');
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
  // argv without token: only CLI entry + start --data-dir <dir>(--hub not explicit when do not pass,token from node.json read)
  assert.ok(!JSON.stringify(capturedArgs).includes('s3cret'), 'argv must not contains token secret');
  assert.ok(!JSON.stringify(capturedArgs).includes('rev-nt:'), 'argv must not contains token prefix');
  assert.ok(capturedArgs.includes('start'));
  assert.ok(capturedArgs.includes(dir));
  // env without token(instanceId/endpoint is local machine control information, allows store in)
  assert.ok(!JSON.stringify(capturedEnv ?? {}).includes('s3cret'), 'env must not contains token secret');
  assert.ok((capturedEnv?.['HELM_NODE_INSTANCE_ID'] ?? '').length >= 16, 'instanceId via env pass');
  assert.ok((capturedEnv?.['HELM_NODE_CONTROL_ENDPOINT'] ?? '').length > 0, 'endpoint via env pass');
});

test('control channel: unknown instance nonce reject (do not kill without closure process),pid file keep', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-nonce-');
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

  // directly for real control end point error nonce  stop: must by reject (instance_mismatch), process do not subject to affect
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
  assert.ok(hostile !== null, 'control end point should reply');
  assert.equal(hostile!.ok, false);
  assert.equal(hostile!.error, 'instance_mismatch');
  await waitFor(() => realIsAlive(pid), 2_000, 'error nonce under process must store');

  // pid file still keep, normal stop still valid
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(realIsAlive(pid), false);
});

test('duplicate start reject (instance via control channel verify,already_running)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-dup-');
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
  assert.ok(realIsAlive(pid), 'duplicate start attempt must not affect store instance');

  // lock already release (can again normal stop)
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
});

test('control channel cannot reach but pid store:stop and start all reject and keep pid file', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-unreach-');
  t.after(async () => {
    // use real store this test process occupy pid: directly clean pid file (test wrap-up)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-unreach:s', 'http://127.0.0.1:1');
  // occupy:pid points to this test process (store),endpoint points to missing socket
  const fakeEndpoint = path.join(dir, 'no-such.sock');
  await fs.writeFile(
    path.join(dir, 'node.pid'),
    JSON.stringify({ pid: process.pid, instanceId: 'a'.repeat(32), endpoint: fakeEndpoint }) + '\n',
    'utf8',
  );

  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 1);
  const stopEnvelope = JSON.parse(stop.err) as { error: { message: string } };
  assert.match(stopEnvelope.error.message, /control channel cannot reach/);
  assert.match(stopEnvelope.error.message, /reject to not via identity verify process send signal/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid file must keep');

  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 1);
  const startEnvelope = JSON.parse(start.err) as { error: { message: string } };
  assert.match(startEnvelope.error.message, /control channel cannot reach|cannot verify can security override/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid file must keep');
});

test('pid indeed already death:stop by stale clean up,start clean up after normal start', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-stale-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // find a already exit pid:spawn a i.e. retreat child process
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

test('broken pid file and leftover start lock: explicit errors, not silently clean up', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-badpid-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // old edition pure number pid Profile: structure illegal explicit errors
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
  const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(legacy.code, 1);
  assert.match(JSON.parse(legacy.err).error.message, /illegal|corrupt/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'not silently clean up');

  // broken JSON
  await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
  const broken = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(broken.code, 1);
  assert.match(JSON.parse(broken.err).error.message, /corrupt/);

  // leftover start lock: explicit diagnose (not silently delete),stop do not subject to affect
  await fs.writeFile(path.join(dir, 'node.start.lock'), '', 'utf8');
  const lockStop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(lockStop.code, 1); // broken pid file still in → errors while non- clean up
  const hub = await startHubFixture({ expectedToken: 'rev-lock:s' });
  t.after(async () => {
    await hub.close();
  });
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  await bindIdentityFromJoinToken(dir, 'rev-lock:s', hub.url);
  const lockStart = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(lockStart.code, 1);
  assert.match(JSON.parse(lockStart.err).error.message, /concurrency start conflict|node\.start\.lock/);
  assert.equal(await fs.stat(path.join(dir, 'node.start.lock')).then(() => true, () => false), true, 'leftover lock not silently delete');
});

// ---------------------------------------------------------------------------
// 3. failed such as:spawn failed / child process i.e. retreat / ready timeout
// ---------------------------------------------------------------------------

test('start -d:node can execute missing → spawn error explicit errors, do not fake succeeded', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-spawn-err-');
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
  // failed do not pid Profile
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false);
});

test('start -d: child process i.e. retreat (entry script missing)→ explicit errors attach log tail part, do not write pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-exit:s', 'http://127.0.0.1:1');
  // use real defaultSpawnDaemon but argv points to missing script: child process immediately exit,ready forever do not occur
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
  assert.ok(/immediately exit|not on report ready/.test(message), `should report i.e. retreat or ready timeout: ${message}`);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'i.e. retreat must not write pid');
});

test('start -d:node.log failed to open (by directory occupy)→ explicit error', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-logfail-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'node.log'), { recursive: true }); // node.log is directory → open failed
  await bindIdentityFromJoinToken(dataDir, 'rev-log:s', 'http://127.0.0.1:1');
  const r = await runCli(['start', '-d', '--data-dir', dataDir, '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /open log file failed/);
});

// ---------------------------------------------------------------------------
// 4. after startup child process IPC clean exit (without orphan child socket / without token leak leak enter log)
// ---------------------------------------------------------------------------

test('start -d: normal start stop after without orphan child control socket,node.log excludes token', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-clean-');
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
  // this instance control socket already clean up (concurrency test file instance mutual do not interference, do not global scan /tmp)
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    'control socket should clean up',
  );
  assert.notEqual(record.endpoint, undefined);
  // log without leaking token
  const log = await fs.readFile(path.join(dir, 'node.log'), 'utf8').catch(() => '');
  assert.ok(!log.includes('s3cret-value'), 'node.log must not contains token secret');
});

// ---------------------------------------------------------------------------
// 5. service entry choose: compile artifact takes precedence, source code run without dist explicit hint
// ---------------------------------------------------------------------------

test('service install entry: source code run and without dist artifact → explicit hint pnpm build(do not generate cannot start service)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-entry-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const { resolveServiceEntry } = await import('../src/cli.js');
  // source code entry and same package without dist artifact (isolated temp directory)→ explicit hint first pnpm build
  const pkgSrc = path.join(dir, 'pkg', 'src', 'cli.ts');
  await fs.mkdir(path.dirname(pkgSrc), { recursive: true });
  await fs.writeFile(pkgSrc, '', 'utf8');
  assert.throws(() => resolveServiceEntry(pkgSrc), /pnpm build|compile artifact/);
  // fabricate dist artifact store in → return dist path
  const distDir = path.join(dir, 'pkg', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  const fakeDist = path.join(distDir, 'cli.js');
  await fs.writeFile(fakeDist, '', 'utf8');
  const resolved = resolveServiceEntry(pkgSrc);
  assert.equal(resolved, fakeDist);
  // serviceEntry inject override (CLI does not store in decide, by inject way negative duty)
  const r = await runCli(['service', 'status', '--data-dir', dir, '--json'], { serviceEntry: fakeDist });
  assert.equal(r.code, 0, r.err);
});

test('connect foreground: register complete before output connect in, register after output real state,Ctrl+C graceful exit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-connect-');
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
      // registered output after simulated Ctrl+C(forwardSignals already take over clean up)
      if (text.includes('registered')) {
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 200);
      }
    },
  });
  const r = await runPromise;
  assert.equal(r.code, 0, r.err);
  assert.match(outputs[0] ?? '', /connect in/, 'first output must be connect in while non- connected');
  assert.ok(outputs.some((text) => text.includes('registered and start work')));
  assert.ok(!outputs.some((text) => text.includes('connected ')), 'must not output connected false state');
});

test('connect --once: once attempt i.e. exit; authentication reject when such as report failed', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-once-');
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
// 6. service: inject execute one by one step verify (zero host side effect:serviceHome → temp directory)
// ---------------------------------------------------------------------------

const okExec: ServiceExec = {
  run: async () => ({ code: 0, stdout: 'active', stderr: '' }),
};
const failExec: ServiceExec = {
  run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
};

test('install:targetPath  serviceHome temp directory, zero host side effect', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-');
  const home = await tempDir('helm-review-svc-home-');
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
  assert.ok(installed.targetPath!.startsWith(home), `targetPath must serviceHome: ${installed.targetPath}`);
  assert.equal(
    await fs.stat(installed.targetPath!).then(() => true, () => false),
    true,
    'platform takes effect file should write',
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
    'unload after platform takes effect file should delete',
  );
});

test('install:daemon-reload / register command failed one by one step explicit errors, config keep', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-cmdfail-');
  const home = await tempDir('helm-review-svc-cmdfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // daemon-reload failed (only systemctl command failed)
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
  // Profile copy still in (supply diagnose/retry)
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helm-node.service')).then(() => true, () => false),
    true,
  );

  // register command failed
  await assert.rejects(
    installNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /system register|permission denied/,
  );
});

test('uninstall: deregister command failed → keep config and errors (does not pretend to be uninstalled)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-unfail-');
  const home = await tempDir('helm-review-svc-unfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');
  // first succeeded install
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  // deregister failed
  await assert.rejects(
    uninstallNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /platform deregister failed|permission denied/,
  );
  // config keep (contains platform takes effect file)
  assert.equal(
    await fs.stat(path.join(home, '.config/systemd/user/helm-node.service')).then(() => true, () => false),
    true,
  );
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helm-node.service')).then(() => true, () => false),
    true,
  );
});

test('status: three state zone (installed/running/unknown), query failed explicit diagnose', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-status-');
  const home = await tempDir('helm-review-svc-status-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // not installed:installed false(even if state command sound call active)
  const notInstalled = await getNodeServiceStatus(cliEntry, dir, {
    execCommand: okExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(notInstalled.installed, false);
  assert.match(notInstalled.detail ?? '', /takes effect file missing/);

  // installed + active → running
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  const running = await getNodeServiceStatus(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  assert.equal(running.installed, true);
  assert.equal(running.running, 'running');

  // installed + inactive → stopped
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

  // query failed (command cannot execute)→ unknown + explicit diagnose
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
  assert.match(unknownStatus.detail ?? '', /state query command failed/);
});

test('renderServiceSpec:serviceHome override three platform targetPath;unsupported errors', { timeout: 60_000 }, () => {
  const opts = { cliEntryPath: '/opt/cli.js', dataDir: '/opt/data', serviceHome: '/srv/fake-home' } as const;
  assert.equal(renderServiceSpec({ ...opts, platform: 'darwin' }).targetPath, '/srv/fake-home/Library/LaunchAgents/ai.helm.node.plist');
  assert.equal(renderServiceSpec({ ...opts, platform: 'linux' }).targetPath, '/srv/fake-home/.config/systemd/user/helm-node.service');
  assert.equal(renderServiceSpec({ ...opts, platform: 'win32' }).targetPath, '/srv/fake-home/HelmNode.xml');
  assert.throws(() => renderServiceSpec({ ...opts, platform: 'sunos' }), /unsupported platform/);
});

test('unknown parameter --json: output error message seal; redundant location parameter reject', { timeout: 60_000 }, async () => {
  const r = await runCli(['bogus', 'extra', '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'unknown_command');
  assert.match(envelope.error.message, /unknown command/);
});

test('isDirectRun:pnpm symlink invoke when identify path (bin smoke)', { timeout: 60_000 }, async () => {
  const selfPath = new URL(import.meta.url).pathname;
  assert.equal(isDirectRun(selfPath), false, 'test module is not CLI entry');
  assert.equal(isDirectRun('/definitely/not/this/file.js'), false);
  assert.equal(isDirectRun(undefined), false);
});
