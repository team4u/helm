/**
 * 测试辅助：经 kernel 真实 esbuild 编译器加载 builtin:workflow 插件 client 模块。
 *
 * - 纯逻辑（models.ts）与组件（index.tsx）均编译为浏览器 ESM 后以 data: URL
 *   动态 import（与浏览器 Blob URL 动态 import 语义一致）；
 * - 共享依赖经 __helm_shared_* 命名空间解析（与 HelmStoreProvider 挂载一致）；
 * - @helm/plugin-client 共享模块注入 stub 上下文（纯逻辑/SSR 渲染均够用）；
 * - tsx 直接执行当前 worktree 的真实编译器源码，不依赖整个 kernel 构建或私有脚本。
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as LucideReact from 'lucide-react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compilePluginClientModule } from '../../../kernel/src/plugins/client-compiler.js'
import * as HelmPluginClient from '../../src/lib/plugin-client-context.js'

const WORKFLOW_CLIENT_ROOT = fileURLToPath(new URL('../../../kernel/src/builtin-plugins/workflow/client', import.meta.url))
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'helm-web-workflow-client-'))
after(() => rmSync(CACHE_DIR, { recursive: true, force: true }))

export interface StubPluginClientContext {
  pluginId: string
  callAction: (actionId: string, input?: unknown) => Promise<unknown>
  openScreen: (target: string) => void
  openSplitScreen: (target: string) => void
  openConversationDrawer: (conversationId: number) => void
  openArtifact: (artifactId: string) => void
  openWorkbench: (panelId?: string) => void
  closeWorkbench: () => void
  notify: (message: string, tone?: 'info' | 'warning' | 'error') => void
  getPluginDoc: (docName: string) => Promise<unknown>
  conversationId?: number
  theme: 'light' | 'dark'
}

export interface WorkflowClientStubOptions {
  /** usePluginDoc 返回值（默认 undefined）。 */
  docValue?: unknown
  /** useConversations 返回值（默认 []）。 */
  conversations?: unknown[]
  /** useConversation(id) 返回值工厂。 */
  conversation?: (id: number | undefined) => Record<string, unknown>
  /** usePluginContext 返回的上下文。 */
  context?: StubPluginClientContext
}

/** 可变 stub 配置：模块编译产物在首次 import 时捕获命名空间对象引用，
 * 因此挂载的命名空间必须是同一对象；测试通过 setWorkflowClientStub 动态改写行为。 */
const stubState: {
  docValue: unknown
  conversations: unknown[]
  conversation: (id: number | undefined) => Record<string, unknown> | undefined
  context: StubPluginClientContext | undefined
} = {
  docValue: undefined,
  conversations: [],
  conversation: undefined,
  context: undefined,
}

/** 更新共享 stub 行为（对已 import 的编译产物立即生效）。 */
export function setWorkflowClientStub(opts: WorkflowClientStubOptions = {}): void {
  stubState.docValue = opts.docValue
  stubState.conversations = opts.conversations ?? []
  stubState.conversation = opts.conversation
  stubState.context = opts.context
}

let realHooks = false
const sharedPluginClientNamespace = {
  ...HelmPluginClient,
  usePluginDoc: (name: string) => realHooks ? HelmPluginClient.usePluginDoc(name) : stubState.docValue,
  useConversations: () => realHooks ? HelmPluginClient.useConversations() : stubState.conversations,
  useConversation: (id: number | undefined) => realHooks
    ? HelmPluginClient.useConversation(id)
    : stubState.conversation?.(id) ?? { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  usePluginContext: (): StubPluginClientContext => {
    const context = HelmPluginClient.usePluginContext()
    return stubState.context ?? context
  },
}

/** 挂载 __helm_shared_* 命名空间（幂等；每个测试文件 before 钩号调用一次即可）。 */
export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  const g = globalThis as unknown as Record<string, unknown>
  g.__helm_shared_react = React
  g.__helm_shared_react_dom = ReactDom
  g.__helm_shared_react_dom_client = ReactDomClient
  g.__helm_shared_react_jsx_runtime = ReactJsxRuntime
  g.__helm_shared_lucide_react = LucideReact
  g.__helm_shared_plugin_client = sharedPluginClientNamespace
}

export const workflowClientRoot = WORKFLOW_CLIENT_ROOT

/** 编译并动态 import builtin:workflow client 模块（默认 index.tsx）。 */
export async function importWorkflowClientModule(
  moduleRef = 'index.tsx',
  cacheDir = CACHE_DIR,
): Promise<Record<string, unknown>> {
  const { code } = await compilePluginClientModule('builtin:workflow', WORKFLOW_CLIENT_ROOT, moduleRef, cacheDir)
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  return (await import(url)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 编译产物 models.ts 的类型化视图（编译产物无 .d.ts；签名与源码一一对应）
// ---------------------------------------------------------------------------

import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  WorkflowNodeState,
  WorkflowRunSummary,
} from '@helm/protocol'

export interface WorkflowModels {
  formatDurationMs(ms: number | undefined): string
  firstLineOf(text: string, maxChars: number): string
  resolveSubagentConversationId(
    input: { callId: string | undefined; input: unknown; result?: unknown },
    parentConversationId: number,
    conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
  ): number | undefined
  resolveWorkflowRunForTool(
    input: { callId: string | undefined; result?: unknown },
    parentConversationId: number,
    workflowRuns: ReadonlyArray<WorkflowRunSummary>,
  ): WorkflowRunSummary | undefined
  resolveSubagentExecutionMeta(
    input: { callId: string | undefined; result?: unknown },
    parentConversationId: number,
    workflowRuns: ReadonlyArray<WorkflowRunSummary>,
  ): {
    run?: WorkflowRunSummary
    worktree?: { path: string; branch: string }
    executionId?: string
    nodeId?: string
    effectiveCwd?: string
  }
  subagentBadge(
    summaryStatus: string | undefined,
    toolStatus: 'running' | 'done' | 'error' | 'unknown',
    backgroundRunStatus?: WorkflowRunSummary['status'],
  ): { status: string; label: string; badge: string }
  resolveSubagentTaskTitle(
    summary: ConversationSummary | undefined,
    childConversationId: number,
    toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean },
    backgroundRun?: WorkflowRunSummary,
  ): string | undefined
  formatShortModelName(model: string | undefined): string | undefined
  resolveSubagentElapsedMs(input: {
    backgroundRun?: WorkflowRunSummary
    toolSummary?: { startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean; prompt?: string }
    startedAt?: number
    nowMs?: number
    isWorking?: boolean
  }): number | undefined
  formatSemanticToolAction(toolName: string, input: unknown, cwd?: string): { tag: string; text: string }
  extractSubagentResultPreview(resultText: string | undefined): string | undefined
  resolveSubagentHeaderSnippet(input: {
    badgeStatus: string
    summary?: ConversationSummary
    live?: ConversationLive
    entries?: ReadonlyArray<ConversationEntry>
    pendingAsk?: { title?: string; description?: string }
    backgroundRun?: WorkflowRunSummary
    toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
    detailError?: string
  }): { kind: string; tag?: string; text: string } | undefined
  buildSubagentStreamLines(
    entries: ReadonlyArray<ConversationEntry>,
    live?: ConversationLive,
    working?: boolean,
  ): Array<Record<string, unknown> & { kind: string }>
  buildSubagentStatSegments(input: {
    summary?: ConversationSummary
    entries?: ReadonlyArray<ConversationEntry>
    live?: ConversationLive
    backgroundRun?: WorkflowRunSummary
    toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
    nowMs?: number
    startedAt?: number
    isWorking?: boolean
  }): string[]
  resolveNodeSummaryText(
    node: WorkflowNodeState,
    childDoing?: string,
    childStatus?: ConversationSummary['status'],
    pendingAskTitle?: string,
  ): { text?: string; isError: boolean }
  formatNodeOutputPreview(output: unknown, maxChars?: number): string | undefined
  buildWorkflowPhaseSections(run: WorkflowRunSummary): Array<{
    key: string
    index: number
    title: string
    detail?: string
    status: 'pending' | 'running' | 'done' | 'failed'
    nodes: WorkflowNodeState[]
    doneCount: number
    totalCount: number
  }>
  extractWorkflowLogs(run: WorkflowRunSummary): Array<{ key: string; at: number; message: string }>
  canResumeWorkflowRun(run: WorkflowRunSummary): boolean
  formatWorkflowNodeStats(node: WorkflowNodeState): string[]
  buildWorkbenchSubagentItems(
    conversations: ReadonlyArray<ConversationSummary>,
    parentConversationId: number,
    workflowRuns: ReadonlyArray<WorkflowRunSummary>,
  ): Array<{ conversationId: number; summary?: ConversationSummary; backgroundRun?: WorkflowRunSummary }>
  isLatestSubagentCallForTarget(
    props: {
      callId: string
      input?: unknown
      result?: unknown
      siblingCalls?: ReadonlyArray<{ callId: string; toolName: string; input?: unknown; status: string; result?: unknown }>
      conversationId: number
    },
    childConversationId: number | undefined,
  ): boolean
  parentToolSummaryOf(props: {
    input?: unknown
    startedAt?: number
    durationMs?: number
    result?: unknown
    isError?: boolean
  }): { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
}

/** 编译并动态 import models.ts（类型化视图）。 */
export async function importWorkflowModels(cacheDir = CACHE_DIR): Promise<WorkflowModels> {
  return (await importWorkflowClientModule('models.ts', cacheDir)) as unknown as WorkflowModels
}
