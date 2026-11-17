/**
 * SwarmBoardScreen (#/views/builtin:swarm/board & split view):
 * - Dual-channel data source: live usePluginSessionDoc('board-view') when the
 *   group is active and !coordinatorDetached; automatic fallback to
 *   board_status + board_read for closed or coordinatorDetached groups (zero
 *   blank screen);
 * - Top control bar: group <Select>, channel <Tabs>, coordinatorGuard <Switch>,
 *   and two-mode close_group controls (keepWorktree unlock-merge vs clean close);
 * - 1-line headline + <Callout> rescue banner for stall / blocker / unmerged;
 * - Adaptive topology: wide full-screen orthogonal SVG graph, compact role pill
 *   bar in split view or narrow viewports (<= 680px);
 * - #seq handoff stream cards + bottom human post bar (<MultiSelect> targets,
 *   orthogonal wake Switch, 15px input);
 * - Right 540px member detail drawer (<BoardMemberDrawer>).
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import {
  Callout,
  formatTime,
  HelmIcon,
  MultiSelect,
  Screen,
  ScreenSection,
  Select,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
  usePluginTranslator,
  type SelectOption,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  buildPostTargetOptions,
  canStartSwarmGroup,
  extractPostRefs,
  filterBoardPosts,
  isNarrowViewport,
  mergeBoardViewWithRead,
  parseBoardBadges,
  parseBoardReadPosts,
  parseBoardView,
  parseGroups,
  postKindBadgeClass,
  previewPostBody,
  resolveConversationBoardLink,
  shouldCollapsePostBody,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
} from './board-model.ts'
import {
  SW_ACTION_REFRESH,
  SW_ACTION_RETRY,
  SW_BOARD_CHANNEL_ALL,
  SW_BOARD_CHANNEL_TABS_ARIA,
  SW_BOARD_CLOSE_CLEAN,
  SW_BOARD_CLOSE_CLEAN_TITLE,
  SW_BOARD_DETACHED_BADGE,
  SW_BOARD_EMPTY_HINT,
  SW_BOARD_EMPTY_TITLE,
  SW_BOARD_GUARD_SHORT,
  SW_BOARD_OPEN_COORDINATOR,
  SW_BOARD_SELECT_CONV_ARIA,
  SW_BOARD_SELECT_GROUP_ARIA,
  SW_BOARD_STATUS_ACTIVE,
  SW_BOARD_STATUS_CLOSED,
  SW_BOARD_TITLE,
  SW_BOARD_UNLOCK_MERGE,
  SW_BOARD_UNLOCK_MERGE_TITLE,
  SW_BODY_COLLAPSE,
  SW_BODY_EXPAND,
  SW_FILTER_CLEAR,
  SW_LOADING_BOARD,
  SW_MERGE_REQUEST_SENT,
  SW_PASSIVE_NOTE_BADGE,
  SW_POST_INPUT_ARIA,
  SW_POST_INPUT_PLACEHOLDER,
  SW_POST_KIND_ARIA,
  SW_POST_SEND,
  SW_POST_SENDING,
  SW_POST_TARGETS_ARIA,
  SW_POST_TARGETS_PLACEHOLDER,
  SW_POST_VALIDATION_EMPTY,
  SW_POST_WAKE_LABEL,
  SW_POST_WAKE_NOTE_HINT,
  SW_REQUEST_MERGE_BTN,
  SW_RESCUE_BLOCKER_TITLE,
  SW_RESCUE_STALL_TITLE,
  SW_RESCUE_SWITCH_MODEL,
  SW_RESCUE_UNLOCK_MERGE,
  SW_RESCUE_UNMERGED_TITLE,
  SW_RESCUE_WAKE_BUTTON,
  SW_RETAINED_WT_TITLE,
  SW_START_GROUP_BUTTON,
  SW_STREAM_EMPTY,
  SW_STREAM_TITLE,
  SW_TOPO_SECTION_TITLE,
  swBuildCoordinatorMergeRequest,
  swFilterEdgeLabel,
  swFilterMemberLabel,
  swRescueWakeBody,
  swSnapshotSummary,
} from './copy.ts'
import { BoardTopologySection } from './BoardTopology.tsx'
import { BoardMemberDrawer } from './MemberDrawer.tsx'
import { SwarmGroupStarterDialog } from './StarterDialog.tsx'

const POST_KIND_OPTIONS: ReadonlyArray<SelectOption<BoardPostKind>> = [
  { value: 'handoff', label: 'handoff' },
  { value: 'comment', label: 'comment' },
  { value: 'review', label: 'review' },
  { value: 'brief', label: 'brief' },
  { value: 'blocker', label: 'blocker' },
  { value: 'done', label: 'done' },
]

function StreamPostCard({
  post,
  focused,
  onJumpSeq,
}: {
  post: BoardPost
  focused: boolean
  onJumpSeq: (seq: number) => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const [expanded, setExpanded] = useState(false)
  const collapsible = shouldCollapsePostBody(post.body)
  const refs = useMemo(() => extractPostRefs(post), [post])
  const targetsLabel =
    post.to.length > 0
      ? post.to.map((target) => (target.startsWith('#') || target === 'all' ? target : `@${target}`)).join(', ')
      : '-'

  return (
    <article
      className={`sw-post-card${focused ? ' is-focused' : ''}${post.wake ? '' : ' is-passive'}`}
      data-seq={post.seq}
    >
      <div className="sw-post-header">
        <span className="sw-post-seq mono tabular-nums">#{post.seq}</span>
        <span className="sw-post-route mono">
          <span className="sw-post-from">@{post.from}</span>
          <HelmIcon name="arrow-right" size={11} />
          <span className="sw-post-to">{targetsLabel}</span>
        </span>
        <span className={`badge ${postKindBadgeClass(post.kind)}`}>{post.kind}</span>
        {post.channel !== 'main' ? (
          <span className="badge badge-neutral mono">#{post.channel}</span>
        ) : null}
        {!post.wake ? (
          <span className="badge badge-neutral">{t(SW_PASSIVE_NOTE_BADGE)}</span>
        ) : null}
        {refs.map((refSeq) => (
          <button
            key={refSeq}
            type="button"
            className="btn btn-xs btn-ghost mono sw-ref-pill"
            onClick={() => onJumpSeq(refSeq)}
          >
            #{refSeq}
          </button>
        ))}
        {post.createdAt > 0 ? (
          <span className="sw-post-time tabular-nums">{formatTime(post.createdAt)}</span>
        ) : null}
      </div>

      {post.worktreeSnapshot !== undefined ? (
        <div className="sw-post-wt-pill">
          <HelmIcon name="git-branch" size={11} />
          <span className="mono">{swSnapshotSummary(post.worktreeSnapshot, locale)}</span>
          {post.worktreeSnapshot.changedFilesPreview.length > 0 ? (
            <span className="sw-muted mono">
              {post.worktreeSnapshot.changedFilesPreview.slice(0, 3).join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="sw-post-body selectable">
        {collapsible && !expanded ? previewPostBody(post.body) : post.body}
      </div>

      {collapsible ? (
        <div className="sw-post-footer">
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{expanded ? t(SW_BODY_COLLAPSE) : t(SW_BODY_EXPAND)}</span>
          </button>
        </div>
      ) : null}
    </article>
  )
}

export function BoardScreen(props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const rawBadges = usePluginDoc<BoardBadgesDoc>('board-badges')
  const badges = useMemo(() => parseBoardBadges(rawBadges), [rawBadges])
  const groups = useMemo(() => parseGroups(index), [index])

  const [viewportWidth, setViewportWidth] = useState<number | undefined>(() =>
    typeof window !== 'undefined' ? window.innerWidth : undefined,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const currentLink = useMemo(
    () => resolveConversationBoardLink(ctx.conversationId, badges, index),
    [ctx.conversationId, badges, index],
  )

  const paramGroupId = props.params['groupId']?.trim()
  const selectedGroupId =
    paramGroupId !== undefined && paramGroupId !== ''
      ? paramGroupId
      : currentLink?.groupId ?? groups[0]?.id

  const groupSummary = useMemo(
    () => (selectedGroupId !== undefined ? groups.find((g) => g.id === selectedGroupId) : undefined),
    [groups, selectedGroupId],
  )

  const shouldSubscribeLive =
    groupSummary !== undefined &&
    groupSummary.status === 'active' &&
    groupSummary.coordinatorDetached !== true

  const rawLiveBoard = usePluginSessionDoc(shouldSubscribeLive ? 'board-view' : '', {
    conversationId: shouldSubscribeLive ? groupSummary.coordinatorConversationId : undefined,
  })
  const liveBoard = useMemo(() => parseBoardView(rawLiveBoard), [rawLiveBoard])

  // Fallback snapshot state for closed / coordinatorDetached / deep-linked groups
  const [fallbackBoard, setFallbackBoard] = useState<BoardViewDoc | undefined>(undefined)
  const [fallbackLoading, setFallbackLoading] = useState(false)
  const [fallbackError, setFallbackError] = useState<string | undefined>(undefined)
  const loadGeneration = useRef(0)

  const loadSnapshotFallback = useCallback(
    async (targetGroupId: string): Promise<void> => {
      const gen = ++loadGeneration.current
      setFallbackLoading(true)
      setFallbackError(undefined)
      try {
        const [statusRaw, readRaw] = await Promise.all([
          ctx.callAction('board_status', { groupId: targetGroupId }),
          ctx.callAction('board_read', { groupId: targetGroupId, limit: 100 }),
        ])
        if (loadGeneration.current !== gen) return
        const parsedStatus = parseBoardView(statusRaw)
        if (parsedStatus === undefined) {
          setFallbackError('Invalid board_status response')
          return
        }
        const readPosts = parseBoardReadPosts(readRaw)
        setFallbackBoard(mergeBoardViewWithRead(parsedStatus, readPosts))
      } catch (err) {
        if (loadGeneration.current !== gen) return
        setFallbackError(err instanceof Error ? err.message : String(err))
      } finally {
        if (loadGeneration.current === gen) {
          setFallbackLoading(false)
        }
      }
    },
    [ctx],
  )

  useEffect(() => {
    loadGeneration.current += 1
    setFallbackError(undefined)
    if (selectedGroupId === undefined || selectedGroupId === '') {
      setFallbackBoard(undefined)
      setFallbackLoading(false)
      return
    }
    if (!shouldSubscribeLive) {
      void loadSnapshotFallback(selectedGroupId)
    } else {
      setFallbackLoading(false)
    }
  }, [selectedGroupId, shouldSubscribeLive, loadSnapshotFallback])

  const board = shouldSubscribeLive
    ? (liveBoard?.group.id === selectedGroupId
        ? liveBoard
        : fallbackBoard?.group.id === selectedGroupId
          ? fallbackBoard
          : undefined)
    : (fallbackBoard?.group.id === selectedGroupId
        ? fallbackBoard
        : liveBoard?.group.id === selectedGroupId
          ? liveBoard
          : undefined)

  // Local UI state
  const [drawerMemberName, setDrawerMemberName] = useState<string | undefined>(undefined)
  const [edgeFilter, setEdgeFilter] = useState<{ from: string; to: string } | undefined>(undefined)
  const [memberFilter, setMemberFilter] = useState<string | undefined>(undefined)
  const [controlPending, setControlPending] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | undefined>(undefined)

  // Human post composer state
  const [postTargets, setPostTargets] = useState<string[]>([])
  const [postKind, setPostKind] = useState<BoardPostKind>('handoff')
  const [postWake, setPostWake] = useState(true)
  const [postBody, setPostBody] = useState('')
  const [postSending, setPostSending] = useState(false)
  const [postError, setPostError] = useState<string | undefined>(undefined)

  // Empty-state starter dialog state
  const eligibleStarterConvs = useMemo(
    () => conversations.filter((c) => canStartSwarmGroup(c, index, badges)),
    [conversations, index, badges],
  )
  const [starterConvId, setStarterConvId] = useState<string>('')
  const [starterOpen, setStarterOpen] = useState(false)

  useEffect(() => {
    setEdgeFilter(undefined)
    setMemberFilter(undefined)
    setControlError(undefined)
    setPostError(undefined)
  }, [selectedGroupId])

  const activeChannel = props.params['channel']?.trim() || 'all'
  const highlightedWorker = props.params['worker']?.trim() || undefined
  const focusedSeq = useMemo(() => {
    const raw = props.params['seq']
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : undefined
  }, [props.params])

  const groupSelectOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = groups.map((g) => ({
      value: g.id,
      label: g.title,
      meta: g.status === 'active' ? t(SW_BOARD_STATUS_ACTIVE) : t(SW_BOARD_STATUS_CLOSED),
      icon: g.status === 'active' ? 'workflow' : 'archive',
    }))
    if (board !== undefined && !opts.some((o) => o.value === board.group.id)) {
      opts.unshift({
        value: board.group.id,
        label: board.group.title,
        meta: board.group.status === 'active' ? t(SW_BOARD_STATUS_ACTIVE) : t(SW_BOARD_STATUS_CLOSED),
        icon: board.group.status === 'active' ? 'workflow' : 'archive',
      })
    }
    return opts
  }, [groups, board, t])

  const visibleChannels = useMemo(
    () => (board ? board.group.channels.filter((ch) => ch.archived !== true) : []),
    [board],
  )

  const filteredPosts = useMemo(
    () =>
      board
        ? filterBoardPosts(board.posts, {
            channel: activeChannel,
            member: memberFilter,
            edge: edgeFilter,
          })
        : [],
    [board, activeChannel, memberFilter, edgeFilter],
  )

  const targetOptions = useMemo(
    () => (board ? buildPostTargetOptions(board) : []),
    [board],
  )

  const drawerMember = useMemo(
    () => (board && drawerMemberName ? board.members.find((m) => m.name === drawerMemberName) : undefined),
    [board, drawerMemberName],
  )

  const refreshIfFallback = useCallback((): void => {
    if (selectedGroupId !== undefined && (!shouldSubscribeLive || liveBoard === undefined)) {
      void loadSnapshotFallback(selectedGroupId)
    }
  }, [selectedGroupId, shouldSubscribeLive, liveBoard, loadSnapshotFallback])

  // ---- Control bar & rescue actions ----
  const handleToggleGuard = async (nextGuard: boolean): Promise<void> => {
    if (!board || controlPending !== null) return
    setControlPending('guard')
    setControlError(undefined)
    try {
      await ctx.callAction('update_group', {
        groupId: board.group.id,
        coordinatorGuard: nextGuard,
      })
      refreshIfFallback()
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlPending(null)
    }
  }

  const handleCloseGroup = async (keepWorktree: boolean): Promise<void> => {
    if (!board || controlPending !== null) return
    setControlPending(keepWorktree ? 'close-keep' : 'close-clean')
    setControlError(undefined)
    try {
      await ctx.callAction('close_group', {
        groupId: board.group.id,
        ...(keepWorktree ? { keepWorktree: true } : {}),
        ...(keepWorktree && board.activeWorkingMembers.length > 0 ? { abortRunning: true } : {}),
      })
      await loadSnapshotFallback(board.group.id)
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlPending(null)
    }
  }

  const handleRescueWake = async (): Promise<void> => {
    if (!board || controlPending !== null) return
    const target = board.headline.targetMember ?? 'coordinator'
    setControlPending('rescue-wake')
    setControlError(undefined)
    try {
      await ctx.callAction('board_post', {
        groupId: board.group.id,
        to: [target],
        kind: 'handoff',
        wake: true,
        ...(board.headline.refSeq !== undefined ? { refs: [board.headline.refSeq] } : {}),
        body: swRescueWakeBody(target, board.headline.refSeq, locale),
      })
      refreshIfFallback()
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlPending(null)
    }
  }

  const handleRequestRetainedMerge = async (
    wt: { memberName: string; worktreeId: string; branch: string; path: string; commitsAhead: number },
  ): Promise<void> => {
    if (!board || controlPending !== null) return
    setControlPending(`merge:${wt.worktreeId}`)
    setControlError(undefined)
    try {
      const text = swBuildCoordinatorMergeRequest(
        {
          groupId: board.group.id,
          memberName: wt.memberName,
          worktreeId: wt.worktreeId,
          branch: wt.branch,
          path: wt.path,
          commitsAhead: wt.commitsAhead,
        },
        locale,
      )
      await ctx.submitInput(text, {
        conversationId: board.group.coordinatorConversationId,
        whenBusy: 'followUp',
      })
      ctx.notify(t(SW_MERGE_REQUEST_SENT), 'info')
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlPending(null)
    }
  }

  const handleSubmitPost = async (): Promise<void> => {
    if (!board || postSending) return
    const trimmed = postBody.trim()
    if (postTargets.length === 0 || trimmed === '') {
      setPostError(t(SW_POST_VALIDATION_EMPTY))
      return
    }
    setPostSending(true)
    setPostError(undefined)
    try {
      await ctx.callAction('board_post', {
        groupId: board.group.id,
        ...(activeChannel !== 'all' ? { channel: activeChannel } : {}),
        to: postTargets,
        kind: postKind,
        wake: postWake,
        body: trimmed,
      })
      setPostBody('')
      refreshIfFallback()
    } catch (err) {
      setPostError(err instanceof Error ? err.message : String(err))
    } finally {
      setPostSending(false)
    }
  }

  // ---- Empty / Initial Loading States ----
  if (selectedGroupId === undefined) {
    if (index === undefined) {
      return (
        <Screen title={t(SW_BOARD_TITLE)}>
          <div className="loading-state" role="status">
            <HelmIcon name="loader" size={12} className="spin-slow" />
            <span>{t(SW_LOADING_BOARD)}</span>
          </div>
        </Screen>
      )
    }

    const effectiveConvId =
      starterConvId !== ''
        ? Number(starterConvId)
        : (ctx.conversationId ?? eligibleStarterConvs[0]?.id)
    const targetConv = eligibleStarterConvs.find((c) => c.id === effectiveConvId) ?? eligibleStarterConvs[0]

    return (
      <Screen title={t(SW_BOARD_TITLE)}>
        <div className="empty-state sw-board-empty">
          <HelmIcon name="workflow" size={20} />
          <strong>{t(SW_BOARD_EMPTY_TITLE)}</strong>
          <p className="sw-muted">{t(SW_BOARD_EMPTY_HINT)}</p>
          {eligibleStarterConvs.length > 0 ? (
            <div className="sw-empty-starter-row">
              <Select
                value={String(targetConv?.id ?? '')}
                options={eligibleStarterConvs.map((c) => ({
                  value: String(c.id),
                  label: c.title.trim() !== '' ? `${c.title} (#${c.id})` : `#${c.id}`,
                  icon: 'message-square',
                }))}
                aria-label={t(SW_BOARD_SELECT_CONV_ARIA)}
                onChange={(e) => setStarterConvId(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setStarterOpen(true)}
              >
                <HelmIcon name="workflow" size={12} />
                <span>{t(SW_START_GROUP_BUTTON)}</span>
              </button>
            </div>
          ) : null}
        </div>
        <SwarmGroupStarterDialog
          open={starterOpen}
          onOpenChange={setStarterOpen}
          targetConversation={targetConv}
          onCreated={(newGroupId) => {
            if (newGroupId !== undefined) {
              props.setParams({ groupId: newGroupId })
            }
          }}
        />
      </Screen>
    )
  }

  if (board === undefined) {
    return (
      <Screen title={t(SW_BOARD_TITLE)}>
        {fallbackError !== undefined ? (
          <Callout tone="err">
            <div className="sw-callout-row">
              <span>{fallbackError}</span>
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => void loadSnapshotFallback(selectedGroupId)}
              >
                {t(SW_ACTION_RETRY)}
              </button>
            </div>
          </Callout>
        ) : (
          <div className="loading-state" role="status">
            <HelmIcon name="loader" size={12} className="spin-slow" />
            <span>{t(SW_LOADING_BOARD)}</span>
          </div>
        )}
      </Screen>
    )
  }

  const compactTopology = props.isSplit || isNarrowViewport(viewportWidth)
  const isActiveGroup = board.group.status === 'active'
  const rescueMemberTarget =
    board.headline.targetMember ??
    board.members.find((m) => m.liveState === 'error' || m.liveState === 'blocked' || m.liveState === 'idle')?.name

  return (
    <Screen
      className="sw-board-screen"
      header={
        <div className="screen-header sw-board-header">
          <div className="sw-board-control-left">
            <Select
              value={board.group.id}
              options={groupSelectOptions}
              size="sm"
              prefixIcon="workflow"
              aria-label={t(SW_BOARD_SELECT_GROUP_ARIA)}
              onChange={(e) => {
                props.setParams({
                  groupId: e.target.value,
                  worker: undefined,
                  seq: undefined,
                })
              }}
            />
            <span className={`badge ${isActiveGroup ? 'badge-ok' : 'badge-neutral'}`}>
              {isActiveGroup ? t(SW_BOARD_STATUS_ACTIVE) : t(SW_BOARD_STATUS_CLOSED)}
            </span>
            {board.group.coordinatorDetached === true ? (
              <span className="badge badge-warn">{t(SW_BOARD_DETACHED_BADGE)}</span>
            ) : (
              <button
                type="button"
                className="btn btn-xs btn-ghost mono"
                title={t(SW_BOARD_OPEN_COORDINATOR)}
                onClick={() => ctx.openScreen(`conversation:${board.group.coordinatorConversationId}`)}
              >
                <HelmIcon name="message-square" size={11} />
                <span>#{board.group.coordinatorConversationId}</span>
              </button>
            )}
          </div>

          <div className="sw-board-control-right">
            <Switch
              checked={board.group.coordinatorGuard}
              onChange={(next) => void handleToggleGuard(next)}
              disabled={!isActiveGroup || controlPending !== null}
              label={t(SW_BOARD_GUARD_SHORT)}
              aria-label={t(SW_BOARD_GUARD_SHORT)}
            />

            {isActiveGroup ? (
              <>
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={controlPending !== null}
                  title={t(SW_BOARD_UNLOCK_MERGE_TITLE)}
                  onClick={() => void handleCloseGroup(true)}
                >
                  <HelmIcon name="git-pull-request" size={11} />
                  <span>{t(SW_BOARD_UNLOCK_MERGE)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-danger"
                  disabled={controlPending !== null}
                  title={t(SW_BOARD_CLOSE_CLEAN_TITLE)}
                  onClick={() => void handleCloseGroup(false)}
                >
                  <HelmIcon name="check-circle" size={11} />
                  <span>{t(SW_BOARD_CLOSE_CLEAN)}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={fallbackLoading}
                onClick={() => void loadSnapshotFallback(board.group.id)}
              >
                <HelmIcon name="rotate-cw" size={11} className={fallbackLoading ? 'spin-slow' : undefined} />
                <span>{t(SW_ACTION_REFRESH)}</span>
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* Channel Tabs */}
      <div className="sw-channel-tabs-row">
        <Tabs
          value={activeChannel}
          variant="segmented"
          size="sm"
          onValueChange={(next) => {
            props.setParams({ channel: next === 'all' ? undefined : next })
          }}
        >
          <TabsList aria-label={t(SW_BOARD_CHANNEL_TABS_ARIA)}>
            <TabsTrigger value="all">{t(SW_BOARD_CHANNEL_ALL)}</TabsTrigger>
            {visibleChannels.map((ch) => (
              <TabsTrigger key={ch.name} value={ch.name}>
                #{ch.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="sw-muted mono tabular-nums">
          {`head=#${board.group.headSeq} · active=${board.group.activeWorkerCount}`}
        </span>
      </div>

      {controlError !== undefined ? <Callout tone="err">{controlError}</Callout> : null}

      {/* 1-Line Headline Bar */}
      <div className={`sw-headline-bar tone-${board.headline.tone}`}>
        <HelmIcon
          name={
            board.headline.tone === 'err' || board.headline.tone === 'warn'
              ? 'alert-triangle'
              : board.headline.tone === 'ok'
                ? 'check-circle'
                : 'activity'
          }
          size={13}
        />
        <span className="sw-headline-text">{board.headline.text}</span>
        {board.activeWorkingMembers.length > 0 ? (
          <span className="badge badge-accent mono">
            {board.activeWorkingMembers.map((m) => `@${m}`).join(', ')}
          </span>
        ) : null}
      </div>

      {/* Rescue Callout Banner for stall / blocker / unmerged */}
      {board.headline.kind === 'stall' ||
      board.headline.kind === 'blocker' ||
      board.headline.kind === 'unmerged' ? (
        <Callout
          tone={board.headline.kind === 'blocker' ? 'err' : 'warn'}
          title={
            board.headline.kind === 'stall'
              ? t(SW_RESCUE_STALL_TITLE)
              : board.headline.kind === 'blocker'
                ? t(SW_RESCUE_BLOCKER_TITLE)
                : t(SW_RESCUE_UNMERGED_TITLE)
          }
        >
          <div className="sw-rescue-body">
            <span>{board.headline.text}</span>
            <div className="sw-rescue-actions">
              {board.headline.kind === 'stall' || board.headline.kind === 'blocker' ? (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={controlPending !== null || !isActiveGroup}
                  onClick={() => void handleRescueWake()}
                >
                  <HelmIcon name="bell" size={11} />
                  <span>{t(SW_RESCUE_WAKE_BUTTON)}</span>
                </button>
              ) : null}

              {board.headline.kind === 'blocker' && rescueMemberTarget !== undefined ? (
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => setDrawerMemberName(rescueMemberTarget)}
                >
                  <HelmIcon name="cpu" size={11} />
                  <span>{t(SW_RESCUE_SWITCH_MODEL)}</span>
                </button>
              ) : null}

              {board.headline.kind === 'unmerged' && isActiveGroup ? (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={controlPending !== null}
                  onClick={() => void handleCloseGroup(true)}
                >
                  <HelmIcon name="git-pull-request" size={11} />
                  <span>{t(SW_RESCUE_UNLOCK_MERGE)}</span>
                </button>
              ) : null}

              {board.headline.refSeq !== undefined ? (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost mono"
                  onClick={() => props.setParams({ seq: String(board.headline.refSeq) })}
                >
                  #{board.headline.refSeq}
                </button>
              ) : null}
            </div>
          </div>
        </Callout>
      ) : null}

      {/* Retained Worktrees Merge Panel (after close_group({ keepWorktree: true })) */}
      {board.group.retainedWorktrees !== undefined && board.group.retainedWorktrees.length > 0 ? (
        <ScreenSection title={t(SW_RETAINED_WT_TITLE)}>
          <div className="sw-retained-wt-list">
            {board.group.retainedWorktrees.map((wt) => (
              <div key={wt.worktreeId} className="sw-retained-wt-row">
                <div className="sw-retained-wt-info">
                  <span className="badge badge-neutral mono">@{wt.memberName}</span>
                  <span className="mono">{wt.branch}</span>
                  <span className="sw-muted mono">{wt.path}</span>
                  <span className="badge badge-accent tabular-nums">+{wt.commitsAhead}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={controlPending !== null || board.group.coordinatorDetached === true}
                  onClick={() => void handleRequestRetainedMerge(wt)}
                >
                  <HelmIcon name="git-pull-request" size={11} />
                  <span>{t(SW_REQUEST_MERGE_BTN)}</span>
                </button>
              </div>
            ))}
          </div>
        </ScreenSection>
      ) : null}

      {/* Adaptive Topology */}
      <ScreenSection title={t(SW_TOPO_SECTION_TITLE)}>
        <BoardTopologySection
          board={board}
          compact={compactTopology}
          highlightedWorker={highlightedWorker}
          activeEdgeFilter={edgeFilter}
          activeMemberFilter={memberFilter}
          onOpenMemberDrawer={(name) => setDrawerMemberName(name)}
          onToggleEdgeFilter={(edge) => {
            setMemberFilter(undefined)
            setEdgeFilter((prev) =>
              prev?.from === edge.from && prev?.to === edge.to ? undefined : edge,
            )
          }}
          onToggleMemberFilter={(name) => {
            setEdgeFilter(undefined)
            setMemberFilter((prev) => (prev === name ? undefined : name))
          }}
        />
      </ScreenSection>

      {/* #seq Handoff Stream */}
      <ScreenSection
        title={t(SW_STREAM_TITLE)}
        titleExtra={
          edgeFilter !== undefined || memberFilter !== undefined || focusedSeq !== undefined ? (
            <span className="sw-filter-bar">
              {edgeFilter !== undefined ? (
                <span className="badge badge-accent mono">
                  {swFilterEdgeLabel(edgeFilter.from, edgeFilter.to, locale)}
                </span>
              ) : null}
              {memberFilter !== undefined ? (
                <span className="badge badge-accent mono">
                  {swFilterMemberLabel(memberFilter, locale)}
                </span>
              ) : null}
              {focusedSeq !== undefined ? (
                <span className="badge badge-neutral mono">#{focusedSeq}</span>
              ) : null}
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => {
                  setEdgeFilter(undefined)
                  setMemberFilter(undefined)
                  if (focusedSeq !== undefined) {
                    props.setParams({ seq: undefined })
                  }
                }}
              >
                <HelmIcon name="x" size={11} />
                <span>{t(SW_FILTER_CLEAR)}</span>
              </button>
            </span>
          ) : (
            <span className="tabular-nums">{filteredPosts.length}</span>
          )
        }
      >
        {filteredPosts.length === 0 ? (
          <div className="sw-muted">{t(SW_STREAM_EMPTY)}</div>
        ) : (
          <div className="sw-stream-list">
            {filteredPosts.map((post) => (
              <StreamPostCard
                key={post.seq}
                post={post}
                focused={focusedSeq === post.seq}
                onJumpSeq={(targetSeq) => props.setParams({ seq: String(targetSeq) })}
              />
            ))}
          </div>
        )}
      </ScreenSection>

      {/* Bottom Human Direct Post Bar */}
      {isActiveGroup ? (
        <div className="sw-human-post-bar">
          {postError !== undefined ? <Callout tone="err">{postError}</Callout> : null}
          <div className="sw-human-post-controls">
            <MultiSelect
              value={postTargets}
              options={targetOptions}
              onValuesChange={setPostTargets}
              size="sm"
              prefixIcon="send"
              placeholder={t(SW_POST_TARGETS_PLACEHOLDER)}
              aria-label={t(SW_POST_TARGETS_ARIA)}
              disabled={postSending}
              className="sw-post-target-select"
            />
            <Select
              value={postKind}
              options={POST_KIND_OPTIONS}
              size="sm"
              aria-label={t(SW_POST_KIND_ARIA)}
              disabled={postSending}
              onChange={(e) => {
                const nextKind = e.target.value
                setPostKind(nextKind)
                setPostWake(nextKind !== 'comment')
              }}
            />
            <Switch
              checked={postWake}
              onChange={setPostWake}
              disabled={postSending}
              label={postWake ? t(SW_POST_WAKE_LABEL) : t(SW_POST_WAKE_NOTE_HINT)}
              aria-label={t(SW_POST_WAKE_LABEL)}
            />
          </div>
          <div className="sw-human-post-input-row">
            <textarea
              className="sw-post-input"
              rows={2}
              value={postBody}
              disabled={postSending}
              aria-label={t(SW_POST_INPUT_ARIA)}
              placeholder={t(SW_POST_INPUT_PLACEHOLDER)}
              onChange={(e) => setPostBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleSubmitPost()
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary sw-post-send-btn"
              disabled={postSending}
              onClick={() => void handleSubmitPost()}
            >
              <HelmIcon name={postSending ? 'loader' : 'send'} size={13} className={postSending ? 'spin-slow' : undefined} />
              <span>{postSending ? t(SW_POST_SENDING) : t(SW_POST_SEND)}</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* Right 540px Member Detail Drawer */}
      <BoardMemberDrawer
        board={board}
        member={drawerMember}
        onClose={() => setDrawerMemberName(undefined)}
        onMutated={refreshIfFallback}
      />
    </Screen>
  )
}
