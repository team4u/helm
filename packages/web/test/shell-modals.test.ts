import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import {
  ARCHIVED_WORKER_TAG,
  buildSidebarGroups,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  filterConversationsByTag,
  fuzzyMatchConversations,
  partitionSidebarUi,
  selectHumanConversations,
} from '../src/shell/sidebar-model.js'

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const conversations: ConversationSummary[] = [
  conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
  conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent' }),
  conv({ id: 3, title: '巡检看门狗', profileId: 'watchdog' }),
  conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
  conv({ id: 11, title: '代码审查随手记', profileId: 'assistant' }),
  conv({ id: 20, title: 'Worker: 重构内核', profileId: 'coder', tags: ['worker'], status: 'working' }),
  conv({ id: 21, title: 'Worker: 修复测试', profileId: 'coder', tags: ['worker'], status: 'blocked' }),
  conv({ id: 30, title: 'Worker: 旧任务', profileId: 'coder', tags: ['worker', 'worker-archived'] }),
]

const sidebarItems = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'hub', label: 'SuperAgent 中枢', target: 'conversation:profile:superagent' },
  },
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'watchdog', label: '巡检看门狗', target: 'conversation:profile:watchdog' },
  },
  {
    pluginId: 'builtin:assistant',
    spec: { id: 'root', label: '个人助理', target: 'conversation:1' },
  },
]

const sidebarSections = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' },
  },
]

test('partitionSidebarUi 提取 profile / 会话 / section 标签去重规则', () => {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  assert.deepEqual([...partition.pinnedProfileIds].sort(), ['superagent', 'watchdog'])
  assert.deepEqual([...partition.pinnedConversationIds], [1])
  assert.deepEqual([...partition.sectionTags], ['worker'])
})

test('partitionSidebarUi 跳过 conversation:tag: 前缀目标', () => {
  const partition = partitionSidebarUi(
    [{ pluginId: 'p', spec: { id: 'x', label: 'X', target: 'conversation:tag:worker' } }],
    [],
  )
  assert.equal(partition.pinnedConversationIds.size, 0)
  assert.equal(partition.pinnedProfileIds.size, 0)
})

test('selectHumanConversations 排除 #1、常驻 profile、worker 与已归档会话', () => {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  const effective = { ...partition, sectionTags: new Set([...partition.sectionTags, ARCHIVED_WORKER_TAG]) }
  const mine = selectHumanConversations(conversations, effective)
  assert.deepEqual(mine.map((c) => c.id), [11, 10])
})

test('selectHumanConversations 无 UI 贡献时仅排除 #1 与归档 Worker（worker 活跃会话依赖 section 声明排除）', () => {
  const mine = selectHumanConversations(conversations, {
    pinnedProfileIds: new Set(),
    pinnedConversationIds: new Set(),
    sectionTags: new Set([ARCHIVED_WORKER_TAG]),
  })
  // superagent/watchdog 无 sidebar.item 指向时不被视为常驻；无 worker section 声明时活跃 worker 不被排除
  assert.deepEqual(mine.map((c) => c.id), [21, 20, 11, 10, 3, 2])
})

test('buildSidebarGroups 输出人类对话与已归档 Worker 分组', () => {
  const groups = buildSidebarGroups(conversations, sidebarItems, sidebarSections)
  assert.deepEqual(groups.humanConversations.map((c) => c.id), [11, 10])
  assert.deepEqual(groups.archivedWorkers.map((c) => c.id), [30])
})

test('buildSidebarGroups 在无插件声明归档 section 时也收纳 worker-archived', () => {
  const groups = buildSidebarGroups(conversations, sidebarItems, [])
  assert.deepEqual(groups.archivedWorkers.map((c) => c.id), [30])
  // 无 worker section 声明时活跃 worker 会话会落入人类列表，但归档 #30 始终被排除
  assert.deepEqual(groups.humanConversations.map((c) => c.id), [21, 20, 11, 10])
})

test('filterConversationsByTag 按 filterTag 过滤分组会话', () => {
  const workers = filterConversationsByTag(conversations, 'worker')
  assert.deepEqual(workers.map((c) => c.id), [20, 21, 30])
})

test('fuzzyMatchConversations 按标题、profileId 与纯数字 id 过滤', () => {
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '周末').map((c) => c.id),
    [10],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, 'coder').map((c) => c.id),
    [20, 21, 30],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '20').map((c) => c.id),
    [20],
  )
  assert.deepEqual(fuzzyMatchConversations(conversations, ''), [])
})

test('conversationStatusLabel / BadgeClass 覆盖五态', () => {
  assert.equal(conversationStatusLabel('working'), '运行中')
  assert.equal(conversationStatusLabel('blocked'), '待确认')
  assert.equal(conversationStatusLabel('done'), '已完成')
  assert.equal(conversationStatusLabel('idle'), '空闲')
  assert.equal(conversationStatusLabel('error'), '异常')
  assert.equal(conversationStatusBadgeClass('working'), 'badge badge-accent')
  assert.equal(conversationStatusBadgeClass('blocked'), 'badge badge-warn')
  assert.equal(conversationStatusBadgeClass('done'), 'badge badge-ok')
  assert.equal(conversationStatusBadgeClass('error'), 'badge badge-err')
  assert.equal(conversationStatusBadgeClass('idle'), 'badge badge-neutral')
})

test('selectHumanConversations 按 updatedAt 倒序排列', () => {
  const reversed: ConversationSummary[] = [...conversations].reverse()
  const mine = selectHumanConversations(reversed, {
    pinnedProfileIds: new Set(['superagent', 'watchdog']),
    pinnedConversationIds: new Set([1]),
    sectionTags: new Set(['worker', 'worker-archived']),
  })
  assert.deepEqual(mine.map((c) => c.id), [11, 10])
})
