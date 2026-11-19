import React, { useEffect, useMemo, useState } from 'react'
import type { Profile } from './profile-center-model.js'
import {
  buildProfileCategoryCounts,
  filterProfiles,
  profileCategoryTabLabel,
  PROFILE_CATEGORY_TABS,
  type ProfileCategoryTab,
} from './profile-center-model.js'
import { ProfileCard } from './ProfileCard.js'
import { ProfileDetailDrawer } from './ProfileDetailDrawer.js'
import { HelmxIcon } from '@helmx/plugin-client'
import { assetsApi } from '../lib/api.js'
import {
  useAuthenticated,
  useLocationTargets,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'

export interface ProfileCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline explicitly (for tests and unified SSR assertions). */
  inlineDrawer?: boolean
}

/**
 * Full-screen agent profile center (primary stage):
 * - top bar: title, subtitle, summary stats, new-profile button and split-close actions;
 * - toolbar: multi-dimension search box and category pill tabs (with count badges);
 * - content: responsive card grid or empty state;
 * - detail & edit drawer: right slide-over ProfileDetailDrawer synced with store.primaryTarget;
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function ProfileCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: ProfileCenterProps): React.JSX.Element {
  const authenticated = useAuthenticated()
  const { profiles } = useProfilesSlice()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshAssets, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ProfileCategoryTab>('all')
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [fetchedDefaultModel, setFetchedDefaultModel] = useState<{
    defaultModel: string
    defaultThinkingLevel: string
  } | null>(null)

  const effectiveDefaultModelInfo = fetchedDefaultModel

  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    void assetsApi
      .getDefaultModel()
      .then((info) => {
        if (!cancelled) setFetchedDefaultModel(info)
      })
      .catch(() => {
        if (!cancelled) setFetchedDefaultModel(null)
      })
    return () => {
      cancelled = true
    }
  }, [authenticated])

  const categoryCounts = useMemo(() => buildProfileCategoryCounts(profiles), [profiles])

  const filteredProfiles = useMemo(() => {
    return filterProfiles(profiles, {
      query,
      categoryTab: activeTab,
    })
  }, [profiles, query, activeTab])

  const activeTarget = isSplit ? splitTarget : primaryTarget
  const selectedProfileId =
    activeTarget?.kind === 'profiles' ? activeTarget.profileId : undefined

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )

  const isDrawerOpen = Boolean(
    (selectedProfileId && selectedProfile) ||
      isCreatingNew ||
      selectedProfileId === 'new',
  )

  const openCenterTarget = (profileId?: string) => {
    const target =
      profileId !== undefined
        ? { kind: 'profiles' as const, profileId }
        : { kind: 'profiles' as const }
    if (isSplit) {
      openTarget(target, { split: true })
    } else {
      openTarget(target)
    }
  }

  const handleSelectProfile = (profileId: string) => {
    setIsCreatingNew(false)
    openCenterTarget(profileId)
  }

  const handleCreateNew = () => {
    setIsCreatingNew(true)
    openCenterTarget('new')
  }

  const handleCloseDrawer = () => {
    setIsCreatingNew(false)
    openCenterTarget(undefined)
  }

  const handleProfileSaved = (saved: Profile) => {
    setIsCreatingNew(false)
    void refreshAssets()
    pushNotice({
      type: 'notification',
      level: 'info',
      title: t('profiles.notice.savedTitle'),
      body: t('profiles.notice.savedBody', { name: saved.name || saved.id }),
    })
    openCenterTarget(saved.id)
  }

  const handleProfileDeleted = (deletedId: string) => {
    setIsCreatingNew(false)
    void refreshAssets()
    pushNotice({
      type: 'notification',
      level: 'info',
      title: t('profiles.notice.deletedTitle'),
      body: t('profiles.notice.deletedBody', { id: deletedId }),
    })
    openCenterTarget(undefined)
  }

  const handleResetFilters = () => {
    setQuery('')
    setActiveTab('all')
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
    openTarget({ kind: 'profiles', profileId: selectedProfileId }, { split: true })
  }

  return (
    <div
      className={`primary-center${isSplit ? ' is-split' : ''}`}
      data-view="profile-center"
    >
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="bot" size={14} />
            <span>{t('profiles.center.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleCreateNew}
          >
            <HelmxIcon name="plus" size={12} />
            <span className="pane-action-label">{t('profiles.center.newProfile')}</span>
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

      {/* Toolbar: search and category tabs */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmxIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t('profiles.center.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('profiles.center.searchLabel')}
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title={t('profiles.center.clearSearch')}
              aria-label={t('profiles.center.clearSearch')}
              onClick={() => setQuery('')}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div
          className="primary-category-pills"
          role="tablist"
          aria-label={t('profiles.center.filterLabel')}
        >
          {PROFILE_CATEGORY_TABS.map((tab) => {
            const count = categoryCounts[tab.key] ?? 0
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span>{profileCategoryTabLabel(tab.key, t)}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Main viewport: responsive card grid or empty state */}
      <div className="primary-center-content">
        {filteredProfiles.length > 0 ? (
          <div className="primary-center-grid">
            {filteredProfiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                selected={selectedProfileId === p.id}
                defaultModelInfo={effectiveDefaultModelInfo}
                onSelect={() => handleSelectProfile(p.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmxIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">{t('profiles.center.emptyTitle')}</div>
            <div className="primary-center-empty-hint">{t('profiles.center.emptyHint')}</div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleResetFilters}
              >
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('profiles.center.resetFilters')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 540px right slide-over detail and edit drawer */}
      <ProfileDetailDrawer
        profile={selectedProfile}
        isNew={isCreatingNew || selectedProfileId === 'new'}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
        onSaved={handleProfileSaved}
        onDeleted={handleProfileDeleted}
      />
    </div>
  )
}
