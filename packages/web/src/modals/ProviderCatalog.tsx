import { useEffect, useMemo, useState } from 'react'
import type { ModelProviderSummary } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { HelmSpecView } from '../ui/HelmSpecView.js'
import { buildProviderEntries, filterProviderEntries, type ProviderEntry, type ProviderFilter } from './provider-auth-model.js'

function ProviderDetail({
  provider,
  onEditGateway,
  onRefreshCatalog,
  onBack,
}: {
  provider: ProviderEntry | null
  onEditGateway(): void
  onRefreshCatalog(): void
  onBack(): void
}) {
  const store = useHelmStore()
  const [customId, setCustomId] = useState('')
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const activeId = provider?.id ?? customId.trim()
  const supportsKey = !provider || provider.authMethods.some((method) => method.type === 'api_key')
  const supportsOAuth = provider?.authMethods.some((method) => method.type === 'oauth')
  const modelList = store.models.filter((model) => model.provider === activeId && model.modelId.toLowerCase().includes(modelQuery.trim().toLowerCase()))
  // 通用插件联动：任何插件注册的供应商都自动内联其 settingsPanels，零插件名硬编码。
  const owningPlugin = store.plugins.find((plugin) => plugin.id === provider?.pluginId)
  const pluginPanels = provider?.pluginId ? store.groupedUi.settingsPanels.filter((panel) => panel.pluginId === provider.pluginId) : []

  const refreshCatalog = async () => {
    if (!provider) return
    setRefreshing(true)
    setError(null)
    try {
      const res = await assetsApi.refreshModels([provider.id])
      await store.refreshAssets()
      onRefreshCatalog()
      const refreshError = res.errors?.[provider.id]
      if (refreshError) setError(refreshError)
      else if (res.aborted) setError('模型目录刷新已取消，请重试。')
      else store.pushNotice({ type: 'notification', level: 'info', title: '模型目录已刷新', body: `${provider.name} 已重新拉取最新模型目录` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setRefreshing(false) }
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!activeId || !value.trim()) {
      setError('请填写供应商 ID 与 API Key')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await assetsApi.setCredential(activeId, value.trim())
      setValue('')
      setVisible(false)
      await store.refreshAssets()
      store.pushNotice({ type: 'notification', level: 'info', title: '密钥已保存', body: `${activeId} 的新凭据已生效` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!window.confirm(`删除 ${activeId} 的已存密钥？环境变量中的凭据不会被删除。`)) return
    setBusy(true)
    setError(null)
    try {
      await assetsApi.deleteCredential(activeId)
      setValue('')
      setVisible(false)
      await store.refreshAssets()
      store.pushNotice({ type: 'notification', level: 'info', title: '密钥已删除', body: `${activeId} 已移除本地凭据` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <section className="provider-detail" aria-label="供应商配置" aria-busy={busy || refreshing}>
      <button
        className="btn btn-ghost btn-sm provider-mobile-back"
        type="button"
        onClick={onBack}
        aria-label="返回供应商列表"
      >
        <HelmIcon name="arrow-left" size={14} />
        返回供应商列表
      </button>
      <div className="provider-detail-heading">
        <div className="provider-avatar"><HelmIcon name={provider?.custom ? 'network' : 'cpu'} size={21} /></div>
        <div className="provider-heading-copy">
          <h3>{provider?.name ?? '按 ID 配置凭据'}</h3>
          <span className="mono provider-muted">{provider?.id ?? '适用于自定义网关或已有凭据 ID'}</span>
        </div>
        {provider?.available && <span className="badge badge-ok">可用</span>}
      </div>

      {provider && (
        <div className="provider-meta">
          <span className="badge badge-neutral">{provider.custom ? '自定义网关' : '供应商目录'}</span>
          {provider.dynamic && <span className="badge badge-neutral">动态目录</span>}
          {provider.baseUrl && <span className="badge badge-neutral mono" title="供应商网关地址">{provider.baseUrl}</span>}
          <span className="badge badge-neutral">{provider.modelCount} 个模型</span>
          {provider.authMethods.map((method) => <span key={method.type} className="badge badge-neutral" title={method.label}>{method.type === 'oauth' ? 'OAuth' : 'API Key / 环境配置'}</span>)}
        </div>
      )}

      {provider?.hasStoredKey ? (
        <div className="provider-status"><HelmIcon name="lock" size={14} /><span>本地密钥已保存，不回显明文。{!provider.available && '当前尚不可用，请检查该供应商需要的环境配置。'}</span></div>
      ) : provider?.available ? (
        <div className="provider-status"><HelmIcon name="check-circle" size={14} /><span>此供应商已具备请求所需的认证配置，无需重复保存密钥。</span></div>
      ) : null}

      {supportsKey && !provider?.pluginId ? (
        <form className="provider-credential-form" onSubmit={(event) => void save(event)}>
          {!provider && <label className="provider-field">供应商 ID<input className="input mono" aria-label="供应商 ID" placeholder="与网关 ID 保持一致" value={customId} onChange={(event) => setCustomId(event.target.value)} disabled={busy} /></label>}
          <label className="provider-field">
            {provider?.hasStoredKey ? '替换 API Key' : 'API Key'}
            <span className="provider-secret-input">
              <input className="input mono" type={visible ? 'text' : 'password'} aria-label="API Key" autoComplete="new-password" placeholder={provider?.hasStoredKey ? '输入新密钥以替换，留空不会修改' : '输入此供应商的 API Key'} value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} />
              <button className="btn btn-ghost btn-sm" type="button" aria-label={visible ? '隐藏密钥' : '显示密钥'} aria-pressed={visible} onClick={() => setVisible((previous) => !previous)}><HelmIcon name="eye" size={14} /></button>
            </span>
          </label>
          <p className="provider-help">密钥写入本机 credentials.json（0600），不进入模型上下文。环境变量和供应商特有配置由 PI 原生模块解析。</p>
          <div className="provider-form-actions">
            <button className="btn btn-primary" type="submit" disabled={busy || !activeId || !value.trim()}><HelmIcon name={busy ? 'loader' : 'check'} size={13} />{busy ? '处理中…' : '保存密钥'}</button>
            {provider?.hasStoredKey && <button className="btn btn-sm btn-danger" type="button" disabled={busy} onClick={() => void remove()}><HelmIcon name="trash-2" size={12} />删除密钥</button>}
          </div>
        </form>
      ) : !supportsKey && !provider?.pluginId ? <div className="provider-status"><HelmIcon name="shield" size={16} /><span>此供应商仅支持 OAuth，不接受 API Key。</span></div> : null}

      {supportsOAuth && <div className="provider-help provider-oauth-note"><HelmIcon name="alert-circle" size={14} /><span>PI 提供 OAuth 模块；Helm 尚未接入交互式登录，当前不能在此完成 OAuth 授权。</span></div>}
      {provider?.custom && <button className="btn" onClick={onEditGateway}><HelmIcon name="network" size={13} />编辑网关地址与模型</button>}
      {provider?.dynamic && (
        <div className="provider-dynamic-actions">
          <button className="btn" type="button" disabled={refreshing || busy} onClick={() => void refreshCatalog()}><HelmIcon name={refreshing ? 'loader' : 'refresh-cw'} size={13} />{refreshing ? '刷新中…' : '刷新模型目录'}</button>
          <p className="provider-help">动态目录供应商支持从其网关实时拉取最新模型列表与路由信息。</p>
        </div>
      )}
      {error && <div className="jr-callout jr-callout-err" role="alert"><HelmIcon name="alert-circle" size={13} /><span className="selectable">{error}</span></div>}

      {provider?.pluginId && (
        <div className="provider-plugin-zone">
          <div className="provider-plugin-heading">
            <HelmIcon name="sliders" size={14} />
            <span>{owningPlugin?.name ?? provider.name} 提供连接配置与专属面板。</span>
            <button className="btn btn-sm" type="button" onClick={() => store.setActiveModal({ kind: 'plugin-settings', pluginId: provider.pluginId })}><HelmIcon name="settings" size={12} />插件连接设置</button>
          </div>
          {pluginPanels.map((panel) => (
            <div key={`${panel.pluginId}/${panel.spec.id}`} className="provider-plugin-panel">
              <h4><HelmIcon name="sliders" size={13} />{panel.spec.label || panel.spec.title || panel.spec.id}</h4>
              <HelmSpecView pluginId={panel.pluginId} spec={panel.spec.json} docs={panel.spec.docs} />
            </div>
          ))}
        </div>
      )}

      {provider && (provider.modelCount > 0 || provider.dynamic) && (
        <details className="provider-models">
          <summary>模型目录 <span className="provider-muted">{provider.modelCount}</span></summary>
          {provider.dynamic && provider.modelCount === 0 && <p className="provider-help">当前目录为空；请确认该供应商网关已启动，然后点击刷新模型目录。</p>}
          <input className="input" aria-label="筛选当前供应商模型" placeholder="筛选模型 ID" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} />
          <div className="provider-model-list">
            {modelList.length ? modelList.map((model) => <div className="mono" key={model.id}>{model.modelId}</div>) : <p className="provider-help">{store.models.some((model) => model.provider === activeId) ? '没有匹配的模型' : '当前无已加载模型；请检查网关是否启用或模型目录是否加载成功。'}</p>}
          </div>
        </details>
      )}
    </section>
  )
}

export function ProviderCatalog({ onEditGateway }: { onEditGateway(): void }) {
  const store = useHelmStore()
  const [catalog, setCatalog] = useState<ModelProviderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void assetsApi.listModelProviders().then((providers) => {
      if (!cancelled) setCatalog(providers)
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload, store.providers])

  const entries = useMemo(() => buildProviderEntries(catalog, store.providers, store.credentials, store.models), [catalog, store.providers, store.credentials, store.models])
  const filtered = useMemo(() => filterProviderEntries(entries, query, filter, store.models), [entries, query, filter, store.models])
  const selected = entries.find((entry) => entry.id === selectedId) ?? null
  const configuredCount = entries.filter((entry) => entry.available || entry.hasStoredKey).length

  const hasSelection = Boolean(manual || selected)

  return (
    <div className={`provider-catalog${hasSelection ? ' has-selection' : ''}`}>
      <aside className="provider-sidebar" aria-label="供应商列表">
        <div className="provider-sidebar-controls">
          <label className="provider-search"><HelmIcon name="search" size={14} /><input className="input" aria-label="搜索供应商或模型" placeholder="搜索供应商或模型…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></label>
          <div className="provider-filters" role="group" aria-label="供应商状态筛选">
            {([['all', '全部', entries.length], ['configured', '已配置', configuredCount], ['unconfigured', '待配置', entries.length - configuredCount]] as const).map(([id, label, count]) => <button key={id} className={`provider-filter${filter === id ? ' is-active' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}
          </div>
        </div>
        <div className="provider-list" aria-busy={loading}>
          {loading && <div className="provider-list-message" role="status">加载 PI 供应商目录…</div>}
          {error && <div className="provider-list-message" role="alert"><p>供应商目录加载失败</p><p className="provider-help selectable">{error}</p><button className="btn btn-sm" onClick={() => setReload((previous) => previous + 1)}>重试</button></div>}
          {!loading && !error && filtered.length === 0 && <div className="provider-list-message">没有匹配的供应商<button className="btn btn-ghost btn-sm" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</button></div>}
          {filtered.map((provider) => <button key={provider.id} className={`provider-list-item${!manual && selected?.id === provider.id ? ' is-selected' : ''}`} aria-pressed={!manual && selected?.id === provider.id} title={`${provider.name} (${provider.id})`} onClick={() => { setSelectedId(provider.id); setManual(false) }}>
            <span className="provider-list-item-copy"><strong>{provider.name}</strong><span className="mono">{provider.id}</span></span>
            <span className={`provider-list-status${provider.available ? ' is-available' : ''}`}>{provider.available ? '可用' : provider.hasStoredKey ? '已存密钥' : `${provider.modelCount} 模型`}</span>
          </button>)}
        </div>
        <div className="provider-sidebar-footer"><span>{query.trim() ? `${filtered.length} / ${entries.length} 家` : `${entries.length} 家供应商`}</span><button className="btn btn-ghost btn-sm" aria-pressed={manual} onClick={() => { setManual(true); setSelectedId(null) }}><HelmIcon name="plus" size={12} />按 ID 配置</button></div>
      </aside>
      <div className="provider-detail-scroll">
        {manual || selected ? (
          <ProviderDetail
            key={manual ? '__manual__' : selected!.id}
            provider={manual ? null : selected}
            onEditGateway={onEditGateway}
            onRefreshCatalog={() => setReload((previous) => previous + 1)}
            onBack={() => {
              setSelectedId(null)
              setManual(false)
            }}
          />
        ) : (
          <div className="provider-empty"><HelmIcon name="cpu" size={32} /><h3>选择供应商，配置模型连接</h3><p>搜索名称、供应商 ID 或模型 ID。<br />已配置的供应商优先展示，目录与协议直接来自 PI。</p><span className="provider-help">自定义代理地址请使用「自定义网关」。</span></div>
        )}
      </div>
    </div>
  )
}
