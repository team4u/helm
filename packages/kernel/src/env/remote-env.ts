/**
 * remote execute environment: pi-durable `ExecutionEnv`(FileSystem + Shell) each
 * operation translate is for node side `NodeEnvRpcFunctions` invoke.
 *
 * key semantics (honest discipline):
 * - reader with readerId handle bridge;close idempotent and do not because connect expires suspended;
 * - `exec`  onOutput chunked via ExecOutputHub back put (node streaming push, by execId routing),
 *   instance level output sink on demand register/deregister: first carries onOutput  exec before register to
 *   resolver, finally a in-flight exec end (or cleanup) after deregister - - short lifecycle
 *   instance (envFor path) use after i.e. abandon also without register table leftover;
 * - cancel pass broadcast:context abort when immediately rpc.envAbortExec(execId) let node kill die the
 *   command the whole child process tree, do not etc. command self however end;
 * - remote node offline and resolver support while waiting, block wait for reconnect (can cancel);
 *   **never back to local**- - remote (nodeId, cwd) path only in target node on has intent meaning;
 * - connect lose (exec already after start disconnect): command result unknown. with `unknown` error explicit
 *   report (do not automatically retry), never static default replay do not security shell(external side effect cannot replay).
 */

import type { Context } from '@earendil-works/chord/context'
import {
  ExecutionError,
  FileError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileListing,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchTarget,
  type FileWatcher,
  type FileChange,
} from '@earendil-works/pi-durable/env'
import type { EnvExecOutputEvent, NodeEnvRpcFunctions, RpcEnvError, RpcResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ExecOutputHub } from './exec-output.js'

/** by nodeId parse node env RPC(by fabric connect register table connect line). */
export interface NodeRpcResolver {
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined
  /**
   * remote offline resilience: node offline when wait for reconnect (respect context cancel); cannot wait for
   * (not provide) when caller immediately failed. cancel when return undefined.
   */
  waitForNodeOnline?(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions | undefined>
  /** instance level output sink register (by exec lifecycle self manage; without then the instance output
   *  do not routing - - only when without streaming requirement internal construct use). */
  addOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
  removeOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
}

export interface RemoteExecutionEnvOptions {
  nodeId: string
  cwd: string
  /**
   * file operation parse RPC connect wait for cap (milli second), default 30s: file operation may run in
   * withFileMutationQueue hold lock window inside, unbounded etc. reconnect will freeze the file all queue up
   *(other conversation/plugin) direct until hold lock turn by abort; timeout throw node_offline release lock.
   * exec do not subject to limit (long command wait for reconnect by caller context cancel semantics manage).
   */
  rpcWaitTimeoutMs?: number
}

/** #call file operation parse RPC default wait for cap. */
const DEFAULT_RPC_WAIT_TIMEOUT_MS = 30_000

const fileError = (error: RpcEnvError, path?: string): FileError =>
  new FileError(error.code as FileError['code'], error.message, path)

// node upgrade arrange empty refuse new (envExec return node_draining):pi-durable 
// ExecutionError/FileError join together (external package) cannot bear load node state code, along use since has
// runtime pass-through policy (and connect_failed same):code original keep in error object on,
// message carry complete diagnose - - on layer (such as tools.ts  shell tag) can based on this
// node is now upgrade arrange empty and aborted(cancel)/unknown(assert connect result unknown) zone,
// never archive and is aborted, also does not trigger without sound retry/wait for reconnect.

const execErrorFromRpc = (error: RpcEnvError): ExecutionError => {
  const e = new ExecutionError(error.code as ExecutionError['code'], error.message)
  if (error.spillPath !== undefined) e.spillPath = error.spillPath
  return e
}

const unwrapFile = <T>(result: RpcResult<T>, path?: string): Result<T, FileError> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, error: fileError(result.error, path) }

const voidOk: Result<void, FileError> = { ok: true, value: undefined }

const lostMessage = (nodeId: string, error: unknown): string =>
  `node ${nodeId} connect interrupt, operation result unknown (do not automatically retry):${error instanceof Error ? error.message : String(error)}`

let execSeq = 0

export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  readonly #resolver: NodeRpcResolver
  readonly #outputHub: ExecOutputHub
  readonly #nodeIdValue: string
  readonly #rpcWaitTimeoutMs: number
  #sinkRegistered = false
  #liveExecsWithOutput = 0

  constructor(resolver: NodeRpcResolver, options: RemoteExecutionEnvOptions, outputHub = new ExecOutputHub()) {
    this.#resolver = resolver
    this.cwd = options.cwd
    this.id = `remote:${options.nodeId}`
    this.#nodeIdValue = options.nodeId
    this.#outputHub = outputHub
    this.#rpcWaitTimeoutMs = options.rpcWaitTimeoutMs ?? DEFAULT_RPC_WAIT_TIMEOUT_MS
  }

  /** sink register/deregister by in-flight exec counter: first carries onOutput  exec register, finally a
   *  after end deregister - - instance (contains envFor short lifecycle object) leaves no residue register table strong reference. */
  #acquireSink(): void {
    this.#liveExecsWithOutput += 1
    if (!this.#sinkRegistered && this.#resolver.addOutputSink !== undefined) {
      this.#resolver.addOutputSink(this.#nodeIdValue, this.onEnvExecOutput)
      this.#sinkRegistered = true
    }
  }

  #releaseSink(): void {
    this.#liveExecsWithOutput = Math.max(0, this.#liveExecsWithOutput - 1)
    if (this.#liveExecsWithOutput === 0 && this.#sinkRegistered) {
      this.#resolver.removeOutputSink?.(this.#nodeIdValue, this.onEnvExecOutput)
      this.#sinkRegistered = false
    }
  }

  /** node side streaming call back entry (fabric register to register table by node routing). */
  get onEnvExecOutput(): (event: EnvExecOutputEvent) => void {
    return this.#outputHub.onEnvExecOutput
  }

  get outputHub(): ExecOutputHub {
    return this.#outputHub
  }

  /** acquire online node RPC; offline and can while waiting first wait for (wait for during context cancel → undefined). */
  async #rpc(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpc = this.#resolver.getNodeEnvRpc(this.#nodeIdValue)
    if (rpc !== undefined) return rpc
    const wait = this.#resolver.waitForNodeOnline
    if (wait !== undefined) {
      const restored = await wait(this.#nodeIdValue, context)
      if (restored !== undefined) return restored
      throw new Error(`wait for node ${this.#nodeIdValue} enable already by cancel`)
    }
    throw new Error(`node ${this.#nodeIdValue} offline`)
  }

  /**
   * reader across proxy security: handle bind set create when RPC proxy. node reconnect after new proxy may re- use the same
   * readerId ordinal (such as r1 points to another file) - - never can old handle to new proxy mistakenly read
   * other file. each time read/info/next/close all validate original proxy rpc still is when before proxy,
   * expires i.e. report unknown/invalid(do not replay, do not across proxy re- use).
   */
  #staleReaderError(path: string): FileError {
    return new FileError(
      'unknown',
      `node ${this.#nodeIdValue} connect already replace,reader handle which belong proxy already final (do not across proxy re- use):${path}`,
      path,
    )
  }

  /** original proxy rpc is otherwise still is when before proxy (false = already by top replace/disconnect, handle all expires). */
  #isCurrentRpc(rpc: NodeEnvRpcFunctions): boolean {
    return this.#resolver.getNodeEnvRpc(this.#nodeIdValue) === rpc
  }

  /**
   * file operation entry RPC parse (#call dedicated use): wait for reconnect has boundary (rpcWaitTimeoutMs).
   * without boundary wait for in hold lock window inside will file queue freeze to hold lock turn by abort; timeout throw
   * node_offline(lock follow exception release), node reconnect after caller can explicit retry.
   */
  async #rpcBounded(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpcPromise = this.#rpc(context)
    // timeout first until when rpcPromise still may in etc.:observe guard against not handle rejection.
    rpcPromise.catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        rpcPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new HelmError(
              'node_offline',
              `node ${this.#nodeIdValue} offline, wait for reconnect exceeds ${this.#rpcWaitTimeoutMs}ms(file operation do not unbounded wait for)`,
              409,
              { nodeId: this.#nodeIdValue },
            ))
          }, this.#rpcWaitTimeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** RPC invoke wrap: node lose join (connect disconnect throws) archive one is result unknown. */
  async #call<T>(
    fn: (rpc: NodeEnvRpcFunctions) => Promise<RpcResult<T>>,
    context: Context,
    path?: string,
  ): Promise<Result<T, FileError>> {
    const rpc = await this.#rpcBounded(context)
    try {
      return unwrapFile(await fn(rpc), path)
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      throw new Error(lostMessage(this.#nodeIdValue, error))
    }
  }

  // ---- FileSystem -----------------------------------------------------------

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envAbsolutePath({ path, cwd: this.cwd }), context, path)
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envJoinPath({ parts, cwd: this.cwd }), context)
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envReadTextFile({ path, cwd: this.cwd }), context, path)
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.#call((rpc) => rpc.envReadTextLines({ path, maxLines: options?.maxLines, cwd: this.cwd }), context, path)
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const rpc = await this.#rpc(context)
    let readerId: string
    try {
      const result = await rpc.envOpenTextLineReader({ path, cwd: this.cwd })
      if (!result.ok) return unwrapFile(result, path)
      readerId = result.value.readerId
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      throw new Error(lostMessage(this.#nodeIdValue, error))
    }
    return {
      ok: true,
      value: {
        readLine: async () => {
          // across proxy validate: old handle do not to new proxy (new proxy same name readerId is another file).
          if (!this.#isCurrentRpc(rpc)) return { ok: false, error: this.#staleReaderError(path) }
          let read: Awaited<ReturnType<typeof rpc.envTextReaderRead>>
          try {
            read = await rpc.envTextReaderRead({ readerId })
          } catch (error) {
            if (context.abortSignal?.aborted) throw error
            throw new Error(lostMessage(this.#nodeIdValue, error))
          }
          if (!read.ok) return unwrapFile(read, path)
          return read.value === null ? { ok: true, value: undefined } : { ok: true, value: read.value }
        },
        close: async () => {
          try {
            if (this.#isCurrentRpc(rpc)) await rpc.envTextReaderClose({ readerId })
          } catch {
            // connect already expires: node side reader lifecycle and connect bind set, on disconnect unify reclaim.
          }
        },
      },
    }
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await this.#call((rpc) => rpc.envReadBinaryFile({ path, cwd: this.cwd }), context, path)
    if (!result.ok) return result
    return { ok: true, value: new Uint8Array(Buffer.from(result.value.base64, 'base64')) }
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const rpc = await this.#rpc(context)
    let readerId: string
    try {
      const result = await rpc.envOpenBinaryReader({ path, noFollow: options?.noFollow, cwd: this.cwd })
      if (!result.ok) return unwrapFile(result, path)
      readerId = result.value.readerId
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      throw new Error(lostMessage(this.#nodeIdValue, error))
    }
    // across proxy validate: each time invoke before confirm original proxy rpc still is when before proxy (old handle do not to new proxy).
    const guard = (): FileError | undefined =>
      this.#isCurrentRpc(rpc) ? undefined : this.#staleReaderError(path)
    const call = <T>(fn: (r: string) => Promise<RpcResult<T>>): Promise<Result<T, FileError>> => {
      const stale = guard()
      if (stale !== undefined) return Promise.resolve({ ok: false, error: stale })
      return fn(readerId)
        .catch((error: unknown) => {
          throw new Error(lostMessage(this.#nodeIdValue, error))
        })
        .then((r) => unwrapFile(r, path))
    }
    return {
      ok: true,
      value: {
        info: () => call((r) => rpc.envBinaryReaderInfo({ readerId: r })),
        read: (offset: number, length: number) =>
          call((r) => rpc.envBinaryReaderRead({ readerId: r, offset, length })).then((read) =>
            read.ok ? { ok: true, value: new Uint8Array(Buffer.from(read.value.base64, 'base64')) } : read,
          ),
        scanLines: (scan: { startLine: number; endLine?: number }) =>
          call((r) => rpc.envBinaryReaderScanLines({ readerId: r, ...scan })),
        close: async () => {
          try {
            if (this.#isCurrentRpc(rpc)) await rpc.envBinaryReaderClose({ readerId })
          } catch {
            // same on: connect expires when by node side connect level reclaim fall back.
          }
        },
      },
    }
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#write(path, content, false, context)
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#write(path, content, true, context)
  }

  async #write(
    path: string,
    content: string | Uint8Array,
    append: boolean,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const payload =
      typeof content === 'string'
        ? { content, encoding: 'utf8' as const }
        : { content: Buffer.from(content).toString('base64'), encoding: 'base64' as const }
    const result = append
      ? await this.#call((rpc) => rpc.envAppendFile({ path, ...payload, cwd: this.cwd }), context, path)
      : await this.#call((rpc) => rpc.envWriteFile({ path, ...payload, cwd: this.cwd }), context, path)
    return result.ok ? voidOk : result
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const result = await this.#call((rpc) => rpc.envTruncateFile({ path, size, cwd: this.cwd }), context, path)
    return result.ok ? voidOk : result
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    // real forwarding node side envFlushFile: remote fsync semantics by node execute (do not fake succeeded).
    const result = await this.#call((rpc) => rpc.envFlushFile({ path, cwd: this.cwd }), context, path)
    return result.ok ? voidOk : result
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const result = await this.#call(
      (rpc) => rpc.envRenameFile({ sourcePath, destinationPath, cwd: this.cwd }),
      context,
      sourcePath,
    )
    return result.ok ? voidOk : result
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#call((rpc) => rpc.envFileInfo({ path, cwd: this.cwd }), context, path)
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#call((rpc) => rpc.envListDir({ path, cwd: this.cwd }), context, path)
  }

  async listFiles(
    path: string,
    _options: ListFilesOptions | undefined,
    context: Context,
  ): Promise<Result<FileListing, FileError>> {
    const result = await this.#call((rpc) => rpc.envListFiles({ path, cwd: this.cwd }), context, path)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const rpc = await this.#rpc(context)
    let readerId: string
    try {
      const result = await rpc.envOpenDirReader({ path, cwd: this.cwd })
      if (!result.ok) return unwrapFile(result, path)
      readerId = result.value.readerId
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      throw new Error(lostMessage(this.#nodeIdValue, error))
    }
    return {
      ok: true,
      value: {
        next: (maxEntries: number) => {
          // across proxy validate: old handle do not to new proxy (new proxy same name readerId is another directory page cursor).
          if (!this.#isCurrentRpc(rpc)) {
            return Promise.resolve({ ok: false, error: this.#staleReaderError(path) })
          }
          return rpc
            .envDirReaderNext({ readerId, maxEntries })
            .catch((error: unknown) => {
              throw new Error(lostMessage(this.#nodeIdValue, error))
            })
            .then((r) => unwrapFile(r, path))
        },
        close: async () => {
          try {
            if (this.#isCurrentRpc(rpc)) await rpc.envDirReaderClose({ readerId })
          } catch {
            // connect expires: node side connect level reclaim fall back.
          }
        },
      },
    }
  }

  async watch(
    _targets: readonly WatchTarget[],
    _onChange: (change: FileChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    // remote watch exceeds protocol scope: explicit errors (not_supported), never return
    // false watcher(that will let host with is already establish listen while forever fewer than event).
    return { ok: false, error: new FileError('not_supported', 'Remote env watch is not supported over RPC') }
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envCanonicalPath({ path, cwd: this.cwd }), context, path)
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.#call((rpc) => rpc.envExists({ path, cwd: this.cwd }), context, path)
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.#call(
      (rpc) => rpc.envCreateDir({ path, recursive: options?.recursive, cwd: this.cwd }),
      context,
      path,
    )
    return result.ok ? voidOk : result
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.#call(
      (rpc) => rpc.envRemove({ path, recursive: options?.recursive, force: options?.force, cwd: this.cwd }),
      context,
      path,
    )
    return result.ok ? voidOk : result
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envCreateTempDir({ prefix, cwd: this.cwd }), context)
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.#call((rpc) => rpc.envCreateTempFile({ prefix: options?.prefix, suffix: options?.suffix, cwd: this.cwd }), context)
  }

  async cleanup(_context: Context): Promise<void> {
    // instance clean up only deregister itself sink(self manage lifecycle); never send by cwd 
    // envCleanup- - node side envCleanup will kill same cwd under**other conversation**in-flight
    // command (cwd is not conversation isolated key). in-flight command terminate by caller context abort
    // (envAbortExec by execId precise kill) or connect disconnect node side connect level dispose
    // fall back.
    this.#liveExecsWithOutput = 0
    if (this.#sinkRegistered) {
      this.#resolver.removeOutputSink?.(this.#nodeIdValue, this.onEnvExecOutput)
      this.#sinkRegistered = false
    }
  }

  // ---- Shell -----------------------------------------------------------------

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError('aborted', 'Command aborted') }
    }
    let rpc: NodeEnvRpcFunctions
    try {
      rpc = await this.#rpc(context)
    } catch {
      return {
        ok: false,
        error:
          context.abortSignal?.aborted
            ? new ExecutionError('aborted', 'wait for node enable when cancel')
            : new ExecutionError('unknown', `node ${this.#nodeIdValue} offline`),
      }
    }
    const execId = `exec-${++execSeq}-${Math.random().toString(36).slice(2, 8)}`
    const onOutput = options?.onOutput
    if (onOutput !== undefined) {
      this.#acquireSink()
      this.#outputHub.subscribe(execId, (event) => {
        onOutput(event.text, context, {
          stream: event.stream,
          ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
        })
      })
    }
    const signal = context.abortSignal
    const onAbort = () => {
      void rpc.envAbortExec(execId).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await rpc.envExec({
        execId,
        command,
        // one by one invoke cwd takes precedence (pi-durable Shell semantics); default use env itself cwd.
        cwd: options?.cwd ?? this.cwd,
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options?.spill === undefined ? {} : { spill: options.spill }),
        ...(options?.window === undefined ? {} : { window: options.window }),
      })
      if (context.abortSignal?.aborted) {
        return { ok: false, error: new ExecutionError('aborted', 'Command aborted') }
      }
      if (result.ok) {
        return {
          ok: true,
          value: {
            exitCode: result.value.exitCode,
            ...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }),
          },
        }
      }
      return { ok: false, error: execErrorFromRpc(result.error) }
    } catch (error) {
      // cancel quote connect exception archive one is aborted; otherwise is connect lose - - command already in node
      // start, result unknown: explicit errors and never automatically retry (do not security shell replay will
      // for external world duplicate side effect).
      if (context.abortSignal?.aborted) {
        return { ok: false, error: new ExecutionError('aborted', 'Command aborted') }
      }
      return { ok: false, error: new ExecutionError('unknown', lostMessage(this.#nodeIdValue, error)) }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.#outputHub.unsubscribe(execId)
      if (onOutput !== undefined) this.#releaseSink()
    }
  }

  /** cancel designate run in command (pass-through node side envAbortExec). */
  async abortExec(execId: string, context: Context): Promise<void> {
    await (await this.#rpc(context)).envAbortExec(execId)
  }
}
