import React, { useEffect, useRef, useState } from 'react'
import type { SkillSummary } from '@helm/protocol'
import { copyToClipboard, HelmIcon } from '@helm/plugin-client'
import { getSkillSourceBadge } from './skill-center-model.js'

export interface SkillCardProps {
  skill: SkillSummary
  selected?: boolean
  onSelect: () => void
}

/**
 * 全屏技能中心单张技能卡片视图组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计系统规范；
 * - 顶部展示名称、有效来源徽章（内置 / 共享 / 工作区 / 插件）与等宽 ID；
 * - 中部展示功能说明；
 * - 底部展示可一键复制的 `/skill:<id>` 指令胶囊与参考文件数（为 0 时省略）；
 * - 支持鼠标点击与键盘无障碍交互（Enter / Space 激活）；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function SkillCard({
  skill,
  selected = false,
  onSelect,
}: SkillCardProps): React.JSX.Element {
  const sourceBadge = getSkillSourceBadge(skill)
  const refCount = skill.references?.length ?? 0
  const description = skill.description || '暂无描述'
  const slashCommand = `/skill:${skill.id}`
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const handleCopyCommand = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const ok = await copyToClipboard(slashCommand)
    if (!ok) return
    setCopied(true)
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      setCopied(false)
      copyTimerRef.current = null
    }, 1500)
  }

  const badgeClass =
    sourceBadge.variant === 'builtin'
      ? 'badge badge-neutral'
      : sourceBadge.variant === 'plugin'
        ? 'badge badge-neutral mono'
        : sourceBadge.variant === 'agents'
          ? 'badge badge-accent'
          : 'badge badge-neutral'

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
      {/* 顶部头部：标题/来源标签/ID 靠左对齐 */}
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={skill.name || skill.id}>
              {skill.name || skill.id}
            </span>
            <span className={badgeClass} title={`来源：${sourceBadge.label}`}>
              {sourceBadge.label}
            </span>
          </div>
          <div className="primary-card-id mono text-subtle break-word" title={skill.id}>
            {skill.id}
          </div>
        </div>
      </div>

      {/* 中部：描述 */}
      <div className="primary-card-desc" title={description}>
        {description}
      </div>

      {/* 底部：斜杠指令快捷复制与参考文件数量（为 0 时省略） */}
      <div className="primary-card-footer">
        <div className="primary-card-pills">
          <button
            type="button"
            className="primary-card-pill mono"
            title={`复制斜杠指令 ${slashCommand}`}
            aria-label={`复制斜杠指令 ${slashCommand}`}
            onClick={(e) => void handleCopyCommand(e)}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <HelmIcon name={copied ? 'check' : 'copy'} size={10} />
            <span>{copied ? '已复制' : slashCommand}</span>
          </button>
          {refCount > 0 && (
            <span className="primary-card-pill" title={`${refCount} 个参考文件`}>
              <HelmIcon name="file-text" size={11} />
              <span>{`${refCount} 个参考文件`}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
