/**
 * 插件 client.tsx 组件的宿主上下文与共享 hooks。
 *
 * 本模块同时服务两个消费方（同一实现，绝不打包第二份 React）：
 * 1. 宿主自身：`<PluginUiView />` import createPluginClientContext / PluginClientContext；
 * 2. 插件编译产物：源码里 `import { usePluginContext, usePluginDoc } from '@helm/plugin-client'`，
 *    编译器把该说明符虚拟化为 `module.exports = globalThis.__helm_shared_plugin_client`
 *    （HelmStoreProvider 挂载本模块导出），运行时取到的就是这里导出的同一批函数。
 *
 * 全部能力转发真实宿主 store（invokePluginAction / conversationsApi.submitInput /
 * ensurePluginDoc / 会话文档订阅），无任何 mock。
 */
import { createContext, useCallback, useContext, useEffect } from 'react'
import type { AskSpec, ComposerController, ConversationDetail, ConversationLive, ConversationSummary, PluginClientContext as PluginClientContextType } from '@helm/protocol'
import { conversationsApi } from './api.js'
import { useHelmStore, usePluginDoc as usePluginDocFromStore, usePluginSessionDoc as usePluginSessionDocFromStore } from './store-context.js'
import type { HelmStoreValue } from './types.js'
export { useToolActivity } from './tool-activity.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return ctx
}

/**
 * 响应式订阅公开文档：pluginId 省略时取当前 ctx.pluginId（本插件），
 * 传入时订阅其他插件的公开文档（跨插件寻址）。
 * 首次自动 GET，随后随 SSE `plugin.doc.updated` 实时重渲染（与宿主
 * usePluginDoc 同一 store，非 Promise 轮询）。
 * 必须在 <PluginUiView> 内的插件组件中调用。
 *
 * 导出两个名字：插件源码 `import { usePluginDoc } from '@helm/plugin-client'`
 * （共享模块契约名）；宿主内部引用用 useClientPluginDoc 避免与
 * store-context 的 usePluginDoc(pluginId, docName) 混淆。
 */
export const usePluginDoc = useClientPluginDocInternal
export { useClientPluginDocInternal as useClientPluginDoc }

function useClientPluginDocInternal<T = unknown>(docName: string, pluginId?: string): T | undefined {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginDoc 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return usePluginDocFromStore<T>(pluginId ?? ctx.pluginId, docName)
}

/**
 * 响应式订阅会话级公开文档：pluginId 省略时取当前 ctx.pluginId，
 * conversationId 省略时继承当前槽位 ctx.conversationId；两者都缺省时
 * 无会话上下文，返回 undefined 且不发起订阅。
 * 订阅走 (pluginId, docName, conversationId) 元组专用 SSE 流
 * （GET /api/plugins/:id/docs/:name/events?conversationId=N），不依赖全局事件。
 */
export const usePluginSessionDoc = useClientPluginSessionDocInternal
export { useClientPluginSessionDocInternal as useClientSessionPluginDoc }

function useClientPluginSessionDocInternal<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginSessionDoc 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return usePluginSessionDocFromStore<T>(docName, {
    pluginId: options?.pluginId ?? ctx.pluginId,
    conversationId: options?.conversationId ?? ctx.conversationId,
  })
}

/** 全部会话摘要（SSE 实时同步；与宿主左栏同一数据源，无 mock）。 */
export function useConversations(): ConversationSummary[] {
  return useHelmStore().conversations
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
  /** 详情加载失败文本（store.loadErrors[`conversation:<id>`]）。 */
  loadError: string | undefined
  /** 强制重新拉取会话详情。 */
  reload: () => void
}

/**
 * 订阅单个会话：详情缺失且无失败记录时自动加载，随后随 SSE 实时更新。
 * conversationId 为 undefined 时（无会话上下文）返回空视图且不发请求。
 */
export function useConversation(conversationId: number | undefined): ConversationHookResult {
  const store = useHelmStore()
  const summary =
    conversationId !== undefined ? store.conversations.find((c) => c.id === conversationId) : undefined
  const detail = conversationId !== undefined ? store.conversationDetails[conversationId] : undefined
  const live = conversationId !== undefined ? store.conversationLives[conversationId] : undefined
  const pendingAsks =
    conversationId !== undefined ? store.pendingAsks.filter((a) => a.conversationId === conversationId) : []
  const loadError =
    conversationId !== undefined ? store.loadErrors[`conversation:${conversationId}`] : undefined
  const load = store.loadConversationDetail

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

/** 校验会话 ID 为正安全整数（与内核边界一致），非法即抛显式错误。 */
function assertConversationId(id: number, label: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} 需为正整数（收到 ${String(id)}）`)
  }
}

/**
 * 从宿主 store 构造绑定插件 ID 的上下文实现（PluginUiView 内部使用）。
 * - callAction 第三参支持跨插件寻址（pluginId）与关联会话（conversationId）；
 * - submitInput 向真实 conversationsApi 提交输入，无会话时显式 reject；
 * - getPluginDoc 第二参读取其他插件公开文档；
 * - composer 仅在宿主提供（输入区槽位）时透传。
 */
export function createPluginClientContext(
  store: HelmStoreValue,
  pluginId: string,
  conversationId: number | undefined,
  composer?: ComposerController,
): PluginClientContextType {
  return {
    pluginId,
    callAction: (actionId, input, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      if (options?.conversationId !== undefined) assertConversationId(options.conversationId, 'options.conversationId')
      return store.invokePluginAction(
        targetPlugin,
        actionId,
        input,
        options?.conversationId ?? conversationId,
      )
    },
    submitInput: async (text, options) => {
      const target = options?.conversationId ?? conversationId
      if (target === undefined) {
        throw new Error('submitInput 无目标会话：当前槽位无会话上下文且未传 options.conversationId')
      }
      assertConversationId(target, 'conversationId')
      await conversationsApi.submitInput(target, {
        text,
        origin: 'agent',
        ...(options?.whenBusy !== undefined ? { whenBusy: options.whenBusy } : {}),
      })
    },
    openScreen: (target) => store.openTarget(target),
    openSplitScreen: (target) => store.openTarget(target, { split: true }),
    openConversationDrawer: (conversationId) =>
      store.setActiveModal({ kind: 'conversation-drawer', conversationId }),
    openArtifact: (artifactId) =>
      store.setActiveModal({ kind: 'artifact-preview', artifactId, conversationId }),
    openWorkbench: (panelId) => {
      store.setWorkbenchOpen(true)
      if (panelId) store.setWorkbenchTab(panelId)
    },
    closeWorkbench: () => store.setWorkbenchOpen(false),
    notify: (message, tone = 'info') =>
      store.pushNotice({
        type: 'notification',
        level: tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'info',
        title: message,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
    getPluginDoc: (docName, pluginId2) => store.ensurePluginDoc(pluginId2 ?? pluginId, docName),
    getPluginSessionDoc: (docName, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      const target = options?.conversationId ?? conversationId
      if (target === undefined) {
        return Promise.reject(new Error('getPluginSessionDoc 无目标会话：当前槽位无会话上下文且未传 options.conversationId'))
      }
      assertConversationId(target, 'conversationId')
      return store.getPluginSessionDoc(targetPlugin, docName, target)
    },
    ...(composer !== undefined ? { composer } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: store.theme,
  }
}
