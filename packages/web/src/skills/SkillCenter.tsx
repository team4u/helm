import React, { useEffect, useMemo, useState } from 'react'
import { HelmxIcon, Select } from '@helmx/plugin-client'
import type { SelectOption } from '@helmx/plugin-client'
import {
  useConversations,
  useLocationTargets,
  useProfilesSlice,
  useSkills,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { SkillCard } from './SkillCard.js'
import { SkillDetailDrawer } from './SkillDetailDrawer.js'
import {
  buildSkillCategoryCounts,
  filterSkills,
  skillCategoryTabLabel,
  skillsApi,
  type SkillCategoryTab,
} from './skill-center-model.js'
import { readScopedSkillFile } from './skill-scope-api.js'
import {
  buildSkillScopeCandidates,
  isNodeSourceSkill,
  parseSkillScopeEnv,
  skillScopeKey,
  skillScopeTargetEnv,
} from './skill-scope-model.js'
import { useScopedSkillCatalog } from './use-scoped-skills.js'

export interface SkillCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline explicitly (for tests and unified SSR assertions). */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: SkillCategoryTab[] = ['all', 'builtin', 'plugins', 'agents', 'node', 'workspace']

/** Sentinel value of the scope picker's Hub (default) option (never empty:
 * Radix Select items reject empty-string values; scope keys contain a NUL
 * separator so they can never collide with the sentinel). */
const HUB_SCOPE_VALUE = '__hub__'

/**
 * Full-screen skill center (primary stage) container:
 * - a system-level full-screen view managing model tool skills, playbooks and
 *   code reference guides;
 * - scope picker: the Hub dataDir catalog by default, or the merged Hub+node
 *   catalog of a physical (nodeId, cwd) workspace (candidates deduped from
 *   conversations and explicit profile cwds); the scope rides the skills
 *   target's own node/cwd query params (the agent standby env precedent:
 *   top-level for the primary, inside the split value for the split pane), so
 *   deep links, refresh and back/forward all restore it, and detail
 *   open/close keeps the scope;
 * - top bar: title, split actions and the refresh action (scoped reload vs
 *   Hub asset refresh);
 * - search bar: fuzzy search across ID / name / description / reference file
 *   paths, combined with category pill tabs (node-sourced skills form their
 *   own category; node offline / same-name shadowing report as explicit
 *   callouts, never silently degrading);
 * - responsive card grid: SkillCard cells, zero emoji;
 * - detail & doc reader drawer: SkillDetailDrawer showing SKILL.md and
 *   references/*.md (node-sourced skills read through the builtin:profile
 *   action with the current coordinates);
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: SkillCenterProps): React.JSX.Element {
  const hubSkills = useSkills() ?? []
  const conversations = useConversations()
  const { profiles } = useProfilesSlice()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshAssets, invokePluginAction } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')
  const [reloadSeq, setReloadSeq] = useState(0)

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const targetEnv =
    currentTarget !== null && currentTarget.kind === 'skills'
      ? { nodeId: currentTarget.nodeId, cwd: currentTarget.cwd }
      : undefined
  // Physical scope from the target env (single source of truth): Hub when
  // unset; partial node/cwd pairs self-heal away below.
  const { scope, partial } = useMemo(() => parseSkillScopeEnv(targetEnv), [targetEnv])

  const scopeCandidates = useMemo(
    () => buildSkillScopeCandidates(conversations, profiles),
    [conversations, profiles],
  )

  const scopedCatalog = useScopedSkillCatalog(scope, invokePluginAction, reloadSeq)

  // Hub scope consumes the store's /api/skills list; a physical scope consumes
  // the merged action catalog (empty while loading — never a phantom Hub list).
  const skills = useMemo(
    () => (scope === undefined ? hubSkills : scopedCatalog.catalog?.skills ?? []),
    [scope, hubSkills, scopedCatalog.catalog],
  )

  const categoryCounts = useMemo(() => buildSkillCategoryCounts(skills), [skills])

  const filteredSkills = useMemo(() => {
    return filterSkills(skills, {
      query,
      categoryTab: activeTab,
    })
  }, [skills, query, activeTab])

  const selectedSkillId =
    currentTarget && currentTarget.kind === 'skills' ? currentTarget.skillId : undefined

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  )

  const isDrawerOpen = Boolean(selectedSkillId && selectedSkill)

  // Half env pairs (only node or only cwd) are untrustworthy: self-heal back to
  // the Hub scope with a replace navigation, keeping the detail selection.
  useEffect(() => {
    if (!partial) return
    openTarget(skillScopeTargetEnv(undefined, { skillId: selectedSkillId }), {
      ...(isSplit ? { split: true } : {}),
      history: 'replace',
    })
  }, [partial, isSplit, openTarget, selectedSkillId])

  // Detail open/close keeps the scope coordinates (they ride the target).
  const handleSelectSkill = (skillId: string) => {
    openTarget(
      skillScopeTargetEnv(scope, { skillId }),
      isSplit ? { split: true } : undefined,
    )
  }

  const handleCloseDrawer = () => {
    openTarget(skillScopeTargetEnv(scope), isSplit ? { split: true } : undefined)
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
    openTarget(skillScopeTargetEnv(scope, { skillId: selectedSkillId }), { split: true })
  }

  // Scope switching is an env-level change of the same skills center slot
  // (the agent standby draft-env precedent): replace history and drop the
  // stale detail selection in one navigation write.
  const scopeOptions: Array<SelectOption<string>> = useMemo(() => {
    const options: Array<SelectOption<string>> = [
      { value: HUB_SCOPE_VALUE, label: t('skills.scope.hub'), meta: t('skills.scope.hubMeta') },
    ]
    for (const candidate of scopeCandidates) {
      options.push({
        value: skillScopeKey(candidate),
        label: candidate.cwd,
        meta:
          candidate.origin === 'conversation'
            ? `${t('skills.scope.conversationMeta')} · ${candidate.nodeId}`
            : `${t('skills.scope.profileMeta')} · ${candidate.nodeId}`,
      })
    }
    // A deep-linked coordinate with no matching conversation/profile stays
    // selectable and honestly visible (never silently swapped for Hub).
    const currentKey = scope === undefined ? HUB_SCOPE_VALUE : skillScopeKey(scope)
    if (scope !== undefined && !options.some((option) => option.value === currentKey)) {
      options.push({ value: currentKey, label: scope.cwd, meta: scope.nodeId })
    }
    return options
  }, [scopeCandidates, scope, t])

  const handleScopeChange = (nextValue: string) => {
    const nextScope =
      nextValue === HUB_SCOPE_VALUE
        ? undefined
        : scopeCandidates.find((candidate) => skillScopeKey(candidate) === nextValue) ??
          (scope !== undefined && skillScopeKey(scope) === nextValue ? scope : undefined)
    openTarget(skillScopeTargetEnv(nextScope), {
      ...(isSplit ? { split: true } : {}),
      history: 'replace',
    })
  }

  const handleRefresh = () => {
    if (scope !== undefined) {
      setReloadSeq((seq) => seq + 1)
      return
    }
    void refreshAssets?.()
  }

  // Node-sourced skill files read through the builtin:profile action with the
  // current coordinates; Hub-sourced files keep the direct asset read.
  const drawerReader = useMemo(() => {
    if (scope === undefined) return undefined
    return (skillId: string, path?: string) => {
      const summary = skills.find((s) => s.id === skillId)
      if (summary !== undefined && isNodeSourceSkill(summary)) {
        return readScopedSkillFile(invokePluginAction, scope, skillId, path)
      }
      return skillsApi.read(skillId, path)
    }
  }, [scope, skills, invokePluginAction])

  const shadowedNodeSkillIds = scopedCatalog.catalog?.shadowedNodeSkillIds ?? []
  const nodeUnavailable = scopedCatalog.catalog?.nodeUnavailable
  const scopeLoadError = scopedCatalog.error
  const scopeLoading = scope !== undefined && scopedCatalog.loading

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
            onClick={handleRefresh}
            title={scope === undefined ? t('skills.center.refreshTitle') : t('skills.scope.reloadTitle')}
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

      {/* Search bar, scope picker and category filter pills */}
      <div className="primary-center-toolbar">
        <div className="skill-scope-picker">
          <Select
            className="skill-scope-select"
            size="sm"
            inline={inlineDrawer}
            value={scope === undefined ? HUB_SCOPE_VALUE : skillScopeKey(scope)}
            options={scopeOptions}
            onChange={(ev) => handleScopeChange(ev.target.value)}
            aria-label={t('skills.scope.label')}
            prefixIcon="server"
          />
        </div>

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

      {/* Scope diagnostics: explicit node-unavailable / shadowing / load errors */}
      {scope !== undefined && (
        <div className="skill-scope-diagnostics">
          {scopeLoadError !== null && (
            <div className="callout callout-error" role="alert">
              <HelmxIcon name="alert-circle" size={13} />
              <span className="callout-text">{t('skills.scope.loadFailed', { error: scopeLoadError })}</span>
              <button type="button" className="btn btn-sm" onClick={() => setReloadSeq((seq) => seq + 1)}>
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('skills.scope.retry')}</span>
              </button>
            </div>
          )}
          {scopeLoadError === null && nodeUnavailable !== undefined && (
            <div className="callout callout-warn" role="alert">
              <HelmxIcon name="alert-triangle" size={13} />
              <span className="callout-text">{t('skills.scope.nodeUnavailable', { reason: nodeUnavailable })}</span>
            </div>
          )}
          {scopeLoadError === null && shadowedNodeSkillIds.length > 0 && (
            <div className="callout" role="status">
              <HelmxIcon name="layers" size={13} />
              <span className="callout-text">
                {t('skills.scope.shadowed', { ids: shadowedNodeSkillIds.join(', ') })}
              </span>
            </div>
          )}
          {scopeLoading && scopeLoadError === null && (
            <div className="skill-scope-loading text-subtle" role="status">
              <HelmxIcon name="loader" size={12} className="spin" />
              <span>{t('skills.scope.loading')}</span>
            </div>
          )}
        </div>
      )}

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
        readSkill={drawerReader}
        nodeScope={scope}
      />
    </div>
  )
}
