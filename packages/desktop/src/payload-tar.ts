/**
 * 最小安全 tar.gz 解包器（纯 Node 零依赖）：面向 npm 包 tarball（ustar + pax 扩展头 +
 * GNU longname），流式解压落盘，强制三重防线：
 * 1. 条目名 containment：拒绝绝对路径 / `..` 穿越 / 反斜杠（Windows 语义不确定）/
 *    非 `package/` 前缀（npm 包布局铁律）；
 * 2. 类型白名单：仅文件 / 目录；链接、设备文件与 FIFO 显式拒绝；
 * 3. 上限：条目数与解包总字节封顶（防解压炸弹）。
 * 任何违规显式抛 DesktopError（tar_*），绝不静默跳过。
 */
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { DesktopError } from './errors.js';

const BLOCK_SIZE = 512;

export interface TarExtractOptions {
  maxEntries: number;
  maxTotalBytes: number;
  /** npm tarball 根前缀（npm pack 布局恒为 package/）。 */
  stripPrefix: string;
}

export interface TarExtractResult {
  files: number;
  directories: number;
  totalBytes: number;
}

const DEFAULTS: TarExtractOptions = {
  maxEntries: 200_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  stripPrefix: 'package',
};

/** 按需拉取的可缓冲字节源（异步迭代器天然背压，避免整包驻留内存）。 */
class BlockSource {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    return true;
  }

  /** 恰好 n 字节（跨 chunk 聚合）；流提前结束返回 null。 */
  async readExact(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n) {
      if (!(await this.fill())) return null;
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** 至多 n 字节（至少 1 字节可用）；流结束返回 null。 */
  async readUpTo(n: number): Promise<Buffer | null> {
    if (this.buffer.length === 0 && !(await this.fill())) return null;
    const take = Math.min(n, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  /** 丢弃 n 字节；流提前结束抛 tar_truncated。 */
  async skipBytes(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.readUpTo(Math.min(remaining, BLOCK_SIZE * 2));
      if (chunk === null) {
        throw new DesktopError('tar_truncated', 'tar 流在条目内容中途结束（文件损坏或截断）');
      }
      remaining -= chunk.length;
    }
  }
}

function parseOctal(field: Buffer, what: string): number {
  const text = field.toString('utf8').split('\0')[0]!.trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!/^[0-7]+$/.test(text) || !Number.isSafeInteger(value) || value < 0) {
    throw new DesktopError('tar_header_invalid', `tar 头部 ${what} 字段不是合法八进制: ${JSON.stringify(text)}`);
  }
  return value;
}

function verifyChecksum(header: Buffer): void {
  const stored = parseOctal(header.subarray(148, 156), 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i]!;
  }
  if (sum !== stored) {
    throw new DesktopError('tar_header_invalid', `tar 头部校验和不一致（期望 ${stored}，实际 ${sum}）`);
  }
}

/** pax 扩展头记录解析（`<len> key=value\n` 重复结构）。 */
function parsePaxRecords(content: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(' ', offset);
    if (spaceIdx < 0) {
      throw new DesktopError('tar_header_invalid', 'pax 记录缺少长度字段');
    }
    const len = Number.parseInt(content.subarray(offset, spaceIdx).toString('utf8'), 10);
    if (!Number.isInteger(len) || len <= 0 || offset + len > content.length) {
      throw new DesktopError('tar_header_invalid', `pax 记录长度非法: ${len}`);
    }
    const record = content.subarray(spaceIdx + 1, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.endsWith('\n')) {
      const key = record.slice(0, eq);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new DesktopError('tar_header_invalid', 'pax 键非法');
      records[key] = record.slice(eq + 1, -1);
    }
    offset += len;
  }
  return records;
}

function stripTrailingNul(text: string): string {
  return text.replace(/\0+$/, '');
}

/**
 * 条目名 → 目标绝对路径（containment 强校验）。违规抛 tar_entry_escape /
 * tar_entry_prefix / tar_entry_invalid，绝不产出 destDir 之外的路径。
 */
function entryTarget(destDir: string, rawName: string, stripPrefix: string, kind: string): string {
  if (rawName.length === 0) {
    throw new DesktopError('tar_entry_invalid', 'tar 条目名为空');
  }
  if (rawName.includes('\\')) {
    throw new DesktopError('tar_entry_invalid', `tar 条目名含反斜杠（Windows 路径语义不确定，拒绝）: ${rawName}`);
  }
  const normalized = path.posix.normalize(rawName);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new DesktopError('tar_entry_escape', `tar 条目名逃逸目标目录（${kind}）: ${rawName}`);
  }
  let rel: string;
  if (normalized === stripPrefix) {
    rel = '.';
  } else if (normalized.startsWith(`${stripPrefix}/`)) {
    rel = normalized.slice(stripPrefix.length + 1);
  } else {
    throw new DesktopError('tar_entry_prefix', `tar 条目不在 ${stripPrefix}/ 前缀下（非 npm 包布局）: ${rawName}`);
  }
  const target = rel === '.' ? destDir : path.resolve(destDir, rel);
  const containment = path.relative(destDir, target);
  if (containment.startsWith('..') || path.isAbsolute(containment)) {
    throw new DesktopError('tar_entry_escape', `tar 条目路径逃逸（${kind}）: ${rawName}`);
  }
  return target;
}

async function readFull(source: BlockSource, size: number): Promise<Buffer> {
  const out = await source.readExact(size);
  if (out === null) {
    throw new DesktopError('tar_truncated', `tar 流在元数据内容中途结束（size=${size}）`);
  }
  return out;
}

async function skipPadding(source: BlockSource, size: number): Promise<void> {
  await source.skipBytes((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
}

async function writeFileStreaming(source: BlockSource, target: string, size: number, mode: number): Promise<void> {
  mkdirSync(path.dirname(target), { recursive: true });
  const fh = openSync(target, 'w', mode === 0 ? 0o644 : mode);
  let remaining = size;
  try {
    while (remaining > 0) {
      const chunk = await source.readUpTo(Math.min(remaining, 1024 * 1024));
      if (chunk === null) {
        throw new DesktopError('tar_truncated', `tar 流在文件内容中途结束: ${target}`);
      }
      writeSync(fh, chunk, 0, chunk.length);
      remaining -= chunk.length;
    }
  } finally {
    closeSync(fh);
  }
  await skipPadding(source, size);
}

/**
 * 解压 npm tarball（.tgz）到 destDir，剥离 `package/` 根前缀。
 * 返回文件/目录计数；任何结构性问题显式抛 DesktopError。
 */
export async function extractTarGzip(
  tgzPath: string,
  destDir: string,
  partial: Partial<TarExtractOptions> = {},
): Promise<TarExtractResult> {
  const options: TarExtractOptions = { ...DEFAULTS, ...partial };
  const sourceStream = createReadStream(tgzPath);
  const gunzip = createGunzip();
  sourceStream.on('error', (error) => gunzip.destroy(error));
  sourceStream.pipe(gunzip);
  const source = new BlockSource(gunzip[Symbol.asyncIterator]());
  const result: TarExtractResult = { files: 0, directories: 0, totalBytes: 0 };
  let longName: string | null = null;
  let nextPax: Record<string, string> | null = null;
  let globalPax: Record<string, string> = {};
  let headerCount = 0;
  let metadataBytes = 0;

  try {
    mkdirSync(destDir, { recursive: true });
    for (;;) {
      const header = await source.readExact(BLOCK_SIZE);
      if (header === null) throw new DesktopError('tar_truncated', 'tar 缺少结束标记');
      if (header.every((b) => b === 0)) break; // end-of-archive 标记块
      verifyChecksum(header);
      const rawName = stripTrailingNul(header.subarray(0, 100).toString('utf8'));
      const size = parseOctal(header.subarray(124, 136), 'size');
      const typeflag = String.fromCharCode(header[156]!);
      const prefix = stripTrailingNul(header.subarray(345, 500).toString('utf8')).trim();
      const mode = parseOctal(header.subarray(100, 108), 'mode') & 0o777;

      headerCount += 1;
      if (headerCount > options.maxEntries || size > options.maxTotalBytes) throw new DesktopError('tar_size_limit', 'tar 元数据或条目超限');
      if (typeflag === 'g' || typeflag === 'x' || typeflag === 'L') {
        metadataBytes += size;
        if (metadataBytes > Math.min(options.maxTotalBytes, 1024 * 1024)) throw new DesktopError('tar_size_limit', 'tar 扩展元数据超过上限');
      }
      if (typeflag === 'g' || typeflag === 'x') {
        const content = await readFull(source, size);
        const records = parsePaxRecords(content);
        if (typeflag === 'g') globalPax = { ...globalPax, ...records };
        else nextPax = records;
        await skipPadding(source, size);
        continue;
      }
      if (typeflag === 'L') {
        const content = stripTrailingNul((await readFull(source, size)).toString('utf8'));
        longName = content;
        await skipPadding(source, size);
        continue;
      }

      // 条目属性合成：pax 记录 > GNU long* > ustar 头部
      const effective = { ...globalPax, ...(nextPax ?? {}) };
      nextPax = null;
      let name = rawName;
      if (longName !== null) {
        name = longName;
        longName = null;
      } else if (typeof effective['path'] === 'string') {
        name = effective['path'];
      } else if (prefix.length > 0) {
        name = `${prefix}/${rawName}`;
      }
      let entrySize = size;
      if (typeof effective['size'] === 'string') {
        const paxSize = Number.parseInt(effective['size'], 10);
        if (!/^\d+$/.test(effective['size']) || !Number.isSafeInteger(paxSize) || paxSize < 0) {
          throw new DesktopError('tar_header_invalid', `pax size 记录非法: ${effective['size']}`);
        }
        entrySize = paxSize;
      }

      if (result.files + result.directories >= options.maxEntries) {
        throw new DesktopError('tar_entry_limit', `tar 条目数超过上限 ${options.maxEntries}`);
      }
      if (result.totalBytes + entrySize > options.maxTotalBytes) {
        throw new DesktopError('tar_size_limit', `tar 解包总字节超过上限 ${options.maxTotalBytes}`);
      }

      const isDirectory =
        typeflag === '5' || ((typeflag === '0' || typeflag === '\0') && entrySize === 0 && name.endsWith('/'));
      if (isDirectory) {
        if (entrySize !== 0) throw new DesktopError('tar_header_invalid', 'tar 目录不得含文件内容');
        const target = entryTarget(destDir, name.replace(/\/+$/, ''), options.stripPrefix, '目录');
        mkdirSync(target, { recursive: true });
        result.directories += 1;
        await skipPadding(source, entrySize);
        continue;
      }
      if (typeflag === '0' || typeflag === '\0') {
        const target = entryTarget(destDir, name, options.stripPrefix, '文件');
        await writeFileStreaming(source, target, entrySize, mode);
        result.files += 1;
        result.totalBytes += entrySize;
        continue;
      }
      throw new DesktopError(
        'tar_unsupported_type',
        `tar 条目类型不支持（typeflag=${JSON.stringify(typeflag)}，仅文件/目录）: ${name}`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('tar_extract_failed', `tar.gz 解包失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    sourceStream.destroy();
    gunzip.destroy();
  }
}
