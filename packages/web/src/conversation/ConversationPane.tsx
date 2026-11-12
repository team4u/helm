import { useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationAttachmentRef } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { isConversationDeletable, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { useHelmStore } from '../lib/store-context.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/DropdownMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { Composer } from './Composer.js'
import { formatEnvSubtitle, sendingPendingVisible } from './composer-model.js'
import { ConversationTimeline } from './ConversationTimeline.js'
import { resolveActiveWorkbenchTab, summarizeWorkbenchBadge } from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'
import { matchConversationActions, splitConversationHeaderActions } from './action-model.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import type { EditRequestTarget } from './timeline-model.js'

export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
  isDrawer?: boolean
  onCloseDrawer?: () => void
}

/** 会话顶栏 + 时间线 + AskDock(Composer 内) + Composer 微操舱。 */
export function ConversationPane({ conversationId, isSplit, onCloseSplit, isDrawer, onCloseDrawer }: ConversationPaneProps) {
  const store = useHelmStore()
  const detail = store.conversationDetails[conversationId]
  const summary = useMemo(() => store.conversations.find((c) => c.id === conversationId), [store.conversations, conversationId])
  const conversation = summary ?? detail
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [prefill, setPrefill] = useState<{ text: string; entryId?: number; attachments?: ConversationAttachmentRef[]; tick: number; onlyIfEmpty?: boolean } | null>(null)
  const [sendingInFlight, setSendingInFlight] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset' | 'delete' | null>(null)
  const moreMenuRef = useRef<HTMLSpanElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)

  const loadDetail = store.loadConversationDetail
  useEffect(() => {
    if (detail === undefined) {
      void loadDetail(conversationId, true)
    }
  }, [conversationId, detail, loadDetail])

  // 切换会话时关闭更多菜单（组件复用时也保持确定语义）
  useEffect(() => {
    setMoreOpen(false)
  }, [conversationId])

  // 工作台汇总角标：内置产物计数 + 各插件面板 badge（从 public doc 动态提取）。
  const workbenchTabs = useWorkbenchTabs(conversationId, conversation)
  const workbenchBadge = summarizeWorkbenchBadge(workbenchTabs)
  const hasWorkbenchPanel = workbenchTabs.some((tab) => tab.id !== 'artifacts')
  const detailError = store.loadErrors[`conversation:${conversationId}`]
  if (detailError) {
    return (
      <div className={`${isSplit ? 'helm-split-pane' : 'helm-pane'} pane-error`} role="alert">
        <div className="pane-error-row">
          <p>会话 #{conversationId} 加载失败：{detailError}</p>
          <span className="pane-error-actions">
            <button className="btn" onClick={() => void store.loadConversationDetail(conversationId, true)}>重试</button>
            {isDrawer && onCloseDrawer !== undefined ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseDrawer}>关闭</button>
            ) : isSplit && onCloseSplit !== undefined ? <CloseSplitButton onCloseSplit={onCloseSplit} /> : null}
          </span>
        </div>
      </div>
    )
  }

  if (conversation === undefined) {
    return (
      <div className={isSplit ? 'helm-split-pane' : 'helm-pane'} style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
        正在加载会话 #{conversationId}…
        {isDrawer && onCloseDrawer !== undefined ? (
          <span className="pane-loading-split-close">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseDrawer}>关闭</button>
          </span>
        ) : isSplit && onCloseSplit !== undefined ? (
          <span className="pane-loading-split-close">
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          </span>
        ) : null}
      </div>
    )
  }

  const sendingPending = sendingPendingVisible(sendingInFlight, conversation.status)
  // 计数与色调由插件 public-doc badge 与内置产物共同决定。
  const workbenchCount = workbenchBadge.totalCount
  const workbenchBadgeClass = workbenchBadge.tone === 'warn' ? 'badge-warn' : workbenchBadge.tone === 'accent' ? 'badge-accent' : 'badge-neutral'
  const currentNodeId = conversation.nodeId || 'local'
  const envSubtitle = formatEnvSubtitle({
    profileId: conversation.profileId,
    nodeId: currentNodeId,
    cwd: conversation.cwd,
  })
  const envSubtitleCompact = formatEnvSubtitle({
    profileId: conversation.profileId,
    nodeId: currentNodeId,
    cwd: conversation.cwd,
    compact: true,
  })
  const remoteNodeTag = envSubtitleCompact.text !== '' ? envSubtitleCompact.text : null

  const runAction = async (name: string, fn: () => Promise<unknown>, successTitle: string): Promise<void> => {
    setActionPending(name)
    try {
      await fn()
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: successTitle,
        conversationId,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: `${successTitle}失败`,
        body: err instanceof Error ? err.message : String(err),
        conversationId,
      })
    } finally {
      setActionPending(null)
    }
  }

  const profile = store.profiles.find((p) => p.id === conversation.profileId)
  const profileStarters = profile !== undefined && profile.starters !== undefined && profile.starters.length > 0 ? profile.starters : undefined
  const enabledPluginIds = new Set(store.plugins.filter((p) => p.enabled).map((p) => p.id))
  const canCreateThread = profile !== undefined &&
    isHumanSelectableProfile(profile, enabledPluginIds) &&
    (conversation.ownedBy ?? 'human') === 'human'

  // 插件微插槽 conversation.header.action：placement='toolbar' 直出顶栏按钮组，
  // 其余（缺省 'menu'）收纳进「更多操作」下拉菜单；均按 scope 过滤当前会话。
  const headerActions = matchConversationActions(store.groupedUi.uiActions, 'conversation:header', conversation)
  const { toolbar: toolbarActions, menu: menuActions } = splitConversationHeaderActions(headerActions)

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim()
    setRenaming(false)
    if (next === '' || next === conversation.title) return
    await runAction('rename', () => conversationsApi.patch(conversationId, { title: next }), '已重命名会话')
  }

  const requestEdit = (target: EditRequestTarget): void => {
    // prefill 绑定会话 id：即使未来 Pane 复用不重挂载，旧会话的编辑目标也不会注入新会话 Composer
    setPrefill(target.text.trim() === '' && target.entryId === undefined ? null : { ...target, tick: Date.now() })
  }

  // 空白会话引导词：仅回填草稿（onlyIfEmpty 交 Composer 原子保护，非空草稿不覆盖）
  const requestStarter = (text: string): void => {
    setPrefill({ text, tick: Date.now(), onlyIfEmpty: true })
  }

  const toggleSplit = (): void => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (store.splitTarget !== null) {
      store.closeSplit()
      return
    }
    store.openTarget({ kind: 'conversation', conversationId }, { split: true })
  }

  // 新话题：继承当前会话环境（profile + 节点 + 目录），主顶栏与话题切换器共用同一语义
  const createNewThread = (): void => {
    void runAction(
      'new-thread',
      async () => {
        const created = await conversationsApi.create({
          profileId: conversation.profileId,
          nodeId: currentNodeId,
          cwd: conversation.cwd,
        })
        store.openTarget(
          { kind: 'conversation', conversationId: created.id },
          isSplit ? { split: true } : undefined,
        )
      },
      '已新建对话',
    )
  }

  return (
    <div className="helm-pane">
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          {conversation.parentConversationId !== undefined ? (
            <button
              type="button"
              className="btn btn-sm pane-parent-nav-btn"
              title={`返回父会话 #${conversation.parentConversationId}`}
              aria-label={`返回父会话 #${conversation.parentConversationId}`}
              onClick={() => {
                store.openTarget(
                  { kind: 'conversation', conversationId: conversation.parentConversationId! },
                  isSplit ? { split: true } : undefined,
                )
              }}
            >
              <HelmIcon name="arrow-left" size={12} />
              <span className="pane-parent-nav-label">#{conversation.parentConversationId}</span>
            </button>
          ) : null}
          {renaming ? (
            <input
              className="input"
              style={{ maxWidth: 320, height: 26 }}
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                else if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={() => void saveTitle()}
            />
          ) : (
            <span className="pane-title">
              {conversation.title === '' ? `会话 #${conversationId}` : conversation.title}
            </span>
          )}
          <span className="pane-cwd-subtitle" title={envSubtitle.tooltip}>
            <span className="env-subtitle-full">{envSubtitle.text}</span>
            {remoteNodeTag !== null ? <span className="env-subtitle-compact">{remoteNodeTag}</span> : null}
          </span>
        </div>
        <div className="pane-actions">
          {canCreateThread ? (
            <button
              type="button"
              className="btn btn-sm"
              title="在当前智能体下新建对话"
              disabled={actionPending !== null}
              onClick={createNewThread}
            >
              <HelmIcon name={actionPending === 'new-thread' ? 'loader' : 'plus'} size={12} />
              <span className="pane-action-label">新话题</span>
            </button>
          ) : null}
          {toolbarActions.map((action) => (
            <PluginMicroAction
              key={`header:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="toolbar"
              conversationId={conversation.id}
              slotProps={{ conversation }}
            />
          ))}
          {!isDrawer && (workbenchCount > 0 || hasWorkbenchPanel) ? (
            <button
              type="button"
              className={`btn btn-sm${store.workbenchOpen ? ' btn-primary' : ''}`}
              title="展开右侧工作台（插件面板与产物）"
              onClick={() => {
                // 打开首个可用页签；已打开时保持当前有效页签。
                const target = resolveActiveWorkbenchTab(
                  store.workbenchOpen ? store.workbenchTab : undefined,
                  workbenchTabs,
                )
                if (!store.workbenchOpen || target !== store.workbenchTab) store.setWorkbenchTab(target)
                store.setWorkbenchOpen(true)
              }}
            >
              <HelmIcon name="panel-right" size={12} />
              工作台
              {workbenchCount > 0 && <span className={`badge ${workbenchBadgeClass} tabular-nums`}>{workbenchCount}</span>}
            </button>
          ) : null}
          {isDrawer && onCloseDrawer !== undefined ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost conversation-drawer-primary-btn"
                title="在主屏中全屏打开此会话"
                onClick={() => {
                  onCloseDrawer()
                  store.openTarget({ kind: 'conversation', conversationId })
                }}
              >
                <HelmIcon name="external-link" size={12} />
                <span className="pane-action-label">全屏</span>
              </button>
              <Tooltip content="关闭子会话抽屉 (Esc)" side="bottom">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost conversation-drawer-close-btn"
                  aria-label="关闭抽屉"
                  title="关闭子会话抽屉 (Esc)"
                  onClick={onCloseDrawer}
                >
                  <HelmIcon name="x" size={13} />
                  <span className="pane-action-label">关闭</span>
                </button>
              </Tooltip>
            </>
          ) : isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={store.splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
          <span className="pane-more-menu" ref={moreMenuRef}>
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="更多会话操作"
                  title="更多会话操作"
                  aria-expanded={moreOpen}
                  ref={moreButtonRef}
                >
                  <HelmIcon name="more" size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  className="pane-more-popover"
                  align="end"
                  sideOffset={6}
                  onCloseAutoFocus={(e) => {
                    e.preventDefault()
                    moreButtonRef.current?.focus()
                  }}
                >
                  <DropdownMenuItem
                    className="popover-item"
                    onSelect={() => {
                      setTitleDraft(conversation.title)
                      setRenaming(true)
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmIcon name="edit" size={13} />
                      重命名会话
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="popover-item"
                    disabled={actionPending !== null}
                    onSelect={() => {
                      void runAction('compact', () => conversationsApi.compact(conversationId), '精简任务已提交')
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmIcon name={actionPending === 'compact' ? 'loader' : 'archive'} size={13} />
                      精简上下文 (/compact)
                    </span>
                  </DropdownMenuItem>
                  {menuActions.length > 0 && (
                    <>
                      <DropdownMenuSeparator className="popover-separator" />
                      {menuActions.map((action) => (
                        <PluginMicroAction
                          key={`header-menu:${action.pluginId}/${action.spec.id}`}
                          action={action}
                          variant="menu"
                          inDropdown
                          conversationId={conversation.id}
                          slotProps={{ conversation }}
                          onInvoked={() => setMoreOpen(false)}
                        />
                      ))}
                    </>
                  )}
                  <DropdownMenuSeparator className="popover-separator" />
                  <DropdownMenuItem
                    className="popover-item popover-item-danger"
                    danger
                    disabled={actionPending !== null}
                    onSelect={() => {
                      setConfirmAction('reset')
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={13} />
                      重置上下文 (/reset)
                    </span>
                  </DropdownMenuItem>
                  {isConversationDeletable(conversation) && (
                    <DropdownMenuItem
                      className="popover-item popover-item-danger"
                      danger
                      onSelect={() => {
                        setConfirmAction('delete')
                      }}
                    >
                      <span className="pane-more-item-label">
                        <HelmIcon name="trash-2" size={13} />
                        删除会话
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </span>
        </div>
      </header>

      <ConversationTimeline
        conversation={conversation}
        detailEntries={detail?.entries ?? []}
        sendingPending={sendingPending}
        {...(store.conversationLives[conversationId] !== undefined
          ? { live: store.conversationLives[conversationId] }
          : {})}
        starters={profileStarters}
        onRequestEdit={requestEdit}
        onRequestStarter={requestStarter}
      />

      <Composer key={`composer-${conversation.id}`} conversation={conversation} prefill={prefill} onSendingChange={setSendingInFlight} />

      <ConfirmDialog
        open={confirmAction === 'reset'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={`重置会话 #${conversationId} 的上下文？`}
        description="历史消息保留，模型将从全新上下文开始。"
        confirmText="重置上下文"
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void runAction('reset', () => conversationsApi.reset(conversationId), '上下文已重置')
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={confirmAction === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={`确定删除会话 #${conversationId} 吗？`}
        description="此操作无法撤销。"
        confirmText="删除会话"
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void (async () => {
            try {
              await conversationsApi.remove(conversationId)
              // 导航由 conversation.deleted 事件按当前目标做条件更新；这里不使用
              // await 前捕获的主屏/分屏快照，避免删除完成时打断用户的新导航。
              store.pushNotice({
                type: 'notification',
                level: 'info',
                title: '已删除会话',
                body: `会话 #${conversationId} 已删除`,
              })
            } catch (err) {
              store.pushNotice({
                type: 'notification',
                level: 'error',
                title: '删除会话失败',
                body: err instanceof Error ? err.message : String(err),
              })
            }
          })()
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
