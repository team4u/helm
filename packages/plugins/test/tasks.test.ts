/**
 * builtin:tasks 纯函数与插件定义单测（Unit 档，纯内存零全局副作用）：
 * - 插件契约：TASKS_PLUGIN_ID / 受管技能 ID / 标签常量 / 无静态 dependencies / 双语元数据；
 * - 配置边界（maxConcurrentTasks 0..50）与 doc / record / id 强校验；
 * - 依赖环 DFS 检测与 assertDependenciesValid 全拒绝面；
 * - board 投影截断（未归档全量 + 最近 50 条历史）与徽标聚合全状态判定
 *   （attention / review / running / tone 阶梯 / 双语摘要 / 子树会话事实 / 脏检查键）；
 * - <active_task> 段落 100% 字节恒定与 kickoff 任务书内容（planFirst 走真实 Ask 指令）；
 * - before_turn 工具过滤纯函数（规划/执行隔离、子会话与自动化会话）；
 * - 子树忙碌检查与停滞判定纯函数（含 Workflow 在途 'unknown' 保守分支）；
 * - 重启恢复：两阶段启动中断任务诚实回滚待办；
 * - 会话总览卡胶囊（OVERVIEW_CARD_META_SLOT）：findTaskForOverviewCard 纯函数
 *   优先序（根精确 > 树成员；未归档 > 已归档；updatedAt 最新）+ 编译产物
 *   TaskOverviewCardMeta 只读跳转渲染/交互（命中渲染、点击深链且阻止冒泡、
 *   无命中 null 零残留、导出仅 PascalCase 组件）——该用例内注册 happy-dom。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { CLIENT_SHARED_GLOBALS, compilePluginClientModule } from '@helmx/plugin-build'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import {
  ACTIVE_TASK_SECTION_ID,
  TASKS_PLUGIN_ID,
  TASKS_SKILL_ID,
  TASK_ACTIVE_TAG,
  TASK_ARCHIVED_TAG,
  TASK_BOARD_DOC,
  TASK_BOARD_DONE_HISTORY_LIMIT,
  TASK_BOARD_SIDEBAR_BADGE,
  TASK_RECORDS_DOC,
  assertTaskId,
  assertTaskRecord,
  assertTaskStoreDoc,
  blockedDependenciesOf,
  createTasksPlugin,
  detectDependencyCycle,
  projectBoardDoc,
  resolveTasksConfig,
  subtreeAttentionFlags,
  taskBoardBadgeKey,
  type TaskRecord,
} from '../src/tasks.js'
import { assertDependenciesValid, recoverInterruptedStartups, recoverKickoffMarkers } from '../src/tasks/store.js'
import { activeTaskSection, buildMergeClosingPrompt, buildTaskKickoffPrompt } from '../src/tasks/prompts.js'
import { filterTaskToolsForTurn, shouldMarkStalled, subtreeHasWorkingOrBlocked } from '../src/tasks/hooks.js'

function makeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'T-1',
    title: 'Ship login fix',
    brief: 'Fix the login redirect loop described in issue 42. Acceptance: e2e test passes.',
    column: 'backlog',
    assigneeProfileId: 'assistant',
    dependsOn: [],
    reworkCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

function makeConversation(over: Partial<Parameters<typeof filterTaskToolsForTurn>[1]> = {}) {
  return {
    id: 7,
    tags: [] as string[],
    parentConversationId: undefined,
    ownedBy: undefined,
    ...over,
  }
}

const TOOL = (name: string) => ({ name, description: `${name} stub`, inputSchema: {} })

test('tasks-unit1: plugin definition contract, constants, and bilingual metadata', { timeout: 60_000 }, () => {
  const def = createTasksPlugin()
  assert.equal(def.id, TASKS_PLUGIN_ID)
  assert.equal(def.id, 'builtin:tasks')
  assert.equal(TASKS_SKILL_ID, 'tasks')
  assert.equal(def.dependencies, undefined, 'must not declare static dependencies')
  assert.equal(def.locked, undefined)
  assert.deepEqual(def.name, { en: 'Task Board', 'zh-CN': '任务看板' })
  assert.ok(typeof def.description === 'object' && def.description !== null)
  assert.equal((def.description as { en: string }).en.length > 0, true)
  assert.equal((def.description as { 'zh-CN': string })['zh-CN'].length > 0, true)
  assert.equal(def.icon, 'check-square')

  assert.equal(TASK_ACTIVE_TAG, 'task')
  assert.equal(TASK_ARCHIVED_TAG, 'task-archived')
  assert.equal(TASK_BOARD_DOC, 'board')
  assert.equal(TASK_RECORDS_DOC, 'records')
  assert.equal(ACTIVE_TASK_SECTION_ID, 'tasks.active_task')
})

test('tasks-unit2: config bounds and boundary validators', { timeout: 60_000 }, () => {
  const defaults = resolveTasksConfig({})
  assert.deepEqual(defaults, {
    defaultPlannerProfile: 'assistant',
    defaultAssigneeProfile: 'assistant',
    maxConcurrentTasks: 0,
  })
  assert.deepEqual(resolveTasksConfig({ maxConcurrentTasks: 5, defaultAssigneeProfile: 'lx' }), {
    defaultPlannerProfile: 'assistant',
    defaultAssigneeProfile: 'lx',
    maxConcurrentTasks: 5,
  })
  assert.throws(() => resolveTasksConfig({ maxConcurrentTasks: -1 }), /0\.\.50/)
  assert.throws(() => resolveTasksConfig({ maxConcurrentTasks: 51 }), /0\.\.50/)
  assert.throws(() => resolveTasksConfig({ maxConcurrentTasks: 2.5 }), /0\.\.50/)
  assert.throws(() => resolveTasksConfig({ defaultAssigneeProfile: '' }), /1\.\.64/)

  assert.equal(assertTaskId('T-1'), 'T-1')
  assert.throws(() => assertTaskId('../escape'), /非法/)
  assert.throws(() => assertTaskId(''), /非法/)
  assert.throws(() => assertTaskId(42 as unknown as string), /字符串/)

  const task = makeTask()
  assert.equal(assertTaskRecord(task).id, 'T-1')
  assert.throws(() => assertTaskRecord(makeTask({ title: '' })), /title/)
  assert.throws(() => assertTaskRecord(makeTask({ column: 'weird' as TaskRecord['column'] })), /column/)
  assert.throws(() => assertTaskRecord(makeTask({ reworkCount: -1 })), /reworkCount/)
  assert.throws(() => assertTaskRecord(makeTask({ dependsOn: 'T-2' as unknown as string[] })), /dependsOn/)

  assert.equal(assertTaskStoreDoc({ nextSeq: 2, tasks: { 'T-1': task } }).nextSeq, 2)
  assert.throws(() => assertTaskStoreDoc({ nextSeq: 0, tasks: {} }), /nextSeq/)
  assert.throws(() => assertTaskStoreDoc({ nextSeq: 1, tasks: { 'T-9': task } }), /不一致/)
})

test('tasks-unit3: dependency cycle detection and full rejection surface', { timeout: 60_000 }, () => {
  const t1 = makeTask({ id: 'T-1' })
  const t2 = makeTask({ id: 'T-2', dependsOn: ['T-1'] })
  assert.equal(detectDependencyCycle({ 'T-1': t1, 'T-2': t2 }), null)

  // Two-node cycle
  const c1 = makeTask({ id: 'T-1', dependsOn: ['T-2'] })
  const c2 = makeTask({ id: 'T-2', dependsOn: ['T-1'] })
  assert.deepEqual(detectDependencyCycle({ 'T-1': c1, 'T-2': c2 }), ['T-1', 'T-2', 'T-1'])

  // Three-node cycle skips over an acyclic sibling
  const a = makeTask({ id: 'T-a' })
  const b = makeTask({ id: 'T-b', dependsOn: ['T-c'] })
  const c = makeTask({ id: 'T-c', dependsOn: ['T-d'] })
  const d = makeTask({ id: 'T-d', dependsOn: ['T-b'] })
  const cycle = detectDependencyCycle({ 'T-a': a, 'T-b': b, 'T-c': c, 'T-d': d })
  assert.ok(cycle !== null)
  assert.equal(cycle[0], cycle[cycle.length - 1])

  assert.throws(() => assertDependenciesValid('T-1', ['T-1'], {}), /不得依赖自身/)
  assert.throws(() => assertDependenciesValid('T-1', ['T-404'], { 'T-1': t1 }), /不存在/)
  assert.throws(() => assertDependenciesValid('T-2', ['T-1'], { 'T-1': c1, 'T-2': t2 }), /依赖环/)
  assert.doesNotThrow(() => assertDependenciesValid('T-2', ['T-1'], { 'T-1': t1, 'T-2': t2 }))

  assert.deepEqual(blockedDependenciesOf({ dependsOn: ['T-1', 'T-2'] }, { 'T-1': t1, 'T-2': t2 }), ['T-1', 'T-2'])
  assert.deepEqual(blockedDependenciesOf({ dependsOn: ['T-1'] }, { 'T-1': makeTask({ column: 'done' }) }), [])
})

test('tasks-unit4: board projection truncation keeps all active plus last 50 done entries', { timeout: 60_000 }, () => {
  const tasks: Record<string, TaskRecord> = {}
  for (let i = 1; i <= 3; i += 1) tasks[`T-${i}`] = makeTask({ id: `T-${i}`, createdAt: i, updatedAt: i })
  for (let i = 4; i <= 4 + TASK_BOARD_DONE_HISTORY_LIMIT + 10; i += 1) {
    tasks[`T-${i}`] = makeTask({
      id: `T-${i}`,
      column: 'done',
      archived: true,
      createdAt: i,
      updatedAt: i,
    })
  }
  const projected = projectBoardDoc({ nextSeq: 100, tasks })
  assert.equal(projected.tasks.length, 3 + TASK_BOARD_DONE_HISTORY_LIMIT)
  assert.equal(projected.tasks.some((t) => t.id === 'T-4'), false, 'oldest done history is dropped')
  const newestDone = `T-${4 + TASK_BOARD_DONE_HISTORY_LIMIT + 10}`
  assert.equal(projected.tasks.some((t) => t.id === newestDone), true, 'newest done history is kept')
  for (const id of ['T-1', 'T-2', 'T-3']) {
    assert.equal(projected.tasks.some((t) => t.id === id), true, `active ${id} always projected`)
  }
})

test('tasks-unit5: <active_task> section is byte-constant and kickoff prompt carries brief + rules', { timeout: 60_000 }, () => {
  const task = makeTask()
  const first = activeTaskSection(task)
  const second = activeTaskSection({ ...task, submission: { summary: 'x', submittedAt: 2 }, silenceState: { stalledAt: 3 } })
  assert.equal(first, second, 'mutable state must not leak into the section')

  assert.match(first, /^<active_task id="T-1" title="Ship login fix" plan-first="false" auto-merge="false">/)
  assert.match(first, /task_submit/)
  assert.match(first, /subagent \/ SubagentWorkflow \/ Swarm/)
  assert.doesNotMatch(first, /stalledAt|submission/)

  const planFirst = activeTaskSection(makeTask({ planFirst: true, autoMerge: true }))
  assert.match(planFirst, /plan-first="true" auto-merge="true"/)
  assert.match(planFirst, /task_request_plan_approval/)
  assert.match(planFirst, /before the plan is approved/)
  assert.match(planFirst, /merge your isolated branch/)

  const kickoff = buildTaskKickoffPrompt(task)
  assert.match(kickoff, /<task_kickoff id="T-1">/)
  assert.match(kickoff, /Fix the login redirect loop/)
  assert.match(kickoff, /NEVER merge into the main line yourself/)
  const planKickoff = buildTaskKickoffPrompt(makeTask({ planFirst: true }))
  assert.match(planKickoff, /task_request_plan_approval with your concise plan/)
  const mergeClosing = buildMergeClosingPrompt(makeTask({ id: 'T-9' }), 'do it')
  assert.match(mergeClosing, /explicitly authorized merging it now/)
  assert.match(mergeClosing, /merged: true explicitly/)
  assert.match(mergeClosing, /no second manual approval is needed/)
})

test('tasks-unit6: tool filtering isolates planner vs assignee vs child/automated sessions', { timeout: 60_000 }, () => {
  const tools = ['task_create', 'task_list', 'task_inspect', 'task_start', 'task_submit', 'task_approve', 'task_rework', 'bash', 'subagent'].map(TOOL)

  // Task execution conversation: planner tools hidden, submit/inspect/list kept, host tools untouched
  const assignee = filterTaskToolsForTurn(tools, makeConversation({ tags: ['task'] }), makeTask({ column: 'in_progress' }))!
  assert.deepEqual(
    assignee.map((t) => t.name).sort(),
    ['bash', 'subagent', 'task_inspect', 'task_list', 'task_submit'],
  )

  // Plain top-level human conversation: task_submit hidden, planner tools kept
  const planner = filterTaskToolsForTurn(tools, makeConversation(), undefined)!
  assert.deepEqual(
    planner.map((t) => t.name).sort(),
    ['bash', 'subagent', 'task_approve', 'task_create', 'task_inspect', 'task_list', 'task_rework', 'task_start'],
  )

  // Child conversation: planner tools hidden too
  const child = filterTaskToolsForTurn(tools, makeConversation({ parentConversationId: 1 }), undefined)!
  assert.equal(child.some((t) => t.name === 'task_create'), false)
  assert.equal(child.some((t) => t.name === 'task_submit'), false)

  // Automated conversation: same isolation
  const automated = filterTaskToolsForTurn(tools, makeConversation({ ownedBy: 'helmx' }), undefined)!
  assert.equal(automated.some((t) => t.name === 'task_create'), false)

  // No task tools present -> unchanged (undefined)
  const hostOnly = ['bash', 'subagent'].map(TOOL)
  assert.equal(filterTaskToolsForTurn(hostOnly, makeConversation(), undefined), undefined)
})

test('tasks-unit7: subtree busy check with cycle defense and stalled decision table', { timeout: 60_000 }, () => {
  const conv = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    title: `c${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/repo',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as never as import('@helmx/protocol').ConversationSummary

  const all = [
    conv(1),
    conv(2, { parentConversationId: 1, status: 'working' as never }),
    conv(3, { parentConversationId: 2, status: 'blocked' as never }),
    conv(4, { status: 'idle' as never }),
  ]
  assert.equal(subtreeHasWorkingOrBlocked(1, all), true)
  assert.equal(subtreeHasWorkingOrBlocked(4, all), false)
  // Cycle defense: 5 -> 6 -> 5 must terminate
  const cyclic = [...all, conv(5, { parentConversationId: 6 } as never), conv(6, { parentConversationId: 5 } as never)]
  assert.equal(subtreeHasWorkingOrBlocked(5, cyclic), false)

  const task = makeTask({ column: 'in_progress', conversationId: 7 })
  const base = {
    task,
    conversation: { id: 7, status: 'done' as const, pendingAskCount: 0 },
    subtreeBusy: false,
    workflowBusy: false as boolean | 'unknown',
  }
  // Fully quiescent, still in progress, not yet marked -> mark stalled (no delivery ever)
  assert.equal(shouldMarkStalled(base), true)
  // Already marked -> no double marking
  assert.equal(shouldMarkStalled({ ...base, task: { ...task, silenceState: { stalledAt: 5 } } }), false)
  assert.equal(shouldMarkStalled({ ...base, conversation: { ...base.conversation, pendingAskCount: 1 } }), false)
  assert.equal(shouldMarkStalled({ ...base, subtreeBusy: true }), false)
  // Workflow in-flight (or unknown probe) -> conservatively do not mark (avoid false "stalled")
  assert.equal(shouldMarkStalled({ ...base, workflowBusy: true }), false)
  assert.equal(shouldMarkStalled({ ...base, workflowBusy: 'unknown' }), false)
  assert.equal(shouldMarkStalled({ ...base, task: { ...task, column: 'in_review' } }), false)
  assert.equal(shouldMarkStalled({ ...base, task: { ...task, conversationId: 8 } }), false)
})

test('tasks-unit7b: restart recovery rolls back interrupted two-phase startups honestly', { timeout: 60_000 }, () => {
  const draft = {
    nextSeq: 5,
    tasks: {
      'T-1': makeTask({ id: 'T-1', column: 'in_progress', conversationId: 11 }),
      // interrupted startup placeholder: in_progress without a bound conversation
      'T-2': makeTask({ id: 'T-2', column: 'in_progress', startedAt: 9 }),
      'T-3': makeTask({ id: 'T-3', column: 'backlog' }),
    },
  }
  const rolled = recoverInterruptedStartups(draft)
  assert.deepEqual(rolled, ['T-2'])
  assert.equal(draft.tasks['T-2']!.column, 'backlog')
  assert.equal(draft.tasks['T-2']!.startedAt, undefined)
  assert.match(draft.tasks['T-2']!.silenceState!.lastError!, /startup interrupted/)
  // Bound or non-running tasks untouched
  assert.equal(draft.tasks['T-1']!.column, 'in_progress')
  assert.equal(draft.tasks['T-3']!.column, 'backlog')
  assert.equal(draft.tasks['T-3']!.silenceState, undefined)
})

test('tasks-unit7c: kickoff marker recovery marks undelivered for live tasks only, never auto-delivers', { timeout: 60_000 }, () => {
  const draft = {
    nextSeq: 9,
    tasks: {
      // in_progress + bound + marker pending -> honestly marked undelivered (board shows "resume")
      'T-1': makeTask({ id: 'T-1', column: 'in_progress', conversationId: 11, kickoffPending: true }),
      // backlog residue (e.g. rolled back concurrently): marker cleared, no false undelivered flag
      'T-2': makeTask({ id: 'T-2', column: 'backlog', kickoffPending: true }),
      // healthy task: no marker, untouched
      'T-3': makeTask({ id: 'T-3', column: 'in_progress', conversationId: 13 }),
    },
  }
  const marked = recoverKickoffMarkers(draft)
  assert.deepEqual(marked, ['T-1'])
  assert.equal(draft.tasks['T-1']!.kickoffPending, undefined)
  assert.equal(draft.tasks['T-1']!.kickoffUndelivered, true)
  assert.equal(draft.tasks['T-2']!.kickoffPending, undefined)
  assert.equal(draft.tasks['T-2']!.kickoffUndelivered, undefined)
  assert.equal(draft.tasks['T-3']!.kickoffUndelivered, undefined)
})

test('tasks-unit8: HelmxError contract sanity for store validators', { timeout: 60_000 }, () => {
  try {
    assertTaskStoreDoc({ nextSeq: 1, tasks: { 'T-1': makeTask({ createdAt: -5 }) } })
    assert.fail('must throw')
  } catch (err) {
    assert.ok(err instanceof HelmxError)
    assert.equal((err as HelmxError).code, 'tasks_doc_corrupt')
  }
})

test('tasks-unit9: board badge projection — honest attention counts, tone ladder, bilingual summary', { timeout: 60_000 }, () => {
  const conv = (id: number, over: Record<string, unknown> = {}) =>
    ({
      id,
      title: `c${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/repo',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as never as import('@helmx/protocol').ConversationSummary

  const board = (tasks: Record<string, TaskRecord>, conversations?: import('@helmx/protocol').ConversationSummary[]) =>
    projectBoardDoc({ nextSeq: 100, tasks }, conversations)

  // Empty board: fully quiet neutral
  const empty = board({})
  assert.equal(empty.attentionCount, 0)
  assert.equal(empty.reviewCount, 0)
  assert.equal(empty.runningCount, 0)
  assert.equal(empty.hasRunning, false)
  assert.equal(empty.badgeTone, 'neutral')
  assert.equal(empty.badgeSummary, undefined)

  // Backlog-only: still neutral
  const backlog = board({ 'T-1': makeTask(), 'T-2': makeTask({ id: 'T-2' }) })
  assert.equal(backlog.badgeTone, 'neutral')
  assert.equal(backlog.attentionCount, 0)
  assert.equal(backlog.badgeSummary, undefined)

  // Healthy running (no conversation facts provided): quiet accent dot, running summary
  const running = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, startedAt: 2_000 }),
    'T-2': makeTask({ id: 'T-2', column: 'in_progress', conversationId: 8, startedAt: 2_000 }),
  })
  assert.equal(running.attentionCount, 0)
  assert.equal(running.runningCount, 2)
  assert.equal(running.hasRunning, true)
  assert.equal(running.badgeTone, 'accent')
  assert.deepEqual(running.badgeSummary, { en: '2 running', 'zh-CN': '2 个进行中' })

  // in_review: attention + review counts, warn tone, review-only summary
  const review = board({
    'T-1': makeTask({ column: 'in_review', conversationId: 7, submission: { summary: 'done', submittedAt: 3 } }),
  })
  assert.equal(review.attentionCount, 1)
  assert.equal(review.reviewCount, 1)
  assert.equal(review.runningCount, 0)
  assert.equal(review.hasRunning, false)
  assert.equal(review.badgeTone, 'warn')
  assert.deepEqual(review.badgeSummary, { en: '1 awaiting review', 'zh-CN': '1 个待验收' })

  // Persisted record signals (no conversation facts needed): stalled / lastError / kickoffUndelivered / plan ask
  const stalled = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, silenceState: { stalledAt: 5 } }),
  })
  assert.equal(stalled.attentionCount, 1)
  assert.equal(stalled.runningCount, 0)
  assert.equal(stalled.badgeTone, 'warn')
  assert.deepEqual(stalled.badgeSummary, { en: '1 needs attention', 'zh-CN': '1 个需处理' })

  const lastError = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, silenceState: { lastError: 'boom' } }),
  })
  assert.equal(lastError.attentionCount, 1)
  assert.equal(lastError.badgeTone, 'warn')

  const undelivered = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, kickoffUndelivered: true }),
  })
  assert.equal(undelivered.attentionCount, 1)
  assert.equal(undelivered.badgeTone, 'warn')

  const planAsk = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, pendingPlanAskId: 'ask-1' }),
  })
  assert.equal(planAsk.attentionCount, 1)
  assert.equal(planAsk.badgeTone, 'warn')
  // Decided plan (even rejected) is not an attention signal by itself
  const planDecided = board({
    'T-1': makeTask({
      column: 'in_progress',
      conversationId: 7,
      pendingPlanAskId: 'ask-1',
      planApproval: { decision: 'approved', askedAt: 1, decidedAt: 2, askId: 'ask-1' },
    }),
  })
  assert.equal(planDecided.attentionCount, 0)
  assert.equal(planDecided.runningCount, 1)
  assert.equal(planDecided.badgeTone, 'accent')

  // conversationMissing flag (persisted by conversation.deleted): error severity
  const missingFlag = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, conversationMissing: true }),
  })
  assert.equal(missingFlag.attentionCount, 1)
  assert.equal(missingFlag.badgeTone, 'error')
  assert.deepEqual(missingFlag.badgeSummary, { en: '1 needs attention', 'zh-CN': '1 个需处理' })

  // Live conversation facts: bound conversation absent from the provided list -> error
  const absent = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(8)],
  )
  assert.equal(absent.attentionCount, 1)
  assert.equal(absent.badgeTone, 'error')

  // Descendant error in the bound conversation subtree -> attention at error severity (subtree traversal)
  const descendantError = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7), conv(8, { parentConversationId: 7 }), conv(9, { parentConversationId: 8, status: 'error' })],
  )
  assert.equal(descendantError.attentionCount, 1)
  assert.equal(descendantError.badgeTone, 'error')

  // Blocked descendant / pending ask on the bound conversation -> warn attention (not error, not running)
  const descendantBlocked = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7), conv(9, { parentConversationId: 7, status: 'blocked' })],
  )
  assert.equal(descendantBlocked.attentionCount, 1)
  assert.equal(descendantBlocked.runningCount, 0)
  assert.equal(descendantBlocked.badgeTone, 'warn')

  const pendingAsk = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7, { status: 'blocked', pendingAskCount: 1 })],
  )
  assert.equal(pendingAsk.attentionCount, 1)
  assert.equal(pendingAsk.badgeTone, 'warn')

  // In-review card with a missing conversation: review attention at error severity
  const reviewMissing = board(
    { 'T-1': makeTask({ column: 'in_review', conversationId: 7, conversationMissing: true }) },
    [],
  )
  assert.equal(reviewMissing.attentionCount, 1)
  assert.equal(reviewMissing.reviewCount, 1)
  assert.equal(reviewMissing.badgeTone, 'error')

  // Mixed review + healthy running: attention wins, hasRunning false, summary carries review part only
  const mixed = board({
    'T-1': makeTask({ column: 'in_review', conversationId: 7, submission: { summary: 'done', submittedAt: 3 } }),
    'T-2': makeTask({ id: 'T-2', column: 'in_progress', conversationId: 8 }),
  })
  assert.equal(mixed.attentionCount, 1)
  assert.equal(mixed.reviewCount, 1)
  assert.equal(mixed.runningCount, 1)
  assert.equal(mixed.hasRunning, false)
  assert.equal(mixed.badgeTone, 'warn')
  assert.deepEqual(mixed.badgeSummary, { en: '1 awaiting review', 'zh-CN': '1 个待验收' })

  // Review + other attention: combined summary with both parts (EN pluralization included)
  const combined = board({
    'T-1': makeTask({ column: 'in_review', conversationId: 7, submission: { summary: 'done', submittedAt: 3 } }),
    'T-2': makeTask({ id: 'T-2', column: 'in_progress', conversationId: 8, silenceState: { stalledAt: 5 } }),
    'T-3': makeTask({ id: 'T-3', column: 'in_progress', conversationId: 9, silenceState: { stalledAt: 6 } }),
  })
  assert.equal(combined.attentionCount, 3)
  assert.equal(combined.reviewCount, 1)
  assert.equal(combined.badgeTone, 'warn')
  assert.deepEqual(combined.badgeSummary, { en: '1 awaiting review · 2 need attention', 'zh-CN': '1 个待验收 · 2 个需处理' })

  // Archived cards are excluded from every badge count even in active-ish columns
  const archived = board({
    'T-1': makeTask({ column: 'in_review', archived: true, conversationId: 7 }),
    'T-2': makeTask({ id: 'T-2', column: 'in_progress', archived: true, conversationId: 8 }),
  })
  assert.equal(archived.attentionCount, 0)
  assert.equal(archived.reviewCount, 0)
  assert.equal(archived.runningCount, 0)
  assert.equal(archived.badgeTone, 'neutral')
  assert.equal(archived.badgeSummary, undefined)
})

test('tasks-unit10: subtreeAttentionFlags collects error and blocked/ask facts in one cycle-safe walk', { timeout: 60_000 }, () => {
  const conv = (id: number, over: Record<string, unknown> = {}) =>
    ({
      id,
      title: `c${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/repo',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as never as import('@helmx/protocol').ConversationSummary

  const quiet = subtreeAttentionFlags(1, [conv(1), conv(2, { parentConversationId: 1 })])
  assert.deepEqual({ ...quiet }, { error: false, blockedOrAsk: false })

  const errored = subtreeAttentionFlags(1, [conv(1), conv(2, { parentConversationId: 1, status: 'error' })])
  assert.deepEqual({ ...errored }, { error: true, blockedOrAsk: false })

  const asked = subtreeAttentionFlags(1, [conv(1, { pendingAskCount: 2 })])
  assert.deepEqual({ ...asked }, { error: false, blockedOrAsk: true })

  // Root itself counts; cycle defense terminates
  const rootBlocked = subtreeAttentionFlags(1, [conv(1, { status: 'blocked' })])
  assert.deepEqual({ ...rootBlocked }, { error: false, blockedOrAsk: true })
  const cyclic = [conv(1), conv(2, { parentConversationId: 3 }), conv(3, { parentConversationId: 2, status: 'error' })]
  assert.deepEqual({ ...subtreeAttentionFlags(1, cyclic) }, { error: false, blockedOrAsk: false })

  // Dirty-check key: stable serialization of the badge tuple
  assert.equal(
    taskBoardBadgeKey({ attentionCount: 1, reviewCount: 1, runningCount: 0, hasRunning: false, badgeTone: 'warn' }),
    taskBoardBadgeKey({ attentionCount: 1, reviewCount: 1, runningCount: 0, hasRunning: false, badgeTone: 'warn' }),
  )
  assert.notEqual(
    taskBoardBadgeKey({ attentionCount: 1, reviewCount: 1, runningCount: 0, hasRunning: false, badgeTone: 'warn' }),
    taskBoardBadgeKey({ attentionCount: 1, reviewCount: 1, runningCount: 0, hasRunning: false, badgeTone: 'error' }),
  )

  // Sidebar badge declaration constant: exact Contract A field names against the board doc fields
  assert.deepEqual({ ...TASK_BOARD_SIDEBAR_BADGE }, {
    doc: 'board',
    countField: 'attentionCount',
    toneField: 'badgeTone',
    dotField: 'hasRunning',
    summaryField: 'badgeSummary',
  })
})

// ---------------------------------------------------------------------------
// 看板归档语义（归档即收离看板；已归档卡仅历史开关打开时可见、沉底淡化）
// ---------------------------------------------------------------------------

test('tasks-unit: screen params 解析 archived 开关（深链单一事实源）', { timeout: 60_000 }, async () => {
  const { parseTaskScreenParams } = await import('../src/tasks/client/models.js')
  assert.equal(parseTaskScreenParams({}).showArchived, false)
  assert.equal(parseTaskScreenParams({ archived: '1' }).showArchived, true)
  assert.equal(parseTaskScreenParams({ archived: '0' }).showArchived, false)
  // 既有参数不受影响
  const parsed = parseTaskScreenParams({ q: 'fix', tab: 'done', task: 'T-9', archived: '1' })
  assert.equal(parsed.filter.query, 'fix')
  assert.equal(parsed.tab, 'done')
  assert.equal(parsed.taskId, 'T-9')
})

test('tasks-unit: compareTaskItems 已归档卡沉底（活跃卡永远在前）', { timeout: 60_000 }, async () => {
  const { bucketByColumn, deriveBoardItems } = await import('../src/tasks/client/models.js')
  const base = { reworkCount: 0, dependsOn: [], createdAt: 0, updatedAt: 0 } as const
  const tasks = [
    { ...base, id: 'T-1', title: '旧归档', column: 'done', archived: true, createdAt: 5000 },
    { ...base, id: 'T-2', title: '新结单', column: 'done', createdAt: 100 },
    { ...base, id: 'T-3', title: '更新归档', column: 'done', archived: true, createdAt: 200 },
  ] as never as Parameters<typeof deriveBoardItems>[0]
  const items = deriveBoardItems(tasks, [])
  const done = bucketByColumn(items).done
  // 未归档在前；两张归档卡之间按创建时间倒序
  assert.deepEqual(done.map((i) => i.task.id), ['T-2', 'T-1', 'T-3'])
})

// ---------------------------------------------------------------------------
// 会话总览卡胶囊（OVERVIEW_CARD_META_SLOT 贡献）
// ---------------------------------------------------------------------------

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

test('tasks-unit11: 总览卡胶囊查找优先序与 TaskOverviewCardMeta 只读跳转交互', { timeout: 60_000 }, async (t) => {
  // models.ts 传递导入 @helmx/plugin-client（连带 Radix），须在 happy-dom 就绪后动态导入
  if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()
  const { findTaskForOverviewCard } = await import('../src/tasks/client/models.ts')
  type ClientTaskRecord = import('../src/tasks/client/models.ts').TaskRecord
  const ct = (over: Partial<ClientTaskRecord> = {}): ClientTaskRecord => ({
    id: 'T-0',
    title: 'Demo',
    brief: '',
    column: 'backlog',
    assigneeProfileId: 'assistant',
    dependsOn: [],
    reworkCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  // 根会话精确命中优先于树成员命中
  assert.equal(
    findTaskForOverviewCard([ct({ id: 'T-2', conversationId: 7 }), ct({ id: 'T-1', conversationId: 42 })], 42, [42, 7])?.id,
    'T-1',
  )
  // 树成员（子会话）兜底命中
  assert.equal(findTaskForOverviewCard([ct({ id: 'T-3', conversationId: 9 })], 42, [42, 9])?.id, 'T-3')
  // 同桶内未归档优先于已归档历史（即便归档者 updatedAt 更新）
  assert.equal(
    findTaskForOverviewCard(
      [ct({ id: 'T-4', conversationId: 7, archived: true, updatedAt: 900 }), ct({ id: 'T-5', conversationId: 7, updatedAt: 100 })],
      7,
      [7],
    )?.id,
    'T-5',
  )
  // 全归档时仍返回最新归档（历史卡仍可跳转），updatedAt 决胜、id 决定平局
  assert.equal(
    findTaskForOverviewCard(
      [ct({ id: 'T-6', conversationId: 7, archived: true, updatedAt: 5 }), ct({ id: 'T-7', conversationId: 7, archived: true, updatedAt: 9 })],
      7,
      [7],
    )?.id,
    'T-7',
  )
  assert.equal(
    findTaskForOverviewCard([ct({ id: 'T-8', conversationId: 7, updatedAt: 10 }), ct({ id: 'T-9', conversationId: 7, updatedAt: 20 })], 7, [7])?.id,
    'T-9',
  )
  // 无命中面：无 conversationId 记录、memberIds 不含目标、空任务表、双缺省标识
  assert.equal(findTaskForOverviewCard([ct({ id: 'T-10' })], 42, [42]), undefined)
  assert.equal(findTaskForOverviewCard([ct({ id: 'T-11', conversationId: 7 })], 42, [42]), undefined)
  assert.equal(findTaskForOverviewCard([], 42, [42]), undefined)
  assert.equal(findTaskForOverviewCard([ct({ id: 'T-12', conversationId: 42 })], undefined, undefined), undefined)

  // ---- 编译产物组件交互（真实 bundle + 共享宿主 SDK + DOM 事件） ----
  const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
  const React = req('react') as typeof import('react')
  const ReactDOM = req('react-dom') as unknown
  const ReactDOMClient = req('react-dom/client') as {
    createRoot: (container: Element) => { render(node: React.ReactNode): void; unmount(): void }
  }
  const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
  const LucideReact = req('lucide-react') as Record<string, unknown>
  const SDK = await import('../../plugin-client/src/index.js')

  const g = globalThis as Record<string, unknown>
  const sharedKeys = [
    'React',
    'IS_REACT_ACT_ENVIRONMENT',
    CLIENT_SHARED_GLOBALS['react']!,
    CLIENT_SHARED_GLOBALS['react-dom']!,
    CLIENT_SHARED_GLOBALS['react-dom/client']!,
    CLIENT_SHARED_GLOBALS['react/jsx-runtime']!,
    CLIENT_SHARED_GLOBALS['lucide-react']!,
    CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!,
  ]
  const prevGlobals = new Map(sharedKeys.map((k) => [k, g[k]]))
  const buildDir = mkdtempSync(join(tmpdir(), 'helmx-tasks-overview-pill-'))
  t.after(() => {
    for (const key of sharedKeys) {
      const prev = prevGlobals.get(key)
      if (prev === undefined) delete g[key]
      else g[key] = prev
    }
    rmSync(buildDir, { recursive: true, force: true })
  })

  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react-dom']!] = ReactDOM
  g[CLIENT_SHARED_GLOBALS['react-dom/client']!] = ReactDOMClient
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] = SDK

  const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/tasks/client')
  const bundle = await compilePluginClientModule(TASKS_PLUGIN_ID, clientDir, 'index.tsx', buildDir)
  const rawModule = (await import(`data:text/javascript;base64,${Buffer.from(bundle.code, 'utf8').toString('base64')}`)) as Record<
    string,
    unknown
  >

  // Fast Refresh 契约：客户端 bundle 仅导出 PascalCase 组件函数
  for (const [name, value] of Object.entries(rawModule)) {
    if (name === 'default' || name.startsWith('__')) continue
    assert.ok(/^[A-Z][A-Za-z0-9]*$/.test(name), `客户端应仅导出 PascalCase 组件，发现：${name}`)
    assert.ok(typeof value === 'function', `导出 ${name} 应为组件函数`)
  }
  const TaskOverviewCardMeta = rawModule['TaskOverviewCardMeta'] as React.ComponentType<Record<string, unknown>>
  assert.ok(TaskOverviewCardMeta !== undefined, '客户端应导出 TaskOverviewCardMeta')

  const rootConversation: ConversationSummary = {
    id: 42,
    title: 'Fix login redirect',
    profileId: 'assistant',
    tags: ['task'],
    cwd: '/workspace/demo',
    model: 'faux/echo',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
  }

  const mountPill = (board: unknown) => {
    const screens: string[] = []
    const port: import('../../plugin-client/src/index.js').PluginClientHostPort = {
      authenticated: true,
      theme: 'light',
      locale: 'zh-CN',
      conversations: [],
      conversationDetails: {},
      conversationLives: {},
      pendingAsks: [],
      loadErrors: {},
      plugins: [],
      screens: [],
      pluginDocs: board === undefined ? {} : { 'builtin:tasks/board': board },
      ensurePluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      subscribeSessionDoc: () => () => {},
      getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false }),
      invokePluginAction: async () => ({}),
      submitConversationInput: async () => undefined,
      openTarget: (target) => {
        screens.push(target)
      },
      openConversationDrawer: () => undefined,
      openArtifactPreview: () => undefined,
      setWorkbenchOpen: () => undefined,
      setWorkbenchTab: () => undefined,
      notify: () => undefined,
      loadConversationDetail: () => undefined,
      slots: { collectItems: () => [], renderItem: () => null },
      markdown: { view: () => null, codeBlock: () => null },
    }
    const ctx = SDK.createPluginClientContext(port, TASKS_PLUGIN_ID, 42)
    let outerClicks = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container)
    React.act(() => {
      root.render(
        React.createElement(
          SDK.PluginClientHostContext.Provider,
          { value: port },
          React.createElement(
            SDK.PluginClientContext.Provider,
            { value: ctx },
            React.createElement(
              'div',
              {
                onClick: () => {
                  outerClicks += 1
                },
              },
              React.createElement(TaskOverviewCardMeta, { rootConversation, memberIds: [42, 43] }),
            ),
          ),
        ),
      )
    })
    return {
      container,
      screens,
      outerClicks: () => outerClicks,
      unmount: () => {
        React.act(() => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  // 命中：任务号 + zh-CN 列位文案 + 项目短标记 + data-column 事实；点击深链且不冒泡
  const hit = mountPill({
    tasks: [
      { id: 'T-12', title: 'Ship', column: 'in_review', conversationId: 42, project: 'helmx-web', updatedAt: 9 },
      { id: 'T-13', title: 'Other', column: 'backlog', conversationId: 999, updatedAt: 99 },
    ],
    updatedAt: 9,
  })
  try {
    const pill = hit.container.querySelector('button.task-overview-pill')
    assert.ok(pill !== null, '命中应渲染胶囊按钮')
    assert.ok(pill.getAttribute('data-column') === 'in_review', 'data-column 应携带真实列位')
    const text = pill.textContent ?? ''
    assert.ok(text.includes('T-12'), `胶囊应含任务号，实际：${text}`)
    assert.ok(text.includes('待验收'), `zh-CN 列位文案应渲染，实际：${text}`)
    assert.ok(text.includes('helmx-web'), `项目短标记应渲染，实际：${text}`)
    assert.ok(!EMOJI_RE.test(text), '渲染文本不得含 Emoji')
    const title = pill.getAttribute('title') ?? ''
    assert.ok(title.includes('T-12'), `title 应为跳转说明，实际：${title}`)
    React.act(() => {
      pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(hit.screens, ['screen:builtin:tasks/board?task=T-12'], '点击应深链看板任务抽屉')
    assert.ok(hit.outerClicks() === 0, '点击胶囊不得冒泡触发外层总览卡动作')
  } finally {
    hit.unmount()
  }

  // 无命中（doc 未加载 / 无匹配任务）返回 null：零视觉残留
  for (const board of [undefined, { tasks: [{ id: 'T-13', title: 'Other', column: 'backlog', conversationId: 999 }], updatedAt: 1 }]) {
    const miss = mountPill(board)
    try {
      assert.ok(miss.container.querySelector('button') === null, '无命中不应渲染任何按钮')
      assert.ok((miss.container.textContent ?? '') === '', '无命中零文本残留')
    } finally {
      miss.unmount()
    }
  }
})
