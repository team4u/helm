/**
 * daemon 升级 RPC 接线行为测试（引擎 upgrader.ts 本身由 node-upgrade.test.ts 覆盖）：
 * - env server draining gate：guard 入口同步受理登记（已受理未 spawn 计数）、
 *   新命令拒绝、pendingActivation 继承；
 * - RPC 入参严格边界：非法对象/未知字段/坏类型/非受信 registry 拒绝且错误码保留；
 * - 无 prepareUpgradeReplacement：checkUpgrade 仍可用、upgrade 明确 not_supported 不伪造；
 * - register 上报真实运行版本与 upgradeAttemptId；
 * - 升级成功：draining 生效 → commit → onUpgradeReplaced → 重连暂停；
 * - 同版本无操作：flags/gate/重连恢复；失败回滚：恢复并可重连执行命令；
 * - 提交未确认（cause 链）：保持 draining 等待宿主退出、不回滚；
 * - 并发/非法输入后 busy 与可重试语义；close 后拒绝新升级；
 * - confirmUpgrade：候选身份对账（attemptId/version/pid）、幂等、立即心跳携带 commit、
 *   重连后 commit 持续重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import process from 'node:process';
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待可观察条件成立（替代固定 sleep），超时显式失败。 */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(20);
  }
  assert.ok(await condition(), `等待超时：${what}`);
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. env server draining gate 与 exec 计数（guard 入口受理）
// ---------------------------------------------------------------------------

test('setDraining(true) 同步拒绝新 envExec；false 恢复；在途不受影响', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const slow = server.envExec({ execId: 'e-slow', command: 'sleep 1', timeout: 30 });
    await delay(150);
    assert.equal(server.getActiveExecCount(), 1, '已受理未完成的 exec 计入 getActiveExecCount');

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

test('guard 入口同步登记：调用返回时已受理未 spawn 也计入计数；受理后 setDraining 不影响该调用', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-count-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const jobs = [1, 2, 3].map((i) => server.envExec({ execId: `e-${i}`, command: 'sleep 0.3', timeout: 30 }));
    // 不等任何延迟：guard 入口同步登记，立即计数 3（含尚未 spawn 的）
    assert.equal(server.getActiveExecCount(), 3);
    // 已受理的调用不因之后的 draining 被拒：正常完成
    server.setDraining(true);
    const results = await Promise.all(jobs);
    assert.equal(results.every((r) => r.ok), true, '已受理命令不受后续 draining 影响');
    assert.equal(server.getActiveExecCount(), 0);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Hub fixture（version / upgradeAttemptId / heartbeat commit 断言）
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  port: number;
  registrations: NodeRegisterInput[];
  /** heartbeat 入参（含 upgradeCommit 的完整 input）。 */
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
      // 本测试不消费流式输出
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
            // 忽略单层失败
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

/** 受管宿主替身：真实调用 createNodeDaemon 并提供 prepareUpgradeReplacement。 */
interface HostStub {
  daemon: Awaited<ReturnType<typeof createNodeDaemon>>;
  prepareCalls: { release: StagedNodeRelease; context: { attemptId: string; previousVersion: string; targetVersion: string } }[];
  commitCalls: number;
  abortCalls: number;
  replacedPids: number[];
  /** 行为开关：commit 先等 commitHold（busy 测试挂起用）再抛 commitError。 */
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

/** 布置真实 staged release 结构（.complete 位于版本根，供缓存复用校验）。 */
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

/** 轮询等待 envExec 被 draining 拒绝（升级引擎进入排空的时点不确定）。 */
async function waitUntilDraining(rpc: BirpcReturn<NodeEnvRpcFunctions, object>, tag: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastCode = '';
  for (let i = 0; Date.now() < deadline; i += 1) {
    const r = await rpc.envExec({ execId: `probe-${tag}-${i}`, command: 'echo hi', timeout: 10 });
    if (!r.ok && r.error.code === 'node_draining') return;
    lastCode = r.ok ? 'ok' : r.error.code;
    await delay(100);
  }
  assert.fail(`排空 gate 未生效（最后状态 ${lastCode}）`);
}

// ---------------------------------------------------------------------------
// 3. 无 prepareUpgradeReplacement：checkUpgrade 可用 / upgrade not_supported
// ---------------------------------------------------------------------------

test('无宿主：checkUpgrade 仍可用（真实 registry 查询），upgrade 明确 not_supported', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-noprep-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    // 检查更新不依赖替换宿主（HELM_NPM_PACKAGE 指向真实存在的公共包）
    process.env.HELM_NPM_PACKAGE = 'eslint';
    const check = await stub.daemon.checkUpgrade();
    assert.ok(check.currentVersion.length > 0);
    assert.ok(check.latestVersion.length > 0);
    // 升级明确拒绝（带 code 的 Error），不伪造
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: '1.0.0', force: true }),
      (error: Error & { code?: string }) => error.code === 'not_supported',
    );
    assert.equal(stub.daemon.isUpgrading(), false);
    // RPC 路径返回 RpcResult 错误信封
    const rpc = hub.nodeRpc();
    assert.ok(rpc?.nodeUpgrade !== undefined, '外层 RPC 应挂 nodeUpgrade');
    const rpcUp = await rpc!.nodeUpgrade!({ targetVersion: '1.0.0' });
    assert.equal(rpcUp.ok, false);
    assert.equal(!rpcUp.ok && rpcUp.error.code, 'not_supported');
    // RPC checkUpgrade 同样可用
    const rpcCheck = await rpc!.nodeCheckUpgrade!({});
    assert.equal(rpcCheck.ok, true, `RPC checkUpgrade 应成功：${!rpcCheck.ok && rpcCheck.error.message}`);
  } finally {
    delete process.env.HELM_NPM_PACKAGE;
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. register 上报真实版本与 upgradeAttemptId
// ---------------------------------------------------------------------------

test('register 上报 getNodeVersion() 与 options.upgradeAttemptId', { timeout: 60_000 }, async () => {
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
    assert.equal(reg?.version, getNodeVersion(), 'register 应携带真实运行包版本');
    assert.equal(reg?.upgradeAttemptId, 'att-reg-1');
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. RPC 入参边界与 registry 允许清单
// ---------------------------------------------------------------------------

test('RPC 入参严格校验：非对象/未知字段/坏类型拒绝且保留 invalid；remote registry 只允许允许清单', { timeout: 60_000 }, async () => {
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

    // remote 非受信 registry 源拒绝（filterRpcRegistryUrl 白名单）
    const evil = await call(rpc.nodeUpgrade, { registryUrl: 'https://evil.example.com' });
    assert.equal(evil.ok, false);
    assert.equal(evil.error?.code, 'invalid');
    assert.match(evil.error?.message ?? '', /拒绝非受信 npm registry/);

    const badForce = await call(rpc.nodeUpgrade, { force: 'yes' });
    assert.equal(badForce.ok, false);
    assert.equal(badForce.error?.code, 'invalid');

    // 本机 CLI 可信调用（trustedRegistry=true）显式源进入引擎层（非法版本号被引擎拒绝）
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }, true),
      (error: Error & { code?: string }) => error.code === 'invalid' && /非法 SemVer/.test(error.message),
    );
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 升级成功：draining → commit → onUpgradeReplaced → 重连暂停
// ---------------------------------------------------------------------------

test('upgrade 成功路径：排空 gate 生效、commit 唯一提交点、宿主让位回调、暂停重连', { timeout: 60_000 }, async (t) => {
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
  assert.equal(result.ok, true, `升级应成功：${!result.ok && result.error.message}`);
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
  assert.equal(stub.daemon.isUpgrading(), true, '已提交待退出，isUpgrading 保持 true');

  // 升级已提交：断开后旧 daemon 不得重连（等待宿主退出）
  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  await delay(500);
  assert.equal(hub2.registrations.length, 0, '升级提交后旧 daemon 不得重连');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 7. 同版本无操作：flags/gate/重连恢复
// ---------------------------------------------------------------------------

test('upgrade 同版本无操作（upgraded:false）：恢复 flags/gate 并保持可重连', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-upnoop-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // 目标 = 当前运行版本且不 force：引擎直接返回 upgraded:false（无 stage 无网络）
  const result = await stub.daemon.upgrade({ targetVersion: getNodeVersion() });
  assert.equal(result.upgraded, false);
  assert.equal(result.ok, true);
  assert.equal(stub.daemon.isUpgrading(), false, '无操作后不得保持 busy');
  assert.equal(stub.prepareCalls.length, 0);
  assert.equal(stub.replacedPids.length, 0);

  // gate 已恢复：命令可执行；断开后可重连
  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'noop-1', command: 'echo still-alive', timeout: 10 });
  assert.equal(exec.ok, true, `无操作后命令应可执行：${!exec.ok && exec.error.message}`);

  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub2.registrations.length === 0) await delay(200);
  assert.equal(hub2.registrations.length, 1, '无操作后应保持重连能力');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 8. 升级失败：gate 与重连恢复
// ---------------------------------------------------------------------------

test('upgrade 失败回滚：解除 gate、恢复重连、重连后新 server gate 恢复受理', { timeout: 60_000 }, async (t) => {
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
    (error: Error & { code?: string }) => /已回滚/.test(error.message),
  );

  assert.equal(stub.abortCalls, 1, '失败路径 abort 候选');
  assert.equal(stub.daemon.isUpgrading(), false);
  assert.equal((await readCurrentRelease(dir))?.version, undefined, '无既有 current：失败后删除');
  assert.equal((await readBlockedRelease(dir))?.version, '8.8.8');

  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
  assert.equal(hub.registrations.length, 1, '失败后应恢复重连');

  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'after-fail', command: 'echo recovered', timeout: 10 });
  assert.equal(exec.ok, true, `失败回滚后新命令应可执行：${!exec.ok && exec.error.message}`);
  await hub.close();
});

// ---------------------------------------------------------------------------
// 9. 提交未确认：保持 draining、不回滚、宿主让位
// ---------------------------------------------------------------------------

test('UpgradeCommitUnconfirmedError（含 cause 链）：不回滚、保持 gate、宿主让位', { timeout: 60_000 }, async (t) => {
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
  // 引擎把 UpgradeCommitUnconfirmedError 包成普通 Error（cause 保留原错误），
  // daemon 侧须沿 cause 链识别为「提交未确认」而非普通失败。
  stub.behavior.commitError = new UpgradeCommitUnconfirmedError('hub ack timeout');

  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '7.7.7', attemptId: 'att-unc-1' }),
    (error: Error) => /激活结果未确认/.test(error.message),
  );

  assert.equal((await readCurrentRelease(dir))?.version, '7.7.7', '不回滚：current 指向新版本');
  assert.equal(stub.abortCalls, 0);
  assert.deepEqual(stub.replacedPids, [424242]);
  assert.equal(stub.daemon.isUpgrading(), true, '提交未确认保持让位等待宿主退出');
});

// ---------------------------------------------------------------------------
// 10. 并发 busy / 非法输入后可重试 / close 后拒绝
// ---------------------------------------------------------------------------

test('并发升级拒绝 busy（不同目标不共享结果）；非法输入后可再次调用；close 后拒绝', { timeout: 60_000 }, async (t) => {
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

  // 在途升级（8.8.8）：commit 挂起直到放行（然后抛失败走回滚）。
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

  // 并发不同目标：busy invalid，绝不复用在途结果
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid' && /busy/.test(error.message),
  );
  assert.equal(firstSettled, false, '第一个升级仍在途');

  // 放行失败：第一个回滚落定后可再次调用（非法输入不永久缓存 busy）
  stub.behavior.commitError = new Error('candidate register failed at hub');
  releaseHold!();
  await assert.rejects(() => first, (error: Error) => /已回滚/.test(error.message));
  assert.equal(stub.daemon.isUpgrading(), false);

  // 非法输入快速失败后再调非法输入：仍可调（无缓存 busy）
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }),
      (error: Error & { code?: string }) => error.code === 'invalid',
    );
  }

  // close 后拒绝新升级
  await stub.daemon.close();
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// 11. pendingActivation 候选：创建即 draining，confirmUpgrade 身份对账与解除
// ---------------------------------------------------------------------------

test('候选 pendingActivation：创建即拒新命令；confirmUpgrade 身份对账后解除并立即上报 commit', { timeout: 60_000 }, async (t) => {
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

  // 身份对账：attemptId / version / pid 任一不匹配即拒绝且 gate 不解除
  const pid = process.pid;
  const version = getNodeVersion();
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'wrong-att', version, previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version: '0.0.0', previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid: 12345 }));
  const stillDrained = await rpc.envExec({ execId: 'pend-2', command: 'echo hi', timeout: 10 });
  assert.equal(stillDrained.ok, false, '对账失败不得解除 gate');

  // 正确 commit：resolve、立即心跳携带 upgradeCommit、gate 解除
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });
  await waitFor(() => hub.heartbeatInputs.some((input) => input.upgradeCommit !== undefined), 10_000, '心跳携带 upgradeCommit');
  const commits = hub.heartbeatInputs.filter((input) => input.upgradeCommit !== undefined);
  assert.ok(commits.length >= 1, 'confirmUpgrade 后应立即/随后心跳携带 upgradeCommit');
  assert.equal(commits[0]?.upgradeCommit?.attemptId, 'att-pend-1');
  assert.equal(commits[0]?.upgradeCommit?.pid, pid);

  const ok = await rpc.envExec({ execId: 'pend-3', command: 'echo hi', timeout: 10 });
  assert.equal(ok.ok, true, `confirmUpgrade 后应恢复受理：${!ok.ok && ok.error.message}`);

  // 重复同一 commit 幂等
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });

  // 参数非法直接抛出
  await assert.rejects(() => stub.daemon.confirmUpgrade({ attemptId: '', version: '1', previousVersion: '0', pid: -1 }));
});

// ---------------------------------------------------------------------------
// 12. 断线重连后 commit 在内存保留并持续重试
// ---------------------------------------------------------------------------

test('断线重连后，commit 在内存保留并在新连接心跳重试', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-node-commitretry-');
  let hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 300 });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // 非候选 daemon 的 confirmUpgrade 不做身份对账（普通心跳上报路径）
  await stub.daemon.confirmUpgrade({ attemptId: 'att-retry-1', version: '5.5.5', previousVersion: '5.5.4', pid: 777 });
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    '首次心跳携带 commit',
  );
  assert.ok(hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'));

  await hub.close();
  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 300, port: hub.port });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
  assert.equal(hub.registrations.length, 1, '应重连成功');
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    '重连后心跳继续携带 commit',
  );
  const retried = hub.heartbeatInputs.filter((input) => input.upgradeCommit?.attemptId === 'att-retry-1');
  assert.ok(retried.length >= 1, '重连后心跳应继续携带 commit');
  await hub.close();
});
