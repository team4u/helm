import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '@helm/protocol/browser'
import { searchApi } from '../lib/api.js'
import { commandActionPluginId, commandHint, commandsForConversation } from '../lib/commands-model.js'
import { HelmIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import {
  activeTargetForPanel,
  formatModShortcut,
  resolveFocusedPanel,
  selectRecentConversationsForPalette,
  type HelmShortcutDetail,
} from '../shell/shortcuts-model.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import type { CommandSpec } from '@helm/protocol/browser'

type PaletteRow =
  | { kind: 'command'; id: string; title: string; hint?: string; shortcut?: string; icon?: string; keywords?: string[]; run: () => void }
  | { kind: 'search-hit'; id: string; hit: SearchHit }

export function CommandPaletteModal({ onClose }: { onClose: () => void }) {
  const store = useHelmStore()
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
    return store.conversations
      .filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.profileId.toLowerCase().includes(q) ||
          (numeric !== null && c.id === numeric),
      )
      .slice(0, 6)
  }, [query, store.conversations])

  const close = () => onClose()

  const activePanel = resolveFocusedPanel(store.focusedPanel ?? 'primary', store.splitTarget)
  const activeTarget = activeTargetForPanel(store.primaryTarget, store.splitTarget, activePanel)

  // 当前 Profile 上下文：聚焦面板待命页或会话所属角色；无上下文时不猜测默认角色。
  const paletteProfileId = useMemo(() => {
    if (activeTarget.kind === 'agent') return activeTarget.profileId
    if (activeTarget.kind !== 'conversation') return undefined
    return store.conversations.find((c) => c.id === activeTarget.conversationId)?.profileId
  }, [activeTarget, store.conversations])

  // ⌘K 面板打开在当前聚焦面板会话上下文：与输入框 '/' 补全同一份作用域过滤，保证同一命令行为一致。
  const paletteConversation = useMemo(() => {
    if (activeTarget.kind !== 'conversation') return undefined
    return store.conversations.find((c) => c.id === activeTarget.conversationId)
  }, [activeTarget, store.conversations])

  const contextCommands = useMemo<Array<PaletteRow>>(() => {
    const rows: Array<PaletteRow> = []
    if (activeTarget.kind === 'conversation' || activeTarget.kind === 'agent') {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-model-picker',
        title: 'Switch current model',
        shortcut: 'Ctrl+L',
        icon: 'sparkles',
        keywords: ['model', 'picker', 'Model', 'Switch model'],
        run: () => {
          const detail: HelmShortcutDetail = { action: 'toggle-model-picker', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmShortcutDetail>('helm:shortcut', { detail }))
        },
      })
    }
    if (activeTarget.kind === 'conversation') {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-process-groups',
        title: 'Expand / collapse recent process steps',
        shortcut: 'Ctrl+O',
        icon: 'list-tree',
        keywords: ['process', 'thinking', 'tools', 'Process', 'Thinking', 'Collapse'],
        run: () => {
          const detail: HelmShortcutDetail = { action: 'toggle-process-groups', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmShortcutDetail>('helm:shortcut', { detail }))
        },
      })
    }
    if (activeTarget.kind === 'conversation' || store.workbenchOpen) {
      rows.push({
        kind: 'command',
        id: 'builtin:toggle-workbench',
        title: store.workbenchOpen ? 'Close workbench drawer' : 'Open workbench drawer',
        shortcut: formatModShortcut('J'),
        icon: 'panel-right',
        keywords: ['workbench', 'drawer', 'Workbench', 'Artifacts'],
        run: () => store.setWorkbenchOpen(!store.workbenchOpen),
      })
    }
    rows.push({
      kind: 'command',
      id: 'builtin:new-conversation',
      title: 'New conversation',
      hint: paletteProfileId !== undefined ? paletteProfileId : 'Select a profile first',
      icon: 'plus',
      run: () => {
        // 有当前 Profile 上下文进入待命态（首次发送才创建）；无上下文去角色中心选角色，
        // 不硬编码默认 assistant。
        store.openTarget(
          paletteProfileId !== undefined
            ? { kind: 'agent', profileId: paletteProfileId }
            : { kind: 'profiles' },
          activePanel === 'split' ? { split: true } : undefined,
        )
      },
    })
    if (store.splitTarget) {
      rows.push({
        kind: 'command',
        id: 'builtin:close-split',
        title: 'Close right split view',
        icon: 'panel-right',
        run: () => store.closeSplit(),
      })
    }
    return rows
  }, [activePanel, activeTarget.kind, paletteProfileId, store])

  const navCommands = useMemo<Array<PaletteRow>>(() => [
    {
      kind: 'command',
      id: 'builtin:toggle-sidebar',
      title: store.sidebarCollapsed ? 'Expand desktop sidebar' : 'Collapse desktop sidebar',
      shortcut: formatModShortcut('B'),
      icon: 'columns',
      keywords: ['sidebar', 'collapse', 'Sidebar', 'Collapse', 'Navigation'],
      run: () => store.toggleSidebarCollapsed?.(),
    },
    {
      kind: 'command',
      id: 'builtin:goto-assistant',
      title: 'Open personal assistant profile',
      hint: 'assistant',
      icon: 'sparkles',
      run: () => store.openTarget({ kind: 'agent', profileId: 'assistant' }),
    },
    {
      kind: 'command',
      id: 'builtin:open-profile-editor',
      title: 'Open agent profile center',
      icon: 'bot',
      keywords: ['profile', 'profiles', 'Profile', 'Agents'],
      run: () => {
        close()
        store.openTarget({ kind: 'profiles' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-provider-auth',
      title: 'Open models and credentials center',
      icon: 'key',
      keywords: ['model', 'models', 'provider', 'providers', 'key', 'Model', 'Credentials'],
      run: () => {
        close()
        store.openTarget({ kind: 'models' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-skill-viewer',
      title: 'Open skills center',
      icon: 'sparkles',
      keywords: ['skill', 'skills', 'Skills'],
      run: () => {
        close()
        store.openTarget({ kind: 'skills' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-nodes',
      title: 'Open compute nodes center',
      icon: 'network',
      keywords: ['node', 'nodes', 'byom', 'helm-node', 'Nodes'],
      run: () => {
        close()
        store.openTarget({ kind: 'nodes' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:open-plugin-center',
      title: 'Open plugins center',
      icon: 'boxes',
      keywords: ['plugin', 'plugins', 'settings', 'Plugins', 'Settings', 'Plugin Center'],
      run: () => {
        close()
        store.openTarget({ kind: 'plugins' })
      },
    },
    {
      kind: 'command',
      id: 'builtin:toggle-theme',
      title:
        store.themePreference === 'system'
          ? 'Switch to light mode'
          : store.themePreference === 'light'
            ? 'Switch to dark mode'
            : 'Switch to system theme',
      icon:
        store.themePreference === 'system'
          ? 'monitor'
          : store.themePreference === 'light'
            ? 'sun'
            : 'moon',
      run: () => store.toggleTheme(),
    },
    {
      kind: 'command',
      id: 'builtin:toggle-quiet-notify',
      title: store.quietNotifyEnabled ? 'Disable background browser notifications' : 'Enable background browser notifications (alert when a conversation completes or awaits input while the page is in the background)',
      icon: store.quietNotifyEnabled ? 'bell' : 'bell-off',
      keywords: ['notify', 'notification', 'background', 'quiet', 'blocked', 'Notifications', 'Alerts', 'Background', 'Completed', 'Approvals'],
      run: () => {
        void store.setQuietNotify(!store.quietNotifyEnabled)
      },
    },
  ], [store])

  // 声明了 client 内容的插件命令：作为可选中命令行列出（选中即内联渲染）
  const pluginContentCommands = useMemo(
    () =>
      store.groupedUi.commands
        .filter((cmd) => cmd.spec.client !== undefined)
        .map((cmd) => ({ pluginId: cmd.pluginId, spec: cmd.spec })),
    [store.groupedUi.commands],
  )

  const pluginCommands = useMemo<Array<PaletteRow>>(
    () =>
      commandsForConversation(store.groupedUi.commands, paletteConversation).map((cmd) => ({
        kind: 'command' as const,
        id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
        title: cmd.spec.title,
        hint: commandHint(cmd.spec, cmd.pluginId),
        icon: cmd.spec.icon ?? 'zap',
        keywords: cmd.spec.keywords,
        run: () => {
          if (!cmd.spec.actionId) return
          void store
            .invokePluginAction(commandActionPluginId(cmd), cmd.spec.actionId, cmd.spec.input, paletteConversation?.id)
            .then(() =>
              store.pushNotice({
                type: 'notification',
                level: 'info',
                title: 'Command executed',
                body: cmd.spec.title,
              }),
            )
            .catch((err: unknown) =>
              store.pushNotice({
                type: 'notification',
                level: 'error',
                title: 'Command execution failed',
                body: err instanceof Error ? err.message : String(err),
              }),
            )
        },
      })),
    [store, paletteConversation],
  )

  const conversationRows = useMemo<Array<PaletteRow>>(
    () =>
      conversationMatches.map((conv) => ({
        kind: 'search-hit' as const,
        id: `conv:${conv.id}`,
        hit: {
          conversationId: conv.id,
          title: conv.title,
          entryId: '',
          snippet: `Conversation #${conv.id} / ${conv.profileId}`,
        },
      })),
    [conversationMatches],
  )

  const searchRows = useMemo<Array<PaletteRow>>(
    () => hits.map((hit) => ({ kind: 'search-hit' as const, id: `hit:${hit.conversationId}/${hit.entryId}`, hit })),
    [hits],
  )

  const pluginRows = useMemo<Array<PaletteRow>>(
    () =>
      (store.plugins ?? []).map((plugin) => ({
        kind: 'command' as const,
        id: `plugin-item:${plugin.id}`,
        title: `Plugin: ${plugin.name || plugin.id}`,
        hint: `View and configure ${plugin.id} in the plugin center`,
        icon: 'boxes',
        keywords: [
          'plugin',
          'plugins',
          'Plugins',
          plugin.id,
          plugin.name ?? '',
          ...(plugin.tools ?? []),
          ...(plugin.actions ?? []),
        ],
        run: () => {
          close()
          store.openTarget({ kind: 'plugins', pluginId: plugin.id })
        },
      })),
    [store.plugins, store.openTarget, close],
  )

  const recentConversationRows = useMemo<Array<PaletteRow>>(
    () =>
      selectRecentConversationsForPalette(store.conversations, paletteConversation?.id, 5).map((conv) => ({
        kind: 'search-hit' as const,
        id: `recent-conv:${conv.id}`,
        hit: {
          conversationId: conv.id,
          title: conv.title,
          entryId: '',
          snippet: `Recent conversation #${conv.id} / ${conv.profileId}`,
        },
      })),
    [store.conversations, paletteConversation?.id],
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
      store.openTarget(
        { kind: 'conversation', conversationId: row.hit.conversationId },
        { highlightEntryId: String(row.hit.entryId) },
      )
    } else {
      close()
      store.openTarget({ kind: 'conversation', conversationId: row.hit.conversationId })
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
            aria-label="Command palette and global search"
            onKeyDown={onKeyDown}
          >
            <DialogTitle style={{ display: 'none' }}>Command palette and global search</DialogTitle>
            <div className="modal-header" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
                <HelmIcon name="search" size={15} />
                <input
                  ref={inputRef}
                  aria-label="Search message text, jump to a conversation, or run a command"
                  placeholder="Search message text, jump to a conversation, or run a command..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {searching && (
                <span className="badge badge-neutral" style={{ height: 22, padding: '0 6px', flexShrink: 0 }}>
                  <HelmIcon name="loader" size={12} className="spin-slow" />
                  Searching
                </span>
              )}
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm palette-close-btn"
                  onClick={close}
                  title="Close"
                  aria-label="Close"
                >
                  <span className="palette-close-desktop badge badge-neutral">Esc to close</span>
                  <span className="palette-close-mobile" style={{ alignItems: 'center', gap: 4 }}>
                    <HelmIcon name="x" size={13} />
                    <span style={{ fontSize: 11.5 }}>Close</span>
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
                  {previewCmd.spec.title} · {previewCmd.pluginId}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPreviewCmd(null)}
                  aria-label="Close command content preview"
                >
                  Collapse
                </button>
              </div>
              <PluginUiView
                pluginId={previewCmd.pluginId}
                spec={previewCmd.spec}
                label={`Command ${previewCmd.spec.id} content`}
              />
            </div>
          )}
          {rows.length === 0 && (
            <div style={{ padding: '18px 12px', color: 'var(--fg-subtle)', fontSize: 12.5, textAlign: 'center' }}>
              {query.trim() ? 'No matching results' : 'Type keywords to search, or pick a command below'}
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
                  <HelmIcon name={row.icon} size={14} />
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
                  <HelmIcon name="message-square" size={14} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span className="nav-item-label">
                      {row.hit.title || `Conversation #${row.hit.conversationId}`}
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
