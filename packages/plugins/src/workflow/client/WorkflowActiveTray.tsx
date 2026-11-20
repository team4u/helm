/**
 * builtin:workflow bottom in-flight activity tray (COMPOSER_DOCK_SLOT
 * extension point): renders a compact 32px single-line HUD only when the
 * current conversation or its descendants have in-flight tasks (running /
 * blocked / background subagents), with an expandable concurrent list and
 * one-click access to the workbench / drawer / abort / detach; returns null
 * once everything settles (0px, never occupying space).
 *
 * Interaction contract (card de-clutter pass, a11y-legal structure):
 * - the bar is a flex row whose main region is one real toggle <button>
 *   (aria-expanded / aria-controls); the Workbench action is a sibling
 *   button — no interactive element ever nests inside another;
 * - every expanded row is one real detail-entry <button> covering the row
 *   body (conversationId opens the ConversationDrawer, else runId focuses
 *   the run in the workbench); detach / abort are sibling buttons in the
 *   trailing action group — no stopPropagation acrobatics needed;
 * - the row body is a single-line layout isomorphic to the collapsed bar:
 *   status light, title / #id / progress / elapsed and the current execution
 *   content (live tool semantics / output / thinking / approval title,
 *   falling back to the model-provided doing digest) share one row — the
 *   live line takes the remaining width as a single-line ellipsis, so row
 *   height is constant and live-text length changes never make the tray or
 *   composer jump;
 * - live facts come from the host snapshot through useConversation with
 *   includeDetail:false (never an eager detail fetch) shared with the
 *   timeline subagent cards via resolveSubagentHeaderSnippet; collapsed bar
 *   prefers the current progress / approval content, expanded bar shows the
 *   concise task count instead of repeating task names.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildActiveTraySummary, type ActiveTrayItem } from './model-active-tray.ts'
import { resolveSubagentHeaderSnippet } from './model-subagent-card.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'
import {
  ACTION_ABORT,
  ACTION_DETACH,
  actionDetachDone,
  execConversationTitle,
  executionStatusLabel,
  TRAY_COLLAPSE,
  TRAY_EXPAND,
  TRAY_REGION_ARIA,
  TRAY_WORKBENCH,
  trayActionFailed,
  trayCount,
  trayRowOpenConversationLabel,
  trayRowOpenRunLabel,
  trayToggleLabel,
} from './copy.ts'

/**
 * Single row activity line: host-snapshot live facts via
 * useConversation(includeDetail:false) + resolveSubagentHeaderSnippet (same
 * derivation as the timeline subagent cards), falling back to the
 * model-provided doing digest when the host has no facts for the target.
 * Blocked-ness is judged from the activity conversation's own facts
 * (pendingAsk / status), never from the row aggregate — a container row
 * blocked elsewhere in its subtree must not fake an approval line onto a
 * working descendant. `inline` renders the one-line ellipsis bar variant
 * instead of the two-line row variant. A standalone component so the hook is
 * never called directly inside a list map.
 */
function ActiveTrayLiveLine(props: {
  conversationId: number | undefined
  runId?: string
  runs: ReadonlyArray<WorkflowRunSummary>
  fallback?: string
  inline?: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const conv = useConversation(props.conversationId, { includeDetail: false })
  const summary = conv.summary
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const backgroundRun =
    props.runId !== undefined ? props.runs.find((r) => r.id === props.runId) : undefined
  const hasHostFacts =
    summary !== undefined ||
    live !== undefined ||
    pendingAsk !== undefined ||
    backgroundRun !== undefined ||
    conv.loadError !== undefined
  const snippet =
    props.conversationId === undefined || !hasHostFacts
      ? undefined
      : resolveSubagentHeaderSnippet(
          {
            badgeStatus:
              pendingAsk !== undefined || (summary?.pendingAskCount ?? 0) > 0 || summary?.status === 'blocked'
                ? 'blocked'
                : 'working',
            ...(summary !== undefined ? { summary } : {}),
            ...(live !== undefined ? { live } : {}),
            ...(pendingAsk !== undefined ? { pendingAsk } : {}),
            ...(backgroundRun !== undefined ? { backgroundRun } : {}),
            ...(conv.loadError !== undefined ? { detailError: conv.loadError } : {}),
          },
          locale,
        )

  const text =
    snippet !== undefined
      ? snippet.tag !== undefined
        ? `${snippet.tag}: ${snippet.text}`
        : snippet.text
      : props.fallback
  if (text === undefined || text.trim() === '') return null
  return (
    <span
      className={props.inline === true ? 'workflow-active-tray-frontline' : 'workflow-active-tray-row-live'}
      title={text}
    >
      {text}
    </span>
  )
}

function WorkflowActiveTrayRow(props: {
  item: ActiveTrayItem
  rootConversationId: number
  runs: ReadonlyArray<WorkflowRunSummary>
  nowMs: number | undefined
  busy: boolean
  onAction: (key: string, actionId: string, runId: string, successMessage?: string) => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { item } = props

  const itemElapsed =
    props.nowMs !== undefined && item.startedAt !== undefined && props.nowMs >= item.startedAt
      ? formatDurationMs(props.nowMs - item.startedAt)
      : undefined
  const isFallbackConvTitle =
    item.conversationId !== undefined && item.title === execConversationTitle(item.conversationId, locale)
  // Row detail entry: conversation rows open the drawer, other rows focus the
  // run in the workbench. Detach / abort live in the trailing sibling action
  // group (no nested interactives); the activity target never changes this.
  const openRow = (): void => {
    if (item.conversationId !== undefined) {
      ctx.openConversationDrawer(item.conversationId)
      return
    }
    if (item.runId !== undefined) {
      requestWorkbenchRunFocus(props.rootConversationId, item.runId)
      ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
    }
  }
  const rowActivatable = item.conversationId !== undefined || item.runId !== undefined
  const rowLabel =
    item.conversationId !== undefined
      ? trayRowOpenConversationLabel(item.conversationId, locale)
      : item.runId !== undefined
        ? trayRowOpenRunLabel(item.runId, locale)
        : item.title
  const rowMainClass = `workflow-active-tray-row-main${rowActivatable ? ' workflow-active-tray-row-clickable' : ''}`
  // 单行行体（与折叠横栏同构）：状态灯/标题/#id/进度/耗时与实况同行，
  // 实况吃掉剩余宽度单行省略——行高恒定，实况长短变化不引起托盘/输入区跳动。
  const rowMainContent = (
    <>
      <StatusLight
        status={item.isBlocked ? 'blocked' : 'running'}
        label={executionStatusLabel(item.isBlocked ? 'blocked' : 'working', locale)}
      />
      <span className="workflow-active-tray-row-title">{item.title}</span>
      {item.conversationId !== undefined && !isFallbackConvTitle ? (
        <span className="workflow-active-tray-row-id tabular-nums">{`#${item.conversationId}`}</span>
      ) : null}
      {item.progress !== undefined ? (
        <span className="badge badge-neutral workflow-trace-badge tabular-nums">
          {`${item.progress.done}/${item.progress.total}`}
        </span>
      ) : null}
      {itemElapsed !== undefined ? (
        <span className="workflow-active-tray-elapsed tabular-nums">{itemElapsed}</span>
      ) : null}
      <ActiveTrayLiveLine
        conversationId={item.activityConversationId ?? item.conversationId}
        runId={item.runId}
        runs={props.runs}
        fallback={item.doing}
      />
    </>
  )
  return (
    <div className="workflow-active-tray-row">
      {rowActivatable ? (
        <button
          type="button"
          className={rowMainClass}
          aria-label={`${item.title} — ${rowLabel}`}
          onClick={openRow}
        >
          {rowMainContent}
        </button>
      ) : (
        <div className={rowMainClass}>{rowMainContent}</div>
      )}
      <div className="workflow-active-tray-row-actions">
        {item.canDetach && item.runId !== undefined ? (
          <button
            type="button"
            className="btn btn-xs"
            disabled={props.busy}
            onClick={() =>
              props.onAction(`detach:${item.runId}`, 'detach', item.runId!, actionDetachDone(item.runId!, locale))
            }
          >
            <Icon name="arrow-down-to-line" size={11} />
            <span>{resolveLocalizedText(ACTION_DETACH, locale)}</span>
          </button>
        ) : null}
        {item.canAbort && item.runId !== undefined ? (
          <button
            type="button"
            className="btn btn-xs btn-danger"
            disabled={props.busy}
            onClick={() => props.onAction(`abort:${item.runId}`, 'abort', item.runId!)}
          >
            <Icon name="square" size={11} />
            <span>{resolveLocalizedText(ACTION_ABORT, locale)}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function WorkflowActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const runs = runsDoc?.runs ?? []
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const listId = useId()

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const ownedBy =
    props.conversation?.ownedBy ??
    conversations.find((c) => c.id === conversationId)?.ownedBy

  const summary = useMemo(
    () =>
      conversationId === undefined
        ? undefined
        : buildActiveTraySummary(
            {
              rootConversationId: conversationId,
              conversations,
              runs,
              viewer: { conversationId, ownedBy },
            },
            locale,
          ),
    [conversationId, conversations, runs, ownedBy, locale],
  )

  const hasTimer = summary !== undefined && summary.items.length > 0 && summary.earliestStartedAt !== undefined
  const nowMs = useElapsedNowMs(hasTimer)

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }

  const runAction = (key: string, actionId: string, runId: string, successMessage?: string): void => {
    if (busyKey !== undefined) return
    setBusyKey(key)
    void ctx
      .callAction(actionId, { runId })
      .then(() => {
        if (successMessage !== undefined) ctx.notify(successMessage)
      })
      .catch((err: unknown) => {
        ctx.notify(
          trayActionFailed(actionId === 'abort' ? 'abort' : 'detach', err instanceof Error ? err.message : String(err), locale),
          'error',
        )
      })
      .finally(() => {
        setBusyKey(undefined)
      })
  }

  const countText = trayCount(summary.blockedCount, summary.runningCount, summary.activeCount, locale)
  const hasBlocked = summary.blockedCount > 0

  const singleItem = summary.items.length === 1 ? summary.items[0] : undefined
  const singleProgress = singleItem?.progress
  // Multi-task collapsed headline target: the first tray item carrying an
  // activity conversation of its own subtree (single-item trays reuse that
  // item); a container digest never overrides a real live target.
  const headlineItem =
    singleItem ?? summary.items.find((item) => item.activityConversationId !== undefined)

  return (
    <div
      className={`workflow-active-tray${hasBlocked ? ' workflow-active-tray-warn' : ''}`}
      role="region"
      aria-label={resolveLocalizedText(TRAY_REGION_ARIA, locale)}
    >
      <div className="workflow-active-tray-bar">
        <button
          type="button"
          className="workflow-active-tray-bar-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={trayToggleLabel(expanded, countText, locale)}
          title={resolveLocalizedText(expanded ? TRAY_COLLAPSE : TRAY_EXPAND, locale)}
          onClick={() => setExpanded((v) => !v)}
        >
          <StatusLight status={hasBlocked ? 'blocked' : 'running'} label={countText} />
          {singleProgress !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge tabular-nums">
              {`${singleProgress.done}/${singleProgress.total}`}
            </span>
          ) : null}
          {summary.items.length > 1 || expanded ? (
            <span className="workflow-active-tray-count">{countText}</span>
          ) : null}
          {/* Collapsed bar prefers the current progress / approval content;
             expanded bar stays concise (count only, no repeated task names).
             Multi-task headline: after approvals, real live content from the
             first tray item's own subtree target (never a cross-row target),
             then the frontline digest. */}
          {expanded ? null : summary.approvals.length > 0 ? (
            <span className="workflow-active-tray-frontline">{summary.approvals[0]!.text}</span>
          ) : headlineItem !== undefined ? (
            <ActiveTrayLiveLine
              conversationId={headlineItem.activityConversationId ?? headlineItem.conversationId}
              runId={headlineItem.runId}
              runs={runs}
              fallback={headlineItem.doing}
              inline
            />
          ) : summary.frontline.length > 0 ? (
            <span className="workflow-active-tray-frontline">{summary.frontline[0]!.text}</span>
          ) : null}
          <span className="workflow-active-tray-spacer" />
          {nowMs !== undefined && summary.earliestStartedAt !== undefined && nowMs >= summary.earliestStartedAt ? (
            <span className="workflow-active-tray-elapsed tabular-nums">
              {formatDurationMs(nowMs - summary.earliestStartedAt)}
            </span>
          ) : null}
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={11}
            className="workflow-active-tray-chevron"
          />
        </button>
        <button
          type="button"
          className="btn btn-xs workflow-active-tray-workbench"
          onClick={() => {
            const singleRunId = summary.items.length === 1 ? summary.items[0]?.runId : undefined
            if (singleRunId !== undefined) requestWorkbenchRunFocus(conversationId, singleRunId)
            ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
          }}
        >
          <Icon name="git-branch" size={11} />
          <span>{resolveLocalizedText(TRAY_WORKBENCH, locale)}</span>
        </button>
      </div>
      {expanded ? (
        <div id={listId} className="workflow-active-tray-list">
          {summary.items.map((item) => (
            <WorkflowActiveTrayRow
              key={item.key}
              item={item}
              rootConversationId={conversationId}
              runs={runs}
              nowMs={nowMs}
              busy={busyKey !== undefined}
              onAction={runAction}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
