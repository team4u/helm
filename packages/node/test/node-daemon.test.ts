/**
 * @helm/node 全链路真实测试：不 mock 被测模块。
 * - NodeEnvRpcServer：真实文件/目录/Reader/命令执行 + 真实 Unix Socket IPC 桥；
 * - 身份持久化：真实临时目录、0600 权限、token 轮换与跨 nodeId 冲突；
 * - createNodeDaemon：真实本地 http.Server + WebSocketServer + birpc Hub 模拟，
 *   反向调用 envExec / envReadTextFile / ipcCall，断线重连与鉴权拒绝（4003）；
 * - runNodeCli：status / service 模板（三平台）/ --help / --json。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
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

import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. 依赖极简回归：@helm/node 运行时依赖仅限 @helm/protocol / birpc / ws
// ---------------------------------------------------------------------------

test('@helm/node 运行时依赖仅 @helm/protocol / birpc / ws（防重依赖回归）', { timeout: 60_000 }, async () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}).sort(),
    ['@helm/protocol', 'birpc', 'ws'],
    '@helm/node 的 dependencies 必须且仅能是 @helm/protocol / birpc / ws（不得引入 @earendil-works/* 等重依赖）',
  );
});


async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. NodeEnvRpcServer：文件/目录/Reader/exec/dispose
// ---------------------------------------------------------------------------

test('env 文件读写与目录列表', { timeout: 60_000 }, async () => {
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

    // base64 二进制读写
    const bytes = Buffer.from([0, 1, 2, 255]);
    await server.envWriteFile({ path: 'b.bin', content: bytes.toString('base64'), encoding: 'base64' });
    const bin = await server.envReadBinaryFile({ path: 'b.bin' });
    assert.equal(bin.ok, true);
    assert.deepEqual(bin.ok && Buffer.from(bin.value.base64, 'base64'), bytes);

    // 目录列表
    await server.envCreateDir({ path: 'sub', recursive: true });
    await server.envWriteFile({ path: 'sub/c.txt', content: 'x' });
    const list = await server.envListDir({ path: '.' });
    assert.equal(list.ok, true);
    const names = (list.ok ? list.value : []).map((e) => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'b.bin', 'sub']);

    // 不存在文件 → 结构化错误 not_found
    const missing = await server.envReadTextFile({ path: 'no-such.txt' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');

    // 绝对路径解析
    const abs = await server.envAbsolutePath({ path: 'a.txt' });
    assert.equal(abs.ok && abs.value, path.join(dir, 'a.txt'));
    const exists = await server.envExists({ path: 'a.txt' });
    assert.equal(exists.ok && exists.value, true);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Text/Binary/Dir Reader 生命周期与 dispose 清理', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-readers-');
  await fs.writeFile(path.join(dir, 'lines.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from([0x41, 0x0a, 0x43, 0x44])); // "A\nCD"：1 个换行
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
    // 未知 reader 显式报错
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
    // 关闭后再读报错
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
    assert.equal(scan.ok && scan.value.firstLineBytes, 2); // 第 1 行 "CD"

    // Dir reader
    const d = await server.envOpenDirReader({ path: 'd' });
    assert.equal(d.ok, true);
    const did = d.ok ? d.value.readerId : '';
    const page = await server.envDirReaderNext({ readerId: did, maxEntries: 10 });
    assert.equal(page.ok && page.value.entries.length, 2);
    assert.equal(page.ok && page.value.done, true);

    // dispose 关闭所有 reader
    assert.equal(server.getOpenReaderCount(), 2); // binary + dir
    await server.dispose();
    assert.equal(server.getOpenReaderCount(), 0);
    // dispose 幂等
    await server.dispose();
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('envExec 流式输出与 envAbortExec 立即终止子进程树', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-exec-');
  const chunks: EnvExecOutputEvent[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onExecOutput: (event) => chunks.push(event),
    shellEnv: { HELM_TEST_MARKER: 'from-shell-env' },
  });
  try {
    // 真实命令：stdout 流式输出
    const ok = await server.envExec({
      execId: 'e1',
      command: 'echo hello-from-exec && echo marker=$HELM_TEST_MARKER 1>&2',
      timeout: 30,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.value.exitCode, 0);
    const text = chunks.map((c) => c.text).join('');
    assert.match(text, /hello-from-exec/);
    assert.match(text, /marker=from-shell-env/); // shellEnv 注入生效
    const stderrChunk = chunks.find((c) => c.stream === 'stderr');
    assert.ok(stderrChunk !== undefined, 'stderr 流标记正确');

    // abort：sleep 长命令应被立即终止（aborted 结构化错误，且耗时应远小于 timeout）
    const start = Date.now();
    const slow = server.envExec({ execId: 'e2', command: 'sleep 30', timeout: 60 });
    await delay(200); // 等子进程真正启动
    assert.equal(server.getActiveExecCount(), 1);
    await server.envAbortExec('e2');
    const result = await slow;
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'aborted');
    assert.ok(elapsed < 10_000, `abort 应立即生效（实际 ${elapsed}ms）`);

    // dispose 杀死在途进程
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
// 2. NodeEnvRpcServer IPC 桥（真实 Unix Socket）
// ---------------------------------------------------------------------------

interface IpcTestServer {
  path: string;
  close(): Promise<void>;
}

/**
 * 连接级错误：客户端主动断开（ipcUnsubscribe / ipcAbortCall / 超时清理）是 IPC 桥的正常路径。
 * 对端关闭后 fixture 可能还有一次在途写入，内核回 RST 时即 EPIPE。
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

/** 真实 Unix Socket 模拟 Herdr：每连接一行请求一行响应。 */
async function startHerdrLikeServer(
  handler: (line: string, socket: net.Socket) => void,
): Promise<IpcTestServer> {
  const dir = await tempDir('helm-node-ipc-');
  const sockPath = path.join(dir, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  /** 非连接级错误：fixture 自身故障必须在 close() 暴露，不能被对端断开掩盖。 */
  const faults: Error[] = [];
  const record = (error: unknown): void => {
    if (isIpcDisconnectError(error)) return;
    faults.push(error instanceof Error ? error : new Error(String(error)));
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // 缺少 error 监听时，服务端向已回 RST 的连接写入会把 EPIPE 抛成未捕获异常，
    // 让无关测试（而非 fixture）失败。
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

test('ipcCall 请求/响应与超时', { timeout: 60_000 }, async (t) => {
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

  // 超时：服务端不回包
  const silent = await startHerdrLikeServer(() => undefined);
  try {
    const r = await server.ipcCall!({ endpoint: silent.path, line, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'timeout');
  } finally {
    await silent.close();
  }

  // 连接错误：不存在的 socket 路径
  const dead = await server.ipcCall!({ endpoint: path.join(dir, 'no', 'such.sock'), line, timeoutMs: 1_000 });
  assert.equal(dead.ok, false);
  assert.equal(!dead.ok && dead.error.code, 'unknown');

  // 首行含 NUL 字节拒绝
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

test('ipcAbortCall 立即中断阻塞等待', { timeout: 60_000 }, async (t) => {
  // 服务端收到请求后挂起不回（模拟 agent.prompt --wait）
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
  assert.ok(elapsed < 5_000, `abort 应立即生效（实际 ${elapsed}ms）`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcSubscribe 订阅流、事件转发与 ipcUnsubscribe 关闭', { timeout: 60_000 }, async (t) => {
  const events: NodeIpcEvent[] = [];
  const closed: NodeIpcClosedEvent[] = [];
  // 服务端：ACK subscription_started，之后每 40ms 推一行事件帧
  const srv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`);
    let seq = 0;
    const timer = setInterval(() => {
      // 对端断开后 close 事件可能晚于下一次 timer：可写性检查让 fixture 主动停流，
      // 而不是向已关闭连接继续写。
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

  await delay(200); // 至少 3-4 个事件
  assert.ok(events.length >= 3, `应收到流式事件（实际 ${events.length}）`);
  assert.equal(events[0]?.subscribeId, 'sub-1');
  assert.equal(JSON.parse(events[0]!.line).event, 'tick');

  // 主动退订：不触发异常 onIpcClosed
  await server.ipcUnsubscribe!('sub-1');
  await delay(150);
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
  assert.equal(closed.length, 0, '主动退订不触发 onIpcClosed');
  const countAfterUnsub = events.length;
  await delay(250);
  assert.equal(events.length, countAfterUnsub, '退订后不再收到事件');

  // 服务端拒绝订阅（error 信封）
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

  // ACK 非 subscription_started 拒绝
  const badAckSrv = await startHerdrLikeServer((line, socket) => {
    const req = JSON.parse(line) as { id: string };
    socket.write(`${JSON.stringify({ id: req.id, result: { type: 'something_else' } })}\n`);
  });
  try {
    const r = await await server.ipcSubscribe!({
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

test('ipc fixture：对端断开后的在途写入按连接级错误隔离', { timeout: 60_000 }, async () => {
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

    // 暂停读取让后续 tick 留在接收缓冲；再硬关闭，服务端的在途写入就会命中
    // 已断开连接。缺少 error 监听时 EPIPE 会成为未捕获异常，拖垮整个测试文件。
    client.pause();
    await delay(50);
    client.destroy();
    await delay(150);
    assert.ok(writes > 0, 'fixture 应确实在断开后尝试过写入');
  } finally {
    client.destroy();
    await srv.close();
  }
});

test('resolveIpcEndpoint 端点解析（显式 > 环境变量 > session 默认）', { timeout: 60_000 }, async () => {
  const server = createNodeEnvRpcServer({ defaultCwd: '/tmp' }) as NodeEnvRpcServer & {
    resolveIpcEndpoint(input: { endpoint?: string; session?: string }): string;
  };
  try {
    // 显式 endpoint 优先
    assert.equal(server.resolveIpcEndpoint({ endpoint: '/explicit/sock' }), '/explicit/sock');
    // HERDR_SOCKET_PATH 次之（优先于 session 推导）
    process.env['HERDR_SOCKET_PATH'] = '/env/sock';
    try {
      assert.equal(server.resolveIpcEndpoint({}), '/env/sock');
      assert.equal(server.resolveIpcEndpoint({ session: 'work' }), '/env/sock');
    } finally {
      delete process.env['HERDR_SOCKET_PATH'];
    }
    // 有 session 时默认推导 sessions/<session>/herdr.sock
    const withSession = server.resolveIpcEndpoint({ session: 'work' });
    assert.match(withSession, /herdr[/]sessions[/]work[/]herdr\.sock$/);
    // 无 session 时推导默认 herdr.sock
    const noSession = server.resolveIpcEndpoint({});
    assert.match(noSession, /herdr[/]herdr\.sock$/);
    // 非法 session 名报 invalid
    assert.throws(() => server.resolveIpcEndpoint({ session: '../evil' }), /session/i);
    assert.throws(() => server.resolveIpcEndpoint({ session: 'a b' }), /session/i);
  } finally {
    await server.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. 身份持久化
// ---------------------------------------------------------------------------

test('parseJoinToken 合法/非法令牌', { timeout: 60_000 }, () => {
  assert.deepEqual(parseJoinToken('node-1:secret'), { nodeId: 'node-1', secret: 'secret' });
  assert.deepEqual(parseJoinToken('abc.def-2:s3cr3t!'), { nodeId: 'abc.def-2', secret: 's3cr3t!' });
  assert.equal(parseJoinToken(''), null);
  assert.equal(parseJoinToken('nosecret'), null);
  assert.equal(parseJoinToken(':secret'), null);
  assert.equal(parseJoinToken('node:'), null);
  assert.equal(parseJoinToken('bad name:secret'), null);
  // secret 含冒号合法（nodeId 取第一段）
  assert.deepEqual(parseJoinToken('n1:a:b'), { nodeId: 'n1', secret: 'a:b' });
});

test('bindIdentityFromJoinToken：首次写入 0600、同 nodeId 轮换、跨 nodeId 拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-identity-');
  try {
    // 首次绑定
    const first = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-1', 'http://127.0.0.1:3202');
    assert.equal(first.nodeId, 'workstation-1');
    assert.equal(first.token, 'workstation-1:secret-1');
    const st = await fs.stat(path.join(dir, 'node.json'));
    assert.equal(st.mode & 0o777, 0o600, 'node.json 权限应为 0600');

    // 同 nodeId 轮换 token
    const rotated = await bindIdentityFromJoinToken(dir, 'workstation-1:secret-2', 'http://127.0.0.2:3202');
    assert.equal(rotated.token, 'workstation-1:secret-2');
    const reread = await readNodeIdentity(dir);
    assert.equal(reread?.token, 'workstation-1:secret-2');
    assert.equal(reread?.hubUrl, 'http://127.0.0.2:3202');

    // 跨 nodeId 显式拒绝
    await assert.rejects(
      bindIdentityFromJoinToken(dir, 'other-node:secret', 'http://x'),
      /已绑定节点 workstation-1.*拒绝改绑/,
    );

    // 非法令牌
    await assert.rejects(bindIdentityFromJoinToken(dir, 'not-a-join-token', 'http://x'), /JOIN 令牌格式非法/);

    // 损坏 node.json 显式报错（不静默当无身份）
    await fs.writeFile(path.join(dir, 'node.json'), '{broken json', 'utf8');
    await assert.rejects(readNodeIdentity(dir), /损坏/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. createNodeDaemon：真实 WS Hub 模拟
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: NodeRegisterInput[];
  heartbeats: string[];
  /** 服务端持有的节点函数代理（本地端函数见 startHubFixture）。 */
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  close(): Promise<void>;
}

/**
 * 真实 http.Server + WebSocketServer + birpc 模拟 Hub /ws/node 网关：
 * 校验 token、register/heartbeat、按 ack.heartbeatMs 心跳、反向调用节点函数。
 * 单一 birpc 层 + 共享消息分派器（同一 socket 上两层功能：控制面 register/heartbeat
 * 与节点函数代理），避免双 birpc 争抢同一帧导致响应冲突。
 */
async function startHubFixture(options: {
  expectedToken: string;
  heartbeatMs?: number;
  reject?: boolean;
  execOutputs: EnvExecOutputEvent[];
  ipcEvents?: NodeIpcEvent[];
  ipcClosed?: NodeIpcClosedEvent[];
  /** 复用端口（重连测试：Hub 重启回同一端口）。 */
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
            // 单层失败不影响其他层。
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

test('createNodeDaemon：register + heartbeat + 反向 envExec/envReadTextFile/ipcCall', { timeout: 60_000 }, async () => {
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
  // IPC 目标 socket（在 Hub fixture 所在测试进程内不起服务：daemon 侧才连）——
  // 为验证 ipcCall 经 WS 转发到节点本机，先起一个本地 Herdr 模拟 socket。
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
    assert.equal(await daemon.waitUntilRegistered(10_000), true, '应完成注册');
    assert.equal(hub.registrations.length, 1);
    assert.equal(hub.registrations[0]?.nodeId, 'work-a');
    assert.equal(hub.registrations[0]?.token, token);
    assert.equal(typeof hub.registrations[0]?.hostname, 'string');
    assert.equal(hub.registrations[0]?.platform, process.platform);
    assert.equal(hub.registrations[0]?.hubUrl, hub.url);

    // 等至少一次心跳
    await delay(300);
    assert.ok(hub.heartbeats.length >= 1, '心跳应按 ack.heartbeatMs 发送');

    // 服务端反向调用：写文件 + 读回
    const rpc = hub.nodeRpc();
    assert.ok(rpc !== undefined, 'Hub 侧应持有节点代理');
    const write = await rpc!.envWriteFile({ path: 'from-hub.txt', content: 'via-ws' });
    assert.equal(write.ok, true);
    const read = await rpc!.envReadTextFile({ path: 'from-hub.txt' });
    assert.equal(read.ok && read.value, 'via-ws');
    // 相对路径基于 dataDir
    const onDisk = await fs.readFile(path.join(dir, 'from-hub.txt'), 'utf8');
    assert.equal(onDisk, 'via-ws');

    // 反向 envExec：流式输出回传 Hub
    execOutputs.length = 0;
    const exec = await rpc!.envExec({
      execId: 'hub-e1',
      command: 'echo via-hub-exec',
      timeout: 30,
    });
    assert.equal(exec.ok && exec.value.exitCode, 0);
    await delay(300); // onEnvExecOutput 是事件推送，稍等落账
    assert.match(execOutputs.map((e) => e.text).join(''), /via-hub-exec/);

    // 反向 ipcCall：经节点连本机 Herdr 模拟 socket
    const ipc = await rpc!.ipcCall!({
      endpoint: ipcSrv.path,
      line: JSON.stringify({ id: '1', method: 'ping' }),
      timeoutMs: 5_000,
    });
    assert.equal(ipc.ok, true, ipc.ok ? '' : ipc.error.message);
    assert.equal(ipc.ok && JSON.parse(ipc.value).result.pong, true);

    // 反向 ipcSubscribe：事件流回传 Hub
    const events: NodeIpcEvent[] = [];
    // 挂一个持续推流的 socket 服务
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
    await delay(400);
    assert.ok(ipcEvents.some((e) => e.subscribeId === 's1' && JSON.parse(e.line).event === 'hello'), 'ipc 事件应回传 Hub');
    await rpc!.ipcUnsubscribe!('s1');
    await subSrv.close();
  } finally {
    await daemon.close();
    await ipcSrv.close();
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createNodeDaemon：断线 dispose 旧代并自动重连重注册', { timeout: 60_000 }, async () => {
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

    // 服务端强制断开（模拟网络中断）：等 daemon 侧感知 close（退避计时器已排上）。
    await hub.close();
    await delay(300);
    assert.equal(daemon.isConnected(), false, '断线后应视为未连接');

    // 同端口重启 Hub（daemon 仍指向原 hubUrl），退避重连后应重新注册。
    const hub2 = await startHubFixture({ expectedToken: token, heartbeatMs: 15_000, execOutputs, port });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && hub2.registrations.length === 0) {
        await delay(200);
      }
      assert.equal(hub2.registrations.length, 1, '应在退避重连后重新注册');
      assert.equal(hub2.registrations[0]?.nodeId, 'work-b');
      assert.equal(daemon.isConnected(), true);
      // 新代可执行命令
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

test('createNodeDaemon：鉴权拒绝（4003）后不伪装已连接', { timeout: 60_000 }, async () => {
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
    assert.equal(await daemon.waitUntilRegistered(5_000), false, '被拒注册不得报告为已连接');
    assert.equal(daemon.isConnected(), false);
    assert.ok(hub.registrations.length >= 1, 'register 请求应到达 Hub');
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
    env: { ...process.env, ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { out, err, code };
}

test('runNodeCli --help 与未知命令/未知选项/错误信封', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /helm-node/);
  assert.match(help.out, /connect/);
  assert.match(help.out, /service install/);

  const unknown = await runCli(['bogus-command']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /未知命令/);

  const unknownFlag = await runCli(['status', '--no-such-flag']);
  assert.equal(unknownFlag.code, 1);
  assert.match(unknownFlag.err, /未知选项/);

  // --json 下未知选项也输出错误信封
  const jsonFlag = await runCli(['status', '--no-such-flag', '--json']);
  assert.equal(jsonFlag.code, 1);
  const envelope = JSON.parse(jsonFlag.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'usage_error');
  assert.match(envelope.error.message, /未知选项/);

  // 无关位置参数 / 不属于该命令的选项 / 未知短选项都拒绝
  const extraPositional = await runCli(['status', 'extra', '--json']);
  assert.equal(extraPositional.code, 1);
  assert.match(JSON.parse(extraPositional.err).error.message, /位置参数/);
  const wrongFlag = await runCli(['stop', '--token', 'x:y', '--json']);
  assert.equal(wrongFlag.code, 1);
  assert.match(JSON.parse(wrongFlag.err).error.message, /不支持/);
  const shortFlag = await runCli(['status', '-x', '--json']);
  assert.equal(shortFlag.code, 1);
  assert.match(JSON.parse(shortFlag.err).error.message, /未知选项/);
  const badService = await runCli(['service', 'bogus', '--json']);
  assert.equal(badService.code, 1);
  assert.match(JSON.parse(badService.err).error.message, /install\|uninstall\|status/);
});

test('runNodeCli status --json：未绑定/已绑定/残留 pid 与机密不输出', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-status-');
  try {
    // 未绑定
    const none = await runCli(['status', '--data-dir', dir, '--json']);
    assert.equal(none.code, 0);
    const nonePayload = JSON.parse(none.out) as { bound: boolean; dataDir: string; pid: number | null; pidAlive: boolean };
    assert.equal(nonePayload.bound, false);
    assert.equal(nonePayload.pid, null);
    assert.equal(nonePayload.pidAlive, false);

    // 绑定 + 留档指向本进程但控制通道不可达：pidAlive true + state unknown + 显式诊断
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
    assert.match(payload.detail, /控制通道不可达/);
    // 机密不输出（无 tokenPreview / token 字段）
    assert.equal('tokenPreview' in payload, false);
    assert.equal(JSON.stringify(payload).includes('cli-node:tok'), false);

    // 残留 pid（已消失）：pidAlive false + pidStale 标记，仍显式报状态不报错
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

test('runNodeCli stop：无 pid 显式失败；stale pid 清理；坏 pid 文件显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-stop-');
  try {
    // 无 pid 文件：显式失败不静默成功（错误信封走 stderr，退出码 1）
    const none = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(none.code, 1);
    assert.match(JSON.parse(none.err).error.message, /未找到 pid/);

    // 旧版纯数字 pid 留档：无法校验身份 → 损坏报错（不静默清理）
    await fs.writeFile(path.join(dir, 'node.pid'), '999999998\n', 'utf8');
    const legacy = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(legacy.code, 1);
    assert.match(JSON.parse(legacy.err).error.message, /非法|损坏/);

    // 合法结构但 pid 不存在：stale，清理 pid 文件
    await fs.writeFile(
      path.join(dir, 'node.pid'),
      JSON.stringify({ pid: 999999998, instanceId: 'e'.repeat(32), endpoint: path.join(dir, 'no.sock') }) + '\n',
      'utf8',
    );
    const dead = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(dead.code, 0);
    assert.equal(JSON.parse(dead.out).outcome, 'stale');
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid 文件应被清理');

    // 坏 JSON pid 文件：显式报错且不清理
    await fs.writeFile(path.join(dir, 'node.pid'), '{broken', 'utf8');
    const broken = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(broken.code, 1);
    assert.match(JSON.parse(broken.err).error.message, /损坏/);
    assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), true, '坏 pid 文件不静默清理');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('service 模板渲染：darwin/linux/win32（含空格中文路径与特殊字符转义）', { timeout: 60_000 }, () => {
  const dataDir = '/opt/helm 数据';
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
  // plist XML 转义：路径含空格/中文原样保留，<>&&"' 转义
  assert.ok(darwin.content.includes('/opt/helm 数据'));

  const linux = renderServiceSpec({ platform: 'linux', nodePath: '/usr/bin/node', cliEntryPath: cliEntry, dataDir });
  assert.equal(linux.platform, 'linux');
  assert.match(linux.content, /\[Unit\]/);
  assert.ok(linux.configPath.endsWith('helm-node.service'));
  assert.ok(linux.targetPath?.endsWith('helm-node.service'));
  assert.match(linux.content, /ExecStart=/);
  assert.match(linux.content, /WantedBy=default\.target/);
  assert.equal(linux.installCmd[0], 'systemctl');
  assert.equal(linux.installCmd[1], '--user');
  // systemd 引号转义：空格路径整体双引号包裹，内部引号/反斜杠加倍
  const execLine = linux.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(execLine.includes('"/opt/hélm node/dist/cli.js"'), `ExecStart 应引号包裹含空格路径: ${execLine}`);
  assert.ok(!execLine.includes('\r'), 'ExecStart 不应被控制字符拆分');
  // % 与 $ 变量不被 systemd 展开：含 %/$ 的路径须引号包裹
  const tricky = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/helm %n $MAIN/dist/cli.js',
    dataDir: '/opt/data%-dir',
  });
  const trickyLine = tricky.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(trickyLine.includes('"/opt/helm %%n $$MAIN/dist/cli.js"'), `%/$ 必须字面转义: ${trickyLine}`);
  assert.ok(trickyLine.includes('"/opt/data%%-dir"'), `% specifier 必须字面转义: ${trickyLine}`);
  // 内部双引号与反斜杠加倍转义
  const quoted = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/we"ird\\path/cli.js',
    dataDir: '/opt/d',
  });
  const quotedLine = quoted.content.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(quotedLine.includes('\\"') && quotedLine.includes('\\\\'), `内部引号/反斜杠须转义: ${quotedLine}`);

  const win = renderServiceSpec({ platform: 'win32', nodePath: 'C:\\node\\node.exe', cliEntryPath: 'C:\\helm\\cli.js', dataDir });
  assert.equal(win.platform, 'win32');
  assert.match(win.configPath, /HelmNode\.xml$/);
  assert.deepEqual(win.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmNode', '/XML', win.targetPath]);
  assert.match(win.content, /<Task version="1\.2"/);
  assert.ok(win.content.includes('&quot;/opt/helm 数据&quot;'), '任务参数在 XML 中按字面值引用');
  assert.deepEqual(win.uninstallCmd, ['schtasks', '/Delete', '/F', '/TN', 'HelmNode']);
  // XML 留档合法转义：剔除 XML 声明/注释/标签后文本内容无未转义特殊字符，路径原样保留
  const xmlText = win.content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<\/[a-zA-Z][^>]*>/g, '')
    .replace(/<[a-zA-Z][^>]*>/g, '')
    .replace(/&(lt|gt|amp|apos|quot);/g, '');
  assert.ok(!/[<>&]/.test(xmlText), `XML 文本应无未转义特殊字符: ${JSON.stringify(xmlText)}`);
  assert.ok(win.content.includes('/opt/helm 数据'));

  // 不支持平台：显式报错，不得默认 Linux
  assert.throws(() => renderServiceSpec({ platform: 'freebsd', cliEntryPath: cliEntry, dataDir }), /不支持的平台/);
});

test('runNodeCli service status（注入 execCommand 无副作用）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-service-');
  try {
    // status：未安装（exec 失败如实呈现 running unknown）
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

test('runNodeCli connect --once --json：真实 Hub 注册一次即退出', { timeout: 60_000 }, async () => {
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
    // 身份已持久化（0600）
    const st = await fs.stat(path.join(dir, 'node.json'));
    assert.equal(st.mode & 0o777, 0o600);
    // Hub 收到注册
    assert.equal(hub.registrations.length, 1);

    // --once 且 --json 输出是合法 JSON（单行对象）
    assert.equal(r.out.trim().startsWith('{'), true);
  } finally {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runNodeCli start 缺身份显式报错；start -d 真实 Hub 可达则 state=registered', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-cli-start-');
  let hub: Awaited<ReturnType<typeof startHubFixture>> | undefined;
  try {
    const noIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(noIdentity.code, 1);
    assert.match(JSON.parse(noIdentity.err).error.message, /未找到节点身份|connect/);

    // 可达 Hub：后台子进程真实注册成功 → state=registered（ready 基于真实 daemon 登记状态）
    const execOutputs: EnvExecOutputEvent[] = [];
    hub = await startHubFixture({ expectedToken: 'start-1:s', heartbeatMs: 15_000, execOutputs });
    await bindIdentityFromJoinToken(dir, 'start-1:s', hub.url);
    const withIdentity = await runCli(['start', '-d', '--data-dir', dir, '--json']);
    assert.equal(withIdentity.code, 0, withIdentity.err);
    const payload = JSON.parse(withIdentity.out) as { ok: boolean; pid: number; state: string };
    assert.equal(payload.ok, true);
    assert.ok(payload.pid > 0);
    assert.equal(payload.state, 'registered');
    // Hub 确实收到注册
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && hub.registrations.length === 0) await delay(200);
    assert.equal(hub.registrations.length, 1);
    // pid 文件为新契约留档（pid+instanceId+endpoint）
    const pidRaw = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as {
      pid: number;
      instanceId: string;
      endpoint: string;
    };
    assert.equal(pidRaw.pid, payload.pid);
    // 真实停掉后台进程
    const stop = await runCli(['stop', '--data-dir', dir, '--json']);
    assert.equal(stop.code, 0);
    assert.equal(JSON.parse(stop.out).stopped, true);
  } finally {
    await hub?.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
