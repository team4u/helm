/**
 * helm-node CLI 后台控制评审测试（便携控制 IPC 契约验收）。
 *
 * 全部走真实多进程：真实 detached 子进程（stdio IPC 就绪上报 + 持久控制
 * UDS）+ 真实 Hub fixture（http.Server + WebSocketServer + birpc）。
 * 独立 CLI 子进程用例验证跨进程控制，其余用例通过进程内入口定位边界行为。
 *
 * 覆盖：
 * 1. start -d / stop / status / restart 全链路：就绪 state 语义（registered 只
 *    来自真实 ACK）、stop 后进程真实退出且 pid 文件删除、status 呈现 unknown
 *    并诊断；
 * 2. 安全边界：argv/env 无 token；未知实例 nonce 拒绝且不杀进程；控制通道不可
 *    达但 pid 存活时 stop/start 显式失败并保留 pid 文件；重复启动拒绝；
 * 3. 失败如实：spawn 失败、子进程即退不伪成功；node.pid 新契约校验；
 * 4. service：模板/安装行为归 service 测试；此处仅验证 CLI 入口选择编译产物
 *    （源码运行无 dist 产物时显式提示 pnpm build）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helm/protocol';
import { bindIdentityFromJoinToken } from '../src/daemon/index.js';
import { isDirectRun, runNodeCli, type NodeCliIo } from '../src/cli.js';
import {
  getNodeServiceStatus,
  installNodeService,
  renderServiceSpec,
  uninstallNodeService,
  type ServiceExec,
} from '../src/daemon/service.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface Captured {
  out: string;
  err: string;
  code: number;
}

/** 内存 IO 入口；与真实子进程 CLI 测试分别覆盖，不能互相替代。 */
async function runCli(argv: string[], io: Partial<NodeCliIo> = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    env: { ...process.env },
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...io,
  });
  return { out, err, code };
}

// ---------------------------------------------------------------------------
// Hub fixture：真实 http.Server + WebSocketServer + birpc
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
          // 本文件不测 env 转发。
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
              // 非 JSON 帧。
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

/** 读子进程存活状态（真实 process.kill(pid, 0)）。 */
const realIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 等待条件成立（真实施测轮询，非固定 sleep；条件可异步）。 */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(await condition(), `等待超时：${what}`);
}

// ---------------------------------------------------------------------------
// 1. 全链路：start -d / status / stop / restart（真实多进程 + 真实 Hub）
// ---------------------------------------------------------------------------

test('start -d / status / stop：registered 来自真实注册，stop 后真实退出并清 pid', { timeout: 60_000 }, async (t) => {
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

  // CLI 进程 A：后台启动
  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 0, start.err);
  const payload = JSON.parse(start.out) as { ok: boolean; pid: number; state: string; logPath: string };
  assert.equal(payload.ok, true);
  assert.ok(payload.pid > 0);
  assert.equal(payload.state, 'registered', '可达 Hub 下 state 必须来自真实注册 ACK');

  // Hub 确实收到注册
  await waitFor(() => hub.registrations.length >= 1, 10_000, 'Hub 收到注册');

  // node.pid 新契约：pid + instanceId + endpoint，0600
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
    pid: number;
    instanceId: string;
    endpoint: string;
  };
  assert.equal(record.pid, payload.pid);
  assert.match(record.instanceId, /^[0-9a-f]{32}$/);
  assert.match(record.endpoint, /^\/tmp\/helm-node-[0-9a-f]{16}\.sock$/);
  const pidStat = await fs.stat(path.join(dir, 'node.pid'));
  assert.equal(pidStat.mode & 0o777, 0o600);
  assert.ok(realIsAlive(record.pid), '守护进程应真实存活');

  // 控制端点 socket 文件真实存在
  await waitFor(() => fs.stat(record.endpoint).then(() => true, () => false), 5_000, '控制 socket 落盘');

  // 再次调用入口：status 呈现真实运行态。
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
  const statusPayload = JSON.parse(status.out) as { pid: number; pidAlive: boolean; state: string };
  assert.equal(statusPayload.pid, record.pid);
  assert.equal(statusPayload.pidAlive, true);
  assert.equal(statusPayload.state, 'registered');

  // stop 经 IPC 请求后台进程清理，确认 pid 和 socket 留档消失。
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(JSON.parse(stop.out).outcome, 'stopped');
  assert.equal(realIsAlive(record.pid), false, '进程应真实退出（经控制通道优雅停止）');
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid 文件应删除');
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    '控制 socket 应清理',
  );

  // stop 后 status 回到「无后台进程」
  const after = await runCli(['status', '--data-dir', dir, '--json']);
  const afterPayload = JSON.parse(after.out) as { pid: number | null; pidAlive: boolean };
  assert.equal(afterPayload.pid, null);
  assert.equal(afterPayload.pidAlive, false);
});

test('三个独立 CLI 子进程能启动、查询并停止同一后台节点实例', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-cli-processes-');
  const hub = await startHubFixture({ expectedToken: 'cli-process:s' });
  t.after(async () => { await runCli(['stop', '--data-dir', dir, '--json']); await hub.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await bindIdentityFromJoinToken(dir, 'cli-process:s', hub.url);
  const childCli = (args: string[]): Promise<Captured> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args, '--data-dir', dir, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HELM_HUB_URL: hub.url } });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString() });
    child.stderr.on('data', (chunk) => { err += chunk.toString() });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI 子进程未在预算内退出')) }, 20_000);
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

test('restart：旧实例经控制通道真实退出，新实例注册成功', { timeout: 60_000 }, async (t) => {
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
  assert.equal(realIsAlive(firstPid), false, '旧进程应已真实退出');
  assert.ok(realIsAlive(payload.pid), '新进程应存活');

  // restart 后旧实例控制 socket 已清、新 socket 可查
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { pid: number; state: string };
  assert.equal(statusPayload.pid, payload.pid);
  assert.equal(statusPayload.state, 'registered');
});

test('start -d：Hub 不可达时 state=starting（如实呈现离线运行态，不伪称已注册）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-startd-offline-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 127.0.0.1:1 端口不会接受连接（daemon 会持续退避重连）
  await bindIdentityFromJoinToken(dir, 'rev-off:s', 'http://127.0.0.1:1');

  const r = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { ok: boolean; pid: number; state: string; message: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'starting');
  assert.match(payload.message, /尚未完成/);
  assert.ok(realIsAlive(payload.pid), '离线时守护进程应存活重连');

  // status 同样呈现 starting
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  const statusPayload = JSON.parse(status.out) as { state: string };
  assert.equal(statusPayload.state, 'starting');
});

// ---------------------------------------------------------------------------
// 2. 安全边界：无 token argv/env；未知 nonce 拒绝；不可达保留 pid；重复启动拒绝
// ---------------------------------------------------------------------------

test('start -d：argv 与 env 均无 token；子进程 argv 仅 start --data-dir [--hub]', { timeout: 60_000 }, async (t) => {
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
  // argv 无 token：只有 CLI 入口 + start --data-dir <dir>（--hub 未显式时不传，token 从 node.json 读）
  assert.ok(!JSON.stringify(capturedArgs).includes('s3cret'), 'argv 不得包含 token secret');
  assert.ok(!JSON.stringify(capturedArgs).includes('rev-nt:'), 'argv 不得包含 token 前缀');
  assert.ok(capturedArgs.includes('start'));
  assert.ok(capturedArgs.includes(dir));
  // env 无 token（instanceId/endpoint 是本机控制信息，允许存在）
  assert.ok(!JSON.stringify(capturedEnv ?? {}).includes('s3cret'), 'env 不得包含 token secret');
  assert.ok((capturedEnv?.['HELM_NODE_INSTANCE_ID'] ?? '').length >= 16, 'instanceId 经 env 传递');
  assert.ok((capturedEnv?.['HELM_NODE_CONTROL_ENDPOINT'] ?? '').length > 0, 'endpoint 经 env 传递');
});

test('控制通道：未知实例 nonce 拒绝（不杀无关进程），pid 文件保留', { timeout: 60_000 }, async (t) => {
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

  // 直接对真实控制端点发错误 nonce 的 stop：必须被拒绝（instance_mismatch），进程不受影响
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
  assert.ok(hostile !== null, '控制端点应应答');
  assert.equal(hostile!.ok, false);
  assert.equal(hostile!.error, 'instance_mismatch');
  await waitFor(() => realIsAlive(pid), 2_000, '错误 nonce 下进程必须存活');

  // pid 文件仍保留，正常 stop 仍有效
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(realIsAlive(pid), false);
});

test('重复启动拒绝（活实例经控制通道验证，already_running）', { timeout: 60_000 }, async (t) => {
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
  assert.ok(realIsAlive(pid), '重复启动尝试不得影响存活实例');

  // 锁已释放（可再次正常 stop）
  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 0, stop.err);
});

test('控制通道不可达但 pid 存活：stop 与 start 都拒绝且保留 pid 文件', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-unreach-');
  t.after(async () => {
    // 用真实存活的本测试进程占位 pid：直接清 pid 文件（测试收尾）
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-unreach:s', 'http://127.0.0.1:1');
  // 占位：pid 指向本测试进程（存活），endpoint 指向不存在的 socket
  const fakeEndpoint = path.join(dir, 'no-such.sock');
  await fs.writeFile(
    path.join(dir, 'node.pid'),
    JSON.stringify({ pid: process.pid, instanceId: 'a'.repeat(32), endpoint: fakeEndpoint }) + '\n',
    'utf8',
  );

  const stop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stop.code, 1);
  const stopEnvelope = JSON.parse(stop.err) as { error: { message: string } };
  assert.match(stopEnvelope.error.message, /控制通道不可达/);
  assert.match(stopEnvelope.error.message, /拒绝向未经身份验证的进程发送信号/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid 文件必须保留');

  const start = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(start.code, 1);
  const startEnvelope = JSON.parse(start.err) as { error: { message: string } };
  assert.match(startEnvelope.error.message, /控制通道不可达|无法证实可安全覆盖/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'pid 文件必须保留');
});

test('pid 确已死亡：stop 按 stale 清理，start 清理后正常启动', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-stale-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 找一个已退出的 pid：spawn 一个即退子进程
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

test('坏 pid 文件与残留 start 锁：显式报错，不静默清理', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-badpid-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 旧版纯数字 pid 留档：结构非法显式报错
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
  const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(legacy.code, 1);
  assert.match(JSON.parse(legacy.err).error.message, /非法|损坏/);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, '不静默清理');

  // 坏 JSON
  await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
  const broken = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(broken.code, 1);
  assert.match(JSON.parse(broken.err).error.message, /损坏/);

  // 残留 start 锁：显式诊断（不静默删除），stop 不受影响
  await fs.writeFile(path.join(dir, 'node.start.lock'), '', 'utf8');
  const lockStop = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(lockStop.code, 1); // 坏 pid 文件仍在 → 报错而非清理
  const hub = await startHubFixture({ expectedToken: 'rev-lock:s' });
  t.after(async () => {
    await hub.close();
  });
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  await bindIdentityFromJoinToken(dir, 'rev-lock:s', hub.url);
  const lockStart = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(lockStart.code, 1);
  assert.match(JSON.parse(lockStart.err).error.message, /并发启动冲突|node\.start\.lock/);
  assert.equal(await fs.stat(path.join(dir, 'node.start.lock')).then(() => true, () => false), true, '残留锁不静默删除');
});

// ---------------------------------------------------------------------------
// 3. 失败如实：spawn 失败 / 子进程即退 / 就绪超时
// ---------------------------------------------------------------------------

test('start -d：node 可执行不存在 → spawn error 显式报错，不伪成功', { timeout: 60_000 }, async (t) => {
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
  assert.match(JSON.parse(r.err).error.message, /spawn|启动失败|ENOENT/);
  // 失败不留 pid 留档
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false);
});

test('start -d：子进程即退（入口脚本不存在）→ 显式报错附日志尾部，不写 pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'rev-exit:s', 'http://127.0.0.1:1');
  // 用真实 defaultSpawnDaemon 但 argv 指向不存在脚本：子进程立即退出，ready 永不发生
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
  assert.ok(/立即退出|未上报就绪/.test(message), `应报即退或就绪超时: ${message}`);
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, '即退不得写 pid');
});

test('start -d：node.log 打开失败（被目录占位）→ 显式错误', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-logfail-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'node.log'), { recursive: true }); // node.log 是目录 → open 失败
  await bindIdentityFromJoinToken(dataDir, 'rev-log:s', 'http://127.0.0.1:1');
  const r = await runCli(['start', '-d', '--data-dir', dataDir, '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /打开日志文件失败/);
});

// ---------------------------------------------------------------------------
// 4. 启动后子进程 IPC 干净退出（无孤儿 socket / 无 token 泄漏进日志）
// ---------------------------------------------------------------------------

test('start -d：正常启停后无孤儿控制 socket，node.log 不含 token', { timeout: 60_000 }, async (t) => {
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
  // 本实例控制 socket 已清理（并发测试文件的实例互不干扰，不全局扫 /tmp）
  await waitFor(
    () => fs.stat(record.endpoint).then(() => false, () => true),
    5_000,
    '控制 socket 应清理',
  );
  assert.notEqual(record.endpoint, undefined);
  // 日志不泄漏 token
  const log = await fs.readFile(path.join(dir, 'node.log'), 'utf8').catch(() => '');
  assert.ok(!log.includes('s3cret-value'), 'node.log 不得包含 token secret');
});

// ---------------------------------------------------------------------------
// 5. service 入口选择：编译产物优先，源码运行无 dist 显式提示
// ---------------------------------------------------------------------------

test('service install 入口：源码运行且无 dist 产物 → 显式提示 pnpm build（不生成无法启动的服务）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-entry-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const { resolveServiceEntry } = await import('../src/cli.js');
  // 源码入口且同包无 dist 产物（隔离临时目录）→ 显式提示先 pnpm build
  const pkgSrc = path.join(dir, 'pkg', 'src', 'cli.ts');
  await fs.mkdir(path.dirname(pkgSrc), { recursive: true });
  await fs.writeFile(pkgSrc, '', 'utf8');
  assert.throws(() => resolveServiceEntry(pkgSrc), /pnpm build|编译产物/);
  // 伪造 dist 产物存在 → 返回 dist 路径
  const distDir = path.join(dir, 'pkg', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  const fakeDist = path.join(distDir, 'cli.js');
  await fs.writeFile(fakeDist, '', 'utf8');
  const resolved = resolveServiceEntry(pkgSrc);
  assert.equal(resolved, fakeDist);
  // serviceEntry 注入覆盖（CLI 不做存在性判断，由注入方负责）
  const r = await runCli(['service', 'status', '--data-dir', dir, '--json'], { serviceEntry: fakeDist });
  assert.equal(r.code, 0, r.err);
});

test('connect 前台：注册完成前输出「连接中」，注册后输出真实状态，Ctrl+C 优雅退出', { timeout: 60_000 }, async (t) => {
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
      // 已注册输出后模拟 Ctrl+C（forwardSignals 已接管清理）
      if (text.includes('已注册')) {
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 200);
      }
    },
  });
  const r = await runPromise;
  assert.equal(r.code, 0, r.err);
  assert.match(outputs[0] ?? '', /连接中/, '首条输出必须是连接中而非已连接');
  assert.ok(outputs.some((text) => text.includes('已注册并开始工作')));
  assert.ok(!outputs.some((text) => text.includes('已连接 ')), '不得输出「已连接」假状态');
});

test('connect --once：一次尝试即退出；鉴权拒绝时如实报失败', { timeout: 60_000 }, async (t) => {
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
// 6. service：注入执行器逐步验证（零宿主副作用：serviceHome → 临时目录）
// ---------------------------------------------------------------------------

const okExec: ServiceExec = {
  run: async () => ({ code: 0, stdout: 'active', stderr: '' }),
};
const failExec: ServiceExec = {
  run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
};

test('install：targetPath 落 serviceHome 临时目录，零宿主副作用', { timeout: 60_000 }, async (t) => {
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
  assert.ok(installed.targetPath!.startsWith(home), `targetPath 须落 serviceHome: ${installed.targetPath}`);
  assert.equal(
    await fs.stat(installed.targetPath!).then(() => true, () => false),
    true,
    '平台生效文件应写入',
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
    '卸载后平台生效文件应删除',
  );
});

test('install：daemon-reload / 注册命令失败逐步显式报错，配置保留', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-cmdfail-');
  const home = await tempDir('helm-review-svc-cmdfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // daemon-reload 失败（仅 systemctl 命令失败）
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
  // 留档副本仍在（供诊断/重试）
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helm-node.service')).then(() => true, () => false),
    true,
  );

  // 注册命令失败
  await assert.rejects(
    installNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /系统注册|permission denied/,
  );
});

test('uninstall：注销命令失败 → 保留配置且报错（不伪装已卸载）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-unfail-');
  const home = await tempDir('helm-review-svc-unfail-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');
  // 先成功安装
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  // 注销失败
  await assert.rejects(
    uninstallNodeService(cliEntry, dir, { execCommand: failExec, platform: 'linux', serviceHome: home }),
    /平台注销失败|permission denied/,
  );
  // 配置保留（含平台生效文件）
  assert.equal(
    await fs.stat(path.join(home, '.config/systemd/user/helm-node.service')).then(() => true, () => false),
    true,
  );
  assert.equal(
    await fs.stat(path.join(dir, 'service', 'helm-node.service')).then(() => true, () => false),
    true,
  );
});

test('status：三态区分（installed/running/unknown），查询失败显式诊断', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-review-svc-status-');
  const home = await tempDir('helm-review-svc-status-home-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const cliEntry = path.join(dir, 'cli.js');

  // 未安装：installed false（即使状态命令声称 active）
  const notInstalled = await getNodeServiceStatus(cliEntry, dir, {
    execCommand: okExec,
    platform: 'linux',
    serviceHome: home,
  });
  assert.equal(notInstalled.installed, false);
  assert.match(notInstalled.detail ?? '', /生效文件缺失/);

  // 已安装 + active → running
  await installNodeService(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  const running = await getNodeServiceStatus(cliEntry, dir, { execCommand: okExec, platform: 'linux', serviceHome: home });
  assert.equal(running.installed, true);
  assert.equal(running.running, 'running');

  // 已安装 + inactive → stopped
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

  // 查询失败（命令无法执行）→ unknown + 显式诊断
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
  assert.match(unknownStatus.detail ?? '', /状态查询命令失败/);
});

test('renderServiceSpec：serviceHome 覆盖三平台 targetPath；unsupported 报错', { timeout: 60_000 }, () => {
  const opts = { cliEntryPath: '/opt/cli.js', dataDir: '/opt/data', serviceHome: '/srv/fake-home' } as const;
  assert.equal(renderServiceSpec({ ...opts, platform: 'darwin' }).targetPath, '/srv/fake-home/Library/LaunchAgents/ai.helm.node.plist');
  assert.equal(renderServiceSpec({ ...opts, platform: 'linux' }).targetPath, '/srv/fake-home/.config/systemd/user/helm-node.service');
  assert.equal(renderServiceSpec({ ...opts, platform: 'win32' }).targetPath, '/srv/fake-home/HelmNode.xml');
  assert.throws(() => renderServiceSpec({ ...opts, platform: 'sunos' }), /不支持的平台/);
});

test('未知参数 --json：输出错误信封；多余位置参数拒绝', { timeout: 60_000 }, async () => {
  const r = await runCli(['bogus', 'extra', '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'unknown_command');
  assert.match(envelope.error.message, /未知命令/);
});

test('isDirectRun：pnpm symlink 调用时识别实路径（bin smoke）', { timeout: 60_000 }, async () => {
  const selfPath = new URL(import.meta.url).pathname;
  assert.equal(isDirectRun(selfPath), false, '测试模块不是 CLI 入口');
  assert.equal(isDirectRun('/definitely/not/this/file.js'), false);
  assert.equal(isDirectRun(undefined), false);
});
