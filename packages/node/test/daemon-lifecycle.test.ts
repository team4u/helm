/**
 * `daemon/index.ts` lifecycle regression tests (real HTTP+WS+birpc and real temp dirs, no mocking):
 * - Reconnects cleanly after initial connection failure (delayed Hub startup);
 * - `waitUntilRegistered` never fabricates success while offline (false offline, true after reconnect);
 * - At most one active connection during repeated `register` rejections;
 * - Keeps event loop alive across offline backoff reconnects (no unref timer leaks);
 * - `close()` waits for active generation cleanup (kills remote `envExec` child processes first);
 * - Rejects invalid identity / token / hubUrl explicitly without falling back to stale identity;
 * - At most one concurrent `bindIdentityFromJoinToken` succeeds per process (in-process lock);
 * - `shellEnv` prepends managed `helmx` bin dir onto `PATH` (remote bash can run `helmx`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sleep as delay } from '@helmx/test-kit';
import { makeTempDir as tempDir } from '@helmx/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helmx/protocol';
import {
  bindIdentityFromJoinToken,
  createNodeDaemon,
  parseJoinToken,
  readNodeIdentity,
  resolveManagedHelmxBinDir,
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

/**
 * Waits for reconnect registration to succeed within budget, tolerating an in-flight attempt
 * started before the server switched to accept settling false via confirmOffline().
 */
async function waitUntilReconnected(
  daemon: { waitUntilRegistered(timeoutMs?: number): Promise<boolean> },
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (await daemon.waitUntilRegistered(remaining)) return true;
    await delay(10);
  }
  return false;
}

interface HubHandle {
  url: string;
  port: number;
  registrations: NodeRegisterInput[];
  /** Cumulative accepted WebSocket upgrades. */
  connections: number;
  /** Currently open sockets accepted by the Hub. */
  openSockets: Set<WebSocket>;
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  /** Force-disconnect all connected node sockets. */
  disconnectAll(): void;
  close(): Promise<void>;
  /** Override register or heartbeat replies dynamically. */
  setBehavior(behavior: {
    registerAck?: (input: NodeRegisterInput) => NodeRegisterResult;
    heartbeat?: (nodeId: string) => boolean;
  }): void;
}

/** Real http.Server + WebSocketServer + birpc Hub gateway matching `/ws/node`. */
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
              // Tolerate occasional noisy frames in test Hub fixture.
            }
          });
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      // On socket close, reject all in-flight RPC calls promptly like real Hub.
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
// 1. Initial connection failure -> backoff reconnect succeeds
// ---------------------------------------------------------------------------

test('reconnects after initial connection failure when Hub starts late', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-firstfail-');
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
    // Hub not listening yet: initial connect and early retries fail without exiting/crashing daemon.
    await delay(300);
    assert.equal(daemon.isConnected(), false, 'should report offline while Hub is down');
    assert.equal(await daemon.waitUntilRegistered(50), false, 'wait must not fabricate success while offline');

    // Start Hub: backoff retry should register successfully.
    hub = await startHub({ port, heartbeatMs: 15_000 });
    const ok = await waitUntilReconnected(daemon, 15_000);
    assert.equal(ok, true, `should reconnect and register after Hub starts (logs: ${logs.join(' | ')})`);
    assert.equal(daemon.isConnected(), true);
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'ff-1');

    // Subsequent waits resolve true immediately while online
    assert.equal(await daemon.waitUntilRegistered(1_000), true);
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. waitUntilRegistered stays false after disconnect, flips true after reconnect
// ---------------------------------------------------------------------------

test('waitUntilRegistered returns false after disconnect and flips true on reconnect', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-wait-');
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

    // Disconnect + reject subsequent registrations: wait must explicitly return false while offline.
    hub.setBehavior({ registerAck: () => ({ ok: false, heartbeatMs: 0, reason: 'maintenance' }) });
    hub.disconnectAll();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && daemon.isConnected()) await delay(50);
    assert.equal(daemon.isConnected(), false, 'should report disconnected after drop');
    assert.equal(await daemon.waitUntilRegistered(300), false, 'wait must not fabricate success while offline/rejected');

    // Server accepts again: new wait turns true after re-registration (rejection is not cached).
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    const ok = await waitUntilReconnected(daemon, 15_000);
    assert.equal(ok, true, 'wait should flip true after reconnect registration');
    assert.equal(daemon.isConnected(), true);
    assert.ok(hub.registrations.length > registrationsBefore, 'multiple registration attempts recorded (initial + reconnect)');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Repeated rejections: keep at most one concurrent connection
// ---------------------------------------------------------------------------

test('keeps at most one connection during repeated register rejections', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-reject-');
  const hub = await startHub({ heartbeatMs: 15_000, rejectAll: true });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'r-1', token: 'r-1:wrong' },
    dataDir: dir,
    reconnectBaseDelayMs: 30,
    reconnectMaxDelayMs: 100,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(400), false, 'auth rejection must make wait return false');
    // Observe across several retry cycles: at most one node socket on Hub side at any point.
    for (let i = 0; i < 6; i += 1) {
      await delay(50);
      assert.ok(hub.openSockets.size <= 1, `sample ${i} found ${hub.openSockets.size} parallel connections`);
    }
    assert.ok(hub.registrations.length >= 2, 'backoff retries should attempt registration multiple times');
    assert.equal(daemon.isConnected(), false);

    // Switch to accepting: rejections are not cached so recovery registers cleanly.
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    assert.equal(await waitUntilReconnected(daemon, 15_000), true, 'should register once Hub accepts');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Keeps event loop alive across offline backoff reconnects (unref regression)
// ---------------------------------------------------------------------------

test('stays alive across offline backoff reconnects without unref draining the event loop', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-alive-');
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
    // Daemon must remain alive throughout the 900ms offline window (unref'd reconnect timers would
    // drain the event loop and terminate the delay loop below prematurely).
    const start = Date.now();
    let aliveMs = 0;
    while (Date.now() - start < 900) {
      await delay(80);
      aliveMs = Date.now() - start;
      assert.equal(daemon.isConnected(), false);
    }
    assert.ok(aliveMs >= 700, `should stay alive while offline (actual ${aliveMs}ms)`);

    hub = await startHub({ port, heartbeatMs: 15_000 });
    assert.equal(await waitUntilReconnected(daemon, 15_000), true, 'should reconnect once Hub is up');
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. close() awaits active generation cleanup (kills remote exec children)
// ---------------------------------------------------------------------------

test('close awaits generation cleanup (kills active envExec child processes)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-close-');
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
    // Long remote command: close() must terminate child processes and settle RPC with failure (no hang, no replay).
    const pending = rpc!
      .envExec({ execId: 'long-1', command: 'sleep 60', timeout: 120 })
      .catch((error: unknown) => ({ ok: false as const, error: { code: 'closed', message: String(error) } }));
    await delay(250); // Wait for child process to start
    const start = Date.now();
    await daemon.close();
    const closedMs = Date.now() - start;
    assert.ok(closedMs < 15_000, `close should await cleanup within bounded time (actual ${closedMs}ms)`);
    const result = await Promise.race([
      pending,
      new Promise<{ ok: true }>((resolve) => {
        const t = setTimeout(() => resolve({ ok: true }), 8_000);
        t.unref?.();
      }),
    ]);
    assert.equal(result.ok, false, 'in-flight envExec must settle with failure without replaying');
    // close is idempotent
    await daemon.close();
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Rejects invalid identity / token / hubUrl explicitly
// ---------------------------------------------------------------------------

test('readNodeIdentity strictly validates parsed objects (rejects null/arrays/bad fields)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-badid-');
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
    // Valid identity with optional hubUrl passes
    await fs.writeFile(file, JSON.stringify({ nodeId: 'ok-node', token: 'ok-node:sec', hubUrl: 'http://127.0.0.1:3202' }), 'utf8');
    const ok = await readNodeIdentity(dir);
    assert.equal(ok?.nodeId, 'ok-node');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseJoinToken rejects local, whitespace, and control-character tokens', { timeout: 60_000 }, () => {
  assert.equal(parseJoinToken('local:secret'), null, 'local ID must not be used as JOIN nodeId');
  assert.equal(parseJoinToken(' node-1:secret'), null, 'leading whitespace rejected');
  assert.equal(parseJoinToken('node-1:secret '), null, 'trailing whitespace rejected');
  assert.equal(parseJoinToken('node-1:\n'), null, 'control characters in secret rejected');
  assert.equal(parseJoinToken('node-1:sec\x00ret'), null, 'NUL rejected');
  assert.equal(parseJoinToken('local:'), null);
  assert.deepEqual(parseJoinToken('node.9_x:s3c'), { nodeId: 'node.9_x', secret: 's3c' });
});

test('bindIdentityFromJoinToken rejects invalid hubUrl without leaking token', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-bind-');
  try {
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'ftp://x'), /protocol must be http/);
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'http://u:p@x'), /userinfo/);
    // Error message for invalid token must not leak token prefix or secret
    const secret = 'supersecretvalue';
    try {
      await bindIdentityFromJoinToken(dir, `bad id:${secret}`, 'http://127.0.0.1:3202');
      assert.fail('should reject invalid token');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes('bad id'.slice(0, 4)), `error must not leak token prefix: ${message}`);
      assert.ok(!message.includes(secret), `error must not leak secret: ${message}`);
    }
    assert.equal(await readNodeIdentity(dir), null, 'failed bind must not write identity');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeNodeIdentity validates inputs and rejects invalid identities', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-write-');
  try {
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'local', token: 'x' }), /invalid node identity/);
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'n', token: '' }), /invalid node identity/);
    await assert.rejects(
      writeNodeIdentity(dir, { nodeId: 'n', token: 'n:s', hubUrl: 'javascript:alert(1)' }),
      /invalid node identity/,
    );
    assert.equal(await readNodeIdentity(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Concurrent bind: at most one distinct nodeId succeeds
// ---------------------------------------------------------------------------

test('concurrent bindIdentityFromJoinToken with distinct nodeIds succeeds for exactly one caller', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-race-');
  try {
    const results = await Promise.allSettled([
      bindIdentityFromJoinToken(dir, 'race-a:sec-a', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-b:sec-b', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-c:sec-c', 'http://127.0.0.1:3202'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, `exactly one call should succeed (actual ${fulfilled.length})`);
    assert.equal(rejected.length, 2, 'remaining calls must fail explicitly');
    for (const r of rejected) {
      assert.equal(r.status, 'rejected');
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      assert.match(message, /already bound to node|concurrent identity bind conflict/, `rejection reason should be explicit: ${message}`);
    }
    // Persisted identity belongs to the sole winner, with no stale lock left behind
    const identity = await readNodeIdentity(dir);
    assert.ok(identity !== null);
    assert.ok(['race-a', 'race-b', 'race-c'].includes(identity.nodeId));
    assert.equal(fulfilled[0]?.status === 'fulfilled' && fulfilled[0].value.nodeId, identity.nodeId);
    const lockExists = await fs.stat(path.join(dir, 'node.json.lock')).then(
      () => true,
      () => false,
    );
    assert.equal(lockExists, false, 'lock file must be cleaned up');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. createNodeDaemon input validation + shellEnv prepending managed helmx bin
// ---------------------------------------------------------------------------

test('createNodeDaemon rejects invalid identity or hubUrl', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-badopts-');
  try {
    await assert.rejects(
      createNodeDaemon({ hubUrl: 'http://127.0.0.1:3202', identity: { nodeId: 'local', token: 'x' }, dataDir: dir }),
      /invalid node identity/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'http://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s', hubUrl: 'http://u:p@h' },
        dataDir: dir,
      }),
      /invalid node identity/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'ftp://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s' },
        dataDir: dir,
      }),
      /protocol must be http/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveManagedHelmxBinDir locates workspace bin dir containing executable helmx', { timeout: 60_000 }, async () => {
  const resolved = await resolveManagedHelmxBinDir();
  assert.ok('dir' in resolved, `should locate managed helmx bin (result: ${JSON.stringify(resolved)})`);
  if ('dir' in resolved) {
    const entry = path.join(resolved.dir, process.platform === 'win32' ? 'helmx.cmd' : 'helmx');
    await fs.access(entry);
  }
  // Explicitly bad directory returns explicit diagnostics instead of false success
  const bad = await resolveManagedHelmxBinDir(path.join(os.tmpdir(), 'helmx-no-such-bin-dir'));
  assert.ok('error' in bad && bad.error.length > 0, 'invalid directory must produce explicit diagnostic');
});

test('daemon shellEnv prepends managed helmx bin to PATH (remote bash can run helmx)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-helmxpath-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'hp-1', token: 'hp-1:sec' },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'prepended bin resolution failure prevents startup');
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined);
    // Remote bash runs helmx directly: prepended managed bin on PATH must resolve (--help needs no Hub).
    const output = await rpc!.envExec({
      execId: 'helmx-path-2',
      command: 'command -v helmx && helmx --help >/dev/null && echo helmx-runs',
      timeout: 60,
    });
    assert.equal(output.ok, true, output.ok ? '' : output.error.message);
    // Environment carries the node's actual hubUrl / dataDir
    const envProbe = await rpc!.envExec({
      execId: 'helmx-path-3',
      command: 'echo hub=$HELMX_HUB_URL data=$HELMX_DATA_DIR',
      timeout: 30,
    });
    assert.equal(envProbe.ok, true, envProbe.ok ? '' : envProbe.error.message);
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('daemon child process env sets HELMX_HUB_URL to node actual hubUrl', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-dlc-env-');
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
    const r = await rpc!.envExec({ execId: 'env-echo', command: 'echo hub=$HELMX_HUB_URL', timeout: 30 });
    assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
