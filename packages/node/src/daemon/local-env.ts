/**
 * 零外部依赖的本机执行环境：仅用 Node.js 内置模块实现
 * `NodeEnvRpcFunctions` 所需的文件系统与 shell 能力（本地文件读写、
 * 行扫描、命令执行），语义与 `@earendil-works/pi-durable` 的
 * `NodeExecutionEnv` 1.5.0 对齐。与上游的手工同步点由契约测试钉住
 * （test/node-local-env-contract.test.ts：shell 探测结果、128+信号编号
 * 退出码、超时文案、溢写文件完整性、流式解码与行扫描口径）。
 *
 * 与 SDK 版本的差异（刻意为之）：
 * - 取消信号直接用原生 `AbortSignal`（不引入 chord 的 Context）；
 * - 不实现 `watch` / `listFiles`（NodeEnvRpcFunctions 不包含文件监听
 *   与递归列举接口；envListFiles 如实返回 not_supported）。
 *
 * 所有文件系统与进程错误如实映射为 FileError / ExecutionError
 * （code 对齐 @helm/protocol 的 RpcFileErrorCode / RpcExecutionErrorCode），
 * 绝不静默降级或伪造结果。
 *
 * 实现按职责拆分为 local-env/ 子模块，本文件是组合根（LocalExecutionEnv
 * 编排各原语）与公共 API 门面：
 * - local-env/errors.ts：Result 信封、FileError / ExecutionError 与错误映射；
 * - local-env/decode.ts：StreamDecoder / LineScanner（对齐 pi-durable
 *   decode.ts / line-scan.ts）；
 * - local-env/readers.ts：TextLine / Binary / Dir 三类 Reader 与 FileInfo；
 * - local-env/shell.ts：shell 定位（含 WSL legacy）、进程树终止、exec
 *   选项类型与环境组装（对齐 pi coding-agent shell.ts）；
 * - local-env/target-path.ts：resolveTargetPath 统一目标路径解析原语。
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
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { ShellProbeIo } from '@helm/env-io';
import { targetPlatformOf, type TargetPlatform } from '@helm/protocol';
import { ExecutionError, FileError, abortResult, err, isNodeError, ok, toError, toFileError, type Result } from './local-env/errors.js';
import { StreamDecoder } from './local-env/decode.js';
import {
  LocalBinaryReader,
  LocalDirReader,
  LocalTextLineReader,
  fileInfoFromStats,
  type BinaryReader,
  type DirReader,
  type FileHandleLike,
  type FileInfo,
  type TextLineReader,
} from './local-env/readers.js';
import {
  SPILL_HIGH_WATER_MARK,
  getShellConfig,
  getShellEnv,
  killProcessTree,
  resolveTimeoutMs,
  waitForChildProcess,
  type ChildProcessLike,
  type ShellExecOptions,
  type ShellExecResult,
} from './local-env/shell.js';
import { joinTargetPath, parentTargetPath, resolveTargetPath } from './local-env/target-path.js';

// 公共 API 门面：保持与拆分前完全一致的导出面（消费方统一从本文件导入）。
export type { Result, FileErrorCode, ExecutionErrorCode } from './local-env/errors.js';
export { FileError, ExecutionError, ok, err } from './local-env/errors.js';
export type { LineScan } from './local-env/decode.js';
export { StreamDecoder, LineScanner } from './local-env/decode.js';
export type {
  FileKind,
  FileInfo,
  TextLine,
  TextLineReader,
  BinaryReader,
  DirReader,
  FileHandleLike,
  DirHandleLike,
} from './local-env/readers.js';
export type {
  ShellSpillOptions,
  ShellOutputSkip,
  ShellOutputInfo,
  ShellExecOptions,
  ShellExecResult,
} from './local-env/shell.js';
export { isManagedHelmEnvKey, killProcessTree } from './local-env/shell.js';
export { resolveTargetPath } from './local-env/target-path.js';

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
  /** 测试注入口：覆写 Shell 探测 I/O（生产不传）。 */
  shellProbeIo?: ShellProbeIo;
}

export class LocalExecutionEnv {
  /** 所有本机环境看到相同的文件。 */
  readonly id = 'node:local';
  cwd: string;
  #shellPath?: string;
  #shellEnv?: NodeJS.ProcessEnv;
  #platform: TargetPlatform;
  #shellProbeIo?: ShellProbeIo;
  #activeChildPids = new Set<number>();

  constructor(options: LocalExecutionEnvOptions) {
    this.cwd = options.cwd;
    this.#shellPath = options.shellPath;
    this.#shellEnv = options.shellEnv;
    this.#platform = targetPlatformOf(options.platform ?? process.platform);
    this.#shellProbeIo = options.shellProbeIo;
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
      const shellConfig = await getShellConfig(this.#shellPath, this.#shellProbeIo);
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
