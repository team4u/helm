/**
 * env-rpc-server 独立审查回归测试：只复现真实缺陷，不复制主实现测试。
 * 每项都对应一个被修复的真实边界（见各 test 注释）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { exec as execCb } from 'node:child_process';
import {
  createNodeEnvRpcServer,
  resolveHerdrIpcEndpoint,
} from '../src/daemon/env-rpc-server.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 起 Unix Socket 行服务器（herdr 形状模拟）。 */
function startLineServer(
  dir: string,
  name: string,
  handler: (line: string, socket: net.Socket) => void,
): { path: string; close(): Promise<void> } {
  const sockPath = path.join(dir, `${name}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handler(line, socket);
      }
    });
  });
  void server.listen(sockPath).once('error', () => undefined);
  return {
    path: sockPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        void fs.rm(sockPath, { force: true }).catch(() => undefined);
      }),
  };
}

/** 等待 Unix socket 可连接（listen 是异步的）。 */
async function waitListening(sockPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(sockPath);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`socket never listened: ${sockPath}`);
    await delay(30);
  }
}

// ---------------------------------------------------------------------------
// 1. envFlushFile（协议 fb6ffbdb 补齐的必需原语）：真实文件 / 不存在 / dispose 后
// ---------------------------------------------------------------------------

test('envFlushFile：真实文件 ok、不存在 not_found、dispose 后 aborted', { timeout: 60_000 }, async () => {
  const dir = await tempDir('flush-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    await fs.writeFile(path.join(dir, 'f.txt'), 'data');
    const ok = await server.envFlushFile({ path: 'f.txt' });
    assert.equal(ok.ok, true);

    // flush 目录：is_directory（SDK POSIX 语义，Windows 同样显式检查）
    await fs.mkdir(path.join(dir, 'd'));
    const isDir = await server.envFlushFile({ path: 'd' });
    assert.equal(isDir.ok, false);
    assert.equal(!isDir.ok && isDir.error.code, 'is_directory');

    // 不存在：not_found，不伪装成功
    const missing = await server.envFlushFile({ path: 'no-such' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');
  } finally {
    await server.dispose();
  }

  // dispose 后：边界包装返回结构化 aborted 信封（不抛裸异常）
  const after = await server.envFlushFile({ path: 'f.txt' });
  assert.equal(after.ok, false);
  assert.equal(!after.ok && after.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dispose 终态：文件 RPC 返回结构化 aborted，不重建 env/reader', { timeout: 60_000 }, async () => {
  const dir = await tempDir('dispose-final-');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  const opened = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(opened.ok, true);
  await server.dispose();
  assert.equal(server.getOpenReaderCount(), 0);

  // 修复前缺陷：dispose 后 envReadTextFile 会重建 env 并成功执行（或裸 throw）
  const read = await server.envReadTextFile({ path: 'a.txt' });
  assert.equal(read.ok, false, 'dispose 后文件 RPC 必须拒绝');
  assert.equal(!read.ok && read.error.code, 'aborted');
  const reader = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(reader.ok, false);
  assert.equal(!reader.ok && reader.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('边界包装：null 输入与未知 reader 返回结构化错误（不裸抛）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    // null 输入：修复前解构 {path} 直接 TypeError 裸抛到 birpc 层
    const nullRead = await (server.envReadTextFile as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(
      null,
    );
    assert.equal(nullRead.ok, false);
    assert.ok(nullRead.error !== undefined);

    // 未知 readerId：结构化 not_found
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. envExec 宿主 HELM_TOKEN 隔离（不删全局 process.env，真实子进程验证）
// ---------------------------------------------------------------------------

test('envExec 宿主 HELM_TOKEN 不泄漏进子进程；input.env 受管注入可用', { timeout: 60_000 }, async (t) => {
  // 模拟节点宿主持有 token：改写测试进程 process.env（t.after 恢复）。
  // SDK NodeExecutionEnv.getShellEnv 默认继承 process.env —— 验证合并结果
  // 必须在「宿主确实带着 HELM_TOKEN 运行」的前提下成立，不靠删全局变量掩盖。
  const base = process.env;
  process.env = { ...base, HELM_TOKEN: 'host-secret-token-do-not-leak' } as NodeJS.ProcessEnv;
  t.after(() => {
    process.env = base;
  });

  const dir = await tempDir('token-iso-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    shellEnv: { HELM_HUB_URL: 'http://hub:3202', HELM_DATA_DIR: dir },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 1) 默认（inheritEnv 缺省）：宿主 token 不得出现，基础环境继承
  await server.envExec({
    execId: 't1-dump',
    command:
      'node -e \'require("fs").writeFileSync("env-dump.json", JSON.stringify({token:process.env.HELM_TOKEN??null,hub:process.env.HELM_HUB_URL??null,hasPath:!!process.env.PATH,hasHome:!!process.env.HOME,data:process.env.HELM_DATA_DIR??null}))\'',
    timeout: 30,
  });
  const dump1 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump.json'), 'utf8')) as {
    token: string | null;
    hub: string | null;
    hasPath: boolean;
    hasHome: boolean;
    data: string | null;
  };
  assert.equal(dump1.token, null, '宿主 HELM_TOKEN 不得泄漏（SDK inheritEnv:true 默认会合并 process.env）');
  assert.equal(dump1.hub, 'http://hub:3202');
  assert.equal(dump1.data, dir);
  assert.equal(dump1.hasPath, true, '基础 PATH 继承');
  assert.equal(dump1.hasHome, true, '基础 HOME 继承');

  // 2) input.env 显式 HELM_TOKEN（Hub 受管注入）：必须可用
  await server.envExec({
    execId: 't2',
    command: 'node -e \'require("fs").writeFileSync("env-dump2.json", JSON.stringify({token:process.env.HELM_TOKEN??null}))\'',
    env: { HELM_TOKEN: 'managed-token-xyz' },
    timeout: 30,
  });
  const dump2 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump2.json'), 'utf8')) as { token: string | null };
  assert.equal(dump2.token, 'managed-token-xyz');

  // 3) inheritEnv:false：只用 shellEnv + input.env，不带宿主基底
  await server.envExec({
    execId: 't3',
    command: 'node -e \'require("fs").writeFileSync("env-dump3.json", JSON.stringify({hasPath:!!process.env.PATH,hub:process.env.HELM_HUB_URL??null,custom:process.env.MY_VAR??null}))\'',
    env: { MY_VAR: 'yes' },
    inheritEnv: false,
    timeout: 30,
  });
  const dump3 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump3.json'), 'utf8')) as {
    hasPath: boolean;
    hub: string | null;
    custom: string | null;
  };
  assert.equal(dump3.hasPath, false, 'inheritEnv:false 不带宿主 PATH');
  assert.equal(dump3.hub, 'http://hub:3202', 'shellEnv 仍注入');
  assert.equal(dump3.custom, 'yes', 'input.env 注入');
});

// ---------------------------------------------------------------------------
// 3. 输出分块：UTF-16 代理对（emoji）不得在 chunk 边界劈开；上限 1 不死循环
// ---------------------------------------------------------------------------

test('onExecOutput 分块不劈开代理对：边界正落 emoji 高/低代理之间', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('surrogate-');
  const chunks: string[] = [];
  // 选一个小上限使分块真实发生；奇数上限 + emoji（2 码元）+ 单码元字符
  // 混排必然撞上「切点落在高代理之后」的场景，由 safeChunkEnd 回退一码元。
  const CHUNK = 7;
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    maxOutputChunkChars: CHUNK,
    onExecOutput: (e) => chunks.push(e.text),
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const emoji = '😀'; // U+1F600: 高代理 + 低代理
  const payload = `AB${emoji}CD${emoji}E${emoji}FG${emoji}H`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 's1', command: 'node script.js', timeout: 30 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);

  // 拼接必须无损（劈开会产生 U+FFFD）
  assert.equal(chunks.join(''), payload, '跨 chunk 拼接必须恢复原文');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(!chunk.includes('\uFFFD'), `chunk ${i} 含替代字符：${JSON.stringify(chunk)}`);
    assert.ok(chunk.length <= CHUNK, `chunk ${i} 超上限`);
  }
  assert.ok(chunks.length > 1, `应产生多块（实际 ${chunks.length} 块）`);
  // 至少一块以高代理结尾被回退的证据：存在长度为 CHUNK-1 的块
  const hasBackoff = chunks.some((c) => c.length === CHUNK - 1);
  assert.ok(hasBackoff, '存在因代理对回退一码元的块（切点真实落在高/低代理之间）');
});

test('maxOutputChunkChars=1 遇 emoji 不死循环：每轮前进并终局', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('chunk1-');
  const chunks: string[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    maxOutputChunkChars: 1,
    onExecOutput: (e) => chunks.push(e.text),
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 修复前缺陷：safeChunkEnd(text, offset=0, limit=1) 在 emoji 开头时
  // 回退到 0 → end === offset → 无限循环，envExec 永不返回（测试超时）。
  const emoji = '🚀';
  const payload = `A${emoji}B${emoji}`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 'c1', command: 'node script.js', timeout: 20 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(server.getActiveExecCount(), 0);
  // 上限为1时，完整代理对允许占2码元；每个分块单独UTF-8编码也必须无损。
  assert.equal(chunks.map((chunk) => Buffer.from(chunk).toString()).join(''), payload)
  assert.equal(chunks.join(''), payload, '分块拼接必须恢复原文');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.length >= 1 && chunk.length <= 2, `chunk ${i} 应为完整码点`);
  }
});

// ---------------------------------------------------------------------------
// 4. onExecOutput 回调异常：立即取消进程并返回 callback_error（不空跑到超时）
// ---------------------------------------------------------------------------

test('onExecOutput 回调抛异常：立即杀树返回 callback_error，不等慢命令超时', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cb-err-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // 首次回调即抛：echo 的多行输出通常合并在同一个 data chunk 里到达，
    // 「第 N 次」语义不可靠；首次必抛才能确定性触发。
    onExecOutput: () => {
      throw new Error('sink exploded');
    },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 修复前双重缺陷：1) 回调异常被静默吞，进程空跑到 sleep/timeout；
  // 2) SDK 在「shell 字符串命令 + 回调栈内取消」时 promise 永不 settle，
  // envExec 挂死——race 兕底强制结算 callback_error。
  const start = Date.now();
  const r = await server.envExec({
    execId: 'c2',
    command: 'echo line1 && echo line2 && sleep 55',
    timeout: 60,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, '回调失败不得伪装成功');
  assert.equal(!r.ok && r.error.code, 'callback_error');
  assert.match(!r.ok ? r.error.message : '', /sink exploded/);
  assert.ok(elapsed < 10_000, `回调失败应立即杀树（实际 ${elapsed}ms，不应等满 sleep/timeout）`);
  assert.equal(server.getActiveExecCount(), 0, '进程被取消，无在途条目残留');
  // 孤儿进程验证：锦定 ^sleep 55$ 精确匹配（非锦定 -f 会匹配到检测命令
  // 自身的命令行，产生误报）。给杀组一点宽限时间。
  await delay(300);
  const leftover = await new Promise<number>((resolve) => {
    execCb('pgrep -f "^sleep 55$" | grep -cv pgrep || true', (error, stdout) => {
      resolve(error ? -1 : Number.parseInt((stdout || '0').trim(), 10));
    });
  });
  assert.equal(leftover, 0, '杀树后不得留孤儿 sleep 进程');
});

// ---------------------------------------------------------------------------
// 5. base64 边界校验：Node 宽松解析不得静默吞非法字符
// ---------------------------------------------------------------------------

test('envWriteFile base64 严格校验：非法字母表显式 invalid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Node Buffer.from(x,'base64') 会静默忽略 '!' 等字符 —— 修复后必须拒绝
  const bad = await server.envWriteFile({ path: 'x.bin', content: 'QQ!Q', encoding: 'base64' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'x.bin')).then(() => true, () => false), false, '不得写出错误数据');

  // 含空白的 base64 同样拒绝（宽松解析会跳过空白）
  const space = await server.envWriteFile({ path: 'y.bin', content: 'QQ Q', encoding: 'base64' });
  assert.equal(space.ok, false);
  assert.equal(!space.ok && space.error.code, 'invalid');

  // 合法 base64 正常工作
  const good = await server.envWriteFile({ path: 'z.bin', content: Buffer.from('ok').toString('base64'), encoding: 'base64' });
  assert.equal(good.ok, true);
  assert.equal(await fs.readFile(path.join(dir, 'z.bin'), 'utf8'), 'ok');

  // 空内容合法
  const empty = await server.envWriteFile({ path: 'e.bin', content: '', encoding: 'base64' });
  assert.equal(empty.ok, true);
});

// ---------------------------------------------------------------------------
// 6. envExec 重复 execId：显式拒绝（覆盖会丢失旧 cancel 句柄）；
//    且被拒绝的调用不得从 dispose 排空集中挤掉真实在途命令
// ---------------------------------------------------------------------------

test('envExec 重复 execId 在途时显式拒绝', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('dup-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const slow = server.envExec({ execId: 'dup', command: 'sleep 5', timeout: 30 });
  await delay(200);
  const second = await server.envExec({ execId: 'dup', command: 'echo hi', timeout: 30 });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.code, 'invalid');
  assert.match(!second.ok ? second.error.message : '', /Duplicate execId/);

  await server.envAbortExec('dup');
  const settled = await slow;
  assert.equal(settled.ok, false);
  assert.equal(!settled.ok && settled.error.code, 'aborted');
  assert.equal(server.getActiveExecCount(), 0);
});

test('dispose 排空按调用追踪：同 execId 的被拒调用不挤掉真实在途命令', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-set-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 修复前缺陷：execWaiters 是 Map<execId, Promise>，同 execId 的第二次
  // （被拒的）调用会覆盖第一次的 promise，且先 settle 时把条目删掉——
  // dispose 等待集里就没有真实的 sleep 命令了。改 Set<Promise> 后每个
  // 调用独立追踪。
  const slow = server.envExec({ execId: 'd', command: 'sleep 3', timeout: 60 });
  await delay(200);
  const dup = await server.envExec({ execId: 'd', command: 'echo x', timeout: 60 });
  assert.equal(dup.ok, false, '重复 execId 应被拒');

  await server.dispose();
  assert.equal(server.getActiveExecCount(), 0, 'dispose 等到了真实在途命令 settle');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

// ---------------------------------------------------------------------------
// 7. IPC 注入边界：多行/CR/NUL 载荷拒绝；非法 callId/timeout 拒绝
// ---------------------------------------------------------------------------

test('ipcCall 载荷单行校验：换行注入拒绝（不拆成多帧请求）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ipc-inject-');
  const received: string[] = [];
  const srv = startLineServer(dir, 'herdr', (line) => received.push(line));
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
  });

  // 修复前缺陷：line 中间的换行会注入第二个请求帧
  const injected = await server.ipcCall!({
    endpoint: srv.path,
    line: '{"id":"1","method":"a"}\n{"id":"2","method":"evil"}',
    timeoutMs: 2_000,
  });
  assert.equal(injected.ok, false);
  assert.equal(!injected.ok && injected.error.code, 'invalid');
  assert.match(!injected.ok ? injected.error.message : '', /single line/i);

  // CR 同样拒绝
  const cr = await server.ipcCall!({ endpoint: srv.path, line: 'a\rb', timeoutMs: 2_000 });
  assert.equal(cr.ok, false);
  assert.equal(!cr.ok && cr.error.code, 'invalid');

  // NUL 拒绝
  const nul = await server.ipcCall!({ endpoint: srv.path, line: 'a\u0000b', timeoutMs: 2_000 });
  assert.equal(nul.ok, false);
  assert.equal(!nul.ok && nul.error.code, 'invalid');

  // 非空校验
  const emptyLine = await server.ipcCall!({ endpoint: srv.path, line: '', timeoutMs: 2_000 });
  assert.equal(emptyLine.ok, false);
  assert.equal(!emptyLine.ok && emptyLine.error.code, 'invalid');

  // 非法 callId
  const badId = await server.ipcCall!({ callId: 'x'.repeat(129), endpoint: srv.path, line: 'ok', timeoutMs: 2_000 });
  assert.equal(badId.ok, false);
  assert.equal(!badId.ok && badId.error.code, 'invalid');

  // 非法 timeoutMs（负数/NaN）
  const negTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: -5 });
  assert.equal(negTimeout.ok, false);
  assert.equal(!negTimeout.ok && negTimeout.error.code, 'invalid');
  const nanTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: Number.NaN });
  assert.equal(nanTimeout.ok, false);
  assert.equal(!nanTimeout.ok && nanTimeout.error.code, 'invalid');

  // 合法单行正常往返
  const respSrv = startLineServer(dir, 'resp', (line, socket) => {
    socket.write(`${JSON.stringify({ id: line, result: 'ok' })}\n`);
  });
  try {
    await waitListening(respSrv.path);
    const ok = await server.ipcCall!({ endpoint: respSrv.path, line: 'single', timeoutMs: 3_000 });
    assert.equal(ok.ok, true);
  } finally {
    await respSrv.close();
  }
});

test('ipcSubscribe ACK 结构化判定：子串匹配的数据帧不再被误判为 ACK', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ack-strict-');
  const events: string[] = [];
  // 修复前缺陷：line.includes('"subscription_started"') 会把含该子串的
  // 数据帧误判为 ACK。此服务器先推一条「事件中嵌有 ACK 子串」的数据行，
  // 再推真正的 ACK —— 严格判定下数据帧不能被吃掉。
  const srv = startLineServer(dir, 'tricky', (_line, socket) => {
    socket.write(`${JSON.stringify({ event: 'note', detail: 'saw "subscription_started" text' })}\n`);
    socket.write(`${JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } })}\n`);
    socket.write(`${JSON.stringify({ event: 'real' })}\n`);
  });
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onIpcEvent: (e) => events.push(e.line),
  });
  t.after(async () => {
    await server.dispose();
  });

  // 首个响应行是嵌 ACK 子串的数据帧：协议要求首行必须是 ACK——按
  // unexpected 显式拒绝（不误判成功，也不静默吞帧）。
  const ack = await server.ipcSubscribe!({ subscribeId: 's1', endpoint: srv.path, line: 'req' });
  assert.equal(ack.ok, false, '嵌 ACK 子串的数据帧作为首行必须被拒绝');
  assert.match(!ack.ok ? ack.error.message : '', /unexpected/);
  assert.equal(events.length, 0, '误判 ACK 不应吞掉数据帧当 ACK');

  // 对照：真正的 ACK 首行照常成功
  const goodSrv = startLineServer(dir, 'good', (line, socket) => {
    socket.write(`${JSON.stringify({ id: line, result: { type: 'subscription_started' } })}\n`);
    socket.write(`${JSON.stringify({ event: 'real' })}\n`);
  });
  try {
    await waitListening(goodSrv.path);
    const good = await server.ipcSubscribe!({ subscribeId: 's1b', endpoint: goodSrv.path, line: 'req' });
    assert.equal(good.ok, true, good.ok ? '' : good.error.message);
    await delay(200);
    assert.ok(events.some((l) => JSON.parse(l).event === 'real'), '真 ACK 后事件正常转发');
  } finally {
    await goodSrv.close();
  }
});

test('ipcSubscribe 事件帧 NUL 拒绝并走 onIpcClosed', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ev-nul-');
  const closed: { id: string; error?: string }[] = [];
  const srv = startLineServer(dir, 'nul', (_line, socket) => {
    socket.write(`${JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } })}\n`);
    socket.write(Buffer.concat([Buffer.from('{"event":"bad","x":"'), Buffer.from([0x00]), Buffer.from('"}\n')]));
    socket.write(`${JSON.stringify({ event: 'after' })}\n`);
  });
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onIpcClosed: (e) => closed.push({ id: e.subscribeId, error: e.error }),
  });
  t.after(async () => {
    await server.dispose();
  });

  const ack = await server.ipcSubscribe!({ subscribeId: 's2', endpoint: srv.path, line: 'req' });
  assert.equal(ack.ok, true);
  await delay(300);
  assert.equal(server.getActiveIpcSubscriptionCount(), 0, '坏帧后订阅应关闭');
  const closedEvent = closed.find((c) => c.id === 's2');
  assert.ok(closedEvent !== undefined, 'onIpcClosed 应通知');
  assert.match(closedEvent?.error ?? '', /NUL/);
});

// ---------------------------------------------------------------------------
// 8. ipcCall 空闲兜底：静默服务器（不回包不关闭）真实超时，注入短值验证
// ---------------------------------------------------------------------------

test('ipcCall 无 timeoutMs 静默服务器：空闲兜底真实超时（注入 300ms）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle-');
  const srv = startLineServer(dir, 'silent', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  // 注入短空闲兜底：验证「无 timeoutMs 也必然超时返回」的真实路径，
  // 而非只靠类型断言声称兜底存在。
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 300 });
  t.after(async () => {
    await server.dispose();
  });

  const start = Date.now();
  const r = await server.ipcCall!({ endpoint: srv.path, line: 'req' }); // 无 timeoutMs
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.match(!r.ok ? r.error.message : '', /300ms/);
  assert.ok(elapsed >= 250 && elapsed < 5_000, `兜底应约 300ms 生效（实际 ${elapsed}ms）`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcCall timeoutMs:0 同样走空闲兜底并登记在途 socket', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle2-');
  const srv = startLineServer(dir, 'silent2', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 200 });
  t.after(async () => {
    await server.dispose();
  });

  // timeoutMs:0 修复前不设任何计时器（条件 timeoutMs > 0 才设）→ 永久挂起；
  // 修复后 0/缺省走同一空闲兜底。
  const pending = server.ipcCall!({ callId: 'c0', endpoint: srv.path, line: 'req', timeoutMs: 0 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1, 'timeoutMs:0 也应登记在途 socket');
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0);

  // ipcAbortCall 对挂起调用立即生效
  const pending2 = server.ipcCall!({ callId: 'c1', endpoint: srv.path, line: 'req', timeoutMs: 60_000 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1);
  await server.ipcAbortCall!('c1');
  const r2 = await pending2;
  assert.equal(r2.ok, false);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

// ---------------------------------------------------------------------------
// 9. 端点解析（纯函数 + 平台注入）：session 白名单 / Windows pipe 前缀
// ---------------------------------------------------------------------------

test('resolveHerdrIpcEndpoint session 校验与 herdr validate_name 同向', { timeout: 60_000 }, () => {
  // herdr 允许：字母数字 . _ -（首字符无限制，≤64 字节，非 ./..）
  // 修复前缺陷：白名单缺 `.` 且要求字母开头 —— 'a.b-c_d' 会被拒。
  const dotted = resolveHerdrIpcEndpoint(
    { session: 'a.b-c_d' },
    { platform: 'linux', homeDir: '/home/u', getEnv: () => undefined },
  );
  assert.match(dotted, /sessions[/]a\.b-c_d[/]herdr\.sock$/);
  const numeric = resolveHerdrIpcEndpoint(
    { session: '2nd-work' },
    { platform: 'linux', homeDir: '/home/u', getEnv: () => undefined },
  );
  assert.match(numeric, /sessions[/]2nd-work[/]herdr\.sock$/);

  // 拒绝：路径穿越、空、超长、非法字符、./..
  for (const bad of ['../evil', 'a/b', 'a b', '.', '..', 'x'.repeat(65), 'a#b']) {
    assert.throws(
      () => resolveHerdrIpcEndpoint({ session: bad }, { platform: 'linux', homeDir: '/home/u', getEnv: () => undefined }),
      { message: /session/i },
      `session ${JSON.stringify(bad)} 应拒绝`,
    );
  }
});

test('resolveHerdrIpcEndpoint win32：\\.\pipe\ + 配置目录路径字符串（冒号/斜杠原样）', { timeout: 60_000 }, () => {
  const noEnv = () => undefined;

  // 依据 interprocess 2.4.2 map_generic_namespaced_osstr + pathcvt：
  // pipe 名 = '\\.\pipe\' + herdr 配置目录路径字符串，冒号与反斜杠均原样保留。
  const appdata = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : undefined) },
  );
  assert.equal(appdata, '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock');

  const withSession = resolveHerdrIpcEndpoint(
    { session: 'work' },
    { platform: 'win32', getEnv: (n) => (n === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : undefined) },
  );
  assert.equal(withSession, '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\work\\herdr.sock');

  // XDG_CONFIG_HOME 优先于 APPDATA（herdr config_dir 同序）
  const xdg = resolveHerdrIpcEndpoint(
    {},
    {
      platform: 'win32',
      getEnv: (n) =>
        n === 'XDG_CONFIG_HOME' ? 'D:\\xdg' : n === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : undefined,
    },
  );
  assert.equal(xdg, '\\\\.\\pipe\\D:\\xdg\\herdr\\herdr.sock');

  // APPDATA 缺失 → USERPROFILE\AppData\Roaming（herdr platform_config_dir 同向）
  const userProfile = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'USERPROFILE' ? 'C:\\Users\\dev' : undefined) },
  );
  assert.equal(userProfile, '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock');

  // 再退 HOME/.config > temp
  const homeFallback = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', homeDir: '/ignored', tempDir: 'T:\\tmp', getEnv: (n) => (n === 'HOME' ? 'C:\\Users\\dev' : undefined) },
  );
  assert.equal(homeFallback, '\\\\.\\pipe\\C:\\Users\\dev\\.config\\herdr\\herdr.sock');
  const tempFallback = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', homeDir: '/ignored', tempDir: 'T:\\tmp', getEnv: noEnv },
  );
  assert.equal(tempFallback, '\\\\.\\pipe\\T:\\tmp\\herdr\\herdr.sock');

  // HERDR_SOCKET_PATH 覆盖默认推导（原样返回，不加前缀）
  const envOverride = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'HERDR_SOCKET_PATH' ? 'E:\\custom.sock' : undefined) },
  );
  assert.equal(envOverride, 'E:\\custom.sock');

  // 显式完整 pipe endpoint 原样返回
  const explicit = resolveHerdrIpcEndpoint(
    { endpoint: '\\\\.\\pipe\\my-custom' },
    { platform: 'win32', getEnv: noEnv },
  );
  assert.equal(explicit, '\\\\.\\pipe\\my-custom');

  // unix 平台不受 Windows 前缀影响（同一注入函数交叉验证）
  const unix = resolveHerdrIpcEndpoint(
    {},
    { platform: 'linux', homeDir: '/home/u', getEnv: noEnv },
  );
  assert.equal(unix, '/home/u/.config/herdr/herdr.sock');
  assert.ok(!unix.includes('pipe'));
});

// ---------------------------------------------------------------------------
// 10. dispose 排空：在途 exec/ipcCall/订阅 在 dispose 返回前全部收口
// ---------------------------------------------------------------------------

test('dispose 等待在途 exec settle：返回后无在途条目', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const slow = server.envExec({ execId: 'd1', command: 'sleep 3', timeout: 60 });
  await delay(250);
  assert.equal(server.getActiveExecCount(), 1);
  await server.dispose();
  // 修复前缺陷：dispose 不等待在途 promise，running 条目由 finally 异步删除，
  // 此处可能仍为 1。
  assert.equal(server.getActiveExecCount(), 0, 'dispose 返回时在途 exec 必须已 settle 并清理');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

test('dispose 销毁在途 ipcCall socket：等待 promise 立即失败', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('disp-ipc-');
  const srv = startLineServer(dir, 'hold', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
  });

  const pending = server.ipcCall!({ callId: 'c9', endpoint: srv.path, line: 'req', timeoutMs: 60_000 });
  await delay(150);
  assert.equal(server.getActiveIpcCallCount(), 1);
  await server.dispose();
  const r = await pending;
  assert.equal(r.ok, false, 'dispose 后在途 ipcCall 不得悬挂');
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('dispose 销毁活跃订阅并停发事件', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('disp-sub-');
  const events: string[] = [];
  let pushTimer: NodeJS.Timeout | undefined;
  const srv = startLineServer(dir, 'push', (line, socket) => {
    socket.on('error', () => { if (pushTimer) clearInterval(pushTimer) });
    socket.write(`${JSON.stringify({ id: line, result: { type: 'subscription_started' } })}\n`);
    let seq = 0;
    pushTimer = setInterval(() => {
      if (socket.destroyed || socket.writableEnded) return;
      seq += 1;
      socket.write(`${JSON.stringify({ event: 'tick', seq })}\n`);
    }, 50);
    socket.once('close', () => {
      if (pushTimer !== undefined) clearInterval(pushTimer);
    });
  });
  t.after(async () => {
    if (pushTimer !== undefined) clearInterval(pushTimer);
    await srv.close();
  });
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onIpcEvent: (e) => events.push(e.line),
  });
  t.after(async () => {
    await server.dispose();
  });

  const ack = await server.ipcSubscribe!({ subscribeId: 'sd', endpoint: srv.path, line: 'req' });
  assert.equal(ack.ok, true);
  await delay(200);
  const before = events.length;
  assert.ok(before > 0, 'dispose 前应有事件');
  await server.dispose();
  await delay(200);
  assert.equal(events.length, before, 'dispose 后不再收到事件');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
});

// ---------------------------------------------------------------------------
// 11. 升级排空纳入 IPC：draining 拒新 call/subscribe，在途 call 计入排空口径
// ---------------------------------------------------------------------------

test('升级排空纳入 IPC：draining 拒新 call/subscribe，在途 call 不强杀且计入排空计数', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-ipc-');
  // 挂起服务器：收到请求不回（模拟 herdr:agy --wait 长等待）
  const hold = startLineServer(dir, 'hold', () => undefined);
  // 回声服务器：验证解除 draining 后恢复受理
  const echo = startLineServer(dir, 'echo', (line, socket) => socket.write(`${line}-ok\n`));
  t.after(async () => {
    await hold.close();
    await echo.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await waitListening(hold.path);
  await waitListening(echo.path);

  // 在途一次性 call（无 callId）也计入排空口径：升级事务据此等待其收敛
  const pending = server.ipcCall!({ endpoint: hold.path, line: 'wait-req', timeoutMs: 600 });
  await delay(150);
  assert.equal(server.getActiveIpcCallCount(), 1, '在途 IPC call 应计入排空计数');

  server.setDraining(true);
  const rejectedCall = await server.ipcCall!({ endpoint: echo.path, line: 'new-call', timeoutMs: 1_000 });
  assert.equal(rejectedCall.ok, false);
  assert.equal(!rejectedCall.ok && rejectedCall.error.code, 'node_draining');
  assert.match(!rejectedCall.ok ? rejectedCall.error.message : '', /draining/);

  const rejectedSub = await server.ipcSubscribe!({ subscribeId: 's-drain', endpoint: echo.path, line: 'new-sub' });
  assert.equal(rejectedSub.ok, false);
  assert.equal(!rejectedSub.ok && rejectedSub.error.code, 'node_draining');
  assert.match(!rejectedSub.ok ? rejectedSub.error.message : '', /draining/);

  // draining 不强杀在途：超时自然结算后计数归零
  const settled = await pending;
  assert.equal(settled.ok, false);
  assert.equal(!settled.ok && settled.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0, '排空计数应随在途 call 结算归零');

  // 恢复受理（升级失败回滚路径）
  server.setDraining(false);
  const okAgain = await server.ipcCall!({ endpoint: echo.path, line: 'after', timeoutMs: 2_000 });
  assert.equal(okAgain.ok, true);
});

test('envCleanup：draining/disposed 显式拒绝（按 cwd 杀同 cwd 全部会话命令的锋利语义）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cleanup-guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  server.setDraining(true);
  await assert.rejects(
    () => server.envCleanup!(dir),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'node_draining');
      assert.match(err.message ?? '', /draining/);
      return true;
    },
  );

  server.setDraining(false);
  await server.envCleanup!(dir); // 正常路径不抛

  await server.dispose();
  await assert.rejects(() => server.envCleanup!(dir), /disposed/);
});

// ---------------------------------------------------------------------------
// 12. LineAssembler 限长闭合：带换行的完整超长行不再绕过单帧上限
// ---------------------------------------------------------------------------

test('ipcCall 单帧上限：带换行的完整超长行同样拒绝（不再整行进内存回传）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ipc-frame-limit-');
  // 回一行超限内容 + '\n'：修复前完整行从不检查长度，直接通过
  const srv = startLineServer(dir, 'bigline', (_line, socket) => {
    socket.write(Buffer.concat([Buffer.alloc(32 * 1024 * 1024 + 1, 0x61), Buffer.from('\n')]));
  });
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const result = await server.ipcCall!({ endpoint: srv.path, line: 'q', timeoutMs: 30_000 });
  assert.equal(result.ok, false, '超限完整行必须被拒绝');
  assert.match(!result.ok ? result.error.message : '', /exceeds/);
});

// ---------------------------------------------------------------------------
// 13. birpc events 适配：on/off 包装引用配对（$close 后监听器完整摘除）
// ---------------------------------------------------------------------------

test('birpc events 适配：off 摘除包装监听，多路 on 各自独立摘除', { timeout: 60_000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const { createSocketBirpcEvents } = await import('../src/daemon/birpc-events.js');
  const socket = new EventEmitter();
  const invalidFrames: string[] = [];
  const events = createSocketBirpcEvents(socket as never, (message) => {
    invalidFrames.push(message);
  });

  const receivedA: unknown[] = [];
  const callbackA = (data: unknown): void => {
    receivedA.push(data);
  };
  events.on(callbackA);
  assert.equal(socket.listenerCount('message'), 1);

  socket.emit('message', Buffer.from(JSON.stringify({ a: 1 })));
  assert.deepEqual(receivedA, [{ a: 1 }]);

  // 非法 JSON / 非对象帧走 onInvalidFrame，不进回调
  socket.emit('message', Buffer.from('not-json'));
  socket.emit('message', Buffer.from('[1,2]'));
  assert.equal(invalidFrames.length, 2);
  assert.deepEqual(receivedA, [{ a: 1 }]);

  const receivedB: unknown[] = [];
  const callbackB = (data: unknown): void => {
    receivedB.push(data);
  };
  events.on(callbackB);
  assert.equal(socket.listenerCount('message'), 2);

  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 1, 'off 必须摘除实际注册的包装监听');
  socket.emit('message', Buffer.from(JSON.stringify({ b: 2 })));
  assert.deepEqual(receivedA, [{ a: 1 }], '已摘除的回调不再收帧');
  assert.deepEqual(receivedB, [{ b: 2 }]);

  events.off(callbackB);
  assert.equal(socket.listenerCount('message'), 0, '全部摘除后无 message 残留（$close 语义）');
  // 未知回调的 off 幂等无害
  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 0);
});
