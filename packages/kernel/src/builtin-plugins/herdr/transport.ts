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
 * 子进程 argv；远端经 `ssh <machine> python3 -u -` 用 stdin 携带 base64 JSON payload，
 * 由远端 Python 直连官方 socket RPC，任务与机密内容不出现在任何进程命令行。
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
export const MAX_LINE_BYTES = 32 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const OUTPUT_FILE_PATTERN = /^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/
const SUBSCRIPTION_METHOD = 'events.subscribe'
const SUBSCRIPTION_TYPES = ['pane.created', 'pane.updated', 'pane.closed', 'pane.exited'] as const

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

/** machine 作为 ssh 的单一 argv：拒绝选项前缀、控制字符与空白注入。 */
export function isValidMachineName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/.test(name)
}

function assertTarget(target: HerdrTarget): void {
  if (target.machine !== undefined && !isValidMachineName(target.machine)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid machine name: ${target.machine}`, describeTarget(target))
  }
  if (target.session !== undefined && !isValidSessionName(target.session)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid session name: ${target.session}`, describeTarget(target))
  }
}

/** socket 解析：调用方显式 target.socketPath 最优先，其次 HERDR_SOCKET_PATH，最后默认会话目录。 */
function resolveSocketPath(target: HerdrTarget): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ''}/.config`
  if (target.session) return `${configHome}/herdr/sessions/${target.session}/herdr.sock`
  if (target.socketPath) return target.socketPath
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH
  return `${configHome}/herdr/herdr.sock`
}

/** 按 \n 分帧；不完整 UTF-8 尾部留在 pending，跨 chunk 拼接。 */
class LineAssembler {
  private pending?: Uint8Array
  private buffer = ''
  private bytes = 0

  push(chunk: Buffer): string[] {
    const merged = this.pending ? Buffer.concat([Buffer.from(this.pending), chunk]) : chunk
    this.pending = undefined
    if (merged.includes(0)) {
      throw new HerdrTransportError('herdr_protocol', 'socket stream contained NUL byte', 'herdr socket')
    }
    this.bytes += merged.length
    if (this.bytes > MAX_LINE_BYTES) {
      throw new HerdrTransportError('herdr_response_too_large', `response exceeded ${MAX_LINE_BYTES} bytes`, 'herdr socket')
    }
    const lines = (this.buffer + merged.toString('utf8')).split('\n')
    this.buffer = lines.pop() ?? ''
    return lines
  }

  /** EOF 时若有残留字节（服务端未带换行关闭）按最后一行处理；不完整 UTF-8 视为协议错误。 */
  flush(): string[] {
    if (this.pending) {
      throw new HerdrTransportError('herdr_protocol', 'incomplete UTF-8 sequence at stream end', 'herdr socket')
    }
    const rest = this.buffer
    this.buffer = ''
    return rest ? [rest] : []
  }
}

function parseJsonLine(line: string, target: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    throw new HerdrTransportError('herdr_protocol', `invalid JSON line: ${trimmed.slice(0, 200)}`, target, { cause })
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
  if (envelope['error'] !== undefined) {
    const body = isObject(envelope['error']) ? envelope['error'] : {}
    raiseWireError(body, target, redact)
  }
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

function optionalTimeout(ms: number | undefined, target: string): { promise: Promise<never>; clear: () => void } {
  if (ms === undefined) return { promise: new Promise<never>(() => {}), clear: () => {} }
  return timeoutPromise(ms, target)
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

// --------------------------------------------------------------- 本机 RPC --

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
  const timer = optionalTimeout(timeoutMs, target)

  const firstLine = new Promise<string>((resolve, reject) => {
    const settle = (outcome: Promise<string>) => {
      socket.destroy()
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

  const onAbort = () => socket.destroy()
  signal?.addEventListener('abort', onAbort, { once: true })
  let line: string
  try {
    socket.write(`${JSON.stringify({ id: '1', method, params })}\n`)
    line = timeoutMs === undefined ? await firstLine : await Promise.race([firstLine, timer.promise])
  } finally {
    timer.clear()
    signal?.removeEventListener('abort', onAbort)
    socket.destroy()
  }

  if (signal?.aborted) throw new HerdrTransportError('herdr_aborted', 'call aborted', target)
  const envelope = parseJsonLine(line, target)
  if (!envelope) throw new HerdrTransportError('herdr_protocol', 'empty response line', target)
  checkWireError(envelope, target, redact)
  return envelope['result']
}

// ------------------------------------------------------- 本机事件订阅流 --

/** 订阅流：ack 后每行一个裸事件帧；任何终止路径都必须显式上报，不静默断线。 */
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
  let acked = false

  const ack = new Promise<void>((resolve, reject) => {
    socket.once('error', (err) => {
      if (acked || stopped) return
      reject(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, target, { cause: err }))
    })
    socket.once('close', () => {
      if (!acked && !stopped) {
        reject(new HerdrTransportError('herdr_disconnected', 'subscription socket closed before ack', target))
      }
    })
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = assembler.push(chunk)
      } catch (err) {
        socket.destroy()
        if (!acked) reject(err)
        else onError(err)
        return
      }
      for (const line of lines) {
        const envelope = parseJsonLine(line, target)
        if (!envelope) continue
        if (envelope['event'] !== undefined) {
          // ack 之前到达的事件帧：仍按序分发，不丢弃。
          if (!tryDispatch(envelope, onEvent, target, onError)) return
          continue
        }
        if (envelope['result'] !== undefined || envelope['error'] !== undefined) {
          if (envelope['error'] !== undefined) {
            const body = isObject(envelope['error']) ? envelope['error'] : {}
            socket.destroy()
            const code = typeof body['code'] === 'string' && body['code'] ? body['code'] : 'herdr_error'
            const rawMessage = typeof body['message'] === 'string' && body['message'] ? redact(body['message']) : 'herdr returned an error without a message'
            reject(new HerdrTransportError(code, `${code}: ${rawMessage}`, target))
            return
          }
          const result = envelope['result']
          const type = isObject(result) ? result['type'] : undefined
          if (type === 'subscription_started') {
            acked = true
            resolve()
            return
          }
          const snapshot = JSON.stringify(result).slice(0, 200)
          socket.destroy()
          reject(new HerdrTransportError('herdr_protocol', `unexpected subscription ack: ${snapshot}`, target))
          return
        }
      }
    })
    socket.once('close', () => {
      if (!acked && !stopped) {
        reject(new HerdrTransportError('herdr_disconnected', 'subscription socket closed before ack', target))
      }
    })
  })

  socket.once('error', (err) => {
    if (acked && !stopped) {
      onError(new HerdrTransportError('herdr_socket', `subscription socket error: ${redact(err.message)}`, target, { cause: err }))
    }
  })
  socket.once('close', () => {
    if (acked && !stopped) {
      onError(new HerdrTransportError('herdr_disconnected', 'subscription socket closed unexpectedly', target))
    }
  })

  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions: SUBSCRIPTION_TYPES.map((type) => ({ type })) } }
  socket.write(`${JSON.stringify(request)}\n`)
  await ack
  return () => {
    stopped = true
    socket.destroy()
  }
}

/** 裸事件帧 → 规范化 {type, paneId}；坏帧上报 onError 并终止订阅。 */
function tryDispatch(
  frame: Record<string, unknown>,
  onEvent: (event: HerdrEvent) => void,
  target: string,
  onError: (error: unknown) => void,
): boolean {
  try {
    const type = frame['event']
    if (typeof type !== 'string' || !(SUBSCRIPTION_TYPES as readonly string[]).includes(type)) return true
    const data = isObject(frame['data']) ? frame['data'] : {}
    const pane = isObject(data['pane']) ? data['pane'] : undefined
    const paneId = typeof data['pane_id'] === 'string' ? data['pane_id'] : typeof pane?.['pane_id'] === 'string' ? pane['pane_id'] : undefined
    if (!paneId) throw new HerdrTransportError('herdr_protocol', `event ${type} missing pane identity`, target)
    onEvent({ type: type as HerdrEvent['type'], paneId })
    return true
  } catch (err) {
    onError(err)
    return false
  }
}

// ------------------------------------------------------------ 远端通道 --

/**
 * 远端固定解释器脚本：从 stdin 读一行 base64 JSON payload，按 op 分派，
 * 输出一行 JSON 信封后退出。文件与 Gate 操作复用与本地相同的安全边界。
 * 只依赖 python3 标准库（socket/json/os/subprocess/base64）。
 */
const REMOTE_SCRIPT = String.raw`
import base64, json, os, re, signal, socket, subprocess, sys

MAX_OUTPUT_BYTES = 33554432
OUTPUT_FILE_PATTERN = re.compile(r"^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$")

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def fail(code, message):
    out({"error": {"code": code, "message": message}})

def socket_path(spec):
    if spec.get("session"):
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        return os.path.join(base, "herdr", "sessions", spec["session"], "herdr.sock")
    if spec.get("socketPath"):
        return spec["socketPath"]
    if os.environ.get("HERDR_SOCKET_PATH"):
        return os.environ["HERDR_SOCKET_PATH"]
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "herdr", "herdr.sock")

def rpc(spec, method, params):
    path = socket_path(spec)
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.settimeout(float(params.get("timeout_s") or 120))
        conn.connect(path)
        conn.sendall(json.dumps({"id": "1", "method": method, "params": params}).encode() + b"\n")
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
    except OSError as err:
        fail("herdr_socket", "%s %s: %s" % (method, path, err))
        return None
    finally:
        conn.close()
    try:
        envelope = json.loads(buf.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as err:
        fail("herdr_protocol", "bad rpc response for %s: %s" % (method, err))
        return None
    return {"result": envelope.get("result"), "error": envelope.get("error")}

def safe_output_path(cwd, file_name):
    if not OUTPUT_FILE_PATTERN.match(file_name):
        raise ValueError("unsafe output file name: %s" % file_name)
    return os.path.join(os.path.abspath(cwd), ".helm", file_name)

def read_file(cwd, file_name):
    try:
        path = safe_output_path(cwd, file_name)
    except ValueError as err:
        return {"error": {"code": "herdr_invalid_output_name", "message": str(err)}}
    try:
        st = os.lstat(path)
        if not os.path.isfile(path) or stat_is_link(st):
            return {"error": {"code": "herdr_output_not_file", "message": "not a regular file: %s" % path}}
        if st.st_size > MAX_OUTPUT_BYTES:
            return {"error": {"code": "herdr_output_too_large", "message": "output exceeds limit"}}
        with open(path, "r", encoding="utf-8") as handle:
            return {"ok": True, "content": handle.read()}
    except OSError as err:
        if err.errno == errno_enoent():
            return {"error": {"code": "herdr_output_missing", "message": "missing: %s" % path}}
        return {"error": {"code": "herdr_io", "message": "read %s: %s" % (path, err)}}

def stat_is_link(st):
    return os.path.stat.S_ISLNK(st.st_mode)

def remove_file(cwd, file_name):
    try:
        path = safe_output_path(cwd, file_name)
    except ValueError as err:
        return {"error": {"code": "herdr_invalid_output_name", "message": str(err)}}
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
    return getattr(__import__("errno"), "ENOENT", 2)

def run_gate(command, cwd, env, timeout_ms):
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
    try:
        output, _ = proc.communicate(timeout=(timeout_ms or 600000) / 1000.0)
        return {"ok": proc.returncode == 0, "output": output.decode("utf-8", "replace")[-8000:]}
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        output, _ = proc.communicate()
        return {"ok": False, "output": ("gate timed out\n" + output.decode("utf-8", "replace"))[-8000:]}

def main():
    try:
        payload = json.loads(base64.b64decode(sys.stdin.readline()))
    except Exception as err:
        fail("herdr_protocol", "bad payload: %s" % err)
        return
    op = payload.get("op")
    if op == "rpc":
        result = rpc(payload.get("target") or {}, payload.get("method") or "", payload.get("params") or {})
        if result is not None:
            out(result)
    elif op == "readFile":
        out(read_file(payload.get("cwd") or "", payload.get("fileName") or ""))
    elif op == "removeFile":
        out(remove_file(payload.get("cwd") or "", payload.get("fileName") or ""))
    elif op == "runGate":
        out(run_gate(payload.get("command") or "", payload.get("cwd") or "", payload.get("env"), payload.get("timeoutMs")))
    else:
        fail("herdr_protocol", "unknown op: %r" % op)

main()
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
}

interface RemoteEnvelope {
  result?: unknown
  ok?: boolean
  content?: string
  output?: string
  error?: { code?: unknown; message?: unknown }
}

/**
 * 远端执行：ssh -T BatchMode（无 tty、无交互），远端命令固定 `python3 -u -`，
 * payload 仅经 stdin。argv 中不含任务内容与机密值。
 */
async function runRemote(
  machine: string,
  payload: RemotePayload,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  redact: (s: string) => string,
): Promise<RemoteEnvelope> {
  const childProcess = await import('node:child_process')
  const target = describeTarget({ machine })
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  const child = childProcess.spawn('ssh', ['-T', '-o', 'BatchMode=yes', '--', machine, 'python3 -u -'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => stdout.push(c))
  child.stderr.on('data', (c: Buffer) => stderr.push(c))
  child.stdin.on('error', () => {
    /* ssh 早退时 EPIPE 属预期，失败路径由 exit code 承载 */
  })
  child.stdin.write(`${encoded}\n`)
  child.stdin.end()

  const timer = optionalTimeout(timeoutMs, target)
  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, sig) => resolve({ code, signal: sig }))
  })

  let exit: { code: number | null; signal: NodeJS.Signals | null }
  try {
    exit = await (timeoutMs === undefined ? exited : Promise.race([exited, timer.promise]))
  } catch (err) {
    child.kill('SIGKILL')
    throw err
  } finally {
    timer.clear()
    signal?.removeEventListener('abort', onAbort)
  }

  const text = Buffer.concat(stdout).toString('utf8').trim()
  const errText = Buffer.concat(stderr).toString('utf8').trim()
  if (exit.code !== 0) {
    if (signal?.aborted) {
      throw new HerdrTransportError('herdr_aborted', `remote operation on ${machine} aborted`, target)
    }
    const cause = exit.code === 127 ? 'python3 or ssh not found on remote' : `exit ${exit.code ?? `signal ${exit.signal}`}`
    const detail = errText ? `: ${redact(errText.slice(-800))}` : ''
    const code = exit.code === 127 ? 'herdr_remote_python_missing' : 'herdr_remote_failed'
    throw new HerdrTransportError(code, `ssh ${machine} ${cause}${detail}`, target)
  }
  if (!text) {
    throw new HerdrTransportError('herdr_remote_failed', `ssh ${machine} produced no output`, target)
  }
  const envelope = parseJsonLine(text, target)
  if (!envelope || !('result' in envelope || 'ok' in envelope || 'error' in envelope)) {
    throw new HerdrTransportError('herdr_protocol', `unexpected remote envelope: ${text.slice(0, 200)}`, target)
  }
  return envelope
}

// ------------------------------------------------------- 文件与门禁 --

function assertSafeOutputName(fileName: string, target: string): void {
  if (!OUTPUT_FILE_PATTERN.test(fileName)) {
    throw new HerdrTransportError('herdr_invalid_output_name', `refusing unsafe output file name: ${fileName}`, target)
  }
}

function joinOutputPath(cwd: string, fileName: string): string {
  return `${cwd.replace(/\/+$/, '')}/.helm/${fileName}`
}

async function readLocalOutput(path: string, signal: AbortSignal | undefined, target: string): Promise<string> {
  const fs = await import('node:fs/promises')
  checkAborted(signal, target)
  let stat
  try {
    stat = await fs.lstat(path)
  } catch {
    // 与插件约定的自愈边界码：仅文件缺失走 404，其余 IO 错误显式失败。
    throw new HelmError('herdr_output_missing', `交接文件不存在: ${path}`, 404)
  }
  if (!stat.isFile()) {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
  }
  if (stat.size > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, target)
  }
  return fs.readFile(path, 'utf8')
}

async function removeLocalOutput(path: string, signal: AbortSignal | undefined, target: string): Promise<void> {
  const fs = await import('node:fs/promises')
  checkAborted(signal, target)
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    await fs.unlink(path)
  } catch (err) {
    if (err instanceof HerdrTransportError || err instanceof HelmError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${String(err)}`, target, { cause: err })
  }
}

function validEnvEntries(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

/** 本机 Gate：在指定 cwd 以受限 env 运行，保留输出尾部；abort/超时杀掉自己创建的进程。 */
async function runLocalGate(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  target: string,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  const childProcess = await import('node:child_process')
  const childEnv: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) childEnv[key] = value
  // detached+进程组：`sh -c "sleep 30"` 的 sh 可能先于子孙退出，孤儿进程仍持有 stdout
  // 管道使 close 永不触发（实测挂起根因），必须杀整组。
  const child = childProcess.spawn('/bin/sh', ['-c', command], { cwd, env: childEnv, detached: true })
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  const chunks: Buffer[] = []
  child.stdout?.on('data', (c: Buffer) => chunks.push(c))
  child.stderr?.on('data', (c: Buffer) => chunks.push(c))
  const timer = timeoutPromise(600_000, target)
  const onAbort = () => killGroup()
  signal?.addEventListener('abort', onAbort, { once: true })
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null))
    child.once('close', (code) => resolve(code))
  })
  let code: number | null
  try {
    code = await Promise.race([exited, timer.promise.then(() => null)])
  } finally {
    timer.clear()
    signal?.removeEventListener('abort', onAbort)
    killGroup()
  }
  const output = Buffer.concat(chunks).toString('utf8')
  return { ok: code === 0, output: redact(output.slice(-8000)) }
}

// ------------------------------------------------------------- 工厂 --

export function createHerdrTransport(options?: HerdrTransportOptions): HerdrTransport {
  const redact = options?.redact ?? ((text: string) => text)

  async function call(target: HerdrTarget, method: string, params: Record<string, unknown>, callOptions?: HerdrCallOptions): Promise<unknown> {
    assertTarget(target)
    if (target.machine) {
      const payload: RemotePayload = {
        op: 'rpc',
        target: { session: target.session, socketPath: target.socketPath },
        method,
        params,
      }
      const resolved = resolveCallTimeoutMs(method, params, callOptions)
      // 远端多一层 ssh 进程：有限死线外加传输余量；无限死线（wait 类）保持无限。
      const remoteTimeout = resolved === undefined ? undefined : resolved + HERDR_START_TIMEOUT_MARGIN_MS
      const envelope = await runRemote(target.machine, payload, callOptions?.signal, remoteTimeout, redact)
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
        const envelope = await runRemote(target.machine, { op: 'readFile', cwd, fileName, timeoutMs: 30_000 }, signal, 60_000, redact)
        if (envelope.error) {
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
      return readLocalOutput(joinOutputPath(cwd, fileName), signal, describeTarget(target))
    },
    async removeOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      if (target.machine) {
        const envelope = await runRemote(target.machine, { op: 'removeFile', cwd, fileName, timeoutMs: 30_000 }, signal, 60_000, redact)
        checkWireError(envelope as Record<string, unknown>, describeTarget(target), redact)
        return
      }
      await removeLocalOutput(joinOutputPath(cwd, fileName), signal, describeTarget(target))
    },
    async runGate(target, command, cwd, signal, env) {
      assertTarget(target)
      if (target.machine) {
        const envelope = await runRemote(
          target.machine,
          { op: 'runGate', cwd, command, env: env && Object.fromEntries(validEnvEntries(env)), timeoutMs: 600_000 },
          signal,
          620_000,
          redact,
        )
        checkWireError(envelope as Record<string, unknown>, describeTarget(target), redact)
        if (typeof envelope.ok !== 'boolean' || typeof envelope.output !== 'string') {
          throw new HerdrTransportError('herdr_protocol', 'remote runGate returned malformed result', describeTarget(target))
        }
        return { ok: envelope.ok, output: envelope.output }
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
