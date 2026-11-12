/**
 * builtin:apps 应用中心启动台（client.tsx，只导出组件保 Fast Refresh 契约）。
 *
 * 数据全部来自 @helm/plugin-client 共享 hooks（usePlugins / usePluginDoc），无轮询：
 * - 应用列表：宿主 plugins + screens 左连接（非 builtin 外部插件 + 至少一个 Screen）；
 * - 产品元数据（置顶/分类/来源会话）：builtin:apps 公开文档 catalog（后端登记，
 *   缺失时如实回退插件摘要本身，绝不编造）。
 * 打开应用经 ctx.openScreen / ctx.openSplitScreen 唯一导航机制；
 * 点击卡片右下角 3 点按钮直接导航至 plugins:<pluginId>，统一复用插件详情页与卸载能力；
 * 筛选 Tab 与搜索词写入 ScreenProps.params（sp.* / ssp.* 深链命名空间）。
 */
import { useMemo, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import {
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

/** 单个应用卡片：图标/名称/状态/描述 + 主视图快捷打开（主屏/右屏） + 详情跳转。 */
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
              title="在插件中心启用该应用（详情页提供启停开关与卸载）"
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
            title="查看插件详情与卸载"
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

export interface AppCenterScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

export function AppCenterScreen(props: AppCenterScreenProps): ReactNode {
  const ctx = usePluginContext()
  const { plugins, screens } = usePlugins()
  const catalog = usePluginDoc<AppCatalogDoc | undefined>('catalog')

  // 深链参数（sp.* / ssp.* 命名空间）：tab / q 经 setParams 唯一导航机制回写
  const tab = useMemo(() => parseAppTabParam(props.params['tab']), [props.params])
  const queryFromUrl = props.params['q'] ?? ''
  const [queryDraft, setQueryDraft] = useState(queryFromUrl)
  const query = queryDraft

  const items = useMemo(() => mergeAppItems(plugins, screens, catalog), [plugins, screens, catalog])
  const stats = useMemo(() => summarizeAppItems(items), [items])
  const filtered = useMemo(() => filterAppItems(items, { query, tab }), [items, query, tab])

  const setTab = (next: AppTabParam) => {
    props.setParams({ tab: formatAppTabParam(next) })
  }

  const setQuery = (next: string) => {
    setQueryDraft(next)
    props.setParams({ q: next === '' ? undefined : next })
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
              onShowDetail={() => ctx.openScreen(`plugins:${item.plugin.id}`)}
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
    </div>
  )
}
