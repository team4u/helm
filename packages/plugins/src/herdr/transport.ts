import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Socket } from 'node:net'
import { connectHerdrEndpoint } from './local-node-channel.js'
import type {
  HerdrCallOptions,
  HerdrEvent,
  HerdrNodeChannel,
  HerdrSubscribeOptions,
  HerdrTarget,
  HerdrTransport,
} from './contracts.js'
import { targetNodeId } from './contracts.js'
import { assertSafeOutputName, isWindowsShapedPath, readLocalOutput, readNodeOutput, removeLocalOutput, removeNodeOutput } from './transport-output.js'
import { runLocalGate, runNodeGate } from './transport-gate.js'
import { checkAborted, HerdrTransportError } from './transport-shared.js'

// Split re-exports: handoff-file IO and Gate execution moved to sibling submodules; existing consumers
// importing the exported symbols from transport.js (executor / local-node-channel / tests) are unchanged.
export { MAX_OUTPUT_BYTES, isAbsoluteAnyPath, isWindowsShapedPath, pathContains } from './transport-output.js'
export { MAX_GATE_OUTPUT_BYTES } from './transport-gate.js'
export { HerdrTransportError } from './transport-shared.js'

/**
 * Minimal NDJSON transport for the official Herdr line-protocol IPC.
 *
 * Wire contract (herdr 0.9.5 / protocol 22, verified via `herdr api schema --json` and server source):
 * - one request per connection: write a line `{"id","method","params"}`, read a line `{"id","result"}` or
 *   `{"id","error":{"code","message"}}`, then the connection ends.
 * - `events.subscribe`: first replies with the `{"id","result":{"type":"subscription_started"}}` ack,
 *   afterwards each line is a bare event frame `{"event","data"}` with no id.
 *
 * Secret discipline: environment variables travel only inside JSON params (tab.create's env object), never
 * into any process command line. Remote nodes always forward the single-line JSON request via `HerdrNodeChannel`
 * (the kernel EnvFabric node channel); tasks and secret contents never appear in any argv.
 *
 * Local endpoint resolution (aligned with herdr source `config/io.rs` + `session.rs` + `ipc.rs`;
 * XDG_CONFIG_HOME takes precedence over platform dirs):
 * - Unix: `${XDG_CONFIG_HOME ?? ~/.config}/herdr[/sessions/<name>]/herdr.sock` (a UDS file);
 * - Windows: `${XDG_CONFIG_HOME ?? %APPDATA% ?? USERPROFILE/AppData/Roaming}/herdr/.../herdr.sock`
 *   it is only a marker file -- the real endpoint is a Named Pipe (at connect time, join per the
 *   interprocess pathcvt rules with the `\\.\\pipe\\` prefix; never treat the marker file path as a connectable endpoint).
 *
 * Remote endpoint discipline (cross-platform/cross-machine): only the **explicit** target.socketPath (optional)
 * and session travel to the remote; HERDR_SOCKET_PATH / config dirs / endpoint form (UDS vs pipe) are all resolved
 * by the target node itself. Never impose the Hub-local resolveSocketPath() result or endpointKind on the
 * remote (that would send a Linux Hub's ~/.config path to a Windows target).
 */

interface HerdrTransportOptions {
  /** Redaction for diagnostics and error messages; defaults to returning as-is. */
  redact?: (text: string) => string
  /** Cross-node channel (injected by EnvFabric or a test fixture). When absent, remote targets fail explicitly; never fall back to local. */
  nodeChannel?: HerdrNodeChannel
  /** Wait deadline for events.subscribe ack; defaults to SUBSCRIBE_ACK_TIMEOUT_MS (shortened in tests). */
  subscribeAckTimeoutMs?: number
}

export const HERDR_CALL_TIMEOUT_MS = 120_000
/** The server-side startup cap for agent.start (>3000 and <=300000 ms) plus transport headroom. */
const HERDR_START_TIMEOUT_CEILING_MS = 300_000
const HERDR_START_TIMEOUT_MARGIN_MS = 15_000
/** No client deadline for agent.prompt(wait)/agent.wait without an explicit timeout; left to signal/server. */
const HERDR_WAIT_METHODS = new Set(['agent.prompt', 'agent.wait', 'pane.wait_for_output', 'events.wait'])
/** Per-frame (single JSON line) size cap; the subscription stream is limited per frame, not cumulatively over the connection lifetime. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const SUBSCRIPTION_METHOD = 'events.subscribe'
/** Status event types: the official contract requires per-pane filtering by pane_id at subscribe time; no global subscription. */
const PANE_STATUS_EVENT_TYPE = 'pane.agent_status_changed'
/**
 * Global subscription set (subscribe by official type, payload rides in EventData): covers pane lifecycle
 * and position/focus changes. pane.moved changes the pane ID (official panes.rs:1326 emits only moved,
 * with no companion created/closed) so a snapshot must be re-fetched; agent_status_changed requires pane_id
 * (one filter subscription per pane of interest, rebuilt by the caller as snapshot paneIds change).
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
// The global EventEnvelope names use snake_case; the dedicated status events use dots.
// Subscription requests still use dots uniformly; normalization to internal HerdrEvent names happens only at the receive boundary.
const WIRE_EVENT_TYPES = new Map<string, HerdrEvent['type']>(
  SUBSCRIPTION_TYPES.map((type) => [type.replace('.', '_'), type] as const),
)
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000
/** Single-line request ID for remote RPC: wire validation must match it exactly. */
const REMOTE_RPC_ID = 'helm-remote-1'
/** Node ID as a single safe token (incl. 'local'; empty strings and oversize values rejected explicitly). */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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

/** The session name becomes a socket path segment; character whitelist (aligned with herdr's validate_name). */
export function isValidSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
}

/**
 * Node ID as a single safe token: starts alphanumeric, may contain `.` `_` `-`, length 1..128.
 * Empty strings and illegal characters are rejected explicitly (never silently treat an empty string as local -- that is silent degradation).
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
 * Local Herdr IPC endpoint path resolution (local node only; remote nodes resolve themselves):
 * target.socketPath > HERDR_SOCKET_PATH > session dir (session or default).
 * On Unix this is the UDS file itself; on Windows it is the named pipe's marker file (at connect time
 * it must be converted to the pipe name; never connect directly to the file path).
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

/** Long session/wait-style requests: no client deadline without an explicit timeoutMs; terminated by signal or the server's wait timeout. */
function resolveCallTimeoutMs(method: string, params: Record<string, unknown>, options: HerdrCallOptions | undefined): number | undefined {
  if (options?.timeoutMs !== undefined) return options.timeoutMs
  if (HERDR_WAIT_METHODS.has(method)) return undefined
  if (method === 'agent.start') {
    const requested = typeof params['timeout_ms'] === 'number' ? params['timeout_ms'] : 30_000
    return Math.min(Math.max(requested, 1), HERDR_START_TIMEOUT_CEILING_MS) + HERDR_START_TIMEOUT_MARGIN_MS
  }
  return HERDR_CALL_TIMEOUT_MS
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

// --------------------------------------------------------------- frame decoding --

/**
 * NDJSON frame decoder: find \n boundaries by bytes; an incomplete UTF-8 tail stays in the byte buffer;
 * string decoding uses an incremental TextDecoder; subclasses can reuse it for deterministic byte-by-byte regression.
 * Limits are per frame (limitBytes), not cumulative per connection.
 */
export class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0)
  private decoder = new TextDecoder('utf-8', { fatal: true })

  /** Feed an arbitrarily split chunk; returns the lines completed this time (without \n). Over-limit/invalid UTF-8 throws. */
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

  /** EOF: leftover bytes are treated as the last frame; incomplete UTF-8 is a protocol error. */
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
    // Redact the whole thing first, then take the preview, so a bad frame's raw text cannot leak secrets.
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

// --------------------------------------------------------- local socket RPC --

/**
 * Establish a connection to the local Herdr IPC endpoint:
 * - Unix path: connect straight to the UDS file;
 * - Windows-shaped path (drive letter/UNC, incl. a full pipe path): the on-disk herdr.sock is only a
 *   marker file; the real endpoint is the `\\.\\pipe\\` named pipe -- first confirm the marker file exists
 *   (absent means herdr_unreachable, same semantics as UDS ENOENT), then convert to the pipe name and connect;
 *   never treat the marker file path as a connectable endpoint.
 */
async function openLocalHerdrSocket(socketPath: string, target: string, signal?: AbortSignal): Promise<Socket> {
  const net = await import('node:net')
  checkAborted(signal, target)
  if (!isWindowsShapedPath(socketPath)) {
    const socket = net.connect(socketPath)
    socket.setNoDelay(true)
    return socket
  }
  // Already a full pipe path: no marker to check; convert and connect directly (the pipe name is the endpoint).
  if (!/^\\\\(\.|[^\\]+)\\pipe\\/.test(socketPath.replaceAll('/', '\\'))) {
    const fs = await import('node:fs/promises')
    try {
      await fs.stat(socketPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        throw new HerdrTransportError(
          'herdr_unreachable',
          `herdr marker file does not exist (${code ?? 'stat failed'}): ${socketPath}; confirm the local Windows herdr is running`,
          target,
          { cause: err },
        )
      }
      throw new HerdrTransportError('herdr_io', `cannot access the herdr marker file: ${socketPath} (${code ?? String(err)})`, target, { cause: err })
    }
    checkAborted(signal, target)
  }
  const socket = connectHerdrEndpoint(socketPath, 'named-pipe')
  socket.setNoDelay(true)
  return socket
}

/** One request per connection: destroy the connection as soon as the first complete response line arrives. */
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

  const socket = await openLocalHerdrSocket(socketPath, target, signal)
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

  // Active abort settle: thoroughly destroy our side of the socket (incl. the read side), not relying on the peer closing first;
  // an agent.wait without a deadline must also be terminated immediately by abort.
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
    // A missing or wrong id is a peer protocol violation; never treated as success.
    throw new HerdrTransportError('herdr_protocol', 'response id missing or mismatched', target)
  }
  if (envelope['result'] === undefined && envelope['error'] === undefined) {
    throw new HerdrTransportError('herdr_protocol', 'response has neither result nor error', target)
  }
  checkWireError(envelope, target, redact)
  return envelope['result']
}

// ------------------------------------------------------- local event subscription --

/**
 * Subscription stream: after the ack, each line is a bare event frame.
 * A single finalizer guarantees resources are cleaned once and errors reported once; when the ack and events arrive in the same chunk, lines are processed in order.
 * options.paneIds appends a {type:'pane.agent_status_changed',pane_id} filter subscription per deduped pane;
 * an abort of options.signal at any moment closes this socket: the pending-ack Promise settles immediately with herdr_aborted,
 * while in the normal streaming phase it just closes silently, not reported as a new error to onError.
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
  // Subscription set: global topology events + one status filter subscription per deduped paneId.
  const paneIds = [...new Set(options?.paneIds ?? [])]
  const invalidPaneId = paneIds.find((paneId) => typeof paneId !== 'string' || paneId === '')
  if (invalidPaneId !== undefined) {
    throw new HerdrTransportError('herdr_invalid_subscription', `invalid pane id in subscription options: ${String(invalidPaneId)}`, target)
  }
  const socket = await openLocalHerdrSocket(socketPath, target, signal)
  const assembler = new LineAssembler()

  let stopped = false
  let terminated = false
  let acked = false
  let terminate: (error: unknown) => void = () => {}

  /** The single finalization path: gracefully close the socket (send FIN, avoiding a hung server connection); errors are reported once. */
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
          // Event frames arriving before the ack: still dispatched in order, not dropped.
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
            continue // later lines of the same chunk continue as events
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
      if (stopped) return // an active close from stop()/abort is not an error
      failOnce(new HerdrTransportError('herdr_disconnected', terminated ? 'subscription socket closed' : 'subscription socket closed before ack', target))
    })
  })

  const subscriptions: Array<Record<string, unknown>> = SUBSCRIPTION_TYPES.map((type) => ({ type }))
  for (const paneId of paneIds) subscriptions.push({ type: PANE_STATUS_EVENT_TYPE, pane_id: paneId })

  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions } }
  socket.write(`${JSON.stringify(request)}\n`)

  // Active abort settle: reject the pending Promise in the ack phase, close silently in the normal streaming phase;
  // neither reports abort as a new error to onError.
  const onAbort = () => {
    if (terminated) return
    stopped = true
    terminated = true
    socket.destroy()
    if (!acked) terminate(new HerdrTransportError('herdr_aborted', 'subscription aborted', target))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // Compensation for the window between checkAborted and addEventListener where abort already fired (abort events do not fire retroactively).
  if (signal?.aborted) onAbort()

  // Ack deadline: whichever path fails (timeout/bad frame/disconnect) must close the socket via failOnce,
  // otherwise the server connection hangs and close listeners leak.
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
    // The rejection path's caller never gets stop(): clean up the abort listener here so it doesn't leak.
    signal?.removeEventListener('abort', onAbort)
    throw err
  } finally {
    ackTimer.clear()
  }

  /**
   * Event frame -> {type, paneId}; pane.created/updated carries the full PaneInfo (official
   * EventData); closed/exited/focused/agent_status_changed use the pane_id field;
   * moved takes data.pane.pane_id (the new ID; the old ID is realigned by re-fetching the snapshot).
   * Bad frames are reported through the finalizer and stop the subscription.
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
    // A normal unsubscribe sends FIN so the peer releases the subscription promptly; destroy the read side after the write side ends, avoiding a lingering socket.
    socket.end(() => socket.destroy())
  }
}

// ------------------------------------------------------------ remote node channel --

/**
 * Resolve the channel needed for remote calls: when EnvFabric is not injected (nodeChannel missing),
 * explicitly herdr_node_unavailable; an offline node is explicitly herdr_node_offline. Never fall back to local.
 */
function requireChannel(nodeChannel: HerdrNodeChannel | undefined, nodeId: string, target: string): HerdrNodeChannel {
  if (nodeChannel === undefined) {
    throw new HerdrTransportError(
      'herdr_node_unavailable',
      `node '${nodeId}' has no HerdrNodeChannel (EnvFabric not injected); remote Herdr calls are unavailable and never fall back to local`,
      target,
    )
  }
  if (!nodeChannel.isOnline(nodeId)) {
    throw new HerdrTransportError('herdr_node_offline', `node '${nodeId}' is offline`, target)
  }
  return nodeChannel
}

/** Channel-layer error codes -> transport error codes (timeouts/cancellation/IO typed honestly; no swallowed errors). */
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
 * Remote RPC: a single-line JSON reaches the target node's local Herdr IPC via the node channel.
 * Only the explicit target.socketPath (optional) and session travel -- the endpoint path/form is resolved by
 * the target node itself (local resolveSocketPath/endpointKind are never sent down).
 * Secrets exist only inside the JSON structure, never in any command-line argv.
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

// ------------------------------------------------------------- factories --

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
        // The channel does not support event forwarding: fail explicitly, never silently degrade to no events.
        return Promise.reject(
          new HerdrTransportError('herdr_subscribe_unsupported', `node channel for '${nodeId}' does not stream events`, describeTarget(target)),
        )
      }
      return subscribeLocal(resolveSocketPath(target), describeTarget(target), onEvent, onError, redact, options, factoryOptions?.subscribeAckTimeoutMs)
    },
  }
}

/**
 * Remote event subscription (via the channel's ipcSubscribe).
 *
 * Contract: the channel consumes and validates the subscription ACK itself before the Promise resolves;
 * resolving means the subscription is ready, after which onLine only pushes bare event frames -- this function
 * waits for no second ACK and sets no ack timer. Events may arrive before the Promise resolves (buffered and
 * dispatched in order, not dropped). stop/abort/stream close all finalize once and release the subscription; callbacks at most once.
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
    /** The single finalization path: release the subscription, remove the abort listener; errors reported once. */
    const finish = (error: unknown): void => {
      if (settled) return
      settled = true
      stopped = true
      signal?.removeEventListener('abort', onAbort)
      try {
        release?.()
      } catch (releaseError) {
        // Release failures merge honestly into the finalization error; never silently swallowed.
        onError(releaseError)
      }
      if (error !== undefined) onError(error)
    }
    const onAbort = () => finish(undefined)

    // Events may arrive before the ipcSubscribe Promise resolves: buffered, then dispatched in order once resolved.
    const earlyLines: string[] = []
    let ready = false

    /** Event frame parsing follows the same rules as the local subscription; bad frames finalize the whole stream. */
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
      // The ACK was consumed and validated at the channel layer; an id frame arriving after resolve is a channel
      // implementation violation -- finalize honestly (not silently dropped, not treated as success).
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
            // abort vs resolve race: already finalized; this is only a fallback release.
            try {
              stop()
            } catch {
              /* finish already reported an error; a release failure is not reported twice */
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
