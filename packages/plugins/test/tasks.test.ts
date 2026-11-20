/**
 * builtin:tasks 纯函数与插件定义单测（Unit 档，纯内存零全局副作用）：
 * - 插件契约：TASKS_PLUGIN_ID / 受管技能 ID / 标签常量 / 无静态 dependencies / 双语元数据；
 * - 配置边界（defaultPlannerProfile / defaultAssigneeProfile）与 doc / record / id 强校验；
 * - board 投影截断（未归档全量 + 最近 50 条历史）与徽标聚合全状态判定
 *   （attention / review / running / tone 阶梯 / 双语摘要 / 主会话事实 / 脏检查键）；
 * - <active_task> 段落 100% 字节恒定与 kickoff 任务书内容；
 * - before_turn 工具过滤纯函数（规划/执行隔离、子会话与自动化会话）；
 * - 客户端纯模型：deriveTaskLiveView 只看主会话 + background 快照、
 *   「会话已空闲 · 未交卷」纯派生、screen params archived 开关、compareTaskItems 归档沉底；
 * - 会话总览卡胶囊（OVERVIEW_CARD_META_SLOT）：findTaskForOverviewCard 纯函数
 *   优先序（根精确 > 树成员；未归档 > 已归档；updatedAt 最新）+ 编译产物
 *   TaskOverviewCardMeta 只读跳转渲染/交互（命中渲染、点击深链且阻止冒泡、
 *   无命中 null 零残留、导出仅 PascalCase 组件）——该用例内注册 happy-dom。
 * - 详情抽屉长文本（简报/交付 summary/验证说明/最近返工意见）全部经宿主
 *   markdown.view 渲染且全文可见，交付区不复用卡片 line-clamp 摘要类。
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
  createTasksPlugin,
  projectBoardDoc,
  resolveTasksConfig,
  taskBoardBadgeKey,
  type TaskRecord,
} from '../src/tasks.js'
import { activeTaskSection, buildTaskKickoffPrompt } from '../src/tasks/prompts.js'
import { filterTaskToolsForTurn } from '../src/tasks/hooks.js'

function makeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'T-1',
    title: 'Ship login fix',
    brief: 'Fix the login redirect loop described in issue 42. Acceptance: e2e test passes.',
    column: 'backlog',
    assigneeProfileId: 'assistant',
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
  })
  assert.deepEqual(resolveTasksConfig({ defaultAssigneeProfile: 'lx', defaultPlannerProfile: 'code2' }), {
    defaultPlannerProfile: 'code2',
    defaultAssigneeProfile: 'lx',
  })
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

  assert.equal(assertTaskStoreDoc({ nextSeq: 2, tasks: { 'T-1': task } }).nextSeq, 2)
  assert.throws(() => assertTaskStoreDoc({ nextSeq: 0, tasks: {} }), /nextSeq/)
  assert.throws(() => assertTaskStoreDoc({ nextSeq: 1, tasks: { 'T-9': task } }), /不一致/)
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
  const second = activeTaskSection({ ...task, submission: { summary: 'x', submittedAt: 2 } })
  assert.equal(first, second, 'mutable state must not leak into the section')

  assert.match(first, /^<active_task id="T-1" title="Ship login fix">/)
  assert.match(first, /task_submit/)
  assert.match(first, /subagent \/ SubagentWorkflow \/ Swarm/)
  assert.doesNotMatch(first, /submission|plan-first|auto-merge/, 'deleted flags must not leak into the section')

  const kickoff = buildTaskKickoffPrompt(task)
  assert.match(kickoff, /<task_kickoff id="T-1">/)
  assert.match(kickoff, /Fix the login redirect loop/)
  assert.match(kickoff, /task_submit with a summary/)
  assert.doesNotMatch(kickoff, /planFirst|autoMerge|task_request_plan_approval/)
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
    }) as never as ConversationSummary

  const board = (tasks: Record<string, TaskRecord>, conversations?: ConversationSummary[]) =>
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

  // Healthy running (main idle, no facts): quiet accent dot, running summary
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

  // conversationMissing flag (persisted by conversation.deleted): error severity
  const missingFlag = board({
    'T-1': makeTask({ column: 'in_progress', conversationId: 7, conversationMissing: true }),
  })
  assert.equal(missingFlag.attentionCount, 1)
  assert.equal(missingFlag.badgeTone, 'error')
  assert.deepEqual(missingFlag.badgeSummary, { en: '1 needs attention', 'zh-CN': '1 个需处理' })

  // Live main-conversation facts: bound conversation absent from the provided list -> error
  const absent = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(8)],
  )
  assert.equal(absent.attentionCount, 1)
  assert.equal(absent.badgeTone, 'error')

  // Main conversation error -> attention at error severity
  const errored = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7, { status: 'error' })],
  )
  assert.equal(errored.attentionCount, 1)
  assert.equal(errored.badgeTone, 'error')

  // Main blocked / pending ask -> warn attention (not error, not running)
  const blocked = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7, { status: 'blocked' })],
  )
  assert.equal(blocked.attentionCount, 1)
  assert.equal(blocked.runningCount, 0)
  assert.equal(blocked.badgeTone, 'warn')

  const pendingAsk = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7, { status: 'blocked', pendingAskCount: 1 })],
  )
  assert.equal(pendingAsk.attentionCount, 1)
  assert.equal(pendingAsk.badgeTone, 'warn')

  // Descendant-only signals are NOT attention (subtree monitoring removed): a
  // working child under an idle main conversation is still a healthy run.
  const descendantBusy = board(
    { 'T-1': makeTask({ column: 'in_progress', conversationId: 7 }) },
    [conv(7), conv(9, { parentConversationId: 7, status: 'working' })],
  )
  assert.equal(descendantBusy.attentionCount, 0)
  assert.equal(descendantBusy.runningCount, 1)
  assert.equal(descendantBusy.badgeTone, 'accent')

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
    'T-2': makeTask({ id: 'T-2', column: 'in_progress', conversationId: 8, conversationMissing: true }),
    'T-3': makeTask({ id: 'T-3', column: 'in_progress', conversationId: 9, conversationMissing: true }),
  })
  assert.equal(combined.attentionCount, 3)
  assert.equal(combined.reviewCount, 1)
  assert.equal(combined.badgeTone, 'error')
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
// 客户端纯模型（deriveTaskLiveView 只看主会话 + background 快照）
// ---------------------------------------------------------------------------

test('tasks-unit-models: deriveTaskLiveView 主会话事实优先级与「会话已空闲 · 未交卷」纯派生', { timeout: 60_000 }, async () => {
  const { deriveTaskLiveView } = await import('../src/tasks/client/models.js')
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
    }) as never as ConversationSummary

  const running = makeTask({ column: 'in_progress', conversationId: 7 })
  // 主会话 working：running 灯 + doing 摘要
  const working = deriveTaskLiveView(running, [conv(7, { status: 'working', doing: '跑测试' })], undefined, 'zh-CN')
  assert.equal(working.lightStatus, 'running')
  assert.equal(working.needsAttention, false)
  assert.equal(working.liveSummary, '跑测试')

  // 主会话 blocked + 待答 Ask：blocked 灯 + 等待审批 + needsAttention
  const asked = deriveTaskLiveView(running, [conv(7, { status: 'blocked', pendingAskCount: 1 })], undefined, 'zh-CN')
  assert.equal(asked.lightStatus, 'blocked')
  assert.equal(asked.approvalPending, true)
  assert.equal(asked.needsAttention, true)
  assert.ok(asked.liveSummary.includes('等待审批'))

  // 主会话 error：error 灯 + lastError 摘要
  const errored = deriveTaskLiveView(running, [conv(7, { status: 'error', lastError: 'boom' })], undefined, 'zh-CN')
  assert.equal(errored.lightStatus, 'error')
  assert.equal(errored.needsAttention, true)
  assert.ok(errored.liveSummary.includes('boom'))

  // 会话缺失：error 灯 + 缺失摘要（真实会话表里没有绑定会话）
  const missing = deriveTaskLiveView(running, [conv(8)], undefined, 'zh-CN')
  assert.equal(missing.conversationMissing, true)
  assert.equal(missing.lightStatus, 'error')
  assert.equal(missing.needsAttention, true)
  assert.ok(missing.liveSummary.includes('执行会话缺失'))

  // 纯派生「会话已空闲 · 未交卷」：in_progress + 主会话 idle + 无 background 在途
  const idle = deriveTaskLiveView(running, [conv(7, { status: 'idle' })], undefined, 'zh-CN')
  assert.equal(idle.lightStatus, 'idle')
  assert.equal(idle.idleNotSubmitted, true)
  assert.ok(idle.liveSummary.includes('会话已空闲'))
  assert.ok(idle.liveSummary.includes('未交卷'))
  // 空闲未交卷不进 needsAttention（服务端口径一致：主会话 error/blocked/缺失才算）
  assert.equal(idle.needsAttention, false)

  // background 在途优先于 idle：SDK 快照 active 时不误报「空闲未交卷」
  const backgroundActive = deriveTaskLiveView(running, [conv(7, { status: 'idle' })], undefined, 'zh-CN', {
    unknown: false,
    byConversation: new Map([[7, { active: true, summary: '后台跑 workflow' }]]),
  })
  assert.equal(backgroundActive.lightStatus, 'background')
  assert.equal(backgroundActive.backgroundActive, true)
  assert.equal(backgroundActive.idleNotSubmitted, false)
  assert.ok(backgroundActive.liveSummary.includes('后台跑 workflow'))

  // background unknown（doc 加载中）：不推断任何方向，idle 派生照常按主会话事实给出
  const backgroundUnknown = deriveTaskLiveView(running, [conv(7, { status: 'idle' })], undefined, 'zh-CN', {
    unknown: true,
    byConversation: new Map(),
  })
  assert.equal(backgroundUnknown.lightStatus, 'idle')
  assert.equal(backgroundUnknown.idleNotSubmitted, true)

  // 子会话状态不影响灯位（子树扫描已删）：working 子会话下主会话 idle 仍是 idle
  const childWorking = deriveTaskLiveView(running, [conv(7, { status: 'idle' }), conv(9, { parentConversationId: 7, status: 'working' })], undefined, 'zh-CN')
  assert.equal(childWorking.lightStatus, 'idle')

  // backlog 卡恒可开工；无会话时无摘要
  const backlogCard = deriveTaskLiveView(makeTask(), [], undefined, 'zh-CN')
  assert.equal(backlogCard.isReadyToStart, true)
  assert.equal(backlogCard.liveSummary, '')
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
  const base = { reworkCount: 0, createdAt: 0, updatedAt: 0 } as const
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

test('tasks-unit12: 详情抽屉交付信息与返工意见走宿主 Markdown 渲染（全文不截断）', { timeout: 60_000 }, async (t) => {
  // 该用例内注册 happy-dom；挂载编译产物 TaskDetailDrawer 验证长文本字段全部
  // 经宿主 markdown.view 渲染且不落卡片式 line-clamp 类。
  if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()
  const { deriveTaskLiveView } = await import('../src/tasks/client/models.ts')

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
  const buildDir = mkdtempSync(join(tmpdir(), 'helmx-tasks-drawer-md-'))
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
  const bundle = await compilePluginClientModule(TASKS_PLUGIN_ID, clientDir, 'TaskDialogs.tsx', buildDir)
  const rawModule = (await import(`data:text/javascript;base64,${Buffer.from(bundle.code, 'utf8').toString('base64')}`)) as Record<
    string,
    unknown
  >
  const TaskDetailDrawer = rawModule['TaskDetailDrawer'] as React.ComponentType<Record<string, unknown>>
  assert.ok(TaskDetailDrawer !== undefined, '客户端应导出 TaskDetailDrawer')

  const rendered: string[] = []
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
    pluginDocs: {},
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false }),
    invokePluginAction: async () => ({}),
    submitConversationInput: async () => undefined,
    openTarget: () => undefined,
    openConversationDrawer: () => undefined,
    openArtifactPreview: () => undefined,
    setWorkbenchOpen: () => undefined,
    setWorkbenchTab: () => undefined,
    notify: () => undefined,
    loadConversationDetail: () => undefined,
    slots: { collectItems: () => [], renderItem: () => null },
    markdown: {
      view: ({ text }: { text: string }) => {
        rendered.push(text)
        return React.createElement('div', { className: 'md-stub' }, text)
      },
      codeBlock: ({ code }: { code: string }) => React.createElement('pre', null, code),
    },
  }
  const ctx = SDK.createPluginClientContext(port, TASKS_PLUGIN_ID, 42)

  const summaryText = '## 交付说明\n- 重定向循环已修复\n- 新增 e2e 用例覆盖'
  const verificationText = '跑了 `pnpm test`，全部通过'
  const feedbackText = '请补充**回归测试**后再交卷'
  const briefText = '修复 issue 42 的登录重定向循环。'
  const task = makeTask({
    column: 'in_review',
    brief: briefText,
    submission: { summary: summaryText, verification: verificationText, branch: 'helmx/spawn-demo', submittedAt: 1_000 },
    lastReworkFeedback: feedbackText,
  })
  const live = deriveTaskLiveView(task, [], undefined, 'zh-CN')

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
          React.createElement(TaskDetailDrawer, {
            item: { task, live },
            tasksById: new Map([[task.id, task]]),
            inline: true,
            onClose: () => undefined,
            onRework: () => undefined,
            busy: false,
          }),
        ),
      ),
    )
  })
  t.after(() => {
    React.act(() => {
      root.unmount()
    })
    container.remove()
  })

  // 四个长文本字段（简报/交付 summary/验证说明/最近返工意见）全部经宿主 markdown 渲染
  for (const text of [briefText, summaryText, verificationText, feedbackText]) {
    assert.ok(rendered.includes(text), `长文本应经宿主 markdown.view 渲染：${text.slice(0, 12)}…`)
  }
  const drawerText = container.textContent ?? ''
  for (const text of [summaryText, verificationText, feedbackText]) {
    assert.ok(drawerText.includes(text), `交付/返工全文应可见（不被截断省略）：${text.slice(0, 12)}…`)
  }
  // 验证说明有独立标签；交付区块不再复用卡片式 line-clamp 摘要类
  assert.ok(drawerText.includes('验证说明'), '验证说明应有独立区块标签')
  const mdBlocks = Array.from(container.querySelectorAll('.task-detail-md, .task-detail-brief')).map((el) => el.textContent ?? '')
  assert.ok(mdBlocks.some((s) => s.includes(summaryText)), '交付 summary 应在 markdown 容器中')
  assert.ok(mdBlocks.some((s) => s.includes(verificationText)), '验证说明应在 markdown 容器中')
  assert.ok(mdBlocks.some((s) => s.includes(feedbackText)), '返工意见应在 markdown 容器中')
  assert.ok(container.querySelector('.task-detail-submission .task-card-submission-summary') === null, '抽屉交付区不得复用卡片 line-clamp 摘要类')
  assert.ok((container.querySelector('.task-detail-submission .mono')?.textContent ?? '') === 'helmx/spawn-demo', '分支事实行保留')
})
