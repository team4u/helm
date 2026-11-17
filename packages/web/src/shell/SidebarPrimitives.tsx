import { useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helm/protocol/browser'
import { asksApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { HelmStoreValue } from '../lib/types.js'
import type { SidebarTargetPresence } from './sidebar-model.js'
import {
  backgroundAwareStatusTooltip,
  resolveStatusLight,
  type ConversationBackgroundActivity,
  type StandingStatusIndicator,
} from './background-activity-model.js'

export function StatusDot({ connected }: { connected: boolean }) {
  const { t } = useWebLocale()
  return (
    <span
      className={`status-dot ${connected ? 'status-dot-done status-dot-connected' : 'status-dot-disconnected'}`}
      title={connected ? t('shell.status.liveHealthy') : t('shell.status.liveLost')}
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
 * Single-light-slot status light: dotClass is adjudicated by the pure
 * resolveStatusLight; each row renders exactly one light and never stacks a
 * second by order (working/blocked/error status lights are exclusive;
 * idle/done yield to the background hollow ring; with nothing in flight the
 * five states stay as-is). The tooltip shares the light's source; the
 * background summary is appended only on the hollow-ring slot.
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
  const { t } = useWebLocale()
  const light = resolveStatusLight(status, backgroundActive)
  if (light.dotClass === null) return null
  const tooltip = backgroundAwareStatusTooltip({
    status,
    doing,
    lastError,
    backgroundActive,
    backgroundSummary,
    t,
  })
  return (
    <Tooltip content={tooltip} side="top">
      <span className={light.dotClass} title={tooltip} aria-label={tooltip} role="status" />
    </Tooltip>
  )
}

/** The conversation row's single status light: main status first; idle/done with background work yields to the hollow ring. */
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

/** The agent standing row's single collapsed-state light: the representative
 *  conversation's status light first (working/blocked/error exclusive, hiding
 *  the whole standing's background ring); when the representative is idle/done
 *  and any conversation under it has background work, only the hollow ring shows. */
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

/** Compact read-only marker for remote conversations: non-local rows at a glance. */
export function RemoteNodeTag({ nodeId }: { nodeId: string }) {
  const { t } = useWebLocale()
  return (
    <span
      className="mono"
      style={{ fontSize: 10.5, color: 'var(--fg-muted)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={t('shell.node.title', { id: nodeId })}
    >
      @{nodeId}
    </span>
  )
}

const PANE_TAG_TITLE_KEYS: Record<NonNullable<SidebarTargetPresence['paneTag']>, 'shell.pane.main' | 'shell.pane.split' | 'shell.pane.both'> = {
  Main: 'shell.pane.main',
  Split: 'shell.pane.split',
  'Main·Split': 'shell.pane.both',
}

/** Resolve a pane tag's tooltip title through the given translator (pure helper). */
function paneTagTitle(t: WebMessageTranslator, paneTag: NonNullable<SidebarTargetPresence['paneTag']>): string {
  return t(PANE_TAG_TITLE_KEYS[paneTag])
}

/** Pane-affinity micro badge shown at sidebar row ends when the split view is open (Main / Split / Main·Split). */
export function SidebarPaneTag({ paneTag }: { paneTag: SidebarTargetPresence['paneTag'] }) {
  const { t } = useWebLocale()
  if (paneTag === null) return null
  return (
    <span className="nav-pane-tag" title={paneTagTitle(t, paneTag)}>
      {paneTag}
    </span>
  )
}

/** Global pending-approval amber pill with the quick-approval flyout. */
export function PendingAsksPanel({ store }: { store: HelmStoreValue }) {
  const { t } = useWebLocale()
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
        title: t('shell.asks.submitted'),
        body: `${ask.title} #${ask.conversationId}`,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('shell.asks.submitFailed'),
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
        title={t('shell.asks.expand')}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="pending-asks-toggle-label">
          <HelmIcon name="alert-triangle" size={12} />
          {t('shell.asks.pending', { count: asks.length })}
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
                  {t('shell.asks.handleInMain')}
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
                  {t('shell.asks.sideBySide')}
                </button>
                {isSimpleConfirm(ask) && (
                  <>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, true)}
                    >
                      <HelmIcon name="check" size={12} />
                      {t('shell.asks.approve')}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, false)}
                    >
                      <HelmIcon name="x" size={12} />
                      {t('common.cancel')}
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
