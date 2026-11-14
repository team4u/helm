/**
 * 宿主端口适配器：把真实 HelmStoreValue 适配为 @helm/plugin-client 的
 * PluginClientHostPort（SDK 唯一宿主注入面；SDK 不反向依赖任何 web 实现）。
 *
 * - 数据切片与具名函数直接转发真实 store（引用与 SSE 节奏一致，无拷贝无 mock）；
 * - submitConversationInput 走真实 conversationsApi.submitInput（origin: agent）；
 * - slots：匹配/排序复用 plugin-slot-model（宿主逻辑），单项渲染委托 PluginUiView；
 * - markdown：注入宿主标准 MarkdownView / CodeBlockView（产物链接、代码块扩展、
 *   流式分块），SDK 侧 MarkdownView/CodeBlockView 仅做端口转发。
 */
import { createElement } from 'react'
import type { PluginClientHostPort, PluginSlotPortItem } from '@helm/plugin-client'
import { conversationsApi } from './api.js'
import { MarkdownView, CodeBlockView } from '../conversation/MarkdownView.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { collectSlotItems } from '../ui/plugin-slot-model.js'
import { matchesUiScope, type HelmStoreValue } from './types.js'

/** 从真实 store 构造宿主端口（HelmStoreProvider 每次 store 变化重建，消费方仅依赖稳定具名函数）。 */
export function createPluginClientHostPort(store: HelmStoreValue): PluginClientHostPort {
  return {
    authenticated: store.authenticated,
    theme: store.theme,
    conversations: store.conversations,
    conversationDetails: store.conversationDetails,
    conversationLives: store.conversationLives,
    pendingAsks: store.pendingAsks,
    loadErrors: store.loadErrors,
    plugins: store.plugins,
    // 测试替身可能只携带部分字段：缺失的 UI 贡献切片语义为空（无 Screen / 无插槽贡献）。
    screens: store.groupedUi?.screens ?? [],
    pluginDocs: store.pluginDocs,
    ensurePluginDoc: (pluginId, docName) => store.ensurePluginDoc(pluginId, docName),
    getPluginSessionDoc: (pluginId, docName, conversationId) => store.getPluginSessionDoc(pluginId, docName, conversationId),
    subscribeSessionDoc: (key, listener) => store.subscribeSessionDoc(key, listener),
    getSessionDocState: (key) => store.getSessionDocState(key),
    invokePluginAction: (pluginId, actionId, input, conversationId) =>
      store.invokePluginAction(pluginId, actionId, input, conversationId),
    submitConversationInput: async (conversationId, input) => {
      await conversationsApi.submitInput(conversationId, {
        text: input.text,
        origin: input.origin,
        ...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
      })
    },
    openTarget: (target, options) => store.openTarget(target, options?.split === true ? { split: true } : undefined),
    openConversationDrawer: (conversationId) => store.setActiveModal({ kind: 'conversation-drawer', conversationId }),
    openArtifactPreview: (artifactId, conversationId) =>
      store.setActiveModal({ kind: 'artifact-preview', artifactId, ...(conversationId !== undefined ? { conversationId } : {}) }),
    setWorkbenchOpen: (open) => store.setWorkbenchOpen(open),
    setWorkbenchTab: (tab) => store.setWorkbenchTab(tab),
    notify: (message, tone, conversationId) =>
      store.pushNotice({
        type: 'notification',
        level: tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'info',
        title: message,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
    loadConversationDetail: (conversationId, force) => store.loadConversationDetail(conversationId, force),
    slots: {
      collectItems: (qualifiedName, conversationId) => {
        const conversation = conversationId !== undefined
          ? (store.conversations ?? []).find((c) => c.id === conversationId)
          : undefined
        return collectSlotItems(
          store.groupedUi?.pluginSlots ?? [],
          qualifiedName,
          (scope) => matchesUiScope(conversation, scope),
        ).map((item): PluginSlotPortItem => ({ pluginId: item.pluginId, contributionId: item.spec.id, spec: item.spec }))
      },
      renderItem: (item, options) =>
        createElement(PluginUiView, {
          pluginId: item.pluginId,
          spec: item.spec,
          slotProps: options.slotProps,
          conversationId: options.conversationId,
          composer: options.composer,
          label: options.label,
        }),
    },
    markdown: {
      view: MarkdownView,
      codeBlock: CodeBlockView,
    },
  }
}
