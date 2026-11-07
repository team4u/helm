import { useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi, searchApi, type SearchHitItem } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

type PaletteRow =
  | { kind: 'command'; id: string; title: string; hint?: string; icon?: string; keywords?: string[]; run: () => void }
  | { kind: 'search-hit'; id: string; hit: SearchHitItem }

export function CommandPaletteModal({ onClose }: { onClose: () => void }) {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHitItem[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
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

  const builtinCommands = useMemo<Array<PaletteRow>>(() => {
    const rows: Array<PaletteRow> = [
      {
        kind: 'command',
        id: 'builtin:new-conversation',
        title: '新建对话',
        icon: 'plus',
        run: () => {
          void (async () => {
            try {
              const conv = await conversationsApi.create()
              store.openTarget({ kind: 'conversation', conversationId: conv.id })
            } catch (err) {
              store.pushNotice({
                type: 'notification',
                level: 'error',
                title: '新建会话失败',
                body: err instanceof Error ? err.message : String(err),
              })
            }
          })()
        },
      },
      {
        kind: 'command',
        id: 'builtin:goto-assistant',
        title: '跳转 #1 个人助理',
        hint: '#1',
        icon: 'sparkles',
        run: () => store.openTarget({ kind: 'conversation', conversationId: 1 }),
      },
      {
        kind: 'command',
        id: 'builtin:open-profile-editor',
        title: '打开角色 Profile 编辑器',
        icon: 'bot',
        run: () => store.setActiveModal({ kind: 'profile-editor' }),
      },
      {
        kind: 'command',
        id: 'builtin:open-provider-auth',
        title: '打开模型与 API Key 设置',
        icon: 'key',
        run: () => store.setActiveModal({ kind: 'provider-auth' }),
      },
      {
        kind: 'command',
        id: 'builtin:open-skill-viewer',
        title: '打开技能查看器',
        icon: 'sparkles',
        run: () => store.setActiveModal({ kind: 'skill-viewer' }),
      },
      {
        kind: 'command',
        id: 'builtin:open-plugin-settings',
        title: '打开插件设置',
        icon: 'settings',
        run: () => store.setActiveModal({ kind: 'plugin-settings' }),
      },
      {
        kind: 'command',
        id: 'builtin:toggle-theme',
        title: '切换明暗主题',
        icon: store.theme === 'light' ? 'moon' : 'sun',
        run: () => store.toggleTheme(),
      },
    ]
    if (store.splitTarget) {
      rows.push({
        kind: 'command',
        id: 'builtin:close-split',
        title: '关闭右侧分屏',
        icon: 'panel-right',
        run: () => store.closeSplit(),
      })
    }
    return rows
  }, [store])

  const pluginCommands = useMemo<Array<PaletteRow>>(
    () =>
      store.groupedUi.commands.map((cmd) => ({
        kind: 'command' as const,
        id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
        title: cmd.spec.title,
        hint: cmd.spec.actionId ? `${cmd.pluginId} / ${cmd.spec.actionId}` : cmd.pluginId,
        icon: 'zap',
        keywords: cmd.spec.keywords,
        run: () => {
          if (!cmd.spec.actionId) return
          void store
            .invokePluginAction(cmd.pluginId, cmd.spec.actionId, cmd.spec.input)
            .then(() =>
              store.pushNotice({
                type: 'notification',
                level: 'info',
                title: '命令已执行',
                body: cmd.spec.title,
              }),
            )
            .catch((err: unknown) =>
              store.pushNotice({
                type: 'notification',
                level: 'error',
                title: '命令执行失败',
                body: err instanceof Error ? err.message : String(err),
              }),
            )
        },
      })),
    [store],
  )

  const conversationRows = useMemo<Array<PaletteRow>>(
    () =>
      conversationMatches.map((conv) => ({
        kind: 'search-hit' as const,
        id: `conv:${conv.id}`,
        hit: {
          conversationId: conv.id,
          conversationTitle: conv.title,
          entryId: '',
          snippet: `会话 #${conv.id} / ${conv.profileId}`,
        },
      })),
    [conversationMatches],
  )

  const searchRows = useMemo<Array<PaletteRow>>(
    () => hits.map((hit) => ({ kind: 'search-hit' as const, id: `hit:${hit.conversationId}/${hit.entryId}`, hit })),
    [hits],
  )

  const rows = useMemo<Array<PaletteRow>>(() => {
    const q = query.trim().toLowerCase()
    const commands = [...builtinCommands, ...pluginCommands].filter((row) => {
      if (row.kind !== 'command') return true
      if (!q) return true
      return (
        row.title.toLowerCase().includes(q) ||
        (row.hint?.toLowerCase().includes(q) ?? false) ||
        (row.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false)
      )
    })
    return [...commands, ...conversationRows, ...searchRows]
  }, [query, builtinCommands, pluginCommands, conversationRows, searchRows])

  useEffect(() => {
    setSelectedIdx(0)
  }, [rows.length, query])

  const runRow = (row: PaletteRow) => {
    if (row.kind === 'command') {
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 620 }}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板与全局搜索"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header" style={{ padding: '8px 12px' }}>
          <style>{'@keyframes helmSpin { to { transform: rotate(360deg) } }'}</style>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <HelmIcon name="search" size={15} />
            <input
              ref={inputRef}
              className="input"
              style={{ border: 'none', background: 'transparent', padding: '4px 0' }}
              aria-label="搜索消息全文、跳转会话或执行命令"
              placeholder="搜索消息全文、跳转会话或执行命令..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {searching && (
              <span className="badge badge-neutral" style={{ height: 22, padding: '0 6px' }}>
                <HelmIcon name="loader" size={12} style={{ animation: 'helmSpin 0.9s linear infinite' }} />
                搜索中
              </span>
            )}
            <span className="badge badge-neutral">Esc 关闭</span>
          </span>
        </div>
        <div className="modal-body" style={{ padding: 6, gap: 2 }} ref={listRef}>
          {rows.length === 0 && (
            <div style={{ padding: '18px 12px', color: 'var(--fg-subtle)', fontSize: 12.5, textAlign: 'center' }}>
              {query.trim() ? '没有匹配的结果' : '输入关键词搜索，或直接选择下方命令'}
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
                {row.hint && <span className="nav-item-meta mono">{row.hint}</span>}
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
                      {row.hit.conversationTitle || `会话 #${row.hit.conversationId}`}
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
      </div>
    </div>
  )
}
