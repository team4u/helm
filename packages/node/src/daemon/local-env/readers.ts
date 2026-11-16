/**
 * three class Reader implement (local-env sub- module):TextLineReader(strictly LF cut row),
 * BinaryReader(explicit location read + row scan),DirReader(incremental enumeration + lstat).
 * handle structure side (FileHandleLike / DirHandleLike) supply test inject.
 */

import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { TargetPlatform } from '@helm/protocol';
import { FileError, abortResult, err, isNodeError, ok, toFileError, type Result } from './errors.js';
import { LineScanner, StreamDecoder, type LineScan } from './decode.js';
import { joinTargetPath } from './target-path.js';

// ---------------------------------------------------------------------------
// meta information type
// ---------------------------------------------------------------------------

export type FileKind = 'file' | 'directory' | 'symlink';

export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface TextLine {
  text: string;
  terminated: boolean;
}

// ---------------------------------------------------------------------------
// fs/promises handle most small structure side (test can inject)
// ---------------------------------------------------------------------------

/** fs/promises FileHandle most small structure side (test can inject). */
export interface FileHandleLike {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }>;
  close(): Promise<void>;
}

/** fs/promises DirHandle(opendir return value) most small structure side. */
export interface DirHandleLike {
  read(): Promise<{ name: string } | null>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reader interface
// ---------------------------------------------------------------------------

export interface TextLineReader {
  readLine(signal?: AbortSignal): Promise<Result<TextLine | undefined>>;
  close(): Promise<void>;
}

export interface BinaryReader {
  info(signal?: AbortSignal): Promise<Result<FileInfo>>;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Result<Uint8Array>>;
  scanLines(options: { startLine: number; endLine?: number }, signal?: AbortSignal): Promise<Result<LineScan>>;
  close(): Promise<void>;
}

export interface DirReader {
  next(maxEntries: number, signal?: AbortSignal): Promise<Result<{ entries: FileInfo[]; done: boolean }>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// stats → FileInfo
// ---------------------------------------------------------------------------

function fileKindFromStats(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind | undefined {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return undefined;
}

export function fileInfoFromStats(path: string, stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }): Result<FileInfo> {
  const kind = fileKindFromStats(stats);
  if (!kind) return err(new FileError('invalid', 'Unsupported file type', path));
  return ok({ name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs });
}

const closedResult = (what: string, path: string) => err(new FileError('invalid', `${what} is closed`, path));

/** BinaryReader single time most large read chunk: huge length only by file actual content allocate. */
const BINARY_READ_CHUNK = 1024 * 1024;

// ---------------------------------------------------------------------------
// TextLineReader / BinaryReader / DirReader implement
// ---------------------------------------------------------------------------

/** strictly by LF cut row:Node readline do not report finally one row is otherwise has newline tail. */
export class LocalTextLineReader implements TextLineReader {
  #file: FileHandleLike;
  #path: string;
  #decoder = new StreamDecoder();
  #chunk = new Uint8Array(64 * 1024);
  #byteOffset = 0;
  #buffered = '';
  #ended = false;
  #closed = false;

  constructor(file: FileHandleLike, path: string) {
    this.#file = file;
    this.#path = path;
  }

  async readLine(signal?: AbortSignal): Promise<Result<TextLine | undefined>> {
    const aborted = abortResult(signal, this.#path);
    if (aborted) return aborted;
    if (this.#closed) return err(new FileError('invalid', 'Text line reader is closed', this.#path));
    try {
      for (;;) {
        const newline = this.#buffered.indexOf('\n');
        if (newline !== -1) {
          const text = this.#buffered.slice(0, newline);
          this.#buffered = this.#buffered.slice(newline + 1);
          return ok({ text, terminated: true });
        }
        if (this.#ended) {
          if (this.#buffered.length === 0) return ok(undefined);
          const text = this.#buffered;
          this.#buffered = '';
          return ok({ text, terminated: false });
        }
        // explicit location read: abort after retry will not skip byte.
        const { bytesRead } = await this.#file.read(this.#chunk, 0, this.#chunk.length, this.#byteOffset);
        const afterReadAbort = abortResult(signal, this.#path);
        if (afterReadAbort) return afterReadAbort;
        this.#byteOffset += bytesRead;
        if (bytesRead === 0) {
          this.#buffered += this.#decoder.decode();
          this.#ended = true;
        } else {
          this.#buffered += this.#decoder.decode(this.#chunk.subarray(0, bytesRead));
        }
      }
    } catch (error) {
      return err(toFileError(error, this.#path));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = '';
    try {
      await this.#file.close();
    } catch {
      // close is exhaust force while is, including cancel after or early before I/O failed after.
    }
  }
}

export class LocalBinaryReader implements BinaryReader {
  #file: FileHandleLike;
  #path: string;
  #closed = false;

  constructor(file: FileHandleLike, path: string) {
    this.#file = file;
    this.#path = path;
  }

  async info(signal?: AbortSignal): Promise<Result<FileInfo>> {
    const aborted = abortResult(signal, this.#path);
    if (aborted) return aborted;
    if (this.#closed) return closedResult('Binary reader', this.#path);
    try {
      return fileInfoFromStats(this.#path, await this.#file.stat());
    } catch (error) {
      return err(toFileError(error, this.#path));
    }
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Result<Uint8Array>> {
    const aborted = abortResult(signal, this.#path);
    if (aborted) return aborted;
    if (this.#closed) return closedResult('Binary reader', this.#path);
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0
    ) {
      return err(
        new FileError('invalid', 'Offset and length must be non-negative safe integers', this.#path),
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < length) {
        const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK));
        const { bytesRead } = await this.#file.read(chunk, 0, chunk.length, offset + total);
        const afterReadAbort = abortResult(signal, this.#path);
        if (afterReadAbort) return afterReadAbort;
        if (bytesRead === 0) break;
        chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
    } catch (error) {
      return err(toFileError(error, this.#path));
    }
    if (chunks.length === 1) return ok(chunks[0]!);
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    return ok(bytes);
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    signal?: AbortSignal,
  ): Promise<Result<LineScan>> {
    const aborted = abortResult(signal, this.#path);
    if (aborted) return aborted;
    if (this.#closed) return closedResult('Binary reader', this.#path);
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.#path));
    }
    const chunk = new Uint8Array(64 * 1024);
    try {
      for (let position = 0; ; ) {
        const { bytesRead } = await this.#file.read(chunk, 0, chunk.length, position);
        const afterReadAbort = abortResult(signal, this.#path);
        if (afterReadAbort) return afterReadAbort;
        if (bytesRead === 0) return ok(scanner.finish());
        scanner.push(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    } catch (error) {
      return err(toFileError(error, this.#path));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#file.close().catch(() => undefined);
  }
}

export class LocalDirReader implements DirReader {
  #dir: DirHandleLike;
  #path: string;
  #platform: TargetPlatform;
  #done = false;
  #closed = false;

  constructor(dir: DirHandleLike, path: string, platform: TargetPlatform) {
    this.#dir = dir;
    this.#path = path;
    this.#platform = platform;
  }

  async next(maxEntries: number, signal?: AbortSignal): Promise<Result<{ entries: FileInfo[]; done: boolean }>> {
    const aborted = abortResult(signal, this.#path);
    if (aborted) return aborted;
    if (this.#closed) return closedResult('Directory reader', this.#path);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.#path));
    }
    const entries: FileInfo[] = [];
    try {
      while (!this.#done && entries.length < maxEntries) {
        const entry = await this.#dir.read();
        if (entry === null) {
          this.#done = true;
          break;
        }
        const loopAbort = abortResult(signal, this.#path);
        if (loopAbort) return loopAbort;
        const entryPath = joinTargetPath(this.#platform, this.#path, entry.name);
        let stats;
        try {
          stats = await lstat(entryPath);
        } catch (error) {
          // enumeration to lstat between disappear item: no longer is list one part.
          if (isNodeError(error) && error.code === 'ENOENT') continue;
          return err(toFileError(error, entryPath));
        }
        const info = fileInfoFromStats(entryPath, stats);
        if (info.ok) entries.push(info.value);
      }
      return ok({ entries, done: this.#done });
    } catch (error) {
      return err(toFileError(error, this.#path));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#dir.close().catch(() => undefined);
  }
}
