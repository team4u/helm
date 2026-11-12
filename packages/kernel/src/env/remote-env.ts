/**
 * 远端执行环境：把 pi-durable `ExecutionEnv`（FileSystem + Shell）的每个
 * 操作翻译为对节点侧 `NodeEnvRpcFunctions` 的调用。
 *
 * 关键语义（诚实性纪律）：
 * - reader 以 readerId 句柄桥接；close 幂等且不因连接失效挂起；
 * - `exec` 把 onOutput 分块经 ExecOutputHub 回放（节点流式推送，按 execId 路由），
 *   实例级输出 sink 按需注册/注销：首个带 onOutput 的 exec 前注册到
 *   resolver，最后一个在途 exec 结束（或 cleanup）后注销——短生命周期
 *   实例（envFor 路径）用后即弃也无注册表残留；
 * - 取消传播：context abort 时立即 rpc.envAbortExec(execId) 让节点杀死该
 *   命令的整棵子进程树，不等命令自然结束；
 * - 远端节点离线且 resolver 支持等待时，阻塞等待重连（可取消）；
 *   **绝不回落到 local**——远端 (nodeId, cwd) 的路径只在目标节点上有意义；
 * - 连接丢失（exec 已开始后断开）：命令结果未知。以 `unknown` 错误显式
 *   报告（不自动重试），绝不静默重放不安全的 shell（外部副作用不可重放）。
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

/** 按 nodeId 解析节点 env RPC（由 fabric 的连接注册表接线）。 */
export interface NodeRpcResolver {
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined
  /**
   * 远端离线韧性：节点离线时等待重连（尊重 context 取消）；不可等待
   * （未提供）时调用方立即失败。取消时返回 undefined。
   */
  waitForNodeOnline?(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions | undefined>
  /** 实例级输出 sink 注册（按 exec 生命周期自管理；无则该实例输出
   *  不路由——仅当无流式需求的内部构造使用）。 */
  addOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
  removeOutputSink?(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void
}

export interface RemoteExecutionEnvOptions {
  nodeId: string
  cwd: string
  /**
   * 文件操作解析 RPC 连接的等待上限（毫秒），缺省 30s：文件操作可能运行在
   * withFileMutationQueue 持锁窗口内，无限等重连会冻结该文件全部排队者
   *（其他会话/插件）直至持锁者 turn 被中止；超时抛出 node_offline 释放锁。
   * exec 不受限（长命令等待重连由调用方 context 取消语义管理）。
   */
  rpcWaitTimeoutMs?: number
}

/** #call 文件操作解析 RPC 的缺省等待上限。 */
const DEFAULT_RPC_WAIT_TIMEOUT_MS = 30_000

const fileError = (error: RpcEnvError, path?: string): FileError =>
  new FileError(error.code as FileError['code'], error.message, path)

// 节点升级排空拒新（envExec 返回 node_draining）：pi-durable 的
// ExecutionError/FileError 联合（外部包）无法承载节点态码，沿用既有
// 运行时透传策略（与 connect_failed 同）：code 原样保留在错误对象上，
// message 携带完整诊断——上层（如 tools.ts 的 shell 标签）可据此把
// 「节点正在升级排空」与 aborted（取消）/unknown（断连结果未知）区分，
// 绝不归并为 aborted，也不触发无声重试/等待重连。

const execErrorFromRpc = (error: RpcEnvError): ExecutionError => {
  const e = new ExecutionError(error.code as ExecutionError['code'], error.message)
  if (error.spillPath !== undefined) e.spillPath = error.spillPath
  return e
}

const unwrapFile = <T>(result: RpcResult<T>, path?: string): Result<T, FileError> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, error: fileError(result.error, path) }

const voidOk: Result<void, FileError> = { ok: true, value: undefined }

const lostMessage = (nodeId: string, error: unknown): string =>
  `节点 ${nodeId} 连接中断，操作结果未知（不自动重试）：${error instanceof Error ? error.message : String(error)}`

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

  /** sink 注册/注销按在途 exec 计数：首个带 onOutput 的 exec 注册，最后一个
   *  结束后注销——实例（含 envFor 短生命周期对象）不残留注册表强引用。 */
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

  /** 节点侧流式回调入口（fabric 登记到注册表按节点路由）。 */
  get onEnvExecOutput(): (event: EnvExecOutputEvent) => void {
    return this.#outputHub.onEnvExecOutput
  }

  get outputHub(): ExecOutputHub {
    return this.#outputHub
  }

  /** 取得在线节点的 RPC；离线且可等待时先等待（等待期间 context 取消 → undefined）。 */
  async #rpc(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpc = this.#resolver.getNodeEnvRpc(this.#nodeIdValue)
    if (rpc !== undefined) return rpc
    const wait = this.#resolver.waitForNodeOnline
    if (wait !== undefined) {
      const restored = await wait(this.#nodeIdValue, context)
      if (restored !== undefined) return restored
      throw new Error(`等待节点 ${this.#nodeIdValue} 上线已被取消`)
    }
    throw new Error(`节点 ${this.#nodeIdValue} 离线`)
  }

  /**
   * reader 跨代安全：句柄绑定创建时的 RPC 代。节点重连后新代可能复用同一
   * readerId 序号（如 r1 指向另一个文件）——绝不能把旧句柄发给新代误读
   * 别的文件。每次 read/info/next/close 都校验「原代 rpc 仍是当前代」，
   * 失效即报 unknown/invalid（不重放、不跨代复用）。
   */
  #staleReaderError(path: string): FileError {
    return new FileError(
      'unknown',
      `节点 ${this.#nodeIdValue} 连接已替换，reader 句柄所属代已终结（不跨代复用）：${path}`,
      path,
    )
  }

  /** 原代 rpc 是否仍是当前代（false = 已被顶替/断开，句柄全部失效）。 */
  #isCurrentRpc(rpc: NodeEnvRpcFunctions): boolean {
    return this.#resolver.getNodeEnvRpc(this.#nodeIdValue) === rpc
  }

  /**
   * 文件操作入口的 RPC 解析（#call 专用）：等待重连有界（rpcWaitTimeoutMs）。
   * 无界等待在持锁窗口内会把文件队列冻结到持锁者 turn 被中止；超时抛出
   * node_offline（锁随异常释放），节点重连后调用方可显式重试。
   */
  async #rpcBounded(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpcPromise = this.#rpc(context)
    // 超时先至时 rpcPromise 仍可能在等：observe 防未处理 rejection。
    rpcPromise.catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        rpcPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new HelmError(
              'node_offline',
              `节点 ${this.#nodeIdValue} 离线，等待重连超过 ${this.#rpcWaitTimeoutMs}ms（文件操作不无限等待）`,
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

  /** RPC 调用包装：节点失联（连接断开抛错）归一为「结果未知」。 */
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
          // 跨代校验：旧句柄不发给新代（新代同名 readerId 是另一个文件）。
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
            // 连接已失效：节点侧 reader 生命周期与连接绑定，断开时统一回收。
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
    // 跨代校验：每次调用前确认原代 rpc 仍是当前代（旧句柄不发给新代）。
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
            // 同上：连接失效时由节点侧连接级回收兜底。
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
    // 真实转发节点侧 envFlushFile：远端 fsync 语义由节点执行（不伪成功）。
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
          // 跨代校验：旧句柄不发给新代（新代同名 readerId 是另一个目录页游标）。
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
            // 连接失效：节点侧连接级回收兜底。
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
    // 远端 watch 超出协议范围：显式报错（not_supported），绝不返回
    // 假 watcher（那会让宿主以为已建立监听而永远收不到事件）。
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
    // 实例清理只注销自身 sink（自管理生命周期）；绝不发送按 cwd 的
    // envCleanup——节点侧 envCleanup 会杀同 cwd 下**其他会话**的在途
    // 命令（cwd 不是会话隔离键）。在途命令的终止由调用方 context abort
    // （envAbortExec 按 execId 精确杀）或连接断开的节点侧连接级 dispose
    // 兜底。
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
            ? new ExecutionError('aborted', '等待节点上线时取消')
            : new ExecutionError('unknown', `节点 ${this.#nodeIdValue} 离线`),
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
        // 逐调用 cwd 优先（pi-durable Shell 语义）；缺省用 env 自身 cwd。
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
      // 取消引发的连接异常归一为 aborted；否则是连接丢失——命令已在节点
      // 启动，结果未知：显式报错且绝不自动重试（不安全的 shell 重放会
      // 对外部世界重复副作用）。
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

  /** 取消指定的运行中命令（透传节点侧 envAbortExec）。 */
  async abortExec(execId: string, context: Context): Promise<void> {
    await (await this.#rpc(context)).envAbortExec(execId)
  }
}
