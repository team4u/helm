import { useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationAttachmentRef } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { matchesUiScope } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
import { Composer } from './Composer.js'
import { formatEnvSubtitle, sendingPendingVisible } from './composer-model.js'
import { ConversationTimeline } from './ConversationTimeline.js'
import { summarizeWorkbenchTasks } from './workflow-card-model.js'
import type { EditRequestTarget } from './timeline-model.js'

export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
  isDrawer?: boolean
  onCloseDrawer?: () => void
}

/** 分屏窗格右上角关闭入口：加载中/加载失败早退分支同样可见，手机不被困住。 */
function CloseSplitButton({ onCloseSplit }: { onCloseSplit: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost split-close-btn"
      aria-label="关闭分屏"
      title="关闭本分屏"
      onClick={onCloseSplit}
    >
      <HelmIcon name="x" size={12} />
      <span className="pane-action-label">关闭分屏</span>
    </button>
  )
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
  const [prefill, setPrefill] = useState<{ text: string; entryId?: number; attachments?: ConversationAttachmentRef[]; tick: number } | null>(null)
  const [sendingInFlight, setSendingInFlight] = useState(false)
  const moreMenuRef = useRef<HTMLSpanElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)

  const loadDetail = store.loadConversationDetail
  useEffect(() => {
    if (detail === undefined) {
      void loadDetail(conversationId, true)
    }
  }, [conversationId, detail, loadDetail])

  // 更多操作菜单：点击外部或 Escape 关闭；Escape 关闭后焦点回触发按钮
  useEffect(() => {
    if (!moreOpen) return
    const onDocClick = (e: PointerEvent): void => {
      if (moreMenuRef.current !== null && !moreMenuRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  // 切换会话时关闭更多菜单（组件复用时也保持确定语义）
  useEffect(() => {
    setMoreOpen(false)
  }, [conversationId])

  const taskSummary = useMemo(
    () => summarizeWorkbenchTasks(store.conversations, conversationId, store.workflowRuns),
    [store.conversations, conversationId, store.workflowRuns],
  )
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
  const artifacts = store.conversationArtifacts[conversationId] ?? []
  // 去重后的工作台计数：工作流子会话不再被 runs 与 children 双重计入。
  const workbenchCount = taskSummary.totalCount + artifacts.length
  const workbenchBadge = taskSummary.blockedCount > 0 ? 'badge-warn' : taskSummary.activeCount > 0 ? 'badge-accent' : 'badge-neutral'
  const hasWorkbenchPanel = store.groupedUi.workbenchPanels.some((panel) => matchesUiScope(conversation, panel.spec.scope))
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
  const enabledPluginIds = new Set(store.plugins.filter((p) => p.enabled).map((p) => p.id))
  const canCreateThread = profile !== undefined &&
    isHumanSelectableProfile(profile, enabledPluginIds) &&
    (conversation.ownedBy ?? 'human') === 'human'

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
            <span
              className="pane-title"
              title="点击重命名"
              onClick={() => {
                setTitleDraft(conversation.title)
                setRenaming(true)
              }}
            >
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
              onClick={() =>
                void runAction(
                  'new-thread',
                  async () => {
                    // 继承当前会话环境（profile + 节点 + 目录）：在远端会话内新话题不必重配环境
                    const created = await conversationsApi.create({
                      profileId: conversation.profileId,
                      nodeId: currentNodeId,
                      cwd: conversation.cwd,
                    })
                    store.openTarget({ kind: 'conversation', conversationId: created.id })
                  },
                  '已新建对话',
                )
              }
            >
              <HelmIcon name={actionPending === 'new-thread' ? 'loader' : 'plus'} size={12} />
              <span className="pane-action-label">新话题</span>
            </button>
          ) : null}
          {!isDrawer && (workbenchCount > 0 || hasWorkbenchPanel) ? (
            <button
              type="button"
              className={`btn btn-sm${store.workbenchOpen ? ' btn-primary' : ''}`}
              title="展开右侧工作台（工作流与产物）"
              onClick={() => {
                store.setWorkbenchOpen(!store.workbenchOpen)
                store.setWorkbenchTab('tasks')
              }}
            >
              <HelmIcon name="panel-right" size={12} />
              工作台
              {workbenchCount > 0 && <span className={`badge ${workbenchBadge} tabular-nums`}>{workbenchCount}</span>}
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
            </>
          ) : isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <button
              type="button"
              className={`btn btn-sm split-toggle-btn${store.splitTarget !== null ? ' btn-primary split-active' : ''}`}
              aria-label={store.splitTarget !== null ? '关闭分屏' : '并排分屏'}
              title="在右屏并排打开 / 关闭分屏"
              onClick={toggleSplit}
            >
              <HelmIcon name="columns" size={12} />
            </button>
          )}
          <span className="pane-more-menu" ref={moreMenuRef}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="更多会话操作"
              title="更多会话操作"
              aria-expanded={moreOpen}
              ref={moreButtonRef}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <HelmIcon name="more" size={14} />
            </button>
            {moreOpen ? (
              <div className="pane-more-popover">
                <button
                  type="button"
                  className="popover-item"
                  onClick={() => {
                    setMoreOpen(false)
                    setTitleDraft(conversation.title)
                    setRenaming(true)
                  }}
                >
                  <span className="pane-more-item-label">
                    <HelmIcon name="edit" size={13} />
                    重命名会话
                  </span>
                </button>
                <button
                  type="button"
                  className="popover-item"
                  disabled={actionPending !== null}
                  onClick={() => {
                    setMoreOpen(false)
                    void runAction('compact', () => conversationsApi.compact(conversationId), '精简任务已提交')
                  }}
                >
                  <span className="pane-more-item-label">
                    <HelmIcon name={actionPending === 'compact' ? 'loader' : 'archive'} size={13} />
                    精简上下文 (/compact)
                  </span>
                </button>
                <div className="popover-separator" role="separator" />
                <button
                  type="button"
                  className="popover-item popover-item-danger"
                  disabled={actionPending !== null}
                  onClick={() => {
                    setMoreOpen(false)
                    // 危险操作先确认：reset 切换上下文但不删历史，文案如实说明后果
                    if (!window.confirm(`重置会话 #${conversationId} 的上下文？历史消息保留，模型将从全新上下文开始。`)) return
                    void runAction('reset', () => conversationsApi.reset(conversationId), '上下文已重置')
                  }}
                >
                  <span className="pane-more-item-label">
                    <HelmIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={13} />
                    重置上下文 (/reset)
                  </span>
                </button>
              </div>
            ) : null}
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
        onRequestEdit={requestEdit}
      />

      <Composer key={`composer-${conversation.id}`} conversation={conversation} prefill={prefill} onSendingChange={setSendingInFlight} />
    </div>
  )
}
