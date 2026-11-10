import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import { conversationsApi, searchApi } from '../lib/api.js'
import { commandActionPluginId, commandHint, commandsForConversation } from '../lib/commands-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import type { CommandSpec } from '@helm/protocol'

type PaletteRow =
  | { kind: 'command'; id: string; title: string; hint?: string; icon?: string; keywords?: string[]; run: () => void }
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
        run: () => store.openTarget({ kind: 'conversation', conversationId: ROOT_CONVERSATION_ID }),
      },
      {
        kind: 'command',
        id: 'builtin:open-profile-editor',
        title: '打开智能体角色中心',
        icon: 'bot',
        keywords: ['profile', 'profiles', '角色', '智能体'],
        run: () => {
          close()
          store.openTarget({ kind: 'profiles' })
        },
      },
      {
        kind: 'command',
        id: 'builtin:open-provider-auth',
        title: '打开模型与凭据中心',
        icon: 'key',
        keywords: ['model', 'models', 'provider', 'providers', 'key', '模型', '凭据'],
        run: () => {
          close()
          store.openTarget({ kind: 'models' })
        },
      },
      {
        kind: 'command',
        id: 'builtin:open-skill-viewer',
        title: '打开技能中心',
        icon: 'sparkles',
        keywords: ['skill', 'skills', '技能'],
        run: () => {
          close()
          store.openTarget({ kind: 'skills' })
        },
      },
      {
        kind: 'command',
        id: 'builtin:open-nodes',
        title: '打开计算节点中心',
        icon: 'network',
        keywords: ['node', 'nodes', 'byom', 'helm-node', '节点'],
        run: () => {
          close()
          store.openTarget({ kind: 'nodes' })
        },
      },
      {
        kind: 'command',
        id: 'builtin:open-plugin-center',
        title: '打开插件中心',
        icon: 'boxes',
        keywords: ['plugin', 'plugins', 'settings', '插件', '设置', '插件中心'],
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
            ? '切换为浅色模式'
            : store.themePreference === 'light'
              ? '切换为暗色模式'
              : '切换为跟随系统',
        icon:
          store.themePreference === 'system'
            ? 'monitor'
            : store.themePreference === 'light'
              ? 'sun'
              : 'moon',
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

  // 声明了 client/json 内容的插件命令：作为可选中命令行列出（选中即内联渲染）
  const pluginContentCommands = useMemo(
    () =>
      store.groupedUi.commands
        .filter((cmd) => cmd.spec.client !== undefined || cmd.spec.json !== undefined)
        .map((cmd) => ({ pluginId: cmd.pluginId, spec: cmd.spec })),
    [store.groupedUi.commands],
  )

  // ⌘K 面板打开在当前会话上下文：与输入框 '/' 补全同一份作用域过滤，保证同一命令行为一致。
  const paletteConversation = useMemo(() => {
    const target = store.primaryTarget
    if (target.kind !== 'conversation') return undefined
    return store.conversations.find((c) => c.id === target.conversationId)
  }, [store.primaryTarget, store.conversations])

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
          snippet: `会话 #${conv.id} / ${conv.profileId}`,
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
        title: `插件：${plugin.name || plugin.id}`,
        hint: `在插件中心查看与配置 ${plugin.id}`,
        icon: 'boxes',
        keywords: [
          'plugin',
          'plugins',
          '插件',
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

  const rows = useMemo<Array<PaletteRow>>(() => {
    const q = query.trim().toLowerCase()
    const commands = [...builtinCommands, ...pluginCommands, ...pluginRows].filter((row) => {
      if (row.kind !== 'command') return true
      if (!q) return true
      return (
        row.title.toLowerCase().includes(q) ||
        (row.hint?.toLowerCase().includes(q) ?? false) ||
        (row.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false)
      )
    })
    return [...commands, ...conversationRows, ...searchRows]
  }, [query, builtinCommands, pluginCommands, pluginRows, conversationRows, searchRows])

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
            aria-label="命令面板与全局搜索"
            onKeyDown={onKeyDown}
          >
            <DialogTitle style={{ display: 'none' }}>命令面板与全局搜索</DialogTitle>
            <div className="modal-header" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
                <HelmIcon name="search" size={15} />
                <input
                  ref={inputRef}
                  className="input"
                  style={{ border: 'none', background: 'transparent' }}
                  aria-label="搜索消息全文、跳转会话或执行命令"
                  placeholder="搜索消息全文、跳转会话或执行命令..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {searching && (
                <span className="badge badge-neutral" style={{ height: 22, padding: '0 6px', flexShrink: 0 }}>
                  <HelmIcon name="loader" size={12} className="spin-slow" />
                  搜索中
                </span>
              )}
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm palette-close-btn"
                  onClick={close}
                  title="关闭"
                  aria-label="关闭"
                >
                  <span className="palette-close-desktop badge badge-neutral">Esc 关闭</span>
                  <span className="palette-close-mobile" style={{ alignItems: 'center', gap: 4 }}>
                    <HelmIcon name="x" size={13} />
                    <span style={{ fontSize: 11.5 }}>关闭</span>
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
                  aria-label="关闭命令内容预览"
                >
                  收起
                </button>
              </div>
              <PluginUiView
                pluginId={previewCmd.pluginId}
                spec={previewCmd.spec}
                label={`命令 ${previewCmd.spec.id} 内容`}
              />
            </div>
          )}
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
                      {row.hit.title || `会话 #${row.hit.conversationId}`}
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
