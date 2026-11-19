/**
 * builtin:swarm：极简独立多智能体黑板协同插件（默认启用、可停用）。
 *
 * 架构边界（Option A — 零全局常驻会话、零轮询 Watchdog、谁派生谁负责）：
 * - 零启动时常驻会话与零后台巡检定时器，所有协同组按需在顶层人类会话上创建；
 * - 零静态 dependencies（空闲时不阻塞停用 builtin:workflow；持锁工作树由 ManagedWorktreeHold 保护）；
 * - 单真源 <dataDir>/groups/<groupId>/{meta.json, board.jsonl} 派生 index / board-badges / board-view；
 * - 纯 turn_settled 事件驱动自愈（失败自动上板 [blocker]、哑巴退场单次续催、6 条件 0-Token [stall] 守卫）。
 */
import {
  HelmxError,
  type ConversationSummary,
  type MaybePromise,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { readSwarmSkillAsset } from './swarm/assets.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  BOARD_BADGES_DOC_NAME,
  BOARD_REPORT_RENDERER,
  BOARD_VIEW_DOC_NAME,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_SCOPE,
  COORDINATOR_TAG,
  INDEX_DOC_NAME,
  PARTICIPANT_SCOPE,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  WORKER_ARCHIVED_TAG,
  WORKER_TAG,
  asConversationDeletedEvent,
  asConversationUpsertEvent,
  assertBoardPost,
  assertChannelName,
  assertCollabGroupRecord,
  assertGroupId,
  assertIndexDoc,
  assertMemberName,
  resolveSwarmConfig,
  type BoardBadgeEntry,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type BoardViewEdge,
  type BoardViewHeadline,
  type BoardViewMember,
  type CollabChannelSpec,
  type CollabGroupRecord,
  type CollabGroupStatus,
  type CollabGroupSummary,
  type GroupMemberState,
  type MemberLiveState,
  type RetainedWorktreeInfo,
  type SwarmConfig,
  type SwarmCoordinator,
  type SwarmDocs,
  type SwarmIndexDoc,
  type SwarmWorkerPointer,
  type WorkerAccess,
  type WorkerIsolation,
  type WorktreeHandoffSnapshot,
} from './swarm/contracts.js'
import { createCollabGroupRuntime } from './swarm/group-store.js'
import { registerSwarmActions } from './swarm/actions.js'
import { registerSwarmHooks } from './swarm/hooks.js'
import { registerSwarmUi } from './swarm/ui.js'

export function createSwarmPlugin(): PluginDefinition {
  return {
    id: SWARM_PLUGIN_ID,
    name: { en: 'Swarm Peer Collaboration', 'zh-CN': 'Swarm 对等协同' },
    description: {
      en: 'On-demand multi-agent peer collaboration inside a conversation: dynamic author/verifier squads, worktree-isolated handoffs, event-driven stall recovery, and a per-conversation orchestration panel.',
      'zh-CN': '会话内按需多智能体对等协同：动态拆分执行与审阅小队、工作树隔离交接、事件驱动防掉棒自愈与按会话的编排面板。',
    },
    icon: 'network',
    version: '0.1.0',
    ...resolvePluginClientAssets(SWARM_PLUGIN_ID, 'swarm', 'swarm_plugin_client_missing'),
    definePlugin(ctx) {
      let active = false
      let shutdown = false
      let dispatchChain: Promise<unknown> = Promise.resolve()
      const liveTasks = new Map<string, number>()
      const settlingWorkers = new Map<number, number>()
      let upsertUnsubscribe: (() => void) | undefined
      let deletedUnsubscribe: (() => void) | undefined
      let runtimeStartedUnsubscribe: (() => void) | undefined
      let reconcilePromise: Promise<void> | undefined

      const countLabel = (label: string, delta: number): void => {
        const next = (liveTasks.get(label) ?? 0) + delta
        if (next > 0) liveTasks.set(label, next)
        else liveTasks.delete(label)
      }

      async function track<T>(label: string, task: () => MaybePromise<T>): Promise<T> {
        if (shutdown) {
          throw new HelmxError('plugin_disabled', `${SWARM_PLUGIN_ID} 已停用，拒绝后台任务 ${label}`, 409, {
            pluginId: SWARM_PLUGIN_ID,
          })
        }
        countLabel(label, +1)
        try {
          return await task()
        } finally {
          countLabel(label, -1)
        }
      }

      const logDiagnostic = (message: string): void => {
        console.error(`[swarm] ${ctx.host.redact(message)}`)
      }

      const reportError = (title: string, detail: unknown): void => {
        const message = detail instanceof Error ? detail.message : String(detail)
        const body = ctx.host.redact(`${title}：${message}`)
        try {
          ctx.host.emitEvent('notification', {
            type: 'notification',
            level: 'error',
            title: ctx.host.redact(title),
            body,
          })
        } catch (eventErr) {
          logDiagnostic(`swarm 事件上报失败：${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
        }
      }

      const getConfig = (): SwarmConfig =>
        resolveSwarmConfig(ctx.getConfig() as Record<string, unknown>)

      const docs: SwarmDocs = {
        index: ctx.doc<SwarmIndexDoc>(INDEX_DOC_NAME, { workers: [], groups: [] }, { public: true, durable: false }),
        boardBadges: ctx.doc<BoardBadgesDoc>(BOARD_BADGES_DOC_NAME, { byConversation: {} }, { public: true, durable: false }),
        boardView: ctx.sessionDoc<BoardViewDoc | null>(BOARD_VIEW_DOC_NAME, null, { public: true, durable: false }),
      }

      const readIndex = (): SwarmIndexDoc => assertIndexDoc(docs.index.get())
      const writeIndex = (next: SwarmIndexDoc): SwarmIndexDoc => {
        assertIndexDoc(next)
        docs.index.set(next)
        return next
      }

      const readConversationOrUndefined = (id: number | undefined): ConversationSummary | undefined => {
        if (!Number.isInteger(id) || (id as number) <= 0) return undefined
        try {
          return ctx.host.getConversation(id as number)
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') return undefined
          throw err
        }
      }

      let coordinatorRef!: SwarmCoordinator
      const groupsRuntime = createCollabGroupRuntime(ctx, () => coordinatorRef)

      const coordinator: SwarmCoordinator = {
        isActive: () => active,
        isShutdown: () => shutdown,
        getConfig,
        getDocs: () => docs,
        readIndex,
        writeIndex,
        readConversationOrUndefined,
        reportError,
        enqueueDispatch: <T>(fn: () => Promise<T>): Promise<T> => {
          const task = dispatchChain.then(fn, fn)
          dispatchChain = task.catch(() => undefined)
          return task
        },
        track,
        groups: groupsRuntime,
        settlingWorkers,
      }
      coordinatorRef = coordinator

      registerSwarmActions(ctx, coordinator)
      registerSwarmHooks(ctx, coordinator)
      registerSwarmUi(ctx)

      ctx.configSchema({
        maxWorkersPerGroup: {
          type: 'number',
          label: { en: 'Max workers per group', 'zh-CN': '单组最大成员数' },
          description: {
            en: 'Maximum active peer members allowed in a single collaboration group (integer 2..32)',
            'zh-CN': '单个协作组同时处于活跃生命周期的对等成员上限（整数 2..32）',
          },
          default: 12,
        },
        boardPreviewLimit: {
          type: 'number',
          label: { en: 'Board preview limit', 'zh-CN': '看板预览消息上限' },
          description: {
            en: 'Maximum recent board posts retained in the board-view session document (integer 20..200)',
            'zh-CN': '看板实时会话文档保留的最近流转消息条数上限（整数 20..200）',
          },
          default: 80,
        },
      })

      ctx.service({
        id: 'swarm-core',
        liveTasks() {
          const labels = [...liveTasks.keys(), ...groupsRuntime.liveTaskLabels()]
          if (!active) return labels
          const busyIds = new Set<number>()
          for (const w of readIndex().workers) busyIds.add(w.conversationId)
          for (const id of busyIds) {
            try {
              const s = ctx.host.getConversation(id)
              if (s.status === 'working' || s.status === 'blocked') labels.push(`worker-run:${id}`)
            } catch (err) {
              if (err instanceof HelmxError && err.code === 'not_found') continue
              throw err
            }
          }
          for (const [settlingId, count] of settlingWorkers) {
            if (count > 0) labels.push(`worker-settle:${settlingId}`)
          }
          return labels
        },
        inUse() {
          if (!active) return []
          return groupsRuntime.inUseItems()
        },
        async start() {
          shutdown = false
          getConfig()
          readIndex()
          await ctx.host.skills.ensureSkill(readSwarmSkillAsset())
          upsertUnsubscribe = ctx.host.onEvent('conversation.upsert', (payload) => {
            if (!active || shutdown) return
            const upsert = asConversationUpsertEvent(payload)
            if (upsert === undefined) return
            groupsRuntime.onConversationUpsert(upsert.id)
          })
          deletedUnsubscribe = ctx.host.onEvent('conversation.deleted', async (payload) => {
            if (!active || shutdown) return
            const deletedId = asConversationDeletedEvent(payload)
            if (deletedId === undefined) return
            await groupsRuntime.onConversationDeleted(deletedId)
          })
          runtimeStartedUnsubscribe = ctx.host.onEvent('runtime.started', () => {
            if (!active || shutdown) return
            const task = track('reconcile-recovered-groups', () => groupsRuntime.reconcileRecoveredGroups()).catch(
              (err) => {
                if (!shutdown) reportError('Swarm 启动恢复对账失败', err)
              },
            )
            reconcilePromise = task
            return task
          })
          active = true
          await groupsRuntime.loadAllFromDisk()
          await groupsRuntime.reconcileOrphansOnBoot()
        },
        async stop() {
          shutdown = true
          active = false
          upsertUnsubscribe?.()
          upsertUnsubscribe = undefined
          deletedUnsubscribe?.()
          deletedUnsubscribe = undefined
          runtimeStartedUnsubscribe?.()
          runtimeStartedUnsubscribe = undefined
          await groupsRuntime.stopAndClear()
          if (reconcilePromise !== undefined) {
            await Promise.allSettled([reconcilePromise])
            reconcilePromise = undefined
          }
          settlingWorkers.clear()
        },
      })
    },
  }
}

export {
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  COORDINATOR_TAG,
  WORKER_TAG,
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  WORKER_ARCHIVED_TAG,
  COORDINATOR_SCOPE,
  PARTICIPANT_SCOPE,
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  INDEX_DOC_NAME,
  BOARD_BADGES_DOC_NAME,
  BOARD_VIEW_DOC_NAME,
  resolveSwarmConfig,
  assertIndexDoc,
  assertCollabGroupRecord,
  assertBoardPost,
  assertMemberName,
  assertChannelName,
  assertGroupId,
  type SwarmConfig,
  type WorkerAccess,
  type WorkerIsolation,
  type CollabGroupStatus,
  type BoardPostKind,
  type SwarmWorkerPointer,
  type SwarmIndexDoc,
  type CollabGroupSummary,
  type GroupMemberState,
  type RetainedWorktreeInfo,
  type CollabChannelSpec,
  type CollabGroupRecord,
  type WorktreeHandoffSnapshot,
  type BoardPost,
  type BoardBadgeEntry,
  type BoardBadgesDoc,
  type BoardViewHeadline,
  type MemberLiveState,
  type BoardViewMember,
  type BoardViewEdge,
  type BoardViewDoc,
}

export {
  resolveDefaultWake,
  resolvePostChannel,
  resolveBoardTargets,
  aggregateBoardEdges,
  synthesizeHeadline,
  synthesizeBoardView,
} from './swarm/board-router.js'

export {
  evaluateSilentExit,
  diagnoseStallRootCause,
  computeStallWatermark,
  evaluateGroupQuiescence,
} from './swarm/board-stall.js'

export {
  activeSwarmGroupCoordinatorSection,
  activeSwarmGroupWorkerSection,
} from './swarm/hooks.js'

export { registerSwarmUi } from './swarm/ui.js'
