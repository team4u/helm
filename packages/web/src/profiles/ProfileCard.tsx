import React from 'react'
import type { Profile } from './profile-center-model.js'
import {
  isHerdrProfile,
  isSystemProfile,
  resolveProfileModel,
} from './profile-center-model.js'
import { HelmIcon } from '../lib/icons.js'

export interface ProfileCardProps {
  profile: Profile
  selected?: boolean
  onSelect: () => void
}

/**
 * 智能体角色卡片组件：
 * - 消费 .primary-card 视觉规范，呈现角色名称、ID、系统锁、描述、模型胶囊与技能统计，零图标杂音；
 * - 键盘 Enter/Space 与点击激活；
 * - 严格遵循零 Emoji 铁律。
 */
export function ProfileCard({
  profile,
  selected = false,
  onSelect,
}: ProfileCardProps): React.JSX.Element {
  const isSystem = isSystemProfile(profile)
  const isHerdr = isHerdrProfile(profile)
  const model = resolveProfileModel(profile)
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
          </div>
          <span className="mono text-subtle" style={{ fontSize: 11 }}>
            {profile.id}
          </span>
        </div>
      </div>

      <div className="primary-card-desc" title={profile.description || undefined}>
        {profile.description || '暂无描述'}
      </div>

      <div className="primary-card-footer">
        <div className="primary-card-pills">
          {model && (
            <span className="primary-card-pill mono" title={`默认模型：${model}`}>
              <HelmIcon name="cpu" size={10} />
              <span>{model}</span>
            </span>
          )}
          <span className="primary-card-pill" title={`技能配置：${skillsLabel}`}>
            <HelmIcon name="wrench" size={10} />
            <span>{skillsLabel}</span>
          </span>
          {isHerdr && (
            <span className="primary-card-pill" title="Herdr 外部运行时">
              <HelmIcon name="terminal" size={10} />
              <span>Herdr</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
