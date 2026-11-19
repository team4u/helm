/**
 * Thin `@helmx/node` adapter over `@earendil-works/pi-durable/env/node` (`NodeExecutionEnv`).
 *
 * Delegates file I/O, streaming line/binary/directory readers, `StreamDecoder`, `LineScanner`,
 * error types, command execution, spill files, and timeout/signal handling to `NodeExecutionEnv`,
 * while preserving `@helmx/node`-specific guarantees:
 * - `AbortSignal`-based API surface (bridged to `@earendil-works/chord/context`);
 * - deterministic target-platform path resolution via `resolveTargetPath`;
 * - host shell probing via `@helmx/env-io` (`resolveHostShellConfig`), preventing Windows hosts
 *   from implicitly falling back into WSL;
 * - stripping managed identity/scope variables (`HELMX_TOKEN`, `HELMX_EXECUTION_SCOPE`) and
 *   case-safe Windows env-key normalization (`getShellEnv`).
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import {
  ExecutionError,
  FileError,
  LineScanner,
  StreamDecoder,
  err as sdkErr,
  ok as sdkOk,
  toError,
  type BinaryReader as SdkBinaryReader,
  type DirReader as SdkDirReader,
  type ExecutionErrorCode,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type LineScan,
  type Result as SdkResult,
  type ShellExecOptions as SdkShellExecOptions,
  type ShellExecResult,
  type ShellOutputInfo,
  type ShellOutputSkip,
  type ShellSpillOptions,
  type TextLine,
  type TextLineReader as SdkTextLineReader,
} from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import {
  killProcessTree,
  resolveHostShellConfig,
  setEnvEntry,
  type ResolvedShellConfig,
  type ShellProbeIo,
} from '@helmx/env-io';
import { targetPlatformOf, type TargetPlatform } from '@helmx/protocol';
import { resolveTargetPath } from './local-env/target-path.js';

export type Result<T> = SdkResult<T, FileError | ExecutionError>;
export type {
  FileErrorCode,
  ExecutionErrorCode,
  LineScan,
  FileKind,
  FileInfo,
  TextLine,
  ShellSpillOptions,
  ShellOutputSkip,
  ShellOutputInfo,
  ShellExecResult,
};
export { FileError, ExecutionError, StreamDecoder, LineScanner, killProcessTree, resolveTargetPath };

export const ok = <T>(value: T): Result<T> => sdkOk(value);
export const err = <T = never>(error: FileError | ExecutionError): Result<T> => sdkErr(error);

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

export type ShellExecOptions = Omit<SdkShellExecOptions, 'onOutput'> & {
  onOutput?: (text: string, info: ShellOutputInfo) => void;
};

const toContext = (signal?: AbortSignal): Context =>
  signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);

const wrapTextLineReader = (reader: SdkTextLineReader): TextLineReader => ({
  readLine: (signal) => reader.readLine(toContext(signal)),
  close: () => reader.close(BACKGROUND_CONTEXT),
});

const wrapBinaryReader = (reader: SdkBinaryReader): BinaryReader => ({
  info: (signal) => reader.info(toContext(signal)),
  read: (offset, length, signal) => reader.read(offset, length, toContext(signal)),
  scanLines: (options, signal) => reader.scanLines(options, toContext(signal)),
  close: () => reader.close(BACKGROUND_CONTEXT),
});

const wrapDirReader = (reader: SdkDirReader): DirReader => ({
  next: (maxEntries, signal) => reader.next(maxEntries, toContext(signal)),
  close: () => reader.close(BACKGROUND_CONTEXT),
});

/** Resolve host shell configuration wrapped as an `ExecutionError` Result. */
export async function getShellConfig(
  customShellPath: string | undefined,
  io?: ShellProbeIo,
): Promise<Result<ResolvedShellConfig>> {
  const resolved = await resolveHostShellConfig(customShellPath, io);
  return resolved.ok ? ok(resolved.value) : err(new ExecutionError('shell_unavailable', resolved.message));
}

/**
 * Managed identity/scope variables stripped when inheriting host `process.env` into child
 * commands (`HELMX_TOKEN` is the node's own credential; `HELMX_EXECUTION_SCOPE` is per-invocation).
 * Explicit `baseEnv` (`shellEnv`) and caller `extraEnv` still override deliberately.
 */
const MANAGED_INHERIT_STRIP_UPPER = new Set(['HELMX_TOKEN', 'HELMX_EXECUTION_SCOPE']);

/** Returns true for managed identity/scope env keys (case-insensitive). */
export function isManagedHelmxEnvKey(key: string): boolean {
  return MANAGED_INHERIT_STRIP_UPPER.has(key.toUpperCase());
}

/** Build the child process environment map, stripping managed host keys and deduplicating Windows casing. */
export function getShellEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  extraEnv: Record<string, string> | undefined,
  inheritEnv = true,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || isManagedHelmxEnvKey(key)) continue;
      setEnvEntry(merged, key, value, platform);
    }
    for (const [key, value] of Object.entries(baseEnv ?? {})) {
      if (value === undefined) continue;
      setEnvEntry(merged, key, value, platform);
    }
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) continue;
    setEnvEntry(merged, key, value, platform);
  }
  return merged;
}

export interface LocalExecutionEnvOptions {
  cwd: string;
  shellPath?: string;
  shellEnv?: NodeJS.ProcessEnv;
  /**
   * Target platform identifier (defaults to `process.platform`): `win32` enables deterministic
   * POSIX-view normalization via `resolveTargetPath`. For test injection only.
   */
  platform?: string;
  /** Test-only override for host shell probing I/O. */
  shellProbeIo?: ShellProbeIo;
}

export class LocalExecutionEnv {
  /** All local host environments share the same file namespace. */
  readonly id = 'node:local';
  cwd: string;
  readonly #shellPath?: string;
  readonly #shellEnv?: NodeJS.ProcessEnv;
  readonly #platform: TargetPlatform;
  readonly #shellProbeIo?: ShellProbeIo;
  readonly #inner: NodeExecutionEnv;
  readonly #activeRunners = new Set<NodeExecutionEnv>();

  constructor(options: LocalExecutionEnvOptions) {
    this.cwd = options.cwd;
    this.#shellPath = options.shellPath;
    this.#shellEnv = options.shellEnv;
    this.#platform = targetPlatformOf(options.platform ?? process.platform);
    this.#shellProbeIo = options.shellProbeIo;
    this.#inner = new NodeExecutionEnv({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    });
  }

  #resolvePath(path: string): Result<string> {
    return resolveTargetPath(this.cwd, path, this.#platform);
  }

  async #withResolvedPath<T>(
    path: string,
    fn: (resolved: string) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const resolution = this.#resolvePath(path);
    if (!resolution.ok) return resolution;
    return fn(resolution.value);
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

    let resolvedShellPath = this.#shellPath;
    if (typeof command === 'string') {
      const probePlatform = this.#shellProbeIo?.platform ?? process.platform;
      if (probePlatform === 'win32' || this.#shellPath !== undefined || this.#shellProbeIo !== undefined) {
        const shellConfig = await getShellConfig(this.#shellPath, this.#shellProbeIo);
        if (!shellConfig.ok) return shellConfig;
        resolvedShellPath = shellConfig.value.shell;
      }
    }

    try {
      await access(cwd, constants.F_OK);
    } catch (error) {
      const cause = toError(error);
      const origin =
        originalCwd !== undefined && this.#platform === 'win32' && originalCwd !== cwd
          ? ` (resolved from ${originalCwd})`
          : '';
      return err(
        new ExecutionError(
          'spawn_error',
          `Working directory does not exist: ${cwd}${origin}\nCannot execute bash commands.`,
          cause,
        ),
      );
    }

    const runner = new NodeExecutionEnv({
      cwd,
      ...(resolvedShellPath === undefined ? {} : { shellPath: resolvedShellPath }),
    });
    const env = getShellEnv(this.#shellEnv, options?.env, options?.inheritEnv);
    const userOnOutput = options?.onOutput;
    const sdkOptions: SdkShellExecOptions = {
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options?.spill === undefined ? {} : { spill: options.spill }),
      ...(options?.window === undefined ? {} : { window: options.window }),
      env,
      inheritEnv: false,
      ...(userOnOutput === undefined
        ? {}
        : {
            onOutput: (text, _context, info) => {
              userOnOutput(text, info);
            },
          }),
    };
    this.#activeRunners.add(runner);
    try {
      return await runner.exec(command, sdkOptions, toContext(signal));
    } finally {
      this.#activeRunners.delete(runner);
    }
  }

  async openTextLineReader(path: string, signal?: AbortSignal): Promise<Result<TextLineReader>> {
    return this.#withResolvedPath(path, async (resolved) => {
      const result = await this.#inner.openTextLineReader(resolved, toContext(signal));
      return result.ok ? ok(wrapTextLineReader(result.value)) : result;
    });
  }

  async readTextFile(path: string, signal?: AbortSignal): Promise<Result<string>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.readTextFile(resolved, toContext(signal)));
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<string[]>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.readTextLines(resolved, options, toContext(signal)),
    );
  }

  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.readBinaryFile(resolved, toContext(signal)));
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<BinaryReader>> {
    return this.#withResolvedPath(path, async (resolved) => {
      const result = await this.#inner.openBinaryReader(resolved, options, toContext(signal));
      return result.ok ? ok(wrapBinaryReader(result.value)) : result;
    });
  }

  async writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.writeFile(resolved, content, toContext(signal)),
    );
  }

  async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.appendFile(resolved, content, toContext(signal)),
    );
  }

  async truncateFile(path: string, size: number, signal?: AbortSignal): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.truncateFile(resolved, size, toContext(signal)),
    );
  }

  async flushFile(path: string, signal?: AbortSignal): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.flushFile(resolved, toContext(signal)));
  }

  async renameFile(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<Result<void>> {
    const src = this.#resolvePath(sourcePath);
    if (!src.ok) return src;
    const dst = this.#resolvePath(destinationPath);
    if (!dst.ok) return dst;
    return this.#inner.renameFile(src.value, dst.value, toContext(signal));
  }

  async fileInfo(path: string, signal?: AbortSignal): Promise<Result<FileInfo>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.fileInfo(resolved, toContext(signal)));
  }

  async listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[]>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.listDir(resolved, toContext(signal)));
  }

  async openDirReader(path: string, signal?: AbortSignal): Promise<Result<DirReader>> {
    return this.#withResolvedPath(path, async (resolved) => {
      const result = await this.#inner.openDirReader(resolved, toContext(signal));
      return result.ok ? ok(wrapDirReader(result.value)) : result;
    });
  }

  async canonicalPath(path: string, signal?: AbortSignal): Promise<Result<string>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.canonicalPath(resolved, toContext(signal)));
  }

  async exists(path: string, signal?: AbortSignal): Promise<Result<boolean>> {
    return this.#withResolvedPath(path, (resolved) => this.#inner.exists(resolved, toContext(signal)));
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.createDir(resolved, options, toContext(signal)),
    );
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return this.#withResolvedPath(path, (resolved) =>
      this.#inner.remove(resolved, options, toContext(signal)),
    );
  }

  async createTempDir(prefix: string | undefined, signal?: AbortSignal): Promise<Result<string>> {
    return this.#inner.createTempDir(prefix, toContext(signal));
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<string>> {
    return this.#inner.createTempFile(options, toContext(signal));
  }

  /** Terminate all commands currently running in this environment (for shutdown only, never per-request). */
  async cleanup(): Promise<void> {
    const runners = [...this.#activeRunners];
    await Promise.all([
      this.#inner.cleanup(BACKGROUND_CONTEXT),
      ...runners.map((runner) => runner.cleanup(BACKGROUND_CONTEXT)),
    ]);
  }
}
