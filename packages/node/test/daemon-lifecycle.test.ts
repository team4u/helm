/**
 * daemon/index.ts lifecycle regression test (real HTTP+WS+birpc + real temp directory, do not mock by test module):
 * - first time failed to connect after reconnect succeeded (Hub latency start);
 * - disconnection after waitUntilRegistered do not fabricate succeeded (offline confirm false; reconnect register after can again translate true);
 * - reverse re- register reject during always at most a connect (without parallel connect);
 * - offline backoff reconnect during daemon keep store (event loop do not by unref count when put empty);
 * - close() wait for in-flight era proxy clean up complete (remote envExec child process by kill after only then return);
 * - broken identity/broken token/broken hubUrl explicit reject (not silently fall back since has identity);
 * - concurrency bind set different nodeId exactly a succeeded (process inside mutual exclusion);
 * - shellEnv PATH pre- managed helm bin(remote bash can run helm).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helm/protocol';
import {
  bindIdentityFromJoinToken,
  createNodeDaemon,
  parseJoinToken,
  readNodeIdentity,
  resolveManagedHelmBinDir,
  writeNodeIdentity,
} from '../src/daemon/index.js';

/** re- use port: first occupy a idle port, closure after to fixture backlisten(reconnect back same port use). */
async function reservePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface HubHandle {
  url: string;
  port: number;
  registrations: NodeRegisterInput[];
  /** cumulative accept connect (upgrade time count). */
  connections: number;
  /** immediately accept socket count (browser side already establish). */
  openSockets: Set<WebSocket>;
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  /** actively disconnect all node connect. */
  disconnectAll(): void;
  close(): Promise<void>;
  /** on demand change write register reply/heartbeat reply. */
  setBehavior(behavior: {
    registerAck?: (input: NodeRegisterInput) => NodeRegisterResult;
    heartbeat?: (nodeId: string) => boolean;
  }): void;
}

/** real http.Server + WebSocketServer + birpc  Hub gateway (and formal /ws/node same construct). */
async function startHub(options: {
  port?: number;
  heartbeatMs?: number;
  rejectAll?: boolean;
  execOutputs?: EnvExecOutputEvent[];
}): Promise<HubHandle> {
  const registrations: NodeRegisterInput[] = [];
  const openSockets = new Set<WebSocket>();
  let connections = 0;
  let nodeRpc: BirpcReturn<NodeEnvRpcFunctions, NodeHubLocal> | undefined;
  let registerBehavior: (input: NodeRegisterInput) => NodeRegisterResult = () =>
    options.rejectAll
      ? { ok: false, heartbeatMs: 0, reason: 'rejected' }
      : { ok: true, heartbeatMs: options.heartbeatMs ?? 15_000 };
  let heartbeat: (nodeId: string) => boolean = () => true;

  interface NodeHubLocal {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
    heartbeat(nodeId: string): boolean;
    onEnvExecOutput(event: EnvExecOutputEvent): void;
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    connections += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      openSockets.add(ws);
      ws.once('close', () => openSockets.delete(ws));
      const local: NodeHubLocal = {
        async register(input) {
          registrations.push(input);
          const ack = registerBehavior(input);
          if (!ack.ok) {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) ws.close(4003, ack.reason ?? 'invalid token');
            }, 20);
          }
          return ack;
        },
        heartbeat(nodeId) {
          return heartbeat(nodeId);
        },
        onEnvExecOutput(event) {
          options.execOutputs?.push(event);
        },
      };
      nodeRpc = createBirpc<NodeEnvRpcFunctions, NodeHubLocal>(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
            try {
              const parsed = JSON.parse(text) as unknown;
              if (parsed !== null && typeof parsed === 'object') callback(parsed);
            } catch {
              // Hub fixture contain tolerate occasional noise frame.
            }
          });
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      // connect disconnect: as specification Hub must immediately reject all in-flight invoke (do not pending to timeout).
      ws.once('close', () => nodeRpc?.$close());
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registrations,
    connections,
    openSockets,
    nodeRpc: () => nodeRpc,
    disconnectAll() {
      for (const ws of openSockets) ws.close();
    },
    setBehavior(behavior) {
      if (behavior.registerAck !== undefined) registerBehavior = behavior.registerAck;
      if (behavior.heartbeat !== undefined) heartbeat = behavior.heartbeat;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of openSockets) ws.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// 1. first time failed to connect → backoff reconnect succeeded
// ---------------------------------------------------------------------------

test('first time failed to connect (Hub not start) after reconnect succeeded', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-firstfail-');
  const port = await reservePort();
  const logs: string[] = [];
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    identity: { nodeId: 'ff-1', token: 'ff-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 60,
    reconnectMaxDelayMs: 300,
    log: (m) => logs.push(m),
  });
  let hub: HubHandle | undefined;
  try {
    // Hub not yet listen: first connect and if dry time reconnect all failed,daemon must not exit, must not crash.
    await delay(300);
    assert.equal(daemon.isConnected(), false, 'failed phase should offline');
    assert.equal(await daemon.waitUntilRegistered(50), false, 'failed phase wait for must not fabricate succeeded');

    // start Hub: backoff reconnect after should register succeeded.
    hub = await startHub({ port, heartbeatMs: 15_000 });
    const ok = await daemon.waitUntilRegistered(15_000);
    assert.equal(ok, true, `Hub after startup should reconnect register succeeded (log:${logs.join(' | ')})`);
    assert.equal(daemon.isConnected(), true);
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'ff-1');

    // after success new wait immediately true(when before online)
    assert.equal(await daemon.waitUntilRegistered(1_000), true);
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. disconnection after wait do not fabricate succeeded; reconnect after can again translate true
// ---------------------------------------------------------------------------

test('disconnection after waitUntilRegistered do not fabricate succeeded, reconnect after translate true', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-wait-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'w-1', token: 'w-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 60,
    reconnectMaxDelayMs: 300,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    const registrationsBefore = hub.registrations.length;

    // disconnection + reject after continue register: offline window inside wait must explicit false(do not fabricate succeeded).
    hub.setBehavior({ registerAck: () => ({ ok: false, heartbeatMs: 0, reason: 'maintenance' }) });
    hub.disconnectAll();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && daemon.isConnected()) await delay(50);
    assert.equal(daemon.isConnected(), false, 'disconnection after should treated as not connect');
    assert.equal(await daemon.waitUntilRegistered(300), false, 'offline/by refuse phase wait must not fabricate succeeded');

    // server side restore accept: reconnect register after success, new wait translate true(do not cache failed).
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    const ok = await daemon.waitUntilRegistered(15_000);
    assert.equal(ok, true, 'reconnect register after success wait should translate true');
    assert.equal(daemon.isConnected(), true);
    assert.ok(hub.registrations.length > registrationsBefore, 'shared many time register attempt (initial + reconnect)');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. reverse re- reject: always at most a connect
// ---------------------------------------------------------------------------

test('reverse re- register reject during always at most a parallel connect', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-reject-');
  const hub = await startHub({ heartbeatMs: 15_000, rejectAll: true });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'r-1', token: 'r-1:wrong' },
    dataDir: dir,
    reconnectBaseDelayMs: 30,
    reconnectMaxDelayMs: 100,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(400), false, 'authentication reject must wait false');
    // observe multiple reject cycle: any one moment Hub side at most a node socket(without parallel connect).
    for (let i = 0; i < 6; i += 1) {
      await delay(50);
      assert.ok(hub.openSockets.size <= 1, ` ${i} time sampling discover ${hub.openSockets.size} parallel connect`);
    }
    assert.ok(hub.registrations.length >= 2, 'backoff retry should many time attempt register');
    assert.equal(daemon.isConnected(), false);

    // rotate is accept: reject do not cache, restore after register succeeded.
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    assert.equal(await daemon.waitUntilRegistered(15_000), true, 'restore accept after should register succeeded');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. offline backoff reconnect during daemon keep store (unref fix regression)
// ---------------------------------------------------------------------------

test('offline backoff reconnect during keep store (do not by unref count when put empty)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-alive-');
  const port = await reservePort();
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    identity: { nodeId: 'a-1', token: 'a-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 40,
    reconnectMaxDelayMs: 120,
  });
  let hub: HubHandle | undefined;
  try {
    // the whole 900ms offline window inside daemon should continuous store (if reconnect count when by unref,
    // test process event loop by put empty, under side delay loop also will follow process exit while abort).
    const start = Date.now();
    let aliveMs = 0;
    while (Date.now() - start < 900) {
      await delay(80);
      aliveMs = Date.now() - start;
      assert.equal(daemon.isConnected(), false);
    }
    assert.ok(aliveMs >= 700, `offline during should stay store (actual store ${aliveMs}ms)`);

    hub = await startHub({ port, heartbeatMs: 15_000 });
    assert.equal(await daemon.waitUntilRegistered(15_000), true, 'store after reconnect succeeded');
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. close() wait for in-flight era proxy clean up (remote exec child process by kill after only then return)
// ---------------------------------------------------------------------------

test('close return before wait for era proxy clean up (in-flight envExec child process by kill)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-close-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'c-1', token: 'c-1:sec' },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined);
    // remote long command:close() should terminate its child process and make RPC with failed set (do not pending, do not replay).
    const pending = rpc!
      .envExec({ execId: 'long-1', command: 'sleep 60', timeout: 120 })
      .catch((error: unknown) => ({ ok: false as const, error: { code: 'closed', message: String(error) } }));
    await delay(250); // etc. child process truly start
    const start = Date.now();
    await daemon.close();
    const closedMs = Date.now() - start;
    assert.ok(closedMs < 15_000, `close should has boundary wait for clean up (actual ${closedMs}ms)`);
    const result = await Promise.race([
      pending,
      new Promise<{ ok: true }>((resolve) => {
        const t = setTimeout(() => resolve({ ok: true }), 8_000);
        t.unref?.();
      }),
    ]);
    assert.equal(result.ok, false, 'in-flight envExec must with failed set (do not replay)');
    // close idempotent
    await daemon.close();
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. broken identity/broken token/broken hubUrl explicit reject
// ---------------------------------------------------------------------------

test('readNodeIdentity strictly validate external object (null/array/broken field all reject)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-badid-');
  const file = path.join(dir, 'node.json');
  const cases: unknown[] = [
    'not-an-object',
    null,
    [],
    { nodeId: 123, token: 'x:sec' },
    { nodeId: 'ok-node', token: '' },
    { nodeId: 'ok-node', token: 'other-node:secret' },
    { nodeId: 'ok-node', token: 'ok-node:line\nbreak' },
    { nodeId: 'ok-node', token: 'ok-node:has space' },
    { nodeId: 'ok-node', token: '  padded:sec  ' },
    { nodeId: 'local', token: 'local:x' },
    { nodeId: 'bad id', token: 'a:sec' },
    { nodeId: 'ok-node', token: 'a:sec', hubUrl: 'ftp://hub:3202' },
    { nodeId: 'ok-node', token: 'a:sec', hubUrl: 'http://user:pass@hub:3202' },
    { nodeId: 'ok-node', token: 'a:sec', hubUrl: 'http://hub:3202/#frag' },
  ];
  try {
    for (const value of cases) {
      await fs.writeFile(file, JSON.stringify(value), 'utf8');
      await assert.rejects(readNodeIdentity(dir), { name: 'Error' }, `should reject: ${JSON.stringify(value)}`);
    }
    // legal identity (contains optional hubUrl) via
    await fs.writeFile(file, JSON.stringify({ nodeId: 'ok-node', token: 'ok-node:sec', hubUrl: 'http://127.0.0.1:3202' }), 'utf8');
    const ok = await readNodeIdentity(dir);
    assert.equal(ok?.nodeId, 'ok-node');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseJoinToken reject local/whitespace/control character etc. illegal token', { timeout: 60_000 }, () => {
  assert.equal(parseJoinToken('local:secret'), null, 'local ID must not as JOIN nodeId');
  assert.equal(parseJoinToken(' node-1:secret'), null, 'first whitespace reject');
  assert.equal(parseJoinToken('node-1:secret '), null, 'tail whitespace reject');
  assert.equal(parseJoinToken('node-1:\n'), null, 'control character secret reject');
  assert.equal(parseJoinToken('node-1:sec\x00ret'), null, 'NUL reject');
  assert.equal(parseJoinToken('local:'), null);
  assert.deepEqual(parseJoinToken('node.9_x:s3c'), { nodeId: 'node.9_x', secret: 's3c' });
});

test('bindIdentityFromJoinToken reject broken hubUrl and do not leak token', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-bind-');
  try {
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'ftp://x'), /protocol must is http/);
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'http://u:p@x'), /userinfo/);
    // illegal token error information must not contains token prefix
    const secret = 'supersecretvalue';
    try {
      await bindIdentityFromJoinToken(dir, `bad id:${secret}`, 'http://127.0.0.1:3202');
      assert.fail('should reject illegal token');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes('bad id'.slice(0, 4)), `error must not leak token prefix:${message}`);
      assert.ok(!message.includes(secret), `error must not leak secret:${message}`);
    }
    assert.equal(await readNodeIdentity(dir), null, 'failed bind set must not write identity');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeNodeIdentity validate reference (broken identity directly reject)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-write-');
  try {
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'local', token: 'x' }), /identity illegal/);
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'n', token: '' }), /identity illegal/);
    await assert.rejects(
      writeNodeIdentity(dir, { nodeId: 'n', token: 'n:s', hubUrl: 'javascript:alert(1)' }),
      /identity illegal/,
    );
    assert.equal(await readNodeIdentity(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. concurrency bind set: different nodeId exactly a succeeded
// ---------------------------------------------------------------------------

test('concurrency bindIdentityFromJoinToken different nodeId exactly a succeeded', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-race-');
  try {
    const results = await Promise.allSettled([
      bindIdentityFromJoinToken(dir, 'race-a:sec-a', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-b:sec-b', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-c:sec-c', 'http://127.0.0.1:3202'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, `exactly a succeeded (actual ${fulfilled.length})`);
    assert.equal(rejected.length, 2, 'the rest explicit reject');
    for (const r of rejected) {
      assert.equal(r.status, 'rejected');
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      assert.match(message, /already bind set node|concurrency bind set conflict/, `reject reason should explicit:${message}`);
    }
    // identity = unique succeeded, and without lock leftover
    const identity = await readNodeIdentity(dir);
    assert.ok(identity !== null);
    assert.ok(['race-a', 'race-b', 'race-c'].includes(identity.nodeId));
    assert.equal(fulfilled[0]?.status === 'fulfilled' && fulfilled[0].value.nodeId, identity.nodeId);
    const lockExists = await fs.stat(path.join(dir, 'node.json.lock')).then(
      () => true,
      () => false,
    );
    assert.equal(lockExists, false, 'lock file must clean up');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. createNodeDaemon reference validate + shellEnv PATH pre- managed helm bin
// ---------------------------------------------------------------------------

test('createNodeDaemon reject broken identity / broken hubUrl', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-badopts-');
  try {
    await assert.rejects(
      createNodeDaemon({ hubUrl: 'http://127.0.0.1:3202', identity: { nodeId: 'local', token: 'x' }, dataDir: dir }),
      /identity illegal/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'http://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s', hubUrl: 'http://u:p@h' },
        dataDir: dir,
      }),
      /identity illegal/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'ftp://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s' },
        dataDir: dir,
      }),
      /protocol must is http/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveManagedHelmBinDir:workspace can locate and contains can execute helm', { timeout: 60_000 }, async () => {
  const resolved = await resolveManagedHelmBinDir();
  assert.ok('dir' in resolved, `should can locate managed helm bin(result:${JSON.stringify(resolved)})`);
  if ('dir' in resolved) {
    const entry = path.join(resolved.dir, process.platform === 'win32' ? 'helm.cmd' : 'helm');
    await fs.access(entry);
  }
  // explicit broken directory: explicit diagnose while non- false succeeded
  const bad = await resolveManagedHelmBinDir(path.join(os.tmpdir(), 'helm-no-such-bin-dir'));
  assert.ok('error' in bad && bad.error.length > 0, 'broken directory must explicit diagnose');
});

test('daemon shellEnv PATH pre- managed helm bin(remote bash can run helm)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-helmpath-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'hp-1', token: 'hp-1:sec' },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'pre- bin failed to parse will leads to failed to start');
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined);
    // remote bash directly run helm:PATH pre- managed bin must hit (--help no need to Hub).
    const output = await rpc!.envExec({
      execId: 'helm-path-2',
      command: 'command -v helm && helm --help >/dev/null && echo helm-runs',
      timeout: 60,
    });
    assert.equal(output.ok, true, output.ok ? '' : output.error.message);
    // environment variable carry the node actual hubUrl / dataDir
    const envProbe = await rpc!.envExec({
      execId: 'helm-path-3',
      command: 'echo hub=$HELM_HUB_URL data=$HELM_DATA_DIR',
      timeout: 30,
    });
    assert.equal(envProbe.ok, true, envProbe.ok ? '' : envProbe.error.message);
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('daemon child process env:HELM_HUB_URL is node actual hubUrl', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-env-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'env-1', token: 'env-1:sec' },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined);
    const r = await rpc!.envExec({ execId: 'env-echo', command: 'echo hub=$HELM_HUB_URL', timeout: 30 });
    assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
