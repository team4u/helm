/**
 * 与生产 HelmStoreProvider 同构的测试 Provider 栈：真实 store + SDK 宿主端口
 * （TestStoreProvider 再叠加插件上下文）。
 *
 * 本模块静态引入 @helm/plugin-client（携带 Radix 依赖图）：happy-dom 环境下需要
 * 交互式展开 Radix 浮层的测试必须遵循「GlobalRegistrator.register() 之后再动态
 * 加载」约定（与组件动态加载同一约定）导入本模块，否则浮层无法展开。
 */
import * as React from 'react'
import { PluginClientContext, PluginClientHostContext, createPluginClientContext } from '@helm/plugin-client'
import { createLocaleTranslator } from '@helm/protocol/browser'
import { createPluginClientHostPort } from '../../src/lib/plugin-client-host.js'
import { HelmStoreContext } from '../../src/lib/store-context.js'
import type { HelmStoreValue } from '../../src/lib/types.js'

export function HostStoreProviders({ value, children }: { value: HelmStoreValue; children?: React.ReactNode }): React.ReactNode {
  // 与生产 HelmStoreProvider 同节奏：端口对象仅在 store 快照变化时重建（消费方仅依赖稳定具名函数）。
  // 语言端口镜像生产：locale/translate 叠加在基础适配器之上，SDK 组件按宿主 locale 渲染默认文案。
  const port = React.useMemo(() => ({ ...createPluginClientHostPort(value), locale: value.locale, translate: createLocaleTranslator(value.locale) }), [value])
  return React.createElement(HelmStoreContext.Provider, { value },
    React.createElement(PluginClientHostContext.Provider, { value: port }, children))
}

/** 同时注入真实宿主 store、SDK 宿主端口与插件上下文，不替换 hooks 或组件事件。 */
export function TestStoreProvider({ value, children }: { value: HelmStoreValue; children?: React.ReactNode }): React.ReactNode {
  const port = React.useMemo(() => ({ ...createPluginClientHostPort(value), locale: value.locale, translate: createLocaleTranslator(value.locale) }), [value])
  return React.createElement(HelmStoreContext.Provider, { value },
    React.createElement(PluginClientHostContext.Provider, { value: port },
      React.createElement(PluginClientContext.Provider, { value: createPluginClientContext(port, 'builtin:workflow', 1) }, children)))
}
