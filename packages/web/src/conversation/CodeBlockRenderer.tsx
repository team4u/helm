/**
 * Markdown 代码块扩展分派器（宿主机制，零业务特判）：
 * - 有插件注册命中当前语言（priority 裁决）→ 动态加载其 client 组件渲染
 *   （loading / 加载失败 / 渲染异常均显式展示并可复制源码，绝不静默空白）；
 * - 无命中（含插件停用后贡献消失）→ 回退宿主普通代码块；
 * - 不 import 任何具体语言实现（JSON / Mermaid 均为插件）。
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ComponentType } from 'react'
import type { MarkdownCodeBlockProps } from '@helmx/protocol/browser'
import { CopyButton, createPluginClientContext, HelmxIcon, PluginClientContext, usePluginClientHost, ViewBoundary } from '@helmx/plugin-client'
import { usePluginsUi } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  getCachedClientComponent,
  getPluginClientCacheRevision,
  loadPluginClientModule,
  PluginClientError,
  requireClientExport,
  subscribePluginClientCacheInvalidation,
} from '../lib/plugin-client.js'
import { matchMarkdownCodeBlock } from './codeblock-registry-model.js'
import { StandardCodeBlock } from './StandardCodeBlock.js'

type ClientState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; Component: ComponentType<MarkdownCodeBlockProps> }

function CodeBlockError({ language, code, message, onRetry }: { language: string; code: string; message: string; onRetry: () => void }): ReactNode {
  const { t } = useWebLocale()
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language}</span>
        <CopyButton text={code} />
      </div>
      <div className="callout callout--error" role="alert">
        <HelmxIcon name="alert-triangle" size={13} />
        <div>
          <strong>{t('conv.codeblock.renderFailed')}</strong>
          <p className="selectable">{message}</p>
          <button type="button" className="btn btn-sm" onClick={onRetry}>{t('conv.codeblock.retryLoading')}</button>
        </div>
      </div>
      <pre className="code-block-pre code-block-pre-flush selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function CodeBlockRenderer({ language, code, conversationId }: { language: string; code: string; conversationId?: number }): ReactNode {
  const { uiContributions, plugins } = usePluginsUi()
  const match = matchMarkdownCodeBlock(uiContributions, language)

  if (match === null || match.spec.client === undefined) {
    return <StandardCodeBlock language={language} code={code} />
  }
  const plugin = plugins.find((p) => p.id === match.pluginId)
  const expectedHash =
    plugin !== undefined && plugin.enabled && (plugin.status === undefined || plugin.status === 'active')
      ? plugin.clientHashes?.[match.spec.client.module]
      : undefined
  return (
    <PluginCodeBlock
      key={`${match.pluginId}:${match.spec.id}:${language}:${getPluginClientCacheRevision(match.pluginId)}`}
      pluginId={match.pluginId}
      clientRef={match.spec.client}
      expectedHash={expectedHash}
      language={language}
      code={code}
      conversationId={conversationId}
    />
  )
}

function PluginCodeBlock(props: {
  pluginId: string
  clientRef: { module: string; export: string }
  expectedHash?: string
  language: string
  code: string
  conversationId?: number
}): ReactNode {
  const { pluginId, clientRef, expectedHash, language, code, conversationId } = props
  const port = usePluginClientHost()
  const { t } = useWebLocale()
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  const [retry, setRetry] = useState(0)
  const [client, setClient] = useState<ClientState>(() => {
    const cached = getCachedClientComponent(pluginId, clientRef.module, clientRef.export, expectedHash)
    return cached !== undefined ? { phase: 'ready', Component: cached as unknown as ComponentType<MarkdownCodeBlockProps> } : { phase: 'loading' }
  })

  useEffect(() => {
    let cancelled = false
    if (getCachedClientComponent(pluginId, clientRef.module, clientRef.export, expectedHash) === undefined) {
      setClient((prev) => (prev.phase === 'loading' ? prev : { phase: 'loading' }))
    }
    void (async () => {
      try {
        const loaded = await loadPluginClientModule(pluginId, clientRef.module, expectedHash)
        const exported = requireClientExport(pluginId, clientRef.module, clientRef.export, loaded.module)
        if (typeof exported !== 'function') {
          throw new PluginClientError(
            'client_export_not_component',
            `Plugin ${pluginId} module ${clientRef.module} export ${clientRef.export} is not a component function`,
            0,
          )
        }
        if (!cancelled) {
          const Component = exported as unknown as ComponentType<MarkdownCodeBlockProps>
          setClient((prev) => (prev.phase === 'ready' && prev.Component === Component ? prev : { phase: 'ready', Component }))
        }
      } catch (err) {
        if (!cancelled) {
          setClient({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, clientRef.module, clientRef.export, expectedHash, retry, revision])

  if (client.phase === 'loading') {
    return (
      <div className="code-block-wrap">
        <div className="code-block-header">
          <span>{language}</span>
        </div>
        <div className="callout" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <HelmxIcon name="loader" size={13} className="spin-slow" />
          <span>{t('conv.codeblock.loadingRenderer', { language })}</span>
        </div>
      </div>
    )
  }
  if (client.phase === 'error') {
    return (
      <CodeBlockError
        language={language}
        code={code}
        message={client.message}
        onRetry={() => {
          setClient({ phase: 'loading' })
          setRetry((value) => value + 1)
        }}
      />
    )
  }

  const { Component } = client
  const ctx = createPluginClientContext(port, pluginId, conversationId)
  return (
    <ViewBoundary label={t('conv.codeblock.viewBoundary', { language })}>
      <PluginClientContext.Provider value={ctx}>
        <Component language={language} code={code} conversationId={conversationId} />
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}
