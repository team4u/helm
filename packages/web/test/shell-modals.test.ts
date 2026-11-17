import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ConversationSummary,
  Profile,
  SidebarItemSpec,
  SidebarSectionSpec,
  SkillSummary,
} from '@helm/protocol'
import { resolveTargetString } from '../src/lib/types.js'
import {
  type AgentStanding,
  ARCHIVED_TAG,
  activeConversationIdsOf,
  activeProfileIdOf,
  activeProfileIdsOf,
  archiveConversationTags,
  buildAgentStandings,
  buildArchivedConversationList,
  collectEnabledPluginIds,
  conversationStatusBadgeClass,
  conversationStatusDotClass,
  conversationStatusLabel,
  conversationStatusTooltip,
  extractSidebarViews,
  filterAgentStandings,
  filterConversationsByTag,
  filterDeletableConversations,
  fuzzyMatchConversations,
  getAgentStandbyPresence,
  getConversationPresence,
  isAgentStandbyActive,
  isConversationActive,
  isConversationArchivable,
  isConversationArchived,
  isConversationDeletable,
  isHumanSelectableProfile,
  restoreConversationTags,
  isProfileVisible,
  isSkillVisible,
  partitionSidebarUi,
  resolveSidebarTargetPresence,
} from '../src/shell/sidebar-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore as makeHostTestStore, type TestStoreOverrides } from './helpers/store.js'
import type { HelmExternalStore } from '../src/lib/helm-store.js'


const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { Sidebar } = await import('../src/shell/Sidebar.js')

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
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
  conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent', ownedBy: 'helm' }),
  conv({ id: 3, title: '巡检看门狗', profileId: 'watchdog', ownedBy: 'helm' }),
  conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
  conv({ id: 11, title: '代码审查随手记', profileId: 'assistant' }),
  conv({ id: 20, title: 'Worker: 重构内核', profileId: 'coder', tags: ['worker'], ownedBy: 'bot', status: 'working' }),
  conv({ id: 21, title: 'Worker: 修复测试', profileId: 'coder', tags: ['worker'], ownedBy: 'bot', status: 'blocked' }),
  conv({ id: 30, title: 'Worker: 旧任务', profileId: 'coder', tags: ['worker', 'worker-archived'], ownedBy: 'bot' }),
  conv({ id: 40, title: '重构方案讨论', profileId: 'coder' }),
]

const sidebarItems: Array<{ pluginId: string; spec: SidebarItemSpec }> = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'hub', label: 'SuperAgent 中枢', icon: 'network', target: 'conversation:profile:superagent', order: 10 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'watchdog', label: '巡检看门狗', icon: 'shield', target: 'conversation:profile:watchdog', order: 11 },
  },
  {
    pluginId: 'builtin:profile',
    spec: { id: 'root', label: '个人助理', icon: 'sparkles', target: 'conversation:1', order: 0 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'recall', label: '记忆与订阅图谱', icon: 'git-fork', target: 'screen:builtin:superagent/recall-graph', order: 12 },
  },
  {
    pluginId: 'builtin:herdr',
    spec: { id: 'herdr', label: 'Herdr 终端', icon: 'terminal', target: 'screen:builtin:herdr/overview', order: 40 },
  },
]

/** superagent 插件声明的分组（后台 Worker + 可折叠归档）。 */
const sidebarSections: Array<{ pluginId: string; spec: SidebarSectionSpec }> = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker', order: 20 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: {
      id: 'archived-workers',
      label: 'Archived Worker',
      icon: 'archive',
      filterTag: 'worker-archived',
      collapsible: true,
      defaultCollapsed: true,
      order: 30,
    },
  },
]

const profiles: Profile[] = [
  { id: 'assistant', name: '个人助理' },
  { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent', humanSelectable: false },
  { id: 'watchdog', name: '巡检看门狗', managedByPlugin: 'builtin:superagent', humanSelectable: false },
  { id: 'coder', name: '编码专员' },
]

const plugins = [
  { id: 'builtin:profile', enabled: true },
  { id: 'builtin:superagent', enabled: true },
  { id: 'builtin:herdr', enabled: true },
]

function standingsInput(overrides?: Partial<Parameters<typeof buildAgentStandings>[0]>) {
  return {
    profiles,
    conversations,
    plugins,
    sidebarItems,
    sidebarSections,
    // 中文功能夹具均为纯字符串 LocalizedText：'en' 解析原样透传，断言不受 locale 影响。
    locale: 'en' as const,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Agent 站位：每个 Agent 一个固定站位 + 下挂各自历史对话
// ---------------------------------------------------------------------------

test('buildAgentStandings 生成独立的一级 Agent 站位（个人助理 / 中枢 / 看门狗 / 专家）', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.deepEqual(
    standings.map((s) => s.profileId),
    ['assistant', 'superagent', 'watchdog', 'coder'],
  )
  const assistant = standings[0]!
  assert.equal(assistant.label, '个人助理')
  assert.equal(assistant.order, 0)
  assert.equal(assistant.canCreateConversation, true)
  const hub = standings[1]!
  assert.equal(hub.label, 'SuperAgent 中枢')
  assert.equal(hub.canCreateConversation, false)
  const watchdog = standings[2]!
  assert.equal(watchdog.label, '巡检看门狗')
  assert.equal(watchdog.canCreateConversation, false)
  const coder = standings[3]!
  assert.equal(coder.label, '编码专员')
  assert.equal(coder.canCreateConversation, true)
})

test('buildAgentStandings：人类在 assistant 下新建的对话归集到其站位，#1 置顶其余倒序', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  const assistant = standings.find((s) => s.profileId === 'assistant')!
  assert.deepEqual(assistant.conversations.map((c) => c.id), [1, 11, 10])
  assert.equal(assistant.primaryConversation?.id, 1)
})

test('buildAgentStandings：中枢/看门狗常驻会话（ownedBy=helm）挂在各自单例站位下', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.deepEqual(
    standings.find((s) => s.profileId === 'superagent')!.conversations.map((c) => c.id),
    [2],
  )
  assert.deepEqual(
    standings.find((s) => s.profileId === 'watchdog')!.conversations.map((c) => c.id),
    [3],
  )
})

test('buildAgentStandings：canCreateConversation 由 isHumanSelectableProfile 决定', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  const byId = new Map(standings.map((s) => [s.profileId, s.canCreateConversation]))
  assert.equal(byId.get('assistant'), true)
  assert.equal(byId.get('coder'), true)
  assert.equal(byId.get('superagent'), false)
  assert.equal(byId.get('watchdog'), false)
})

test('buildAgentStandings：section filterTag 命中的后台会话不混入 Agent 日常对话列表', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  const coder = standings.find((s) => s.profileId === 'coder')!
  // #20/#21/#30 命中 worker/worker-archived 分组：由 SidebarSectionGroups 展示，
  // 不重复挂在 coder 站位下；仅人类自由会话 #40 挂载。
  assert.deepEqual(coder.conversations.map((c) => c.id), [40])
})

test('buildAgentStandings：screen: 类型 sidebar.item 不混入 Agent 站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.equal(standings.some((s) => s.label === '记忆与订阅图谱'), false)
  assert.equal(standings.some((s) => s.label === 'Herdr 终端'), false)
})

test('buildAgentStandings：插件停用后其 managedByPlugin 站位与 ownedBy=helm/bot 会话自动隐藏', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      plugins: [
        { id: 'builtin:profile', enabled: true },
        { id: 'builtin:herdr', enabled: true },
      ],
      sidebarItems: [sidebarItems[2]!],
      sidebarSections: [],
    }),
  )
  // superagent 停用：中枢/看门狗 Profile 不可见 -> 站位消失，其 ownedBy=helm 常驻会话与
  // ownedBy=bot 的 Worker 会话也不泄露；assistant/coder 保留。
  assert.deepEqual(
    standings.map((s) => s.profileId),
    ['assistant', 'coder'],
  )
  assert.equal(standings.some((s) => s.conversations.some((c) => c.id === 2 || c.id === 3)), false)
  assert.equal(standings.some((s) => s.conversations.some((c) => c.tags.includes('worker'))), false)
})

test('buildAgentStandings：Profile 已删的人类历史对话生成孤儿兜底站位，绝不丢失', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      conversations: [
        conv({ id: 1, profileId: 'assistant' }),
        conv({ id: 70, title: '旧专家话题', profileId: 'deleted-expert' }),
      ],
      sidebarItems: [sidebarItems[2]!],
      sidebarSections: [],
    }),
  )
  const orphan = standings.find((s) => s.profileId === 'deleted-expert')!
  assert.equal(orphan.label, 'deleted-expert')
  assert.equal(orphan.order, 200)
  assert.equal(orphan.canCreateConversation, false)
  assert.deepEqual(orphan.conversations.map((c) => c.id), [70])
  assert.equal(orphan.primaryConversation?.id, 70)
})

test('buildAgentStandings：资产未加载时按真实会话的 profileId 展示，不编造默认 Profile', { timeout: 60_000 }, () => {
  const input = { profiles: [], plugins: [], sidebarItems: [], sidebarSections: [], locale: 'en' as const }
  const standings = buildAgentStandings({
    ...input,
    conversations: [conv({ id: 80, profileId: 'loading-profile' })],
  })
  assert.equal(standings.length, 1)
  assert.equal(standings[0]!.profileId, 'loading-profile')
  assert.equal(standings[0]!.label, 'loading-profile')
  assert.equal(standings[0]!.canCreateConversation, false)
  assert.equal(standings[0]!.primaryConversation?.id, 80)
  assert.deepEqual(buildAgentStandings({ ...input, conversations: [] }), [])
})

test('buildAgentStandings：assistant 站位排序由 sidebar.item pinMeta 驱动（order:0）', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [],
    conversations: [conv({ id: 1, title: '个人助理', profileId: 'assistant' })],
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:profile', spec: { id: 'root', label: '个人助理', icon: 'sparkles', target: 'conversation:1', order: 0 } },
    ],
    sidebarSections: [],
  })
  assert.equal(standings[0]!.label, '个人助理')
  assert.equal(standings[0]!.order, 0)
  // 站位行不渲染图标：声明式 icon 仅对 screen 视图项生效，智能体行不再消费。
  assert.equal('icon' in standings[0]!, false)
})

test('buildAgentStandings：子代理派生会话（有父链）不挂 Agent 站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      conversations: [
        conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent', ownedBy: 'helm' }),
        conv({ id: 21, profileId: 'superagent', parentConversationId: 2, tags: ['worker'], ownedBy: 'bot' }),
        conv({ id: 22, profileId: 'assistant', parentConversationId: 1 }),
      ],
      sidebarItems: [sidebarItems[0]!, sidebarItems[2]!],
      sidebarSections: [sidebarSections[0]!],
    }),
  )
  const hub = standings.find((s) => s.profileId === 'superagent')!
  assert.deepEqual(hub.conversations.map((c) => c.id), [2])
  const assistant = standings.find((s) => s.profileId === 'assistant')!
  assert.equal(assistant.conversations.some((c) => c.id === 22), false)
})

test('人工归档 tags 幂等保留其他标签，恢复只移除 archived', { timeout: 60_000 }, () => {
  const tags = ['important', 'worker-note']
  assert.equal(ARCHIVED_TAG, 'helm:archived')
  assert.deepEqual(archiveConversationTags(tags), [...tags, ARCHIVED_TAG])
  assert.deepEqual(archiveConversationTags([...tags, ARCHIVED_TAG]), [...tags, ARCHIVED_TAG])
  assert.deepEqual(restoreConversationTags([...tags, ARCHIVED_TAG, ARCHIVED_TAG]), tags)
  assert.equal(isConversationArchived(conv({ id: 1, tags: [ARCHIVED_TAG] })), true)
  assert.equal(isConversationArchivable(conv({ id: 1 }), new Set()), true)
  assert.equal(isConversationArchivable(conv({ id: 2, parentConversationId: 1 }), new Set()), false)
  assert.equal(isConversationArchivable(conv({ id: 3, ownedBy: 'bot' }), new Set()), false)
  assert.equal(isConversationArchivable(conv({ id: 4, tags: ['worker'] }), new Set(['worker'])), false)
})

test('buildArchivedConversationList 只展示人类根会话并按创建时间稳定排序', { timeout: 60_000 }, () => {
  const archived = [
    conv({ id: 1, profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 100 }),
    conv({ id: 2, profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 300 }),
    conv({ id: 3, profileId: 'assistant', tags: [ARCHIVED_TAG], parentConversationId: 1 }),
    conv({ id: 4, profileId: 'assistant', tags: [ARCHIVED_TAG], ownedBy: 'bot' }),
    conv({ id: 5, profileId: 'assistant', tags: [ARCHIVED_TAG, 'worker'] }),
    conv({ id: 6, profileId: 'assistant' }),
  ]
  const items = buildArchivedConversationList({
    conversations: archived,
    profiles: [{ id: 'assistant', name: '个人助理' }],
    sidebarSections: [{ pluginId: 'plugin', spec: { id: 'workers', label: 'Worker', filterTag: 'worker' } }],
  })
  assert.deepEqual(items.map((item) => item.conv.id), [2, 1])
  assert.equal(items[0]?.profileLabel, '个人助理')
  assert.equal(buildAgentStandings({
    locale: 'en',
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: archived,
    plugins: [],
    sidebarSections: [],
  })[0]?.conversations.some((item) => item.id === 1), false)
})

test('buildAgentStandings：按 createdAt 倒序（updatedAt 推进不重排）；被 sidebar.item 指向的会话置顶', { timeout: 60_000 }, () => {
  const sameTime: ConversationSummary[] = [
    conv({ id: 1, profileId: 'assistant' }),
    conv({ id: 10, profileId: 'assistant', createdAt: 5000, updatedAt: 5000 }),
    // #11 模拟 AI 正在输出：updatedAt 远大于创建时间，但位置仍由 createdAt 决定
    conv({ id: 11, profileId: 'assistant', createdAt: 5000, updatedAt: 99999 }),
  ]
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: sameTime,
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:profile', spec: { id: 'pin-10', label: '置顶话题', target: 'conversation:10' } },
    ],
    sidebarSections: [],
  })
  // #10 被 sidebar.item 指向置顶 -> 其余（含 #1）按 createdAt 倒序、同刻按 id 倒序（无根会话特判）
  assert.deepEqual(standings[0]!.conversations.map((c) => c.id), [10, 11, 1])
})

// ---------------------------------------------------------------------------
// 视图分流：extractSidebarViews
// ---------------------------------------------------------------------------

test('extractSidebarViews 提取 screen: 导航项并按 order 排序，不混入 Agent 站位', { timeout: 60_000 }, () => {
  const views = extractSidebarViews(sidebarItems, conversations, 'en')
  assert.deepEqual(
    views.map((v) => v.key),
    ['builtin:superagent/recall', 'builtin:herdr/herdr'],
  )
  const recall = views[0]!
  assert.equal(recall.label, '记忆与订阅图谱')
  assert.equal(recall.icon, 'git-fork')
  assert.equal(recall.order, 12)
  assert.deepEqual(recall.target, { kind: 'screen', pluginId: 'builtin:superagent', screenId: 'recall-graph' })
  const herdr = views[1]!
  assert.deepEqual(herdr.target, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
})

test('extractSidebarViews：无 icon 的视图项兜底 panel-right 图标', { timeout: 60_000 }, () => {
  const views = extractSidebarViews(
    [{ pluginId: 'p', spec: { id: 'x', label: 'X', target: 'screen:p/home' } }],
    [],
    'en',
  )
  assert.equal(views[0]!.icon, 'panel-right')
})

test('LocalizedText 侧栏显示名：站位 pin label 与视图 label 均按 locale 解析', { timeout: 60_000 }, () => {
  const items = [
    // 会话指向型 sidebar.item：pin label 覆盖站位默认展示名（LocalizedText 地图）
    {
      pluginId: 'builtin:profile',
      spec: { id: 'root', label: { en: 'Assistant', 'zh-CN': '个人助理' }, target: 'conversation:1', order: 0 },
    },
    // screen: 视图项 label（LocalizedText 地图）
    {
      pluginId: 'builtin:superagent',
      spec: { id: 'recall', label: { en: 'Recall graph', 'zh-CN': '召回图谱' }, target: 'screen:builtin:superagent/recall-graph' },
    },
    // 纯字符串 label（向后兼容）任意 locale 原样
    { pluginId: 'builtin:herdr', spec: { id: 'herdr', label: 'Herdr 终端', target: 'screen:builtin:herdr/overview' } },
  ]
  const conversations = [conv({ id: 1, title: '根会话', profileId: 'assistant' })]
  const zhStandings = buildAgentStandings({
    ...standingsInput({ conversations, sidebarItems: items }),
    locale: 'zh-CN',
  })
  assert.equal(zhStandings.find((s) => s.profileId === 'assistant')?.label, '个人助理')
  const enStandings = buildAgentStandings({
    ...standingsInput({ conversations, sidebarItems: items }),
    locale: 'en',
  })
  assert.equal(enStandings.find((s) => s.profileId === 'assistant')?.label, 'Assistant')

  const zhViews = extractSidebarViews(items, conversations, 'zh-CN')
  assert.equal(zhViews.find((v) => v.key === 'builtin:superagent/recall')?.label, '召回图谱')
  assert.equal(zhViews.find((v) => v.key === 'builtin:herdr/herdr')?.label, 'Herdr 终端')
  const enViews = extractSidebarViews(items, conversations, 'en')
  assert.equal(enViews.find((v) => v.key === 'builtin:superagent/recall')?.label, 'Recall graph')
})

test('partitionSidebarUi 提取 profile / 会话 / section 标签去重规则', { timeout: 60_000 }, () => {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  assert.deepEqual([...partition.pinnedProfileIds].sort(), ['superagent', 'watchdog'])
  assert.deepEqual([...partition.pinnedConversationIds], [1])
  assert.deepEqual([...partition.sectionTags].sort(), ['worker', 'worker-archived'])
})

test('partitionSidebarUi 跳过 conversation:tag: 前缀目标', { timeout: 60_000 }, () => {
  const partition = partitionSidebarUi(
    [{ pluginId: 'p', spec: { id: 'x', label: 'X', target: 'conversation:tag:worker' } }],
    [],
  )
  assert.equal(partition.pinnedConversationIds.size, 0)
  assert.equal(partition.pinnedProfileIds.size, 0)
})

test('filterConversationsByTag 按 filterTag 过滤分组会话（含折叠归档分组）', { timeout: 60_000 }, () => {
  const workers = filterConversationsByTag(conversations, 'worker')
  assert.deepEqual(workers.map((c) => c.id), [20, 21, 30])
  const archived = filterConversationsByTag(conversations, 'worker-archived')
  assert.deepEqual(archived.map((c) => c.id), [30])
  const archiveSpec = sidebarSections[1]!.spec
  assert.equal(archiveSpec.collapsible, true)
  assert.equal(archiveSpec.defaultCollapsed, true)
})

test('fuzzyMatchConversations 按标题、profileId 与纯数字 id 过滤', { timeout: 60_000 }, () => {
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '周末').map((c) => c.id),
    [10],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, 'coder').map((c) => c.id),
    [20, 21, 30, 40],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '20').map((c) => c.id),
    [20],
  )
  assert.deepEqual(fuzzyMatchConversations(conversations, ''), [])
})

test('conversationStatusLabel / BadgeClass 覆盖五态', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusLabel('working'), 'Running')
  assert.equal(conversationStatusLabel('blocked'), 'Awaiting confirmation')
  assert.equal(conversationStatusLabel('done'), 'Completed')
  assert.equal(conversationStatusLabel('idle'), 'Idle')
  assert.equal(conversationStatusLabel('error'), 'Error')
  assert.equal(conversationStatusBadgeClass('working'), 'badge badge-accent')
  assert.equal(conversationStatusBadgeClass('blocked'), 'badge badge-warn')
  assert.equal(conversationStatusBadgeClass('done'), 'badge badge-ok')
  assert.equal(conversationStatusBadgeClass('error'), 'badge badge-err')
  assert.equal(conversationStatusBadgeClass('idle'), 'badge badge-neutral')
})

test('conversationStatusDotClass 仅对非 idle 状态返回圆点类名', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusDotClass('idle'), null)
  assert.equal(conversationStatusDotClass('working'), 'status-dot status-dot-working')
  assert.equal(conversationStatusDotClass('blocked'), 'status-dot status-dot-blocked')
  assert.equal(conversationStatusDotClass('done'), 'status-dot status-dot-done')
  assert.equal(conversationStatusDotClass('error'), 'status-dot status-dot-error')
})

test('conversationStatusTooltip 生成准确悬停提示', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusTooltip('idle'), 'Idle')
  assert.equal(conversationStatusTooltip('blocked'), 'Awaiting confirmation')
  assert.equal(conversationStatusTooltip('done'), 'Completed')
  assert.equal(conversationStatusTooltip('error'), 'Error')
  assert.equal(conversationStatusTooltip('working'), 'Running')
  assert.equal(conversationStatusTooltip('working', '正在分析代码'), 'Running: 正在分析代码')
})

test('resolveTargetString conversation:profile: 优先无父链常驻会话，不做标签硬编码', { timeout: 60_000 }, () => {
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



// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

test('isProfileVisible：仅依据 managedByPlugin 字段过滤（不按 id 猜归属），任意插件 id 同样生效', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:profile'])
  const plain: Profile = { id: 'coder', name: '编码' }
  // 无字段的同名 Profile 不猜隐藏（用户自建同 id 资产）
  const hubNoMeta: Profile = { id: 'superagent', name: 'SuperAgent 中枢' }
  const managed = new Set<string>(['builtin:profile', 'builtin:superagent'])
  const hubManaged: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent' }
  // 任意第三方插件的托管资产同样按字段过滤（验证不依赖特定插件 id）
  const thirdParty: Profile = { id: 'custom-x', managedByPlugin: 'community:reporter' }
  const herdrManaged: Profile = { id: 'herdr-tool', managedByPlugin: 'builtin:herdr' }
  assert.equal(isProfileVisible(plain, disabled), true)
  assert.equal(isProfileVisible(hubNoMeta, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isProfileVisible(hubManaged, disabled), false)
  assert.equal(isProfileVisible(thirdParty, disabled), false)
  assert.equal(isProfileVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'builtin:herdr', 'community:reporter'])
  assert.equal(isProfileVisible(hubManaged, enabled), true)
  assert.equal(isProfileVisible(thirdParty, enabled), true)
  assert.equal(isProfileVisible(herdrManaged, enabled), true)
})

test('isHumanSelectableProfile：仅依据通用 humanSelectable 字段排除常驻单例，其他插件专家 Profile 可选', { timeout: 60_000 }, () => {
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'community:reporter'])
  const assistant: Profile = { id: 'assistant', name: '个人助理' }
  // 常驻单例：插件显式声明 humanSelectable=false
  const hub: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent', humanSelectable: false }
  const watchdog: Profile = { id: 'watchdog', name: '巡检看门狗', managedByPlugin: 'builtin:superagent', humanSelectable: false }
  // 其他插件提供的专家 Profile：受管但未置 humanSelectable，人类可选（缺省 true）
  const pluginExpert: Profile = { id: 'reporter', name: '周报专员', managedByPlugin: 'community:reporter' }
  const pluginSingleton: Profile = { id: 'night-hub', name: '夜间中枢', managedByPlugin: 'community:reporter', humanSelectable: false }
  // 用户自建同名资产（无字段）：不猜隐藏，可选
  const userHubNamed: Profile = { id: 'superagent', name: '我的自定义角色' }
  const disabled = new Set<string>(['builtin:profile'])
  assert.equal(isHumanSelectableProfile(assistant, enabled), true)
  assert.equal(isHumanSelectableProfile(hub, enabled), false)
  assert.equal(isHumanSelectableProfile(watchdog, enabled), false)
  assert.equal(isHumanSelectableProfile(pluginExpert, enabled), true, '插件专家 Profile 缺省可选')
  assert.equal(isHumanSelectableProfile(pluginSingleton, enabled), false, '任意插件单例同样被通用字段排除')
  assert.equal(isHumanSelectableProfile(userHubNamed, enabled), true, '用户自建同名资产不按 id 猜隐藏')
  assert.equal(isHumanSelectableProfile(hub, disabled), false, '不可见优先于可选')
})

test('isSkillVisible：仅依据 managedByPlugin 字段过滤（任意插件 id），不按 skill id 猜', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:profile'])
  const plain: SkillSummary = { id: 'weekly-report', name: '周报', references: [] }
  // 无字段同名 skill 不猜隐藏（用户自建）
  const legacy: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [] }
  const managed = new Set<string>(['builtin:profile', 'builtin:superagent'])
  const managedPlaybooks: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [], managedByPlugin: 'builtin:superagent' }
  const herdrManaged: SkillSummary = { id: 'herdr-flow', name: 'Herdr 流程', references: [], managedByPlugin: 'builtin:herdr' }
  assert.equal(isSkillVisible(plain, disabled), true)
  assert.equal(isSkillVisible(legacy, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isSkillVisible(managedPlaybooks, disabled), false)
  assert.equal(isSkillVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'builtin:herdr'])
  assert.equal(isSkillVisible(managedPlaybooks, enabled), true)
  assert.equal(isSkillVisible(herdrManaged, enabled), true)
})

test('collectEnabledPluginIds 仅收集启用插件', { timeout: 60_000 }, () => {
  const ids = collectEnabledPluginIds([
    { id: 'builtin:profile', enabled: true },
    { id: 'builtin:herdr', enabled: false },
    { id: 'builtin:superagent', enabled: true },
  ])
  assert.deepEqual([...ids].sort(), ['builtin:profile', 'builtin:superagent'])
})

// ---------------------------------------------------------------------------
// 会话可删除性判断：isConversationDeletable & filterDeletableConversations
// ---------------------------------------------------------------------------

test('isConversationDeletable 正确判定会话是否允许人类删除', { timeout: 60_000 }, () => {
  // 初始会话（#1）无 id 级豁免：与普通人类会话同样可删
  assert.equal(isConversationDeletable({ id: 1 }), true)
  assert.equal(isConversationDeletable({ id: 1, ownedBy: 'human' }), true)

  // 机器/插件托管会话禁止删除
  assert.equal(isConversationDeletable({ id: 2, ownedBy: 'bot' }), false)
  assert.equal(isConversationDeletable({ id: 3, ownedBy: 'helm' }), false)

  // 普通人类会话（无 ownedBy 或 ownedBy === 'human'）允许删除
  assert.equal(isConversationDeletable({ id: 10 }), true)
  assert.equal(isConversationDeletable({ id: 11, ownedBy: 'human' }), true)
})

test('filterDeletableConversations 过滤出可删除会话', { timeout: 60_000 }, () => {
  const sample = [
    conv({ id: 1, title: '初始会话' }), // 无 id 级豁免 -> true
    conv({ id: 2, title: '中枢', ownedBy: 'helm' }), // ownedBy: 'helm' -> false
    conv({ id: 20, title: 'Worker', ownedBy: 'bot' }), // ownedBy: 'bot' -> false
    conv({ id: 10, title: '人类会话1' }), // true
    conv({ id: 11, title: '人类会话2', ownedBy: 'human' }), // true
  ]

  const deletable = filterDeletableConversations(sample)
  assert.deepEqual(
    deletable.map((c) => c.id),
    [1, 10, 11],
  )
})

// ---------------------------------------------------------------------------
// 侧栏深度过滤与分屏在场/焦点推导纯函数
// ---------------------------------------------------------------------------

test('filterAgentStandings 深度过滤：命中 Agent 自身保留全部话题，命中会话或 #id 仅保留命中会话', { timeout: 60_000 }, () => {
  const richStandings = buildAgentStandings(
    standingsInput({
      conversations: [
        ...conversations,
        conv({ id: 41, title: '测试补全', profileId: 'coder' }),
      ],
    }),
  )
  // 空 query 原样返回
  assert.equal(filterAgentStandings(richStandings, ''), richStandings)
  assert.equal(filterAgentStandings(richStandings, '  '), richStandings)

  // label 命中（'中枢'）
  assert.deepEqual(
    filterAgentStandings(richStandings, '中枢').map((s) => s.profileId),
    ['superagent'],
  )

  // 命中智能体自身 label（'个人助理'）时保留名下完整 conversations（含未包含该词的 #11、#10）
  const assistantByLabel = filterAgentStandings(richStandings, '个人助理')
  assert.deepEqual(assistantByLabel.map((s) => s.profileId), ['assistant'])
  assert.deepEqual(assistantByLabel[0]!.conversations.map((c) => c.id), [1, 11, 10])

  // profileId 命中（'coder'）时保留名下完整 conversations
  const coderByProfile = filterAgentStandings(richStandings, 'coder')
  assert.deepEqual(coderByProfile.map((s) => s.profileId), ['coder'])
  assert.deepEqual(coderByProfile[0]!.conversations.map((c) => c.id), [41, 40])

  // 仅命中会话标题（'周末计划'）时：AgentStanding.conversations 仅含命中的会话，不保留同组其他会话
  const byTitle = filterAgentStandings(richStandings, '周末计划')
  assert.deepEqual(byTitle.map((s) => s.profileId), ['assistant'])
  assert.deepEqual(byTitle[0]!.conversations.map((c) => c.id), [10])

  // 纯数字 id 与 #id 井号匹配均仅保留命中的具体会话（#40 不带出 #41）
  for (const query of ['40', '#40']) {
    const byId = filterAgentStandings(richStandings, query)
    assert.deepEqual(byId.map((s) => s.profileId), ['coder'])
    assert.deepEqual(byId[0]!.conversations.map((c) => c.id), [40])
  }

  // 确认未原地篡改输入 standings 的 conversations
  assert.deepEqual(
    richStandings.find((s) => s.profileId === 'coder')!.conversations.map((c) => c.id),
    [41, 40],
  )

  // 无命中返回空
  assert.equal(filterAgentStandings(richStandings, '不存在的关键词').length, 0)
})

test('resolveSidebarTargetPresence / getConversationPresence / getAgentStandbyPresence 覆盖单屏、分屏双开、焦点切换与同目标双开', { timeout: 60_000 }, () => {
  // 1) 单屏模式（splitTarget === null）
  const singleStore = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: null,
    focusedPanel: 'primary' as const,
  }
  assert.deepEqual(getConversationPresence(singleStore, 1), {
    inPrimary: true,
    inSplit: false,
    active: true,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })
  assert.equal(isConversationActive(singleStore, 1), true)
  assert.deepEqual(getConversationPresence(singleStore, 10), {
    inPrimary: false,
    inSplit: false,
    active: false,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })
  assert.equal(isConversationActive(singleStore, 10), false)

  const singleStandbyStore = {
    primaryTarget: { kind: 'agent' as const, profileId: 'assistant' },
    splitTarget: null,
    focusedPanel: 'primary' as const,
  }
  assert.deepEqual(getAgentStandbyPresence(singleStandbyStore, 'assistant'), {
    inPrimary: true,
    inSplit: false,
    active: true,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })
  assert.equal(isAgentStandbyActive(singleStandbyStore, 'assistant'), true)

  // 2) 分屏双开不同会话（focusedPanel 缺省兜底 primary -> 再切换至 split）
  const splitPrimaryFocus = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'conversation' as const, conversationId: 10 },
    focusedPanel: 'primary' as const,
  }
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 1), {
    inPrimary: true,
    inSplit: false,
    active: true,
    splitSecondary: false,
    focused: true,
    paneTag: 'Main',
  })
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 10), {
    inPrimary: false,
    inSplit: true,
    active: false,
    splitSecondary: true,
    focused: false,
    paneTag: 'Split',
  })
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 99), {
    inPrimary: false,
    inSplit: false,
    active: false,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })
  assert.equal(isConversationActive(splitPrimaryFocus, 1), true)
  assert.equal(isConversationActive(splitPrimaryFocus, 10), false)

  const splitSecondaryFocus = {
    ...splitPrimaryFocus,
    focusedPanel: 'split' as const,
  }
  assert.deepEqual(getConversationPresence(splitSecondaryFocus, 1), {
    inPrimary: true,
    inSplit: false,
    active: false,
    splitSecondary: true,
    focused: false,
    paneTag: 'Main',
  })
  assert.deepEqual(getConversationPresence(splitSecondaryFocus, 10), {
    inPrimary: false,
    inSplit: true,
    active: true,
    splitSecondary: false,
    focused: true,
    paneTag: 'Split',
  })
  assert.equal(isConversationActive(splitSecondaryFocus, 1), false)
  assert.equal(isConversationActive(splitSecondaryFocus, 10), true)

  // 3) 同目标双开：主屏与分屏均为同一会话或同一待命页 -> paneTag 为 '主·分'，两焦点下均 active+focused
  for (const focusedPanel of ['primary', 'split'] as const) {
    const sameConvStore = {
      primaryTarget: { kind: 'conversation' as const, conversationId: 10 },
      splitTarget: { kind: 'conversation' as const, conversationId: 10 },
      focusedPanel,
    }
    assert.deepEqual(getConversationPresence(sameConvStore, 10), {
      inPrimary: true,
      inSplit: true,
      active: true,
      splitSecondary: false,
      focused: true,
      paneTag: 'Main·Split',
    })

    const sameAgentStore = {
      primaryTarget: { kind: 'agent' as const, profileId: 'coder' },
      splitTarget: { kind: 'agent' as const, profileId: 'coder' },
      focusedPanel,
    }
    assert.deepEqual(getAgentStandbyPresence(sameAgentStore, 'coder'), {
      inPrimary: true,
      inSplit: true,
      active: true,
      splitSecondary: false,
      focused: true,
      paneTag: 'Main·Split',
    })
  }

  // 4) 混合分屏：主屏会话 + 分屏待命页，自定义 matches 验证 resolveSidebarTargetPresence
  const mixedSplitStore = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'agent' as const, profileId: 'coder' },
    focusedPanel: 'split' as const,
  }
  assert.deepEqual(getAgentStandbyPresence(mixedSplitStore, 'coder'), {
    inPrimary: false,
    inSplit: true,
    active: true,
    splitSecondary: false,
    focused: true,
    paneTag: 'Split',
  })
  assert.equal(isAgentStandbyActive(mixedSplitStore, 'coder'), true)
  assert.deepEqual(
    resolveSidebarTargetPresence(mixedSplitStore, (t) => t.kind === 'conversation' && t.conversationId === 1),
    {
      inPrimary: true,
      inSplit: false,
      active: false,
      splitSecondary: true,
      focused: false,
      paneTag: 'Main',
    },
  )
})

test('activeProfileIdsOf / activeProfileIdOf / activeConversationIdsOf 收集主分屏活跃目标与主屏优先序', { timeout: 60_000 }, () => {
  const sampleConvs = [
    conv({ id: 1, profileId: 'assistant' }),
    conv({ id: 10, profileId: 'assistant' }),
    conv({ id: 40, profileId: 'coder' }),
  ]

  // 单屏会话
  const singleConv = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: null,
    conversations: sampleConvs,
  }
  assert.deepEqual(Array.from(activeProfileIdsOf(singleConv)), ['assistant'])
  assert.equal(activeProfileIdOf(singleConv), 'assistant')
  assert.deepEqual(Array.from(activeConversationIdsOf(singleConv)), [1])

  // 非智能体/会话目标（如 models）
  const centerOnly = {
    primaryTarget: { kind: 'models' as const },
    splitTarget: null,
    conversations: sampleConvs,
  }
  assert.equal(activeProfileIdsOf(centerOnly).size, 0)
  assert.equal(activeProfileIdOf(centerOnly), null)
  assert.equal(activeConversationIdsOf(centerOnly).size, 0)

  // 分屏双开不同智能体（主屏 assistant 会话 + 分屏 coder 会话）：主屏优先插序
  const splitDifferent = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'conversation' as const, conversationId: 40 },
    conversations: sampleConvs,
  }
  assert.deepEqual(Array.from(activeProfileIdsOf(splitDifferent)), ['assistant', 'coder'])
  assert.equal(activeProfileIdOf(splitDifferent), 'assistant')
  assert.deepEqual(Array.from(activeConversationIdsOf(splitDifferent)), [1, 40])

  // 分屏主屏会话 + 分屏待命页：profileId 主屏优先，conversationIds 仅含主屏会话
  const splitWithStandby = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 40 },
    splitTarget: { kind: 'agent' as const, profileId: 'assistant' },
    conversations: sampleConvs,
  }
  assert.deepEqual(Array.from(activeProfileIdsOf(splitWithStandby)), ['coder', 'assistant'])
  assert.equal(activeProfileIdOf(splitWithStandby), 'coder')
  assert.deepEqual(Array.from(activeConversationIdsOf(splitWithStandby)), [40])

  // 分屏同智能体两会话：profileId 自动去重，conversationIds 均保留
  const splitSameProfile = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'conversation' as const, conversationId: 10 },
    conversations: sampleConvs,
  }
  assert.deepEqual(Array.from(activeProfileIdsOf(splitSameProfile)), ['assistant'])
  assert.equal(activeProfileIdOf(splitSameProfile), 'assistant')
  assert.deepEqual(Array.from(activeConversationIdsOf(splitSameProfile)), [1, 10])

  // 主屏会话未解析时兜底取分屏 profileId
  const primaryUnresolved = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 999 },
    splitTarget: { kind: 'agent' as const, profileId: 'coder' },
    conversations: sampleConvs,
  }
  assert.deepEqual(Array.from(activeProfileIdsOf(primaryUnresolved)), ['coder'])
  assert.equal(activeProfileIdOf(primaryUnresolved), 'coder')
  assert.deepEqual(Array.from(activeConversationIdsOf(primaryUnresolved)), [999])
})

// ---------------------------------------------------------------------------
// 侧边栏批量管理与批量删除逻辑
// ---------------------------------------------------------------------------

/** 批量管理用宿主 store（真实 external store；沿用本文件历史默认数据）。 */
function makeTestStore(partial: TestStoreOverrides = {}): HelmExternalStore {
  return makeHostTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 10, title: '用户会话1', profileId: 'assistant' }),
      conv({ id: 11, title: '用户会话2', profileId: 'assistant' }),
    ],
    plugins: [{ id: 'builtin:profile', name: '个人助理', locked: true, enabled: true, hooks: [], actions: [], tools: [] }],
    profiles: [{ id: 'assistant', name: '个人助理' }],
    models: [
      {
        id: 'zhipu/glm-4.6',
        provider: 'zhipu',
        modelId: 'glm-4.6',
        available: true,
        thinkingLevels: ['off', 'low', 'high'],
      },
    ],
    ...partial,
  })
}

test('批量选择状态计算：全选、反选与单选切换', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '代码助手' },
    ],
    conversations: [
      conv({ id: 1, title: '根会话', profileId: 'assistant' }),
      conv({ id: 10, title: '会话 10', profileId: 'assistant' }),
      conv({ id: 11, title: '会话 11', profileId: 'assistant' }),
      conv({ id: 20, title: 'Worker', profileId: 'coder', ownedBy: 'bot' }),
      conv({ id: 21, title: '系统中枢', profileId: 'coder', ownedBy: 'helm' }),
      conv({ id: 22, title: '会话 22', profileId: 'coder' }),
    ],
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [],
    sidebarSections: [],
  })

  // 提取所有智能体站位下的可删除会话
  const allConvs = standings.flatMap((a) => a.conversations)
  const allDeletableIds = filterDeletableConversations(allConvs).map((c) => c.id)

  // 应该包含 1, 10, 11, 22（初始会话无豁免；排除 bot 和 helm 拥有的会话）
  assert.deepEqual(allDeletableIds.sort((a, b) => a - b), [1, 10, 11, 22])

  let selectedIds = new Set<number>()
  const isAllSelected = (ids: Set<number>) =>
    allDeletableIds.length > 0 && allDeletableIds.every((id) => ids.has(id))

  // 初始为空
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 0)

  // 单选 10
  selectedIds = new Set(selectedIds).add(10)
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 1)

  // 全选
  selectedIds = new Set(allDeletableIds)
  assert.equal(isAllSelected(selectedIds), true)
  assert.equal(selectedIds.size, 4)

  // 清空
  selectedIds = new Set()
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 0)
})

test('批量删除导航契约：Sidebar 不做二次导航，回退统一由 Provider 删除管道负责', { timeout: 60_000 }, () => {
  // Sidebar 拆分后源码断言拼接主文件与拆出的子模块（断言本身不变）。
  const sidebarSource = [
    '../src/shell/Sidebar.tsx',
    '../src/shell/SidebarAgentStandings.tsx',
    '../src/shell/SidebarPrimitives.tsx',
  ]
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join('\n')
  const batchStart = sidebarSource.indexOf('const executeBatchDelete')
  const batchEnd = sidebarSource.indexOf('return (', batchStart)
  assert.ok(batchStart > 0 && batchEnd > batchStart, 'executeBatchDelete 存在')
  const batchBody = sidebarSource.slice(batchStart, batchEnd)
  // 删除导航唯一 truth：成功 SSE conversation.deleted 事件 → Provider 按当前目标条件回退；
  // Sidebar 不再基于旧快照/selectedIds 二次跳转（旧实现会连失败项一起跳走）。
  assert.doesNotMatch(batchBody, /openTarget/, '批量删除不得在 Sidebar 内导航')
  assert.doesNotMatch(batchBody, /closeSplit/, '批量删除不得在 Sidebar 内关分屏')
  assert.match(batchBody, /conversationsApi\.remove/, '批量删除仍发起真实删除请求')
})

test('删除回退仿真：主屏/分屏/抽屉命中被删会话时回该智能体待命态', { timeout: 60_000 }, () => {
  // 与 Provider conversation.deleted 管道同一决策函数形状：仅命中当前目标才回退，
  // 待命目标继承被删会话的 profileId/nodeId/cwd（远端坐标不回落本机）。
  function simulateFallback(
    deleted: { id: number; profileId: string; nodeId?: string; cwd?: string },
    primaryTarget: { kind: string; conversationId?: number },
    splitTarget: { kind: string; conversationId?: number } | null,
    drawerConversationId: number | null,
  ) {
    const primaryHit = primaryTarget.kind === 'conversation' && primaryTarget.conversationId === deleted.id
    const splitHit = splitTarget?.kind === 'conversation' && splitTarget.conversationId === deleted.id
    const drawerHit = drawerConversationId === deleted.id
    const fallback = {
      kind: 'agent',
      profileId: deleted.profileId,
      ...(deleted.nodeId !== undefined && deleted.nodeId !== '' && deleted.nodeId !== 'local' ? { nodeId: deleted.nodeId } : {}),
      ...(deleted.cwd !== undefined && deleted.cwd !== '' ? { cwd: deleted.cwd } : {}),
    }
    return {
      primary: primaryHit ? fallback : primaryTarget,
      splitClosed: splitHit,
      drawerClosed: drawerHit,
    }
  }

  // 场景 1：主屏会话 10（远端）被删：回待命态并继承节点与目录
  const r1 = simulateFallback(
    { id: 10, profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' },
    { kind: 'conversation', conversationId: 10 },
    null,
    null,
  )
  assert.deepEqual(r1.primary, { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })

  // 场景 2：分屏会话 11 被删：只关分屏，主屏不动
  const r2 = simulateFallback(
    { id: 11, profileId: 'assistant' },
    { kind: 'conversation', conversationId: 1 },
    { kind: 'conversation', conversationId: 11 },
    null,
  )
  assert.deepEqual(r2.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(r2.splitClosed, true)

  // 场景 3：被删的不是当前目标：不重定向
  const r3 = simulateFallback(
    { id: 10, profileId: 'assistant' },
    { kind: 'conversation', conversationId: 1 },
    { kind: 'conversation', conversationId: 99 },
    null,
  )
  assert.deepEqual(r3.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(r3.splitClosed, false)
  assert.equal(r3.drawerClosed, false)
})

test('SSR 渲染回归：Sidebar 包含批量管理按钮与极简无 Emoji 验证', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // 智能体分组头部包含 check-square 批量管理按钮
  assert.ok(html.includes('title="Manage conversations in bulk"'), '应渲染批量管理切换按钮')
  assert.ok(html.includes('check-square') || html.includes('lucide'), '应包含 check-square 图标')

  // 极简无 Emoji 铁律验证
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u
  assert.ok(!EMOJI_RE.test(html), 'Sidebar 渲染输出全程不得包含任何 Emoji')
  assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊字符')
})

test('Archived分组默认折叠，展开态才渲染归档会话', { timeout: 60_000 }, async () => {
  const { ArchivedConversationsGroup } = await import('../src/shell/SidebarArchivedConversations.js')
  const archived = conv({ id: 77, title: '已收尾的话题', tags: [ARCHIVED_TAG] })
  const store = makeTestStore({
    conversations: [archived],
    profiles: [{ id: 'assistant', name: '个人助理' }],
  })
  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ArchivedConversationsGroup, { background: new Map() })),
  )
  assert.match(html, /Archived/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /已收尾的话题/)
})

test('Sidebar 状态圆点渲染验证：五态圆点与单会话站位行', { timeout: 60_000 }, () => {
  // 手风琴契约：仅当前会话所属智能体展开话题子列表，其余智能体单行展示圆点与计数。
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 2, title: '任务 A', profileId: 'assistant', status: 'working', doing: '正在思考方案', updatedAt: 6000 }),
      conv({ id: 10, title: '空闲 E', profileId: 'assistant', status: 'idle', updatedAt: 2000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
      { id: 'reviewer', name: '审阅专员' },
      { id: 'auditor', name: '审计专员' },
      { id: 'reporter', name: '报告专员' },
    ],
  })
  // 单会话 Agent 各自渲染一种状态圆点：working / blocked / error / done
  store.updateLive((prev) => ({
    ...prev,
    conversations: [
      ...prev.conversations,
      conv({ id: 20, title: '代码重构', profileId: 'coder', status: 'working', doing: '重构中' }),
      conv({ id: 21, title: '审批 B', profileId: 'reviewer', status: 'blocked' }),
      conv({ id: 22, title: '异常 C', profileId: 'auditor', status: 'error' }),
      conv({ id: 23, title: '完成 D', profileId: 'reporter', status: 'done' }),
    ],
  }))
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // 1) idle 不产生任何圆点（conversationStatusDotClass 对 idle 返回 null）
  assert.ok(!html.includes('status-dot-idle'), 'idle 会话不得渲染状态圆点')

  // 2) working 圆点带 doing 提示与无障碍属性
  assert.ok(html.includes('class="status-dot status-dot-working"'), '应渲染 working 圆点')
  assert.ok(html.includes('title="Running: 正在思考方案"'), 'working 圆点应带 doing 提示')
  assert.ok(html.includes('aria-label="Running: 正在思考方案"'), '圆点应带 aria-label')
  assert.ok(html.includes('role="status"'), '圆点应带 role=status')

  // 3) blocked / error / done 圆点
  assert.ok(html.includes('class="status-dot status-dot-blocked"'), '应渲染 blocked 圆点')
  assert.ok(html.includes('title="Awaiting confirmation"'), 'blocked 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-error"'), '应渲染 error 圆点')
  assert.ok(html.includes('title="Error"'), 'error 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-done"'), '应渲染 done 圆点')
  assert.ok(html.includes('title="Completed"'), 'done 圆点提示')

  // 4) 手风琴契约：仅当前会话所属智能体（assistant）展开话题子列表；
  //    多会话智能体展示计数徽标，单会话 coder 站位行渲染主会话 working 圆点。
  assert.ok(html.includes('agent-conversations-list'), '当前智能体展开话题子列表')
  assert.ok(html.includes('>3</span>'), '多会话智能体站位行应展示会话计数徽标')
  assert.ok(html.includes('title="Running: 重构中"'), '单会话 Agent 站位行圆点应带 tooltip')
  assert.ok(!html.includes('badge-accent'), '不应再渲染文字徽章样式 badge-accent')
})

// ---------------------------------------------------------------------------
// 双层导航：Activity Rail + Context Sidebar
// ---------------------------------------------------------------------------

test('Sidebar 双层导航：Activity Rail 空间切换与系统中心直达（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // Rail 结构：三空间切换 + 主题按钮均带 aria-label；系统中心入口收敛到设置空间列表
  assert.ok(html.includes('activity-rail'), '应渲染 Activity Rail 容器')
  assert.ok(html.includes('aria-label="Conversations space"'), '对话空间按钮')
  assert.ok(html.includes('aria-label="Views space"'), '视图空间按钮')
  assert.ok(html.includes('aria-label="Settings space"'), '设置空间按钮')
  assert.ok(!html.includes('activity-rail-centers'), 'Rail 不再直接渲染系统中心图标')
  assert.ok(html.includes('aria-label="System"'), '主题按钮')

  // 默认对话空间：智能体分组在 Context Sidebar 内；视图/设置空间内容不渲染
  assert.ok(html.includes('agent-standing-group'), '对话空间渲染智能体分组')
  assert.ok(!html.includes('>视图</div>'), '默认不渲染视图空间分组')
  assert.ok(!html.includes('settings-nav'), '默认不渲染设置空间分组')

  // 默认收起筛选栏：渲染筛选切换按钮与 Cmd-K 按钮，无多余常驻搜索输入
  assert.ok(html.includes('aria-label="Filter agents and topics"'), '渲染智能体筛选开关按钮')
  assert.ok(!html.includes('sidebar-search-input'), '默认收起筛选栏，不常驻渲染搜索输入框')
  assert.ok(html.includes('title="Open Cmd K global search and command palette"'), 'Cmd-K 按钮保留')

  // 底栏已移除：系统中心入口收敛到设置空间
  assert.ok(!html.includes('sidebar-footer'), '底栏容器已移除')
})

test('Sidebar 设置空间：系统中心纵向列表与激活高亮（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore({ primaryTarget: { kind: 'models' } })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  assert.ok(html.includes('settings-nav'), '设置空间渲染系统中心列表')
  for (const label of ['Profile', 'Models &amp; credentials', 'Skills', 'Compute nodes', 'Plugin Center']) {
    assert.ok(html.includes(`>${label}</span>`), `设置列表项 ${label}`)
  }
  // 当前中心为 models：设置列表项激活高亮
  const idx = html.indexOf('>Models &amp; credentials</span>')
  assert.ok(idx > 0 && html.lastIndexOf('nav-item-active', idx) > 0, '模型与凭据为激活项')
  // 设置空间不渲染智能体分组
  assert.ok(!html.includes('agent-standing-group'), '设置空间不渲染智能体分组')
})

test('Sidebar 双层导航：单展开仅当前智能体显示话题子列表，待命亮父行/进会话亮子行（SSR）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
    conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
    conv({ id: 11, title: '代码审查', profileId: 'assistant' }),
  ]
  const profiles = [{ id: 'assistant', name: '个人助理' }]

  // 1) 进会话态：站位行（父）仅弱亮分支态，当前会话子行（子）唯一点亮
  const convStore = makeTestStore({ conversations, profiles })
  const convHtml = renderToString(e(HostStoreProviders, { value: convStore }, e(Sidebar)))
  assert.ok(convHtml.includes('agent-conversations-list'), '当前智能体渲染话题子列表')
  assert.ok(convHtml.includes('nav-item-sub'), '话题子行使用二级行样式')
  assert.ok(convHtml.includes('>3</span>'), '多会话智能体行展示计数徽标')
  assert.ok(convHtml.includes('title="Start a new topic under 个人助理"'), '智能体行新建按钮保留（进入待命态）')
  assert.ok(convHtml.includes('class="nav-item agent-standing-row agent-standing-row-branch"'), '进会话时站位行（父）呈分支弱态')
  assert.ok(!convHtml.includes('class="nav-item agent-standing-row nav-item-active"'), '进会话时站位行（父）不亮激活底')
  assert.ok(convHtml.includes('class="nav-item nav-item-sub nav-item-active"'), '当前会话子行（子）唯一点亮')

  // 2) 待命态 #/a/assistant：站位行（父）点亮，子列表展开但任何子行均不点亮
  const standbyStore = makeTestStore({
    conversations,
    profiles,
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
  })
  const standbyHtml = renderToString(e(HostStoreProviders, { value: standbyStore }, e(Sidebar)))
  assert.ok(standbyHtml.includes('agent-conversations-list'), '待命态展开所属智能体话题子列表')
  assert.ok(standbyHtml.includes('class="nav-item agent-standing-row nav-item-active"'), '待命态站位行（父）点亮')
  assert.ok(!standbyHtml.includes('agent-standing-row-branch'), '待命态站位行不附带分支弱态')
  assert.ok(!standbyHtml.includes('nav-item-sub nav-item-active'), '待命态任何子行均不点亮')
})

test('Sidebar 分屏混开 SSR 回归：主屏会话 + 分屏待命且聚焦分屏时高亮与主/分微标准确呈现', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '主屏会话', profileId: 'assistant' }),
      conv({ id: 40, title: '编码历史', profileId: 'coder' }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'agent', profileId: 'coder' },
    focusedPanel: 'split',
  })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  assert.equal((html.match(/class="agent-conversations-list"/g) ?? []).length, 2, '分屏两侧所属智能体均展开')
  assert.ok(html.includes('class="nav-item agent-standing-row agent-standing-row-branch"'), '主屏会话所属智能体父行呈分支弱态')
  assert.ok(html.includes('class="nav-item nav-item-sub nav-item-split"'), '主屏非聚焦会话子行呈分屏在场态')
  assert.ok(html.includes('<span class="nav-pane-tag" title="Open in main view">Main</span>'), '主屏会话子行带「主」微标')
  assert.ok(html.includes('class="nav-item agent-standing-row nav-item-active nav-item-focused"'), '分屏聚焦的待命智能体父行点亮并带焦点刻度')
  assert.ok(html.includes('<span class="nav-pane-tag" title="Open in split view">Split</span>'), '分屏待命父行带「分」微标')
})



