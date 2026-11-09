import { useEffect, useRef, useState } from 'react'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Switch } from '../ui/Switch.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import {
  buildPluginConfigPayload,
  configFieldInitialValue,
  secretConfigured,
  type ConfigValue,
} from './plugin-config-form-model.js'
import { deepLinkSelection, fallbackSelection, shouldSyncSelectionToStore } from './list-modal-selection.js'

function initialFormValues(config: PluginConfigResponse): Record<string, ConfigValue> {
  const init: Record<string, ConfigValue> = {}
  for (const [key, schema] of Object.entries(config.schema ?? {})) {
    init[key] = configFieldInitialValue(schema, config.values?.[key])
  }
  return init
}

/** 按 schema 自动生成的插件配置表单。secret 空串=保持已存密钥（见 form-model 契约）。 */
function PluginConfigForm({
  pluginId,
  config,
  onSaved,
}: {
  pluginId: string
  config: PluginConfigResponse
  onSaved: () => void
}) {
  const store = useHelmStore()
  const entries = Object.entries(config.schema ?? {})
  const [values, setValues] = useState<Record<string, ConfigValue>>(() => initialFormValues(config))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

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
      // 仅提交有改动的 secret；未改动的密钥字段省略，服务端保持原值。
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

  return (
    <div className="flex-col">
      <div className="config-fields flex-col">
        {entries.map(([key, schema]) => {
          const fieldId = `helm-plugin-config-${pluginId}-${key}`
          return (
            <div key={key} className="form-grid">
              <label htmlFor={fieldId} className="form-grid-label">
                {schema.secret === true && <HelmIcon name="lock" size={11} />}
                {schema.label ?? key}
                {schema.required && <span className="text-err">*</span>}
              </label>
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
                />
              )}
            </div>
          )
        })}
      </div>
      {error && (
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{error}</span>
        </div>
      )}
      <div>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          <HelmIcon name={saved ? 'check' : 'check'} size={12} />
          {saved ? '已保存' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

export function PluginSettingsModal({
  initialPluginId,
  onClose,
}: {
  initialPluginId?: string
  onClose: () => void
}) {
  const store = useHelmStore()
  const [selectedId, setSelectedId] = useState<string | null>(initialPluginId ?? store.plugins[0]?.id ?? null)
  const [config, setConfig] = useState<(PluginConfigResponse & { pluginId: string }) | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 请求代数守卫：快速切换插件时旧响应（慢返回）不得写入新插件的配置视图。
  const configGeneration = useRef(0)

  const plugin = store.plugins.find((p) => p.id === selectedId)
  // 同插件多 settings.panel：全部渲染（groupedUi 已按 order ?? 100 升序稳定排序），
  // 每个面板独立 PluginUiView 挂载，互不干扰；切换/停用插件时随 groupedUi 增量更新。
  const settingsPanels = store.groupedUi.settingsPanels.filter((p) => p.pluginId === selectedId)

  // store 引用快照：effect 只依赖插件列表与选中，不因无关 SSE 帧重跑。
  const storeRef = useRef(store)
  storeRef.current = store
  // 外部深链（URL 前进/后退）切换插件：本地跟随、作废在途配置加载，但不写回 store（防回环）。
  const initialPluginIdRef = useRef(initialPluginId)
  useEffect(() => {
    if (initialPluginId === initialPluginIdRef.current) return
    initialPluginIdRef.current = initialPluginId
    const next = deepLinkSelection(selectedId, initialPluginId)
    if (next === null) return
    setSelectedId(next)
    configGeneration.current += 1
    setConfig(null)
    setLoadingConfig(true)
    setError(null)
  }, [initialPluginId, selectedId])

  // 列表兑底：plugins 为空（快照未到）时保留深链 initialPluginId；列表到达后若选中项
  // 不在其中（插件已卸载），回退首项不留悬空选中。兑底属本地决策，经守卫写回。
  useEffect(() => {
    if (storeRef.current.plugins.length === 0) return
    const next = fallbackSelection(selectedId, storeRef.current.plugins.map((p) => p.id))
    if (next === null) return
    setSelectedId(next)
    if (shouldSyncSelectionToStore(storeRef.current.activeModal, 'plugin-settings', next)) {
      storeRef.current.setActiveModal({ kind: 'plugin-settings', pluginId: next })
    }
  }, [store.plugins, selectedId])

  const reloadConfig = async (id: string) => {
    const generation = ++configGeneration.current
    setLoadingConfig(true)
    setError(null)
    try {
      const result = await pluginsApi.getConfig(id)
      if (configGeneration.current !== generation) return
      setConfig({ ...result, pluginId: id })
  } catch (err) {
      if (configGeneration.current !== generation) return
      setConfig(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (configGeneration.current === generation) setLoadingConfig(false)
    }
  }

  useEffect(() => {
    if (selectedId) void reloadConfig(selectedId)
    else setConfig(null)
  }, [selectedId])

  const selectPlugin = (id: string) => {
    // 同步进入加载态：点击到 effect 生效之间不闪现旧插件的可保存表单。
    setSelectedId(id)
    if (shouldSyncSelectionToStore(store.activeModal, 'plugin-settings', id)) {
      store.setActiveModal({ kind: 'plugin-settings', pluginId: id })
    }
    setLoadingConfig(true)
    setConfig(null)
    setError(null)
  }

  const toggleEnabled = async () => {
    if (!plugin || toggling) return
    setToggling(true)
    setError(null)
    try {
      if (plugin.enabled) {
        await pluginsApi.disable(plugin.id)
      } else {
        await pluginsApi.enable(plugin.id)
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setError(`停用失败：插件存在在途任务（${err.code}）。请等待任务结束或中止后再试。`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setToggling(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal"
            style={{ maxWidth: 860 }}
            aria-label="插件与设置"
          >
            <div className="modal-header">
              <DialogTitle className="modal-title flex-row">
                <HelmIcon name="settings" size={15} />
                插件与设置
              </DialogTitle>
              <DialogClose asChild>
                <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                  <HelmIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>
            <div className="modal-body asset-modal-body">
          <div className="list asset-modal-list">
            {store.plugins.length === 0 && (
              <div className="empty-state empty-state-compact">暂无已加载插件</div>
            )}
            {store.plugins.map((p: PluginSummary) => {
              const isSelected = selectedId === p.id
              return (
                <button
                  key={p.id}
                  className={`list-item-btn${isSelected ? ' is-active' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => selectPlugin(p.id)}
                >
                  <span className="list-item-btn-title">
                    <span className="flex-row">
                      {p.name || p.id}
                      {p.locked && <HelmIcon name="lock" size={11} />}
                    </span>
                  </span>
                  <span className="mono text-muted">{p.id}</span>
                  <span>
                    {p.enabled ? (
                      <span className="badge badge-ok">
                        <HelmIcon name="check" size={10} />
                        已启用
                      </span>
                    ) : (
                      <span className="badge badge-neutral">已停用</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="asset-modal-main">
            {!plugin && (
              <div className="empty-state">
                选择左侧插件查看详情
              </div>
            )}
            {plugin && (
              <>
                <section className="section-flat">
                  <div
                    className="plugin-card-header"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      className="plugin-card-meta"
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
                        {plugin.name || plugin.id}
                      </span>
                      <span className="mono text-muted nowrap">{plugin.id}</span>
                      {plugin.version && (
                        <span className="badge badge-neutral nowrap">
                          v{plugin.version}
                        </span>
                      )}
                      {plugin.locked && (
                        <span className="badge badge-warn" style={{ whiteSpace: 'nowrap' }}>
                          <HelmIcon name="lock" size={10} />
                          常驻核心插件，不可停用
                        </span>
                      )}
                    </div>
                    <button
                      className={`btn btn-sm ${plugin.enabled ? 'btn' : 'btn-primary'}`}
                      style={{ flexShrink: 0 }}
                      disabled={plugin.locked || toggling}
                      onClick={() => void toggleEnabled()}
                    >
                      {plugin.enabled ? (
                        <>
                          <HelmIcon name="square" size={12} />
                          停用插件
                        </>
                      ) : (
                        <>
                          <HelmIcon name="play" size={12} />
                          启用插件
                        </>
                      )}
                    </button>
                  </div>
                  <div className="flex-row-wrap text-muted">
                    {plugin.hooks.length > 0 && (
                      <span className="badge badge-neutral">Hooks: {plugin.hooks.join(', ')}</span>
                    )}
                    {plugin.actions.length > 0 && (
                      <span className="badge badge-neutral tabular-nums">Actions: {plugin.actions.length}</span>
                    )}
                    {plugin.tools.length > 0 && (
                      <span className="badge badge-neutral tabular-nums">Tools: {plugin.tools.length}</span>
                    )}
                  </div>
                </section>

                {error && (
                  <div className="jr-callout jr-callout-err" role="alert">
                    <HelmIcon name="alert-circle" size={13} />
                    <span className="selectable">{error}</span>
                  </div>
                )}

                <section className="section-flat">
                  <h4 className="section-flat-title">配置项</h4>
                  {/* 加载完成前不渲染表单：避免旧插件配置残留在新插件下可被保存。 */}
                  {loadingConfig ? (
                    <div className="flex-row text-muted">
                      <HelmIcon name="loader" size={13} />
                      正在读取配置...
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
                </section>

                {settingsPanels.length > 0 && (
                  <section className="section-flat">
                    <h4 className="section-flat-title flex-row">
                      <HelmIcon name="sliders" size={13} />
                      {settingsPanels.length > 1 ? `插件面板（${settingsPanels.length}）` : (settingsPanels[0]!.spec.label || '插件面板')}
                    </h4>
                    {settingsPanels.map((panel) => (
                      <div key={`${panel.pluginId}/${panel.spec.id}`} className="plugin-settings-panels">
                        {settingsPanels.length > 1 && (
                          <div className="plugin-settings-panel-title">{panel.spec.label || panel.spec.id}</div>
                        )}
                        <PluginUiView
                          pluginId={plugin.id}
                          spec={panel.spec}
                          label={`设置面板 ${panel.spec.id}`}
                        />
                      </div>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
