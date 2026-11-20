/**
 * 移动端全局快捷导航簇（根挂载，与 .mobile-nav-toggle 同层）：
 *
 * - 免开汉堡的一键直达：首个已声明 quickEntry 的插件视图（如任务看板）+
 *   会话态势总览；态势微标独立可按（tone 灯色 + 紧凑计数 + aria 摘要挂在
 *   总览按钮上），一次点击即达；
 * - 仅移动端视口渲染（桌面返回 null，折叠 Rail 承担同源入口）；抽屉拉开时
 *   隐藏（抽屉内 Rail 已有同款按钮）；不遮会话标题——配套在 responsive.css
 *   按 shell 属性微调顶栏左让位宽度；
 * - 点击走标准 store 路由（openTarget），零插件 ID 特判。
 */
import type { ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useIsMobileViewport } from '../lib/use-media-query.js'
import { composeAttentionSummary, type GlobalAttentionIndicator } from './attention-model.js'
import {
  composeSidebarBadgeLabel,
  sidebarBadgeCountLabel,
  type ResolvedSidebarBadge,
  type SidebarViewItem,
} from './sidebar-model.js'

export interface MobileQuickNavProps {
  /** 全局态势微标（同源 indicator）。 */
  indicator: GlobalAttentionIndicator
  /** 首个已声明 quickEntry 的插件视图（无则为 null，仅渲染总览按钮）。 */
  quickEntry: SidebarViewItem | null
  /** quickEntry 视图的 sidebar.item badge 解析结果（无信号为 null，零渲染残留）。 */
  quickEntryBadge?: ResolvedSidebarBadge | null
}

export function MobileQuickNav({ indicator, quickEntry, quickEntryBadge = null }: MobileQuickNavProps): ReactNode {
  const { t } = useWebLocale()
  const { openTarget } = useStoreActions()
  const isMobileViewport = useIsMobileViewport()
  if (!isMobileViewport) return null
  const attentionSummary = composeAttentionSummary(indicator, t)
  const overviewLabel =
    attentionSummary !== '' ? `${t('shell.overview.railTooltip')} · ${attentionSummary}` : t('shell.overview.railTooltip')
  const quickLabel = quickEntry !== null ? composeSidebarBadgeLabel(quickEntry.label, quickEntryBadge) : ''
  return (
    <div className="mobile-quick-nav" role="group" aria-label={t('shell.overview.quickNavGroup')}>
      {quickEntry !== null && (
        <button
          type="button"
          className="mobile-quick-btn"
          title={quickLabel}
          aria-label={quickLabel}
          onClick={() => openTarget(quickEntry.target)}
        >
          <HelmxIcon name={quickEntry.icon} size={15} />
          {quickEntryBadge !== null && !quickEntryBadge.dot && quickEntryBadge.count > 0 && (
            <span className="mobile-quick-badge" data-tone={quickEntryBadge.tone}>
              {sidebarBadgeCountLabel(quickEntryBadge.count)}
            </span>
          )}
          {quickEntryBadge !== null && quickEntryBadge.dot && (
            <span className="mobile-quick-dot" data-tone={quickEntryBadge.tone} />
          )}
        </button>
      )}
      <button
        type="button"
        className="mobile-quick-btn mobile-quick-overview-btn"
        title={overviewLabel}
        aria-label={overviewLabel}
        onClick={() => openTarget({ kind: 'overview' })}
      >
        <HelmxIcon name="activity" size={15} />
        {indicator.tone !== null && (
          <span className="mobile-quick-badge" data-tone={indicator.tone}>
            {indicator.totalCount > 99 ? '99+' : indicator.totalCount}
          </span>
        )}
      </button>
    </div>
  )
}
