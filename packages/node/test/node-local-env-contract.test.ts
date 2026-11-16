/**
 * local-env align contract test: pin and upstream (@earendil-works/pi-durable
 * NodeExecutionEnv / decode.ts / line-scan.ts,pi coding-agent shell.ts)
 * manually work sync key behavior special sign - - assertion output format and exit semantics itself, while non- note release text:
 *
 * - StreamDecoder: any chunk cut under decode result and whole once decode one by one byte consistent,
 *   BOM only in stream first strip once (contains BOM by split across chunk case);
 * - LineScanner:LineScan byte offset and choose zone/first row byte count all by original byte count (contains
 *   BOM, now state opening path), feed granularity do not change, illegal row number zone between RangeError;
 * - shell probe:legacy WSL start (System32/Sysnative) via stdin transfer
 *   command (args ['‑s']), the rest bash away argv(args ['-c']); self define
 *   shell path missing explicit shell_unavailable;
 * - exec exit semantics: normal exit code pass-through, by signal kill die mapping 128+signal edit number,
 *   timeout error message format `timeout:<second>`, pre- abort signal immediately aborted;
 * - spill back press: over threshold complete output keep in overflow write file (contains timeout path), threshold inside
 *   produces no overflow write file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { useTempDir } from '@helm/test-kit/node';

import type { ShellProbeIo } from '@helm/env-io';
import { LineScanner, LocalExecutionEnv, StreamDecoder } from '../src/daemon/local-env.js';
import { getBashShellConfig, getShellConfig, getShellEnv, isLegacyWslBashPath } from '../src/daemon/local-env/shell.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---------------------------------------------------------------------------
// StreamDecoder(align pi-durable decode.ts)
// ---------------------------------------------------------------------------

test('StreamDecoder: any byte cut under and whole once decode one by one byte consistent (contains multibyte character split)', { timeout: 60_000 }, () => {
  const text = 'héllo wörld Chinese 🚀 trailing';
  const bytes = Buffer.from(text, 'utf8');
  const whole = new TextDecoder('utf8').decode(bytes);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new StreamDecoder();
    const out = decoder.decode(bytes.subarray(0, split)) + decoder.decode(bytes.subarray(split)) + decoder.decode();
    assert.equal(out, whole, `split=${split}`);
  }
});

test('StreamDecoder: stream first BOM only strip once (contains BOM split across chunk and stream in U+FEFF keep)', { timeout: 60_000 }, () => {
  const body = 'abc';
  const whole = Buffer.concat([BOM, Buffer.from(body, 'utf8')]);
  // whole chunk
  const one = new StreamDecoder();
  assert.equal(one.decode(whole) + one.decode(), body);
  // BOM split: first chunk only EF(decode is empty, not mark record started), time chunk patch complete after strip
  const split = new StreamDecoder();
  assert.equal(split.decode(whole.subarray(0, 1)), '');
  assert.equal(split.decode(whole.subarray(1)) + split.decode(), body);
  // stream in U+FEFF is not BOM: original keep
  const mid = new StreamDecoder();
  const midBytes = Buffer.from('a\ufeffb', 'utf8');
  assert.equal(mid.decode(midBytes) + mid.decode(), 'a\ufeffb');
});

// ---------------------------------------------------------------------------
// LineScanner(align pi-durable line-scan.ts)
// ---------------------------------------------------------------------------

test('LineScanner: row zone between scan byte offset opening path (start/end/firstLineEnd/lastLineStart)', { timeout: 60_000 }, () => {
  // pure ASCII: offset can manually compute. content "L0\nL1\nL2\nL3"(without tail newline).
  const scanner = new LineScanner(1, 3);
  scanner.push(Buffer.from('L0\nL1\nL2\nL3', 'utf8'));
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 3, //  1 row start (L1  L)
    end: 8, //  2 row tail newline symbol offset (excludes newline symbol itself)
    firstLineEnd: 5, //  1 row tail newline symbol offset
    lastLineStart: 6, //  2 row start (endLine-1 row)
    selectedBytes: 5, // "L1\nL2"
    firstLineBytes: 2, // "L1"
  });
});

test('LineScanner: all zone between scan BOM + multibyte content byte opening path (such as pin now state)', { timeout: 60_000 }, () => {
  const text = 'héllo\nwörld\nChinese row\n';
  const bytes = Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
  const bomOffset = 3;
  const line1 = 'héllo';
  const line2 = 'wörld';
  const firstLineEnd = bomOffset + Buffer.byteLength(line1, 'utf8'); // 9
  const secondLineEnd = firstLineEnd + 1 + Buffer.byteLength(line2, 'utf8'); // 16
  const scanner = new LineScanner(0);
  scanner.push(bytes);
  // now state opening path: offset and choose zone/first row byte count all by original byte count,BOM count
  // selectedBytes / firstLineBytes(upstream sync when such as semantics change, this assertion explicit report alert).
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 0,
    end: bytes.length, // not designate endLine: with file tail wrap-up
    firstLineEnd,
    lastLineStart: bytes.length, // endLine=∞ and tail has newline: fall back is finally newline after offset (EOF)
    selectedBytes: bytes.length, // BOM + all text
    firstLineBytes: bomOffset + Buffer.byteLength(line1, 'utf8'), // BOM + first row
  });
  // sub- zone between (1, ∞):BOM in choose zone of outside, byte count and original across consistent
  const fromLine1 = new LineScanner(1);
  fromLine1.push(bytes);
  assert.deepEqual(fromLine1.finish(), {
    newlines: 3,
    start: secondLineEnd - Buffer.byteLength(line2, 'utf8'), //  1 row start = 10
    end: bytes.length,
    firstLineEnd: secondLineEnd,
    lastLineStart: bytes.length, // same on: fall back is finally newline after offset (EOF)
    selectedBytes: bytes.length - (secondLineEnd - Buffer.byteLength(line2, 'utf8')),
    firstLineBytes: Buffer.byteLength(line2, 'utf8'),
  });
});

test('LineScanner: one by one byte feed and whole chunk feed result fully consistent (granularity do not change)', { timeout: 60_000 }, () => {
  const bytes = Buffer.concat([BOM, Buffer.from('héllo\nwörld\nChinese row\n', 'utf8')]);
  const oneShot = new LineScanner(1);
  oneShot.push(bytes);
  const bytewise = new LineScanner(1);
  for (const byte of bytes) bytewise.push(Buffer.from([byte]));
  assert.deepEqual(bytewise.finish(), oneShot.finish());
});

test('LineScanner: illegal row number zone between throw RangeError', { timeout: 60_000 }, () => {
  assert.throws(() => new LineScanner(-1), RangeError);
  assert.throws(() => new LineScanner(2, 2), RangeError); // endLine must > startLine
  assert.throws(() => new LineScanner(0.5), RangeError);
  assert.throws(() => new LineScanner(0, 1.5), RangeError);
});

// ---------------------------------------------------------------------------
// shell probe (align pi coding-agent shell.ts)
// ---------------------------------------------------------------------------

const withSystemRoot = (value: string | undefined, fn: () => void): void => {
  const saved = process.env['SystemRoot'];
  try {
    if (value === undefined) delete process.env['SystemRoot'];
    else process.env['SystemRoot'] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env['SystemRoot'];
    else process.env['SystemRoot'] = saved;
  }
};

test('shell probe:SystemRoot under System32/Sysnative bash start via stdin transfer command', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    for (const legacy of ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\Sysnative\\bash.exe']) {
      assert.equal(isLegacyWslBashPath(legacy), true, legacy);
      assert.deepEqual(
        getBashShellConfig(legacy),
        { shell: legacy, args: ['-s'], commandTransport: 'stdin' },
      );
    }
    // large small write and isolate symbol archive one after still identify
    assert.equal(isLegacyWslBashPath('c:\\windows\\SYSTEM32\\bash.exe'), true);
  });
});

test('shell probe:Git Bash / other path away argv transfer (args [-c])', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    assert.equal(isLegacyWslBashPath(gitBash), false);
    assert.deepEqual(getBashShellConfig(gitBash), { shell: gitBash, args: ['-c'], commandTransport: 'argv' });
    // non- bash.exe  System32 can execute file do not in start manifest
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\wsl.exe'), false);
  });
  // SystemRoot points to other where: original C:\Windows\... path no longer is start
  withSystemRoot('D:\\Win', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
  // SystemRoot non- symbol form (UNC): explicit does not match, do not guess
  withSystemRoot('\\\\srv\\share', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
});

test('shell probe:SystemRoot unknown when by convention path regex fall back (small write system32/sysnative)', { timeout: 60_000 }, () => {
  withSystemRoot(undefined, () => {
    assert.equal(isLegacyWslBashPath('c:\\windows\\system32\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Windows\\Sysnative\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Program Files\\Git\\bin\\bash.exe'), false);
  });
});

test('shell probe: self define shell path missing explicit shell_unavailable; store in then by argv transfer', { timeout: 60_000 }, async () => {
  const missing = '/nonexistent/helm-contract/bash';
  const rejected = await getShellConfig(missing);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, 'shell_unavailable');
    assert.equal(rejected.error.message, `Custom shell path not found: ${missing}`);
  }
  const sh = await getShellConfig('/bin/sh');
  if (existsSync('/bin/sh')) {
    assert.deepEqual(sh, { ok: true, value: { shell: '/bin/sh', args: ['-c'], commandTransport: 'argv' } });
  } else {
    assert.equal(sh.ok, true);
  }
});

test('shell probe: local machine by default probe takes precedence /bin/bash, fall back PATH and sh', { timeout: 60_000 }, async () => {
  const config = await getShellConfig(undefined);
  assert.equal(config.ok, true);
  if (!config.ok) return;
  if (existsSync('/bin/bash')) {
    assert.deepEqual(config.value, { shell: '/bin/bash', args: ['-c'], commandTransport: 'argv' });
  } else {
    // fall back chain end end is sh -c(argv transfer)
    assert.ok(config.value.shell.length > 0);
    assert.equal(config.value.commandTransport, 'argv');
  }
});

// ---------------------------------------------------------------------------
// exec exit semantics (align pi-durable NodeExecutionEnv)
// ---------------------------------------------------------------------------

test('exec exit semantics: normal exit code pass-through;argv form directly execute do not via shell', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: os.tmpdir() });
  const viaShell = await env.exec('exit 42', undefined);
  assert.deepEqual(viaShell, { ok: true, value: { exitCode: 42 } });
  const viaArgv = await env.exec(['sh', '-c', 'exit 7'], undefined);
  assert.deepEqual(viaArgv, { ok: true, value: { exitCode: 7 } });
  const emptyArgv = await env.exec([], undefined);
  assert.equal(emptyArgv.ok, false);
  if (!emptyArgv.ok) {
    assert.equal(emptyArgv.error.code, 'spawn_error');
    assert.equal(emptyArgv.error.message, 'Empty argv: no program to run');
  }
});

test('exec exit semantics: by signal kill die process mapping is 128+signal edit number (SIGKILL→137)', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: os.tmpdir() });
  const result = await env.exec('kill -9 $$', undefined);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.exitCode, 137);
});

test('exec exit semantics: timeout error message format is timeout:<second>; pre- abort signal immediately aborted', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: os.tmpdir() });
  const timedOut = await env.exec('sleep 5', { timeout: 1 });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) {
    assert.equal(timedOut.error.code, 'timeout');
    assert.equal(timedOut.error.message, 'timeout:1');
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = await env.exec('echo late', undefined, controller.signal);
  assert.deepEqual(
    { ok: aborted.ok, code: aborted.ok ? undefined : aborted.error.code, message: aborted.ok ? undefined : aborted.error.message },
    { ok: false, code: 'aborted', message: 'aborted' },
  );
});

// ---------------------------------------------------------------------------
// spill overflow write (align pi-durable: over threshold complete output keep in overflow write file)
// ---------------------------------------------------------------------------

test('spill: over threshold output complete keep in overflow write file; threshold inside produces no overflow write file', { timeout: 60_000 }, async (t) => {
  const workdir = useTempDir(t, 'helm-spill-');
  const env = new LocalExecutionEnv({ cwd: workdir });
  const big = await env.exec("node -e \"process.stdout.write('a'.repeat(200000))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.ok(big.ok);
  if (big.ok) {
    assert.equal(big.value.exitCode, 0);
    assert.ok(big.value.spillPath !== undefined, 'over threshold must produce overflow write file');
    if (big.value.spillPath !== undefined) {
      assert.equal(await fs.readFile(big.value.spillPath, 'utf8'), 'a'.repeat(200000));
    }
  }
  const small = await env.exec("node -e \"process.stdout.write('a'.repeat(100))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.deepEqual(small, { ok: true, value: { exitCode: 0 } });
});

test('spill: timeout by kill command same carry overflow write file and content complete', { timeout: 60_000 }, async (t) => {
  const workdir = useTempDir(t, 'helm-spill-timeout-');
  const env = new LocalExecutionEnv({ cwd: workdir });
  const result = await env.exec("node -e \"process.stdout.write('x'.repeat(200000))\"; sleep 5", {
    timeout: 1,
    spill: { afterBytes: 1024, afterLines: 10 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'timeout');
    assert.equal(result.error.message, 'timeout:1');
    assert.ok(result.error.spillPath !== undefined, 'timeout compute must carry overflow write file path');
    if (result.error.spillPath !== undefined) {
      assert.equal(await fs.readFile(result.error.spillPath, 'utf8'), 'x'.repeat(200000));
    }
  }
});

// ---------------------------------------------------------------------------
// Windows host machine guard against WSL hijack and large small write security getShellEnv
// ---------------------------------------------------------------------------

test('LocalExecutionEnv: simulated win32 only store in System32\\bash.exe return shell_unavailable; skip WSL after can execute time row shell', { timeout: 60_000 }, async () => {
  const wslOnlyIo: ShellProbeIo = {
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    homedir: () => 'C:\\Users\\me',
    pathExists: async (p) => p.toLowerCase() === 'c:\\windows\\system32\\bash.exe',
    realpath: async () => null,
    execProbe: async (_cmd, args) =>
      args[0] === 'bash.exe'
        ? { stdout: 'C:\\Windows\\System32\\bash.exe\r\n', status: 0 }
        : { stdout: '', status: 1 },
  };
  const blockedEnv = new LocalExecutionEnv({ cwd: os.tmpdir(), shellProbeIo: wslOnlyIo });
  const blocked = await blockedEnv.exec('echo hi', undefined);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error.code, 'shell_unavailable');
    assert.match(blocked.error.message, /Skipped WSL launcher\(s\)/);
  }

  const realShell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const fallbackIo: ShellProbeIo = {
    ...wslOnlyIo,
    pathExists: async (p) => p === realShell || p.toLowerCase() === 'c:\\windows\\system32\\bash.exe',
    execProbe: async (_cmd, args) =>
      args[0] === 'bash.exe'
        ? { stdout: `C:\\Windows\\System32\\bash.exe\r\n${realShell}\r\n`, status: 0 }
        : { stdout: '', status: 1 },
  };
  const okEnv = new LocalExecutionEnv({ cwd: os.tmpdir(), shellProbeIo: fallbackIo });
  let output = '';
  const res = await okEnv.exec('printf ok', { onOutput: (t) => { output += t; } });
  assert.deepEqual(res, { ok: true, value: { exitCode: 0 } });
  assert.equal(output, 'ok');
});

test('getShellEnv(win32):baseEnv/extraEnv override when produces no Path/PATH double key and store', { timeout: 60_000 }, () => {
  const hasUpper = Object.hasOwn(process.env, 'PATH');
  const savedUpper = process.env['PATH'];
  const hasMixed = Object.hasOwn(process.env, 'Path');
  const savedMixed = process.env['Path'];
  try {
    delete process.env['PATH'];
    process.env['Path'] = 'C:\\Windows\\System32';
    const fromBase = getShellEnv(
      { PATH: 'C:\\helm\\bin;C:\\Windows\\System32' },
      undefined,
      true,
      'win32',
    );
    assert.deepEqual(
      Object.keys(fromBase).filter((k) => k.toUpperCase() === 'PATH'),
      ['PATH'],
    );
    assert.equal(fromBase['PATH'], 'C:\\helm\\bin;C:\\Windows\\System32');

    const merged = getShellEnv(
      { PATH: 'C:\\helm\\bin;C:\\Windows\\System32' },
      { Path: 'C:\\custom;C:\\helm\\bin;C:\\Windows\\System32' },
      true,
      'win32',
    );
    assert.deepEqual(
      Object.keys(merged).filter((k) => k.toUpperCase() === 'PATH'),
      ['Path'],
    );
    assert.equal(merged['Path'], 'C:\\custom;C:\\helm\\bin;C:\\Windows\\System32');
  } finally {
    if (hasUpper && savedUpper !== undefined) process.env['PATH'] = savedUpper;
    else delete process.env['PATH'];
    if (hasMixed && savedMixed !== undefined) process.env['Path'] = savedMixed;
    else delete process.env['Path'];
  }
});
