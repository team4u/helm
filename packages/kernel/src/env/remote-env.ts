/**
 * Remote execution environment: translates each `pi-durable` `ExecutionEnv` (`FileSystem` + `Shell`)
 * operation into a node-side `NodeEnvRpcFunctions` call.
 *
 * Key semantics (honest discipline):
 * - Readers are bridged via `readerId`; `close` is idempotent and never hangs when the connection drops;
 * - `exec` `onOutput` chunks come back via `ExecOutputHub` (node streaming push routed by `execId`),
 *   with instance-level output sinks registered/unregistered on demand: registered before the first `exec`
 *   with `onOutput` and unregistered when the last in-flight `exec` (or `cleanup`) finishes—so short-lived
 *   instances (`envFor` path) leave no leaked references in the registry;
 * - Cancellation propagation: aborting `context` immediately sends `rpc.envAbortExec(execId)` so the node
 *   kills the command's whole process tree instead of waiting for it to finish on its own;
 * - Remote node offline: blocks waiting for reconnect when supported by `resolver` (cancellable),
 *   **never falling back to local**—remote `(nodeId, cwd)` paths are only meaningful on the target node;
 * - Connection lost (disconnect after `exec` started): command outcome is unknown. Reports explicitly via
 *   an `unknown` error (no auto-retry) and never silently replays unsafe shell commands (external side effects cannot be replayed).
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
import type { EnvExecOutputEvent, NodeEnvRpcFunctions, RpcEnvError, RpcResult } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { ExecOutputHub } from './exec-output.js'

/** Resolves a node's env RPC by `nodeId` (wired to fabric's connection registry). */
export interface NodeRpcResolver {
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined
  /**
   * Offline resilience: waits for node reconnect when offline (respects context abort); fails immediately
   * when unprovided. Returns `undefined` on cancellation.
   */
  waitForNodeOnline?(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions | undefined>
  /** Instance-level output sink registration (self-managed per exec lifecycle; omitted only for internal non-streaming stubs). */
  addOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
  removeOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
}

export interface RemoteExecutionEnvOptions {
  nodeId: string
  cwd: string
  /**
   * Cap on waiting for reconnect during file-op RPC resolution (ms), default 30s: file ops may run inside
   * `withFileMutationQueue`'s lock window, where unbounded waiting would freeze the file queue (for other
   * conversations/plugins) until the lock holder's turn is aborted; timing out throws `node_offline` and releases the lock.
   * `exec` is uncapped (long commands manage reconnect waits via caller context cancellation).
   */
  rpcWaitTimeoutMs?: number
}

/** Default reconnect wait cap for `#call` file-op RPC resolution. */
const DEFAULT_RPC_WAIT_TIMEOUT_MS = 30_000

const fileError = (error: RpcEnvError, path?: string): FileError =>
  new FileError(error.code as FileError['code'], error.message, path)

// Node draining for upgrade (`envExec` returns `node_draining`): `pi-durable`'s `ExecutionError`/`FileError`
// union (external package) cannot encode node-level status codes, so keep the raw code on the error object
// via runtime passthrough (same as `connect_failed`) and preserve full diagnostics in `message`—upstream layers
// (e.g. `tools.ts` shell tagging) can distinguish draining from `aborted` (cancelled) and `unknown` (disconnected
// with unknown result) rather than misreporting it as aborted or triggering blind retries/reconnect waits.

const execErrorFromRpc = (error: RpcEnvError): ExecutionError => {
  const e = new ExecutionError(error.code as ExecutionError['code'], error.message)
  if (error.spillPath !== undefined) e.spillPath = error.spillPath
  return e
}

const unwrapFile = <T>(result: RpcResult<T>, path?: string): Result<T, FileError> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, error: fileError(result.error, path) }

const voidOk: Result<void, FileError> = { ok: true, value: undefined }

const lostMessage = (nodeId: string, error: unknown): string =>
  `node ${nodeId} connection lost; operation outcome unknown (not auto-retried): ${error instanceof Error ? error.message : String(error)}`

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

  /** Reference-counted sink registration per in-flight exec: registers on first exec with `onOutput`, unregisters when the last ends (so short-lived `envFor` objects leave no registry refs). */
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

  /** Node streaming callback entrypoint (registered in registry by fabric, routed by node). */
  get onEnvExecOutput(): (event: EnvExecOutputEvent) => void {
    return this.#outputHub.onEnvExecOutput
  }

  get outputHub(): ExecOutputHub {
    return this.#outputHub
  }

  /** Acquire online node RPC; waits when offline if supported (returning `undefined` on context cancellation). */
  async #rpc(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpc = this.#resolver.getNodeEnvRpc(this.#nodeIdValue)
    if (rpc !== undefined) return rpc
    const wait = this.#resolver.waitForNodeOnline
    if (wait !== undefined) {
      const restored = await wait(this.#nodeIdValue, context)
      if (restored !== undefined) return restored
      throw new Error(`cancelled while waiting for node ${this.#nodeIdValue} to come online`)
    }
    throw new Error(`node ${this.#nodeIdValue} is offline`)
  }

  /**
   * Cross-generation reader safety: handles bind to the RPC proxy active at open time. After a node reconnects,
   * the new generation may reuse the same `readerId` ordinals (e.g. `r1` pointing to a different file)—old handles
   * must never read the wrong file on a new generation. Every read/info/next/close checks that the original
   * proxy is still current, failing expired handles with `unknown` (never replayed or reused across generations).
   */
  #staleReaderError(path: string): FileError {
    return new FileError(
      'unknown',
      `node ${this.#nodeIdValue} connection was replaced; reader handle's generation has ended (must not be reused across generations): ${path}`,
      path,
    )
  }

  /** Whether `rpc` is still the active proxy (false = superseded/disconnected, invalidating handles). */
  #isCurrentRpc(rpc: NodeEnvRpcFunctions): boolean {
    return this.#resolver.getNodeEnvRpc(this.#nodeIdValue) === rpc
  }

  /**
   * Bounded RPC resolution for file ops (used only by `#call`): caps reconnect wait to `rpcWaitTimeoutMs`.
   * Unbounded waits inside a mutation lock would freeze the file queue until the holder's turn is aborted;
   * timing out throws `node_offline` (releasing the lock) so callers can retry explicitly once the node returns.
   */
  async #rpcBounded(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpcPromise = this.#rpc(context)
    // Observe `rpcPromise` rejection in case the timeout fires first.
    rpcPromise.catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        rpcPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new HelmxError(
              'node_offline',
              `node ${this.#nodeIdValue} is offline; reconnect wait exceeded ${this.#rpcWaitTimeoutMs}ms (file operations do not wait unboundedly)`,
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

  /** RPC invocation wrapper: connection drops normalize to an explicit unknown-outcome error. */
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
          // Cross-generation check: never send old handles to a new proxy (same readerId would hit a different file).
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
            // Connection already stale: node-side reader lifetime is tied to the connection and reclaimed on disconnect.
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
    // Cross-generation check: verify original RPC is still active before each call (never route old handles to a new generation).
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
            // Same as above: stale connections are reclaimed at connection scope on the node.
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
    // Forwards directly to node-side `envFlushFile`: remote fsync runs on the node (never faked as success).
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
          // Cross-generation check: never send old handles to a new proxy (same readerId would be a different dir cursor).
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
            // Connection stale: reclaimed at connection scope on the node.
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
    // Remote watch is out of protocol scope: fail explicitly (`not_supported`) rather than returning a
    // dummy watcher (which would make callers assume watches are active when events will never arrive).
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
    // Instance cleanup only unregisters its own sink (self-managed lifecycle); never sends cwd-wide
    // `envCleanup`—on the node side that would kill in-flight commands from **other conversations**
    // sharing the cwd (cwd is not a conversation isolation key). In-flight commands terminate via
    // caller context abort (`envAbortExec` by execId) or connection-level cleanup on disconnect.
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
            ? new ExecutionError('aborted', 'cancelled while waiting for node to come online')
            : new ExecutionError('unknown', `node ${this.#nodeIdValue} is offline`),
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
        // Per-call cwd takes precedence (pi-durable Shell semantics); defaults to this env's cwd.
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
      // Connection exceptions caused by cancellation map to `aborted`; otherwise connection loss while
      // the command may already have started on the node reports `unknown` explicitly without auto-retry
      // (unsafe shell replay would duplicate external side effects).
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

  /** Cancel a specific running command (forwards directly to node-side `envAbortExec`). */
  async abortExec(execId: string, context: Context): Promise<void> {
    await (await this.#rpc(context)).envAbortExec(execId)
  }
}
