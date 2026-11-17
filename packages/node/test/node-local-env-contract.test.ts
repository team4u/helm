/**
 * `local-env` contract tests locking key behavioral invariants inherited from
 * `@earendil-works/pi-durable` (`NodeExecutionEnv`, `StreamDecoder`, `LineScanner`)
 * and `@helm/env-io` shell probing — asserting observable outputs and exit semantics:
 *
 * - `StreamDecoder`: arbitrary chunk boundaries decode identically byte-for-byte to a single
 *   chunk, and leading UTF-8 BOM is stripped once even when split across chunks;
 * - `LineScanner`: `LineScan` offsets cover raw bytes including BOM while decoded counts
 *   exclude leading BOM, results are invariant to chunk size, and invalid ranges throw `RangeError`;
 * - Shell probing: legacy WSL launchers (`System32`/`Sysnative`) send commands via stdin
 *   (`args: ['-s']`), standard bash uses argv (`args: ['-c']`), and missing custom shells
 *   explicitly return `shell_unavailable`;
 * - `exec` exit semantics: normal exit codes pass through, signal kills map to `128 + signo`,
 *   timeout errors follow `timeout:<seconds>`, and pre-aborted signals yield `aborted`;
 * - Spill backpressure: oversized output is preserved in full via `spillPath` (including on
 *   timeout), whereas within-threshold output creates no spill file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { useTempDir } from '@helm/test-kit/node';

import { getBashShellConfig, isLegacyWslBashPath, type ShellProbeIo } from '@helm/env-io';
import { LineScanner, LocalExecutionEnv, StreamDecoder, getShellConfig, getShellEnv } from '../src/daemon/local-env.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---------------------------------------------------------------------------
// StreamDecoder (delegated to @earendil-works/pi-durable/env)
// ---------------------------------------------------------------------------

test('StreamDecoder matches single-shot UTF-8 decoding across every byte split point', { timeout: 60_000 }, () => {
  const text = 'héllo wörld Chinese 🚀 trailing';
  const bytes = Buffer.from(text, 'utf8');
  const whole = new TextDecoder('utf8').decode(bytes);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new StreamDecoder();
    const out = decoder.decode(bytes.subarray(0, split)) + decoder.decode(bytes.subarray(split)) + decoder.decode();
    assert.equal(out, whole, `split=${split}`);
  }
});

test('StreamDecoder strips leading BOM once even when split across chunks and preserves mid-stream U+FEFF', { timeout: 60_000 }, () => {
  const body = 'abc';
  const whole = Buffer.concat([BOM, Buffer.from(body, 'utf8')]);
  // Whole buffer in one chunk
  const one = new StreamDecoder();
  assert.equal(one.decode(whole) + one.decode(), body);
  // Split BOM: first chunk holds only 0xEF (decodes empty, not started), second completes BOM and strips it
  const split = new StreamDecoder();
  assert.equal(split.decode(whole.subarray(0, 1)), '');
  assert.equal(split.decode(whole.subarray(1)) + split.decode(), body);
  // Mid-stream U+FEFF is not a BOM and must pass through unchanged
  const mid = new StreamDecoder();
  const midBytes = Buffer.from('a\ufeffb', 'utf8');
  assert.equal(mid.decode(midBytes) + mid.decode(), 'a\ufeffb');
});

// ---------------------------------------------------------------------------
// LineScanner (delegated to @earendil-works/pi-durable/env)
// ---------------------------------------------------------------------------

test('LineScanner line-range byte offsets (start/end/firstLineEnd/lastLineStart)', { timeout: 60_000 }, () => {
  // Pure ASCII so byte offsets are straightforward: "L0\nL1\nL2\nL3" without trailing newline.
  const scanner = new LineScanner(1, 3);
  scanner.push(Buffer.from('L0\nL1\nL2\nL3', 'utf8'));
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 3, // Start of line 1 ('L' in L1)
    end: 8, // End offset before newline on line 2
    firstLineEnd: 5, // End offset before newline on line 1
    lastLineStart: 6, // Start of line 2 (endLine - 1)
    selectedBytes: 5, // "L1\nL2"
    firstLineBytes: 2, // "L1"
  });
});

test('LineScanner: full-range scan with BOM + multibyte content reports raw byte offsets and decoded byte counts', { timeout: 60_000 }, () => {
  const text = 'héllo\nwörld\nChinese row\n';
  const bytes = Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
  const bomOffset = 3;
  const line1 = 'héllo';
  const line2 = 'wörld';
  const firstLineEnd = bomOffset + Buffer.byteLength(line1, 'utf8'); // 9
  const secondLineEnd = firstLineEnd + 1 + Buffer.byteLength(line2, 'utf8'); // 16
  const scanner = new LineScanner(0);
  scanner.push(bytes);
  // Offsets are raw file byte positions (including BOM), while decoded sizes (`selectedBytes`,
  // `firstLineBytes`) exclude the leading BOM to match `new TextDecoder().decode(file)`.
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 0,
    end: bytes.length, // no endLine specified: ends at EOF
    firstLineEnd,
    lastLineStart: bytes.length, // endLine=∞ with trailing newline: falls back to offset after last newline (EOF)
    selectedBytes: bytes.length - bomOffset, // decoded text without leading BOM
    firstLineBytes: Buffer.byteLength(line1, 'utf8'), // decoded first line without leading BOM
  });
  // Sub-range [1, ∞): BOM is outside the selection, so decoded size matches raw span.
  const fromLine1 = new LineScanner(1);
  fromLine1.push(bytes);
  assert.deepEqual(fromLine1.finish(), {
    newlines: 3,
    start: secondLineEnd - Buffer.byteLength(line2, 'utf8'), // line 1 start = 10
    end: bytes.length,
    firstLineEnd: secondLineEnd,
    lastLineStart: bytes.length, // same fallback to EOF after trailing newline
    selectedBytes: bytes.length - (secondLineEnd - Buffer.byteLength(line2, 'utf8')),
    firstLineBytes: Buffer.byteLength(line2, 'utf8'),
  });
});

test('LineScanner gives identical results for byte-by-byte vs single-chunk input', { timeout: 60_000 }, () => {
  const bytes = Buffer.concat([BOM, Buffer.from('héllo\nwörld\nChinese row\n', 'utf8')]);
  const oneShot = new LineScanner(1);
  oneShot.push(bytes);
  const bytewise = new LineScanner(1);
  for (const byte of bytes) bytewise.push(Buffer.from([byte]));
  assert.deepEqual(bytewise.finish(), oneShot.finish());
});

test('LineScanner throws RangeError on invalid line ranges', { timeout: 60_000 }, () => {
  assert.throws(() => new LineScanner(-1), RangeError);
  assert.throws(() => new LineScanner(2, 2), RangeError); // endLine must exceed startLine
  assert.throws(() => new LineScanner(0.5), RangeError);
  assert.throws(() => new LineScanner(0, 1.5), RangeError);
});

// ---------------------------------------------------------------------------
// Shell probing (delegated to @helm/env-io)
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

test('shell probe: System32/Sysnative bash launchers under SystemRoot pass commands via stdin', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    for (const legacy of ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\Sysnative\\bash.exe']) {
      assert.equal(isLegacyWslBashPath(legacy), true, legacy);
      assert.deepEqual(
        getBashShellConfig(legacy),
        { shell: legacy, args: ['-s'], commandTransport: 'stdin' },
      );
    }
    // Still matched after case and separator normalization
    assert.equal(isLegacyWslBashPath('c:\\windows\\SYSTEM32\\bash.exe'), true);
  });
});

test('shell probe: Git Bash and other paths pass commands via argv (args [-c])', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    assert.equal(isLegacyWslBashPath(gitBash), false);
    assert.deepEqual(getBashShellConfig(gitBash), { shell: gitBash, args: ['-c'], commandTransport: 'argv' });
    // Non-bash.exe executables under System32 are not treated as legacy WSL bash launchers
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\wsl.exe'), false);
  });
  // SystemRoot pointing elsewhere: C:\Windows\... is no longer treated as SystemRoot launcher
  withSystemRoot('D:\\Win', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
  // Non-drive-letter SystemRoot (UNC): explicitly does not match without guessing
  withSystemRoot('\\\\srv\\share', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
});

test('shell probe: falls back to conventional regex when SystemRoot is unset', { timeout: 60_000 }, () => {
  withSystemRoot(undefined, () => {
    assert.equal(isLegacyWslBashPath('c:\\windows\\system32\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Windows\\Sysnative\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Program Files\\Git\\bin\\bash.exe'), false);
  });
});

test('shell probe: missing custom shell explicitly returns shell_unavailable; existing one uses argv', { timeout: 60_000 }, async () => {
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

test('shell probe: host default prefers /bin/bash and falls back to PATH and sh', { timeout: 60_000 }, async () => {
  const config = await getShellConfig(undefined);
  assert.equal(config.ok, true);
  if (!config.ok) return;
  if (existsSync('/bin/bash')) {
    assert.deepEqual(config.value, { shell: '/bin/bash', args: ['-c'], commandTransport: 'argv' });
  } else {
    // End of fallback chain is sh -c (argv transport)
    assert.ok(config.value.shell.length > 0);
    assert.equal(config.value.commandTransport, 'argv');
  }
});

// ---------------------------------------------------------------------------
// exec exit semantics (delegated to @earendil-works/pi-durable NodeExecutionEnv)
// ---------------------------------------------------------------------------

test('exec exit semantics: passes through exit codes and executes argv arrays without shell', { timeout: 60_000 }, async () => {
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

test('exec exit semantics: signal-killed processes map to 128 + signal number (SIGKILL -> 137)', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: os.tmpdir() });
  const result = await env.exec('kill -9 $$', undefined);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.exitCode, 137);
});

test('exec exit semantics: timeout error message matches timeout:<seconds> and pre-aborted signals yield aborted', { timeout: 60_000 }, async () => {
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
// Output spill backpressure (delegated to pi-durable: full output preserved past threshold)
// ---------------------------------------------------------------------------

test('spill: oversized output is preserved in full via spillPath while small output produces no spill file', { timeout: 60_000 }, async (t) => {
  const workdir = useTempDir(t, 'helm-spill-');
  const env = new LocalExecutionEnv({ cwd: workdir });
  const big = await env.exec("node -e \"process.stdout.write('a'.repeat(200000))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.ok(big.ok);
  if (big.ok) {
    assert.equal(big.value.exitCode, 0);
    assert.ok(big.value.spillPath !== undefined, 'output over threshold must produce a spill file');
    if (big.value.spillPath !== undefined) {
      assert.equal(await fs.readFile(big.value.spillPath, 'utf8'), 'a'.repeat(200000));
    }
  }
  const small = await env.exec("node -e \"process.stdout.write('a'.repeat(100))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.deepEqual(small, { ok: true, value: { exitCode: 0 } });
});

test('spill: timed-out commands still preserve full output in spillPath', { timeout: 60_000 }, async (t) => {
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
    assert.ok(result.error.spillPath !== undefined, 'timeout result must carry spillPath');
    if (result.error.spillPath !== undefined) {
      assert.equal(await fs.readFile(result.error.spillPath, 'utf8'), 'x'.repeat(200000));
    }
  }
});

// ---------------------------------------------------------------------------
// Windows WSL hijack protection and case-safe getShellEnv
// ---------------------------------------------------------------------------

test('LocalExecutionEnv: simulated win32 with only System32\\bash.exe returns shell_unavailable and skips WSL to run fallback shell', { timeout: 60_000 }, async () => {
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

test('getShellEnv(win32): overriding baseEnv/extraEnv never creates duplicate Path and PATH keys', { timeout: 60_000 }, () => {
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
