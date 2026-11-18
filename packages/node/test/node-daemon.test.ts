/**
 * End-to-end integration tests for `@helm/node` without mocking the modules under test:
 * - `NodeEnvRpcServer`: real files, directories, readers, command execution, and Unix Socket IPC bridge;
 * - Identity persistence: real temp directories, `0600` permissions, token rotation, and cross-nodeId conflict rejection;
 * - `createNodeDaemon`: real local `http.Server` + `WebSocketServer` + `birpc` Hub stub testing
 *   `envExec` / `envReadTextFile` / `ipcCall`, reconnects, and auth rejection (`4003`);
 * - `runNodeCli`: `status` / service templates (3 platforms) / `--help` / `--json`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  HubEnvStreamFunctions,
  NodeEnvRpcFunctions,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helm/protocol';
import { createNodeEnvRpcServer, type NodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';
import {
  bindIdentityFromJoinToken,
  createNodeDaemon,
  parseJoinToken,
  readNodeIdentity,
} from '../src/daemon/index.js';
import { renderServiceSpec, defaultServiceExec } from '../src/daemon/service.js';
import { runNodeCli } from '../src/cli.js';
import { sanitizedHostEnv } from './helpers/sanitized-env.js';

import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. Minimal dependency guard: keep @helm/node runtime dependencies bounded
// ---------------------------------------------------------------------------

test('@helm/node runtime dependencies stay minimal and explicit', { timeout: 60_000 }, async () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}).sort(),
    ['@earendil-works/chord', '@earendil-works/pi-durable', '@helm/env-io', '@helm/protocol', '@helm/update', 'birpc', 'ws'],
    '@helm/node dependencies must stay limited to @earendil-works/chord, @earendil-works/pi-durable, @helm/env-io, @helm/protocol, @helm/update, birpc, and ws',
  );
});


/** Poll until an observable condition holds (instead of fixed sleeps), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// 1. NodeEnvRpcServer: files, directories, readers, exec, and dispose
// ---------------------------------------------------------------------------

test('env file read/write and directory listing', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-env-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const write = await server.envWriteFile({ path: 'a.txt', content: 'hello helm' });
    assert.equal(write.ok, true);
    const read = await server.envReadTextFile({ path: 'a.txt' });
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.value, 'hello helm');

    const append = await server.envAppendFile({ path: 'a.txt', content: '!' });
    assert.equal(append.ok, true);
    const read2 = await server.envReadTextFile({ path: 'a.txt' });
    assert.equal(read2.ok && read2.value, 'hello helm!');

    // base64 binary read/write
    const bytes = Buffer.from([0, 1, 2, 255]);
    await server.envWriteFile({ path: 'b.bin', content: bytes.toString('base64'), encoding: 'base64' });
    const bin = await server.envReadBinaryFile({ path: 'b.bin' });
    assert.equal(bin.ok, true);
    assert.deepEqual(bin.ok && Buffer.from(bin.value.base64, 'base64'), bytes);

    // directory list
    await server.envCreateDir({ path: 'sub', recursive: true });
    await server.envWriteFile({ path: 'sub/c.txt', content: 'x' });
    const list = await server.envListDir({ path: '.' });
    assert.equal(list.ok, true);
    const names = (list.ok ? list.value : []).map((e) => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'b.bin', 'sub']);

    // Missing file -> structured not_found error
    const missing = await server.envReadTextFile({ path: 'no-such.txt' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');

    // Absolute path resolution
    const abs = await server.envAbsolutePath({ path: 'a.txt' });
    assert.equal(abs.ok && abs.value, path.join(dir, 'a.txt'));
    const exists = await server.envExists({ path: 'a.txt' });
    assert.equal(exists.ok && exists.value, true);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Text/Binary/Dir Reader lifecycle and dispose cleanup', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-readers-');
  await fs.writeFile(path.join(dir, 'lines.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from([0x41, 0x0a, 0x43, 0x44])); // "A\nCD": 1 newline
  await fs.mkdir(path.join(dir, 'd'));
  await fs.writeFile(path.join(dir, 'd', 'x'), '1');
  await fs.writeFile(path.join(dir, 'd', 'y'), '2');

  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    // Text reader
    const t = await server.envOpenTextLineReader({ path: 'lines.txt' });
    assert.equal(t.ok, true);
    const tid = t.ok ? t.value.readerId : '';
    assert.match(tid, /^r\d+$/);
    const l1 = await server.envTextReaderRead({ readerId: tid });
    assert.equal(l1.ok && l1.value?.text, 'one');
    const l2 = await server.envTextReaderRead({ readerId: tid });
    assert.equal(l2.ok && l2.value?.text, 'two');
    // Unknown reader returns explicit error
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
    // Reading after close returns explicit error
    await server.envTextReaderClose({ readerId: tid });
    const closed = await server.envTextReaderRead({ readerId: tid });
    assert.equal(!closed.ok && closed.error.code, 'not_found');

    // Binary reader
    const b = await server.envOpenBinaryReader({ path: 'data.bin' });
    assert.equal(b.ok, true);
    const bid = b.ok ? b.value.readerId : '';
    const chunk = await server.envBinaryReaderRead({ readerId: bid, offset: 1, length: 2 });
    assert.deepEqual(chunk.ok && Buffer.from(chunk.value.base64, 'base64'), Buffer.from([0x0a, 0x43]));
    const info = await server.envBinaryReaderInfo({ readerId: bid });
    assert.equal(info.ok && info.value.size, 4);
    const scan = await server.envBinaryReaderScanLines({ readerId: bid, startLine: 1 });
    assert.equal(scan.ok && scan.value.newlines, 1);
    assert.equal(scan.ok && scan.value.firstLineBytes, 2); // Line 1: "CD"

    // Dir reader
    const d = await server.envOpenDirReader({ path: 'd' });
    assert.equal(d.ok, true);
    const did = d.ok ? d.value.readerId : '';
    const page = await server.envDirReaderNext({ readerId: did, maxEntries: 10 });
    assert.equal(page.ok && page.value.entries.length, 2);
    assert.equal(page.ok && page.value.done, true);

    // dispose closes all open readers
    assert.equal(server.getOpenReaderCount(), 2); // binary + dir
    await server.dispose();
    assert.equal(server.getOpenReaderCount(), 0);
    // dispose is idempotent
    await server.dispose();
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('envExec streams output and envAbortExec terminates child process tree immediately', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-exec-');
  const chunks: EnvExecOutputEvent[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onExecOutput: (event) => chunks.push(event),
    shellEnv: { HELM_TEST_MARKER: 'from-shell-env' },
  });
  try {
    // Real command: stdout streaming
    const ok = await server.envExec({
      execId: 'e1',
      command: 'echo hello-from-exec && echo marker=$HELM_TEST_MARKER 1>&2',
      timeout: 30,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.value.exitCode, 0);
    const text = chunks.map((c) => c.text).join('');
    assert.match(text, /hello-from-exec/);
    assert.match(text, /marker=from-shell-env/); // shellEnv injection applies
    const stderrChunk = chunks.find((c) => c.stream === 'stderr');
    assert.ok(stderrChunk !== undefined, 'stderr stream tag is accurate');

    // abort: long sleep command terminates immediately (structured aborted error much faster than timeout)
    const start = Date.now();
    const slow = server.envExec({ execId: 'e2', command: 'sleep 30', timeout: 60 });
    await delay(200); // Wait for child process to start
    assert.equal(server.getActiveExecCount(), 1);
    await server.envAbortExec('e2');
    const result = await slow;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'aborted');
    assert.ok(elapsed < 10_000, `abort should take effect immediately (actual ${elapsed}ms)`);

    // dispose kills in-flight processes
    const long = server.envExec({ execId: 'e3', command: 'sleep 60', timeout: 120 });
    await delay(300);
    assert.equal(server.getActiveExecCount(), 1);
    await server.dispose();
    const r3 = await long;
    assert.equal(r3.ok, false);
    assert.equal(!r3.ok && r3.error.code, 'aborted');
    assert.equal(server.getActiveExecCount(), 0);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. NodeEnvRpcServer IPC bridge (real Unix Socket)
// ---------------------------------------------------------------------------

interface IpcTestServer {
  path: string;
  close(): Promise<void>;
}

/**
 * connect level error: client actively disconnect (ipcUnsubscribe / ipcAbortCall / timeout clean up) is IPC bridge happy path.
 * for end close after fixture may also has once in-flight write, kernel back RST when i.e. EPIPE.
 */
const IPC_DISCONNECT_ERROR_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

function isIpcDisconnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && IPC_DISCONNECT_ERROR_CODES.has(code);
}

/** real Unix Socket simulated Herdr: each connect one row request one row response. */
async function startHerdrLikeServer(
  handler: (line: string, socket: net.Socket) => void,
): Promise<IpcTestServer> {
  const dir = await tempDir('helm-node-ipc-');
  const sockPath = path.join(dir, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  /** non- connect level error:fixture itself fault must in close() expose, cannot by for end disconnect mask. */
  const faults: Error[] = [];
  const record = (error: unknown): void => {
    if (isIpcDisconnectError(error)) return;
    faults.push(error instanceof Error ? error : new Error(String(error)));
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // Without an error listener, server writes to a reset socket would emit unhandled EPIPE and
    // break unrelated tests (outside the fixture).
    socket.on('error', record);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = '';
      try {
        handler(line, socket);
      } catch (error) {
        record(error);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  return {
    path: sockPath,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
      if (faults.length > 0) throw faults[0];
    },
  };
}

test('ipcCall request/response and timeout', { timeout: 60_000 }, async (t) => {
  const srv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string; method: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { echo: req.method } })}\n`);
  });
  t.after(async () => {
    await srv.close();
  });
  const dir = await tempDir('helm-node-ipc-client-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const line = JSON.stringify({ id: '1', method: 'tab.list' });
  const ok = await server.ipcCall!({ endpoint: srv.path, line, timeoutMs: 5_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && JSON.parse(ok.value).result.echo, 'tab.list');

  // Timeout: server sends no response
  const silent = await startHerdrLikeServer(() => undefined);
  try {
    const r = await server.ipcCall!({ endpoint: silent.path, line, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'timeout');
  } finally {
    await silent.close();
  }

  // Connection error: missing socket path
  const dead = await server.ipcCall!({ endpoint: path.join(dir, 'no', 'such.sock'), line, timeoutMs: 1_000 });
  assert.equal(dead.ok, false);
  assert.equal(!dead.ok && dead.error.code, 'unknown');

  // Rejects response lines containing NUL bytes
  const nulSrv = await startHerdrLikeServer((_line, socket) => {
    socket.write(Buffer.concat([Buffer.from('{"a":"x"\u0000}'), Buffer.from('\n')]));
  });
  try {
    const r = await server.ipcCall!({ endpoint: nulSrv.path, line, timeoutMs: 5_000 });
    assert.equal(r.ok, false);
  } finally {
    await nulSrv.close();
  }
});

test('ipcAbortCall cancels blocking waits immediately', { timeout: 60_000 }, async (t) => {
  // Server accepts request and hangs without replying (simulates `agent.prompt --wait`)
  const srv = await startHerdrLikeServer(() => undefined);
  t.after(async () => {
    await srv.close();
  });
  const dir = await tempDir('helm-node-ipc-abort-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const start = Date.now();
  const pending = server.ipcCall!({
    callId: 'call-1',
    endpoint: srv.path,
    line: JSON.stringify({ id: '1', method: 'agent.prompt', params: { wait: true } }),
    timeoutMs: 60_000,
  });
  await delay(200);
  assert.equal(server.getActiveIpcCallCount(), 1);
  await server.ipcAbortCall!('call-1');
  const result = await pending;
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 5_000, `abort should take effect immediately (actual ${elapsed}ms)`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcSubscribe streams events and ipcUnsubscribe closes cleanly', { timeout: 60_000 }, async (t) => {
  const events: NodeIpcEvent[] = [];
  const closed: NodeIpcClosedEvent[] = [];
  // Server sends subscription_started ACK, then pushes an event frame every 40ms
  const srv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`);
    let seq = 0;
    const timer = setInterval(() => {
      // After peer disconnect, close event can trail next timer tick; check writable so fixture stops cleanly.
      if (socket.destroyed || !socket.writable) {
        clearInterval(timer);
        return;
      }
      seq += 1;
      socket.write(`${JSON.stringify({ event: 'tick', data: { seq } })}\n`);
    }, 40);
    socket.once('close', () => clearInterval(timer));
  });
  t.after(async () => {
    await srv.close();
  });
  const dir = await tempDir('helm-node-ipc-sub-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onIpcEvent: (e) => events.push(e),
    onIpcClosed: (e) => closed.push(e),
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ack = await server.ipcSubscribe!({
    subscribeId: 'sub-1',
    endpoint: srv.path,
    line: JSON.stringify({ id: 'sub', method: 'events.subscribe', params: {} }),
  });
  assert.equal(ack.ok, true, ack.ok ? '' : ack.error.message);
  assert.equal(server.getActiveIpcSubscriptionCount(), 1);

  await waitFor(() => events.length >= 3, 5_000, 'at least 3 streaming events');
  assert.ok(events.length >= 3, `should receive streaming events (actual ${events.length})`);
  assert.equal(events[0]?.subscribeId, 'sub-1');
  assert.equal(JSON.parse(events[0]!.line).event, 'tick');

  // Explicit unsubscribe does not fire onIpcClosed
  await server.ipcUnsubscribe!('sub-1');
  await waitFor(() => server.getActiveIpcSubscriptionCount() === 0, 5_000, 'subscription count cleared after unsubscribe');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
  assert.equal(closed.length, 0, 'explicit unsubscribe must not emit onIpcClosed');
  const countAfterUnsub = events.length;
  await delay(250);
  assert.equal(events.length, countAfterUnsub, 'no more events received after unsubscribe');

  // Server rejects subscription with error envelope
  const rejectSrv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, error: { code: 'bad_filter', message: 'invalid filter' } })}\n`);
  });
  try {
    const r = await server.ipcSubscribe!({
      subscribeId: 'sub-2',
      endpoint: rejectSrv.path,
      line: JSON.stringify({ id: 'sub', method: 'events.subscribe' }),
    });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /bad_filter/);
  } finally {
    await rejectSrv.close();
  }

  // Rejects ACK whose result type is not subscription_started
  const badAckSrv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'something_else' } })}\n`);
  });
  try {
    const r = await server.ipcSubscribe!({
      subscribeId: 'sub-3',
      endpoint: badAckSrv.path,
      line: JSON.stringify({ id: 'sub', method: 'events.subscribe' }),
    });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /unexpected|subscription_started/);
  } finally {
    await badAckSrv.close();
  }
});

test('ipc fixture isolates in-flight write errors after peer disconnect', { timeout: 60_000 }, async () => {
  let writes = 0;
  const srv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`);
    const timer = setInterval(() => {
      writes += 1;
      socket.write(`${JSON.stringify({ event: 'tick' })}\n`);
    }, 10);
    socket.once('close', () => clearInterval(timer));
  });
  const client = net.connect(srv.path);
  try {
    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe' })}\n`);
    await new Promise<void>((resolve) => client.once('data', () => resolve()));

    // Pause reading so subsequent ticks stay buffered, then destroy client so server writes hit closed socket;
    // without an error handler EPIPE becomes uncaught and crashes the whole suite.
    client.pause();
    await delay(50);
    client.destroy();
    await delay(150);
    assert.ok(writes > 0, 'fixture should indeed attempt writes after disconnect');
  } finally {
    client.destroy();
    await srv.close();
  }
});

test('resolveIpcEndpoint priority (explicit > env var > session default)', { timeout: 60_000 }, async () => {
  const server = createNodeEnvRpcServer({ defaultCwd: '/tmp' }) as NodeEnvRpcServer & {
    resolveIpcEndpoint(input: { endpoint?: string; session?: string }): string;
  };
  try {
    // Explicit endpoint takes precedence
    assert.equal(server.resolveIpcEndpoint({ endpoint: '/explicit/sock' }), '/explicit/sock');
    // HERDR_SOCKET_PATH comes next (before session inference)
    process.env['HERDR_SOCKET_PATH'] = '/env/sock';
    try {
      assert.equal(server.resolveIpcEndpoint({}), '/env/sock');
      assert.equal(server.resolveIpcEndpoint({ session: 'work' }), '/env/sock');
    } finally {
      delete process.env['HERDR_SOCKET_PATH'];
    }
    // With session, defaults to sessions/<session>/herdr.sock
    const withSession = server.resolveIpcEndpoint({ session: 'work' });
    assert.match(withSession, /herdr[/]sessions[/]work[/]herdr\.sock$/);
    // Without session, defaults to herdr.sock
    const noSession = server.resolveIpcEndpoint({});
    assert.match(noSession, /herdr[/]herdr\.sock$/);
    // Invalid session name fails validation
    assert.throws(() => server.resolveIpcEndpoint({ session: '../evil' }), /session/i);
    assert.throws(() => server.resolveIpcEndpoint({ session: 'a b' }), /session/i);
  } finally {
    await server.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. identity persist
// ---------------------------------------------------------------------------

test('parseJoinToken valid and invalid tokens', { timeout: 60_000 }, () => {
  assert.deepEqual(parseJoinToken('node-1:secret'), { nodeId: 'node-1', secret: 'secret' });
  assert.deepEqual(parseJoinToken('abc.def-2:s3cr3t!'), { nodeId: 'abc.def-2', secret: 's3cr3t!' });
  assert.equal(parseJoinToken(''), null);
  assert.equal(parseJoinToken('nosecret'), null);
  assert.equal(parseJoinToken(':secret'), null);
  assert.equal(parseJoinToken('node:'), null);
  assert.equal(parseJoinToken('bad name:secret'), null);
  // Secret containing colons is valid (nodeId is first segment)
  assert.deepEqual(parseJoinToken('n1:a:b'), { nodeId: 'n1', secret: 'a:b' });
});

test('bindIdentityFromJoinToken: initial write 0600, same nodeId rotation, cross-nodeId rejection', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-identity-');
  try {
    // First-time bind
    const first = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-1', 'http://127.0.0.1:3202');
    assert.equal(first.nodeId, 'workstation-1');
    assert.equal(first.token, 'workstation-1:secret-1');
    const st = await fs.stat(path.join(dir, 'node.json'));
    // Skip 0600 mode check on Windows (NTFS uses ACLs instead of POSIX modes).
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o777, 0o600, 'node.json mode should be 0600');
    }

    // Rotate token for same nodeId
    const rotated = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-2', 'http://127.0.0.2:3202');
    assert.equal(rotated.token, 'workstation-1:secret-2');
    const reread = await readNodeIdentity(dir);
    assert.equal(reread?.token, 'workstation-1:secret-2');
    assert.equal(reread?.hubUrl, 'http://127.0.0.2:3202');

    // Cross-nodeId rebind explicitly rejected
    await assert.rejects(
      bindIdentityFromJoinToken(dir, 'other-node:secret', 'http://x'),
      /already bound to node workstation-1.*refusing to rebind/,
    );

    // Invalid token format
    await assert.rejects(bindIdentityFromJoinToken(dir, 'not-a-join-token', 'http://x'), /invalid JOIN token format/);

    // Corrupt node.json explicitly throws instead of silently treating as unbound
    await fs.writeFile(path.join(dir, 'node.json'), '{broken json', 'utf8');
    await assert.rejects(readNodeIdentity(dir), /corrupt/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. createNodeDaemon: real WS Hub simulation
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: string[];
  /** Node RPC client held on server side (local handler lives in startHubFixture). */
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  close(): Promise<void>;
}

/**
 * Real http.Server + WebSocketServer + birpc simulating Hub `/ws/node`:
 * validates tokens, register/heartbeat, honors `ack.heartbeatMs`, and dispatches reverse RPC calls.
 * Uses a single birpc instance and shared message dispatcher across control and RPC surfaces
 * to avoid two birpc layers contending over the same WebSocket frames.
 */
async function startHubFixture(options: {
  expectedToken: string;
  heartbeatMs?: number;
  reject?: boolean;
  execOutputs: EnvExecOutputEvent[];
  ipcEvents?: NodeIpcEvent[];
  ipcClosed?: NodeIpcClosedEvent[];
  /** Reuse port across Hub restarts in reconnect tests. */
  port?: number;
}): Promise<HubFixture> {
  const ipcEventsSink: NodeIpcEvent[] = options.ipcEvents ?? [];
  const ipcClosedSink: NodeIpcClosedEvent[] = options.ipcClosed ?? [];
  const registrations: NodeRegisterInput[] = [];
  const heartbeats: string[] = [];
  let nodeRpc: BirpcReturn<NodeEnvRpcFunctions, NodeHubLocal> | undefined;
  let pendingSocket: WebSocket | undefined;

  interface NodeHubLocal {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
    heartbeat(nodeId: string): boolean;
    onEnvExecOutput(event: EnvExecOutputEvent): void;
    onIpcEvent(event: NodeIpcEvent): void;
    onIpcClosed(event: NodeIpcClosedEvent): void;
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const dispatchers: Array<(data: unknown) => void> = [];
      const local: NodeHubLocal = {
        async register(input) {
          registrations.push(input);
          if (options.reject || input.token !== options.expectedToken) {
            setTimeout(() => {
              if (pendingSocket !== undefined && pendingSocket.readyState === WebSocket.OPEN) {
                pendingSocket.close(4003, 'invalid token');
              }
            }, 30);
            return { ok: false, heartbeatMs: 0, reason: 'invalid token' };
          }
          return { ok: true, heartbeatMs: options.heartbeatMs ?? 15_000 };
        },
        heartbeat(nodeId) {
          heartbeats.push(nodeId);
          return true;
        },
        onEnvExecOutput(event) {
          options.execOutputs.push(event);
        },
        onIpcEvent(event) {
          ipcEventsSink.push(event);
        },
        onIpcClosed(event) {
          ipcClosedSink.push(event);
        },
      };
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
            // Single layer error does not break other layers.
          }
        }
      });
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    heartbeats,
    nodeRpc: () => nodeRpc,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

test('createNodeDaemon: register + heartbeat + reverse envExec/envReadTextFile/ipcCall', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-');
  const execOutputs: EnvExecOutputEvent[] = [];
  const ipcEvents: NodeIpcEvent[] = [];
  const ipcClosed: NodeIpcClosedEvent[] = [];
  const token = 'work-a:secret-a';
  const hub = await startHubFixture({
    expectedToken: token,
    heartbeatMs: 120,
    execOutputs,
    ipcEvents,
    ipcClosed,
  });
  // Target IPC socket (not hosted by Hub fixture; daemon connects locally on node side)
  // to verify ipcCall forwards over WS to a local Herdr-compatible socket.
  const ipcSrv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { pong: true } })}\n`);
  });

  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'work-a', token },
    dataDir: dir,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'should finish registration');
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'work-a');
    assert.equal(hub.registrations[0]?.token, token);
    assert.equal(typeof hub.registrations[0]?.hostname, 'string');
    assert.equal(hub.registrations[0]?.platform, process.platform);
    assert.equal(hub.registrations[0]?.hubUrl, hub.url);

    // Wait for at least one heartbeat
    await waitFor(() => hub.heartbeats.length >= 1, 10_000, 'at least one heartbeat');
    assert.ok(hub.heartbeats.length >= 1, 'heartbeats should fire per ack.heartbeatMs');

    // Server-side reverse RPC: write file + read back
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined, 'Hub side should hold node RPC proxy');
    const write = await rpc!.envWriteFile({ path: 'from-hub.txt', content: 'via-ws' });
    assert.equal(write.ok, true);
    const read = await rpc!.envReadTextFile({ path: 'from-hub.txt' });
    assert.equal(read.ok && read.value, 'via-ws');
    // Relative paths resolve against dataDir
    const onDisk = await fs.readFile(path.join(dir, 'from-hub.txt'), 'utf8');
    assert.equal(onDisk, 'via-ws');

    // Reverse envExec: streamed output forwarded to Hub
    execOutputs.length = 0;
    const exec = await rpc!.envExec({
      execId: 'hub-e1',
      command: 'echo via-hub-exec',
      timeout: 30,
    });
    assert.equal(exec.ok && exec.value.exitCode, 0);
    // onEnvExecOutput is pushed asynchronously: wait until output arrives
    await waitFor(() => execOutputs.map((e) => e.text).join('').includes('via-hub-exec'), 10_000, 'reverse envExec output delivery');
    assert.match(execOutputs.map((e) => e.text).join(''), /via-hub-exec/);

    // Reverse ipcCall: reaches local Herdr stub socket via node
    const ipc = await rpc!.ipcCall!({
      endpoint: ipcSrv.path,
      line: JSON.stringify({ id: '1', method: 'ping' }),
      timeoutMs: 5_000,
    });
    assert.equal(ipc.ok, true, ipc.ok ? '' : ipc.error.message);
    assert.equal(ipc.ok && JSON.parse(ipc.value).result.pong, true);

    // Reverse ipcSubscribe: forwards event stream to Hub
    const events: NodeIpcEvent[] = [];
    // Attach a streaming socket server
    const subSrv = await startHerdrLikeServer((line, socket) => {
      const req = JSON.parse(line) as { id: string };
      socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`);
      socket.write(`${JSON.stringify({ event: 'hello' })}\n`);
    });
    const subAck = await rpc!.ipcSubscribe!({
      subscribeId: 's1',
      endpoint: subSrv.path,
      line: JSON.stringify({ id: 'sub', method: 'events.subscribe' }),
    });
    assert.equal(subAck.ok, true, subAck.ok ? '' : subAck.error.message);
    await waitFor(
      () => ipcEvents.some((e) => e.subscribeId === 's1' && JSON.parse(e.line).event === 'hello'),
      10_000,
      'ipc event forwarded to Hub',
    );
    assert.ok(ipcEvents.some((e) => e.subscribeId === 's1' && JSON.parse(e.line).event === 'hello'), 'ipc event should reach Hub');
    await rpc!.ipcUnsubscribe!('s1');
    await subSrv.close();
  } finally {
    await daemon.close();
    await ipcSrv.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createNodeDaemon: disconnect disposes old generation and reconnects cleanly', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-reconnect-');
  const execOutputs: EnvExecOutputEvent[] = [];
  const token = 'work-b:secret-b';
  const hub = await startHubFixture({ expectedToken: token, heartbeatMs: 15_000, execOutputs });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'work-b', token },
    dataDir: dir,
    reconnectBaseDelayMs: 200,
    reconnectMaxDelayMs: 1_000,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    assert.equal(hub.registrations.length, 1);
    const port = Number(new URL(hub.url).port);

    // Server-initiated disconnect: wait for daemon to notice close and schedule backoff retry.
    await hub.close();
    await delay(300);
    assert.equal(daemon.isConnected(), false, 'should report disconnected after drop');

    // Restart Hub on the same port: daemon should reconnect and re-register.
    const hub2 = await startHubFixture({ expectedToken: token, heartbeatMs: 15_000, execOutputs, port });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && hub2.registrations.length === 0) {
        await delay(200);
      }
      assert.equal(hub2.registrations.length, 1, 'should re-register after backoff reconnect');
      assert.equal(hub2.registrations[0]?.nodeId, 'work-b');
      assert.equal(daemon.isConnected(), true);
      // New generation accepts commands
      const rpc = hub2.nodeRpc();
      assert.ok(rpc !== undefined);
      const r = await rpc!.envExec({ execId: 'after-reconnect', command: 'echo back', timeout: 30 });
      assert.equal(r.ok && r.value.exitCode, 0);
    } finally {
      await hub2.close();
    }
  } finally {
    await daemon.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createNodeDaemon: auth rejection (4003) does not report connected', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-daemon-auth-');
  const execOutputs: EnvExecOutputEvent[] = [];
  const hub = await startHubFixture({ expectedToken: 'right:secret', reject: true, execOutputs });
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'work-c', token: 'work-c:wrong' },
    dataDir: dir,
    reconnectBaseDelayMs: 200,
    reconnectMaxDelayMs: 1_000,
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(5_000), false, 'rejected registration must not report connected');
    assert.equal(daemon.isConnected(), false);
    assert.ok(hub.registrations.length >= 1, 'register attempt should reach Hub');
  } finally {
    await daemon.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. runNodeCli
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
    // Strip host-managed HELM_* variables so CLI startup reflects only explicit test argv/env.
    env: { ...sanitizedHostEnv(), ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('runNodeCli --help, unknown command/option, and error envelope', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /helm-node/);
  assert.match(help.out, /connect/);
  assert.match(help.out, /service install/);

  const unknown = await runCli(['bogus-command']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown command/);

  const unknownFlag = await runCli(['status', '--no-such-flag']);
  assert.equal(unknownFlag.code, 1);
  assert.match(unknownFlag.err, /unknown option/);

  // --json also emits structured error envelope for unknown options
  const jsonFlag = await runCli(['status', '--no-such-flag', '--json']);
  assert.equal(jsonFlag.code, 1);
  const envelope = JSON.parse(jsonFlag.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'usage_error');
  assert.match(envelope.error.message, /unknown option/);

  // Unexpected positional arguments, unsupported options for command, and unknown short flags all reject
  const extraPositional = await runCli(['status', 'extra', '--json']);
  assert.equal(extraPositional.code, 1);
  assert.match(JSON.parse(extraPositional.err).error.message, /positional argument/);
  const wrongFlag = await runCli(['stop', '--token', 'x:y', '--json']);
  assert.equal(wrongFlag.code, 1);
  assert.match(JSON.parse(wrongFlag.err).error.message, /does not support/);
  const shortFlag = await runCli(['status', '-x', '--json']);
  assert.equal(shortFlag.code, 1);
  assert.match(JSON.parse(shortFlag.err).error.message, /unknown option/);
  const badService = await runCli(['service', 'bogus', '--json']);
  assert.equal(badService.code, 1);
  assert.match(JSON.parse(badService.err).error.message, /install\|uninstall\|status/);
});

test('runNodeCli status --json: unbound/bound/stale pid and zero secret leakage', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-status-');
  try {
    // Unbound
    const none = await runCli(['status', '--data-dir', dir, '--json']);
    assert.equal(none.code, 0);
    const nonePayload = JSON.parse(none.out) as { bound: boolean; dataDir: string; pid: number | null; pidAlive: boolean };
    assert.equal(nonePayload.bound, false);
    assert.equal(nonePayload.pid, null);
    assert.equal(nonePayload.pidAlive, false);

    // Bound + PID points to live process with unreachable control channel: pidAlive true + state unknown + explicit diagnostic
    await bindIdentityFromJoinToken(dir, 'cli-node:tok', 'http://127.0.0.1:3202');
    await fs.writeFile(
      path.join(dir, 'node.pid'),
      JSON.stringify({ pid: process.pid, instanceId: 'c'.repeat(32), endpoint: path.join(dir, 'no.sock') }) + '\n',
      'utf8',
    );
    const bound = await runCli(['status', '--data-dir', dir, '--json']);
    assert.equal(bound.code, 0);
    const payload = JSON.parse(bound.out) as {
      bound: boolean;
      nodeId: string;
      hubUrl: string;
      pid: number;
      pidAlive: boolean;
      state: string;
      detail: string;
    };
    assert.equal(payload.bound, true);
    assert.equal(payload.nodeId, 'cli-node');
    assert.equal(payload.hubUrl, 'http://127.0.0.1:3202');
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.pidAlive, true);
    assert.equal(payload.state, 'unknown');
    assert.match(payload.detail, /control channel unreachable/);
    // Never output secret fields (no tokenPreview / token)
    assert.equal('tokenPreview' in payload, false);
    assert.equal(JSON.stringify(payload).includes('cli-node:tok'), false);

    // Stale PID (dead process): pidAlive false + pidStale marker, still reports status cleanly
    await fs.writeFile(
      path.join(dir, 'node.pid'),
      JSON.stringify({ pid: 999999999, instanceId: 'd'.repeat(32), endpoint: path.join(dir, 'no.sock') }) + '\n',
      'utf8',
    );
    const dead = await runCli(['status', '--data-dir', dir, '--json']);
    assert.equal(dead.code, 0);
    const deadPayload = JSON.parse(dead.out) as { pidAlive: boolean; pidStale?: boolean };
    assert.equal(deadPayload.pidAlive, false);
    assert.equal(deadPayload.pidStale, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runNodeCli stop: explicit error without pid, cleans stale pid, rejects corrupt pid file', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-stop-');
  try {
    // Missing pid file: fails explicitly instead of reporting silent success
    const none = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(none.code, 1);
    assert.match(JSON.parse(none.err).error.message, /pid file not found/);

    // Legacy plain-numeric pid file cannot verify identity -> fails as invalid/corrupt without silent cleanup
    await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
    const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(legacy.code, 1);
    assert.match(JSON.parse(legacy.err).error.message, /invalid|corrupt/);

    // Valid structure with dead pid: stale, cleans up pid file
    await fs.writeFile(
      path.join(dir, 'node.pid'),
      JSON.stringify({ pid: 999999998, instanceId: 'e'.repeat(32), endpoint: path.join(dir, 'no.sock') }) + '\n',
      'utf8',
    );
    const dead = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(dead.code, 0);
    assert.equal(JSON.parse(dead.out).outcome, 'stale');
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid file should be removed');

    // Corrupt JSON pid file: fails explicitly without deleting file
    await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
    const broken = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(broken.code, 1);
    assert.match(JSON.parse(broken.err).error.message, /corrupt/);
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'corrupt pid file must not be silently removed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('service template rendering: darwin/linux/win32 (spaces, Unicode paths, special character escaping)', { timeout: 60_000 }, () => {
  const dataDir = '/opt/helm data';
  const cliEntry = '/opt/hélm node/dist/cli.js';

  const darwin = renderServiceSpec({ platform: 'darwin', nodePath: '/usr/local/bin/node', cliEntryPath: cliEntry, dataDir, hubUrl: 'http://hub:3202' });
  assert.equal(darwin.platform, 'darwin');
  assert.match(darwin.content, /ai\.helm\.node/);
  assert.match(darwin.content, /RunAtLoad/);
  assert.match(darwin.content, /KeepAlive/);
  assert.match(darwin.content, /\/usr\/local\/bin\/node/);
  assert.match(darwin.content, /http:\/\/hub:3202/);
  assert.equal(darwin.installCmd[0], 'launchctl');
  assert.equal(darwin.uninstallCmd[0], 'launchctl');
  // plist XML escaping preserves spaces while escaping <>&"'
  assert.ok(darwin.content.includes('/opt/helm data'));

  const linux = renderServiceSpec({ platform: 'linux', nodePath: '/usr/bin/node', cliEntryPath: cliEntry, dataDir });
  assert.equal(linux.platform, 'linux');
  assert.match(linux.content, /\[Unit\]/);
  assert.ok(linux.configPath.endsWith('helm-node.service'));
  assert.ok(linux.targetPath?.endsWith('helm-node.service'));
  assert.match(linux.content, /ExecStart=/);
  assert.match(linux.content, /WantedBy=default\.target/);
  assert.equal(linux.installCmd[0], 'systemctl');
  assert.equal(linux.installCmd[1], '--user');
  // systemd quote escaping: paths with spaces wrapped in double quotes; inner quotes/backslashes doubled
  const execLine = linux.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(execLine.includes('"/opt/hélm node/dist/cli.js"'), `ExecStart should quote space-containing path: ${execLine}`);
  assert.ok(!execLine.includes('\r'), 'ExecStart must not be split by control characters');
  // % and $ variables are not expanded by systemd: paths containing %/$ are quoted and escaped
  const tricky = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/helm %n $MAIN/dist/cli.js',
    dataDir: '/opt/data%-dir',
  });
  const trickyLine = tricky.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(trickyLine.includes('"/opt/helm %%n $$MAIN/dist/cli.js"'), `%/$ must be escaped literally: ${trickyLine}`);
  assert.ok(trickyLine.includes('"/opt/data%%-dir"'), `% specifier must be escaped literally: ${trickyLine}`);
  // Inner double quotes and backslashes escaped cleanly
  const quoted = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/we"ird\\path/cli.js',
    dataDir: '/opt/d',
  });
  const quotedLine = quoted.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(quotedLine.includes('\\"') && quotedLine.includes('\\\\'), `inner quotes/backslashes must be escaped: ${quotedLine}`);

  const win = renderServiceSpec({ platform: 'win32', nodePath: 'C:\\node\\node.exe', cliEntryPath: 'C:\\helm\\cli.js', dataDir });
  assert.equal(win.platform, 'win32');
  assert.match(win.configPath, /HelmNode\.xml$/);
  assert.deepEqual(win.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmNode', '/XML', win.targetPath]);
  assert.match(win.content, /<Task version="1\.2"/);
  assert.ok(win.content.includes('&quot;/opt/helm data&quot;'), 'task arguments are quoted literally inside XML');
  assert.deepEqual(win.uninstallCmd, ['schtasks', '/Delete', '/F', '/TN', 'HelmNode']);
  // Valid XML escaping: after stripping declaration/comments/tags/entities, no unescaped special chars remain
  const xmlText = win.content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<\/[a-zA-Z][^>]*>/g, '')
    .replace(/<[a-zA-Z][^>]*>/g, '')
    .replace(/&(lt|gt|amp|apos|quot);/g, '');
  assert.ok(!/[<>&]/.test(xmlText), `XML text must have no unescaped special chars: ${JSON.stringify(xmlText)}`);
  assert.ok(win.content.includes('/opt/helm data'));

  // Unsupported platform throws explicitly instead of defaulting to Linux
  assert.throws(() => renderServiceSpec({ platform: 'freebsd', cliEntryPath: cliEntry, dataDir }), /unsupported platform/);
});

test('runNodeCli service status (mocked execCommand without side effects)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-service-');
  try {
    // Not installed (failed exec truthfully reports unknown running state)
    const failExec = {
      run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
    };
    const statusNone = await runCli(['service', 'status', '--data-dir', dir, '--json']);
    assert.equal(statusNone.code, 0);
    assert.equal(JSON.parse(statusNone.out).installed, false);
    assert.equal(typeof defaultServiceExec.run, 'function');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runNodeCli connect --once --json registers once with real Hub and exits', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-connect-');
  const execOutputs: EnvExecOutputEvent[] = [];
  const hub = await startHubFixture({ expectedToken: 'cli-1:sec', heartbeatMs: 15_000, execOutputs });
  try {
    const r = await runCli(['connect', hub.url, '--token', 'cli-1:sec', '--data-dir', dir, '--once', '--json']);
    assert.equal(r.code, 0, r.err);
    const payload = JSON.parse(r.out) as { ok: boolean; nodeId: string; hubUrl: string; registered: boolean };
    assert.equal(payload.ok, true);
    assert.equal(payload.nodeId, 'cli-1');
    assert.equal(payload.registered, true);
    // Identity persisted (0600; skip mode bit check on Windows without POSIX modes)
    const st = await fs.stat(path.join(dir, 'node.json'));
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
    // Hub received registration
    assert.equal(hub.registrations.length, 1);

    // --once with --json writes valid single-line JSON object
    assert.equal(r.out.trim().startsWith('{'), true);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runNodeCli start errors without identity and reports state=registered when Hub is reachable', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-start-');
  let hub: Awaited<ReturnType<typeof startHubFixture>> | undefined;
  try {
    const noIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(noIdentity.code, 1);
    assert.match(JSON.parse(noIdentity.err).error.message, /node identity not found|connect/);

    // Reachable Hub: background daemon genuinely registers -> state=registered
    const execOutputs: EnvExecOutputEvent[] = [];
    hub = await startHubFixture({ expectedToken: 'start-1:s', heartbeatMs: 15_000, execOutputs });
    await bindIdentityFromJoinToken(dir, 'start-1:s', hub.url);
    const withIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(withIdentity.code, 0, withIdentity.err);
    const payload = JSON.parse(withIdentity.out) as { ok: boolean; pid: number; state: string };
    assert.equal(payload.ok, true);
    assert.ok(payload.pid > 0);
    assert.equal(payload.state, 'registered');
    // Hub received registration
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
    assert.equal(hub.registrations.length, 1);
    // PID file uses new contract record (pid + instanceId + endpoint)
    const pidRaw = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
      pid: number;
      instanceId: string;
      endpoint: string;
    };
    assert.equal(pidRaw.pid, payload.pid);
    // Cleanly stop the background daemon
    const stop = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(stop.code, 0);
    assert.equal(JSON.parse(stop.out).stopped, true);
  } finally {
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
