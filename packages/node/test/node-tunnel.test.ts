/**
 * 节点侧 TCP 隧道（nodeTunnelOpen）测试：真实 TCP 回环 + 注入式双工流。
 * 覆盖：入参严格校验（未知字段/坏 tunnelId/严格端口拒绝）、端口拒绝的
 * 结构化错误、pause 后双向 pipe 不丢首包、draining 拒新隧道、dispose
 * 销毁全部隧道并等待 settle、getActiveTunnelCount 计数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 回环 echo TCP 服务（收到即回显），返回端口与收到过的字节。 */
async function startEchoServer(): Promise<{ port: number; received: Buffer[]; close(): Promise<void> }> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('nodeTunnelOpen：严格入参校验（未知字段/坏 tunnelId/坏 timeoutMs）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream: async () => new PassThrough() });
  try {
    for (const bad of [
      {},
      { tunnelId: '', port: 80 },
      { tunnelId: 'x'.repeat(129), port: 80 },
      { tunnelId: 't1', port: 0 },
      { tunnelId: 't1', port: 65536 },
      { tunnelId: 't1', port: 1.5 },
      { tunnelId: 't1', port: '8080' },
      { tunnelId: 't1', port: 80, extra: 1 },
      { tunnelId: 't1', port: 80, timeoutMs: -1 },
      { tunnelId: 't1', port: 80, timeoutMs: 'x' },
    ]) {
      const result = await server.nodeTunnelOpen(bad as never);
      assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
      assert.equal(!result.ok && result.error.code, 'invalid', `应 invalid ${JSON.stringify(bad)}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0, '全部被拒，无在途隧道');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：端口拒绝返回结构化错误，不静默伪造隧道', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // 占用一个端口后立即关闭：绝大多数平台上该端口无监听（回环 connect 拒绝）。
  const probe = await startEchoServer();
  const deadPort = probe.port;
  await probe.close();
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream: async () => new PassThrough() });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-refused', port: deadPort });
    assert.equal(result.ok, false);
    if (!result.ok) {
      // TCP 层错误信封：ECONNREFUSED 等诊断保留在 message，不静默伪造隧道。
      assert.equal(typeof result.error.message, 'string');
      assert.match(result.error.message, /tunnel TCP/);
    }
    assert.equal(server.getActiveTunnelCount(), 0, '失败隧道不残留');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：pause 后双向 pipe 不丢首包；重复 tunnelId 拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const echo = await startEchoServer();
  // 双工流延迟交付：模拟隧道握手耗时，验证 pause 的 TCP 不丢对端首批数据。
  const openTunnelStream = async (): Promise<Duplex> => {
    await delay(120);
    return new PassThrough();
  };
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream });
  try {
    const opened = await server.nodeTunnelOpen({ tunnelId: 't-echo', port: echo.port });
    assert.equal(opened.ok, true);
    assert.equal(server.getActiveTunnelCount(), 1);
    // 对端立即写入（早于流握手完成）：TCP 数据在 pause 期间缓冲，pipe 后送达。
    const client = net.connect({ host: '127.0.0.1', port: echo.port });
    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write('first-packet');
    const echoed = await new Promise<string>((resolve) => {
      client.once('data', (chunk) => resolve(chunk.toString()));
      setTimeout(() => resolve('TIMEOUT'), 5_000);
    });
    assert.equal(echoed, 'first-packet', '首包经隧道双向 pipe 回达');
    assert.equal(echo.received.length > 0 && echo.received[0]!.toString().includes('first-packet'), true, 'echo 服务收到首包');
    // 首帧旁路：第二次 open 同 tunnelId 在流握手前即拒绝（in-flight 冲突）。
    const dup = await server.nodeTunnelOpen({ tunnelId: 't-echo', port: echo.port });
    assert.equal(dup.ok, false);
    client.destroy();
  } finally {
    await server.dispose();
    await echo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：openTunnelStream 失败销毁两边并返回结构化错误', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const echo = await startEchoServer();
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      throw Object.assign(new Error('hub tunnel gateway rejected'), { code: 'invalid' });
    },
  });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-fail', port: echo.port });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'invalid');
    assert.equal(server.getActiveTunnelCount(), 0, '握手失败后隧道销毁不残留');
  } finally {
    await server.dispose();
    await echo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：draining 拒绝新隧道；dispose 销毁全部隧道并等待 settle', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const echo = await startEchoServer();
  const streams: PassThrough[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
  });
  try {
    const a = await server.nodeTunnelOpen({ tunnelId: 't-a', port: echo.port });
    const b = await server.nodeTunnelOpen({ tunnelId: 't-b', port: echo.port });
    assert.equal(a.ok && b.ok, true);
    assert.equal(server.getActiveTunnelCount(), 2);

    server.setDraining(true);
    const rejected = await server.nodeTunnelOpen({ tunnelId: 't-c', port: echo.port });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, 'aborted', 'draining 期间新隧道被拒（aborted）');
    assert.equal(server.getActiveTunnelCount(), 2, '在途隧道不受 draining 影响');

    // dispose：销毁全部隧道 TCP/双工流并等待 settle。
    await server.dispose();
    assert.equal(server.getActiveTunnelCount(), 0);
    for (const stream of streams) {
      assert.equal(stream.destroyed, true, '双工流已销毁');
    }
    const afterDispose = await server.nodeTunnelOpen({ tunnelId: 't-d', port: echo.port });
    assert.equal(afterDispose.ok, false);
    assert.equal(!afterDispose.ok && afterDispose.error.code, 'aborted', 'disposed 后拒绝（aborted）');
  } finally {
    await server.dispose();
    await echo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
