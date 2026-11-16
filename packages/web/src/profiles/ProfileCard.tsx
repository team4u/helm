import React, { useContext } from 'react'
import type { Profile } from './profile-center-model.js'
import {
  formatProfileLocation,
  formatShortModelName,
  isHerdrProfile,
  isSystemProfile,
  resolveEffectiveProfileModel,
  summarizeProfileActivity,
} from './profile-center-model.js'
import { HelmIcon } from '@helm/plugin-client'
import { HelmStoreContext } from '../lib/store-context.js'

export interface ProfileCardProps {
  profile: Profile
  selected?: boolean
  onSelect: () => void
  /** 可选：全局默认模型配置（缺省时读取 store.defaultModelInfo） */
  defaultModelInfo?: { defaultModel: string; defaultThinkingLevel: string } | null
  /** 可选：点击右下角「对话」直达动作（缺省通过 store.openTarget 跳转 #/a/<profileId>） */
  onStartChat?: () => void
}

const ACTIVITY_BADGE_CLASS = {
  working: 'badge badge-ok',
  blocked: 'badge badge-warn',
  error: 'badge badge-err',
  'plugin-disabled': 'badge badge-warn',
  active: 'badge badge-accent',
  idle: 'badge badge-neutral',
} as const

/**
 * 智能体角色卡片组件：
 * - 消费 .primary-card 视觉规范，紧凑展示角色名称/ID、系统锁、运行态、有效模型（含思考档位/全局继承标识）、节点与工作目录、技能数及右下角直达对话按钮；
 * - 键盘 Enter/Space 与点击打开右侧详情抽屉；
 * - 严格遵循零 Emoji 铁律与零内联样式。
 */
export function ProfileCard({
  profile,
  selected = false,
  onSelect,
  defaultModelInfo,
  onStartChat,
}: ProfileCardProps): React.JSX.Element {
  const store = useContext(HelmStoreContext)
  const isSystem = isSystemProfile(profile)
  const isHerdr = isHerdrProfile(profile)
  const effectiveModel = resolveEffectiveProfileModel(
    profile,
    defaultModelInfo !== undefined ? defaultModelInfo : store?.defaultModelInfo,
  )
  const location = formatProfileLocation(profile)
  const activity = summarizeProfileActivity(
    profile,
    store?.conversations ?? [],
    store?.plugins ?? [],
  )
  const displayName = profile.name || profile.id

  const skillsLabel =
    profile.skills === undefined
      ? '全部可用技能'
      : `${profile.skills.length} 个技能`

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }

  const handleChatClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (activity.managingPluginDisabled) return
    if (onStartChat) {
      onStartChat()
      return
    }
    store?.openTarget({ kind: 'agent', profileId: profile.id })
  }

  const shortModelName = formatShortModelName(effectiveModel.model)

  const modelTitle = effectiveModel.model
    ? effectiveModel.source === 'bound'
      ? `绑定模型：${effectiveModel.model}${
          effectiveModel.thinkingLevel ? `（思考档位：${effectiveModel.thinkingLevel}）` : ''
        }`
      : `继承全局默认模型：${effectiveModel.model}${
          effectiveModel.thinkingLevel ? `（思考档位：${effectiveModel.thinkingLevel}）` : ''
        }`
    : '跟随全局默认模型配置'

  const locationText = location.cwd
    ? `${location.nodeId} · ${location.cwd}`
    : `${location.nodeId} · 默认工作目录`

  return (
    <div
      role="button"
      tabIndex={0}
      data-profile-id={profile.id}
      aria-selected={selected}
      className={`primary-card${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
    >
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={displayName}>
              {displayName}
            </span>
            {isSystem && (
              <span className="primary-card-pill mono" title="系统内置角色">
                <HelmIcon name="lock" size={10} />
                <span>系统</span>
              </span>
            )}
            <span
              className={`${ACTIVITY_BADGE_CLASS[activity.stateKind]} tabular-nums`}
              title={`激活状态：${activity.stateLabel}`}
            >
              {activity.stateLabel}
            </span>
          </div>
          <span className="mono text-subtle break-word">{profile.id}</span>
        </div>
      </div>

      <div className="primary-card-desc" title={profile.description || undefined}>
        {profile.description || '暂无描述'}
      </div>

      <div className="flex-col-xs">
        <div className="flex-row primary-card-location text-subtle mono" title={`节点与目录：${locationText}`}>
          <HelmIcon name={location.isRemoteNode ? 'server' : 'laptop'} size={11} />
          <span className="break-word">{locationText}</span>
        </div>

        <div className="primary-card-pills">
          {shortModelName ? (
            <span className="primary-card-pill mono" title={modelTitle}>
              <HelmIcon name="cpu" size={10} />
              <span className="primary-card-pill-label">{shortModelName}</span>
              {effectiveModel.thinkingLevel && (
                <span className="primary-card-pill-suffix">· {effectiveModel.thinkingLevel}</span>
              )}
            </span>
          ) : (
            <span className="primary-card-pill" title={modelTitle}>
              <HelmIcon name="cpu" size={10} />
              <span className="primary-card-pill-label">跟随全局默认</span>
            </span>
          )}
          {effectiveModel.source === 'global' && (
            <span
              className="primary-card-pill"
              title={`继承全局默认模型：${effectiveModel.model}`}
            >
              <span>全局默认</span>
            </span>
          )}
          <span className="primary-card-pill" title={`技能配置：${skillsLabel}`}>
            <HelmIcon name="wrench" size={10} />
            <span className="primary-card-pill-label">{skillsLabel}</span>
          </span>
          {isHerdr && (
            <span className="primary-card-pill" title="Herdr 外部运行时">
              <HelmIcon name="terminal" size={10} />
              <span>Herdr</span>
            </span>
          )}
        </div>
      </div>

      <div className="primary-card-footer">
        <span className="text-subtle tabular-nums">
          {activity.conversationCount > 0
            ? `关联 ${activity.conversationCount} 个会话`
            : '暂无关联会话'}
        </span>
        {profile.humanSelectable !== false && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={activity.managingPluginDisabled}
            title={
              activity.managingPluginDisabled
                ? '所属托管插件已停用，无法发起新对话'
                : `与 ${displayName} 发起新对话`
            }
            onClick={handleChatClick}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <HelmIcon name="message-square" size={12} />
            <span>对话</span>
          </button>
        )}
      </div>
    </div>
  )
}
