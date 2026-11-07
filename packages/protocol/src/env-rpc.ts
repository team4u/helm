/**
 * 跨平台计算节点与远端执行环境 RPC 协议（Hub ↔ BYOM 节点，WS + birpc）。
 *
 * 与 `@earendil-works/pi-durable/env` 的 `ExecutionEnv`（FileSystem + Shell）对齐；
 * 二进制内容一律 base64；错误以 `RpcEnvError` 结构返回而非抛出。
 * 同时提供通用本机 IPC 桥（`ipcCall` / `ipcSubscribe`），供可选插件（如 `builtin:herdr`）
 * 复用节点通道访问目标机器上的 Unix Socket 或 Windows Named Pipe，彻底消除 SSH+Python。
 */

/** 默认本机计算节点 ID（与 Hub 同进程，零网络开销）。 */
export const DEFAULT_NODE_ID = 'local'

/** 节点摘要信息（`GET /api/nodes` 与 SSE `snapshot.nodes` / `node.changed`）。 */
export interface NodeInfo {
  id: string
  kind: 'local' | 'byom'
  online: boolean
  hostname?: string
  platform?: string
  connectedAt?: number
  lastSeenAt?: number
  /** 节点连接 Hub 时使用的真实可达地址（供远端受管进程回连）。 */
  hubUrl?: string
}

/** `POST /api/nodes/issue` 签发响应（明文 token 仅返回一次，服务端只存 sha256）。 */
export interface NodeIssuedToken {
  nodeId: string
  /** 格式为 `<nodeId>:<secret>`。 */
  token: string
  createdAt: number
}

/** `helm-node connect` 入参。 */
export interface NodeConnectInput {
  hubUrl: string
  token: string
}

/** 节点 WS 连接建立后首次调用 `register` 的入参（Token 不进 URL query）。 */
export interface NodeRegisterInput {
  nodeId: string
  token: string
  hostname: string
  platform: string
  /** 节点端配置的 Hub 地址（用于远端受管子进程回连）。 */
  hubUrl?: string
}

export interface NodeRegisterResult {
  ok: boolean
  /** 服务端期望的心跳间隔（毫秒）。 */
  heartbeatMs: number
  reason?: string
}

/** `POST /api/env/exec` 请求体。 */
export interface EnvExecRequest {
  command: string | string[]
  nodeId?: string
  cwd?: string
  conversationId?: number
  env?: Record<string, string>
  timeoutMs?: number
  stream?: boolean
}

/** `POST /api/env/exec` 非流式响应体。 */
export interface EnvExecResponse {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
}

/** `POST /api/env/exec` 流式响应；每行一帧，必须以 exit 或 error 结束。 */
export type EnvExecStreamFrame =
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; ok: boolean; exitCode: number | null; timedOut: boolean }
  | { type: 'error'; error: { code: string; message: string; details?: unknown } }

export type RpcFileKind = 'file' | 'directory' | 'symlink'

export type RpcFileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unknown'

export type RpcExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown'

export interface RpcLineScan {
  newlines: number
  start: number
  end: number
  firstLineEnd: number
  lastLineStart: number
  selectedBytes: number
  firstLineBytes: number
}

export interface RpcEnvError {
  code: RpcFileErrorCode | RpcExecutionErrorCode
  message: string
  spillPath?: string
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcEnvError }

export interface RpcFileInfo {
  name: string
  path: string
  kind: RpcFileKind
  size: number
  mtimeMs: number
}

export interface RpcTextLine {
  text: string
  terminated: boolean
}

export interface RpcReaderHandle {
  readerId: string
}

export interface EnvExecOutputEvent {
  execId: string
  text: string
  stream: 'stdout' | 'stderr'
  skipped?: { bytes: number; newlines: number; endsWithNewline: boolean }
}

export interface EnvExecSpillOptions {
  afterBytes: number
  afterLines: number
}

export interface EnvExecWindowOptions {
  maxBytes: number
  maxLines: number
  minIntervalMs: number
  bytesPerSecond: number
}

export interface EnvExecInput {
  execId: string
  command: string | readonly string[]
  cwd?: string
  env?: Record<string, string>
  inheritEnv?: boolean
  /** 超时时间（秒）。 */
  timeout?: number
  spill?: EnvExecSpillOptions
  window?: EnvExecWindowOptions
}

export interface EnvExecOk {
  exitCode: number
  spillPath?: string
}

/** 节点本机单次行协议 IPC 请求（Unix Socket / Windows Named Pipe）。 */
export interface NodeIpcCallInput {
  callId?: string
  /** 显式 socket / pipe 路径；缺省按 session 解析节点本机默认路径。 */
  endpoint?: string
  session?: string
  /** 发送的单行 JSON 载荷（不含末尾换行符）。 */
  line: string
  timeoutMs?: number
}

/** 节点本机流式行协议 IPC 订阅请求。 */
export interface NodeIpcSubscribeInput {
  subscribeId: string
  endpoint?: string
  session?: string
  /** 初始握手请求行（不含末尾换行符）。 */
  line: string
}

export interface NodeIpcEvent {
  subscribeId: string
  line: string
}

export interface NodeIpcClosedEvent {
  subscribeId: string
  error?: string
}

/** 节点侧（`@helm/node`）实现、Hub 侧（`@helm/kernel`）调用的远端函数集。 */
export interface NodeEnvRpcFunctions {
  envAbsolutePath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>
  envJoinPath(input: { parts: string[]; cwd?: string }): Promise<RpcResult<string>>

  envReadTextFile(input: { path: string; cwd?: string }): Promise<RpcResult<string>>
  envReadTextLines(input: { path: string; maxLines?: number; cwd?: string }): Promise<RpcResult<string[]>>
  envReadBinaryFile(input: { path: string; cwd?: string }): Promise<RpcResult<{ base64: string }>>

  envWriteFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>
  envAppendFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>
  envFlushFile(input: { path: string; cwd?: string }): Promise<RpcResult<null>>
  envTruncateFile(input: { path: string; size: number; cwd?: string }): Promise<RpcResult<null>>
  envRenameFile(input: { sourcePath: string; destinationPath: string; cwd?: string }): Promise<RpcResult<null>>

  envFileInfo(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo>>
  envListDir(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo[]>>
  envListFiles(input: {
    path: string
    cwd?: string
  }): Promise<RpcResult<{ entries: { path: string; kind: RpcFileKind }[]; truncated: boolean }>>
  envCanonicalPath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>
  envExists(input: { path: string; cwd?: string }): Promise<RpcResult<boolean>>

  envCreateDir(input: { path: string; recursive?: boolean; cwd?: string }): Promise<RpcResult<null>>
  envRemove(input: { path: string; recursive?: boolean; force?: boolean; cwd?: string }): Promise<RpcResult<null>>
  envCreateTempDir(input: { prefix?: string; cwd?: string }): Promise<RpcResult<string>>
  envCreateTempFile(input: { prefix?: string; suffix?: string; cwd?: string }): Promise<RpcResult<string>>

  envOpenTextLineReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcReaderHandle>>
  envTextReaderRead(input: { readerId: string }): Promise<RpcResult<RpcTextLine | null>>
  envTextReaderClose(input: { readerId: string }): Promise<RpcResult<null>>

  envOpenBinaryReader(input: { path: string; noFollow?: boolean; cwd?: string }): Promise<RpcResult<RpcReaderHandle>>
  envBinaryReaderInfo(input: { readerId: string }): Promise<RpcResult<RpcFileInfo>>
  envBinaryReaderRead(input: {
    readerId: string
    offset: number
    length: number
  }): Promise<RpcResult<{ base64: string; byteLength: number }>>
  envBinaryReaderScanLines(input: { readerId: string; startLine: number; endLine?: number }): Promise<RpcResult<RpcLineScan>>
  envBinaryReaderClose(input: { readerId: string }): Promise<RpcResult<null>>

  envOpenDirReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcReaderHandle>>
  envDirReaderNext(input: { readerId: string; maxEntries: number }): Promise<RpcResult<{ entries: RpcFileInfo[]; done: boolean }>>
  envDirReaderClose(input: { readerId: string }): Promise<RpcResult<null>>

  envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>>
  envAbortExec(execId: string): Promise<void>
  envCleanup(cwd?: string): Promise<void>

  /** 节点本机单次 IPC 调用（供 builtin:herdr 等可选插件跨节点连接当地 Unix Socket / Named Pipe）。 */
  ipcCall?(input: NodeIpcCallInput): Promise<RpcResult<string>>
  /** 取消在途的节点本机 IPC 调用（立即销毁底层 socket）。 */
  ipcAbortCall?(callId: string): Promise<void>
  /** 建立节点本机 IPC 事件订阅流（后续行通过 HubEnvStreamFunctions.onIpcEvent 回调）。 */
  ipcSubscribe?(input: NodeIpcSubscribeInput): Promise<RpcResult<null>>
  /** 停止节点本机 IPC 事件订阅流。 */
  ipcUnsubscribe?(subscribeId: string): Promise<void>
}

/** Hub 侧实现、节点回调的流式事件函数集。 */
export interface HubEnvStreamFunctions {
  onEnvExecOutput(event: EnvExecOutputEvent): void
  onIpcEvent?(event: NodeIpcEvent): void
  onIpcClosed?(event: NodeIpcClosedEvent): void
}
