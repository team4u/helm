import { useEffect, useState } from 'react'
import type { ProviderConfig } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { ProviderCatalog } from './ProviderCatalog.js'
import { Select } from '../ui/Select.js'
import { Switch } from '../ui/Switch.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs.js'
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
            <label className="provider-field">协议
              <Select
                value={provider.protocol}
                disabled={saving}
                options={[
                  { value: 'openai', label: 'OpenAI 兼容' },
                  { value: 'anthropic', label: 'Anthropic 兼容' },
                ]}
                onChange={(event) => patch(index, { protocol: event.target.value as 'openai' | 'anthropic' })}
              />
            </label>
            <label className="provider-field">状态<span className="provider-gateway-toggle"><Switch checked={provider.enabled} onChange={(enabled) => patch(index, { enabled })} disabled={saving} label={provider.enabled ? '已启用' : '已停用'} /></span></label>
            <label className="provider-field provider-gateway-url">Base URL<input className="input mono" placeholder="https://api.example.com/v1" value={provider.baseUrl} onChange={(event) => patch(index, { baseUrl: event.target.value })} disabled={saving} /></label>
          </div>
          <label className="provider-field">模型 ID<textarea className="textarea mono" rows={3} placeholder="每行一个模型 ID，或使用逗号分隔" value={provider.modelText} onChange={(event) => patch(index, { modelText: event.target.value })} disabled={saving} /></label>
          <button className="btn btn-sm btn-danger" aria-label={`删除网关 ${provider.id}`} onClick={() => removeProvider(index)} disabled={saving}><HelmIcon name="trash-2" size={12} />删除网关</button>
        </div>
      ))}
      {!list.length && (
        <div className="empty-state provider-empty-gateway">
          <div className="empty-state-icon"><HelmIcon name="network" size={24} /></div>
          <h4 className="empty-state-title">无需重复配置内置供应商</h4>
          <p className="provider-help">使用自建服务或代理网关时，再添加自定义地址。</p>
        </div>
      )}
      {error && <div className="jr-callout jr-callout-err" role="alert"><HelmIcon name="alert-circle" size={13} /><span className="selectable">{error}</span></div>}
      <div className="provider-gateway-actions"><button className="btn" onClick={addProvider} disabled={saving}><HelmIcon name="plus" size={13} />新增网关</button><button className="btn btn-primary" disabled={saving || !dirty} onClick={() => void saveAll()}><HelmIcon name="check" size={13} />{saving ? '保存中…' : '保存网关配置'}</button>{dirty && <span className="provider-help" style={{ color: 'var(--warn)' }}>有未保存的修改</span>}</div>
    </section>
  )
}

/** 全局默认模型与思考档位（config.json.model / thinkingLevel）：会话继承链的最后一层。 */
function DefaultsSection() {
  const store = useHelmStore()
  const [model, setModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void assetsApi.getDefaultModel().then((result) => {
      if (!cancelled) { setModel(result.defaultModel); setThinkingLevel(result.defaultThinkingLevel); setLoaded(true) }
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [])

  const selected = store.models.find((entry) => entry.id === model)
  const levelOptions = selected?.thinkingLevels ?? ['off']

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      // 在保存前提示当前模型的目录限制。
      if (thinkingLevel !== '' && model !== '' && !levelOptions.includes(thinkingLevel)) {
        throw new Error(`模型 ${model} 不支持思考档位 ${thinkingLevel}（支持：${levelOptions.join(' / ')}）`)
      }
      const result = await assetsApi.setDefaultModel(model, thinkingLevel)
      setModel(result.defaultModel)
      setThinkingLevel(result.defaultThinkingLevel)
      await store.refreshAssets()
      store.pushNotice({ type: 'notification', level: 'info', title: '全局默认已保存', body: result.defaultModel || '已清除全局默认模型' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="provider-defaults" aria-label="全局默认模型">
      <div className="provider-defaults-intro">
        <h3>全局默认模型</h3>
        <p className="provider-help">新会话的继承链：会话临时覆盖 &gt; Profile 模型 &gt; 此处全局默认。切换后对所有未显式覆盖模型的会话即时生效。</p>
      </div>
      <div className="provider-defaults-fields">
        <label className="provider-field">默认模型
          <Select
            aria-label="全局默认模型"
            disabled={!loaded || saving}
            value={model}
            options={[
              { value: '', label: '未设置（未配置模型的会话无法回复）' },
              ...store.models.filter((entry) => entry.available).map((entry) => ({
                value: entry.id,
                label: entry.id,
              })),
              ...(model !== '' && !store.models.some((entry) => entry.id === model && entry.available)
                ? [{ value: model, label: `${model}（目录外）` }]
                : []),
            ]}
            onChange={(event) => {
              const nextModel = event.target.value
              const nextLevels = store.models.find((entry) => entry.id === nextModel)?.thinkingLevels ?? ['off']
              setModel(nextModel)
              if (thinkingLevel !== '' && !nextLevels.includes(thinkingLevel)) setThinkingLevel('')
            }}
          />
        </label>
        <label className="provider-field">默认思考档位
          <Select
            aria-label="全局默认思考档位"
            disabled={!loaded || saving}
            value={thinkingLevel}
            options={[
              { value: '', label: '跟随 SDK 缺省' },
              ...levelOptions.map((level) => ({ value: level, label: level })),
            ]}
            onChange={(event) => setThinkingLevel(event.target.value)}
          />
        </label>
      </div>
      {model !== '' && levelOptions.length <= 1 && <p className="provider-help">所选模型不支持思考档位。</p>}
      {error && <div className="jr-callout jr-callout-err" role="alert"><HelmIcon name="alert-circle" size={13} /><span className="selectable">{error}</span></div>}
      <div className="provider-defaults-actions">
        <button className="btn btn-primary" disabled={!loaded || saving} onClick={() => void save()}><HelmIcon name={saving ? 'loader' : 'check'} size={13} />{saving ? '保存中…' : '保存全局默认'}</button>
      </div>
    </section>
  )
}

export function ProviderAuthModal({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<'providers' | 'gateways' | 'defaults'>('providers')

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal provider-modal"
            aria-labelledby="provider-modal-title"
          >
            <div className="modal-header">
              <DialogTitle asChild>
                <span className="modal-title flex-row" id="provider-modal-title">
                  <HelmIcon name="cpu" size={16} />
                  模型供应商
                </span>
              </DialogTitle>
              <DialogClose asChild>
                <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                  <HelmIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>
            <Tabs value={view} onValueChange={(val) => setView(val as 'providers' | 'gateways' | 'defaults')} variant="underline">
              <TabsList asChild>
                <nav className="tabs-bar provider-tabs" aria-label="模型配置分类">
                  <TabsTrigger value="providers" className="tab-btn">供应商</TabsTrigger>
                  <TabsTrigger value="gateways" className="tab-btn">自定义网关</TabsTrigger>
                  <TabsTrigger value="defaults" className="tab-btn">全局模型</TabsTrigger>
                  <span className="provider-tabs-note">由 PI 原生模块提供</span>
                </nav>
              </TabsList>
            </Tabs>
            {view === 'providers' && <ProviderCatalog onEditGateway={() => setView('gateways')} />}
            <div className="provider-gateway-panel" hidden={view !== 'gateways'}><ProvidersSection /></div>
            <div className="provider-gateway-panel" hidden={view !== 'defaults'}><DefaultsSection /></div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
