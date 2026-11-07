import { useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { ProviderCatalog } from './ProviderCatalog.js'
import './provider-auth.css'

type ProviderDraft = ProviderConfig & { modelText: string }

function providerDraft(provider: ProviderConfig): ProviderDraft {
  return { ...provider, modelText: provider.models.join('\n') }
}

function ProvidersSection() {
  const store = useHelmStore()
  const [list, setList] = useState<ProviderDraft[]>(() => store.providers.map(providerDraft))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => { if (!dirty) setList(store.providers.map(providerDraft)) }, [store.providers, dirty])

  const patch = (index: number, next: Partial<ProviderDraft>) => {
    setDirty(true)
    setList((previous) => previous.map((provider, i) => i === index ? { ...provider, ...next } : provider))
  }
  const addProvider = () => {
    setDirty(true)
    let id = 'custom-gateway'
    let n = list.length + 1
    while (list.some((provider) => provider.id === id)) id = `custom-gateway-${n++}`
    setList((previous) => [...previous, { id, protocol: 'openai', baseUrl: '', models: [], modelText: '', enabled: true }])
  }
  const removeProvider = (index: number) => {
    setDirty(true)
    setList((previous) => previous.filter((_, i) => i !== index))
  }
  const saveAll = async () => {
    if (list.some((provider) => !provider.id.trim() || !provider.baseUrl.trim())) {
      setError('每个网关需填写 ID 与 Base URL')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await assetsApi.saveProviders(list.map(({ modelText, ...provider }) => ({
        ...provider,
        models: modelText.split(/[\n,]/).map((id) => id.trim()).filter(Boolean),
      })))
      await store.refreshAssets()
      setDirty(false)
      store.pushNotice({ type: 'notification', level: 'info', title: '网关配置已保存', body: `共 ${list.length} 个自定义模型网关` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  return (
    <section className="provider-gateways" aria-label="自定义模型网关">
      <div className="provider-gateway-intro"><h3>自定义模型网关</h3><p className="provider-help">PI 内置供应商无需在此重复添加。仅在使用代理地址或兼容服务时新增网关；密钥使用相同 ID，在「供应商」中配置。</p></div>
      {list.map((provider, index) => (
        <div key={index} className="card provider-gateway-card">
          <div className="provider-gateway-fields">
            <label className="provider-field">ID<input className="input mono" value={provider.id} onChange={(event) => patch(index, { id: event.target.value })} disabled={saving} /></label>
            <label className="provider-field">展示名<input className="input" placeholder="可选" value={provider.label ?? ''} onChange={(event) => patch(index, { label: event.target.value })} disabled={saving} /></label>
            <label className="provider-field">协议<select className="select" value={provider.protocol} onChange={(event) => patch(index, { protocol: event.target.value as 'openai' | 'anthropic' })} disabled={saving}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></label>
            <label className="provider-field">状态<span className="provider-gateway-toggle"><input type="checkbox" checked={provider.enabled} onChange={(event) => patch(index, { enabled: event.target.checked })} disabled={saving} />{provider.enabled ? '已启用' : '已停用'}</span></label>
            <label className="provider-field provider-gateway-url">Base URL<input className="input mono" placeholder="https://api.example.com/v1" value={provider.baseUrl} onChange={(event) => patch(index, { baseUrl: event.target.value })} disabled={saving} /></label>
          </div>
          <label className="provider-field">模型 ID<textarea className="textarea mono" rows={3} placeholder="每行一个模型 ID，或使用逗号分隔" value={provider.modelText} onChange={(event) => patch(index, { modelText: event.target.value })} disabled={saving} /></label>
          <button className="btn btn-sm btn-danger" aria-label={`删除网关 ${provider.id}`} onClick={() => removeProvider(index)} disabled={saving}><HelmIcon name="trash-2" size={12} />删除网关</button>
        </div>
      ))}
      {!list.length && <div className="provider-empty provider-empty-gateway"><HelmIcon name="network" size={28} /><h3>无需重复配置内置供应商</h3><p>使用自建服务或代理网关时，再添加自定义地址。</p></div>}
      {error && <div className="jr-callout jr-callout-err" role="alert"><HelmIcon name="alert-circle" size={13} /><span className="selectable">{error}</span></div>}
      <div className="provider-gateway-actions"><button className="btn" onClick={addProvider} disabled={saving}><HelmIcon name="plus" size={13} />新增网关</button><button className="btn btn-primary" disabled={saving || !dirty} onClick={() => void saveAll()}><HelmIcon name="check" size={13} />{saving ? '保存中…' : '保存网关配置'}</button>{dirty && <span className="provider-help" style={{ color: 'var(--warn)' }}>有未保存的修改</span>}</div>
    </section>
  )
}

export function ProviderAuthModal({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<'providers' | 'gateways'>('providers')
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') ?? [])].filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus() }
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal provider-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="provider-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header"><span className="modal-title" id="provider-modal-title"><HelmIcon name="cpu" size={16} />模型供应商</span><button className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}><HelmIcon name="x" size={14} /></button></div>
        <nav className="tabs-bar provider-tabs" aria-label="模型配置分类"><button className={`tab-btn${view === 'providers' ? ' tab-btn-active' : ''}`} aria-pressed={view === 'providers'} onClick={() => setView('providers')}>供应商</button><button className={`tab-btn${view === 'gateways' ? ' tab-btn-active' : ''}`} aria-pressed={view === 'gateways'} onClick={() => setView('gateways')}>自定义网关</button><span className="provider-tabs-note">由 PI 原生模块提供</span></nav>
        {view === 'providers' && <ProviderCatalog onEditGateway={() => setView('gateways')} />}
        <div className="provider-gateway-panel" hidden={view !== 'gateways'}><ProvidersSection /></div>
      </div>
    </div>
  )
}
