/**
 * builtin:swarm right workbench panel (conversation-scoped orchestration
 * card):
 * - resolves the current conversation's swarm group from the public `index`
 *   doc (coordinator-owned group for coordinator conversations, the same
 *   group's facts for worker conversations — never a global group index);
 * - live `board-view` session doc (keyed by coordinatorConversationId) while
 *   the group is active; explicit one-shot `board_status` fallback (plus
 *   on-demand `board_read` for the full record) for closed / detached groups
 *   or a not-yet-projected doc — failures surface with Retry, never a blank
 *   screen or a fabricated "running" state;
 * - one orchestration card: objective, natural status, member rows with one
 *   honest sentence of latest progress (click opens the ConversationDrawer),
 *   recent handoff activity with #seq as auxiliary info, worktree branch
 *   facts, and retained branches after close.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helm/protocol'
import {
  Callout,
  HelmIcon,
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  mergeBoardViewWithRead,
  parseBoardView,
  postDigestLine,
  postKindBadgeClass,
  resolveConversationBoardLink,
  shouldCollapsePostBody,
  type BoardViewDoc,
} from './board-model.ts'
import { buildSwarmPanelModel } from './model-panel.ts'
import { useElapsedNowMs, useSwarmBoardReadOnce, useSwarmBoardStatusFallback } from './hooks.ts'
import {
  PANEL_ACTIVITY_AUTHORED,
  PANEL_ACTIVITY_RECEIVED,
  PANEL_ACTIVITY_TITLE,
  PANEL_EMPTY_HINT,
  PANEL_EMPTY_TITLE,
  PANEL_FALLBACK_NOTE,
  PANEL_HISTORY_COLLAPSE,
  PANEL_HISTORY_TOGGLE,
  PANEL_LOADING,
  PANEL_MEMBERS_TITLE,
  PANEL_OBJECTIVE,
  PANEL_POSTS_EMPTY,
  PANEL_REFRESH,
  PANEL_RETAINED_TITLE,
  PANEL_RETRY,
  PANEL_STATUS_LOAD_FAILED,
  panelPostTargets,
  panelRetainedSummary,
  panelRowOpenLabel,
  panelStatusLabel,
  panelWorktreeSummary,
  postKindLabel,
  memberLiveStateLabel,
  memberAccessLabel,
  PANEL_MEMBER_ARCHIVED,
} from './copy.ts'
import { PostBodyText } from './PostBodyText.tsx'

const RECENT_LIMIT_COLLAPSED = 6
const RECENT_LIMIT_EXPANDED = 80

function panelHeadLight(status: 'running' | 'attention' | 'completed'):
  | 'running'
  | 'blocked'
  | 'done' {
  if (status === 'attention') return 'blocked'
  if (status === 'completed') return 'done'
  return 'running'
}

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const [historyExpanded, setHistoryExpanded] = useState(false)

  useEffect(() => {
    setHistoryExpanded(false)
  }, [conversationId])

  const link = useMemo(
    () => resolveConversationBoardLink(conversationId, {}, index),
    [conversationId, index],
  )

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>(
    'board-view',
    link !== undefined ? { conversationId: link.coordinatorConversationId } : undefined,
  )
  const liveBoard = useMemo(() => {
    if (rawBoard === undefined) return undefined
    const parsed = parseBoardView(rawBoard)
    if (parsed === undefined) return undefined
    if (link !== undefined && parsed.group.id !== link.groupId) return undefined
    return parsed
  }, [rawBoard, link])

  const fallback = useSwarmBoardStatusFallback(link?.groupId, {
    conversationId,
    enabled: link !== undefined && liveBoard === undefined,
  })

  const board = liveBoard ?? fallback.view
  const loading = link !== undefined && liveBoard === undefined && fallback.loading && board === undefined
  const loadError = liveBoard === undefined ? fallback.error : undefined
  const isFallbackData = liveBoard === undefined && board !== undefined

  const readState = useSwarmBoardReadOnce(
    link?.groupId,
    historyExpanded && isFallbackData,
    { conversationId },
  )

  const effectiveBoard = useMemo(
    () =>
      board !== undefined && isFallbackData && readState.posts.length > 0
        ? mergeBoardViewWithRead(board, readState.posts)
        : board,
    [board, isFallbackData, readState.posts],
  )

  const model = useMemo(
    () =>
      effectiveBoard !== undefined
        ? buildSwarmPanelModel(effectiveBoard, conversations, {
            recentLimit: historyExpanded ? RECENT_LIMIT_EXPANDED : RECENT_LIMIT_COLLAPSED,
          })
        : undefined,
    [effectiveBoard, conversations, historyExpanded],
  )

  const groupElapsedActive = model !== undefined && model.status !== 'completed' && effectiveBoard !== undefined && effectiveBoard.group.createdAt > 0
  const nowMs = useElapsedNowMs(groupElapsedActive)
  const groupElapsed =
    nowMs !== undefined &&
    effectiveBoard !== undefined &&
    effectiveBoard.group.createdAt > 0 &&
    nowMs >= effectiveBoard.group.createdAt
      ? formatDurationMs(nowMs - effectiveBoard.group.createdAt)
      : undefined

  if (conversationId === undefined || link === undefined) {
    return (
      <div className="sw-panel">
        <div className="empty-state empty-state-compact">
          <p className="empty-state-title">{resolveLocalizedText(PANEL_EMPTY_TITLE, locale)}</p>
          <p className="empty-state-hint">{resolveLocalizedText(PANEL_EMPTY_HINT, locale)}</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="sw-panel">
        <div className="loading-state" role="status">{resolveLocalizedText(PANEL_LOADING, locale)}</div>
      </div>
    )
  }

  if (model === undefined || effectiveBoard === undefined) {
    return (
      <div className="sw-panel">
        <Callout tone={loadError !== undefined ? 'err' : 'warn'} title={resolveLocalizedText(PANEL_STATUS_LOAD_FAILED, locale)}>
          {loadError !== undefined ? <p className="sw-panel-error-text">{loadError}</p> : null}
          <button type="button" className="btn btn-xs" onClick={fallback.reload}>
            <HelmIcon name="rotate-cw" size={11} />
            <span>{resolveLocalizedText(PANEL_RETRY, locale)}</span>
          </button>
        </Callout>
      </div>
    )
  }

  return (
    <div className="sw-panel">
      <div className="sw-panel-head">
        <span className="sw-panel-head-left">
          <StatusLight status={panelHeadLight(model.status)} label={panelStatusLabel(model.status, locale)} />
          <span className="sw-panel-title" title={effectiveBoard.group.title}>{effectiveBoard.group.title}</span>
          <span className={`badge ${model.status === 'attention' ? 'badge-warn' : model.status === 'completed' ? 'badge-neutral' : 'badge-accent'}`}>
            {panelStatusLabel(model.status, locale)}
          </span>
          <span className="badge badge-neutral tabular-nums">
            {`${model.progress.done}/${model.progress.total}`}
          </span>
          {groupElapsed !== undefined ? (
            <span className="sw-panel-elapsed tabular-nums">{groupElapsed}</span>
          ) : null}
        </span>
        {isFallbackData ? (
          <span className="stack-row">
            <span className="badge badge-neutral">{resolveLocalizedText(PANEL_FALLBACK_NOTE, locale)}</span>
            <button type="button" className="btn btn-xs" onClick={fallback.reload}>
              <HelmIcon name="rotate-cw" size={11} />
              <span>{resolveLocalizedText(PANEL_REFRESH, locale)}</span>
            </button>
          </span>
        ) : null}
      </div>

      {model.objective !== undefined ? (
        <div className="sw-panel-objective">
          <span className="sw-panel-kv-key">{resolveLocalizedText(PANEL_OBJECTIVE, locale)}</span>
          <p className="sw-panel-objective-text">{model.objective}</p>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_MEMBERS_TITLE, locale)}</span>
          <span className="badge badge-neutral tabular-nums">{model.rows.length}</span>
        </div>
        {model.rows.length === 0 ? (
          <div className="sw-panel-empty-hint">{resolveLocalizedText(PANEL_POSTS_EMPTY, locale)}</div>
        ) : (
          <div className="sw-panel-members">
            {model.rows.map((row) => {
              const activityKind =
                row.latestActivity !== undefined ? postKindLabel(row.latestActivity.post.kind, locale) : undefined
              const activityText =
                row.latestActivity !== undefined
                  ? `${row.latestActivity.direction === 'received' ? resolveLocalizedText(PANEL_ACTIVITY_RECEIVED, locale) : resolveLocalizedText(PANEL_ACTIVITY_AUTHORED, locale)} · ${activityKind ?? ''}: ${postDigestLine(row.latestActivity.post.body, 90)}`
                  : undefined
              return (
                <button
                  key={row.name}
                  type="button"
                  className="sw-panel-member-row"
                  aria-label={`@${row.name} — ${panelRowOpenLabel(row.name, locale)}`}
                  onClick={() => ctx.openConversationDrawer(row.conversationId)}
                >
                  <span className="sw-panel-member-main">
                    <StatusLight
                      status={
                        row.liveState === 'working'
                          ? 'running'
                          : row.liveState === 'blocked'
                            ? 'blocked'
                            : row.liveState === 'error'
                              ? 'error'
                              : 'done'
                      }
                      label={memberLiveStateLabel(row.liveState, locale)}
                    />
                    <span className="sw-panel-member-name">@{row.name}</span>
                    {row.lifecycle === 'archived' ? (
                      <span className="badge badge-neutral">{resolveLocalizedText(PANEL_MEMBER_ARCHIVED, locale)}</span>
                    ) : null}
                    <span className="badge badge-neutral">{memberAccessLabel(row.access, locale)}</span>
                    {row.doing !== undefined ? (
                      <span className="sw-panel-member-doing" title={row.doing}>{row.doing}</span>
                    ) : null}
                  </span>
                  <span className="sw-panel-member-activity" title={activityText}>
                    {activityText !== undefined ? activityText : `#${row.conversationId}`}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {model.retainedWorktrees !== undefined && model.retainedWorktrees.length > 0 ? (
        <div className="sw-panel-section">
          <div className="sw-panel-section-head">
            <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_RETAINED_TITLE, locale)}</span>
            <span className="badge badge-warn tabular-nums">{model.retainedWorktrees.length}</span>
          </div>
          <ul className="sw-panel-retained">
            {model.retainedWorktrees.map((item) => (
              <li key={item.worktreeId} className="sw-panel-retained-item">
                <HelmIcon name="git-branch" size={11} />
                <span title={`${item.path} · ${item.worktreeId}`}>{panelRetainedSummary(item, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_ACTIVITY_TITLE, locale)}</span>
          <button
            type="button"
            className="btn btn-xs btn-ghost sw-panel-history-toggle"
            aria-expanded={historyExpanded}
            onClick={() => setHistoryExpanded((v) => !v)}
          >
            <HelmIcon name={historyExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{resolveLocalizedText(historyExpanded ? PANEL_HISTORY_COLLAPSE : PANEL_HISTORY_TOGGLE, locale)}</span>
          </button>
        </div>
        {model.recentPosts.length === 0 ? (
          <div className="sw-panel-empty-hint">{resolveLocalizedText(PANEL_POSTS_EMPTY, locale)}</div>
        ) : (
          <ol className="sw-panel-posts">
            {model.recentPosts.map((post) => (
              <li key={post.seq} className="sw-panel-post">
                <div className="sw-panel-post-head">
                  <span className={`badge ${postKindBadgeClass(post.kind)}`}>{postKindLabel(post.kind, locale)}</span>
                  <span className="sw-panel-post-from">
                    {post.from === 'coordinator' ? 'coordinator' : `@${post.from}`}
                    {' -> '}
                    {panelPostTargets(post)}
                  </span>
                  <span className="sw-panel-post-seq tabular-nums" title={post.body}>{`#${post.seq}`}</span>
                </div>
                <PostBodyText body={post.body} collapsible={shouldCollapsePostBody(post.body)} />
                {post.worktreeSnapshot !== undefined ? (
                  <div className="sw-panel-post-worktree">
                    <HelmIcon name="git-branch" size={11} />
                    <span>{panelWorktreeSummary(post.worktreeSnapshot, locale)}</span>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {readState.error !== undefined ? (
          <div className="sw-panel-empty-hint">{readState.error}</div>
        ) : null}
      </div>
    </div>
  )
}
