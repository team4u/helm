/**
 * Independent review regression tests for `env-rpc-server`: reproduces real edge defects
 * cleanly without duplicating main unit tests (each test documents the specific bug covered).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { exec as execCb } from 'node:child_process';
import { sleep as delay } from '@helmx/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helmx/test-kit/node';
import {
  createNodeEnvRpcServer,
  MAX_IPC_FRAME_BYTES,
  resolveHerdrIpcEndpoint,
} from '../src/daemon/env-rpc-server.js';

/** Poll until observable condition holds (instead of fixed sleeps), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out: ${what}` });

/** Start a Unix socket JSON-line server (herdr-style test double). */
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

/** Wait until the Unix socket accepts connections (`listen` is asynchronous). */
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
// 1. envFlushFile (required protocol primitive): real file / missing / post-dispose
// ---------------------------------------------------------------------------

test('envFlushFile returns ok for real file, not_found when missing, and aborted after dispose', { timeout: 60_000 }, async () => {
  const dir = await tempDir('flush-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    await fs.writeFile(path.join(dir, 'f.txt'), 'data');
    const ok = await server.envFlushFile({ path: 'f.txt' });
    assert.equal(ok.ok, true);

    // Flushing a directory returns is_directory (checked on Windows too under SDK POSIX semantics)
    await fs.mkdir(path.join(dir, 'd'));
    const isDir = await server.envFlushFile({ path: 'd' });
    assert.equal(isDir.ok, false);
    assert.equal(!isDir.ok && isDir.error.code, 'is_directory');

    // Missing path returns not_found instead of pretending success
    const missing = await server.envFlushFile({ path: 'no-such' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');
  } finally {
    await server.dispose();
  }

  // Post-dispose wrapper returns structured aborted error envelope without throwing raw errors
  const after = await server.envFlushFile({ path: 'f.txt' });
  assert.equal(after.ok, false);
  assert.equal(!after.ok && after.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dispose is terminal: file RPCs return structured aborted without recreating env or readers', { timeout: 60_000 }, async () => {
  const dir = await tempDir('dispose-final-');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  const opened = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(opened.ok, true);
  await server.dispose();
  assert.equal(server.getOpenReaderCount(), 0);

  // Pre-fix bug: envReadTextFile after dispose recreated env and ran (or threw raw error)
  const read = await server.envReadTextFile({ path: 'a.txt' });
  assert.equal(read.ok, false, 'file RPCs after dispose must reject');
  assert.equal(!read.ok && read.error.code, 'aborted');
  const reader = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(reader.ok, false);
  assert.equal(!reader.ok && reader.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('boundary wrapper turns null inputs and unknown readers into structured errors without throwing', { timeout: 60_000 }, async () => {
  const dir = await tempDir('guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    // Null input previously threw an uncaught TypeError destructuring `{ path }` straight into birpc
    const nullRead = await (server.envReadTextFile as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(
      null,
    );
    assert.equal(nullRead.ok, false);
    assert.ok(nullRead.error !== undefined);

    // Unknown readerId returns structured not_found
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. envExec strips host HELMX_TOKEN without mutating global process.env (verified via real subprocess)
// ---------------------------------------------------------------------------

test('envExec never leaks host HELMX_TOKEN into children while honoring managed input.env injections', { timeout: 60_000 }, async (t) => {
  // Simulate a daemon host carrying HELMX_TOKEN by swapping process.env (restored via t.after).
  // Upstream NodeExecutionEnv inherits process.env by default, so this proves stripping works
  // genuinely when HELMX_TOKEN is present rather than passing only by deleting global env vars.
  const base = process.env;
  process.env = { ...base, HELMX_TOKEN: 'host-secret-token-do-not-leak' } as NodeJS.ProcessEnv;
  t.after(() => {
    process.env = base;
  });

  const dir = await tempDir('token-iso-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    shellEnv: { HELMX_HUB_URL: 'http://hub:3202', HELMX_DATA_DIR: dir },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 1) Default (inheritEnv omitted): host token must be stripped while base env inherits
  await server.envExec({
    execId: 't1-dump',
    command:
      'node -e \'require("fs").writeFileSync("env-dump.json", JSON.stringify({token:process.env.HELMX_TOKEN??null,hub:process.env.HELMX_HUB_URL??null,hasPath:!!process.env.PATH,hasHome:!!process.env.HOME,data:process.env.HELMX_DATA_DIR??null}))\'',
    timeout: 30,
  });
  const dump1 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump.json'), 'utf8')) as {
    token: string | null;
    hub: string | null;
    hasPath: boolean;
    hasHome: boolean;
    data: string | null;
  };
  assert.equal(dump1.token, null, 'host HELMX_TOKEN must not leak (SDK inheritEnv:true merges process.env by default)');
  assert.equal(dump1.hub, 'http://hub:3202');
  assert.equal(dump1.data, dir);
  assert.equal(dump1.hasPath, true, 'base PATH inherited');
  assert.equal(dump1.hasHome, true, 'base HOME inherited');

  // 2) Explicit input.env HELMX_TOKEN (Hub-managed per-call injection): must pass through
  await server.envExec({
    execId: 't2',
    command: 'node -e \'require("fs").writeFileSync("env-dump2.json", JSON.stringify({token:process.env.HELMX_TOKEN??null}))\'',
    env: { HELMX_TOKEN: 'managed-token-xyz' },
    timeout: 30,
  });
  const dump2 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump2.json'), 'utf8')) as { token: string | null };
  assert.equal(dump2.token, 'managed-token-xyz');

  // 3) inheritEnv:false: passes only shellEnv + input.env without host baseline
  await server.envExec({
    execId: 't3',
    command: 'node -e \'require("fs").writeFileSync("env-dump3.json", JSON.stringify({hasPath:!!process.env.PATH,hub:process.env.HELMX_HUB_URL??null,custom:process.env.MY_VAR??null}))\'',
    env: { MY_VAR: 'yes' },
    inheritEnv: false,
    timeout: 30,
  });
  const dump3 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump3.json'), 'utf8')) as {
    hasPath: boolean;
    hub: string | null;
    custom: string | null;
  };
  assert.equal(dump3.hasPath, false, 'inheritEnv:false omits host PATH');
  assert.equal(dump3.hub, 'http://hub:3202', 'shellEnv still injected');
  assert.equal(dump3.custom, 'yes', 'input.env injected');
});

// ---------------------------------------------------------------------------
// 3. Output chunking: UTF-16 surrogate pairs (emoji) never split across chunks; cap=1 avoids infinite loop
// ---------------------------------------------------------------------------

test('onExecOutput chunking preserves surrogate pairs across chunk boundaries', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('surrogate-');
  const chunks: string[] = [];
  // Odd small chunk cap + emoji (2 code units) + ASCII forces cuts right between high/low surrogates
  // so safeChunkEnd backs off by one code unit.
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

  const emoji = '😀'; // U+1F600: high surrogate + low surrogate
  const payload = `AB${emoji}CD${emoji}E${emoji}FG${emoji}H`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 's1', command: 'node script.js', timeout: 30 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);

  // Concatenation must be lossless (splitting surrogates produces U+FFFD)
  assert.equal(chunks.join(''), payload, 'rejoined chunks must match original string');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(!chunk.includes('\uFFFD'), `chunk ${i} contains replacement character: ${JSON.stringify(chunk)}`);
    assert.ok(chunk.length <= CHUNK, `chunk ${i} exceeds cap`);
  }
  assert.ok(chunks.length > 1, `should split into multiple chunks (got ${chunks.length})`);
  // Evidence of backing off at a high surrogate: at least one chunk has length CHUNK - 1
  const hasBackoff = chunks.some((c) => c.length === CHUNK - 1);
  assert.ok(hasBackoff, 'at least one chunk backed off by one code unit at surrogate boundary');
});

test('maxOutputChunkChars=1 with emoji advances every step and finishes without infinite loop', { timeout: 60_000 }, async (t) => {
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

  // Pre-fix bug: safeChunkEnd(text, offset=0, limit=1) backed off to 0 at leading emoji -> end===offset infinite loop.
  const emoji = '🚀';
  const payload = `A${emoji}B${emoji}`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 'c1', command: 'node script.js', timeout: 20 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(server.getActiveExecCount(), 0);
  // With cap=1, an intact surrogate pair is allowed to occupy 2 code units; each chunk is valid UTF-8.
  assert.equal(chunks.map((chunk) => Buffer.from(chunk).toString()).join(''), payload)
  assert.equal(chunks.join(''), payload, 'rejoined chunks must match original string');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.length >= 1 && chunk.length <= 2, `chunk ${i} should be a complete code point`);
  }
});

// ---------------------------------------------------------------------------
// 4. onExecOutput callback error: cancels child immediately with callback_error
// ---------------------------------------------------------------------------

test('onExecOutput callback throwing kills process tree immediately with callback_error', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cb-err-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // Throw on the first callback because multi-line echo output often coalesces into one chunk.
    onExecOutput: () => {
      throw new Error('sink exploded');
    },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Pre-fix double bug: 1) swallowed callback exceptions let child run until timeout;
  // 2) cancelling inside callback left SDK promise unsettled — race fallback forces callback_error.
  const start = Date.now();
  const r = await server.envExec({
    execId: 'c2',
    command: 'echo line1 && echo line2 && sleep 55',
    timeout: 60,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, 'callback failure must not pretend to succeed');
  assert.equal(!r.ok && r.error.code, 'callback_error');
  assert.match(!r.ok ? r.error.message : '', /sink exploded/);
  assert.ok(elapsed < 10_000, `callback failure should kill process tree immediately (actual ${elapsed}ms)`);
  assert.equal(server.getActiveExecCount(), 0, 'cancelled process must leave no active entry');
  // Orphan guard: exact `^sleep 55$` match (without `-f` self-matching pgrep command lines) after kill grace.
  await delay(300);
  const leftover = await new Promise<number>((resolve) => {
    execCb('pgrep -f "^sleep 55$" | grep -cv pgrep || true', (error, stdout) => {
      resolve(error ? -1 : Number.parseInt((stdout || '0').trim(), 10));
    });
  });
  assert.equal(leftover, 0, 'no orphan sleep process should remain after killTree');
});

// ---------------------------------------------------------------------------
// 5. base64 boundary validation: reject invalid characters instead of permissive Node parsing
// ---------------------------------------------------------------------------

test('envWriteFile base64 strict validation rejects illegal characters explicitly as invalid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Node Buffer.from(x, 'base64') silently ignores '!' etc. — must reject explicitly
  const bad = await server.envWriteFile({ path: 'x.bin', content: 'QQ!Q', encoding: 'base64' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'x.bin')).then(() => true, () => false), false, 'must not write invalid payload');

  // Whitespace in base64 also rejected (permissive parsing skips spaces)
  const space = await server.envWriteFile({ path: 'y.bin', content: 'QQ Q', encoding: 'base64' });
  assert.equal(space.ok, false);
  assert.equal(!space.ok && space.error.code, 'invalid');

  // Valid base64 works normally
  const good = await server.envWriteFile({ path: 'z.bin', content: Buffer.from('ok').toString('base64'), encoding: 'base64' });
  assert.equal(good.ok, true);
  assert.equal(await fs.readFile(path.join(dir, 'z.bin'), 'utf8'), 'ok');

  // Empty content is valid
  const empty = await server.envWriteFile({ path: 'e.bin', content: '', encoding: 'base64' });
  assert.equal(empty.ok, true);
});

// ---------------------------------------------------------------------------
// 6. envExec duplicate execId: rejected explicitly (overwriting drops prior cancel handle)
//    and rejected duplicate calls must not evict live commands from dispose wait set
// ---------------------------------------------------------------------------

test('envExec explicitly rejects duplicate in-flight execId', { timeout: 60_000 }, async (t) => {
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

test('dispose tracks draining waiters per call so rejected duplicate execId never evicts live commands', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-set-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Pre-fix bug: Map<execId, Promise> let rejected second call overwrite first promise and remove it
  // from dispose wait set upon early settlement. Switching to Set<Promise> tracks each call independently.
  const slow = server.envExec({ execId: 'd', command: 'sleep 3', timeout: 60 });
  await delay(200);
  const dup = await server.envExec({ execId: 'd', command: 'echo x', timeout: 60 });
  assert.equal(dup.ok, false, 'duplicate execId should be rejected');

  await server.dispose();
  assert.equal(server.getActiveExecCount(), 0, 'dispose waited for genuine in-flight command to settle');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

// ---------------------------------------------------------------------------
// 7. IPC injection boundaries: multi-line/CR/NUL payloads, bad callId/timeout rejected
// ---------------------------------------------------------------------------

test('ipcCall enforces single-line payloads and rejects newline injection', { timeout: 60_000 }, async (t) => {
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

  // Pre-fix bug: embedded newline injected a second request frame
  const injected = await server.ipcCall!({
    endpoint: srv.path,
    line: '{"id":"1","method":"a"}\n{"id":"2","method":"evil"}',
    timeoutMs: 2_000,
  });
  assert.equal(injected.ok, false);
  assert.equal(!injected.ok && injected.error.code, 'invalid');
  assert.match(!injected.ok ? injected.error.message : '', /single line/i);

  // CR also rejected
  const cr = await server.ipcCall!({ endpoint: srv.path, line: 'a\rb', timeoutMs: 2_000 });
  assert.equal(cr.ok, false);
  assert.equal(!cr.ok && cr.error.code, 'invalid');

  // NUL rejected
  const nul = await server.ipcCall!({ endpoint: srv.path, line: 'a\u0000b', timeoutMs: 2_000 });
  assert.equal(nul.ok, false);
  assert.equal(!nul.ok && nul.error.code, 'invalid');

  // Non-empty validation
  const emptyLine = await server.ipcCall!({ endpoint: srv.path, line: '', timeoutMs: 2_000 });
  assert.equal(emptyLine.ok, false);
  assert.equal(!emptyLine.ok && emptyLine.error.code, 'invalid');

  // Invalid callId
  const badId = await server.ipcCall!({ callId: 'x'.repeat(129), endpoint: srv.path, line: 'ok', timeoutMs: 2_000 });
  assert.equal(badId.ok, false);
  assert.equal(!badId.ok && badId.error.code, 'invalid');

  // Invalid timeoutMs (negative/NaN)
  const negTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: -5 });
  assert.equal(negTimeout.ok, false);
  assert.equal(!negTimeout.ok && negTimeout.error.code, 'invalid');
  const nanTimeout = await server.ipcCall!({ endpoint: srv.path, line: 'ok', timeoutMs: Number.NaN });
  assert.equal(nanTimeout.ok, false);
  assert.equal(!nanTimeout.ok && nanTimeout.error.code, 'invalid');

  // Valid single-line round-trip succeeds
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

test('ipcSubscribe parses ACK structurally so substring matches in data frames are rejected as non-ACK', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('ack-strict-');
  const events: string[] = [];
  // Pre-fix bug: line.includes('"subscription_started"') mistook a data frame containing that substring
  // for an ACK. Server sends a data frame embedding the substring before the real ACK.
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

  // First response line is a data frame containing ACK substring: protocol requires first line to be ACK,
  // so reject explicitly as unexpected instead of falsely succeeding or swallowing a data frame.
  const ack = await server.ipcSubscribe!({ subscribeId: 's1', endpoint: srv.path, line: 'req' });
  assert.equal(ack.ok, false, 'data frame carrying ACK substring as first line must be rejected');
  assert.match(!ack.ok ? ack.error.message : '', /unexpected/);
  assert.equal(events.length, 0, 'must not swallow misparsed data frame as ACK');

  // Control: genuine ACK on first line works as expected
  const goodSrv = startLineServer(dir, 'good', (line, socket) => {
    socket.write(`${JSON.stringify({ id: line, result: { type: 'subscription_started' } })}\n`);
    socket.write(`${JSON.stringify({ event: 'real' })}\n`);
  });
  try {
    await waitListening(goodSrv.path);
    const good = await server.ipcSubscribe!({ subscribeId: 's1b', endpoint: goodSrv.path, line: 'req' });
    assert.equal(good.ok, true, good.ok ? '' : good.error.message);
    await waitFor(() => events.some((l) => JSON.parse(l).event === 'real'), 5_000, 'event forwarded after real ACK');
    assert.ok(events.some((l) => JSON.parse(l).event === 'real'), 'event should forward after genuine ACK');
  } finally {
    await goodSrv.close();
  }
});

test('ipcSubscribe rejects NUL bytes in event frames and invokes onIpcClosed', { timeout: 60_000 }, async (t) => {
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
  await waitFor(() => server.getActiveIpcSubscriptionCount() === 0, 5_000, 'subscription closes after invalid frame');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0, 'subscription should close after invalid frame');
  const closedEvent = closed.find((c) => c.id === 's2');
  assert.ok(closedEvent !== undefined, 'onIpcClosed should be notified');
  assert.match(closedEvent?.error ?? '', /NUL/);
});

// ---------------------------------------------------------------------------
// 8. ipcCall idle timeout fallback: silent server (no reply/close) times out via injected short value
// ---------------------------------------------------------------------------

test('ipcCall without timeoutMs uses idle timeout fallback (injected 300ms)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle-');
  const srv = startLineServer(dir, 'silent', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  // Inject a short idle timeout to exercise the real missing-timeoutMs path rather than only asserting types.
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 300 });
  t.after(async () => {
    await server.dispose();
  });

  const start = Date.now();
  const r = await server.ipcCall!({ endpoint: srv.path, line: 'req' }); // no timeoutMs
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.match(!r.ok ? r.error.message : '', /300ms/);
  assert.ok(elapsed >= 250 && elapsed < 5_000, `fallback should fire near 300ms (actual ${elapsed}ms)`);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('ipcCall timeoutMs:0 also uses idle fallback and tracks active socket', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('idle2-');
  const srv = startLineServer(dir, 'silent2', () => undefined);
  t.after(async () => {
    await srv.close();
  });
  const server = createNodeEnvRpcServer({ defaultCwd: dir, ipcCallIdleTimeoutMs: 200 });
  t.after(async () => {
    await server.dispose();
  });

  // Pre-fix bug: timeoutMs:0 skipped setting any timer (`timeoutMs > 0`) and hung forever;
  // now 0 and omitted share the same idle fallback.
  const pending = server.ipcCall!({ callId: 'c0', endpoint: srv.path, line: 'req', timeoutMs: 0 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1, 'timeoutMs:0 must also register active socket');
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0);

  // ipcAbortCall cancels pending call immediately
  const pending2 = server.ipcCall!({ callId: 'c1', endpoint: srv.path, line: 'req', timeoutMs: 60_000 });
  await delay(80);
  assert.equal(server.getActiveIpcCallCount(), 1);
  await server.ipcAbortCall!('c1');
  const r2 = await pending2;
  assert.equal(r2.ok, false);
  assert.equal(server.getActiveIpcCallCount(), 0);
});

// ---------------------------------------------------------------------------
// 9. Endpoint resolution (pure function + injected platform): session allowlist / Windows pipe prefix
// ---------------------------------------------------------------------------

test('resolveHerdrIpcEndpoint session validation matches herdr validate_name', { timeout: 60_000 }, () => {
  // herdr allows alphanumeric plus . _ - (any leading char, <=64 bytes, not ./..)
  // Pre-fix bug: allowlist omitted `.` and required a leading letter, rejecting `'a.b-c_d'`.
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

  // Reject path traversal, empty, overlong, invalid characters, and ./..
  for (const bad of ['../evil', 'a/b', 'a b', '.', '..', 'x'.repeat(65), 'a#b']) {
    assert.throws(
      () => resolveHerdrIpcEndpoint({ session: bad }, { platform: 'linux', homeDir: '/home/u', getEnv: () => undefined }),
      { message: /session/i },
      `session ${JSON.stringify(bad)} should reject`,
    );
  }
});

test('resolveHerdrIpcEndpoint win32 prepends \\\\.\\pipe\\ preserving colons and backslashes in config dir', { timeout: 60_000 }, () => {
  const noEnv = () => undefined;

  // Matches interprocess 2.4.2 map_generic_namespaced_osstr + pathcvt:
  // pipe name = '\\.\pipe\' + herdr config dir path string with colons and backslashes intact.
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

  // XDG_CONFIG_HOME precedes APPDATA (matching herdr config_dir)
  const xdg = resolveHerdrIpcEndpoint(
    {},
    {
      platform: 'win32',
      getEnv: (n) =>
        n === 'XDG_CONFIG_HOME' ? 'D:\\xdg' : n === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : undefined,
    },
  );
  assert.equal(xdg, '\\\\.\\pipe\\D:\\xdg\\herdr\\herdr.sock');

  // Missing APPDATA falls back to USERPROFILE\AppData\Roaming (matching herdr platform_config_dir)
  const userProfile = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'USERPROFILE' ? 'C:\\Users\\dev' : undefined) },
  );
  assert.equal(userProfile, '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock');

  // Then falls back to HOME/.config > temp
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

  // HERDR_SOCKET_PATH overrides default derivation verbatim without pipe prefix
  const envOverride = resolveHerdrIpcEndpoint(
    {},
    { platform: 'win32', getEnv: (n) => (n === 'HERDR_SOCKET_PATH' ? 'E:\\custom.sock' : undefined) },
  );
  assert.equal(envOverride, 'E:\\custom.sock');

  // Explicit full pipe endpoint returned verbatim
  const explicit = resolveHerdrIpcEndpoint(
    { endpoint: '\\\\.\\pipe\\my-custom' },
    { platform: 'win32', getEnv: noEnv },
  );
  assert.equal(explicit, '\\\\.\\pipe\\my-custom');

  // Unix platforms ignore Windows pipe prefix logic
  const unix = resolveHerdrIpcEndpoint(
    {},
    { platform: 'linux', homeDir: '/home/u', getEnv: noEnv },
  );
  assert.equal(unix, '/home/u/.config/herdr/herdr.sock');
  assert.ok(!unix.includes('pipe'));
});

// ---------------------------------------------------------------------------
// 10. dispose draining: all active exec/ipcCall/subscriptions settle before dispose returns
// ---------------------------------------------------------------------------

test('dispose waits for active exec calls to settle with zero active entries on return', { timeout: 60_000 }, async (t) => {
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
  // Pre-fix bug: dispose did not await in-flight promises so active count could still be 1.
  assert.equal(server.getActiveExecCount(), 0, 'in-flight exec must be settled and cleaned up before dispose returns');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

test('dispose destroys in-flight ipcCall sockets and rejects waiting promises immediately', { timeout: 60_000 }, async (t) => {
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
  assert.equal(r.ok, false, 'in-flight ipcCall must not hang after dispose');
  assert.equal(server.getActiveIpcCallCount(), 0);
});

test('dispose destroys active subscriptions and stops event delivery', { timeout: 60_000 }, async (t) => {
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
  await waitFor(() => events.length > 0, 5_000, 'events arrive before dispose');
  const before = events.length;
  assert.ok(before > 0, 'should receive events before dispose');
  await server.dispose();
  await delay(200);
  assert.equal(events.length, before, 'no more events delivered after dispose');
  assert.equal(server.getActiveIpcSubscriptionCount(), 0);
});

// ---------------------------------------------------------------------------
// 11. Upgrade draining includes IPC: draining rejects new calls/subscriptions while active calls drain cleanly
// ---------------------------------------------------------------------------

test('upgrade draining covers IPC: rejects new call/subscribe while draining active calls', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-ipc-');
  // Silent holding server simulates long-waiting `herdr:agy --wait`
  const hold = startLineServer(dir, 'hold', () => undefined);
  // Echo server verifies acceptance resumes once draining is lifted
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

  // One-shot in-flight calls without callId still count toward draining during upgrades.
  const pending = server.ipcCall!({ endpoint: hold.path, line: 'wait-req', timeoutMs: 250 });
  await waitFor(() => server.getActiveIpcCallCount() === 1, 2_000, 'in-flight IPC call counts toward draining');

  server.setDraining(true);
  const rejectedCall = await server.ipcCall!({ endpoint: echo.path, line: 'new-call', timeoutMs: 1_000 });
  assert.equal(rejectedCall.ok, false);
  assert.equal(!rejectedCall.ok && rejectedCall.error.code, 'node_draining');
  assert.match(!rejectedCall.ok ? rejectedCall.error.message : '', /draining/);

  const rejectedSub = await server.ipcSubscribe!({ subscribeId: 's-drain', endpoint: echo.path, line: 'new-sub' });
  assert.equal(rejectedSub.ok, false);
  assert.equal(!rejectedSub.ok && rejectedSub.error.code, 'node_draining');
  assert.match(!rejectedSub.ok ? rejectedSub.error.message : '', /draining/);

  // Draining does not force-kill active calls: natural timeout zeroes the counter
  const settled = await pending;
  assert.equal(settled.ok, false);
  assert.equal(!settled.ok && settled.error.code, 'timeout');
  assert.equal(server.getActiveIpcCallCount(), 0, 'drain counter resets to zero when active call settles');

  // Re-accepts after rollback clears draining
  server.setDraining(false);
  const okAgain = await server.ipcCall!({ endpoint: echo.path, line: 'after', timeoutMs: 2_000 });
  assert.equal(okAgain.ok, true);
});

test('envCleanup rejects explicitly when draining or disposed (process-tree cwd cleanup)', { timeout: 60_000 }, async (t) => {
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
  await server.envCleanup!(dir); // Normal path succeeds

  await server.dispose();
  await assert.rejects(() => server.envCleanup!(dir), /disposed/);
});

// ---------------------------------------------------------------------------
// 12. LineAssembler length limit: oversized complete lines never bypass per-frame cap
// ---------------------------------------------------------------------------

test('ipcCall per-frame limit rejects oversized complete newline-terminated lines', { timeout: 60_000 }, async (t) => {
  assert.equal(MAX_IPC_FRAME_BYTES, 32 * 1024 * 1024, 'default per-frame limit must be 32 MiB');
  const dir = await tempDir('ipc-frame-limit-');
  const frameLimitBytes = 64 * 1024;
  // Return an oversized line + '\n' (pre-fix bug never checked complete-line length; uses injected limit to avoid 32 MiB alloc)
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
  assert.equal(result.ok, false, 'oversized complete line must be rejected');
  assert.match(!result.ok ? result.error.message : '', /exceeds/);
});

// ---------------------------------------------------------------------------
// 13. birpc events adapter: on/off pairs wrapper references (cleanly removes listeners on $close)
// ---------------------------------------------------------------------------

test('birpc events adapter: off detaches exact wrapped listener independently per route', { timeout: 60_000 }, async () => {
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

  // Malformed JSON or non-object frames go to onInvalidFrame without invoking callback
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
  assert.equal(socket.listenerCount('message'), 1, 'off must detach the actual wrapped listener');
  socket.emit('message', Buffer.from(JSON.stringify({ b: 2 })));
  assert.deepEqual(receivedA, [{ a: 1 }], 'detached callback must stop receiving frames');
  assert.deepEqual(receivedB, [{ b: 2 }]);

  events.off(callbackB);
  assert.equal(socket.listenerCount('message'), 0, 'zero message listeners remain once all detach ($close semantics)');
  // Detaching unknown callback is a harmless no-op
  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 0);
});
