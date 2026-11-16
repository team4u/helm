/**
 * @helm/node all link real test: do not mock by test module.
 * - NodeEnvRpcServer: real file/directory/Reader/command execute + real Unix Socket IPC bridge;
 * - identity persist: real temp directory,0600 permission,token round swap and across nodeId conflict;
 * - createNodeDaemon: real local http.Server + WebSocketServer + birpc Hub simulated,
 *   reverse invoke envExec / envReadTextFile / ipcCall, disconnection reconnect and authentication reject (4003);
 * - runNodeCli:status / service template (three platform)/ --help / --json.
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
// 0. dependency extreme simple regression:@helm/node runtime dependency only limit @helm/protocol / @helm/env-io
//    (process occupy scan sharing execute implement,workspace inside package)/ birpc / ws
// ---------------------------------------------------------------------------

test('@helm/node runtime dependency only @helm/protocol / @helm/env-io / birpc / ws(guard against heavy dependency regression)', { timeout: 60_000 }, async () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}).sort(),
    ['@helm/env-io', '@helm/protocol', 'birpc', 'ws'],
    '@helm/node  dependencies must and only can is @helm/protocol / @helm/env-io(sharing process occupy scan execute implement)/ birpc / ws(must not introduce @earendil-works/* etc. heavy dependency)',
  );
});


/** polling wait for can observe condition into establish (alternative fixed sleep), timeout explicit failed. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out:${what}` });

// ---------------------------------------------------------------------------
// 1. NodeEnvRpcServer: file/directory/Reader/exec/dispose
// ---------------------------------------------------------------------------

test('env file read write and directory list', { timeout: 60_000 }, async () => {
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

    // base64 two enter system read write
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

    // missing file → structure error not_found
    const missing = await server.envReadTextFile({ path: 'no-such.txt' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');

    // absolute path parse
    const abs = await server.envAbsolutePath({ path: 'a.txt' });
    assert.equal(abs.ok && abs.value, path.join(dir, 'a.txt'));
    const exists = await server.envExists({ path: 'a.txt' });
    assert.equal(exists.ok && exists.value, true);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Text/Binary/Dir Reader lifecycle and dispose clean up', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-readers-');
  await fs.writeFile(path.join(dir, 'lines.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from([0x41, 0x0a, 0x43, 0x44])); // "A\nCD":1 newline
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
    // unknown reader explicit errors
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
    // close after again read errors
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
    assert.equal(scan.ok && scan.value.firstLineBytes, 2); //  1 row "CD"

    // Dir reader
    const d = await server.envOpenDirReader({ path: 'd' });
    assert.equal(d.ok, true);
    const did = d.ok ? d.value.readerId : '';
    const page = await server.envDirReaderNext({ readerId: did, maxEntries: 10 });
    assert.equal(page.ok && page.value.entries.length, 2);
    assert.equal(page.ok && page.value.done, true);

    // dispose close all reader
    assert.equal(server.getOpenReaderCount(), 2); // binary + dir
    await server.dispose();
    assert.equal(server.getOpenReaderCount(), 0);
    // dispose idempotent
    await server.dispose();
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('envExec streaming output and envAbortExec immediately terminate child process tree', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-exec-');
  const chunks: EnvExecOutputEvent[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onExecOutput: (event) => chunks.push(event),
    shellEnv: { HELM_TEST_MARKER: 'from-shell-env' },
  });
  try {
    // real command:stdout streaming output
    const ok = await server.envExec({
      execId: 'e1',
      command: 'echo hello-from-exec && echo marker=$HELM_TEST_MARKER 1>&2',
      timeout: 30,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.value.exitCode, 0);
    const text = chunks.map((c) => c.text).join('');
    assert.match(text, /hello-from-exec/);
    assert.match(text, /marker=from-shell-env/); // shellEnv inject takes effect
    const stderrChunk = chunks.find((c) => c.stream === 'stderr');
    assert.ok(stderrChunk !== undefined, 'stderr stream mark record correct');

    // abort:sleep long command should by immediately terminate (aborted structure error, and time cost should far less than timeout)
    const start = Date.now();
    const slow = server.envExec({ execId: 'e2', command: 'sleep 30', timeout: 60 });
    await delay(200); // etc. child process truly start
    assert.equal(server.getActiveExecCount(), 1);
    await server.envAbortExec('e2');
    const result = await slow;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'aborted');
    assert.ok(elapsed < 10_000, `abort should immediately takes effect (actual ${elapsed}ms)`);

    // dispose kill die in-flight process
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
    // missing error listen when, server side to already back RST connect write will EPIPE throw into not catch exception,
    // let without closure test (while non- fixture) failed.
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

  // timeout: server side do not back package
  const silent = await startHerdrLikeServer(() => undefined);
  try {
    const r = await server.ipcCall!({ endpoint: silent.path, line, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'timeout');
  } finally {
    await silent.close();
  }

  // connect error: missing socket path
  const dead = await server.ipcCall!({ endpoint: path.join(dir, 'no', 'such.sock'), line, timeoutMs: 1_000 });
  assert.equal(dead.ok, false);
  assert.equal(!dead.ok && dead.error.code, 'unknown');

  // first row contains NUL byte reject
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

test('ipcAbortCall immediately interrupt block wait for', { timeout: 60_000 }, async (t) => {
  // server side receives request after suspended do not back (simulated agent.prompt --wait)
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
  assert.ok(elapsed < 5_000, `abort should immediately takes effect (actual ${elapsed}ms)`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcSubscribe subscribe stream, event forwarding and ipcUnsubscribe close', { timeout: 60_000 }, async (t) => {
  const events: NodeIpcEvent[] = [];
  const closed: NodeIpcClosedEvent[] = [];
  // server side:ACK subscription_started, after each 40ms push one row event frame
  const srv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`);
    let seq = 0;
    const timer = setInterval(() => {
      // for end after disconnect close event may later than under once timer: can write check let fixture actively stop stream,
      // while is not to already close connect continue write.
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

  await waitFor(() => events.length >= 3, 5_000, 'streaming event at least 3 ');
  assert.ok(events.length >= 3, `should receives streaming event (actual ${events.length})`);
  assert.equal(events[0]?.subscribeId, 'sub-1');
  assert.equal(JSON.parse(events[0]!.line).event, 'tick');

  // actively unsubscribe: does not trigger exception onIpcClosed
  await server.ipcUnsubscribe!('sub-1');
  await waitFor(() => server.getActiveIpcSubscriptionCount() === 0, 5_000, 'unsubscribe after subscribe item clean zero');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
  assert.equal(closed.length, 0, 'actively unsubscribe does not trigger onIpcClosed');
  const countAfterUnsub = events.length;
  await delay(250);
  assert.equal(events.length, countAfterUnsub, 'unsubscribe after no longer receives event');

  // server side reject subscribe (error message seal)
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

  // ACK non- subscription_started reject
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

test('ipc fixture: for end after disconnect in-flight write by connect level error isolated', { timeout: 60_000 }, async () => {
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

    // paused read let after continue tick in receive buffer; again hard close, server side in-flight write then will hit
    // disconnected connect. missing error listen when EPIPE will into is not catch exception, drag collapse the whole test file.
    client.pause();
    await delay(50);
    client.destroy();
    await delay(150);
    assert.ok(writes > 0, 'fixture should indeed in after disconnect attempt write');
  } finally {
    client.destroy();
    await srv.close();
  }
});

test('resolveIpcEndpoint end point parse (explicit > environment variable > session by default)', { timeout: 60_000 }, async () => {
  const server = createNodeEnvRpcServer({ defaultCwd: '/tmp' }) as NodeEnvRpcServer & {
    resolveIpcEndpoint(input: { endpoint?: string; session?: string }): string;
  };
  try {
    // explicit endpoint takes precedence
    assert.equal(server.resolveIpcEndpoint({ endpoint: '/explicit/sock' }), '/explicit/sock');
    // HERDR_SOCKET_PATH time of (takes precedence at session push lead)
    process.env['HERDR_SOCKET_PATH'] = '/env/sock';
    try {
      assert.equal(server.resolveIpcEndpoint({}), '/env/sock');
      assert.equal(server.resolveIpcEndpoint({ session: 'work' }), '/env/sock');
    } finally {
      delete process.env['HERDR_SOCKET_PATH'];
    }
    // has session when by default push lead sessions/<session>/herdr.sock
    const withSession = server.resolveIpcEndpoint({ session: 'work' });
    assert.match(withSession, /herdr[/]sessions[/]work[/]herdr\.sock$/);
    // without session when push lead by default herdr.sock
    const noSession = server.resolveIpcEndpoint({});
    assert.match(noSession, /herdr[/]herdr\.sock$/);
    // illegal session name report invalid
    assert.throws(() => server.resolveIpcEndpoint({ session: '../evil' }), /session/i);
    assert.throws(() => server.resolveIpcEndpoint({ session: 'a b' }), /session/i);
  } finally {
    await server.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. identity persist
// ---------------------------------------------------------------------------

test('parseJoinToken legal/illegal token', { timeout: 60_000 }, () => {
  assert.deepEqual(parseJoinToken('node-1:secret'), { nodeId: 'node-1', secret: 'secret' });
  assert.deepEqual(parseJoinToken('abc.def-2:s3cr3t!'), { nodeId: 'abc.def-2', secret: 's3cr3t!' });
  assert.equal(parseJoinToken(''), null);
  assert.equal(parseJoinToken('nosecret'), null);
  assert.equal(parseJoinToken(':secret'), null);
  assert.equal(parseJoinToken('node:'), null);
  assert.equal(parseJoinToken('bad name:secret'), null);
  // secret contains smoke number legal (nodeId take one segment)
  assert.deepEqual(parseJoinToken('n1:a:b'), { nodeId: 'n1', secret: 'a:b' });
});

test('bindIdentityFromJoinToken: first time write 0600, same nodeId round swap, across nodeId reject', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-identity-');
  try {
    // first time bind set
    const first = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-1', 'http://127.0.0.1:3202');
    assert.equal(first.nodeId, 'workstation-1');
    assert.equal(first.token, 'workstation-1:secret-1');
    const st = await fs.stat(path.join(dir, 'node.json'));
    // Windows without POSIX mode(NTFS away ACL), skip 0600 pattern assertion.
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o777, 0o600, 'node.json permission should be 0600');
    }

    // same nodeId round swap token
    const rotated = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-2', 'http://127.0.0.2:3202');
    assert.equal(rotated.token, 'workstation-1:secret-2');
    const reread = await readNodeIdentity(dir);
    assert.equal(reread?.token, 'workstation-1:secret-2');
    assert.equal(reread?.hubUrl, 'http://127.0.0.2:3202');

    // across nodeId explicit reject
    await assert.rejects(
      bindIdentityFromJoinToken(dir, 'other-node:secret', 'http://x'),
      /already bind set node workstation-1.*reject change bind/,
    );

    // illegal token
    await assert.rejects(bindIdentityFromJoinToken(dir, 'not-a-join-token', 'http://x'), /JOIN token format illegal/);

    // corrupt node.json explicit errors (not silently when without identity)
    await fs.writeFile(path.join(dir, 'node.json'), '{broken json', 'utf8');
    await assert.rejects(readNodeIdentity(dir), /corrupt/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. createNodeDaemon: real WS Hub simulated
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: string[];
  /** server side hold has node function proxy (local end function see startHubFixture). */
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  close(): Promise<void>;
}

/**
 * real http.Server + WebSocketServer + birpc simulated Hub /ws/node gateway:
 * validate token,register/heartbeat, by ack.heartbeatMs heartbeat, reverse invoke node function.
 * single one birpc layer + sharing message dispatch (the same socket on two layer feature can: control side register/heartbeat
 * and node function proxy), avoid double birpc contend grab the same frame leads to response conflict.
 */
async function startHubFixture(options: {
  expectedToken: string;
  heartbeatMs?: number;
  reject?: boolean;
  execOutputs: EnvExecOutputEvent[];
  ipcEvents?: NodeIpcEvent[];
  ipcClosed?: NodeIpcClosedEvent[];
  /** re- use port (reconnect test:Hub restart back the same port). */
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
            // single layer failed does not affect other layer.
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

test('createNodeDaemon:register + heartbeat + reverse envExec/envReadTextFile/ipcCall', { timeout: 60_000 }, async () => {
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
  // IPC target socket(in Hub fixture which in test process inside do not start service:daemon side only then connect) - -
  // is verify ipcCall via WS forwarding to node local machine, first start a local Herdr simulated socket.
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
    assert.equal(await daemon.waitUntilRegistered(10_000), true, 'should complete register');
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'work-a');
    assert.equal(hub.registrations[0]?.token, token);
    assert.equal(typeof hub.registrations[0]?.hostname, 'string');
    assert.equal(hub.registrations[0]?.platform, process.platform);
    assert.equal(hub.registrations[0]?.hubUrl, hub.url);

    // etc. at least once heartbeat
    await waitFor(() => hub.heartbeats.length >= 1, 10_000, 'at least once heartbeat');
    assert.ok(hub.heartbeats.length >= 1, 'heartbeat should by ack.heartbeatMs send');

    // server side reverse invoke: write file + read back
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined, 'Hub side should hold has node proxy');
    const write = await rpc!.envWriteFile({ path: 'from-hub.txt', content: 'via-ws' });
    assert.equal(write.ok, true);
    const read = await rpc!.envReadTextFile({ path: 'from-hub.txt' });
    assert.equal(read.ok && read.value, 'via-ws');
    // relative path based on dataDir
    const onDisk = await fs.readFile(path.join(dir, 'from-hub.txt'), 'utf8');
    assert.equal(onDisk, 'via-ws');

    // reverse envExec: streaming output back pass Hub
    execOutputs.length = 0;
    const exec = await rpc!.envExec({
      execId: 'hub-e1',
      command: 'echo via-hub-exec',
      timeout: 30,
    });
    assert.equal(exec.ok && exec.value.exitCode, 0);
    // onEnvExecOutput is event push: polling etc. account
    await waitFor(() => execOutputs.map((e) => e.text).join('').includes('via-hub-exec'), 10_000, 'reverse envExec output back pass');
    assert.match(execOutputs.map((e) => e.text).join(''), /via-hub-exec/);

    // reverse ipcCall: via node connect local machine Herdr simulated socket
    const ipc = await rpc!.ipcCall!({
      endpoint: ipcSrv.path,
      line: JSON.stringify({ id: '1', method: 'ping' }),
      timeoutMs: 5_000,
    });
    assert.equal(ipc.ok, true, ipc.ok ? '' : ipc.error.message);
    assert.equal(ipc.ok && JSON.parse(ipc.value).result.pong, true);

    // reverse ipcSubscribe: event stream back pass Hub
    const events: NodeIpcEvent[] = [];
    // hang a continuous push stream socket service
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
      'ipc event back pass Hub',
    );
    assert.ok(ipcEvents.some((e) => e.subscribeId === 's1' && JSON.parse(e.line).event === 'hello'), 'ipc event should back pass Hub');
    await rpc!.ipcUnsubscribe!('s1');
    await subSrv.close();
  } finally {
    await daemon.close();
    await ipcSrv.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createNodeDaemon: disconnection dispose old proxy and automatically reconnect heavy register', { timeout: 60_000 }, async () => {
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

    // server side force disconnect (simulated network interrupt): etc. daemon side aware close(backoff count when already arrange on).
    await hub.close();
    await delay(300);
    assert.equal(daemon.isConnected(), false, 'disconnection after should treated as not connect');

    // same port restart Hub(daemon still points to original hubUrl), backoff reconnect after should re- register.
    const hub2 = await startHubFixture({ expectedToken: token, heartbeatMs: 15_000, execOutputs, port });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && hub2.registrations.length === 0) {
        await delay(200);
      }
      assert.equal(hub2.registrations.length, 1, 'should in backoff reconnect after re- register');
      assert.equal(hub2.registrations[0]?.nodeId, 'work-b');
      assert.equal(daemon.isConnected(), true);
      // new proxy can execute command
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

test('createNodeDaemon: authentication reject (4003) after does not pretend to be connected', { timeout: 60_000 }, async () => {
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
    assert.equal(await daemon.waitUntilRegistered(5_000), false, 'by refuse register must not report is connected');
    assert.equal(daemon.isConnected(), false);
    assert.ok(hub.registrations.length >= 1, 'register request should reach Hub');
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
    // strip except host managed HELM_* variable (Hub address/credentials/data directory/control identity), by test
    // CLI start semantics only by test explicit argv/env decide.
    env: { ...sanitizedHostEnv(), ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('runNodeCli --help and unknown command/unknown option/error message seal', { timeout: 60_000 }, async () => {
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

  // --json under unknown option also output error message seal
  const jsonFlag = await runCli(['status', '--no-such-flag', '--json']);
  assert.equal(jsonFlag.code, 1);
  const envelope = JSON.parse(jsonFlag.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'usage_error');
  assert.match(envelope.error.message, /unknown option/);

  // without closure location parameter / do not belongs to the command option / unknown short option all reject
  const extraPositional = await runCli(['status', 'extra', '--json']);
  assert.equal(extraPositional.code, 1);
  assert.match(JSON.parse(extraPositional.err).error.message, /location parameter/);
  const wrongFlag = await runCli(['stop', '--token', 'x:y', '--json']);
  assert.equal(wrongFlag.code, 1);
  assert.match(JSON.parse(wrongFlag.err).error.message, /unsupported/);
  const shortFlag = await runCli(['status', '-x', '--json']);
  assert.equal(shortFlag.code, 1);
  assert.match(JSON.parse(shortFlag.err).error.message, /unknown option/);
  const badService = await runCli(['service', 'bogus', '--json']);
  assert.equal(badService.code, 1);
  assert.match(JSON.parse(badService.err).error.message, /install\|uninstall\|status/);
});

test('runNodeCli status --json: not bind set/already bind set/leftover pid and secret do not output', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-status-');
  try {
    // not bind set
    const none = await runCli(['status', '--data-dir', dir, '--json']);
    assert.equal(none.code, 0);
    const nonePayload = JSON.parse(none.out) as { bound: boolean; dataDir: string; pid: number | null; pidAlive: boolean };
    assert.equal(nonePayload.bound, false);
    assert.equal(nonePayload.pid, null);
    assert.equal(nonePayload.pidAlive, false);

    // bind set + Profile points to this process but control channel cannot reach:pidAlive true + state unknown + explicit diagnose
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
    assert.match(payload.detail, /control channel cannot reach/);
    // secret do not output (without tokenPreview / token field)
    assert.equal('tokenPreview' in payload, false);
    assert.equal(JSON.stringify(payload).includes('cli-node:tok'), false);

    // leftover pid(already disappear):pidAlive false + pidStale mark record, still explicit report state do not errors
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

test('runNodeCli stop: without pid explicit failed;stale pid clean up; broken pid file explicit errors', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-stop-');
  try {
    // without pid file: explicit failed not silently succeeded (error message seal away stderr, exit code 1)
    const none = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(none.code, 1);
    assert.match(JSON.parse(none.err).error.message, /not found pid/);

    // old edition pure number pid Profile: cannot validate identity → corrupt errors (not silently clean up)
    await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
    const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(legacy.code, 1);
    assert.match(JSON.parse(legacy.err).error.message, /illegal|corrupt/);

    // legal structure but pid missing:stale, clean up pid file
    await fs.writeFile(
      path.join(dir, 'node.pid'),
      JSON.stringify({ pid: 999999998, instanceId: 'e'.repeat(32), endpoint: path.join(dir, 'no.sock') }) + '\n',
      'utf8',
    );
    const dead = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(dead.code, 0);
    assert.equal(JSON.parse(dead.out).outcome, 'stale');
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid file should by clean up');

    // broken JSON pid file: explicit errors and do not clean up
    await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
    const broken = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(broken.code, 1);
    assert.match(JSON.parse(broken.err).error.message, /corrupt/);
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, 'broken pid file not silently clean up');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('service template render:darwin/linux/win32(contains space Chinese path and special character escaping)', { timeout: 60_000 }, () => {
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
  // plist XML escaping: path contains space/Chinese original keep,<>&&"' escaping
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
  // systemd quotes escaping: space path whole double quotes package wrap, internal quotes/backslash add multiple
  const execLine = linux.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(execLine.includes('"/opt/hélm node/dist/cli.js"'), `ExecStart should quotes package wrap contains space path: ${execLine}`);
  assert.ok(!execLine.includes('\r'), 'ExecStart must not by control character split');
  // % and $ variable do not by systemd expand: contains %/$ path must quotes package wrap
  const tricky = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/helm %n $MAIN/dist/cli.js',
    dataDir: '/opt/data%-dir',
  });
  const trickyLine = tricky.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(trickyLine.includes('"/opt/helm %%n $$MAIN/dist/cli.js"'), `%/$ must literal escaping: ${trickyLine}`);
  assert.ok(trickyLine.includes('"/opt/data%%-dir"'), `% specifier must literal escaping: ${trickyLine}`);
  // internal double quotes and backslash add multiple escaping
  const quoted = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/we"ird\\path/cli.js',
    dataDir: '/opt/d',
  });
  const quotedLine = quoted.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(quotedLine.includes('\\"') && quotedLine.includes('\\\\'), `internal quotes/backslash must escaping: ${quotedLine}`);

  const win = renderServiceSpec({ platform: 'win32', nodePath: 'C:\\node\\node.exe', cliEntryPath: 'C:\\helm\\cli.js', dataDir });
  assert.equal(win.platform, 'win32');
  assert.match(win.configPath, /HelmNode\.xml$/);
  assert.deepEqual(win.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmNode', '/XML', win.targetPath]);
  assert.match(win.content, /<Task version="1\.2"/);
  assert.ok(win.content.includes('&quot;/opt/helm data&quot;'), 'task parameter in XML in by literal value reference');
  assert.deepEqual(win.uninstallCmd, ['schtasks', '/Delete', '/F', '/TN', 'HelmNode']);
  // XML Profile legal escaping: remove XML declaration/note release/tag after text content without not escaping special character, path original keep
  const xmlText = win.content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<\/[a-zA-Z][^>]*>/g, '')
    .replace(/<[a-zA-Z][^>]*>/g, '')
    .replace(/&(lt|gt|amp|apos|quot);/g, '');
  assert.ok(!/[<>&]/.test(xmlText), `XML text should without not escaping special character: ${JSON.stringify(xmlText)}`);
  assert.ok(win.content.includes('/opt/helm data'));

  // unsupported platform: explicit errors, must not by default Linux
  assert.throws(() => renderServiceSpec({ platform: 'freebsd', cliEntryPath: cliEntry, dataDir }), /unsupported platform/);
});

test('runNodeCli service status(inject execCommand no side effects)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-service-');
  try {
    // status: not installed (exec failed such as present running unknown)
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

test('runNodeCli connect --once --json: real Hub register once i.e. exit', { timeout: 60_000 }, async () => {
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
    // identity persisted (0600;Windows without POSIX mode, skip pattern assertion)
    const st = await fs.stat(path.join(dir, 'node.json'));
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
    // Hub receives register
    assert.equal(hub.registrations.length, 1);

    // --once and --json output is legal JSON(single row object)
    assert.equal(r.out.trim().startsWith('{'), true);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runNodeCli start missing identity explicit errors;start -d real Hub can reach then state=registered', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-start-');
  let hub: Awaited<ReturnType<typeof startHubFixture>> | undefined;
  try {
    const noIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(noIdentity.code, 1);
    assert.match(JSON.parse(noIdentity.err).error.message, /not found node identity|connect/);

    // can reach Hub: background child process real register succeeded → state=registered(ready based on real daemon register state)
    const execOutputs: EnvExecOutputEvent[] = [];
    hub = await startHubFixture({ expectedToken: 'start-1:s', heartbeatMs: 15_000, execOutputs });
    await bindIdentityFromJoinToken(dir, 'start-1:s', hub.url);
    const withIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(withIdentity.code, 0, withIdentity.err);
    const payload = JSON.parse(withIdentity.out) as { ok: boolean; pid: number; state: string };
    assert.equal(payload.ok, true);
    assert.ok(payload.pid > 0);
    assert.equal(payload.state, 'registered');
    // Hub indeed receives register
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
    assert.equal(hub.registrations.length, 1);
    // pid file is new contract Profile (pid+instanceId+endpoint)
    const pidRaw = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
      pid: number;
      instanceId: string;
      endpoint: string;
    };
    assert.equal(pidRaw.pid, payload.pid);
    // real stop background process
    const stop = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(stop.code, 0);
    assert.equal(JSON.parse(stop.out).stopped, true);
  } finally {
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
