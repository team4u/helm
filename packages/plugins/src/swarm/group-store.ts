/**
 * builtin:swarm 单真源协作组存储、投影指纹去重与双向游标批合并调度器。
 *
 * 四层存储职责：
 * 1) 唯一权威真源：<dataDir>/groups/<groupId>/{meta.json, board.jsonl}
 *    （按组串行队列 + withFileLock 互斥 + redactJsonValue 全量脱敏 + atomicWriteFile 原子替换）；
 * 2) 全局轻量反查索引：ctx.doc('index')（workers 与 groups 全量派生自单真源，零双写漂移）；
 * 3) 会话级实时看板投影：ctx.sessionDoc('board-view')（按 coordinatorConversationId 键控，
 *    以 (headSeq, memberStateDigest) 指纹去重，流式生成帧 0 写放大）；
 * 4) 顶栏与侧栏角标：ctx.doc('board-badges')（主控与全体活跃成员 O(1) 反查）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HelmxError,
  redactJsonValue,
  type HelmxPluginContext,
  type MaybePromise,
  type TurnOutcome,
} from '@helmx/protocol'
import {
  ACTIONABLE_WAKE_KINDS,
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_BATCH_WINDOW_MS,
  COORDINATOR_ESCALATION_KINDS,
  MAX_INDEX_CLOSED_GROUPS,
  SWARM_PLUGIN_ID,
  assertBoardPost,
  assertChannelName,
  assertCollabGroupRecord,
  assertGroupId,
  toGroupSummary,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type CollabChannelSpec,
  type CollabGroupRecord,
  type CollabGroupRuntime,
  type GroupMemberState,
  type MemberLiveState,
  type SwarmCoordinator,
  type SwarmWorkerPointer,
  type WorktreeHandoffSnapshot,
} from './contracts.js'
import {
  formatCoordinatorReportEnvelope,
  formatWorkerWakeupEnvelope,
  selectPostsForCoordinatorReport,
  selectPostsForMemberWakeup,
  synthesizeBoardView,
} from './board-router.js'
import {
  evaluateGroupQuiescence,
  evaluateSilentExit,
  type MemberRuntimeSnapshot,
} from './board-stall.js'
import { WORKFLOW_PLUGIN_ID } from './worktree-bridge.js'
import {
  classifyInflightIntent,
  classifyMemberDetailOutcome,
  inspectBoardWalLines,
  reconcileOrphanConversations,
  reconcileOrphanWorktreeHolds,
} from './recovery.js'
import { collectMemberLastReplySummary } from './settlement.js'

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function isLifecycleTeardownError(err: unknown): boolean {
  return (
    err instanceof HelmxError &&
    (err.code === 'plugin_disabled' || err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed')
  )
}

function generateGroupId(): string {
  return `grp_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

interface ScheduledReportEntry {
  readonly promise: Promise<void>
  trigger(delayMs: number): void
  cancel(): void
}

interface InflightWakeupEntry {
  readonly promise: Promise<void>
  requestRetry(fromTurnSettled?: boolean): void
}

export function createCollabGroupRuntime(
  ctx: HelmxPluginContext,
  getCoordinator: () => SwarmCoordinator,
): CollabGroupRuntime {
  const getGroupsRootDir = (): string => join(ctx.dataDir, 'groups')
  const groupsById = new Map<string, CollabGroupRecord>()
  const postsByGroup = new Map<string, BoardPost[]>()
  /** 按组内存串行队列（配合 withFileLock 保障严格 FIFO 写序）。 */
  const groupQueues = new Map<string, Promise<unknown>>()

  /** coordinatorConversationId -> 上次写入 sessionDoc('board-view') 的去重指纹。 */
  const writtenViewDigests = new Map<number, string>()
  /** 已写入过 board-view 的主控会话集合（用于清理或停止阶段核对）。 */
  const projectedCoordinators = new Set<number>()
  /** 上次写入 doc('index') / doc('board-badges') 的序列化快照。 */
  let writtenIndexJson = ''
  let writtenBadgesJson = ''

  /** 在途对等成员唤醒集合（key: `${groupId}:${memberName}`）。 */
  const inflightWakeups = new Map<string, InflightWakeupEntry>()
  /** 在途主控汇总调度/投递集合（覆盖整个 50ms 微批等待窗口与实际投递过程，零间隙跟踪）。 */
  const scheduledReports = new Map<string, ScheduledReportEntry>()
  /** 主控最近一次发出的 board-report 对应的发送前 completionSeq（防同回合连发）。 */
  const lastCoordReportCompletionSeq = new Map<string, number>()
  /** 活跃 Worker 会话受管锁释放句柄（仅锁活跃成员，归档/结单/删除/停用释放）。 */
  const managedWorkerReleases = new Map<number, () => void>()
  /** 标记某组最近一次向主控发出的报告时是否仍存在 activeWorkingMembers。 */
  const coordReportSawActiveWorkers = new Map<string, boolean>()

  let stopping = false
  let orphanWorktreesReconciled = false

  const logDiagnostic = (message: string): void => {
    console.error(`[swarm] ${ctx.host.redact(message)}`)
  }

  const groupDirOf = (groupId: string): string => join(getGroupsRootDir(), groupId)
  const metaPathOf = (groupId: string): string => join(groupDirOf(groupId), 'meta.json')
  const boardPathOf = (groupId: string): string => join(groupDirOf(groupId), 'board.jsonl')
  const reportLockPathOf = (groupId: string): string => join(groupDirOf(groupId), 'report.lock')
  const wakeupLockPathOf = (groupId: string, memberName: string): string =>
    join(groupDirOf(groupId), `wakeup-${memberName}.lock`)

  const redactObject = <T>(value: T): T =>
    redactJsonValue(value, (text) => ctx.host.redact(text)) as T

  /** 先追加并 datasync board.jsonl，再由调用方 atomicWriteFile(meta.json) 推进事务提交点。 */
  const appendBoardLineDurableLocked = async (groupId: string, post: BoardPost): Promise<void> => {
    await mkdir(groupDirOf(groupId), { recursive: true })
    const handle = await open(boardPathOf(groupId), 'a')
    try {
      await handle.writeFile(`${JSON.stringify(post)}\n`, 'utf8')
      await handle.datasync()
    } finally {
      await handle.close()
    }
  }

  const runGroupLocked = async <T>(groupId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = groupQueues.get(groupId) ?? Promise.resolve()
    const invoke = (): Promise<T> =>
      mkdir(groupDirOf(groupId), { recursive: true }).then(() =>
        ctx.host.withFileLock(metaPathOf(groupId), fn),
      )
    const run = prev.then(invoke, invoke)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    groupQueues.set(groupId, settled)
    try {
      return await run
    } finally {
      if (groupQueues.get(groupId) === settled) {
        groupQueues.delete(groupId)
      }
    }
  }

  const resolveMemberLive = (conversationId: number): { liveState: MemberLiveState; model?: string } => {
    const summary = getCoordinator().readConversationOrUndefined(conversationId)
    if (summary === undefined) return { liveState: 'missing' }
    return { liveState: summary.status, model: summary.model }
  }

  const hasOtherWorkingOrSettlingMember = (group: CollabGroupRecord, excludeConvId?: number): boolean => {
    const coord = getCoordinator()
    for (const m of group.members) {
      if (m.lifecycle !== 'active' || m.conversationId === excludeConvId) continue
      if (coord.settlingWorkers.has(m.conversationId)) return true
      const s = coord.readConversationOrUndefined(m.conversationId)
      if (s !== undefined && (s.status === 'working' || s.status === 'blocked')) return true
    }
    return false
  }

  const hasInflightWakeupsForGroup = (groupId: string): boolean => {
    const prefix = `${groupId}:`
    for (const key of inflightWakeups.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  const ensureWorkerManaged = (conversationId: number): void => {
    if (stopping || !getCoordinator().isActive() || managedWorkerReleases.has(conversationId)) return
    if (getCoordinator().readConversationOrUndefined(conversationId) === undefined) return
    managedWorkerReleases.set(conversationId, ctx.host.manageConversation(conversationId))
  }

  const releaseManagedWorker = (conversationId: number): void => {
    const release = managedWorkerReleases.get(conversationId)
    if (release === undefined) return
    managedWorkerReleases.delete(conversationId)
    try {
      release()
    } catch (err) {
      if (!isLifecycleTeardownError(err)) {
        getCoordinator().reportError(`释放受管 Worker 会话 #${conversationId} 保护失败`, err)
      }
    }
  }

  const releaseAllManagedWorkers = (): void => {
    for (const id of [...managedWorkerReleases.keys()]) {
      releaseManagedWorker(id)
    }
  }

  const reconcileManagedWorkersForGroup = (group: CollabGroupRecord): void => {
    if (stopping || !getCoordinator().isActive()) return
    if (group.status !== 'active') {
      coordReportSawActiveWorkers.delete(group.id)
      lastCoordReportCompletionSeq.delete(group.id)
      for (const m of group.members) {
        releaseManagedWorker(m.conversationId)
      }
      return
    }
    for (const m of group.members) {
      if (m.lifecycle === 'active') {
        ensureWorkerManaged(m.conversationId)
      } else {
        releaseManagedWorker(m.conversationId)
      }
    }
  }

  const syncIndex = (): void => {
    const coord = getCoordinator()
    if (stopping || coord.isShutdown()) return
    const activeGroups = [...groupsById.values()]
      .filter((g) => g.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const closedGroups = [...groupsById.values()]
      .filter((g) => g.status === 'closed')
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, MAX_INDEX_CLOSED_GROUPS)
    const ordered = [...activeGroups, ...closedGroups]
    const summaries = ordered.map((g) => toGroupSummary(g))
    const workers: SwarmWorkerPointer[] = activeGroups.flatMap((g) =>
      g.members
        .filter((m) => m.lifecycle === 'active')
        .map((m) => ({
          conversationId: m.conversationId,
          coordinatorConversationId: g.coordinatorConversationId,
          profileId: m.profileId,
          groupId: g.id,
          name: m.name,
          createdAt: m.createdAt,
        })),
    )
    const nextIndex = { workers, groups: summaries }
    const nextJson = JSON.stringify(nextIndex)
    if (nextJson !== writtenIndexJson) {
      coord.writeIndex(nextIndex)
      writtenIndexJson = nextJson
    }
  }

  const syncProjections = (): void => {
    const coord = getCoordinator()
    if (stopping || coord.isShutdown()) return
    const docs = coord.getDocs()
    const previewLimit = coord.getConfig().boardPreviewLimit

    const targetGroupByCoordinator = new Map<number, CollabGroupRecord>()
    const orderedGroups = [...groupsById.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    )
    for (const group of orderedGroups) {
      const existing = targetGroupByCoordinator.get(group.coordinatorConversationId)
      if (existing === undefined || (existing.status !== 'active' && group.status === 'active')) {
        targetGroupByCoordinator.set(group.coordinatorConversationId, group)
      }
    }

    const byConversation: BoardBadgesDoc['byConversation'] = {}

    for (const [coordId, group] of targetGroupByCoordinator) {
      const coordConv = coord.readConversationOrUndefined(coordId)
      const posts = postsByGroup.get(group.id)
      if (posts === undefined) {
        // 已结单且尚未按需懒加载 board.jsonl：不写空黑板假投影，清除陈旧投影以便面板走 board_status 回退
        if (projectedCoordinators.has(coordId) && coordConv !== undefined) {
          docs.boardView.set(coordId, null)
        }
        writtenViewDigests.delete(coordId)
        projectedCoordinators.delete(coordId)
        continue
      }
      const { view, digest, badge } = synthesizeBoardView({
        group,
        posts,
        previewLimit,
        resolveMemberLive,
      })

      if (coordConv !== undefined && !group.coordinatorDetached) {
        if (writtenViewDigests.get(coordId) !== digest) {
          docs.boardView.set(coordId, view)
          writtenViewDigests.set(coordId, digest)
          projectedCoordinators.add(coordId)
        }
      } else {
        writtenViewDigests.delete(coordId)
        projectedCoordinators.delete(coordId)
      }

      if (group.status === 'active') {
        if (coordConv !== undefined && !group.coordinatorDetached) {
          byConversation[String(coordId)] = badge
        }
        for (const member of group.members) {
          if (member.lifecycle !== 'active') continue
          if (coord.readConversationOrUndefined(member.conversationId) === undefined) continue
          byConversation[String(member.conversationId)] = badge
        }
      }
    }

    for (const coordId of [...projectedCoordinators]) {
      if (targetGroupByCoordinator.has(coordId)) continue
      if (coord.readConversationOrUndefined(coordId) !== undefined) {
        docs.boardView.set(coordId, null)
      }
      projectedCoordinators.delete(coordId)
      writtenViewDigests.delete(coordId)
    }

    const nextBadgesJson = JSON.stringify(byConversation)
    if (nextBadgesJson !== writtenBadgesJson) {
      docs.boardBadges.set({ byConversation })
      writtenBadgesJson = nextBadgesJson
    }
  }

  const persistMetaLocked = async (record: CollabGroupRecord): Promise<CollabGroupRecord> => {
    const clean = assertCollabGroupRecord(redactObject(structuredClone(record)))
    await mkdir(groupDirOf(clean.id), { recursive: true })
    await ctx.host.atomicWriteFile(metaPathOf(clean.id), `${JSON.stringify(clean, null, 2)}\n`)
    groupsById.set(clean.id, clean)
    reconcileManagedWorkersForGroup(clean)
    return clean
  }

  const mutateGroup = async <T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ): Promise<T> => {
    const validId = assertGroupId(groupId)
    const out = await runGroupLocked(validId, async () => {
      const current = groupsById.get(validId)
      if (current === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      const posts = postsByGroup.get(validId) ?? []
      const { group: next, result } = await fn(structuredClone(current), posts)
      await persistMetaLocked(next)
      return result
    })
    syncIndex()
    syncProjections()
    return out
  }

  const appendPost = async (
    groupId: string,
    draft: {
      channel: string
      from: string
      to: string[]
      resolvedTargets: string[]
      wake: boolean
      kind: BoardPostKind
      refs: number[]
      body: string
      idempotencyKey?: string
      worktreeSnapshot?: WorktreeHandoffSnapshot
      lastStallWatermarkAfterPost?: string
    },
  ): Promise<BoardPost> => {
    const validId = assertGroupId(groupId)
    let membersToWake: string[] = []
    let shouldNotifyCoordinator = false

    const createdPost = await runGroupLocked(validId, async () => {
      const current = groupsById.get(validId)
      if (current === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      if (draft.idempotencyKey !== undefined) {
        const existing = (postsByGroup.get(validId) ?? []).find(
          (p) => p.idempotencyKey === draft.idempotencyKey,
        )
        if (existing !== undefined) {
          if (existing.wake) {
            for (const target of existing.resolvedTargets) {
              if (target === 'coordinator') continue
              const m = current.members.find((item) => item.name === target && item.lifecycle === 'active')
              if (m !== undefined && m.pendingWakeupSeq > m.readCursorSeq) {
                membersToWake.push(m.name)
              }
            }
          }
          if (
            existing.from !== 'coordinator' &&
            ((existing.resolvedTargets.includes('coordinator') && existing.wake) ||
              COORDINATOR_ESCALATION_KINDS.has(existing.kind)) &&
            current.coordinatorPendingSeq > current.coordinatorNotifiedSeq
          ) {
            shouldNotifyCoordinator = true
          }
          return existing
        }
      }
      const next = structuredClone(current)
      const now = Date.now()
      const seq = next.headSeq + 1
      const rawPost: BoardPost = {
        seq,
        groupId: validId,
        channel: draft.channel,
        from: draft.from,
        to: [...draft.to],
        resolvedTargets: [...draft.resolvedTargets],
        wake: draft.wake,
        kind: draft.kind,
        refs: [...draft.refs],
        body: draft.body,
        ...(draft.idempotencyKey !== undefined ? { idempotencyKey: draft.idempotencyKey } : {}),
        ...(draft.worktreeSnapshot !== undefined ? { worktreeSnapshot: draft.worktreeSnapshot } : {}),
        createdAt: now,
      }
      const post = assertBoardPost(redactObject(rawPost))

      const sender = next.members.find((m) => m.name === post.from && m.lifecycle === 'active')
      if (sender !== undefined) {
        sender.lastPostSeq = post.seq
        sender.lastOutboundEdge = { seq: post.seq, to: [...post.to], kind: post.kind }
        if (sender.readCursorSeq === current.headSeq) {
          sender.readCursorSeq = post.seq
        }
      }

      membersToWake = []
      if (post.wake) {
        for (const target of post.resolvedTargets) {
          if (target === 'coordinator') continue
          const m = next.members.find((item) => item.name === target && item.lifecycle === 'active')
          if (m !== undefined) {
            m.pendingWakeupSeq = post.seq
            if (ACTIONABLE_WAKE_KINDS.has(post.kind)) {
              m.lastWakeTaskSeq = post.seq
            }
            membersToWake.push(m.name)
          }
        }
      }

      if (
        post.from !== 'coordinator' &&
        ((post.resolvedTargets.includes('coordinator') && post.wake) || COORDINATOR_ESCALATION_KINDS.has(post.kind))
      ) {
        next.coordinatorPendingSeq = post.seq
        shouldNotifyCoordinator = true
      }

      if (draft.lastStallWatermarkAfterPost !== undefined) {
        next.lastStallWatermark = draft.lastStallWatermarkAfterPost
      }

      next.headSeq = post.seq
      next.updatedAt = now

      await appendBoardLineDurableLocked(validId, post)
      await persistMetaLocked(next)
      const list = postsByGroup.get(validId) ?? []
      list.push(post)
      postsByGroup.set(validId, list)
      return post
    })

    syncIndex()
    syncProjections()

    for (const memberName of membersToWake) {
      void deliverWorkerWakeup(validId, memberName)
    }
    if (shouldNotifyCoordinator) {
      const latestGroup = groupsById.get(validId)
      const isUrgent = createdPost.kind === 'blocker' || createdPost.kind === 'stall'
      const workersBusy = latestGroup !== undefined && hasOtherWorkingOrSettlingMember(latestGroup)
      if (isUrgent || !workersBusy) {
        void scheduleCoordinatorReport(validId, COORDINATOR_BATCH_WINDOW_MS)
      }
    }

    return createdPost
  }

  const hasInflightDeliveriesForGroup = (groupId: string): boolean => {
    if (scheduledReports.has(groupId)) return true
    return hasInflightWakeupsForGroup(groupId)
  }

  /** 单次对等成员唤醒投递尝试。 */
  const executeSingleMemberWakeup = async (
    groupId: string,
    memberName: string,
    fromTurnSettled: boolean,
  ): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    const group = groupsById.get(groupId)
    if (group === undefined || group.status !== 'active') return
    const member = group.members.find((m) => m.name === memberName && m.lifecycle === 'active')
    if (member === undefined || member.pendingWakeupSeq <= member.readCursorSeq) return

    const summary = coord.readConversationOrUndefined(member.conversationId)
    if (summary === undefined) return
    const prevWakeCompletion = member.lastWakeCompletionSeq
    const isSettlingBusy = !fromTurnSettled && coord.settlingWorkers.has(member.conversationId)
    if (
      summary.status === 'working' ||
      summary.status === 'blocked' ||
      isSettlingBusy ||
      (prevWakeCompletion !== undefined && summary.completionSeq <= prevWakeCompletion)
    ) {
      return
    }

    const fromSeq = member.readCursorSeq + 1
    const toSeq = member.pendingWakeupSeq
    const allPosts = postsByGroup.get(groupId) ?? []
    const selected = selectPostsForMemberWakeup(member, allPosts, fromSeq, toSeq)
    if (selected.length === 0) {
      await mutateGroup(groupId, (draft) => {
        const target = draft.members.find((m) => m.name === memberName)
        if (target !== undefined) target.readCursorSeq = Math.max(target.readCursorSeq, toSeq)
        return { group: draft, result: undefined }
      })
      return
    }

    const envelope = formatWorkerWakeupEnvelope({
      group,
      member,
      posts: selected,
      fromSeq,
      toSeq,
    })
    const requestId = `swarm-wakeup:${groupId}:${memberName}:${fromSeq}-${toSeq}`
    const baseCompletionSeq = summary.completionSeq
    const baseLastEntryId = summary.lastEntryId ?? 0

    await mutateGroup(groupId, (draft) => {
      const target = draft.members.find((m) => m.name === memberName)
      if (target !== undefined) {
        target.inflightWakeup = {
          requestId,
          fromSeq,
          toSeq,
          baseCompletionSeq,
          baseLastEntryId,
        }
      }
      return { group: draft, result: undefined }
    })

    try {
      await ctx.host.submitInputGuarded(
        member.conversationId,
        envelope,
        {
          origin: 'agent',
          whenBusy: 'followUp',
          requestId,
          meta: {
            renderer: BOARD_WAKEUP_RENDERER,
            groupId,
            workerName: memberName,
            fromSeq,
            toSeq,
            postCount: selected.length,
          },
        },
        { expectedOwnership: 'helmx' },
      )
      await mutateGroup(groupId, (draft) => {
        const target = draft.members.find((m) => m.name === memberName)
        if (target !== undefined) {
          target.readCursorSeq = Math.max(target.readCursorSeq, toSeq)
          target.lastWakeCompletionSeq = baseCompletionSeq
          delete target.inflightWakeup
        }
        return { group: draft, result: undefined }
      })
    } catch (err) {
      await mutateGroup(groupId, (draft) => {
        const target = draft.members.find((m) => m.name === memberName)
        if (target !== undefined) {
          if (target.inflightWakeup?.requestId === requestId) {
            delete target.inflightWakeup
          }
          if (target.lastWakeCompletionSeq === baseCompletionSeq) {
            delete target.lastWakeCompletionSeq
          }
        }
        return { group: draft, result: undefined }
      }).catch(() => {})
      if (!isLifecycleTeardownError(err)) {
        coord.reportError(`协作组 ${groupId} 成员 @${memberName} 唤醒投递失败`, err)
      }
    }
  }

  /** 对单个对等成员执行合并唤醒（零间隙跟踪 + 在途并发重入安全）。 */
  const deliverWorkerWakeup = (
    groupId: string,
    memberName: string,
    opts?: { fromTurnSettled?: boolean },
  ): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) {
      return Promise.resolve()
    }
    const lockKey = `${groupId}:${memberName}`
    const existing = inflightWakeups.get(lockKey)
    if (existing !== undefined) {
      existing.requestRetry(opts?.fromTurnSettled)
      return existing.promise
    }

    let retryRequested = false
    let retryFromTurnSettled = opts?.fromTurnSettled === true

    let entryRef!: InflightWakeupEntry
    const promise = coord
      .track(`board-wakeup:${lockKey}`, () =>
        ctx.host.withFileLock(wakeupLockPathOf(groupId, memberName), async () => {
          let currentFromTurnSettled = retryFromTurnSettled
          for (;;) {
            retryRequested = false
            retryFromTurnSettled = false
            await executeSingleMemberWakeup(groupId, memberName, currentFromTurnSettled)
            if (!retryRequested || stopping || ctx.host.isClosing) break
            currentFromTurnSettled = retryFromTurnSettled
          }
        }),
      )
      .catch((err) => {
        if (!isLifecycleTeardownError(err)) {
          coord.reportError(`协作组 ${groupId} 唤醒任务异常`, err)
        }
      })
      .finally(() => {
        if (inflightWakeups.get(lockKey) === entryRef) {
          inflightWakeups.delete(lockKey)
        }
      })

    entryRef = {
      promise,
      requestRetry: (fromTurnSettled) => {
        retryRequested = true
        if (fromTurnSettled) retryFromTurnSettled = true
      },
    }
    inflightWakeups.set(lockKey, entryRef)
    return promise
  }

  /** 判定组是否需要向主控补发全员已空闲汇总（之前上报曾含 activeWorkingMembers，现全员 idle 且最新帖为 done）。 */
  const shouldSendCoordinatorIdleCatchup = (group: CollabGroupRecord, excludeSettlingConvId?: number): boolean => {
    if (coordReportSawActiveWorkers.get(group.id) !== true) return false
    if (hasOtherWorkingOrSettlingMember(group, excludeSettlingConvId)) return false
    if (hasInflightWakeupsForGroup(group.id)) return false
    if (group.members.some((m) => m.lifecycle === 'active' && m.pendingWakeupSeq > m.readCursorSeq)) return false
    const allPosts = postsByGroup.get(group.id) ?? []
    const latestPost = allPosts[allPosts.length - 1]
    return latestPost?.kind === 'done'
  }

  /** 执行主控汇总报告组装与投递（在 scheduledReports 单飞保护内执行）。 */
  const executeCoordinatorReportFlush = async (
    groupId: string,
    excludeSettlingConvId?: number,
  ): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    const group = groupsById.get(groupId)
    if (group === undefined || group.status !== 'active' || group.coordinatorDetached === true) return

    const hasPendingPosts = group.coordinatorPendingSeq > group.coordinatorNotifiedSeq
    const isIdleCatchup = !hasPendingPosts && shouldSendCoordinatorIdleCatchup(group, excludeSettlingConvId)
    if (!hasPendingPosts && !isIdleCatchup) return

    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    if (coordSummary === undefined) {
      await mutateGroup(groupId, (draft) => {
        draft.coordinatorDetached = true
        draft.updatedAt = Date.now()
        return { group: draft, result: undefined }
      })
      return
    }

    const prevCompletion = lastCoordReportCompletionSeq.get(groupId)
    if (
      coordSummary.status === 'working' ||
      coordSummary.status === 'blocked' ||
      (prevCompletion !== undefined && coordSummary.completionSeq <= prevCompletion)
    ) {
      return
    }

    const allPosts = postsByGroup.get(groupId) ?? []
    let fromSeq: number
    let toSeq: number
    let selected: BoardPost[]
    let requestId: string

    if (hasPendingPosts) {
      fromSeq = group.coordinatorNotifiedSeq + 1
      toSeq = group.coordinatorPendingSeq
      selected = selectPostsForCoordinatorReport(allPosts, fromSeq, toSeq)
      if (selected.length === 0) {
        await mutateGroup(groupId, (draft) => {
          draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, toSeq)
          return { group: draft, result: undefined }
        })
        return
      }
      requestId = `swarm-report:${groupId}:${fromSeq}-${toSeq}`
    } else {
      const latestPost = allPosts[allPosts.length - 1]
      if (latestPost === undefined) return
      fromSeq = latestPost.seq
      toSeq = group.headSeq
      selected = [latestPost]
      requestId = `swarm-report-idle:${groupId}:${group.headSeq}:${coordSummary.completionSeq}`
    }

    const { view } = synthesizeBoardView({
      group,
      posts: allPosts,
      previewLimit: coord.getConfig().boardPreviewLimit,
      resolveMemberLive,
    })
    const envelope = formatCoordinatorReportEnvelope({
      group,
      posts: selected,
      fromSeq,
      toSeq,
      activeWorkingMembers: view.activeWorkingMembers,
    })
    const baseCompletionSeq = coordSummary.completionSeq
    const baseLastEntryId = coordSummary.lastEntryId ?? 0
    const meta = {
      renderer: BOARD_REPORT_RENDERER,
      groupId,
      fromSeq,
      toSeq,
      postCount: selected.length,
      headline: view.headline.text,
    }

    await mutateGroup(groupId, (draft) => {
      draft.inflightReport = {
        requestId,
        fromSeq,
        toSeq,
        baseCompletionSeq,
        baseLastEntryId,
      }
      return { group: draft, result: undefined }
    })
    lastCoordReportCompletionSeq.set(groupId, baseCompletionSeq)
    try {
      const ownership = ctx.host.getConversationOwnership(group.coordinatorConversationId)
      if (ownership === 'helmx' || ownership === 'bot') {
        await ctx.host.submitInputGuarded(
          group.coordinatorConversationId,
          envelope,
          { origin: 'agent', whenBusy: 'followUp', requestId, meta },
          { expectedOwnership: ownership },
        )
      } else {
        await ctx.host.submitInput(group.coordinatorConversationId, envelope, {
          origin: 'agent',
          whenBusy: 'followUp',
          requestId,
          meta,
        })
      }
      if (view.activeWorkingMembers.length > 0) {
        coordReportSawActiveWorkers.set(groupId, true)
      } else {
        coordReportSawActiveWorkers.delete(groupId)
      }
      await mutateGroup(groupId, (draft) => {
        if (hasPendingPosts) {
          draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, toSeq)
        }
        delete draft.inflightReport
        return { group: draft, result: undefined }
      })
    } catch (err) {
      if (lastCoordReportCompletionSeq.get(groupId) === baseCompletionSeq) {
        lastCoordReportCompletionSeq.delete(groupId)
      }
      await mutateGroup(groupId, (draft) => {
        if (draft.inflightReport?.requestId === requestId) {
          delete draft.inflightReport
        }
        return { group: draft, result: undefined }
      }).catch(() => {})
      if (!isLifecycleTeardownError(err)) {
        coord.reportError(`协作组 ${groupId} 主控汇总投递失败`, err)
      }
    }
  }

  /**
   * 零间隙调度主控微批汇总：
   * - 同步进入 coord.track + ctx.host.withFileLock(reportLockPathOf)，确保整个 50ms 微批等待窗口与
   *   submitInput 投递期间 service.liveTasks() 与 PluginHost.activeTaskCount() 始终 >= 1；
   * - 冲刷期间若新到达汇报请求，通过 pendingRescheduleMs 在退出前重检循环，避免丢批；
   * - stopAndClear() 时通过 cancel() 立即中断定时器并干净退出。
   */
  const scheduleCoordinatorReport = (
    groupId: string,
    delayMs: number,
    excludeSettlingConvId?: number,
  ): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) {
      return Promise.resolve()
    }
    const existing = scheduledReports.get(groupId)
    if (existing !== undefined) {
      existing.trigger(delayMs)
      return existing.promise
    }

    let state: 'waiting' | 'flushing' | 'cancelled' = delayMs > 0 ? 'waiting' : 'flushing'
    let timer: NodeJS.Timeout | undefined
    let resolveWait: ((mode: 'flush' | 'cancel') => void) | undefined
    let pendingRescheduleMs: number | undefined

    const isCancelled = (): boolean => state === 'cancelled' || stopping
    const readState = (): 'waiting' | 'flushing' | 'cancelled' => state
    const consumePendingReschedule = (): number | undefined => {
      const value = pendingRescheduleMs
      pendingRescheduleMs = undefined
      return value
    }

    const wakeWaiter = (mode: 'flush' | 'cancel'): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      resolveWait?.(mode)
      resolveWait = undefined
    }

    const waitForDelay = (ms: number): Promise<'flush' | 'cancel'> => {
      if (ms <= 0 || readState() !== 'waiting' || stopping) {
        return Promise.resolve(isCancelled() ? 'cancel' : 'flush')
      }
      return new Promise<'flush' | 'cancel'>((resolve) => {
        resolveWait = resolve
        timer = setTimeout(() => {
          timer = undefined
          wakeWaiter('flush')
        }, ms)
        timer.unref?.()
      })
    }

    let entryRef!: ScheduledReportEntry
    const promise = coord
      .track(`board-report:${groupId}`, () =>
        ctx.host.withFileLock(reportLockPathOf(groupId), async () => {
          let nextDelay: number | undefined = delayMs
          while (nextDelay !== undefined) {
            if (isCancelled()) return
            if (nextDelay > 0 && readState() === 'waiting') {
              const mode = await waitForDelay(nextDelay)
              if (mode === 'cancel' || isCancelled()) return
            }
            state = 'flushing'
            pendingRescheduleMs = undefined
            await executeCoordinatorReportFlush(groupId, excludeSettlingConvId)
            if (isCancelled()) return
            const rescheduled = consumePendingReschedule()
            if (rescheduled === undefined) break
            const current = groupsById.get(groupId)
            if (
              current === undefined ||
              current.status !== 'active' ||
              current.coordinatorDetached === true ||
              (current.coordinatorPendingSeq <= current.coordinatorNotifiedSeq &&
                !shouldSendCoordinatorIdleCatchup(current, excludeSettlingConvId))
            ) {
              break
            }
            state = rescheduled > 0 ? 'waiting' : 'flushing'
            nextDelay = rescheduled
          }
        }),
      )
      .catch((err) => {
        if (!isLifecycleTeardownError(err)) {
          coord.reportError(`协作组 ${groupId} 汇总任务异常`, err)
        }
      })
      .finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (scheduledReports.get(groupId) === entryRef) {
          scheduledReports.delete(groupId)
        }
      })

    entryRef = {
      promise,
      trigger: (requestedDelayMs: number) => {
        if (state === 'cancelled') return
        if (state === 'waiting') {
          if (requestedDelayMs <= 0) {
            state = 'flushing'
            wakeWaiter('flush')
          }
          return
        }
        pendingRescheduleMs =
          pendingRescheduleMs === undefined
            ? requestedDelayMs
            : Math.min(pendingRescheduleMs, requestedDelayMs)
      },
      cancel: () => {
        state = 'cancelled'
        pendingRescheduleMs = undefined
        wakeWaiter('cancel')
      },
    }
    scheduledReports.set(groupId, entryRef)
    return promise
  }

  const flushCoordinatorReport = async (groupId: string, excludeSettlingConvId?: number): Promise<void> => {
    await scheduleCoordinatorReport(groupId, 0, excludeSettlingConvId)
  }

  /** 执行 6 条件 0-Token 全组静默守卫检查（排除当前正在收尾的 settlingConvId）。 */
  const checkAndEmitQuiescenceStall = async (groupId: string, settlingConvId?: number): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    const group = groupsById.get(groupId)
    if (group === undefined || group.status !== 'active' || group.coordinatorDetached === true) return

    const posts = postsByGroup.get(groupId) ?? []
    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    const prevCoordCompletion = lastCoordReportCompletionSeq.get(groupId)
    const coordInFlight =
      prevCoordCompletion !== undefined && coordSummary !== undefined && coordSummary.completionSeq <= prevCoordCompletion

    const coordinatorState: { exists: boolean; liveState: MemberLiveState } =
      coordSummary === undefined
        ? { exists: false, liveState: 'missing' }
        : { exists: true, liveState: coordInFlight ? 'working' : coordSummary.status }

    const memberSnapshots: MemberRuntimeSnapshot[] = group.members
      .filter((m) => m.lifecycle === 'active')
      .map((m) => {
        const s = coord.readConversationOrUndefined(m.conversationId)
        const isOtherSettling = m.conversationId !== settlingConvId && coord.settlingWorkers.has(m.conversationId)
        return {
          name: m.name,
          liveState: s === undefined ? 'missing' : s.status,
          completionSeq: s?.completionSeq ?? 0,
          isSettling: isOtherSettling,
          ...(m.lastWakeCompletionSeq !== undefined ? { lastWakeCompletionSeq: m.lastWakeCompletionSeq } : {}),
        }
      })

    const verdict = evaluateGroupQuiescence({
      group,
      posts,
      hasInflightDeliveries: hasInflightDeliveriesForGroup(groupId),
      coordinatorState,
      memberSnapshots,
    })
    if (!verdict.shouldEmitStall) return

    await appendPost(groupId, {
      channel: 'main',
      from: 'system',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'stall',
      refs: verdict.diagnosis.refSeq !== undefined ? [verdict.diagnosis.refSeq] : [],
      body: verdict.diagnosis.body,
      lastStallWatermarkAfterPost: verdict.nextWatermarkAfterPost,
    })
    await flushCoordinatorReport(groupId)
  }

  /** 从磁盘读取并校验单个协作组的 board.jsonl（严格校验并仅回滚至多 1 条未提交 WAL 尾）。 */
  const readAndHealBoardPostsLocked = async (
    groupId: string,
    expectedHeadSeq: number,
  ): Promise<BoardPost[]> => {
    let rawBoard = ''
    try {
      rawBoard = await readFile(boardPathOf(groupId), 'utf8')
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    const wal = inspectBoardWalLines(rawBoard, groupId, expectedHeadSeq)
    if (wal.trimmed) {
      logDiagnostic(
        `协作组 '${groupId}' 检测到未提交的 board.jsonl 尾行（${wal.trimReason}），已按 meta.headSeq=${expectedHeadSeq} 回滚截断`,
      )
      const cleanText = wal.posts.length > 0 ? `${wal.posts.map((p) => JSON.stringify(p)).join('\n')}\n` : ''
      await ctx.host.atomicWriteFile(boardPathOf(groupId), cleanText)
    }
    return wal.posts
  }

  /** 从磁盘加载单个协作组账本；closed 组启动期仅加载 meta.json，board.jsonl 延后至首次按需读。 */
  const loadGroupFromDisk = async (
    groupId: string,
  ): Promise<{ record: CollabGroupRecord; posts: BoardPost[] | undefined }> => {
    return runGroupLocked(groupId, async () => {
      let rawMetaText: string
      try {
        rawMetaText = await readFile(metaPathOf(groupId), 'utf8')
      } catch (err) {
        throw new HelmxError(
          'swarm_doc_corrupt',
          `协作组 '${groupId}' 缺少或无法读取 meta.json：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId: SWARM_PLUGIN_ID, groupId },
        )
      }
      let parsedMeta: unknown
      try {
        parsedMeta = JSON.parse(rawMetaText)
      } catch (err) {
        throw new HelmxError(
          'swarm_doc_corrupt',
          `协作组 '${groupId}' meta.json JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId: SWARM_PLUGIN_ID, groupId },
        )
      }
      let record = assertCollabGroupRecord(parsedMeta)
      if (record.id !== groupId) {
        throw new HelmxError(
          'swarm_doc_corrupt',
          `协作组目录 '${groupId}' 与 meta.json.id '${record.id}' 不一致`,
          500,
          { pluginId: SWARM_PLUGIN_ID, groupId },
        )
      }

      let posts: BoardPost[] | undefined
      if (record.status === 'active') {
        posts = await readAndHealBoardPostsLocked(groupId, record.headSeq)
        if (!record.coordinatorDetached) {
          if (getCoordinator().readConversationOrUndefined(record.coordinatorConversationId) === undefined) {
            record = await persistMetaLocked({ ...record, coordinatorDetached: true, updatedAt: Date.now() })
          }
        }
      }
      return { record, posts }
    })
  }

  const ensurePostsLoaded = async (groupId: string): Promise<readonly BoardPost[]> => {
    const validId = assertGroupId(groupId)
    const cached = postsByGroup.get(validId)
    if (cached !== undefined) return cached
    return runGroupLocked(validId, async () => {
      const again = postsByGroup.get(validId)
      if (again !== undefined) return again
      const current = groupsById.get(validId)
      if (current === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      const parsed = await readAndHealBoardPostsLocked(validId, current.headSeq)
      postsByGroup.set(validId, parsed)
      return parsed
    })
  }

  /** 活跃成员会话缺失/被删时自愈：释放 worktreeHold、归档成员、发 [blocker]，防止 missing 永久卡死静默检测。 */
  const reconcileDeletedWorker = async (groupId: string, conversationId: number): Promise<void> => {
    const coord = getCoordinator()
    releaseManagedWorker(conversationId)
    const current = groupsById.get(groupId)
    if (current === undefined || current.status !== 'active') return
    const targetMember = current.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
    if (targetMember === undefined) return

    if (targetMember.worktreeId !== undefined) {
      try {
        await ctx.host.invokeAction(WORKFLOW_PLUGIN_ID, 'release_worktree_hold', {
          worktreeId: targetMember.worktreeId,
          pluginId: SWARM_PLUGIN_ID,
          holdId: `${groupId}:${targetMember.name}`,
        })
      } catch (err) {
        if (
          !(
            err instanceof HelmxError &&
            (err.code === 'not_found' || err.code === 'plugin_disabled' || err.code === 'unknown_action')
          )
        ) {
          coord.reportError(`释放已删除成员 @${targetMember.name} 的工作树持有锁失败`, err)
        }
      }
    }

    let archivedName: string | undefined
    let prevTaskSeq: number | undefined
    await mutateGroup(groupId, (draft) => {
      if (draft.status !== 'active') return { group: draft, result: undefined }
      const target = draft.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
      if (target === undefined) return { group: draft, result: undefined }
      archivedName = target.name
      prevTaskSeq = target.lastWakeTaskSeq
      target.lifecycle = 'archived'
      target.archivedAt = Date.now()
      delete target.lastWakeTaskSeq
      delete target.silentExitNudgeSeq
      delete target.lastWakeCompletionSeq
      delete target.inflightWakeup
      delete target.inflightNudge
      draft.updatedAt = Date.now()
      return { group: draft, result: undefined }
    })

    if (archivedName !== undefined) {
      await appendPost(groupId, {
        channel: 'main',
        from: 'system',
        to: ['coordinator'],
        resolvedTargets: ['coordinator'],
        wake: true,
        kind: 'blocker',
        refs: prevTaskSeq !== undefined ? [prevTaskSeq] : [],
        body: `Member @${archivedName} (#${conversationId}) conversation was deleted while active; worktree hold released and member archived.`,
      })
    }
  }

  /** 对账单组成员重启前登记的在途唤醒/续催意图与过期完成水位。 */
  const reconcileMemberRecoveryState = async (
    groupId: string,
    memberSnapshot: GroupMemberState,
  ): Promise<void> => {
    const coord = getCoordinator()
    const summary = coord.readConversationOrUndefined(memberSnapshot.conversationId)

    let clearWakeupAction: 'none' | 'missing' | 'active' | 'settled' | 'uncommitted' = 'none'
    if (memberSnapshot.inflightWakeup !== undefined) {
      const status = await classifyInflightIntent(
        ctx.host,
        memberSnapshot.conversationId,
        summary,
        memberSnapshot.inflightWakeup,
      )
      clearWakeupAction = status === 'missing_conv' ? 'missing' : status
    }

    let clearNudgeAction: 'none' | 'missing' | 'active' | 'settled' | 'uncommitted' = 'none'
    if (memberSnapshot.inflightNudge !== undefined) {
      const status = await classifyInflightIntent(
        ctx.host,
        memberSnapshot.conversationId,
        summary,
        memberSnapshot.inflightNudge,
      )
      clearNudgeAction = status === 'missing_conv' ? 'missing' : status
    }

    let clearStaleCompletionSeq = false
    if (
      clearWakeupAction === 'none' &&
      clearNudgeAction === 'none' &&
      summary !== undefined &&
      summary.status !== 'working' &&
      summary.status !== 'blocked' &&
      memberSnapshot.pendingWakeupSeq <= memberSnapshot.readCursorSeq &&
      memberSnapshot.lastWakeCompletionSeq !== undefined &&
      summary.completionSeq <= memberSnapshot.lastWakeCompletionSeq
    ) {
      if (memberSnapshot.lastWakeTaskSeq !== undefined && (memberSnapshot.lastPostSeq ?? 0) >= memberSnapshot.lastWakeTaskSeq) {
        clearStaleCompletionSeq = true
      } else if (memberSnapshot.lastWakeTaskSeq === undefined) {
        clearStaleCompletionSeq = true
      }
    }

    if (clearWakeupAction === 'none' && clearNudgeAction === 'none' && !clearStaleCompletionSeq) {
      return
    }

    await mutateGroup(groupId, (draft) => {
      const target = draft.members.find((m) => m.name === memberSnapshot.name)
      if (target === undefined) return { group: draft, result: undefined }

      if (clearWakeupAction !== 'none' && target.inflightWakeup !== undefined) {
        const inflight = target.inflightWakeup
        if (clearWakeupAction === 'active') {
          target.readCursorSeq = Math.max(target.readCursorSeq, inflight.toSeq)
          target.lastWakeCompletionSeq = inflight.baseCompletionSeq
        } else if (clearWakeupAction === 'settled') {
          target.readCursorSeq = Math.max(target.readCursorSeq, inflight.toSeq)
          if (target.lastWakeCompletionSeq === inflight.baseCompletionSeq) {
            delete target.lastWakeCompletionSeq
          }
        } else if (clearWakeupAction === 'uncommitted') {
          if (target.lastWakeCompletionSeq === inflight.baseCompletionSeq) {
            delete target.lastWakeCompletionSeq
          }
        }
        delete target.inflightWakeup
      }

      if (clearNudgeAction !== 'none' && target.inflightNudge !== undefined) {
        const inflight = target.inflightNudge
        if (clearNudgeAction === 'active') {
          target.lastWakeCompletionSeq = inflight.baseCompletionSeq
        } else if (clearNudgeAction === 'settled') {
          if (target.lastWakeCompletionSeq === inflight.baseCompletionSeq) {
            delete target.lastWakeCompletionSeq
          }
        } else if (clearNudgeAction === 'uncommitted') {
          if (target.lastWakeCompletionSeq === inflight.baseCompletionSeq) {
            delete target.lastWakeCompletionSeq
          }
          if (target.silentExitNudgeSeq === inflight.taskSeq) {
            delete target.silentExitNudgeSeq
          }
        }
        delete target.inflightNudge
      }

      if (clearStaleCompletionSeq) {
        delete target.lastWakeCompletionSeq
      }

      return { group: draft, result: undefined }
    })
  }

  /** 对账单个活跃协作组重启后的在途意图、未送达投递与已停机成员自愈检查。 */
  const reconcileSingleRecoveredGroup = async (groupId: string): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    const initialGroup = groupsById.get(groupId)
    if (initialGroup === undefined || initialGroup.status !== 'active') return

    if (initialGroup.inflightReport !== undefined) {
      const inflight = initialGroup.inflightReport
      if (initialGroup.coordinatorDetached) {
        await mutateGroup(groupId, (draft) => {
          delete draft.inflightReport
          return { group: draft, result: undefined }
        })
      } else {
        const coordSummary = coord.readConversationOrUndefined(initialGroup.coordinatorConversationId)
        const reportStatus = await classifyInflightIntent(
          ctx.host,
          initialGroup.coordinatorConversationId,
          coordSummary,
          inflight,
        )
        await mutateGroup(groupId, (draft) => {
          if (draft.inflightReport?.requestId === inflight.requestId) {
            if (reportStatus === 'active' || reportStatus === 'settled') {
              draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, inflight.toSeq)
            }
            delete draft.inflightReport
          }
          return { group: draft, result: undefined }
        })
        if (reportStatus === 'active') {
          lastCoordReportCompletionSeq.set(groupId, inflight.baseCompletionSeq)
        }
      }
    }

    const activeMembers = initialGroup.members.filter((m) => m.lifecycle === 'active')
    for (const member of activeMembers) {
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      await reconcileMemberRecoveryState(groupId, member)
    }

    const freshGroup = groupsById.get(groupId)
    if (freshGroup === undefined || freshGroup.status !== 'active') return

    for (const member of freshGroup.members) {
      if (member.lifecycle !== 'active') continue
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      if (member.pendingWakeupSeq > member.readCursorSeq) {
        void deliverWorkerWakeup(freshGroup.id, member.name)
        continue
      }
      if (member.lastWakeTaskSeq === undefined || (member.lastPostSeq ?? 0) >= member.lastWakeTaskSeq) {
        continue
      }
      const summary = coord.readConversationOrUndefined(member.conversationId)
      if (summary === undefined || summary.status === 'working' || summary.status === 'blocked') continue

      let entries = [] as Awaited<ReturnType<typeof ctx.host.getConversationDetail>>['entries']
      if (summary.status !== 'error') {
        try {
          entries = (await ctx.host.getConversationDetail(member.conversationId, { limit: 30 })).entries
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') continue
          throw err
        }
      }
      const classified = classifyMemberDetailOutcome(entries, summary, freshGroup.id, member)
      if (classified.kind === 'pending_queue') continue

      const lastReplySummary =
        classified.kind === 'aborted' ? '' : await collectMemberLastReplySummary(ctx.host, member.conversationId)
      await runtimeHandle.onMemberTurnSettled({
        groupId: freshGroup.id,
        memberName: member.name,
        conversationId: member.conversationId,
        completionSeq: summary.completionSeq,
        outcome: classified.kind,
        ...(classified.kind === 'failed' && classified.error !== undefined ? { error: classified.error } : {}),
        lastReplySummary,
      })
    }

    const latestGroup = groupsById.get(groupId)
    if (latestGroup === undefined || latestGroup.status !== 'active' || latestGroup.coordinatorDetached) return
    if (latestGroup.coordinatorPendingSeq > latestGroup.coordinatorNotifiedSeq) {
      const groupPosts = postsByGroup.get(latestGroup.id) ?? []
      const hasUrgentPost = groupPosts.some(
        (p) =>
          p.seq > latestGroup.coordinatorNotifiedSeq &&
          p.seq <= latestGroup.coordinatorPendingSeq &&
          (p.kind === 'blocker' || p.kind === 'stall'),
      )
      if (hasUrgentPost || !hasOtherWorkingOrSettlingMember(latestGroup)) {
        void scheduleCoordinatorReport(latestGroup.id, 0)
      }
    } else if (!hasInflightDeliveriesForGroup(latestGroup.id)) {
      await checkAndEmitQuiescenceStall(latestGroup.id)
    }
  }

  const runtimeHandle: CollabGroupRuntime = {
    async loadAllFromDisk(): Promise<void> {
      stopping = false
      orphanWorktreesReconciled = false
      releaseAllManagedWorkers()
      groupsById.clear()
      postsByGroup.clear()
      groupQueues.clear()
      writtenViewDigests.clear()
      projectedCoordinators.clear()
      writtenIndexJson = ''
      writtenBadgesJson = ''
      lastCoordReportCompletionSeq.clear()
      coordReportSawActiveWorkers.clear()

      let dirEntries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        dirEntries = await readdir(getGroupsRootDir(), { withFileTypes: true })
      } catch (err) {
        if (!isEnoent(err)) throw err
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const groupId = assertGroupId(entry.name)
        const { record, posts } = await loadGroupFromDisk(groupId)
        groupsById.set(groupId, record)
        if (posts !== undefined) {
          postsByGroup.set(groupId, posts)
        }
      }

      for (const group of [...groupsById.values()]) {
        if (group.status !== 'active') continue
        for (const member of [...group.members]) {
          if (member.lifecycle !== 'active') continue
          if (getCoordinator().readConversationOrUndefined(member.conversationId) === undefined) {
            await reconcileDeletedWorker(group.id, member.conversationId)
          } else {
            ensureWorkerManaged(member.conversationId)
          }
        }
      }

      syncIndex()
      syncProjections()
    },

    async reconcileOrphansOnBoot(): Promise<void> {
      if (stopping) return
      await reconcileOrphanConversations(ctx, groupsById.values())
      orphanWorktreesReconciled = await reconcileOrphanWorktreeHolds(ctx, groupsById.values(), logDiagnostic)
    },

    async reconcileRecoveredGroups(): Promise<void> {
      const coord = getCoordinator()
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      if (!orphanWorktreesReconciled) {
        orphanWorktreesReconciled = await reconcileOrphanWorktreeHolds(ctx, groupsById.values(), logDiagnostic)
      }
      for (const group of [...groupsById.values()]) {
        if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
        if (group.status !== 'active') continue
        await reconcileSingleRecoveredGroup(group.id)
      }
      syncProjections()
    },

    async stopAndClear(): Promise<void> {
      stopping = true
      const pendingReports = [...scheduledReports.values()]
      for (const entry of pendingReports) entry.cancel()
      const pendingWakeups = [...inflightWakeups.values()]
      await Promise.allSettled([
        ...pendingReports.map((entry) => entry.promise),
        ...pendingWakeups.map((entry) => entry.promise),
      ])
      releaseAllManagedWorkers()
      scheduledReports.clear()
      inflightWakeups.clear()
      lastCoordReportCompletionSeq.clear()
      coordReportSawActiveWorkers.clear()
      groupQueues.clear()
      groupsById.clear()
      postsByGroup.clear()
      writtenViewDigests.clear()
      projectedCoordinators.clear()
      writtenIndexJson = ''
      writtenBadgesJson = ''
    },

    liveTaskLabels(): string[] {
      const labels: string[] = []
      for (const groupId of scheduledReports.keys()) {
        labels.push(`board-report-schedule:${groupId}`)
      }
      for (const lockKey of inflightWakeups.keys()) {
        labels.push(`board-wakeup:${lockKey}`)
      }
      return labels
    },

    inUseItems(): Array<{ kind: string; id: string; label: string }> {
      const items: Array<{ kind: string; id: string; label: string }> = []
      for (const group of groupsById.values()) {
        if (group.status !== 'active') continue
        items.push({
          kind: 'swarm_group',
          id: group.id,
          label: `Active swarm collaboration group "${group.title}" (${group.id})`,
        })
      }
      return items
    },

    listGroups(): CollabGroupRecord[] {
      return [...groupsById.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    },

    getGroup(groupId: string): CollabGroupRecord | undefined {
      return groupsById.get(groupId)
    },

    findActiveGroupByCoordinator(conversationId: number): CollabGroupRecord | undefined {
      for (const group of groupsById.values()) {
        if (group.status === 'active' && group.coordinatorConversationId === conversationId) {
          return group
        }
      }
      return undefined
    },

    findGroupByParticipant(conversationId: number) {
      for (const group of groupsById.values()) {
        if (group.status !== 'active') continue
        if (group.coordinatorConversationId === conversationId) {
          return { group, role: 'coordinator' as const }
        }
        const member = group.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
        if (member !== undefined) {
          return { group, role: 'worker' as const, member }
        }
      }
      return undefined
    },

    findLatestGroupForConversation(conversationId: number): CollabGroupRecord | undefined {
      const active = this.findGroupByParticipant(conversationId)
      if (active !== undefined) return active.group
      const candidates = [...groupsById.values()]
        .filter(
          (g) =>
            g.coordinatorConversationId === conversationId ||
            g.members.some((m) => m.conversationId === conversationId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      return candidates[0]
    },

    getPosts(groupId: string): readonly BoardPost[] {
      return postsByGroup.get(groupId) ?? []
    },

    ensurePostsLoaded,

    buildBoardView(groupId: string): BoardViewDoc {
      const validId = assertGroupId(groupId)
      const group = groupsById.get(validId)
      if (group === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      const posts = postsByGroup.get(validId) ?? []
      const { view } = synthesizeBoardView({
        group,
        posts,
        previewLimit: getCoordinator().getConfig().boardPreviewLimit,
        resolveMemberLive,
      })
      return view
    },

    syncProjections,

    onConversationUpsert(conversationId: number): void {
      if (stopping) return
      let relevant = false
      for (const group of groupsById.values()) {
        if (
          group.coordinatorConversationId === conversationId ||
          group.members.some((m) => m.conversationId === conversationId)
        ) {
          relevant = true
          break
        }
      }
      if (!relevant) return
      syncProjections()
    },

    async onConversationDeleted(conversationId: number): Promise<void> {
      if (stopping) return
      releaseManagedWorker(conversationId)
      for (const group of [...groupsById.values()]) {
        if (group.coordinatorConversationId === conversationId && !group.coordinatorDetached) {
          await mutateGroup(group.id, (draft) => {
            draft.coordinatorDetached = true
            draft.updatedAt = Date.now()
            return { group: draft, result: undefined }
          })
        } else if (group.status === 'active' && group.members.some((m) => m.conversationId === conversationId && m.lifecycle === 'active')) {
          await reconcileDeletedWorker(group.id, conversationId)
        } else if (group.members.some((m) => m.conversationId === conversationId)) {
          syncProjections()
        }
      }
      projectedCoordinators.delete(conversationId)
      writtenViewDigests.delete(conversationId)
    },

    async createGroup(input): Promise<CollabGroupRecord> {
      const existing = this.findActiveGroupByCoordinator(input.coordinatorConversationId)
      if (existing !== undefined) {
        if (input.createKey !== undefined && existing.createKey === input.createKey) {
          return existing
        }
        throw new HelmxError(
          'swarm_group_already_active',
          `会话 #${input.coordinatorConversationId} 已存在活跃协作组 '${existing.id}'（同会话限 1 个活跃组）`,
          409,
          {
            pluginId: SWARM_PLUGIN_ID,
            conversationId: input.coordinatorConversationId,
            groupId: existing.id,
          },
        )
      }

      const channels: CollabChannelSpec[] = [{ name: 'main' }]
      for (const extra of input.channels ?? []) {
        const chName = assertChannelName(extra.name)
        if (chName === 'main') continue
        if (channels.some((c) => c.name === chName)) continue
        channels.push({
          name: chName,
          ...(extra.topic !== undefined && extra.topic.trim() !== '' ? { topic: extra.topic.trim() } : {}),
        })
      }

      const now = Date.now()
      const groupId = generateGroupId()
      const record: CollabGroupRecord = {
        id: groupId,
        title: input.title.trim(),
        ...(input.objective !== undefined && input.objective.trim() !== '' ? { objective: input.objective.trim() } : {}),
        coordinatorConversationId: input.coordinatorConversationId,
        ...(input.createKey !== undefined ? { createKey: input.createKey } : {}),
        status: 'active',
        channels,
        members: [],
        headSeq: 0,
        coordinatorNotifiedSeq: 0,
        coordinatorPendingSeq: 0,
        createdAt: now,
        updatedAt: now,
      }

      const saved = await runGroupLocked(groupId, async () => {
        postsByGroup.set(groupId, [])
        return persistMetaLocked(record)
      })
      syncIndex()
      syncProjections()
      return saved
    },

    async updateGroup(groupId, patch): Promise<CollabGroupRecord> {
      return mutateGroup(groupId, (draft) => {
        if (draft.status !== 'active') {
          throw new HelmxError('swarm_group_closed', `协作组 '${draft.id}' 已结单，无法修改`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: draft.id,
          })
        }
        if (patch.title !== undefined) {
          const t = patch.title.trim()
          if (t === '') throw new HelmxError('validation_error', 'title 不能为空', 400, {})
          draft.title = t
        }
        if (patch.objective !== undefined) {
          const obj = patch.objective.trim()
          if (obj === '') delete draft.objective
          else draft.objective = obj
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: draft }
      })
    },

    async manageChannel(groupId, input): Promise<CollabGroupRecord> {
      const chName = assertChannelName(input.channel)
      return mutateGroup(groupId, (draft) => {
        if (draft.status !== 'active') {
          throw new HelmxError('swarm_group_closed', `协作组 '${draft.id}' 已结单，无法管理频道`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: draft.id,
          })
        }
        if (input.op === 'create') {
          const existing = draft.channels.find((c) => c.name === chName)
          if (existing !== undefined) {
            if (existing.archived === true) {
              delete existing.archived
              if (input.topic !== undefined && input.topic.trim() !== '') existing.topic = input.topic.trim()
            } else {
              throw new HelmxError('swarm_channel_conflict', `频道 '${chName}' 已存在`, 409, {
                pluginId: SWARM_PLUGIN_ID,
                groupId: draft.id,
                channel: chName,
              })
            }
          } else {
            draft.channels.push({
              name: chName,
              ...(input.topic !== undefined && input.topic.trim() !== '' ? { topic: input.topic.trim() } : {}),
            })
          }
        } else if (input.op === 'archive') {
          if (chName === 'main') {
            throw new HelmxError('validation_error', "主频道 'main' 禁止归档", 400, { channel: chName })
          }
          const ch = draft.channels.find((c) => c.name === chName)
          if (ch === undefined) {
            throw new HelmxError('swarm_unknown_channel', `频道 '${chName}' 不存在`, 404, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          ch.archived = true
        } else if (input.op === 'subscribe' || input.op === 'unsubscribe') {
          if (input.op === 'unsubscribe' && chName === 'main') {
            throw new HelmxError('validation_error', "主频道 'main' 禁止退订", 400, { channel: chName })
          }
          if (typeof input.member !== 'string' || input.member.trim() === '') {
            throw new HelmxError('validation_error', `${input.op} 需指定目标成员 member`, 400, {})
          }
          const ch = draft.channels.find((c) => c.name === chName)
          if (ch === undefined) {
            throw new HelmxError('swarm_unknown_channel', `频道 '${chName}' 不存在`, 404, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          if (input.op === 'subscribe' && ch.archived === true) {
            throw new HelmxError('swarm_channel_archived', `频道 '${chName}' 已归档，无法订阅`, 409, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          const member = draft.members.find((m) => m.name === input.member!.trim() && m.lifecycle === 'active')
          if (member === undefined) {
            throw new HelmxError('swarm_unknown_target', `活跃成员 '${input.member}' 不存在`, 404, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              member: input.member,
            })
          }
          if (input.op === 'subscribe') {
            if (!member.channels.includes(chName)) member.channels.push(chName)
          } else {
            member.channels = member.channels.filter((c) => c !== chName)
          }
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: draft }
      })
    },

    async addMemberWithBrief(groupId, memberInit, briefPrompt) {
      const validId = assertGroupId(groupId)
      const added = await runGroupLocked(validId, async () => {
        const current = groupsById.get(validId)
        if (current === undefined) {
          throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: validId,
          })
        }
        if (memberInit.dispatchKey !== undefined) {
          const existingMember = current.members.find(
            (m) => m.name === memberInit.name && m.dispatchKey === memberInit.dispatchKey,
          )
          if (existingMember !== undefined) {
            const list = postsByGroup.get(validId) ?? []
            const existingPost =
              (existingMember.briefPostSeq !== undefined
                ? list.find((p) => p.seq === existingMember.briefPostSeq)
                : undefined) ??
              list.find((p) => p.kind === 'brief' && p.to.includes(existingMember.name))
            if (existingPost !== undefined) {
              return { group: current, member: existingMember, post: existingPost, replayed: true }
            }
          }
        }
        if (current.status !== 'active') {
          throw new HelmxError('swarm_group_closed', `协作组 '${validId}' 已结单，无法招募新成员`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: validId,
          })
        }
        const next = structuredClone(current)
        const now = Date.now()
        const seq = next.headSeq + 1
        const memberState: GroupMemberState = {
          ...memberInit,
          briefPostSeq: seq,
          readCursorSeq: current.headSeq,
          pendingWakeupSeq: seq,
          lastWakeTaskSeq: seq,
        }
        next.members.push(memberState)
        const rawPost: BoardPost = {
          seq,
          groupId: validId,
          channel: 'main',
          from: 'coordinator',
          to: [memberState.name],
          resolvedTargets: [memberState.name],
          wake: true,
          kind: 'brief',
          refs: [],
          body: briefPrompt,
          createdAt: now,
        }
        const post = assertBoardPost(redactObject(rawPost))
        next.headSeq = seq
        next.updatedAt = now

        await appendBoardLineDurableLocked(validId, post)
        const savedGroup = await persistMetaLocked(next)
        const list = postsByGroup.get(validId) ?? []
        list.push(post)
        postsByGroup.set(validId, list)
        const savedMember = savedGroup.members.find((m) => m.name === memberState.name)!
        return { group: savedGroup, member: savedMember, post, replayed: false }
      })

      syncIndex()
      syncProjections()
      if (
        !added.replayed ||
        (added.member.pendingWakeupSeq > added.member.readCursorSeq &&
          added.member.inflightWakeup === undefined)
      ) {
        await deliverWorkerWakeup(validId, added.member.name)
      }
      return { group: added.group, member: added.member, post: added.post }
    },

    appendPost,
    mutateGroup,

    async onMemberTurnSettled(input: {
      groupId: string
      memberName: string
      conversationId: number
      completionSeq: number
      outcome: TurnOutcome
      error?: string
      lastReplySummary: string
    }): Promise<void> {
      const coord = getCoordinator()
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      const group = groupsById.get(input.groupId)
      if (group === undefined || group.status !== 'active') return
      const member = group.members.find((m) => m.name === input.memberName && m.lifecycle === 'active')
      if (member === undefined) return

      const flushReportIfNoOtherWorkersBusy = async (): Promise<void> => {
        const latest = groupsById.get(input.groupId)
        if (latest === undefined || latest.status !== 'active' || latest.coordinatorDetached) return
        if (hasOtherWorkingOrSettlingMember(latest, input.conversationId)) return
        const needsCatchup = shouldSendCoordinatorIdleCatchup(latest, input.conversationId)
        if (latest.coordinatorPendingSeq > latest.coordinatorNotifiedSeq || needsCatchup) {
          await flushCoordinatorReport(input.groupId, input.conversationId)
        }
      }

      if (input.outcome === 'failed') {
        const prevTaskSeq = member.lastWakeTaskSeq
        const summary = coord.readConversationOrUndefined(input.conversationId)
        const modelName = summary?.model ?? 'unknown'
        const rawErr = input.error ?? summary?.lastError ?? 'unknown turn failure'
        const safeErr = ctx.host.redact(rawErr)
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            delete target.lastWakeTaskSeq
            delete target.silentExitNudgeSeq
            delete target.lastWakeCompletionSeq
            delete target.inflightNudge
          }
          return { group: draft, result: undefined }
        })
        await appendPost(input.groupId, {
          channel: 'main',
          from: 'system',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'blocker',
          refs: prevTaskSeq !== undefined ? [prevTaskSeq] : [],
          body: `Member @${input.memberName} (#${input.conversationId}, model: ${modelName}) turn failed: ${safeErr}`,
        })
        const refreshed = groupsById.get(input.groupId)?.members.find(
          (m) => m.name === input.memberName && m.lifecycle === 'active',
        )
        if (refreshed !== undefined && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
          await deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
          return
        }
        await flushReportIfNoOtherWorkersBusy()
        return
      }

      if (input.outcome === 'aborted') {
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            delete target.lastWakeTaskSeq
            delete target.silentExitNudgeSeq
            delete target.lastWakeCompletionSeq
            delete target.inflightNudge
          }
          return { group: draft, result: undefined }
        })
        const refreshed = groupsById.get(input.groupId)?.members.find((m) => m.name === input.memberName)
        if (refreshed !== undefined && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
          await deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
          return
        }
        await flushReportIfNoOtherWorkersBusy()
        return
      }

      if (member.pendingWakeupSeq > member.readCursorSeq) {
        await deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        return
      }

      const silentAction = evaluateSilentExit(group, member, input.lastReplySummary)
      if (silentAction.kind === 'nudge') {
        const nudgeSummary = coord.readConversationOrUndefined(input.conversationId)
        const baseCompletionSeq = nudgeSummary?.completionSeq ?? input.completionSeq
        const baseLastEntryId = nudgeSummary?.lastEntryId ?? 0
        const nudgeRequestId = `swarm-nudge:${input.groupId}:${input.memberName}:${silentAction.taskSeq}`
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            target.silentExitNudgeSeq = silentAction.taskSeq
            target.inflightNudge = {
              requestId: nudgeRequestId,
              taskSeq: silentAction.taskSeq,
              baseCompletionSeq,
              baseLastEntryId,
            }
          }
          return { group: draft, result: undefined }
        })
        try {
          await ctx.host.submitInputGuarded(
            input.conversationId,
            silentAction.prompt,
            {
              origin: 'agent',
              whenBusy: 'followUp',
              requestId: nudgeRequestId,
            },
            { expectedOwnership: 'helmx' },
          )
          await mutateGroup(input.groupId, (draft) => {
            const target = draft.members.find((m) => m.name === input.memberName)
            if (target !== undefined) {
              if (target.inflightNudge?.requestId === nudgeRequestId) {
                delete target.inflightNudge
              }
              target.lastWakeCompletionSeq = baseCompletionSeq
            }
            return { group: draft, result: undefined }
          })
        } catch (err) {
          await mutateGroup(input.groupId, (draft) => {
            const target = draft.members.find((m) => m.name === input.memberName)
            if (target !== undefined) {
              if (target.inflightNudge?.requestId === nudgeRequestId) {
                delete target.inflightNudge
              }
              if (target.silentExitNudgeSeq === silentAction.taskSeq) {
                delete target.silentExitNudgeSeq
              }
              if (target.lastWakeCompletionSeq === baseCompletionSeq) {
                delete target.lastWakeCompletionSeq
              }
            }
            return { group: draft, result: undefined }
          }).catch(() => {})
          if (!isLifecycleTeardownError(err)) {
            coord.reportError(`协作组 ${input.groupId} 成员 @${input.memberName} 哑巴退场续催失败`, err)
          }
        }
        return
      }

      if (silentAction.kind === 'fallback_blocker') {
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            delete target.lastWakeTaskSeq
            delete target.silentExitNudgeSeq
            delete target.lastWakeCompletionSeq
            delete target.inflightNudge
          }
          return { group: draft, result: undefined }
        })
        await appendPost(input.groupId, {
          channel: 'main',
          from: 'system',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'blocker',
          refs: [silentAction.taskSeq],
          body: silentAction.body,
        })
        await flushReportIfNoOtherWorkersBusy()
        return
      }

      await flushReportIfNoOtherWorkersBusy()
      await checkAndEmitQuiescenceStall(input.groupId, input.conversationId)
    },

    async onCoordinatorTurnSettled(conversationId: number): Promise<void> {
      const coord = getCoordinator()
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      const group = this.findActiveGroupByCoordinator(conversationId)
      if (group === undefined) return
      lastCoordReportCompletionSeq.delete(group.id)
      syncProjections()

      if (
        !group.coordinatorDetached &&
        (group.coordinatorPendingSeq > group.coordinatorNotifiedSeq || shouldSendCoordinatorIdleCatchup(group))
      ) {
        await flushCoordinatorReport(group.id)
        return
      }
      await checkAndEmitQuiescenceStall(group.id)
    },
  }

  return runtimeHandle
}
