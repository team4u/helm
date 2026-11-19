import React, { useEffect, useMemo, useState } from 'react'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import { HelmxIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@helmx/plugin-client'
import { useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import {
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'

/**
 * Maximum number of model pills rendered without a filter and before
 * expanding, so huge catalogs never flood the drawer in one frame.
 */
const CHIP_RENDER_LIMIT = 80

export interface ModelDetailDrawerProps {
  provider: ProviderItem | null
  open: boolean
  onClose: () => void
  inline?: boolean
  availableModels?: ModelDescriptor[]
  onSave?: (
    providerId: string,
    data: { apiKey?: string; baseUrl?: string; models?: ProviderModelItem[] },
  ) => Promise<void> | void
  onTestConnection?: (
    providerId: string,
    baseUrl?: string,
  ) => Promise<{ success: boolean; latencyMs?: number; message?: string }>
}

/**
 * Provider details & credentials drawer of the Models & Credentials Center:
 * - built on Radix UI Dialog primitives as a 540px right slide-over;
 * - renders the API-key secure input, service endpoint, dynamic catalog
 *   refresh and per-model routing toggles;
 * - credential deletion is guarded by a ConfirmDialog second confirmation;
 * - strictly zero Emoji; follows Fast Refresh and WAI-ARIA primitives.
 */
export function ModelDetailDrawer({
  provider,
  open,
  onClose,
  inline = false,
  availableModels,
  onSave,
  onTestConnection,
}: ModelDetailDrawerProps): React.JSX.Element {
  const storeModels = useOptionalModels()
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const catalogModels = availableModels ?? storeModels ?? []

  // Regular provider form state
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(() => provider?.baseUrl ?? '')
  const [models, setModels] = useState<ProviderModelItem[]>(() =>
    provider?.models ? provider.models.map((m) => ({ ...m })) : [],
  )
  const [testing, setTesting] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    latencyMs?: number
    message?: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)

  // Endpoint editability: only custom gateway (providers.json) endpoints can
  // actually be persisted from this UI. Plugin gateway endpoints (pluginId
  // set, e.g. builtin:magpie) are owned by the plugin configuration, and
  // built-in provider endpoints are fixed — both render read-only, so there
  // is never an editable-looking input whose save silently does nothing (the
  // root cause of endpoints bouncing back to the default address).
  const endpointEditable = provider?.custom === true
  const endpointHint =
    endpointEditable === true
      ? t('models.endpoint.hintCustom')
      : provider?.pluginId
        ? t('models.endpoint.hintPlugin', { pluginId: provider.pluginId })
        : t('models.endpoint.hintBuiltIn')

  // Sync local form state whenever the selected provider changes
  useEffect(() => {
    if (provider) {
      setApiKey('')
      setBaseUrl(provider.baseUrl ?? '')
      setModels(provider.models ? provider.models.map((m) => ({ ...m })) : [])
      setTestResult(null)
      setSaveError(null)
      setSaveSuccess(false)
      setModelFilter('')
      setIsExpanded(false)
    } else {
      setApiKey('')
      setBaseUrl('')
      setModels([])
      setTestResult(null)
      setSaveError(null)
      setSaveSuccess(false)
      setModelFilter('')
      setIsExpanded(false)
    }
  }, [provider])

  // Enabled model ids and the filtered list
  const enabledModelIds = useMemo(
    () => models.filter((m) => m.enabled).map((m) => m.id),
    [models],
  )

  const filteredModels = useMemo(() => {
    if (!modelFilter.trim()) return models
    const q = modelFilter.trim().toLowerCase()
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }, [models, modelFilter])

  const hasModelFilter = modelFilter.trim() !== ''

  // Hard-limit the first frame without a filter and before expanding; models
  // default to enabled, so `enabled` cannot mark "user-picked" — otherwise an
  // OpenRouter initial catalog would still render every model at once. Search
  // or explicit expansion reveals the full list.
  const visibleModels = useMemo(() => {
    if (hasModelFilter || isExpanded) return filteredModels
    return filteredModels.slice(0, CHIP_RENDER_LIMIT)
  }, [filteredModels, hasModelFilter, isExpanded])

  const hiddenModelCount = filteredModels.length - visibleModels.length

  const handleToggleModel = (modelId: string) => {
    setModels((prev) =>
      prev.map((item) =>
        item.id === modelId ? { ...item, enabled: !item.enabled } : item,
      ),
    )
  }

  // Bulk enable/disable: with no filter term it applies to the full list; with
  // a filter term it applies only to the current matches, never touching
  // models outside the search. Saving always submits the complete list (the
  // local state is saved as a whole).
  const handleSelectAll = () => {
    const matchedIds = hasModelFilter ? new Set(filteredModels.map((m) => m.id)) : null
    setModels((prev) =>
      prev.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: true } : item,
      ),
    )
  }

  const handleClearAll = () => {
    const matchedIds = hasModelFilter ? new Set(filteredModels.map((m) => m.id)) : null
    setModels((prev) =>
      prev.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: false } : item,
      ),
    )
  }

  // Connectivity test
  const handleTest = async () => {
    if (!provider) return
    setTesting(true)
    setTestResult(null)
    setSaveError(null)
    try {
      if (onTestConnection) {
        const res = await onTestConnection(provider.id, baseUrl.trim() || undefined)
        setTestResult(res)
      } else if (provider.dynamic) {
        const start = Date.now()
        const res = await assetsApi.refreshModels([provider.id])
        const latencyMs = Date.now() - start
        const refreshError = res.errors?.[provider.id]
        if (refreshError) {
          setTestResult({
            success: false,
            latencyMs,
            message: t('models.test.failed', { error: refreshError }),
          })
        } else {
          setTestResult({
            success: true,
            latencyMs,
            message: t('models.test.ok'),
          })
        }
      } else {
        const isKeyPresent = Boolean(apiKey.trim() || provider.configured)
        if (!isKeyPresent && provider.type === 'commercial') {
          setTestResult({
            success: false,
            message: t('models.test.noKey'),
          })
        } else {
          setTestResult({
            success: true,
            message: t('models.test.validated'),
          })
        }
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }

  // Refresh the model catalog of a dynamic provider
  const handleRefreshCatalog = async () => {
    if (!provider) return
    setRefreshingCatalog(true)
    setSaveError(null)
    try {
      const res = await assetsApi.refreshModels([provider.id])
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      const refreshError = res.errors?.[provider.id]
      if (refreshError) {
        setSaveError(refreshError)
      } else if (res.aborted) {
        setSaveError(t('models.refresh.cancelled'))
      } else {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2400)
        actions?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: t('models.notice.catalogRefreshed'),
          body: t('models.notice.catalogResynced', { name: provider.name }),
        })
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshingCatalog(false)
    }
  }

  // Really delete the stored key
  const handleDeleteCredential = async () => {
    if (!provider) return
    setDeleting(true)
    setSaveError(null)
    try {
      await assetsApi.deleteCredential(provider.id)
      setApiKey('')
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.secretDeleted'),
        body: t('models.notice.secretDeletedBody', { name: provider.name }),
      })
      setDeleteConfirmOpen(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2400)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  // Save the regular provider configuration
  const handleSaveProvider = async () => {
    if (!provider) return
    // The custom gateway endpoint is a required providers.json field: saving
    // an empty value is explicitly rejected — never silently keep the old
    // value and pretend the save succeeded.
    if (provider.custom === true && !baseUrl.trim()) {
      setSaveSuccess(false)
      setSaveError(t('models.errors.customGatewayEndpointEmpty'))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      if (onSave) {
        await onSave(provider.id, {
          apiKey: apiKey.trim() ? apiKey.trim() : undefined,
          baseUrl: baseUrl.trim() ? baseUrl.trim() : undefined,
          models,
        })
      } else if (apiKey.trim()) {
        await assetsApi.setCredential(provider.id, apiKey.trim())
        if (actions?.refreshAssets) {
          await actions.refreshAssets()
        }
      }
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2400)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        inline={inline}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose()
        }}
      >
        <DialogPortal inline={inline}>
          <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
          <DialogContent
            className="primary-drawer-content"
            role="dialog"
            aria-label={
              provider
                ? t('models.drawer.ariaSelected', { name: provider.name })
                : t('models.drawer.ariaDefault')
            }
          >
            {/* Header metadata */}
            <div className="primary-drawer-header">
              <div className="primary-drawer-header-left">
                <div className="primary-drawer-title-col">
                  <div className="primary-drawer-title-row">
                    <DialogTitle className="primary-drawer-title break-word">
                      {provider?.name || t('models.drawer.titleFallback')}
                    </DialogTitle>
                    {provider?.configured ? (
                      <span className="badge badge-ok">{t('models.configured')}</span>
                    ) : (
                      <span className="badge badge-neutral">{t('models.notConfigured')}</span>
                    )}
                    {provider?.dynamic && <span className="badge badge-neutral">{t('models.dynamicSyncBadge')}</span>}
                  </div>
                  <div className="text-subtle mono break-word">{provider?.id}</div>
                </div>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                >
                  <HelmxIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>

            {/* Drawer body */}
            <div className="primary-drawer-body">
              {!provider ? (
                <div className="primary-center-empty">
                  <div className="primary-center-empty-text">{t('models.drawer.noSelection')}</div>
                </div>
              ) : (
                <>
                  {/* Credentials and connection settings */}
                  <div className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmxIcon name="key" size={14} />
                        <span className="section-flat-title">{t('models.drawer.credentialsSection')}</span>
                      </div>
                      {provider.dynamic && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={handleRefreshCatalog}
                          disabled={refreshingCatalog}
                          title={t('models.drawer.resyncTitle')}
                        >
                          <HelmxIcon
                            name="refresh-cw"
                            size={12}
                            className={refreshingCatalog ? 'spin' : ''}
                          />
                          <span>{refreshingCatalog ? t('models.refreshing') : t('models.refreshCatalog')}</span>
                        </button>
                      )}
                    </div>
                    <div className="form-grid">
                      <label htmlFor="model-drawer-api-key" className="form-grid-label">
                        {t('models.apiKey')}
                      </label>
                      <div className="flex-col-xs">
                        {provider.pluginId ? (
                          <>
                            <div className="form-grid-value" title={t('models.apiKey.pluginKeyTitle')}>
                              {t('models.apiKey.pluginManaged', { pluginId: provider.pluginId })}
                            </div>
                            <span className="text-subtle">
                              {t('models.apiKey.pluginManagedHint')}
                            </span>
                          </>
                        ) : (
                          <>
                            <input
                              id="model-drawer-api-key"
                              type="password"
                              className="input"
                              value={apiKey}
                              onChange={(e) => setApiKey(e.target.value)}
                              placeholder={
                                provider.configured
                                  ? t('models.apiKey.placeholderConfigured')
                                  : t('models.apiKey.placeholderEnter')
                              }
                              autoComplete="off"
                            />
                            <span className="text-subtle">
                              {t('models.apiKey.secretHint')}
                            </span>
                          </>
                        )}
                      </div>

                      <label htmlFor="model-drawer-base-url" className="form-grid-label">
                        {t('models.endpoint')}
                      </label>
                      <div className="flex-col-xs">
                        {endpointEditable ? (
                          <input
                            id="model-drawer-base-url"
                            type="text"
                            className="input mono"
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            placeholder={
                              provider.baseUrl ||
                              (provider.type === 'local'
                                ? 'http://127.0.0.1:11434'
                                : t('models.endpoint.defaultUrlPlaceholder'))
                            }
                          />
                        ) : (
                          <div className="form-grid-value mono break-word" title={t('models.endpoint.readOnlyTitle')}>
                            {provider.baseUrl || '—'}
                          </div>
                        )}
                        <span className="text-subtle">{endpointHint}</span>
                      </div>
                    </div>

                    {/* Connectivity test and secret deletion */}
                    <div className="flex-row-between flex-row-wrap">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handleTest}
                        disabled={testing}
                      >
                        <HelmxIcon name="activity" size={12} />
                        <span>{testing ? t('models.test.testing') : t('models.test.action')}</span>
                      </button>

                      {provider.configured && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost text-err"
                          onClick={() => setDeleteConfirmOpen(true)}
                          disabled={deleting}
                        >
                          <HelmxIcon name="trash" size={12} />
                          <span>{t('models.credentials.delete')}</span>
                        </button>
                      )}
                    </div>

                    {testResult && (
                      <div
                        className={`callout ${testResult.success ? 'callout-ok' : 'callout-error'}`}
                        role={testResult.success ? 'status' : 'alert'}
                      >
                        <HelmxIcon
                          name={testResult.success ? 'check' : 'alert-circle'}
                          size={13}
                        />
                        <span className="callout-text selectable">
                          {testResult.message}
                          {testResult.latencyMs !== undefined &&
                            t('models.test.latency', { ms: testResult.latencyMs })}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Model list management (model chips interactions) */}
                  <div className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmxIcon name="cpu" size={14} />
                        <span className="section-flat-title">{t('models.models.section')}</span>
                      </div>
                      <span className="badge badge-neutral mono tabular-nums">
                        {t('models.models.countBadge', {
                          enabled: enabledModelIds.length,
                          total: models.length,
                        })}
                      </span>
                    </div>

                    <p className="text-subtle">
                      {t('models.models.hint')}
                    </p>

                    {models.length === 0 ? (
                      <div className="text-subtle">
                        {provider.dynamic
                          ? t('models.models.emptyDynamic')
                          : t('models.models.emptyStatic')}
                      </div>
                    ) : (
                      <div className="models model-chips-container">
                        {/* Action toolbar: filter search and bulk controls */}
                        <div className="mbulk model-chips-toolbar">
                          <div className="search-box flex-1">
                            <HelmxIcon name="search" size={13} />
                            <input
                              type="text"
                              placeholder={t('models.models.filterPlaceholder')}
                              value={modelFilter}
                              onChange={(e) => setModelFilter(e.target.value)}
                              aria-label={t('models.models.filterAria')}
                            />
                          </div>
                          <div className="model-chips-actions">
                            <button
                              type="button"
                              className="text action"
                              onClick={handleSelectAll}
                              title={hasModelFilter ? t('models.models.enableMatchesTitle') : t('models.models.enableAll')}
                            >
                              {hasModelFilter
                                ? t('models.models.enableMatches', { count: filteredModels.length })
                                : t('models.models.enableAll')}
                            </button>
                            <button
                              type="button"
                              className="text action"
                              onClick={handleClearAll}
                              title={hasModelFilter ? t('models.models.disableMatchesTitle') : t('models.models.disableAll')}
                            >
                              {hasModelFilter
                                ? t('models.models.disableMatches', { count: filteredModels.length })
                                : t('models.models.disableAll')}
                            </button>
                          </div>
                        </div>

                        {/* Flat pill cluster (frameless, airy white tiles) */}
                        <div
                          className={`mchips model-drawer-tags-wrap ${isExpanded ? 'open is-expanded' : ''}`}
                          role="group"
                          aria-label={t('models.models.selectAria')}
                        >
                          {visibleModels.length === 0 ? (
                            <span className="text-subtle">
                              {t('models.models.noMatches')}
                            </span>
                          ) : (
                            visibleModels.map((model) => {
                              const isChecked = Boolean(model.enabled)
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  role="checkbox"
                                  aria-checked={isChecked}
                                  className={`mchip pick model-drawer-tag ${isChecked ? 'on active' : ''}`}
                                  onClick={() => handleToggleModel(model.id)}
                                  title={t(
                                    isChecked
                                      ? 'models.models.chipTitleDisable'
                                      : 'models.models.chipTitleEnable',
                                    { name: model.name, id: model.id },
                                  )}
                                >
                                  <span className="mchip-check" aria-hidden="true">
                                    <HelmxIcon name="check" size={10} />
                                  </span>
                                  <span>{model.name}</span>
                                  {model.tags?.map((tag) => (
                                    <span key={tag} className="badge mi-effort mchip-tag mtell">
                                      {tag}
                                    </span>
                                  ))}
                                </button>
                              )
                            })
                          )}
                        </div>

                        {/* Expand/collapse full-width button */}
                        {models.length > 12 && (
                          <button
                            type="button"
                            className="mchips-fold"
                            onClick={() => setIsExpanded((prev) => !prev)}
                            aria-expanded={isExpanded}
                            title={isExpanded ? t('models.models.collapseList') : t('models.models.expandAll')}
                          >
                            <span>
                              {isExpanded
                                ? t('models.models.collapseList')
                                : hiddenModelCount > 0
                                  ? t('models.models.expandAllHidden', { count: hiddenModelCount })
                                  : t('models.models.expandAll')}
                            </span>
                            <HelmxIcon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={12} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Drawer footer actions */}
            <div className="primary-drawer-footer flex-row-between">
              <div className="flex-1">
                {saveSuccess && (
                  <span className="text-subtle" role="status">
                    {t('models.saveSuccess')}
                  </span>
                )}
                {saveError && (
                  <div className="callout callout-error" role="alert">
                    <HelmxIcon name="alert-circle" size={13} />
                    <span className="callout-text">{saveError}</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSaveProvider}
                disabled={saving || !provider}
              >
                <HelmxIcon name="check" size={14} />
                <span>{saving ? t('models.saving') : t('models.saveConfig')}</span>
              </button>
            </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>

      {/* Delete credentials confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('models.confirm.title')}
        description={t('models.confirm.body', {
          name: provider?.name ?? t('models.confirm.thisProvider'),
        })}
        confirmText={t('models.confirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={handleDeleteCredential}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  )
}
