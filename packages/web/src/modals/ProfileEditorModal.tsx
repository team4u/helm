import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile, ProfileRuntime } from '@helm/protocol'
import { ApiClientError, assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

type EditorTab = 'basic' | 'system' | 'memory'

interface EnvPair {
  key: string
  value: string
}

const COMMON_HERDR_AGENTS = ['pi', 'claude', 'codex', 'agy', 'gemini', 'cursor', 'opencode', 'gemini-cli']

function isValidProfileId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id)
}

function tagsToText(tags: string[] | undefined): string {
  return (tags ?? []).join(', ')
}

function textToTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function envToPairs(env: Record<string, string> | undefined): EnvPair[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
}

function pairsToEnv(pairs: EnvPair[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const p of pairs) {
    const k = p.key.trim()
    if (k) env[k] = p.value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/** 左侧 Profile 列表。 */
function ProfileListPanel({
  profiles,
  selectedId,
  onSelect,
  onCreate,
}: {
  profiles: Profile[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <button className="btn btn-primary btn-sm" onClick={onCreate}>
        <HelmIcon name="plus" size={13} />
        新建 Profile
      </button>
      <div className="list">
        {profiles.length === 0 && <div className="row" style={{ color: 'var(--fg-subtle)' }}>暂无 Profile</div>}
        {profiles.map((p) => (
          <button
            key={p.id}
            className="row"
            style={{
              width: '100%',
              background: selectedId === p.id ? 'var(--bg-active)' : 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
            }}
            onClick={() => onSelect(p.id)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 500, fontSize: 12.5 }}>{p.name || p.id}</span>
              {p.runtime?.kind === 'herdr' && (
                <span className="badge badge-accent">
                  <HelmIcon name="terminal" size={10} />
                  herdr
                </span>
              )}
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {p.id}
              {p.model ? ` / ${p.model}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Tab 1：基础与 Herdr 运行时。 */
function ProfileBasicTab({
  draft,
  setDraft,
  isNew,
  models,
}: {
  draft: Profile
  setDraft: (next: Profile) => void
  isNew: boolean
  models: Array<{ id: string; label?: string }>
}) {
  const [runtimeEnabled, setRuntimeEnabled] = useState(draft.runtime !== undefined)
  const [envPairs, setEnvPairs] = useState<EnvPair[]>(envToPairs(draft.runtime?.env))
  const runtime = draft.runtime

  useEffect(() => {
    setRuntimeEnabled(draft.runtime !== undefined)
    setEnvPairs(envToPairs(draft.runtime?.env))
  }, [draft.id, draft.runtime])

  const patchRuntime = (patch: Partial<ProfileRuntime>) => {
    const base: ProfileRuntime = runtime ?? { kind: 'herdr', agent: '' }
    setDraft({ ...draft, runtime: { ...base, ...patch } })
  }

  const modelOptions = models.map((m) => m.id)
  const modelKnown = !draft.model || modelOptions.includes(draft.model)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 12px', alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>ID</label>
        <input
          className="input mono"
          value={draft.id}
          disabled={!isNew}
          placeholder="小写字母、数字与连字符"
          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
        />
        <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>展示名</label>
        <input
          className="input"
          value={draft.name ?? ''}
          placeholder="如：个人助理"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>模型</label>
        <span style={{ display: 'flex', gap: 6 }}>
          <input
            className="input mono"
            style={{ flex: 1 }}
            list="helm-model-options"
            value={draft.model ?? ''}
            placeholder="provider/model，留空继承全局默认"
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
          <datalist id="helm-model-options">
            {modelOptions.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {!modelKnown && <span className="badge badge-warn">自定义</span>}
        </span>
        <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Tags</label>
        <input
          className="input mono"
          value={tagsToText(draft.tags)}
          placeholder="逗号分隔，如 worker, coder"
          onChange={(e) => setDraft({ ...draft, tags: textToTags(e.target.value) })}
        />
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={runtimeEnabled}
            onChange={(e) => {
              const enabled = e.target.checked
              setRuntimeEnabled(enabled)
              if (enabled && !draft.runtime) {
                setDraft({ ...draft, runtime: { kind: 'herdr', agent: '' } })
              } else if (!enabled) {
                setDraft({ ...draft, runtime: undefined })
              }
            }}
          />
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>
            <HelmIcon name="terminal" size={13} /> 外部 Herdr 运行时
          </span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>（可选）作为 subagent 时绑定 Herdr CLI</span>
        </label>

        {runtimeEnabled && runtime && (
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 12px', alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Agent</label>
            <input
              className="input mono"
              list="helm-herdr-agents"
              value={runtime.agent}
              placeholder="如 pi / claude / codex / agy"
              onChange={(e) => patchRuntime({ agent: e.target.value })}
            />
            <datalist id="helm-herdr-agents">
              {COMMON_HERDR_AGENTS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Machine</label>
            <input
              className="input mono"
              value={runtime.machine ?? ''}
              placeholder="SSH 远端机器名，留空为本机"
              onChange={(e) => patchRuntime({ machine: e.target.value })}
            />
            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Workspace</label>
            <input
              className="input mono"
              value={runtime.workspace ?? ''}
              placeholder="绑定工作目录绝对路径"
              onChange={(e) => patchRuntime({ workspace: e.target.value })}
            />
            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Args</label>
            <input
              className="input mono"
              value={(runtime.args ?? []).join(' ')}
              placeholder="额外 CLI 参数，空格分隔"
              onChange={(e) => {
                const args = e.target.value.split(/\s+/).filter((s) => s.length > 0)
                patchRuntime({ args })
              }}
            />
          </div>
        )}

        {runtimeEnabled && runtime && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              环境变量（仅非机密项；API Key 请使用凭据库）
            </span>
            {envPairs.map((pair, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  placeholder="KEY"
                  value={pair.key}
                  onChange={(e) => {
                    const next = [...envPairs]
                    next[idx] = { ...pair, key: e.target.value }
                    setEnvPairs(next)
                    patchRuntime({ env: pairsToEnv(next) })
                  }}
                />
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  placeholder="VALUE"
                  value={pair.value}
                  onChange={(e) => {
                    const next = [...envPairs]
                    next[idx] = { ...pair, value: e.target.value }
                    setEnvPairs(next)
                    patchRuntime({ env: pairsToEnv(next) })
                  }}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const next = envPairs.filter((_, i) => i !== idx)
                    setEnvPairs(next)
                    patchRuntime({ env: pairsToEnv(next) })
                  }}
                >
                  <HelmIcon name="x" size={12} />
                </button>
              </div>
            ))}
            <button
              className="btn btn-sm"
              style={{ width: 'fit-content' }}
              onClick={() => setEnvPairs((prev) => [...prev, { key: '', value: '' }])}
            >
              <HelmIcon name="plus" size={12} />
              添加变量
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function ProfileEditorModal({
  initialProfileId,
  onClose,
}: {
  initialProfileId?: string
  onClose: () => void
}) {
  const store = useHelmStore()
  const [selectedId, setSelectedId] = useState<string | null>(initialProfileId ?? store.profiles[0]?.id ?? null)
  const [isNew, setIsNew] = useState(false)
  const [draft, setDraft] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<EditorTab>('basic')

  const profiles = store.profiles

  const loadDetail = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const detail = await assetsApi.getProfile(id)
      setDraft(detail)
    } catch (err) {
      setDraft(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isNew || !selectedId) return
    void loadDetail(selectedId)
  }, [selectedId, isNew, loadDetail])

  const startCreate = () => {
    setIsNew(true)
    setSelectedId(null)
    setTab('basic')
    setError(null)
    setDraft({ id: '', name: '', model: '', tags: [], system: '', memory: '' })
  }

  const selectProfile = (id: string) => {
    setIsNew(false)
    setSelectedId(id)
    setTab('basic')
    setError(null)
  }

  const reloadFromDisk = async () => {
    if (!selectedId || isNew) return
    await loadDetail(selectedId)
    store.pushNotice({
      type: 'notification',
      level: 'info',
      title: '已重新读取',
      body: `Profile ${selectedId} 已从磁盘刷新`,
    })
  }

  const save = async () => {
    if (!draft) return
    if (!isValidProfileId(draft.id)) {
      setError('Profile ID 仅允许小写字母、数字与连字符 [a-z0-9-]')
      setTab('basic')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Profile = {
        id: draft.id,
        name: draft.name || undefined,
        model: draft.model?.trim() || undefined,
        tags: draft.tags && draft.tags.length > 0 ? draft.tags : undefined,
        runtime: draft.runtime,
        system: draft.system,
        memory: draft.memory,
      }
      if (isNew) {
        const created = await assetsApi.createProfile(payload)
        setIsNew(false)
        setSelectedId(created.id)
      } else if (selectedId) {
        await assetsApi.updateProfile(selectedId, { ...payload, id: selectedId })
      }
      await store.refreshAssets()
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: 'Profile 已保存',
        body: draft.id,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!selectedId || isNew) return
    setSaving(true)
    setError(null)
    try {
      await assetsApi.deleteProfile(selectedId)
      await store.refreshAssets()
      store.pushNotice({ type: 'notification', level: 'info', title: 'Profile 已删除', body: selectedId })
      setIsNew(false)
      setSelectedId(store.profiles.find((p) => p.id !== selectedId)?.id ?? null)
      setDraft(null)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setError(`Profile 被会话占用，无法删除（${err.code}: ${err.message}）`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSaving(false)
    }
  }

  const isAssistant = useMemo(
    () => !isNew && (selectedId === 'assistant' || draft?.id === 'assistant'),
    [isNew, selectedId, draft?.id],
  )

  const tabItems: Array<{ key: EditorTab; label: string }> = [
    { key: 'basic', label: '基础与运行时' },
    { key: 'system', label: 'SYSTEM.md' },
    { key: 'memory', label: 'MEMORY.md' },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 860 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="bot" size={15} />
            角色 Profile 编辑器
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body" style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
          <div style={{ width: 210, minWidth: 210, overflowY: 'auto' }}>
            <ProfileListPanel
              profiles={profiles}
              selectedId={isNew ? null : selectedId}
              onSelect={selectProfile}
              onCreate={startCreate}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="tabs-bar">
              {tabItems.map((t) => (
                <button
                  key={t.key}
                  className={`tab-btn${tab === t.key ? ' tab-btn-active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 280, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {error && (
                <div className="jr-callout jr-callout-err" role="alert">
                  <HelmIcon name="alert-circle" size={14} />
                  <span className="selectable">{error}</span>
                </div>
              )}
              {loading && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <HelmIcon name="loader" size={13} />
                  正在读取 Profile 详情...
                </div>
              )}
              {!loading && !draft && !isNew && (
                <div style={{ color: 'var(--fg-subtle)', fontSize: 12.5, padding: '24px 0', textAlign: 'center' }}>
                  选择左侧 Profile 或新建一个
                </div>
              )}
              {!loading && draft && tab === 'basic' && (
                <ProfileBasicTab draft={draft} setDraft={setDraft} isNew={isNew} models={store.models} />
              )}
              {!loading && draft && tab === 'system' && (
                <textarea
                  className="textarea mono selectable"
                  style={{ minHeight: 320, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
                  spellCheck={false}
                  value={draft.system ?? ''}
                  placeholder="该角色的系统提示词全文（SYSTEM.md）"
                  onChange={(e) => setDraft({ ...draft, system: e.target.value })}
                />
              )}
              {!loading && draft && tab === 'memory' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm" disabled={isNew} onClick={() => void reloadFromDisk()}>
                      <HelmIcon name="rotate-ccw" size={12} />
                      重新从磁盘读取
                    </button>
                  </div>
                  <textarea
                    className="textarea mono selectable"
                    style={{ minHeight: 280, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
                    spellCheck={false}
                    value={draft.memory ?? ''}
                    placeholder="该角色的长期记忆全文（MEMORY.md）"
                    onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--fg-muted)' }}>
            {isAssistant ? 'assistant 为默认 Profile，不可删除' : isNew ? '新建 Profile' : `正在编辑 ${selectedId}`}
          </span>
          <button
            className="btn btn-danger"
            disabled={isAssistant || isNew || !selectedId || saving}
            onClick={() => void remove()}
          >
            <HelmIcon name="trash-2" size={13} />
            删除 Profile
          </button>
          <button className="btn btn-primary" disabled={saving || !draft} onClick={() => void save()}>
            <HelmIcon name="check" size={13} />
            保存修改
          </button>
        </div>
      </div>
    </div>
  )
}
