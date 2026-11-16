import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from './profile-center-model.js'
import type { StarterDraft } from './profile-center-model.js'
import {
  buildProfileModelOptions,
  isSystemProfile,
  profileIdValid,
  profilesApi,
  resolveProfileModel,
  startersAtLimit,
  startersToDrafts,
  validateStarterDraft,
  validateStarterDrafts,
} from './profile-center-model.js'
import { HelmIcon, Checkbox, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, PluginSlot, Select, type SelectOption, Switch } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { ThinkingLevelControl } from '../ui/ThinkingLevelControl.js'
import { PROFILE_DETAIL_SECTION_SLOT, PROFILE_STARTERS_MAX_ITEMS } from '@helm/protocol/browser'

export interface ProfileDetailDrawerProps {
  profile: Profile | null
  isNew?: boolean
  open: boolean
  onClose: () => void
  inline?: boolean
  onSaved?: (saved: Profile) => void
  onDeleted?: (id: string) => void
}

interface FormState {
  id: string
  name: string
  description: string
  model: string
  thinkingLevel: string
  /** 绑定的默认计算节点 ID；空串 = 未绑定（回退本机 local）。 */
  nodeId: string
  cwd: string
  system: string
  useAllSkills: boolean
  selectedSkillIds: string[]
  starters: StarterDraft[]
  /** 保存时未暴露字段原样回传：runtime/tags 等不得因表单裁剪而丢。 */
  source: Profile | null
}

function createInitialForm(profile: Profile | null, isNew: boolean): FormState {
  if (isNew || !profile) {
    return {
      id: '',
      name: '',
      description: '',
      model: '',
      thinkingLevel: '',
      nodeId: '',
      cwd: '',
      system: '',
      useAllSkills: true,
      selectedSkillIds: [],
      starters: [],
      source: null,
    }
  }

  return {
    id: profile.id,
    name: profile.name ?? '',
    description: profile.description ?? '',
    model: resolveProfileModel(profile) ?? '',
    thinkingLevel: profile.thinkingLevel ?? '',
    nodeId: profile.nodeId ?? '',
    cwd: profile.cwd ?? '',
    system: profile.system ?? '',
    useAllSkills: profile.skills === undefined,
    selectedSkillIds: Array.isArray(profile.skills) ? [...profile.skills] : [],
    starters: startersToDrafts(profile.starters),
    source: profile,
  }
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、默认节点、工作目录、系统提示词、插件扩展子插槽与技能白名单；
 * - 提供脏表单防护、新建校验与删除二次确认；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function ProfileDetailDrawer({
  profile,
  isNew = false,
  open,
  onClose,
  inline = false,
  onSaved,
  onDeleted,
}: ProfileDetailDrawerProps): React.JSX.Element {
  const store = useHelmStore()
  const [form, setForm] = useState<FormState>(() => createInitialForm(profile, isNew))
  const [baseline, setBaseline] = useState<FormState>(() => createInitialForm(profile, isNew))
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const activeFetchIdRef = useRef<string | null>(null)

  // 当 Drawer 打开或传入的目标 profile / isNew 变化时重置表单态
  useEffect(() => {
    if (!open) {
      setError(null)
      setShowDeleteConfirm(false)
      setShowDiscardConfirm(false)
      activeFetchIdRef.current = null
      return
    }

    const initial = createInitialForm(profile, isNew)
    setForm(initial)
    setBaseline(initial)
    setError(null)

    // 若编辑已有角色，尝试拉取全文详情（含完整 SYSTEM.md；MEMORY.md 由
    // builtin:memory 插件子插槽自治拉取，不经宿主 Profile 表单）
    if (!isNew && profile?.id) {
      const targetId = profile.id
      activeFetchIdRef.current = targetId

      void profilesApi
        .get(targetId)
        .then((detail) => {
          if (activeFetchIdRef.current !== targetId) return
          setForm((prev) => {
            const next = {
              ...prev,
              name: detail.name ?? prev.name,
              description: detail.description ?? prev.description,
              model: resolveProfileModel(detail) ?? prev.model,
              thinkingLevel: detail.thinkingLevel ?? '',
              nodeId: detail.nodeId ?? prev.nodeId,
              cwd: detail.cwd ?? prev.cwd,
              system: detail.system ?? prev.system,
              useAllSkills: detail.skills === undefined,
              selectedSkillIds: Array.isArray(detail.skills) ? [...detail.skills] : prev.selectedSkillIds,
              starters: startersToDrafts(detail.starters),
              source: detail,
            }
            setBaseline(next)
            return next
          })
        })
        .catch(() => {
          // 详情获取失败时静默维持基础信息
        })
    }
  }, [open, profile, isNew])

  const isSystem = Boolean(profile && isSystemProfile(profile))
  const canDelete = !isNew && !isSystem && Boolean(profile)

  // 计算脏表单状态
  const isDirty = useMemo(() => {
    const startersDirty = (a: StarterDraft[], b: StarterDraft[]): boolean =>
      a.length !== b.length || a.some((item, i) => item.label !== b[i]?.label || item.prompt !== b[i]?.prompt)
    if (isNew) {
      return (
        form.id.trim() !== '' ||
        form.name.trim() !== '' ||
        form.description.trim() !== '' ||
        form.model.trim() !== '' ||
        form.thinkingLevel !== '' ||
        form.nodeId.trim() !== '' ||
        form.cwd.trim() !== '' ||
        form.system.trim() !== '' ||
        !form.useAllSkills ||
        form.selectedSkillIds.length > 0 ||
        form.starters.length > 0
      )
    }

    if (form.id !== baseline.id) return true
    if (form.name !== baseline.name) return true
    if (form.description !== baseline.description) return true
    if (form.model !== baseline.model) return true
    if (form.thinkingLevel !== baseline.thinkingLevel) return true
    if (form.nodeId !== baseline.nodeId) return true
    if (form.cwd !== baseline.cwd) return true
    if (form.system !== baseline.system) return true
    if (form.useAllSkills !== baseline.useAllSkills) return true
    if (startersDirty(form.starters, baseline.starters)) return true

    const sortedCurrent = [...form.selectedSkillIds].sort().join(',')
    const sortedBaseline = [...baseline.selectedSkillIds].sort().join(',')
    return sortedCurrent !== sortedBaseline
  }, [form, baseline, isNew])

  // 关闭请求处理：脏表单时弹出确认
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true)
    } else {
      onClose()
    }
  }

  // 模型下拉选项列表（过滤为已配置模型）
  const modelOptions = useMemo<SelectOption<string>[]>(() => {
    return buildProfileModelOptions(store.models ?? [], form.model)
  }, [store.models, form.model])

  // 默认节点下拉选项：未绑定项 + store.nodes 全量；既有值不在节点列表时补「未知节点」回退项
  const nodeOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: 'Unbound (local node)', icon: 'monitor' },
      ...store.nodes.map((n) => ({
        value: n.id,
        label: nodeOptionLabel(n),
        icon: n.id === 'local' || n.kind === 'local' ? 'monitor' : 'network',
        meta: n.kind === 'local' ? undefined : n.online ? 'Online' : 'Offline',
      })),
    ]
    const current = form.nodeId.trim()
    if (current !== '' && !list.some((o) => o.value === current)) {
      list.push({ value: current, label: `${current} (unknown node)`, icon: 'alert-circle' })
    }
    return list
  }, [store.nodes, form.nodeId])

  // 所选模型支持的思考档位：未绑定模型时无档位（跟随全局缺省）；
  // 目录缺失（模型未配置/外部）时无档位可选，仅保留既有值提示。
  const profileThinkingLevels = useMemo(() => {
    const found = (store.models ?? []).find((m) => m.id === form.model)
    return found?.thinkingLevels ?? []
  }, [store.models, form.model])
  const profileThinkingSupported = profileThinkingLevels.some((level) => level !== 'off')
  const profileThinkingLevelUnsupported =
    form.thinkingLevel !== '' && !profileThinkingLevels.includes(form.thinkingLevel)

  // 可用技能列表
  const availableSkills = store.skills ?? []

  // 技能勾选切换
  const handleToggleSkill = (skillId: string, checked: boolean) => {
    setForm((prev) => {
      const set = new Set(prev.selectedSkillIds)
      if (checked) {
        set.add(skillId)
      } else {
        set.delete(skillId)
      }
      return { ...prev, selectedSkillIds: Array.from(set) }
    })
  }

  // 保存操作
  const handleSave = async () => {
    setError(null)
    const normalizedId = form.id.trim()
    if (!normalizedId) {
      setError('Enter a profile ID')
      return
    }

    if (isNew && !profileIdValid(normalizedId)) {
      setError('Profile ID must contain only lowercase letters, digits and hyphens (e.g. code-reviewer)')
      return
    }

    const starterError = validateStarterDrafts(form.starters)
    if (starterError !== null) {
      setError(`Starter ${starterError.index + 1}: ${starterError.error}`)
      return
    }

    setIsSaving(true)
    try {
      // 整体替换契约：以最近一次完整详情为基底，仅覆写表单暴露字段——
      // runtime/tags 等未暴露字段原样保留，不因表单裁剪而丢。
      const base = (isNew ? {} : { ...form.source }) as Record<string, unknown>
      const payload = {
        ...base,
        id: normalizedId,
        system: form.system,
        skills: form.useAllSkills ? undefined : form.selectedSkillIds,
        ...(form.name.trim() !== '' ? { name: form.name.trim() } : {}),
        ...(form.model.trim() !== '' ? { model: form.model.trim() } : {}),
        // 整体替换契约：thinkingLevel 必须显式提交（省略即清除，跟随全局缺省）
        ...(form.thinkingLevel !== '' ? { thinkingLevel: form.thinkingLevel } : {}),
        ...(form.nodeId.trim() !== '' ? { nodeId: form.nodeId.trim() } : {}),
        ...(form.cwd.trim() !== '' ? { cwd: form.cwd.trim() } : {}),
        ...(form.starters.length > 0
          ? { starters: form.starters.map((s) => ({ label: s.label.trim(), prompt: s.prompt })) }
          : {}),
      } as Profile
      if (!isNew && form.starters.length === 0) {
        // 编辑既有角色：空列表显式清空（恢复宿主默认提示）；新建则不携带键
        payload.starters = []
      }
      if (form.name.trim() === '') delete (payload as { name?: string }).name
      if (form.model.trim() === '') delete (payload as { model?: string }).model
      if (form.thinkingLevel === '') delete (payload as { thinkingLevel?: string }).thinkingLevel
      // 置空即解绑：base（既有详情）携带的 nodeId 必须显式删除，否则整体替换会复活旧绑定
      if (form.nodeId.trim() === '') delete (payload as { nodeId?: string }).nodeId
      if (form.cwd.trim() === '') delete (payload as { cwd?: string }).cwd

      let saved: Profile
      if (isNew) {
        saved = await profilesApi.create(payload)
      } else {
        saved = await profilesApi.update(normalizedId, payload)
      }

      setBaseline(form)
      onSaved?.(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  // 删除操作
  const handleConfirmDelete = async () => {
    if (!profile || isNew) return
    setIsDeleting(true)
    setError(null)
    try {
      await profilesApi.delete(profile.id)
      setShowDeleteConfirm(false)
      onDeleted?.(profile.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setShowDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }

  const titleText = isNew
    ? 'New agent profile'
    : form.name || form.id || profile?.name || profile?.id || 'Profile details'

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleRequestClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content"
          role="dialog"
          aria-label={titleText}
        >
          {/* Drawer header */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title break-word">
                    {titleText}
                  </DialogTitle>
                  {isSystem && (
                    <span className="badge badge-warn" title="Built-in system profile; protected">
                      <HelmIcon name="lock" size={10} />
                      <span>System</span>
                    </span>
                  )}
                </div>
                {!isNew && form.id && (
                  <div className="mono text-subtle break-word">{form.id}</div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                aria-label="Close drawer"
                title="Close"
                onClick={handleRequestClose}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* Drawer body: form sections */}
          <div className="primary-drawer-body">
            {error && (
              <div className="callout callout-error" role="alert">
                <HelmIcon name="alert-circle" size={14} />
                <span className="callout-text">{error}</span>
              </div>
            )}

            {/* Basic fields */}
            <section className="section-flat">
              <div className="form-grid">
                <label htmlFor="profile-form-id" className="form-grid-label">
                  Profile ID
                </label>
                <div className="form-grid-value">
                  {isNew ? (
                    <input
                      id="profile-form-id"
                      type="text"
                      className="input mono"
                      placeholder="Letters, digits and hyphens, e.g. code-reviewer"
                      value={form.id}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                        }))
                      }
                    />
                  ) : (
                    <input
                      id="profile-form-id"
                      type="text"
                      className="input mono"
                      value={form.id}
                      disabled
                      readOnly
                    />
                  )}
                </div>

                <label htmlFor="profile-form-name" className="form-grid-label">
                  Profile name
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-name"
                    type="text"
                    className="input"
                    placeholder="e.g. Code Reviewer, Software Architect"
                    value={form.name}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                  />
                </div>

                <label
                  htmlFor="profile-form-desc"
                  className="form-grid-label form-grid-align-start"
                >
                  Profile description
                </label>
                <div className="form-grid-value">
                  <textarea
                    id="profile-form-desc"
                    className="input profile-desc-textarea"
                    rows={3}
                    placeholder="Briefly describe the duties, background and strengths of this profile..."
                    value={form.description}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-model" className="form-grid-label">
                  Default model
                </label>
                <div className="form-grid-value">
                  <Select
                    id="profile-form-model"
                    value={form.model}
                    options={modelOptions}
                    popoverClassName="helm-select-popover-wide"
                    className="w-full mono"
                    onChange={(e) =>
                      setForm((prev) => {
                        const model = e.target.value
                        // 切换模型后：当前档位不在新模型支持列表时回落跟随全局缺省（与全局默认面板同法）
                        if (prev.thinkingLevel !== '') {
                          const levels = (store.models ?? []).find((m) => m.id === model)?.thinkingLevels ?? []
                          if (!levels.includes(prev.thinkingLevel)) {
                            return { ...prev, model, thinkingLevel: '' }
                          }
                        }
                        return { ...prev, model }
                      })
                    }
                    inline={inline}
                    placeholder="Follow system default"
                  />
                </div>

                <label className="form-grid-label form-grid-align-start" htmlFor="profile-form-thinking">
                  Thinking level
                </label>
                <div className="form-grid-value">
                  {form.model.trim() === '' ? (
                    <span className="text-subtle" id="profile-form-thinking">
                      Follows the global default thinking level when no model is bound.
                    </span>
                  ) : profileThinkingSupported ? (
                    <ThinkingLevelControl
                      value={form.thinkingLevel}
                      levels={profileThinkingLevels}
                      disabled={isSaving || isDeleting}
                      className="composer-thinking-row profile-thinking-row"
                      onPick={(level) =>
                        setForm((prev) => ({ ...prev, thinkingLevel: level }))
                      }
                    />
                  ) : (
                    <span className="text-subtle" id="profile-form-thinking">
                      The selected model does not support thinking levels.
                    </span>
                  )}
                  {profileThinkingLevelUnsupported && (
                    <div className="callout callout-warn" role="status">
                      <HelmIcon name="alert-triangle" size={13} />
                      <span className="callout-text">
                        Current level {form.thinkingLevel} is not supported by the selected model; adjust before saving.
                      </span>
                    </div>
                  )}
                </div>

                <label htmlFor="profile-form-node" className="form-grid-label">
                  Default node
                </label>
                <div className="form-grid-value">
                  <Select
                    id="profile-form-node"
                    value={form.nodeId}
                    options={nodeOptions}
                    popoverClassName="helm-select-popover-wide"
                    className="w-full mono"
                    inline={inline}
                    placeholder="Unbound (local node)"
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, nodeId: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-cwd" className="form-grid-label">
                  Working directory
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-cwd"
                    type="text"
                    className="input mono"
                    placeholder="Optional, e.g. /root/code/my-project"
                    value={form.cwd}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, cwd: e.target.value }))
                    }
                  />
                </div>
              </div>
            </section>

            {/* System prompt section */}
            <section className="section-flat">
              <div className="section-flat-header flex-row-between">
                <span className="section-flat-title">System prompt (SYSTEM.md)</span>
                <span className="mono profile-editor-meta">
                  {form.system.length} characters{form.system ? ` · ${form.system.split('\n').length} lines` : ''}
                </span>
              </div>
              <textarea
                id="profile-form-system"
                className="input mono profile-editor-textarea"
                rows={10}
                placeholder="Enter the system prompt instructions for this profile (Markdown supported)..."
                value={form.system}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, system: e.target.value }))
                }
                aria-label="System prompt"
              />
              <div className="profile-editor-hint">
                Tip: the system prompt defines the core duties and ground rules of the profile; saving applies to future conversations immediately.
              </div>
            </section>

            {/* Plugin extension slots (e.g. builtin:memory long-term memory section) */}
            <PluginSlot
              ownerPluginId="builtin:profile"
              name={PROFILE_DETAIL_SECTION_SLOT}
              slotProps={{
                profileId: form.id.trim(),
                isNew,
                disabled: isSaving || isDeleting,
              }}
            />

            {/* Empty-conversation starters (max 6) */}
            <section className="section-flat">
              <div className="section-flat-header profile-starters-header">
                <span className="section-flat-title">Empty-conversation starters</span>
                <span className="mono profile-editor-meta">
                  {form.starters.length}/{PROFILE_STARTERS_MAX_ITEMS}
                </span>
              </div>
              <div className="profile-starters-list">
                {form.starters.length === 0 ? (
                  <div className="text-subtle text-xs profile-starters-empty">
                    Falls back to the system default starter prompts when unset.
                  </div>
                ) : (
                  form.starters.map((starter, index) => {
                    const issue = validateStarterDraft(starter)
                    return (
                      <div key={`starter-${index}`} className="profile-starter-item">
                        <div className="profile-starter-fields">
                          <input
                            type="text"
                            className="input profile-starter-label"
                            placeholder="Title (max 24 code points)"
                            value={starter.label}
                            aria-label={`Starter ${index + 1} title`}
                            onChange={(e) =>
                              setForm((prev) => {
                                const starters = [...prev.starters]
                                starters[index] = { ...starters[index]!, label: e.target.value }
                                return { ...prev, starters }
                              })
                            }
                          />
                          <textarea
                            className="input profile-starter-prompt"
                            rows={2}
                            placeholder="Prompt filled into the composer on click (max 4000 code points; not sent automatically)"
                            value={starter.prompt}
                            aria-label={`Starter ${index + 1} prompt`}
                            onChange={(e) =>
                              setForm((prev) => {
                                const starters = [...prev.starters]
                                starters[index] = { ...starters[index]!, prompt: e.target.value }
                                return { ...prev, starters }
                              })
                            }
                          />
                        </div>
                        {issue !== null ? (
                          <div className="profile-starter-error" role="alert">
                            {issue}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm profile-starter-remove"
                          aria-label={`Delete starter ${index + 1}`}
                          title="Delete this starter"
                          disabled={isSaving || isDeleting}
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              starters: prev.starters.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          <HelmIcon name="trash-2" size={12} />
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm profile-starter-add"
                disabled={isSaving || isDeleting || startersAtLimit(form.starters)}
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    starters: [...prev.starters, { label: '', prompt: '' }],
                  }))
                }
              >
                <HelmIcon name="plus" size={12} />
                <span>Add starter</span>
              </button>
            </section>

            {/* Skill allowlist */}
            <section className="section-flat">
              <div className="section-flat-header flex-row-between">
                <span className="section-flat-title">Available skills allowlist</span>
                <Switch
                  id="profile-form-skills-switch"
                  checked={form.useAllSkills}
                  onChange={(val) =>
                    setForm((prev) => ({ ...prev, useAllSkills: val }))
                  }
                  label="All available skills"
                />
              </div>

              {form.useAllSkills ? (
                <div className="text-subtle">
                  This profile may use every available skill without restriction.
                </div>
              ) : (
                <div
                  className="flex-col"
                  style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {availableSkills.length === 0 ? (
                    <div className="text-subtle">No skills loaded</div>
                  ) : (
                    availableSkills.map((s) => (
                      <Checkbox
                        key={s.id}
                        checked={form.selectedSkillIds.includes(s.id)}
                        onChange={(checked) => handleToggleSkill(s.id, checked)}
                        label={
                          <span className="flex-row text-muted">
                            <span>{s.name}</span>
                            <span className="mono text-subtle">({s.id})</span>
                          </span>
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </section>
          </div>

          {/* Drawer footer actions */}
          <div className="primary-drawer-footer flex-row-between">
            <div>
              {canDelete && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-err"
                  disabled={isSaving || isDeleting}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <HelmIcon name="trash" size={13} />
                  <span>Delete profile</span>
                </button>
              )}
            </div>

            <div className="flex-row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={isSaving || isDeleting}
                onClick={handleRequestClose}
              >
                Cancel
              </button>

              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={
                  isSaving ||
                  isDeleting ||
                  (isNew && !profileIdValid(form.id.trim()))
              }
                onClick={() => void handleSave()}
              >
                <HelmIcon name={isSaving ? 'loader' : 'check'} size={13} />
                <span>{isSaving ? 'Saving…' : 'Save profile'}</span>
              </button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete profile"
        description={`Delete profile "${form.name || form.id}"? This action cannot be undone.`}
        confirmText={isDeleting ? 'Deleting…' : 'Confirm deletion'}
        cancelText="Cancel"
        danger
        inline={inline}
        onConfirm={() => void handleConfirmDelete()}
      />

      {/* Dirty form guard dialog */}
      <ConfirmDialog
        open={showDiscardConfirm}
        onOpenChange={setShowDiscardConfirm}
        title="Discard unsaved changes"
        description="The form has unsaved changes that will be lost on close. Discard them and close?"
        confirmText="Discard changes"
        cancelText="Keep editing"
        danger
        inline={inline}
        onConfirm={() => {
          setShowDiscardConfirm(false)
          onClose()
        }}
      />
    </Dialog>
  )
}
