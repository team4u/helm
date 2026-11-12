import React, { useMemo, useState } from 'react'
import type { Profile } from './profile-center-model.js'
import {
  buildProfileCategoryCounts,
  filterProfiles,
  PROFILE_CATEGORY_TABS,
  summarizeProfiles,
  type ProfileCategoryTab,
} from './profile-center-model.js'
import { ProfileCard } from './ProfileCard.js'
import { ProfileDetailDrawer } from './ProfileDetailDrawer.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export interface ProfileCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

/**
 * 全屏智能体角色中心（Profile Center）主视图：
 * - 升格为系统一级主舞台全屏视图；
 * - 顶栏：标题、副标题、统计摘要、新建角色按钮与分屏关闭操作；
 * - 工具栏：多维检索搜索框与分类药丸标签栏（带数量徽章）；
 * - 内容区：响应式卡片流式网格或空状态；
 * - 详情与配置抽屉：右侧滑出 ProfileDetailDrawer，与 store.primaryTarget 紧密同步；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function ProfileCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: ProfileCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ProfileCategoryTab>('all')
  const [isCreatingNew, setIsCreatingNew] = useState(false)

  const profiles = store.profiles ?? []
  const categoryCounts = useMemo(() => buildProfileCategoryCounts(profiles), [profiles])

  const filteredProfiles = useMemo(() => {
    return filterProfiles(profiles, {
      query,
      categoryTab: activeTab,
    })
  }, [profiles, query, activeTab])

  const selectedProfileId =
    store.primaryTarget.kind === 'profiles' ? store.primaryTarget.profileId : undefined

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )

  const isDrawerOpen = Boolean(
    (selectedProfileId && selectedProfile) ||
      isCreatingNew ||
      selectedProfileId === 'new',
  )

  const handleSelectProfile = (profileId: string) => {
    setIsCreatingNew(false)
    store.openTarget({ kind: 'profiles', profileId })
  }

  const handleCreateNew = () => {
    setIsCreatingNew(true)
    store.openTarget({ kind: 'profiles', profileId: 'new' })
  }

  const handleCloseDrawer = () => {
    setIsCreatingNew(false)
    store.openTarget({ kind: 'profiles' })
  }

  const handleProfileSaved = (saved: Profile) => {
    setIsCreatingNew(false)
    void store.refreshAssets()
    store.pushNotice({
      type: 'notification',
      level: 'info',
      title: '角色已保存',
      body: `${saved.name || saved.id} 配置已更新`,
    })
    store.openTarget({ kind: 'profiles', profileId: saved.id })
  }

  const handleProfileDeleted = (deletedId: string) => {
    setIsCreatingNew(false)
    void store.refreshAssets()
    store.pushNotice({
      type: 'notification',
      level: 'info',
      title: '角色已删除',
      body: `角色 ${deletedId} 已彻底删除`,
    })
    store.openTarget({ kind: 'profiles' })
  }

  const handleResetFilters = () => {
    setQuery('')
    setActiveTab('all')
  }

  return (
    <div
      className={`primary-center${isSplit ? ' is-split' : ''}`}
      data-view="profile-center"
    >
      {/* 顶栏：标题与操作 */}
      <div className="primary-center-topbar">
        <div className="primary-center-title-wrap">
          <div className="primary-center-title">
            <HelmIcon name="bot" size={16} />
            <span>智能体角色中心</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleCreateNew}
          >
            <HelmIcon name="plus" size={13} />
            <span>新建角色</span>
          </button>
          {isSplit && onCloseSplit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="关闭分屏"
              aria-label="关闭分屏"
              onClick={onCloseSplit}
            >
              <HelmIcon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 工具栏：检索与分类标签 */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder="搜索角色名称、ID、模型、标签或技能…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索角色"
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div
          className="primary-category-pills"
          role="tablist"
          aria-label="角色分类筛选"
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
                <span>{tab.label}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 主视口：自适应响应式卡片网格或空状态 */}
      <div className="primary-center-content">
        {filteredProfiles.length > 0 ? (
          <div className="primary-center-grid">
            {filteredProfiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                selected={selectedProfileId === p.id}
                onSelect={() => handleSelectProfile(p.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">未找到匹配的角色</div>
            <div className="primary-center-empty-hint">
              请尝试调整搜索关键字或切换分类标签。
            </div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleResetFilters}
              >
                <HelmIcon name="rotate-ccw" size={12} />
                <span>重置筛选条件</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 540px 右侧滑出式详情与编辑抽屉 */}
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
