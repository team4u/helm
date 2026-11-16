/**
 * Reactive hooks for conversations and the plugin registry (host-port driven,
 * live-synced over SSE, no polling and no mocks).
 * No component exports in this file (Fast Refresh friendly).
 */
import { useCallback, useEffect } from 'react'
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

/**
 * Subscribe to a single conversation: the detail is auto-loaded when missing
 * and no failure is recorded, then updated live via SSE.
 * When conversationId is undefined (no conversation context), an empty view is
 * returned and no request is made.
 */
export function useConversation(conversationId: number | undefined): ConversationHookResult {
  const port = usePluginClientHost()
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
    if (conversationId !== undefined && detail === undefined && loadError === undefined) {
      void load(conversationId)
    }
  }, [conversationId, detail, loadError, load])

  const reload = useCallback(() => {
    if (conversationId !== undefined) void load(conversationId, true)
  }, [conversationId, load])

  return { summary, detail, live, pendingAsks, loadError, reload }
}
