import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, SidebarSectionSpec } from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import {
  buildSidebarGroups,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  filterConversationsByTag,
  fuzzyMatchConversations,
  partitionSidebarUi,
  selectHumanConversations,
} from '../src/shell/sidebar-model.js'
import { resolveTargetString } from '../src/lib/types.js'

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

/** superagent 插件声明的分组（后台 Worker + 可折叠已归档），标签值仅为测试数据。 */
const sidebarSections: Array<{ pluginId: string; spec: SidebarSectionSpec }> = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker', order: 20 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: {
      id: 'archived-workers',
      label: '已归档 Worker',
      icon: 'archive',
      filterTag: 'worker-archived',
      collapsible: true,
      defaultCollapsed: true,
      order: 30,
    },
  },
]

test('partitionSidebarUi 提取 profile / 会话 / section 标签去重规则', () => {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  assert.deepEqual([...partition.pinnedProfileIds].sort(), ['superagent', 'watchdog'])
  assert.deepEqual([...partition.pinnedConversationIds], [1])
  assert.deepEqual([...partition.sectionTags].sort(), ['worker', 'worker-archived'])
})

test('partitionSidebarUi 跳过 conversation:tag: 前缀目标', () => {
  const partition = partitionSidebarUi(
    [{ pluginId: 'p', spec: { id: 'x', label: 'X', target: 'conversation:tag:worker' } }],
    [],
  )
  assert.equal(partition.pinnedConversationIds.size, 0)
  assert.equal(partition.pinnedProfileIds.size, 0)
})

test('selectHumanConversations 排除根会话、常驻 profile 与全部 section 命中会话', () => {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  const mine = selectHumanConversations(conversations, partition)
  assert.deepEqual(mine.map((c) => c.id), [11, 10])
})

test('selectHumanConversations 无 UI 贡献时仅排除根会话', () => {
  const mine = selectHumanConversations(conversations, {
    pinnedProfileIds: new Set(),
    pinnedConversationIds: new Set(),
    sectionTags: new Set(),
  })
  // 无任何插件声明时其余会话都属人类列表（分组去重完全由 sidebar.section 声明驱动）
  assert.deepEqual(mine.map((c) => c.id), [30, 21, 20, 11, 10, 3, 2])
})

test('buildSidebarGroups 输出人类对话；归档分组由 sidebar.section 声明驱动', () => {
  const groups = buildSidebarGroups(conversations, sidebarItems, sidebarSections)
  assert.deepEqual(groups.humanConversations.map((c) => c.id), [11, 10])
  // 无归档 section 声明时不再有内置兜底：worker-archived 会话按声明缺失保留在人类列表
  const noArchive = buildSidebarGroups(
    [
      ...conversations,
      conv({ id: 31, title: 'Worker: 纯归档', profileId: 'coder', tags: ['worker-archived'] }),
    ],
    sidebarItems,
    [sidebarSections[0]!],
  )
  // 只声明 worker section 时，仅带 worker-archived 标签的 #31 不再被内置兑底排除
  assert.deepEqual(noArchive.humanConversations.map((c) => c.id), [31, 11, 10])
  // 声明归档 section 后重新被排除（分组去重完全由声明驱动）
  const withArchive = buildSidebarGroups(
    [
      ...conversations,
      conv({ id: 31, title: 'Worker: 纯归档', profileId: 'coder', tags: ['worker-archived'] }),
    ],
    sidebarItems,
    sidebarSections,
  )
  assert.deepEqual(withArchive.humanConversations.map((c) => c.id), [11, 10])
})

test('filterConversationsByTag 按 filterTag 过滤分组会话（含折叠归档分组）', () => {
  const workers = filterConversationsByTag(conversations, 'worker')
  assert.deepEqual(workers.map((c) => c.id), [20, 21, 30])
  const archived = filterConversationsByTag(conversations, 'worker-archived')
  assert.deepEqual(archived.map((c) => c.id), [30])
  const archiveSpec = sidebarSections[1]!.spec
  assert.equal(archiveSpec.collapsible, true)
  assert.equal(archiveSpec.defaultCollapsed, true)
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

test('resolveTargetString conversation:profile: 优先无父链常驻会话，不做标签硬编码', () => {
  const convs: ConversationSummary[] = [
    conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent' }),
    // 同 profile 的派生 Worker（有 parentConversationId），不应被常驻指向命中
    conv({ id: 20, title: 'Worker: 重构内核', profileId: 'superagent', tags: ['whatever'], parentConversationId: 2 }),
  ]
  assert.deepEqual(resolveTargetString('conversation:profile:superagent', convs), {
    kind: 'conversation',
    conversationId: 2,
  })

  // 只有派生会话时兜底取第一个（不返回 null）
  const onlyDerived = [convs[1]!]
  assert.deepEqual(resolveTargetString('conversation:profile:superagent', onlyDerived), {
    kind: 'conversation',
    conversationId: 20,
  })

  // 标签名不参与判定：无 worker 标签但有父链的会话同样不算常驻
  const noTagDerived = conv({ id: 21, profileId: 'superagent', parentConversationId: 2 })
  const residentLater = conv({ id: 22, profileId: 'superagent' })
  assert.deepEqual(
    resolveTargetString('conversation:profile:superagent', [noTagDerived, residentLater]),
    { kind: 'conversation', conversationId: 22 },
  )
})

test('ROOT_CONVERSATION_ID 从 @helm/protocol 导入且与根会话排除规则一致', () => {
  assert.equal(ROOT_CONVERSATION_ID, 1)
  const partition = { pinnedProfileIds: new Set<string>(), pinnedConversationIds: new Set<number>(), sectionTags: new Set<string>() }
  assert.deepEqual(
    selectHumanConversations([conv({ id: ROOT_CONVERSATION_ID })], partition).map((c) => c.id),
    [],
  )
})
