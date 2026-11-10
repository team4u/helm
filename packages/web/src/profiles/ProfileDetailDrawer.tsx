import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from './profile-center-model.js'
import {
  buildProfileModelOptions,
  getProfileIcon,
  isSystemProfile,
  profileIdValid,
  profilesApi,
  resolveProfileModel,
} from './profile-center-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { Checkbox } from '../ui/Checkbox.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import { PluginSlot } from '../ui/PluginSlot.js'
import { Select, type SelectOption } from '../ui/Select.js'
import { Switch } from '../ui/Switch.js'
import { PROFILE_DETAIL_SECTION_SLOT } from '@helm/protocol'

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
  cwd: string
  system: string
  useAllSkills: boolean
  selectedSkillIds: string[]
}

function createInitialForm(profile: Profile | null, isNew: boolean): FormState {
  if (isNew || !profile) {
    return {
      id: '',
      name: '',
      description: '',
      model: '',
      cwd: '',
      system: '',
      useAllSkills: true,
      selectedSkillIds: [],
    }
  }

  return {
    id: profile.id,
    name: profile.name ?? '',
    description: profile.description ?? '',
    model: resolveProfileModel(profile) ?? '',
    cwd: profile.cwd ?? '',
    system: profile.system ?? '',
    useAllSkills: profile.skills === undefined,
    selectedSkillIds: Array.isArray(profile.skills) ? [...profile.skills] : [],
  }
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、工作目录、系统提示词、插件扩展子插槽与技能白名单；
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
              cwd: detail.cwd ?? prev.cwd,
              system: detail.system ?? prev.system,
              useAllSkills: detail.skills === undefined,
              selectedSkillIds: Array.isArray(detail.skills) ? [...detail.skills] : prev.selectedSkillIds,
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
    if (isNew) {
      return (
        form.id.trim() !== '' ||
        form.name.trim() !== '' ||
        form.description.trim() !== '' ||
        form.model.trim() !== '' ||
        form.cwd.trim() !== '' ||
        form.system.trim() !== '' ||
        !form.useAllSkills ||
        form.selectedSkillIds.length > 0
      )
    }

    if (form.id !== baseline.id) return true
    if (form.name !== baseline.name) return true
    if (form.description !== baseline.description) return true
    if (form.model !== baseline.model) return true
    if (form.cwd !== baseline.cwd) return true
    if (form.system !== baseline.system) return true
    if (form.useAllSkills !== baseline.useAllSkills) return true

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
      setError('请输入角色 ID')
      return
    }

    if (isNew && !profileIdValid(normalizedId)) {
      setError('角色 ID 必须由小写字母、数字和连字符组成（例如 code-reviewer）')
      return
    }

    setIsSaving(true)
    try {
      const payload: Profile = {
        id: normalizedId,
        name: form.name.trim() || undefined,
        model: form.model.trim() || undefined,
        cwd: form.cwd.trim() || undefined,
        system: form.system,
        skills: form.useAllSkills ? undefined : form.selectedSkillIds,
      }

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

  const iconName = getProfileIcon({
    id: form.id || profile?.id,
    tags: profile?.tags,
    runtime: profile?.runtime,
  })

  const titleText = isNew
    ? '新建智能体角色'
    : form.name || form.id || profile?.name || profile?.id || '角色详情'

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
          {/* 抽屉头部 */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <HelmIcon name={iconName} size={20} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">
                    {titleText}
                  </DialogTitle>
                  {isSystem && (
                    <span className="badge badge-warn" title="系统内置角色，受保护">
                      <HelmIcon name="lock" size={10} />
                      <span>系统</span>
                    </span>
                  )}
                </div>
                {!isNew && form.id && (
                  <div className="mono text-subtle text-xs">{form.id}</div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="关闭抽屉"
                title="关闭"
                onClick={handleRequestClose}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* 抽屉主体：表单各区块 */}
          <div className="primary-drawer-body">
            {error && (
              <div
                className="badge badge-warn"
                role="alert"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  justifyContent: 'flex-start',
                  fontSize: 12,
                }}
              >
                <HelmIcon name="alert-circle" size={14} />
                <span>{error}</span>
              </div>
            )}

            {/* 基本字段区块 */}
            <section className="section-flat">
              <div className="form-grid">
                <label htmlFor="profile-form-id" className="form-grid-label">
                  角色 ID
                </label>
                <div className="form-grid-value">
                  {isNew ? (
                    <input
                      id="profile-form-id"
                      type="text"
                      className="input mono"
                      placeholder="字母、数字与连字符，如 code-reviewer"
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
                  角色名称
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-name"
                    type="text"
                    className="input"
                    placeholder="例如：代码评审员、技术架构师"
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
                  角色描述
                </label>
                <div className="form-grid-value">
                  <textarea
                    id="profile-form-desc"
                    className="input profile-desc-textarea"
                    rows={3}
                    placeholder="简要描述该角色的职责、背景与能力专长..."
                    value={form.description}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-model" className="form-grid-label">
                  默认模型
                </label>
                <div className="form-grid-value">
                  <Select
                    id="profile-form-model"
                    value={form.model}
                    options={modelOptions}
                    popoverClassName="helm-select-popover-wide"
                    className="w-full mono"
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, model: e.target.value }))
                    }
                    inline={inline}
                    placeholder="跟随系统默认"
                  />
                </div>

                <label htmlFor="profile-form-cwd" className="form-grid-label">
                  工作目录
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-cwd"
                    type="text"
                    className="input mono"
                    placeholder="可选，例如 /root/code/my-project"
                    value={form.cwd}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, cwd: e.target.value }))
                    }
                  />
                </div>
              </div>
            </section>

            {/* 系统提示词区块 */}
            <section className="section-flat">
              <div className="section-flat-header flex-row-between">
                <span className="section-flat-title">系统提示词 (SYSTEM.md)</span>
                <span className="mono profile-editor-meta">
                  {form.system.length} 字符{form.system ? ` · ${form.system.split('\n').length} 行` : ''}
                </span>
              </div>
              <textarea
                id="profile-form-system"
                className="input mono profile-editor-textarea"
                rows={10}
                placeholder="输入该角色的系统提示词指令（支持 Markdown）..."
                value={form.system}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, system: e.target.value }))
                }
                aria-label="系统提示词"
              />
              <div className="profile-editor-hint">
                提示：系统指令定义角色的核心职责与行动准则，保存后对后续会话即时生效。
              </div>
            </section>

            {/* 插件扩展子插槽（builtin:memory 注入长期记忆区块等） */}
            <PluginSlot
              ownerPluginId="builtin:profile"
              name={PROFILE_DETAIL_SECTION_SLOT}
              slotProps={{
                profileId: form.id.trim(),
                isNew,
                disabled: isSaving || isDeleting,
              }}
            />

            {/* 技能白名单配置 */}
            <section className="section-flat">
              <div
                className="section-flat-header"
                style={{ justifyContent: 'space-between' }}
              >
                <span className="section-flat-title">可用技能白名单</span>
                <Switch
                  id="profile-form-skills-switch"
                  checked={form.useAllSkills}
                  onChange={(val) =>
                    setForm((prev) => ({ ...prev, useAllSkills: val }))
                  }
                  label="全部可用技能"
                />
              </div>

              {form.useAllSkills ? (
                <div className="text-subtle text-xs" style={{ padding: '2px 0' }}>
                  已允许此角色无限制使用系统内所有可用技能。
                </div>
              ) : (
                <div
                  className="flex-col"
                  style={{
                    gap: 8,
                    maxHeight: 180,
                    overflowY: 'auto',
                    paddingTop: 4,
                  }}
                >
                  {availableSkills.length === 0 ? (
                    <div className="text-subtle text-xs">暂无已加载的技能</div>
                  ) : (
                    availableSkills.map((s) => (
                      <Checkbox
                        key={s.id}
                        checked={form.selectedSkillIds.includes(s.id)}
                        onChange={(checked) => handleToggleSkill(s.id, checked)}
                        label={
                          <span
                            className="flex-row"
                            style={{ gap: 6, fontSize: 12 }}
                          >
                            <span>{s.name}</span>
                            <span className="mono text-subtle text-xs">
                              ({s.id})
                            </span>
                          </span>
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </section>
          </div>

          {/* 抽屉底部操作栏 */}
          <div className="primary-drawer-footer">
            {canDelete && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-danger"
                style={{ marginRight: 'auto' }}
                disabled={isSaving || isDeleting}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <HelmIcon name="trash" size={13} />
                <span>删除角色</span>
              </button>
            )}

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={isSaving || isDeleting}
              onClick={handleRequestClose}
            >
              取消
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
              <span>{isSaving ? '保存中…' : '保存角色'}</span>
            </button>
          </div>
        </DialogContent>
      </DialogPortal>

      {/* 删除二次确认弹窗 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="删除角色"
        description={`确定删除角色「${form.name || form.id}」？此操作不可撤销。`}
        confirmText={isDeleting ? '删除中…' : '确认删除'}
        cancelText="取消"
        danger
        inline={inline}
        onConfirm={() => void handleConfirmDelete()}
      />

      {/* 脏表单防丢弹窗 */}
      <ConfirmDialog
        open={showDiscardConfirm}
        onOpenChange={setShowDiscardConfirm}
        title="放弃未保存的修改"
        description="当前表单有尚未保存的修改，关闭后将丢失这些改动。确定要放弃修改并关闭吗？"
        confirmText="放弃修改"
        cancelText="继续编辑"
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
