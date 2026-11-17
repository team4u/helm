/**
 * Node-side TCP tunnel tests (`nodeTunnelOpen` / `nodeTunnelAbort`): real TCP loopback +
 * real duplex pairs built from `Duplex.from({ readable, writable })` so data genuinely
 * flows through both tunnel ends rather than bypassing it.
 * Covers: strict parameter validation (unknown fields, invalid tunnelId/port/host),
 * port connection refused -> `connect_failed`, default `127.0.0.1` vs explicit `host`
 * passthrough, immediate settle on `dispose()` during handshake, peer disconnect during
 * handshake, `abort` RPC cancelling connect, banner first-packet preservation, large
 * payloads, and `end` flushing complete responses.
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

/** Real duplex pair: data written to `a` reads from `b` (relayed through tunnel stream). */
function duplexPair(): [DuplexType, DuplexType] {
  const toNode = new PassThrough();
  const toHub = new PassThrough();
  return [
    Duplex.from({ readable: toNode, writable: toHub }),
    Duplex.from({ readable: toHub, writable: toNode }),
  ];
}

/** Loopback TCP server: sends banner immediately on accept and echoes subsequent incoming bytes. */
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

test('nodeTunnelOpen validates parameters strictly (unknown fields, invalid tunnelId/port/host)', { timeout: 60_000 }, async () => {
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
      assert.equal(!result.ok && result.error.code, 'invalid', `should return invalid for ${JSON.stringify(bad)}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0, 'all invalid calls rejected with zero active tunnels');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen normalizes port refusal to connect_failed without fabricating a tunnel', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // Claim a port then immediately close it so loopback connect fails with ECONNREFUSED.
  const probe = await startBannerEchoServer('x');
  const deadPort = probe.port;
  await probe.close();
  const server = createNodeEnvRpcServer({ defaultCwd: dir, openTunnelStream: async () => new PassThrough() });
  try {
    const result = await server.nodeTunnelOpen({ tunnelId: 't-refused', port: deadPort });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'connect_failed', 'TCP refusal normalizes to connect_failed (no raw errno leak in code)');
      assert.match(result.error.message, /ECONNREFUSED/, 'message preserves underlying system diagnostic');
    }
    assert.equal(server.getActiveTunnelCount(), 0, 'failed tunnel leaves no active state');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen preserves initial banner sent before handshake completes (pause/pipe buffering)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const banner = 'HELLO-BANNER\r\n';
  const srv = await startBannerEchoServer(banner);
  // Delay peer stream delivery to simulate WS handshake latency; peer represents the Hub end.
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
    // Banner arrives right at TCP accept (before stream handshake completes): pause buffers it until pipe drains
    // so peer reads the complete banner genuinely across the tunnel stream.
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
    assert.ok(gotBanner.includes(banner), `peer should read banner across tunnel, actual: ${JSON.stringify(gotBanner)}`);
    // Round-trip data: peer -> tunnel stream -> node TCP -> echo server -> peer.
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
    assert.ok(echoed.includes('ping-through-tunnel'), 'request round-tripped through tunnel');
    assert.ok(srv.received.some((c) => c.toString().includes('ping-through-tunnel')), 'echo server actually received bytes');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen transfers large payloads bidirectionally across the tunnel', { timeout: 60_000 }, async () => {
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
    // 4 MiB exceeds single-frame and stream highWaterMark limits to exercise chunking and reassembly.
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
    assert.equal(echoed.length, payload.length, 'large payload round-tripped with matching length');
    assert.equal(echoed, payload, 'large payload round-tripped with identical content');
    peer.destroy();
    peer.on('error', () => undefined);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen flushes complete response under normal end semantics without premature destroy', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // Server writes a large response and calls end(); ensures piped end path flushes completely.
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
    assert.equal(echoed, response, 'complete response flushes cleanly under end semantics instead of being cut off by destroy');
  } finally {
    await rpc.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen settles immediately on dispose during handshake without waiting for timeoutMs', { timeout: 60_000 }, async () => {
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
    // Wait for TCP connect before pausing inside WS handshake.
    await delay(100);
    assert.equal(server.getActiveTunnelCount(), 1);
    const start = Date.now();
    await server.dispose();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5_000, `dispose should settle immediately (actual ${elapsed}ms)`);
    const result = await openPromise;
    assert.equal(result.ok, false, 'in-flight open during handshake should fail on dispose');
    if (!result.ok) {
      assert.equal(result.error.code, 'aborted');
    }
    assert.equal(server.getActiveTunnelCount(), 0);
    // Late stream resolution after dispose must neither leak nor resurrect the tunnel.
    resolveStream?.(new PassThrough());
    await delay(50);
    assert.equal(server.getActiveTunnelCount(), 0, 'late stream must not resurrect tunnel');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelAbort cancels handshake connect immediately and aborts signal without waiting for timeout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const streamSignals: AbortSignal[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: (tunnelId, signal) =>
      new Promise<DuplexType>(() => {
        streamSignals.push(signal!);
        // Never resolves: only AbortSignal terminates handshake.
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
    assert.ok(elapsed < 5_000, `open should fail immediately after abort (actual ${elapsed}ms)`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(server.getActiveTunnelCount(), 0);
    assert.equal(streamSignals[0]?.aborted, true, 'connect signal aborted immediately (closing WS)');
    // Aborting an unknown tunnelId is a harmless no-op.
    await server.nodeTunnelAbort('no-such');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen returns structured error if target service disconnects during handshake', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  const srv = await startBannerEchoServer('');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // Handshake hangs forever; termination occurs when TCP service destroys the socket.
    openTunnelStream: () => new Promise<DuplexType>(() => undefined),
  });
  try {
    const openPromise = server.nodeTunnelOpen({ tunnelId: 't-early', port: srv.port, timeoutMs: 15_000 });
    await delay(100);
    // Server actively closes TCP socket: TCP error/close must be handled safely without crashing,
    // and open must settle immediately with connect_failed/aborted instead of hitting 15s timeout.
    const start = Date.now();
    for (const socket of srv.sockets) socket.destroy();
    const result = await openPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `peer disconnect during handshake should fail immediately (actual ${elapsed}ms)`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(['connect_failed', 'aborted'].includes(result.error.code), `expected structured error, got ${result.error.code}`);
    }
    assert.equal(server.getActiveTunnelCount(), 0);
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen rejects new tunnels while draining and destroys all on dispose', { timeout: 60_000 }, async () => {
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
    assert.equal(!rejected.ok && rejected.error.code, 'node_draining', 'rejects new tunnel while draining (node_draining)');
    assert.equal(server.getActiveTunnelCount(), 2, 'in-flight tunnels are unaffected by draining');

    await server.dispose();
    assert.equal(server.getActiveTunnelCount(), 0);
    for (const stream of streams) {
      assert.equal(stream.destroyed, true, 'all open streams must be destroyed');
    }
    const afterDispose = await server.nodeTunnelOpen({ tunnelId: 't-d', port: srv.port });
    assert.equal(afterDispose.ok, false);
    assert.equal(!afterDispose.ok && afterDispose.error.code, 'aborted', 'rejects new tunnel after dispose (aborted)');
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen passes through explicit host (resolves localhost to connect to target service)', { timeout: 60_000 }, async () => {
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
    // Explicit host=localhost: node resolves domain and connects to test server on loopback.
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
    assert.ok(got.includes('HOST-BANNER'), 'tunnel created with explicit host reads banner');
    peer.destroy();
    peer.on('error', () => undefined);
    // Omitting host defaults to 127.0.0.1 loopback behavior.
    const openedDefault = await server.nodeTunnelOpen({ tunnelId: 't-default', port: srv.port });
    assert.equal(openedDefault.ok, true);
    // Consume and close second tunnel peer (simulating Hub close; unconsumed peer streams
    // would emit unhandled error events on node-side destroy).
    const peerDefault = await pending[1]!;
    peerDefault.on('error', () => undefined);
    peerDefault.destroy();
  } finally {
    await server.dispose();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nodeTunnelOpen normalizes host connect failures to connect_failed including target host:port', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-tunnel-');
  // Claim a port then immediately close it so loopback connect fails with ECONNREFUSED.
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
      assert.equal(result.error.code, 'connect_failed', 'connect failure normalizes to connect_failed');
      assert.match(result.error.message, new RegExp(`localhost:${deadPort}`), 'error message includes target host:port');
    }
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
