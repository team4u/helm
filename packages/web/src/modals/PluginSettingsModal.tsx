import { useEffect, useRef, useState } from 'react'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { HelmSpecView } from '../ui/HelmSpecView.js'
import {
  buildPluginConfigPayload,
  configFieldInitialValue,
  secretConfigured,
  type ConfigValue,
} from './plugin-config-form-model.js'

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
    return <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>该插件未声明配置项。</div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="config-fields" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map(([key, schema]) => {
          const fieldId = `helm-plugin-config-${pluginId}-${key}`
          return (
            <div key={key} style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '6px 12px', alignItems: 'center' }}>
              <label htmlFor={fieldId} style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                {schema.secret === true && <HelmIcon name="lock" size={11} />}
                {schema.label ?? key}
                {schema.required && <span style={{ color: 'var(--err)' }}>*</span>}
              </label>
              {schema.type === 'boolean' ? (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input
                    id={fieldId}
                    type="checkbox"
                    checked={values[key] === true}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.checked }))}
                  />
                  {values[key] === true ? '开启' : '关闭'}
                </label>
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
  const settingsPanel = store.groupedUi.settingsPanels.find((p) => p.pluginId === selectedId)

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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 860 }}
        role="dialog"
        aria-modal="true"
        aria-label="插件与设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="settings" size={15} />
            插件与设置
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭" onClick={onClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body asset-modal-body" style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
          <div className="list asset-modal-list" style={{ width: 230, minWidth: 230, overflowY: 'auto' }}>
            {store.plugins.length === 0 && (
              <div className="row" style={{ color: 'var(--fg-subtle)' }}>暂无已加载插件</div>
            )}
            {store.plugins.map((p: PluginSummary) => (
              <button
                key={p.id}
                className="row"
                aria-pressed={selectedId === p.id}
                style={{
                  width: '100%',
                  background: selectedId === p.id ? 'var(--bg-active)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3,
                }}
                onClick={() => selectPlugin(p.id)}
              >
                <span style={{ fontWeight: 500, fontSize: 12.5, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  {p.name || p.id}
                  {p.locked && <HelmIcon name="lock" size={11} />}
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{p.id}</span>
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
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!plugin && (
              <div style={{ color: 'var(--fg-subtle)', fontSize: 12.5, padding: '24px 0', textAlign: 'center' }}>
                选择左侧插件查看详情
              </div>
            )}
            {plugin && (
              <>
                <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{plugin.name || plugin.id}</span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{plugin.id}</span>
                      {plugin.version && <span className="badge badge-neutral">v{plugin.version}</span>}
                      {plugin.locked && (
                        <span className="badge badge-warn">
                          <HelmIcon name="lock" size={10} />
                          常驻核心插件，不可停用
                        </span>
                      )}
                    </span>
                    <button
                      className={`btn btn-sm ${plugin.enabled ? 'btn-danger' : 'btn-primary'}`}
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
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--fg-muted)' }}>
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

                <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 12.5 }}>配置项</h4>
                  {/* 加载完成前不渲染表单：避免旧插件配置残留在新插件下可被保存。 */}
                  {loadingConfig ? (
                    <div style={{ color: 'var(--fg-muted)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
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
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>配置读取失败或未声明。</div>
                  )}
                </section>

                {settingsPanel && (
                  <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <h4 style={{ margin: 0, fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <HelmIcon name="sliders" size={13} />
                      {settingsPanel.spec.label || '插件面板'}
                    </h4>
                    <HelmSpecView
                      pluginId={plugin.id}
                      spec={settingsPanel.spec.json}
                      docs={settingsPanel.spec.docs}
                    />
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
