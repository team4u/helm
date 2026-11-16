/**
 * 宿主能力端口（host port）：SDK 与宿主 Web 之间的唯一注入面。
 *
 * SDK 包不反向依赖任何宿主实现（store / API / 导航 / markdown 渲染 / 插件槽
 * 渲染）；全部宿主能力以类型清晰的端口对象经 <PluginClientHostContext.Provider>
 * 注入。宿主（@helm/web）在 HelmStoreProvider 内用真实 store 实现本端口；
 * 插件与宿主共享同一 React / context 实例（编译器把 '@helm/plugin-client'
 * 虚拟化为 __helm_shared_plugin_client 全局命名空间）。
 *
 * 本文件只含类型与 context（无组件导出，Fast Refresh 友好）。
 */
import { createContext, useContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type {
  AskSpec,
  ComposerController,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  PluginSlotContributionSpec,
  PluginSummary,
  ScreenSpec,
  WhenBusy,
} from '@helm/protocol/browser'

/** 会话级插件文档订阅元组（宿主 ref-count 共享专用 SSE 流的 key）。 */
export interface PluginSessionDocKey {
  pluginId: string
  docName: string
  conversationId: number
}

/** 会话级文档订阅快照（与宿主 session-docs 缓存态一致；未订阅返回空态）。 */
export interface PluginSessionDocState {
  value?: unknown
  hasValue: boolean
  deleted: boolean
  error?: string
  connected: boolean
}

/** 子插槽贡献项（宿主匹配 + 排序后回填；spec 为协议类型，不含宿主私有类型）。 */
export interface PluginSlotPortItem {
  pluginId: string
  contributionId: string
  spec: PluginSlotContributionSpec
}

/** SDK MarkdownViewProps（宿主 MarkdownView 实现必须满足的 props 契约）。 */
export interface MarkdownViewProps {
  text: string
  conversationId?: number
  /** true = 流式正文：已完成前缀块冻结复用解析，仅末尾可变块重解析。 */
  streaming?: boolean
}

/** SDK CodeBlockViewProps（宿主语法高亮代码块 props 契约）。 */
export interface CodeBlockViewProps {
  code: string
  language: string
}

/**
 * 宿主注入的完整能力端口。数据切片为响应式快照（引用变化驱动重渲染，
 * 与宿主 store 同一节奏）；方法均为宿主真实实现，无任何 mock。
 */
export interface PluginClientHostPort {
  /** 已通过鉴权（决定公开文档是否可发起首次 GET）。 */
  authenticated: boolean
  theme: 'light' | 'dark'

  // ---- 会话与插件实时快照（SSE 驱动） ----
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  loadErrors: Record<string, string>
  plugins: PluginSummary[]
  /** 已启用插件注册的 Screen 贡献（停用插件贡献即时移除）。 */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>

  // ---- 插件文档 ----
  /** key: `${pluginId}/${docName}`。 */
  pluginDocs: Record<string, unknown>
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  subscribeSessionDoc(key: PluginSessionDocKey, listener: () => void): () => void
  getSessionDocState(key: PluginSessionDocKey): PluginSessionDocState

  // ---- 动作与输入 ----
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
  submitConversationInput(
    conversationId: number,
    input: { text: string; origin: 'human' | 'agent' | 'trigger'; whenBusy?: WhenBusy },
  ): Promise<void>

  // ---- 导航与通知 ----
  openTarget(target: string, options?: { split?: boolean }): void
  openConversationDrawer(conversationId: number): void
  openArtifactPreview(artifactId: string, conversationId?: number): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  notify(message: string, tone: 'info' | 'warning' | 'error', conversationId?: number): void

  // ---- 详情加载 ----
  loadConversationDetail(conversationId: number, force?: boolean): Promise<ConversationDetail | undefined> | void

  // ---- 子插槽（匹配/排序由宿主执行；环保护与深度限制由 SDK 组件负责） ----
  slots: {
    /** 命中当前会话 scope 的贡献项（priority 降序、order 升序稳定排序）。 */
    collectItems(qualifiedName: string, conversationId: number | undefined): ReadonlyArray<PluginSlotPortItem>
    /** 渲染单个贡献项（宿主 PluginUiView：子上下文 pluginId 是贡献者插件）。 */
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

  // ---- Markdown 渲染（宿主标准实现：产物链接、代码块扩展、流式分块） ----
  markdown: {
    view: ComponentType<MarkdownViewProps>
    codeBlock: ComponentType<CodeBlockViewProps>
  }
}

export const PluginClientHostContext = createContext<PluginClientHostPort | null>(null)

/** 读取宿主端口；不在宿主 Provider 内时显式报错（绝不静默返回降级实现）。 */
export function usePluginClientHost(): PluginClientHostPort {
  const port = useContext(PluginClientHostContext)
  if (port === null) {
    throw new Error('usePluginClientHost 必须在 <PluginClientHostContext.Provider> 内调用（宿主 HelmStoreProvider 注入）')
  }
  return port
}
