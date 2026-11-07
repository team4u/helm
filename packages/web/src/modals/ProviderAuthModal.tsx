import { useEffect, useState } from 'react'
import type { ProviderConfig } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

const PRESET_CREDENTIAL_IDS = ['openai', 'anthropic', 'google', 'deepseek', 'zhipu', 'openrouter']

function newProvider(): ProviderConfig {
  return { id: '', protocol: 'openai', baseUrl: '', models: [], enabled: true }
}

function modelsToText(models: string[]): string {
  return models.join('\n')
}

function textToModels(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function CredentialsSection() {
  const store = useHelmStore()
  const [selectedId, setSelectedId] = useState<string>(PRESET_CREDENTIAL_IDS[0] ?? '')
  const [customMode, setCustomMode] = useState(false)
  const [customId, setCustomId] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeId = customMode ? customId.trim() : selectedId

  const saveCredential = async () => {
    if (!activeId || !value) {
      setError('请填写 credentialId 与 API Key')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await assetsApi.setCredential(activeId, value)
      await store.refreshAssets()
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '密钥已保存',
        body: `${activeId} 已写入 credentials.json（0600）`,
      })
      setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const deleteCredential = async (id: string) => {
    setError(null)
    try {
      await assetsApi.deleteCredential(id)
      await store.refreshAssets()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        <HelmIcon name="key" size={14} />
        API Key 机密凭据库
        <span className="badge badge-neutral">credentials.json / 0600</span>
      </h3>
      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--fg-muted)' }}>
        密钥仅存于本机凭据文件，不进入模型上下文；已保存的密钥不再回显明文。
      </p>

      <div className="list">
        {store.credentials.length === 0 && (
          <div className="row" style={{ color: 'var(--fg-subtle)' }}>尚未配置任何凭据</div>
        )}
        {store.credentials.map((cred) => (
          <div key={cred.id} className="row">
            <span className="mono" style={{ fontSize: 12.5 }}>{cred.id}</span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {cred.configured ? (
                <span className="badge badge-ok">
                  <HelmIcon name="check" size={10} />
                  已配置
                </span>
              ) : (
                <span className="badge badge-warn">未配置</span>
              )}
              <button className="btn btn-sm btn-danger" aria-label={`删除凭据 ${cred.id}`} onClick={() => void deleteCredential(cred.id)}>
                <HelmIcon name="trash-2" size={12} />
                删除
              </button>
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>常用 Provider：</span>
          {PRESET_CREDENTIAL_IDS.map((id) => {
            const configured = store.credentials.some((c) => c.id === id && c.configured)
            return (
              <button
                key={id}
                className={`badge${!customMode && selectedId === id ? ' badge-accent' : ' badge-neutral'}`}
                style={{ cursor: 'pointer', height: 24 }}
                title={configured ? '已配置' : '未配置'}
                onClick={() => {
                  setCustomMode(false)
                  setSelectedId(id)
                }}
              >
                {id}
                {configured && <HelmIcon name="check" size={10} />}
              </button>
            )
          })}
          <button
            className={`badge${customMode ? ' badge-accent' : ' badge-neutral'}`}
            style={{ cursor: 'pointer', height: 24 }}
            onClick={() => setCustomMode((v) => !v)}
          >
            自定义...
          </button>
        </div>
        {customMode && (
          <input
            className="input mono"
            placeholder="自定义 credentialId（如 my-gateway-key）"
            aria-label="自定义 credentialId"
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
          />
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input mono"
            type="password"
            style={{ flex: 1 }}
            aria-label="新 API Key"
            placeholder={`输入 ${customMode ? customId || '自定义' : selectedId} 的新 API Key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn btn-primary" disabled={saving} onClick={() => void saveCredential()}>
            <HelmIcon name="check" size={13} />
            保存密钥
          </button>
        </div>
        {error && (
          <div className="jr-callout jr-callout-err">
            <HelmIcon name="alert-circle" size={13} />
            <span className="selectable">{error}</span>
          </div>
        )}
      </div>
    </section>
  )
}

function ProvidersSection() {
  const store = useHelmStore()
  const [list, setList] = useState<ProviderConfig[]>(store.providers)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) setList(store.providers)
  }, [store.providers, dirty])

  const patch = (idx: number, next: Partial<ProviderConfig>) => {
    setDirty(true)
    setList((prev) => prev.map((p, i) => (i === idx ? { ...p, ...next } : p)))
  }

  const addProvider = () => {
    setDirty(true)
    let base = 'custom-gateway'
    let n = list.length + 1
    while (list.some((p) => p.id === base)) {
      base = `custom-gateway-${n}`
      n += 1
    }
    setList((prev) => [...prev, { ...newProvider(), id: base }])
  }

  const removeProvider = (idx: number) => {
    setDirty(true)
    setList((prev) => prev.filter((_, i) => i !== idx))
  }

  const saveAll = async () => {
    for (const p of list) {
      if (!p.id.trim() || !p.baseUrl.trim()) {
        setError('每个网关需填写 id 与 baseUrl')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      await assetsApi.saveProviders(list)
      await store.refreshAssets()
      setDirty(false)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '网关配置已保存',
        body: `共 ${list.length} 个自定义模型网关`,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        <HelmIcon name="network" size={14} />
        自定义模型网关
        <span className="badge badge-neutral">providers.json</span>
      </h3>

      {list.map((p, idx) => (
        <div key={idx} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-subtle)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr 86px 1fr', gap: '6px 10px', alignItems: 'center' }}>
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>ID</label>
            <input className="input mono" style={{ height: 27 }} value={p.id} onChange={(e) => patch(idx, { id: e.target.value })} />
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>展示名</label>
            <input
              className="input"
              style={{ height: 27 }}
              placeholder="可选"
              value={p.label ?? ''}
              onChange={(e) => patch(idx, { label: e.target.value })}
            />
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>协议</label>
            <select
              className="select"
              style={{ height: 27 }}
              value={p.protocol}
              onChange={(e) => patch(idx, { protocol: e.target.value as 'openai' | 'anthropic' }) }
            >
              <option value="openai">openai 兼容</option>
              <option value="anthropic">anthropic 兼容</option>
            </select>
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>启用</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={p.enabled} onChange={(e) => patch(idx, { enabled: e.target.checked })} />
              {p.enabled ? '已启用' : '已停用'}
            </label>
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Base URL</label>
            <input
              className="input mono"
              style={{ height: 27, gridColumn: '2 / span 3' }}
              placeholder="https://api.example.com/v1"
              value={p.baseUrl}
              onChange={(e) => patch(idx, { baseUrl: e.target.value })}
            />
          </div>
          <textarea
            className="textarea mono"
            style={{ minHeight: 52, fontSize: 12, resize: 'vertical' }}
            placeholder="模型 ID 列表（逗号或换行分隔）"
            value={modelsToText(p.models)}
            onChange={(e) => patch(idx, { models: textToModels(e.target.value) })}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-danger" aria-label={`删除网关 ${p.id}`} onClick={() => removeProvider(idx)}>
              <HelmIcon name="trash-2" size={12} />
              删除网关
            </button>
          </div>
        </div>
      ))}

      {list.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'center', padding: '8px 0' }}>
          暂无自定义网关，可点击下方新增
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={addProvider}>
          <HelmIcon name="plus" size={13} />
          新增网关
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void saveAll()}>
          <HelmIcon name="check" size={13} />
          保存全部网关配置
        </button>
        {dirty && <span style={{ fontSize: 11.5, color: 'var(--warn)', alignSelf: 'center' }}>有未保存的修改</span>}
      </div>

      {error && (
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{error}</span>
        </div>
      )}
    </section>
  )
}

export function ProviderAuthModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 760 }}
        role="dialog"
        aria-modal="true"
        aria-label="模型网关与 API Key 凭据"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="key" size={15} />
            模型网关与 API Key 凭据
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭" onClick={onClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">
          <CredentialsSection />
          <ProvidersSection />
        </div>
      </div>
    </div>
  )
}
