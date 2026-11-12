import React, { useContext, useEffect, useMemo, useState } from 'react'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { HelmStoreContext } from '../lib/store-context.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import {
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'

/**
 * 无过滤且未展开时最多渲染的模型胶囊数（首帧 DOM 上限）。
 * 启用中的模型无论排序位置一律保留，避免 OpenRouter 数百模型一次性铺满抽屉。
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

  // 轻量截断：无过滤且未展开时只渲染前 CHIP_RENDER_LIMIT 个胶囊，启用中的模型
  // 无论排序位置都追加保留；有过滤词（便于搜索定位）或已展开时完整渲染。
  const visibleModels = useMemo(() => {
    if (hasModelFilter || isExpanded) return filteredModels
    if (filteredModels.length <= CHIP_RENDER_LIMIT) return filteredModels
    const head = filteredModels.slice(0, CHIP_RENDER_LIMIT)
    const headIds = new Set(head.map((m) => m.id))
    const enabledTail = filteredModels.filter((m) => m.enabled && !headIds.has(m.id))
    return enabledTail.length > 0 ? [...head, ...enabledTail] : head
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
            message: `连接失败: ${res.errors[provider.id]}`,
          })
        } else {
          setTestResult({
            success: true,
            latencyMs,
            message: '供应商端点连通正常，模型目录同步成功。',
          })
        }
      } else {
        const isKeyPresent = Boolean(apiKey.trim() || provider.configured)
        if (!isKeyPresent && provider.type === 'commercial') {
          setTestResult({
            success: false,
            message: '未配置 API 密钥，请先输入密钥后再测试连接。',
          })
        } else {
          setTestResult({
            success: true,
            message: '端点与凭证格式校验正常。',
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
        setSaveError('模型目录刷新已取消，请重试。')
      } else {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2400)
        store?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: '模型目录已刷新',
          body: `${provider.name} 已重新同步最新模型目录。`,
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
        title: '密钥已删除',
        body: `${provider.name} 的本地凭证已成功移除。`,
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
            aria-label={provider ? `${provider.name} 详情与凭证设置` : '供应商详情与凭证设置'}
          >
            {/* 头部元信息 */}
            <div className="primary-drawer-header">
              <div className="primary-drawer-header-left">
                <div className="primary-drawer-title-col">
                  <div className="primary-drawer-title-row">
                    <DialogTitle className="primary-drawer-title">
                      {provider?.name || '供应商详情'}
                    </DialogTitle>
                    {provider?.configured ? (
                      <span className="badge badge-ok">已配置</span>
                    ) : (
                      <span className="badge badge-neutral">未配置</span>
                    )}
                    {provider?.dynamic && <span className="badge badge-neutral">动态同步</span>}
                  </div>
                  <div className="text-xs text-subtle mono">{provider?.id}</div>
                </div>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="关闭"
                  title="关闭"
                >
                  <HelmIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>

            {/* 抽屉主体 */}
            <div className="primary-drawer-body">
              {!provider ? (
                <div className="primary-center-empty">
                  <div className="primary-center-empty-text">未选择供应商</div>
                </div>
              ) : (
                <>
                  {/* 凭证与连接设置 */}
                  <div className="section-flat">
                    <div
                      className="section-flat-header"
                      style={{ justifyContent: 'space-between' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HelmIcon name="key" size={14} />
                        <span className="section-flat-title">凭证与连接设置</span>
                      </div>
                      {provider.dynamic && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={handleRefreshCatalog}
                          disabled={refreshingCatalog}
                          title="重新同步该供应商的动态模型目录"
                        >
                          <HelmIcon
                            name="refresh-cw"
                            size={12}
                            className={refreshingCatalog ? 'spin' : ''}
                          />
                          <span>{refreshingCatalog ? '刷新中...' : '刷新目录'}</span>
                        </button>
                      )}
                    </div>
                    <div className="form-grid">
                      <label htmlFor="model-drawer-api-key" className="form-grid-label">
                        API 密钥
                      </label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <input
                          id="model-drawer-api-key"
                          type="password"
                          className="input"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder={
                            provider.configured
                              ? '已配置（留空保持不变）'
                              : '请输入 API 密钥'
                          }
                          autoComplete="off"
                        />
                        <span className="text-xs text-subtle">
                          密钥密文将安全存储于系统保密箱中，调用时由内核自动注入，不向模型泄露。
                        </span>
                      </div>

                      <label htmlFor="model-drawer-base-url" className="form-grid-label">
                        服务端点
                      </label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                              : 'https://api.example.com/v1（留空使用默认地址）')
                          }
                        />
                        <span className="text-xs text-subtle">
                          用于反向代理、内网转发端点或本地推理服务接口。
                        </span>
                      </div>
                    </div>

                    {/* 连通性测试与删除密钥 */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        marginTop: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handleTest}
                        disabled={testing}
                      >
                        <HelmIcon name="activity" size={12} />
                        <span>{testing ? '正在测试连接...' : '测试连接'}</span>
                      </button>

                      {provider.configured && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost text-danger"
                          onClick={() => setDeleteConfirmOpen(true)}
                          disabled={deleting}
                        >
                          <HelmIcon name="trash" size={12} />
                          <span>删除凭证</span>
                        </button>
                      )}
                    </div>

                    {testResult && (
                      <div
                        className={`callout ${testResult.success ? 'callout callout--success' : 'callout callout--error'}`}
                        role={testResult.success ? 'status' : 'alert'}
                        style={{ marginTop: 8 }}
                      >
                        <HelmIcon
                          name={testResult.success ? 'check' : 'alert-circle'}
                          size={13}
                        />
                        <span className="selectable">
                          {testResult.message}
                          {testResult.latencyMs !== undefined &&
                            `（延迟 ${testResult.latencyMs}ms）`}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 模型列表管理 (Model Chips 交互) */}
                  <div className="section-flat">
                    <div
                      className="section-flat-header"
                      style={{ justifyContent: 'space-between' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HelmIcon name="cpu" size={14} />
                        <span className="section-flat-title">模型清单与路由控制</span>
                      </div>
                      <span className="badge badge-neutral mono" style={{ fontSize: 11 }}>
                        {`已启用 ${enabledModelIds.length} / 共 ${models.length} 个模型`}
                      </span>
                    </div>

                    <p className="text-xs text-subtle" style={{ margin: '4px 0 10px' }}>
                      点击胶囊药丸切换模型启用状态，未启用的模型将在目录中标记停用，且会话无法选用。
                    </p>

                    {models.length === 0 ? (
                      <div className="text-subtle text-xs" style={{ padding: '8px 0' }}>
                        {provider.dynamic
                          ? '该动态供应商可通过上方「刷新目录」拉取可用模型。'
                          : '该供应商暂未登记预置模型，保存端点配置后将自动同步目录。'}
                      </div>
                    ) : (
                      <div className="models model-chips-container">
                        {/* 操作工具栏：过滤搜索与批量控制 */}
                        <div className="mbulk model-chips-toolbar">
                          <div className="search-box" style={{ flex: 1, minWidth: 0, maxWidth: 260 }}>
                            <HelmIcon name="search" size={13} />
                            <input
                              type="text"
                              placeholder="过滤模型..."
                              value={modelFilter}
                              onChange={(e) => setModelFilter(e.target.value)}
                              aria-label="过滤模型"
                            />
                          </div>
                          <div className="model-chips-actions">
                            <button
                              type="button"
                              className="text action"
                              onClick={handleSelectAll}
                              title={hasModelFilter ? '启用当前过滤匹配的模型' : '全部启用'}
                            >
                              {hasModelFilter
                                ? `启用匹配项（${filteredModels.length}）`
                                : '全部启用'}
                            </button>
                            <button
                              type="button"
                              className="text action"
                              onClick={handleClearAll}
                              title={hasModelFilter ? '停用当前过滤匹配的模型' : '全部停用'}
                            >
                              {hasModelFilter
                                ? `停用匹配项（${filteredModels.length}）`
                                : '全部停用'}
                            </button>
                          </div>
                        </div>

                        {/* 平铺药丸胶囊群（零外框、呼吸感白底平铺） */}
                        <div
                          className={`mchips model-drawer-tags-wrap ${isExpanded ? 'open is-expanded' : ''}`}
                          role="group"
                          aria-label="选择启用的模型"
                        >
                          {visibleModels.length === 0 ? (
                            <span className="text-xs text-subtle" style={{ padding: '6px 8px' }}>
                              未找到匹配的模型
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
                                  title={`${model.name} (${model.id}) - 点击${isChecked ? '停用' : '启用'}`}
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

                        {/* 展开/折叠通栏按钮 */}
                        {models.length > 12 && (
                          <button
                            type="button"
                            className="mchips-fold"
                            onClick={() => setIsExpanded((prev) => !prev)}
                            aria-expanded={isExpanded}
                            title={isExpanded ? '折叠列表' : '展开全部'}
                          >
                            <span>
                              {isExpanded
                                ? '折叠列表'
                                : hiddenModelCount > 0
                                  ? `展开全部（省略 ${hiddenModelCount} 个）`
                                  : '展开全部'}
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

            {/* 抽屉底部动作栏 */}
            <div className="primary-drawer-footer">
              {saveSuccess && (
                <span className="text-xs text-ok" style={{ marginRight: 'auto' }}>
                  配置已成功保存
                </span>
              )}
              {saveError && (
                <span className="text-xs text-danger" style={{ marginRight: 'auto' }}>
                  {saveError}
                </span>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSaveProvider}
                disabled={saving || !provider}
              >
                <HelmIcon name="check" size={14} />
                <span>{saving ? '保存中...' : '保存配置'}</span>
              </button>
            </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>

      {/* 删除凭据二次确认对话框 */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="确认删除凭证"
        description={`确定要删除 ${provider?.name ?? '该供应商'} 的本地密钥凭据吗？删除后未单独配置其他密钥的会话将无法访问此供应商。`}
        confirmText="确认删除"
        cancelText="取消"
        danger
        inline={inline}
        onConfirm={handleDeleteCredential}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  )
}
