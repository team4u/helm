/**
 * Reactive hooks for conversations, the plugin registry, and shared elapsed-time tickers
 * (host-port driven, live-synced over SSE, no polling and no mocks).
 * No component exports in this file (Fast Refresh friendly).
 */
import { useCallback, useEffect, useState } from 'react'
import type { AskSpec, ConversationDetail, ConversationLive, ConversationSummary, UsePluginsResult } from '@helm/protocol/browser'
import { usePluginClientHost } from './host-port.js'

/** All conversation summaries (live-synced over SSE; same data source as the host left sidebar). */
export function useConversations(): ConversationSummary[] {
  return usePluginClientHost().conversations
}

/**
 * Reactive snapshot of the host plugin registry and Screen contributions (same
 * SSE data source as the plugin center / left sidebar, no polling):
 * - plugins: all plugin summaries, updated live via plugin.changed / snapshot frames;
 * - screens: Screen contributions registered by enabled plugins (including
 *   pluginId); contributions of disabled plugins are removed immediately.
 * Usable outside <PluginUiView> (fullscreen views like the app center have no
 * conversation context and can still call it).
 */
export function usePlugins(): UsePluginsResult {
  const port = usePluginClientHost()
  return {
    plugins: port.plugins,
    screens: port.screens,
  }
}

/** Live per-conversation view returned by useConversation. */
export interface ConversationHookResult {
  /** Conversation summary (undefined until SSE pushes it; never a fabricated placeholder object). */
  summary: ConversationSummary | undefined
  /** Loaded conversation detail (entries etc.); undefined when not loaded. */
  detail: ConversationDetail | undefined
  /** Streaming live view (during working/blocked). */
  live: ConversationLive | undefined
  /** Pending approvals of this conversation. */
  pendingAsks: AskSpec[]
  /** Detail load failure text (host loadErrors[`conversation:<id>`]). */
  loadError: string | undefined
  /** Force-refetch the conversation detail. */
  reload: () => void
}

export interface ConversationHookOptions {
  /**
   * Auto-load conversation detail when missing and no error is recorded (default true).
   * Pass `false` when only `summary` / `live` / `pendingAsks` are needed to avoid eager detail fetches.
   */
  includeDetail?: boolean
}

/**
 * Subscribe to a single conversation: the detail is auto-loaded by default when missing
 * and no failure is recorded, then updated live via SSE.
 * When `options?.includeDetail === false`, auto-loading is skipped while still returning any
 * already-cached `detail` plus `summary`, `live`, `pendingAsks`, `loadError`, and manual `reload`.
 * When conversationId is undefined (no conversation context), an empty view is
 * returned and no request is made.
 */
export function useConversation(
  conversationId: number | undefined,
  options?: ConversationHookOptions,
): ConversationHookResult {
  const port = usePluginClientHost()
  const includeDetail = options?.includeDetail !== false
  const summary =
    conversationId !== undefined ? port.conversations.find((c) => c.id === conversationId) : undefined
  const detail = conversationId !== undefined ? port.conversationDetails[conversationId] : undefined
  const live = conversationId !== undefined ? port.conversationLives[conversationId] : undefined
  const pendingAsks =
    conversationId !== undefined ? port.pendingAsks.filter((a) => a.conversationId === conversationId) : []
  const loadError =
    conversationId !== undefined ? port.loadErrors[`conversation:${conversationId}`] : undefined
  const load = port.loadConversationDetail

  useEffect(() => {
    if (includeDetail && conversationId !== undefined && detail === undefined && loadError === undefined) {
      void load(conversationId)
    }
  }, [includeDetail, conversationId, detail, loadError, load])

  const reload = useCallback(() => {
    if (conversationId !== undefined) void load(conversationId, true)
  }, [conversationId, load])

  return { summary, detail, live, pendingAsks, loadError, reload }
}

// ---------------------------------------------------------------------------
// Shared module-level wall-clock ticker (`useSharedNowMs`)
// ---------------------------------------------------------------------------

interface SharedTickerBucket {
  listeners: Set<(now: number) => void>
  timer: ReturnType<typeof setInterval> | undefined
}

const sharedTickers = new Map<number, SharedTickerBucket>()

function normalizeIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 1000
  return Math.max(1, Math.trunc(intervalMs))
}

function subscribeSharedNow(intervalMs: number, listener: (now: number) => void): () => void {
  let bucket = sharedTickers.get(intervalMs)
  if (!bucket) {
    const listeners = new Set<(now: number) => void>()
    const timer = globalThis.setInterval?.(() => {
      const now = Date.now()
      for (const fn of [...listeners]) {
        fn(now)
      }
    }, intervalMs)
    bucket = { listeners, timer }
    sharedTickers.set(intervalMs, bucket)
  }
  bucket.listeners.add(listener)

  let released = false
  return () => {
    if (released) return
    released = true
    const current = sharedTickers.get(intervalMs)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      if (current.timer !== undefined) globalThis.clearInterval?.(current.timer)
      sharedTickers.delete(intervalMs)
    }
  }
}

/**
 * Shared stopwatch clock: returns `undefined` on SSR / initial render and whenever `active` is `false`.
 * On client `useEffect`, when `active` is `true`, immediately samples `Date.now()` and subscribes to a
 * single shared `setInterval` bucket per `intervalMs`, tearing down the timer as soon as the last
 * subscriber unmounts or deactivates.
 */
export function useSharedNowMs(active: boolean, intervalMs = 1000): number | undefined {
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  const effectiveIntervalMs = normalizeIntervalMs(intervalMs)

  useEffect(() => {
    if (!active) {
      setNowMs(undefined)
      return
    }
    setNowMs(Date.now())
    return subscribeSharedNow(effectiveIntervalMs, setNowMs)
  }, [active, effectiveIntervalMs])

  return active ? nowMs : undefined
}
