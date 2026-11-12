/**
 * 节点侧 TCP 隧道（nodeTunnelOpen / nodeTunnelAbort）测试：真实 TCP 回环 +
 * Duplex.from({readable,writable}) 构成的真实双工对（数据真的流经隧道双端，
 * 绝不用旁路 TCP 冒充隧道成功）。
 * 覆盖：入参严格校验（含严格端口/host 拒绝）、端口拒绝 connect_failed、
 * host 缺省 127.0.0.1 与显式 host 透传、握手中 dispose 立即 settle、握手期
 * 对端断开、abort RPC 取消建连、banner 首包不丢、大 payload、end 语义
 * flush 完整响应。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough, type Duplex as DuplexType } from 'node:stream';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 真实双工对：a 与 b 互为对端，写入 a 的数据可从 b 读到（经隧道流真实转发）。 */
function duplexPair(): [DuplexType, DuplexType] {
  const toNode = new PassThrough();
  const toHub = new PassThrough();
  return [
    Duplex.from({ readable: toNode, writable: toHub }),
    Duplex.from({ readable: toHub, writable: toNode }),
  ];
}

/** 回环 TCP 服务：accept 即发 banner；echo 其后收到的数据。 */
async function startBannerEchoServer(banner: string): Promise<{
  port: number;
  received: Buffer[];
  sockets: net.Socket[];
  close(): Promise<void>;
}> {
  const received: Buffer[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.write(banner);
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
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test('nodeTunnelOpen：严格入参校验（未知字段/坏 tunnelId/严格端口拒绝）', { timeout: 60_000 }, async () => {
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
      { tunnelId: 't1', port: 80, host: 123 },
      { tunnelId: 't1', port: 80, host: '' },
      { tunnelId: 't1', port: 80, host: ' 127.0.0.1' },
      { tunnelId: 't1', port: 80, host: 'bad\nhost' },
      { tunnelId: 't1', port: 80, host: 'a'.repeat(256) },
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

test('nodeTunnelOpen：端口拒绝归一 connect_failed，不静默伪造隧道', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // 占用一个端口后立即关闭：该端口无监听（回环 connect 拒绝）。
  const probe = await startBannerEchoServer('x');
  const deadPort = probe.port;
  await probe.close();
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream: async () => new PassThrough() });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-refused', port: deadPort });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'connect_failed', 'TCP 错误归一 connect_failed（系统码不外溢 code）');
      assert.match(result.error.message, /ECONNREFUSED/, 'message 保留底层系统诊断');
    }
    assert.equal(server.getActiveTunnelCount(), 0, '失败隧道不残留');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：握手延迟后经隧道双工流读到 banner（pause 不丢首包）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const banner = 'HELLO-BANNER\r\n';
  const srv = await startBannerEchoServer(banner);
  // 隧道对端流延迟交付（模拟 WS 握手耗时）；peer 侧代表 Hub 端流。
  const pending: Array<Promise<DuplexType>> = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      await delay(150);
      const [nodeSide, peerSide] = duplexPair();
      pending.push(Promise.resolve(peerSide));
      return nodeSide;
    },
  });
  try {
    const opened = await server.nodeTunnelOpen({ tunnelId: 't-banner', port: srv.port });
    assert.equal(opened.ok, true);
    // banner 在 TCP accept 即发出（早于流握手完成）：pause 缓冲、pipe 放行，
    // peer 端经隧道流读到完整 banner——真实流经隧道，非旁路。
    const peer = await pending[0]!;
    const gotBanner = await new Promise<string>((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve(buf), 5_000);
      peer.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes(banner)) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
    });
    assert.ok(gotBanner.includes(banner), `peer 应经隧道读到 banner，实际: ${JSON.stringify(gotBanner)}`);
    // 经隧道流发数据 → 节点 TCP → echo 服务 → 回到 peer 端。
    peer.write('ping-through-tunnel');
    const echoed = await new Promise<string>((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve(buf), 5_000);
      peer.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('ping-through-tunnel')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
    });
    assert.ok(echoed.includes('ping-through-tunnel'), '请求经隧道往返');
    assert.ok(srv.received.some((c) => c.toString().includes('ping-through-tunnel')), 'echo 服务确实收到（真实转发）');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：大 payload 经隧道双向完整传输', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const pending: Array<Promise<DuplexType>> = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      const [nodeSide, peerSide] = duplexPair();
      pending.push(Promise.resolve(peerSide));
      return nodeSide;
    },
  });
  try {
    const opened = await server.nodeTunnelOpen({ tunnelId: 't-big', port: srv.port });
    assert.equal(opened.ok, true);
    const peer = await pending[0]!;
    // 4 MiB 超过单帧/缓冲的高水位，验证分片重组后完整往返。
    const payload = 'A'.repeat(4 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    peer.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    peer.write(payload);
    const echoed = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 10_000);
      const check = (): void => {
        if (total >= payload.length) {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString());
        }
      };
      peer.on('data', check);
      check();
    });
    assert.equal(echoed.length, payload.length, '大 payload 完整往返（长度一致）');
    assert.equal(echoed, payload, '大 payload 完整往返（内容一致）');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：正常 end 语义 flush 完整响应（不 destroy 掐断）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // 服务收到请求后写大响应再 end：验证 pipe 的 end 链路完整 flush。
  const response = 'R'.repeat(2 * 1024 * 1024);
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('req')) {
        socket.end(response);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const pending: Array<Promise<DuplexType>> = [];
  const rpc = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      const [nodeSide, peerSide] = duplexPair();
      pending.push(Promise.resolve(peerSide));
      return nodeSide;
    },
  });
  try {
    const opened = await rpc.nodeTunnelOpen({ tunnelId: 't-flush', port });
    assert.equal(opened.ok, true);
    const peer = await pending[0]!;
    const chunks: Buffer[] = [];
    const got = new Promise<string>((resolve) => {
      peer.on('data', (c) => chunks.push(c));
      peer.on('end', () => resolve(Buffer.concat(chunks).toString()));
      peer.on('close', () => resolve(Buffer.concat(chunks).toString()));
    });
    peer.end('req');
    const echoed = await Promise.race([got, delay(10_000).then(() => 'TIMEOUT')]);
    assert.equal(echoed, response, 'end 语义下完整响应 flush 回达，不被 destroy 掐断');
  } finally {
    await rpc.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：握手中 dispose 立即销毁并 settle，不等预算耗尽', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  let resolveStream: ((stream: DuplexType) => void) | undefined;
  const streamSignals: AbortSignal[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: (tunnelId, signal) =>
      new Promise<DuplexType>((resolve, reject) => {
        streamSignals.push(signal!);
        resolveStream = resolve;
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true });
      }),
  });
  try {
    const openPromise = server.nodeTunnelOpen({ tunnelId: 't-dispose', port: srv.port, timeoutMs: 15_000 });
    // 等 TCP 连上、进入 WS 握手等待。
    await delay(100);
    assert.equal(server.getActiveTunnelCount(), 1);
    const start = Date.now();
    await server.dispose();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5_000, `dispose 应立即 settle（实际 ${elapsed}ms）`);
    const result = await openPromise;
    assert.equal(result.ok, false, '握手中的 open 随 dispose 失败');
    if (!result.ok) {
      assert.equal(result.error.code, 'aborted');
    }
    assert.equal(server.getActiveTunnelCount(), 0);
    // dispose 后迟到的流 resolve 不得复活隧道/泄漏。
    resolveStream?.(new PassThrough());
    await delay(50);
    assert.equal(server.getActiveTunnelCount(), 0, '迟到流不复活隧道');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelAbort：握手中取消建连立即失败（不等预算），signal 已通知', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const streamSignals: AbortSignal[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: (tunnelId, signal) =>
      new Promise<DuplexType>(() => {
        streamSignals.push(signal!);
        // 永不 resolve：仅 signal 能终结。
      }),
  });
  try {
    const openPromise = server.nodeTunnelOpen({ tunnelId: 't-abort', port: srv.port, timeoutMs: 15_000 });
    await delay(100);
    assert.equal(server.getActiveTunnelCount(), 1);
    const start = Date.now();
    await server.nodeTunnelAbort('t-abort');
    const result = await openPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5_000, `abort 后 open 应立即失败（实际 ${elapsed}ms）`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(server.getActiveTunnelCount(), 0);
    assert.equal(streamSignals[0]?.aborted, true, '建连 signal 已 abort（WS 立即断开）');
    // 未知 tunnelId 幂等无害。
    await server.nodeTunnelAbort('no-such');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：握手期对端（服务）断开返回结构化错误', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // 握手永远悬挂：由 TCP 侧断开（服务销毁 socket）终结。
    openTunnelStream: () => new Promise<DuplexType>(() => undefined),
  });
  try {
    const openPromise = server.nodeTunnelOpen({ tunnelId: 't-early', port: srv.port, timeoutMs: 15_000 });
    await delay(100);
    // 服务侧主动断开：TCP error/close 必须被统一处理（不未捕获崩进程），
    // open 以 connect_failed/aborted 结构化失败。
    for (const socket of srv.sockets) socket.destroy();
    const result = await openPromise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(['connect_failed', 'aborted', 'timeout'].includes(result.error.code), `结构化错误，实际 ${result.error.code}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：draining 拒绝新隧道；dispose 销毁全部并等待 settle', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
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
    const a = await server.nodeTunnelOpen({ tunnelId: 't-a', port: srv.port });
    const b = await server.nodeTunnelOpen({ tunnelId: 't-b', port: srv.port });
    assert.equal(a.ok && b.ok, true);
    assert.equal(server.getActiveTunnelCount(), 2);

    server.setDraining(true);
    const rejected = await server.nodeTunnelOpen({ tunnelId: 't-c', port: srv.port });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, 'aborted', 'draining 期间新隧道被拒（aborted）');
    assert.equal(server.getActiveTunnelCount(), 2, '在途隧道不受 draining 影响');

    await server.dispose();
    assert.equal(server.getActiveTunnelCount(), 0);
    for (const stream of streams) {
      assert.equal(stream.destroyed, true, '双工流已销毁');
    }
    const afterDispose = await server.nodeTunnelOpen({ tunnelId: 't-d', port: srv.port });
    assert.equal(afterDispose.ok, false);
    assert.equal(!afterDispose.ok && afterDispose.error.code, 'aborted', 'disposed 后拒绝（aborted）');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：host 显式透传（localhost 域名解析后连接真实服务）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('HOST-BANNER\r\n');
  const pending: Array<Promise<DuplexType>> = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      const [nodeSide, peerSide] = duplexPair();
      pending.push(Promise.resolve(peerSide));
      return nodeSide;
    },
  });
  try {
    // 显式 host=localhost：节点解析域名并连接（等价 127.0.0.1 上的测试服务）。
    const opened = await server.nodeTunnelOpen({ tunnelId: 't-host', host: 'localhost', port: srv.port });
    assert.equal(opened.ok, true);
    const peer = await pending[0]!;
    const got = await new Promise<string>((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve(buf), 5_000);
      peer.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('HOST-BANNER')) { clearTimeout(timer); resolve(buf); }
      });
    });
    assert.ok(got.includes('HOST-BANNER'), '经显式 host 建立的隧道真实读到 banner');
    peer.destroy();
    peer.on('error', () => undefined);
    // host 缺省：默认 127.0.0.1（与既有 loopback 语义一致）。
    const openedDefault = await server.nodeTunnelOpen({ tunnelId: 't-default', port: srv.port });
    assert.equal(openedDefault.ok, true);
    // 消费并关闭第二条隧道的 peer（模拟 Hub 端断开；未消费的 peer 在节点侧
    // 销毁时会以未处理 error 崩溃——真实部署中 Hub 端必然持有消费者）。
    const peerDefault = await pending[1]!;
    peerDefault.on('error', () => undefined);
    peerDefault.destroy();
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen：host 目标连接失败归一 connect_failed（真实目标入 message）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // 占用后立即释放：得到一个回环上必拒绝的端口。
  const probe = await startBannerEchoServer('x');
  const deadPort = probe.port;
  await probe.close();
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => new PassThrough(),
  });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-refused-host', host: 'localhost', port: deadPort });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'connect_failed', '连接失败归一 connect_failed');
      assert.match(result.error.message, new RegExp(`localhost:${deadPort}`), '错误信息包含真实目标 host:port');
    }
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
