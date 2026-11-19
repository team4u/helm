/**
 * builtin:swarm 协作组单真源存储与运行时门面（组合根）。
 *
 * 四层存储职责：
 * 1) 唯一权威真源：<dataDir>/groups/<groupId>/{meta.json, board.jsonl}
 *    （按组串行队列 + withFileLock 互斥 + redactJsonValue 全量脱敏 + atomicWriteFile 原子替换）；
 * 2) 全局轻量反查索引：ctx.doc('index')（projections.ts 派生，零双写漂移）；
 * 3) 会话级实时看板投影：ctx.sessionDoc('board-view')（projections.ts 指纹去重）；
 * 4) 顶栏与侧栏角标：ctx.doc('board-badges')（projections.ts）。
 *
 * 本模块同时是组合根：装配 wake-dispatcher（唤醒投递与主控报告调度）、projections（投影）、
 * member-healing（成员自愈与恢复对账）三个子模块，并对外暴露 CollabGroupRuntime 契约。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HelmxError,
  redactJsonValue,
  type HelmxPluginContext,
  type MaybePromise,
} from '@helmx/protocol'
import {
  ACTIONABLE_WAKE_KINDS,
  COORDINATOR_BATCH_WINDOW_MS,
  COORDINATOR_ESCALATION_KINDS,
  SWARM_PLUGIN_ID,
  assertBoardPost,
  assertChannelName,
  assertCollabGroupRecord,
  assertGroupId,
  isEnoent,
  isLifecycleTeardownError,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type CollabChannelSpec,
  type CollabGroupRecord,
  type CollabGroupRuntime,
  type GroupMemberState,
  type MemberLiveState,
  type SwarmCoordinator,
  type WorktreeHandoffSnapshot,
} from './contracts.js'
import { synthesizeBoardView } from './board-router.js'
import {
  reconcileOrphanConversations,
  reconcileOrphanWorktreeHolds,
} from './recovery.js'
import { createWakeDispatcher } from './wake-dispatcher.js'
import { createBoardProjections } from './projections.js'
import { createMemberHealing } from './member-healing.js'

function generateGroupId(): string {
  return `grp_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
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
  /** 活跃 Worker 会话受管锁释放句柄（仅锁活跃成员，归档/结单/删除/停用释放）。 */
  const managedWorkerReleases = new Map<number, () => void>()
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
      dispatcher.forgetGroupReportState(group.id)
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
    projections.syncIndex()
    projections.syncProjections()
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

    projections.syncIndex()
    projections.syncProjections()

    for (const memberName of membersToWake) {
      void dispatcher.deliverWorkerWakeup(validId, memberName)
    }
    if (shouldNotifyCoordinator) {
      const latestGroup = groupsById.get(validId)
      const isUrgent = createdPost.kind === 'blocker' || createdPost.kind === 'stall'
      const workersBusy = latestGroup !== undefined && hasOtherWorkingOrSettlingMember(latestGroup)
      if (isUrgent || !workersBusy) {
        void dispatcher.scheduleCoordinatorReport(validId, COORDINATOR_BATCH_WINDOW_MS)
      }
    }

    return createdPost
  }

  // ---- 子模块装配（组合根）：唤醒调度 / 投影 / 成员自愈 ----
  const dispatcher = createWakeDispatcher({
    ctx,
    getCoordinator,
    isStopping: () => stopping,
    getGroup: (groupId) => groupsById.get(groupId),
    getPosts: (groupId) => postsByGroup.get(groupId) ?? [],
    mutateGroup,
    reportLockPath: reportLockPathOf,
    wakeupLockPath: wakeupLockPathOf,
    resolveMemberLive,
    hasOtherWorkingOrSettlingMember,
  })

  const projections = createBoardProjections({
    getCoordinator,
    isStopping: () => stopping,
    getAllGroups: () => [...groupsById.values()],
    getPosts: (groupId) => postsByGroup.get(groupId),
    resolveMemberLive,
  })

  const healing = createMemberHealing({
    ctx,
    getCoordinator,
    isStopping: () => stopping,
    getGroup: (groupId) => groupsById.get(groupId),
    getPosts: (groupId) => postsByGroup.get(groupId),
    setPostsCache: (groupId, posts) => {
      postsByGroup.set(groupId, posts)
    },
    mutateGroup,
    appendPost,
    persistMeta: persistMetaLocked,
    runGroupLocked,
    metaPath: metaPathOf,
    boardPath: boardPathOf,
    logDiagnostic,
    releaseManagedWorker,
    dispatcher,
    hasOtherWorkingOrSettlingMember,
  })

  const findActiveGroupByCoordinator = (conversationId: number): CollabGroupRecord | undefined => {
    for (const group of groupsById.values()) {
      if (group.status === 'active' && group.coordinatorConversationId === conversationId) {
        return group
      }
    }
    return undefined
  }

  const findGroupByParticipant = (
    conversationId: number,
  ):
    | { group: CollabGroupRecord; role: 'coordinator' }
    | { group: CollabGroupRecord; role: 'worker'; member: GroupMemberState }
    | undefined => {
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
  }

  const findLatestGroupForConversation = (conversationId: number): CollabGroupRecord | undefined => {
    const active = findGroupByParticipant(conversationId)
    if (active !== undefined) return active.group
    const candidates = [...groupsById.values()]
      .filter(
        (g) =>
          g.coordinatorConversationId === conversationId ||
          g.members.some((m) => m.conversationId === conversationId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    return candidates[0]
  }

  const runtimeHandle: CollabGroupRuntime = {
    async loadAllFromDisk(): Promise<void> {
      stopping = false
      orphanWorktreesReconciled = false
      releaseAllManagedWorkers()
      groupsById.clear()
      postsByGroup.clear()
      groupQueues.clear()
      projections.reset()
      dispatcher.resetWatermarks()

      let dirEntries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        dirEntries = await readdir(getGroupsRootDir(), { withFileTypes: true })
      } catch (err) {
        if (!isEnoent(err)) throw err
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const groupId = assertGroupId(entry.name)
        const { record, posts } = await healing.loadGroupFromDisk(groupId)
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
            await healing.reconcileDeletedWorker(group.id, member.conversationId)
          } else {
            ensureWorkerManaged(member.conversationId)
          }
        }
      }

      projections.syncIndex()
      projections.syncProjections()
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
        await healing.reconcileSingleRecoveredGroup(group.id)
      }
      projections.syncProjections()
    },

    async stopAndClear(): Promise<void> {
      stopping = true
      await dispatcher.drain()
      releaseAllManagedWorkers()
      groupQueues.clear()
      groupsById.clear()
      postsByGroup.clear()
      projections.reset()
    },

    liveTaskLabels(): string[] {
      return dispatcher.liveTaskLabels()
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

    findActiveGroupByCoordinator,
    findGroupByParticipant,
    findLatestGroupForConversation,

    getPosts(groupId: string): readonly BoardPost[] {
      return postsByGroup.get(groupId) ?? []
    },

    ensurePostsLoaded: healing.ensurePostsLoaded,

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

    syncProjections: projections.syncProjections,

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
      projections.syncProjections()
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
          await healing.reconcileDeletedWorker(group.id, conversationId)
        } else if (group.members.some((m) => m.conversationId === conversationId)) {
          projections.syncProjections()
        }
      }
      projections.forgetCoordinator(conversationId)
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
      projections.syncIndex()
      projections.syncProjections()
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

      projections.syncIndex()
      projections.syncProjections()
      if (
        !added.replayed ||
        (added.member.pendingWakeupSeq > added.member.readCursorSeq &&
          added.member.inflightWakeup === undefined)
      ) {
        await dispatcher.deliverWorkerWakeup(validId, added.member.name)
      }
      return { group: added.group, member: added.member, post: added.post }
    },

    appendPost,
    mutateGroup,

    async onMemberTurnSettled(input): Promise<void> {
      await healing.onMemberTurnSettled(input)
    },

    async onCoordinatorTurnSettled(conversationId: number): Promise<void> {
      const coord = getCoordinator()
      if (stopping || !coord.isActive() || coord.isShutdown() || ctx.host.isClosing) return
      const group = findActiveGroupByCoordinator(conversationId)
      if (group === undefined) return
      dispatcher.forgetCoordReportCompletion(group.id)
      projections.syncProjections()

      if (
        !group.coordinatorDetached &&
        (group.coordinatorPendingSeq > group.coordinatorNotifiedSeq ||
          dispatcher.shouldSendCoordinatorIdleCatchup(group))
      ) {
        await dispatcher.flushCoordinatorReport(group.id)
        return
      }
      await healing.checkAndEmitQuiescenceStall(group.id)
    },
  }

  return runtimeHandle
}
