import { useEffect, useMemo, useRef, useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helm/protocol'
import { asksApi, conversationsApi, ApiClientError } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { isSameResolvedTarget, resolveTargetString, type HelmStoreValue } from '../lib/types.js'
import {
  ARCHIVED_WORKER_TAG,
  ROOT_CONVERSATION,
  buildSidebarGroups,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  filterConversationsByTag,
} from './sidebar-model.js'

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? '实时连接正常' : '实时连接断开，正在重连'}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        flexShrink: 0,
        background: connected ? 'var(--ok)' : 'var(--fg-subtle)',
        boxShadow: connected ? '0 0 0 2px var(--ok-bg)' : 'none',
      }}
    />
  )
}

function HoverIconButton({
  title,
  icon,
  onClick,
}: {
  title: string
  icon: string
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      className="btn btn-ghost btn-sm"
      title={title}
      style={{ height: 22, width: 22, padding: 0, flexShrink: 0 }}
      onClick={onClick}
    >
      <HelmIcon name={icon} size={13} />
    </button>
  )
}

function StatusBadge({ conv }: { conv: ConversationSummary }) {
  return (
    <span className={conversationStatusBadgeClass(conv.status)} title={conv.doing ?? ''}>
      {conv.status === 'working' && conv.doing ? conv.doing : conversationStatusLabel(conv.status)}
    </span>
  )
}

/** 单个会话行（点击主屏打开；悬停出现右屏分屏按钮）。 */
function ConversationRow({
  conv,
  active,
  onOpen,
  onOpenSplit,
  children,
}: {
  conv: ConversationSummary
  active: boolean
  onOpen: () => void
  onOpenSplit?: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      className={`nav-item${active ? ' nav-item-active' : ''}`}
      style={{ minHeight: 30, opacity: 1 }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <span className="nav-item-main">
        {children}
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </span>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        <StatusBadge conv={conv} />
        {onOpenSplit && (
          <span style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
            <HoverIconButton
              title="在右屏分屏打开"
              icon="columns"
              onClick={(e) => {
                e.stopPropagation()
                onOpenSplit()
              }}
            />
          </span>
        )}
      </span>
    </div>
  )
}

/** 新建对话按钮 + Profile 下拉（默认或指定角色直聊）。 */
function NewConversationControl({ store }: { store: HelmStoreValue }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const createWith = async (profileId: string | null) => {
    setOpen(false)
    try {
      const conv = await conversationsApi.create(
        profileId ? { profileId } : undefined,
      )
      store.openTarget({ kind: 'conversation', conversationId: conv.id })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '新建会话失败',
        body: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 0 }}>
        <button
          className="btn btn-sm"
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          title="新建对话（默认 Profile）"
          onClick={() => void createWith(null)}
        >
          <HelmIcon name="plus" size={13} />
        </button>
        <button
          className="btn btn-sm"
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: '0 5px' }}
          title="按角色 Profile 新建对话"
          onClick={() => setOpen((v) => !v)}
        >
          <HelmIcon name="chevron-down" size={12} />
        </button>
      </div>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 60,
            minWidth: 220,
            maxWidth: 300,
          }}
          className="list"
        >
          <div className="row" style={{ padding: '4px 10px', fontSize: 11, color: 'var(--fg-muted)' }}>
            选择角色 Profile 新建对话
          </div>
          {store.profiles.length === 0 && <div className="row">暂无可用 Profile</div>}
          {store.profiles.map((p) => (
            <button
              key={p.id}
              className="row"
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onClick={() => void createWith(p.id)}
            >
              <span className="nav-item-main">
                {p.runtime?.kind === 'herdr' && <HelmIcon name="terminal" size={12} />}
                <span className="nav-item-label">{p.name || p.id}</span>
              </span>
              <span className="nav-item-meta mono">{p.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 全局待审批琥珀色胶囊与快速审批浮层。 */
function PendingAsksPanel({ store }: { store: HelmStoreValue }) {
  const [expanded, setExpanded] = useState(false)
  const [busyAskId, setBusyAskId] = useState<string | null>(null)
  const asks = store.pendingAsks

  if (asks.length === 0) return null

  const isSimpleConfirm = (ask: AskSpec) =>
    ask.fields.length === 1 && ask.fields[0]?.type === 'confirm'

  const answerConfirm = async (ask: AskSpec, value: boolean) => {
    const field = ask.fields[0]
    if (!field) return
    setBusyAskId(ask.id)
    try {
      await asksApi.answer(ask.id, { [field.name]: value ? 'true' : 'false' }, ask.expectedStateSeq)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '审批已提交',
        body: `${ask.title} #${ask.conversationId}`,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '审批提交失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyAskId(null)
    }
  }

  return (
    <div className="sidebar-group" style={{ gap: 4 }}>
      <button
        className={`badge badge-warn${expanded ? ' badge-err' : ''}`}
        style={{ width: '100%', justifyContent: 'space-between', height: 26, cursor: 'pointer' }}
        title="展开待审批列表"
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <HelmIcon name="alert-triangle" size={12} />
          待确认 ({asks.length})
        </span>
        <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {expanded && (
        <div className="list" style={{ boxShadow: 'var(--shadow-md)' }}>
          {asks.map((ask) => (
            <div key={ask.id} className="row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ask.title}
                </span>
                <span className="badge badge-neutral tabular-nums">#{ask.conversationId}</span>
              </div>
              {ask.description && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                  {ask.description}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setExpanded(false)
                    store.openTarget({ kind: 'conversation', conversationId: ask.conversationId })
                  }}
                >
                  主屏处理
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setExpanded(false)
                    store.openTarget(
                      { kind: 'conversation', conversationId: ask.conversationId },
                      { split: true },
                    )
                  }}
                >
                  右屏并排
                </button>
                {isSimpleConfirm(ask) && (
                  <>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, true)}
                    >
                      <HelmIcon name="check" size={12} />
                      批准
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, false)}
                    >
                      <HelmIcon name="x" size={12} />
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 常驻工作台导航区（sidebar.item），含 #1 兜底。 */
function WorkbenchNavItems({ store }: { store: HelmStoreValue }) {
  const hasRootItem = store.groupedUi.sidebarItems.some((item) => {
    const resolved = resolveTargetString(item.spec.target ?? '', store.conversations)
    return resolved?.kind === 'conversation' && resolved.conversationId === ROOT_CONVERSATION
  })

  const rows: Array<{
    key: string
    label: string
    icon?: string
    target: ReturnType<typeof resolveTargetString>
  }> = []

  if (!hasRootItem) {
    rows.push({
      key: 'fallback-root',
      label: '个人助理',
      icon: 'sparkles',
      target: { kind: 'conversation', conversationId: ROOT_CONVERSATION },
    })
  }
  for (const item of store.groupedUi.sidebarItems) {
    const resolved = resolveTargetString(item.spec.target ?? '', store.conversations)
    if (!resolved) continue
    if (!hasRootItem && resolved.kind === 'conversation' && resolved.conversationId === ROOT_CONVERSATION) continue
    rows.push({ key: `${item.pluginId}/${item.spec.id}`, label: item.spec.label, icon: item.spec.icon, target: resolved })
  }

  return (
    <>
      {rows.map((row) => {
        const active = isSameResolvedTarget(row.target, store.primaryTarget)
        return (
          <div
            key={row.key}
            className={`nav-item${active ? ' nav-item-active' : ''}`}
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => row.target && store.openTarget(row.target)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && row.target) store.openTarget(row.target)
            }}
          >
            <span className="nav-item-main">
              <HelmIcon name={row.icon} size={14} />
              <span className="nav-item-label">{row.label}</span>
            </span>
            <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
              <HoverIconButton
                title="在右屏分屏打开"
                icon="columns"
                onClick={(e) => {
                  e.stopPropagation()
                  if (row.target) store.openTarget(row.target, { split: true })
                }}
              />
            </span>
          </div>
        )
      })}
    </>
  )
}

/** 插件动态会话分组区（sidebar.section）。 */
function SidebarSectionGroups({ store }: { store: HelmStoreValue }) {
  const sections = store.groupedUi.sidebarSections.filter((s) => s.spec.filterTag)
  if (sections.length === 0) return null
  return (
    <>
      {sections.map((section) => {
        const tag = section.spec.filterTag as string
        const convs = filterConversationsByTag(store.conversations, tag).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )
        return (
          <div key={`${section.pluginId}/${section.spec.id}`} className="sidebar-group">
            <div className="sidebar-group-header">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <HelmIcon name={section.spec.icon} size={12} />
                {section.spec.label}
              </span>
              <span className="tabular-nums">{convs.length}</span>
            </div>
            {convs.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                active={
                  store.primaryTarget.kind === 'conversation' &&
                  store.primaryTarget.conversationId === conv.id
                }
                onOpen={() => store.openTarget({ kind: 'conversation', conversationId: conv.id })}
                onOpenSplit={() =>
                  store.openTarget({ kind: 'conversation', conversationId: conv.id }, { split: true })
                }
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

/** 「我的对话」列表：批量多选管理 + 单行重命名/删除。 */
function MyConversationsGroup({ store }: { store: HelmStoreValue }) {
  const { humanConversations } = useMemo(
    () =>
      buildSidebarGroups(store.conversations, store.groupedUi.sidebarItems, store.groupedUi.sidebarSections),
    [store.conversations, store.groupedUi.sidebarItems, store.groupedUi.sidebarSections],
  )
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [renaming, setRenaming] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const deleteOne = async (id: number) => {
    setDeleting(true)
    try {
      await conversationsApi.remove(id)
      store.pushNotice({ type: 'notification', level: 'info', title: '会话已删除', body: `#${id}` })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '删除会话失败',
        body: err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  const deleteSelected = async () => {
    setDeleting(true)
    let failed = 0
    for (const id of selected) {
      try {
        await conversationsApi.remove(id)
      } catch {
        failed += 1
      }
    }
    setDeleting(false)
    setSelected(new Set())
    store.pushNotice({
      type: 'notification',
      level: failed > 0 ? 'warning' : 'info',
      title: '批量删除完成',
      body: failed > 0 ? `${selected.size - failed} 成功，${failed} 失败` : `已删除 ${selected.size} 个会话`,
    })
  }

  const commitRename = async (id: number) => {
    const title = renameText.trim()
    setRenaming(null)
    if (!title) return
    try {
      await conversationsApi.patch(id, { title })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '重命名失败',
        body: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-header">
        <span>我的对话</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {selectMode && humanConversations.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ height: 18, padding: '0 6px', fontSize: 10.5 }}
              onClick={() =>
                setSelected((prev) =>
                  prev.size === humanConversations.length
                    ? new Set()
                    : new Set(humanConversations.map((c) => c.id)),
                )
              }
            >
              {selected.size === humanConversations.length ? '取消全选' : '全选'}
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            style={{ height: 18, padding: '0 6px', fontSize: 10.5 }}
            onClick={() => {
              setSelectMode((v) => !v)
              setSelected(new Set())
            }}
          >
            {selectMode ? '退出批量' : '批量选择'}
          </button>
        </span>
      </div>
      {humanConversations.length === 0 && (
        <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--fg-subtle)' }}>暂无自由对话</div>
      )}
      {humanConversations.map((conv) => {
        const active =
          store.primaryTarget.kind === 'conversation' && store.primaryTarget.conversationId === conv.id
        if (renaming === conv.id) {
          return (
            <div key={conv.id} style={{ display: 'flex', gap: 4, padding: '2px 0' }}>
              <input
                className="input"
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(conv.id)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                style={{ height: 26, fontSize: 12 }}
              />
              <button className="btn btn-sm" onClick={() => void commitRename(conv.id)}>
                <HelmIcon name="check" size={12} />
              </button>
              <button className="btn btn-sm" onClick={() => setRenaming(null)}>
                <HelmIcon name="x" size={12} />
              </button>
            </div>
          )
        }
        return (
          <ConversationRow
            key={conv.id}
            conv={conv}
            active={active}
            onOpen={() => store.openTarget({ kind: 'conversation', conversationId: conv.id })}
            onOpenSplit={() =>
              store.openTarget({ kind: 'conversation', conversationId: conv.id }, { split: true })
            }
          >
            {selectMode ? (
              <input
                type="checkbox"
                checked={selected.has(conv.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleSelect(conv.id)}
                style={{ flexShrink: 0 }}
              />
            ) : undefined}
          </ConversationRow>
        )
      })}
      {selectMode && selected.size > 0 && (
        <button
          className="btn btn-sm btn-danger"
          style={{ marginTop: 4 }}
          disabled={deleting}
          onClick={() => void deleteSelected()}
        >
          <HelmIcon name="trash-2" size={12} />
          删除选中 ({selected.size})
        </button>
      )}
    </div>
  )
}

/** 可折叠「已归档 Worker」分组。 */
function ArchivedWorkersGroup({ store }: { store: HelmStoreValue }) {
  const [open, setOpen] = useState(false)
  const archived = useMemo(
    () => filterConversationsByTag(store.conversations, ARCHIVED_WORKER_TAG),
    [store.conversations],
  )
  if (archived.length === 0) return null
  return (
    <div className="sidebar-group">
      <button
        className="sidebar-group-header"
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer' }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <HelmIcon name="archive" size={12} />
          已归档 Worker ({archived.length})
        </span>
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open &&
        archived
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              active={
                store.primaryTarget.kind === 'conversation' &&
                store.primaryTarget.conversationId === conv.id
              }
              onOpen={() => store.openTarget({ kind: 'conversation', conversationId: conv.id })}
              onOpenSplit={() =>
                store.openTarget({ kind: 'conversation', conversationId: conv.id }, { split: true })
              }
            />
          ))}
    </div>
  )
}

export function Sidebar() {
  const store = useHelmStore()

  return (
    <aside className="helm-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <HelmIcon name="layers" size={16} />
          Helm
          <StatusDot connected={store.sseConnected} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            className="btn btn-sm"
            title="打开 Cmd K 全局搜索与命令面板"
            onClick={() => store.setActiveModal({ kind: 'command-palette' })}
          >
            <HelmIcon name="search" size={13} />
          </button>
          <NewConversationControl store={store} />
        </div>
      </div>

      <div className="sidebar-scroll">
        <PendingAsksPanel store={store} />

        <div className="sidebar-group">
          <div className="sidebar-group-header">工作台</div>
          <WorkbenchNavItems store={store} />
        </div>

        <SidebarSectionGroups store={store} />

        <MyConversationsGroup store={store} />

        <ArchivedWorkersGroup store={store} />
      </div>

      <div className="sidebar-footer">
        <div style={{ display: 'flex', gap: 2 }}>
          <button
            className="btn btn-ghost btn-sm"
            title="角色 Profiles"
            onClick={() => store.setActiveModal({ kind: 'profile-editor' })}
          >
            <HelmIcon name="bot" size={14} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="模型与凭据"
            onClick={() => store.setActiveModal({ kind: 'provider-auth' })}
          >
            <HelmIcon name="key" size={14} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="技能库 Skills"
            onClick={() => store.setActiveModal({ kind: 'skill-viewer' })}
          >
            <HelmIcon name="sparkles" size={14} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="插件与设置"
            onClick={() => store.setActiveModal({ kind: 'plugin-settings' })}
          >
            <HelmIcon name="settings" size={14} />
          </button>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          title={store.theme === 'light' ? '切换到暗色主题' : '切换到亮色主题'}
          onClick={store.toggleTheme}
        >
          <HelmIcon name={store.theme === 'light' ? 'moon' : 'sun'} size={14} />
        </button>
      </div>
    </aside>
  )
}
