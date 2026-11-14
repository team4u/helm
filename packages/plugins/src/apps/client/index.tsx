/**
 * builtin:apps 应用中心启动台（client.tsx，只导出组件保 Fast Refresh 契约）。
 *
 * 数据全部来自 @helm/plugin-client 共享 hooks（usePlugins / usePluginDoc），无轮询：
 * - 应用列表：宿主 plugins + screens 左连接（非 builtin 外部插件 + 至少一个 Screen）；
 * - 产品元数据（置顶/分类/来源会话）：builtin:apps 公开文档 catalog（后端登记，
 *   缺失时如实回退插件摘要本身，绝不编造）。
 * 打开应用经 ctx.openScreen / ctx.openSplitScreen 唯一导航机制；
 * 点击卡片右下角 3 点按钮展开应用中心就地标准详情抽屉（保持应用中心上下文，不跳走菜单），
 * 抽屉内支持多视图直达、继续对话迭代与直接卸载删除应用；
 * 筛选 Tab、搜索词与选中应用 ID 写入 ScreenProps.params（sp.* / ssp.* 深链命名空间）。
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
  usePlugins,
} from '@helm/plugin-client'
import {
  APP_CATEGORY_LABELS,
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

/** 单个应用卡片：图标/名称/状态/描述 + 主视图快捷打开（主屏/右屏） + 详情抽屉入口。 */
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
  const { plugin, screens, catalog } = item
  const target = appScreenTarget(item)
  const isReady = plugin.enabled && target !== null
  const versionLabel = plugin.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const iconName = catalog?.icon ?? 'layout-grid'
  const categoryLabel = APP_CATEGORY_LABELS[normalizeAppCategory(catalog?.category)]
  const description =
    plugin.description && plugin.description.trim() !== ''
      ? plugin.description
      : screens.length > 0
        ? `提供 ${screens.map((s) => s.label).join('、')} 视图。`
        : '全栈微应用。'

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
              <span className="badge badge-neutral" title="已置顶">
                置顶
              </span>
            )}
            {plugin.enabled ? (
              <span className="badge badge-ok">已就绪</span>
            ) : (
              <span className="badge badge-neutral">已停用</span>
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
            <span className="app-card-pill" title={`${screens.length} 个视图`}>
              {`${screens.length} 视图`}
            </span>
          ) : (
            <span className="app-card-pill" title="插件已停用，视图贡献已卸载；启用后自动恢复">
              已停用
            </span>
          )}
          {(plugin.actions?.length ?? 0) > 0 && (
            <span className="app-card-pill" title={`${plugin.actions.length} 个动作`}>
              {`${plugin.actions.length} 动作`}
            </span>
          )}
        </div>
        <div className="app-card-actions">
          {isReady && target !== null ? (
            <button
              type="button"
              className="btn btn-xs btn-icon-xs"
              title="在右侧分屏并排打开"
              aria-label="分屏打开应用"
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
              title="在插件中心启用该应用"
              onClick={(e) => {
                e.stopPropagation()
                onEnableInPluginCenter()
              }}
            >
              <HelmIcon name="settings" size={10} />
              <span>插件中心启用</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-xs btn-icon-xs"
            title="查看应用详情"
            aria-label="查看应用详情"
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
 * 应用详情抽屉：与 Skills/Profiles/Plugins 抽屉规范 100% 对齐的侧滑抽屉。
 * 保留在应用中心就地打开，不跳转页面、不切换菜单选中态，提供视图直达、
 * 「回到创建会话继续迭代」与在底栏旁边的「直接删除卸载应用」功能。
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
  const categoryLabel = APP_CATEGORY_LABELS[normalizeAppCategory(catalog?.category)]
  const description =
    plugin.description && plugin.description.trim() !== ''
      ? plugin.description
      : screens.length > 0
        ? `提供 ${screens.map((s) => s.label).join('、')} 视图。`
        : '全栈微应用。'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content app-detail-drawer"
          role="dialog"
          aria-label={`${plugin.name || plugin.id} 应用详情`}
        >
          {/* 抽屉头部：统一复用 primary-drawer-header 规范 */}
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
                    <span className="badge badge-neutral mono" title={`版本 ${versionLabel}`}>
                      {versionLabel}
                    </span>
                  )}
                  {catalog?.pinned === true && (
                    <span className="badge badge-neutral" title="已置顶">
                      置顶
                    </span>
                  )}
                  {plugin.enabled ? (
                    <span className="badge badge-ok">已就绪</span>
                  ) : (
                    <span className="badge badge-neutral">已停用</span>
                  )}
                </div>
                <div className="primary-drawer-id mono">{plugin.id}</div>
              </div>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* 抽屉正文：统一复用 primary-drawer-body 规范 */}
          <div className="primary-drawer-body">
            {description && (
              <div className="app-detail-desc text-secondary" style={{ fontSize: '13px', lineHeight: 1.5 }}>
                {description}
              </div>
            )}

            <div className="form-grid">
              <div className="form-grid-row">
                <span className="form-grid-label"><span>应用 ID</span></span>
                <span className="form-grid-value mono">{plugin.id}</span>
              </div>
              {versionLabel && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>版本</span></span>
                  <span className="form-grid-value mono">{versionLabel}</span>
                </div>
              )}
              <div className="form-grid-row">
                <span className="form-grid-label"><span>分类</span></span>
                <span className="badge badge-neutral">{categoryLabel ?? '其他'}</span>
              </div>
              <div className="form-grid-row">
                <span className="form-grid-label"><span>置顶状态</span></span>
                <span className="form-grid-value">
                  {catalog?.pinned ? '已置顶' : '未置顶'}
                </span>
              </div>
              {catalog?.workspaceDir && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>工作区源码</span></span>
                  <span className="form-grid-value mono" title={catalog.workspaceDir}>
                    {catalog.workspaceDir}
                  </span>
                </div>
              )}
              {plugin.managed?.source && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>安装来源</span></span>
                  <span className="form-grid-value mono" title={plugin.managed.source.raw}>
                    {plugin.managed.source.raw}
                  </span>
                </div>
              )}
              {originConversationId !== undefined && (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>创建会话</span></span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs mono"
                    title={`跳转到创建此应用的会话 #${originConversationId}`}
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
                  <span>应用视图 ({screens.length})</span>
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
                          title="在主屏打开此视图"
                          onClick={() => ctx.openScreen(target)}
                        >
                          <HelmIcon name="play" size={11} />
                          <span>打开视图</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-icon-xs"
                          title="在右侧分屏并排打开"
                          aria-label="分屏打开此视图"
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
                  <span>导出能力 ({plugin.actions?.length})</span>
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

          {/* 抽屉底栏：统一复用 primary-drawer-footer 规范 */}
          <div className="primary-drawer-footer">
            {confirmDelete ? (
              <div className="app-detail-delete-confirm">
                <span className="text-subtle">确认卸载并删除此应用？</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  <span>取消</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={deleting}
                  onClick={handleDelete}
                >
                  <HelmIcon name="trash-2" size={12} />
                  <span>{deleting ? '正在删除…' : '确认删除'}</span>
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onClose}
                >
                  <span>关闭</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={originConversationId === undefined || iterateTarget === null || !plugin.enabled}
                  title={
                    originConversationId === undefined
                      ? '该应用未登记创建会话'
                      : '回到创建会话并把应用视图开到右屏，边看边改'
                  }
                  onClick={handleIterate}
                >
                  <HelmIcon name="message-square" size={12} />
                  <span>继续对话迭代</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-danger"
                  title="从系统卸载并删除此应用"
                  aria-label="卸载删除应用"
                  onClick={() => setConfirmDelete(true)}
                >
                  <HelmIcon name="trash-2" size={12} />
                  <span>删除</span>
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
  const { plugins, screens } = usePlugins()
  const catalog = usePluginDoc<AppCatalogDoc | undefined>('catalog')

  // 深链参数（sp.* / ssp.* 命名空间）：tab / q / app 经 setParams 唯一导航机制回写
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
            <span>应用中心</span>
          </div>
          <span className="apps-center-subtitle text-subtle">
            AI 生成与受管安装的全栈微应用启动台
          </span>
        </div>
        <div className="apps-center-topbar-actions">
          <span className="apps-center-stats text-subtle">
            {`共 ${stats.total} 个应用 · ${stats.ready} 个已就绪`}
          </span>
        </div>
      </div>

      <div className="apps-center-toolbar">
        <div className="apps-search-box">
          <HelmIcon name="search" size={13} />
          <input
            type="text"
            className="input"
            placeholder="搜索应用名称、ID 或描述…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索应用"
          />
          {query !== '' && (
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={11} />
            </button>
          )}
        </div>
        <div className="apps-category-pills" role="tablist" aria-label="应用筛选">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`apps-category-pill${tab === 'all' ? ' is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            <span>全部</span>
            <span className="badge tabular-nums">{stats.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pinned'}
            className={`apps-category-pill${tab === 'pinned' ? ' is-active' : ''}`}
            onClick={() => setTab('pinned')}
          >
            <span>已置顶</span>
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
            {items.length === 0 ? '还没有全栈应用' : '未找到匹配的应用'}
          </div>
          <div className="apps-empty-hint text-subtle">
            {items.length === 0
              ? '在会话中让 AI 生成一个全栈微应用并发布到应用中心，即可在此启动。'
              : '请尝试调整搜索关键字或切换置顶标签。'}
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
              <span>重置筛选条件</span>
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
