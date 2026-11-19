/**
 * Hub-side TCP port forwarding (foreground MVP): listens on `listenHost:listenPort` on the Hub host
 * on demand, opens TCP tunnels via `EnvFabric.openTunnel` to `targetHost:targetPort` on the target node
 * for each incoming connection, and pipes both directions.
 *
 * Lifecycle (foreground lease, aligned with CLI foreground commands):
 * - **Holder model**: automatically stops if no monitor event stream attaches (`acquireLease`) within
 *   `leaseTimeoutMs` (no leaked listeners if CLI crashes or is killed); once attached, stops as soon as
 *   the last holder releases (`releaseLease`, invoked on stream disconnect/cancel); read-only list/get
 *   calls are not holders; explicit `stop()` or host close also stops forwarding;
 * - Events (`connections`/`errors`/`stopped`) are emitted via callbacks (converted to NDJSON by HTTP);
 * - Listen address conflicts (`EADDRINUSE`) fail explicitly; `stop` is idempotent (shares a single close
 *   Promise so concurrent/duplicate calls wait for the same shutdown); races between `listen` and `stop`
 *   never publish a new listening session after `close` returns.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { HelmxError, type NodeForwardEvent, type NodeForwardInput, type NodeForwardSession } from '@helmx/protocol'
import type { Duplex } from 'node:stream'
import type { EnvFabric } from './fabric.js'

export type { NodeForwardEvent, NodeForwardInput, NodeForwardSession } from '@helmx/protocol'

/** Default foreground lease deadline: stops automatically if no event stream attaches after creation (CLI makes a single stream request). */
const NODE_FORWARD_LEASE_TIMEOUT_MS = 15_000

/** Validate host: non-empty, no control chars/whitespace, <= 255 characters (hostname or IP literal). */
function validateHost(raw: unknown, what: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 255 ||
    raw.trim() !== raw ||
    /\s/.test(raw)
  ) {
    throw new HelmxError('validation_error', `${what} must be a non-empty string without whitespace (<= 255 characters)`, 400, { value: raw })
  }
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      throw new HelmxError('validation_error', `${what} must not contain control characters`, 400, { value: raw })
    }
  }
  return raw
}

function validatePort(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 65535) {
    throw new HelmxError('validation_error', `${what} must be a valid integer port in 1..65535`, 400, { value: raw })
  }
  return raw
}

interface ActiveForward {
  session: NodeForwardSession
  server: net.Server
  /** Active tunnel duplexes (destroyed together on stop). */
  tunnels: Set<Duplex>
  events: EventEmitter
  /** Stop waiters (used to close monitor streams cleanly after emitting the terminal frame). */
  stopWaiters: Set<() => void>
  /** Holder count (incremented on monitor stream bind, decremented on disconnect; stops once it returns to 0 after having a holder). */
  holders: number
  /** Lease timer: stops automatically if no holder attaches in time after creation. */
  leaseTimer: NodeJS.Timeout | undefined
  /** Idempotent shutdown: concurrent/duplicate stop calls share this Promise. */
  stopPromise: Promise<void> | undefined
  sessionRemoved: boolean
  stopped(): boolean
  stop(reason: string): Promise<void>
}

export class NodeForwardService {
  readonly #fabric: EnvFabric
  readonly #forwards = new Map<string, ActiveForward>()
  #closed = false

  constructor(
    fabric: EnvFabric,
    private readonly leaseTimeoutMs: number = NODE_FORWARD_LEASE_TIMEOUT_MS,
  ) {
    this.#fabric = fabric
  }

  /** Start forwarding (foreground command lifecycle): fails explicitly if listen fails; returns session on success. */
  async start(nodeId: string, input: NodeForwardInput): Promise<NodeForwardSession> {
    if (this.#closed) throw new HelmxError('node_offline', 'forwarding service is closed', 409)
    const forwardId = `fwd-${cryptoRandomUUID()}`
    const targetHost = input.targetHost ?? '127.0.0.1'
    const session: NodeForwardSession = {
      forwardId,
      nodeId,
      listenHost: input.listenHost,
      listenPort: input.listenPort,
      targetHost,
      targetPort: input.targetPort,
      activeConnections: 0,
      totalConnections: 0,
    }
    const tunnels = new Set<Duplex>()
    /** AbortControllers for in-flight tunnel opens (cancelled together on stop so nothing leaks). */
    const pendingOpens = new Set<AbortController>()
    const events = new EventEmitter()

    // There is an await window between `listen` completing and `forward` assignment: connection callbacks
    // guard against undefined (destroying sockets if not yet assigned), avoiding implicit microtask timing
    // dependencies (TDZ). Callbacks capture `fwd` locally rather than reading an outer reassigned binding.
    let forward: ActiveForward | undefined
    const server = net.createServer((socket) => {
      const fwd = forward
      if (fwd === undefined || fwd.sessionRemoved) { socket.destroy(); return }
      socket.on('error', () => undefined) // prevent unhandled socket errors from crashing the process; real cleanup happens in cleanup()
      session.totalConnections += 1
      // Bind socket lifetime while opening the tunnel: if client disconnects first, abort the in-flight open
      // immediately and destroy any late-arriving tunnel without piping or registering it.
      const controller = new AbortController()
      pendingOpens.add(controller)
      let socketGone = false
      const onSocketGone = (): void => {
        socketGone = true
        controller.abort()
      }
      socket.once('close', onSocketGone)
      socket.once('error', onSocketGone)
      void (async () => {
        let tunnel: Duplex | undefined
        try {
          tunnel = await this.#fabric.openTunnel(nodeId, { host: targetHost, port: input.targetPort }, controller.signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!socketGone) {
            session.lastError = message
            events.emit('event', { type: 'error', message } satisfies NodeForwardEvent)
          }
          socket.destroy()
          return
        } finally {
          pendingOpens.delete(controller)
          socket.removeListener('close', onSocketGone)
          socket.removeListener('error', onSocketGone)
        }
        // Client disconnected or forward stopped during tunnel open: destroy late tunnel immediately without registering.
        if (socketGone || fwd.sessionRemoved) { tunnel.destroy(); socket.destroy(); return }
        tunnels.add(tunnel)
        session.activeConnections += 1
        events.emit('event', { type: 'connection', count: session.activeConnections } satisfies NodeForwardEvent)
        // Exactly-once cleanup: socket and tunnel close/error converge here so activeConnections is never decremented twice.
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          socket.removeListener('close', cleanup)
          socket.removeListener('error', cleanup)
          tunnel!.removeListener('close', cleanup)
          tunnel!.removeListener('error', cleanup)
          tunnels.delete(tunnel!)
          session.activeConnections = Math.max(0, session.activeConnections - 1)
          socket.destroy()
          tunnel!.destroy()
        }
        socket.once('close', cleanup)
        socket.once('error', cleanup)
        tunnel!.once('close', cleanup)
        tunnel!.once('error', cleanup)
        socket.pipe(tunnel)
        tunnel.pipe(socket)
      })()
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new HelmxError(
          'node_forward_listen_failed',
          `failed to listen on ${input.listenHost}:${input.listenPort}: ${error.message}`,
          409,
          { listenHost: input.listenHost, listenPort: input.listenPort },
        ))
      }
      server.once('error', onError)
      server.listen(input.listenPort, input.listenHost, () => {
        server.removeListener('error', onError)
        // Record runtime errors after listen succeeds (never crash the process).
        server.on('error', (error) => {
          session.lastError = error.message
          events.emit('event', { type: 'error', message: error.message } satisfies NodeForwardEvent)
        })
        resolve()
      })
    })

    // Race between listen completing and service closing: never publish a new session once closed.
    if (this.#closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new HelmxError('node_offline', 'forwarding service is closed', 409)
    }

    // Self-referential closures (`stopped`/`stop`/`lease`): only invoked after full object construction and assignment (no TDZ risk).
    const fwd: ActiveForward = {
      session,
      server,
      tunnels,
      events,
      stopWaiters: new Set(),
      holders: 0,
      leaseTimer: undefined,
      stopPromise: undefined,
      sessionRemoved: false,
      stopped: () => fwd.stopPromise !== undefined,
      // Arrow function preserves class `this` via closure so `this.#forwards` can be cleaned up cleanly.
      stop: (reason: string): Promise<void> => {
        // Idempotent: concurrent/duplicate stop calls share the same close Promise (subsequent calls wait on the same shutdown).
        if (fwd.stopPromise !== undefined) return fwd.stopPromise
        fwd.sessionRemoved = true
        if (fwd.leaseTimer !== undefined) clearTimeout(fwd.leaseTimer)
        fwd.stopPromise = (async () => {
          // Emit terminal frame first (so monitor streams close cleanly via stopWaiters without hanging),
          // then abort all in-flight tunnel opens (late arrivals self-destroy without registering).
          fwd.events.emit('event', { type: 'stopped' } satisfies NodeForwardEvent)
          for (const waiter of [...fwd.stopWaiters]) waiter()
          fwd.stopWaiters.clear()
          for (const controller of [...pendingOpens]) controller.abort()
          pendingOpens.clear()
          for (const tunnel of [...fwd.tunnels]) tunnel.destroy()
          fwd.tunnels.clear()
          await new Promise<void>((resolve) => fwd.server.close(() => resolve()))
          this.#forwards.delete(forwardId)
          void reason
          fwd.events.removeAllListeners()
        })()
        return fwd.stopPromise
      },
    }
    forward = fwd
    this.#forwards.set(forwardId, fwd)
    // Foreground lease: stops automatically if no holder binds (`acquireLease`) within the timeout.
    fwd.leaseTimer = setTimeout(() => {
      if (fwd.holders === 0 && !fwd.stopped()) {
        void fwd.stop('lease_timeout').catch(() => undefined)
      }
    }, this.leaseTimeoutMs)
    fwd.leaseTimer.unref?.()
    events.emit('event', { type: 'started', listenHost: session.listenHost, listenPort: session.listenPort } satisfies NodeForwardEvent)
    return { ...session }
  }

  /** Subscribe to events (used by monitor streams); returns an unsubscribe function. */
  onEvent(forwardId: string, listener: (event: NodeForwardEvent) => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmxError('not_found', `forwarding session ${forwardId} not found`, 404, { forwardId })
    forward.events.on('event', listener)
    return () => forward.events.removeListener('event', listener)
  }

  /**
   * Bind a lease holder (foreground lease): called when the monitor event stream opens—clears the creation
   * lease timer and increments `holders`. Returns a release function (called on stream disconnect/cancel):
   * decrements `holders` and stops forwarding once it reaches zero (last holder leaves -> close listener).
   * No-op if forwarding is already stopped.
   */
  acquireLease(forwardId: string): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmxError('not_found', `forwarding session ${forwardId} not found`, 404, { forwardId })
    if (forward.stopped()) return () => undefined
    if (forward.leaseTimer !== undefined) {
      clearTimeout(forward.leaseTimer)
      forward.leaseTimer = undefined
    }
    forward.holders += 1
    return () => {
      if (forward.stopped()) return
      forward.holders = Math.max(0, forward.holders - 1)
      if (forward.holders === 0) {
        void forward.stop('last_holder_released').catch(() => undefined)
      }
    }
  }

  /**
   * Subscribe to termination notification (used to close monitor streams cleanly after emitting the `stopped` frame):
   * invokes immediately via microtask if already stopped or evicted (race-safe); returns an unsubscribe function.
   * Also invokes immediately if the forward does not exist (ensures monitor teardown wins even when GET detail returns 404).
   */
  onStopped(forwardId: string, listener: () => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined || forward.stopped()) {
      queueMicrotask(listener)
      return () => undefined
    }
    forward.stopWaiters.add(listener)
    return () => {
      forward.stopWaiters.delete(listener)
    }
  }

  get(forwardId: string): NodeForwardSession | undefined {
    const forward = this.#forwards.get(forwardId)
    return forward === undefined ? undefined : { ...forward.session }
  }

  list(): NodeForwardSession[] {
    return [...this.#forwards.values()].map((f) => ({ ...f.session }))
  }

  /** Stop forwarding (idempotent: shares the same close Promise). */
  async stop(forwardId: string): Promise<void> {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmxError('not_found', `forwarding session ${forwardId} not found`, 404, { forwardId })
    await forward.stop('explicit')
  }

  /** Close all forwarding sessions (host shutdown / dispose). */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#forwards.values()].map((f) => f.stop('service_closed')))
  }
}
