/**
 * PluginUiView: the unified wrapper for every view-like UI extension point
 * (pure data registrations never pass through this component).
 * - Dynamic compiled client module loading / export validation errors render
 *   explicitly (never a silent blank); ViewBoundary isolates render crashes;
 * - injects PluginClientContext (usePluginContext) plus the protocol-standard
 *   props;
 * - component-function validation: a non-function export fails explicitly.
 * Display copy (loading / failed / retry) resolves from the active locale;
 * loader-thrown error text stays English execution copy.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { ClientComponentRef, ComposerController } from '@helm/protocol/browser'
import { HelmIcon, createPluginClientContext, PluginClientContext, usePluginClientHost, ViewBoundary } from '@helm/plugin-client'
import { getCachedClientComponent, getPluginClientCacheRevision, loadPluginClientModule, PluginClientError, requireClientExport, subscribePluginClientCacheInvalidation } from '../lib/plugin-client.js'
import { usePlugins } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface PluginUiViewProps {
  pluginId: string
  /** client.tsx component reference (dangling refs are rejected at the registration boundary; a missing one is a contract violation and fails explicitly). */
  spec: { client?: ClientComponentRef }
  /** Protocol-standard props (screenId / entry / toolView / conversation, etc.). */
  slotProps?: Record<string, unknown>
  /** Conversation context id (omitted for conversation-less slots). */
  conversationId?: number
  /** Composer controller (provided by the host for composer slots only). */
  composer?: ComposerController
  /** ViewBoundary error title. */
  label?: string
}

type ClientState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; Component: ComponentType<Record<string, unknown>> }

export function PluginUiView(props: PluginUiViewProps): ReactNode {
  const { pluginId, spec } = props
  const plugins = usePlugins()
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  const clientRef = spec.client
  if (clientRef === undefined) {
    return <MissingTrackError pluginId={pluginId} />
  }
  const plugin = plugins.find((p) => p.id === pluginId)
  const expectedHash =
    plugin !== undefined && plugin.enabled && (plugin.status === undefined || plugin.status === 'active')
      ? plugin.clientHashes?.[clientRef.module]
      : undefined
  // Snapshot rebuilds / per-plugin reconciliation invalidate the cache too:
  // mounted views must reload instead of keeping the old component (or losing its styles).
  return (
    <ClientPluginUiView
      key={JSON.stringify([pluginId, clientRef.module, clientRef.export, revision])}
      {...props}
      clientRef={clientRef}
      expectedHash={expectedHash}
    />
  )
}

function ClientPluginUiView({
  pluginId,
  clientRef,
  expectedHash,
  slotProps,
  conversationId,
  composer,
  label,
}: PluginUiViewProps & { clientRef: ClientComponentRef; expectedHash?: string }): ReactNode {
  const { t } = useWebLocale()
  const port = usePluginClientHost()
  const [retry, setRetry] = useState(0)
  const [client, setClient] = useState<ClientState>(() => {
    const cached = getCachedClientComponent(pluginId, clientRef.module, clientRef.export, expectedHash)
    return cached !== undefined ? { phase: 'ready', Component: cached } : { phase: 'loading' }
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
          const Component = exported as ComponentType<Record<string, unknown>>
          setClient((prev) => (prev.phase === 'ready' && prev.Component === Component ? prev : { phase: 'ready', Component }))
        }
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
  }, [pluginId, clientRef.module, clientRef.export, expectedHash, retry])

  if (client.phase === 'loading') {
    return (
      <div className="callout" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <HelmIcon name="loader" size={13} className="spin-slow" />
        <span>{t('ui.pluginUi.loading', { pluginId })}</span>
      </div>
    )
  }
  if (client.phase === 'error') {
    return (
      <div className="callout callout--error" role="alert">
        <HelmIcon name="alert-triangle" size={13} />
        <div>
          <strong>{t('ui.pluginUi.loadFailedTitle', { pluginId })}</strong>
          <p className="selectable">{client.message}</p>
          <button type="button" className="btn btn-sm" onClick={() => { setClient({ phase: 'loading' }); setRetry((value) => value + 1) }}>
            {t('ui.pluginUi.retry')}
          </button>
        </div>
      </div>
    )
  }

  const ctx = createPluginClientContext(port, pluginId, conversationId, composer)
  return (
    <ViewBoundary label={label ?? t('ui.pluginUi.boundaryLabel')}>
      <PluginClientContext.Provider value={ctx}>
        <client.Component {...(slotProps ?? {})} />
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}

/** Missing client declaration: explicit contract error (registration boundary already rejects it; this is render-time defense). */
function MissingTrackError({ pluginId }: { pluginId: string }): ReactNode {
  const { t } = useWebLocale()
  return (
    <div className="callout callout--warning">
      <HelmIcon name="alert-triangle" size={13} />
      <span>{t('ui.pluginUi.missingClient', { pluginId })}</span>
    </div>
  )
}
