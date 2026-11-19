/**
 * builtin:swarm 对等成员唤醒投递与主控微批汇总报告调度器（自 group-store 拆出）。
 *
 * 职责：
 * 1) 对等成员唤醒：按 (groupId, memberName) 单飞合并（在途并发重入安全），按读游标批合并
 *    选择帖子并经 submitInputGuarded 投递，失败仅记录诊断不中断调度；
 * 2) 主控汇总：COORDINATOR_BATCH_WINDOW_MS 微批窗口合并上报，同组单飞 + 冲刷期重检循环防丢批，
 *    含全员空闲补发（idle catchup）；
 * 3) 报告水位：lastCoordReportCompletionSeq / coordReportSawActiveWorkers 由本模块独占维护，
 *    供静默守卫与重启恢复对账读取。
 *
 * 并发不变量与拆分前逐字等价：inflightWakeups / scheduledReports 覆盖整个微批等待窗口与
 * 实际投递过程（liveTasks 零间隙）；stopAndClear 经 drain() 先 cancel 再 allSettled 排空。
 */
import type { HelmxPluginContext, MaybePromise } from '@helmx/protocol'
import {
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_BATCH_WINDOW_MS,
  isLifecycleTeardownError,
  type BoardPost,
  type CollabGroupRecord,
  type MemberLiveState,
  type SwarmCoordinator,
} from './contracts.js'
import {
  formatCoordinatorReportEnvelope,
  formatWorkerWakeupEnvelope,
  selectPostsForCoordinatorReport,
  selectPostsForMemberWakeup,
  synthesizeBoardView,
} from './board-router.js'

interface ScheduledReportEntry {
  readonly promise: Promise<void>
  trigger(delayMs: number): void
  cancel(): void
}

interface InflightWakeupEntry {
  readonly promise: Promise<void>
  requestRetry(fromTurnSettled?: boolean): void
}

/** wake-dispatcher 对组存储门面的最小依赖端口。 */
export interface WakeDispatcherPorts {
  readonly ctx: HelmxPluginContext
  readonly getCoordinator: () => SwarmCoordinator
  readonly isStopping: () => boolean
  readonly getGroup: (groupId: string) => CollabGroupRecord | undefined
  readonly getPosts: (groupId: string) => readonly BoardPost[]
  readonly mutateGroup: <T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ) => Promise<T>
  readonly reportLockPath: (groupId: string) => string
  readonly wakeupLockPath: (groupId: string, memberName: string) => string
  readonly resolveMemberLive: (conversationId: number) => { liveState: MemberLiveState; model?: string }
  readonly hasOtherWorkingOrSettlingMember: (group: CollabGroupRecord, excludeConvId?: number) => boolean
}

/** 对等唤醒投递与主控报告调度能力（由 group-store 组合根装配后使用）。 */
export interface WakeDispatcher {
  deliverWorkerWakeup(groupId: string, memberName: string, opts?: { fromTurnSettled?: boolean }): Promise<void>
  scheduleCoordinatorReport(groupId: string, delayMs: number, excludeSettlingConvId?: number): Promise<void>
  flushCoordinatorReport(groupId: string, excludeSettlingConvId?: number): Promise<void>
  shouldSendCoordinatorIdleCatchup(group: CollabGroupRecord, excludeSettlingConvId?: number): boolean
  hasInflightDeliveriesForGroup(groupId: string): boolean
  liveTaskLabels(): string[]
  /** 主控最近一次报告的发送前 completionSeq（防同回合连发；静默守卫读）。 */
  getLastCoordReportCompletionSeq(groupId: string): number | undefined
  /** 重启恢复对账：主控在途报告水位回填。 */
  noteCoordReportInflight(groupId: string, completionSeq: number): void
  /** 主控回合结算：清同回合水位。 */
  forgetCoordReportCompletion(groupId: string): void
  /** 组退出活跃态：清该组全部报告水位。 */
  forgetGroupReportState(groupId: string): void
  resetWatermarks(): void
  drain(): Promise<void>
}

export function createWakeDispatcher(ports: WakeDispatcherPorts): WakeDispatcher {
  /** 在途对等成员唤醒集合（key: `${groupId}:${memberName}`）。 */
  const inflightWakeups = new Map<string, InflightWakeupEntry>()
  /** 在途主控汇总调度/投递集合（覆盖整个微批等待窗口与实际投递过程，零间隙跟踪）。 */
  const scheduledReports = new Map<string, ScheduledReportEntry>()
  /** 主控最近一次发出的 board-report 对应的发送前 completionSeq（防同回合连发）。 */
  const lastCoordReportCompletionSeq = new Map<string, number>()
  /** 标记某组最近一次向主控发出的报告时是否仍存在 activeWorkingMembers。 */
  const coordReportSawActiveWorkers = new Map<string, boolean>()

  const hasInflightWakeupsForGroup = (groupId: string): boolean => {
    const prefix = `${groupId}:`
    for (const key of inflightWakeups.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
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
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
    const group = ports.getGroup(groupId)
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
    const allPosts = ports.getPosts(groupId) ?? []
    const selected = selectPostsForMemberWakeup(member, allPosts, fromSeq, toSeq)
    if (selected.length === 0) {
      await ports.mutateGroup(groupId, (draft) => {
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

    await ports.mutateGroup(groupId, (draft) => {
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
      await ports.ctx.host.submitInputGuarded(
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
      await ports.mutateGroup(groupId, (draft) => {
        const target = draft.members.find((m) => m.name === memberName)
        if (target !== undefined) {
          target.readCursorSeq = Math.max(target.readCursorSeq, toSeq)
          target.lastWakeCompletionSeq = baseCompletionSeq
          delete target.inflightWakeup
        }
        return { group: draft, result: undefined }
      })
    } catch (err) {
      await ports.mutateGroup(groupId, (draft) => {
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
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) {
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
        ports.ctx.host.withFileLock(ports.wakeupLockPath(groupId, memberName), async () => {
          let currentFromTurnSettled = retryFromTurnSettled
          for (;;) {
            retryRequested = false
            retryFromTurnSettled = false
            await executeSingleMemberWakeup(groupId, memberName, currentFromTurnSettled)
            if (!retryRequested || ports.isStopping() || ports.ctx.host.isClosing) break
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
    if (ports.hasOtherWorkingOrSettlingMember(group, excludeSettlingConvId)) return false
    if (hasInflightWakeupsForGroup(group.id)) return false
    if (group.members.some((m) => m.lifecycle === 'active' && m.pendingWakeupSeq > m.readCursorSeq)) return false
    const allPosts = ports.getPosts(group.id) ?? []
    const latestPost = allPosts[allPosts.length - 1]
    return latestPost?.kind === 'done'
  }

  /** 执行主控汇总报告组装与投递（在 scheduledReports 单飞保护内执行）。 */
  const executeCoordinatorReportFlush = async (
    groupId: string,
    excludeSettlingConvId?: number,
  ): Promise<void> => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) return
    const group = ports.getGroup(groupId)
    if (group === undefined || group.status !== 'active' || group.coordinatorDetached === true) return

    const hasPendingPosts = group.coordinatorPendingSeq > group.coordinatorNotifiedSeq
    const isIdleCatchup = !hasPendingPosts && shouldSendCoordinatorIdleCatchup(group, excludeSettlingConvId)
    if (!hasPendingPosts && !isIdleCatchup) return

    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    if (coordSummary === undefined) {
      await ports.mutateGroup(groupId, (draft) => {
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

    const allPosts = ports.getPosts(groupId) ?? []
    let fromSeq: number
    let toSeq: number
    let selected: BoardPost[]
    let requestId: string

    if (hasPendingPosts) {
      fromSeq = group.coordinatorNotifiedSeq + 1
      toSeq = group.coordinatorPendingSeq
      selected = selectPostsForCoordinatorReport(allPosts, fromSeq, toSeq)
      if (selected.length === 0) {
        await ports.mutateGroup(groupId, (draft) => {
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
      resolveMemberLive: ports.resolveMemberLive,
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

    await ports.mutateGroup(groupId, (draft) => {
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
      const ownership = ports.ctx.host.getConversationOwnership(group.coordinatorConversationId)
      if (ownership === 'helmx' || ownership === 'bot') {
        await ports.ctx.host.submitInputGuarded(
          group.coordinatorConversationId,
          envelope,
          { origin: 'agent', whenBusy: 'followUp', requestId, meta },
          { expectedOwnership: ownership },
        )
      } else {
        await ports.ctx.host.submitInput(group.coordinatorConversationId, envelope, {
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
      await ports.mutateGroup(groupId, (draft) => {
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
      await ports.mutateGroup(groupId, (draft) => {
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
   * - 同步进入 coord.track + ports.ctx.host.withFileLock(reportLockPathOf)，确保整个 50ms 微批等待窗口与
   *   submitInput 投递期间 service.liveTasks() 与 PluginHost.activeTaskCount() 始终 >= 1；
   * - 冲刷期间若新到达汇报请求，通过 pendingRescheduleMs 在退出前重检循环，避免丢批；
   * - stopAndClear() 时通过 cancel() 立即中断定时器并干净退出。
   */
  const scheduleCoordinatorReport = (
    groupId: string,
    delayMs: number,
    excludeSettlingConvId?: number,
  ): Promise<void> => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || !coord.isActive() || coord.isShutdown() || ports.ctx.host.isClosing) {
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

    const isCancelled = (): boolean => state === 'cancelled' || ports.isStopping()
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
      if (ms <= 0 || readState() !== 'waiting' || ports.isStopping()) {
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
        ports.ctx.host.withFileLock(ports.reportLockPath(groupId), async () => {
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
            const current = ports.getGroup(groupId)
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


  const dispatcher: WakeDispatcher = {
    deliverWorkerWakeup,
    scheduleCoordinatorReport,
    flushCoordinatorReport,
    shouldSendCoordinatorIdleCatchup,
    hasInflightDeliveriesForGroup,

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

    getLastCoordReportCompletionSeq(groupId: string): number | undefined {
      return lastCoordReportCompletionSeq.get(groupId)
    },

    noteCoordReportInflight(groupId: string, completionSeq: number): void {
      lastCoordReportCompletionSeq.set(groupId, completionSeq)
    },

    forgetCoordReportCompletion(groupId: string): void {
      lastCoordReportCompletionSeq.delete(groupId)
    },

    forgetGroupReportState(groupId: string): void {
      coordReportSawActiveWorkers.delete(groupId)
      lastCoordReportCompletionSeq.delete(groupId)
    },

    resetWatermarks(): void {
      lastCoordReportCompletionSeq.clear()
      coordReportSawActiveWorkers.clear()
    },

    async drain(): Promise<void> {
      const pendingReports = [...scheduledReports.values()]
      for (const entry of pendingReports) entry.cancel()
      const pendingWakeups = [...inflightWakeups.values()]
      await Promise.allSettled([
        ...pendingReports.map((entry) => entry.promise),
        ...pendingWakeups.map((entry) => entry.promise),
      ])
      scheduledReports.clear()
      inflightWakeups.clear()
      lastCoordReportCompletionSeq.clear()
      coordReportSawActiveWorkers.clear()
    },
  }

  return dispatcher
}
