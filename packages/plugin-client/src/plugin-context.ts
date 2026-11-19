/**
 * Host context for plugin client.tsx components (return value of
 * usePluginContext) and the context factory.
 *
 * - PluginClientContext / usePluginContext: current plugin identity and
 *   conversation capabilities inside plugin components;
 * - createPluginClientContext: the host PluginUiView builds the plugin-ID-bound
 *   context implementation from the host port (callAction addresses across
 *   plugins, submitInput explicitly rejects without a conversation, navigation
 *   and notifications forward to the real host port, no mocks).
 *
 * No component exports in this file (Fast Refresh friendly).
 */
import { createContext, useContext } from 'react'
import {
  DEFAULT_HELMX_LOCALE,
  createLocaleTranslator,
  type ComposerController,
  type PluginClientContext as PluginClientContextType,
} from '@helmx/protocol/browser'
import type { PluginClientHostPort } from './host-port.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext must be called inside a plugin component rendered by <PluginUiView>')
  }
  return ctx
}

/** Validates a conversation ID as a positive safe integer (aligned with the kernel boundary); throws an explicit error otherwise. */
function assertConversationId(id: number, label: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive integer (received ${String(id)})`)
  }
}

/**
 * Build the plugin-ID-bound context implementation from the host port (used
 * internally by the host PluginUiView).
 * - callAction's third argument supports cross-plugin addressing (pluginId)
 *   and conversation association (conversationId);
 * - submitInput submits input to the real conversation through the host port
 *   and explicitly rejects when there is no conversation;
 * - getPluginDoc's second argument reads other plugins' public docs;
 * - locale/translate bind the host port locale (falling back to
 *   DEFAULT_HELMX_LOCALE / a derived translator when the host has not wired
 *   them yet) so plugin components can resolve LocalizedText display copy;
 * - composer is passed through only when the host provides it (composer slots).
 */
export function createPluginClientContext(
  port: PluginClientHostPort,
  pluginId: string,
  conversationId: number | undefined,
  composer?: ComposerController,
): PluginClientContextType {
  const locale = port.locale ?? DEFAULT_HELMX_LOCALE
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
        throw new Error('submitInput has no target conversation: the current slot has no conversation context and options.conversationId was not given')
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
        return Promise.reject(new Error('getPluginSessionDoc has no target conversation: the current slot has no conversation context and options.conversationId was not given'))
      }
      assertConversationId(target, 'conversationId')
      return port.getPluginSessionDoc(targetPlugin, docName, target)
    },
    ...(composer !== undefined ? { composer } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: port.theme,
    locale,
    translate: port.translate ?? createLocaleTranslator(locale),
  }
}
