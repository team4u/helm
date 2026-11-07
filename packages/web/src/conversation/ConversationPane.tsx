import { useEffect, useMemo, useState } from 'react'
import type { ConversationStatus } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { matchesUiScope } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
import { Composer } from './Composer.js'
import { ConversationTimeline } from './ConversationTimeline.js'

export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
}

const STATUS_META: Record<ConversationStatus, { label: string; badge: string; icon: string }> = {
  working: { label: '执行中', badge: 'badge-accent', icon: 'loader' },
  blocked: { label: '等待审批', badge: 'badge-warn', icon: 'shield-alert' },
  done: { label: '已完成', badge: 'badge-ok', icon: 'check-circle' },
  idle: { label: '空闲', badge: 'badge-neutral', icon: 'circle' },
  error: { label: '出错', badge: 'badge-err', icon: 'alert-circle' },
}

function tailPath(cwd: string, segments = 2): string {
  if (cwd === '') return ''
  const parts = cwd.split('/').filter((p) => p !== '')
  return parts.slice(-segments).join('/')
}

/** 会话顶栏 + 时间线 + AskDock(Composer 内) + Composer 微操舱。 */
export function ConversationPane({ conversationId, isSplit, onCloseSplit }: ConversationPaneProps) {
  const store = useHelmStore()
  const detail = store.conversationDetails[conversationId]
  const summary = useMemo(() => store.conversations.find((c) => c.id === conversationId), [store.conversations, conversationId])
  const conversation = summary ?? detail
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [cwdEditing, setCwdEditing] = useState(false)
  const [cwdDraft, setCwdDraft] = useState('')
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; tick: number } | null>(null)

  const loadDetail = store.loadConversationDetail
  useEffect(() => {
    if (detail === undefined) {
      void loadDetail(conversationId, true)
    }
  }, [conversationId, detail, loadDetail])

  const detailError = store.loadErrors[`conversation:${conversationId}`]
  if (detailError) {
    return (
      <div className="helm-pane pane-error" role="alert">
        <p>会话 #{conversationId} 加载失败：{detailError}</p>
        <button className="btn" onClick={() => void store.loadConversationDetail(conversationId, true)}>重试</button>
      </div>
    )
  }

  if (conversation === undefined) {
    return (
      <div className={isSplit ? 'helm-split-pane' : 'helm-pane'} style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
        正在加载会话 #{conversationId}…
      </div>
    )
  }

  const statusMeta = STATUS_META[conversation.status] ?? STATUS_META.idle!
  const artifacts = store.conversationArtifacts[conversationId] ?? []
  const runs = store.workflowRuns.filter((r) => r.conversationId === conversationId)
  const children = store.conversations.filter((item) => item.parentConversationId === conversationId)
  const workbenchCount = runs.length + artifacts.length + children.length
  const hasWorkbenchPanel = store.groupedUi.workbenchPanels.some((panel) => matchesUiScope(conversation, panel.spec.scope))

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

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim()
    setRenaming(false)
    if (next === '' || next === conversation.title) return
    await runAction('rename', () => conversationsApi.patch(conversationId, { title: next }), '已重命名会话')
  }

  const saveCwd = async (): Promise<void> => {
    const next = cwdDraft.trim()
    setCwdEditing(false)
    if (next === '' || next === conversation.cwd) return
    await runAction('cwd', () => conversationsApi.patch(conversationId, { cwd: next }), '已更新工作目录')
  }

  const requestEdit = (text: string): void => {
    setPrefill({ text, tick: Date.now() })
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
          <span className="badge badge-neutral" title={`Profile: ${conversation.profileId}`}>
            {conversation.profileId}
          </span>
          <span className={`badge ${statusMeta.badge}`}>
            <HelmIcon
              name={statusMeta.icon}
              size={11}
              className={conversation.status === 'working' ? 'spin-slow' : undefined}
            />
            {statusMeta.label}
          </span>
          {cwdEditing ? (
            <input
              className="input mono"
              style={{ maxWidth: 280, height: 24, fontSize: 11 }}
              value={cwdDraft}
              autoFocus
              placeholder="/绝对路径"
              onChange={(e) => setCwdDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveCwd()
                else if (e.key === 'Escape') setCwdEditing(false)
              }}
              onBlur={() => void saveCwd()}
            />
          ) : (
            <span
              className="pane-cwd-subtitle"
              title={`工作目录：${conversation.cwd}（点击修改）`}
              onClick={() => {
                setCwdDraft(conversation.cwd)
                setCwdEditing(true)
              }}
            >
              {tailPath(conversation.cwd)}
            </span>
          )}
        </div>
        <div className="pane-actions">
          {workbenchCount > 0 || hasWorkbenchPanel ? (
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
              {workbenchCount > 0 && <span className="badge badge-neutral tabular-nums">{workbenchCount}</span>}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            title="精简上下文 (/compact)"
            disabled={actionPending !== null}
            onClick={() =>
              void runAction(
                'compact',
                () => conversationsApi.compact(conversationId),
                '精简任务已提交',
              )
            }
          >
            <HelmIcon name={actionPending === 'compact' ? 'loader' : 'archive'} size={12} />
            <span className="pane-action-label">精简上下文</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title="重置上下文 (/reset)"
            disabled={actionPending !== null}
            onClick={() =>
              void runAction(
                'reset',
                () => conversationsApi.reset(conversationId),
                '上下文已重置',
              )
            }
          >
            <HelmIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={12} />
            <span className="pane-action-label">重置上下文</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm${isSplit || store.splitTarget !== null ? ' btn-primary' : ''}`}
            title={isSplit ? '关闭本分屏' : '在右屏并排打开 / 关闭分屏'}
            onClick={toggleSplit}
          >
            <HelmIcon name="columns" size={12} />
          </button>
        </div>
      </header>

      <ConversationTimeline
        conversation={conversation}
        detailEntries={detail?.entries ?? []}
        {...(store.conversationLives[conversationId] !== undefined
          ? { live: store.conversationLives[conversationId] }
          : {})}
        onRequestEdit={requestEdit}
      />

      <Composer conversation={conversation} prefill={prefill} />
    </div>
  )
}
