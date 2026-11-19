/**
 * builtin:tasks 真实组合层整链集成测试（Integration 档，createHelmx 全插件）：
 * 1) 默认启用、启动零常驻会话、空闲不阻塞 disable('builtin:workflow')、受管技能 tasks 随启停显隐、inUse 保护；
 * 2) create(autoStart) 建独立顶层 human-owned 执行会话（无 parentConversationId、tags 含 task），
 *    任务书投递 + <active_task> 恒定段落 + 规划/执行工具隔离 + 执行会话内实测派 subagent 子代理；
 * 3) 完整闭环 create → submit → rework → submit → approve(close_only)（tag 换 task-archived、下游依赖自动接棒）；
 * 4) merge_and_close（mergePending + 合并指令投递 + 再次 submit 收口）；
 * 5) 依赖阻塞 / 环拒绝 / 并发上限；
 * 6) 防沉默单次轻推与停滞标记（turn_settled 纯事件驱动）、conversation.deleted 诚实标记；
 * 7) 停用后工具 / UI / 受管技能即时消失且已有执行会话完整保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { HelmxError } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import {
  makeFauxProvider,
  useTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'
import {
  ACTIVE_TASK_SECTION_ID,
  TASKS_PLUGIN_ID,
  TASKS_SKILL_ID,
  TASK_ACTIVE_TAG,
  TASK_ARCHIVED_TAG,
  type TaskBoardDoc,
  type TaskRecord,
} from '../src/tasks.js'

const WORKFLOW_ID = 'builtin:workflow'

interface TasksTestEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelmx>>
  close(): Promise<void>
}

async function openTasksEnv(root: string): Promise<TasksTestEnv> {
  const dataDir = join(root, 'data')
  const faux = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  faux.setResponses([])
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close()
    },
  }
}

function captureRequestMeta(messages: readonly Record<string, unknown>[]): {
  toolNames: string[]
  sectionsById: Record<string, string>
  lastUserText: string
} {
  const tools = getCurrentTools(messages as never)
  const sectionsById: Record<string, string> = {}
  for (const m of messages) {
    if (m['role'] === 'system' && typeof m['sections'] === 'object' && m['sections'] !== null) {
      for (const [k, v] of Object.entries(m['sections'] as Record<string, unknown>)) {
        if (typeof v === 'string') sectionsById[k] = v
      }
    }
  }
  let lastUserText = ''
  for (const m of messages) {
    if (m['role'] !== 'user') continue
    const content = m['content']
    let texts: string[] = []
    if (typeof content === 'string') texts = [content]
    else if (Array.isArray(content)) {
      texts = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
    }
    if (texts.length > 0) lastUserText = texts[texts.length - 1]!
  }
  return { toolNames: tools.map((t) => t.name), sectionsById, lastUserText }
}

type FauxStep = NonNullable<Parameters<FauxProviderHandle['setResponses']>[0]>[number]
type FauxFactoryArgs = Parameters<Extract<FauxStep, (...args: never[]) => unknown>>

interface RouteSnapshot {
  toolNames: string[]
  hasActiveTask: boolean
}

/**
 * 按请求事实路由 faux 响应：
 * - 带 tasks.active_task section → 任务执行会话；
 * - 无 section 且可见 task_create → 顶层规划会话；
 * - 无 section 且无 task_create → 子代理会话（subagent 派生）。
 */
function setRoutedResponses(
  faux: FauxProviderHandle,
  queues: { assignee: FauxStep[]; planner: FauxStep[]; child: FauxStep[] },
  maxCalls = 64,
): Array<RouteSnapshot & { lastUserText: string }> {
  const observed: Array<RouteSnapshot & { lastUserText: string }> = []
  const cursors = { assignee: 0, planner: 0, child: 0 }
  const dispatch: FauxStep = (async (ctx: FauxFactoryArgs[0], ...rest) => {
    const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
    const key: keyof typeof cursors = meta.sectionsById[ACTIVE_TASK_SECTION_ID] !== undefined
      ? 'assignee'
      : meta.toolNames.includes('task_create')
        ? 'planner'
        : 'child'
    observed.push({
      toolNames: meta.toolNames,
      hasActiveTask: meta.sectionsById[ACTIVE_TASK_SECTION_ID] !== undefined,
      lastUserText: meta.lastUserText,
    })
    const list = queues[key]
    const idx = cursors[key]
    cursors[key] = idx + 1
    const step = list[idx]
    if (step === undefined) {
      throw new Error(`Unexpected faux request for route "${key}" at index ${idx}`)
    }
    if (typeof step === 'function') {
      return await (step as (c: FauxFactoryArgs[0], ...r: unknown[]) => unknown)(ctx, ...rest)
    }
    return step
  }) as FauxStep
  faux.setResponses(Array.from({ length: maxCalls }, () => dispatch))
  return observed
}

function boardDoc(env: TasksTestEnv): TaskBoardDoc {
  return env.app.kernel.plugins.getPublicDoc(TASKS_PLUGIN_ID, 'board').value as TaskBoardDoc
}

async function taskFromAction(env: TasksTestEnv, taskId: string): Promise<TaskRecord> {
  const res = (await env.app.kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'inspect', { taskId })) as {
    task: TaskRecord
  }
  return res.task
}

test('tasks-int1: default-enabled boot, zero residents, workflow-disable freedom, skill lifecycle, inUse guard', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int1-'))
  try {
    const { kernel } = env.app
    const summary = kernel.plugins.list().find((p) => p.id === TASKS_PLUGIN_ID)
    assert.ok(summary, 'createHelmx must register builtin:tasks')
    assert.equal(summary!.enabled, true, 'builtin:tasks must be default-enabled')
    assert.equal(
      kernel.listConversations().some((c) => c.tags.includes(TASK_ACTIVE_TAG) || c.ownedBy === 'helmx'),
      false,
      'builtin:tasks must NOT create any resident conversations on boot',
    )

    // Idle tasks has no static dependency on builtin:workflow
    await kernel.plugins.disable(WORKFLOW_ID)
    await kernel.plugins.enable(WORKFLOW_ID)

    // Managed skill 'tasks' is available while enabled
    const loaded = (await kernel.plugins.executeTool('load_skill', { skillId: TASKS_SKILL_ID }, { conversationId: 1 })) as {
      text: string
    }
    assert.match(loaded.text, /Planner Rule/)

    // No duplicate palette command (screens are reachable via the rail sidebar item)
    assert.equal(
      kernel.plugins.listUi().filter((u) => u.pluginId === TASKS_PLUGIN_ID && u.surface === 'commandPalette').length,
      0,
    )
    const surfaces = kernel.plugins
      .listUi()
      .filter((u) => u.pluginId === TASKS_PLUGIN_ID)
      .map((u) => `${u.surface}:${String((u.spec as { id?: string }).id)}`)
      .sort()
    assert.deepEqual(surfaces, [
      'screen:board',
      'sidebar.item:task-board',
      'sidebar.section:task-archived-conversations',
      'sidebar.section:task-conversations',
      'tool.view:task-tool-card',
    ])
  } finally {
    await env.close()
  }
})

test('tasks-int2: autoStart creates an independent top-level human-owned conversation with tool isolation and live subagent spawn', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int2-'))
  try {
    const { kernel } = env.app
    const observed = setRoutedResponses(env.faux, {
      // Task execution conversation: first spawn a subagent, then submit
      assignee: [
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          // Tool isolation on the very first beat
          assert.equal(meta.toolNames.includes('task_create'), false, 'assignee must NOT see task_create')
          assert.equal(meta.toolNames.includes('task_approve'), false)
          assert.equal(meta.toolNames.includes('task_rework'), false)
          assert.equal(meta.toolNames.includes('task_start'), false)
          for (const expected of ['task_submit', 'task_list', 'task_inspect', 'subagent', 'SubagentWorkflow', 'swarm_create_group', 'bash']) {
            assert.ok(meta.toolNames.includes(expected), `assignee must keep ${expected} (actual: ${meta.toolNames.join(',')})`)
          }
          assert.match(meta.sectionsById[ACTIVE_TASK_SECTION_ID]!, /^<active_task id="T-1"/)
          assert.match(meta.sectionsById[ACTIVE_TASK_SECTION_ID]!, /task_submit/)
          assert.equal(meta.lastUserText.includes('<task_kickoff id="T-1">'), true, 'kickoff prompt delivered as the first user input')
          return fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'List the repo files', label: 'probe-repo' })], {
            stopReason: 'toolUse',
          })
        },
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          // Section stays byte-constant across beats of the same task
          assert.match(meta.sectionsById[ACTIVE_TASK_SECTION_ID]!, /^<active_task id="T-1"/)
          return fauxAssistantMessage(
            [fauxToolCall('task_submit', { summary: 'Probed repo; deliverable ready', verification: 'ls ran clean' })],
            { stopReason: 'toolUse' },
          )
        },
        fauxAssistantMessage('Submitted.'),
        // builtin:workflow delivers a background subagent settlement notice after the child finishes
        fauxAssistantMessage('Noted the settlement notice; standing by.'),
        fauxAssistantMessage('Standing by.'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('child probe done')],
    })

    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Probe repo structure',
      brief: 'List the repository files and summarize the layout. Acceptance: a clear tree summary.',
      autoStart: true,
    })) as { task: TaskRecord; started: boolean; conversationId?: number }
    assert.equal(created.started, true)
    assert.equal(created.task.column, 'in_progress')

    const conv = kernel.listConversations().find((c) => c.id === created.conversationId)
    assert.ok(conv, 'execution conversation must exist')
    assert.equal(conv!.parentConversationId, undefined, 'execution conversation must be top-level')
    assert.equal(conv!.ownedBy === undefined || conv!.ownedBy === 'human', true, 'must stay human-owned')
    assert.equal(conv!.tags.includes(TASK_ACTIVE_TAG), true)

    await kernel.waitForIdle(conv!.id)
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_review')

    const after = await taskFromAction(env, 'T-1')
    assert.equal(after.submission?.summary, 'Probed repo; deliverable ready')
    assert.equal(after.submission?.verification, 'ls ran clean')

    // The subagent child conversation really ran inside the task execution conversation's subtree
    const child = kernel.listConversations().find((c) => c.parentConversationId === conv!.id)
    assert.ok(child, 'subagent child conversation must exist under the task conversation')
    assert.equal(observed.some((o) => o.hasActiveTask && o.toolNames.includes('subagent')), true)

    // Planner conversation still sees planner tools and NOT task_submit
    const plannerConv = await kernel.createConversation({ title: 'Planner', profileId: 'assistant' })
    await kernel.submitInput(plannerConv.id, 'Check the board')
    await kernel.waitForIdle(plannerConv.id)
    const plannerBeat = observed.filter((o) => !o.hasActiveTask && o.toolNames.includes('task_create')).at(-1)
    assert.ok(plannerBeat, 'planner conversation must have been served by the faux planner route')
    assert.equal(plannerBeat!.toolNames.includes('task_submit'), false, 'planner must NOT see task_submit')
  } finally {
    await env.close()
  }
})

test('tasks-int3: full loop create → submit → rework → submit → approve with downstream auto-start', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int3-'))
  try {
    const { kernel } = env.app
    const submitStep = (summary: string): FauxStep[] => [
      fauxAssistantMessage([fauxToolCall('task_submit', { summary })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Handed in.'),
    ]
    const observed = setRoutedResponses(env.faux, {
      assignee: [
        ...submitStep('First draft'),
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          assert.match(meta.lastUserText, /<task_rework id="T-1">/)
          assert.match(meta.lastUserText, /Add tests/)
          return fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'Second draft with tests' })], {
            stopReason: 'toolUse',
          })
        },
        fauxAssistantMessage('Handed in again.'),
        // T-2 auto-starts after T-1 is approved: its kickoff + submit beats
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'T-2 documentation delivered' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('T-2 handed in.'),
        fauxAssistantMessage('Standing by.'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })

    // T-1 (immediate) + T-2 (blocked by T-1, auto-start on unblock)
    const first = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Implement feature A',
      brief: 'Implement feature A. Acceptance: works.',
    })) as { task: TaskRecord; conversationId?: number }
    const second = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Document feature A',
      brief: 'Document feature A. Acceptance: docs updated.',
      dependsOn: ['T-1'],
    })) as { task: TaskRecord }
    assert.equal(second.task.column, 'backlog')
    assert.equal(second.task.autoStartOnUnblock, true)

    const firstConvId = first.conversationId!
    await kernel.waitForIdle(firstConvId)
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_review')

    // Rework: card returns to in_progress and the feedback reaches the original conversation
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', { taskId: 'T-1', feedback: 'Add tests for the new path.' })
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_progress')
    await kernel.waitForIdle(firstConvId)
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_review')
    const reworked = await taskFromAction(env, 'T-1')
    assert.equal(reworked.reworkCount, 1)
    assert.match(reworked.lastReworkFeedback!, /Add tests/)

    // Approve close_only: done + conversation tag swap + downstream T-2 auto-starts
    const approved = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', {
      taskId: 'T-1',
      mergeAction: 'close_only',
    })) as { task: TaskRecord; unblockedTaskIds: string[]; autoStartedTaskIds: string[] }
    assert.equal(approved.task.column, 'done')
    assert.deepEqual(approved.unblockedTaskIds, ['T-2'])
    assert.deepEqual(approved.autoStartedTaskIds, ['T-2'])

    await waitFor(async () => (await taskFromAction(env, 'T-2')).column === 'in_progress')
    const firstConv = kernel.listConversations().find((c) => c.id === firstConvId)
    assert.equal(firstConv!.tags.includes(TASK_ARCHIVED_TAG), true, 'done task conversation swaps to task-archived')
    assert.equal(firstConv!.tags.includes(TASK_ACTIVE_TAG), false)

    const secondTask = await taskFromAction(env, 'T-2')
    assert.ok(secondTask.conversationId !== undefined, 'T-2 auto-started its own conversation')
    const secondConv = kernel.listConversations().find((c) => c.id === secondTask.conversationId)
    assert.equal(secondConv!.parentConversationId, undefined)
    assert.equal(secondConv!.tags.includes(TASK_ACTIVE_TAG), true)

    await kernel.waitForIdle(secondTask.conversationId!)
    await waitFor(async () => (await taskFromAction(env, 'T-2')).column === 'in_review')
    void observed
  } finally {
    await env.close()
  }
})

test('tasks-int4: merge_and_close loop, dependency cycle rejection, blocked start, concurrency limit', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int4-'))
  try {
    const { kernel } = env.app

    // --- Cycle rejection on update ---
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'A',
      brief: 'a',
      autoStart: false,
    })
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'B',
      brief: 'b',
      autoStart: false,
      dependsOn: ['T-1'],
    })
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'update', { taskId: 'T-1', dependsOn: ['T-2'] }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // --- Blocked start ---
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'start', { taskId: 'T-2' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'task_blocked_by_dependencies' && err.status === 409,
    )

    // --- Missing dependency reference ---
    await assert.rejects(
      () =>
        kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
          title: 'C',
          brief: 'c',
          dependsOn: ['T-404'],
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // --- Concurrency limit ---
    await kernel.plugins.setConfig(TASKS_PLUGIN_ID, { maxConcurrentTasks: 1 })
    setRoutedResponses(env.faux, {
      assignee: [
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'ok' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
        // merge_and_close beat: merge, clean up, then submit again
        fauxAssistantMessage(
          [fauxToolCall('task_submit', { summary: 'Merged to main, worktree cleaned, checks green', branch: 'feat/t-1' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Merged and cleaned up.'),
        fauxAssistantMessage('Standing by.'),
      ],
      planner: [fauxAssistantMessage('idle')],
      child: [fauxAssistantMessage('ok')],
    })
    const started = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'start', { taskId: 'T-1' })) as {
      conversationId: number
    }
    // T-2 stays blocked anyway; create a fresh independent task to hit the concurrency ceiling
    const extra = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'D',
      brief: 'd',
    })) as { task: TaskRecord; started: boolean; notStartedReason?: string }
    assert.equal(extra.started, false)
    assert.equal(extra.notStartedReason, 'concurrency_limit')
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'start', { taskId: extra.task.id }),
      (err: unknown) => err instanceof HelmxError && err.code === 'task_concurrency_limit' && err.status === 409,
    )

    // --- merge_and_close: mergePending + instruction + resubmit clears it ---
    const convId = started.conversationId
    await kernel.waitForIdle(convId)
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_review')
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', {
      taskId: 'T-1',
      mergeAction: 'merge_and_close',
      note: 'merge to main',
    })
    const merging = await taskFromAction(env, 'T-1')
    assert.equal(merging.column, 'in_progress')
    assert.equal(merging.mergePending, true)
    // The merge instruction was delivered as a follow-up input
    const detail = await kernel.getConversationDetail(convId, { limit: 50 })
    const mergeDelivered = detail.entries.some(
      (e) => JSON.stringify(e.model ?? e.data ?? null).includes('task_merge_closing'),
    )
    assert.equal(mergeDelivered, true, 'merge closing instruction must be delivered')
    await kernel.waitForIdle(convId)
    await waitFor(async () => {
      const task = await taskFromAction(env, 'T-1')
      return task.column === 'in_review' && task.mergePending === undefined
    })
    // Final close
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: 'T-1' })
    assert.equal((await taskFromAction(env, 'T-1')).column, 'done')
  } finally {
    await env.close()
  }
})

test('tasks-int5: silence nudge once then stalled, failed turn records lastError, conversation.deleted marks missing', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int5-'))
  try {
    const { kernel } = env.app
    setRoutedResponses(env.faux, {
      assignee: [
        fauxAssistantMessage('I did some work but will not submit yet.'),
        fauxAssistantMessage('Still not submitting.'),
        fauxAssistantMessage('Still not submitting (2).'),
      ],
      planner: [fauxAssistantMessage('idle')],
      child: [fauxAssistantMessage('ok')],
    })
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Slow task',
      brief: 'Do the thing. Acceptance: thing done.',
    })) as { conversationId?: number }
    const convId = created.conversationId!

    // Turn completes without submission -> single nudge (followUp input) is delivered
    await kernel.waitForIdle(convId)
    await waitFor(async () => {
      const task = await taskFromAction(env, 'T-1')
      return task.silenceState?.nudgedAt !== undefined
    })
    // The nudge turn settles and the card honestly reports stalled (never killed, never faked)
    await kernel.waitForIdle(convId)
    await waitFor(async () => {
      const task = await taskFromAction(env, 'T-1')
      return task.silenceState?.stalledAt !== undefined
    })
    const stalled = await taskFromAction(env, 'T-1')
    assert.equal(stalled.column, 'in_progress')
    assert.equal(stalled.silenceState!.nudgedAt !== undefined, true)

    // Board projection reflects the silence state for the frontend
    assert.equal(boardDoc(env).tasks.some((task) => task.silenceState?.stalledAt !== undefined), true)

    // Deleting the bound conversation honestly marks conversationMissing
    await kernel.deleteConversation(convId)
    await waitFor(async () => {
      const task = await taskFromAction(env, 'T-1')
      return task.conversationMissing === true
    })
    const missing = await taskFromAction(env, 'T-1')
    assert.equal(missing.column, 'in_progress')
    // Rework without recreateConversation refuses honestly
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', { taskId: 'T-1', feedback: 'again' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'task_conversation_missing' && err.status === 409,
    )
  } finally {
    await env.close()
  }
})

test('tasks-int5b: a failed assignee turn records silenceState.lastError honestly', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int5b-'))
  try {
    const { kernel } = env.app
    env.faux.setResponses([
      async () => {
        throw new Error('faux model exploded')
      },
    ])
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Failing task',
      brief: 'Do it. Acceptance: thing done.',
    })) as { conversationId?: number }
    const convId = created.conversationId!
    await kernel.waitForIdle(convId).catch(() => undefined)
    await waitFor(async () => {
      const task = await taskFromAction(env, 'T-1')
      return typeof task.silenceState?.lastError === 'string' && task.silenceState.lastError.length > 0
    })
    const task = await taskFromAction(env, 'T-1')
    assert.equal(task.column, 'in_progress', 'failed turn must not fake any column change')
  } finally {
    await env.close()
  }
})

test('tasks-int6: disable hides tools/UI/skill immediately while execution conversations survive', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int6-'))
  try {
    const { kernel } = env.app
    setRoutedResponses(env.faux, {
      assignee: [
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'done' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('handed in'),
      ],
      planner: [fauxAssistantMessage('idle')],
      child: [fauxAssistantMessage('ok')],
    })
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Survivor',
      brief: 'Acceptance: survives plugin disable.',
    })) as { conversationId?: number }
    const convId = created.conversationId!
    await kernel.waitForIdle(convId)
    await waitFor(async () => (await taskFromAction(env, 'T-1')).column === 'in_review')

    // in_progress/in_review tasks protect the plugin from silent disable
    await assert.rejects(
      () => kernel.plugins.disable(TASKS_PLUGIN_ID),
      (err: unknown) => err instanceof HelmxError && (err.code === 'plugin_in_use' || err.code === 'plugin_has_live_tasks'),
    )

    // Approve closes the card, then disable succeeds
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: 'T-1' })
    await kernel.plugins.disable(TASKS_PLUGIN_ID)
    const disabled = kernel.plugins.list().find((p) => p.id === TASKS_PLUGIN_ID)
    assert.equal(disabled!.enabled, false)

    // Tools gone
    assert.equal(
      kernel.plugins.listTools().some((tool) => tool.name.startsWith('task_')),
      false,
      'task_* tools must disappear immediately after disable',
    )
    // UI contributions gone
    assert.equal(kernel.plugins.listUi().some((u) => u.pluginId === TASKS_PLUGIN_ID), false)
    // Managed skill becomes unavailable (skill_not_available) after disable
    await assert.rejects(
      () => kernel.plugins.executeTool('load_skill', { skillId: TASKS_SKILL_ID }, { conversationId: convId }),
      (err: unknown) => err instanceof HelmxError && err.code === 'skill_not_available',
    )

    // The execution conversation survives with its archived tag and full history
    const survivor = kernel.listConversations().find((c) => c.id === convId)
    assert.ok(survivor, 'execution conversation must survive plugin disable')
    assert.equal(survivor!.tags.includes(TASK_ARCHIVED_TAG), true)
    const detail = await kernel.getConversationDetail(convId, { limit: 10 })
    assert.equal(detail.entries.length > 0, true)

    // Re-enable restores the board projection from the durable records doc
    await kernel.plugins.enable(TASKS_PLUGIN_ID)
    const task = await taskFromAction(env, 'T-1')
    assert.equal(task.column, 'done')
    assert.equal(boardDoc(env).tasks.some((entry) => entry.id === 'T-1'), true)
  } finally {
    await env.close()
  }
})
