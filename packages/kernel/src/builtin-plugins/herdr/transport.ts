import { isIP as nodeIsIP } from 'node:net'

import { HelmError } from '@helm/protocol'
import type { AgentGateResult } from '@helm/protocol'
import type { HerdrCallOptions, HerdrEvent, HerdrTarget, HerdrTransport } from './contracts.js'

/**
 * Herdr 官方 socket RPC 的最小 NDJSON 传输。
 *
 * Wire 契约（herdr 0.9.5 / protocol 22，经 `herdr api schema --json` 与服务端源码核实）：
 * - 一条连接一个请求：写一行 `{"id","method","params"}`，读一行 `{"id","result"}` 或
 *   `{"id","error":{"code","message"}}`，随后连接结束。
 * - `events.subscribe`：先回 `{"id","result":{"type":"subscription_started"}}` ack，
 *   之后每行是裸事件帧 `{"event","data"}`，无 id。
 *
 * 机密纪律：环境变量只经 JSON params（tab.create 的 env 对象）传递，永不落入 herdr
 * 子进程 argv；远端经 `ssh <machine> python3 -u -` 用 stdin 携带「固定脚本 + base64
 * payload 字面量」作为远端 Python 源码，任务与机密内容不出现在任何进程命令行。
 */

export interface HerdrTransportOptions {
  /** 诊断与错误信息脱敏；缺省原样返回。 */
  redact?: (text: string) => string
}

export const HERDR_CALL_TIMEOUT_MS = 120_000
/** agent.start 的服务端启动上限（>3000 且 ≤300000 ms）加传输余量。 */
export const HERDR_START_TIMEOUT_CEILING_MS = 300_000
export const HERDR_START_TIMEOUT_MARGIN_MS = 15_000
/** agent.prompt(wait)/agent.wait 无显式超时时不设客户端死线，交给 signal/服务端。 */
export const HERDR_WAIT_METHODS = new Set(['agent.prompt', 'agent.wait', 'pane.wait_for_output', 'events.wait'])
/** 单帧（单行 JSON）大小上限；订阅流按帧限额，不按连接生命周期累计。 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** 子进程（ssh/gate）stdout/stderr 聚合上限，防止远端异常输出耗尽内存。 */
export const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024
/** Gate 输出保留上限；超限显式失败，绝不静默截断充当成功。 */
export const MAX_GATE_OUTPUT_BYTES = 1024 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const OUTPUT_FILE_PATTERN = /^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/
const SUBSCRIPTION_METHOD = 'events.subscribe'
const SUBSCRIPTION_TYPES = ['pane.created', 'pane.updated', 'pane.closed', 'pane.exited'] as const
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000
/** 子进程组终止宽限：先 TERM 再 KILL，给远端 Python 清理窗口。 */
const TERMINATE_GRACE_MS = 2_000

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
  if (target.machine) return `herdr@${target.machine}`
  if (target.session) return `herdr session ${target.session}`
  if (target.socketPath) return `herdr socket ${target.socketPath}`
  return 'herdr local default session'
}

/** session 名会成为 socket 路径段，字符白名单（与 herdr 侧 validate_name 同向）。 */
export function isValidSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
}

/**
 * machine 作为 ssh 的单一 argv：拒绝选项前缀、控制字符与空白注入。
 * 允许 user@host、SSH 别名、IPv4 与裸/带方括号 IPv6（方括号在去壳后校验）。
 */
export function isValidMachineName(name: string): boolean {
  return normalizeMachineHost(name) !== undefined
}

/** 校验并规范 machine 为 ssh 实际可用的目标（bracket IPv6 去壳）；非法返回 undefined。 */
export function normalizeMachineHost(name: string): string | undefined {
  if (name.length === 0 || name.length > 255) return undefined
  if (/[^\x21-\x7e]/.test(name)) return undefined // 拒绝空白与一切控制字符
  // 冒号不在黑名单：IPv6 需要它；非法冒号形态由 isIP(host)===6 严格拒绝。
  // 方括号允许出现在此阶段（IPv6 包裹），剥壳后残留由后续检查拒绝。
  if (/[\s'"\\;|&$<>`(){},!*=~%^#]/.test(name)) return undefined // 拒绝 shell 元字符
  if (name.startsWith('-')) return undefined // 拒绝被当作 ssh 选项
  let userinfo: string | undefined
  let host = name
  const at = name.lastIndexOf('@')
  if (at >= 0) {
    userinfo = name.slice(0, at)
    host = name.slice(at + 1)
    if (userinfo.length === 0 || host.length === 0) return undefined
    if (!/^[A-Za-z0-9._-]+$/.test(userinfo)) return undefined // 用户名白名单
  }
  // 方括号仅用于整段包裹：半截（'[::1]x'）或残留（'a[b]'）一律拒绝。
  const bracketed = host.startsWith('[') || host.endsWith(']')
  if (bracketed) {
    if (!(host.startsWith('[') && host.endsWith(']') && host.length > 2)) return undefined
    host = host.slice(1, -1)
  } else if (host.includes('[') || host.includes(']')) {
    return undefined
  }
  if (host.includes(':') || bracketed) {
    // 含冒号或方括号形式：必须是严格 IPv6（'::::' 等被 net.isIP 拒绝）。
    if (nodeIsIP(host) !== 6) return undefined
  } else {
    if (host.includes('..')) return undefined
    // 域名/别名/IPv4：字母数字点连下划线（下划线别名是既有用法）。
    if (!/^[A-Za-z0-9._-]+$/.test(host)) return undefined
  }
  return userinfo === undefined ? host : `${userinfo}@${host}`
}

function assertTarget(target: HerdrTarget): void {
  if (target.machine !== undefined && !isValidMachineName(target.machine)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid machine name: ${target.machine}`, describeTarget(target))
  }
  if (target.session !== undefined && !isValidSessionName(target.session)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid session name: ${target.session}`, describeTarget(target))
  }
}

/**
 * socket 解析遵循设计文档优先级，本地与远端一致：
 * target.socketPath > HERDR_SOCKET_PATH > 会话目录（session 或默认）。
 */
export function resolveSocketPath(target: HerdrTarget): string {
  if (target.socketPath) return target.socketPath
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH
  const configHome = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ''}/.config`
  if (target.session) return `${configHome}/herdr/sessions/${target.session}/herdr.sock`
  return `${configHome}/herdr/herdr.sock`
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

function raiseWireError(error: { code?: unknown; message?: unknown }, target: string, redact: (s: string) => string): never {
  const code = typeof error.code === 'string' && error.code ? error.code : 'herdr_error'
  const message = typeof error.message === 'string' && error.message ? redact(error.message) : 'herdr returned an error without a message'
  throw new HerdrTransportError(code, `${code}: ${message}`, target)
}

function checkWireError(envelope: Record<string, unknown>, target: string, redact: (s: string) => string): void {
  if (envelope['error'] !== undefined && envelope['error'] !== null) {
    const body = isObject(envelope['error']) ? envelope['error'] : {}
    raiseWireError(body, target, redact)
  }
}

// --------------------------------------------------------- 本机 socket RPC --

/** 一连接一请求：拿到首个完整响应行即销毁连接。 */
async function callLocal(
  socketPath: string,
  target: string,
  method: string,
  params: Record<string, unknown>,
  options: HerdrCallOptions | undefined,
  redact: (s: string) => string,
): Promise<unknown> {
  const net = await import('node:net')
  const signal = options?.signal
  checkAborted(signal, target)

  const socket = net.connect(socketPath)
  socket.setNoDelay(true)
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
 */
async function subscribeLocal(
  socketPath: string,
  target: string,
  onEvent: (event: HerdrEvent) => void,
  onError: (error: unknown) => void,
  redact: (s: string) => string,
): Promise<() => void> {
  const net = await import('node:net')
  const socket = net.connect(socketPath)
  socket.setNoDelay(true)
  const assembler = new LineAssembler()

  let stopped = false
  let terminated = false
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
      if (stopped) return // stop() 主动关闭不是错误
      failOnce(new HerdrTransportError('herdr_disconnected', terminated ? 'subscription socket closed' : 'subscription socket closed before ack', target))
    })
  })

  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions: SUBSCRIPTION_TYPES.map((type) => ({ type })) } }
  socket.write(`${JSON.stringify(request)}\n`)

  // ack 期限：无论哪条路径失败（超时/坏帧/断线）都必须经 failOnce 关闭 socket，
  // 否则服务端连接悬挂且 close 监听器残留。
  const ackTimer = timeoutPromise(SUBSCRIBE_ACK_TIMEOUT_MS, target)
  try {
    await Promise.race([ack, ackTimer.promise.then((never) => never as never, (err) => {
      failOnce(err)
      throw err
    })])
  } finally {
    ackTimer.clear()
  }

  /** 事件帧 → {type, paneId}；坏帧经终结器上报并停止订阅。 */
  function dispatchEventFrame(frame: Record<string, unknown>): boolean {
    try {
      const type = frame['event']
      if (typeof type !== 'string' || !(SUBSCRIPTION_TYPES as readonly string[]).includes(type)) return true
      const data = isObject(frame['data']) ? frame['data'] : {}
      const pane = isObject(data['pane']) ? data['pane'] : undefined
      const paneId =
        typeof data['pane_id'] === 'string' ? data['pane_id'] : typeof pane?.['pane_id'] === 'string' ? (pane['pane_id'] as string) : undefined
      if (!paneId) {
        failOnce(new HerdrTransportError('herdr_protocol', `event ${String(type)} missing pane identity`, target))
        return false
      }
      onEvent({ type: type as HerdrEvent['type'], paneId })
      return true
    } catch (err) {
      failOnce(err)
      return false
    }
  }

  return () => {
    stopped = true
    socket.destroy()
  }
}

// ------------------------------------------------------------ 远端通道 --

/**
 * 远端固定解释器脚本（函数体定义）：
 * 从「脚本尾部 base64 字面量」解码 payload，按 op 分派，输出一行 JSON 信封后退出。
 * rpc 成功输出 {"result": ..., "error": null} 单一信封（error:null 不是失败）。
 * 文件与 Gate 操作复用与本地相同的安全边界；只依赖 python3 标准库。
 *
 * deadlineMs 语义与 Node 端一致：None 表示不设远端死线（wait 类），
 * agent.start 含服务端启动时间 + 传输余量。
 */
const REMOTE_SCRIPT_BODY = String.raw`
import base64, json, os, re, signal, socket, subprocess, sys, threading

MAX_OUTPUT_BYTES = 33554432
MAX_GATE_OUTPUT_BYTES = 1048576
MAX_FRAME_BYTES = 33554432
OUTPUT_FILE_PATTERN = re.compile(r"^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$")

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def fail(code, message):
    out({"error": {"code": code, "message": message}})

def socket_path(spec):
    if spec.get("socketPath"):
        return spec["socketPath"]
    if os.environ.get("HERDR_SOCKET_PATH"):
        return os.environ["HERDR_SOCKET_PATH"]
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    if spec.get("session"):
        return os.path.join(base, "herdr", "sessions", spec["session"], "herdr.sock")
    return os.path.join(base, "herdr", "herdr.sock")

def read_frame(conn, deadline):
    buf = b""
    while not buf.endswith(b"\n"):
        remaining = None if deadline is None else max(0.0, deadline - time_time())
        if remaining is not None and remaining <= 0:
            raise TimeoutError("rpc deadline exceeded")
        # 无 deadline 的 wait 也必须在 SSH 通道死亡后尽快退出，不留无限辅助进程。
        if CHANNEL_DEAD.is_set():
            raise OSError("ssh channel closed while waiting for rpc response")
        conn.settimeout(0.5)
        try:
            chunk = conn.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_FRAME_BYTES:
            raise OverflowError("rpc frame exceeds limit")
    return buf

def time_time():
    import time
    return time.monotonic()

RPC_ID = "helm-remote-1"

def rpc(spec, method, params, deadline_ms):
    path = socket_path(spec)
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        deadline = None if deadline_ms is None else time_time() + deadline_ms / 1000.0
        conn.settimeout(5.0)
        conn.connect(path)
        conn.settimeout(None)
        conn.sendall(json.dumps({"id": RPC_ID, "method": method, "params": params}).encode() + b"\n")
        buf = read_frame(conn, deadline)
    except TimeoutError as err:
        fail("herdr_timeout", "%s %s: %s" % (method, path, err))
        return
    except OSError as err:
        fail("herdr_socket", "%s %s: %s" % (method, path, err))
        return
    finally:
        conn.close()
    try:
        envelope = json.loads(buf.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as err:
        fail("herdr_protocol", "bad rpc response for %s: %s" % (method, err))
        return
    # 与本机一致的 wire 校验：id 必须存在且匹配；缺 result 与 error 是协议违规。
    if not isinstance(envelope, dict) or envelope.get("id") != RPC_ID:
        fail("herdr_protocol", "rpc response id missing or mismatched for %s" % method)
        return
    if "result" not in envelope and "error" not in envelope:
        fail("herdr_protocol", "rpc response has neither result nor error for %s" % method)
        return
    # 单一信封：成功时 error 为 null；只有真实非空 error 才是失败。
    out({"result": envelope.get("result"), "error": envelope.get("error")})

class MissingOutput(Exception):
    pass

def safe_output_path(cwd, file_name):
    if not OUTPUT_FILE_PATTERN.match(file_name):
        raise ValueError("unsafe output file name: %s" % file_name)
    base = os.path.realpath(cwd)
    parent = os.path.join(base, ".helm")
    if os.path.sep + ".helm" not in parent or not parent.startswith(base + os.path.sep):
        raise ValueError("unsafe .helm path")
    try:
        st = os.lstat(parent)
    except OSError as err:
        if err.errno in (errno_enoent(), errno_enotdir()):
            raise MissingOutput(parent)
        raise IOErrorStamp(err)
    if os.path.stat.S_ISLNK(st.st_mode) or not os.path.stat.S_ISDIR(st.st_mode):
        raise NotADirectoryError(".helm is not a real directory inside cwd")
    return os.path.join(parent, file_name)

class IOErrorStamp(Exception):
    def __init__(self, err):
        super().__init__(str(err))
        self.errno = err.errno

def errno_enotdir():
    import errno
    return errno.ENOTDIR

def read_file(cwd, file_name):
    try:
        path = safe_output_path(cwd, file_name)
    except ValueError as err:
        return {"error": {"code": "herdr_invalid_output_name", "message": str(err)}}
    except MissingOutput as err:
        return {"error": {"code": "herdr_output_missing", "message": "missing: %s" % err}}
    except IOErrorStamp as err:
        return {"error": {"code": "herdr_io", "message": str(err)}}
    except (NotADirectoryError, OSError) as err:
        return {"error": {"code": "herdr_output_escaping", "message": str(err)}}
    try:
        st = os.lstat(path)
        if os.path.stat.S_ISLNK(st.st_mode) or not os.path.isfile(path):
            return {"error": {"code": "herdr_output_not_file", "message": "not a regular file: %s" % path}}
        if st.st_size > MAX_OUTPUT_BYTES:
            return {"error": {"code": "herdr_output_too_large", "message": "output exceeds limit"}}
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read(MAX_OUTPUT_BYTES + 1)
        if len(content.encode("utf-8")) > MAX_OUTPUT_BYTES:
            return {"error": {"code": "herdr_output_too_large", "message": "output grew past limit while reading"}}
        return {"ok": True, "content": content}
    except OSError as err:
        if err.errno == errno_enoent():
            return {"error": {"code": "herdr_output_missing", "message": "missing: %s" % path}}
        return {"error": {"code": "herdr_io", "message": "read %s: %s" % (path, err)}}

def remove_file(cwd, file_name):
    try:
        path = safe_output_path(cwd, file_name)
    except ValueError as err:
        return {"error": {"code": "herdr_invalid_output_name", "message": str(err)}}
    except MissingOutput as err:
        return {"ok": True}
    except IOErrorStamp as err:
        return {"error": {"code": "herdr_io", "message": str(err)}}
    except (NotADirectoryError, OSError) as err:
        return {"error": {"code": "herdr_output_escaping", "message": str(err)}}
    try:
        st = os.lstat(path)
        if os.path.stat.S_ISLNK(st.st_mode) or not os.path.stat.S_ISREG(st.st_mode):
            return {"error": {"code": "herdr_output_not_file", "message": "not a regular file: %s" % path}}
        os.unlink(path)
        return {"ok": True}
    except OSError as err:
        if err.errno == errno_enoent():
            return {"ok": True}
        return {"error": {"code": "herdr_io", "message": "remove %s: %s" % (path, err)}}

def errno_enoent():
    import errno
    return errno.ENOENT

def run_gate(command, cwd, env, timeout_ms):
    import select as _select
    base = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": os.path.expanduser("~")}
    if env:
        base.update({k: v for k, v in env.items() if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k)})
    try:
        proc = subprocess.Popen(
            ["/bin/sh", "-c", command],
            cwd=cwd,
            env=base,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as err:
        return {"ok": False, "output": "spawn failed: %s" % err}
    gate_pgid = None
    try:
        gate_pgid = os.getpgid(proc.pid)
    except OSError:
        pass

    def kill_gate_group():
        if gate_pgid is not None:
            try:
                os.killpg(gate_pgid, signal.SIGKILL)
            except OSError:
                pass

    # 本进程被 TERM/HUP（Node 侧宽限终止 ssh）或通道心跳检测到 SSH 断开时：
    # 立即杀掉自建 Gate 进程组再退出，绝不遗留远端进程。
    def _terminate(signum, frame):
        kill_gate_group()
        os._exit(3)
    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGHUP, _terminate)
    signal.signal(signal.SIGINT, _terminate)
    stop_heartbeat_kill = watch_channel_death(kill_gate_group)

    def finish(result):
        kill_gate_group()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        return result

    # 流式有界读取：达到上限立即杀组并显式失败，绝不先聚合无限输出。
    chunks = []
    total = 0
    deadline = time_time() + (timeout_ms or 600000) / 1000.0
    overflow = False
    timed_out = False
    stdout_fd = proc.stdout.fileno()
    while True:
        remaining = deadline - time_time()
        if remaining <= 0:
            timed_out = True
            break
        try:
            ready, _, _ = _select.select([stdout_fd], [], [], min(0.25, remaining))
        except (OSError, ValueError):
            break
        if not ready:
            if proc.poll() is not None and not overflow:
                # 进程退出：排空残余后结束
                pass
            continue
        try:
            chunk = os.read(stdout_fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_GATE_OUTPUT_BYTES:
            overflow = True
            break
        chunks.append(chunk)
    if overflow:
        stop_heartbeat_kill()
        return finish({"ok": False, "output": "gate output exceeded %d bytes" % MAX_GATE_OUTPUT_BYTES})
    output = b"".join(chunks)
    try:
        rc = proc.poll()
        if rc is None:
            try:
                rc = proc.wait(timeout=max(0.0, deadline - time_time()))
            except subprocess.TimeoutExpired:
                timed_out = True
                kill_gate_group()
                rc = proc.wait(timeout=5)
        else:
            rc = proc.wait()
    except Exception:
        rc = -1
    text = output.decode("utf-8", "replace")
    stop_heartbeat_kill()
    if timed_out:
        return {"ok": False, "output": "gate timed out\n" + text}
    return {"ok": rc == 0, "output": text}

CHANNEL_DEAD = threading.Event()

_CHANNEL_WATCHERS = []

def watch_channel_death(callback):
    """通道死亡时执行回调（如杀 Gate 组）；返回取消函数。"""
    entry = [callback]
    _CHANNEL_WATCHERS.append(entry)
    def cancel():
        try:
            _CHANNEL_WATCHERS.remove(entry)
        except ValueError:
            pass
    return cancel

def _channel_heartbeat():
    # stderr 心跳空行：SSH 通道断开后 write 抛 BrokenPipeError/EBADF，
    # 据此标记通道死亡并触发 watchers（杀 Gate 组等）。不携带任何敏感值。
    while not CHANNEL_DEAD.is_set():
        time_sleep(1.0)
        try:
            sys.stderr.write("\n")
            sys.stderr.flush()
        except (BrokenPipeError, OSError, ValueError):
            CHANNEL_DEAD.set()
            for entry in list(_CHANNEL_WATCHERS):
                try:
                    entry[0]()
                except Exception:
                    pass
            return

def time_sleep(seconds):
    import time
    time.sleep(seconds)

def main(payload):
    watcher = threading.Thread(target=_channel_heartbeat, daemon=True)
    watcher.start()
    op = payload.get("op")
    if op == "rpc":
        rpc(payload.get("target") or {}, payload.get("method") or "", payload.get("params") or {}, payload.get("deadlineMs"))
    elif op == "readFile":
        out(read_file(payload.get("cwd") or "", payload.get("fileName") or ""))
    elif op == "removeFile":
        out(remove_file(payload.get("cwd") or "", payload.get("fileName") or ""))
    elif op == "runGate":
        out(run_gate(payload.get("command") or "", payload.get("cwd") or "", payload.get("env"), payload.get("timeoutMs")))
    else:
        fail("herdr_protocol", "unknown op: %r" % op)
    CHANNEL_DEAD.set()
`

interface RemotePayload {
  op: 'rpc' | 'readFile' | 'removeFile' | 'runGate'
  target?: { session?: string; socketPath?: string }
  method?: string
  params?: Record<string, unknown>
  cwd?: string
  fileName?: string
  command?: string
  env?: Record<string, string>
  timeoutMs?: number
  deadlineMs?: number | null
}

interface RemoteEnvelope {
  result?: unknown
  ok?: boolean
  content?: string
  output?: string
  error?: { code?: unknown; message?: unknown } | null
}

interface ChildRunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  spawnError?: Error
}

/**
 * 子进程统一控制：有限输出聚合上限、预 abort 检查、timeout/abort 杀自建进程组后
 * 等待真正退出、listener/timer 全清理。非 interactive（无 tty）仅用于 ssh。
 */
async function runChild(
  command: string,
  args: string[],
  options: {
    stdinData?: Buffer
    timeoutMs?: number
    signal?: AbortSignal
    target: string
    redact: (s: string) => string
    /** 子进程工作目录（Gate 必须；ssh 通道用当前目录）。 */
    cwd?: string
    /** 白名单环境（Gate 用）；ssh 通道不继承宿主环境。 */
    envOverride?: Record<string, string>
  },
): Promise<ChildRunResult> {
  const childProcess = await import('node:child_process')
  const { stdinData, timeoutMs, signal, target, redact, cwd, envOverride } = options
  checkAborted(signal, target)

  const child = childProcess.spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    cwd,
    env: envOverride,
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let totalBytes = 0 // stdout+stderr 合计上限
  let spawnError: Error | undefined
  let outputOverflow = false
  let closed = false
  let terminating = false

  const onStdout = (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > MAX_CHILD_OUTPUT_BYTES) {
      outputOverflow = true
      killGroup()
      return
    }
    stdoutChunks.push(chunk)
  }
  const onStderr = (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > MAX_CHILD_OUTPUT_BYTES) {
      outputOverflow = true
      killGroup()
      return
    }
    stderrChunks.push(chunk)
  }
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', onStderr)
  child.once('error', (err) => {
    spawnError = err
    killGroup()
  })

  const rawKillGroup = () => {
    if (closed) return
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  /** 先 TERM（宽限内允许清理），超时或宽限期满再 KILL；幂等。 */
  const terminateGroup = () => {
    if (closed || terminating) return
    terminating = true
    // close 才说明管道已释放；主进程 exit 后其子进程仍可能持有输出管道。
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
    } catch {
      rawKillGroup()
      return
    }
    const grace = setTimeout(rawKillGroup, TERMINATE_GRACE_MS)
    grace.unref?.()
    exited.then(() => clearTimeout(grace), () => clearTimeout(grace))
  }
  const killGroup = terminateGroup

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true
      resolve({ code, signal })
    })
  })

  const timer = timeoutMs === undefined ? undefined : timeoutPromise(timeoutMs, target)
  const onAbort = () => killGroup()
  signal?.addEventListener('abort', onAbort, { once: true })

  if (stdinData !== undefined) {
    child.stdin?.on('error', () => {
      /* 早退 EPIPE 由 exit/spawn error 承载 */
    })
    child.stdin?.end(stdinData)
  } else {
    child.stdin?.end()
  }

  let exit: { code: number | null; signal: NodeJS.Signals | null }
  try {
    const racers: Promise<{ code: number | null; signal: NodeJS.Signals | null }>[] = [exited]
    if (timer) racers.push(timer.promise.then(() => ({ code: null, signal: null })))
    exit = await Promise.race(racers)
  } finally {
    timer?.clear()
    signal?.removeEventListener('abort', onAbort)
    killGroup() // TERM->KILL 宽限终止；之后等待真实退出，不留悬挂子进程
    await exited
  }

  checkAborted(signal, target)
  if (outputOverflow) {
    throw new HerdrTransportError('herdr_remote_output_too_large', `child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes`, target)
  }
  if (spawnError) {
    const notFound = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
    throw new HerdrTransportError(
      notFound ? 'herdr_spawn_not_found' : 'herdr_spawn_failed',
      `failed to spawn ${command}: ${redact(spawnError.message)}`,
      target,
      { cause: spawnError },
    )
  }
  return { ...exit, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) }
}

/**
 * 远端执行：ssh -T BatchMode（无 tty、无交互），远端命令固定 `python3 -u -`。
 * stdin 是「完整固定脚本 + base64 payload 字面量」的 Python 源码；
 * 任务内容与机密值绝不进入 ssh/herdr 进程 argv。
 */
async function runRemote(
  machine: string,
  payload: RemotePayload,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  redact: (s: string) => string,
): Promise<RemoteEnvelope> {
  const target = describeTarget({ machine })
  const payloadJson = JSON.stringify(payload)
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64')
  // 脚本尾部以字面量调用 main：base64 字符串经 JSON 引号包装，安全嵌入源码。
  const source = `${REMOTE_SCRIPT_BODY}\nmain(json.loads(base64.b64decode(${JSON.stringify(encoded)})))\n`
  const stdinData = Buffer.from(source, 'utf8')

  // bracket IPv6 规范为裸 host 后再交给 ssh（ssh 不接受带方括号目标）。
  const sshTarget = normalizeMachineHost(machine)
  if (sshTarget === undefined) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid machine name: ${machine}`, target)
  }
  const exit = await runChild(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '--', sshTarget, 'python3 -u -'],
    { stdinData, timeoutMs, signal, target, redact },
  )

  const text = exit.stdout.toString('utf8').trim()
  const errText = exit.stderr.toString('utf8').trim()
  if (exit.code !== 0) {
    if (signal?.aborted) {
      throw new HerdrTransportError('herdr_aborted', `remote operation on ${machine} aborted`, target)
    }
    const cause = exit.code === 127 ? 'python3 or ssh not found on remote' : `exit ${exit.code ?? `signal ${exit.signal}`}`
    const detail = errText ? `: ${redact(errText).slice(-800)}` : ''
    const code = exit.code === 127 ? 'herdr_remote_python_missing' : 'herdr_remote_failed'
    throw new HerdrTransportError(code, `ssh ${machine} ${cause}${detail}`, target)
  }
  if (!text) {
    throw new HerdrTransportError('herdr_remote_failed', `ssh ${machine} produced no output`, target)
  }
  const envelope = parseJsonLine(text, target)
  if (!envelope || !('result' in envelope || 'ok' in envelope || 'error' in envelope)) {
    // 不回显原始内容，只报协议错误（原文可能含机密）。
    throw new HerdrTransportError('herdr_protocol', 'unexpected remote envelope', target)
  }
  return envelope as RemoteEnvelope
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
  checkAborted(signal, target)
  const path = await resolveLocalOutputPath(cwd, fileName, target)
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${path}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${redact(String(err))}`, target, { cause: err })
  }
  if (!stat.isFile()) {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
  }
  if (stat.size > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, target)
  }
  const content = await fs.readFile(path, 'utf8')
  if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, target)
  }
  return content
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

function validEnvEntries(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

/** 本机 Gate：受限 env、完整输出（限额内）、abort/超时杀自建进程组并等待退出。 */
async function runLocalGate(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  target: string,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) childEnv[key] = value
  const exit = await runChild('/bin/sh', ['-c', command], {
    stdinData: undefined,
    timeoutMs: 600_000,
    signal,
    target,
    redact,
    cwd,
    envOverride: childEnv,
  })
  const output = redact(exit.stdout.toString('utf8') + exit.stderr.toString('utf8'))
  if (Buffer.byteLength(output, 'utf8') > MAX_GATE_OUTPUT_BYTES) {
    return { ok: false, output: `gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes` }
  }
  return { ok: exit.code === 0, output }
}

// ------------------------------------------------------------- 工厂 --

export function createHerdrTransport(options?: HerdrTransportOptions): HerdrTransport {
  const redact = options?.redact ?? ((text: string) => text)

  async function call(target: HerdrTarget, method: string, params: Record<string, unknown>, callOptions?: HerdrCallOptions): Promise<unknown> {
    assertTarget(target)
    if (target.machine) {
      const resolved = resolveCallTimeoutMs(method, params, callOptions)
      // 远端多一层 ssh 进程：有限死线外加传输余量；无限死线（wait 类）保持无限。
      const remoteDeadline = resolved === undefined ? null : resolved + HERDR_START_TIMEOUT_MARGIN_MS
      const payload: RemotePayload = {
        op: 'rpc',
        target: { session: target.session, socketPath: target.socketPath },
        method,
        params,
        deadlineMs: remoteDeadline,
      }
      const envelope = await runRemote(
        target.machine,
        payload,
        callOptions?.signal,
        remoteDeadline === null ? undefined : remoteDeadline ?? undefined,
        redact,
      )
      checkWireError(envelope as Record<string, unknown>, describeTarget(target), redact)
      return envelope.result
    }
    return callLocal(resolveSocketPath(target), describeTarget(target), method, params, callOptions, redact)
  }

  return {
    call,
    async readOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      if (target.machine) {
        const envelope = await runRemote(target.machine, { op: 'readFile', cwd, fileName, deadlineMs: 30_000 }, signal, 60_000, redact)
        if (envelope.error && typeof envelope.error === 'object') {
          const code = typeof envelope.error.code === 'string' ? envelope.error.code : 'herdr_io'
          if (code === 'herdr_output_missing') {
            throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
          }
          raiseWireError(envelope.error, describeTarget(target), redact)
        }
        if (typeof envelope.content !== 'string') {
          throw new HerdrTransportError('herdr_protocol', 'remote readFile returned no content', describeTarget(target))
        }
        return envelope.content
      }
      return readLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async removeOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      if (target.machine) {
        const envelope = await runRemote(target.machine, { op: 'removeFile', cwd, fileName, deadlineMs: 30_000 }, signal, 60_000, redact)
        if (envelope.error && typeof envelope.error === 'object') {
          raiseWireError(envelope.error, describeTarget(target), redact)
        }
        return
      }
      await removeLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async runGate(target, command, cwd, signal, env) {
      assertTarget(target)
      if (target.machine) {
        const envelope = await runRemote(
          target.machine,
          {
            op: 'runGate',
            cwd,
            command,
            env: env && Object.fromEntries(validEnvEntries(env)),
            timeoutMs: 600_000,
          },
          signal,
          620_000,
          redact,
        )
        if (envelope.error && typeof envelope.error === 'object') {
          raiseWireError(envelope.error, describeTarget(target), redact)
        }
        if (typeof envelope.ok !== 'boolean' || typeof envelope.output !== 'string') {
          throw new HerdrTransportError('herdr_protocol', 'remote runGate returned malformed result', describeTarget(target))
        }
        return { ok: envelope.ok, output: redact(envelope.output) }
      }
      return runLocalGate(command, cwd, signal, env, describeTarget(target), redact)
    },
    subscribe(target, onEvent, onError) {
      assertTarget(target)
      if (target.machine) {
        // 远端没有事件流转发通道；订阅契约只承诺本机 socket。显式失败，不静默降级。
        return Promise.reject(
          new HerdrTransportError('herdr_subscribe_unsupported', 'event subscription is only supported on the local herdr socket', describeTarget(target)),
        )
      }
      return subscribeLocal(resolveSocketPath(target), describeTarget(target), onEvent, onError, redact)
    },
  }
}
