/**
 * PluginUiView：所有视图类 UI 扩展点的统一 wrapper（纯数据注册项不经过本组件）。
 * - 动态编译 client 模块加载 / 导出校验错误显式展示（绝不静默空白），
 *   ViewBoundary 隔离渲染异常；
 * - 注入 PluginClientContext（usePluginContext）与协议标准 Props；
 * - 组件函数校验：导出不是函数时显式报错。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { ClientComponentRef, ComposerController } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { createPluginClientContext, PluginClientContext } from '../lib/plugin-client-context.js'
import { getCachedClientComponent, getPluginClientCacheRevision, loadPluginClientModule, PluginClientError, requireClientExport, subscribePluginClientCacheInvalidation } from '../lib/plugin-client.js'
import { ViewBoundary } from './ViewBoundary.js'

export interface PluginUiViewProps {
  pluginId: string
  /** client.tsx 组件引用（注册边界已拒绝悬空引用；缺省属契约违约，显式报错）。 */
  spec: { client?: ClientComponentRef }
  /** 协议标准 Props（screenId / entry / toolView / conversation 等）。 */
  slotProps?: Record<string, unknown>
  /** 会话上下文 ID（无会话槽位省略）。 */
  conversationId?: number
  /** 输入区控制器（仅 composer 槽位由宿主提供）。 */
  composer?: ComposerController
  /** ViewBoundary 错误标题。 */
  label?: string
}

type ClientState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; Component: ComponentType<Record<string, unknown>> }

export function PluginUiView(props: PluginUiViewProps): ReactNode {
  const { pluginId, spec, conversationId, composer, label } = props
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  const clientRef = spec.client
  if (clientRef === undefined) {
    return <MissingTrackError pluginId={pluginId} />
  }
  // 快照重建也会失效缓存，已挂载视图必须重载，不能继续显示旧组件或丢失样式。
  return <ClientPluginUiView key={JSON.stringify([pluginId, clientRef.module, clientRef.export, revision])} {...props} clientRef={clientRef} />
}

function ClientPluginUiView({ pluginId, clientRef, slotProps, conversationId, composer, label }: PluginUiViewProps & { clientRef: ClientComponentRef }): ReactNode {
  const store = useHelmStore()
  const [retry, setRetry] = useState(0)
  const [client, setClient] = useState<ClientState>(() => {
    const cached = getCachedClientComponent(pluginId, clientRef.module, clientRef.export)
    return cached !== undefined ? { phase: 'ready', Component: cached } : { phase: 'loading' }
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await loadPluginClientModule(pluginId, clientRef.module)
        const exported = requireClientExport(pluginId, clientRef.module, clientRef.export, loaded.module)
        if (typeof exported !== 'function') {
          throw new PluginClientError(
            'client_export_not_component',
            `插件 ${pluginId} 模块 ${clientRef.module} 导出 ${clientRef.export} 不是组件函数`,
            0,
          )
        }
        if (!cancelled) setClient({ phase: 'ready', Component: exported as ComponentType<Record<string, unknown>> })
      } catch (err) {
        if (!cancelled) {
          setClient({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, clientRef.module, clientRef.export, retry])

  if (client.phase === 'loading') {
    return (
      <div className="callout" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <HelmIcon name="loader" size={13} className="spin-slow" />
        <span>正在加载插件组件 {pluginId}...</span>
      </div>
    )
  }
  if (client.phase === 'error') {
    return (
      <div className="callout callout--error" role="alert">
        <HelmIcon name="alert-triangle" size={13} />
        <div>
          <strong>插件组件加载失败（{pluginId}）</strong>
          <p className="selectable">{client.message}</p>
          <button type="button" className="btn btn-sm" onClick={() => { setClient({ phase: 'loading' }); setRetry((value) => value + 1) }}>
            重试加载
          </button>
        </div>
      </div>
    )
  }

  const ctx = createPluginClientContext(store, pluginId, conversationId, composer)
  return (
    <ViewBoundary label={label ?? '插件组件'}>
      <PluginClientContext.Provider value={ctx}>
        <client.Component {...(slotProps ?? {})} />
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}

/** 未声明 client：显式契约错误（注册边界已拦截，防御渲染期）。 */
function MissingTrackError({ pluginId }: { pluginId: string }): ReactNode {
  return (
    <div className="callout callout--warning">
      <HelmIcon name="alert-triangle" size={13} />
      <span>插件 {pluginId} 的该扩展点未声明 client 组件引用。</span>
    </div>
  )
}
