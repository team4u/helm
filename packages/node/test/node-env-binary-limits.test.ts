/**
 * 二进制传输 64 MiB 上限与精确贴界写入保护回归。
 *
 * envReadBinaryFile / envBinaryReaderRead / envWriteFile（base64 解码前/后）
 * 的单次载荷超限显式报错（invalid），绝不静默截断、绝不让节点守护进程
 * 无界占用内存拼装巨型 base64 帧；恰好 64 MiB 的合法 base64 写入成功。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { useTempDir } from '@helm/test-kit/node';

import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

const LIMIT = 64 * 1024 * 1024;

test('envBinaryReaderRead：请求长度超限显式 invalid（无需物化任何字节）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-reader-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
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
  const dir = useTempDir(t, 'b64-limit-write-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // 编码上限按 base64 的 4/3 膨胀计算；超限时在解码前拒绝。
  const huge = 'A'.repeat(Math.ceil(LIMIT / 3) * 4 + 4);
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
  const dir = useTempDir(t, 'b64-limit-decode-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // 字符数低于上限但 UTF-8 字节数超限，写入与追加都必须拒绝。
  const bigUtf8 = '中'.repeat(Math.floor(LIMIT / 3) + 1);
  const rejected = await server.envWriteFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  const appendRejected = await server.envAppendFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(appendRejected.ok, false);
  assert.equal(!appendRejected.ok && appendRejected.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'big.txt')).then(() => true, () => false), false);
});

test('envReadBinaryFile：结果超限显式 invalid（不截断充当成功）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-read-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // 建一个逻辑 64MiB+1 的文件（truncate 扩展；大多数文件系统为稀疏分配）。
  await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.from([0]));
  await fs.truncate(path.join(dir, 'huge.bin'), LIMIT + 1);
  const result = await server.envReadBinaryFile({ path: 'huge.bin' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'invalid');
  assert.match(!result.ok && result.error.message, /transfer limit/);
});

test('恰好 64MiB 的合法 base64 写入成功，编码膨胀和填充不减少字节额度', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-base64-boundary-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
  const encodedLength = Math.ceil(LIMIT / 3) * 4;
  // 全零数据的标准编码，末尾两个填充字符必须从解码长度中扣除。
  const result = await server.envWriteFile({
    path: 'edge.bin',
    content: 'A'.repeat(encodedLength - 2) + '==',
    encoding: 'base64',
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  assert.equal((await fs.stat(path.join(dir, 'edge.bin'))).size, LIMIT);
});
