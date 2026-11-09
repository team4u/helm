import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile, ProfileRuntimeUiSpec } from '@helm/protocol'
import { ApiClientError, assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { collectEnabledPluginIds, isProfileVisible } from '../shell/sidebar-model.js'
import { Select, type SelectOption } from '../ui/Select.js'
import { Switch } from '../ui/Switch.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs.js'
import { nodeOptionLabel } from './nodes-modal-model.js'
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
import { deepLinkSelection, fallbackSelection, shouldClearSelectionInStore, shouldSyncSelectionToStore } from './list-modal-selection.js'
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'

type EditorTab = 'basic' | 'system' | 'memory'

/** store.groupedUi.profileRuntimes 元素（pluginId + spec）。 */
interface QualifiedRuntimeSpec {
  pluginId: string
  spec: ProfileRuntimeUiSpec
}

/** 有未保存改动时请求放弃；返回 true 表示可以安全离开。 */
function confirmDiscard(profileId: string | null): boolean {
  const label = profileId ? `Profile ${profileId}` : '当前 Profile'
  return window.confirm(`${label} 有未保存的修改，确定放弃吗？`)
}

/** 左侧 Profile 列表（运行时徽章由 profileRuntimes 动态驱动，零插件 ID 硬编码）。 */
function ProfileListPanel({
  profiles,
  selectedId,
  onSelect,
  onCreate,
  runtimeKinds,
}: {
  profiles: Profile[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  /** 当前已注册的运行时 kind 集合（对应插件停用时其徽章零痕迹隐藏）。 */
  runtimeKinds: ReadonlySet<string>
}) {
  return (
    <div className="flex-col">
      <button className="btn btn-primary btn-sm" onClick={onCreate}>
        <HelmIcon name="plus" size={13} />
        新建 Profile
      </button>
      <div className="list">
        {profiles.length === 0 && <div className="empty-state empty-state-compact">暂无 Profile</div>}
        {profiles.map((p) => {
          const isSelected = selectedId === p.id
          const runtimeBadge = p.runtime !== undefined && runtimeKinds.has(p.runtime.kind) ? p.runtime.kind : null
          return (
            <button
              key={p.id}
              className={`list-item-btn${isSelected ? ' is-active' : ''}`}
              aria-pressed={isSelected}
              onClick={() => onSelect(p.id)}
            >
              <span className="list-item-btn-title">
                <span>{p.name || p.id}</span>
                {runtimeBadge !== null && (
                  <span className="badge badge-accent">
                    <HelmIcon name="terminal" size={10} />
                    {runtimeBadge}
                  </span>
                )}
              </span>
              <span className="mono text-muted">
                {p.id}
                {p.model ? ` / ${p.model}` : ''}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Tab 1：基础信息与外部运行时（profileRuntimes 动态驱动，零插件 ID 硬编码）。
 * 当前已注册 kind 且 Profile 无 runtime 或 kind 命中注册项时渲染通用运行时
 * 表单；kind 未注册（插件停用）或无任何注册项时，已保存 runtime 只提供
 * 通用保留/清除提示，不冒充运行时配置修改，也不悄悄丢失。
 */
function ProfileBasicTab({
  draft,
  patch,
  isNew,
  models,
  defaultModel,
  runtimeSpecs,
}: {
  draft: ProfileDraft
  patch: (next: Profile) => void
  isNew: boolean
  models: Array<{ id: string; available?: boolean; thinkingLevels?: string[] }>
  defaultModel: string
  /** 当前已注册的外部运行时 UI 定义（按 order 排序）。 */
  runtimeSpecs: ReadonlyArray<QualifiedRuntimeSpec>
}) {
  const profile = draft.profile
  const store = useHelmStore()
  const knownNodes = store.nodes ?? []
  const [runtimeEnabled, setRuntimeEnabled] = useState(profile.runtime !== undefined)
  const [envPairs, setEnvPairs] = useState<EnvPair[]>(envToPairs(profile.runtime?.env))
  const [argsText, setArgsText] = useState(argsToText(profile.runtime?.args))
  const runtime = profile.runtime
  const specsByKind = useMemo(() => new Map(runtimeSpecs.map((s) => [s.spec.kind, s])), [runtimeSpecs])
  const activeSpec = runtime !== undefined ? specsByKind.get(runtime.kind) : undefined
  // 已启用且当前 runtime 形状可由本编辑器管理：无 runtime（可新建）或 kind 已注册。
  const canEditRuntime = runtimeSpecs.length > 0 && (runtime === undefined || activeSpec !== undefined)
  const defaultSpec = runtimeSpecs[0]

  // 本地编辑态（args 多行文本 / env 键值行）不随每次 patch 重置：组件由父级
  // 以 baseline 引用为 key 控制——仅在重新加载 Profile 时重挂载初始化。

  const patchRuntime = (nextRuntime: Profile['runtime']) => patch({ ...profile, runtime: nextRuntime })

  const patchRuntimeField = (fieldPatch: Partial<NonNullable<Profile['runtime']>>) => {
    const base = runtime ?? { kind: defaultSpec?.spec.kind ?? '', agent: '' }
    patchRuntime({ ...base, ...fieldPatch })
  }

  /** 切换运行时 kind（多运行时下拉）：重建为所选 kind 的空白配置。 */
  const switchRuntimeKind = (kind: string) => {
    patchRuntime({ kind, agent: '' })
  }

  const modelOptions = models.map((m) => m.id)
  const modelKnown = !profile.model || modelOptions.includes(profile.model)
  const selectedModel = models.find((m) => m.id === (profile.model || defaultModel))

  const modelSelectOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: '跟随全局默认模型' },
    ]
    for (const m of models.filter((entry) => entry.available)) {
      list.push({
        value: m.id,
        label: `${m.id}${(m.thinkingLevels?.length ?? 0) > 1 ? '（支持思考）' : ''}`,
      })
    }
    if (profile.model && !models.some((m) => m.id === profile.model && m.available)) {
      list.push({
        value: profile.model,
        label: `${profile.model}（目录外）`,
      })
    }
    return list
  }, [models, profile.model])

  const thinkingSelectOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: '跟随全局缺省' },
    ]
    for (const level of selectedModel?.thinkingLevels ?? ['off']) {
      list.push({ value: level, label: level })
    }
    return list
  }, [selectedModel])

  const nodeSelectOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: '本机 local（默认）', icon: 'monitor' },
    ]
    for (const node of knownNodes.filter((n) => n.id !== 'local')) {
      list.push({
        value: node.id,
        label: nodeOptionLabel(node),
        icon: 'network',
        meta: node.online ? '在线' : '离线',
      })
    }
    if (profile.nodeId && profile.nodeId !== 'local' && !knownNodes.some((n) => n.id === profile.nodeId)) {
      list.push({
        value: profile.nodeId,
        label: `${profile.nodeId}（未知）`,
        icon: 'alert-circle',
      })
    }
    return list
  }, [knownNodes, profile.nodeId])

  const runtimeNodeSelectOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: '继承 Profile 或父会话节点' },
      { value: 'local', label: '本机 local', icon: 'monitor' },
    ]
    for (const node of knownNodes.filter((n) => n.id !== 'local')) {
      list.push({
        value: node.id,
        label: nodeOptionLabel(node),
        icon: 'network',
        meta: node.online ? '在线' : '离线',
      })
    }
    if (runtime?.nodeId && runtime.nodeId !== 'local' && !knownNodes.some((n) => n.id === runtime.nodeId)) {
      list.push({
        value: runtime.nodeId,
        label: `${runtime.nodeId}（未知）`,
        icon: 'alert-circle',
      })
    }
    return list
  }, [knownNodes, runtime?.nodeId])

  return (
    <div className="flex-col">
      <div className="form-grid">
        <label htmlFor="helm-profile-id" className="form-grid-label">ID</label>
        {isNew ? (
          <input
            id="helm-profile-id"
            className="input mono"
            value={profile.id}
            placeholder="小写字母、数字与连字符"
            onChange={(e) => patch({ ...profile, id: e.target.value })}
          />
        ) : (
          <span className="badge badge-neutral">
            {profile.managedByPlugin !== undefined && <HelmIcon name="lock" size={11} />}
            {profile.id}
          </span>
        )}
        <label htmlFor="helm-profile-name" className="form-grid-label">展示名</label>
        <input
          id="helm-profile-name"
          className="input"
          value={profile.name ?? ''}
          placeholder="如：个人助理"
          onChange={(e) => patch({ ...profile, name: e.target.value })}
        />
        <label htmlFor="helm-profile-model" className="form-grid-label">模型</label>
        <span className="flex-row">
          <Select
            id="helm-profile-model"
            className="flex-1"
            value={profile.model ?? ''}
            options={modelSelectOptions}
            onChange={(e) => {
              const nextModel = e.target.value
              const nextLevels = models.find((m) => m.id === (nextModel || defaultModel))?.thinkingLevels ?? ['off']
              patch({ ...profile, model: nextModel, thinkingLevel: profile.thinkingLevel && nextLevels.includes(profile.thinkingLevel) ? profile.thinkingLevel : undefined })
            }}
          />
          {!modelKnown && <span className="badge badge-warn">自定义</span>}
        </span>
        <label htmlFor="helm-profile-thinking" className="form-grid-label">思考等级</label>
        <span className="flex-row">
          <Select
            id="helm-profile-thinking"
            className="flex-1"
            value={profile.thinkingLevel ?? ''}
            options={thinkingSelectOptions}
            onChange={(e) => patch({ ...profile, thinkingLevel: e.target.value === '' ? undefined : e.target.value })}
          />
          {selectedModel && (selectedModel.thinkingLevels?.length ?? 0) <= 1 && (
            <span className="provider-help text-subtle">该模型不支持思考档位</span>
          )}
        </span>
        <label htmlFor="helm-profile-tags" className="form-grid-label">Tags</label>
        <input
          id="helm-profile-tags"
          className="input"
          value={tagsToText(profile.tags)}
          placeholder="逗号分隔，如 research, coding"
          onChange={(e) => patch({ ...profile, tags: textToTags(e.target.value) })}
        />
        <label htmlFor="helm-profile-node" className="form-grid-label">节点</label>
        <Select
          id="helm-profile-node"
          value={profile.nodeId === 'local' ? '' : (profile.nodeId ?? '')}
          options={nodeSelectOptions}
          onChange={(e) => patch({ ...profile, nodeId: e.target.value === '' ? undefined : e.target.value })}
        />
        <label htmlFor="helm-profile-cwd" className="form-grid-label">工作目录</label>
        <input
          id="helm-profile-cwd"
          className="input"
          value={profile.cwd ?? ''}
          placeholder="普通会话默认工作目录绝对路径，留空由内核决定"
          onChange={(e) => patch({ ...profile, cwd: e.target.value })}
        />
      </div>

      {!canEditRuntime && runtime !== undefined && (
        <div className="section-flat flex-row-between">
          <span className="text-muted">
            已保存外部运行时配置（{runtime.kind}），所属插件未启用或不由本编辑器管理，保存时原样保留
          </span>
          <button
            className="btn btn-sm"
            title="清除已保存的外部运行时配置"
            onClick={() => {
              setRuntimeEnabled(false)
              patch({ ...profile, runtime: undefined })
            }}
          >
            <HelmIcon name="x" size={12} />
            清除
          </button>
        </div>
      )}

      {canEditRuntime && (
        <div className="section-flat">
          <div className="flex-row">
            <Switch
              checked={runtimeEnabled}
              onChange={(enabled) => {
                setRuntimeEnabled(enabled)
                if (enabled && !profile.runtime) {
                  patchRuntime({ kind: defaultSpec?.spec.kind ?? '', agent: '' })
                } else if (!enabled) {
                  patchRuntime(undefined)
                }
              }}
              label={
                <span className="section-flat-title flex-row">
                  <HelmIcon name="terminal" size={13} /> {activeSpec?.spec.label ?? defaultSpec?.spec.label ?? '外部运行时'}
                </span>
              }
            />
            <span className="text-subtle">（可选）作为 subagent 时绑定 Herdr CLI</span>
          </div>

          {runtimeEnabled && runtime && (
            <div className="form-grid">
              {runtimeSpecs.length > 1 && (
                <>
                  <label htmlFor="helm-runtime-kind" className="form-grid-label">运行时类型</label>
                  <Select
                    id="helm-runtime-kind"
                    value={runtime.kind}
                    options={runtimeSpecs.map((s) => ({ value: s.spec.kind, label: s.spec.label }))}
                    onChange={(e) => switchRuntimeKind(e.target.value)}
                  />
                </>
              )}
              <label htmlFor="helm-runtime-agent" className="form-grid-label">Agent</label>
              <input
                id="helm-runtime-agent"
                className="input mono"
                list="helm-runtime-agents"
                value={runtime.agent}
                placeholder={(activeSpec?.spec.agentSuggestions ?? []).slice(0, 4).join(' / ') || 'CLI kind'}
                onChange={(e) => patchRuntimeField({ agent: e.target.value })}
              />
              <datalist id="helm-runtime-agents">
                {(activeSpec?.spec.agentSuggestions ?? []).map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
              <label htmlFor="helm-runtime-node" className="form-grid-label">节点</label>
              <Select
                id="helm-runtime-node"
                value={runtime.nodeId ?? ''}
                options={runtimeNodeSelectOptions}
                onChange={(e) => patchRuntimeField({ nodeId: e.target.value === '' ? undefined : e.target.value })}
              />
              <label htmlFor="helm-runtime-workspace" className="form-grid-label">Workspace</label>
              <input
                id="helm-runtime-workspace"
                className="input mono"
                value={runtime.workspace ?? ''}
                placeholder="绑定工作目录绝对路径"
                onChange={(e) => patchRuntimeField({ workspace: e.target.value })}
              />
              <label htmlFor="helm-runtime-args" className="form-grid-label form-grid-align-start">Args</label>
              <textarea
                id="helm-runtime-args"
                className="textarea mono profile-args-textarea"
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
            <div className="flex-col">
              <span className="text-muted">
                环境变量（仅非机密项；API Key 请使用凭据库）
              </span>
              {envPairs.map((pair, idx) => {
                const keyId = `helm-runtime-env-key-${idx}`
                const valueId = `helm-runtime-env-value-${idx}`
                return (
                  <div key={idx} className="flex-row">
                    <input
                      id={keyId}
                      className="input mono flex-1"
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
                      className="input mono flex-1"
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
  // SSE 快照未到达或测试 mock 未携带时兜底为空（节点 datalist 可选项为空不影响表单）。
  const knownNodes = store.nodes ?? []
  const [defaultModel, setDefaultModel] = useState('')
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(store.plugins), [store.plugins])
  // 外部运行时定义由插件 profileRuntime 动态注册（已按 order 排序）。
  const runtimeSpecs = useMemo(() => store.groupedUi.profileRuntimes, [store.groupedUi.profileRuntimes])
  const runtimeKinds = useMemo(() => new Set(runtimeSpecs.map((s) => s.spec.kind)), [runtimeSpecs])
  // 列表与默认选中仅消费可见 Profile：插件未启用时其自举 Profile 不残留痕迹。
  const profiles = useMemo(
    () => store.profiles.filter((p) => isProfileVisible(p, enabledPluginIds)),
    [store.profiles, enabledPluginIds],
  )
  const herdrTabLabel = runtimeSpecs.length > 0 ? '基础与运行时' : '基础信息'
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

  // store 引用快照：effect 只依赖列表与选中，不因无关 SSE 帧重跑。
  const storeRef = useRef(store)
  storeRef.current = store
  // 外部深链（URL 前进/后退）切换 Profile：本地跟随但绝不写回 store——
  // 变更源头就是 store/URL，写回即回环（还会用旧 selectedId 覆盖用户刚导航到的条目）。
  // 外部导航丢弃未保存草稿是显式权衡：浏览器回退是用户主动离开，不弹 confirm 阻断。
  const initialProfileIdRef = useRef(initialProfileId)
  useEffect(() => {
    if (initialProfileId === initialProfileIdRef.current) return
    initialProfileIdRef.current = initialProfileId
    const next = deepLinkSelection(selectedId, initialProfileId)
    if (next === null) return
    setIsNew(false)
    setSelectedId(next)
    detailGeneration.current += 1
    setDraft(null)
    setLoading(true)
    setTab('basic')
    setError(null)
  }, [initialProfileId, selectedId])
  // 列表兑底（合并）：profiles 为空（刷新后资产未返回）时保留深链选中不覆盖；
  // 列表到达后若选中项不在其中（深链 id 不存在 / 插件停用隐藏），回退首项不留悬空选中。
  // 兑底属本地决策，经守卫写回（仅弹窗仍是 profile-editor 时）。
  useEffect(() => {
    if (isNew) return
    const next = fallbackSelection(selectedId, profiles.map((p) => p.id))
    if (next === null) return
    setSelectedId(next)
    if (shouldSyncSelectionToStore(storeRef.current.activeModal, 'profile-editor', next)) {
      storeRef.current.setActiveModal({ kind: 'profile-editor', profileId: next })
    }
  }, [profiles, selectedId, isNew])

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
    if (shouldClearSelectionInStore(store.activeModal, 'profile-editor')) {
      store.setActiveModal({ kind: 'profile-editor' })
    }
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
    if (shouldSyncSelectionToStore(store.activeModal, 'profile-editor', id)) {
      store.setActiveModal({ kind: 'profile-editor', profileId: id })
    }
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
        // 新建成功后让地址栏深链指向新 Profile。
        if (shouldSyncSelectionToStore(store.activeModal, 'profile-editor', created.id)) {
          store.setActiveModal({ kind: 'profile-editor', profileId: created.id })
        }
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

  const isProtected = !isNew && draft?.profile.managedByPlugin !== undefined

  const tabItems: Array<{ key: EditorTab; label: string }> = [
    // 无任何已注册运行时时本 Tab 只有基础字段，不预告运行时能力。
    { key: 'basic', label: herdrTabLabel },
    { key: 'system', label: 'SYSTEM.md' },
    { key: 'memory', label: 'MEMORY.md' },
  ]

  const requestClose = () => {
    if (!guardUnsaved(isNew ? null : selectedId)) return
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal"
            style={{ maxWidth: 860 }}
            aria-label="角色 Profile 编辑器"
            onEscapeKeyDown={(e) => {
              if (!guardUnsaved(isNew ? null : selectedId)) {
                e.preventDefault()
              }
            }}
            onPointerDownOutside={(e) => {
              if (!guardUnsaved(isNew ? null : selectedId)) {
                e.preventDefault()
              }
            }}
          >
            <div className="modal-header">
              <DialogTitle className="modal-title flex-row">
                <HelmIcon name="bot" size={15} />
                角色 Profile 编辑器
                {dirty && <span className="badge badge-warn">有未保存修改</span>}
              </DialogTitle>
              <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭" onClick={requestClose}>
                <HelmIcon name="x" size={14} />
              </button>
            </div>
            <div className="modal-body asset-modal-body">
          <div className="asset-modal-list">
            <ProfileListPanel
              profiles={profiles}
              selectedId={isNew ? null : selectedId}
              onSelect={selectProfile}
              onCreate={startCreate}
              runtimeKinds={runtimeKinds}
            />
          </div>
          <div className="asset-modal-main">
            <Tabs value={tab} onValueChange={(val) => setTab(val as EditorTab)} variant="underline">
              <TabsList className="tabs-bar" aria-label="Profile 配置选项卡">
                {tabItems.map((t) => (
                  <TabsTrigger
                    key={t.key}
                    value={t.key}
                    className={`tab-btn${tab === t.key ? ' tab-btn-active' : ''}`}
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="profile-tab-content">
              {error && (
                <div className="jr-callout jr-callout-err" role="alert">
                  <HelmIcon name="alert-circle" size={14} />
                  <span className="selectable">{error}</span>
                </div>
              )}
              {loading && (
                <div className="flex-row text-muted">
                  <HelmIcon name="loader" size={13} />
                  正在读取 Profile 详情...
                </div>
              )}
              {!loading && !draft && !isNew && (
                <div className="empty-state">
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
                  runtimeSpecs={runtimeSpecs}
                />
              )}
              {!loading && draft && tab === 'system' && (
                <textarea
                  className="textarea mono selectable profile-editor-textarea"
                  spellCheck={false}
                  aria-label="SYSTEM.md 系统提示词全文"
                  value={draft.profile.system ?? ''}
                  placeholder="该角色的系统提示词全文（SYSTEM.md）"
                  onChange={(e) => patchBigText('system', e.target.value)}
                />
              )}
              {!loading && draft && tab === 'memory' && (
                <div className="flex-col flex-1">
                  <div className="flex-row justify-end">
                    <button className="btn btn-sm" disabled={isNew} onClick={reloadFromDisk}>
                      <HelmIcon name="rotate-ccw" size={12} />
                      重新从磁盘读取
                    </button>
                  </div>
                  <textarea
                    className="textarea mono selectable profile-editor-textarea"
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
          <span className="text-muted flex-1">
            {isProtected ? `${selectedId} 为受保护 Profile（内核默认或插件托管），不可删除` : isNew ? '新建 Profile' : `正在编辑 ${selectedId}`}
          </span>
          <button
            className="btn btn-danger"
            disabled={isProtected || isNew || !selectedId || saving}
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
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
