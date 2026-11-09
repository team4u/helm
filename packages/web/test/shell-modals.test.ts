import assert from 'node:assert/strict'
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
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import {
  type AgentStanding,
  buildAgentStandings,
  collectEnabledPluginIds,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  extractSidebarViews,
  filterConversationsByTag,
  filterDeletableConversations,
  fuzzyMatchConversations,
  isConversationDeletable,
  isHumanSelectableProfile,
  isProfileVisible,
  isSkillVisible,
  partitionSidebarUi,
} from '../src/shell/sidebar-model.js'
import { resolveTargetString } from '../src/lib/types.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { Sidebar, AgentStandingItem } = await import('../src/shell/Sidebar.js')

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
    pluginId: 'builtin:assistant',
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
  { id: 'builtin:assistant', enabled: true },
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
  assert.equal(assistant.icon, 'sparkles')
  assert.equal(assistant.order, 0)
  assert.equal(assistant.canCreateConversation, true)
  const hub = standings[1]!
  assert.equal(hub.label, 'SuperAgent 中枢')
  assert.equal(hub.icon, 'network')
  assert.equal(hub.canCreateConversation, false)
  const watchdog = standings[2]!
  assert.equal(watchdog.label, '巡检看门狗')
  assert.equal(watchdog.icon, 'shield')
  assert.equal(watchdog.canCreateConversation, false)
  const coder = standings[3]!
  assert.equal(coder.label, '编码专员')
  assert.equal(coder.icon, 'bot')
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
        { id: 'builtin:assistant', enabled: true },
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
  assert.equal(orphan.icon, 'bot')
  assert.equal(orphan.order, 200)
  assert.equal(orphan.canCreateConversation, false)
  assert.deepEqual(orphan.conversations.map((c) => c.id), [70])
  assert.equal(orphan.primaryConversation?.id, 70)
})

test('buildAgentStandings：profiles 未加载出 assistant 时兜底生成个人助理站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    profiles: [],
    conversations: [conv({ id: 1, title: '个人助理', profileId: 'assistant' })],
    plugins: [{ id: 'builtin:assistant', enabled: true }],
    sidebarItems: [],
    sidebarSections: [],
  })
  assert.equal(standings.length, 1)
  assert.equal(standings[0]!.profileId, 'assistant')
  assert.equal(standings[0]!.label, '个人助理')
  assert.equal(standings[0]!.icon, 'sparkles')
  assert.equal(standings[0]!.primaryConversation?.id, 1)
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
    plugins: [{ id: 'builtin:assistant', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:assistant', spec: { id: 'pin-10', label: '置顶话题', target: 'conversation:10' } },
    ],
    sidebarSections: [],
  })
  // #1 根会话 -> #10 被 sidebar.item 指向 -> 其余同刻按 id 倒序
  assert.deepEqual(standings[0]!.conversations.map((c) => c.id), [1, 10, 11])
})

test('buildAgentStandings：runtime Profile 默认 terminal 图标，sidebar.item icon 优先', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'herdr-agent', name: '终端代理', runtime: { kind: 'herdr', agent: 'claude' } },
      { id: 'plain', name: '普通专家' },
    ],
    conversations: [conv({ id: 1, profileId: 'assistant' })],
    plugins: [{ id: 'builtin:assistant', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:assistant', spec: { id: 'root', label: '个人助理', icon: 'sparkles', target: 'conversation:1' } },
    ],
    sidebarSections: [],
  })
  const byId = new Map(standings.map((s) => [s.profileId, s.icon]))
  assert.equal(byId.get('assistant'), 'sparkles')
  assert.equal(byId.get('herdr-agent'), 'terminal')
  assert.equal(byId.get('plain'), 'bot')
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

test('ROOT_CONVERSATION_ID 从 @helm/protocol 导入且为 1', { timeout: 60_000 }, () => {
  assert.equal(ROOT_CONVERSATION_ID, 1)
})

// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

test('isProfileVisible：仅依据 managedByPlugin 字段过滤（不按 id 猜归属），任意插件 id 同样生效', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:assistant'])
  const plain: Profile = { id: 'coder', name: '编码' }
  // 无字段的同名 Profile 不猜隐藏（用户自建同 id 资产）
  const hubNoMeta: Profile = { id: 'superagent', name: 'SuperAgent 中枢' }
  const managed = new Set<string>(['builtin:assistant', 'builtin:superagent'])
  const hubManaged: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent' }
  // 任意第三方插件的托管资产同样按字段过滤（验证不依赖特定插件 id）
  const thirdParty: Profile = { id: 'custom-x', managedByPlugin: 'community:reporter' }
  const herdrManaged: Profile = { id: 'herdr-tool', managedByPlugin: 'builtin:herdr' }
  assert.equal(isProfileVisible(plain, disabled), true)
  assert.equal(isProfileVisible(hubNoMeta, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isProfileVisible(hubManaged, disabled), false)
  assert.equal(isProfileVisible(thirdParty, disabled), false)
  assert.equal(isProfileVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent', 'builtin:herdr', 'community:reporter'])
  assert.equal(isProfileVisible(hubManaged, enabled), true)
  assert.equal(isProfileVisible(thirdParty, enabled), true)
  assert.equal(isProfileVisible(herdrManaged, enabled), true)
})

test('isHumanSelectableProfile：仅依据通用 humanSelectable 字段排除常驻单例，其他插件专家 Profile 可选', { timeout: 60_000 }, () => {
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent', 'community:reporter'])
  const assistant: Profile = { id: 'assistant', name: '个人助理' }
  // 常驻单例：插件显式声明 humanSelectable=false
  const hub: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent', humanSelectable: false }
  const watchdog: Profile = { id: 'watchdog', name: '巡检看门狗', managedByPlugin: 'builtin:superagent', humanSelectable: false }
  // 其他插件提供的专家 Profile：受管但未置 humanSelectable，人类可选（缺省 true）
  const pluginExpert: Profile = { id: 'reporter', name: '周报专员', managedByPlugin: 'community:reporter' }
  const pluginSingleton: Profile = { id: 'night-hub', name: '夜间中枢', managedByPlugin: 'community:reporter', humanSelectable: false }
  // 用户自建同名资产（无字段）：不猜隐藏，可选
  const userHubNamed: Profile = { id: 'superagent', name: '我的自定义角色' }
  const disabled = new Set<string>(['builtin:assistant'])
  assert.equal(isHumanSelectableProfile(assistant, enabled), true)
  assert.equal(isHumanSelectableProfile(hub, enabled), false)
  assert.equal(isHumanSelectableProfile(watchdog, enabled), false)
  assert.equal(isHumanSelectableProfile(pluginExpert, enabled), true, '插件专家 Profile 缺省可选')
  assert.equal(isHumanSelectableProfile(pluginSingleton, enabled), false, '任意插件单例同样被通用字段排除')
  assert.equal(isHumanSelectableProfile(userHubNamed, enabled), true, '用户自建同名资产不按 id 猜隐藏')
  assert.equal(isHumanSelectableProfile(hub, disabled), false, '不可见优先于可选')
})

test('isSkillVisible：仅依据 managedByPlugin 字段过滤（任意插件 id），不按 skill id 猜', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:assistant'])
  const plain: SkillSummary = { id: 'weekly-report', name: '周报', references: [] }
  // 无字段同名 skill 不猜隐藏（用户自建）
  const legacy: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [] }
  const managed = new Set<string>(['builtin:assistant', 'builtin:superagent'])
  const managedPlaybooks: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [], managedByPlugin: 'builtin:superagent' }
  const herdrManaged: SkillSummary = { id: 'herdr-flow', name: 'Herdr 流程', references: [], managedByPlugin: 'builtin:herdr' }
  assert.equal(isSkillVisible(plain, disabled), true)
  assert.equal(isSkillVisible(legacy, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isSkillVisible(managedPlaybooks, disabled), false)
  assert.equal(isSkillVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent', 'builtin:herdr'])
  assert.equal(isSkillVisible(managedPlaybooks, enabled), true)
  assert.equal(isSkillVisible(herdrManaged, enabled), true)
})

test('collectEnabledPluginIds 仅收集启用插件', { timeout: 60_000 }, () => {
  const ids = collectEnabledPluginIds([
    { id: 'builtin:assistant', enabled: true },
    { id: 'builtin:herdr', enabled: false },
    { id: 'builtin:superagent', enabled: true },
  ])
  assert.deepEqual([...ids].sort(), ['builtin:assistant', 'builtin:superagent'])
})

// ---------------------------------------------------------------------------
// 会话可删除性判断：isConversationDeletable & filterDeletableConversations
// ---------------------------------------------------------------------------

test('isConversationDeletable 正确判定会话是否允许人类删除', { timeout: 60_000 }, () => {
  // 根会话（ROOT_CONVERSATION_ID）受保护，禁止删除
  assert.equal(isConversationDeletable({ id: ROOT_CONVERSATION_ID }), false)
  assert.equal(isConversationDeletable({ id: 1, ownedBy: 'human' }), false)

  // 机器/插件托管会话禁止删除
  assert.equal(isConversationDeletable({ id: 2, ownedBy: 'bot' }), false)
  assert.equal(isConversationDeletable({ id: 3, ownedBy: 'helm' }), false)

  // 普通人类会话（无 ownedBy 或 ownedBy === 'human' 且 id !== ROOT_CONVERSATION_ID）允许删除
  assert.equal(isConversationDeletable({ id: 10 }), true)
  assert.equal(isConversationDeletable({ id: 11, ownedBy: 'human' }), true)
})

test('filterDeletableConversations 过滤出可删除会话', { timeout: 60_000 }, () => {
  const sample = [
    conv({ id: 1, title: '根会话' }), // ROOT_CONVERSATION_ID -> false
    conv({ id: 2, title: '中枢', ownedBy: 'helm' }), // ownedBy: 'helm' -> false
    conv({ id: 20, title: 'Worker', ownedBy: 'bot' }), // ownedBy: 'bot' -> false
    conv({ id: 10, title: '人类会话1' }), // true
    conv({ id: 11, title: '人类会话2', ownedBy: 'human' }), // true
  ]

  const deletable = filterDeletableConversations(sample)
  assert.deepEqual(
    deletable.map((c) => c.id),
    [10, 11],
  )
})

// ---------------------------------------------------------------------------
// 侧边栏批量管理与批量删除逻辑
// ---------------------------------------------------------------------------

function makeTestStore(partial: Partial<HelmStoreValue> = {}): HelmStoreValue {
  return {
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
    plugins: [{ id: 'builtin:assistant', name: '个人助理', locked: true, enabled: true, hooks: [], actions: [], tools: [] }],
    uiContributions: [],
    groupedUi: {
      sidebarItems: [],
      sidebarSections: [],
      screens: [],
      timelineRenderers: [],
      toolViews: [],
      composerPills: [],
      composerWidgets: [],
      workbenchPanels: [],
      commands: [],
      settingsPanels: [],
    },
    pluginDocs: {},
    workflowRuns: [],
    nodes: [],
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
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'tasks',
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
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    setActiveModal: () => {},
    dismissNotice: () => {},
    pushNotice: () => {},
    invokePluginAction: async () => undefined,
    ...partial,
  }
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
    plugins: [{ id: 'builtin:assistant', enabled: true }],
    sidebarItems: [],
    sidebarSections: [],
  })

  // 提取所有智能体站位下的可删除会话
  const allConvs = standings.flatMap((a) => a.conversations)
  const allDeletableIds = filterDeletableConversations(allConvs).map((c) => c.id)

  // 应该包含 10, 11, 22（排除 1 根会话，排除 bot 和 helm 拥有的会话）
  assert.deepEqual(allDeletableIds.sort((a, b) => a - b), [10, 11, 22])

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
  assert.equal(selectedIds.size, 3)

  // 清空
  selectedIds = new Set()
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 0)
})

test('批量删除重定向保护仿真：主屏/分屏活跃会话删除时安全回退', { timeout: 60_000 }, () => {
  function simulateRedirection(
    selectedIds: Set<number>,
    primaryTarget: { kind: string; conversationId: number },
    splitTarget: { kind: string; conversationId: number } | null,
  ) {
    let redirectedTo: number | null = null
    let splitClosed = false
    if (primaryTarget.kind === 'conversation' && selectedIds.has(primaryTarget.conversationId)) {
      redirectedTo = ROOT_CONVERSATION_ID
    }
    if (splitTarget?.kind === 'conversation' && selectedIds.has(splitTarget.conversationId)) {
      splitClosed = true
    }
    return { redirectedTo, splitClosed }
  }

  // 场景 1：当前主屏为会话 10，分屏为会话 11；批量删除选中了 10 和 11
  const r1 = simulateRedirection(
    new Set([10, 11]),
    { kind: 'conversation', conversationId: 10 },
    { kind: 'conversation', conversationId: 11 },
  )
  assert.equal(r1.redirectedTo, ROOT_CONVERSATION_ID, '主屏正在查看的会话被删，自动重定向到根会话 #1')
  assert.equal(r1.splitClosed, true, '分屏正在查看的会话被删，自动关闭分屏')

  // 场景 2：当前主屏为根会话 1，分屏为会话 99；批量删除选中了 10
  const r2 = simulateRedirection(
    new Set([10]),
    { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
    { kind: 'conversation', conversationId: 99 },
  )
  assert.equal(r2.redirectedTo, null, '未被删除的活跃主屏会话不被重定向')
  assert.equal(r2.splitClosed, false, '未被删除的分屏会话不被关闭')
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

test('批量模式下机器人行（agent-standing-row）绝对不得包含勾选框，仅会话子项可勾选', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const agentStanding: AgentStanding = {
    profileId: 'coder',
    label: '代码专家',
    icon: 'code',
    order: 0,
    primaryConversation: conv({ id: 20, title: '代码重构', profileId: 'coder' }),
    conversations: [conv({ id: 20, title: '代码重构', profileId: 'coder' })],
    canCreateConversation: true,
  }

  const html = renderToString(
    e(AgentStandingItem, {
      agent: agentStanding,
      store,
      onCreate: () => {},
      batchMode: true,
      selectedIds: new Set([20]),
    }),
  )

  // 1) 机器人角色头部行（agent-standing-row）严禁包含任何 checkbox
  const rowMatch = html.match(/<div class="nav-item agent-standing-row[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  assert.ok(rowMatch, '应渲染 agent-standing-row')
  const headerContent = rowMatch[1]!
  assert.ok(!headerContent.includes('type="checkbox"'), '机器人行绝对不得包含勾选框（防止误勾选机器人）')
  assert.ok(!headerContent.includes('sidebar-batch-checkbox'), '机器人行绝对不得包含复选框类名')

  // 2) 只有下挂的会话项（agent-conversations-list）包含会话勾选框
  assert.ok(html.includes('agent-conversations-list'), '应展开子列表渲染具体会话')
  assert.ok(html.includes('sidebar-batch-checkbox'), '会话行应渲染勾选框供批量管理')
  assert.ok(/#<!-- -->20|#20/.test(html), '会话行应包含具体会话 ID')
})


