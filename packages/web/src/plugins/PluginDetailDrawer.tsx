import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  extractPluginUsages,
  getPluginDescription,
  pluginErrorStageLabel,
  type PluginUsageItem,
} from './plugin-card-model.js'
import type { HelmxLocale, PluginSummary } from '@helmx/protocol/browser'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText } from '@helmx/protocol/browser'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../lib/api.js'
import { HelmxIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, Select, Switch } from '@helmx/plugin-client'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalGroupedUi, useOptionalLocale, useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { buildProfileModelOptions } from '../profiles/profile-center-model.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
} from '../ui/AlertDialog.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import {
  formatInstalledAt,
  pluginPackageErrorText,
  pluginSourceBadgeLabel,
  pluginSourceDisplayText,
} from './plugin-package-model.js'
import {
  buildPluginConfigPayload,
  buildResetFieldPayload,
  canResetConfigField,
  configFieldInitialValue,
  secretConfigured,
  type ConfigValue,
} from '../modals/plugin-config-form-model.js'
import { listPluginScreens } from './plugin-card-model.js'
import { isPluginFailed } from './plugin-center-model.js'

export interface PluginDetailDrawerProps {
  plugin: PluginSummary | null
  open: boolean
  onClose: () => void
  onToggleEnabled: (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => Promise<void>
  toggling: boolean
  /** 插件包更新/卸载成功后请求父级刷新插件列表。 */
  onPackageChanged?: () => void
  /** 卸载成功后请求父级关闭抽屉（列表已无该插件）。 */
  onRemoved?: () => void
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
}

export interface PluginConfigFormProps {
  pluginId: string
  config: PluginConfigResponse
  /** 配置字段 label/description（LocalizedText）的解析 locale。 */
  locale: HelmxLocale
  onSaved: () => void
  /** 内联渲染下拉菜单（便于测试与抽屉内断言）。 */
  inline?: boolean
}

/**
 * 表单字段初始值推导纯函数
 */
function initialFormValues(config: PluginConfigResponse): Record<string, ConfigValue> {
  const init: Record<string, ConfigValue> = {}
  for (const [key, schema] of Object.entries(config.schema ?? {})) {
    init[key] = configFieldInitialValue(schema, config.values?.[key])
  }
  return init
}

/**
 * 按 schema 自动生成的插件配置受控表单：
 * - 遵守 secret 安全规范（空串保持已存凭据，已配置掩码防覆写）；
 * - 支持 boolean、number、string 各类受控渲染。
 */
export function PluginConfigForm({
  pluginId,
  config,
  locale,
  onSaved,
  inline = false,
}: PluginConfigFormProps): React.JSX.Element {
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const models = useOptionalModels() ?? []
  const entries = Object.entries(config.schema ?? {})
  const [values, setValues] = useState<Record<string, ConfigValue>>(() => initialFormValues(config))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [resettingKey, setResettingKey] = useState<string | null>(null)

  useEffect(() => {
    setValues(initialFormValues(config))
  }, [config])

  if (entries.length === 0) {
    return <div className="text-subtle">{t('plugins.config.empty')}</div>
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await pluginsApi.setConfig(pluginId, buildPluginConfigPayload(config.schema ?? {}, values))
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // 单字段重置：发送 { [key]: null } 清除用户显式覆写值（或已存密钥），回退 schema.default。
  const resetField = async (key: string) => {
    setResettingKey(key)
    setError(null)
    try {
      await pluginsApi.setConfig(pluginId, buildResetFieldPayload(key))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResettingKey(null)
    }
  }

  return (
    <div className="flex-col">
      <div className="config-fields flex-col">
        {entries.map(([key, schema]) => {
          const fieldId = `helmx-plugin-config-${pluginId}-${key}`
          const source = config.sources?.[key]
          // 必填且无 default 的字段无值可回退，禁止清除（后端同样会拒绝）。
          const isRequiredWithoutDefault = schema.required === true && schema.default === undefined
          const canReset =
            !isRequiredWithoutDefault && canResetConfigField(schema, source, config.values?.[key])
          return (
            <div key={key} className="form-grid plugin-config-row">
              <label htmlFor={fieldId} className="form-grid-label plugin-config-field-label">
                {schema.secret === true && <HelmxIcon name="lock" size={11} />}
                <span className="plugin-config-field-name">
                  {schema.label !== undefined ? resolveLocalizedText(schema.label, locale) || key : key}
                </span>
                {schema.required && <span className="text-err">*</span>}
                {source === 'configured' && (
                  <span className="badge badge-neutral plugin-config-source-tag" title={t('plugins.config.configuredTitle')}>
                    {t('plugins.config.configured')}
                  </span>
                )}
                {source === 'default' && (
                  <span className="text-subtle plugin-config-source-tag" title={t('plugins.config.defaultTitle')}>
                    {t('common.default')}
                  </span>
                )}
              </label>
              <div className="plugin-config-field-value">
                {schema.type === 'boolean' ? (
                  <Switch
                    id={fieldId}
                    checked={values[key] === true}
                    onChange={(checked) => setValues((prev) => ({ ...prev, [key]: checked }))}
                    label={values[key] === true ? t('plugins.config.switchOn') : t('plugins.config.switchOff')}
                  />
                ) : schema.type === 'number' ? (
                  <input
                    id={fieldId}
                    className="input"
                    type="number"
                    min={schema.minimum}
                    max={schema.maximum}
                    step={schema.integer === true ? 1 : 'any'}
                    value={String(values[key] ?? '')}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                    onInput={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: Number((e.target as HTMLInputElement).value),
                      }))
                    }
                  />
                ) : schema.format === 'model' ? (
                  <Select
                    id={fieldId}
                    inline={inline}
                    popoverClassName="helmx-select-popover-wide"
                    aria-label={
                      schema.label !== undefined ? resolveLocalizedText(schema.label, locale) || key : key
                    }
                    value={String(values[key] ?? '')}
                    options={buildProfileModelOptions(models, String(values[key] ?? ''), t)}
                    onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                  />
                ) : (
                  <input
                    id={fieldId}
                    className={schema.secret ? 'input mono' : 'input'}
                    type={schema.secret ? 'password' : 'text'}
                    placeholder={
                      schema.secret
                        ? secretConfigured(config.values?.[key])
                          ? t('plugins.config.secretConfiguredPlaceholder')
                          : (schema.description !== undefined
                              ? resolveLocalizedText(schema.description, locale)
                              : '') || t('plugins.config.secretUnconfiguredPlaceholder')
                        : schema.description !== undefined
                          ? resolveLocalizedText(schema.description, locale)
                          : undefined
                    }
                    value={String(values[key] ?? '')}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    onInput={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: (e.target as HTMLInputElement).value,
                      }))
                    }
                  />
                )}
                {canReset && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={saving || resettingKey !== null}
                    onClick={() => void resetField(key)}
                    title={schema.secret ? t('plugins.config.clearSecretTitle') : t('plugins.config.resetDefaultTitle')}
                  >
                    <HelmxIcon name="rotate-ccw" size={11} />
                    <span>{schema.secret ? t('plugins.config.clear') : t('plugins.config.reset')}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {error && (
        <div className="callout callout-error" role="alert">
          <HelmxIcon name="alert-circle" size={13} />
          <span className="callout-text selectable">{error}</span>
        </div>
      )}
      <div>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          <HelmxIcon name="check" size={12} />
          <span>{saved ? t('plugins.config.saved') : t('plugins.config.save')}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * 全屏插件中心右侧深度配置抽屉 (PluginDetailDrawer)：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 顶部元信息：大图标、完整名称、插件唯一 ID、版本与常驻核心状态；
 * - 启停操作区：主启停按钮（带防重复提交与 409 在途任务冲突处理）；
 * - 能力清单透视：折叠/展开 Tools、Actions、Hooks 详细清单；
 * - 动态配置项表单：带并发代数守卫（configGeneration）；
 * - 扩展设置面板：集成 PluginUiView 挂载 settingsPanels；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function PluginDetailDrawer({
  plugin,
  open,
  onClose,
  onToggleEnabled,
  toggling,
  onPackageChanged,
  onRemoved,
  inline = false,
}: PluginDetailDrawerProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const groupedUi = useOptionalGroupedUi()
  const actions = useOptionalStoreActions()
  // LocalizedText 显示元数据（插件名 / 配置字段 label / 设置面板 label）按
  // store 权威 locale 解析；保留无 Provider 的 SSR 渲染容忍（缺省英文桥接）。
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const [config, setConfig] = useState<(PluginConfigResponse & { pluginId: string }) | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // 包管理互斥状态：idle | updating | removing（与启停 toggling 独立）
  const [packageOp, setPackageOp] = useState<'idle' | 'updating' | 'removing'>('idle')
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  // 409 plugin_in_use 占用确认：保存待确认的占用清单与目标插件
  const [inUseConfirm, setInUseConfirm] = useState<{ plugin: PluginSummary; usages: PluginUsageItem[] } | null>(null)

  // 代数并发保护：快速切换插件时迟到的旧响应不得写入新插件配置
  const configGeneration = useRef(0)

  const reloadConfig = async (id: string) => {
    const generation = ++configGeneration.current
    setLoadingConfig(true)
    setConfigError(null)
    try {
      const result = await pluginsApi.getConfig(id)
      if (configGeneration.current !== generation) return
      setConfig({ ...result, pluginId: id })
    } catch (err) {
      if (configGeneration.current !== generation) return
      setConfig(null)
      setConfigError(err instanceof Error ? err.message : String(err))
    } finally {
      if (configGeneration.current === generation) {
        setLoadingConfig(false)
      }
    }
  }

  useEffect(() => {
    if (open && plugin?.id) {
      void reloadConfig(plugin.id)
    } else {
      configGeneration.current += 1
      setConfig(null)
      setLoadingConfig(false)
      setConfigError(null)
      setActionError(null)
      setPackageOp('idle')
      setConfirmRemoveOpen(false)
      setInUseConfirm(null)
    }
  }, [open, plugin?.id])

  const handleToggle = async (targetEnabled?: boolean, options?: { force?: boolean }) => {
    if (!plugin || plugin.locked || toggling) return
    setActionError(null)
    try {
      await onToggleEnabled(plugin, targetEnabled, options)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409 && err.code === 'plugin_in_use') {
        // 持久资源占用：展示占用清单供用户知情后选择强制停用
        const usages = extractPluginUsages(err.details)
        if (usages.length > 0) {
          setInUseConfirm({ plugin, usages })
        } else {
          setActionError(t('plugins.drawer.disableInUseError'))
        }
      } else if (err instanceof ApiClientError && err.status === 409) {
        setActionError(t('plugins.drawer.disableLiveTasksError', { code: err.code }))
      } else {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  // 受管插件包：重新拉取安装来源最新版本并重载（源未变化时 changed=false，如实回显）。
  const handleUpdatePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle') return
    setPackageOp('updating')
    setActionError(null)
    try {
      const result = await pluginsApi.update(plugin.id)
      const versionLabel = result.record.version || t('plugins.package.unknownVersion')
      const noticeBody = result.changed
        ? t('plugins.package.updatedBody', {
            version: versionLabel,
            previous: result.previousVersion || t('plugins.package.unknownVersion'),
          })
        : t('plugins.package.unchangedBody', { version: versionLabel })
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.updateNoticeTitle'),
        body: t('plugins.package.updateNoticeBody', {
          name: resolveLocalizedText(plugin.name, locale) || plugin.id,
          detail: noticeBody,
        }),
      })
      onPackageChanged?.()
    } catch (err) {
      setActionError(pluginPackageErrorText(err, t('plugins.package.action.update'), t))
    } finally {
      setPackageOp('idle')
    }
  }

  // 受管插件包卸载：确认后清理安装目录与注册记录；成功后关闭抽屉并刷新列表。
  const handleRemovePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle') return
    setPackageOp('removing')
    setActionError(null)
    try {
      await pluginsApi.remove(plugin.id)
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.removeNoticeTitle'),
        body: t('plugins.package.removeNoticeBody', {
          name: resolveLocalizedText(plugin.name, locale) || plugin.id,
          id: plugin.id,
        }),
      })
      setConfirmRemoveOpen(false)
      onRemoved?.()
      onPackageChanged?.()
    } catch (err) {
      setActionError(pluginPackageErrorText(err, t('plugins.package.action.uninstall'), t))
      setConfirmRemoveOpen(false)
    } finally {
      setPackageOp('idle')
    }
  }

  const handleForceDisable = async () => {
    const pending = inUseConfirm
    if (!pending) return
    setInUseConfirm(null)
    await handleToggle(false, { force: true })
  }

  const versionLabel = plugin?.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const settingsPanels =
    groupedUi?.settingsPanels?.filter((p) => p.pluginId === plugin?.id) ?? []
  // 已启用且有 Screen 贡献时提供快捷打开（主屏/右屏）；唯一导航机制 openTarget。
  const pluginScreens =
    plugin !== null && groupedUi !== undefined && plugin.enabled
      ? listPluginScreens(groupedUi, plugin.id)
      : []
  const primaryScreen = pluginScreens[0] ?? null

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop plugin-drawer-backdrop" />
        <DialogContent
          className="plugin-drawer-content"
          role="dialog"
          aria-label={
            plugin
              ? t('plugins.drawer.ariaSelected', {
                  name: resolveLocalizedText(plugin.name, locale) || plugin.id,
                })
              : t('plugins.drawer.titleFallback')
          }
        >
          {/* Header metadata */}
          <div className="plugin-drawer-header">
            <div className="plugin-drawer-header-left">
              <div className="plugin-drawer-title-col">
                <div className="plugin-drawer-title-row">
                  <DialogTitle className="plugin-drawer-title">
                    {(plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') ||
                      plugin?.id ||
                      t('plugins.drawer.titleFallback')}
                  </DialogTitle>
                  {versionLabel && (
                    <span className="badge badge-neutral mono" title={t('plugins.card.versionTitle', { version: versionLabel })}>
                      {versionLabel}
                    </span>
                  )}
                  {plugin?.locked && (
                    <span className="badge badge-warn" title={t('plugins.card.lockedTitle')}>
                      <HelmxIcon name="lock" size={10} />
                      <span>{t('plugins.resident')}</span>
                    </span>
                  )}
                  {plugin?.dependencies && plugin.dependencies.length > 0 && (
                    <span
                      className="badge badge-neutral"
                      title={t('plugins.drawer.dependenciesTitle', {
                        deps: plugin.dependencies.join(t('plugins.desc.listSeparator')),
                      })}
                    >
                      <HelmxIcon name="network" size={10} />
                      <span>{t('plugins.drawer.dependenciesCount', { count: plugin.dependencies.length })}</span>
                    </span>
                  )}
                </div>
                {plugin && <div className="plugin-drawer-id mono">{plugin.id}</div>}
                {plugin && (
                  <div className="plugin-drawer-desc">{getPluginDescription(plugin, locale, t)}</div>
                )}
                {plugin?.status === 'failed' && plugin.error && (
                  <div className="plugin-drawer-failed-note" role="note">
                    <span className="badge badge-err">{t('plugins.drawer.failedToLoad')}</span>
                    <span className="mono selectable">
                      {t('plugins.drawer.failedNoteDetail', {
                        code: plugin.error.code,
                        message: plugin.error.message,
                        stage: plugin.error.stage,
                      })}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                className="btn btn-ghost btn-icon-sm plugin-drawer-close-btn"
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* Drawer body */}
          <div className="plugin-drawer-body">
            {!plugin ? (
              <div className="empty-state">{t('plugins.drawer.noSelection')}</div>
            ) : (
              <>
                {/* Quick actions and enable/disable bar */}
                <div className="plugin-drawer-action-bar">
                  <div className="plugin-drawer-status-wrap">
                    <span className="text-subtle">{t('plugins.drawer.currentStatus')}</span>
                    {isPluginFailed(plugin) ? (
                      <span className="badge badge-err" title={t('plugins.drawer.errorBadgeTitle')}>
                        <HelmxIcon name="alert-circle" size={10} />
                        <span>{t('plugins.status.error')}</span>
                      </span>
                    ) : plugin.enabled ? (
                      <span className="badge badge-ok">
                        <HelmxIcon name="check" size={10} />
                        <span>{t('common.enabled')}</span>
                      </span>
                    ) : (
                      <span className="badge badge-neutral">{t('common.disabled')}</span>
                    )}
                  </div>
                  <div className="plugin-drawer-screen-actions">
                    {primaryScreen !== null && actions !== null && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={
                            pluginScreens.length > 1
                              ? t('plugins.drawer.openMainViewMultiTitle', {
                                  screenId: primaryScreen.screenId,
                                  count: pluginScreens.length,
                                })
                              : t('plugins.drawer.openMainViewTitle')
                          }
                          onClick={() =>
                            actions.openTarget({
                              kind: 'screen',
                              pluginId: primaryScreen.pluginId,
                              screenId: primaryScreen.screenId,
                            })
                          }
                        >
                          <HelmxIcon name="play" size={12} />
                          <span>{t('plugins.openView')}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm split-toggle-btn plugin-drawer-split-btn"
                          title={t('plugins.drawer.openSplitTitle')}
                          onClick={() =>
                            actions.openTarget(
                              {
                                kind: 'screen',
                                pluginId: primaryScreen.pluginId,
                                screenId: primaryScreen.screenId,
                              },
                              { split: true },
                            )
                          }
                        >
                          <HelmxIcon name="columns" size={12} />
                          <span>{t('plugins.drawer.openSplit')}</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={`btn btn-sm ${plugin.enabled ? 'btn' : 'btn-primary'}`}
                      disabled={plugin.locked || toggling}
                      onClick={() => void handleToggle(plugin.enabled ? false : true)}
                    >
                      {plugin.enabled ? (
                        <>
                          <HelmxIcon name="square" size={12} />
                          <span>{t('plugins.drawer.disablePlugin')}</span>
                        </>
                      ) : (
                        <>
                          <HelmxIcon name="play" size={12} />
                          <span>{t('plugins.drawer.enablePlugin')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {actionError && (
                  <div className="callout callout-error" role="alert">
                    <HelmxIcon name="alert-circle" size={13} />
                    <span className="callout-text selectable">{actionError}</span>
                  </div>
                )}

                {/* Managed plugin package: source metadata + update/uninstall (hidden for built-in or unmanaged plugins) */}
                {plugin?.managed && (
                  <div className="plugin-drawer-section plugin-package-section">
                    <h4 className="plugin-drawer-section-title">
                      <HelmxIcon name="boxes" size={13} />
                      <span>{t('plugins.package.sectionTitle')}</span>
                    </h4>
                    <div className="plugin-package-meta">
                      <div className="form-grid">
                        <span className="form-grid-label"><span>{t('plugins.package.sourceLabel')}</span></span>
                        <span className="form-grid-value">
                          <span className="badge badge-neutral mono" data-source-kind={plugin.managed.source.kind}>
                            {pluginSourceBadgeLabel(plugin.managed.source, t)}
                          </span>
                          <span className="mono selectable plugin-package-source-text">
                            {pluginSourceDisplayText(plugin.managed.source)}
                          </span>
                        </span>
                      </div>
                      {plugin.managed.installedVersion !== '' && (
                        <div className="form-grid">
                          <span className="form-grid-label"><span>{t('plugins.package.installedVersionLabel')}</span></span>
                          <span className="form-grid-value mono">{plugin.managed.installedVersion}</span>
                        </div>
                      )}
                      {formatInstalledAt(plugin.managed.installedAt, locale) !== '' && (
                        <div className="form-grid">
                          <span className="form-grid-label"><span>{t('plugins.package.installedAtLabel')}</span></span>
                          <span className="form-grid-value">{formatInstalledAt(plugin.managed.installedAt, locale)}</span>
                        </div>
                      )}
                    </div>
                    <div className="plugin-package-actions">
                      <button className="btn btn-sm" disabled={packageOp !== 'idle'} onClick={() => void handleUpdatePackage()}>
                        <HelmxIcon name="refresh-cw" size={12} />
                        <span>{packageOp === 'updating' ? t('plugins.package.updating') : t('plugins.package.checkUpdates')}</span>
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={packageOp !== 'idle'} onClick={() => setConfirmRemoveOpen(true)}>
                        <HelmxIcon name="trash-2" size={12} />
                        <span>{packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.uninstallPlugin')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Failure diagnostics box: structured stage, error code and full message */}
                {plugin.error && (
                  <div className="callout callout-error" role="alert">
                    <HelmxIcon name="alert-circle" size={13} />
                    <div className="plugin-diagnostic-body">
                      <div className="plugin-diagnostic-title">{t('plugins.drawer.diagnosticTitle')}</div>
                      <div className="text-subtle">
                        {t('plugins.drawer.diagnosticMetaPrefix', {
                          stage: pluginErrorStageLabel(plugin.error.stage, t),
                        })}
                        <span className="mono">{plugin.error.code}</span>
                      </div>
                      <div className="selectable plugin-diagnostic-message">{plugin.error.message}</div>
                    </div>
                  </div>
                )}

                {/* 409 plugin_in_use confirmation: informed forced disable */}
                {inUseConfirm && (
                  <div className="callout callout-warn" role="alert">
                    <HelmxIcon name="alert-triangle" size={13} />
                    <div className="plugin-inuse-body">
                      <div className="plugin-diagnostic-title">{t('plugins.drawer.inUseTitle')}</div>
                      <div className="text-subtle">{t('plugins.drawer.inUseHint')}</div>
                      <ul className="plugin-inuse-list">
                        {inUseConfirm.usages.map((usage) => (
                          <li key={`${usage.kind}/${usage.id}`} title={`${usage.kind}/${usage.id}`}>
                            {usage.label}
                          </li>
                        ))}
                      </ul>
                      <div className="plugin-inuse-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInUseConfirm(null)}>
                          {t('common.cancel')}
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" disabled={toggling} onClick={() => void handleForceDisable()}>
                          <HelmxIcon name="square" size={12} />
                          <span>{t('plugins.drawer.forceDisable')}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Capability inventory */}
                <div className="plugin-drawer-section">
                  <h4 className="plugin-drawer-section-title">
                    <HelmxIcon name="boxes" size={13} />
                    <span>{t('plugins.drawer.capabilities')}</span>
                  </h4>
                  <div className="plugin-drawer-capabilities">
                    {/* Tools */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmxIcon name="wrench" size={11} />
                        <span className="plugin-capability-group-title">
                          Tools ({plugin.tools.length})
                        </span>
                      </div>
                      {plugin.tools.length > 0 ? (
                        <div className="plugin-capability-tags">
                          {plugin.tools.map((tool) => (
                            <span key={tool} className="plugin-capability-tag mono" title={tool}>
                              {tool}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-subtle">{t('plugins.drawer.noTools')}</div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmxIcon name="zap" size={11} />
                        <span className="plugin-capability-group-title">
                          Actions ({plugin.actions.length})
                        </span>
                      </div>
                      {plugin.actions.length > 0 ? (
                        <div className="plugin-capability-tags">
                          {plugin.actions.map((act) => (
                            <span key={act} className="plugin-capability-tag mono" title={act}>
                              {act}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-subtle">{t('plugins.drawer.noActions')}</div>
                      )}
                    </div>

                    {/* Hooks */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmxIcon name="layers" size={11} />
                        <span className="plugin-capability-group-title">
                          Hooks ({plugin.hooks.length})
                        </span>
                      </div>
                      {plugin.hooks.length > 0 ? (
                        <div className="plugin-capability-tags">
                          {plugin.hooks.map((hook) => (
                            <span key={hook} className="plugin-capability-tag mono" title={hook}>
                              {hook}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-subtle">{t('plugins.drawer.noHooks')}</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Dynamic configuration options */}
                <div className="plugin-drawer-section">
                  <h4 className="plugin-drawer-section-title">
                    <HelmxIcon name="sliders" size={13} />
                    <span>{t('plugins.drawer.configuration')}</span>
                  </h4>
                  {loadingConfig ? (
                    <div className="loading-state">
                      <HelmxIcon name="loader" size={13} className="spin-slow" />
                      <span>{t('plugins.drawer.loadingConfig')}</span>
                    </div>
                  ) : configError ? (
                    <div className="callout callout-error" role="alert">
                      <HelmxIcon name="alert-circle" size={13} />
                      <span className="callout-text selectable">{configError}</span>
                    </div>
                  ) : config && config.pluginId === plugin.id ? (
                    <PluginConfigForm
                      pluginId={plugin.id}
                      config={config}
                      locale={locale}
                      inline={inline}
                      onSaved={() => void reloadConfig(plugin.id)}
                    />
                  ) : (
                    <div className="text-subtle">{t('plugins.drawer.configUnavailable')}</div>
                  )}
                </div>

                {/* Extension settings panels */}
                {settingsPanels.length > 0 && (
                  <div className="plugin-drawer-section">
                    <h4 className="plugin-drawer-section-title">
                      <HelmxIcon name="layout" size={13} />
                      <span>
                        {settingsPanels.length > 1
                          ? t('plugins.drawer.settingsPanelsCount', { count: settingsPanels.length })
                          : resolveLocalizedText(settingsPanels[0]!.spec.label, locale) ||
                            t('plugins.drawer.settingsPanels')}
                      </span>
                    </h4>
                    {settingsPanels.map((panel) => (
                      <div
                        key={`${panel.pluginId}/${panel.spec.id}`}
                        className="plugin-settings-panels"
                      >
                        {settingsPanels.length > 1 && (
                          <div className="plugin-settings-panel-title">
                            {resolveLocalizedText(panel.spec.label, locale) || panel.spec.id}
                          </div>
                        )}
                        <PluginUiView
                          pluginId={plugin.id}
                          spec={panel.spec}
                          label={t('plugins.drawer.settingsPanelLabel', { id: panel.spec.id })}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>

      {/* Uninstall danger confirmation: Radix AlertDialog (inline rendering matches the drawer for test assertions) */}
      <AlertDialog
        open={confirmRemoveOpen && Boolean(plugin?.managed)}
        inline={inline}
        onOpenChange={(isOpen) => {
          if (!isOpen && packageOp !== 'removing') setConfirmRemoveOpen(false)
        }}
      >
        <AlertDialogPortal inline={inline}>
          <AlertDialogOverlay className="modal-backdrop">
            <AlertDialogContent
              className="modal plugin-remove-confirm"
              role="alertdialog"
              aria-label={t('plugins.package.confirmUninstallAria')}
            >
            <div className="modal-header">
              <AlertDialogTitle className="modal-title">{t('plugins.package.uninstallPlugin')}</AlertDialogTitle>
            </div>
            <div className="modal-body">
              <AlertDialogDescription className="plugin-remove-confirm-desc">
                {t('plugins.package.confirmUninstallBody', {
                  name: (plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') || plugin?.id || '',
                  id: plugin?.id ?? '',
                })}
              </AlertDialogDescription>
            </div>
            <div className="modal-footer">
              <AlertDialogCancel asChild>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={packageOp === 'removing'}
                  onClick={() => setConfirmRemoveOpen(false)}
                >
                  {t('common.cancel')}
                </button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <button
                  className="btn btn-danger btn-sm"
                  disabled={packageOp === 'removing'}
                  onClick={() => void handleRemovePackage()}
                >
                  <HelmxIcon name="trash-2" size={12} />
                  <span>{packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.confirmUninstall')}</span>
                </button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialogPortal>
      </AlertDialog>
    </Dialog>
  )
}
