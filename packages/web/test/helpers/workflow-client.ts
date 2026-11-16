/**
 * 测试当前 worktree 的真实 client 编译产物。
 * tsx 执行 kernel 编译器源码；浏览器 ESM 经 data: URL 导入，共享宿主 React/SDK。
 * 默认只替换数据 hooks 以构造状态；上下文始终读取真实 Provider，绝不吞掉事件。
 */
import { fileURLToPath } from 'node:url'
import * as HelmPluginClient from '@helm/plugin-client'
import {
  importCompiledPluginClient,
  mountPluginNamespaceGlobals,
  PLUGIN_CLIENT_CACHE_DIR,
} from './plugin-namespace.js'

const WORKFLOW_CLIENT_ROOT = fileURLToPath(new URL('../../../plugins/src/workflow/client', import.meta.url))

export interface WorkflowClientStubOptions {
  docValue?: unknown
  conversations?: unknown[]
  conversation?: (id: number | undefined) => Record<string, unknown>
}

let stub: WorkflowClientStubOptions = {}
let realHooks = false

export function setWorkflowClientStub(options: WorkflowClientStubOptions = {}): void {
  stub = options
}

// 编译产物持有这个对象的引用。测试只更新数据，不替换共享命名空间身份。
// runs 已是会话分片：stub.docValue 同时充当 usePluginSessionDoc('runs', ...) 的
// 返回值（组件不再读全局 runs 文档）。
const sharedPluginClientNamespace = {
  ...HelmPluginClient,
  usePluginDoc: (name: string) => realHooks ? HelmPluginClient.usePluginDoc(name) : stub.docValue,
  usePluginSessionDoc: (name: string, options?: { conversationId?: number }) =>
    realHooks ? HelmPluginClient.usePluginSessionDoc(name, options) : stub.docValue,
  useConversations: () => realHooks ? HelmPluginClient.useConversations() : stub.conversations ?? [],
  useConversation: (id: number | undefined) => realHooks
    ? HelmPluginClient.useConversation(id)
    : stub.conversation?.(id) ?? { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  mountPluginNamespaceGlobals(sharedPluginClientNamespace)
}

export async function importWorkflowClientModule(
  moduleRef = 'index.tsx',
  cacheDir = PLUGIN_CLIENT_CACHE_DIR,
): Promise<Record<string, unknown>> {
  return importCompiledPluginClient('builtin:workflow', WORKFLOW_CLIENT_ROOT, moduleRef, cacheDir)
}

/** 类型引用不执行源码：运行时始终使用上方真实编译与动态 import。 */
export async function importWorkflowModels(
  cacheDir = PLUGIN_CLIENT_CACHE_DIR,
): Promise<typeof import('../../../plugins/src/workflow/client/models.ts')> {
  return await importWorkflowClientModule('models.ts', cacheDir) as unknown as typeof import('../../../plugins/src/workflow/client/models.ts')
}
