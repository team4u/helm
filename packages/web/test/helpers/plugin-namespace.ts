/**
 * 共享插件客户端编译与全局命名空间挂载基础设施：
 * 供 builtin-clients.ts 等 Web 宿主测试复用，避免重复声明 React/SDK 全局桥与 data: ESM 导入逻辑。
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as LucideReact from 'lucide-react'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compilePluginClientModule } from '@helm/plugin-build'

export const PLUGIN_CLIENT_CACHE_DIR = fileURLToPath(
  new URL('../../../../node_modules/.cache/helm-test-plugin-clients', import.meta.url),
)
mkdirSync(PLUGIN_CLIENT_CACHE_DIR, { recursive: true })

/** 将宿主共享 React / Lucide / @helm/plugin-client 命名空间挂载到 globalThis。 */
export function mountPluginNamespaceGlobals(pluginClientNamespace: Record<string, unknown>): void {
  Object.assign(globalThis, {
    __helm_shared_react: React,
    __helm_shared_react_dom: ReactDom,
    __helm_shared_react_dom_client: ReactDomClient,
    __helm_shared_react_jsx_runtime: ReactJsxRuntime,
    __helm_shared_lucide_react: LucideReact,
    __helm_shared_plugin_client: pluginClientNamespace,
  })
}

/** 通过 @helm/plugin-build 编译真实插件 client 模块并以 data: URL 动态导入。 */
export async function importCompiledPluginClient(
  pluginId: string,
  root: string,
  moduleRef = 'index.tsx',
  cacheDir = PLUGIN_CLIENT_CACHE_DIR,
): Promise<Record<string, unknown>> {
  const { code } = await compilePluginClientModule(pluginId, root, moduleRef, cacheDir)
  return (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<
    string,
    unknown
  >
}
