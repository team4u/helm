/**
 * 与生产 HelmxStoreProvider 同构的测试 Provider 栈：真实 external store + SDK 宿主端口
 * （直接复用生产 PluginClientHostBridge，无第二套端口实现；TestStoreProvider 再叠加插件上下文）。
 *
 * 本模块静态引入 @helmx/plugin-client（携带 Radix 依赖图）与生产 Provider 模块：
 * happy-dom 环境下需要交互式展开 Radix 浮层的测试必须遵循「GlobalRegistrator.register()
 * 之后再动态加载」约定（与组件动态加载同一约定）导入本模块，否则浮层无法展开。
 */
import * as React from 'react'
import { PluginClientContext, PluginClientHostContext, createPluginClientContext } from '@helmx/plugin-client'
import { PluginClientHostBridge } from '../../src/lib/plugin-host-bridge.js'
import type { HelmxExternalStore } from '../../src/lib/helmx-store.js'
import { HelmxExternalStoreContext } from './store.js'

/** 真实 external store + SDK 宿主端口（与生产 HelmxStoreProvider 同一桥实现）。 */
export function HostStoreProviders({ value: store, children }: { value: HelmxExternalStore; children?: React.ReactNode }): React.ReactNode {
  return (
    <HelmxExternalStoreContext.Provider value={store}>
      <PluginClientHostBridge store={store}>{children ?? null}</PluginClientHostBridge>
    </HelmxExternalStoreContext.Provider>
  )
}

/** 在宿主端口桥内叠加插件 SDK 上下文（不替换 hooks 或组件事件）。 */
function TestPluginClientContext({ children }: { children?: React.ReactNode }): React.ReactNode {
  const port = React.useContext(PluginClientHostContext)
  if (port === null) {
    throw new Error('TestStoreProvider: PluginClientHostContext missing inside PluginClientHostBridge')
  }
  const value = React.useMemo(() => createPluginClientContext(port, 'builtin:workflow', 1), [port])
  return <PluginClientContext.Provider value={value}>{children}</PluginClientContext.Provider>
}

/** 同时注入真实宿主 store、SDK 宿主端口与插件上下文，不替换 hooks 或组件事件。 */
export function TestStoreProvider({ value: store, children }: { value: HelmxExternalStore; children?: React.ReactNode }): React.ReactNode {
  return (
    <HelmxExternalStoreContext.Provider value={store}>
      <PluginClientHostBridge store={store}>
        <TestPluginClientContext>{children ?? null}</TestPluginClientContext>
      </PluginClientHostBridge>
    </HelmxExternalStoreContext.Provider>
  )
}
