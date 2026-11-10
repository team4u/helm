import React from 'react'
import type { SkillSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { getSkillIcon, getSkillSourceBadge } from './skill-center-model.js'

export interface SkillCardProps {
  skill: SkillSummary
  selected?: boolean
  onSelect: () => void
}

/**
 * 全屏技能中心单张技能卡片视图组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计系统规范；
 * - 顶部展示矢量图标、名称、来源徽章（内置 / 工作区 / 插件）与等宽 ID；
 * - 中部展示功能说明；
 * - 底部展示关联文件数量胶囊（N 个参考文件）；
 * - 支持鼠标点击与键盘无障碍交互（Enter / Space 激活）；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function SkillCard({
  skill,
  selected = false,
  onSelect,
}: SkillCardProps): React.JSX.Element {
  const iconName = getSkillIcon(skill)
  const sourceBadge = getSkillSourceBadge(skill)
  const refCount = skill.references?.length ?? 0
  const description = skill.description || '暂无描述'

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const badgeClass =
    sourceBadge.variant === 'builtin'
      ? 'badge badge-neutral'
      : sourceBadge.variant === 'plugin'
        ? 'badge badge-subtle mono'
        : 'badge badge-ghost'

  const cardClasses = [
    'primary-card',
    'skill-card',
    selected && 'is-selected',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClasses}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      data-skill-id={skill.id}
    >
      {/* 顶部头部：图标 + 标题/来源标签/ID */}
      <div className="primary-card-header">
        <div className="primary-card-icon-wrap">
          <HelmIcon name={iconName} size={18} />
        </div>
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={skill.name || skill.id}>
              {skill.name || skill.id}
            </span>
            <span className={badgeClass} title={`来源：${sourceBadge.label}`}>
              {sourceBadge.label}
            </span>
          </div>
          <div className="primary-card-id mono" title={skill.id}>
            {skill.id}
          </div>
        </div>
      </div>

      {/* 中部：描述 */}
      <div className="primary-card-desc" title={description}>
        {description}
      </div>

      {/* 底部：参考文件数量胶囊 */}
      <div className="primary-card-footer">
        <div className="primary-card-pills">
          <span className="primary-card-pill" title={`${refCount} 个参考文件`}>
            <HelmIcon name="file-text" size={11} />
            <span>{`${refCount} 个参考文件`}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
