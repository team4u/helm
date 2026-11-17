/**
 * Keyed HTTP request deduplication, AbortController / epoch cancellation,
 * asset-refresh generation tracking, and lifecycle timers for HelmExternalStore.
 */
import type { ArtifactsSyncWatermark } from './use-unread-sync.js'

export function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

export interface ControlledRequestContext {
  signal: AbortSignal
  isStale: () => boolean
}

export interface ControlledRequestOptions<T> {
  key: string
  onStart?: () => void
  onError?: (error: unknown) => void
  exec: (ctx: ControlledRequestContext) => Promise<T | undefined>
}

export class StoreRequestManager {
  readonly session = { current: 0 }
  readonly requests = { current: new Map<string, Promise<unknown>>() }
  readonly inFlightControllers = new Map<string, AbortController>()
  readonly requestEpochs = new Map<string, number>()
  readonly failedDocs = { current: new Set<string>() }
  readonly pluginEpoch = { current: new Map<string, number>() }
  readonly artifactsWatermarks = { current: new Map<number, ArtifactsSyncWatermark>() }
  readonly prevVisibleConversationIds = new Set<number>()
  readonly assetGeneration = { current: 0 }
  assetsController: AbortController | null = null
  readonly timers = new Set<ReturnType<typeof setTimeout>>()

  delay = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  abortRequestKey = (key: string): void => {
    this.requestEpochs.set(key, (this.requestEpochs.get(key) ?? 0) + 1)
    const ctrl = this.inFlightControllers.get(key)
    if (ctrl !== undefined) {
      this.inFlightControllers.delete(key)
      ctrl.abort()
    }
    this.requests.current.delete(key)
  }

  abortInFlightConversationRequests = (): void => {
    const keys = new Set<string>([...this.inFlightControllers.keys(), ...this.requests.current.keys()])
    for (const key of keys) {
      if (key.startsWith('conversation:') || key.startsWith('history:') || key.startsWith('artifacts:')) {
        this.abortRequestKey(key)
      }
    }
  }

  abortAllInFlight = (): void => {
    const keys = new Set<string>([...this.inFlightControllers.keys(), ...this.requests.current.keys()])
    for (const key of keys) this.abortRequestKey(key)
    this.assetsController?.abort()
    this.assetsController = null
  }

  beginAssetRefresh(): { generation: number; controller: AbortController } {
    const generation = ++this.assetGeneration.current
    this.assetsController?.abort()
    const controller = new AbortController()
    this.assetsController = controller
    return { generation, controller }
  }

  finishAssetRefresh(controller: AbortController): void {
    if (this.assetsController === controller) {
      this.assetsController = null
    }
  }

  syncVisibleConversations(nextVisible: Set<number>): void {
    for (const prevId of this.prevVisibleConversationIds) {
      if (!nextVisible.has(prevId)) {
        this.abortRequestKey(`conversation:${prevId}`)
        this.abortRequestKey(`history:${prevId}`)
        this.abortRequestKey(`artifacts:${prevId}`)
      }
    }
    this.prevVisibleConversationIds.clear()
    for (const id of nextVisible) {
      this.prevVisibleConversationIds.add(id)
    }
  }

  runControlled<T>(opts: ControlledRequestOptions<T>): Promise<T | undefined> {
    const { key, onStart, onError, exec } = opts
    const existing = this.requests.current.get(key)
    if (existing) return existing as Promise<T | undefined>

    onStart?.()
    const epoch = this.session.current
    const reqEpoch = (this.requestEpochs.get(key) ?? 0) + 1
    this.requestEpochs.set(key, reqEpoch)
    const controller = new AbortController()
    this.inFlightControllers.set(key, controller)

    const isStale = (): boolean =>
      this.session.current !== epoch ||
      controller.signal.aborted ||
      this.requestEpochs.get(key) !== reqEpoch

    const task = exec({ signal: controller.signal, isStale })
      .then((value): T | undefined => (isStale() ? undefined : value))
      .catch((error: unknown): undefined => {
        if (isAbortError(error) || isStale()) return undefined
        onError?.(error)
        return undefined
      })
      .finally(() => {
        if (this.inFlightControllers.get(key) === controller) this.inFlightControllers.delete(key)
        if (this.requests.current.get(key) === task) this.requests.current.delete(key)
      })

    this.requests.current.set(key, task)
    return task
  }

  resetOnLogout(): void {
    this.session.current++
    this.abortAllInFlight()
    this.requests.current.clear()
    this.failedDocs.current.clear()
    this.artifactsWatermarks.current.clear()
    this.prevVisibleConversationIds.clear()
    this.assetGeneration.current++
  }

  dispose(): void {
    this.session.current++
    this.abortAllInFlight()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
