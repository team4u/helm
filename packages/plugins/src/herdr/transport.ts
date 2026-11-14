import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Socket } from 'node:net'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { HelmError } from '@helm/protocol'
import type { AgentGateResult } from '@helm/protocol'
import { connectHerdrEndpoint } from './local-node-channel.js'
import type {
  HerdrCallOptions,
  HerdrEvent,
  HerdrNodeChannel,
  HerdrNodeEnv,
  HerdrSubscribeOptions,
  HerdrTarget,
  HerdrTransport,
} from './contracts.js'
import { targetNodeId } from './contracts.js'

/**
 * Herdr 官方行协议 IPC 的最小 NDJSON 传输。
 *
 * Wire 契约（herdr 0.9.5 / protocol 22，经 `herdr api schema --json` 与服务端源码核实）：
 * - 一条连接一个请求：写一行 `{"id","method","params"}`，读一行 `{"id","result"}` 或
 *   `{"id","error":{"code","message"}}`，随后连接结束。
 * - `events.subscribe`：先回 `{"id","result":{"type":"subscription_started"}}` ack，
 *   之后每行是裸事件帧 `{"event","data"}`，无 id。
 *
 * 机密纪律：环境变量只经 JSON params（tab.create 的 env 对象）传递，永不落入
 * 任何进程命令行。远端节点一律经 `HerdrNodeChannel`（内核 EnvFabric 节点通道）
 * 转发单行 JSON 请求；任务与机密内容不出现在任何 argv。
 *
 * 本机端点解析（与 herdr 源码 `config/io.rs` + `session.rs` + `ipc.rs` 对齐；
 * XDG_CONFIG_HOME 优先于平台目录）：
 * - Unix：`${XDG_CONFIG_HOME ?? ~/.config}/herdr[/sessions/<name>]/herdr.sock`（UDS 文件）；
 * - Windows：`${XDG_CONFIG_HOME ?? %APPDATA% ?? USERPROFILE/AppData/Roaming}/herdr/.../herdr.sock`
 *   只是标记文件，真实端点是 Named Pipe（连接时按 interprocess pathcvt 规则
 *   拼接 `\\.\pipe\` 前缀，绝不把标记文件路径当可连接端点）。
 *
 * 远端端点纪律（跨平台/跨机器）：远端只传**显式** target.socketPath（可缺省）与
 * session；HERDR_SOCKET_PATH / 配置目录 / 端点形态（UDS vs pipe）全部由目标
 * 节点自行解析。绝不把 Hub 本机的 resolveSocketPath() 结果或 endpointKind
 * 强加给远端（那会把 Linux Hub 的 ~/.config 路径发给 Windows 目标）。
 */

export interface HerdrTransportOptions {
  /** 诊断与错误信息脱敏；缺省原样返回。 */
  redact?: (text: string) => string
  /** 跨节点通道（EnvFabric 或测试 fixture 注入）。缺省时远端目标显式报错，绝不回退本机。 */
  nodeChannel?: HerdrNodeChannel
  /** events.subscribe ack 等待期限；缺省 SUBSCRIBE_ACK_TIMEOUT_MS（测试可缩短）。 */
  subscribeAckTimeoutMs?: number
}

export const HERDR_CALL_TIMEOUT_MS = 120_000
/** agent.start 的服务端启动上限（>3000 且 ≤300000 ms）加传输余量。 */
export const HERDR_START_TIMEOUT_CEILING_MS = 300_000
export const HERDR_START_TIMEOUT_MARGIN_MS = 15_000
/** agent.prompt(wait)/agent.wait 无显式超时时不设客户端死线，交给 signal/服务端。 */
export const HERDR_WAIT_METHODS = new Set(['agent.prompt', 'agent.wait', 'pane.wait_for_output', 'events.wait'])
/** 单帧（单行 JSON）大小上限；订阅流按帧限额，不按连接生命周期累计。 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** Gate 输出保留上限；超限显式失败，绝不静默截断充当成功。 */
export const MAX_GATE_OUTPUT_BYTES = 1024 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const OUTPUT_FILE_PATTERN = /^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/
const SUBSCRIPTION_METHOD = 'events.subscribe'
/** 状态事件类型：官方契约要求订阅时按 pane_id 逐窗格过滤，无全量订阅。 */
const PANE_STATUS_EVENT_TYPE = 'pane.agent_status_changed'
/**
 * 全局订阅集（官方 type 基订阅，payload 走 EventData）：覆盖窗格生命周期与
 * 位置/焦点变化。pane.moved 会换 pane ID（官方 panes.rs:1326 只发 moved，
 * 无配套 created/closed）必须重取快照；agent_status_changed 需指定 pane_id
 * （每个关注窗格一条过滤订阅，由调用方随快照 paneIds 变化重建）。
 */
const SUBSCRIPTION_TYPES = [
  'pane.created',
  'pane.updated',
  'pane.closed',
  'pane.exited',
  'pane.focused',
  'pane.moved',
  'tab.closed',
  'workspace.closed',
] as const
// 全局 EventEnvelope 的名称使用 snake_case；专用状态事件使用点号。
// 订阅请求仍统一使用点号，只在接收边界规范成内部 HerdrEvent 名称。
const WIRE_EVENT_TYPES = new Map<string, HerdrEvent['type']>(
  SUBSCRIPTION_TYPES.map((type) => [type.replace('.', '_'), type] as const),
)
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000
/** 远端 RPC 单行请求 ID：wire 校验必须精确匹配。 */
const REMOTE_RPC_ID = 'helm-remote-1'
/** Gate 超时（秒；NodeExecutionEnv timeout 单位）：600s 预算 + 收尾余量。 */
const GATE_TIMEOUT_SECONDS = 620
/** 节点 ID 单一安全 token（含 'local'；空串与超长显式拒绝）。 */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class HerdrTransportError extends Error {
  readonly code: string
  readonly target: string

  constructor(code: string, message: string, target: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HerdrTransportError'
    this.code = code
    this.target = target
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeTarget(target: HerdrTarget): string {
  const nodeId = targetNodeId(target)
  if (nodeId !== undefined) return `herdr@node:${nodeId}`
  if (target.session) return `herdr session ${target.session}`
  if (target.socketPath) return `herdr socket ${target.socketPath}`
  return 'herdr local default session'
}

/** session 名会成为 socket 路径段，字符白名单（与 herdr 侧 validate_name 同向）。 */
export function isValidSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
}

/**
 * 节点 ID 单一安全 token：字母数字开头，可含 `.` `_` `-`，长度 1..128。
 * 空串与非法字符显式拒绝（绝不把空串默默当本机——那是静默降级）。
 */
export function isValidNodeId(name: string): boolean {
  return NODE_ID_PATTERN.test(name)
}

function assertTarget(target: HerdrTarget): void {
  if (target.nodeId !== undefined && !isValidNodeId(target.nodeId)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid nodeId: ${target.nodeId}`, describeTarget(target))
  }
  if (target.session !== undefined && !isValidSessionName(target.session)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid session name: ${target.session}`, describeTarget(target))
  }
}

/**
 * 本机 Herdr IPC 端点路径解析（仅本机节点使用；远端节点自行解析）：
 * target.socketPath > HERDR_SOCKET_PATH > 会话目录（session 或默认）。
 * Unix 上即 UDS 文件本身；Windows 上是 named pipe 的 marker 文件（连接时
 * 必须换算为 pipe 名，绝不能直接 connect 文件路径）。
 */
export function resolveSocketPath(target: HerdrTarget): string {
  if (target.socketPath) return target.socketPath
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH
  if (process.platform === 'win32') {
    const configHome = process.env.XDG_CONFIG_HOME ?? process.env.APPDATA ?? win32.join(homedir(), 'AppData', 'Roaming')
    if (target.session) return win32.join(configHome, 'herdr', 'sessions', target.session, 'herdr.sock')
    return win32.join(configHome, 'herdr', 'herdr.sock')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? posix.join(process.env.HOME ?? homedir(), '.config')
  if (target.session) return posix.join(configHome, 'herdr', 'sessions', target.session, 'herdr.sock')
  return posix.join(configHome, 'herdr', 'herdr.sock')
}

/** 会话/等待类长请求：无显式 timeoutMs 时不套客户端死线，由 signal 或服务端 wait 超时终止。 */
function resolveCallTimeoutMs(method: string, params: Record<string, unknown>, options: HerdrCallOptions | undefined): number | undefined {
  if (options?.timeoutMs !== undefined) return options.timeoutMs
  if (HERDR_WAIT_METHODS.has(method)) return undefined
  if (method === 'agent.start') {
    const requested = typeof params['timeout_ms'] === 'number' ? params['timeout_ms'] : 30_000
    return Math.min(Math.max(requested, 1), HERDR_START_TIMEOUT_CEILING_MS) + HERDR_START_TIMEOUT_MARGIN_MS
  }
  return HERDR_CALL_TIMEOUT_MS
}

function checkAborted(signal: AbortSignal | undefined, target: string): void {
  if (signal?.aborted) throw new HerdrTransportError('herdr_aborted', 'operation aborted', target)
}

function contextOf(signal: AbortSignal | undefined, target: string): Context {
  checkAborted(signal, target)
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

function timeoutPromise(ms: number, target: string): { promise: Promise<never>; clear: () => void } {
  let handle: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new HerdrTransportError('herdr_timeout', `no response within ${ms}ms`, target))
    }, ms)
    handle.unref?.()
  })
  return { promise, clear: () => handle && clearTimeout(handle) }
}

// --------------------------------------------------------------- 帧解码 --

/**
 * NDJSON 帧解码器：按字节找 \n 边界，未完整的 UTF-8 尾部留在字节缓冲，
 * 字符串解码用增量 TextDecoder，可被 subclass 复用于确定性逐字节回归。
 * 限额按单帧计（limitBytes），不按连接累计。
 */
export class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0)
  private decoder = new TextDecoder('utf-8', { fatal: true })

  /** 喂入任意切分的 chunk，返回本次完成的行（不含 \n）。超限/非法 UTF-8 抛错。 */
  push(chunk: Buffer, limitBytes = MAX_FRAME_BYTES): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (this.buffer.includes(0)) {
      throw new HerdrTransportError('herdr_protocol', 'socket stream contained NUL byte', 'herdr socket')
    }
    const lines: string[] = []
    let index: number
    while ((index = this.buffer.indexOf(0x0a)) >= 0) {
      const frame = this.buffer.subarray(0, index)
      this.buffer = this.buffer.subarray(index + 1)
      if (frame.length > limitBytes) {
        throw new HerdrTransportError('herdr_frame_too_large', `frame exceeded ${limitBytes} bytes`, 'herdr socket')
      }
      lines.push(this.decode(frame))
    }
    if (this.buffer.length > limitBytes) {
      throw new HerdrTransportError('herdr_frame_too_large', `frame exceeded ${limitBytes} bytes`, 'herdr socket')
    }
    return lines
  }

  /** EOF：残留字节按最后一帧处理；不完整 UTF-8 是协议错误。 */
  flush(): string[] {
    if (this.buffer.length === 0) return []
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    return [this.decode(rest)]
  }

  private decode(frame: Buffer): string {
    try {
      return this.decoder.decode(frame, { stream: false })
    } catch (cause) {
      throw new HerdrTransportError('herdr_protocol', 'invalid UTF-8 in frame', 'herdr socket', { cause })
    }
  }
}

function parseJsonLine(line: string, target: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 先整体脱敏再取预览，避免坏帧原文携带机密泄漏。
    throw new HerdrTransportError('herdr_protocol', 'invalid JSON line', target)
  }
  if (!isObject(parsed)) {
    throw new HerdrTransportError('herdr_protocol', 'response line is not a JSON object', target)
  }
  return parsed
}

function checkWireError(envelope: Record<string, unknown>, target: string, redact: (s: string) => string): void {
  if (envelope['error'] !== undefined && envelope['error'] !== null) {
    const body = isObject(envelope['error']) ? envelope['error'] : {}
    raiseWireError(body, target, redact)
  }
}

function raiseWireError(error: { code?: unknown; message?: unknown }, target: string, redact: (s: string) => string): never {
  const code = typeof error.code === 'string' && error.code ? error.code : 'herdr_error'
  const message = typeof error.message === 'string' && error.message ? redact(error.message) : 'herdr returned an error without a message'
  throw new HerdrTransportError(code, `${code}: ${message}`, target)
}

// --------------------------------------------------------- 本机 socket RPC --

/**
 * 建立到本机 Herdr IPC 端点的连接：
 * - Unix 路径：直连 UDS 文件；
 * - Windows 形状路径（盘符/UNC，含完整 pipe 路径）：磁盘上的 herdr.sock 只是
 *   marker 文件，真实端点是 `\\.\pipe\` 命名管道——先确认 marker 文件存在
 *   （不存在即 herdr_unreachable，与 UDS ENOENT 同语义），再换算 pipe 名连接，
 *   绝不把 marker 文件路径当可连接端点。
 */
async function openLocalHerdrSocket(socketPath: string, target: string): Promise<Socket> {
  const net = await import('node:net')
  if (!isWindowsShapedPath(socketPath)) {
    const socket = net.connect(socketPath)
    socket.setNoDelay(true)
    return socket
  }
  // 已是完整 pipe 路径：无 marker 可查，直接换算连接（pipe 名即端点）。
  if (!/^\\\\(\.|[^\\]+)\\pipe\\/.test(socketPath.replaceAll('/', '\\'))) {
    const fs = await import('node:fs/promises')
    try {
      await fs.stat(socketPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        throw new HerdrTransportError(
          'herdr_unreachable',
          `herdr marker 文件不存在（${code ?? 'stat failed'}）：${socketPath}，请确认 Windows 本机 herdr 正在运行`,
          target,
          { cause: err },
        )
      }
      throw new HerdrTransportError('herdr_io', `无法访问 herdr marker 文件：${socketPath}（${code ?? String(err)}）`, target, { cause: err })
    }
  }
  const socket = connectHerdrEndpoint(socketPath, 'named-pipe')
  socket.setNoDelay(true)
  return socket
}

/** 一连接一请求：拿到首个完整响应行即销毁连接。 */
async function callLocal(
  socketPath: string,
  target: string,
  method: string,
  params: Record<string, unknown>,
  options: HerdrCallOptions | undefined,
  redact: (s: string) => string,
): Promise<unknown> {
  const signal = options?.signal
  checkAborted(signal, target)

  const socket = await openLocalHerdrSocket(socketPath, target)
  const assembler = new LineAssembler()
  const timeoutMs = resolveCallTimeoutMs(method, params, options)
  const timer = timeoutMs === undefined ? undefined : timeoutPromise(timeoutMs, target)
  const requestId = '1'

  const firstLine = new Promise<string>((resolve, reject) => {
    const settle = (outcome: Promise<string>) => {
      socket.end()
      outcome.then(resolve, reject)
    }
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = assembler.push(chunk)
      } catch (err) {
        settle(Promise.reject(err))
        return
      }
      if (lines[0] !== undefined) settle(Promise.resolve(lines[0]))
    })
    socket.once('close', () => {
      let lines: string[]
      try {
        lines = assembler.flush()
      } catch (err) {
        reject(err)
        return
      }
      if (lines[0] !== undefined) resolve(lines[0])
      else reject(new HerdrTransportError('herdr_disconnected', 'socket closed before response', target))
    })
    socket.once('error', (err) => {
      reject(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, target, { cause: err }))
    })
  })

  // abort 主动结算：彻底销毁本方 socket（含读方向），不依赖对端先关闭；
  // 无 deadline 的 agent.wait 也必须能被 abort 立即终止。
  let onAbort: () => void = () => {}
  const abortRejection = new Promise<never>((_, reject) => {
    onAbort = () => {
      socket.destroy()
      reject(new HerdrTransportError('herdr_aborted', 'call aborted', target))
    }
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  let line: string
  try {
    socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    const racers: Promise<string>[] = [firstLine, abortRejection]
    if (timer) racers.push(timer.promise)
    line = await Promise.race(racers)
  } finally {
    timer?.clear()
    signal?.removeEventListener('abort', onAbort)
    socket.destroy()
  }
  const envelope = parseJsonLine(line, target)
  if (!envelope) throw new HerdrTransportError('herdr_protocol', 'empty response line', target)
  if (envelope['id'] !== requestId) {
    // 缺 id 或错 id 都是对端协议违规，绝不当作成功。
    throw new HerdrTransportError('herdr_protocol', 'response id missing or mismatched', target)
  }
  if (envelope['result'] === undefined && envelope['error'] === undefined) {
    throw new HerdrTransportError('herdr_protocol', 'response has neither result nor error', target)
  }
  checkWireError(envelope, target, redact)
  return envelope['result']
}

// ------------------------------------------------------- 本机事件订阅流 --

/**
 * 订阅流：ack 后每行一个裸事件帧。
 * 单一终结器保证资源只清一次、错误只报一次；ack 与事件同 chunk 到达时逐行处理完。
 * options.paneIds 为每个去重窗格追加 {type:'pane.agent_status_changed',pane_id} 过滤订阅；
 * options.signal 任一时刻 abort 都关闭本次 socket：待 ack Promise 立即以 herdr_aborted 结算，
 * 正常流阶段仅静默关闭，不当作新错误通知 onError。
 */
async function subscribeLocal(
  socketPath: string,
  target: string,
  onEvent: (event: HerdrEvent) => void,
  onError: (error: unknown) => void,
  redact: (s: string) => string,
  options?: HerdrSubscribeOptions,
  subscribeAckTimeoutMs: number = SUBSCRIBE_ACK_TIMEOUT_MS,
): Promise<() => void> {
  const signal = options?.signal
  checkAborted(signal, target)
  // 订阅集：全局拓扑事件 + 每个去重 paneId 一条状态过滤订阅。
  const paneIds = [...new Set(options?.paneIds ?? [])]
  const invalidPaneId = paneIds.find((paneId) => typeof paneId !== 'string' || paneId === '')
  if (invalidPaneId !== undefined) {
    throw new HerdrTransportError('herdr_invalid_subscription', `invalid pane id in subscription options: ${String(invalidPaneId)}`, target)
  }
  const socket = await openLocalHerdrSocket(socketPath, target)
  const assembler = new LineAssembler()

  let stopped = false
  let terminated = false
  let acked = false
  let terminate: (error: unknown) => void = () => {}

  /** 唯一终结路径：温和关闭 socket（发 FIN，避免服务端连接悬挂）；错误只报一次。 */
  function failOnce(error: unknown): void {
    if (terminated) return
    terminated = true
    socket.destroy()
    terminate(error)
  }

  const ack = new Promise<void>((resolve, reject) => {
    let settled = false
    terminate = (error) => {
      if (settled) onError(error)
      else {
        settled = true
        reject(error)
      }
    }
    const succeed = () => {
      if (settled) return
      settled = true
      acked = true
      resolve()
    }

    const handleLines = (lines: string[]) => {
      for (const line of lines) {
        let envelope: Record<string, unknown> | undefined
        try {
          envelope = parseJsonLine(line, target)
        } catch (err) {
          failOnce(err)
          return
        }
        if (!envelope) continue
        if (envelope['event'] !== undefined) {
          // ack 之前到达的事件帧：仍按序分发，不丢弃。
          if (!dispatchEventFrame(envelope)) return
          continue
        }
        if (envelope['id'] !== 'sub') {
          failOnce(new HerdrTransportError('herdr_protocol', 'subscription response id missing or mismatched', target))
          return
        }
        if (envelope['error'] !== undefined && envelope['error'] !== null) {
          const body = isObject(envelope['error']) ? envelope['error'] : {}
          const code = typeof body['code'] === 'string' && body['code'] ? body['code'] : 'herdr_error'
          const message =
            typeof body['message'] === 'string' && body['message'] ? redact(body['message']) : 'herdr returned an error without a message'
          failOnce(new HerdrTransportError(code, `${code}: ${message}`, target))
          return
        }
        if (envelope['result'] !== undefined) {
          const result = envelope['result']
          const type = isObject(result) ? result['type'] : undefined
          if (type === 'subscription_started') {
            succeed()
            continue // 同 chunk 后续行继续按事件处理
          }
          failOnce(new HerdrTransportError('herdr_protocol', 'unexpected subscription ack result', target))
          return
        }
      }
    }

    socket.on('data', (chunk: Buffer) => {
      if (terminated || stopped) return
      let lines: string[]
      try {
        lines = assembler.push(chunk)
      } catch (err) {
        failOnce(err)
        return
      }
      handleLines(lines)
    })
    socket.once('error', (err) => {
      failOnce(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, target, { cause: err }))
    })
    socket.once('close', () => {
      if (stopped) return // stop()/abort 主动关闭不是错误
      failOnce(new HerdrTransportError('herdr_disconnected', terminated ? 'subscription socket closed' : 'subscription socket closed before ack', target))
    })
  })

  const subscriptions: Array<Record<string, unknown>> = SUBSCRIPTION_TYPES.map((type) => ({ type }))
  for (const paneId of paneIds) subscriptions.push({ type: PANE_STATUS_EVENT_TYPE, pane_id: paneId })

  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions } }
  socket.write(`${JSON.stringify(request)}\n`)

  // abort 主动结算：待 ack 阶段 reject 本次 Promise，正常流阶段仅静默关闭；
  // 二者都不把 abort 当作新错误上报 onError。
  const onAbort = () => {
    if (terminated) return
    stopped = true
    terminated = true
    socket.destroy()
    if (!acked) terminate(new HerdrTransportError('herdr_aborted', 'subscription aborted', target))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // checkAborted 与 addEventListener 之间已 abort 的窗口补偿（abort 事件不追溯触发）。
  if (signal?.aborted) onAbort()

  // ack 期限：无论哪条路径失败（超时/坏帧/断线）都必须经 failOnce 关闭 socket，
  // 否则服务端连接悬挂且 close 监听器残留。
  const ackTimer = timeoutPromise(subscribeAckTimeoutMs, target)
  try {
    await Promise.race([
      ack,
      ackTimer.promise.then(
        (never) => never as never,
        (err) => {
          failOnce(err)
          throw err
        },
      ),
    ])
  } catch (err) {
    // 拒绝路径调用方拿不到 stop()：在此白行清理 abort listener，不泄漏。
    signal?.removeEventListener('abort', onAbort)
    throw err
  } finally {
    ackTimer.clear()
  }

  /**
   * 事件帧 → {type, paneId}；pane.created/updated 携带完整 PaneInfo（官方
   * EventData），closed/exited/focused/agent_status_changed 为 pane_id 字段，
   * moved 取 data.pane.pane_id（新 ID；旧 ID 由快照重取对齐）。
   * 坏帧经终结器上报并停止订阅。
   */
  function dispatchEventFrame(frame: Record<string, unknown>): boolean {
    try {
      const wireType = frame['event']
      if (typeof wireType !== 'string') return true
      const type = wireType === PANE_STATUS_EVENT_TYPE ? wireType : WIRE_EVENT_TYPES.get(wireType)
      if (type === undefined) return true
      const data = isObject(frame['data']) ? frame['data'] : {}
      if (type === 'tab.closed' || type === 'workspace.closed') {
        const workspaceId = data['workspace_id']
        const tabId = data['tab_id']
        if (typeof workspaceId !== 'string' || workspaceId === '' ||
            (type === 'tab.closed' && (typeof tabId !== 'string' || tabId === ''))) {
          failOnce(new HerdrTransportError('herdr_protocol', `event ${type} missing topology identity`, target))
          return false
        }
        if (type === 'tab.closed') onEvent({ type, workspaceId, tabId: tabId as string })
        else onEvent({ type, workspaceId })
        return true
      }
      const pane = isObject(data['pane']) ? data['pane'] : undefined
      const paneId =
        typeof data['pane_id'] === 'string' && data['pane_id'] !== ''
          ? data['pane_id']
          : typeof pane?.['pane_id'] === 'string' && pane['pane_id'] !== ''
            ? (pane['pane_id'] as string)
            : undefined
      if (!paneId) {
        failOnce(new HerdrTransportError('herdr_protocol', `event ${String(type)} missing pane identity`, target))
        return false
      }
      onEvent({ type, paneId })
      return true
    } catch (err) {
      failOnce(err)
      return false
    }
  }

  return () => {
    stopped = true
    signal?.removeEventListener('abort', onAbort)
    // 正常退订发送 FIN，让对端及时释放订阅；写侧结束后再销毁读侧，避免长驻 socket。
    socket.end(() => socket.destroy())
  }
}

// ------------------------------------------------------------ 远端节点通道 --

/**
 * 解析远端调用所需的通道：EnvFabric 未注入（缺 nodeChannel）时显式
 * herdr_node_unavailable；节点离线显式 herdr_node_offline。绝不回退本机。
 */
function requireChannel(nodeChannel: HerdrNodeChannel | undefined, nodeId: string, target: string): HerdrNodeChannel {
  if (nodeChannel === undefined) {
    throw new HerdrTransportError(
      'herdr_node_unavailable',
      `node '${nodeId}' has no HerdrNodeChannel（EnvFabric 未注入）；远端 Herdr 调用不可用，且绝不回退本机`,
      target,
    )
  }
  if (!nodeChannel.isOnline(nodeId)) {
    throw new HerdrTransportError('herdr_node_offline', `node '${nodeId}' is offline`, target)
  }
  return nodeChannel
}

/** 通道层错误码 → 传输错误码（超时/取消/IO 如实分型，不吞错）。 */
function raiseChannelError(code: string, message: string, target: string): never {
  const mapped =
    code === 'timeout' ? 'herdr_timeout'
    : code === 'aborted' ? 'herdr_aborted'
    : code === 'not_found' ? 'herdr_output_missing'
    : code === 'permission_denied' ? 'herdr_io'
    : 'herdr_node_error'
  throw new HerdrTransportError(mapped, `${code}: ${message}`, target)
}

/**
 * 远端 RPC：单行 JSON 经节点通道直达目标节点的本机 Herdr IPC。
 * 只传显式 target.socketPath（可缺省）与 session——端点路径/形态由目标节点
 * 自行解析（本机 resolveSocketPath/endpointKind 绝不下发）。
 * 机密只存在于 JSON 结构内部，绝不进入任何命令行 argv。
 */
async function callRemote(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  target: HerdrTarget,
  targetLabel: string,
  method: string,
  params: Record<string, unknown>,
  options: HerdrCallOptions | undefined,
  redact: (s: string) => string,
): Promise<unknown> {
  const line = JSON.stringify({ id: REMOTE_RPC_ID, method, params })
  const timeoutMs = resolveCallTimeoutMs(method, params, options)
  const result = await nodeChannel.ipcCall(
    nodeId,
    {
      ...(target.socketPath !== undefined ? { endpoint: target.socketPath } : {}),
      ...(target.session !== undefined ? { session: target.session } : {}),
      line,
      timeoutMs,
    },
    options?.signal,
  )
  if (!result.ok) raiseChannelError(result.error.code, result.error.message, targetLabel)
  const envelope = parseJsonLine(result.value, targetLabel)
  if (!envelope) throw new HerdrTransportError('herdr_protocol', 'empty response line', targetLabel)
  if (envelope['id'] !== REMOTE_RPC_ID) {
    throw new HerdrTransportError('herdr_protocol', 'response id missing or mismatched', targetLabel)
  }
  if (envelope['result'] === undefined && envelope['error'] === undefined) {
    throw new HerdrTransportError('herdr_protocol', 'response has neither result nor error', targetLabel)
  }
  checkWireError(envelope, targetLabel, redact)
  return envelope['result']
}

// ------------------------------------------------------- 文件与门禁 --

function assertSafeOutputName(fileName: string, target: string): void {
  if (!OUTPUT_FILE_PATTERN.test(fileName)) {
    throw new HerdrTransportError('herdr_invalid_output_name', `refusing unsafe output file name: ${fileName}`, target)
  }
}

/** 本机输出路径：校验 cwd 真实存在、.helm 是真实目录（非软链）且在真实 cwd 内。 */
async function resolveLocalOutputPath(cwd: string, fileName: string, target: string): Promise<string> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  let realCwd: string
  try {
    realCwd = await fs.realpath(cwd)
  } catch (err) {
    throw new HerdrTransportError('herdr_invalid_cwd', `cwd not accessible: ${cwd}`, target, { cause: err })
  }
  const helmDir = path.join(realCwd, '.helm')
  let helmStat
  try {
    helmStat = await fs.lstat(helmDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 目录缺失 = 交接文件缺失：read 报 404、remove 幂等（一次自愈边界）。
      throw new HelmError('herdr_output_missing', `交接目录不存在: ${helmDir}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect ${helmDir}: ${code ?? String(err)}`, target, { cause: err })
  }
  if (helmStat.isSymbolicLink() || !helmStat.isDirectory()) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  // realpath 再验证：目录内不允许任何中间软链把最终路径移出 cwd。
  const realHelm = await fs.realpath(helmDir)
  if (realHelm !== helmDir) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return path.join(helmDir, fileName)
}

async function readLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<string> {
  const fs = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  checkAborted(signal, target)
  const path = await resolveLocalOutputPath(cwd, fileName, target)
  // 以 O_NOFOLLOW 打开收敛 TOCTOU：lstat 与 readFile 分离时，窗口内文件可被
  // 替换为符号链接越出 .helm；在打开时点拒绝 symlink 后从同一句柄 fstat+读
  // （Windows 无 O_NOFOLLOW，退回读后 realpath 复核仍锚定 .helm 内）。
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let fh: Awaited<ReturnType<typeof fs.open>>
  try {
    fh = await fs.open(path, fs.constants.O_RDONLY | noFollow)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${path}`, 404)
    }
    if (code === 'ELOOP') {
      throw new HerdrTransportError('herdr_output_escaping', `output path is a symlink: ${path}`, target)
    }
    throw new HerdrTransportError('herdr_io', `failed to open output file: ${redact(String(err))}`, target, { cause: err })
  }
  try {
    const stat = await fh.stat()
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    if (stat.size > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, target)
    }
    const content = await fh.readFile('utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, target)
    }
    if (!noFollow) {
      const real = await fs.realpath(path)
      if (!pathContains(await fs.realpath(dirname(path)), real)) {
        throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, target)
      }
    }
    return content
  } finally {
    await fh.close().catch(() => {})
  }
}

async function removeLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<void> {
  const fs = await import('node:fs/promises')
  checkAborted(signal, target)
  let path: string
  try {
    path = await resolveLocalOutputPath(cwd, fileName, target)
  } catch (err) {
    // 目录/文件缺失：remove 语义是幂等无操作（与插件一次自愈边界一致）。
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    await fs.unlink(path)
  } catch (err) {
    if (err instanceof HerdrTransportError || err instanceof HelmError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${redact(String(err))}`, target, { cause: err })
  }
}

/**
 * 目标路径形状对应的纯路径规则（不依赖 Hub 进程平台）：
 * Windows 形状（盘符或 UNC `\\server\share`）用 win32 规则，其余 POSIX。
 */
function pathRulesFor(path: string): typeof posix | typeof win32 {
  return isWindowsShapedPath(path) ? win32 : posix
}

/** Windows 路径形状：盘符（C:\ 或 C:/）或 UNC（\\server\share）。纯规则判断。 */
export function isWindowsShapedPath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(path)
}

/** 路径是否为绝对路径（POSIX `/` 或 Windows 盘符/UNC；拒绝 `C:relative`）。纯规则。 */
export function isAbsoluteAnyPath(path: string): boolean {
  return isWindowsShapedPath(path) ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

/**
 * 跨平台安全 containment：child 必须等于 root 或位于 root 之下（规范化比较，
 * 不多加目录分隔——root 为 `/` 时 `/foo` 合法包含，`//foo` 不额外产生）。
 * root 与 child 均为已 canonical 解析的路径（调用方保证）。
 */
export function pathContains(root: string, child: string): boolean {
  if (root === child) return true
  const rules = pathRulesFor(root)
  const rootPrefix = root.endsWith(rules.sep) ? root.slice(0, -1) : root
  return child.startsWith(rootPrefix + rules.sep)
}

/**
 * 远端节点输出目录解析（与本地 resolveLocalOutputPath 同一安全边界）：
 * - cwd 依据自身路径形状选用 win32/posix 纯规则拼 `<cwd>/.helm`（Hub 的
 *   node:path.join 会按 Hub 平台拆 Windows 路径——Linux Hub 会把 `\` 当
 *   普通字符产生错误目录名，Windows Hub 会把 POSIX cwd 拆碎）；
 * - cwd 经 env.canonicalPath 校验真实可解析（不可达 = invalid_cwd）；
 * - `<realCwd>/.helm` 必须是真实目录（缺失 = 404 可自愈边界；symlink/非目录 = 逃逸拒绝）；
 * - canonical 后必须仍落在 realCwd 之内（pathContains，中间软链拦截）。
 */
async function resolveNodeOutputDir(
  env: HerdrNodeEnv,
  cwd: string,
  target: string,
  context: Context,
): Promise<{ realCwd: string; realHelm: string }> {
  const rules = pathRulesFor(cwd)
  const canonicalCwd = await env.canonicalPath(cwd, context)
  if (!canonicalCwd.ok) {
    throw new HerdrTransportError(
      'herdr_invalid_cwd',
      `cwd not accessible on node: ${canonicalCwd.error.code}: ${canonicalCwd.error.message}`,
      target,
      { cause: new Error(canonicalCwd.error.message) },
    )
  }
  const realCwd = canonicalCwd.value
  const helmDir = rules.join(realCwd, '.helm')
  const helmInfo = await env.fileInfo(helmDir, context)
  if (!helmInfo.ok) {
    const code = helmInfo.error.code
    if (code === 'not_found' || code === 'not_directory') {
      // 目录缺失 = 交接文件缺失：read 报 404、remove 幂等（一次自愈边界）。
      throw new HelmError('herdr_output_missing', `交接目录不存在: ${helmDir}`, 404)
    }
    throw new HerdrTransportError(
      'herdr_io',
      `failed to inspect ${helmDir}: ${code}: ${helmInfo.error.message}`,
      target,
    )
  }
  if (helmInfo.value.kind === 'symlink' || helmInfo.value.kind !== 'directory') {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  const canonicalHelm = await env.canonicalPath(helmDir, context)
  if (!canonicalHelm.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${helmDir}: ${canonicalHelm.error.message}`, target)
  }
  const realHelm = canonicalHelm.value
  if (!pathContains(realCwd, realHelm)) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return { realCwd, realHelm }
}

async function readNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  target: HerdrTarget,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  const { realHelm } = await resolveNodeOutputDir(env, cwd, targetLabel, context)
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${filePath}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  if (info.value.size > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, targetLabel)
  }
  const content = await env.readTextFile(filePath, context)
  if (!content.ok) {
    throw new HerdrTransportError('herdr_io', `failed to read output file: ${content.error.code}: ${content.error.message}`, targetLabel)
  }
  // 读后 canonical 复核（TOCTOU 收敛）：fileInfo(lstat) 与 readTextFile（跟随
  // 软链）之间文件可被替换为符号链接越出 .helm；节点 env 无 O_NOFOLLOW 语义，
  // 以 realpath 复核实际读到的路径仍锚定 realHelm 内（内容已读入但绝不返回）。
  const canonical = await env.canonicalPath(filePath, context)
  if (!canonical.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${filePath}: ${canonical.error.message}`, targetLabel)
  }
  if (!pathContains(realHelm, canonical.value)) {
    throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, targetLabel)
  }
  if (Buffer.byteLength(content.value, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, targetLabel)
  }
  return content.value
}

async function removeNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  let realHelm: string
  try {
    realHelm = (await resolveNodeOutputDir(env, cwd, targetLabel, context)).realHelm
  } catch (err) {
    // 目录缺失：remove 幂等无操作（与本地语义一致）。
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') return // 文件缺失：幂等
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  const removed = await env.remove(filePath, { force: true }, context)
  if (!removed.ok) {
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${removed.error.code}: ${removed.error.message}`, targetLabel)
  }
}

function validEnvEntries(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

/**
 * Gate 执行核心（本机与远端同构）：SDK `NodeExecutionEnv.exec`——跨平台 shell
 * 选择（Unix /bin/bash→sh；Windows Git Bash/WSL 探测）与进程树终止
 * （Unix 进程组 SIGKILL；Windows taskkill /F /T）由 SDK 承担。
 * `inheritEnv: false`：只注入显式受管 env（宿主 HELM_TOKEN 等绝不泄漏进
 * gate 子进程；token 只能经显式 env 提供）。流式累计超限即取消并显式失败。
 */
async function execGate(
  env: HerdrNodeEnv,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  target: string,
  envVars: Record<string, string>,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const chunks: string[] = []
  let total = 0
  let overflow = false
  try {
    const result = await env.exec(
      command,
      {
        cwd,
        env: envVars,
        inheritEnv: false,
        timeout: GATE_TIMEOUT_SECONDS,
        onOutput: (text) => {
          total += Buffer.byteLength(text, 'utf8')
          if (total > MAX_GATE_OUTPUT_BYTES) {
            overflow = true
            controller.abort() // 立即取消远端命令，不先聚合无限输出
            return
          }
          chunks.push(text)
        },
      },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    if (!result.ok) {
      if (overflow) return { ok: false, output: `gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes` }
      if (result.error.code === 'aborted' && signal?.aborted) {
        throw new HerdrTransportError('herdr_aborted', 'gate aborted', target)
      }
      if (result.error.code === 'timeout') {
        throw new HerdrTransportError('herdr_timeout', `gate timed out: ${result.error.message}`, target)
      }
      throw new HerdrTransportError('herdr_node_error', `gate failed: ${result.error.code}: ${result.error.message}`, target)
    }
    if (total > MAX_GATE_OUTPUT_BYTES) {
      return { ok: false, output: `gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes` }
    }
    return { ok: result.value.exitCode === 0, output: redact(chunks.join('')) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 本机 Gate：NodeExecutionEnv（真实本机环境）+ 显式受管 env。 */
async function runLocalGate(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  target: string,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  checkAborted(signal, target)
  const sanitized: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) sanitized[key] = value
  const localEnv = new NodeExecutionEnv({ cwd })
  return execGate(localEnv, command, cwd, signal, target, sanitized, redact)
}

/** 远端 Gate：经节点 env.exec 在目标节点执行（同一安全边界）。 */
async function runNodeGate(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  targetLabel: string,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  checkAborted(signal, targetLabel)
  const sanitized: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) sanitized[key] = value
  return execGate(nodeChannel.envFor(nodeId, cwd), command, cwd, signal, targetLabel, sanitized, redact)
}

// ------------------------------------------------------------- 工厂 --

export function createHerdrTransport(factoryOptions?: HerdrTransportOptions): HerdrTransport {
  const redact = factoryOptions?.redact ?? ((text: string) => text)
  const nodeChannel = factoryOptions?.nodeChannel

  async function call(target: HerdrTarget, method: string, params: Record<string, unknown>, callOptions?: HerdrCallOptions): Promise<unknown> {
    assertTarget(target)
    const nodeId = targetNodeId(target)
    if (nodeId !== undefined) {
      const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
      return callRemote(channel, nodeId, target, describeTarget(target), method, params, callOptions, redact)
    }
    return callLocal(resolveSocketPath(target), describeTarget(target), method, params, callOptions, redact)
  }

  return {
    call,
    async readOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        return readNodeOutput(channel, nodeId, target, describeTarget(target), cwd, fileName, signal)
      }
      return readLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async removeOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        await removeNodeOutput(channel, nodeId, describeTarget(target), cwd, fileName, signal)
        return
      }
      await removeLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async runGate(target, command, cwd, signal, env) {
      assertTarget(target)
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        return runNodeGate(channel, nodeId, describeTarget(target), command, cwd, signal, env, redact)
      }
      return runLocalGate(command, cwd, signal, env, describeTarget(target), redact)
    },
    async subscribe(target, onEvent, onError, options) {
      assertTarget(target)
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        if (channel.ipcSubscribe !== undefined) {
          return subscribeNode(channel, nodeId, target, onEvent, onError, options)
        }
        // 通道不支持事件转发：显式失败，不静默降级为无事件。
        return Promise.reject(
          new HerdrTransportError('herdr_subscribe_unsupported', `node channel for '${nodeId}' does not stream events`, describeTarget(target)),
        )
      }
      return subscribeLocal(resolveSocketPath(target), describeTarget(target), onEvent, onError, redact, options, factoryOptions?.subscribeAckTimeoutMs)
    },
  }
}

/**
 * 远端事件订阅（经通道 ipcSubscribe）。
 *
 * 契约：通道在 Promise resolve 前自行消费并验证订阅 ACK；resolve 即代表订阅
 * 就绪，此后 onLine 只推送裸事件帧——本函数不再等待第二个 ACK，也不再设
 * ack timer。事件可能在 Promise resolve 之前到达（缓冲后按序分发，不丢弃）。
 * stop/abort/流关闭均只终结一次并释放订阅（release），回调至多一次。
 */
function subscribeNode(
  channel: HerdrNodeChannel,
  nodeId: string,
  target: HerdrTarget,
  onEvent: (event: HerdrEvent) => void,
  onError: (error: unknown) => void,
  options?: HerdrSubscribeOptions,
): Promise<() => void> {
  const targetLabel = describeTarget(target)
  const signal = options?.signal
  checkAborted(signal, targetLabel)
  const paneIds = [...new Set(options?.paneIds ?? [])]
  const subscriptions: Array<Record<string, unknown>> = SUBSCRIPTION_TYPES.map((type) => ({ type }))
  for (const paneId of paneIds) subscriptions.push({ type: PANE_STATUS_EVENT_TYPE, pane_id: paneId })
  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions } }

  return new Promise<() => void>((resolve, reject) => {
    let stopped = false
    let settled = false
    let release: (() => void) | undefined
    /** 唯一终结路径：释放订阅、移除 abort 监听；错误只报一次。 */
    const finish = (error: unknown): void => {
      if (settled) return
      settled = true
      stopped = true
      signal?.removeEventListener('abort', onAbort)
      try {
        release?.()
      } catch (releaseError) {
        // 释放失败如实并入终结错误，不静默吞。
        onError(releaseError)
      }
      if (error !== undefined) onError(error)
    }
    const onAbort = () => finish(undefined)

    // 事件可能在 ipcSubscribe Promise resolve 之前到达：缓冲待 resolve 后按序分发。
    const earlyLines: string[] = []
    let ready = false

    /** 事件帧解析与本地订阅同规则；坏帧经 finish 终结整个流。 */
    const handleEventFrame = (frame: Record<string, unknown>): void => {
      try {
        const wireType = frame['event']
        if (typeof wireType !== 'string') return
        const type = wireType === PANE_STATUS_EVENT_TYPE ? wireType : WIRE_EVENT_TYPES.get(wireType)
        if (type === undefined) return
        const data = isObject(frame['data']) ? frame['data'] : {}
        if (type === 'tab.closed' || type === 'workspace.closed') {
          const workspaceId = data['workspace_id']
          const tabId = data['tab_id']
          if (typeof workspaceId !== 'string' || workspaceId === '' ||
              (type === 'tab.closed' && (typeof tabId !== 'string' || tabId === ''))) {
            finish(new HerdrTransportError('herdr_protocol', `event ${type} missing topology identity`, targetLabel))
            return
          }
          if (type === 'tab.closed') onEvent({ type, workspaceId, tabId: tabId as string })
          else onEvent({ type, workspaceId })
          return
        }
        const pane = isObject(data['pane']) ? data['pane'] : undefined
        const paneId =
          typeof data['pane_id'] === 'string' && data['pane_id'] !== ''
            ? data['pane_id']
            : typeof pane?.['pane_id'] === 'string' && pane['pane_id'] !== ''
              ? (pane['pane_id'] as string)
              : undefined
        if (!paneId) {
          finish(new HerdrTransportError('herdr_protocol', `event ${String(type)} missing pane identity`, targetLabel))
          return
        }
        onEvent({ type, paneId })
      } catch (err) {
        finish(err)
      }
    }

    const handleLine = (line: string): void => {
      if (stopped) return
      let envelope: Record<string, unknown> | undefined
      try {
        envelope = parseJsonLine(line, targetLabel)
      } catch (err) {
        finish(err)
        return
      }
      if (envelope === undefined) return
      if (envelope['event'] !== undefined) {
        handleEventFrame(envelope)
        return
      }
      // ACK 已在通道层消费验证；resolve 后再到达的 id 帧是通道实现违约，
      // 如实终结（不静默丢弃，也不当成功）。
      finish(new HerdrTransportError('herdr_protocol', 'unexpected post-ack response frame on subscription stream', targetLabel))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      reject(new HerdrTransportError('herdr_aborted', 'subscription aborted', targetLabel))
      return
    }

    channel
      .ipcSubscribe!(
        nodeId,
        {
          ...(target.socketPath !== undefined ? { endpoint: target.socketPath } : {}),
          ...(target.session !== undefined ? { session: target.session } : {}),
          line: JSON.stringify(request),
        },
        (line) => {
          if (stopped) return
          if (!ready) {
            earlyLines.push(line)
            return
          }
          handleLine(line)
        },
        (error) => {
          finish(
            error === undefined
              ? new HerdrTransportError('herdr_disconnected', 'subscription stream closed', targetLabel)
              : new HerdrTransportError('herdr_disconnected', `subscription stream closed: ${error}`, targetLabel),
          )
        },
        signal,
      )
      .then(
        (stop) => {
          if (stopped) {
            // abort 与 resolve 竞态：已终结，这里只兜底释放。
            try {
              stop()
            } catch {
              /* finish 已上报过错误；释放失败不再二次上报 */
            }
            return
          }
          release = stop
          ready = true
          resolve(() => finish(undefined))
          for (const line of earlyLines) {
            if (stopped) break
            handleLine(line)
          }
          earlyLines.length = 0
        },
        (error: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          settled = true
          stopped = true
          reject(error)
        },
      )
  })
}
