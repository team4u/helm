/**
 * 二进制传输 64 MiB 上限保护回归。
 *
 * envReadBinaryFile / envBinaryReaderRead / envWriteFile（base64 解码前/后）
 * 的单次载荷超限显式报错（invalid），绝不静默截断、绝不让节点守护进程
 * 无界占用内存拼装巨型 base64 帧。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

const LIMIT = 64 * 1024 * 1024;

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('envBinaryReaderRead：请求长度超限显式 invalid（无需物化任何字节）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-limit-reader-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'small.bin'), Buffer.from([1, 2, 3]));
  const opened = await server.envOpenBinaryReader({ path: 'small.bin' });
  assert.equal(opened.ok, true);
  const readerId = opened.ok ? opened.value.readerId : '';

  // 请求 length 超上限：直接拒绝，不做任何读取。
  const tooBig = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(!tooBig.ok && tooBig.error.code, 'invalid');
  assert.match(!tooBig.ok && tooBig.error.message, /no greater than/);

  // 边界值（恰等于上限）不在本断言范围：合法（分页读取由调用方分批）。
  const edge = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT });
  assert.equal(edge.ok, true, '恰在上限的请求合法（本例文件只有 3 字节）');

  // 非整数 length 仍被底层校验拒绝。
  const badShape = await server.envBinaryReaderRead({ readerId, offset: 0, length: Number.NaN });
  assert.equal(badShape.ok, false);
});

test('envWriteFile：base64 编码长度超限在解码前拒绝', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-limit-write-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 编码长度超 64 MiB：解码前拒绝（防先物化巨型 Buffer）。
  const huge = 'A'.repeat(LIMIT + 8);
  const rejected = await server.envWriteFile({ path: 'big.bin', content: huge, encoding: 'base64' });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  assert.match(!rejected.ok && rejected.error.message, /exceeds/);
  assert.equal(
    await fs.stat(path.join(dir, 'big.bin')).then(() => true, () => false),
    false,
    '超限写入不得落盘',
  );
});

test('envWriteFile：解码后字节超限复验拒绝', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-limit-decode-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 构造解码后超限的合法 base64（含 padding，编码长度低于解码前阈值的
  // 简单倍数关系不足以绕过：这里编码长度也超限，会被解码前检查拦下；
  // 换用手绕开编码长度检查的等价路径——utf8 路径的长字符串由解码后
  // 字节数复验兜底）。
  const bigUtf8 = 'x'.repeat(LIMIT + 100);
  const rejected = await server.envWriteFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
});

test('envReadBinaryFile：结果超限显式 invalid（不截断充当成功）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-limit-read-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 建一个逻辑 64MiB+1 的文件（truncate 扩展；大多数文件系统为稀疏分配）。
  await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.from([0]));
  await fs.truncate(path.join(dir, 'huge.bin'), LIMIT + 1);
  const result = await server.envReadBinaryFile({ path: 'huge.bin' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'invalid');
  assert.match(!result.ok && result.error.message, /transfer limit/);
});
