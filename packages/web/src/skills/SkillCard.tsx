import React, { useEffect, useRef, useState } from 'react'
import type { SkillSummary } from '@helmx/protocol/browser'
import { copyToClipboard, HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { getSkillSourceBadge } from './skill-center-model.js'

export interface SkillCardProps {
  skill: SkillSummary
  selected?: boolean
  onSelect: () => void
}

/**
 * One skill card in the full-screen skill center:
 * - a responsive grid cell following the 1px hairline border and restrained
 *   low-saturation design system;
 * - header shows the name, effective source badge (built-in / shared /
 *   workspace / plugin) and the monospace ID;
 * - middle shows the description;
 * - footer shows the one-click-copy `/skill:<id>` command pill and the
 *   reference file count (omitted when 0);
 * - mouse click and keyboard accessibility (Enter / Space) both activate;
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillCard({
  skill,
  selected = false,
  onSelect,
}: SkillCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const sourceBadge = getSkillSourceBadge(skill, t)
  const refCount = skill.references?.length ?? 0
  const description = skill.description || t('skills.card.noDescription')
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
      {/* Top header: title/source badge/ID left-aligned */}
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={skill.name || skill.id}>
              {skill.name || skill.id}
            </span>
            <span className={badgeClass} title={t('skills.card.sourceTitle', { label: sourceBadge.label })}>
              {sourceBadge.label}
            </span>
          </div>
          <div className="primary-card-id mono text-subtle break-word" title={skill.id}>
            {skill.id}
          </div>
        </div>
      </div>

      {/* Middle: description */}
      <div className="primary-card-desc" title={description}>
        {description}
      </div>

      {/* Bottom: slash command quick copy and reference file count (omitted when 0) */}
      <div className="primary-card-footer">
        <div className="primary-card-pills">
          <button
            type="button"
            className="primary-card-pill mono"
            title={t('skills.card.copyCommandTitle', { command: slashCommand })}
            aria-label={t('skills.card.copyCommandTitle', { command: slashCommand })}
            onClick={(e) => void handleCopyCommand(e)}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <HelmxIcon name={copied ? 'check' : 'copy'} size={10} />
            <span>{copied ? t('skills.card.copied') : slashCommand}</span>
          </button>
          {refCount > 0 && (
            <span
              className="primary-card-pill tabular-nums"
              title={t('skills.card.referenceFiles', { count: refCount })}
            >
              <HelmxIcon name="file-text" size={11} />
              <span aria-label={t('skills.card.referenceFiles', { count: refCount })}>{refCount}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
