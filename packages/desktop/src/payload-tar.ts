/**
 * most small security tar.gz unwrap (pure Node zero dependency): for npm package tarball(ustar + pax extend head +
 * GNU longname), streaming decompress, force three heavy guard against line:
 * 1. item name containment: reject absolute path / `..` through exceeds / backslash (Windows semantics uncertain)/
 *    non- `package/` prefix (npm package layout iron rule);
 * 2. type blank name single: only file / directory; link, device file and FIFO explicit reject;
 * 3. cap: item count and unwrap total byte seal top (guard against decompress bomb).
 * any violate rule explicit throw DesktopError(tar_*), never static default skip.
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
  /** npm tarball prefix (npm pack layout constant is package/). */
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

/** on demand pull can buffer byte source (async iterate day however back press, avoid whole package resident memory). */
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

  /** exactly n byte (across chunk aggregate); stream mention before end return null. */
  async readExact(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n) {
      if (!(await this.fill())) return null;
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** at most n byte (at least 1 byte available); stream end return null. */
  async readUpTo(n: number): Promise<Buffer | null> {
    if (this.buffer.length === 0 && !(await this.fill())) return null;
    const take = Math.min(n, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  /** discard n byte; stream mention before end throw tar_truncated. */
  async skipBytes(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.readUpTo(Math.min(remaining, BLOCK_SIZE * 2));
      if (chunk === null) {
        throw new DesktopError('tar_truncated', 'tar stream in item content in route end (file corrupt or truncate)');
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
    throw new DesktopError('tar_header_invalid', `tar header ${what} field is not legal eight enter system: ${JSON.stringify(text)}`);
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
    throw new DesktopError('tar_header_invalid', `tar header validate and inconsistent (expectation ${stored}, actual ${sum})`);
  }
}

/** pax extend head record parse (`<len> key=value\n` duplicate structure). */
function parsePaxRecords(content: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(' ', offset);
    if (spaceIdx < 0) {
      throw new DesktopError('tar_header_invalid', 'pax record missing length field');
    }
    const len = Number.parseInt(content.subarray(offset, spaceIdx).toString('utf8'), 10);
    if (!Number.isInteger(len) || len <= 0 || offset + len > content.length) {
      throw new DesktopError('tar_header_invalid', `pax record length illegal: ${len}`);
    }
    const record = content.subarray(spaceIdx + 1, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.endsWith('\n')) {
      const key = record.slice(0, eq);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new DesktopError('tar_header_invalid', 'pax key illegal');
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
 * item name → target absolute path (containment strong validate). violate rule throw tar_entry_escape /
 * tar_entry_prefix / tar_entry_invalid, never produce out destDir of outside path.
 */
function entryTarget(destDir: string, rawName: string, stripPrefix: string, kind: string): string {
  if (rawName.length === 0) {
    throw new DesktopError('tar_entry_invalid', 'tar item name is empty');
  }
  if (rawName.includes('\\')) {
    throw new DesktopError('tar_entry_invalid', `tar item name contains backslash (Windows path semantics uncertain, reject): ${rawName}`);
  }
  const normalized = path.posix.normalize(rawName);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new DesktopError('tar_entry_escape', `tar item name escape target directory (${kind}): ${rawName}`);
  }
  let rel: string;
  if (normalized === stripPrefix) {
    rel = '.';
  } else if (normalized.startsWith(`${stripPrefix}/`)) {
    rel = normalized.slice(stripPrefix.length + 1);
  } else {
    throw new DesktopError('tar_entry_prefix', `tar item do not in ${stripPrefix}/ prefix under (non- npm package layout): ${rawName}`);
  }
  const target = rel === '.' ? destDir : path.resolve(destDir, rel);
  const containment = path.relative(destDir, target);
  if (containment.startsWith('..') || path.isAbsolute(containment)) {
    throw new DesktopError('tar_entry_escape', `tar item path escape (${kind}): ${rawName}`);
  }
  return target;
}

async function readFull(source: BlockSource, size: number): Promise<Buffer> {
  const out = await source.readExact(size);
  if (out === null) {
    throw new DesktopError('tar_truncated', `tar stream in metadata content in route end (size=${size})`);
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
        throw new DesktopError('tar_truncated', `tar stream in file content in route end: ${target}`);
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
 * decompress npm tarball(.tgz) to destDir, strip `package/` prefix.
 * return file/directory counter; any structure issue explicit throw DesktopError.
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
      if (header === null) throw new DesktopError('tar_truncated', 'tar missing end mark record');
      if (header.every((b) => b === 0)) break; // end-of-archive mark record chunk
      verifyChecksum(header);
      const rawName = stripTrailingNul(header.subarray(0, 100).toString('utf8'));
      const size = parseOctal(header.subarray(124, 136), 'size');
      const typeflag = String.fromCharCode(header[156]!);
      const prefix = stripTrailingNul(header.subarray(345, 500).toString('utf8')).trim();
      const mode = parseOctal(header.subarray(100, 108), 'mode') & 0o777;

      headerCount += 1;
      if (headerCount > options.maxEntries || size > options.maxTotalBytes) throw new DesktopError('tar_size_limit', 'tar metadata or item over limit');
      if (typeflag === 'g' || typeflag === 'x' || typeflag === 'L') {
        metadataBytes += size;
        if (metadataBytes > Math.min(options.maxTotalBytes, 1024 * 1024)) throw new DesktopError('tar_size_limit', 'tar extend metadata exceeds cap');
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

      // item property together into:pax record > GNU long* > ustar header
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
          throw new DesktopError('tar_header_invalid', `pax size record illegal: ${effective['size']}`);
        }
        entrySize = paxSize;
      }

      if (result.files + result.directories >= options.maxEntries) {
        throw new DesktopError('tar_entry_limit', `tar item count exceeds cap ${options.maxEntries}`);
      }
      if (result.totalBytes + entrySize > options.maxTotalBytes) {
        throw new DesktopError('tar_size_limit', `tar unwrap total byte exceeds cap ${options.maxTotalBytes}`);
      }

      const isDirectory =
        typeflag === '5' || ((typeflag === '0' || typeflag === '\0') && entrySize === 0 && name.endsWith('/'));
      if (isDirectory) {
        if (entrySize !== 0) throw new DesktopError('tar_header_invalid', 'tar directory must not contains file content');
        const target = entryTarget(destDir, name.replace(/\/+$/, ''), options.stripPrefix, 'directory');
        mkdirSync(target, { recursive: true });
        result.directories += 1;
        await skipPadding(source, entrySize);
        continue;
      }
      if (typeflag === '0' || typeflag === '\0') {
        const target = entryTarget(destDir, name, options.stripPrefix, 'file');
        await writeFileStreaming(source, target, entrySize, mode);
        result.files += 1;
        result.totalBytes += entrySize;
        continue;
      }
      throw new DesktopError(
        'tar_unsupported_type',
        `tar item type unsupported (typeflag=${JSON.stringify(typeflag)}, only file/directory): ${name}`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('tar_extract_failed', `tar.gz unwrap failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    sourceStream.destroy();
    gunzip.destroy();
  }
}
