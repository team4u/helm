import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { extractTarGzip } from '../src/payload-tar.js';
import { buildTar } from './helpers-payload.js';

function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  let sum = 0;
  for (const value of header) sum += value;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
}
async function withArchive(archive: Buffer, fn: (input: string, output: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'helm-tar-'));
  try {
    const input = join(dir, 'payload.tgz');
    await writeFile(input, gzipSync(archive));
    await fn(input, join(dir, 'output'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('归档拒绝符号链接、硬链接和设备条目', { timeout: 60_000 }, async () => {
  for (const type of ['1', '2', '3', '6']) {
    const tar = buildTar([{ name: 'package/link', content: '' }]);
    tar.write(type, 156, 1);
    tar.write('outside', 157);
    checksum(tar.subarray(0, 512));
    await withArchive(tar, async (input, output) => {
      await assert.rejects(extractTarGzip(input, output), { code: 'tar_unsupported_type' });
    });
  }
});

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  return `${length} ${body}`;
}

test('pax 多条扩展记录正确应用路径并保留文件内容', { timeout: 60_000 }, async () => {
  const pax = paxRecord('mtime', '123') + paxRecord('path', 'package/目录/内容.txt');
  const tar = buildTar([{ name: 'package/pax', content: pax }, { name: 'package/placeholder', content: 'payload' }]);
  tar.write('x', 156, 1);
  checksum(tar.subarray(0, 512));
  await withArchive(tar, async (input, output) => {
    await extractTarGzip(input, output);
    assert.equal(await readFile(join(output, '目录', '内容.txt'), 'utf8'), 'payload');
  });
});

test('归档在分配扩展元数据前检查长度上限', { timeout: 60_000 }, async () => {
  const tar = buildTar([{ name: 'package/pax', content: '' }]);
  tar.write('x', 156, 1);
  tar.write(`${(10 * 1024 * 1024).toString(8).padStart(11, '0')}\0`, 124, 12);
  checksum(tar.subarray(0, 512));
  await withArchive(tar, async (input, output) => {
    await assert.rejects(extractTarGzip(input, output), { code: 'tar_size_limit' });
  });
});
