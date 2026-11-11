/**
 * builtin:apps 应用中心启动台（client.tsx，只导出组件保 Fast Refresh 契约）。
 *
 * 数据全部来自 @helm/plugin-client 共享 hooks（usePlugins / usePluginDoc），无轮询：
 * - 应用列表：宿主 plugins + screens 左连接（非 builtin 外部插件 + 至少一个 Screen）；
 * - 产品元数据（置顶/分类/来源会话）：builtin:apps 公开文档 catalog（后端登记，
 *   缺失时如实回退插件摘要本身，绝不编造）。
 * 打开应用经 ctx.openScreen / ctx.openSplitScreen 唯一导航机制；
 * 筛选 Tab、搜索词与选中详情应用写入 ScreenProps.params（sp.* / ssp.* 深链命名空间）。
 */
import { useMemo, useState } from 'react'
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
  APP_CATEGORY_TABS,
  appScreenTarget,
  filterAppItems,
  formatAppTabParam,
  mergeAppItems,
  normalizeAppCategory,
  parseAppTabParam,
  isSameAppTab,
  summarizeAppItems,
  type AppCatalogDoc,
  type AppItem,
  type AppTabParam,
} from './models.ts'

/** 单个应用卡片：图标/名称/状态/描述 + 主视图快捷打开（主屏/右屏）。 */
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
            <>
              <button
                type="button"
                className="btn btn-xs"
                title="在主屏打开应用"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(target)
                }}
              >
                <HelmIcon name="play" size={10} />
                <span>打开应用</span>
              </button>
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
            </>
          ) : (
            <button
              type="button"
              className="btn btn-xs"
              title="在插件中心启用该应用（详情抽屉提供启停开关）"
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
 * 应用详情抽屉：多视图分别打开、能力清单、catalog 元数据展示、
 * 置顶切换（update_meta 动作）与「回到创建会话继续迭代」。
 * 基于共享 Dialog 原语（Radix 无障碍底座），不引入新路由。
 */
function AppDetailDrawer({
  item,
  onClose,
  onPin,
  pinPending,
  pinError,
}: {
  item: AppItem
  onClose: () => void
  onPin: (pluginId: string, pinned: boolean) => void
  pinPending: boolean
  pinError: string | null
}): ReactNode {
  const ctx = usePluginContext()
  const { plugin, screens, catalog } = item
  const originConversationId = catalog?.originConversationId
  // 迭代入口：回到创建会话并把应用视图开到右屏（边看边改；无来源会话时如实禁用）
  const iterateTarget = appScreenTarget(item)
  const handleIterate = () => {
    if (originConversationId === undefined || iterateTarget === null) return
    ctx.openScreen(`conversation:${originConversationId}`)
    ctx.openSplitScreen(iterateTarget)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline>
        <DialogOverlay className="modal-backdrop" />
        <DialogContent
          className="modal app-detail-drawer"
          role="dialog"
          aria-label={`${plugin.name || plugin.id} 应用详情`}
        >
          <div className="modal-header">
            <DialogTitle className="modal-title">
              <HelmIcon name={catalog?.icon ?? 'layout-grid'} size={14} />
              <span>{plugin.name || plugin.id}</span>
            </DialogTitle>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>
          <div className="modal-body app-detail-body">
            <div className="app-detail-meta">
              <div className="form-grid">
                <span className="form-grid-label"><span>应用 ID</span></span>
                <span className="form-grid-value mono selectable">{plugin.id}</span>
              </div>
              {plugin.version !== undefined && plugin.version !== '' && (
                <div className="form-grid">
                  <span className="form-grid-label"><span>版本</span></span>
                  <span className="form-grid-value mono">{`v${plugin.version.replace(/^v/, '')}`}</span>
                </div>
              )}
              <div className="form-grid">
                <span className="form-grid-label"><span>分类</span></span>
                <span className="form-grid-value">
                  <span className="badge badge-neutral">{APP_CATEGORY_LABELS[normalizeAppCategory(catalog?.category)]}</span>
                </span>
              </div>
              <div className="form-grid">
                <span className="form-grid-label"><span>置顶</span></span>
                <span className="form-grid-value">
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={pinPending}
                    title={catalog?.pinned === true ? '取消置顶' : '置顶到应用中心顶部'}
                    onClick={() => onPin(plugin.id, catalog?.pinned !== true)}
                  >
                    <HelmIcon name={catalog?.pinned === true ? 'check' : 'arrow-up'} size={11} />
                    <span>{pinPending ? '提交中…' : catalog?.pinned === true ? '取消置顶' : '置顶'}</span>
                  </button>
                </span>
              </div>
              {catalog?.workspaceDir !== undefined && catalog.workspaceDir !== '' && (
                <div className="form-grid">
                  <span className="form-grid-label"><span>源码目录</span></span>
                  <span className="form-grid-value mono selectable" title={catalog.workspaceDir}>
                    {catalog.workspaceDir}
                  </span>
                </div>
              )}
              {originConversationId !== undefined && (
                <div className="form-grid">
                  <span className="form-grid-label"><span>创建会话</span></span>
                  <span className="form-grid-value mono">{`#${originConversationId}`}</span>
                </div>
              )}
            </div>

            {pinError !== null && (
              <div className="callout callout--error" role="alert">
                <HelmIcon name="alert-circle" size={12} />
                <span className="selectable">{pinError}</span>
              </div>
            )}

            <div className="app-detail-section">
              <h4 className="app-detail-section-title">
                <HelmIcon name="layout-grid" size={12} />
                <span>视图（{screens.length}）</span>
              </h4>
              {screens.length > 0 ? (
                screens.map((screen) => (
                  <div key={screen.screenId} className="list-item-btn app-detail-screen-row">
                    <span className="app-detail-screen-label" title={`${item.plugin.id}/${screen.screenId}`}>
                      <HelmIcon name="eye" size={12} />
                      <span>{screen.label || screen.screenId}</span>
                    </span>
                    <span className="app-detail-screen-actions">
                      <button
                        type="button"
                        className="btn btn-xs"
                        disabled={!plugin.enabled}
                        onClick={() => ctx.openScreen(`screen:${plugin.id}/${screen.screenId}`)}
                        title="在主屏打开此视图"
                      >
                        <HelmIcon name="play" size={10} />
                        <span>打开</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-icon-xs"
                        disabled={!plugin.enabled}
                        aria-label="分屏打开此视图"
                        title="在右侧分屏打开此视图"
                        onClick={() => ctx.openSplitScreen(`screen:${plugin.id}/${screen.screenId}`)}
                      >
                        <HelmIcon name="columns" size={11} />
                      </button>
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-subtle">该应用未声明视图。</div>
              )}
            </div>

            <div className="app-detail-section">
              <h4 className="app-detail-section-title">
                <HelmIcon name="zap" size={12} />
                <span>动作（{plugin.actions.length}）</span>
              </h4>
              {plugin.actions.length > 0 ? (
                <div className="plugin-capability-tags">
                  {plugin.actions.map((act) => (
                    <span key={act} className="plugin-capability-tag mono" title={act}>
                      {act}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-subtle">无声明动作。</div>
              )}
            </div>
          </div>
          <div className="modal-footer">
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
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

export function AppCenterScreen(props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const { plugins, screens } = usePlugins()
  const catalog = usePluginDoc<AppCatalogDoc | undefined>('catalog')

  // 深链参数（sp.* / ssp.* 命名空间）：tab / q / app 经 setParams 唯一导航机制回写
  const tab = useMemo(() => parseAppTabParam(props.params['tab']), [props.params])
  const queryFromUrl = props.params['q'] ?? ''
  const selectedAppId = props.params['app']
  const [queryDraft, setQueryDraft] = useState(queryFromUrl)
  const query = queryDraft

  // 置顶等元数据更新（builtin:apps update_meta 动作；后端未启用时显式报错不静默）
  const [pinPendingId, setPinPendingId] = useState<string | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)

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

  const handlePin = async (pluginId: string, pinned: boolean) => {
    setPinError(null)
    setPinPendingId(pluginId)
    try {
      await ctx.callAction('update_meta', { pluginId, pinned })
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err))
    } finally {
      setPinPendingId(null)
    }
  }

  const pillCount = (pillTab: AppTabParam): number => {
    if (pillTab === 'all') return stats.total
    if (pillTab === 'pinned') return stats.pinned
    return stats.categories[pillTab.category]
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
        <div className="apps-category-pills" role="tablist" aria-label="应用分类筛选">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`apps-category-pill${tab === 'all' ? ' is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            <span>全部</span>
            <span className="badge tabular-nums">{pillCount('all')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pinned'}
            className={`apps-category-pill${tab === 'pinned' ? ' is-active' : ''}`}
            onClick={() => setTab('pinned')}
          >
            <span>已置顶</span>
            <span className="badge tabular-nums">{pillCount('pinned')}</span>
          </button>
          {APP_CATEGORY_TABS.map((cat) => {
            const catTab: AppTabParam = { category: cat.key }
            return (
              <button
                key={cat.key}
                type="button"
                role="tab"
                aria-selected={isSameAppTab(tab, catTab)}
                className={`apps-category-pill${isSameAppTab(tab, catTab) ? ' is-active' : ''}`}
                onClick={() => setTab(catTab)}
              >
                <span>{cat.label}</span>
                <span className="badge tabular-nums">{pillCount(catTab)}</span>
              </button>
            )
          })}
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
              : '请尝试调整搜索关键字或切换分类标签。'}
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
          onClose={() => props.setParams({ app: undefined })}
          onPin={(pluginId, pinned) => void handlePin(pluginId, pinned)}
          pinPending={pinPendingId === selectedItem.plugin.id}
          pinError={pinPendingId === null ? pinError : null}
        />
      )}
    </div>
  )
}
