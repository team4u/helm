/**
 * builtin:apps app center launchpad (client.tsx, component exports only to
 * keep the Fast Refresh contract).
 *
 * All data comes from @helm/plugin-client shared hooks (usePlugins /
 * usePluginDoc), no polling:
 * - app list: left join of host plugins + screens (non-builtin external
 *   plugin with at least one Screen);
 * - product metadata (pinned/category/origin conversation): the builtin:apps
 *   public catalog doc (registered by the backend; when missing we honestly
 *   fall back to the plugin summary itself, never fabricate).
 * Opening an app goes exclusively through ctx.openScreen / ctx.openSplitScreen;
 * the 3-dot button in the card footer opens the standard in-place detail
 * drawer (keeps the app-center context instead of navigating away), which
 * supports direct view access, iterating in the origin conversation and
 * uninstalling the app outright; filter tab, search query and the selected
 * app id are written into ScreenProps.params (sp.* / ssp.* deep-link
 * namespaces).
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged.
 */
import { useEffect, useMemo, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmIcon,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  usePlugins,
} from '@helm/plugin-client'
import {
  appScreenTarget,
  filterAppItems,
  formatAppTabParam,
  mergeAppItems,
  normalizeAppCategory,
  parseAppTabParam,
  summarizeAppItems,
  type AppCatalogDoc,
  type AppItem,
  type AppTabParam,
} from './models.ts'
import {
  APP_BADGE_PINNED,
  APP_CANCEL,
  APP_CLOSE,
  APP_DELETE_CONFIRM,
  APP_DELETE_CONFIRM_LABEL,
  APP_DELETING,
  APP_DETAIL_TITLE,
  APP_DESCRIPTION_FALLBACK,
  APP_EMPTY_HINT_NO_APPS,
  APP_EMPTY_HINT_NO_MATCH,
  APP_EMPTY_NO_APPS,
  APP_EMPTY_NO_MATCH,
  APP_ENABLE_LABEL,
  APP_ENABLE_TITLE,
  APP_FILTER_LABEL,
  APP_ITERATE,
  APP_ITERATE_DISABLED_TITLE,
  APP_ITERATE_TITLE,
  APP_KV_APP_ID,
  APP_KV_CATEGORY,
  APP_KV_INSTALL_SOURCE,
  APP_KV_ORIGIN_CONVERSATION,
  APP_KV_PINNED,
  APP_KV_VERSION,
  APP_KV_WORKSPACE,
  APP_OPEN_SPLIT_LABEL,
  APP_OPEN_SPLIT_TITLE,
  APP_OPEN_VIEW_LABEL,
  APP_OPEN_VIEW_SPLIT_LABEL,
  APP_OPEN_VIEW_TITLE,
  APP_PINNED_NO,
  APP_PINNED_TITLE,
  APP_PINNED_YES,
  APP_RESET_FILTERS,
  APP_SEARCH_CLEAR,
  APP_SEARCH_LABEL,
  APP_SEARCH_PLACEHOLDER,
  APP_STATUS_READY,
  APP_STATUS_STOPPED,
  APP_STOPPED_PILL,
  APP_STOPPED_PILL_TITLE,
  APP_TAB_ALL,
  APP_TAB_PINNED,
  APP_UNINSTALL,
  APP_UNINSTALL_LABEL,
  APP_UNINSTALL_TITLE,
  APP_CENTER_SUBTITLE,
  APP_CENTER_TITLE,
  appActionsCount,
  appActionsSectionTitle,
  appCategoryLabel,
  appCenterStats,
  appDescriptionFromViews,
  appDetailDialogLabel,
  appOriginJumpTitle,
  appVersionTitle,
  appViewsCount,
  appViewsSectionTitle,
} from './copy.ts'

/** Single app card: icon/name/status/description + quick open (main/split pane) + detail drawer entry. */
function AppCard({
  item,
  onOpen,
  onOpenSplit,
  onShowDetail,
  onEnableInPluginCenter,
}: {
  item: AppItem
  onOpen: (target: string) => void
  onOpenSplit: (target: string) => void
  onShowDetail: () => void
  onEnableInPluginCenter: () => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { plugin, screens, catalog } = item
  const target = appScreenTarget(item)
  const isReady = plugin.enabled && target !== null
  const versionLabel = plugin.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const iconName = catalog?.icon ?? 'layout-grid'
  const categoryLabel = appCategoryLabel(normalizeAppCategory(catalog?.category), locale)
  const description =
    plugin.description && plugin.description.trim() !== ''
      ? plugin.description
      : screens.length > 0
        ? appDescriptionFromViews(screens.map((s) => s.label), locale)
        : t(APP_DESCRIPTION_FALLBACK)

  return (
    <div
      className={`app-card${plugin.enabled ? '' : ' is-disabled'}`}
      data-app-id={plugin.id}
      role="button"
      tabIndex={0}
      aria-label={plugin.name || plugin.id}
      onClick={() => {
        if (isReady && target !== null) onOpen(target)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (isReady && target !== null) onOpen(target)
        }
      }}
    >
      <div className="app-card-header">
        <div className="app-card-icon-wrap">
          <HelmIcon name={iconName} size={16} />
        </div>
        <div className="app-card-meta">
          <div className="app-card-title-row">
            <span className="app-card-name" title={plugin.name || plugin.id}>
              {plugin.name || plugin.id}
            </span>
            {versionLabel && <span className="app-card-version">{versionLabel}</span>}
            {catalog?.pinned === true && (
              <span className="badge badge-neutral" title={t(APP_PINNED_TITLE)}>
                {t(APP_BADGE_PINNED)}
              </span>
            )}
            {plugin.enabled ? (
              <span className="badge badge-ok">{t(APP_STATUS_READY)}</span>
            ) : (
              <span className="badge badge-neutral">{t(APP_STATUS_STOPPED)}</span>
            )}
          </div>
          <div className="app-card-id" title={plugin.id}>
            {plugin.id}
            {categoryLabel !== undefined && <span className="app-card-category"> · {categoryLabel}</span>}
          </div>
        </div>
      </div>

      <div className="app-card-desc" title={description}>
        {description}
      </div>

      <div className="app-card-footer">
        <div className="app-card-pills">
          {screens.length > 0 ? (
            <span className="app-card-pill" title={appViewsCount(screens.length, locale)}>
              {appViewsCount(screens.length, locale)}
            </span>
          ) : (
            <span className="app-card-pill" title={t(APP_STOPPED_PILL_TITLE)}>
              {t(APP_STOPPED_PILL)}
            </span>
          )}
          {(plugin.actions?.length ?? 0) > 0 && (
            <span className="app-card-pill" title={appActionsCount(plugin.actions.length, locale)}>
              {appActionsCount(plugin.actions.length, locale)}
            </span>
          )}
        </div>
        <div className="app-card-actions">
          {isReady && target !== null ? (
            <button
              type="button"
              className="btn btn-xs btn-icon-xs"
              title={t(APP_OPEN_SPLIT_TITLE)}
              aria-label={t(APP_OPEN_SPLIT_LABEL)}
              onClick={(e) => {
                e.stopPropagation()
                onOpenSplit(target)
              }}
            >
              <HelmIcon name="columns" size={11} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-xs"
              title={t(APP_ENABLE_TITLE)}
              onClick={(e) => {
                e.stopPropagation()
                onEnableInPluginCenter()
              }}
            >
              <HelmIcon name="settings" size={10} />
              <span>{t(APP_ENABLE_LABEL)}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-xs btn-icon-xs"
            title={t(APP_DETAIL_TITLE)}
            aria-label={t(APP_DETAIL_TITLE)}
            onClick={(e) => {
              e.stopPropagation()
              onShowDetail()
            }}
          >
            <HelmIcon name="more" size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * App detail drawer: a side drawer 100% aligned with the Skills/Profiles/
 * Plugins drawer conventions. It opens in place inside the app center — no
 * page navigation, no menu selection change — and offers direct view access,
 * "return to the origin conversation to keep iterating" and an
 * "uninstall/delete the app" action next to the footer.
 */
function AppDetailDrawer({
  item,
  inline,
  onClose,
}: {
  item: AppItem
  inline?: boolean
  onClose: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { plugin, screens, catalog } = item
  const originConversationId = catalog?.originConversationId
  const iterateTarget = appScreenTarget(item)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setConfirmDelete(false)
    setDeleting(false)
    setDeleteError(null)
  }, [plugin.id])

  const handleIterate = () => {
    if (originConversationId === undefined || iterateTarget === null) return
    ctx.openScreen(`conversation:${originConversationId}`)
    ctx.openSplitScreen(iterateTarget)
  }

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await ctx.callAction('remove', { pluginId: plugin.id })
      setConfirmDelete(false)
      onClose()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const versionLabel = plugin.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const categoryLabel = appCategoryLabel(normalizeAppCategory(catalog?.category), locale)
  const description =
    plugin.description && plugin.description.trim() !== ''
      ? plugin.description
      : screens.length > 0
        ? appDescriptionFromViews(screens.map((s) => s.label), locale)
        : t(APP_DESCRIPTION_FALLBACK)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content app-detail-drawer"
          role="dialog"
          aria-label={appDetailDialogLabel(plugin.name || plugin.id, locale)}
        >
          {/* Drawer header: reuses the primary-drawer-header conventions */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <HelmIcon name={catalog?.icon ?? 'layout-grid'} size={18} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">
                    {plugin.name || plugin.id}
                  </DialogTitle>
                  {versionLabel && (
                    <span className="badge badge-neutral mono" title={appVersionTitle(versionLabel, locale)}>
                      {versionLabel}
                    </span>
                  )}
                  {catalog?.pinned === true && (
                    <span className="badge badge-neutral" title={t(APP_PINNED_TITLE)}>
                      {t(APP_BADGE_PINNED)}
                    </span>
                  )}
                  {plugin.enabled ? (
                    <span className="badge badge-ok">{t(APP_STATUS_READY)}</span>
                  ) : (
                    <span className="badge badge-neutral">{t(APP_STATUS_STOPPED)}</span>
                  )}
                </div>
                <div className="primary-drawer-id mono">{plugin.id}</div>
              </div>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t(APP_CLOSE)} title={t(APP_CLOSE)}>
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* Drawer body: reuses the primary-drawer-body conventions */}
          <div className="primary-drawer-body">
            {description && (
              <div className="app-detail-desc text-secondary" style={{ fontSize: '13px', lineHeight: 1.5 }}>
                {description}
              </div>
            )}

            <div className="form-grid">
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{t(APP_KV_APP_ID)}</span></span>
                <span className="form-grid-value mono">{plugin.id}</span>
              </div>
              {versionLabel && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(APP_KV_VERSION)}</span></span>
                  <span className="form-grid-value mono">{versionLabel}</span>
                </div>
              )}
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{t(APP_KV_CATEGORY)}</span></span>
                <span className="badge badge-neutral">{categoryLabel}</span>
              </div>
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{t(APP_KV_PINNED)}</span></span>
                <span className="form-grid-value">
                  {catalog?.pinned ? t(APP_PINNED_YES) : t(APP_PINNED_NO)}
                </span>
              </div>
              {catalog?.workspaceDir && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(APP_KV_WORKSPACE)}</span></span>
                  <span className="form-grid-value mono" title={catalog.workspaceDir}>
                    {catalog.workspaceDir}
                  </span>
                </div>
              )}
              {plugin.managed?.source && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(APP_KV_INSTALL_SOURCE)}</span></span>
                  <span className="form-grid-value mono" title={plugin.managed.source.raw}>
                    {plugin.managed.source.raw}
                  </span>
                </div>
              )}
              {originConversationId !== undefined && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(APP_KV_ORIGIN_CONVERSATION)}</span></span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs mono"
                    title={appOriginJumpTitle(originConversationId, locale)}
                    onClick={() => ctx.openScreen(`conversation:${originConversationId}`)}
                  >
                    <HelmIcon name="message-square" size={11} />
                    <span>#{originConversationId}</span>
                  </button>
                </div>
              )}
            </div>

            {screens.length > 0 && (
              <div className="app-detail-section">
                <h4 className="app-detail-section-title">
                  <HelmIcon name="monitor" size={13} />
                  <span>{appViewsSectionTitle(screens.length, locale)}</span>
                </h4>
                {screens.map((screen) => {
                  const target = `screen:${screen.pluginId}/${screen.screenId}`
                  return (
                    <div key={screen.screenId} className="app-detail-screen-row">
                      <span className="app-detail-screen-label" title={`${screen.pluginId}/${screen.screenId}`}>
                        <HelmIcon name="layout" size={13} />
                        <span>{screen.label || screen.screenId}</span>
                      </span>
                      <div className="app-detail-screen-actions">
                        <button
                          type="button"
                          className="btn btn-xs"
                          title={t(APP_OPEN_VIEW_TITLE)}
                          onClick={() => ctx.openScreen(target)}
                        >
                          <HelmIcon name="play" size={11} />
                          <span>{t(APP_OPEN_VIEW_LABEL)}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-icon-xs"
                          title={t(APP_OPEN_SPLIT_TITLE)}
                          aria-label={t(APP_OPEN_VIEW_SPLIT_LABEL)}
                          onClick={() => ctx.openSplitScreen(target)}
                        >
                          <HelmIcon name="columns" size={11} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {(plugin.actions?.length ?? 0) > 0 && (
              <div className="app-detail-section">
                <h4 className="app-detail-section-title">
                  <HelmIcon name="zap" size={13} />
                  <span>{appActionsSectionTitle(plugin.actions?.length ?? 0, locale)}</span>
                </h4>
                <div className="plugin-capability-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {plugin.actions?.map((act) => (
                    <span key={act} className="badge badge-neutral mono" title={act}>
                      {act}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {deleteError !== null && (
            <div className="text-danger" style={{ padding: '0 20px 8px', fontSize: '12px' }}>
              {deleteError}
            </div>
          )}

          {/* Drawer footer: reuses the primary-drawer-footer conventions */}
          <div className="primary-drawer-footer">
            {confirmDelete ? (
              <div className="app-detail-delete-confirm">
                <span className="text-subtle">{t(APP_DELETE_CONFIRM)}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  <span>{t(APP_CANCEL)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={deleting}
                  onClick={handleDelete}
                >
                  <HelmIcon name="trash-2" size={12} />
                  <span>{deleting ? t(APP_DELETING) : t(APP_DELETE_CONFIRM_LABEL)}</span>
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onClose}
                >
                  <span>{t(APP_CLOSE)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={originConversationId === undefined || iterateTarget === null || !plugin.enabled}
                  title={
                    originConversationId === undefined
                      ? t(APP_ITERATE_DISABLED_TITLE)
                      : t(APP_ITERATE_TITLE)
                  }
                  onClick={handleIterate}
                >
                  <HelmIcon name="message-square" size={12} />
                  <span>{t(APP_ITERATE)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-danger"
                  title={t(APP_UNINSTALL_TITLE)}
                  aria-label={t(APP_UNINSTALL_LABEL)}
                  onClick={() => setConfirmDelete(true)}
                >
                  <HelmIcon name="trash-2" size={12} />
                  <span>{t(APP_UNINSTALL)}</span>
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

export interface AppCenterScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

export function AppCenterScreen(props: AppCenterScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { plugins, screens } = usePlugins()
  const catalog = usePluginDoc<AppCatalogDoc | undefined>('catalog')

  // Deep-link params (sp.* / ssp.* namespaces): tab / q / app are written back
  // through setParams, the only navigation mechanism.
  const tab = useMemo(() => parseAppTabParam(props.params['tab']), [props.params])
  const queryFromUrl = props.params['q'] ?? ''
  const selectedAppId = props.params['app']
  const [queryDraft, setQueryDraft] = useState(queryFromUrl)
  const query = queryDraft

  const items = useMemo(() => mergeAppItems(plugins, screens, catalog), [plugins, screens, catalog])
  const stats = useMemo(() => summarizeAppItems(items), [items])
  const filtered = useMemo(() => filterAppItems(items, { query, tab }), [items, query, tab])
  const selectedItem = selectedAppId !== undefined ? items.find((i) => i.plugin.id === selectedAppId) : undefined

  const setTab = (next: AppTabParam) => {
    props.setParams({ tab: formatAppTabParam(next) })
  }

  const setQuery = (next: string) => {
    setQueryDraft(next)
    props.setParams({ q: next === '' ? undefined : next })
  }

  const showDetail = (pluginId: string) => {
    props.setParams({ app: pluginId })
  }

  return (
    <div className="apps-center" data-view="app-center">
      <div className="apps-center-topbar">
        <div className="apps-center-title-wrap">
          <div className="apps-center-title">
            <HelmIcon name="layout-grid" size={16} />
            <span>{t(APP_CENTER_TITLE)}</span>
          </div>
          <span className="apps-center-subtitle text-subtle">
            {t(APP_CENTER_SUBTITLE)}
          </span>
        </div>
        <div className="apps-center-topbar-actions">
          <span className="apps-center-stats text-subtle">
            {appCenterStats(stats.total, stats.ready, locale)}
          </span>
        </div>
      </div>

      <div className="apps-center-toolbar">
        <div className="primary-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t(APP_SEARCH_PLACEHOLDER)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t(APP_SEARCH_LABEL)}
          />
          {query !== '' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title={t(APP_SEARCH_CLEAR)}
              aria-label={t(APP_SEARCH_CLEAR)}
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>
        <div className="primary-category-pills" role="tablist" aria-label={t(APP_FILTER_LABEL)}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`primary-category-pill${tab === 'all' ? ' is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            <span>{t(APP_TAB_ALL)}</span>
            <span className="badge tabular-nums">{stats.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pinned'}
            className={`primary-category-pill${tab === 'pinned' ? ' is-active' : ''}`}
            onClick={() => setTab('pinned')}
          >
            <span>{t(APP_TAB_PINNED)}</span>
            <span className="badge tabular-nums">{stats.pinned}</span>
          </button>
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="apps-grid">
          {filtered.map((item) => (
            <AppCard
              key={item.plugin.id}
              item={item}
              onOpen={(target) => ctx.openScreen(target)}
              onOpenSplit={(target) => ctx.openSplitScreen(target)}
              onShowDetail={() => showDetail(item.plugin.id)}
              onEnableInPluginCenter={() => ctx.openScreen(`plugins:${item.plugin.id}`)}
            />
          ))}
        </div>
      ) : (
        <div className="apps-empty">
          <HelmIcon name="layout-grid" size={26} />
          <div className="apps-empty-title">
            {items.length === 0 ? t(APP_EMPTY_NO_APPS) : t(APP_EMPTY_NO_MATCH)}
          </div>
          <div className="apps-empty-hint text-subtle">
            {items.length === 0 ? t(APP_EMPTY_HINT_NO_APPS) : t(APP_EMPTY_HINT_NO_MATCH)}
          </div>
          {(query !== '' || tab !== 'all') && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setQuery('')
                setTab('all')
              }}
            >
              <HelmIcon name="rotate-ccw" size={11} />
              <span>{t(APP_RESET_FILTERS)}</span>
            </button>
          )}
        </div>
      )}

      {selectedItem !== undefined && (
        <AppDetailDrawer
          item={selectedItem}
          inline={props.inlineDrawer}
          onClose={() => props.setParams({ app: undefined })}
        />
      )}
    </div>
  )
}
