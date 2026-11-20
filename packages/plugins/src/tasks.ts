/**
 * builtin:tasks：任务看板插件（默认启用、可停用）。
 *
 * 架构边界（零内核改动、零常驻角色）：
 * - 零启动常驻会话与零受管 Profile：执行者按需创建**独立顶层 human-owned 会话**
 *   （无 parentConversationId、不标 helmx 归属），完整保留 subagent / SubagentWorkflow /
 *   Swarm 自主编排决策权；
 * - 无静态 dependencies：空闲时不阻塞 builtin:workflow / builtin:swarm 停用；
 * - 单真源私有持久 doc `records` 派生公开瞬态投影 `board`（防 2 MiB 写放大）；
 * - 纯事件驱动诚实标记（conversation.deleted 落 conversationMissing；主会话
 *   error/blocked/待答 Ask 由投影按实时事实折进徽标），零投递零定时器零强杀——
 *   human-owned 会话红线：绝不自动轻推，由用户显式继续；
 * - 受管技能 `tasks` 随启停自举/消失，赋予任意 Profile 需求拆解与派单能力。
 */
import {
  HelmxError,
  type ConversationSummary,
  type MaybePromise,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { readTasksSkillAsset } from './tasks/assets.js'
import {
  TASK_ACTIVE_TAG,
  TASK_ARCHIVED_TAG,
  TASK_BOARD_DOC,
  TASK_RECORDS_DOC,
  TASKS_PLUGIN_ID,
  TASKS_SKILL_ID,
  resolveTasksConfig,
  type TaskBoardDoc,
  type TaskStoreDoc,
  type TasksConfig,
} from './tasks/contracts.js'
import { createTasksStore } from './tasks/store.js'
import { registerTasksActions, type TasksRuntime } from './tasks/actions.js'
import { onTasksConversationDeleted, registerTasksHooks } from './tasks/hooks.js'
import { registerTasksUi } from './tasks/ui.js'
import { asConversationDeletedEvent } from './tasks/contracts.js'

export function createTasksPlugin(): PluginDefinition {
  return {
    id: TASKS_PLUGIN_ID,
    name: { en: 'Task Board', 'zh-CN': '任务看板' },
    description: {
      en: 'Delegate well-defined work units to independent task execution conversations tracked on a 4-column board: submit/approve/rework review loops and a managed planning skill.',
      'zh-CN': '把定义清晰的工作单元派发到独立任务执行会话并在四列看板上跟踪：交卷/验收/返工闭环与受管规划技能。',
    },
    icon: 'check-square',
    version: '0.1.0',
    ...resolvePluginClientAssets(TASKS_PLUGIN_ID, 'tasks', 'tasks_plugin_client_missing'),
    definePlugin(ctx) {
      let active = false
      let shutdown = false
      let deletedUnsubscribe: (() => void) | undefined
      let stateUnsubscribers: Array<() => void> = []
      const liveTasks = new Map<string, number>()

      /** 会话状态 / Ask 变化的真实内核事件名（protocol `events.ts` 契约，勿凭空猜测）：
       * conversation.upsert（状态 / pendingAskCount / 摘要变化）+ ask.upsert / ask.resolved。 */
      const CONVERSATION_STATE_EVENT_TYPES = ['conversation.upsert', 'ask.upsert', 'ask.resolved'] as const

      const countLabel = (label: string, delta: number): void => {
        const next = (liveTasks.get(label) ?? 0) + delta
        if (next > 0) liveTasks.set(label, next)
        else liveTasks.delete(label)
      }

      async function track<T>(label: string, task: () => MaybePromise<T>): Promise<T> {
        if (shutdown) {
          throw new HelmxError('plugin_disabled', `${TASKS_PLUGIN_ID} 已停用，拒绝后台任务 ${label}`, 409, {
            pluginId: TASKS_PLUGIN_ID,
          })
        }
        countLabel(label, +1)
        try {
          return await task()
        } finally {
          countLabel(label, -1)
        }
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
          console.error(
            `[tasks] 事件上报失败：${eventErr instanceof Error ? eventErr.message : String(eventErr)}`,
          )
        }
      }

      const getConfig = (): TasksConfig => resolveTasksConfig(ctx.getConfig() as Record<string, unknown>)

      const docs = {
        records: ctx.doc<TaskStoreDoc>(
          TASK_RECORDS_DOC,
          { nextSeq: 1, tasks: {} },
          { public: false, durable: true },
        ),
        board: ctx.doc<TaskBoardDoc>(
          TASK_BOARD_DOC,
          {
            tasks: [],
            updatedAt: 0,
            attentionCount: 0,
            reviewCount: 0,
            runningCount: 0,
            hasRunning: false,
            badgeTone: 'neutral',
          },
          { public: true, durable: false },
        ),
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

      const store = createTasksStore(docs.records, docs.board, {
        listConversations: () => ctx.host.listConversations(),
        onMutationStart: (label) => countLabel(`store:${label}`, +1),
        onMutationEnd: (label) => countLabel(`store:${label}`, -1),
      })

      const runtime: TasksRuntime = {
        isActive: () => active,
        isShutdown: () => shutdown,
        getConfig,
        store,
        flushRecords: () => docs.records.flush(),
        readConversationOrUndefined,
        reportError,
        track,
      }

      /** 未归档 in_progress / in_review 卡存在性：会话事件订阅的廉价门（无活跃卡时徽标与会话事实无关）。 */
      const hasActiveBoardTasks = (): boolean =>
        Object.values(store.read().tasks).some(
          (t) => t.archived !== true && (t.column === 'in_progress' || t.column === 'in_review'),
        )

      registerTasksActions(ctx, runtime)
      registerTasksHooks(ctx, runtime)
      registerTasksUi(ctx)

      ctx.configSchema({
        defaultPlannerProfile: {
          type: 'string',
          label: { en: 'Default planner profile', 'zh-CN': '默认规划角色' },
          description: {
            en: "Profile id opened by the board's 'chat a new task' button (default 'assistant')",
            'zh-CN': '看板「聊一个新任务」按钮跳转的规划角色 Profile ID（默认 assistant）',
          },
          default: 'assistant',
        },
        defaultAssigneeProfile: {
          type: 'string',
          label: { en: 'Default assignee profile', 'zh-CN': '默认执行角色' },
          description: {
            en: "Fallback executor profile when a task does not specify one (default 'assistant')",
            'zh-CN': '创建任务未指定执行角色时的回退 Profile ID（默认 assistant）',
          },
          default: 'assistant',
        },
      })

      ctx.service({
        id: 'tasks-core',
        liveTasks() {
          return [...liveTasks.keys()]
        },
        inUse() {
          if (!active) return []
          return Object.values(store.read().tasks)
            .filter((t) => t.column === 'in_progress' || t.column === 'in_review')
            .map((t) => ({
              kind: 'task_board',
              id: t.id,
              label: `Task ${t.id} "${t.title}" (${t.column})`,
            }))
        },
        async start() {
          shutdown = false
          getConfig()
          store.read()
          await ctx.host.skills.ensureSkill(readTasksSkillAsset())
          // 先置活再执行恢复两块（启动中断回滚 / 孤儿会话收口）：补投触发的首回合
          // 必须命中 before_turn 的 isActive() 门，携带 <active_task> 段落与正确的工具隔离。
          active = true
          // 启动中断恢复（单会话原子化启动的崩溃窗口，诚实回滚绝不自动重投）：
          // a) in_progress 未绑定会话（recreate 绑定前崩溃）→ 诚实回滚 backlog；
          // b) 已绑定会话但零 helmx.input（任务书投递前崩溃）→ 回滚 backlog + 会话贴
          //    task-archived 保留现场（绝不向 human-owned 会话自动提交任何输入，
          //    用户 reset 清空的意图同样得到尊重）。
          const interrupted = new Map<string, number | undefined>()
          for (const task of Object.values(runtime.store.read().tasks)) {
            if (task.column !== 'in_progress') continue
            if (task.conversationId === undefined) {
              interrupted.set(task.id, undefined)
              continue
            }
            try {
              const detail = await ctx.host.getConversationDetail(task.conversationId, { limit: 50 })
              if (!detail.entries.some((e) => e.kind === 'helmx.input')) {
                interrupted.set(task.id, task.conversationId)
              }
            } catch (err) {
              if (err instanceof HelmxError && err.code === 'not_found') continue
              reportError(`启动恢复检查任务 ${task.id} 绑定会话 #${task.conversationId} 失败`, err)
            }
          }
          if (interrupted.size > 0) {
            await runtime.store.enqueueMutation((draft) => {
              for (const id of interrupted.keys()) {
                const task = draft.tasks[id]
                if (task === undefined || task.column !== 'in_progress') continue
                task.column = 'backlog'
                delete task.conversationId
                delete task.startedAt
                delete task.conversationMissing
                task.updatedAt = Date.now()
              }
            })
            await runtime.flushRecords()
            for (const conversationId of interrupted.values()) {
              if (conversationId === undefined) continue
              const conv = readConversationOrUndefined(conversationId)
              if (conv === undefined) continue
              const nextTags = [...conv.tags.filter((tg) => tg !== TASK_ACTIVE_TAG), TASK_ARCHIVED_TAG]
              await ctx.host.updateConversation(conversationId, { tags: nextTags }).catch(() => undefined)
            }
            console.error(
              `[tasks] 启动恢复：${interrupted.size} 个启动中断任务已回滚待办（${[...interrupted.keys()].join(', ')}），可手动重新开工`,
            )
          }
          // Q1 孤儿会话恢复：绑定前崩溃遗留的「task 标签 + 零输入 + 不绑任何任务」会话——
          // 诚实贴 task-archived（保留现场，仅收口侧栏分组）并上报，绝不删除会话。
          const boundConversationIds = new Set(
            Object.values(runtime.store.read().tasks)
              .map((t) => t.conversationId)
              .filter((id): id is number => id !== undefined),
          )
          for (const conv of ctx.host.listConversations({ topLevelOnly: true })) {
            if (!conv.tags.includes(TASK_ACTIVE_TAG) || boundConversationIds.has(conv.id)) continue
            try {
              const detail = await ctx.host.getConversationDetail(conv.id, { limit: 50 })
              if (detail.entries.some((e) => e.kind === 'helmx.input')) continue
              const nextTags = [...conv.tags.filter((tg) => tg !== TASK_ACTIVE_TAG), TASK_ARCHIVED_TAG]
              await ctx.host.updateConversation(conv.id, { tags: nextTags })
              console.error(
                `[tasks] 启动恢复：检测到绑定前崩溃遗留的孤儿执行会话 #${conv.id}（已贴归档标签保留现场）`,
              )
            } catch (err) {
              if (err instanceof HelmxError && err.code === 'not_found') continue
              reportError(`孤儿执行会话 #${conv.id} 恢复检查失败`, err)
            }
          }
          deletedUnsubscribe = ctx.host.onEvent('conversation.deleted', (payload) => {
            if (!active || shutdown) return
            const deletedId = asConversationDeletedEvent(payload)
            if (deletedId === undefined) return
            return onTasksConversationDeleted(runtime, deletedId)
          })
          // 徽标实时感知：订阅会话状态 / Ask 变化事件，仅当存在未归档活跃卡时重投影，
          // 且经徽标元组脏检查后真正变化才写 board（高频流式事件零 SSE 写放大）。
          stateUnsubscribers = CONVERSATION_STATE_EVENT_TYPES.map((type) =>
            ctx.host.onEvent(type, () => {
              if (!active || shutdown) return
              if (!hasActiveBoardTasks()) return
              store.refreshBoardIfBadgeChanged()
            }),
          )
          store.refreshBoard()
        },
        async stop() {
          shutdown = true
          active = false
          deletedUnsubscribe?.()
          deletedUnsubscribe = undefined
          for (const unsubscribe of stateUnsubscribers) unsubscribe()
          stateUnsubscribers = []
        },
      })
    },
  }
}

export {
  TASKS_PLUGIN_ID,
  TASKS_SKILL_ID,
  TASK_BOARD_DOC,
  TASK_RECORDS_DOC,
  resolveTasksConfig,
  type TaskBoardDoc,
  type TaskStoreDoc,
  type TasksConfig,
}
export {
  TASK_ACTIVE_TAG,
  TASK_ARCHIVED_TAG,
  ACTIVE_TASK_SECTION_ID,
  TASK_BOARD_DONE_HISTORY_LIMIT,
  TASK_BOARD_SIDEBAR_BADGE,
  TASK_COLUMNS,
  assertTaskId,
  assertTaskRecord,
  assertTaskStoreDoc,
  projectBoardDoc,
  taskBoardBadgeKey,
  type TaskBoardBadgeTone,
  type TaskColumn,
  type TaskRecord,
  type TaskSubmission,
} from './tasks/contracts.js'
export { activeTaskSection, buildTaskKickoffPrompt } from './tasks/prompts.js'
export { filterTaskToolsForTurn } from './tasks/hooks.js'
