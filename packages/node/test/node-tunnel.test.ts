/**
 * node side TCP tunnel (nodeTunnelOpen / nodeTunnelAbort) test: real TCP loopback +
 * Duplex.from({readable,writable}) construct into real double work for (data true stream via tunnel double end,
 * never use beside route TCP smoke fill tunnel succeeded).
 * override: reference strictly validate (contains strictly port/host reject), port reject connect_failed,
 * host default 127.0.0.1 and explicit host pass-through, grasp manually in dispose immediately settle, grasp manually phase
 * for end disconnect,abort RPC cancel create connect,banner first package do not lose, large payload,end semantics
 * flush complete response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Duplex, PassThrough, type Duplex as DuplexType } from 'node:stream';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir } from '@helm/test-kit/node';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

/** real double work for:a and b mutual is for end, write a data can from b read to (via tunnel stream real forwarding). */
function duplexPair(): [DuplexType, DuplexType] {
  const toNode = new PassThrough();
  const toHub = new PassThrough();
  return [
    Duplex.from({ readable: toNode, writable: toHub }),
    Duplex.from({ readable: toHub, writable: toNode }),
  ];
}

/** loopback TCP service:accept i.e. banner;echo its after receives data. */
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

test('nodeTunnelOpen: strictly reference validate (unknown field/broken tunnelId/strictly port reject)', { timeout: 60_000 }, async () => {
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
      assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
      assert.equal(!result.ok && result.error.code, 'invalid', `should invalid ${JSON.stringify(bad)}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0, 'all by refuse, without in-flight tunnel');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: port reject archive one connect_failed, not silently fabricate tunnel', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // occupy a port after immediately close: the port without listen (loopback connect reject).
  const probe = await startBannerEchoServer('x');
  const deadPort = probe.port;
  await probe.close();
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream: async () => new PassThrough() });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-refused', port: deadPort });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'connect_failed', 'TCP error archive one connect_failed(system code do not outside overflow code)');
      assert.match(result.error.message, /ECONNREFUSED/, 'message keep underlying system diagnose');
    }
    assert.equal(server.getActiveTunnelCount(), 0, 'failed tunnel leaves no residue');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: grasp manually latency after via tunnel double work stream read to banner(pause do not lose first package)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const banner = 'HELLO-BANNER\r\n';
  const srv = await startBannerEchoServer(banner);
  // tunnel for end stream latency deliver (simulated WS grasp manually time cost);peer side proxy table Hub end stream.
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
    // banner in TCP accept i.e. out (early at stream grasp manually complete):pause buffer,pipe let through,
    // peer end via tunnel stream read to complete banner- - real stream via tunnel, non- beside route.
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
    assert.ok(gotBanner.includes(banner), `peer should via tunnel read to banner, actual: ${JSON.stringify(gotBanner)}`);
    // via tunnel stream data → node TCP → echo service → back to peer end.
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
    assert.ok(echoed.includes('ping-through-tunnel'), 'request via tunnel to return');
    assert.ok(srv.received.some((c) => c.toString().includes('ping-through-tunnel')), 'echo service indeed receives (real forwarding)');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: large payload via tunnel double to complete transfer', { timeout: 60_000 }, async () => {
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
    // 4 MiB exceeds single frame/buffer high watermark, verify shard heavy group after complete to return.
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
    assert.equal(echoed.length, payload.length, 'large payload complete to return (length consistent)');
    assert.equal(echoed, payload, 'large payload complete to return (content consistent)');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: normal end semantics flush complete response (do not destroy pinch assert)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // service receives request after write large response again end: verify pipe  end link complete flush.
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
    let timeoutId: NodeJS.Timeout | undefined;
    const echoed = await Promise.race([
      got,
      new Promise<string>((resolve) => {
        timeoutId = setTimeout(() => resolve('TIMEOUT'), 10_000);
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    assert.equal(echoed, response, 'end semantics under complete response flush back reach, do not by destroy pinch assert');
  } finally {
    await rpc.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: grasp manually in dispose immediately destroy and settle, do not etc. pre- compute exhausted', { timeout: 60_000 }, async () => {
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
    // etc. TCP connect on, enter WS grasp manually wait for.
    await delay(100);
    assert.equal(server.getActiveTunnelCount(), 1);
    const start = Date.now();
    await server.dispose();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5_000, `dispose should immediately settle(actual ${elapsed}ms)`);
    const result = await openPromise;
    assert.equal(result.ok, false, 'grasp manually in open follow dispose failed');
    if (!result.ok) {
      assert.equal(result.error.code, 'aborted');
    }
    assert.equal(server.getActiveTunnelCount(), 0);
    // dispose after late to stream resolve must not re- tunnel/leak leak.
    resolveStream?.(new PassThrough());
    await delay(50);
    assert.equal(server.getActiveTunnelCount(), 0, 'late to stream does not resurrect tunnel');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelAbort: grasp manually in cancel create connect immediately failed (do not etc. pre- compute),signal already notify', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const streamSignals: AbortSignal[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: (tunnelId, signal) =>
      new Promise<DuplexType>(() => {
        streamSignals.push(signal!);
        // forever do not resolve: only signal can final.
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
    assert.ok(elapsed < 5_000, `abort after open should immediately failed (actual ${elapsed}ms)`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(server.getActiveTunnelCount(), 0);
    assert.equal(streamSignals[0]?.aborted, true, 'create connect signal already abort(WS immediately disconnect)');
    // unknown tunnelId idempotent without harm.
    await server.nodeTunnelAbort('no-such');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen: grasp manually phase for end (service) disconnect return structure error', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // grasp manually forever pending: by TCP side disconnect (service destroy socket) final.
    openTunnelStream: () => new Promise<DuplexType>(() => undefined),
  });
  try {
    const openPromise = server.nodeTunnelOpen({ tunnelId: 't-early', port: srv.port, timeoutMs: 15_000 });
    await delay(100);
    // service side actively disconnect:TCP error/close must by unify handle (do not not catch crash process),
    // open immediately with connect_failed/aborted structure failed (must not drag to 15s timeout).
    const start = Date.now();
    for (const socket of srv.sockets) socket.destroy();
    const result = await openPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `grasp manually phase for end disconnect should immediately failed (actual ${elapsed}ms)`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(['connect_failed', 'aborted'].includes(result.error.code), `structure error, actual ${result.error.code}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen:draining reject new tunnel;dispose destroy all and wait for settle', { timeout: 60_000 }, async () => {
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
    assert.equal(!rejected.ok && rejected.error.code, 'node_draining', 'draining during new tunnel by refuse (node_draining)');
    assert.equal(server.getActiveTunnelCount(), 2, 'in-flight tunnel do not subject to draining affect');

    await server.dispose();
    assert.equal(server.getActiveTunnelCount(), 0);
    for (const stream of streams) {
      assert.equal(stream.destroyed, true, 'double work stream already destroy');
    }
    const afterDispose = await server.nodeTunnelOpen({ tunnelId: 't-d', port: srv.port });
    assert.equal(afterDispose.ok, false);
    assert.equal(!afterDispose.ok && afterDispose.error.code, 'aborted', 'disposed after reject (aborted)');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen:host explicit pass-through (localhost domain parse after connect real service)', { timeout: 60_000 }, async () => {
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
    // explicit host=localhost: node parse domain and connect (etc. price 127.0.0.1 on test service).
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
    assert.ok(got.includes('HOST-BANNER'), 'via explicit host establish tunnel real read to banner');
    peer.destroy();
    peer.on('error', () => undefined);
    // host default: by default 127.0.0.1(and since has loopback semantics consistent).
    const openedDefault = await server.nodeTunnelOpen({ tunnelId: 't-default', port: srv.port });
    assert.equal(openedDefault.ok, true);
    // consume and close second tunnel peer(simulated Hub end disconnect; unconsumed peer in node side
    // destroy when will with not handle error crash - - real deploy in Hub end must however hold has consumer).
    const peerDefault = await pending[1]!;
    peerDefault.on('error', () => undefined);
    peerDefault.destroy();
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen:host target failed to connect archive one connect_failed(real target message)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // occupy after immediately release: obtain to a loopback on must reject port.
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
      assert.equal(result.error.code, 'connect_failed', 'failed to connect archive one connect_failed');
      assert.match(result.error.message, new RegExp(`localhost:${deadPort}`), 'error information contains real target host:port');
    }
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
