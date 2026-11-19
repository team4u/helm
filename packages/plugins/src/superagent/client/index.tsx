/**
 * builtin:superagent plugin client.tsx components (component exports only,
 * Fast Refresh contract):
 * - SuperAgentComposerWidget: hub status widget (active workers / live
 *   subscription counts + table);
 * - SuperAgentRouterModePill: hub router convergence-mode switch
 *   (set_router_mode action);
 * - SuperAgentDispatchToolView: dispatch_worker tool card (dispatch state +
 *   archive action);
 * - SuperAgentWorkerReportCard: worker report timeline card (exact
 *   meta.renderer match);
 * - SuperAgentRecallScreen: RecallGraph memory graph + event-subscription
 *   fullscreen view;
 * - SuperAgentSettingsPanel: settings panel (read-only managed state,
 *   pointing to the plugin config area).
 *
 * Data flows through the @helmx/plugin-client shared hooks (usePluginDoc)
 * subscribing reactively to this plugin's public docs; actions go through
 * ctx.callAction (POST /api/actions), navigation through ctx.openScreen /
 * ctx.openSplitScreen. Generic structure reuses the host design-system
 * primitives (.screen-container / .helmx-table / .kv-list / .callout /
 * .loading-state); only the sa-widget / sa-pill / sa-report inspection
 * specifics keep their own business styles.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged.
 */
import { useMemo, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type {
  ComposerScopeProps,
  ConversationSummary,
  ScreenProps,
  TimelineRendererProps,
  ToolViewProps,
} from '@helmx/protocol'
import {
  StatusLight,
  formatTime,
  Switch,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  buildConversationMap,
  dispatchedWorkerId,
  dispatchInput,
  outcomeLabel,
  outcomeTone,
  parseRecallNodes,
  parseRouterMode,
  parseSubscriptions,
  parseWorkers,
  resolveConversationTitle,
  workerReportMeta,
  type RecallGraphDoc,
  type RouterModeDoc,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './models.ts'
import {
  SA_ACTION_ARCHIVE,
  SA_ACTION_OPEN,
  SA_ACTION_OPEN_CONVERSATION,
  SA_ACTION_OPEN_WORKER,
  SA_ACTION_SPLIT_OPEN,
  SA_COL_ACTIONS,
  SA_COL_CONVERSATION,
  SA_COL_CREATED,
  SA_COL_OUTCOME,
  SA_COL_SUMMARY,
  SA_DISPATCH_DONE,
  SA_DISPATCH_FAILED,
  SA_DISPATCH_TITLE,
  SA_DISPATCHING,
  SA_KV_ROUTER,
  SA_KV_WATCHDOG,
  SA_KV_WORKERS,
  SA_LOADING,
  SA_LOADING_GRAPH,
  SA_LOADING_MANAGED,
  SA_LOADING_STATUS,
  SA_LOADING_SUBSCRIPTIONS,
  SA_LOADING_WORKERS,
  SA_NO_DATA,
  SA_NOT_BOOTSTRAPPED,
  SA_RECALL_TITLE,
  SA_ROUTER_PILL_ARIA,
  SA_ROUTER_PILL_LABEL,
  SA_SETTINGS_HINT,
  SA_SETTINGS_TITLE,
  SA_SUBSCRIPTIONS_TITLE,
  SA_WIDGET_TITLE,
  SA_WORKER_REPORT,
  SA_STATUS_COMPLETED,
  SA_STATUS_FAILED,
  SA_STATUS_RUNNING,
  saArtifactTitle,
  saDispatchedWorker,
  saRecallSubtitle,
  saWidgetSummary,
} from './copy.ts'

import {
  Bot,
  Boxes,
  ExternalLink,
  GitFork,
  Loader2,
  MessageSquare,
  Network,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Shared small components (plugin-internal, not part of the core)
// ---------------------------------------------------------------------------

/** Inline loading state before the doc subscription's first frame arrives. */
function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="loading-state" role="status">
      <Loader2 size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

/** Action error banner (callAction failed explicitly; never silent). */
function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout--error" role="alert">
      <span>{message}</span>
    </div>
  )
}

/**
 * Worker row action button. Buttons guarded by the same pending flag stay
 * uniformly disabled: while any action is in flight the other buttons are
 * unclickable too, avoiding the "looks clickable but does nothing" trap.
 */
function RowAction({
  label,
  icon,
  disabled,
  danger,
  onClick,
}: {
  label: string
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      {disabled === true ? <Loader2 size={11} className="spin-slow" /> : icon}
      <span>{label}</span>
    </button>
  )
}

/** Conversation cell: live title + subtle #id when available, or honest #id only when missing/placeholder. */
function ConversationCell({
  conversationId,
  conversationsById,
}: {
  conversationId: number
  conversationsById: ReadonlyMap<number, ConversationSummary>
}): ReactNode {
  const title = resolveConversationTitle(conversationsById, conversationId)
  if (title === undefined) {
    return <td className="tabular-nums">#{conversationId}</td>
  }
  return (
    <td>
      <span className="sa-conv-cell" title={`${title} (#${conversationId})`}>
        <span className="sa-conv-name">{title}</span>{' '}
        <span className="sa-conv-id tabular-nums">#{conversationId}</span>
      </span>
    </td>
  )
}

// ---------------------------------------------------------------------------
// composerWidget: hub status
// ---------------------------------------------------------------------------

/** Hub status widget: live counts and the active-worker center table (open + archive). */
export function SuperAgentComposerWidget(_props: ComposerScopeProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const conversations = useConversations()
  const conversationsById = useMemo(() => buildConversationMap(conversations), [conversations])
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const workers = parseWorkers(index)
  const subs = parseSubscriptions(subscriptions)
  const loading = index === undefined || subscriptions === undefined
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const archive = (workerConversationId: number): void => {
    if (archiving) return
    setArchiving(true)
    setError(undefined)
    void ctx
      .callAction('archive_worker', { workerConversationId })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setArchiving(false)
      })
  }

  return (
    <div className="section-flat sa-widget">
      <div className="sa-widget-title">
        <Network size={13} strokeWidth={1.75} />
        <span>{t(SA_WIDGET_TITLE)}</span>
      </div>
      {loading ? (
        <DocLoading label={t(SA_LOADING_STATUS)} />
      ) : (
        <>
          <div className="sa-widget-muted">{saWidgetSummary(workers.length, subs.length, locale)}</div>
          {error !== undefined ? <ActionError message={error} /> : null}
          <div className="helmx-table-wrap">
            <table className="helmx-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Profile</th>
                  <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      {t(SA_NO_DATA)}
                    </td>
                  </tr>
                ) : (
                  workers.map((w) => (
                    <tr key={w.conversationId}>
                      <ConversationCell conversationId={w.conversationId} conversationsById={conversationsById} />
                      <td>{w.profileId}</td>
                      <td className="cell-actions">
                        {/* While an archive is in flight, disable every row button on this card (uniform re-entry guard). */}
                        <div className="row-actions-group">
                          <RowAction label={t(SA_ACTION_OPEN)} icon={<ExternalLink size={11} />} disabled={archiving} onClick={() => ctx.openScreen(`conversation:${w.conversationId}`)} />
                          <RowAction
                            label={t(SA_ACTION_ARCHIVE)}
                            icon={<Boxes size={11} />}
                            disabled={archiving}
                            danger
                            onClick={() => archive(w.conversationId)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// composerPill: hub router convergence-mode switch
// ---------------------------------------------------------------------------

/** Hub router convergence-mode pill (routing mirror doc; set_router_mode writes the real config). */
export function SuperAgentRouterModePill(_props: ComposerScopeProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const routing = usePluginDoc<RouterModeDoc>('routing')
  const mode = parseRouterMode(routing)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const toggle = (next: boolean): void => {
    if (pending) return
    setPending(true)
    setError(undefined)
    void ctx
      .callAction('set_router_mode', { enabled: next })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setPending(false)
      })
  }

  return (
    <span className="sa-pill">
      <Switch
        checked={mode === true}
        onChange={toggle}
        disabled={pending || mode === undefined}
        label={t(SA_ROUTER_PILL_LABEL)}
        aria-label={t(SA_ROUTER_PILL_ARIA)}
      />
      {mode === undefined ? <span className="text-subtle">{t(SA_LOADING)}</span> : null}
      {error !== undefined ? <ActionError message={error} /> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// toolView: dispatch_worker tool card
// ---------------------------------------------------------------------------

/**
 * dispatch_worker tool card: a lightweight single-line dispatch receipt (status
 * light + summary + direct worker conversation entry). The live worker list and
 * the archive capability live in the hub status widget (SuperAgentComposerWidget)
 * — nothing is lost, the timeline card just stops duplicating the center table.
 */
export function SuperAgentDispatchToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const input = dispatchInput(props)
  const resultWorkerId = dispatchedWorkerId(props)

  const lightStatus =
    props.status === 'running' ? 'running' : props.status === 'error' ? 'failed' : 'completed'
  const receiptText =
    props.status === 'running'
      ? t(SA_DISPATCHING)
      : props.status === 'error'
        ? t(SA_DISPATCH_FAILED)
        : resultWorkerId !== undefined
          ? saDispatchedWorker(resultWorkerId, locale)
          : t(SA_DISPATCH_DONE)

  return (
    <div className="section-flat sa-widget sa-dispatch-receipt-card">
      <div className="sa-widget-title">
        <Boxes size={13} strokeWidth={1.75} />
        <span>{t(SA_DISPATCH_TITLE)}</span>
      </div>
      <div className="sa-dispatch-receipt">
        {/* 灯的可访问名称只用短状态词：相邻可见回执已承载 worker id/摘要，避免读屏重复 */}
        <StatusLight status={lightStatus} label={t(lightStatus === 'running' ? SA_STATUS_RUNNING : lightStatus === 'failed' ? SA_STATUS_FAILED : SA_STATUS_COMPLETED)} />
        <span className="sa-dispatch-text">{receiptText}</span>
        {input.profileId !== undefined ? <span className="sa-dispatch-meta">Profile {input.profileId}</span> : null}
        {input.threadKey !== undefined ? <span className="sa-dispatch-meta mono">{input.threadKey}</span> : null}
        {resultWorkerId !== undefined ? (
          <RowAction
            label={t(SA_ACTION_OPEN)}
            icon={<ExternalLink size={11} />}
            onClick={() => ctx.openScreen(`conversation:${resultWorkerId}`)}
          />
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// timelineRenderer: worker report card
// ---------------------------------------------------------------------------

/** Worker report timeline card (exact matchMeta.renderer = superagent:worker-report). */
export function SuperAgentWorkerReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const meta = workerReportMeta(props)

  return (
    <div className="sa-report">
      <div className="sa-report-header">
        <span className="badge badge-neutral">
          <Bot size={11} strokeWidth={1.75} />
          <span>{t(SA_WORKER_REPORT)}</span>
        </span>
        {meta.profileId !== undefined ? <span className="badge badge-neutral">{meta.profileId}</span> : null}
        {meta.outcome !== undefined ? (
          <StatusLight status={meta.outcome} label={outcomeLabel(meta.outcome, locale)} />
        ) : null}
      </div>
      <div className="sa-report-summary">{meta.summary ?? ''}</div>
      {meta.artifacts !== undefined && meta.artifacts.length > 0 ? (
        <div className="sa-report-meta">
          {meta.artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => ctx.openArtifact(a.id)}
              title={saArtifactTitle(a.name, a.size, locale)}
            >
              <ExternalLink size={11} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="row-actions-group">
        <RowAction
          label={t(SA_ACTION_SPLIT_OPEN)}
          icon={<MessageSquare size={11} />}
          onClick={() => {
            if (meta.workerId !== undefined) ctx.openSplitScreen(`conversation:${meta.workerId}`)
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// screen: RecallGraph memory graph + event subscriptions
// ---------------------------------------------------------------------------

/** Memory + subscription graph fullscreen view (live subscription to recall-graph and subscriptions docs). */
export function SuperAgentRecallScreen(props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const conversations = useConversations()
  const conversationsById = useMemo(() => buildConversationMap(conversations), [conversations])
  const recall = usePluginDoc<RecallGraphDoc>('recall-graph')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const nodes = parseRecallNodes(recall)
  const subs = parseSubscriptions(subscriptions)

  return (
    <div className="screen-container">
      <div className="screen-header">
        <div className="screen-title">
          <GitFork size={15} strokeWidth={1.75} />
          <span>{t(SA_RECALL_TITLE)}</span>
        </div>
        <span className="screen-subtitle">{saRecallSubtitle(nodes.length, subs.length, props.isSplit, locale)}</span>
      </div>

      <div className="screen-section">
        <div className="helmx-table-wrap">
          <table className="helmx-table">
            <thead>
              <tr>
                <th>{t(SA_COL_CONVERSATION)}</th>
                <th>Profile</th>
                <th>{t(SA_COL_OUTCOME)}</th>
                <th>{t(SA_COL_SUMMARY)}</th>
                <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
              </tr>
            </thead>
            <tbody>
              {recall === undefined && nodes.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <DocLoading label={t(SA_LOADING_GRAPH)} />
                  </td>
                </tr>
              ) : nodes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    {t(SA_NO_DATA)}
                  </td>
                </tr>
              ) : (
                nodes.map((n) => (
                  <tr key={n.id}>
                    <ConversationCell conversationId={n.conversationId} conversationsById={conversationsById} />
                    <td>{n.profileId}</td>
                    <td>
                      {/* 表格保留可见 outcome 文字徽章（列语义不依赖列标题或颜色解释）；回执/汇报卡继续用灯 */}
                      <span className={`badge badge-${outcomeTone(n.outcome)}`}>
                        {outcomeLabel(n.outcome, locale)}
                      </span>
                    </td>
                    <td className="sa-summary-cell">{n.summary}</td>
                    <td className="cell-actions">
                      <div className="row-actions-group">
                        <RowAction label={t(SA_ACTION_OPEN_CONVERSATION)} icon={<ExternalLink size={11} />} onClick={() => ctx.openScreen(`conversation:${n.conversationId}`)} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="screen-section">
        <div className="screen-section-title">
          <Network size={13} strokeWidth={1.75} />
          <span>{t(SA_SUBSCRIPTIONS_TITLE)}</span>
        </div>
        <div className="helmx-table-wrap">
          <table className="helmx-table">
            <thead>
              <tr>
                <th>ThreadKey</th>
                <th>Worker</th>
                <th>{t(SA_COL_CREATED)}</th>
                <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions === undefined && subs.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <DocLoading label={t(SA_LOADING_SUBSCRIPTIONS)} />
                  </td>
                </tr>
              ) : subs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    {t(SA_NO_DATA)}
                  </td>
                </tr>
              ) : (
                subs.map((s) => (
                  <tr key={s.threadKey}>
                    <td>{s.threadKey}</td>
                    <ConversationCell conversationId={s.workerConversationId} conversationsById={conversationsById} />
                    <td>{formatTime(s.createdAt)}</td>
                    <td className="cell-actions">
                      <div className="row-actions-group">
                        <RowAction label={t(SA_ACTION_OPEN_WORKER)} icon={<ExternalLink size={11} />} onClick={() => ctx.openScreen(`conversation:${s.workerConversationId}`)} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// settingsPanel: read-only managed state
// ---------------------------------------------------------------------------

/** Settings panel: read-only view of the hub/watchdog managed conversations; config points to the plugin config area. */
export function SuperAgentSettingsPanel(): ReactNode {
  const t = usePluginTranslator()
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const routerId = typeof index?.routerConversationId === 'number' ? index.routerConversationId : undefined
  const watchdogId = typeof index?.watchdogConversationId === 'number' ? index.watchdogConversationId : undefined
  const workers = parseWorkers(index)

  return (
    <div className="screen-container">
      <div className="screen-section-title">
        <Network size={13} strokeWidth={1.75} />
        <span>{t(SA_SETTINGS_TITLE)}</span>
      </div>
      <div className="sa-widget-muted">{t(SA_SETTINGS_HINT)}</div>
      {index === undefined ? (
        <DocLoading label={t(SA_LOADING_MANAGED)} />
      ) : (
        <div className="kv-list">
          <div className="kv-key">{t(SA_KV_ROUTER)}</div>
          <div className="kv-val">{routerId !== undefined ? `#${routerId}` : t(SA_NOT_BOOTSTRAPPED)}</div>
          <div className="kv-key">{t(SA_KV_WATCHDOG)}</div>
          <div className="kv-val">{watchdogId !== undefined ? `#${watchdogId}` : t(SA_NOT_BOOTSTRAPPED)}</div>
          <div className="kv-key">{t(SA_KV_WORKERS)}</div>
          <div className="kv-val">{workers.length}</div>
        </div>
      )}
    </div>
  )
}