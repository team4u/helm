/**
 * Host capability port: the single injection surface between the SDK and the host web app.
 *
 * The SDK package never depends on any host implementation (store / API /
 * navigation / markdown rendering / plugin slot rendering); all host
 * capabilities are injected as a typed port object via
 * <PluginClientHostContext.Provider>. The host (@helm/web) implements this
 * port with the real store inside HelmStoreProvider; plugins and the host
 * share the same React / context instance (the compiler virtualizes
 * '@helm/plugin-client' into the __helm_shared_plugin_client global
 * namespace).
 *
 * Types and context only in this file (no component exports, Fast Refresh friendly).
 */
import { createContext, useContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type {
  AskSpec,
  ComposerController,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  HelmLocale,
  LocaleTranslator,
  PluginSlotContributionSpec,
  PluginSummary,
  ScreenSpec,
  WhenBusy,
} from '@helm/protocol/browser'

/** Conversation-scoped plugin doc subscription tuple (key for the host ref-counted shared SSE stream). */
export interface PluginSessionDocKey {
  pluginId: string
  docName: string
  conversationId: number
}

/** Session doc subscription snapshot (consistent with the host session-docs cache; empty state when unsubscribed). */
export interface PluginSessionDocState {
  value?: unknown
  hasValue: boolean
  deleted: boolean
  error?: string
  connected: boolean
}

/** Sub-slot contribution item (matched + ordered by the host; spec is a protocol type, no host-private types). */
export interface PluginSlotPortItem {
  pluginId: string
  contributionId: string
  spec: PluginSlotContributionSpec
}

/** SDK MarkdownViewProps (the props contract the host MarkdownView implementation must satisfy). */
export interface MarkdownViewProps {
  text: string
  conversationId?: number
  /** true = streaming body: completed prefix blocks freeze their parsed form for reuse, only the trailing mutable block is re-parsed. */
  streaming?: boolean
  /** true = render single newlines as hard line breaks (user-authored bodies keep their typed line structure). */
  breaks?: boolean
  /** Relative POSIX directory within the workspace (e.g. 'docs') used as base dir when resolving relative links/images in nested Markdown previews. */
  workspaceBaseDir?: string
}

/** SDK CodeBlockViewProps (host syntax-highlighted code block props contract). */
export interface CodeBlockViewProps {
  code: string
  language: string
}

/**
 * The complete capability port injected by the host. Data slices are reactive
 * snapshots (reference changes drive re-renders, at the same cadence as the
 * host store); every method is a real host implementation, no mocks.
 */
export interface PluginClientHostPort {
  /** Passed authentication (decides whether public docs may issue the first GET). */
  authenticated: boolean
  theme: 'light' | 'dark'
  /**
   * Current host UI locale (normalized via HELM_LOCALES / normalizeLocaleTag).
   * Optional so hosts can adopt it additively: when absent, the plugin client
   * context factory falls back to DEFAULT_HELM_LOCALE ('en') — a locale always
   * has a well-defined default, so no silent degradation of data fidelity is
   * involved.
   */
  locale?: HelmLocale
  /**
   * Minimal translator for the current locale (resolves LocalizedText display
   * copy). Optional for the same additive reason: when absent, the context
   * factory derives one from locale via createLocaleTranslator. When both are
   * provided, keep them bound to the same locale.
   */
  translate?: LocaleTranslator

  // ---- Conversations & plugin realtime snapshots (SSE driven) ----
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  loadErrors: Record<string, string>
  plugins: PluginSummary[]
  /** Screen contributions registered by enabled plugins (disabled plugin contributions are removed immediately). */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>

  // ---- Plugin docs ----
  /** key: `${pluginId}/${docName}`. */
  pluginDocs: Record<string, unknown>
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  subscribeSessionDoc(key: PluginSessionDocKey, listener: () => void): () => void
  getSessionDocState(key: PluginSessionDocKey): PluginSessionDocState

  // ---- Actions & input ----
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
  submitConversationInput(
    conversationId: number,
    input: { text: string; origin: 'human' | 'agent' | 'trigger'; whenBusy?: WhenBusy },
  ): Promise<void>

  // ---- Navigation & notifications ----
  openTarget(target: string, options?: { split?: boolean }): void
  openConversationDrawer(conversationId: number): void
  openArtifactPreview(artifactId: string, conversationId?: number): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  notify(message: string, tone: 'info' | 'warning' | 'error', conversationId?: number): void

  // ---- Detail loading ----
  loadConversationDetail(conversationId: number, force?: boolean): Promise<ConversationDetail | undefined> | void

  // ---- Sub-slots (matching/ordering done by the host; cycle guard and depth limit by the SDK component) ----
  slots: {
    /** Contribution items matching the current conversation scope (priority descending, order ascending, stable sort). */
    collectItems(qualifiedName: string, conversationId: number | undefined): ReadonlyArray<PluginSlotPortItem>
    /** Render a single contribution item (host PluginUiView: the sub context's pluginId is the contributing plugin). */
    renderItem(
      item: PluginSlotPortItem,
      options: {
        slotProps?: Record<string, unknown>
        conversationId?: number
        composer?: ComposerController
        label: string
      },
    ): ReactNode
  }

  // ---- Markdown rendering (host standard implementation: artifact links, code block extensions, streaming chunks) ----
  markdown: {
    view: ComponentType<MarkdownViewProps>
    codeBlock: ComponentType<CodeBlockViewProps>
  }
}

export const PluginClientHostContext = createContext<PluginClientHostPort | null>(null)

/** Read the host port; explicitly errors outside the host Provider (never silently returns a degraded implementation). */
export function usePluginClientHost(): PluginClientHostPort {
  const port = useContext(PluginClientHostContext)
  if (port === null) {
    throw new Error('usePluginClientHost must be called inside <PluginClientHostContext.Provider> (injected by the host HelmStoreProvider)')
  }
  return port
}
