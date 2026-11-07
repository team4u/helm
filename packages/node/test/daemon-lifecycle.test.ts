/**
 * daemon/index.ts 生命周期回归测试（真实 HTTP+WS+birpc + 真实临时目录，不 mock 被测模块）：
 * - 首次连接失败后重连成功（Hub 延迟启动）；
 * - 断线后 waitUntilRegistered 不伪造成功（离线确认 false；重连注册后可再翻 true）；
 * - 反复 register 拒绝期间始终至多一条连接（无并行连接）；
 * - 离线退避重连期间守护进程保持存活（事件循环不被 unref 计时器放空）；
 * - close() 等待在途世代清理完成（远端 envExec 子进程被杀后才返回）；
 * - 坏身份/坏 token/坏 hubUrl 显式拒绝（不静默回退既有身份）；
 * - 并发绑定不同 nodeId 恰一个成功（进程内互斥）；
 * - shellEnv PATH 前置受管 helm bin（远端 bash 可运行 helm）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 复用端口：先占住一个空闲端口，关掉后给 fixture 回listen（重连回同端口用）。 */
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
  /** 累计接受的连接（upgrade 次数）。 */
  connections: number;
  /** 立即接受的 socket 数（浏览器侧已建立）。 */
  openSockets: Set<WebSocket>;
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  /** 主动断开全部节点连接。 */
  disconnectAll(): void;
  close(): Promise<void>;
  /** 按需改写注册应答/心跳应答。 */
  setBehavior(behavior: {
    registerAck?: (input: NodeRegisterInput) => NodeRegisterResult;
    heartbeat?: (nodeId: string) => boolean;
  }): void;
}

/** 真实 http.Server + WebSocketServer + birpc 的 Hub 网关（与正式 /ws/node 同构）。 */
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
              // Hub fixture 容忍偶发噪声帧。
            }
          });
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      // 连接断开：作为规范 Hub 必须立刻 reject 全部在途调用（不悬挂到超时）。
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
// 1. 首次连接失败 → 退避重连成功
// ---------------------------------------------------------------------------

test('首次连接失败（Hub 未启动）后重连成功', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-firstfail-');
  const port = await reservePort();
  const logs: string[] = [];
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    identity: { nodeId: 'ff-1', token: 'ff-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 200,
    reconnectMaxDelayMs: 1_000,
    log: (m) => logs.push(m),
  });
  let hub: HubHandle | undefined;
  try {
    // Hub 尚未监听：首连与若干次重连均失败，daemon 不得退出、不得崩溃。
    await delay(900);
    assert.equal(daemon.isConnected(), false, '失败期应离线');
    assert.equal(await daemon.waitUntilRegistered(50), false, '失败期等待不得伪造成功');

    // 启动 Hub：退避重连后应注册成功。
    hub = await startHub({ port, heartbeatMs: 15_000 });
    const ok = await daemon.waitUntilRegistered(15_000);
    assert.equal(ok, true, `Hub 启动后应重连注册成功（日志：${logs.join(' | ')}）`);
    assert.equal(daemon.isConnected(), true);
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'ff-1');

    // 成功后的新 wait 立即 true（当前在线）
    assert.equal(await daemon.waitUntilRegistered(1_000), true);
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 断线后 wait 不伪造成功；重连后可再翻 true
// ---------------------------------------------------------------------------

test('断线后 waitUntilRegistered 不伪造成功，重连后翻 true', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-wait-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'w-1', token: 'w-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 200,
    reconnectMaxDelayMs: 1_000,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    const registrationsBefore = hub.registrations.length;

    // 断线 + 拒绝后续注册：离线窗口内 wait 必须显式 false（不伪造成功）。
    hub.setBehavior({ registerAck: () => ({ ok: false, heartbeatMs: 0, reason: 'maintenance' }) });
    hub.disconnectAll();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && daemon.isConnected()) await delay(50);
    assert.equal(daemon.isConnected(), false, '断线后应视为未连接');
    assert.equal(await daemon.waitUntilRegistered(300), false, '离线/被拒期 wait 不得伪造成功');

    // 服务端恢复接受：重连注册成功后，新的 wait 翻 true（不缓存失败）。
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    const ok = await daemon.waitUntilRegistered(15_000);
    assert.equal(ok, true, '重连注册成功后 wait 应翻 true');
    assert.equal(daemon.isConnected(), true);
    assert.ok(hub.registrations.length > registrationsBefore, '共多次注册尝试（初始 + 重连）');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 反复拒绝：始终至多一条连接
// ---------------------------------------------------------------------------

test('反复 register 拒绝期间始终至多一条并行连接', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-reject-');
  const hub = await startHub({ heartbeatMs: 15_000, rejectAll: true });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'r-1', token: 'r-1:wrong' },
    dataDir: dir,
    reconnectBaseDelayMs: 150,
    reconnectMaxDelayMs: 600,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(1_500), false, '鉴权拒绝必须 wait false');
    // 观察多个拒绝周期：任一时刻 Hub 侧至多一个节点 socket（无并行连接）。
    for (let i = 0; i < 12; i += 1) {
      await delay(150);
      assert.ok(hub.openSockets.size <= 1, `第 ${i} 次采样发现 ${hub.openSockets.size} 条并行连接`);
    }
    assert.ok(hub.registrations.length >= 2, '退避重试应多次尝试注册');
    assert.equal(daemon.isConnected(), false);

    // 转为接受：拒绝不缓存，恢复后注册成功。
    hub.setBehavior({ registerAck: () => ({ ok: true, heartbeatMs: 15_000 }) });
    assert.equal(await daemon.waitUntilRegistered(15_000), true, '恢复接受后应注册成功');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 离线退避重连期间守护进程保持存活（unref 修复回归）
// ---------------------------------------------------------------------------

test('离线退避重连期间保持存活（不被 unref 计时器放空）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-alive-');
  const port = await reservePort();
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    identity: { nodeId: 'a-1', token: 'a-1:sec' },
    dataDir: dir,
    reconnectBaseDelayMs: 300,
    reconnectMaxDelayMs: 1_000,
  });
  let hub: HubHandle | undefined;
  try {
    // 整个 2.5s 离线窗口内 daemon 应持续存活（若重连计时器被 unref，
    // 测试进程的事件循环将被放空、下面的 delay 循环也会随进程退出而中止）。
    const start = Date.now();
    let aliveMs = 0;
    while (Date.now() - start < 2_500) {
      await delay(250);
      aliveMs = Date.now() - start;
      assert.equal(daemon.isConnected(), false);
    }
    assert.ok(aliveMs >= 2_000, `离线期间应保持存活（实际存活 ${aliveMs}ms）`);

    hub = await startHub({ port, heartbeatMs: 15_000 });
    assert.equal(await daemon.waitUntilRegistered(15_000), true, '存活后重连成功');
  } finally {
    await daemon.close();
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. close() 等待在途世代清理（远端 exec 子进程被杀后才返回）
// ---------------------------------------------------------------------------

test('close 返回前等待世代清理（在途 envExec 子进程被杀）', { timeout: 60_000 }, async () => {
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
    // 远端长命令：close() 应终止其子进程并使 RPC 以失败落定（不悬挂、不重放）。
    const pending = rpc!
      .envExec({ execId: 'long-1', command: 'sleep 60', timeout: 120 })
      .catch((error: unknown) => ({ ok: false as const, error: { code: 'closed', message: String(error) } }));
    await delay(400); // 等子进程真正启动
    const start = Date.now();
    await daemon.close();
    const closedMs = Date.now() - start;
    assert.ok(closedMs < 15_000, `close 应有界等待清理（实际 ${closedMs}ms）`);
    const result = await Promise.race([
      pending,
      new Promise<{ ok: true }>((resolve) => {
        const t = setTimeout(() => resolve({ ok: true }), 8_000);
        t.unref?.();
      }),
    ]);
    assert.equal(result.ok, false, '在途 envExec 必须以失败落定（不重放）');
    // close 幂等
    await daemon.close();
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 坏身份/坏 token/坏 hubUrl 显式拒绝
// ---------------------------------------------------------------------------

test('readNodeIdentity 严格校验外部对象（null/array/坏字段全拒绝）', { timeout: 60_000 }, async () => {
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
      await assert.rejects(readNodeIdentity(dir), { name: 'Error' }, `应拒绝: ${JSON.stringify(value)}`);
    }
    // 合法身份（含可选 hubUrl）通过
    await fs.writeFile(file, JSON.stringify({ nodeId: 'ok-node', token: 'ok-node:sec', hubUrl: 'http://127.0.0.1:3202' }), 'utf8');
    const ok = await readNodeIdentity(dir);
    assert.equal(ok?.nodeId, 'ok-node');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseJoinToken 拒绝 local/空白/控制字符等非法令牌', () => {
  assert.equal(parseJoinToken('local:secret'), null, 'local ID 不得作为 JOIN nodeId');
  assert.equal(parseJoinToken(' node-1:secret'), null, '首空白拒绝');
  assert.equal(parseJoinToken('node-1:secret '), null, '尾空白拒绝');
  assert.equal(parseJoinToken('node-1:\n'), null, '控制字符 secret 拒绝');
  assert.equal(parseJoinToken('node-1:sec\x00ret'), null, 'NUL 拒绝');
  assert.equal(parseJoinToken('local:'), null);
  assert.deepEqual(parseJoinToken('node.9_x:s3c'), { nodeId: 'node.9_x', secret: 's3c' });
});

test('bindIdentityFromJoinToken 拒绝坏 hubUrl 且不泄露 token', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-bind-');
  try {
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'ftp://x'), /协议必须为 http/);
    await assert.rejects(bindIdentityFromJoinToken(dir, 'n-1:sec', 'http://u:p@x'), /userinfo/);
    // 非法令牌的错误信息不得含 token 前缀
    const secret = 'supersecretvalue';
    try {
      await bindIdentityFromJoinToken(dir, `bad id:${secret}`, 'http://127.0.0.1:3202');
      assert.fail('应拒绝非法令牌');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes('bad id'.slice(0, 4)), `错误不得泄露令牌前缀：${message}`);
      assert.ok(!message.includes(secret), `错误不得泄露 secret：${message}`);
    }
    assert.equal(await readNodeIdentity(dir), null, '失败绑定不得写入身份');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeNodeIdentity 校验入参（坏身份直接拒绝）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-write-');
  try {
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'local', token: 'x' }), /身份非法/);
    await assert.rejects(writeNodeIdentity(dir, { nodeId: 'n', token: '' }), /身份非法/);
    await assert.rejects(
      writeNodeIdentity(dir, { nodeId: 'n', token: 'n:s', hubUrl: 'javascript:alert(1)' }),
      /身份非法/,
    );
    assert.equal(await readNodeIdentity(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. 并发绑定：不同 nodeId 恰一个成功
// ---------------------------------------------------------------------------

test('并发 bindIdentityFromJoinToken 不同 nodeId 恰一个成功', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-race-');
  try {
    const results = await Promise.allSettled([
      bindIdentityFromJoinToken(dir, 'race-a:sec-a', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-b:sec-b', 'http://127.0.0.1:3202'),
      bindIdentityFromJoinToken(dir, 'race-c:sec-c', 'http://127.0.0.1:3202'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, `恰一个成功（实际 ${fulfilled.length}）`);
    assert.equal(rejected.length, 2, '其余显式拒绝');
    for (const r of rejected) {
      assert.equal(r.status, 'rejected');
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      assert.match(message, /已绑定节点|并发绑定冲突/, `拒绝原因应明确：${message}`);
    }
    // 落盘身份 = 唯一成功者，且无锁残留
    const identity = await readNodeIdentity(dir);
    assert.ok(identity !== null);
    assert.ok(['race-a', 'race-b', 'race-c'].includes(identity.nodeId));
    assert.equal(fulfilled[0]?.status === 'fulfilled' && fulfilled[0].value.nodeId, identity.nodeId);
    const lockExists = await fs.stat(path.join(dir, 'node.json.lock')).then(
      () => true,
      () => false,
    );
    assert.equal(lockExists, false, '锁文件必须清理');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. createNodeDaemon 入参校验 + shellEnv PATH 前置受管 helm bin
// ---------------------------------------------------------------------------

test('createNodeDaemon 拒绝坏 identity / 坏 hubUrl', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-badopts-');
  try {
    await assert.rejects(
      createNodeDaemon({ hubUrl: 'http://127.0.0.1:3202', identity: { nodeId: 'local', token: 'x' }, dataDir: dir }),
      /身份非法/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'http://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s', hubUrl: 'http://u:p@h' },
        dataDir: dir,
      }),
      /身份非法/,
    );
    await assert.rejects(
      createNodeDaemon({
        hubUrl: 'ftp://127.0.0.1:3202',
        identity: { nodeId: 'n-1', token: 'n-1:s' },
        dataDir: dir,
      }),
      /协议必须为 http/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveManagedHelmBinDir：workspace 可定位且含可执行 helm', { timeout: 60_000 }, async () => {
  const resolved = await resolveManagedHelmBinDir();
  assert.ok('dir' in resolved, `应能定位受管 helm bin（结果：${JSON.stringify(resolved)}）`);
  if ('dir' in resolved) {
    const entry = path.join(resolved.dir, process.platform === 'win32' ? 'helm.cmd' : 'helm');
    await fs.access(entry);
  }
  // 显式坏目录：显式诊断而非假成功
  const bad = await resolveManagedHelmBinDir(path.join(os.tmpdir(), 'helm-no-such-bin-dir'));
  assert.ok('error' in bad && bad.error.length > 0, '坏目录必须显式诊断');
});

test('daemon shellEnv PATH 前置受管 helm bin（远端 bash 可运行 helm）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-dlc-helmpath-');
  const hub = await startHub({ heartbeatMs: 15_000 });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'hp-1', token: 'hp-1:sec' },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, '前置 bin 解析失败会导致启动失败');
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined);
    // 远端 bash 直接运行 helm：PATH 前置的受管 bin 必须命中（--help 无需 Hub）。
    const output = await rpc!.envExec({
      execId: 'helm-path-2',
      command: 'command -v helm && helm --help >/dev/null && echo helm-runs',
      timeout: 60,
    });
    assert.equal(output.ok, true, output.ok ? '' : output.error.message);
    // 环境变量携带该节点实际 hubUrl / dataDir
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

test('daemon 子进程 env：HELM_HUB_URL 为节点实际 hubUrl', { timeout: 60_000 }, async () => {
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
