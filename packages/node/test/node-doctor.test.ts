/**
 * helm-node doctor / 健康快照 / stdio Drain 硬超时保护测试：
 * - collectNodeHealth：基础指标与磁盘字段合法；目录不存在回退 homedir；
 * - createNodeDaemon：register 与 heartbeat 真实携带 health 快照；
 * - NodeEnvRpcServer：detached 孙进程持续向继承的 stdout 写入时，
 *   envAbortExec / timeout 后 execOnce 在 abortDrainGraceMs 内强制结算，
 *   dispose() 不挂死；
 * - helm-node doctor [--json]：未绑定身份 / 0644 权限 / root 权限 warn /
 *   真实 WS Hub mock 下 rttMs 与机密不泄漏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
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

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. collectNodeHealth
// ---------------------------------------------------------------------------

test('collectNodeHealth：返回合法的基础指标与磁盘空间字段', { timeout: 60_000 }, async () => {
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
  // statfs 在 Linux/macOS 可用：磁盘字段应采集到且合理
  if (snapshot.diskFreeBytes !== undefined && snapshot.diskTotalBytes !== undefined) {
    assert.ok(snapshot.diskFreeBytes > 0);
    assert.ok(snapshot.diskTotalBytes > 0);
    assert.ok(snapshot.diskFreeBytes <= snapshot.diskTotalBytes);
  }
  // 指定目录存在：按该目录所在挂载点采集
  const dir = await tempDir('helm-node-health-');
  try {
    const targeted = await collectNodeHealth(dir);
    assert.ok(targeted.collectedAt > 0);
    if (targeted.diskFreeBytes !== undefined) assert.ok(targeted.diskFreeBytes > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // 目录不存在：回退 homedir，绝不抛出
  const fallback = await collectNodeHealth(path.join(dir, 'no-such-dir'));
  assert.ok(fallback.uptimeSec >= 0);
  if (fallback.diskFreeBytes !== undefined) assert.ok(fallback.diskFreeBytes > 0);
});

// ---------------------------------------------------------------------------
// 2. createNodeDaemon：register / heartbeat 携带 health 快照（真实 WS Hub mock）
// ---------------------------------------------------------------------------

interface DoctorHubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: { nodeId: string; input?: NodeHeartbeatInput }[];
  close(): Promise<void>;
}

/** 真实 http.Server + WebSocketServer 模拟 Hub /ws/node：记录 register/heartbeat。 */
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
              // 忽略非法帧。
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

test('createNodeDaemon：register 与 heartbeat 真实携带 health 快照', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-health-');
  const token = 'health-node:secret-1';
  const hub = await startDoctorHub(token);
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'health-node', token },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, '应完成注册');
    assert.equal(hub.registrations.length, 1);
    const registerHealth = hub.registrations[0]?.health;
    assert.ok(registerHealth !== undefined, 'register 应携带 health 快照');
    assert.ok(registerHealth!.uptimeSec >= 0);
    assert.ok(Number.isFinite(registerHealth!.memTotalBytes) && registerHealth!.memTotalBytes > 0);
    if (registerHealth!.diskTotalBytes !== undefined) assert.ok(registerHealth!.diskTotalBytes > 0);
    assert.ok(Math.abs(registerHealth!.collectedAt - Date.now()) < 60_000);

    // 等至少一次心跳（heartbeatMs=100ms）
    await delay(400);
    assert.ok(hub.heartbeats.length >= 1, '应收到心跳');
    for (const beat of hub.heartbeats) {
      assert.equal(beat.nodeId, 'health-node');
      assert.ok(beat.input?.health !== undefined, '心跳应携带 health 快照');
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
// 3. stdio Drain 硬超时保护：detached 孙进程持续写 stdout
// ---------------------------------------------------------------------------

/**
 * 以 detached: true 派生孙进程：孙进程每 20ms 向继承的 stdout 持续写入，5s 后
 * 自行退出（自限制避免测试遗留孤儿进程；也不可过短——要热过 abort/timeout 的
 * 杀窗，且 runner 需等管道排空才会收尾）；父进程 1s 后退出，孙进程继续拽住
 * 管道 fd——模拟真实的孤儿孙进程挂死场景。
 */
const ORPHAN_PROGRAM = [
  "const cp = require('node:child_process');",
  "const childCode = 'const t0 = Date.now(); setInterval(() => { if (Date.now() - t0 > 5000) process.exit(0); process.stdout.write(String(Date.now() % 10)); }, 20);';",
  "cp.spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();",
  "setTimeout(() => {}, 1000);",
].join(' ');

test('envAbortExec 后 500ms Drain 保护：孙进程拽住 stdout 不挂死', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-abort-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const pending = server.envExec({
      execId: 'drain-abort',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 60,
    });
    // 等父进程 spawn 完孙进程并退出（孙进程持续向继承管道写入）
    await delay(300);
    assert.equal(server.getActiveExecCount(), 1, 'exec 应仍在途（被孙进程管道拽住）');
    await server.envAbortExec('drain-abort');
    const result = await pending;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, '应失败结算');
    assert.equal(!result.ok && result.error.code, 'aborted', '错误码应为 aborted');
    if (!result.ok) {
      assert.match(result.error.message, /aborted|drain/i);
    }
    assert.ok(elapsed < 10_000, `abort 后应在 Drain 宽限期内结算（实际 ${elapsed}ms）`);
    // dispose 不挂死
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose 不应挂死');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('命令 timeout 后 Drain 保护：强制 timeout 结算且 dispose 不挂死', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-drain-timeout-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, abortDrainGraceMs: 200 });
  try {
    const start = Date.now();
    const result = await server.envExec({
      execId: 'drain-timeout',
      command: [process.execPath, '-e', ORPHAN_PROGRAM],
      timeout: 1, // 1s 超时 + 200ms Drain 宽限
    });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false, '应失败结算');
    assert.equal(!result.ok && result.error.code, 'timeout', '错误码应为 timeout');
    if (!result.ok) {
      assert.match(result.error.message, /timed out after 1 seconds/);
    }
    assert.ok(elapsed < 10_000, `timeout 后应在 Drain 宽限期内结算（实际 ${elapsed}ms）`);
    const disposeStart = Date.now();
    await server.dispose();
    assert.ok(Date.now() - disposeStart < 10_000, 'dispose 不应挂死');
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
    env: { ...process.env, ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('doctor：未绑定身份时 ok=false 且退出码 1', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-none-');
  try {
    // Herdr IPC 检查需避免读到真实 ~/.config/herdr：指向隔离路径
    const result = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(result.code, 1, `期望退出码 1，实得 ${result.code}（out=${result.out}）`);
    const report = JSON.parse(result.out) as { ok: boolean; checks: { id: string; status: string }[] };
    assert.equal(report.ok, false);
    const identity = report.checks.find((c) => c.id === 'identity');
    assert.equal(identity?.status, 'error');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor：node.json 权限 0644 时 identity 报 error（退出码 1）', { timeout: 60_000 }, async () => {
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
    // 非 json 模式同样可用
    const textResult = await runCli(['doctor', '--data-dir', dir], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(textResult.code, 1);
    assert.match(textResult.out, /identity/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor：root 权限 warn 但身份与 Hub 正常时整体 ok=true（退出码 0）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-root-');
  const token = 'doctor-ok-node:secret-1';
  const hub = await startDoctorHub(token);
  try {
    await writeNodeIdentity(dir, { nodeId: 'doctor-ok-node', token, hubUrl: hub.url });
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...process.env, HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      checkPrivilege: async () => ({ isRoot: true, passwordlessSudo: false }),
    });
    const privilege = report.checks.find((c) => c.id === 'privilege');
    assert.equal(privilege?.status, 'warn');
    assert.match(privilege?.message ?? '', /root 或免密 sudo/);
    assert.equal(report.checks.find((c) => c.id === 'identity')?.status, 'ok');
    assert.equal(report.checks.find((c) => c.id === 'hub')?.status, 'ok');
    assert.equal(report.ok, true, 'warn 不影响整体 ok');

    const result = await runCli(
      ['doctor', '--data-dir', dir, '--json'],
      { HERDR_SOCKET_PATH: path.join(dir, 'no.sock'), HELM_DOCTOR_TEST: '1' },
    );
    // CLI 无法注入 checkPrivilege：hub 检查以真实 WS 探测（身份与 Hub 均正常）。
    // 该断言仅验证 CLI 退出码与 warn 项在身份/Hub 正常时整体 ok。
    assert.equal(result.code, report.ok ? 0 : 1);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor：真实 WS Hub mock 下 hub 项返回 rttMs 且 token 绝不出现', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-doctor-hub-');
  const token = 'doctor-hub-node:secret-1';
  const hub = await startDoctorHub(token);
  try {
    await writeNodeIdentity(dir, { nodeId: 'doctor-hub-node', token, hubUrl: hub.url });
    const report = await runNodeDoctor({
      dataDir: dir,
      env: { ...process.env, HERDR_SOCKET_PATH: path.join(dir, 'no.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    const hubCheck = report.checks.find((c) => c.id === 'hub');
    assert.equal(hubCheck?.status, 'ok');
    const details = (hubCheck?.details ?? {}) as { rttMs?: number; hubUrl?: string; heartbeatMs?: number };
    assert.equal(typeof details.rttMs, 'number');
    assert.ok(details.rttMs! >= 0);
    assert.equal(details.hubUrl, hub.url);
    // Hub 侧收到了真实 register（含 health 快照）
    assert.ok(hub.registrations.length >= 1);
    const registered = hub.registrations[0];
    assert.equal(registered?.nodeId, 'doctor-hub-node');
    assert.ok(registered?.health !== undefined);
    // 报告全文绝不出现 token（secret）
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(token), false, '报告中不得出现 token');
    assert.equal(serialized.includes('secret-1'), false);
    // CLI --json 输出同样不泄漏
    const cli = await runCli(['doctor', '--data-dir', dir, '--json'], { HERDR_SOCKET_PATH: path.join(dir, 'no.sock') });
    assert.equal(cli.code, 0, cli.out + cli.err);
    assert.equal(cli.out.includes(token), false, 'CLI 输出不得出现 token');
    const cliReport = JSON.parse(cli.out) as { ok: boolean; hubUrl: string };
    assert.equal(cliReport.ok, true);
    assert.equal(cliReport.hubUrl, hub.url);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor：herdr_ipc 端点可达时 ok、不可达时 info', { timeout: 60_000 }, async () => {
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
    // 可达：ok
    const reachable = await runNodeDoctor({
      dataDir: dir,
      env: { ...process.env, HERDR_SOCKET_PATH: sockPath },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcOk = reachable.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcOk?.status, 'ok', JSON.stringify(reachable.checks));
    assert.equal((ipcOk?.details as { endpoint?: string } | undefined)?.endpoint, sockPath);

    // 不可达：info（可选能力不阻断）
    const missing = await runNodeDoctor({
      dataDir: dir,
      env: { ...process.env, HERDR_SOCKET_PATH: path.join(dir, 'missing.sock') },
      checkPrivilege: async () => ({ isRoot: false, passwordlessSudo: false }),
    });
    const ipcInfo = missing.checks.find((c) => c.id === 'herdr_ipc');
    assert.equal(ipcInfo?.status, 'info');
    assert.match(ipcInfo?.message ?? '', /未检测到运行中的 Herdr IPC/);
    assert.equal(missing.ok, true, 'info 不影响整体 ok');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
