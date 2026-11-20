/**
 * 侧栏「会话总览」单行脉冲入口（Web 宿主，对话空间顶部）：
 *
 * - 会话视角收敛后的唯一侧栏态势入口：行结构与视图行/会话行同构
 *   （行首单灯位 + 标题 + 右侧 pane 标签与分屏按钮），取代旧的
 *   SidebarAttentionGroup 平铺列表——逐树明细只在总览页呈现；
 * - 态势经同源 indicator：非空时行首渲染单灯（tone 词汇与状态灯同阶）
 *   并在标题下挂一行真实摘要（composeAttentionSummary，绝不编造）；
 *   全安静时零灯零副文（不装忙）；
 * - 点击主区进入 #/overview（store.openTarget 标准路由，收起移动端抽屉）；
 *   悬停右侧分屏按钮可把总览直接钉在右分屏；选中态跟
 *   resolveSidebarTargetPresence 同步（含 aria-current 与 pane 标签）。
 */
import type { MouseEvent, ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  type SidebarStoreView,
} from './sidebar-model.js'
import { composeAttentionSummary, type GlobalAttentionIndicator } from './attention-model.js'
import { HoverIconButton, SidebarPaneTag } from './SidebarPrimitives.js'

/** 聚合 tone → 行首 status-dot 类（running 落 working 色阶，同一五态词汇）。 */
const TONE_DOT_CLASS: Record<Exclude<GlobalAttentionIndicator['tone'], null>, string> = {
  error: 'status-dot status-dot-error',
  blocked: 'status-dot status-dot-blocked',
  running: 'status-dot status-dot-working',
  done: 'status-dot status-dot-done',
}

export function SidebarOverviewEntry({
  store,
  indicator,
  onNavigate,
}: {
  store: SidebarStoreView
  indicator: GlobalAttentionIndicator
  onNavigate?: () => void
}): ReactNode {
  const { t } = useWebLocale()
  const presence = resolveSidebarTargetPresence(store, (target) => target.kind === 'overview')
  const summary = composeAttentionSummary(indicator, t)
  const tooltip = summary !== '' ? `${t('shell.overview.railTooltip')} · ${summary}` : t('shell.overview.railTooltip')
  const openOverview = (): void => {
    store.openTarget({ kind: 'overview' })
    onNavigate?.()
  }
  const handleRowActivate = (e: MouseEvent<HTMLDivElement>): void => {
    if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
    openOverview()
  }
  return (
    <div
      className={`nav-item sidebar-overview-entry${presenceNavClassSuffix(presence)}`}
      onClick={handleRowActivate}
    >
      <button
        type="button"
        className="nav-item-main nav-open"
        title={tooltip}
        aria-label={tooltip}
        onClick={openOverview}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          {indicator.tone !== null && <span className={TONE_DOT_CLASS[indicator.tone]} title={summary} />}
        </span>
        <HelmxIcon name="activity" size={14} />
        <span className="sidebar-overview-entry-body">
          <span className="nav-item-label">{t('shell.overview.title')}</span>
          {summary !== '' && <span className="sidebar-overview-entry-sub">{summary}</span>}
        </span>
      </button>
      <span className="nav-item-meta">
        <SidebarPaneTag paneTag={presence.paneTag} />
        <span className="sidebar-split-action">
          <HoverIconButton
            className="split-toggle-btn sidebar-split-btn"
            title={t('shell.sidebar.openInRightSplit')}
            icon="columns"
            onClick={(e) => {
              e.stopPropagation()
              store.openTarget({ kind: 'overview' }, { split: true })
              onNavigate?.()
            }}
          />
        </span>
      </span>
    </div>
  )
}
