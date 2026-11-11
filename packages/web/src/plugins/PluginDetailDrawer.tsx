import React, { useContext, useEffect, useRef, useState } from 'react'
import {
  extractPluginUsages,
  getPluginDescription,
  pluginErrorStageLabel,
  type PluginUsageItem,
} from './plugin-card-model.js'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { HelmStoreContext } from '../lib/store-context.js'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Switch } from '../ui/Switch.js'
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
  onSaved: () => void
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
  onSaved,
}: PluginConfigFormProps): React.JSX.Element {
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
    return <div className="text-subtle">该插件未声明配置项。</div>
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
          const fieldId = `helm-plugin-config-${pluginId}-${key}`
          const source = config.sources?.[key]
          // 必填且无 default 的字段无值可回退，禁止清除（后端同样会拒绝）。
          const isRequiredWithoutDefault = schema.required === true && schema.default === undefined
          const canReset =
            !isRequiredWithoutDefault && canResetConfigField(schema, source, config.values?.[key])
          return (
            <div key={key} className="form-grid">
              <label htmlFor={fieldId} className="form-grid-label">
                {schema.secret === true && <HelmIcon name="lock" size={11} />}
                <span>{schema.label ?? key}</span>
                {schema.required && <span className="text-err">*</span>}
                {source === 'configured' && (
                  <span className="badge badge-neutral" title="用户已显式配置">
                    已配置
                  </span>
                )}
                {source === 'default' && (
                  <span className="text-subtle" title="当前使用默认值">
                    默认
                  </span>
                )}
              </label>
              <div className="plugin-config-field-value">
                {schema.type === 'boolean' ? (
                  <Switch
                    id={fieldId}
                    checked={values[key] === true}
                    onChange={(checked) => setValues((prev) => ({ ...prev, [key]: checked }))}
                    label={values[key] === true ? '开启' : '关闭'}
                  />
                ) : schema.type === 'number' ? (
                  <input
                    id={fieldId}
                    className="input"
                    type="number"
                    value={String(values[key] ?? '')}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                    onInput={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: Number((e.target as HTMLInputElement).value),
                      }))
                    }
                  />
                ) : (
                  <input
                    id={fieldId}
                    className={schema.secret ? 'input mono' : 'input'}
                    type={schema.secret ? 'password' : 'text'}
                    placeholder={
                      schema.secret
                        ? secretConfigured(config.values?.[key])
                          ? '已配置（留空保持不变）'
                          : (schema.description ?? '未配置')
                        : schema.description
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
                    title={schema.secret ? '清除已保存密钥' : '重置为默认值'}
                  >
                    <HelmIcon name="rotate-ccw" size={11} />
                    <span>{schema.secret ? '清除' : '重置'}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {error && (
        <div className="callout callout--error" role="alert">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{error}</span>
        </div>
      )}
      <div>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          <HelmIcon name="check" size={12} />
          <span>{saved ? '已保存' : '保存配置'}</span>
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
  const store = useContext(HelmStoreContext)
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
          setActionError('停用失败：插件存在关联的持久资源占用（plugin_in_use）。')
        }
      } else if (err instanceof ApiClientError && err.status === 409) {
        setActionError(
          `停用失败：插件存在在途任务（${err.code}）。请等待任务结束或中止后再试。`,
        )
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
      const versionLabel = result.record.version || '未知版本'
      const noticeBody = result.changed
        ? `已更新到 ${versionLabel}（此前 ${result.previousVersion || '未知版本'}）`
        : `源未变化，当前仍为 ${versionLabel}`
      store?.pushNotice({
        type: 'notification',
        level: 'info',
        title: '插件包已更新',
        body: `${plugin.name || plugin.id}：${noticeBody}`,
      })
      onPackageChanged?.()
    } catch (err) {
      setActionError(pluginPackageErrorText(err, '更新'))
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
      store?.pushNotice({
        type: 'notification',
        level: 'info',
        title: '插件包已卸载',
        body: `${plugin.name || plugin.id} 已移除（${plugin.id}）`,
      })
      setConfirmRemoveOpen(false)
      onRemoved?.()
      onPackageChanged?.()
    } catch (err) {
      setActionError(pluginPackageErrorText(err, '卸载'))
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
    store?.groupedUi?.settingsPanels?.filter((p) => p.pluginId === plugin?.id) ?? []
  // 已启用且有 Screen 贡献时提供快捷打开（主屏/右屏）；唯一导航机制 store.openTarget。
  const pluginScreens =
    plugin !== null && store !== null && plugin.enabled
      ? listPluginScreens(store.groupedUi, plugin.id)
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
          aria-label={plugin ? `${plugin.name || plugin.id} 详情` : '插件详情'}
        >
          {/* 头部元信息 */}
          <div className="plugin-drawer-header">
            <div className="plugin-drawer-header-left">
              <div className="plugin-drawer-title-col">
                <div className="plugin-drawer-title-row">
                  <DialogTitle className="plugin-drawer-title">
                    {plugin?.name || plugin?.id || '插件详情'}
                  </DialogTitle>
                  {versionLabel && (
                    <span className="badge badge-neutral mono" title={`版本 ${versionLabel}`}>
                      {versionLabel}
                    </span>
                  )}
                  {plugin?.locked && (
                    <span className="badge badge-warn" title="常驻核心插件，不可停用">
                      <HelmIcon name="lock" size={10} />
                      <span>常驻</span>
                    </span>
                  )}
                </div>
                {plugin && <div className="plugin-drawer-id mono">{plugin.id}</div>}
                {plugin && (
                  <div className="plugin-drawer-desc">{getPluginDescription(plugin)}</div>
                )}
                {plugin?.status === 'failed' && plugin.error && (
                  <div className="plugin-drawer-failed-note" role="note">
                    <span className="badge badge-err">加载失败</span>
                    <span className="mono selectable">{`${plugin.error.code}：${plugin.error.message}（阶段 ${plugin.error.stage}）`}</span>
                  </div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                className="btn btn-ghost btn-sm plugin-drawer-close-btn"
                aria-label="关闭"
                title="关闭"
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* 抽屉主体 */}
          <div className="plugin-drawer-body">
            {!plugin ? (
              <div className="empty-state">未选择插件</div>
            ) : (
              <>
                {/* 快速动作与启停栏 */}
                <div className="plugin-drawer-action-bar">
                  <div className="plugin-drawer-status-wrap">
                    <span className="text-subtle text-xs">当前状态</span>
                    {isPluginFailed(plugin) ? (
                      <span className="badge badge-err" title="插件加载或启用失败，详见下方诊断信息">
                        <HelmIcon name="alert-circle" size={10} />
                        <span>异常</span>
                      </span>
                    ) : plugin.enabled ? (
                      <span className="badge badge-ok">
                        <HelmIcon name="check" size={10} />
                        <span>已启用</span>
                      </span>
                    ) : (
                      <span className="badge badge-neutral">已停用</span>
                    )}
                  </div>
                  <div className="plugin-drawer-screen-actions">
                    {primaryScreen !== null && store !== null && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={
                            pluginScreens.length > 1
                              ? `打开主视图 ${primaryScreen.screenId}（共 ${pluginScreens.length} 个视图）`
                              : '打开主视图'
                          }
                          onClick={() =>
                            store.openTarget({
                              kind: 'screen',
                              pluginId: primaryScreen.pluginId,
                              screenId: primaryScreen.screenId,
                            })
                          }
                        >
                          <HelmIcon name="play" size={12} />
                          <span>打开视图</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="在右侧分屏并排打开"
                          onClick={() =>
                            store.openTarget(
                              {
                                kind: 'screen',
                                pluginId: primaryScreen.pluginId,
                                screenId: primaryScreen.screenId,
                              },
                              { split: true },
                            )
                          }
                        >
                          <HelmIcon name="columns" size={12} />
                          <span>右屏打开</span>
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
                          <HelmIcon name="square" size={12} />
                          <span>停用插件</span>
                        </>
                      ) : (
                        <>
                          <HelmIcon name="play" size={12} />
                          <span>启用插件</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {actionError && (
                  <div className="callout callout--error" role="alert">
                    <HelmIcon name="alert-circle" size={13} />
                    <span className="selectable">{actionError}</span>
                  </div>
                )}

                {/* 受管插件包：来源元数据 + 更新/卸载（内置或未受管插件不展示） */}
                {plugin?.managed && (
                  <div className="plugin-drawer-section plugin-package-section">
                    <h4 className="plugin-drawer-section-title">
                      <HelmIcon name="boxes" size={13} />
                      <span>包管理</span>
                    </h4>
                    <div className="plugin-package-meta">
                      <div className="form-grid">
                        <span className="form-grid-label"><span>来源</span></span>
                        <span className="form-grid-value">
                          <span className="badge badge-neutral mono" data-source-kind={plugin.managed.source.kind}>
                            {pluginSourceBadgeLabel(plugin.managed.source)}
                          </span>
                          <span className="mono selectable plugin-package-source-text">
                            {pluginSourceDisplayText(plugin.managed.source)}
                          </span>
                        </span>
                      </div>
                      {plugin.managed.installedVersion !== '' && (
                        <div className="form-grid">
                          <span className="form-grid-label"><span>已安装版本</span></span>
                          <span className="form-grid-value mono">{plugin.managed.installedVersion}</span>
                        </div>
                      )}
                      {formatInstalledAt(plugin.managed.installedAt) !== '' && (
                        <div className="form-grid">
                          <span className="form-grid-label"><span>安装时间</span></span>
                          <span className="form-grid-value">{formatInstalledAt(plugin.managed.installedAt)}</span>
                        </div>
                      )}
                    </div>
                    <div className="plugin-package-actions">
                      <button className="btn btn-sm" disabled={packageOp !== 'idle'} onClick={() => void handleUpdatePackage()}>
                        <HelmIcon name="refresh-cw" size={12} />
                        <span>{packageOp === 'updating' ? '正在更新…' : '检查更新'}</span>
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={packageOp !== 'idle'} onClick={() => setConfirmRemoveOpen(true)}>
                        <HelmIcon name="trash-2" size={12} />
                        <span>{packageOp === 'removing' ? '正在卸载…' : '卸载插件'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* 故障诊断框：结构化展示阶段、错误码与完整消息 */}
                {plugin.error && (
                  <div className="callout callout--error" role="alert">
                    <HelmIcon name="alert-circle" size={13} />
                    <div className="plugin-diagnostic-body">
                      <div className="plugin-diagnostic-title">插件加载或启用失败</div>
                      <div className="text-subtle">
                        {`故障阶段：${pluginErrorStageLabel(plugin.error.stage)} · 错误码：`}
                        <span className="mono">{plugin.error.code}</span>
                      </div>
                      <div className="selectable plugin-diagnostic-message">{plugin.error.message}</div>
                    </div>
                  </div>
                )}

                {/* 409 plugin_in_use 占用确认：知情后可选强制停用 */}
                {inUseConfirm && (
                  <div className="callout callout--warning" role="alert">
                    <HelmIcon name="alert-triangle" size={13} />
                    <div className="plugin-inuse-body">
                      <div className="plugin-diagnostic-title">插件资源占用确认（plugin_in_use）</div>
                      <div className="text-subtle">停用后以下关联资源将暂时失效，配置保留待下次启用恢复：</div>
                      <ul className="plugin-inuse-list">
                        {inUseConfirm.usages.map((usage) => (
                          <li key={`${usage.kind}/${usage.id}`} title={`${usage.kind}/${usage.id}`}>
                            {usage.label}
                          </li>
                        ))}
                      </ul>
                      <div className="plugin-inuse-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInUseConfirm(null)}>
                          取消
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" disabled={toggling} onClick={() => void handleForceDisable()}>
                          <HelmIcon name="square" size={12} />
                          <span>强制停用</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* 能力清单透视 */}
                <div className="plugin-drawer-section">
                  <h4 className="plugin-drawer-section-title">
                    <HelmIcon name="boxes" size={13} />
                    <span>能力清单</span>
                  </h4>
                  <div className="plugin-drawer-capabilities">
                    {/* Tools */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmIcon name="wrench" size={11} />
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
                        <div className="text-subtle text-xs">无声明工具</div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmIcon name="zap" size={11} />
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
                        <div className="text-subtle text-xs">无声明动作</div>
                      )}
                    </div>

                    {/* Hooks */}
                    <div className="plugin-capability-group">
                      <div className="plugin-capability-group-header">
                        <HelmIcon name="layers" size={11} />
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
                        <div className="text-subtle text-xs">无拦截钩子</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 动态配置项 */}
                <div className="plugin-drawer-section">
                  <h4 className="plugin-drawer-section-title">
                    <HelmIcon name="sliders" size={13} />
                    <span>配置项</span>
                  </h4>
                  {loadingConfig ? (
                    <div className="flex-row text-muted" style={{ padding: '8px 0' }}>
                      <HelmIcon name="loader" size={13} />
                      <span>正在读取配置...</span>
                    </div>
                  ) : configError ? (
                    <div className="callout callout--error" role="alert">
                      <HelmIcon name="alert-circle" size={13} />
                      <span className="selectable">{configError}</span>
                    </div>
                  ) : config && config.pluginId === plugin.id ? (
                    <PluginConfigForm
                      pluginId={plugin.id}
                      config={config}
                      onSaved={() => void reloadConfig(plugin.id)}
                    />
                  ) : (
                    <div className="text-subtle">配置读取失败或未声明。</div>
                  )}
                </div>

                {/* 扩展设置面板 */}
                {settingsPanels.length > 0 && (
                  <div className="plugin-drawer-section">
                    <h4 className="plugin-drawer-section-title">
                      <HelmIcon name="layout" size={13} />
                      <span>
                        {settingsPanels.length > 1
                          ? `扩展设置面板（${settingsPanels.length}）`
                          : (settingsPanels[0]!.spec.label || '扩展设置面板')}
                      </span>
                    </h4>
                    {settingsPanels.map((panel) => (
                      <div
                        key={`${panel.pluginId}/${panel.spec.id}`}
                        className="plugin-settings-panels"
                      >
                        {settingsPanels.length > 1 && (
                          <div className="plugin-settings-panel-title">
                            {panel.spec.label || panel.spec.id}
                          </div>
                        )}
                        <PluginUiView
                          pluginId={plugin.id}
                          spec={panel.spec}
                          label={`设置面板 ${panel.spec.id}`}
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

      {/* 卸载危险二次确认：Radix AlertDialog（内联渲染与抽屉一致，便于测试断言） */}
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
              aria-label="确认卸载插件"
            >
            <div className="modal-header">
              <AlertDialogTitle className="modal-title">卸载插件</AlertDialogTitle>
            </div>
            <div className="modal-body">
              <AlertDialogDescription className="plugin-remove-confirm-desc">
                确定卸载 {plugin?.name || plugin?.id}（{plugin?.id}）？将删除安装目录与注册记录，该操作不可恢复。
              </AlertDialogDescription>
            </div>
            <div className="modal-footer">
              <AlertDialogCancel asChild>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={packageOp === 'removing'}
                  onClick={() => setConfirmRemoveOpen(false)}
                >
                  取消
                </button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <button
                  className="btn btn-danger btn-sm"
                  disabled={packageOp === 'removing'}
                  onClick={() => void handleRemovePackage()}
                >
                  <HelmIcon name="trash-2" size={12} />
                  <span>{packageOp === 'removing' ? '正在卸载…' : '确认卸载'}</span>
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
