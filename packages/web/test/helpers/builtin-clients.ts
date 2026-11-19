/**
 * 测试当前 worktree 三个内置插件（superagent / triggers / magpie / apps）的真实 client
 * 编译产物（tsx 执行 kernel 编译器源码；浏览器 ESM 经 data: URL 导入，共享宿主
 * React/SDK）。默认只替换数据 hooks 以构造状态；上下文始终读取真实 Provider。
 */
import { fileURLToPath } from 'node:url'
import * as HelmxPluginClient from '@helmx/plugin-client'
import { importCompiledPluginClient, mountPluginNamespaceGlobals } from './plugin-namespace.js'

export interface BuiltinClientStubOptions {
  /** docName → doc 值（usePluginDoc 按 docName 路由返回）。 */
  docs?: Record<string, unknown>
}

let stub: BuiltinClientStubOptions = {}
let realHooks = false

export function setBuiltinClientStub(options: BuiltinClientStubOptions = {}): void {
  stub = options
}

const sharedPluginClientNamespace = {
  ...HelmxPluginClient,
  usePluginDoc: (name: string) => (realHooks ? HelmxPluginClient.usePluginDoc(name) : stub.docs?.[name]),
  usePluginSessionDoc: (name: string, options?: { conversationId?: number }) =>
    realHooks ? HelmxPluginClient.usePluginSessionDoc(name, options) : undefined,
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  mountPluginNamespaceGlobals(sharedPluginClientNamespace)
}

const CLIENT_ROOTS: Record<string, string> = {
  'builtin:swarm': fileURLToPath(new URL('../../../plugins/src/swarm/client', import.meta.url)),
  'builtin:superagent': fileURLToPath(new URL('../../../plugins/src/superagent/client', import.meta.url)),
  'builtin:triggers': fileURLToPath(new URL('../../../plugins/src/triggers/client', import.meta.url)),
  'builtin:magpie': fileURLToPath(new URL('../../../plugins/src/magpie/client', import.meta.url)),
  'builtin:apps': fileURLToPath(new URL('../../../plugins/src/apps/client', import.meta.url)),
  'builtin:tasks': fileURLToPath(new URL('../../../plugins/src/tasks/client', import.meta.url)),
}

export async function importBuiltinClientModule(
  pluginId: keyof typeof CLIENT_ROOTS | string,
  moduleRef = 'index.tsx',
): Promise<Record<string, unknown>> {
  const root = CLIENT_ROOTS[pluginId]
  if (root === undefined) throw new Error(`未知内置插件 clientRoot：${pluginId}`)
  return importCompiledPluginClient(pluginId, root, moduleRef)
}
