import React, { useContext, useEffect, useMemo, useState } from 'react'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import { HelmIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@helm/plugin-client'
import { HelmStoreContext } from '../lib/store-context.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import {
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'

/**
 * 无过滤且未展开时最多渲染的模型胶囊数，避免海量目录一次性铺满抽屉。
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
 * 模型与凭证中心供应商详情、凭证配置抽屉：
 * - 基于 Radix UI Dialog 原语封装，540px 右侧滑出抽屉；
 * - 渲染 API 密钥安全输入、服务端点、动态目录刷新与单个模型路由开关；
 * - 凭据删除支持 ConfirmDialog 二次确认；
 * - 绝对零 Emoji 规范，遵循 Fast Refresh 与 WAI-ARIA 原语。
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
  const store = useContext(HelmStoreContext)
  const catalogModels = availableModels ?? store?.models ?? []

  // 常规供应商表单状态
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

  // 服务端点可编辑性：只有自定义网关（providers.json）的端点能在本界面真正
  // 持久化。插件网关（pluginId 存在，如 builtin:magpie）端点由所属插件的
  // 配置管理，内置供应商端点固定——一律只读展示，杜绝「可编辑却保存无效」
  // 的假入口（改了也改不回默认地址的根因）。
  const endpointEditable = provider?.custom === true
  const endpointHint =
    endpointEditable === true
      ? 'For reverse proxies, intranet forwarding endpoints or local inference services.'
      : provider?.pluginId
        ? `This endpoint is managed by the configuration of plugin ${provider.pluginId}; change it in that plugin configuration in the plugin center.`
        : 'This provider endpoint is built in and cannot be changed here.'

  // 当选中的供应商变化时同步本地表单状态
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

  // 计算已启用的模型 ID 与过滤列表
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

  // 无过滤且未展开时严格限制首帧数量；模型默认均为启用态，不能用 enabled 作为
  // “用户特别选择”的标记，否则 OpenRouter 初始目录仍会一次性渲染全部模型。
  // 搜索或显式展开后再显示完整结果。
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

  // 批量启停：无过滤词时作用于全量；有过滤词时仅作用于当前匹配结果，
  // 不影响搜索之外的模型，保存仍提交完整清单（由本地状态统一保存）。
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

  // 连通性测试
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
        if (res.errors?.[provider.id]) {
          setTestResult({
            success: false,
            latencyMs,
            message: `Connection failed: ${res.errors[provider.id]}`,
          })
        } else {
          setTestResult({
            success: true,
            latencyMs,
            message: 'Provider endpoint reachable and model catalog synced.',
          })
        }
      } else {
        const isKeyPresent = Boolean(apiKey.trim() || provider.configured)
        if (!isKeyPresent && provider.type === 'commercial') {
          setTestResult({
            success: false,
            message: 'No API key configured; enter the key before testing the connection.',
          })
        } else {
          setTestResult({
            success: true,
            message: 'Endpoint and credential format validated.',
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

  // 动态供应商刷新模型目录
  const handleRefreshCatalog = async () => {
    if (!provider) return
    setRefreshingCatalog(true)
    setSaveError(null)
    try {
      const res = await assetsApi.refreshModels([provider.id])
      if (store?.refreshAssets) {
        await store.refreshAssets()
      }
      const refreshError = res.errors?.[provider.id]
      if (refreshError) {
        setSaveError(refreshError)
      } else if (res.aborted) {
        setSaveError('Model catalog refresh was cancelled; retry.')
      } else {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2400)
        store?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: 'Model catalog refreshed',
          body: `${provider.name} re-synced the latest model catalog.`,
        })
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshingCatalog(false)
    }
  }

  // 真实删除密钥
  const handleDeleteCredential = async () => {
    if (!provider) return
    setDeleting(true)
    setSaveError(null)
    try {
      await assetsApi.deleteCredential(provider.id)
      setApiKey('')
      if (store?.refreshAssets) {
        await store.refreshAssets()
      }
      store?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: 'Secret deleted',
        body: `Local credentials of ${provider.name} removed successfully.`,
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

  // 保存常规供应商配置
  const handleSaveProvider = async () => {
    if (!provider) return
    // 自定义网关端点为 providers.json 必填字段：清空后保存显式拒绝，
    // 绝不静默保留旧值冒充保存成功。
    if (provider.custom === true && !baseUrl.trim()) {
      setSaveSuccess(false)
      setSaveError('The custom gateway endpoint cannot be empty.')
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
        if (store?.refreshAssets) {
          await store.refreshAssets()
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
            aria-label={provider ? `${provider.name} details and credentials` : 'Provider details and credentials'}
          >
            {/* Header metadata */}
            <div className="primary-drawer-header">
              <div className="primary-drawer-header-left">
                <div className="primary-drawer-title-col">
                  <div className="primary-drawer-title-row">
                    <DialogTitle className="primary-drawer-title break-word">
                      {provider?.name || 'Provider details'}
                    </DialogTitle>
                    {provider?.configured ? (
                      <span className="badge badge-ok">Configured</span>
                    ) : (
                      <span className="badge badge-neutral">Not configured</span>
                    )}
                    {provider?.dynamic && <span className="badge badge-neutral">Dynamic sync</span>}
                  </div>
                  <div className="text-subtle mono break-word">{provider?.id}</div>
                </div>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm"
                  aria-label="Close"
                  title="Close"
                >
                  <HelmIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>

            {/* Drawer body */}
            <div className="primary-drawer-body">
              {!provider ? (
                <div className="primary-center-empty">
                  <div className="primary-center-empty-text">No provider selected</div>
                </div>
              ) : (
                <>
                  {/* Credentials and connection settings */}
                  <div className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmIcon name="key" size={14} />
                        <span className="section-flat-title">Credentials and connection settings</span>
                      </div>
                      {provider.dynamic && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={handleRefreshCatalog}
                          disabled={refreshingCatalog}
                          title="Re-sync the dynamic model catalog of this provider"
                        >
                          <HelmIcon
                            name="refresh-cw"
                            size={12}
                            className={refreshingCatalog ? 'spin' : ''}
                          />
                          <span>{refreshingCatalog ? 'Refreshing...' : 'Refresh catalog'}</span>
                        </button>
                      )}
                    </div>
                    <div className="form-grid">
                      <label htmlFor="model-drawer-api-key" className="form-grid-label">
                        API key
                      </label>
                      <div className="flex-col-xs">
                        {provider.pluginId ? (
                          <>
                            <div className="form-grid-value" title="Plugin gateway key">
                              Managed by the configuration of plugin {provider.pluginId}
                            </div>
                            <span className="text-subtle">
                              This key is set in the plugin configuration in the plugin center, not stored in the kernel credential vault; filling it in here has no effect.
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
                                  ? 'Configured (leave empty to keep unchanged)'
                                  : 'Enter API key'
                              }
                              autoComplete="off"
                            />
                            <span className="text-subtle">
                              The secret is stored encrypted in the system secret stash and injected automatically by the kernel on calls; never exposed to the model.
                            </span>
                          </>
                        )}
                      </div>

                      <label htmlFor="model-drawer-base-url" className="form-grid-label">
                        Endpoint
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
                                : 'https://api.example.com/v1 (empty for default URL)')
                            }
                          />
                        ) : (
                          <div className="form-grid-value mono break-word" title="Read-only endpoint">
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
                        <HelmIcon name="activity" size={12} />
                        <span>{testing ? 'Testing connection...' : 'Test connection'}</span>
                      </button>

                      {provider.configured && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost text-err"
                          onClick={() => setDeleteConfirmOpen(true)}
                          disabled={deleting}
                        >
                          <HelmIcon name="trash" size={12} />
                          <span>Delete credentials</span>
                        </button>
                      )}
                    </div>

                    {testResult && (
                      <div
                        className={`callout ${testResult.success ? 'callout-ok' : 'callout-error'}`}
                        role={testResult.success ? 'status' : 'alert'}
                      >
                        <HelmIcon
                          name={testResult.success ? 'check' : 'alert-circle'}
                          size={13}
                        />
                        <span className="callout-text selectable">
                          {testResult.message}
                          {testResult.latencyMs !== undefined &&
                            `(latency ${testResult.latencyMs}ms)`}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Model list management (model chips interactions) */}
                  <div className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmIcon name="cpu" size={14} />
                        <span className="section-flat-title">Models and routing control</span>
                      </div>
                      <span className="badge badge-neutral mono tabular-nums">
                        {`${enabledModelIds.length} enabled / ${models.length} models in total`}
                      </span>
                    </div>

                    <p className="text-subtle">
                      Click a pill to toggle a model; disabled models are marked in the catalog and cannot be picked in conversations.
                    </p>

                    {models.length === 0 ? (
                      <div className="text-subtle">
                        {provider.dynamic
                          ? 'This dynamic provider can fetch available models via Refresh catalog above.'
                          : 'This provider has no preset models; the catalog syncs automatically after saving the endpoint.'}
                      </div>
                    ) : (
                      <div className="models model-chips-container">
                        {/* Action toolbar: filter search and bulk controls */}
                        <div className="mbulk model-chips-toolbar">
                          <div className="search-box flex-1">
                            <HelmIcon name="search" size={13} />
                            <input
                              type="text"
                              placeholder="Filter models..."
                              value={modelFilter}
                              onChange={(e) => setModelFilter(e.target.value)}
                              aria-label="Filter models"
                            />
                          </div>
                          <div className="model-chips-actions">
                            <button
                              type="button"
                              className="text action"
                              onClick={handleSelectAll}
                              title={hasModelFilter ? 'Enable models matching the current filter' : 'Enable all'}
                            >
                              {hasModelFilter
                                ? `Enable matches (${filteredModels.length})`
                                : 'Enable all'}
                            </button>
                            <button
                              type="button"
                              className="text action"
                              onClick={handleClearAll}
                              title={hasModelFilter ? 'Disable models matching the current filter' : 'Disable all'}
                            >
                              {hasModelFilter
                                ? `Disable matches (${filteredModels.length})`
                                : 'Disable all'}
                            </button>
                          </div>
                        </div>

                        {/* Flat pill cluster (frameless, airy white tiles) */}
                        <div
                          className={`mchips model-drawer-tags-wrap ${isExpanded ? 'open is-expanded' : ''}`}
                          role="group"
                          aria-label="Select enabled models"
                        >
                          {visibleModels.length === 0 ? (
                            <span className="text-subtle">
                              No matching models
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
                                  title={`${model.name} (${model.id}) - click to ${isChecked ? 'Disable' : 'Enable'}`}
                                >
                                  <span className="mchip-check" aria-hidden="true">
                                    <HelmIcon name="check" size={10} />
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
                            title={isExpanded ? 'Collapse list' : 'Expand all'}
                          >
                            <span>
                              {isExpanded
                                ? 'Collapse list'
                                : hiddenModelCount > 0
                                  ? `Expand all (${hiddenModelCount} hidden)`
                                  : 'Expand all'}
                            </span>
                            <HelmIcon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={12} />
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
                    Configuration saved
                  </span>
                )}
                {saveError && (
                  <div className="callout callout-error" role="alert">
                    <HelmIcon name="alert-circle" size={13} />
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
                <HelmIcon name="check" size={14} />
                <span>{saving ? 'Saving...' : 'Save configuration'}</span>
              </button>
            </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>

      {/* Delete credentials confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Confirm credential deletion"
        description={`Delete the local credentials of ${provider?.name ?? 'This provider'}? Conversations without another configured key will lose access to this provider.`}
        confirmText="Confirm deletion"
        cancelText="Cancel"
        danger
        inline={inline}
        onConfirm={handleDeleteCredential}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  )
}
