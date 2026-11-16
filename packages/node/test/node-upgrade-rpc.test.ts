/**
 * daemon upgrade RPC connect line behavior test (engine upgrader.ts itself by node-upgrade.test.ts override):
 * - env server draining gate:guard entry sync subject to register (already subject to not spawn counter),
 *   new command reject,pendingActivation inherit;
 * - RPC reference strictly boundary: illegal object/unknown field/broken type/non- subject to message registry reject and error code keep;
 * - without prepareUpgradeReplacement:checkUpgrade still available,upgrade explicit not_supported do not fabricate;
 * - register on report real run version and upgradeAttemptId;
 * - upgrade succeeded:draining takes effect → commit → onUpgradeReplaced → reconnect paused;
 * - same version without operation:flags/gate/reconnect restore; failed rollback: restore and can reconnect execute command;
 * - commit not confirm (cause chain): keep draining wait for host exit, do not rollback;
 * - concurrency/invalid input after busy and can retry semantics;close after reject new upgrade;
 * - confirmUpgrade: choose identity for account (attemptId/version/pid), idempotent, immediately heartbeat carry commit,
 *   reconnect after commit continuous retry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import process from 'node:process';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeHeartbeatInput,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helm/protocol';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';
import { createNodeDaemon } from '../src/daemon/index.js';
import {
  UpgradeCommitUnconfirmedError,
  getNodeVersion,
  readCurrentRelease,
  readBlockedRelease,
  type PreparedNodeReplacement,
  type StagedNodeRelease,
} from '../src/daemon/upgrader.js';

/** polling wait for can observe condition into establish (alternative fixed sleep), timeout explicit failed. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out:${what}` });

// ---------------------------------------------------------------------------
// 1. env server draining gate and exec counter (guard entry subject to)
// ---------------------------------------------------------------------------

test('setDraining(true) sync reject new envExec;false restore; in-flight do not subject to affect', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const slow = server.envExec({ execId: 'e-slow', command: 'sleep 1', timeout: 30 });
    await delay(150);
    assert.equal(server.getActiveExecCount(), 1, 'already subject to not complete exec count getActiveExecCount');

    server.setDraining(true);
    const rejected = await server.envExec({ execId: 'e-new', command: 'echo hi', timeout: 10 });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, 'node_draining');

    const done = await slow;
    assert.equal(done.ok, true);
    assert.equal(server.getActiveExecCount(), 0);

    server.setDraining(false);
    const ok = await server.envExec({ execId: 'e-again', command: 'echo hi', timeout: 10 });
    assert.equal(ok.ok, true);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('guard entry sync register: invoke return when already subject to not spawn also count counter; subject to after setDraining does not affect the invoke', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-count-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const jobs = [1, 2, 3].map((i) => server.envExec({ execId: `e-${i}`, command: 'sleep 0.3', timeout: 30 }));
    // do not etc. any latency:guard entry sync register, immediately counter 3(contains not yet spawn )
    assert.equal(server.getActiveExecCount(), 3);
    // already subject to invoke do not because after draining by refuse: normal complete
    server.setDraining(true);
    const results = await Promise.all(jobs);
    assert.equal(results.every((r) => r.ok), true, 'already subject to command do not subject to after continue draining affect');
    assert.equal(server.getActiveExecCount(), 0);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Hub fixture(version / upgradeAttemptId / heartbeat commit assertion)
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  port: number;
  registrations: NodeRegisterInput[];
  /** heartbeat reference (contains upgradeCommit complete input). */
  heartbeatInputs: NodeHeartbeatInput[];
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  close(): Promise<void>;
}

async function startHubFixture(options: { expectedToken: string; heartbeatMs?: number; port?: number }): Promise<HubFixture> {
  const registrations: NodeRegisterInput[] = [];
  const heartbeatInputs: NodeHeartbeatInput[] = [];
  let nodeRpc: BirpcReturn<NodeEnvRpcFunctions, NodeHubLocal> | undefined;
  let pendingSocket: WebSocket | undefined;

  interface NodeHubLocal {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
    heartbeat(nodeId: string, input?: NodeHeartbeatInput): boolean;
    onEnvExecOutput(event: EnvExecOutputEvent): void;
  }
  const local: NodeHubLocal = {
    async register(input) {
      registrations.push(input);
      if (input.token !== options.expectedToken) return { ok: false, heartbeatMs: 0, reason: 'invalid token' };
      return { ok: true, heartbeatMs: options.heartbeatMs ?? 15_000 };
    },
    heartbeat(nodeId, input) {
      void nodeId;
      if (input !== undefined) heartbeatInputs.push(input);
      return true;
    },
    onEnvExecOutput() {
      // this test do not consume streaming output
    },
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const dispatchers: Array<(data: unknown) => void> = [];
      nodeRpc = createBirpc<NodeEnvRpcFunctions, NodeHubLocal>(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          dispatchers.push(callback as (data: unknown) => void);
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== 'object') return;
        for (const dispatch of dispatchers) {
          try {
            dispatch(parsed);
          } catch {
            // ignore single layer failed
          }
        }
      });
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const port = typeof address === 'object' && 'port' in address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registrations,
    heartbeatInputs,
    nodeRpc: () => nodeRpc,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

/** managed host replace body: real invoke createNodeDaemon and provide prepareUpgradeReplacement. */
interface HostStub {
  daemon: Awaited<ReturnType<typeof createNodeDaemon>>;
  prepareCalls: { release: StagedNodeRelease; context: { attemptId: string; previousVersion: string; targetVersion: string } }[];
  commitCalls: number;
  abortCalls: number;
  replacedPids: number[];
  /** behavior switch:commit first etc. commitHold(busy test suspended use) again throw commitError. */
  behavior: { commitError?: Error; commitHold?: Promise<void> };
}

async function startManagedDaemon(options: {
  hubUrl: string;
  dataDir: string;
  nodeId?: string;
  upgradeAttemptId?: string;
  pendingActivation?: boolean;
  withPrepare: boolean;
}): Promise<HostStub> {
  const stub: HostStub = {
    daemon: undefined as never,
    prepareCalls: [],
    commitCalls: 0,
    abortCalls: 0,
    replacedPids: [],
    behavior: {},
  };
  stub.daemon = await createNodeDaemon({
    hubUrl: options.hubUrl,
    identity: { nodeId: options.nodeId ?? 'up-a', token: 'up-a:secret-a' },
    dataDir: options.dataDir,
    reconnectBaseDelayMs: 60,
    reconnectMaxDelayMs: 250,
    ...(options.withPrepare
      ? {
          prepareUpgradeReplacement: async (release, context) => {
            stub.prepareCalls.push({ release, context });
            const replacement: PreparedNodeReplacement = {
              pid: 424242,
              async commit() {
                stub.commitCalls += 1;
                if (stub.behavior.commitHold) await stub.behavior.commitHold;
                if (stub.behavior.commitError) throw stub.behavior.commitError;
              },
              async abort() {
                stub.abortCalls += 1;
              },
            };
            return replacement;
          },
        }
      : {}),
    onUpgradeReplaced: (pid) => {
      stub.replacedPids.push(pid);
    },
    ...(options.upgradeAttemptId !== undefined ? { upgradeAttemptId: options.upgradeAttemptId } : {}),
    ...(options.pendingActivation !== undefined ? { pendingActivation: options.pendingActivation } : {}),
  });
  return stub;
}

/** publish placement real staged release structure (.complete at version, supply cache re- use validate). */
async function seedStagedRelease(dataDir: string, version: string): Promise<void> {
  const versionRoot = path.join(dataDir, 'releases', version);
  const candidate = path.join(versionRoot, 'seeded');
  await fs.mkdir(path.join(candidate, 'node_modules', '@helm', 'node', 'dist'), { recursive: true });
  await fs.mkdir(path.join(candidate, 'node_modules', '.bin'), { recursive: true });
  const entryPath = path.join(candidate, 'node_modules', '@helm', 'node', 'dist', 'cli.js');
  await fs.writeFile(entryPath, '#!/usr/bin/env node\n');
  await fs.writeFile(
    path.join(candidate, 'node_modules', '@helm', 'node', 'package.json'),
    JSON.stringify({ name: '@helm/node', version }),
  );
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({
      version,
      candidateDir: candidate,
      entryPath,
      cliBinDir: path.join(candidate, 'node_modules', '.bin'),
      completedAt: new Date().toISOString(),
      origin: 'extractor',
    }),
  );
}

/** polling wait for envExec by draining reject (upgrade engine enter arrange empty when point uncertain). */
async function waitUntilDraining(rpc: BirpcReturn<NodeEnvRpcFunctions, object>, tag: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastCode = '';
  for (let i = 0; Date.now() < deadline; i += 1) {
    const r = await rpc.envExec({ execId: `probe-${tag}-${i}`, command: 'echo hi', timeout: 10 });
    if (!r.ok && r.error.code === 'node_draining') return;
    lastCode = r.ok ? 'ok' : r.error.code;
    await delay(100);
  }
  assert.fail(`arrange empty gate not takes effect (finally state ${lastCode})`);
}

// ---------------------------------------------------------------------------
// 3. without prepareUpgradeReplacement:checkUpgrade available / upgrade not_supported
// ---------------------------------------------------------------------------

test('without host:checkUpgrade still available (real registry query),upgrade explicit not_supported', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-noprep-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    // check update independent of replace host (HELM_NPM_PACKAGE points to real store in public package)
    process.env.HELM_NPM_PACKAGE = 'eslint';
    const check = await stub.daemon.checkUpgrade();
    assert.ok(check.currentVersion.length > 0);
    assert.ok(check.latestVersion.length > 0);
    // upgrade explicit reject (carries code  Error), do not fabricate
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: '1.0.0', force: true }),
      (error: Error & { code?: string }) => error.code === 'not_supported',
    );
    assert.equal(stub.daemon.isUpgrading(), false);
    // RPC path return RpcResult error message seal
    const rpc = hub.nodeRpc();
    assert.ok(rpc?.nodeUpgrade !== undefined, 'outside layer RPC should hang nodeUpgrade');
    const rpcUp = await rpc!.nodeUpgrade!({ targetVersion: '1.0.0' });
    assert.equal(rpcUp.ok, false);
    assert.equal(!rpcUp.ok && rpcUp.error.code, 'not_supported');
    // RPC checkUpgrade same available
    const rpcCheck = await rpc!.nodeCheckUpgrade!({});
    assert.equal(rpcCheck.ok, true, `RPC checkUpgrade should succeeded:${!rpcCheck.ok && rpcCheck.error.message}`);
  } finally {
    delete process.env.HELM_NPM_PACKAGE;
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. register on report real version and upgradeAttemptId
// ---------------------------------------------------------------------------

test('register on report getNodeVersion() and options.upgradeAttemptId', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-regver-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({
    hubUrl: hub.url,
    dataDir: dir,
    withPrepare: false,
    upgradeAttemptId: 'att-reg-1',
  });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    const reg = hub.registrations[0];
    assert.ok(reg !== undefined);
    assert.equal(reg?.version, getNodeVersion(), 'register should carry real run package version');
    assert.equal(reg?.upgradeAttemptId, 'att-reg-1');
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. RPC reference boundary and registry allows manifest
// ---------------------------------------------------------------------------

test('RPC reference strictly validate: non- object/unknown field/broken type reject and keep invalid;remote registry only allows allows manifest', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-rpcbound-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    const rpc = hub.nodeRpc()!;
    const call = (fn: unknown, input: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
      (fn as (i: unknown) => Promise<{ ok: boolean; error?: { code: string; message: string } }>)(input);

    const badArray = await call(rpc.nodeCheckUpgrade, ['not', 'object']);
    assert.equal(badArray.ok, false);
    assert.equal(badArray.error?.code, 'invalid');
    const badField = await call(rpc.nodeCheckUpgrade, { registryUrl: 'https://registry.npmjs.org', extra: 1 });
    assert.equal(badField.ok, false);
    assert.equal(badField.error?.code, 'invalid');

    // remote non- subject to message registry source reject (filterRpcRegistryUrl blank name single)
    const evil = await call(rpc.nodeUpgrade, { registryUrl: 'https://evil.example.com' });
    assert.equal(evil.ok, false);
    assert.equal(evil.error?.code, 'invalid');
    assert.match(evil.error?.message ?? '', /reject non- subject to message npm registry/);

    const badForce = await call(rpc.nodeUpgrade, { force: 'yes' });
    assert.equal(badForce.ok, false);
    assert.equal(badForce.error?.code, 'invalid');

    // local machine CLI can message invoke (trustedRegistry=true) explicit source enter engine layer (illegal version number by engine reject)
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }, true),
      (error: Error & { code?: string }) => error.code === 'invalid' && /illegal SemVer/.test(error.message),
    );
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. upgrade succeeded:draining → commit → onUpgradeReplaced → reconnect paused
// ---------------------------------------------------------------------------

test('upgrade succeeded path: arrange empty gate takes effect,commit unique commit point, host let call back, paused reconnect', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-upok-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  await seedStagedRelease(dir, '9.9.9');
  const rpc = hub.nodeRpc()!;

  const upgrading = rpc.nodeUpgrade!({ targetVersion: '9.9.9', attemptId: 'att-ok-1' });
  await waitUntilDraining(rpc, 'ok');

  const result = await upgrading;
  assert.equal(result.ok, true, `upgrade should succeeded:${!result.ok && result.error.message}`);
  assert.equal(result.ok && result.value.upgraded, true);
  assert.equal(result.ok && result.value.pid, 424242);
  assert.equal(result.ok && result.value.targetVersion, '9.9.9');

  assert.equal(stub.prepareCalls.length, 1);
  assert.equal(stub.commitCalls, 1);
  assert.equal(stub.abortCalls, 0);
  assert.equal(stub.prepareCalls[0]?.context.attemptId, 'att-ok-1');

  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '9.9.9');

  assert.deepEqual(stub.replacedPids, [424242]);
  assert.equal(stub.daemon.isUpgrading(), true, 'committed await exit,isUpgrading keep true');

  // upgrade committed: after disconnect old daemon must not reconnect (wait for host exit)
  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  await delay(500);
  assert.equal(hub2.registrations.length, 0, 'upgrade after commit old daemon must not reconnect');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 7. same version without operation:flags/gate/reconnect restore
// ---------------------------------------------------------------------------

test('upgrade same version without operation (upgraded:false): restore flags/gate and keep can reconnect', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-upnoop-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // target = when before run version and do not force: engine directly return upgraded:false(without stage without network)
  const result = await stub.daemon.upgrade({ targetVersion: getNodeVersion() });
  assert.equal(result.upgraded, false);
  assert.equal(result.ok, true);
  assert.equal(stub.daemon.isUpgrading(), false, 'without operation after must not keep busy');
  assert.equal(stub.prepareCalls.length, 0);
  assert.equal(stub.replacedPids.length, 0);

  // gate already restore: command can execute; after disconnect can reconnect
  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'noop-1', command: 'echo still-alive', timeout: 10 });
  assert.equal(exec.ok, true, `without operation after command should can execute:${!exec.ok && exec.error.message}`);

  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub2.registrations.length === 0) await delay(200);
  assert.equal(hub2.registrations.length, 1, 'without operation after should stay reconnect capability');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 8. failed to upgrade:gate and reconnect restore
// ---------------------------------------------------------------------------

test('upgrade failed rollback: solve except gate, restore reconnect, reconnect after new server gate restore subject to', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-upfail-');
  let hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  const port = hub.port;

  await seedStagedRelease(dir, '8.8.8');
  stub.behavior.commitError = new Error('candidate register failed at hub');

  await hub.close();
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '8.8.8', attemptId: 'att-fail-1' }),
    (error: Error & { code?: string }) => /already rollback/.test(error.message),
  );

  assert.equal(stub.abortCalls, 1, 'failed path abort choose');
  assert.equal(stub.daemon.isUpgrading(), false);
  assert.equal((await readCurrentRelease(dir))?.version, undefined, 'without since has current: failed after delete');
  assert.equal((await readBlockedRelease(dir))?.version, '8.8.8');

  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
  assert.equal(hub.registrations.length, 1, 'failed after should restore reconnect');

  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'after-fail', command: 'echo recovered', timeout: 10 });
  assert.equal(exec.ok, true, `failed rollback after new command should can execute:${!exec.ok && exec.error.message}`);
  await hub.close();
});

// ---------------------------------------------------------------------------
// 9. commit not confirm: keep draining, do not rollback, host let
// ---------------------------------------------------------------------------

test('UpgradeCommitUnconfirmedError(contains cause chain): do not rollback, keep gate, host let', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-upunconf-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  await seedStagedRelease(dir, '7.7.7');
  // engine UpgradeCommitUnconfirmedError package into ordinary Error(cause keep original error),
  // daemon side must along cause chain identify is commit not confirm while non- ordinary failed.
  stub.behavior.commitError = new UpgradeCommitUnconfirmedError('hub ack timeout');

  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '7.7.7', attemptId: 'att-unc-1' }),
    (error: Error) => /activate result not confirm/.test(error.message),
  );

  assert.equal((await readCurrentRelease(dir))?.version, '7.7.7', 'do not rollback:current points to new version');
  assert.equal(stub.abortCalls, 0);
  assert.deepEqual(stub.replacedPids, [424242]);
  assert.equal(stub.daemon.isUpgrading(), true, 'commit not confirm keep let wait for host exit');
});

// ---------------------------------------------------------------------------
// 10. concurrency busy / invalid input after can retry / close after reject
// ---------------------------------------------------------------------------

test('concurrency upgrade reject busy(different target do not sharing result); invalid input after can again invoke;close after reject', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-busy-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  await seedStagedRelease(dir, '9.9.9');
  await seedStagedRelease(dir, '8.8.8');

  // in-flight upgrade (8.8.8):commit suspended until let through (then throw failed away rollback).
  let releaseHold: (() => void) | undefined;
  stub.behavior.commitHold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let firstSettled = false;
  const first = stub.daemon.upgrade({ targetVersion: '8.8.8', attemptId: 'att-busy-1' }).then(
    (value) => {
      firstSettled = true;
      return value;
    },
    (error: Error) => {
      firstSettled = true;
      throw error;
    },
  );
  await waitUntilDraining(hub.nodeRpc()!, 'busy');

  // concurrency different target:busy invalid, never re- use in-flight result
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid' && /busy/.test(error.message),
  );
  assert.equal(firstSettled, false, 'a upgrade still in-flight');

  // let through failed: a rollback set after can again invoke (invalid input do not forever long cache busy)
  stub.behavior.commitError = new Error('candidate register failed at hub');
  releaseHold!();
  await assert.rejects(() => first, (error: Error) => /already rollback/.test(error.message));
  assert.equal(stub.daemon.isUpgrading(), false);

  // invalid input fast failed after again tune invalid input: still can tune (without cache busy)
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }),
      (error: Error & { code?: string }) => error.code === 'invalid',
    );
  }

  // close after reject new upgrade
  await stub.daemon.close();
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// 11. pendingActivation choose: create i.e. draining,confirmUpgrade identity for account and solve except
// ---------------------------------------------------------------------------

test('choose pendingActivation: create i.e. refuse new command;confirmUpgrade identity for account after solve except and immediately on report commit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-pending-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 300 });
  const stub = await startManagedDaemon({
    hubUrl: hub.url,
    dataDir: dir,
    withPrepare: false,
    pendingActivation: true,
    upgradeAttemptId: 'att-pend-1',
  });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  const rpc = hub.nodeRpc()!;

  const rejected = await rpc.envExec({ execId: 'pend-1', command: 'echo hi', timeout: 10 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'node_draining');

  // identity for account:attemptId / version / pid any one does not match i.e. reject and gate do not solve except
  const pid = process.pid;
  const version = getNodeVersion();
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'wrong-att', version, previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version: '0.0.0', previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid: 12345 }));
  const stillDrained = await rpc.envExec({ execId: 'pend-2', command: 'echo hi', timeout: 10 });
  assert.equal(stillDrained.ok, false, 'for account failed must not solve except gate');

  // correct commit:resolve, immediately heartbeat carry upgradeCommit,gate solve except
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });
  await waitFor(() => hub.heartbeatInputs.some((input) => input.upgradeCommit !== undefined), 10_000, 'heartbeat carry upgradeCommit');
  const commits = hub.heartbeatInputs.filter((input) => input.upgradeCommit !== undefined);
  assert.ok(commits.length >= 1, 'confirmUpgrade after should immediately/then heartbeat carry upgradeCommit');
  assert.equal(commits[0]?.upgradeCommit?.attemptId, 'att-pend-1');
  assert.equal(commits[0]?.upgradeCommit?.pid, pid);

  const ok = await rpc.envExec({ execId: 'pend-3', command: 'echo hi', timeout: 10 });
  assert.equal(ok.ok, true, `confirmUpgrade after should restore subject to:${!ok.ok && ok.error.message}`);

  // duplicate the same commit idempotent
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });

  // parameter illegal directly throw
  await assert.rejects(() => stub.daemon.confirmUpgrade({ attemptId: '', version: '1', previousVersion: '0', pid: -1 }));
});

// ---------------------------------------------------------------------------
// 12. disconnection reconnect after commit in memory keep and continuous retry
// ---------------------------------------------------------------------------

test('disconnection reconnect after,commit in memory keep and in new connect heartbeat retry', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-commitretry-');
  let hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 300 });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // non- choose daemon  confirmUpgrade does not identity for account (ordinary heartbeat on report path)
  await stub.daemon.confirmUpgrade({ attemptId: 'att-retry-1', version: '5.5.5', previousVersion: '5.5.4', pid: 777 });
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    'first time heartbeat carry commit',
  );
  assert.ok(hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'));

  await hub.close();
  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 300, port: hub.port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
  assert.equal(hub.registrations.length, 1, 'should reconnect succeeded');
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    'reconnect after heartbeat continue carry commit',
  );
  const retried = hub.heartbeatInputs.filter((input) => input.upgradeCommit?.attemptId === 'att-retry-1');
  assert.ok(retried.length >= 1, 'reconnect after heartbeat should continue carry commit');
  await hub.close();
});
