/**
 * 测试当前 worktree 三个内置插件（superagent / triggers / magpie）的真实 client
 * 编译产物（tsx 执行 kernel 编译器源码；浏览器 ESM 经 data: URL 导入，共享宿主
 * React/SDK）。默认只替换数据 hooks 以构造状态；上下文始终读取真实 Provider。
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
  ...HelmPluginClient,
  usePluginDoc: (name: string) => (realHooks ? HelmPluginClient.usePluginDoc(name) : stub.docs?.[name]),
  usePluginSessionDoc: (name: string, options?: { conversationId?: number }) =>
    realHooks ? HelmPluginClient.usePluginSessionDoc(name, options) : undefined,
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  Object.assign(globalThis, {
    __helm_shared_react: React,
    __helm_shared_react_dom: ReactDom,
    __helm_shared_react_dom_client: ReactDomClient,
    __helm_shared_react_jsx_runtime: ReactJsxRuntime,
    __helm_shared_lucide_react: LucideReact,
    __helm_shared_plugin_client: sharedPluginClientNamespace,
  })
}

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'helm-web-builtin-clients-'))
after(() => rmSync(CACHE_DIR, { recursive: true, force: true }))

const CLIENT_ROOTS: Record<string, string> = {
  'builtin:superagent': fileURLToPath(new URL('../../../kernel/src/builtin-plugins/superagent/client', import.meta.url)),
  'builtin:triggers': fileURLToPath(new URL('../../../kernel/src/builtin-plugins/triggers/client', import.meta.url)),
  'builtin:magpie': fileURLToPath(new URL('../../../kernel/src/builtin-plugins/magpie/client', import.meta.url)),
}

export async function importBuiltinClientModule(
  pluginId: keyof typeof CLIENT_ROOTS | string,
  moduleRef = 'index.tsx',
): Promise<Record<string, unknown>> {
  const root = CLIENT_ROOTS[pluginId]
  if (root === undefined) throw new Error(`未知内置插件 clientRoot：${pluginId}`)
  const { code } = await compilePluginClientModule(pluginId, root, moduleRef, CACHE_DIR)
  return (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<
    string,
    unknown
  >
}
