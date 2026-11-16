/**
 * Hub side TCP port forwarding (foreground MVP): in Hub host on on demand listen listenHost:listenPort,
 * each station connect via EnvFabric.openTunnel establish to target node targetHost:targetPort 
 * any TCP tunnel and double to pipe.
 *
 * lifecycle (foreground lease, and CLI foreground command align):
 * - **holder model**: after creation if not in leaseTimeoutMs inside bind set monitor event stream (acquireLease)
 *   automatically stop (CLI by kill/DELETE on failure listener leaves no residue); bind set after finally a holder
 *   release (releaseLease, monitor stream disconnect/cancel when invoke) i.e. stop; only read list/get
 *   is not holder; explicit stop() / host close same stop;
 * - event (connections/errors/stopped) via call back on report (HTTP layer rotate NDJSON);
 * - the same listen address conflict (EADDRINUSE) explicit failed;stop idempotent (sharing close Promise,
 *   concurrency/duplicate invoke etc. the same result);start  listen and stop concurrency when close return after
 *   never publish new listen conversation.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { HelmError, type NodeForwardEvent, type NodeForwardInput, type NodeForwardSession } from '@helm/protocol'
import type { Duplex } from 'node:stream'
import type { EnvFabric } from './fabric.js'

export type { NodeForwardEvent, NodeForwardInput, NodeForwardSession } from '@helm/protocol'

/** default foreground lease phase limit: after creation not bind set event stream i.e. automatically stop (CLI only needs once stream request). */
export const NODE_FORWARD_LEASE_TIMEOUT_MS = 15_000

/** validate host: non-empty, without control character/whitespace,≤255(hostname or IP text). */
function validateHost(raw: unknown, what: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 255 ||
    raw.trim() !== raw ||
    /\s/.test(raw)
  ) {
    throw new HelmError('validation_error', `${what} must be non-empty, without whitespace string (≤255 character)`, 400, { value: raw })
  }
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      throw new HelmError('validation_error', `${what} must not contains control character`, 400, { value: raw })
    }
  }
  return raw
}

function validatePort(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 65535) {
    throw new HelmError('validation_error', `${what} must be 1..65535 security integer`, 400, { value: raw })
  }
  return raw
}

export function parseNodeForwardInput(raw: Record<string, unknown>): NodeForwardInput {
  const listenHost = validateHost(raw['listenHost'], 'listenHost')
  const listenPort = validatePort(raw['listenPort'], 'listenPort')
  const targetPort = validatePort(raw['targetPort'], 'targetPort')
  const targetHost = raw['targetHost'] === undefined ? undefined : validateHost(raw['targetHost'], 'targetHost')
  return { listenHost, listenPort, ...(targetHost === undefined ? {} : { targetHost }), targetPort }
}

interface ActiveForward {
  session: NodeForwardSession
  server: net.Server
  /** activity tunnel duplex(stop when unify destroy). */
  tunnels: Set<Duplex>
  events: EventEmitter
  /** terminate wait for (monitor stream close use;stop when in terminal state frame after invoke). */
  stopWaiters: Set<() => void>
  /** holder count (monitor event stream bind set +1 / disconnect -1; reset to zero and once bind set i.e. stop). */
  holders: number
  /** lease timer: after creation not and when bind set holder i.e. automatically stop. */
  leaseTimer: NodeJS.Timeout | undefined
  /** idempotent close: concurrency/duplicate stop sharing the same Promise. */
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

  /** create forwarding (foreground command lifecycle): listen failed explicit failed; succeeded return conversation. */
  async start(nodeId: string, input: NodeForwardInput): Promise<NodeForwardSession> {
    if (this.#closed) throw new HelmError('node_offline', 'forwarding service already close', 409)
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
    /** create connect in-flight abort control (stop when unify cancel, guard against leftover establish). */
    const pendingOpens = new Set<AbortController>()
    const events = new EventEmitter()

    // listen complete to forward assignment between store in await window: connect call back must judge empty fall back
    //(not assignment i.e. destroy socket), eliminate for micro task when order implicit dependency (TDZ). assignment after
    // call back inside one rule use this where catch reference, no longer trigger and outside layer bind set.
    let forward: ActiveForward | undefined
    const server = net.createServer((socket) => {
      const fwd = forward
      if (fwd === undefined || fwd.sessionRemoved) { socket.destroy(); return }
      socket.on('error', () => undefined) // guard against not handle error crash process; real clean up in cleanup
      session.totalConnections += 1
      // create connect phase i.e. bind socket lifecycle: client first on disconnect immediately cancel in-flight establish,
      // late to tunnel directly destroy (do not pipe, do not register).
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
        // create connect during client disconnected or forwarding already stop: late to tunnel immediately destroy, do not register.
        if (socketGone || fwd.sessionRemoved) { tunnel.destroy(); socket.destroy(); return }
        tunnels.add(tunnel)
        session.activeConnections += 1
        events.emit('event', { type: 'connection', count: session.activeConnections } satisfies NodeForwardEvent)
        // exactly once clean up:socket/tunnel any one close/error all enter the same converge point,
        // does not repeat decrement(otherwise will eat other activity connect counter).
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
        reject(new HelmError(
          'node_forward_listen_failed',
          `listen ${input.listenHost}:${input.listenPort} failed:${error.message}`,
          409,
          { listenHost: input.listenHost, listenPort: input.listenPort },
        ))
      }
      server.once('error', onError)
      server.listen(input.listenPort, input.listenHost, () => {
        server.removeListener('error', onError)
        // listen after run phase error such as record (do not crash process).
        server.on('error', (error) => {
          session.lastError = error.message
          events.emit('event', { type: 'error', message: error.message } satisfies NodeForwardEvent)
        })
        resolve()
      })
    })

    // listen after completion and stop concurrency:close/service already closure stop during never publish new listen conversation.
    if (this.#closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new HelmError('node_offline', 'forwarding service already close', 409)
    }

    // self reference closed package (stopped/stop/lease): only in object complete initialize and assignment after only then may by
    // invoke, without TDZ risk.
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
      // arrow function:this i.e. service(closed package catch), supply internal excerpt except register.
      stop: (reason: string): Promise<void> => {
        // idempotent: concurrency/duplicate invoke sharing the same close Promise(after continue invoke no longer immediately return,
        // but rather etc. the same close complete).
        if (fwd.stopPromise !== undefined) return fwd.stopPromise
        fwd.sessionRemoved = true
        if (fwd.leaseTimer !== undefined) clearTimeout(fwd.leaseTimer)
        fwd.stopPromise = (async () => {
          // terminal state frame first row (monitor stream receives after by stopWaiters normal close, do not pending),
          // again cancel all in-flight create connect (late to tunnel by each connect branch self row destroy, do not register).
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
    // foreground lease: after creation not in phase limit inside bind set holder (acquireLease) i.e. automatically stop.
    fwd.leaseTimer = setTimeout(() => {
      if (fwd.holders === 0 && !fwd.stopped()) {
        void fwd.stop('lease_timeout').catch(() => undefined)
      }
    }, this.leaseTimeoutMs)
    fwd.leaseTimer.unref?.()
    events.emit('event', { type: 'started', listenHost: session.listenHost, listenPort: session.listenPort } satisfies NodeForwardEvent)
    return { ...session }
  }

  /** subscribe event (monitor stream use); return unsubscribe function. */
  onEvent(forwardId: string, listener: (event: NodeForwardEvent) => void): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `forwarding ${forwardId} missing`, 404, { forwardId })
    forward.events.on('event', listener)
    return () => forward.events.removeListener('event', listener)
  }

  /**
   * bind set holder (foreground lease): monitor event stream establish when invoke - - clear create lease timer,
   * holders +1. return release function (monitor stream disconnect/cancel when invoke):holders -1,
   * reset to zero i.e. stop forwarding (finally a holder leave i.e. close listener). for already stop forwarding without operation.
   */
  acquireLease(forwardId: string): () => void {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `forwarding ${forwardId} missing`, 404, { forwardId })
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
   * subscribe terminate notify (monitor stream normal end use; terminal state stopped frame after invoke): forwarding already stop
   * or already excerpt except when with micro task immediately call back (subscribe race security); return unsubscribe function. forwarding from not
   * store in when same keep guard immediately call back (monitor stream wrap-up takes precedence;GET detail situation will first 404).
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

  /** stop forwarding (idempotent: sharing the same close Promise). */
  async stop(forwardId: string): Promise<void> {
    const forward = this.#forwards.get(forwardId)
    if (forward === undefined) throw new HelmError('not_found', `forwarding ${forwardId} missing`, 404, { forwardId })
    await forward.stop('explicit')
  }

  /** close all forwarding (host close / dispose). */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#forwards.values()].map((f) => f.stop('service_closed')))
  }
}
