/**
 * 插件 client.tsx 组件的宿主上下文（usePluginContext 返回值）与上下文工厂。
 *
 * - PluginClientContext / usePluginContext：插件组件内取当前插件身份与会话能力；
 * - createPluginClientContext：宿主 PluginUiView 从宿主端口构造绑定插件 ID 的
 *   上下文实现（callAction 跨插件寻址、submitInput 无会话显式 reject、导航与
 *   通知转发真实宿主端口，无任何 mock）。
 *
 * 本文件无组件导出（Fast Refresh 友好）。
 */
import { createContext, useContext } from 'react'
import type { ComposerController, PluginClientContext as PluginClientContextType } from '@helm/protocol'
import type { PluginClientHostPort } from './host-port.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return ctx
}

/** 校验会话 ID 为正安全整数（与内核边界一致），非法即抛显式错误。 */
function assertConversationId(id: number, label: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} 需为正整数（收到 ${String(id)}）`)
  }
}

/**
 * 从宿主端口构造绑定插件 ID 的上下文实现（宿主 PluginUiView 内部使用）。
 * - callAction 第三参支持跨插件寻址（pluginId）与关联会话（conversationId）；
 * - submitInput 经宿主端口向真实会话提交输入，无会话时显式 reject；
 * - getPluginDoc 第二参读取其他插件公开文档；
 * - composer 仅在宿主提供（输入区槽位）时透传。
 */
export function createPluginClientContext(
  port: PluginClientHostPort,
  pluginId: string,
  conversationId: number | undefined,
  composer?: ComposerController,
): PluginClientContextType {
  return {
    pluginId,
    callAction: (actionId, input, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      if (options?.conversationId !== undefined) assertConversationId(options.conversationId, 'options.conversationId')
      return port.invokePluginAction(
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
      await port.submitConversationInput(target, {
        text,
        origin: 'agent',
        ...(options?.whenBusy !== undefined ? { whenBusy: options.whenBusy } : {}),
      })
    },
    openScreen: (target) => port.openTarget(target),
    openSplitScreen: (target) => port.openTarget(target, { split: true }),
    openConversationDrawer: (targetConversationId) => port.openConversationDrawer(targetConversationId),
    openArtifact: (artifactId) => port.openArtifactPreview(artifactId, conversationId),
    openWorkbench: (panelId) => {
      port.setWorkbenchOpen(true)
      if (panelId) port.setWorkbenchTab(panelId)
    },
    closeWorkbench: () => port.setWorkbenchOpen(false),
    notify: (message, tone = 'info') => port.notify(message, tone, conversationId),
    getPluginDoc: (docName, pluginId2) => port.ensurePluginDoc(pluginId2 ?? pluginId, docName),
    getPluginSessionDoc: (docName, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      const target = options?.conversationId ?? conversationId
      if (target === undefined) {
        return Promise.reject(new Error('getPluginSessionDoc 无目标会话：当前槽位无会话上下文且未传 options.conversationId'))
      }
      assertConversationId(target, 'conversationId')
      return port.getPluginSessionDoc(targetPlugin, docName, target)
    },
    ...(composer !== undefined ? { composer } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: port.theme,
  }
}
