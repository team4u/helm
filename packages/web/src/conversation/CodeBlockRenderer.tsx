/**
 * Markdown 代码块扩展分派器（宿主机制，零业务特判）：
 * - 有插件注册命中当前语言（priority 裁决）→ 动态加载其 client 组件渲染
 *   （loading / 加载失败 / 渲染异常均显式展示并可复制源码，绝不静默空白）；
 * - 无命中（含插件停用后贡献消失）→ 回退宿主普通代码块；
 * - 不 import 任何具体语言实现（JSON / Mermaid 均为插件）。
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ComponentType } from 'react'
import type { MarkdownCodeBlockProps } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
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
import { CopyButton } from './CopyButton.js'
import { ViewBoundary } from '../ui/ViewBoundary.js'
import { createPluginClientContext, PluginClientContext } from '../lib/plugin-client-context.js'

type ClientState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; Component: ComponentType<MarkdownCodeBlockProps> }

function CodeBlockError({ language, code, message, onRetry }: { language: string; code: string; message: string; onRetry: () => void }): ReactNode {
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language}</span>
        <CopyButton text={code} />
      </div>
      <div className="callout callout--error" role="alert">
        <HelmIcon name="alert-triangle" size={13} />
        <div>
          <strong>代码块扩展渲染失败</strong>
          <p className="selectable">{message}</p>
          <button type="button" className="btn btn-sm" onClick={onRetry}>重试加载</button>
        </div>
      </div>
      <pre className="code-block-pre code-block-pre-flush selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function CodeBlockRenderer({ language, code, conversationId }: { language: string; code: string; conversationId?: number }): ReactNode {
  const { uiContributions } = useHelmStore()
  const match = matchMarkdownCodeBlock(uiContributions, language)

  if (match === null || match.spec.client === undefined) {
    return <StandardCodeBlock language={language} code={code} />
  }
  return (
    <PluginCodeBlock
      key={`${match.pluginId}:${match.spec.id}:${language}:${getPluginClientCacheRevision(match.pluginId)}`}
      pluginId={match.pluginId}
      clientRef={match.spec.client}
      language={language}
      code={code}
      conversationId={conversationId}
    />
  )
}

function PluginCodeBlock(props: {
  pluginId: string
  clientRef: { module: string; export: string }
  language: string
  code: string
  conversationId?: number
}): ReactNode {
  const { pluginId, clientRef, language, code, conversationId } = props
  const store = useHelmStore()
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  const [retry, setRetry] = useState(0)
  const [client, setClient] = useState<ClientState>(() => {
    const cached = getCachedClientComponent(pluginId, clientRef.module, clientRef.export)
    return cached !== undefined ? { phase: 'ready', Component: cached as unknown as ComponentType<MarkdownCodeBlockProps> } : { phase: 'loading' }
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
        if (!cancelled) setClient({ phase: 'ready', Component: exported as unknown as ComponentType<MarkdownCodeBlockProps> })
      } catch (err) {
        if (!cancelled) {
          setClient({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, clientRef.module, clientRef.export, retry, revision])

  if (client.phase === 'loading') {
    return (
      <div className="code-block-wrap">
        <div className="code-block-header">
          <span>{language}</span>
        </div>
        <div className="callout" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <HelmIcon name="loader" size={13} className="spin-slow" />
          <span>正在加载 {language} 渲染组件...</span>
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
  const ctx = createPluginClientContext(store, pluginId, conversationId)
  return (
    <ViewBoundary label={`${language} 渲染`}>
      <PluginClientContext.Provider value={ctx}>
        <Component language={language} code={code} conversationId={conversationId} />
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}
