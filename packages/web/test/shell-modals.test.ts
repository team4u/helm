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
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, resolveTargetString, spaceForTarget, type HelmStoreValue } from '../src/lib/types.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'
import {
  type AgentStanding,
  buildAgentStandings,
  buildProfileTopics,
  collectEnabledPluginIds,
  conversationStatusBadgeClass,
  conversationStatusDotClass,
  conversationStatusLabel,
  conversationStatusTooltip,
  extractSidebarViews,
  filterAgentStandings,
  filterConversationsByTag,
  filterDeletableConversations,
  filterTopicList,
  fuzzyMatchConversations,
  isConversationDeletable,
  isHumanSelectableProfile,
  isProfileVisible,
  isSkillVisible,
  partitionSidebarUi,
} from '../src/shell/sidebar-model.js'

const noop = () => {}
const asyncNoop = async () => undefined

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

/** superagent 插件声明的分组（后台 Worker + 可折叠已归档）。 */
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
  const input = { profiles: [], plugins: [], sidebarItems: [], sidebarSections: [] }
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

test('buildAgentStandings：同刻 updatedAt 按 id 倒序；被 sidebar.item 指向的会话置顶', { timeout: 60_000 }, () => {
  const sameTime: ConversationSummary[] = [
    conv({ id: 1, profileId: 'assistant' }),
    conv({ id: 10, profileId: 'assistant', updatedAt: 5000 }),
    conv({ id: 11, profileId: 'assistant', updatedAt: 5000 }),
  ]
  const standings = buildAgentStandings({
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: sameTime,
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:profile', spec: { id: 'pin-10', label: '置顶话题', target: 'conversation:10' } },
    ],
    sidebarSections: [],
  })
  // #10 被 sidebar.item 指向置顶 -> 其余（含 #1）同刻按 id 倒序（无根会话特判）
  assert.deepEqual(standings[0]!.conversations.map((c) => c.id), [10, 11, 1])
})

// ---------------------------------------------------------------------------
// 视图分流：extractSidebarViews
// ---------------------------------------------------------------------------

test('extractSidebarViews 提取 screen: 导航项并按 order 排序，不混入 Agent 站位', { timeout: 60_000 }, () => {
  const views = extractSidebarViews(sidebarItems, conversations)
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
  )
  assert.equal(views[0]!.icon, 'panel-right')
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

test('conversationStatusDotClass 仅对非 idle 状态返回圆点类名', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusDotClass('idle'), null)
  assert.equal(conversationStatusDotClass('working'), 'status-dot status-dot-working')
  assert.equal(conversationStatusDotClass('blocked'), 'status-dot status-dot-blocked')
  assert.equal(conversationStatusDotClass('done'), 'status-dot status-dot-done')
  assert.equal(conversationStatusDotClass('error'), 'status-dot status-dot-error')
})

test('conversationStatusTooltip 生成准确悬停提示', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusTooltip('idle'), '空闲')
  assert.equal(conversationStatusTooltip('blocked'), '待确认')
  assert.equal(conversationStatusTooltip('done'), '已完成')
  assert.equal(conversationStatusTooltip('error'), '异常')
  assert.equal(conversationStatusTooltip('working'), '运行中')
  assert.equal(conversationStatusTooltip('working', '正在分析代码'), '运行中: 正在分析代码')
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
// 双层导航纯函数：智能体行过滤 + 当前 Profile 话题列表
// ---------------------------------------------------------------------------

test('filterAgentStandings 按 label / profileId / 会话标题过滤智能体行', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  // 空 query 返回全部
  assert.equal(filterAgentStandings(standings, '').length, standings.length)
  assert.equal(filterAgentStandings(standings, '  ').length, standings.length)
  // label 命中
  assert.deepEqual(
    filterAgentStandings(standings, '中枢').map((s) => s.profileId),
    ['superagent'],
  )
  // profileId 命中
  assert.deepEqual(
    filterAgentStandings(standings, 'coder').map((s) => s.profileId),
    ['coder'],
  )
  // 会话标题命中时保留整行（供用户进一步定位）
  assert.deepEqual(
    filterAgentStandings(standings, '周末计划').map((s) => s.profileId),
    ['assistant'],
  )
  // 纯数字 id 命中
  assert.deepEqual(
    filterAgentStandings(standings, '40').map((s) => s.profileId),
    ['coder'],
  )
  // 无命中返回空
  assert.equal(filterAgentStandings(standings, '不存在的关键词').length, 0)
})

test('buildProfileTopics 构建当前 profile 的根话题列表：pinned/updatedAt/id 稳定排序', { timeout: 60_000 }, () => {
  const topics = buildProfileTopics(
    [
      conv({ id: 1, profileId: 'assistant', updatedAt: 1000 }),
      conv({ id: 10, profileId: 'assistant', updatedAt: 5000 }),
      conv({ id: 11, profileId: 'assistant', updatedAt: 5000, pinned: true }),
      conv({ id: 12, profileId: 'assistant', updatedAt: 9000 }),
      // 非 profile 会话与子代理派生会话不进入话题列表
      conv({ id: 40, profileId: 'coder', updatedAt: 9999 }),
      conv({ id: 41, profileId: 'assistant', parentConversationId: 1, updatedAt: 9999 }),
    ],
    'assistant',
    1,
  )
  assert.deepEqual(
    topics.map((t) => t.conv.id),
    [11, 12, 10, 1],
  )
  // 激活标记
  assert.deepEqual(
    topics.map((t) => t.active),
    [false, false, false, true],
  )
  // markActiveId 为 null 时无激活项
  const noActive = buildProfileTopics([conv({ id: 1, profileId: 'assistant' })], 'assistant', null)
  assert.deepEqual(noActive.map((t) => t.active), [false])
})

test('filterTopicList 按标题与 #id 过滤话题', { timeout: 60_000 }, () => {
  const items = buildProfileTopics(
    [
      conv({ id: 1, title: '周末计划', profileId: 'assistant' }),
      conv({ id: 2, title: '代码审查', profileId: 'assistant' }),
      conv({ id: 10, title: '杂记', profileId: 'assistant' }),
    ],
    'assistant',
    null,
  )
  assert.deepEqual(filterTopicList(items, '').map((t) => t.conv.id), [10, 2, 1])
  assert.deepEqual(filterTopicList(items, '周末').map((t) => t.conv.id), [1])
  // #10 与 10 两种形式都命中 id 10（前缀命中）
  assert.deepEqual(filterTopicList(items, '#10').map((t) => t.conv.id), [10])
  assert.deepEqual(filterTopicList(items, '1').map((t) => t.conv.id), [10, 1])
  assert.equal(filterTopicList(items, '不存在').length, 0)
})

// ---------------------------------------------------------------------------
// 侧边栏批量管理与批量删除逻辑
// ---------------------------------------------------------------------------

function makeTestStore(partial: Partial<HelmStoreValue> = {}): HelmStoreValue {
  const store: HelmStoreValue = {
    authReady: true,
    authConfigured: true,
    authenticated: true,
    authError: null,
    connectionError: null,
    loadErrors: {},
    sseConnected: true,
    theme: 'dark',
    themePreference: 'system',
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 10, title: '用户会话1', profileId: 'assistant' }),
      conv({ id: 11, title: '用户会话2', profileId: 'assistant' }),
    ],
    conversationDetails: {},
    conversationLives: {},
    conversationArtifacts: {},
    pendingAsks: [],
    resolvedAsksByConv: {},
    plugins: [{ id: 'builtin:profile', name: '个人助理', locked: true, enabled: true, hooks: [], actions: [], tools: [] }],
    uiContributions: [],
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    nodes: [],
    profiles: [{ id: 'assistant', name: '个人助理' }],
    assetsLoaded: true,
    models: [
      {
        id: 'zhipu/glm-4.6',
        provider: 'zhipu',
        modelId: 'glm-4.6',
        available: true,
        thinkingLevels: ['off', 'low', 'high'],
      },
    ],
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'artifacts',
    sidebarSpace: 'conversations',
    activeModal: null,
    highlightedEntry: null,
    notices: [],
    setTheme: () => {},
    setThemePreference: () => {},
    toggleTheme: () => {},
    checkAuth: async () => {},
    onAuthenticated: async () => {},
    logout: () => {},
    refreshAssets: async () => {},
    refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined,
    loadEarlierEntries: async () => {},
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: async () => undefined,
    openTarget: () => {},
    closeSplit: () => {},
    setScreenParams: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    setSidebarSpace: () => {},
    setActiveModal: () => {},
    dismissNotice: () => {},
    pushNotice: () => {},
    invokePluginAction: async () => undefined,
    subscribeSessionDoc: subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
    ...partial,
  }
  // 侧栏空间缺省跟随主屏隐含空间（与真实 Provider 的对齐行为一致），可显式覆写。
  if (partial.sidebarSpace === undefined) store.sidebarSpace = spaceForTarget(store.primaryTarget)
  return store
}

test('批量选择状态计算：全选、反选与单选切换', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
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
  const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
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
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))

  // 智能体分组头部包含 check-square 批量管理按钮
  assert.ok(html.includes('title="批量管理会话"'), '应渲染批量管理切换按钮')
  assert.ok(html.includes('check-square') || html.includes('lucide'), '应包含 check-square 图标')

  // 极简无 Emoji 铁律验证
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u
  assert.ok(!EMOJI_RE.test(html), 'Sidebar 渲染输出全程不得包含任何 Emoji')
  assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊字符')
})

test('批量模式勾选框只存在于会话子项，机器人站位行绝不含勾选框（源码结构回归）', { timeout: 60_000 }, () => {
  const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')

  // sidebar-batch-checkbox 仅出现在 AgentConversationRow（会话子行）内，
  // 且位于其受控渲染块中；Agent 站位头部行只使用 agent-collapse-btn / nav-item-main 按钮。
  const checkboxIdx = sidebarSource.indexOf('sidebar-batch-checkbox')
  assert.ok(checkboxIdx > 0, '会话子行应渲染 sidebar-batch-checkbox')
  const convRowStart = sidebarSource.lastIndexOf('function AgentConversationRow', checkboxIdx)
  assert.ok(convRowStart > 0, '勾选框必须定义在 AgentConversationRow 组件内')
  const convRowEnd = sidebarSource.indexOf('\nfunction ', convRowStart + 10)
  assert.ok(
    checkboxIdx < convRowEnd,
    '勾选框必须只存在于会话子行组件，不得混入机器人站位头部行',
  )

  // 站位头部行（agent-standing-row 与其子按钮）不含任何 checkbox 类名。
  const standingStart = sidebarSource.indexOf('function AgentStandingItem')
  const standingEnd = sidebarSource.indexOf('function AgentConversationsList', standingStart)
  const standingBody = sidebarSource.slice(standingStart, standingEnd)
  assert.ok(!standingBody.includes('type="checkbox"'), '机器人站位头部行严禁包含 checkbox 输入框')
  assert.ok(!standingBody.includes('sidebar-batch-checkbox'), '机器人站位头部行严禁复用会话勾选框类名')
  // 批量模式下头部行仅切换展开，不提供勾选。
  assert.match(standingBody, /if \(batchMode && hasSubList\) \{\s*setExpanded/, '批量模式下头部行仅切换子列表展开')
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
  store.conversations.push(
    conv({ id: 20, title: '代码重构', profileId: 'coder', status: 'working', doing: '重构中' }),
    conv({ id: 21, title: '审批 B', profileId: 'reviewer', status: 'blocked' }),
    conv({ id: 22, title: '异常 C', profileId: 'auditor', status: 'error' }),
    conv({ id: 23, title: '完成 D', profileId: 'reporter', status: 'done' }),
  )
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))

  // 1) idle 不产生任何圆点（conversationStatusDotClass 对 idle 返回 null）
  assert.ok(!html.includes('status-dot-idle'), 'idle 会话不得渲染状态圆点')

  // 2) working 圆点带 doing 提示与无障碍属性
  assert.ok(html.includes('class="status-dot status-dot-working"'), '应渲染 working 圆点')
  assert.ok(html.includes('title="运行中: 正在思考方案"'), 'working 圆点应带 doing 提示')
  assert.ok(html.includes('aria-label="运行中: 正在思考方案"'), '圆点应带 aria-label')
  assert.ok(html.includes('role="status"'), '圆点应带 role=status')

  // 3) blocked / error / done 圆点
  assert.ok(html.includes('class="status-dot status-dot-blocked"'), '应渲染 blocked 圆点')
  assert.ok(html.includes('title="待确认"'), 'blocked 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-error"'), '应渲染 error 圆点')
  assert.ok(html.includes('title="异常"'), 'error 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-done"'), '应渲染 done 圆点')
  assert.ok(html.includes('title="已完成"'), 'done 圆点提示')

  // 4) 手风琴契约：仅当前会话所属智能体（assistant）展开话题子列表；
  //    多会话智能体展示计数徽标，单会话 coder 站位行渲染主会话 working 圆点。
  assert.ok(html.includes('agent-conversations-list'), '当前智能体展开话题子列表')
  assert.ok(html.includes('>3</span>'), '多会话智能体站位行应展示会话计数徽标')
  assert.ok(html.includes('title="运行中: 重构中"'), '单会话 Agent 站位行圆点应带 tooltip')
  assert.ok(!html.includes('badge-accent'), '不应再渲染文字徽章样式 badge-accent')
})

// ---------------------------------------------------------------------------
// 双层导航：Activity Rail + Context Sidebar
// ---------------------------------------------------------------------------

test('Sidebar 双层导航：Activity Rail 空间切换与系统中心直达（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))

  // Rail 结构：三空间切换 + 主题按钮均带 aria-label；系统中心入口收敛到设置空间列表
  assert.ok(html.includes('activity-rail'), '应渲染 Activity Rail 容器')
  assert.ok(html.includes('aria-label="对话空间"'), '对话空间按钮')
  assert.ok(html.includes('aria-label="视图空间"'), '视图空间按钮')
  assert.ok(html.includes('aria-label="设置空间"'), '设置空间按钮')
  assert.ok(!html.includes('activity-rail-centers'), 'Rail 不再直接渲染系统中心图标')
  assert.ok(html.includes('aria-label="跟随系统"'), '主题按钮')

  // 默认对话空间：智能体分组在 Context Sidebar 内；视图/设置空间内容不渲染
  assert.ok(html.includes('agent-standing-group'), '对话空间渲染智能体分组')
  assert.ok(!html.includes('>视图</div>'), '默认不渲染视图空间分组')
  assert.ok(!html.includes('settings-nav'), '默认不渲染设置空间分组')

  // 紧凑搜索输入与 Cmd-K 按钮共存
  assert.ok(html.includes('sidebar-search-input'), '智能体搜索输入')
  assert.ok(html.includes('title="打开 Cmd K 全局搜索与命令面板"'), 'Cmd-K 按钮保留')

  // 底栏已移除：系统中心入口收敛到设置空间
  assert.ok(!html.includes('sidebar-footer'), '底栏容器已移除')
})

test('Sidebar 设置空间：系统中心纵向列表与激活高亮（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore({ primaryTarget: { kind: 'models' } })
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))

  assert.ok(html.includes('settings-nav'), '设置空间渲染系统中心列表')
  for (const label of ['角色', '模型与凭据', '技能库', '计算节点', '插件中心']) {
    assert.ok(html.includes(`>${label}</span>`), `设置列表项 ${label}`)
  }
  // 当前中心为 models：设置列表项激活高亮
  const idx = html.indexOf('>模型与凭据</span>')
  assert.ok(idx > 0 && html.lastIndexOf('nav-item-active', idx) > 0, '模型与凭据为激活项')
  // 设置空间不渲染智能体分组
  assert.ok(!html.includes('agent-standing-group'), '设置空间不渲染智能体分组')
})

test('Sidebar 双层导航：手风琴单展开仅当前智能体显示话题子列表（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
      conv({ id: 11, title: '代码审查', profileId: 'assistant' }),
    ],
    profiles: [{ id: 'assistant', name: '个人助理' }],
  })
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))

  // 手风琴：当前会话所属智能体（assistant）展开话题子列表，标题行保持非激活
  assert.ok(html.includes('agent-conversations-list'), '当前智能体渲染话题子列表')
  assert.ok(html.includes('nav-item-sub'), '话题子行使用二级行样式')
  assert.ok(html.includes('>3</span>'), '多会话智能体行展示计数徽标')
  assert.ok(html.includes('title="在 个人助理 下开始新话题"'), '智能体行新建按钮保留（进入待命态）')
})



