/**
 * local-env 对齐契约测试：钉住与上游（@earendil-works/pi-durable
 * NodeExecutionEnv / decode.ts / line-scan.ts、pi coding-agent shell.ts）
 * 手工同步的关键行为特征——断言输出格式与退出语义本身，而非注释文本：
 *
 * - StreamDecoder：任意 chunk 切分下解码结果与整体一次解码逐字节一致，
 *   BOM 只在流首剥离一次（含 BOM 被劈开跨 chunk 的情形）；
 * - LineScanner：LineScan 字节偏移与选区/首行字节数均按原始字节计（含
 *   BOM，现状口径）、喂入粒度不变性、非法行号区间 RangeError；
 * - shell 探测：legacy WSL 启动器（System32/Sysnative）经 stdin 传输
 *   命令（args ['‑s']），其余 bash 走 argv（args ['-c']）；自定义
 *   shell 路径缺失显式 shell_unavailable；
 * - exec 退出语义：正常退出码透传、被信号杀死映射 128+信号编号、
 *   超时错误消息格式 `timeout:<秒>`、预中止信号立即 aborted；
 * - spill 背压：超阈值的完整输出保留在溢写文件（含超时路径），阈值内
 *   不产生溢写文件。
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
// StreamDecoder（对齐 pi-durable decode.ts）
// ---------------------------------------------------------------------------

test('StreamDecoder：任意字节切分下与整体一次解码逐字节一致（含多字节字符劈开）', { timeout: 60_000 }, () => {
  const text = 'héllo wörld 中文 🚀 trailing';
  const bytes = Buffer.from(text, 'utf8');
  const whole = new TextDecoder('utf8').decode(bytes);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new StreamDecoder();
    const out = decoder.decode(bytes.subarray(0, split)) + decoder.decode(bytes.subarray(split)) + decoder.decode();
    assert.equal(out, whole, `split=${split}`);
  }
});

test('StreamDecoder：流首 BOM 只剥离一次（含 BOM 劈开跨 chunk 与流中 U+FEFF 保留）', { timeout: 60_000 }, () => {
  const body = 'abc';
  const whole = Buffer.concat([BOM, Buffer.from(body, 'utf8')]);
  // 整块
  const one = new StreamDecoder();
  assert.equal(one.decode(whole) + one.decode(), body);
  // BOM 劈开：首块只有 EF（解码为空，未标记 started），次块补齐后剥离
  const split = new StreamDecoder();
  assert.equal(split.decode(whole.subarray(0, 1)), '');
  assert.equal(split.decode(whole.subarray(1)) + split.decode(), body);
  // 流中的 U+FEFF 不是 BOM：原样保留
  const mid = new StreamDecoder();
  const midBytes = Buffer.from('a\ufeffb', 'utf8');
  assert.equal(mid.decode(midBytes) + mid.decode(), 'a\ufeffb');
});

// ---------------------------------------------------------------------------
// LineScanner（对齐 pi-durable line-scan.ts）
// ---------------------------------------------------------------------------

test('LineScanner：行区间扫描的字节偏移口径（start/end/firstLineEnd/lastLineStart）', { timeout: 60_000 }, () => {
  // 纯 ASCII：偏移可手算。内容 "L0\nL1\nL2\nL3"（无结尾换行）。
  const scanner = new LineScanner(1, 3);
  scanner.push(Buffer.from('L0\nL1\nL2\nL3', 'utf8'));
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 3, // 第 1 行起始（L1 的 L）
    end: 8, // 第 2 行结尾换行符偏移（不含换行符自身）
    firstLineEnd: 5, // 第 1 行结尾换行符偏移
    lastLineStart: 6, // 第 2 行起始（endLine-1 行）
    selectedBytes: 5, // "L1\nL2"
    firstLineBytes: 2, // "L1"
  });
});

test('LineScanner：全区间扫描 BOM + 多字节内容的字节口径（如实钉住现状）', { timeout: 60_000 }, () => {
  const text = 'héllo\nwörld\n中文行\n';
  const bytes = Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
  const bomOffset = 3;
  const line1 = 'héllo';
  const line2 = 'wörld';
  const firstLineEnd = bomOffset + Buffer.byteLength(line1, 'utf8'); // 9
  const secondLineEnd = firstLineEnd + 1 + Buffer.byteLength(line2, 'utf8'); // 16
  const scanner = new LineScanner(0);
  scanner.push(bytes);
  // 现状口径：偏移与选区/首行字节数均按原始字节计，BOM 计入
  // selectedBytes / firstLineBytes（上游同步时如语义变化，本断言显式报警）。
  assert.deepEqual(scanner.finish(), {
    newlines: 3,
    start: 0,
    end: bytes.length, // 未指定 endLine：以文件末尾收尾
    firstLineEnd,
    lastLineStart: bytes.length, // endLine=∞ 且结尾有换行：回退为最后换行后的偏移（EOF）
    selectedBytes: bytes.length, // BOM + 全文
    firstLineBytes: bomOffset + Buffer.byteLength(line1, 'utf8'), // BOM + 首行
  });
  // 子区间（1, ∞）：BOM 在选区之外，字节数与原始跨度一致
  const fromLine1 = new LineScanner(1);
  fromLine1.push(bytes);
  assert.deepEqual(fromLine1.finish(), {
    newlines: 3,
    start: secondLineEnd - Buffer.byteLength(line2, 'utf8'), // 第 1 行起始 = 10
    end: bytes.length,
    firstLineEnd: secondLineEnd,
    lastLineStart: bytes.length, // 同上：回退为最后换行后的偏移（EOF）
    selectedBytes: bytes.length - (secondLineEnd - Buffer.byteLength(line2, 'utf8')),
    firstLineBytes: Buffer.byteLength(line2, 'utf8'),
  });
});

test('LineScanner：逐字节喂入与整块喂入结果完全一致（粒度不变性）', { timeout: 60_000 }, () => {
  const bytes = Buffer.concat([BOM, Buffer.from('héllo\nwörld\n中文行\n', 'utf8')]);
  const oneShot = new LineScanner(1);
  oneShot.push(bytes);
  const bytewise = new LineScanner(1);
  for (const byte of bytes) bytewise.push(Buffer.from([byte]));
  assert.deepEqual(bytewise.finish(), oneShot.finish());
});

test('LineScanner：非法行号区间抛 RangeError', { timeout: 60_000 }, () => {
  assert.throws(() => new LineScanner(-1), RangeError);
  assert.throws(() => new LineScanner(2, 2), RangeError); // endLine 必须 > startLine
  assert.throws(() => new LineScanner(0.5), RangeError);
  assert.throws(() => new LineScanner(0, 1.5), RangeError);
});

// ---------------------------------------------------------------------------
// shell 探测（对齐 pi coding-agent shell.ts）
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

test('shell 探测：SystemRoot 下的 System32/Sysnative bash 启动器经 stdin 传输命令', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    for (const legacy of ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\Sysnative\\bash.exe']) {
      assert.equal(isLegacyWslBashPath(legacy), true, legacy);
      assert.deepEqual(
        getBashShellConfig(legacy),
        { shell: legacy, args: ['-s'], commandTransport: 'stdin' },
      );
    }
    // 大小写与分隔符归一后仍识别
    assert.equal(isLegacyWslBashPath('c:\\windows\\SYSTEM32\\bash.exe'), true);
  });
});

test('shell 探测：Git Bash / 其他路径走 argv 传输（args [-c]）', { timeout: 60_000 }, () => {
  withSystemRoot('C:\\Windows', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    assert.equal(isLegacyWslBashPath(gitBash), false);
    assert.deepEqual(getBashShellConfig(gitBash), { shell: gitBash, args: ['-c'], commandTransport: 'argv' });
    // 非 bash.exe 的 System32 可执行文件不在启动器清单
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\wsl.exe'), false);
  });
  // SystemRoot 指向别处：原 C:\Windows\... 路径不再是启动器
  withSystemRoot('D:\\Win', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
  // SystemRoot 非盘符形式（UNC）：显式不匹配，不猜
  withSystemRoot('\\\\srv\\share', () => {
    assert.equal(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe'), false);
  });
});

test('shell 探测：SystemRoot 未知时按惯例路径正则回退（小写 system32/sysnative）', { timeout: 60_000 }, () => {
  withSystemRoot(undefined, () => {
    assert.equal(isLegacyWslBashPath('c:\\windows\\system32\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Windows\\Sysnative\\bash.exe'), true);
    assert.equal(isLegacyWslBashPath('C:\\Program Files\\Git\\bin\\bash.exe'), false);
  });
});

test('shell 探测：自定义 shell 路径缺失显式 shell_unavailable；存在则按 argv 传输', { timeout: 60_000 }, async () => {
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

test('shell 探测：本机默认探测优先 /bin/bash，兜底 PATH 与 sh', { timeout: 60_000 }, async () => {
  const config = await getShellConfig(undefined);
  assert.equal(config.ok, true);
  if (!config.ok) return;
  if (existsSync('/bin/bash')) {
    assert.deepEqual(config.value, { shell: '/bin/bash', args: ['-c'], commandTransport: 'argv' });
  } else {
    // 兜底链末端是 sh -c（argv 传输）
    assert.ok(config.value.shell.length > 0);
    assert.equal(config.value.commandTransport, 'argv');
  }
});

// ---------------------------------------------------------------------------
// exec 退出语义（对齐 pi-durable NodeExecutionEnv）
// ---------------------------------------------------------------------------

test('exec 退出语义：正常退出码透传；argv 形式直接执行不经 shell', { timeout: 60_000 }, async () => {
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

test('exec 退出语义：被信号杀死的进程映射为 128+信号编号（SIGKILL→137）', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: os.tmpdir() });
  const result = await env.exec('kill -9 $$', undefined);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.exitCode, 137);
});

test('exec 退出语义：超时错误消息格式为 timeout:<秒>；预中止信号立即 aborted', { timeout: 60_000 }, async () => {
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
// spill 溢写（对齐 pi-durable：超阈值的完整输出保留在溢写文件）
// ---------------------------------------------------------------------------

test('spill：超阈值输出完整保留在溢写文件；阈值内不产生溢写文件', { timeout: 60_000 }, async (t) => {
  const workdir = useTempDir(t, 'helm-spill-');
  const env = new LocalExecutionEnv({ cwd: workdir });
  const big = await env.exec("node -e \"process.stdout.write('a'.repeat(200000))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.ok(big.ok);
  if (big.ok) {
    assert.equal(big.value.exitCode, 0);
    assert.ok(big.value.spillPath !== undefined, '超阈值必须产生溢写文件');
    if (big.value.spillPath !== undefined) {
      assert.equal(await fs.readFile(big.value.spillPath, 'utf8'), 'a'.repeat(200000));
    }
  }
  const small = await env.exec("node -e \"process.stdout.write('a'.repeat(100))\"", {
    spill: { afterBytes: 4096, afterLines: 10 },
  });
  assert.deepEqual(small, { ok: true, value: { exitCode: 0 } });
});

test('spill：超时被杀的命令同样携带溢写文件且内容完整', { timeout: 60_000 }, async (t) => {
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
    assert.ok(result.error.spillPath !== undefined, '超时结算必须携带溢写文件路径');
    if (result.error.spillPath !== undefined) {
      assert.equal(await fs.readFile(result.error.spillPath, 'utf8'), 'x'.repeat(200000));
    }
  }
});

// ---------------------------------------------------------------------------
// Windows 宿主机防 WSL 劫持与大小写安全 getShellEnv
// ---------------------------------------------------------------------------

test('LocalExecutionEnv：模拟 win32 仅存在 System32\\bash.exe 返回 shell_unavailable；跳过 WSL 后可执行次行 shell', { timeout: 60_000 }, async () => {
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

test('getShellEnv(win32)：baseEnv/extraEnv 覆盖时不产生 Path/PATH 双键并存', { timeout: 60_000 }, () => {
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
