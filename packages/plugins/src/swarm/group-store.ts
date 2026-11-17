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
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HelmError,
  redactJsonValue,
  type HelmPluginContext,
  type MaybePromise,
  type TurnOutcome,
} from '@helm/protocol'
import {
  ACTIONABLE_WAKE_KINDS,
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_BATCH_WINDOW_MS,
  COORDINATOR_ESCALATION_KINDS,
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

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function generateGroupId(): string {
  return `grp_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

export function createCollabGroupRuntime(
  ctx: HelmPluginContext,
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
  const inflightMemberWakeups = new Set<string>()
  /** 在途主控汇总投递集合（key: groupId）。 */
  const inflightCoordReports = new Set<string>()
  /** 主控 50ms 微批合并定时器（key: groupId）。 */
  const reportTimers = new Map<string, NodeJS.Timeout>()
  /** 主控最近一次发出的 board-report 对应的发送前 completionSeq（防同回合连发）。 */
  const lastCoordReportCompletionSeq = new Map<string, number>()

  let stopping = false

  const groupDirOf = (groupId: string): string => join(getGroupsRootDir(), groupId)
  const metaPathOf = (groupId: string): string => join(groupDirOf(groupId), 'meta.json')
  const boardPathOf = (groupId: string): string => join(groupDirOf(groupId), 'board.jsonl')

  const redactObject = <T>(value: T): T =>
    redactJsonValue(value, (text) => ctx.host.redact(text)) as T

  const runGroupLocked = async <T>(groupId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = groupQueues.get(groupId) ?? Promise.resolve()
    const run = prev.then(
      () =>
        mkdir(groupDirOf(groupId), { recursive: true }).then(() =>
          ctx.host.withFileLock(metaPathOf(groupId), fn),
        ),
      () =>
        mkdir(groupDirOf(groupId), { recursive: true }).then(() =>
          ctx.host.withFileLock(metaPathOf(groupId), fn),
        ),
    )
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

  const syncIndex = (): void => {
    const coord = getCoordinator()
    if (stopping || coord.isShutdown()) return
    const ordered = [...groupsById.values()].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    )
    const summaries = ordered.map((g) => toGroupSummary(g))
    const workers: SwarmWorkerPointer[] = ordered
      .filter((g) => g.status === 'active')
      .flatMap((g) =>
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

    // 选出每个主控会话当前应投影的代表组：优先 active 组，否则最新创建组
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
      const posts = postsByGroup.get(group.id) ?? []
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

    // 清理不再有任何关联组的旧主控 sessionDoc
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
        throw new HelmError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
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
      worktreeSnapshot?: WorktreeHandoffSnapshot
    },
  ): Promise<BoardPost> => {
    const validId = assertGroupId(groupId)
    let membersToWake: string[] = []
    let shouldNotifyCoordinator = false

    const createdPost = await runGroupLocked(validId, async () => {
      const current = groupsById.get(validId)
      if (current === undefined) {
        throw new HelmError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
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
        ...(draft.worktreeSnapshot !== undefined ? { worktreeSnapshot: draft.worktreeSnapshot } : {}),
        createdAt: now,
      }
      const post = assertBoardPost(redactObject(rawPost))

      // 更新发帖成员自身游标与最后出边
      const sender = next.members.find((m) => m.name === post.from && m.lifecycle === 'active')
      if (sender !== undefined) {
        sender.lastPostSeq = post.seq
        sender.lastOutboundEdge = { seq: post.seq, to: [...post.to], kind: post.kind }
        if (sender.readCursorSeq === current.headSeq) {
          sender.readCursorSeq = post.seq
        }
      }

      // 推进对等成员待唤醒水位（仅 wake === true 触发唤醒）
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

      // 推进主控待汇报水位（显式指向主控且 wake=true，或 blocker/done/stall 升级事件）
      if (
        post.from !== 'coordinator' &&
        ((post.resolvedTargets.includes('coordinator') && post.wake) || COORDINATOR_ESCALATION_KINDS.has(post.kind))
      ) {
        next.coordinatorPendingSeq = post.seq
        shouldNotifyCoordinator = true
      }

      next.headSeq = post.seq
      next.updatedAt = now

      await appendFile(boardPathOf(validId), `${JSON.stringify(post)}\n`, 'utf8')
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
      scheduleCoordinatorReport(validId, COORDINATOR_BATCH_WINDOW_MS)
    }

    return createdPost
  }

  const hasInflightDeliveriesForGroup = (groupId: string): boolean => {
    if (reportTimers.has(groupId) || inflightCoordReports.has(groupId)) return true
    const prefix = `${groupId}:`
    for (const key of inflightMemberWakeups) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  /** 对单个对等成员执行合并唤醒（若成员正忙则留待 turn_settled 合并投递）。 */
  const deliverWorkerWakeup = async (
    groupId: string,
    memberName: string,
    opts?: { fromTurnSettled?: boolean },
  ): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    const lockKey = `${groupId}:${memberName}`
    if (inflightMemberWakeups.has(lockKey)) return
    inflightMemberWakeups.add(lockKey)
    try {
      await coord.track(`board-wakeup:${lockKey}`, async () => {
        if (stopping || coord.isShutdown() || ctx.host.isClosing) return
        const group = groupsById.get(groupId)
        if (group === undefined || group.status !== 'active') return
        const member = group.members.find((m) => m.name === memberName && m.lifecycle === 'active')
        if (member === undefined) return
        if (member.pendingWakeupSeq <= member.readCursorSeq) return

        const summary = coord.readConversationOrUndefined(member.conversationId)
        if (summary === undefined) return
        const isSettlingBusy = opts?.fromTurnSettled !== true && coord.settlingWorkers.has(member.conversationId)
        if (
          summary.status === 'working' ||
          summary.status === 'blocked' ||
          isSettlingBusy ||
          (member.lastWakeCompletionSeq !== undefined && summary.completionSeq <= member.lastWakeCompletionSeq)
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

        await mutateGroup(groupId, (draft) => {
          const target = draft.members.find((m) => m.name === memberName)
          if (target !== undefined) {
            target.lastWakeCompletionSeq = summary.completionSeq
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
            { expectedOwnership: 'helm' },
          )
          await mutateGroup(groupId, (draft) => {
            const target = draft.members.find((m) => m.name === memberName)
            if (target !== undefined) {
              target.readCursorSeq = Math.max(target.readCursorSeq, toSeq)
            }
            return { group: draft, result: undefined }
          })
        } catch (err) {
          await mutateGroup(groupId, (draft) => {
            const target = draft.members.find((m) => m.name === memberName)
            if (target !== undefined && target.lastWakeCompletionSeq === summary.completionSeq) {
              delete target.lastWakeCompletionSeq
            }
            return { group: draft, result: undefined }
          }).catch(() => {})
          coord.reportError(`协作组 ${groupId} 成员 @${memberName} 唤醒投递失败`, err)
        }
      })
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'plugin_disabled')) {
        coord.reportError(`协作组 ${groupId} 唤醒任务异常`, err)
      }
    } finally {
      inflightMemberWakeups.delete(lockKey)
    }
  }

  /** 调度主控 50ms 微批汇总投递。 */
  const scheduleCoordinatorReport = (groupId: string, delayMs: number): void => {
    const coord = getCoordinator()
    if (stopping || coord.isShutdown() || ctx.host.isClosing) return
    if (reportTimers.has(groupId)) return
    if (delayMs <= 0) {
      void flushCoordinatorReport(groupId)
      return
    }
    const timer = setTimeout(() => {
      reportTimers.delete(groupId)
      void flushCoordinatorReport(groupId)
    }, delayMs)
    timer.unref?.()
    reportTimers.set(groupId, timer)
  }

  const flushCoordinatorReport = async (groupId: string): Promise<void> => {
    const coord = getCoordinator()
    if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
    if (inflightCoordReports.has(groupId)) return
    inflightCoordReports.add(groupId)
    try {
      await coord.track(`board-report:${groupId}`, async () => {
        if (stopping || coord.isShutdown() || ctx.host.isClosing) return
        const group = groupsById.get(groupId)
        if (group === undefined || group.status !== 'active' || group.coordinatorDetached === true) return
        if (group.coordinatorPendingSeq <= group.coordinatorNotifiedSeq) return

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

        const fromSeq = group.coordinatorNotifiedSeq + 1
        const toSeq = group.coordinatorPendingSeq
        const allPosts = postsByGroup.get(groupId) ?? []
        const selected = selectPostsForCoordinatorReport(allPosts, fromSeq, toSeq)
        if (selected.length === 0) {
          await mutateGroup(groupId, (draft) => {
            draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, toSeq)
            return { group: draft, result: undefined }
          })
          return
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
        const requestId = `swarm-report:${groupId}:${fromSeq}-${toSeq}`
        const meta = {
          renderer: BOARD_REPORT_RENDERER,
          groupId,
          fromSeq,
          toSeq,
          postCount: selected.length,
          headline: view.headline.text,
        }

        lastCoordReportCompletionSeq.set(groupId, coordSummary.completionSeq)
        try {
          const ownership = ctx.host.getConversationOwnership(group.coordinatorConversationId)
          if (ownership === 'helm' || ownership === 'bot') {
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
          await mutateGroup(groupId, (draft) => {
            draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, toSeq)
            return { group: draft, result: undefined }
          })
        } catch (err) {
          if (lastCoordReportCompletionSeq.get(groupId) === coordSummary.completionSeq) {
            lastCoordReportCompletionSeq.delete(groupId)
          }
          coord.reportError(`协作组 ${groupId} 主控汇总投递失败`, err)
        }
      })
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'plugin_disabled')) {
        coord.reportError(`协作组 ${groupId} 汇总任务异常`, err)
      }
    } finally {
      inflightCoordReports.delete(groupId)
    }
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

    const stallPost = await appendPost(groupId, {
      channel: 'main',
      from: 'system',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'stall',
      refs: verdict.diagnosis.refSeq !== undefined ? [verdict.diagnosis.refSeq] : [],
      body: verdict.diagnosis.body,
    })

    // 将水位推进至本次 stall 帖子序号，防止主控无发帖结束回合后重复刷屏
    const updatedSnaps = group.members
      .filter((m) => m.lifecycle === 'active')
      .map((m) => ({
        name: m.name,
        completionSeq: coord.readConversationOrUndefined(m.conversationId)?.completionSeq ?? 0,
      }))
    const memberDigest = [...updatedSnaps]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => `${m.name}:${m.completionSeq}`)
      .join(',')
    await mutateGroup(groupId, (draft) => {
      draft.lastStallWatermark = `${stallPost.seq}|${memberDigest}`
      return { group: draft, result: undefined }
    })
  }

  return {
    async loadAllFromDisk(): Promise<void> {
      stopping = false
      groupsById.clear()
      postsByGroup.clear()
      groupQueues.clear()
      writtenViewDigests.clear()
      projectedCoordinators.clear()
      writtenIndexJson = ''
      writtenBadgesJson = ''
      lastCoordReportCompletionSeq.clear()

      let dirEntries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        dirEntries = await readdir(getGroupsRootDir(), { withFileTypes: true })
      } catch (err) {
        if (!isEnoent(err)) throw err
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const groupId = assertGroupId(entry.name)
        let rawMetaText: string
        try {
          rawMetaText = await readFile(metaPathOf(groupId), 'utf8')
        } catch (err) {
          throw new HelmError(
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
          throw new HelmError(
            'swarm_doc_corrupt',
            `协作组 '${groupId}' meta.json JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: SWARM_PLUGIN_ID, groupId },
          )
        }
        let record = assertCollabGroupRecord(parsedMeta)
        if (record.id !== groupId) {
          throw new HelmError(
            'swarm_doc_corrupt',
            `协作组目录 '${groupId}' 与 meta.json.id '${record.id}' 不一致`,
            500,
            { pluginId: SWARM_PLUGIN_ID, groupId },
          )
        }

        const posts: BoardPost[] = []
        let rawBoard = ''
        try {
          rawBoard = await readFile(boardPathOf(groupId), 'utf8')
        } catch (err) {
          if (!isEnoent(err)) throw err
        }
        const lines = rawBoard.split('\n').filter((line) => line.trim() !== '')
        for (let i = 0; i < lines.length; i += 1) {
          let parsedLine: unknown
          try {
            parsedLine = JSON.parse(lines[i]!)
          } catch (err) {
            throw new HelmError(
              'swarm_doc_corrupt',
              `协作组 '${groupId}' board.jsonl 第 ${i + 1} 行 JSON 非法：${err instanceof Error ? err.message : String(err)}`,
              500,
              { pluginId: SWARM_PLUGIN_ID, groupId, line: i + 1 },
            )
          }
          const post = assertBoardPost(parsedLine)
          if (post.groupId !== groupId || post.seq !== i + 1) {
            throw new HelmError(
              'swarm_doc_corrupt',
              `协作组 '${groupId}' board.jsonl 第 ${i + 1} 行序号或 groupId 不连续（收到 seq=${post.seq}）`,
              500,
              { pluginId: SWARM_PLUGIN_ID, groupId, line: i + 1, seq: post.seq },
            )
          }
          posts.push(post)
        }
        if (posts.length !== record.headSeq) {
          throw new HelmError(
            'swarm_doc_corrupt',
            `协作组 '${groupId}' board.jsonl 条数(${posts.length})与 meta.headSeq(${record.headSeq}) 不一致`,
            500,
            { pluginId: SWARM_PLUGIN_ID, groupId, postsCount: posts.length, headSeq: record.headSeq },
          )
        }

        if (record.status === 'active' && !record.coordinatorDetached) {
          if (getCoordinator().readConversationOrUndefined(record.coordinatorConversationId) === undefined) {
            record = await runGroupLocked(groupId, () =>
              persistMetaLocked({ ...record, coordinatorDetached: true, updatedAt: Date.now() }),
            )
          }
        }

        groupsById.set(groupId, record)
        postsByGroup.set(groupId, posts)
      }

      syncIndex()
      syncProjections()

      // 重启恢复：补发中断前尚未送达的对等唤醒与主控汇总（requestId 保证跨重启幂等）
      for (const group of groupsById.values()) {
        if (group.status !== 'active') continue
        for (const member of group.members) {
          if (member.lifecycle === 'active' && member.pendingWakeupSeq > member.readCursorSeq) {
            void deliverWorkerWakeup(group.id, member.name)
          }
        }
        if (!group.coordinatorDetached && group.coordinatorPendingSeq > group.coordinatorNotifiedSeq) {
          scheduleCoordinatorReport(group.id, 0)
        }
      }
    },

    async stopAndClear(): Promise<void> {
      stopping = true
      for (const timer of reportTimers.values()) clearTimeout(timer)
      reportTimers.clear()
      inflightMemberWakeups.clear()
      inflightCoordReports.clear()
      lastCoordReportCompletionSeq.clear()
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
      for (const groupId of reportTimers.keys()) {
        labels.push(`board-report-timer:${groupId}`)
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

    buildBoardView(groupId: string): BoardViewDoc {
      const validId = assertGroupId(groupId)
      const group = groupsById.get(validId)
      if (group === undefined) {
        throw new HelmError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
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
      for (const group of [...groupsById.values()]) {
        if (group.coordinatorConversationId === conversationId && !group.coordinatorDetached) {
          await mutateGroup(group.id, (draft) => {
            draft.coordinatorDetached = true
            draft.updatedAt = Date.now()
            return { group: draft, result: undefined }
          })
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
        throw new HelmError(
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
        coordinatorGuard: input.coordinatorGuard,
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
          throw new HelmError('swarm_group_closed', `协作组 '${draft.id}' 已结单，无法修改`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: draft.id,
          })
        }
        if (patch.title !== undefined) {
          const t = patch.title.trim()
          if (t === '') throw new HelmError('validation_error', 'title 不能为空', 400, {})
          draft.title = t
        }
        if (patch.objective !== undefined) {
          const obj = patch.objective.trim()
          if (obj === '') delete draft.objective
          else draft.objective = obj
        }
        if (patch.coordinatorGuard !== undefined) {
          draft.coordinatorGuard = patch.coordinatorGuard
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: draft }
      })
    },

    async manageChannel(groupId, input): Promise<CollabGroupRecord> {
      const chName = assertChannelName(input.channel)
      return mutateGroup(groupId, (draft) => {
        if (draft.status !== 'active') {
          throw new HelmError('swarm_group_closed', `协作组 '${draft.id}' 已结单，无法管理频道`, 409, {
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
              throw new HelmError('swarm_channel_conflict', `频道 '${chName}' 已存在`, 409, {
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
            throw new HelmError('validation_error', "主频道 'main' 禁止归档", 400, { channel: chName })
          }
          const ch = draft.channels.find((c) => c.name === chName)
          if (ch === undefined) {
            throw new HelmError('swarm_unknown_channel', `频道 '${chName}' 不存在`, 404, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          ch.archived = true
        } else if (input.op === 'subscribe' || input.op === 'unsubscribe') {
          if (input.op === 'unsubscribe' && chName === 'main') {
            throw new HelmError('validation_error', "主频道 'main' 禁止退订", 400, { channel: chName })
          }
          if (typeof input.member !== 'string' || input.member.trim() === '') {
            throw new HelmError('validation_error', `${input.op} 需指定目标成员 member`, 400, {})
          }
          const ch = draft.channels.find((c) => c.name === chName)
          if (ch === undefined) {
            throw new HelmError('swarm_unknown_channel', `频道 '${chName}' 不存在`, 404, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          if (input.op === 'subscribe' && ch.archived === true) {
            throw new HelmError('swarm_channel_archived', `频道 '${chName}' 已归档，无法订阅`, 409, {
              pluginId: SWARM_PLUGIN_ID,
              groupId: draft.id,
              channel: chName,
            })
          }
          const member = draft.members.find((m) => m.name === input.member!.trim() && m.lifecycle === 'active')
          if (member === undefined) {
            throw new HelmError('swarm_unknown_target', `活跃成员 '${input.member}' 不存在`, 404, {
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
          throw new HelmError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: validId,
          })
        }
        if (current.status !== 'active') {
          throw new HelmError('swarm_group_closed', `协作组 '${validId}' 已结单，无法招募新成员`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: validId,
          })
        }
        const next = structuredClone(current)
        const now = Date.now()
        const seq = next.headSeq + 1
        const memberState: GroupMemberState = {
          ...memberInit,
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

        await appendFile(boardPathOf(validId), `${JSON.stringify(post)}\n`, 'utf8')
        const savedGroup = await persistMetaLocked(next)
        const list = postsByGroup.get(validId) ?? []
        list.push(post)
        postsByGroup.set(validId, list)
        const savedMember = savedGroup.members.find((m) => m.name === memberState.name)!
        return { group: savedGroup, member: savedMember, post }
      })

      syncIndex()
      syncProjections()
      await deliverWorkerWakeup(validId, added.member.name)
      return added
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

      // 1) 回合 failed -> 立即向黑板追加 system [blocker]（含脱敏错误与当前模型名）并排队唤醒主控
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
        return
      }

      // 2) 回合 aborted（如 abort_worker 原地刹车） -> 清结旧任务水位，若有新排队唤醒则续跑，否则原地待命
      if (input.outcome === 'aborted') {
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            delete target.lastWakeTaskSeq
            delete target.silentExitNudgeSeq
            delete target.lastWakeCompletionSeq
          }
          return { group: draft, result: undefined }
        })
        const refreshed = groupsById.get(input.groupId)?.members.find((m) => m.name === input.memberName)
        if (refreshed !== undefined && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
          await deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        }
        return
      }

      // 3) 回合 completed：若有工作期间新到达的唤醒水位，优先一次性合并唤醒
      if (member.pendingWakeupSeq > member.readCursorSeq) {
        await deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        return
      }

      // 4) 防哑巴退场单次自愈（At-Most-Once Silent-Exit Nudge -> 二次命中代发 [blocker]）
      const silentAction = evaluateSilentExit(group, member, input.lastReplySummary)
      if (silentAction.kind === 'nudge') {
        await mutateGroup(input.groupId, (draft) => {
          const target = draft.members.find((m) => m.name === input.memberName)
          if (target !== undefined) {
            target.silentExitNudgeSeq = silentAction.taskSeq
            target.lastWakeCompletionSeq = input.completionSeq
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
              requestId: `swarm-nudge:${input.groupId}:${input.memberName}:${silentAction.taskSeq}`,
            },
            { expectedOwnership: 'helm' },
          )
        } catch (err) {
          coord.reportError(`协作组 ${input.groupId} 成员 @${input.memberName} 哑巴退场续催失败`, err)
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
        return
      }

      // 5) 正常完成且已发帖交接：若无在途唤醒/汇总，执行 6 条件 0-Token 全组静默守卫
      await checkAndEmitQuiescenceStall(input.groupId, input.conversationId)
    },

    async onCoordinatorTurnSettled(conversationId: number): Promise<void> {
      const coord = getCoordinator()
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      const group = this.findActiveGroupByCoordinator(conversationId)
      if (group === undefined) return
      lastCoordReportCompletionSeq.delete(group.id)
      syncProjections()

      if (!group.coordinatorDetached && group.coordinatorPendingSeq > group.coordinatorNotifiedSeq) {
        await flushCoordinatorReport(group.id)
        return
      }
      await checkAndEmitQuiescenceStall(group.id)
    },
  }
}
