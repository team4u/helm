import { useEffect, useMemo, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol/browser'
import { resolveLocalizedText } from '@helm/protocol/browser'
import { HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { isSameResolvedTarget, resolveTargetString, CENTER_TARGETS, spaceForTarget, type HelmStoreValue, type SidebarSpace } from '../lib/types.js'
import { readBrowserNotificationPermission } from '../lib/browser-notification.js'
import { formatModShortcut } from './shortcuts-model.js'
import {
  extractSidebarViews,
  filterConversationsByTag,
  getConversationPresence,
  isConversationArchived,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  type SidebarTargetPresence,
} from './sidebar-model.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import { AgentStandingsGroup } from './SidebarAgentStandings.js'
import { ArchivedConversationsGroup } from './SidebarArchivedConversations.js'
import {
  ConversationStatusDot,
  HoverIconButton,
  PendingAsksPanel,
  SidebarPaneTag,
  StatusDot,
} from './SidebarPrimitives.js'

/** 插件动态会话分组区（sidebar.section）：filterTag 分组通用渲染，支持 collapsible / defaultCollapsed。 */
function SidebarSectionGroups({ store, background }: { store: HelmStoreValue; background: ConversationBackgroundIndex }) {
  const sections = store.groupedUi.sidebarSections.filter((s) => s.spec.filterTag)
  // 纯内容型 section（无 filterTag，但声明了 client 内容）：渲染内容本身，
  // 不因缺少 filterTag 静默丢弃（与 sidebar.item 的 client 内容渲染同一策略）。
  const contentSections = store.groupedUi.sidebarSections.filter(
    (s) => !s.spec.filterTag && s.spec.client !== undefined,
  )
  return (
    <>
      {contentSections.map((section) => (
        <div key={`content:${section.pluginId}/${section.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={section.pluginId} spec={section.spec} label={`Sidebar section ${section.spec.id}`} />
        </div>
      ))}
      {sections.map((section) => (
        <SidebarSectionGroup
          key={`${section.pluginId}/${section.spec.id}`}
          store={store}
          section={section}
          background={background}
        />
      ))}
    </>
  )
}

/** 单条会话行（插件 sidebar.section 分组内渲染）：状态灯前置行首固定灯位，
 *  右侧保留分屏微标（如有）、#id 与动作区；分屏入口收敛到会话详情顶栏，行内不携带分屏按钮。 */
function ConversationRow({
  conv,
  background,
  presence,
  onOpen,
}: {
  conv: ConversationSummary
  background?: ConversationBackgroundActivity
  presence: SidebarTargetPresence
  onOpen: () => void
}) {
  return (
    <div
      className={`nav-item${presenceNavClassSuffix(presence)}`}
      style={{ minHeight: 30, opacity: 1 }}
    >
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={onOpen}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background} />
        </span>
        <span className="nav-item-label">{conv.title || `Conversation #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <SidebarPaneTag paneTag={presence.paneTag} />
        <span className="tabular-nums">#{conv.id}</span>
        <span className="nav-item-row-actions">
          <ConversationRowActionsMenu conversation={conv} />
        </span>
      </span>
    </div>
  )
}

/** 单个 sidebar.section 分组：声明 collapsible 时渲染可折叠头部与计数徽标。 */
function SidebarSectionGroup({
  store,
  section,
  background,
}: {
  store: HelmStoreValue
  section: HelmStoreValue['groupedUi']['sidebarSections'][number]
  background: ConversationBackgroundIndex
}) {
  const spec = section.spec
  const tag = spec.filterTag as string
  const sectionLabel = resolveLocalizedText(spec.label, store.locale)
  const convs = useMemo(
    // 按创建时间倒序固定排列（同刻按 id 决胜）：分组内会话后台跑动推进 updatedAt 不再引起跳位。
    () =>
      filterConversationsByTag(store.conversations, tag).filter((conversation) => !isConversationArchived(conversation)).sort(
        (a, b) => b.createdAt - a.createdAt || b.id - a.id,
      ),
    [store.conversations, tag],
  )
  const collapsible = spec.collapsible === true
  const [open, setOpen] = useState(!collapsible || spec.defaultCollapsed !== true)

  return (
    <div className="sidebar-group">
      {collapsible ? (
        <button
          type="button"
          className="sidebar-group-header"
          style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer' }}
          title={open ? 'Collapse section' : 'Expand section'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {spec.icon !== undefined && <HelmIcon name={spec.icon} size={12} />}
            <span className="nav-item-label">{sectionLabel}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{convs.length}</span>
            <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
      ) : (
        <div className="sidebar-group-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <HelmIcon name={spec.icon} size={12} />
            {sectionLabel}
          </span>
          <span className="tabular-nums">{convs.length}</span>
        </div>
      )}
      {open &&
        convs.map((conv) => (
          <ConversationRow
            key={conv.id}
            conv={conv}
            background={background.get(conv.id)}
            presence={getConversationPresence(store, conv.id)}
            onOpen={() => store.openTarget({ kind: 'conversation', conversationId: conv.id })}
          />
        ))}
    </div>
  )
}

/** 独立「视图」分组：screen: 导航项 + 无导航 target 的自定义客户端侧栏组件。 */
function ViewNavGroup({ store }: { store: HelmStoreValue }) {
  const viewItems = useMemo(
    () => extractSidebarViews(store.groupedUi.sidebarItems, store.conversations, store.locale),
    [store.groupedUi.sidebarItems, store.conversations, store.locale],
  )
  const clientItems = store.groupedUi.sidebarItems.filter(
    (item) => item.spec.client !== undefined && resolveTargetString(item.spec.target ?? '', store.conversations) === null,
  )
  if (viewItems.length === 0 && clientItems.length === 0) return null

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-header">Views</div>
      {clientItems.map((item) => (
        <div key={`client:${item.pluginId}/${item.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={item.pluginId} spec={item.spec} label={`Sidebar item ${item.spec.id}`} />
        </div>
      ))}
      {viewItems.map((view) => {
        const presence = resolveSidebarTargetPresence(store, (t) => isSameResolvedTarget(t, view.target))
        return (
          <div
            key={view.key}
            className={`nav-item${presenceNavClassSuffix(presence)}`}
            style={{ cursor: 'pointer' }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              onClick={() => store.openTarget(view.target)}
              aria-current={presence.active ? 'page' : undefined}
            >
              <HelmIcon name={view.icon} size={14} />
              <span className="nav-item-label">{view.label}</span>
            </button>
            <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
              <SidebarPaneTag paneTag={presence.paneTag} />
              <span className="sidebar-split-action">
                <HoverIconButton
                  className="split-toggle-btn sidebar-split-btn"
                  title="Open in right split"
                  icon="columns"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.openTarget(view.target, { split: true })
                  }}
                />
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 系统中心目标键已迁至 lib/types（CENTER_TARGETS，与侧栏空间推导共用）。 */
type CenterKey = (typeof CENTER_TARGETS)[number]

const CENTER_ICONS: Record<CenterKey, string> = {
  profiles: 'bot',
  models: 'key',
  skills: 'sparkles',
  nodes: 'network',
  plugins: 'puzzle',
}

const CENTER_LABELS: Record<CenterKey, string> = {
  profiles: 'Profile',
  models: 'Models & credentials',
  skills: 'Skills',
  nodes: 'Compute nodes',
  plugins: 'Plugin Center',
}

/** 侧栏空间由主屏目标唯一推导（spaceForTarget，lib/types.ts），不进 URL；
 * Rail 点击经 store.openSpace 直接导航该空间的主舞台目标（含会话内空间记忆）。 */

const SPACE_ICONS: Record<SidebarSpace, string> = {
  conversations: 'message-square',
  views: 'layout-grid',
  settings: 'settings',
}

const SPACE_LABELS: Record<SidebarSpace, string> = {
  conversations: 'Conversations space',
  views: 'Views space',
  settings: 'Settings space',
}

/**
 * Activity Rail（48px）：仅空间切换（对话/视图/设置）+ 主题按钮。
 * 桌面与移动抽屉共用；空间按钮直接导航主舞台到对应空间的最近目标（store.openSpace），
 * 系统中心入口收敛到「设置」空间内的纵向列表。
 */
function ActivityRail({
  store,
  space,
  onOpenSpace,
}: {
  store: HelmStoreValue
  space: SidebarSpace
  onOpenSpace: (space: SidebarSpace) => void
}) {
  return (
    <nav className="activity-rail" aria-label="Main navigation">
      <div className="activity-rail-brand" title="Helm">
        <HelmIcon name="layers" size={17} />
        <StatusDot connected={store.sseConnected} />
      </div>
      <Tooltip content={`Expand navigation bar (${formatModShortcut('B')})`} side="right">
        <button
          type="button"
          className="rail-btn desktop-sidebar-expand-btn"
          title={`Expand navigation bar (${formatModShortcut('B')})`}
          aria-label="Expand navigation bar"
          onClick={() => store.toggleSidebarCollapsed?.()}
        >
          <HelmIcon name="chevron-right" size={16} />
        </button>
      </Tooltip>
      <div className="activity-rail-spaces">
        {(Object.keys(SPACE_LABELS) as SidebarSpace[]).map((key) => (
          <Tooltip content={SPACE_LABELS[key]} side="right" key={key}>
            <button
              type="button"
              className={`rail-btn rail-space-btn${space === key ? ' rail-btn-active' : ''}`}
              title={SPACE_LABELS[key]}
              aria-label={SPACE_LABELS[key]}
              aria-current={space === key ? 'page' : undefined}
              onClick={() => onOpenSpace(key)}
            >
              <HelmIcon name={SPACE_ICONS[key]} size={16} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="activity-rail-footer">
        <Tooltip
          content={
            store.themePreference === 'system'
              ? `System theme (currently ${store.theme === 'dark' ? 'Dark' : 'Light'}; click to switch to light mode)`
              : store.themePreference === 'light'
                ? 'Light mode (click to switch to dark mode)'
                : 'Dark mode (click to switch to system theme)'
          }
          side="right"
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm sidebar-theme-toggle"
            title={
              store.themePreference === 'system'
                ? `System theme (currently ${store.theme === 'dark' ? 'Dark' : 'Light'}; click to switch to light mode)`
                : store.themePreference === 'light'
                  ? 'Light mode (click to switch to dark mode)'
                  : 'Dark mode (click to switch to system theme)'
            }
            aria-label={
              store.themePreference === 'system'
                ? 'System'
                : store.themePreference === 'light'
                  ? 'Light mode'
                  : 'Dark mode'
            }
            onClick={store.toggleTheme}
          >
            <HelmIcon
              name={
                store.themePreference === 'system'
                  ? 'monitor'
                  : store.themePreference === 'light'
                    ? 'sun'
                    : 'moon'
              }
              size={16}
            />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}

/** 设置空间导航：系统中心纵向列表，行结构与智能体站位行同构
 * （nav-item-main 图标文本），保证两个空间的左缘视觉统一。 */
function SettingsNavGroup({ store, onNavigate }: { store: HelmStoreValue; onNavigate?: () => void }) {
  return (
    <div className="sidebar-group settings-nav">
      {CENTER_TARGETS.map((key) => {
        const presence = resolveSidebarTargetPresence(store, (t) => t.kind === key)
        return (
          <div key={key} className={`nav-item settings-nav-item${presenceNavClassSuffix(presence)}`}>
            <button
              type="button"
              className="nav-item-main nav-open"
              aria-current={presence.active ? 'page' : undefined}
              onClick={() => {
                store.openTarget({ kind: key })
                onNavigate?.()
              }}
            >
              <HelmIcon name={CENTER_ICONS[key]} size={14} />
              <span className="nav-item-label">{CENTER_LABELS[key]}</span>
            </button>
            {presence.paneTag !== null && (
              <span className="nav-item-meta">
                <SidebarPaneTag paneTag={presence.paneTag} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Sidebar({ onClose }: { onClose?: () => void } = {}) {
  const store = useHelmStore()
  // 侧栏空间由主屏目标唯一推导（不进 URL）；Rail 点击经 store.openSpace 直接导航
  // 该空间最近的主舞台目标，URL 即该空间真实锚点，刷新/前进/后退天然可还原。
  const space = spaceForTarget(store.primaryTarget)

  // 后台在途摘要（纯推导，零插件 ID 特判）：workbench.panel badge 契约 → 按会话
  // 索引；badge doc 的按需加载在下方 effect（纯函数内不做副作用）。插件停用后
  // UI 贡献与 doc 均从 store 消失，摘要自然归零，指示立即消失。
  const background = useMemo(
    () =>
      summarizeConversationBackgroundActivity({
        panels: store.groupedUi.workbenchPanels,
        conversations: store.conversations,
        pluginDocs: store.pluginDocs,
      }),
    [store.groupedUi.workbenchPanels, store.conversations, store.pluginDocs],
  )
  const badgeDocs = useMemo(
    () => collectBackgroundBadgeDocs(store.groupedUi.workbenchPanels, store.conversations),
    [store.groupedUi.workbenchPanels, store.conversations],
  )
  const { authenticated, ensurePluginDoc } = store
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) void ensurePluginDoc(ref.pluginId, ref.doc)
  }, [badgeDocs, authenticated, ensurePluginDoc])

  // 后台浏览器通知开关：权限现场读取（浏览器设置可随时收回），
  // 偏好开而权限未授予时如实提示，绝不静默装作已开启。
  const quietNotifyTooltip = !store.quietNotifyEnabled
    ? 'Background notifications: off (alert when a conversation completes or awaits input while the page is in the background)'
    : readBrowserNotificationPermission() !== 'granted'
      ? 'Background notifications: browser permission not granted; allow notifications in browser site settings and re-enable'
      : 'Background notifications: on (alert when a conversation completes or awaits input while the page is in the background; this page must stay open)'

  return (
    <aside className="helm-sidebar">
      {/* Mobile drawer: stays expanded after switching spaces — the secondary list of the space
          (settings list / views list / agent list) renders naturally inside the drawer and closes it
          only when the user picks a concrete item (items carry onNavigate / the App nav-item close
          channel); closing here would whisk the user to the first target before they see the menu.
      The desktop sidebar is persistent; behavior unchanged. */}
      <ActivityRail
        store={store}
        space={space}
        onOpenSpace={(nextSpace) => {
          store.openSpace(nextSpace)
        }}
      />
      <div className="sidebar-context">
        <div className="sidebar-header">
          <div className="sidebar-context-title">
            <HelmIcon
              name={space === 'conversations' ? 'message-square' : space === 'views' ? 'layout-grid' : 'settings'}
              size={14}
            />
            <span>{space === 'conversations' ? 'Conversation' : space === 'views' ? 'Views' : 'Settings'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content="Background notifications: click to toggle" side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={quietNotifyTooltip}
                aria-label={quietNotifyTooltip}
                aria-pressed={store.quietNotifyEnabled}
                onClick={() => {
                  void store.setQuietNotify(!store.quietNotifyEnabled)
                }}
              >
                <HelmIcon name={store.quietNotifyEnabled && readBrowserNotificationPermission() === 'granted' ? 'bell' : 'bell-off'} size={13} />
              </button>
            </Tooltip>
            <Tooltip content="Open Cmd K global search and command palette" side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title="Open Cmd K global search and command palette"
                aria-label="Open Cmd K global search and command palette"
                onClick={() => store.setActiveModal({ kind: 'command-palette' })}
              >
                <HelmIcon name="search" size={13} />
              </button>
            </Tooltip>
            <Tooltip content={`Collapse navigation bar (${formatModShortcut('B')})`} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon desktop-sidebar-collapse-btn"
                title={`Collapse navigation bar (${formatModShortcut('B')})`}
                aria-label="Collapse navigation bar"
                onClick={() => store.toggleSidebarCollapsed?.()}
              >
                <HelmIcon name="chevron-left" size={13} />
              </button>
            </Tooltip>
            {onClose && (
              <Tooltip content="Close navigation bar" side="bottom">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mobile-sidebar-close"
                  aria-label="Close navigation bar"
                  title="Close navigation bar"
                  onClick={onClose}
                >
                  <HelmIcon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="sidebar-scroll">
          {space === 'conversations' ? (
            <>
              <PendingAsksPanel store={store} />
              <AgentStandingsGroup store={store} background={background} onNavigate={onClose} />
              <SidebarSectionGroups store={store} background={background} />
              <ArchivedConversationsGroup background={background} onNavigate={onClose} />
            </>
          ) : space === 'views' ? (
            <ViewNavGroup store={store} />
          ) : (
            <SettingsNavGroup store={store} onNavigate={onClose} />
          )}
        </div>
      </div>
    </aside>
  )
}
