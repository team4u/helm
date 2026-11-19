/**
 * builtin:swarm 成员自愈与恢复对账模块（自 group-store 拆出）。
 *
 * 职责：
 * 1) 0-Token 全组静默守卫（checkAndEmitQuiescenceStall）：6 条件判定并补发 stall 帖；
 * 2) 磁盘加载恢复：board.jsonl 未提交 WAL 尾回滚截断（readAndHealBoardPostsLocked）、
 *    meta.json 校验加载（loadGroupFromDisk）、closed 组帖子按需懒加载（ensurePostsLoaded）；
 * 3) 成员删除自愈（reconcileDeletedWorker）：释放 worktree 持有锁、归档成员、发 [blocker]；
 * 4) 重启恢复对账（reconcileSingleRecoveredGroup）：在途唤醒/续催/报告意图分类收口，
 *    未送达投递补发、已结算成员回合重放（onMemberTurnSettled）。
 *
 * 与拆分前逐字等价：所有持久化仍经 group-store 的 runGroupLocked / mutateGroup / appendPost
 * 端口执行（保持 board.jsonl 先 append + datasync 再 atomicWriteFile(meta.json) 的提交点顺序）；
 * worktree 持有锁释放统一走 worktree-bridge 的 releaseWorktreeHold。
 */
import { readFile } from 'node:fs/promises'
import { HelmxError, type HelmxPluginContext, type MaybePromise, type TurnOutcome } from '@helmx/protocol'
import {
  SWARM_PLUGIN_ID,
  assertCollabGroupRecord,
  assertGroupId,
  isEnoent,
  isLifecycleTeardownError,
  type BoardPost,
  type BoardPostKind,
  type CollabGroupRecord,
  type GroupMemberState,
  type MemberLiveState,
  type SwarmCoordinator,
  type WorktreeHandoffSnapshot,
} from './contracts.js'
import {
  evaluateGroupQuiescence,
  evaluateSilentExit,
  type MemberRuntimeSnapshot,
} from './board-stall.js'
import {
  classifyInflightIntent,
  classifyMemberDetailOutcome,
  inspectBoardWalLines,
} from './recovery.js'
import { collectMemberLastReplySummary } from './settlement.js'
import { releaseWorktreeHold } from './worktree-bridge.js'
import type { WakeDispatcher } from './wake-dispatcher.js'

/** appendPost 的帖子草稿形状（与 CollabGroupRuntime.appendPost 契约结构一致）。 */
export type AppendPostDraft = {
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
}

/** 成员回合结算事件输入（turn_settled 自愈处理的统一入口形状）。 */
export interface MemberTurnSettledInput {
  groupId: string
  memberName: string
  conversationId: number
  completionSeq: number
  outcome: TurnOutcome
  error?: string
  lastReplySummary: string
}

/** member-healing 对组存储门面与唤醒调度的最小依赖端口。 */
export interface MemberHealingPorts {
  readonly ctx: HelmxPluginContext
  readonly getCoordinator: () => SwarmCoordinator
  readonly isStopping: () => boolean
  readonly getGroup: (groupId: string) => CollabGroupRecord | undefined
  /** 未懒加载 board.jsonl 的组返回 undefined（ensurePostsLoaded 的懒加载哨兵）。 */
  readonly getPosts: (groupId: string) => readonly BoardPost[] | undefined
  readonly setPostsCache: (groupId: string, posts: BoardPost[]) => void
  readonly mutateGroup: <T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ) => Promise<T>
  readonly appendPost: (groupId: string, draft: AppendPostDraft) => Promise<BoardPost>
  readonly persistMeta: (record: CollabGroupRecord) => Promise<CollabGroupRecord>
  readonly runGroupLocked: <T>(groupId: string, fn: () => Promise<T>) => Promise<T>
  readonly metaPath: (groupId: string) => string
  readonly boardPath: (groupId: string) => string
  readonly logDiagnostic: (message: string) => void
  readonly releaseManagedWorker: (conversationId: number) => void
  readonly dispatcher: WakeDispatcher
  readonly hasOtherWorkingOrSettlingMember: (group: CollabGroupRecord, excludeConvId?: number) => boolean
}

/** 成员自愈与恢复对账能力（由 group-store 组合根装配后使用）。 */
export interface MemberHealing {
  checkAndEmitQuiescenceStall(groupId: string, settlingConvId?: number): Promise<void>
  readAndHealBoardPostsLocked(groupId: string, expectedHeadSeq: number): Promise<BoardPost[]>
  loadGroupFromDisk(groupId: string): Promise<{ record: CollabGroupRecord; posts: BoardPost[] | undefined }>
  ensurePostsLoaded(groupId: string): Promise<readonly BoardPost[]>
  reconcileDeletedWorker(groupId: string, conversationId: number): Promise<void>
  reconcileSingleRecoveredGroup(groupId: string): Promise<void>
  onMemberTurnSettled(input: MemberTurnSettledInput): Promise<void>
}

export function createMemberHealing(ports: MemberHealingPorts): MemberHealing {
  const { dispatcher } = ports
  const checkAndEmitQuiescenceStall = async (groupId: string, settlingConvId?: number): Promise<void> => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
    const group = ports.getGroup(groupId)
    if (group === undefined || group.status !== 'active' || group.coordinatorDetached === true) return

    const posts = ports.getPosts(groupId) ?? []
    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    const prevCoordCompletion = dispatcher.getLastCoordReportCompletionSeq(groupId)
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
      hasInflightDeliveries: dispatcher.hasInflightDeliveriesForGroup(groupId),
      coordinatorState,
      memberSnapshots,
    })
    if (!verdict.shouldEmitStall) return

    await ports.appendPost(groupId, {
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
    await dispatcher.flushCoordinatorReport(groupId)
  }

  /** 从磁盘读取并校验单个协作组的 board.jsonl（严格校验并仅回滚至多 1 条未提交 WAL 尾）。 */
  const readAndHealBoardPostsLocked = async (
    groupId: string,
    expectedHeadSeq: number,
  ): Promise<BoardPost[]> => {
    let rawBoard = ''
    try {
      rawBoard = await readFile(ports.boardPath(groupId), 'utf8')
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    const wal = inspectBoardWalLines(rawBoard, groupId, expectedHeadSeq)
    if (wal.trimmed) {
      ports.logDiagnostic(
        `协作组 '${groupId}' 检测到未提交的 board.jsonl 尾行（${wal.trimReason}），已按 meta.headSeq=${expectedHeadSeq} 回滚截断`,
      )
      const cleanText = wal.posts.length > 0 ? `${wal.posts.map((p) => JSON.stringify(p)).join('\n')}\n` : ''
      await ports.ctx.host.atomicWriteFile(ports.boardPath(groupId), cleanText)
    }
    return wal.posts
  }

  /** 从磁盘加载单个协作组账本；closed 组启动期仅加载 meta.json，board.jsonl 延后至首次按需读。 */
  const loadGroupFromDisk = async (
    groupId: string,
  ): Promise<{ record: CollabGroupRecord; posts: BoardPost[] | undefined }> => {
    return ports.runGroupLocked(groupId, async () => {
      let rawMetaText: string
      try {
        rawMetaText = await readFile(ports.metaPath(groupId), 'utf8')
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
          if (ports.getCoordinator().readConversationOrUndefined(record.coordinatorConversationId) === undefined) {
            record = await ports.persistMeta({ ...record, coordinatorDetached: true, updatedAt: Date.now() })
          }
        }
      }
      return { record, posts }
    })
  }

  const ensurePostsLoaded = async (groupId: string): Promise<readonly BoardPost[]> => {
    const validId = assertGroupId(groupId)
    const cached = ports.getPosts(validId)
    if (cached !== undefined) return cached
    return ports.runGroupLocked(validId, async () => {
      const again = ports.getPosts(validId)
      if (again !== undefined) return again
      const current = ports.getGroup(validId)
      if (current === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      const parsed = await readAndHealBoardPostsLocked(validId, current.headSeq)
      ports.setPostsCache(validId, parsed)
      return parsed
    })
  }

  /** 活跃成员会话缺失/被删时自愈：释放 worktreeHold、归档成员、发 [blocker]，防止 missing 永久卡死静默检测。 */
  const reconcileDeletedWorker = async (groupId: string, conversationId: number): Promise<void> => {
    const coord = ports.getCoordinator()
    ports.releaseManagedWorker(conversationId)
    const current = ports.getGroup(groupId)
    if (current === undefined || current.status !== 'active') return
    const targetMember = current.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
    if (targetMember === undefined) return

    if (targetMember.worktreeId !== undefined) {
      try {
        await releaseWorktreeHold(ports.ctx, groupId, targetMember.name, targetMember.worktreeId)
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
    await ports.mutateGroup(groupId, (draft) => {
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
      await ports.appendPost(groupId, {
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
    const coord = ports.getCoordinator()
    const summary = coord.readConversationOrUndefined(memberSnapshot.conversationId)

    let clearWakeupAction: 'none' | 'missing' | 'active' | 'settled' | 'uncommitted' = 'none'
    if (memberSnapshot.inflightWakeup !== undefined) {
      const status = await classifyInflightIntent(
        ports.ctx.host,
        memberSnapshot.conversationId,
        summary,
        memberSnapshot.inflightWakeup,
      )
      clearWakeupAction = status === 'missing_conv' ? 'missing' : status
    }

    let clearNudgeAction: 'none' | 'missing' | 'active' | 'settled' | 'uncommitted' = 'none'
    if (memberSnapshot.inflightNudge !== undefined) {
      const status = await classifyInflightIntent(
        ports.ctx.host,
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

    await ports.mutateGroup(groupId, (draft) => {
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
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
    const initialGroup = ports.getGroup(groupId)
    if (initialGroup === undefined || initialGroup.status !== 'active') return

    if (initialGroup.inflightReport !== undefined) {
      const inflight = initialGroup.inflightReport
      if (initialGroup.coordinatorDetached) {
        await ports.mutateGroup(groupId, (draft) => {
          delete draft.inflightReport
          return { group: draft, result: undefined }
        })
      } else {
        const coordSummary = coord.readConversationOrUndefined(initialGroup.coordinatorConversationId)
        const reportStatus = await classifyInflightIntent(
          ports.ctx.host,
          initialGroup.coordinatorConversationId,
          coordSummary,
          inflight,
        )
        await ports.mutateGroup(groupId, (draft) => {
          if (draft.inflightReport?.requestId === inflight.requestId) {
            if (reportStatus === 'active' || reportStatus === 'settled') {
              draft.coordinatorNotifiedSeq = Math.max(draft.coordinatorNotifiedSeq, inflight.toSeq)
            }
            delete draft.inflightReport
          }
          return { group: draft, result: undefined }
        })
        if (reportStatus === 'active') {
          dispatcher.noteCoordReportInflight(groupId, inflight.baseCompletionSeq)
        }
      }
    }

    const activeMembers = initialGroup.members.filter((m) => m.lifecycle === 'active')
    for (const member of activeMembers) {
      if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
      await reconcileMemberRecoveryState(groupId, member)
    }

    const freshGroup = ports.getGroup(groupId)
    if (freshGroup === undefined || freshGroup.status !== 'active') return

    for (const member of freshGroup.members) {
      if (member.lifecycle !== 'active') continue
      if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
      if (member.pendingWakeupSeq > member.readCursorSeq) {
        void dispatcher.deliverWorkerWakeup(freshGroup.id, member.name)
        continue
      }
      if (member.lastWakeTaskSeq === undefined || (member.lastPostSeq ?? 0) >= member.lastWakeTaskSeq) {
        continue
      }
      const summary = coord.readConversationOrUndefined(member.conversationId)
      if (summary === undefined || summary.status === 'working' || summary.status === 'blocked') continue

      let entries = [] as Awaited<ReturnType<typeof ports.ctx.host.getConversationDetail>>['entries']
      if (summary.status !== 'error') {
        try {
          entries = (await ports.ctx.host.getConversationDetail(member.conversationId, { limit: 30 })).entries
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') continue
          throw err
        }
      }
      const classified = classifyMemberDetailOutcome(entries, summary, freshGroup.id, member)
      if (classified.kind === 'pending_queue') continue

      const lastReplySummary =
        classified.kind === 'aborted' ? '' : await collectMemberLastReplySummary(ports.ctx.host, member.conversationId)
      await onMemberTurnSettled({
        groupId: freshGroup.id,
        memberName: member.name,
        conversationId: member.conversationId,
        completionSeq: summary.completionSeq,
        outcome: classified.kind,
        ...(classified.kind === 'failed' && classified.error !== undefined ? { error: classified.error } : {}),
        lastReplySummary,
      })
    }

    const latestGroup = ports.getGroup(groupId)
    if (latestGroup === undefined || latestGroup.status !== 'active' || latestGroup.coordinatorDetached) return
    if (latestGroup.coordinatorPendingSeq > latestGroup.coordinatorNotifiedSeq) {
      const groupPosts = ports.getPosts(latestGroup.id) ?? []
      const hasUrgentPost = groupPosts.some(
        (p) =>
          p.seq > latestGroup.coordinatorNotifiedSeq &&
          p.seq <= latestGroup.coordinatorPendingSeq &&
          (p.kind === 'blocker' || p.kind === 'stall'),
      )
      if (hasUrgentPost || !ports.hasOtherWorkingOrSettlingMember(latestGroup)) {
        void dispatcher.scheduleCoordinatorReport(latestGroup.id, 0)
      }
    } else if (!dispatcher.hasInflightDeliveriesForGroup(latestGroup.id)) {
      await checkAndEmitQuiescenceStall(latestGroup.id)
    }
  }

  const onMemberTurnSettled = async (input: MemberTurnSettledInput): Promise<void> => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
    const group = ports.getGroup(input.groupId)
    if (group === undefined || group.status !== 'active') return
    const member = group.members.find((m) => m.name === input.memberName && m.lifecycle === 'active')
    if (member === undefined) return

    const flushReportIfNoOtherWorkersBusy = async (): Promise<void> => {
      const latest = ports.getGroup(input.groupId)
      if (latest === undefined || latest.status !== 'active' || latest.coordinatorDetached) return
      if (ports.hasOtherWorkingOrSettlingMember(latest, input.conversationId)) return
      const needsCatchup = dispatcher.shouldSendCoordinatorIdleCatchup(latest, input.conversationId)
      if (latest.coordinatorPendingSeq > latest.coordinatorNotifiedSeq || needsCatchup) {
        await dispatcher.flushCoordinatorReport(input.groupId, input.conversationId)
      }
    }

    if (input.outcome === 'failed') {
      const prevTaskSeq = member.lastWakeTaskSeq
      const summary = coord.readConversationOrUndefined(input.conversationId)
      const modelName = summary?.model ?? 'unknown'
      const rawErr = input.error ?? summary?.lastError ?? 'unknown turn failure'
      const safeErr = ports.ctx.host.redact(rawErr)
      await ports.mutateGroup(input.groupId, (draft) => {
        const target = draft.members.find((m) => m.name === input.memberName)
        if (target !== undefined) {
          delete target.lastWakeTaskSeq
          delete target.silentExitNudgeSeq
          delete target.lastWakeCompletionSeq
          delete target.inflightNudge
        }
        return { group: draft, result: undefined }
      })
      await ports.appendPost(input.groupId, {
        channel: 'main',
        from: 'system',
        to: ['coordinator'],
        resolvedTargets: ['coordinator'],
        wake: true,
        kind: 'blocker',
        refs: prevTaskSeq !== undefined ? [prevTaskSeq] : [],
        body: `Member @${input.memberName} (#${input.conversationId}, model: ${modelName}) turn failed: ${safeErr}`,
      })
      const refreshed = ports.getGroup(input.groupId)?.members.find(
        (m) => m.name === input.memberName && m.lifecycle === 'active',
      )
      if (refreshed !== undefined && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
        await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        return
      }
      await flushReportIfNoOtherWorkersBusy()
      return
    }

    if (input.outcome === 'aborted') {
      await ports.mutateGroup(input.groupId, (draft) => {
        const target = draft.members.find((m) => m.name === input.memberName)
        if (target !== undefined) {
          delete target.lastWakeTaskSeq
          delete target.silentExitNudgeSeq
          delete target.lastWakeCompletionSeq
          delete target.inflightNudge
        }
        return { group: draft, result: undefined }
      })
      const refreshed = ports.getGroup(input.groupId)?.members.find((m) => m.name === input.memberName)
      if (refreshed !== undefined && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
        await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        return
      }
      await flushReportIfNoOtherWorkersBusy()
      return
    }

    if (member.pendingWakeupSeq > member.readCursorSeq) {
      await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
      return
    }

    const silentAction = evaluateSilentExit(group, member, input.lastReplySummary)
    if (silentAction.kind === 'nudge') {
      const nudgeSummary = coord.readConversationOrUndefined(input.conversationId)
      const baseCompletionSeq = nudgeSummary?.completionSeq ?? input.completionSeq
      const baseLastEntryId = nudgeSummary?.lastEntryId ?? 0
      const nudgeRequestId = `swarm-nudge:${input.groupId}:${input.memberName}:${silentAction.taskSeq}`
      await ports.mutateGroup(input.groupId, (draft) => {
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
        await ports.ctx.host.submitInputGuarded(
          input.conversationId,
          silentAction.prompt,
          {
            origin: 'agent',
            whenBusy: 'followUp',
            requestId: nudgeRequestId,
          },
          { expectedOwnership: 'helmx' },
        )
        await ports.mutateGroup(input.groupId, (draft) => {
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
        await ports.mutateGroup(input.groupId, (draft) => {
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
      await ports.mutateGroup(input.groupId, (draft) => {
        const target = draft.members.find((m) => m.name === input.memberName)
        if (target !== undefined) {
          delete target.lastWakeTaskSeq
          delete target.silentExitNudgeSeq
          delete target.lastWakeCompletionSeq
          delete target.inflightNudge
        }
        return { group: draft, result: undefined }
      })
      await ports.appendPost(input.groupId, {
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
  }

  return {
    checkAndEmitQuiescenceStall,
    readAndHealBoardPostsLocked,
    loadGroupFromDisk,
    ensurePostsLoaded,
    reconcileDeletedWorker,
    reconcileSingleRecoveredGroup,
    onMemberTurnSettled,
  }
}
