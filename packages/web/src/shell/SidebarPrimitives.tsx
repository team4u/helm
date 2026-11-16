import { useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helm/protocol/browser'
import { asksApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
import { Tooltip } from '../ui/Tooltip.js'
import type { HelmStoreValue } from '../lib/types.js'
import {
  backgroundAwareStatusTooltip,
  resolveStatusLight,
  type ConversationBackgroundActivity,
  type StandingStatusIndicator,
} from './background-activity-model.js'

export function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`status-dot ${connected ? 'status-dot-done status-dot-connected' : 'status-dot-disconnected'}`}
      title={connected ? '实时连接正常' : '实时连接断开，正在重连'}
    />
  )
}

export function HoverIconButton({
  title,
  icon,
  onClick,
  className,
}: {
  title: string
  icon: string
  onClick: (e: React.MouseEvent) => void
  className?: string
}) {
  return (
    <Tooltip content={title} side="top">
      <button
        type="button"
        className={`btn btn-ghost btn-icon-xs${className ? ` ${className}` : ''}`}
        title={title}
        aria-label={title}
        onClick={onClick}
      >
        <HelmIcon name={icon} size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * 单灯位状态灯：dotClass 由 resolveStatusLight 纯函数裁决，每行只渲染一个灯，
 * 绝不依顺序叠第二盏（working/blocked/error 状态灯独占；idle/done 让位后台空心环；
 * 无在途保持五态原样）。tooltip 与灯位同源，后台摘要仅在空心环灯位时叠加。
 */
function StatusLightDot({
  status,
  doing,
  lastError,
  backgroundActive,
  backgroundSummary,
}: {
  status: ConversationSummary['status']
  doing?: string
  lastError?: string
  backgroundActive: boolean
  backgroundSummary?: string
}) {
  const light = resolveStatusLight(status, backgroundActive)
  if (light.dotClass === null) return null
  const tooltip = backgroundAwareStatusTooltip({
    status,
    doing,
    lastError,
    backgroundActive,
    backgroundSummary,
  })
  return (
    <Tooltip content={tooltip} side="top">
      <span className={light.dotClass} title={tooltip} aria-label={tooltip} role="status" />
    </Tooltip>
  )
}

/** 会话行唯一状态灯：主会话状态优先，idle/done 且后台在途时让位空心环。 */
export function ConversationStatusDot({
  conv,
  background,
}: {
  conv: ConversationSummary
  background?: ConversationBackgroundActivity
}) {
  return (
    <StatusLightDot
      status={conv.status}
      doing={conv.doing}
      lastError={conv.lastError}
      backgroundActive={background?.active === true}
      backgroundSummary={background?.summary}
    />
  )
}

/** 智能体站位行折叠态唯一状态灯：代表会话状态灯优先（working/blocked/error 独占，
 *  隐藏整个站位的后台环）；代表 idle/done 且名下任一会话后台在途时只显示空心环。 */
export function StandingStatusDot({ indicator }: { indicator: StandingStatusIndicator }) {
  const rep = indicator.representative
  return (
    <StatusLightDot
      status={rep.status}
      doing={rep.doing}
      lastError={rep.lastError}
      backgroundActive={indicator.backgroundActive}
      backgroundSummary={indicator.backgroundSummary}
    />
  )
}

/** 远端会话紧凑只读标识：一眼区分非本机会话。 */
export function RemoteNodeTag({ nodeId }: { nodeId: string }) {
  return (
    <span
      className="mono"
      style={{ fontSize: 10.5, color: 'var(--fg-muted)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={`运行节点：${nodeId}`}
    >
      @{nodeId}
    </span>
  )
}

/** 全局待审批琥珀色胶囊与快速审批浮层。 */
export function PendingAsksPanel({ store }: { store: HelmStoreValue }) {
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
    <div className="sidebar-group pending-asks-group">
      <button
        className={`badge badge-warn pending-asks-toggle${expanded ? ' badge-err' : ''}`}
        title="展开待审批列表"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="pending-asks-toggle-label">
          <HelmIcon name="alert-triangle" size={12} />
          待确认 ({asks.length})
        </span>
        <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {expanded && (
        <div className="list pending-asks-list">
          {asks.map((ask) => (
            <div key={ask.id} className="row pending-asks-row">
              <div className="pending-asks-row-head">
                <span className="pending-asks-title">
                  {ask.title}
                </span>
                <span className="badge badge-neutral tabular-nums">#{ask.conversationId}</span>
              </div>
              {ask.description && (
                <div className="pending-asks-desc">
                  {ask.description}
                </div>
              )}
              <div className="pending-asks-actions">
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
