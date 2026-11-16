/**
 * env-rpc-server independent review regression test: only re- now real defect, do not duplicate main implement test.
 * each items all for should a by fix real boundary (see each test note release).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { exec as execCb } from 'node:child_process';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import {
  createNodeEnvRpcServer,
  MAX_IPC_FRAME_BYTES,
  resolveHerdrIpcEndpoint,
} from '../src/daemon/env-rpc-server.js';

/** polling wait for can observe condition into establish (alternative fixed sleep), timeout explicit failed. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out:${what}` });

/** start Unix Socket row server (herdr shape simulated). */
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

/** wait for Unix socket can connect (listen is async). */
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
// 1. envFlushFile(protocol fb6ffbdb patch complete must must original language): real file / missing / dispose after
// ---------------------------------------------------------------------------

test('envFlushFile: real file ok, missing not_found,dispose after aborted', { timeout: 60_000 }, async () => {
  const dir = await tempDir('flush-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    await fs.writeFile(path.join(dir, 'f.txt'), 'data');
    const ok = await server.envFlushFile({ path: 'f.txt' });
    assert.equal(ok.ok, true);

    // flush directory:is_directory(SDK POSIX semantics,Windows same explicit check)
    await fs.mkdir(path.join(dir, 'd'));
    const isDir = await server.envFlushFile({ path: 'd' });
    assert.equal(isDir.ok, false);
    assert.equal(!isDir.ok && isDir.error.code, 'is_directory');

    // missing:not_found, does not pretend to be succeeded
    const missing = await server.envFlushFile({ path: 'no-such' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');
  } finally {
    await server.dispose();
  }

  // dispose after: boundary wrap return structure aborted message seal (do not throw bare exception)
  const after = await server.envFlushFile({ path: 'f.txt' });
  assert.equal(after.ok, false);
  assert.equal(!after.ok && after.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dispose terminal state: file RPC return structure aborted, do not rebuild env/reader', { timeout: 60_000 }, async () => {
  const dir = await tempDir('dispose-final-');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  const opened = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(opened.ok, true);
  await server.dispose();
  assert.equal(server.getOpenReaderCount(), 0);

  // fix before defect:dispose after envReadTextFile will rebuild env and succeeded execute (or bare throw)
  const read = await server.envReadTextFile({ path: 'a.txt' });
  assert.equal(read.ok, false, 'dispose after file RPC must reject');
  assert.equal(!read.ok && read.error.code, 'aborted');
  const reader = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(reader.ok, false);
  assert.equal(!reader.ok && reader.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('boundary wrap:null input and unknown reader return structure error (do not bare throw)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    // null input: fix before solve construct {path} directly TypeError bare throw to birpc layer
    const nullRead = await (server.envReadTextFile as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(
      null,
    );
    assert.equal(nullRead.ok, false);
    assert.ok(nullRead.error !== undefined);

    // unknown readerId: structure not_found
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. envExec host HELM_TOKEN isolated (do not delete global process.env, real child process verify)
// ---------------------------------------------------------------------------

test('envExec host HELM_TOKEN without leaking enter child process;input.env managed inject available', { timeout: 60_000 }, async (t) => {
  // simulated node host hold has token: change write test process process.env(t.after restore).
  // SDK NodeExecutionEnv.getShellEnv by default inherit process.env - - verify merge result
  // must in host indeed carries HELM_TOKEN run before mention under into establish, do not rely delete global variable mask.
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

  // 1) by default (inheritEnv default): host token must not appear, basis environment inherit
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
  assert.equal(dump1.token, null, 'host HELM_TOKEN must not leak leak (SDK inheritEnv:true by default will merge process.env)');
  assert.equal(dump1.hub, 'http://hub:3202');
  assert.equal(dump1.data, dir);
  assert.equal(dump1.hasPath, true, 'basis PATH inherit');
  assert.equal(dump1.hasHome, true, 'basis HOME inherit');

  // 2) input.env explicit HELM_TOKEN(Hub managed inject): must available
  await server.envExec({
    execId: 't2',
    command: 'node -e \'require("fs").writeFileSync("env-dump2.json", JSON.stringify({token:process.env.HELM_TOKEN??null}))\'',
    env: { HELM_TOKEN: 'managed-token-xyz' },
    timeout: 30,
  });
  const dump2 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump2.json'), 'utf8')) as { token: string | null };
  assert.equal(dump2.token, 'managed-token-xyz');

  // 3) inheritEnv:false: only use shellEnv + input.env, do not carries host base bottom
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
  assert.equal(dump3.hasPath, false, 'inheritEnv:false do not carries host PATH');
  assert.equal(dump3.hub, 'http://hub:3202', 'shellEnv still inject');
  assert.equal(dump3.custom, 'yes', 'input.env inject');
});

// ---------------------------------------------------------------------------
// 3. output chunked:UTF-16 proxy for (emoji) must not in chunk boundary split; cap 1 do not infinite loop
// ---------------------------------------------------------------------------

test('onExecOutput chunked do not split proxy for: boundary correct emoji high/low proxy between', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('surrogate-');
  const chunks: string[] = [];
  // choose a small cap make chunked real occur; odd count cap + emoji(2 code meta)+ single code meta character
  // mix arrange must however collide on cut point in high proxy after scenario, by safeChunkEnd fall back one code meta.
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

  const emoji = '😀'; // U+1F600: high proxy + low proxy
  const payload = `AB${emoji}CD${emoji}E${emoji}FG${emoji}H`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 's1', command: 'node script.js', timeout: 30 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);

  // concatenate must without loss (split will produce U+FFFD)
  assert.equal(chunks.join(''), payload, 'across chunk concatenate must restore original text');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(!chunk.includes('\uFFFD'), `chunk ${i} contains alternative character:${JSON.stringify(chunk)}`);
    assert.ok(chunk.length <= CHUNK, `chunk ${i} over cap`);
  }
  assert.ok(chunks.length > 1, `should produce many chunk (actual ${chunks.length} chunk)`);
  // at least one chunk with high proxy tail by fall back verify based on: store in length is CHUNK-1 chunk
  const hasBackoff = chunks.some((c) => c.length === CHUNK - 1);
  assert.ok(hasBackoff, 'store in because proxy for fall back one code meta chunk (cut point real in high/low proxy between)');
});

test('maxOutputChunkChars=1 encounter emoji do not infinite loop: each round before enter and final scoped', { timeout: 60_000 }, async (t) => {
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

  // fix before defect:safeChunkEnd(text, offset=0, limit=1) in emoji open head when
  // fall back to 0 → end === offset → unbounded loop,envExec forever do not return (test timeout).
  const emoji = '🚀';
  const payload = `A${emoji}B${emoji}`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 'c1', command: 'node script.js', timeout: 20 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(server.getActiveExecCount(), 0);
  // cap is1when, complete proxy for allows occupy2code meta; each chunked separateUTF-8encode also must without loss.
  assert.equal(chunks.map((chunk) => Buffer.from(chunk).toString()).join(''), payload)
  assert.equal(chunks.join(''), payload, 'chunked concatenate must restore original text');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.length >= 1 && chunk.length <= 2, `chunk ${i} should be complete code point`);
  }
});

// ---------------------------------------------------------------------------
// 4. onExecOutput call back exception: immediately cancel process and return callback_error(do not empty run to timeout)
// ---------------------------------------------------------------------------

test('onExecOutput call back throw exception: immediately kill tree return callback_error, do not etc. slow command timeout', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cb-err-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // first time call back i.e. throw:echo many row output usually merge in the same data chunk in reach,
    //  N time semantics cannot rely; first time must throw only then can determinism trigger.
    onExecOutput: () => {
      throw new Error('sink exploded');
    },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // fix before double heavy defect:1) call back exception by static default swallow, process empty run to sleep/timeout;
  // 2) SDK inshell string command + call back stack inside cancel when promise forever do not settle,
  // envExec hang die - -race si bottom force compute callback_error.
  const start = Date.now();
  const r = await server.envExec({
    execId: 'c2',
    command: 'echo line1 && echo line2 && sleep 55',
    timeout: 60,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, 'call back failed must not disguise succeeded');
  assert.equal(!r.ok && r.error.code, 'callback_error');
  assert.match(!r.ok ? r.error.message : '', /sink exploded/);
  assert.ok(elapsed < 10_000, `call back failed should immediately kill tree (actual ${elapsed}ms, must not etc. full sleep/timeout)`);
  assert.equal(server.getActiveExecCount(), 0, 'process by cancel, without in-flight item leftover');
  // orphan child process verify: brocade set ^sleep 55$ precise match (non- brocade set -f will match to detect command
  // itself command line, produce mistakenly report). to kill group one point wide limit time.
  await delay(300);
  const leftover = await new Promise<number>((resolve) => {
    execCb('pgrep -f "^sleep 55$" | grep -cv pgrep || true', (error, stdout) => {
      resolve(error ? -1 : Number.parseInt((stdout || '0').trim(), 10));
    });
  });
  assert.equal(leftover, 0, 'kill tree after must not orphan child sleep process');
});

// ---------------------------------------------------------------------------
// 5. base64 boundary validate:Node loosely parse must not static default swallow illegal character
// ---------------------------------------------------------------------------

test('envWriteFile base64 strictly validate: illegal character parent table explicit invalid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Node Buffer.from(x,'base64') will static default ignore '!' etc. character - - fix after must reject
  const bad = await server.envWriteFile({ path: 'x.bin', content: 'QQ!Q', encoding: 'base64' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'x.bin')).then(() => true, () => false), false, 'must not write out error data');

  // contains whitespace base64 same reject (loosely parse will skip whitespace)
  const space = await server.envWriteFile({ path: 'y.bin', content: 'QQ Q', encoding: 'base64' });
  assert.equal(space.ok, false);
  assert.equal(!space.ok && space.error.code, 'invalid');

  // legal base64 normal work
  const good = await server.envWriteFile({ path: 'z.bin', content: Buffer.from('ok').toString('base64'), encoding: 'base64' });
  assert.equal(good.ok, true);
  assert.equal(await fs.readFile(path.join(dir, 'z.bin'), 'utf8'), 'ok');

  // empty content legal
  const empty = await server.envWriteFile({ path: 'e.bin', content: '', encoding: 'base64' });
  assert.equal(empty.ok, true);
});

// ---------------------------------------------------------------------------
// 6. envExec duplicate execId: explicit reject (override will lose old cancel handle);
//    and by reject invoke must not from dispose arrange empty concentrate squeeze real in-flight command
// ---------------------------------------------------------------------------

test('envExec duplicate execId in-flight when explicit reject', { timeout: 60_000 }, async (t) => {
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

test('dispose arrange empty by invoke append trace: same execId by refuse invoke do not squeeze real in-flight command', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-set-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // fix before defect:execWaiters is Map<execId, Promise>, same execId second time
  // (by refuse) invoke will override first time promise, and first settle when item delete - -
  // dispose wait for collection in then no real sleep command. change Set<Promise> after each
  // invoke independent append trace.
  const slow = server.envExec({ execId: 'd', command: 'sleep 3', timeout: 60 });
  await delay(200);
  const dup = await server.envExec({ execId: 'd', command: 'echo x', timeout: 60 });
  assert.equal(dup.ok, false, 'duplicate execId should by refuse');

  await server.dispose();
  assert.equal(server.getActiveExecCount(), 0, 'dispose etc. to real in-flight command settle');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

// ---------------------------------------------------------------------------
// 7. IPC inject boundary: many row/CR/NUL payload reject; illegal callId/timeout reject
// ---------------------------------------------------------------------------

test('ipcCall payload single row validate: newline inject reject (do not split into many frame request)', { timeout: 60_000 }, async (t) => {
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

  // fix before defect:line middle newline will inject second request frame
  const injected = await server.ipcCall!({
    endpoint: srv.path,
    line: '{"id":"1","method":"a"}\n{"id":"2","method":"evil"}',
    timeoutMs: 2_000,
  });
  assert.equal(injected.ok, false);
  assert.equal(!injected.ok && injected.error.code, 'invalid');
  assert.match(!injected.ok ? injected.error.message : '', /single line/i);

  // CR same reject
  const cr = await server.ipcCall!({ endpoint: srv.path, line: 'a\rb', timeoutMs: 2_000 });
  assert.equal(cr.ok, false);
  assert.equal(!cr.ok && cr.error.code, 'invalid');

  // NUL reject
  const nul = await server.ipcCall!({ endpoint: srv.path, line: 'a\u0000b', timeoutMs: 2_000 });
  assert.equal(nul.ok, false);
  assert.equal(!nul.ok && nul.error.code, 'invalid');

  // non-empty validate
  const emptyLine = await server.ipcCall!({ endpoint: srv.path, line: '', timeoutMs: 2_000 });
  assert.equal(emptyLine.ok, false);
  assert.equal(!emptyLine.ok && emptyLine.error.code, 'invalid');

  // illegal callId
  const badId = await server.ipcCall!({ callId: 'x'.repeat(129), endpoint: srv.path, line: 'ok', timeoutMs: 2_000 });
  assert.equal(badId.ok, false);
  assert.equal(!badId.ok && badId.error.code, 'invalid');

  // illegal timeoutMs(negative number/NaN)
  const negTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: -5 });
  assert.equal(negTimeout.ok, false);
  assert.equal(!negTimeout.ok && negTimeout.error.code, 'invalid');
  const nanTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: Number.NaN });
  assert.equal(nanTimeout.ok, false);
  assert.equal(!nanTimeout.ok && nanTimeout.error.code, 'invalid');

  // legal single row normal to return
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

test('ipcSubscribe ACK structure decide: sub- string match data frame no longer by mistakenly judge is ACK', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ack-strict-');
  const events: string[] = [];
  // fix before defect:line.includes('"subscription_started"') will contains the sub- string
  // data frame mistakenly judge is ACK. this server first push a event in embed has ACK sub- string data row,
  // again push truly ACK - - strictly decide under data frame cannot by eat.
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

  // first response row is embed ACK sub- string data frame: protocol want seek first row must be ACK- - by
  // unexpected explicit reject (do not mistakenly judge succeeded, also not silently swallow frame).
  const ack = await server.ipcSubscribe!({ subscribeId: 's1', endpoint: srv.path, line: 'req' });
  assert.equal(ack.ok, false, 'embed ACK sub- string data frame as first row must by reject');
  assert.match(!ack.ok ? ack.error.message : '', /unexpected/);
  assert.equal(events.length, 0, 'mistakenly judge ACK must not swallow data frame when ACK');

  // compare: truly ACK first row per common succeeded
  const goodSrv = startLineServer(dir, 'good', (line, socket) => {
    socket.write(`${JSON.stringify({ id: line, result: { type: 'subscription_started' } })}\n`);
    socket.write(`${JSON.stringify({ event: 'real' })}\n`);
  });
  try {
    await waitListening(goodSrv.path);
    const good = await server.ipcSubscribe!({ subscribeId: 's1b', endpoint: goodSrv.path, line: 'req' });
    assert.equal(good.ok, true, good.ok ? '' : good.error.message);
    await waitFor(() => events.some((l) => JSON.parse(l).event === 'real'), 5_000, 'true ACK after event forwarding');
    assert.ok(events.some((l) => JSON.parse(l).event === 'real'), 'true ACK after event normal forwarding');
  } finally {
    await goodSrv.close();
  }
});

test('ipcSubscribe event frame NUL reject and away onIpcClosed', { timeout: 60_000 }, async (t) => {
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
  await waitFor(() => server.getActiveIpcSubscriptionCount() === 0, 5_000, 'broken frame after subscribe close');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0, 'broken frame after subscribe should close');
  const closedEvent = closed.find((c) => c.id === 's2');
  assert.ok(closedEvent !== undefined, 'onIpcClosed should notify');
  assert.match(closedEvent?.error ?? '', /NUL/);
});

// ---------------------------------------------------------------------------
// 8. ipcCall idle fall back: static default server (do not back package does not close) real timeout, inject short value verify
// ---------------------------------------------------------------------------

test('ipcCall without timeoutMs static default server: idle fall back real timeout (inject 300ms)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle-');
  const srv = startLineServer(dir, 'silent', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  // inject short idle fall back: verify without timeoutMs also must however timeout return real path,
  // while non- only rely type assertion sound call fall back store in.
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 300 });
  t.after(async () => {
    await server.dispose();
  });

  const start = Date.now();
  const r = await server.ipcCall!({ endpoint: srv.path, line: 'req' }); // without timeoutMs
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.match(!r.ok ? r.error.message : '', /300ms/);
  assert.ok(elapsed >= 250 && elapsed < 5_000, `fall back should about 300ms takes effect (actual ${elapsed}ms)`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcCall timeoutMs:0 same away idle fall back and register in-flight socket', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle2-');
  const srv = startLineServer(dir, 'silent2', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 200 });
  t.after(async () => {
    await server.dispose();
  });

  // timeoutMs:0 fix before do not set any count when (condition timeoutMs > 0 only then set)→ forever long suspended;
  // fix after 0/default away the same idle fall back.
  const pending = server.ipcCall!({ callId: 'c0', endpoint: srv.path, line: 'req', timeoutMs: 0 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1, 'timeoutMs:0 also should register in-flight socket');
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0);

  // ipcAbortCall for suspended invoke immediately takes effect
  const pending2 = server.ipcCall!({ callId: 'c1', endpoint: srv.path, line: 'req', timeoutMs: 60_000 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1);
  await server.ipcAbortCall!('c1');
  const r2 = await pending2;
  assert.equal(r2.ok, false);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

// ---------------------------------------------------------------------------
// 9. end point parse (pure function + platform inject):session blank name single / Windows pipe prefix
// ---------------------------------------------------------------------------

test('resolveHerdrIpcEndpoint session validate and herdr validate_name same to', { timeout: 60_000 }, () => {
  // herdr allows: character parent number . _ -(first token symbol unbounded system,≤64 byte, non- ./..)
  // fix before defect: blank name single missing `.` and want seek character parent open head - - 'a.b-c_d' will by refuse.
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

  // reject: path through exceeds, empty, over long, illegal character,./..
  for (const bad of ['../evil', 'a/b', 'a b', '.', '..', 'x'.repeat(65), 'a#b']) {
    assert.throws(
      () => resolveHerdrIpcEndpoint({ session: bad }, { platform: 'linux', homeDir: '/home/u', getEnv: () => undefined }),
      { message: /session/i },
      `session ${JSON.stringify(bad)} should reject`,
    );
  }
});

test('resolveHerdrIpcEndpoint win32:\\.\pipe\ + config directory path string (smoke number/slash original)', { timeout: 60_000 }, () => {
  const noEnv = () => undefined;

  // based on interprocess 2.4.2 map_generic_namespaced_osstr + pathcvt:
  // pipe name = '\\.\pipe\' + herdr config directory path string, smoke number and backslash all original keep.
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

  // XDG_CONFIG_HOME takes precedence at APPDATA(herdr config_dir same order)
  const xdg = resolveHerdrIpcEndpoint(
    {},
    {
      platform: 'win32',
      getEnv: (n) =>
        n === 'XDG_CONFIG_HOME' ? 'D:\\xdg' : n === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : undefined,
    },
  );
  assert.equal(xdg, '\\\\.\\pipe\\D:\\xdg\\herdr\\herdr.sock');

  // APPDATA missing → USERPROFILE\AppData\Roaming(herdr platform_config_dir same to)
  const userProfile = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'USERPROFILE' ? 'C:\\Users\\dev' : undefined) },
  );
  assert.equal(userProfile, '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock');

  // again retreat HOME/.config > temp
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

  // HERDR_SOCKET_PATH override by default push lead (original return, do not add prefix)
  const envOverride = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'HERDR_SOCKET_PATH' ? 'E:\\custom.sock' : undefined) },
  );
  assert.equal(envOverride, 'E:\\custom.sock');

  // explicit complete pipe endpoint original return
  const explicit = resolveHerdrIpcEndpoint(
    { endpoint: '\\\\.\\pipe\\my-custom' },
    { platform: 'win32', getEnv: noEnv },
  );
  assert.equal(explicit, '\\\\.\\pipe\\my-custom');

  // unix platform do not subject to Windows prefix affect (the same inject function cross verify)
  const unix = resolveHerdrIpcEndpoint(
    {},
    { platform: 'linux', homeDir: '/home/u', getEnv: noEnv },
  );
  assert.equal(unix, '/home/u/.config/herdr/herdr.sock');
  assert.ok(!unix.includes('pipe'));
});

// ---------------------------------------------------------------------------
// 10. dispose arrange empty: in-flight exec/ipcCall/subscribe in dispose return before all consolidate
// ---------------------------------------------------------------------------

test('dispose wait for in-flight exec settle: return after without in-flight item', { timeout: 60_000 }, async (t) => {
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
  // fix before defect:dispose without waiting in-flight promise,running item by finally async delete,
  // this where may still is 1.
  assert.equal(server.getActiveExecCount(), 0, 'dispose return when in-flight exec must already settle and clean up');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

test('dispose destroy in-flight ipcCall socket: wait for promise immediately failed', { timeout: 60_000 }, async (t) => {
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
  assert.equal(r.ok, false, 'dispose after in-flight ipcCall must not pending');
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('dispose destroy leap subscribe and stop event', { timeout: 60_000 }, async (t) => {
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
  await waitFor(() => events.length > 0, 5_000, 'dispose before event reach');
  const before = events.length;
  assert.ok(before > 0, 'dispose before should has event');
  await server.dispose();
  await delay(200);
  assert.equal(events.length, before, 'dispose after no longer receives event');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
});

// ---------------------------------------------------------------------------
// 11. upgrade arrange empty accept IPC:draining refuse new call/subscribe, in-flight call count arrange empty opening path
// ---------------------------------------------------------------------------

test('upgrade arrange empty accept IPC:draining refuse new call/subscribe, in-flight call do not strong kill and count arrange empty counter', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-ipc-');
  // suspended server: receives request do not back (simulated herdr:agy --wait long wait for)
  const hold = startLineServer(dir, 'hold', () => undefined);
  // back sound server: verify solve except draining after restore subject to
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

  // in-flight once call(without callId) also count arrange empty opening path: upgrade transaction based on this wait for its converge
  const pending = server.ipcCall!({ endpoint: hold.path, line: 'wait-req', timeoutMs: 250 });
  await waitFor(() => server.getActiveIpcCallCount() === 1, 2_000, 'in-flight IPC call should count arrange empty counter');

  server.setDraining(true);
  const rejectedCall = await server.ipcCall!({ endpoint: echo.path, line: 'new-call', timeoutMs: 1_000 });
  assert.equal(rejectedCall.ok, false);
  assert.equal(!rejectedCall.ok && rejectedCall.error.code, 'node_draining');
  assert.match(!rejectedCall.ok ? rejectedCall.error.message : '', /draining/);

  const rejectedSub = await server.ipcSubscribe!({ subscribeId: 's-drain', endpoint: echo.path, line: 'new-sub' });
  assert.equal(rejectedSub.ok, false);
  assert.equal(!rejectedSub.ok && rejectedSub.error.code, 'node_draining');
  assert.match(!rejectedSub.ok ? rejectedSub.error.message : '', /draining/);

  // draining do not strong kill in-flight: timeout self however compute after counter reset to zero
  const settled = await pending;
  assert.equal(settled.ok, false);
  assert.equal(!settled.ok && settled.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0, 'arrange empty counter should follow in-flight call compute reset to zero');

  // restore subject to (failed to upgrade rollback path)
  server.setDraining(false);
  const okAgain = await server.ipcCall!({ endpoint: echo.path, line: 'after', timeoutMs: 2_000 });
  assert.equal(okAgain.ok, true);
});

test('envCleanup:draining/disposed explicit reject (by cwd kill same cwd all conversation command sharp semantics)', { timeout: 60_000 }, async (t) => {
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
  await server.envCleanup!(dir); // happy path do not throw

  await server.dispose();
  await assert.rejects(() => server.envCleanup!(dir), /disposed/);
});

// ---------------------------------------------------------------------------
// 12. LineAssembler limit long closed together: carries newline complete over long row no longer bypass single frame cap
// ---------------------------------------------------------------------------

test('ipcCall single frame cap: carries newline complete over long row same reject (no longer whole row enter memory back pass)', { timeout: 60_000 }, async (t) => {
  assert.equal(MAX_IPC_FRAME_BYTES, 32 * 1024 * 1024, 'by default single frame cap must is 32 MiB');
  const dir = await tempDir('ipc-frame-limit-');
  const frameLimitBytes = 64 * 1024;
  // back one row over limit content + '\n': fix before complete row never check length, directly via (inject threshold avoid test 32 MiB allocate overhead)
  const srv = startLineServer(dir, 'bigline', (_line, socket) => {
    socket.write(Buffer.concat([Buffer.alloc(frameLimitBytes + 1, 0x61), Buffer.from('\n')]));
  });
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir, maxIpcFrameBytes: frameLimitBytes });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const result = await server.ipcCall!({ endpoint: srv.path, line: 'q', timeoutMs: 30_000 });
  assert.equal(result.ok, false, 'over limit complete row must by reject');
  assert.match(!result.ok ? result.error.message : '', /exceeds/);
});

// ---------------------------------------------------------------------------
// 13. birpc events adapt:on/off wrap reference match for ($close after listener complete excerpt except)
// ---------------------------------------------------------------------------

test('birpc events adapt:off excerpt except wrap listen, many route on each independent excerpt except', { timeout: 60_000 }, async () => {
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

  // illegal JSON / non- object frame away onInvalidFrame, does not enter call back
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
  assert.equal(socket.listenerCount('message'), 1, 'off must excerpt except actual register wrap listen');
  socket.emit('message', Buffer.from(JSON.stringify({ b: 2 })));
  assert.deepEqual(receivedA, [{ a: 1 }], 'already excerpt except call back no longer frame');
  assert.deepEqual(receivedB, [{ b: 2 }]);

  events.off(callbackB);
  assert.equal(socket.listenerCount('message'), 0, 'all excerpt except after without message leftover ($close semantics)');
  // unknown call back off idempotent without harm
  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 0);
});
