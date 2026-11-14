/**
 * 会话与插件清单的响应式 hooks（宿主端口驱动，SSE 实时同步，无轮询无 mock）。
 * 本文件无组件导出（Fast Refresh 友好）。
 */
import { useCallback, useEffect } from 'react'
import type { AskSpec, ConversationDetail, ConversationLive, ConversationSummary, UsePluginsResult } from '@helm/protocol'
import { usePluginClientHost } from './host-port.js'

/** 全部会话摘要（SSE 实时同步；与宿主左栏同一数据源）。 */
export function useConversations(): ConversationSummary[] {
  return usePluginClientHost().conversations
}

/**
 * 宿主插件清单与 Screen 贡献响应式快照（与插件中心/左栏同一 SSE 数据源，无轮询）：
 * - plugins：全部插件摘要，随 plugin.changed / 快照帧实时更新；
 * - screens：已启用插件注册的 Screen 贡献（含 pluginId），停用插件贡献即时移除。
 * 可在 <PluginUiView> 外使用（应用中心类全屏视图无会话上下文也可调用）。
 */
export function usePlugins(): UsePluginsResult {
  const port = usePluginClientHost()
  return {
    plugins: port.plugins,
    screens: port.screens,
  }
}

/** useConversation 返回的单个会话实时视图。 */
export interface ConversationHookResult {
  /** 会话摘要（SSE 未推送时 undefined，绝不虚构占位对象）。 */
  summary: ConversationSummary | undefined
  /** 已加载的会话详情（entries 等）；未加载时 undefined。 */
  detail: ConversationDetail | undefined
  /** 流式实时视图（working/blocked 期间）。 */
  live: ConversationLive | undefined
  /** 本会话当前待答审批。 */
  pendingAsks: AskSpec[]
  /** 详情加载失败文本（宿主 loadErrors[`conversation:<id>`]）。 */
  loadError: string | undefined
  /** 强制重新拉取会话详情。 */
  reload: () => void
}

/**
 * 订阅单个会话：详情缺失且无失败记录时自动加载，随后随 SSE 实时更新。
 * conversationId 为 undefined 时（无会话上下文）返回空视图且不发请求。
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
