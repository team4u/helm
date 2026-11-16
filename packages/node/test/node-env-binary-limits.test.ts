/**
 * two enter system transfer 64 MiB cap and precise stick boundary write protect regression.
 *
 * envReadBinaryFile / envBinaryReaderRead / envWriteFile(base64 decode before/after)
 * single time payload over limit explicit errors (invalid), never static default truncate, never let node daemon
 * without boundary occupy memory piece together install huge type base64 frame; exactly 64 MiB legal base64 write succeeded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { useTempDir } from '@helm/test-kit/node';

import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

const LIMIT = 64 * 1024 * 1024;

test('envBinaryReaderRead: request length over limit explicit invalid(no need to thing any byte)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-reader-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
  await fs.writeFile(path.join(dir, 'small.bin'), Buffer.from([1, 2, 3]));
  const opened = await server.envOpenBinaryReader({ path: 'small.bin' });
  assert.equal(opened.ok, true);
  const readerId = opened.ok ? opened.value.readerId : '';

  // request length over cap: directly reject, does not any read.
  const tooBig = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(!tooBig.ok && tooBig.error.code, 'invalid');
  assert.match(!tooBig.ok && tooBig.error.message, /no greater than/);

  // boundary value (exactly equals cap) do not in this assertion scope: legal (page read by caller batch).
  const edge = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT });
  assert.equal(edge.ok, true, 'exactly in cap request legal (this example file only 3 byte)');

  // non- integer length still by underlying validate reject.
  const badShape = await server.envBinaryReaderRead({ readerId, offset: 0, length: Number.NaN });
  assert.equal(badShape.ok, false);
});

test('envWriteFile:base64 encode length over limit in decode before reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-write-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // encode cap by base64  4/3 expansion compute; over limit when in decode before reject.
  const huge = 'A'.repeat(Math.ceil(LIMIT / 3) * 4 + 4);
  const rejected = await server.envWriteFile({ path: 'big.bin', content: huge, encoding: 'base64' });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  assert.match(!rejected.ok && rejected.error.message, /exceeds/);
  assert.equal(
    await fs.stat(path.join(dir, 'big.bin')).then(() => true, () => false),
    false,
    'over limit write must not',
  );
});

test('envWriteFile: decode after byte over limit re- verify reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-decode-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // character count low at cap but UTF-8 byte count over limit, write and append all must reject.
  const bigUtf8 = '中'.repeat(Math.floor(LIMIT / 3) + 1);
  const rejected = await server.envWriteFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  const appendRejected = await server.envAppendFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(appendRejected.ok, false);
  assert.equal(!appendRejected.ok && appendRejected.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'big.txt')).then(() => true, () => false), false);
});

test('envReadBinaryFile: result over limit explicit invalid(do not truncate fill when succeeded)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-read-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // create a logic 64MiB+1 file (truncate extend; large many count file system is sparse allocate).
  await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.from([0]));
  await fs.truncate(path.join(dir, 'huge.bin'), LIMIT + 1);
  const result = await server.envReadBinaryFile({ path: 'huge.bin' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'invalid');
  assert.match(!result.ok && result.error.message, /transfer limit/);
});

test('exactly 64MiB legal base64 write succeeded, encode expansion and fill do not reduce byte quota', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-base64-boundary-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
  const encodedLength = Math.ceil(LIMIT / 3) * 4;
  // all zero data standard encode, tail two fill character must from decode length in buckle except.
  const result = await server.envWriteFile({
    path: 'edge.bin',
    content: 'A'.repeat(encodedLength - 2) + '==',
    encoding: 'base64',
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  assert.equal((await fs.stat(path.join(dir, 'edge.bin'))).size, LIMIT);
});
