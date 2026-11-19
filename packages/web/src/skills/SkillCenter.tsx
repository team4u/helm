import React, { useMemo, useState } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useLocationTargets, useSkills, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { SkillCard } from './SkillCard.js'
import { SkillDetailDrawer } from './SkillDetailDrawer.js'
import {
  buildSkillCategoryCounts,
  filterSkills,
  skillCategoryTabLabel,
  type SkillCategoryTab,
} from './skill-center-model.js'

export interface SkillCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline explicitly (for tests and unified SSR assertions). */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: SkillCategoryTab[] = ['all', 'builtin', 'plugins', 'agents', 'workspace']

/**
 * Full-screen skill center (primary stage) container:
 * - a system-level full-screen view managing model tool skills, playbooks and
 *   code reference guides;
 * - top bar: title, split actions and the refresh action;
 * - search bar: fuzzy search across ID / name / description / reference file
 *   paths, combined with category pill tabs;
 * - responsive card grid: SkillCard cells, zero emoji;
 * - detail & doc reader drawer: SkillDetailDrawer showing SKILL.md and
 *   references/*.md;
 * - deep URL integration: #/settings/skills/<skillId> direct links and
 *   browser history sync;
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: SkillCenterProps): React.JSX.Element {
  const skills = useSkills() ?? []
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshAssets } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')

  const categoryCounts = useMemo(() => buildSkillCategoryCounts(skills), [skills])

  const filteredSkills = useMemo(() => {
    return filterSkills(skills, {
      query,
      categoryTab: activeTab,
    })
  }, [skills, query, activeTab])

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const selectedSkillId =
    currentTarget && currentTarget.kind === 'skills' ? currentTarget.skillId : undefined

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  )

  const isDrawerOpen = Boolean(selectedSkillId && selectedSkill)

  const handleSelectSkill = (skillId: string) => {
    openTarget({ kind: 'skills', skillId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    openTarget({ kind: 'skills' }, isSplit ? { split: true } : undefined)
  }

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget({ kind: 'skills', skillId: selectedSkillId }, { split: true })
  }

  return (
    <div className={`primary-center skill-center${isSplit ? ' is-split' : ''}`} data-view="skill-center">
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="sparkles" size={14} />
            <span>{t('skills.center.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void refreshAssets?.()}
            title={t('skills.center.refreshTitle')}
          >
            <HelmxIcon name="refresh-cw" size={12} />
            <span className="pane-action-label">{t('common.refresh')}</span>
          </button>
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      {/* Search bar and category filter pills */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmxIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t('skills.center.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('skills.center.searchLabel')}
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title={t('skills.center.clearSearch')}
              aria-label={t('skills.center.clearSearch')}
              onClick={() => setQuery('')}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="primary-category-pills" role="tablist" aria-label={t('skills.center.filterLabel')}>
          {CATEGORY_TABS.map((tabKey) => {
            const count = categoryCounts[tabKey] ?? 0
            const isActive = activeTab === tabKey
            return (
              <button
                key={tabKey}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tabKey)}
              >
                <span>{skillCategoryTabLabel(tabKey, t)}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Main viewport: responsive card grid or empty state */}
      <div className="primary-center-content">
        {filteredSkills.length > 0 ? (
          <div className="primary-center-grid">
            {filteredSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                selected={selectedSkillId === skill.id}
                onSelect={() => handleSelectSkill(skill.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmxIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">{t('skills.center.emptyTitle')}</div>
            <div className="primary-center-empty-hint">{t('skills.center.emptyHint')}</div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('skills.center.resetFilters')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right slide-over details and documentation reader drawer */}
      <SkillDetailDrawer
        skill={selectedSkill}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
      />
    </div>
  )
}
