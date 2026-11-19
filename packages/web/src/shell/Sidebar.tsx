import { useMemo, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePendingAsks,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
  useThemePreferencesState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { LocaleMenuButton } from '../ui/LocaleMenuButton.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { isSameResolvedTarget, resolveTargetString, CENTER_TARGETS, spaceForTarget, type SidebarSpace } from '../lib/types.js'
import { useIsMobileViewport } from '../lib/use-media-query.js'
import { readBrowserNotificationPermission } from '../lib/browser-notification.js'
import { formatModShortcut } from './shortcuts-model.js'
import {
  extractRailQuickEntries,
  extractSidebarViews,
  filterConversationsByTag,
  getConversationPresence,
  isConversationArchived,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  type SidebarStoreView,
  type SidebarTargetPresence,
  type SidebarViewItem,
} from './sidebar-model.js'
import type { ConversationBackgroundActivity, ConversationBackgroundIndex } from './background-activity-model.js'
import { AgentStandingsGroup } from './SidebarAgentStandings.js'
import { ArchivedConversationsGroup } from './SidebarArchivedConversations.js'
import { SidebarAttentionGroup } from './SidebarAttentionGroup.js'
import { useGlobalAttention } from './use-attention-indicator.js'
import { composeAttentionSummary, type GlobalAttentionIndicator } from './attention-model.js'
import {
  ConversationStatusDot,
  HoverIconButton,
  PendingAsksPanel,
  SidebarPaneTag,
  StatusDot,
} from './SidebarPrimitives.js'

/** 插件动态会话分组区（sidebar.section）：filterTag 分组通用渲染，支持 collapsible / defaultCollapsed。 */
function SidebarSectionGroups({ store, background }: { store: SidebarStoreView; background: ConversationBackgroundIndex }) {
  const { t } = useWebLocale()
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
          <PluginUiView pluginId={section.pluginId} spec={section.spec} label={t('shell.sidebar.sectionLabel', { id: section.spec.id })} />
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
  const { t } = useWebLocale()
  return (
    <div
      className={`nav-item sidebar-conversation-row${presenceNavClassSuffix(presence)}`}
      style={{ minHeight: 30, opacity: 1 }}
      onClick={(e) => {
        if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
        onOpen()
      }}
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
        <span className="nav-item-label">{conv.title || t('shell.conversationFallback', { id: conv.id })}</span>
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
  store: SidebarStoreView
  section: SidebarStoreView['groupedUi']['sidebarSections'][number]
  background: ConversationBackgroundIndex
}) {
  const { locale, t } = useWebLocale()
  const spec = section.spec
  const tag = spec.filterTag as string
  const sectionLabel = resolveLocalizedText(spec.label, locale)
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
          title={open ? t('shell.sidebar.collapseSection') : t('shell.sidebar.expandSection')}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {spec.icon !== undefined && <HelmxIcon name={spec.icon} size={12} />}
            <span className="nav-item-label">{sectionLabel}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{convs.length}</span>
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
      ) : (
        <div className="sidebar-group-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <HelmxIcon name={spec.icon} size={12} />
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
function ViewNavGroup({ store }: { store: SidebarStoreView }) {
  const { locale, t } = useWebLocale()
  const viewItems = useMemo(
    () => extractSidebarViews(store.groupedUi.sidebarItems, store.conversations, locale),
    [store.groupedUi.sidebarItems, store.conversations, locale],
  )
  const clientItems = store.groupedUi.sidebarItems.filter(
    (item) => item.spec.client !== undefined && resolveTargetString(item.spec.target ?? '', store.conversations) === null,
  )
  if (viewItems.length === 0 && clientItems.length === 0) return null

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-header">{t('shell.sidebar.viewsHeader')}</div>
      {clientItems.map((item) => (
        <div key={`client:${item.pluginId}/${item.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={item.pluginId} spec={item.spec} label={t('shell.sidebar.itemLabel', { id: item.spec.id })} />
        </div>
      ))}
      {viewItems.map((view) => {
        const presence = resolveSidebarTargetPresence(store, (t) => isSameResolvedTarget(t, view.target))
        return (
          <div
            key={view.key}
            className={`nav-item${presenceNavClassSuffix(presence)}`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
              store.openTarget(view.target)
            }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              onClick={() => store.openTarget(view.target)}
              aria-current={presence.active ? 'page' : undefined}
            >
              <HelmxIcon name={view.icon} size={14} />
              <span className="nav-item-label">{view.label}</span>
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

const CENTER_LABEL_KEYS: Record<
  CenterKey,
  'shell.center.profiles' | 'shell.center.models' | 'shell.center.skills' | 'shell.center.nodes' | 'shell.center.plugins'
> = {
  profiles: 'shell.center.profiles',
  models: 'shell.center.models',
  skills: 'shell.center.skills',
  nodes: 'shell.center.nodes',
  plugins: 'shell.center.plugins',
}

/** 侧栏空间由主屏目标唯一推导（spaceForTarget，lib/types.ts），不进 URL；
 * Rail 点击经 store.openSpace 直接导航该空间的主舞台目标（含会话内空间记忆）。 */

const SPACE_ICONS: Record<SidebarSpace, string> = {
  conversations: 'message-square',
  views: 'layout-grid',
  settings: 'settings',
}

const SPACE_LABEL_KEYS: Record<
  SidebarSpace,
  'shell.space.conversations' | 'shell.space.views' | 'shell.space.settings'
> = {
  conversations: 'shell.space.conversations',
  views: 'shell.space.views',
  settings: 'shell.space.settings',
}

/**
 * Activity Rail（48px）：仅空间切换（对话/视图/设置）+ 主题按钮。
 * 桌面与移动抽屉共用；空间按钮直接导航主舞台到对应空间的最近目标（store.openSpace），
 * 系统中心入口收敛到「设置」空间内的纵向列表。
 * 「对话空间」按钮常驻挂载全局态势微标（与移动端汉堡同源 indicator）：桌面折叠
 * 侧栏时也能一眼感知全局并发（需处理/运行中/未读完成的紧凑计数与灯色）。
 */
function ActivityRail({
  sseConnected,
  theme,
  themePreference,
  onToggleTheme,
  onToggleSidebarCollapsed,
  space,
  onOpenSpace,
  attentionIndicator,
  quickEntries,
  store,
  onNavigate,
}: {
  sseConnected: boolean
  theme: 'dark' | 'light'
  themePreference: 'system' | 'light' | 'dark'
  onToggleTheme: () => void
  onToggleSidebarCollapsed?: () => void
  space: SidebarSpace
  onOpenSpace: (space: SidebarSpace) => void
  attentionIndicator: GlobalAttentionIndicator
  quickEntries: SidebarViewItem[]
  store: SidebarStoreView
  onNavigate?: () => void
}) {
  const { t } = useWebLocale()
  const expandWithShortcut = t('shell.sidebar.expandNavWithShortcut', { shortcut: formatModShortcut('B') })
  const themeTooltip =
    themePreference === 'system'
      ? t('shell.auth.themeSystem', {
          current: t(theme === 'dark' ? 'shell.theme.currentDark' : 'shell.theme.currentLight'),
        })
      : themePreference === 'light'
        ? t('shell.auth.themeLight')
        : t('shell.auth.themeDark')
  const themeAriaLabel =
    themePreference === 'system'
      ? t('shell.theme.system')
      : themePreference === 'light'
        ? t('shell.theme.light')
        : t('shell.theme.dark')
  const attentionSummary = composeAttentionSummary(attentionIndicator, t)

  return (
    <nav className="activity-rail" aria-label={t('shell.sidebar.mainNavigation')}>
      <div className="activity-rail-brand" title="Helmx">
        <HelmxIcon name="layers" size={17} />
        <StatusDot connected={sseConnected} />
      </div>
      <Tooltip content={expandWithShortcut} side="right">
        <button
          type="button"
          className="rail-btn desktop-sidebar-expand-btn"
          title={expandWithShortcut}
          aria-label={t('shell.sidebar.expandNav')}
          onClick={() => onToggleSidebarCollapsed?.()}
        >
          <HelmxIcon name="chevron-right" size={16} />
        </button>
      </Tooltip>
      <div className="activity-rail-spaces">
        {(Object.keys(SPACE_LABEL_KEYS) as SidebarSpace[]).map((key) => {
          const spaceLabel = t(SPACE_LABEL_KEYS[key])
          const carriesAttention = key === 'conversations' && attentionIndicator.tone !== null
          const labelWithAttention = carriesAttention && attentionSummary !== ''
            ? `${spaceLabel} · ${attentionSummary}`
            : spaceLabel
          return (
            <Tooltip content={labelWithAttention} side="right" key={key}>
              <button
                type="button"
                className={`rail-btn rail-space-btn${space === key ? ' rail-btn-active' : ''}`}
                title={labelWithAttention}
                aria-label={labelWithAttention}
                aria-current={space === key ? 'page' : undefined}
                onClick={() => onOpenSpace(key)}
              >
                <HelmxIcon name={SPACE_ICONS[key]} size={16} />
                {carriesAttention && (
                  <span className="rail-attention-badge" data-tone={attentionIndicator.tone}>
                    {attentionIndicator.totalCount > 99 ? '99+' : attentionIndicator.totalCount}
                  </span>
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>
      {quickEntries.length > 0 && (
        <div className="activity-rail-quick">
          {quickEntries.map((entry) => {
            const presence = resolveSidebarTargetPresence(store, (t) => isSameResolvedTarget(t, entry.target))
            return (
              <Tooltip content={entry.label} side="right" key={entry.key}>
                <button
                  type="button"
                  className={`rail-btn rail-quick-btn${presence.active ? ' rail-btn-active' : ''}`}
                  title={entry.label}
                  aria-label={entry.label}
                  aria-current={presence.active ? 'page' : undefined}
                  onClick={() => {
                    store.openTarget(entry.target)
                    onNavigate?.()
                  }}
                >
                  <HelmxIcon name={entry.icon} size={16} />
                </button>
              </Tooltip>
            )
          })}
        </div>
      )}
      <div className="activity-rail-footer">
        <LocaleMenuButton tooltipSide="right" menuSide="right" menuAlign="end" />
        <Tooltip content={themeTooltip} side="right">
          <button
            type="button"
            className="btn btn-ghost btn-sm sidebar-theme-toggle"
            title={themeTooltip}
            aria-label={themeAriaLabel}
            onClick={onToggleTheme}
          >
            <HelmxIcon
              name={
                themePreference === 'system'
                  ? 'monitor'
                  : themePreference === 'light'
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
function SettingsNavGroup({ store, onNavigate }: { store: SidebarStoreView; onNavigate?: () => void }) {
  const { t } = useWebLocale()
  return (
    <div className="sidebar-group settings-nav">
      {CENTER_TARGETS.map((key) => {
        const presence = resolveSidebarTargetPresence(store, (target) => target.kind === key)
        return (
          <div
            key={key}
            className={`nav-item settings-nav-item${presenceNavClassSuffix(presence)}`}
            onClick={(e) => {
              if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
              store.openTarget({ kind: key })
              onNavigate?.()
            }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              aria-current={presence.active ? 'page' : undefined}
              onClick={() => {
                store.openTarget({ kind: key })
                onNavigate?.()
              }}
            >
              <HelmxIcon name={CENTER_ICONS[key]} size={14} />
              <span className="nav-item-label">{t(CENTER_LABEL_KEYS[key])}</span>
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
  const { sseConnected } = useAuthConnection()
  const { theme, themePreference, locale, quietNotifyEnabled } = useThemePreferencesState()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const conversations = useConversations()
  const pendingAsks = usePendingAsks()
  const { profiles } = useProfilesSlice()
  const {
    openTarget,
    pushNotice,
    openSpace,
    setQuietNotify,
    setActiveModal,
    toggleSidebarCollapsed,
    toggleTheme,
  } = useStoreActions()
  const { t } = useWebLocale()

  const sidebarStore = useMemo<SidebarStoreView>(
    () => ({
      primaryTarget,
      splitTarget,
      focusedPanel,
      conversations,
      profiles,
      plugins,
      groupedUi,
      pendingAsks,
      locale,
      openTarget,
      pushNotice,
    }),
    [
      primaryTarget,
      splitTarget,
      focusedPanel,
      conversations,
      profiles,
      plugins,
      groupedUi,
      pendingAsks,
      locale,
      openTarget,
      pushNotice,
    ],
  )

  // 侧栏空间由主屏目标唯一推导（不进 URL）；Rail 点击经 openSpace 直接导航
  // 该空间最近的主舞台目标，URL 即该空间真实锚点，刷新/前进/后退天然可还原。
  const space = spaceForTarget(primaryTarget)

  // 全局并发态势（跨角色平铺条目 + 汉堡/Rail 微标 + 后台在途索引）：badge doc
  // 的按需加载内聚在 Hook（ensurePluginDoc 幂等，移动端合着抽屉也不漏后台任务）。
  // 插件停用后其 UI 贡献与 doc 均从 store 消失，态势自然归零。
  const { items: attentionItems, indicator: attentionIndicator, background } = useGlobalAttention()

  // 移动端视口：抽屉形态。任何空间拉开汉堡都能看到态势平铺区并一键行动；
  // 桌面非对话空间保持原布局（态势经 Rail 微标感知，点击「对话空间」直达）。
  const isMobileViewport = useIsMobileViewport()

  // 插件全局快捷入口（sidebar.item quickEntry，最薄通用声明）：仅收当前启用
  // 插件确实注册了的 screen（插件停用后贡献即时消失，入口零残留）；点击走标准
  // store 路由并收起移动抽屉——PC 折叠 Rail 与移动抽屉同源一键直达。
  const railQuickEntries = useMemo(
    () =>
      extractRailQuickEntries(
        groupedUi.sidebarItems,
        groupedUi.screens,
        conversations,
        locale,
      ),
    [groupedUi.sidebarItems, groupedUi.screens, conversations, locale],
  )

  // 后台浏览器通知开关：权限现场读取（浏览器设置可随时收回），
  // 偏好开而权限未授予时如实提示，绝不静默装作已开启。
  const quietNotifyTooltip = !quietNotifyEnabled
    ? t('shell.quietNotify.off')
    : readBrowserNotificationPermission() !== 'granted'
      ? t('shell.quietNotify.denied')
      : t('shell.quietNotify.on')
  const collapseWithShortcut = t('shell.sidebar.collapseNavWithShortcut', { shortcut: formatModShortcut('B') })
  const spaceHeaderLabel =
    space === 'conversations'
      ? t('shell.sidebar.spaceHeaderConversations')
      : space === 'views'
        ? t('shell.sidebar.viewsHeader')
        : t('shell.sidebar.spaceHeaderSettings')

  return (
    <aside className="helmx-sidebar">
      {/* Mobile drawer: stays expanded after switching spaces — the secondary list of the space
          (settings list / views list / agent list) renders naturally inside the drawer and closes it
          only when the user picks a concrete item (items carry onNavigate / the App nav-item close
          channel); closing here would whisk the user to the first target before they see the menu.
      The desktop sidebar is persistent; behavior unchanged. */}
      <ActivityRail
        sseConnected={sseConnected}
        theme={theme}
        themePreference={themePreference}
        onToggleTheme={toggleTheme}
        onToggleSidebarCollapsed={toggleSidebarCollapsed}
        space={space}
        onOpenSpace={(nextSpace) => {
          openSpace(nextSpace)
        }}
        attentionIndicator={attentionIndicator}
        quickEntries={railQuickEntries}
        store={sidebarStore}
        onNavigate={onClose}
      />
      <div className="sidebar-context">
        <div className="sidebar-header">
          <div className="sidebar-context-title">
            <HelmxIcon
              name={space === 'conversations' ? 'message-square' : space === 'views' ? 'layout-grid' : 'settings'}
              size={14}
            />
            <span>{spaceHeaderLabel}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content={t('shell.quietNotify.toggleTooltip')} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={quietNotifyTooltip}
                aria-label={quietNotifyTooltip}
                aria-pressed={quietNotifyEnabled}
                onClick={() => {
                  void setQuietNotify(!quietNotifyEnabled)
                }}
              >
                <HelmxIcon name={quietNotifyEnabled && readBrowserNotificationPermission() === 'granted' ? 'bell' : 'bell-off'} size={13} />
              </button>
            </Tooltip>
            <Tooltip content={t('shell.sidebar.openCommandPalette')} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={t('shell.sidebar.openCommandPalette')}
                aria-label={t('shell.sidebar.openCommandPalette')}
                onClick={() => setActiveModal({ kind: 'command-palette' })}
              >
                <HelmxIcon name="search" size={13} />
              </button>
            </Tooltip>
            <Tooltip content={collapseWithShortcut} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon desktop-sidebar-collapse-btn"
                title={collapseWithShortcut}
                aria-label={t('shell.sidebar.collapseNav')}
                onClick={() => toggleSidebarCollapsed?.()}
              >
                <HelmxIcon name="chevron-left" size={13} />
              </button>
            </Tooltip>
            {onClose && (
              <Tooltip content={t('shell.nav.closeNav')} side="bottom">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mobile-sidebar-close"
                  aria-label={t('shell.nav.closeNav')}
                  title={t('shell.nav.closeNav')}
                  onClick={onClose}
                >
                  <HelmxIcon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="sidebar-scroll">
          {/* 移动端抽屉在任何空间都先看到态势平铺区（一键行动）；对话空间的
              常规挂载点在下方 PendingAsksPanel 之后，此处避免重复渲染。 */}
          {space !== 'conversations' && isMobileViewport && (
            <SidebarAttentionGroup items={attentionItems} store={sidebarStore} onNavigate={onClose} />
          )}
          {space === 'conversations' ? (
            <>
              <PendingAsksPanel store={sidebarStore} />
              <SidebarAttentionGroup items={attentionItems} store={sidebarStore} onNavigate={onClose} />
              <AgentStandingsGroup store={sidebarStore} background={background} onNavigate={onClose} />
              <SidebarSectionGroups store={sidebarStore} background={background} />
              <ArchivedConversationsGroup background={background} onNavigate={onClose} />
            </>
          ) : space === 'views' ? (
            <ViewNavGroup store={sidebarStore} />
          ) : (
            <SettingsNavGroup store={sidebarStore} onNavigate={onClose} />
          )}
        </div>
      </div>
    </aside>
  )
}
