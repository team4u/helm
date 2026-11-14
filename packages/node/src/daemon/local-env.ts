/**
 * 零外部依赖的本机执行环境：仅用 Node.js 内置模块实现
 * `NodeEnvRpcFunctions` 所需的文件系统与 shell 能力（本地文件读写、
 * 行扫描、命令执行），语义与 `@earendil-works/pi-durable` 的
 * `NodeExecutionEnv` 1.5.0 对齐（已有单测与集成测试覆盖边界行为）。
 *
 * 与 SDK 版本的差异（刻意为之）：
 * - 取消信号直接用原生 `AbortSignal`（不引入 chord 的 Context）；
 * - 不实现 `watch` / `listFiles`（NodeEnvRpcFunctions 不包含文件监听
 *   与递归列举接口；envListFiles 如实返回 not_supported）。
 *
 * 所有文件系统与进程错误如实映射为 FileError / ExecutionError
 * （code 对齐 @helm/protocol 的 RpcFileErrorCode / RpcExecutionErrorCode），
 * 绝不静默降级或伪造结果。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, constants as osConstants, tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import { normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol';

// ---------------------------------------------------------------------------
// Result / 错误类型（code 对齐 @helm/protocol 的 Rpc*ErrorCode）
// ---------------------------------------------------------------------------

export type Result<T> = { ok: true; value: T } | { ok: false; error: FileError | ExecutionError };

export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'unknown';

export type ExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown';

export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly path?: string;
  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FileError';
    this.code = code;
    this.path = path;
  }
}

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  /** 超时/中止时超阈值的完整输出溢写文件路径。 */
  spillPath?: string;
  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <T>(error: FileError | ExecutionError): { ok: false; error: FileError | ExecutionError } => ({
  ok: false,
  error,
});

const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
};

// ---------------------------------------------------------------------------
// 元信息类型
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

export interface LineScan {
  newlines: number;
  start: number;
  end: number;
  firstLineEnd: number;
  lastLineStart: number;
  selectedBytes: number;
  firstLineBytes: number;
}

export interface ShellSpillOptions {
  afterBytes: number;
  afterLines: number;
}

export interface ShellOutputSkip {
  bytes: number;
  newlines: number;
  endsWithNewline: boolean;
}

export interface ShellOutputInfo {
  stream: 'stdout' | 'stderr';
  skipped?: ShellOutputSkip;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** 超时时间（秒）。 */
  timeout?: number;
  onOutput?: (text: string, info: ShellOutputInfo) => void;
  spill?: ShellSpillOptions;
}

export interface ShellExecResult {
  exitCode: number;
  spillPath?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 进程退出后留给 stdio 排空的宽限时间，防孙进程持有 fd 卡死。 */
const EXIT_STDIO_GRACE_MS = 100;
/** 溢写文件写流的高水位。 */
const SPILL_HIGH_WATER_MARK = 1024 * 1024;
/** BinaryReader 单次最大读块：巨大 length 只按文件实际内容分配。 */
const BINARY_READ_CHUNK = 1024 * 1024;

function resolveTimeoutMs(timeout: number | undefined): Result<undefined | number> {
  if (timeout === undefined) return ok(undefined);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'));
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return err(
      new ExecutionError('timeout', `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`),
    );
  }
  return ok(timeoutMs);
}

/** 条目拼接按目标平台词法规则（真实宿主上与 node:path 宿主行为一致，注入测试下保持同一视角）。 */
function joinTargetPath(platform: TargetPlatform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/** 父目录提取按目标平台词法规则（输入已是本原语解析后的规范路径）。 */
function parentTargetPath(platform: TargetPlatform, p: string): string {
  return platform === 'win32' ? win32.dirname(p) : posix.resolve(p, '..');
}

/**
 * 统一目标路径解析原语（file API 与 exec 共用，零探测、零猜测）：
 *
 * - posix 目标：按 node:path posix 规则解析（/mnt/… 是真实路径绝不反向转换，
 *   且与宿主 OS 无关——Windows 宿主注入测试下同样保持纯 POSIX 语义）；
 * - win32 目标：先做 `~` / `file://` 展开，再经 @helm/protocol 的
 *   normalizeTargetPath 统一规范化——/mnt/<盘符>/…（WSL 挂载视图）与
 *   /<盘符>/…（Git Bash / MSYS 盘符根视图）确定性转换为 <大写盘符>:\…
 *   （而非宿主 resolve 误锚出的 <盘符>:\mnt\<盘符>\…），原生 Windows /
 *   UNC / 相对路径仅做词法归一，无盘符 POSIX 根（/home、/tmp、裸 / 等）
 *   显式结构化失败（code 'invalid'），绝不做 access 候选猜测；
 *   相对路径锚定到按同一规则规范化后的会话 cwd（会话 cwd 也可能是
 *   /mnt/<盘符>/… 视图）。
 */
export function resolveTargetPath(cwd: string, path: string, platform: TargetPlatform): Result<string> {
  let normalized = path;
  if (normalized === '~') {
    normalized = homedir();
  } else if (
    normalized.startsWith('~/') ||
    (platform === 'win32' && normalized.startsWith('~\\'))
  ) {
    normalized = joinTargetPath(platform, homedir(), normalized.slice(2));
  } else if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized, { windows: platform === 'win32' });
    } catch {
      // 畸形 URL 保留原样作为普通路径，文件方法维持不抛异常的契约。
    }
  }
  if (platform !== 'win32') {
    // 先用 protocol 的纯 POSIX 规则做词法归一，再只用 posix.resolve 做
    // 目标 cwd 锚定；这样 Windows 宿主不会把盘符/反斜杠规则带入目标路径。
    const normalizedPath = normalizeTargetPath(normalized, 'posix')
    const normalizedCwd = normalizeTargetPath(cwd, 'posix')
    if (!normalizedPath.ok || !normalizedCwd.ok) {
      // normalizeTargetPath('posix') 当前不会失败；保留显式分支以守住
      // protocol 契约，避免未来扩展失败类型时静默继续。
      return err(new FileError('invalid', 'Invalid POSIX target path', path))
    }
    return ok(
      posix.isAbsolute(normalizedPath.path)
        ? posix.resolve(normalizedPath.path)
        : posix.resolve(normalizedCwd.path, normalizedPath.path),
    );
  }
  const normalizedWin = normalizeTargetPath(normalized, 'win32');
  if (!normalizedWin.ok) {
    return err(new FileError('invalid', normalizedWin.reason, path));
  }
  if (win32.isAbsolute(normalizedWin.path)) {
    return ok(win32.resolve(normalizedWin.path));
  }
  const base = normalizeTargetPath(cwd, 'win32');
  if (!base.ok) {
    return err(new FileError('invalid', `会话 cwd 无法解析：${base.reason}`, path));
  }
  return ok(win32.resolve(base.path, normalizedWin.path));
}

function fileKindFromStats(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind | undefined {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return undefined;
}

function fileInfoFromStats(path: string, stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }): Result<FileInfo> {
  const kind = fileKindFromStats(stats);
  if (!kind) return err(new FileError('invalid', 'Unsupported file type', path));
  return ok({ name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs });
}

interface NodeError extends Error {
  code?: string;
  path?: string;
}

const isNodeError = (error: unknown): error is NodeError =>
  error instanceof Error && 'code' in error;

function toFileError(error: unknown, fallbackPath?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  const nodeError = isNodeError(error) ? error : undefined;
  const path = typeof nodeError?.path === 'string' ? nodeError.path : fallbackPath;
  if (nodeError) {
    const message = nodeError.message;
    switch (nodeError.code) {
      case 'ABORT_ERR':
        return new FileError('aborted', message, path, cause);
      case 'ENOENT':
        return new FileError('not_found', message, path, cause);
      case 'EACCES':
      case 'EPERM':
        return new FileError('permission_denied', message, path, cause);
      case 'ENOTDIR':
        return new FileError('not_directory', message, path, cause);
      case 'EISDIR':
        return new FileError('is_directory', message, path, cause);
      case 'EINVAL':
        return new FileError('invalid', message, path, cause);
    }
  }
  return new FileError('unknown', cause.message, path, cause);
}

const abortResult = (signal: AbortSignal | undefined, path?: string) =>
  signal?.aborted ? err(new FileError('aborted', 'aborted', path)) : undefined;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// StreamDecoder / LineScanner（与 pi-durable decode.ts / line-scan.ts 对齐）
// ---------------------------------------------------------------------------

/** 字节范围解码器：BOM 交给调用方处理（ignoreBOM）。 */
function rangeDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

/** 前三字节是否为 UTF-8 BOM。 */
function startsWithBom(firstBytes: Uint8Array): boolean {
  return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/**
 * 按 chunk 解码单个流，结果与整体一次解码完全一致：Node 流式解码器在
 * chunk 边界后的 U+FEFF 处理有缺陷，故关闭 BOM 处理并自行剥离流首标记。
 */
export class StreamDecoder {
  #decoder = rangeDecoder();
  #started = false;
  decode(bytes?: Uint8Array): string {
    const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
    if (this.#started || text === '') return text;
    this.#started = true;
    // U+FEFF 仅编码为 EF BB BF，流首 U+FEFF 即字节序标记。
    return text.startsWith('\ufeff') ? text.slice(1) : text;
  }
}

const NEWLINE = 0x0a;
const lineScanEncoder = new TextEncoder();

const decodedBytes = (text: string): number => (text === '' ? 0 : lineScanEncoder.encode(text).length);

/**
 * 按序喂入文件字节，产出 LineScan：任意大小文件都能在有限内存中扫描。
 * 解码字节数与整体解码相同（流式 WHATWG 解码器）。
 */
export class LineScanner {
  #startLine: number;
  #endLine: number;
  #position = 0;
  #newlines = 0;
  #lineStart = 0;
  #start?: number;
  #end?: number;
  #firstLineEnd?: number;
  #lastLineStart?: number;
  #selectedBytes = 0;
  #firstLineBytes = 0;
  #selection?: TextDecoder;
  #firstLine?: TextDecoder;
  /** 文件首字节：攒满 3 字节后判定是否 BOM。 */
  #head?: number[];
  #bom = false;

  constructor(startLine: number, endLine: number = Number.POSITIVE_INFINITY) {
    if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
      throw new RangeError('Invalid line range');
    }
    if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine)) {
      throw new RangeError('Invalid line range');
    }
    this.#startLine = startLine;
    this.#endLine = endLine;
    if (startLine === 0) this.#begin(0);
  }

  push(chunk: Uint8Array): void {
    if (this.#head !== undefined) {
      const take = Math.min(3 - this.#head.length, chunk.length);
      this.#head.push(...chunk.subarray(0, take));
      if (this.#head.length < 3) return;
      this.#releaseHead();
      chunk = chunk.subarray(take);
    }
    this.#process(chunk);
  }

  #releaseHead(): void {
    const head = Uint8Array.from(this.#head ?? []);
    this.#head = undefined;
    this.#bom = startsWithBom(head);
    this.#process(head);
  }

  #process(chunk: Uint8Array): void {
    const base = this.#position;
    let from = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
      this.#feed(chunk, base, from, index);
      const line = this.#newlines;
      const position = base + index;
      if (line === this.#startLine) this.#endFirstLine(position);
      if (line === this.#endLine - 1) this.#endSelection(position);
      this.#feed(chunk, base, index, index + 1);
      from = index + 1;
      this.#newlines++;
      this.#lineStart = position + 1;
      if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
      if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
    }
    this.#feed(chunk, base, from, chunk.length);
    this.#position += chunk.length;
  }

  finish(): LineScan {
    if (this.#head !== undefined) this.#releaseHead();
    const size = this.#position;
    if (this.#start === undefined) {
      return {
        newlines: this.#newlines,
        start: size,
        end: size,
        firstLineEnd: size,
        lastLineStart: size,
        selectedBytes: 0,
        firstLineBytes: 0,
      };
    }
    if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
    if (this.#end === undefined) this.#endSelection(size);
    return {
      newlines: this.#newlines,
      start: this.#start,
      end: this.#end ?? size,
      firstLineEnd: this.#firstLineEnd ?? size,
      // 超出最后一行的选区以最后一行结束。
      lastLineStart: this.#lastLineStart ?? this.#lineStart,
      selectedBytes: this.#selectedBytes,
      firstLineBytes: this.#firstLineBytes,
    };
  }

  #begin(start: number): void {
    this.#start = start;
    if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
    this.#selection = rangeDecoder();
    this.#firstLine = rangeDecoder();
  }

  #endFirstLine(position: number): void {
    this.#firstLineEnd = position;
    if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
    this.#firstLine = undefined;
  }

  #endSelection(position: number): void {
    this.#end = position;
    if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
    this.#selection = undefined;
  }

  /** 喂 chunk[from, to)（起始于文件偏移 base）给仍打开的选区解码器。 */
  #feed(chunk: Uint8Array, base: number, from: number, to: number): void {
    // 整体解码会丢弃文件首的 BOM。
    if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
    if (to <= from) return;
    const bytes = chunk.subarray(from, to);
    if (this.#selection !== undefined) {
      this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
    }
    if (this.#firstLine !== undefined) {
      this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
    }
  }
}

// ---------------------------------------------------------------------------
// Reader 接口
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

const closedResult = (what: string, path: string) => err(new FileError('invalid', `${what} is closed`, path));

// ---------------------------------------------------------------------------
// TextLineReader / BinaryReader / DirReader 实现
// ---------------------------------------------------------------------------

/** 严格按 LF 切行：Node readline 不报告最后一行是否有换行结尾。 */
class LocalTextLineReader implements TextLineReader {
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
        // 显式位置读：中止后的重试不会跳过字节。
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
      // 关闭是尽力而为，包括取消后或早前 I/O 失败后。
    }
  }
}

class LocalBinaryReader implements BinaryReader {
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

class LocalDirReader implements DirReader {
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
          // 枚举到 lstat 之间消失的条目：不再是列表的一部分。
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

// ---------------------------------------------------------------------------
// shell 定位与进程树终止
// ---------------------------------------------------------------------------

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
  return await new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ stdout: '', status: null });
      return;
    }
    const timeout = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve({ stdout: '', status: null });
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({ stdout, status });
    });
  });
}

async function findBashOnPath(): Promise<string | null> {
  const result = process.platform === 'win32'
    ? await runCommand('where', ['bash.exe'], 5000)
    : await runCommand('which', ['bash'], 5000);
  if (result.status !== 0 || !result.stdout) return null;
  const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
  return firstMatch !== undefined && firstMatch !== '' && (await pathExists(firstMatch)) ? firstMatch : null;
}

/** 与 pi coding-agent shell.ts 保持同步：旧版 WSL bash 启动器需经 stdin 传输命令。 */
function isLegacyWslBashPath(path: string): boolean {
  const normalized = win32.normalize(path).toLowerCase();
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot) {
    if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
    return ['System32', 'Sysnative'].some(
      (directory) => normalized === win32.join(systemRoot, directory, 'bash.exe').toLowerCase(),
    );
  }
  // Windows 目录未知时仅按惯例启动器路径回退。
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): { shell: string; args: string[]; commandTransport: 'stdin' | 'argv' } {
  return isLegacyWslBashPath(shell)
    ? { shell, args: ['-s'], commandTransport: 'stdin' }
    : { shell, args: ['-c'], commandTransport: 'argv' };
}

async function getShellConfig(
  customShellPath: string | undefined,
): Promise<Result<{ shell: string; args: string[]; commandTransport: 'stdin' | 'argv' }>> {
  if (customShellPath) {
    if (await pathExists(customShellPath)) {
      return ok(getBashShellConfig(customShellPath));
    }
    return err(
      new ExecutionError('shell_unavailable', `Custom shell path not found: ${customShellPath}`),
    );
  }
  if (process.platform === 'win32') {
    const candidates: string[] = [];
    const programFiles = process.env['ProgramFiles'];
    if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return ok(getBashShellConfig(candidate));
      }
    }
    const bashOnPath = await findBashOnPath();
    if (bashOnPath) {
      return ok(getBashShellConfig(bashOnPath));
    }
    return err(
      new ExecutionError(
        'shell_unavailable',
        `No bash shell found. Options:\n` +
          `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
          `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
          `  3. Configure an explicit shellPath\n\n` +
          `Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join('\n')}`,
      ),
    );
  }
  if (await pathExists('/bin/bash')) {
    return ok(getBashShellConfig('/bin/bash'));
  }
  const bashOnPath = await findBashOnPath();
  if (bashOnPath) {
    return ok(getBashShellConfig(bashOnPath));
  }
  return ok({ shell: 'sh', args: ['-c'], commandTransport: 'argv' });
}

/**
 * 受管身份变量名（大小写不敏感）剥除清单：宿主 daemon 进程自身的这些
 * 环境变量绝不经继承进入子命令——HELM_TOKEN（节点凭据）、
 * HELM_EXECUTION_SCOPE（执行作用域标记，由 Hub 侧按调用注入最新值）。
 * 静默继承旧值会伪造执行身份/作用域，与内核 buildManagedEnv 的受管
 * 固定覆盖同向；shellEnv（daemon 提供的 HELM_HUB_URL/HELM_DATA_DIR）与
 * 调用方显式 env 不在剥除范围。
 */
const MANAGED_INHERIT_STRIP_UPPER = new Set(['HELM_TOKEN', 'HELM_EXECUTION_SCOPE']);

/** 受管身份变量判定（导出供 env-rpc-server 的继承基底复用；大小写不敏感）。 */
export function isManagedHelmEnvKey(key: string): boolean {
  return MANAGED_INHERIT_STRIP_UPPER.has(key.toUpperCase());
}

function getShellEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  extraEnv: Record<string, string> | undefined,
  inheritEnv = true,
): NodeJS.ProcessEnv {
  if (!inheritEnv) return { ...extraEnv };
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isManagedHelmEnvKey(key)) continue;
    inherited[key] = value;
  }
  return { ...inherited, ...baseEnv, ...extraEnv };
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const child = spawn(
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/F', '/T', '/PID', String(pid)],
        { stdio: 'ignore', detached: true, windowsHide: true },
      );
      // spawn 失败会异步发 error：消费掉避免打崩 Node。
      child.once('error', () => {});
    } catch {
      // 忽略错误。
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已死。
    }
  }
}

interface ChildProcessLike {
  pid?: number;
  stdin: null | { on(event: 'error', listener: (error: Error) => void): void; end(data?: string): boolean };
  stdout: null | (NodeJS.ReadableStream & { pause(): void; resume(): void; destroy(): void });
  stderr: null | (NodeJS.ReadableStream & { pause(): void; resume(): void; destroy(): void });
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

/**
 * 等待子进程收尾：exit 后留 100ms stdio 排空宽限（孙进程持有 fd 时不卡死），
 * spill 流背压期间重新计时；close 或宽限到点即结算。
 */
function waitForChildProcess(
  child: ChildProcessLike,
  spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('end', onStdoutEnd);
      child.stderr?.removeListener('end', onStderrEnd);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
    };
    const finalize = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ code: exitCode, signal: exitSignal });
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize();
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => {
        if (spillIsDraining()) armIdleTimer();
        else finalize();
      }, EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: string | null) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null, signal: string | null) => {
      exitCode = code;
      exitSignal = signal;
      finalize();
    };
    child.stdout?.once('end', onStdoutEnd);
    child.stderr?.once('end', onStderrEnd);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// LocalExecutionEnv
// ---------------------------------------------------------------------------

/** fs/promises FileHandle 的最小结构面（测试可注入）。 */
export interface FileHandleLike {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }>;
  close(): Promise<void>;
}

/** fs/promises DirHandle（opendir 返回值）的最小结构面。 */
export interface DirHandleLike {
  read(): Promise<{ name: string } | null>;
  close(): Promise<void>;
}

const symlinkRefused = (path: string, cause?: Error) =>
  new FileError('invalid', 'Refusing to follow a symbolic link', path, cause);

export interface LocalExecutionEnvOptions {
  cwd: string;
  shellPath?: string;
  shellEnv?: NodeJS.ProcessEnv;
  /**
   * 目标平台标识（缺省 process.platform）：win32 目标启用 protocol
   * normalizeTargetPath 的 POSIX 视图确定性转换；测试注入用，生产不传。
   */
  platform?: string;
}

export class LocalExecutionEnv {
  /** 所有本机环境看到相同的文件。 */
  readonly id = 'node:local';
  cwd: string;
  #shellPath?: string;
  #shellEnv?: NodeJS.ProcessEnv;
  #platform: TargetPlatform;
  #activeChildPids = new Set<number>();

  constructor(options: LocalExecutionEnvOptions) {
    this.cwd = options.cwd;
    this.#shellPath = options.shellPath;
    this.#shellEnv = options.shellEnv;
    this.#platform = targetPlatformOf(options.platform ?? process.platform);
  }

  /** file API 与 exec 共用的目标路径解析原语（见 resolveTargetPath）。 */
  #resolvePath(path: string): Result<string> {
    return resolveTargetPath(this.cwd, path, this.#platform);
  }

  async absolutePath(path: string): Promise<Result<string>> {
    return this.#resolvePath(path);
  }

  async joinPath(parts: string[]): Promise<Result<string>> {
    return ok(join(...parts));
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    signal?: AbortSignal,
  ): Promise<Result<ShellExecResult>> {
    if (signal?.aborted) return err(new ExecutionError('aborted', 'aborted'));
    const timeoutMsResult = resolveTimeoutMs(options?.timeout);
    if (!timeoutMsResult.ok) return timeoutMsResult;
    const timeoutMs = timeoutMsResult.value;
    // win32 目标：options.cwd 与会话 cwd 统一经 resolveTargetPath 解析
    // （/mnt/<盘符>/… 等 POSIX 视图确定性转换，无盘符根显式失败）；
    // posix 目标使用 node:path.posix 语义，避免 Windows 宿主污染目标路径。
    let cwd: string;
    let originalCwd: string | undefined;
    if (options?.cwd !== undefined) {
      originalCwd = options.cwd;
      const resolution = this.#resolvePath(options.cwd);
      if (!resolution.ok) {
        return err(
          new ExecutionError(
            'spawn_error',
            `Invalid working directory: ${options.cwd}\n${resolution.error.message}\nCannot execute bash commands.`,
          ),
        );
      }
      cwd = resolution.value;
    } else if (this.#platform === 'win32') {
      // 会话 cwd 本身可能是 POSIX 视图：经同一原语规范化后再 spawn。
      originalCwd = this.cwd;
      const resolution = this.#resolvePath(this.cwd);
      if (!resolution.ok) {
        return err(
          new ExecutionError(
            'spawn_error',
            `Invalid session cwd: ${this.cwd}\n${resolution.error.message}\nCannot execute bash commands.`,
          ),
        );
      }
      cwd = resolution.value;
    } else {
      cwd = this.cwd;
    }
    // 字符串命令经 shell 执行；参数数组直接执行程序，不经 shell 解析。
    let program: string;
    let args: string[];
    let stdinCommand: string | undefined;
    if (typeof command === 'string') {
      const shellConfig = await getShellConfig(this.#shellPath);
      if (!shellConfig.ok) return shellConfig;
      const commandFromStdin = shellConfig.value.commandTransport === 'stdin';
      program = shellConfig.value.shell;
      args = commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command];
      stdinCommand = commandFromStdin ? command : undefined;
    } else {
      const [first, ...rest] = command;
      if (first === undefined) return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'));
      program = first;
      args = rest;
    }
    try {
      await access(cwd, constants.F_OK);
    } catch (error) {
      const cause = toError(error);
      // win32 目标上解析可能改写了路径：诊断同时保留原始 cwd（options.cwd
      // 或 POSIX 视图的会话 cwd）与解析后 cwd；posix 目标消息保持原样
      // （非 Windows 行为不变）。
      const origin =
        originalCwd !== undefined && this.#platform === 'win32' && originalCwd !== cwd
          ? ` (resolved from ${originalCwd})`
          : '';
      return err(
        new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}${origin}\nCannot execute bash commands.`, cause),
      );
    }
    return await new Promise((resolvePromise) => {
      let settled = false;
      let timedOut = false;
      let callbackError: ExecutionError | undefined;
      let spillError: ExecutionError | undefined;
      let child: ChildProcessLike | undefined;
      let timeoutId: NodeJS.Timeout | undefined;
      const spillPrefix: Uint8Array[] = [];
      let spillPath: string | undefined;
      const spillQueue: Uint8Array[] = [];
      let spillStart: Promise<void> | undefined;
      let spillStream: ReturnType<typeof createWriteStream> | undefined;
      let spillBackpressured = false;
      const onAbort = () => {
        if (child?.pid) killProcessTree(child.pid);
      };
      const failCallback = (error: unknown) => {
        if (callbackError !== undefined) return;
        const cause = toError(error);
        callbackError = new ExecutionError('callback_error', cause.message, cause);
        onAbort();
      };
      // 每个流一个解码器：跨 chunk 劈开的字符在同一流内得以存活。
      const stdoutDecoder = new StreamDecoder();
      const stderrDecoder = new StreamDecoder();
      // exec 结算后不再有输出到达调用方（例如孙进程持有 stdio）。
      const emit = (text: string, stream: 'stdout' | 'stderr') => {
        if (settled || text === '' || options?.onOutput === undefined || callbackError !== undefined) return;
        try {
          options.onOutput(text, { stream });
        } catch (error) {
          failCallback(error);
        }
      };
      // spill 启动前的输出：计入阈值并保留为 spill 前缀。
      let seenBytes = 0;
      let seenNewlines = 0;
      const settle = (result: Result<ShellExecResult>) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (child?.pid) this.#activeChildPids.delete(child.pid);
        resolvePromise(result);
      };
      const pauseOutput = () => {
        child?.stdout?.pause();
        child?.stderr?.pause();
      };
      const resumeOutput = () => {
        if (callbackError !== undefined || spillError !== undefined || timedOut || signal?.aborted || spillBackpressured) return;
        child?.stdout?.resume();
        child?.stderr?.resume();
      };
      const failSpill = (error: unknown) => {
        if (spillError !== undefined) return;
        const cause = toError(error);
        spillError = new ExecutionError('unknown', `Failed to preserve complete shell output: ${cause.message}`, cause);
        spillBackpressured = false;
        onAbort();
      };
      const writeSpill = (chunk: Uint8Array) => {
        if (spillStream === undefined || chunk.length === 0) return;
        if (spillStream.write(chunk) || spillBackpressured) return;
        spillBackpressured = true;
        pauseOutput();
        spillStream.once('drain', () => {
          spillBackpressured = false;
          resumeOutput();
        });
      };
      const startSpill = (chunk: Uint8Array) => {
        if (spillStream !== undefined) {
          writeSpill(chunk);
          return;
        }
        spillQueue.push(chunk);
        if (spillStart !== undefined) return;
        pauseOutput();
        spillStart = (async () => {
          const created = await this.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, signal);
          if (!created.ok) throw created.error;
          spillPath = created.value;
          spillStream = createWriteStream(spillPath, { flags: 'a', highWaterMark: SPILL_HIGH_WATER_MARK });
          spillStream.on('error', failSpill);
          for (const queued of spillQueue) writeSpill(queued);
          spillQueue.length = 0;
        })()
          .then(() => undefined)
          .catch(failSpill)
          .finally(resumeOutput);
      };
      const finishSpill = async (): Promise<void> => {
        await spillStart?.catch(() => undefined);
        const stream = spillStream;
        if (stream === undefined || spillError !== undefined || stream.destroyed) return;
        await new Promise<void>((resolveFinish) => {
          stream.once('error', () => resolveFinish());
          stream.once('finish', resolveFinish);
          stream.end();
        });
      };
      try {
        child = spawn(program, args, {
          cwd,
          detached: process.platform !== 'win32',
          env: getShellEnv(this.#shellEnv, options?.env, options?.inheritEnv),
          stdio: [stdinCommand === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }) as ChildProcessLike;
        if (child.pid) this.#activeChildPids.add(child.pid);
        if (stdinCommand !== undefined) {
          child.stdin?.on('error', () => {});
          child.stdin?.end(stdinCommand);
        }
      } catch (error) {
        const cause = toError(error);
        settle(err(new ExecutionError('spawn_error', cause.message, cause)));
        return;
      }
      timeoutId =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              onAbort();
            }, timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const feed =
        (source: 'stdout' | 'stderr', decoder: StreamDecoder) =>
        (chunk: Buffer) => {
          emit(decoder.decode(chunk), source);
          const spill = options?.spill;
          if (spill === undefined || chunk.length === 0) return;
          if (spillStart !== undefined) {
            startSpill(chunk);
            return;
          }
          seenBytes += chunk.length;
          for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) {
            seenNewlines++;
          }
          const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
          if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
            spillPrefix.push(chunk);
            return;
          }
          for (const prefix of spillPrefix) startSpill(prefix);
          spillPrefix.length = 0;
          startSpill(chunk);
        };
      child.stdout?.on('data', feed('stdout', stdoutDecoder));
      child.stderr?.on('data', feed('stderr', stderrDecoder));
      void waitForChildProcess(child, () =>
        spillError === undefined &&
        spillStart !== undefined &&
        (spillStream === undefined || spillBackpressured),
      ).then(
        async ({ code, signal: exitSignal }) => {
          await finishSpill();
          emit(stdoutDecoder.decode(), 'stdout');
          emit(stderrDecoder.decode(), 'stderr');
          if (callbackError !== undefined) {
            settle(err(callbackError));
            return;
          }
          const interrupted =
            timedOut
              ? new ExecutionError('timeout', `timeout:${options?.timeout}`)
              : signal?.aborted
                ? new ExecutionError('aborted', 'aborted')
                : undefined;
          if (interrupted !== undefined) {
            if (spillPath !== undefined) interrupted.spillPath = spillPath;
            settle(err(interrupted));
            return;
          }
          if (spillError !== undefined) {
            settle(err(spillError));
            return;
          }
          // 被信号杀死（如 OOM killer）的进程无退出码：映射为惯例的
          // 128 + 信号编号，调用方不会误判为成功退出。
          const exitCode =
            code ?? (exitSignal !== null ? 128 + ((osConstants.signals as Record<string, number>)[exitSignal] ?? 0) : 1);
          settle(ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) }));
        },
        (error: Error) => settle(err(new ExecutionError('spawn_error', error.message, error))),
      );
    });
  }

  async openTextLineReader(path: string, signal?: AbortSignal): Promise<Result<TextLineReader>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      const file = await openFile(resolved, 'r');
      const afterOpenAbort = abortResult(signal, resolved);
      if (afterOpenAbort) {
        await file.close().catch(() => undefined);
        return afterOpenAbort;
      }
      return ok(new LocalTextLineReader(file, resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readTextFile(path: string, signal?: AbortSignal): Promise<Result<string>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await readFile(resolved, { encoding: 'utf8', signal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<string[]>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, signal);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(signal);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close();
    }
  }

  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await readFile(resolved, { signal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<BinaryReader>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    const noFollow = options?.noFollow === true;
    let file: FileHandleLike | undefined;
    try {
      let flags = constants.O_RDONLY;
      if (process.platform === 'win32') {
        // Windows 无 O_NOFOLLOW：打开前检查最终组件（非竞态安全）。
        if (noFollow && (await lstat(resolved)).isSymbolicLink()) {
          return err(symlinkRefused(resolved));
        }
      } else {
        // 非阻塞：打开 FIFO 不必等待写入者。
        flags |= constants.O_NONBLOCK;
        if (noFollow) flags |= constants.O_NOFOLLOW;
      }
      file = await openFile(resolved, flags);
      const stats = await file.stat();
      if (!stats.isFile()) {
        await file.close().catch(() => undefined);
        return err(
          stats.isDirectory()
            ? new FileError('is_directory', 'EISDIR: illegal operation on a directory, read', resolved)
            : new FileError('invalid', 'Not a regular file', resolved),
        );
      }
      const afterOpenAbort = abortResult(signal, resolved);
      if (afterOpenAbort) {
        await file.close().catch(() => undefined);
        return afterOpenAbort;
      }
      return ok(new LocalBinaryReader(file, resolved));
    } catch (error) {
      await file?.close().catch(() => undefined);
      // O_NOFOLLOW 把最终组件符号链接报为 ELOOP（部分 BSD 为 EMLINK）。
      if (noFollow && isNodeError(error) && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
        return err(symlinkRefused(resolved, toError(error)));
      }
      return err(toFileError(error, resolved));
    }
  }

  async writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      await mkdir(parentTargetPath(this.#platform, resolved), { recursive: true });
      const afterMkdirAbort = abortResult(signal, resolved);
      if (afterMkdirAbort) return afterMkdirAbort;
      await writeFile(resolved, content, { signal });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      await mkdir(parentTargetPath(this.#platform, resolved), { recursive: true });
      const afterMkdirAbort = abortResult(signal, resolved);
      if (afterMkdirAbort) return afterMkdirAbort;
      await appendFile(resolved, content);
      const afterAppendAbort = abortResult(signal, resolved);
      return afterAppendAbort ?? ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async truncateFile(path: string, size: number, signal?: AbortSignal): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(new FileError('invalid', 'File size must be a non-negative safe integer', resolved));
    }
    let file: FileHandle | undefined;
    try {
      file = await openFile(resolved, 'r+');
      await file.truncate(size);
      const afterTruncateAbort = abortResult(signal, resolved);
      return afterTruncateAbort ?? ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async flushFile(path: string, signal?: AbortSignal): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    let file: FileHandle | undefined;
    try {
      file = await openFile(resolved, 'r+');
      // POSIX 拒绝对目录以写方式打开；Windows 能打开，须显式检查。
      if ((await file.stat()).isDirectory()) {
        return err(new FileError('is_directory', 'Is a directory', resolved));
      }
      await file.sync();
      const afterSyncAbort = abortResult(signal, resolved);
      return afterSyncAbort ?? ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async renameFile(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<Result<void>> {
    const sourceResolution = this.#resolvePath(sourcePath);
    if (!sourceResolution.ok) return sourceResolution;
    const source = sourceResolution.value;
    const destinationResolution = this.#resolvePath(destinationPath);
    if (!destinationResolution.ok) return destinationResolution;
    const destination = destinationResolution.value;
    const aborted = abortResult(signal, destination);
    if (aborted) return aborted;
    try {
      await rename(source, destination);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, source));
    }
  }

  async fileInfo(path: string, signal?: AbortSignal): Promise<Result<FileInfo>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      return fileInfoFromStats(resolved, await lstat(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[]>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const infos: FileInfo[] = [];
      for (const entry of entries) {
        const loopAbort = abortResult(signal, resolved);
        if (loopAbort) return loopAbort;
        const entryPath = joinTargetPath(this.#platform, resolved, entry.name);
        try {
          const info = fileInfoFromStats(entryPath, await lstat(entryPath));
          if (info.ok) infos.push(info.value);
        } catch (error) {
          return err(toFileError(error, entryPath));
        }
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async openDirReader(path: string, signal?: AbortSignal): Promise<Result<DirReader>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      const dir = await opendir(resolved);
      const afterOpenAbort = abortResult(signal, resolved);
      if (afterOpenAbort) {
        await dir.close().catch(() => undefined);
        return afterOpenAbort;
      }
      return ok(new LocalDirReader(dir, resolved, this.#platform));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async canonicalPath(path: string, signal?: AbortSignal): Promise<Result<string>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await realpath(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async exists(path: string, signal?: AbortSignal): Promise<Result<boolean>> {
    const result = await this.fileInfo(path, signal);
    if (result.ok) return ok(true);
    if (result.error.code === 'not_found') return ok(false);
    return err(result.error);
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, signal?: AbortSignal): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      await mkdir(resolved, { recursive: options?.recursive ?? true });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    const resolved = resolution.value;
    const aborted = abortResult(signal, resolved);
    if (aborted) return aborted;
    try {
      await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async createTempDir(prefix: string | undefined, signal?: AbortSignal): Promise<Result<string>> {
    const aborted = abortResult(signal);
    if (aborted) return aborted;
    try {
      const effectivePrefix = prefix ?? 'tmp-';
      return ok(await mkdtemp(join(tmpdir(), effectivePrefix)));
    } catch (error) {
      return err(toFileError(error));
    }
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<string>> {
    const dir = await this.createTempDir('tmp-', signal);
    if (!dir.ok) return dir;
    const filePath = join(dir.value, `${options?.prefix ?? ''}${randomUUID()}${options?.suffix ?? ''}`);
    try {
      await writeFile(filePath, '');
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error, filePath));
    }
  }

  /** 杀掉本环境仍在运行的全部命令（属主停机用，绝非单请求用）。 */
  async cleanup(): Promise<void> {
    for (const pid of this.#activeChildPids) killProcessTree(pid);
    this.#activeChildPids.clear();
  }
}
