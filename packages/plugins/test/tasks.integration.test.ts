/**
 * builtin:tasks 真实组合层整链集成测试（Integration 档，createHelmx 全插件）：
 * 1) 默认启用、启动零常驻会话、空闲不阻塞 disable('builtin:workflow')、受管技能 tasks 随启停显隐、inUse 保护；
 * 2) create(autoStart) 建独立顶层 human-owned 执行会话（无 parentConversationId、tags 含 task），
 *    任务书投递 + <active_task> 恒定段落 + 规划/执行工具隔离 + 执行会话内实测派 subagent 子代理；
 * 3) 完整闭环 create → submit → rework → submit → approve（tag 换 task-archived）；
 * 4) conversation.deleted 诚实标记 + rework recreate 重建（单条合成任务书）+ 空闲未交卷零自动投递；
 * 5) 停用后工具 / UI / 受管技能即时消失且已有执行会话完整保留；
 * 6) 验收在途守卫（主会话 working 拒绝、confirmStopped 明示收尾）与重启零自动投递
 *    （重置清空的会话被启动恢复诚实回滚 backlog + 贴 task-archived）；
 * 7) 建单幂等键全路径、孤儿会话恢复；
 * 8) 看板徽标投影全生命周期实时跟踪（健康在跑 accent → in_review 验收计数 → 主会话报错
 *    error 升级 → approve 归零 neutral）、交卷进 in_review 发 info 通知、
 *    徽标无关会话扰动零 board doc 重写（脏检查零 SSE 写放大）；
 * 9) 评审修复轮：update null 清空、非启动路径幂等键、建会话前启动失败留 backlog、
 *    死卡删除、done 幂等、可指派性校验、脱敏投递、task_submit scope。
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
  TASK_BOARD_SIDEBAR_BADGE,
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
      'conversation.header.action:task-anchor',
      'plugin.slot:overview-card-meta',
      'screen:board',
      'sidebar.item:task-board',
      'sidebar.section:task-conversations',
      'tool.view:task-tool-card',
    ])

    // 单一分组收口：任务执行会话声明的 keptAliveTag 让结单/归档成员换
    // task-archived 标签后仍留在「任务执行」分组（Web 侧按双标签渲染），
    // 不再存在第二个「已完成任务」归档抽屉与宿主「已归档」争语义。
    const taskSection = kernel.plugins
      .listUi()
      .find(
        (u) =>
          u.pluginId === TASKS_PLUGIN_ID &&
          u.surface === 'sidebar.section' &&
          (u.spec as { id?: string }).id === 'task-conversations',
      )
    assert.ok(taskSection, 'sidebar.section:task-conversations must exist')
    assert.equal((taskSection!.spec as { filterTag?: string }).filterTag, 'task')
    assert.equal((taskSection!.spec as { keptAliveTag?: string }).keptAliveTag, 'task-archived')

    // Overview card meta slot contribution: read-only jump pill, scoped to task
    // conversation tags (OR within the tags field) so non-task cards never mount it.
    const slotContribution = kernel.plugins
      .listUi()
      .find((u) => u.pluginId === TASKS_PLUGIN_ID && u.surface === 'plugin.slot' && (u.spec as { id?: string }).id === 'overview-card-meta')
    assert.ok(slotContribution, 'plugin.slot:overview-card-meta contribution must exist')
    assert.equal((slotContribution.spec as { target?: unknown }).target, 'builtin:overview/card-meta')
    assert.deepEqual((slotContribution.spec as { scope?: unknown }).scope, { tags: [TASK_ACTIVE_TAG, TASK_ARCHIVED_TAG] })
    assert.deepEqual((slotContribution.spec as { client?: unknown }).client, { module: 'index.tsx', export: 'TaskOverviewCardMeta' })

    // End-to-end badge wiring: the live plugin's sidebar.item contribution carries
    // the declared badge verbatim — protocol SidebarItemBadgeSpec + kernel boundary
    // validator + plugin registration all agreeing on one contract.
    const sidebarItem = kernel.plugins
      .listUi()
      .find((u) => u.pluginId === TASKS_PLUGIN_ID && u.surface === 'sidebar.item' && (u.spec as { id?: string }).id === 'task-board')
    assert.ok(sidebarItem, 'sidebar.item:task-board contribution must exist')
    assert.deepEqual(
      (sidebarItem.spec as { badge?: unknown }).badge,
      { ...TASK_BOARD_SIDEBAR_BADGE },
      'task-board sidebarItem badge must match TASK_BOARD_SIDEBAR_BADGE (protocol -> kernel validator -> plugin registration)',
    )
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
          assert.equal(meta.toolNames.includes('task_request_plan_approval'), false, 'planFirst tool is gone for good')
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

test('tasks-int3: full loop create → submit → rework → submit → approve', { timeout: 60_000 }, async (t) => {
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
        fauxAssistantMessage('Standing by.'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })

    const first = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Implement feature A',
      brief: 'Implement feature A. Acceptance: works.',
    })) as { task: TaskRecord; conversationId?: number }
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

    // Approve: done + conversation tag swap
    const approved = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', {
      taskId: 'T-1',
    })) as { task: TaskRecord }
    assert.equal(approved.task.column, 'done')
    const firstConv = kernel.listConversations().find((c) => c.id === firstConvId)
    assert.equal(firstConv!.tags.includes(TASK_ARCHIVED_TAG), true, 'done task conversation swaps to task-archived')
    assert.equal(firstConv!.tags.includes(TASK_ACTIVE_TAG), false)
    void observed
  } finally {
    await env.close()
  }
})

test('tasks-int5: idle-not-submitted stays honest with ZERO auto-input; conversation.deleted marks missing; recreate delivers one composed briefing', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int5-'))
  try {
    const { kernel } = env.app
    setRoutedResponses(env.faux, {
      assignee: [fauxAssistantMessage('I did some work but will not submit yet.'), fauxAssistantMessage('Standing by.')],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Slow task',
      brief: 'Do the thing. Acceptance: thing done.',
    })) as { conversationId?: number }
    const convId = created.conversationId!

    // Turn completes without submission: the card stays in_progress honestly (no fabricated
    // state, no server-side stall bookkeeping) and NO automatic input is ever delivered
    // to the human-owned conversation (AGENTS red line) — "idle, not submitted" is a
    // pure frontend derivation over the main conversation facts.
    await kernel.waitForIdle(convId)
    await new Promise((r) => setTimeout(r, 600))
    const task = await taskFromAction(env, 'T-1')
    assert.equal(task.column, 'in_progress')
    const detail = await kernel.getConversationDetail(convId, { limit: 50 })
    const inputEntries = detail.entries.filter((e) => e.kind === 'helmx.input')
    assert.equal(inputEntries.length, 1, 'exactly the kickoff input, zero auto-nudge deliveries')
    const convNow = kernel.listConversations().find((c) => c.id === convId)
    assert.equal(convNow!.status !== 'working', true)

    // Board projection keeps the card visible and running-healthy (idle main is not an error)
    assert.equal(boardDoc(env).tasks.some((entry) => entry.id === 'T-1' && entry.column === 'in_progress'), true)

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
    // Rework with recreateConversation rebuilds a fresh execution conversation and delivers brief + feedback
    const recreated = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', {
      taskId: 'T-1',
      feedback: 'restart from scratch',
      recreateConversation: true,
    })) as { conversationId?: number; recreatedConversation?: boolean }
    assert.equal(recreated.recreatedConversation, true)
    assert.ok(recreated.conversationId !== undefined && recreated.conversationId !== convId)
    const afterRecreate = await taskFromAction(env, 'T-1')
    assert.equal(afterRecreate.reworkCount, 1)
    assert.equal(afterRecreate.conversationMissing, undefined)
    // #36: recreate delivers exactly ONE composed briefing (brief + feedback), not kickoff + a second delivery
    await kernel.waitForIdle(recreated.conversationId!)
    const reproDetail = await kernel.getConversationDetail(recreated.conversationId!, { limit: 20 })
    const inputs = reproDetail.entries.filter((e) => e.kind === 'helmx.input')
    assert.equal(inputs.length, 1, 'recreate must deliver a single composed briefing')
    const joined = JSON.stringify(inputs[0]?.model ?? inputs[0]?.data ?? '')
    assert.match(joined, /Do the thing/)
    assert.match(joined, /restart from scratch/)
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
    // UI contributions gone (incl. the OVERVIEW_CARD_META_SLOT pill — disabling
    // removes contributions immediately, no phantom pills on overview cards)
    assert.equal(kernel.plugins.listUi().some((u) => u.pluginId === TASKS_PLUGIN_ID), false)
    assert.equal(
      kernel.plugins
        .listUi()
        .some((u) => u.surface === 'plugin.slot' && (u.spec as { target?: string }).target === 'builtin:overview/card-meta'),
      false,
    )
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

test('tasks-int8: force-disable drops the active_task section; the section carries no phantom plan/merge flags', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int8-'))
  try {
    const { kernel } = env.app
    const sections: Array<Record<string, string>> = []
    env.faux.setResponses(
      Array.from({ length: 8 }, () => async (ctx) => {
        const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
        sections.push(meta.sectionsById)
        return fauxAssistantMessage('ok')
      }),
    )
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Section probe',
      brief: 'Acceptance: n/a.',
    })) as { conversationId?: number }
    const convId = created.conversationId!
    await kernel.waitForIdle(convId)
    assert.ok(sections[0]![ACTIVE_TASK_SECTION_ID] !== undefined, 'section injected while enabled')
    assert.doesNotMatch(sections[0]![ACTIVE_TASK_SECTION_ID]!, /plan-first|auto-merge|task_request_plan_approval/, 'deleted flags leave no phantom prompt residue')
    await kernel.plugins.disable(TASKS_PLUGIN_ID, { force: true })
    assert.equal(kernel.plugins.list().find((p) => p.id === TASKS_PLUGIN_ID)?.enabled, false)
    await kernel.submitInput(convId, 'still there?')
    await kernel.waitForIdle(convId)
    assert.equal(sections[sections.length - 1]![ACTIVE_TASK_SECTION_ID], undefined, 'no phantom section after disable')
    await kernel.plugins.enable(TASKS_PLUGIN_ID)
  } finally {
    await env.close()
  }
})

test('tasks-int9: approve quiescence guard (still-running refused, explicit confirmStopped path) and restart recovery (zero-input rollback, zero auto-delivery)', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int9-'))
  try {
    const { kernel } = env.app
    // Keep the assignee turn busy long enough to assert the in-flight guard deterministically
    setRoutedResponses(env.faux, {
      assignee: [
        async () => {
          await new Promise((r) => setTimeout(r, 1500))
          return fauxAssistantMessage('slow work done')
        },
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'submitted' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('handed in'),
        fauxAssistantMessage('standing by'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })
    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Guarded task',
      brief: 'Acceptance: guard behavior verified.',
    })) as { conversationId?: number }
    const convId = created.conversationId!

    // While the main conversation is still working, approve must be refused (409 task_still_running)
    await waitFor(async () => {
      const conv = kernel.listConversations().find((c) => c.id === convId)
      return conv?.status === 'working'
    })
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: 'T-1' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'task_still_running' && err.status === 409,
    )

    // After the turn settles without submission: in_progress still refuses a bare close (no confirmStopped)
    await kernel.waitForIdle(convId)
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: 'T-1' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'task_invalid_column' && err.status === 409,
    )

    // Delivered kickoff survives a restart untouched: no re-delivery, task stays in_progress
    const inputsBefore = (await kernel.getConversationDetail(convId, { limit: 20 })).entries.filter(
      (e) => e.kind === 'helmx.input',
    ).length
    await kernel.plugins.disable(TASKS_PLUGIN_ID, { force: true })
    await kernel.plugins.enable(TASKS_PLUGIN_ID)
    await new Promise((r) => setTimeout(r, 500))
    const afterRestart = await kernel.getConversationDetail(convId, { limit: 20 })
    assert.equal(
      afterRestart.entries.filter((e) => e.kind === 'helmx.input').length,
      inputsBefore,
      'restart must NOT add any input into the human-owned conversation',
    )
    assert.equal((await taskFromAction(env, 'T-1')).column, 'in_progress', 'delivered kickoff keeps the card running')

    // A user-reset conversation keeps its entry history (context reset ≠ entry wipe), so the
    // startup recovery honestly leaves it alone: never re-delivers, never rolls the card back
    // (the zero-helmx.input crash window is the only rollback trigger).
    await kernel.resetConversation(convId)
    await kernel.plugins.disable(TASKS_PLUGIN_ID, { force: true })
    await kernel.plugins.enable(TASKS_PLUGIN_ID)
    await new Promise((r) => setTimeout(r, 500))
    const resetTask = await taskFromAction(env, 'T-1')
    assert.equal(resetTask.column, 'in_progress', 'a reset-but-delivered conversation is not misjudged as a crash window')
    const afterReset = await kernel.getConversationDetail(convId, { limit: 20 })
    assert.equal(
      afterReset.entries.filter((e) => e.kind === 'helmx.input').length,
      inputsBefore,
      'zero auto re-delivery (reset intent preserved)',
    )

    // Explicit manual close of an in_progress (quiescent) task via confirmStopped proceeds to done
    const closed = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', {
      taskId: 'T-1',
      confirmStopped: true,
    })) as { task: TaskRecord }
    assert.equal(closed.task.column, 'done')
  } finally {
    await env.close()
  }
})

test('tasks-int10: create idempotency key and orphan conversation recovery', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int10-'))
  try {
    const { kernel } = env.app
    setRoutedResponses(env.faux, {
      assignee: [
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'initial delivery' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('initial handed in'),
        fauxAssistantMessage('standing by'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })

    // --- create idempotency: same key double-click returns the same task, no duplicate card/conversation ---
    const first = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Idempotent',
      brief: 'Acceptance: one card only.',
      idempotencyKey: 'dial-press-1',
    })) as { task: TaskRecord; started: boolean; conversationId?: number }
    const replay = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Idempotent',
      brief: 'Acceptance: one card only.',
      idempotencyKey: 'dial-press-1',
    })) as { task: TaskRecord; started: boolean; conversationId?: number }
    assert.equal(replay.task.id, first.task.id, 'idempotent replay returns the same task id')
    assert.equal(replay.task.conversationId, first.task.conversationId)
    const listed = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'list', {})) as { total: number }
    assert.equal(listed.total, 1, 'exactly one card exists after a double-click')

    const convId = first.conversationId!
    const taskId = first.task.id
    await kernel.waitForIdle(convId)
    await waitFor(async () => (await taskFromAction(env, taskId)).column === 'in_review')

    // --- orphan conversation recovery: an unbound, zero-input, task-tagged conversation gets archived on restart ---
    const orphan = await kernel.createConversation({ title: 'Orphan', profileId: 'assistant', tags: ['task'] })
    await kernel.plugins.disable(TASKS_PLUGIN_ID, { force: true })
    await kernel.plugins.enable(TASKS_PLUGIN_ID)
    await waitFor(async () => {
      const conv = kernel.listConversations().find((c) => c.id === orphan.id)
      return conv?.tags.includes('task-archived') === true
    })
    const survivor = kernel.listConversations().find((c) => c.id === convId)
    assert.ok(survivor, 'bound execution conversation untouched by orphan recovery')
    assert.equal(survivor!.tags.includes(TASK_ACTIVE_TAG), true, 'bound in_review conversation keeps its active tag')
  } finally {
    await env.close()
  }
})

test('tasks-int11: board badge projection tracks the lifecycle live; submit notifies; badge-neutral churn writes nothing', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int11-'))
  try {
    const { kernel } = env.app

    // Collect notifications and per-frame board doc updates from the durable event stream
    const notifications: Array<{ level: string; title: string; body?: string; conversationId?: number; view?: string }> = []
    const boardDocFrames: number[] = []
    const plannerUpserts: number[] = []
    let plannerConvId = 0
    const unsubscribe = kernel.events.subscribe((frame) => {
      const event = frame.event
      if (event.type === 'notification' && 'title' in event) {
        notifications.push({
          level: event.level,
          title: event.title,
          body: event.body,
          conversationId: event.conversationId,
          view: event.view,
        })
      } else if (event.type === 'plugin.doc.updated' && 'doc' in event) {
        if (event.doc.pluginId === TASKS_PLUGIN_ID && event.doc.name === 'board') boardDocFrames.push(frame.seq)
      } else if (event.type === 'conversation.upsert' && 'conversation' in event) {
        if (plannerConvId !== 0 && event.conversation.id === plannerConvId) plannerUpserts.push(frame.seq)
      }
    })

    // Fresh boot: board badge starts fully quiet (declared initial value + empty projection agree)
    const initial = boardDoc(env)
    assert.equal(initial.tasks.length, 0)
    assert.equal(initial.attentionCount, 0)
    assert.equal(initial.reviewCount, 0)
    assert.equal(initial.runningCount, 0)
    assert.equal(initial.hasRunning, false)
    assert.equal(initial.badgeTone, 'neutral')
    assert.equal(initial.badgeSummary, undefined)

    let submitCount = 0
    setRoutedResponses(env.faux, {
      assignee: [
        // Turn 1: settles without submitting -> healthy running (idle main is not attention)
        fauxAssistantMessage('Working on it; not submitting yet.'),
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'First draft' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Handed in.'),
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          assert.match(meta.lastUserText, /<task_rework id="T-1">/)
          submitCount += 1
          return fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'Second draft' })], {
            stopReason: 'toolUse',
          })
        },
        fauxAssistantMessage('Handed in again.'),
        // Second rework: the turn fails -> the main conversation enters error state
        async () => {
          submitCount += 1
          throw new Error('faux model exploded on the second rework')
        },
      ],
      planner: [fauxAssistantMessage('planner idle'), fauxAssistantMessage('planner idle again')],
      child: [fauxAssistantMessage('ok')],
    })

    const created = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Badge lifecycle probe',
      brief: 'Drive the board badge across the lifecycle. Acceptance: badge fields stay honest.',
    })) as { conversationId?: number }
    const convId = created.conversationId!

    // Turn settles idle without a submission -> quiet accent dot with a running summary
    await kernel.waitForIdle(convId)
    await waitFor(() => {
      const board = boardDoc(env)
      return (
        board.attentionCount === 0 &&
        board.runningCount === 1 &&
        board.hasRunning === true &&
        board.badgeTone === 'accent' &&
        board.tasks.some((entry) => entry.id === 'T-1' && entry.column === 'in_progress')
      )
    })
    assert.deepEqual(boardDoc(env).badgeSummary, { en: '1 running', 'zh-CN': '1 个进行中' })

    // Badge-neutral churn: a planner conversation turn fires conversation.upsert frames but must NOT
    // rewrite the board doc (badge tuple unchanged -> zero SSE plugin.doc write amplification)
    const boardFramesBeforeChurn = boardDocFrames.length
    plannerConvId = (await kernel.createConversation({ title: 'Planner', profileId: 'assistant' })).id
    await kernel.submitInput(plannerConvId, 'Chatter while a running task sits on the board')
    await kernel.waitForIdle(plannerConvId)
    await waitFor(() => plannerUpserts.length >= 2)
    assert.ok(boardDocFrames.length > 0, 'board doc must have been written during the lifecycle so far')
    assert.equal(
      boardDocFrames.length,
      boardFramesBeforeChurn,
      'badge-neutral conversation churn must not rewrite the board doc',
    )

    // Submit -> in_review badge + notification
    await kernel.submitInput(convId, 'Please hand it in now')
    await kernel.waitForIdle(convId)
    await waitFor(() => {
      const board = boardDoc(env)
      return board.attentionCount === 1 && board.reviewCount === 1 && board.runningCount === 0 && board.badgeTone === 'warn'
    })
    assert.deepEqual(boardDoc(env).badgeSummary, { en: '1 awaiting review', 'zh-CN': '1 个待验收' })
    await waitFor(() => notifications.some((n) => n.conversationId === convId && n.level === 'info'))
    const firstNotice = notifications.find((n) => n.conversationId === convId)!
    assert.match(firstNotice.title, /T-1/)
    assert.match(firstNotice.title, /验收/)
    assert.match(firstNotice.body ?? '', /First draft/)
    assert.equal(firstNotice.view, 'screen:builtin:tasks/board?task=T-1', '交卷通知的标准查看按钮直达看板详情抽屉')

    // Rework -> resubmit: a second honest notification for the new review round
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', { taskId: 'T-1', feedback: 'Tighten the summary.' })
    await kernel.waitForIdle(convId)
    await waitFor(() => notifications.filter((n) => n.conversationId === convId && n.level === 'info').length >= 2)
    await waitFor(() => {
      const board = boardDoc(env)
      return board.attentionCount === 1 && board.reviewCount === 1 && board.badgeTone === 'warn'
    })

    // Pure conversation-event proof: the MAIN execution conversation enters error state on the
    // second rework turn -> the event subscription alone escalates the badge tone warn -> error
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', { taskId: 'T-1', feedback: 'One more polish round.' })
    await kernel.waitForIdle(convId).catch(() => undefined)
    await waitFor(() => {
      const conv = kernel.listConversations().find((c) => c.id === convId)
      return conv?.status === 'error'
    })
    await waitFor(() => {
      const board = boardDoc(env)
      return board.attentionCount === 1 && board.runningCount === 0 && board.badgeTone === 'error'
    })
    assert.deepEqual(boardDoc(env).badgeSummary, { en: '1 needs attention', 'zh-CN': '1 个需处理' })

    // Explicit manual close via confirmStopped: board goes fully quiet (done cards carry no badge weight)
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: 'T-1', confirmStopped: true })
    await waitFor(() => {
      const board = boardDoc(env)
      return (
        board.attentionCount === 0 &&
        board.reviewCount === 0 &&
        board.runningCount === 0 &&
        board.hasRunning === false &&
        board.badgeTone === 'neutral' &&
        board.badgeSummary === undefined &&
        board.tasks.some((entry) => entry.id === 'T-1' && entry.column === 'done')
      )
    })

    // Only the two submit-into-review moments ever notified; approve/rework stayed calm (zero noise)
    assert.equal(
      notifications.filter((n) => n.conversationId === convId).length,
      2,
      'exactly one info notification per submit into in_review',
    )
    unsubscribe()
  } finally {
    await env.close()
  }
})

test('tasks-int12: bugfix round — update null clears, idempotency on non-launch paths, pre-creation launch rollback, dead-card delete, done-approve idempotence, assignee assignability, rework redaction, task_submit tool scope', { timeout: 60_000 }, async (t) => {
  const env = await openTasksEnv(useTempDir(t, 'helmx-tasks-int12-'))
  try {
    const { kernel } = env.app
    setRoutedResponses(env.faux, {
      assignee: [
        // T-3 (dead-card probe): submit into review, then stand by
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'dead-card draft' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('standing by'),
        // T-4 (approve idempotence probe)
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'idempotent-approve draft' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('standing by'),
        // T-5 (rework redaction probe): first draft, then post-rework draft
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'redaction probe draft' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('standing by'),
        fauxAssistantMessage([fauxToolCall('task_submit', { summary: 'fixed per feedback' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('standing by'),
        fauxAssistantMessage('idle'),
      ],
      planner: [fauxAssistantMessage('planner idle')],
      child: [fauxAssistantMessage('ok')],
    })

    // --- 1) update with explicit null clears optional fields (schema must accept null end-to-end) ---
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Nullable fields',
      brief: 'update null clears optional coordinates',
      project: 'proj-x',
      cwd: '/tmp/nullable-cwd',
      autoStart: false,
    })
    const cleared = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'update', {
      taskId: 'T-1',
      project: null,
      cwd: null,
    })) as { task: TaskRecord }
    assert.equal(cleared.task.project, undefined, 'project cleared by explicit null')
    assert.equal(cleared.task.cwd, undefined, 'cwd cleared by explicit null')

    // --- 2) idempotency key persists on non-launch paths (autoStart disabled) ---
    const keptFirst = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Kept in backlog',
      brief: 'no auto start',
      autoStart: false,
      idempotencyKey: 'kept-key-1',
    })) as { task: TaskRecord }
    const keptReplay = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Kept in backlog',
      brief: 'no auto start',
      autoStart: false,
      idempotencyKey: 'kept-key-1',
    })) as { task: TaskRecord }
    assert.equal(keptReplay.task.id, keptFirst.task.id, 'idempotent replay on the autoStart=false path returns the same task')

    // --- 3) launch failure BEFORE conversation creation leaves the card in backlog ---
    const ghost = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Ghost node',
      brief: 'remote node without a paired cwd',
      nodeId: 'ghost-node',
      autoStart: false,
    })) as { task: TaskRecord }
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'start', { taskId: ghost.task.id }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      'remote node without cwd must be rejected by resolveCoordinates',
    )
    const ghostAfter = await taskFromAction(env, ghost.task.id)
    assert.equal(ghostAfter.column, 'backlog', 'task stays in backlog after a pre-creation launch failure')
    assert.equal(ghostAfter.conversationId, undefined, 'no conversation was ever bound')

    // --- 4) dead card: bound conversation deleted -> task delete is the honest exit ---
    const dead = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Dead card probe',
      brief: 'conversation will be deleted while the card lives on',
    })) as { task: TaskRecord; conversationId: number }
    await kernel.waitForIdle(dead.conversationId)
    await waitFor(async () => (await taskFromAction(env, dead.task.id)).column === 'in_review')
    await kernel.deleteConversation(dead.conversationId)
    await waitFor(async () => (await taskFromAction(env, dead.task.id)).conversationMissing === true)
    const deletedDead = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'delete', {
      taskId: dead.task.id,
    })) as { deleted: boolean }
    assert.equal(deletedDead.deleted, true, 'a task whose conversation is gone can be deleted (no zombie cards)')

    // --- 5) approve on an already-done task is idempotent ---
    const once = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Approve twice',
      brief: 'double approval must not error',
    })) as { task: TaskRecord; conversationId: number }
    await kernel.waitForIdle(once.conversationId)
    await waitFor(async () => (await taskFromAction(env, once.task.id)).column === 'in_review')
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', { taskId: once.task.id })
    await waitFor(async () => (await taskFromAction(env, once.task.id)).column === 'done')
    const again = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'approve', {
      taskId: once.task.id,
    })) as { task: TaskRecord }
    assert.equal(again.task.column, 'done', 'repeat approve on done returns the current facts')

    // --- 6) update to a non-assignable profile is rejected (same rule as create) ---
    await kernel.profiles.save({ id: 'sys-role', name: 'sys-role', humanSelectable: false })
    await assert.rejects(
      () => kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'update', { taskId: 'T-1', assigneeProfileId: 'sys-role' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      'humanSelectable=false profiles cannot become board executors via update',
    )

    // --- 7) rework delivers only the sanitized feedback to the execution conversation ---
    const SECRET = 'sk-test-do-not-leak-9f1c'
    const unregister = kernel.stash.addRedaction(SECRET)
    const redactProbe = (await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'create', {
      title: 'Rework redaction probe',
      brief: 'feedback carrying a secret must be redacted before delivery',
    })) as { task: TaskRecord; conversationId: number }
    await kernel.waitForIdle(redactProbe.conversationId)
    await waitFor(async () => (await taskFromAction(env, redactProbe.task.id)).column === 'in_review')
    await kernel.plugins.invokeAction(TASKS_PLUGIN_ID, 'rework', {
      taskId: redactProbe.task.id,
      feedback: `fix the leak: use ${SECRET} from the vault instead`,
    })
    await waitFor(async () => {
      const task = await taskFromAction(env, redactProbe.task.id)
      return task.reworkCount === 1 && task.column === 'in_review'
    })
    const stored = await taskFromAction(env, redactProbe.task.id)
    assert.ok((stored.lastReworkFeedback ?? '').includes('[REDACTED]'), 'persisted feedback carries the redaction marker')
    assert.ok(!(stored.lastReworkFeedback ?? '').includes(SECRET), 'persisted feedback never carries the raw secret')
    const detail = await kernel.getConversationDetail(redactProbe.conversationId, { limit: 100 })
    const deliveredText = JSON.stringify(detail.entries)
    assert.ok(!deliveredText.includes(SECRET), 'the raw secret is never delivered into the conversation history')
    assert.ok(deliveredText.includes('[REDACTED]'), 'the delivered rework prompt carries the redaction marker')
    unregister()

    // --- 8) task_submit tool is scope-gated at registration (not only hidden by before_turn) ---
    const plannerConv = await kernel.createConversation({ title: 'Planner', profileId: 'assistant' })
    const plannerNames = kernel.plugins.listTools(kernel.getConversation(plannerConv.id)).map((tool) => tool.name)
    const taskConvSummary = kernel.getConversation(redactProbe.conversationId)
    const taskNames = kernel.plugins.listTools(taskConvSummary).map((tool) => tool.name)
    assert.equal(plannerNames.includes('task_submit'), false, 'plain conversations never list task_submit (scope, not just hook filtering)')
    assert.equal(taskNames.includes('task_submit'), true, 'task execution conversations keep task_submit')
    assert.equal(plannerNames.includes('task_create'), true, 'sanity: planner tools stay listed')
  } finally {
    await env.close()
  }
})
