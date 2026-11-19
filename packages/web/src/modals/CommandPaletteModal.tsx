import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary, SearchHit } from '@helmx/protocol/browser'
import { searchApi } from '../lib/api.js'
import { commandActionPluginId, commandHint, commandsForConversation } from '../lib/commands-model.js'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import { HelmxIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@helmx/plugin-client'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePluginDocsState,
  usePlugins,
  useSidebarCollapsed,
  useStoreActions,
  useThemePreferencesState,
  useWorkbenchState,
} from '../lib/store-context.js'
import { resolveBrowserLocale } from '../lib/theme-preferences.js'
import type { LocalePreference } from '../lib/types.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  activeTargetForPanel,
  formatModShortcut,
  resolveFocusedPanel,
  selectRecentConversationsForPalette,
  type HelmxShortcutDetail,
} from '../shell/shortcuts-model.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
} from '../shell/background-activity-model.js'
import type { CommandSpec } from '@helmx/protocol/browser'

type PaletteRow =
  | { kind: 'command'; id: string; title: string; hint?: string; shortcut?: string; icon?: string; keywords?: string[]; run: () => void }
  | { kind: 'search-hit'; id: string; hit: SearchHit; conv?: ConversationSummary }

export function CommandPaletteModal({ onClose }: { onClose: () => void }) {
  const conversations = useConversations()
  const { authenticated } = useAuthConnection()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const { workbenchOpen } = useWorkbenchState()
  const sidebarCollapsed = useSidebarCollapsed()
  const { themePreference, localePreference: storeLocalePref, quietNotifyEnabled } = useThemePreferencesState()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const pluginDocs = usePluginDocsState()
  const actions = useStoreActions()
  const { locale, t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  // 声明了 client/json 内容的插件命令：选中时在本面板内联渲染内容
  //（纯元数据命令仍走 actionId 执行，不改变默认导航行为）。
  const [previewCmd, setPreviewCmd] = useState<{ pluginId: string; spec: CommandSpec } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // FTS5 全文搜索 200ms 防抖
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      searchApi
        .query(q)
        .then((items) => setHits(items.slice(0, 8)))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const conversationMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const numeric = /^\d+$/.test(q) ? Number(q) : null
    return conversations
      .filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.profileId.toLowerCase().includes(q) ||
          (numeric !== null && c.id === numeric),
      )
      .slice(0, 6)
  }, [query, conversations])

  // 会话行灯位与态势排序共享的后台在途索引（workbench badge 契约 + 上下文精简）；
  // badge doc 的按需加载与侧栏同链路（ensurePluginDoc 幂等，不重复请求）。
  const background = useMemo(
    () =>
      summarizeConversationBackgroundActivity({
        panels: groupedUi.workbenchPanels,
        conversations,
        pluginDocs,
        t,
      }),
    [groupedUi.workbenchPanels, conversations, pluginDocs, t],
  )
  const badgeDocs = useMemo(
    () => collectBackgroundBadgeDocs(groupedUi.workbenchPanels, conversations),
    [groupedUi.workbenchPanels, conversations],
  )
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) void actions.ensurePluginDoc(ref.pluginId, ref.doc)
  }, [badgeDocs, authenticated, actions.ensurePluginDoc])

  const close = () => onClose()

  const activePanel = resolveFocusedPanel(focusedPanel ?? 'primary', splitTarget)
  const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, activePanel)

  // 当前 Profile 上下文：聚焦面板待命页或会话所属角色；无上下文时不猜测默认角色。
  const paletteProfileId = useMemo(() => {
    if (activeTarget.kind === 'agent') return activeTarget.profileId
    if (activeTarget.kind !== 'conversation') return undefined
    return conversations.find((c) => c.id === activeTarget.conversationId)?.profileId
  }, [activeTarget, conversations])

  // ⌘K 面板打开在当前聚焦面板会话上下文：与输入框 '/' 补全同一份作用域过滤，保证同一命令行为一致。
  const paletteConversation = useMemo(() => {
    if (activeTarget.kind !== 'conversation') return undefined
    return conversations.find((c) => c.id === activeTarget.conversationId)
  }, [activeTarget, conversations])

  const contextCommands = useMemo<Array<PaletteRow>>(() => {
    const rows: Array<PaletteRow> = []
    if (activeTarget.kind === 'conversation' || activeTarget.kind === 'agent') {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-model-picker',
        title: t('modals.palette.cmd.toggleModelPicker'),
        shortcut: 'Ctrl+L',
        icon: 'sparkles',
        keywords: ['model', 'picker', 'Model', 'Switch model', '模型', '切换模型'],
        run: () => {
          const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        },
      })
    }
    if (activeTarget.kind === 'conversation') {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-process-groups',
        title: t('modals.palette.cmd.toggleProcessGroups'),
        shortcut: 'Ctrl+O',
        icon: 'list-tree',
        keywords: ['process', 'thinking', 'tools', 'Process', 'Thinking', 'Collapse', '过程', '思考', '工具', '收起'],
        run: () => {
          const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        },
      })
    }
    if (activeTarget.kind === 'conversation' || workbenchOpen) {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-workbench',
        title: workbenchOpen ? t('modals.palette.cmd.closeWorkbench') : t('modals.palette.cmd.openWorkbench'),
        shortcut: formatModShortcut('J'),
        icon: 'panel-right',
        keywords: ['workbench', 'drawer', 'Workbench', 'Artifacts', '工作台', '产物'],
        run: () => actions.setWorkbenchOpen(!workbenchOpen),
      })
    }
    rows.push({
      kind: 'command',
      id: 'builtin:new-conversation',
      title: t('modals.palette.cmd.newConversation'),
      hint: paletteProfileId !== undefined ? paletteProfileId : t('modals.palette.cmd.selectProfileFirst'),
      icon: 'plus',
      keywords: ['new', 'conversation', 'topic', '新建', '会话', '话题'],
      run: () => {
        // 有当前 Profile 上下文进入待命态（首次发送才创建）；无上下文去角色中心选角色，
        // 不硬编码默认 assistant。
        actions.openTarget(
          paletteProfileId !== undefined
            ? { kind: 'agent', profileId: paletteProfileId }
            : { kind: 'profiles' },
          activePanel === 'split' ? { split: true } : undefined,
        )
      },
    })
    if (splitTarget) {
      rows.push({
        kind: 'command',
        id: 'builtin:close-split',
        title: t('modals.palette.cmd.closeSplit'),
        icon: 'panel-right',
        keywords: ['split', 'close', '分屏', '关闭'],
        run: () => actions.closeSplit(),
      })
    }
    return rows
  }, [activePanel, activeTarget.kind, actions, paletteProfileId, splitTarget, t, workbenchOpen])

  const localePref: LocalePreference = storeLocalePref ?? 'auto'

  const navCommands = useMemo<Array<PaletteRow>>(() => [
    {
      kind: 'command',
      id: 'builtin:toggle-sidebar',
      title: sidebarCollapsed ? t('modals.palette.cmd.expandSidebar') : t('modals.palette.cmd.collapseSidebar'),
      shortcut: formatModShortcut('B'),
      icon: 'columns',
      keywords: ['sidebar', 'collapse', 'Sidebar', 'Collapse', 'Navigation', '侧栏', '导航', '收起', '展开'],
      run: () => actions.toggleSidebarCollapsed?.(),
    },
    {
      kind: 'command',
      id: 'builtin:goto-assistant',
      title: t('modals.palette.cmd.gotoAssistant'),
      hint: 'assistant',
      icon: 'sparkles',
      keywords: ['assistant', 'profile', '个人助理', '角色'],
      run: () => actions.openTarget({ kind: 'agent', profileId: 'assistant' }),
    },
    {
      kind: 'command',
      id: 'builtin:open-profile-editor',
      title: t('modals.palette.cmd.openProfiles'),
      icon: 'bot',
      keywords: ['profile', 'profiles', 'Profile', 'Agents', '角色', '智能体'],
      run: () => {
        close()
        actions.openTarget({ kind: 'profiles' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-provider-auth',
      title: t('modals.palette.cmd.openModels'),
      icon: 'key',
      keywords: ['model', 'models', 'provider', 'providers', 'key', 'Model', 'Credentials', '模型', '凭证', '供应商'],
      run: () => {
        close()
        actions.openTarget({ kind: 'models' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-skill-viewer',
      title: t('modals.palette.cmd.openSkills'),
      icon: 'sparkles',
      keywords: ['skill', 'skills', 'Skills', '技能'],
      run: () => {
        close()
        actions.openTarget({ kind: 'skills' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-nodes',
      title: t('modals.palette.cmd.openNodes'),
      icon: 'network',
      keywords: ['node', 'nodes', 'byom', 'helmx-node', 'Nodes', '节点', '计算节点'],
      run: () => {
        close()
        actions.openTarget({ kind: 'nodes' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-plugin-center',
      title: t('modals.palette.cmd.openPlugins'),
      icon: 'boxes',
      keywords: ['plugin', 'plugins', 'settings', 'Plugins', 'Settings', 'Plugin Center', '插件', '设置', '插件中心'],
      run: () => {
        close()
        actions.openTarget({ kind: 'plugins' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:toggle-theme',
      title:
        themePreference === 'system'
          ? t('modals.palette.cmd.themeToLight')
          : themePreference === 'light'
            ? t('modals.palette.cmd.themeToDark')
            : t('modals.palette.cmd.themeToSystem'),
      icon:
        themePreference === 'system'
          ? 'monitor'
          : themePreference === 'light'
            ? 'sun'
            : 'moon',
      keywords: ['theme', 'light', 'dark', 'system', '主题', '浅色', '暗色', '系统'],
      run: () => actions.toggleTheme(),
    },
    {
      kind: 'command',
      id: 'builtin:cycle-locale',
      title:
        localePref === 'auto'
          ? t('modals.palette.cmd.localeToEnglish')
          : localePref === 'en'
            ? t('modals.palette.cmd.localeToZhCn')
            : t('modals.palette.cmd.localeToAuto'),
      hint: localePref === 'auto' ? t('shell.locale.auto') : localePref === 'en' ? 'English' : '简体中文',
      icon: 'globe',
      keywords: ['language', 'locale', 'i18n', 'auto', 'english', 'chinese', '语言', '中文', '英文', '自动'],
      run: () => {
        const nextPref: LocalePreference =
          localePref === 'auto' ? 'en' : localePref === 'en' ? 'zh-CN' : 'auto'
        if (actions.setLocalePreference) {
          actions.setLocalePreference(nextPref)
        } else {
          actions.setLocale(nextPref === 'auto' ? resolveBrowserLocale() : nextPref)
        }
      },
    },
    {
      kind: 'command',
      id: 'builtin:toggle-quiet-notify',
      title: quietNotifyEnabled
        ? t('modals.palette.cmd.quietNotifyDisable')
        : t('modals.palette.cmd.quietNotifyEnable'),
      icon: quietNotifyEnabled ? 'bell' : 'bell-off',
      keywords: ['notify', 'notification', 'background', 'quiet', 'blocked', 'Notifications', 'Alerts', 'Background', 'Completed', 'Approvals', '通知', '后台', '提醒', '审批'],
      run: () => {
        void actions.setQuietNotify(!quietNotifyEnabled)
      },
    },
  ], [actions, localePref, quietNotifyEnabled, sidebarCollapsed, t, themePreference])

  // 声明了 client 内容的插件命令：作为可选中命令行列出（选中即内联渲染）
  const pluginContentCommands = useMemo(
    () =>
      groupedUi.commands
        .filter((cmd) => cmd.spec.client !== undefined)
        .map((cmd) => ({ pluginId: cmd.pluginId, spec: cmd.spec })),
    [groupedUi.commands],
  )

  const pluginCommands = useMemo<Array<PaletteRow>>(
    () =>
      commandsForConversation(groupedUi.commands, paletteConversation).map((cmd) => ({
        kind: 'command' as const,
        id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
        title: resolveLocalizedText(cmd.spec.title, locale),
        hint: commandHint(cmd.spec, cmd.pluginId, locale),
        icon: cmd.spec.icon ?? 'zap',
        keywords: cmd.spec.keywords,
        run: () => {
          if (!cmd.spec.actionId) return
          void actions
            .invokePluginAction(commandActionPluginId(cmd), cmd.spec.actionId, cmd.spec.input, paletteConversation?.id)
            .then(() =>
              actions.pushNotice({
                type: 'notification',
                level: 'info',
                title: t('modals.palette.cmdExecuted'),
                body: resolveLocalizedText(cmd.spec.title, locale),
              }),
            )
            .catch((err: unknown) =>
              actions.pushNotice({
                type: 'notification',
                level: 'error',
                title: t('modals.palette.cmdFailed'),
                body: err instanceof Error ? err.message : String(err),
              }),
            )
        },
      })),
    [actions, groupedUi.commands, paletteConversation, locale, t],
  )

  const conversationRows = useMemo<Array<PaletteRow>>(
    () =>
      conversationMatches.map((conv) => ({
        kind: 'search-hit' as const,
        id: `conv:${conv.id}`,
        conv,
        hit: {
          conversationId: conv.id,
          title: conv.title,
          entryId: '',
          snippet: t('modals.palette.convSnippet', { id: conv.id, profileId: conv.profileId }),
        },
      })),
    [conversationMatches, t],
  )

  const searchRows = useMemo<Array<PaletteRow>>(
    () =>
      hits.map((hit) => ({
        kind: 'search-hit' as const,
        id: `hit:${hit.conversationId}/${hit.entryId}`,
        hit,
        conv: conversations.find((c) => c.id === hit.conversationId),
      })),
    [hits, conversations],
  )

  const pluginRows = useMemo<Array<PaletteRow>>(
    () =>
      (plugins ?? []).map((plugin) => ({
        kind: 'command' as const,
        id: `plugin-item:${plugin.id}`,
        title: t('modals.palette.pluginTitle', { name: resolveLocalizedText(plugin.name, locale) || plugin.id }),
        hint: t('modals.palette.pluginHint', { id: plugin.id }),
        icon: 'boxes',
        keywords: [
          'plugin',
          'plugins',
          'Plugins',
          '插件',
          '插件中心',
          plugin.id,
          resolveLocalizedText(plugin.name, locale),
          ...(plugin.tools ?? []),
          ...(plugin.actions ?? []),
        ],
        run: () => {
          close()
          actions.openTarget({ kind: 'plugins', pluginId: plugin.id })
        },
      })),
    [plugins, actions.openTarget, close, locale, t],
  )

  const recentConversationRows = useMemo<Array<PaletteRow>>(
    () =>
      selectRecentConversationsForPalette(conversations, paletteConversation?.id, 5, background).map((conv) => ({
        kind: 'search-hit' as const,
        id: `recent-conv:${conv.id}`,
        conv,
        hit: {
          conversationId: conv.id,
          title: conv.title,
          entryId: '',
          snippet: t('modals.palette.recentSnippet', { id: conv.id, profileId: conv.profileId }),
        },
      })),
    [conversations, paletteConversation?.id, background, t],
  )

  const rows = useMemo<Array<PaletteRow>>(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // 空搜索词首屏优先级：当前上下文高频操作 → 最近活跃会话（前 5 条）→ 空间与中心导航 → 插件命令与配置
      return [
        ...contextCommands,
        ...recentConversationRows,
        ...navCommands,
        ...pluginCommands,
        ...pluginRows,
      ]
    }
    const commands = [...contextCommands, ...navCommands, ...pluginCommands, ...pluginRows].filter((row) => {
      if (row.kind !== 'command') return true
      return (
        row.title.toLowerCase().includes(q) ||
        (row.hint?.toLowerCase().includes(q) ?? false) ||
        (row.shortcut?.toLowerCase().includes(q) ?? false) ||
        (row.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false)
      )
    })
    return [...commands, ...conversationRows, ...searchRows]
  }, [
    query,
    contextCommands,
    recentConversationRows,
    navCommands,
    pluginCommands,
    pluginRows,
    conversationRows,
    searchRows,
  ])

  useEffect(() => {
    setSelectedIdx(0)
  }, [rows.length, query])

  const runRow = (row: PaletteRow) => {
    if (row.kind === 'command') {
      // 内容型命令（声明 client/json）：内联渲染内容，不关闭面板
      const cmd = pluginContentCommands.find((c) => `plugin:${c.pluginId}/${c.spec.id}` === row.id)
      if (cmd) {
        setPreviewCmd(cmd)
        return
      }
      close()
      row.run()
    } else if (row.hit.entryId) {
      close()
      actions.openTarget(
        { kind: 'conversation', conversationId: row.hit.conversationId },
        { highlightEntryId: String(row.hit.entryId) },
      )
    } else {
      close()
      actions.openTarget({ kind: 'conversation', conversationId: row.hit.conversationId })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[selectedIdx]
      if (row) runRow(row)
    }
  }

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal"
            style={{ maxWidth: 620 }}
            aria-label={t('modals.palette.dialogTitle')}
            onKeyDown={onKeyDown}
          >
            <DialogTitle style={{ display: 'none' }}>{t('modals.palette.dialogTitle')}</DialogTitle>
            <div className="modal-header" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
                <HelmxIcon name="search" size={15} />
                <input
                  ref={inputRef}
                  aria-label={t('modals.palette.searchAria')}
                  placeholder={t('modals.palette.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {searching && (
                <span className="badge badge-neutral" style={{ height: 22, padding: '0 6px', flexShrink: 0 }}>
                  <HelmxIcon name="loader" size={12} className="spin-slow" />
                  {t('modals.palette.searching')}
                </span>
              )}
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm palette-close-btn"
                  onClick={close}
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <span className="palette-close-desktop badge badge-neutral">{t('modals.palette.escToClose')}</span>
                  <span className="palette-close-mobile" style={{ alignItems: 'center', gap: 4 }}>
                    <HelmxIcon name="x" size={13} />
                    <span style={{ fontSize: 11.5 }}>{t('common.close')}</span>
                  </span>
                </button>
              </DialogClose>
            </div>
        <div className="modal-body" style={{ padding: 6, gap: 2 }} ref={listRef}>
          {previewCmd && (
            <div
              style={{
                padding: 8,
                marginBottom: 6,
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  marginBottom: 6,
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                }}
              >
                <span>
                  {resolveLocalizedText(previewCmd.spec.title, locale)} · {previewCmd.pluginId}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPreviewCmd(null)}
                  aria-label={t('modals.palette.closePreview')}
                >
                  {t('common.collapse')}
                </button>
              </div>
              <PluginUiView
                pluginId={previewCmd.pluginId}
                spec={previewCmd.spec}
                label={t('modals.palette.previewLabel', { id: previewCmd.spec.id })}
              />
            </div>
          )}
          {rows.length === 0 && (
            <div style={{ padding: '18px 12px', color: 'var(--fg-subtle)', fontSize: 12.5, textAlign: 'center' }}>
              {query.trim() ? t('modals.palette.noResults') : t('modals.palette.emptyHint')}
            </div>
          )}
          {rows.map((row, idx) =>
            row.kind === 'command' ? (
              <div
                key={row.id}
                data-idx={idx}
                className={`nav-item${idx === selectedIdx ? ' nav-item-active' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => runRow(row)}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="nav-item-main">
                  <HelmxIcon name={row.icon} size={14} />
                  <span className="nav-item-label">{row.title}</span>
                </span>
                {(row.hint || row.shortcut) && (
                  <span className="nav-item-meta">
                    {row.hint && <span className="mono">{row.hint}</span>}
                    {row.shortcut && <kbd className="kbd-hint">{row.shortcut}</kbd>}
                  </span>
                )}
              </div>
            ) : (
              <div
                key={row.id}
                data-idx={idx}
                className={`nav-item${idx === selectedIdx ? ' nav-item-active' : ''}`}
                style={{ cursor: 'pointer', alignItems: 'flex-start' }}
                onClick={() => runRow(row)}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="nav-item-main">
                  <span className="nav-status-slot">
                    {row.conv !== undefined ? (
                      <ConversationStatusDot conv={row.conv} background={background.get(row.conv.id)} />
                    ) : (
                      <HelmxIcon name="message-square" size={14} />
                    )}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span className="nav-item-label">
                      {row.hit.title || t('shell.conversationFallback', { id: row.hit.conversationId })}
                    </span>
                    <span
                      className="mono selectable"
                      style={{
                        fontSize: 11.5,
                        color: idx === selectedIdx ? 'var(--nav-active-muted)' : 'var(--fg-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 480,
                      }}
                    >
                      {row.hit.snippet}
                    </span>
                  </span>
                </span>
                <span className="nav-item-meta tabular-nums">#{row.hit.conversationId}</span>
              </div>
            ),
          )}
        </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
