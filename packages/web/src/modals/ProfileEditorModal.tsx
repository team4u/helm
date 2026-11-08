import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '@helm/protocol'
import { ApiClientError, assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { collectEnabledPluginIds, isProfileVisible } from '../shell/sidebar-model.js'
import {
  argsTextToArgs,
  argsToText,
  createDraft,
  editBigText,
  editProfileField,
  envToPairs,
  isDraftDirty,
  buildProfileSavePayload,
  profileIdValid,
  tagsToText,
  textToTags,
  type EnvPair,
  type ProfileDraft,
} from './profile-editor-model.js'

type EditorTab = 'basic' | 'system' | 'memory'

const COMMON_HERDR_AGENTS = ['pi', 'claude', 'codex', 'agy', 'gemini', 'cursor', 'opencode', 'gemini-cli']

/** 有未保存改动时请求放弃；返回 true 表示可以安全离开。 */
function confirmDiscard(profileId: string | null): boolean {
  const label = profileId ? `Profile ${profileId}` : '当前 Profile'
  return window.confirm(`${label} 有未保存的修改，确定放弃吗？`)
}

/** 左侧 Profile 列表（herdr 未启用时不渲染 herdr 徽章，零插件痕迹）。 */
function ProfileListPanel({
  profiles,
  selectedId,
  onSelect,
  onCreate,
  herdrEnabled,
}: {
  profiles: Profile[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  herdrEnabled: boolean
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
            aria-pressed={selectedId === p.id}
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
              {herdrEnabled && p.runtime?.kind === 'herdr' && (
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

/**
 * Tab 1：基础与 Herdr 运行时。
 * herdr 插件未启用时完全不渲染 Herdr 运行时卡片：仅历史遗留 runtime 配置
 * 预留一行克制提示与清除入口，不展开大段表单。
 */
function ProfileBasicTab({
  draft,
  patch,
  isNew,
  models,
  defaultModel,
  herdrEnabled,
}: {
  draft: ProfileDraft
  patch: (next: Profile) => void
  isNew: boolean
  models: Array<{ id: string; available?: boolean; thinkingLevels?: string[] }>
  defaultModel: string
  herdrEnabled: boolean
}) {
  const profile = draft.profile
  const [runtimeEnabled, setRuntimeEnabled] = useState(profile.runtime !== undefined)
  const [envPairs, setEnvPairs] = useState<EnvPair[]>(envToPairs(profile.runtime?.env))
  const [argsText, setArgsText] = useState(argsToText(profile.runtime?.args))
  const runtime = profile.runtime

  // 本地编辑态（args 多行文本 / env 键值行）不随每次 patch 重置：组件由父级
  // 以 baseline 引用为 key 控制——仅在重新加载 Profile 时重挂载初始化。

  const patchRuntime = (nextRuntime: Profile['runtime']) => patch({ ...profile, runtime: nextRuntime })

  const patchRuntimeField = (fieldPatch: Partial<NonNullable<Profile['runtime']>>) => {
    const base = runtime ?? { kind: 'herdr', agent: '' }
    patchRuntime({ ...base, ...fieldPatch })
  }

  const modelOptions = models.map((m) => m.id)
  const modelKnown = !profile.model || modelOptions.includes(profile.model)
  const selectedModel = models.find((m) => m.id === (profile.model || defaultModel))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 12px', alignItems: 'center' }}>
        <label htmlFor="helm-profile-id" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>ID</label>
        <input
          id="helm-profile-id"
          className="input mono"
          value={profile.id}
          disabled={!isNew}
          placeholder="小写字母、数字与连字符"
          onChange={(e) => patch({ ...profile, id: e.target.value })}
        />
        <label htmlFor="helm-profile-name" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>展示名</label>
        <input
          id="helm-profile-name"
          className="input"
          value={profile.name ?? ''}
          placeholder="如：个人助理"
          onChange={(e) => patch({ ...profile, name: e.target.value })}
        />
        <label htmlFor="helm-profile-model" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>模型</label>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            id="helm-profile-model"
            className="input mono"
            style={{ flex: 1 }}
            value={profile.model ?? ''}
            onChange={(e) => {
              const nextModel = e.target.value
              const nextLevels = models.find((m) => m.id === (nextModel || defaultModel))?.thinkingLevels ?? ['off']
              patch({ ...profile, model: nextModel, thinkingLevel: profile.thinkingLevel && nextLevels.includes(profile.thinkingLevel) ? profile.thinkingLevel : undefined })
            }}
          >
            <option value="">跟随全局默认模型</option>
            {models.filter((m) => m.available).map((m) => (
              <option key={m.id} value={m.id}>{m.id}{(m.thinkingLevels?.length ?? 0) > 1 ? '（支持思考）' : ''}</option>
            ))}
            {profile.model && !models.some((m) => m.id === profile.model && m.available) && (
              <option value={profile.model}>{profile.model}（目录外）</option>
            )}
          </select>
          {!modelKnown && <span className="badge badge-warn">自定义</span>}
        </span>
        <label htmlFor="helm-profile-thinking" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>思考等级</label>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            id="helm-profile-thinking"
            className="input"
            style={{ flex: 1 }}
            value={profile.thinkingLevel ?? ''}
            onChange={(e) => patch({ ...profile, thinkingLevel: e.target.value === '' ? undefined : e.target.value })}
          >
            <option value="">跟随全局缺省</option>
            {(selectedModel?.thinkingLevels ?? ['off']).map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
          {selectedModel && (selectedModel.thinkingLevels?.length ?? 0) <= 1 && (
            <span className="provider-help" style={{ fontSize: 11 }}>该模型不支持思考档位</span>
          )}
        </span>
        <label htmlFor="helm-profile-tags" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Tags</label>
        <input
          id="helm-profile-tags"
          className="input mono"
          value={tagsToText(profile.tags)}
          placeholder="逗号分隔，如 research, coding"
          onChange={(e) => patch({ ...profile, tags: textToTags(e.target.value) })}
        />
        <label htmlFor="helm-profile-node" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>节点</label>
        <input
          id="helm-profile-node"
          className="input mono"
          value={profile.nodeId ?? ''}
          placeholder="普通会话默认执行节点，留空为本机 local"
          onChange={(e) => patch({ ...profile, nodeId: e.target.value })}
        />
        <label htmlFor="helm-profile-cwd" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>工作目录</label>
        <input
          id="helm-profile-cwd"
          className="input mono"
          value={profile.cwd ?? ''}
          placeholder="普通会话默认工作目录绝对路径，留空由内核决定"
          onChange={(e) => patch({ ...profile, cwd: e.target.value })}
        />
      </div>

      {!herdrEnabled && runtime !== undefined && (
        <div
          className="card"
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px' }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            该 Profile 遗留外部运行时配置（{runtime.kind}），启用对应插件后可编辑
          </span>
          <button
            className="btn btn-sm"
            title="清除遗留的外部运行时配置"
            onClick={() => patch({ ...profile, runtime: undefined })}
          >
            <HelmIcon name="x" size={12} />
            清除
          </button>
        </div>
      )}

      {herdrEnabled && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={runtimeEnabled}
              onChange={(e) => {
                const enabled = e.target.checked
                setRuntimeEnabled(enabled)
                if (enabled && !profile.runtime) {
                  patchRuntime({ kind: 'herdr', agent: '' })
                } else if (!enabled) {
                  patchRuntime(undefined)
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
              <label htmlFor="helm-runtime-agent" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Agent</label>
              <input
                id="helm-runtime-agent"
                className="input mono"
                list="helm-herdr-agents"
                value={runtime.agent}
                placeholder="如 pi / claude / codex / agy"
                onChange={(e) => patchRuntimeField({ agent: e.target.value })}
              />
              <datalist id="helm-herdr-agents">
                {COMMON_HERDR_AGENTS.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
              <label htmlFor="helm-runtime-node" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>节点</label>
              <input
                id="helm-runtime-node"
                className="input mono"
                value={runtime.nodeId ?? ''}
                placeholder="Herdr 目标节点，留空继承 Profile 或父会话节点"
                onChange={(e) => patchRuntimeField({ nodeId: e.target.value })}
              />
              <label htmlFor="helm-runtime-workspace" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Workspace</label>
              <input
                id="helm-runtime-workspace"
                className="input mono"
                value={runtime.workspace ?? ''}
                placeholder="绑定工作目录绝对路径"
                onChange={(e) => patchRuntimeField({ workspace: e.target.value })}
              />
              <label htmlFor="helm-runtime-args" style={{ fontSize: 12, color: 'var(--fg-muted)', alignSelf: 'start', paddingTop: 6 }}>Args</label>
              <textarea
                id="helm-runtime-args"
                className="textarea mono"
                style={{ minHeight: 64, fontSize: 12, resize: 'vertical' }}
                spellCheck={false}
                value={argsText}
                placeholder={'每行一个参数，参数内的空格会原样保留，如：\n--prompt\n--title 周报 草稿'}
                onChange={(e) => {
                  setArgsText(e.target.value)
                  patchRuntimeField({ args: argsTextToArgs(e.target.value) })
                }}
              />
            </div>
          )}

          {runtimeEnabled && runtime && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                环境变量（仅非机密项；API Key 请使用凭据库）
              </span>
              {envPairs.map((pair, idx) => {
                const keyId = `helm-runtime-env-key-${idx}`
                const valueId = `helm-runtime-env-value-${idx}`
                return (
                  <div key={idx} style={{ display: 'flex', gap: 6 }}>
                    <input
                      id={keyId}
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="KEY"
                      aria-label={`环境变量 ${idx + 1} 键名`}
                      value={pair.key}
                      onChange={(e) => {
                        const next = [...envPairs]
                        next[idx] = { ...pair, key: e.target.value }
                        setEnvPairs(next)
                        patchRuntimeField({ env: pairsToEnvOrUndefined(next) })
                      }}
                    />
                    <input
                      id={valueId}
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="VALUE"
                      aria-label={`环境变量 ${idx + 1} 值`}
                      value={pair.value}
                      onChange={(e) => {
                        const next = [...envPairs]
                        next[idx] = { ...pair, value: e.target.value }
                        setEnvPairs(next)
                        patchRuntimeField({ env: pairsToEnvOrUndefined(next) })
                      }}
                    />
                    <button
                      className="btn btn-sm"
                      aria-label={`删除环境变量 ${pair.key || idx + 1}`}
                      title="删除该变量"
                      onClick={() => {
                        const next = envPairs.filter((_, i) => i !== idx)
                        setEnvPairs(next)
                        patchRuntimeField({ env: pairsToEnvOrUndefined(next) })
                      }}
                    >
                      <HelmIcon name="x" size={12} />
                    </button>
                  </div>
                )
              })}
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
      )}
    </div>
  )
}

function pairsToEnvOrUndefined(pairs: EnvPair[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const p of pairs) {
    const k = p.key.trim()
    if (k) env[k] = p.value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

export function ProfileEditorModal({
  initialProfileId,
  onClose,
}: {
  initialProfileId?: string
  onClose: () => void
}) {
  const store = useHelmStore()
  const [defaultModel, setDefaultModel] = useState('')
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(store.plugins), [store.plugins])
  // 列表与默认选中仅消费可见 Profile：插件未启用时其自举 Profile 不残留痕迹。
  const profiles = useMemo(
    () => store.profiles.filter((p) => isProfileVisible(p, enabledPluginIds)),
    [store.profiles, enabledPluginIds],
  )
  const herdrEnabled = useMemo(
    () => store.plugins.some((p) => p.id === 'builtin:herdr' && p.enabled),
    [store.plugins],
  )
  const [selectedId, setSelectedId] = useState<string | null>(
    initialProfileId ?? store.profiles.find((p) => isProfileVisible(p, enabledPluginIds))?.id ?? null,
  )
  const [isNew, setIsNew] = useState(false)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<EditorTab>('basic')
  // 详情加载序号：作为基础 Tab 的重挂载 key，重新加载后重置本地编辑态。
  const [loadSeq, setLoadSeq] = useState(0)
  // 请求代数守卫：快速切换 Profile 时慢返回的旧详情不得写入新 Profile 草稿。
  const detailGeneration = useRef(0)

  useEffect(() => {
    let cancelled = false
    void assetsApi.getDefaultModel().then((result) => {
      if (!cancelled) setDefaultModel(result.defaultModel)
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [])

  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  // 插件启停导致当前选中 Profile 被隐藏时，自动切换到首个可见 Profile，不留悬空选中。
  useEffect(() => {
    setSelectedId((current) => {
      if (current === null || isNew) return current
      return profilesRef.current.some((p) => p.id === current) ? current : (profilesRef.current[0]?.id ?? null)
    })
  }, [profiles, isNew])

  const dirty = draft !== null && isDraftDirty(draft)

  const loadDetail = useCallback(async (id: string) => {
    const generation = ++detailGeneration.current
    setLoading(true)
    setError(null)
    try {
      const detail = await assetsApi.getProfile(id)
      if (detailGeneration.current !== generation) return
      setDraft(createDraft(detail))
      setLoadSeq((seq) => seq + 1)
    } catch (err) {
      if (detailGeneration.current !== generation) return
      setDraft(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (detailGeneration.current === generation) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isNew || !selectedId) return
    void loadDetail(selectedId)
  }, [selectedId, isNew, loadDetail])

  /** dirty guard：丢弃改动前必须显式确认；确认后同时满空草稿。 */
  const guardUnsaved = (profileId: string | null): boolean => {
    if (!dirty) return true
    if (!confirmDiscard(profileId)) return false
    setDraft(null)
    return true
  }

  // 本地 capture Esc：先于全局 ModalFocusScope（bubble 阶段）拦截，确保
  // 有未保存改动时 Esc 也走确认流程，而不是直接关闭弹窗丢掉改动。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (!dirty) return
      e.preventDefault()
      e.stopPropagation()
      if (confirmDiscard(selectedId)) onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [dirty, selectedId, onClose])

  const startCreate = () => {
    if (!guardUnsaved(selectedId)) return
    setIsNew(true)
    setSelectedId(null)
    setTab('basic')
    setError(null)
    setDraft(createDraft({ id: '', name: '', model: '', tags: [], system: '', memory: '' }))
    setLoadSeq((seq) => seq + 1)
  }

  const selectProfile = (id: string) => {
    if (isNew) {
      if (!guardUnsaved(id)) return
      setIsNew(false)
    } else if (id === selectedId) {
      return
    } else if (!guardUnsaved(selectedId)) {
      return
    }
    // 同步进入加载态：切换到详情返回之间不闪现旧 Profile 的可编辑表单。
    setSelectedId(id)
    setDraft(null)
    setLoading(true)
    setTab('basic')
    setError(null)
  }

  const reloadFromDisk = () => {
    if (!selectedId || isNew) return
    if (dirty && !confirmDiscard(selectedId)) return
    void loadDetail(selectedId)
    store.pushNotice({
      type: 'notification',
      level: 'info',
      title: '已重新读取',
      body: `Profile ${selectedId} 已从磁盘刷新（本地未保存修改已丢弃）`,
    })
  }

  const patchProfile = (next: Profile) => {
    setDraft((prev) => (prev === null ? prev : editProfileField(prev, next)))
  }

  const patchBigText = (field: 'system' | 'memory', value: string) => {
    setDraft((prev) => (prev === null ? prev : editBigText(prev, field, value)))
  }

  const save = async () => {
    if (!draft) return
    if (!profileIdValid(draft.profile.id)) {
      setError('Profile ID 仅允许小写字母、数字与连字符 [a-z0-9-]')
      setTab('basic')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = buildProfileSavePayload(draft, { isNew })
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
        body: draft.profile.id,
      })
      if (selectedId) await loadDetail(selectedId)
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
      const nextId = profiles.find((p) => p.id !== selectedId)?.id ?? null
      setSelectedId(nextId)
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
    () => !isNew && (selectedId === 'assistant' || draft?.profile.id === 'assistant'),
    [isNew, selectedId, draft?.profile.id],
  )

  const tabItems: Array<{ key: EditorTab; label: string }> = [
    { key: 'basic', label: '基础与运行时' },
    { key: 'system', label: 'SYSTEM.md' },
    { key: 'memory', label: 'MEMORY.md' },
  ]

  const requestClose = () => {
    if (!guardUnsaved(isNew ? null : selectedId)) return
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal"
        style={{ maxWidth: 860 }}
        role="dialog"
        aria-modal="true"
        aria-label="角色 Profile 编辑器"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="bot" size={15} />
            角色 Profile 编辑器
            {dirty && <span className="badge badge-warn">有未保存修改</span>}
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭" onClick={requestClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body asset-modal-body" style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
          <div className="asset-modal-list" style={{ width: 210, minWidth: 210, overflowY: 'auto' }}>
            <ProfileListPanel
              profiles={profiles}
              selectedId={isNew ? null : selectedId}
              onSelect={selectProfile}
              onCreate={startCreate}
              herdrEnabled={herdrEnabled}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="tabs-bar">
              {tabItems.map((t) => (
                <button
                  key={t.key}
                  className={`tab-btn${tab === t.key ? ' tab-btn-active' : ''}`}
                  aria-pressed={tab === t.key}
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
                <ProfileBasicTab
                  key={`profile:${loadSeq}`}
                  draft={draft}
                  patch={patchProfile}
                  isNew={isNew}
                  models={store.models}
                  defaultModel={defaultModel}
                  herdrEnabled={herdrEnabled}
                />
              )}
              {!loading && draft && tab === 'system' && (
                <textarea
                  className="textarea mono selectable"
                  style={{ minHeight: 320, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
                  spellCheck={false}
                  aria-label="SYSTEM.md 系统提示词全文"
                  value={draft.profile.system ?? ''}
                  placeholder="该角色的系统提示词全文（SYSTEM.md）"
                  onChange={(e) => patchBigText('system', e.target.value)}
                />
              )}
              {!loading && draft && tab === 'memory' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm" disabled={isNew} onClick={reloadFromDisk}>
                      <HelmIcon name="rotate-ccw" size={12} />
                      重新从磁盘读取
                    </button>
                  </div>
                  <textarea
                    className="textarea mono selectable"
                    style={{ minHeight: 280, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
                    spellCheck={false}
                    aria-label="MEMORY.md 长期记忆全文"
                    value={draft.profile.memory ?? ''}
                    placeholder="该角色的长期记忆全文（MEMORY.md）"
                    onChange={(e) => patchBigText('memory', e.target.value)}
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
