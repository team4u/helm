/**
 * 移动端全局快捷导航簇（根挂载，与 .mobile-nav-toggle 同层）：
 *
 * - 免开汉堡的一键直达：首个已声明 quickEntry 的插件视图（如任务看板）+
 *   会话态势总览；quickEntry 按钮按插件 sidebarItem 通用 badge 声明渲染
 *   计数徽标 / 安静圆点（mobile-quick-badge / mobile-quick-dot）；总览按钮
 *   挂同源 tone 灯点（与 PC 折叠 Rail 的总览按钮同款，无计数徽标——总览页
 *   已有逐会话指示灯），态势摘要只进 title/aria；
 * - 主屏已停在入口目标（quickEntry 视图或总览）时该按钮就地隐藏——原地
 *   重复入口无意义；两钮皆隐时整簇不渲染（零占位残留）；
 * - 仅移动端视口渲染（桌面返回 null，折叠 Rail 承担同源入口）；抽屉拉开时
 *   隐藏（抽屉内 Rail 已有同款按钮）；不遮会话标题——配套在 responsive.css
 *   按 shell 属性微调顶栏左让位宽度；
 * - 点击走标准 store 路由（openTarget），零插件 ID 特判。
 */
import type { ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { usePrimaryTarget, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useIsMobileViewport } from '../lib/use-media-query.js'
import { isSameResolvedTarget } from '../lib/types.js'
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
  const primaryTarget = usePrimaryTarget()
  const isMobileViewport = useIsMobileViewport()
  if (!isMobileViewport) return null
  const visibleQuickEntry =
    quickEntry !== null && !isSameResolvedTarget(primaryTarget, quickEntry.target) ? quickEntry : null
  const overviewActive = primaryTarget.kind === 'overview'
  if (visibleQuickEntry === null && overviewActive) return null
  const attentionSummary = composeAttentionSummary(indicator, t)
  const overviewLabel =
    attentionSummary !== '' ? `${t('shell.overview.railTooltip')} · ${attentionSummary}` : t('shell.overview.railTooltip')
  const quickLabel = visibleQuickEntry !== null ? composeSidebarBadgeLabel(visibleQuickEntry.label, quickEntryBadge) : ''
  return (
    <div className="mobile-quick-nav" role="group" aria-label={t('shell.overview.quickNavGroup')}>
      {visibleQuickEntry !== null && (
        <button
          type="button"
          className="mobile-quick-btn"
          title={quickLabel}
          aria-label={quickLabel}
          onClick={() => openTarget(visibleQuickEntry.target)}
        >
          <HelmxIcon name={visibleQuickEntry.icon} size={15} />
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
      {!overviewActive && (
        <button
          type="button"
          className="mobile-quick-btn mobile-quick-overview-btn"
          title={overviewLabel}
          aria-label={overviewLabel}
          onClick={() => openTarget({ kind: 'overview' })}
        >
          <HelmxIcon name="activity" size={15} />
          {indicator.totalCount > 0 && indicator.tone !== null && (
            <span className="overview-count-badge" data-tone={indicator.tone}>
              {sidebarBadgeCountLabel(indicator.totalCount)}
            </span>
          )}
        </button>
      )}
    </div>
  )
}
