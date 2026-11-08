import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, Profile, SidebarSectionSpec, SkillSummary } from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import {
  buildSidebarGroups,
  collectEnabledPluginIds,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  filterConversationsByTag,
  fuzzyMatchConversations,
  isHumanSelectableProfile,
  isProfileVisible,
  isSkillVisible,
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

test('selectHumanConversations 无 UI 贡献时不混入插件/系统会话（superagent 停用兑底）', () => {
  const mine = selectHumanConversations(conversations, {
    pinnedProfileIds: new Set(),
    pinnedConversationIds: new Set(),
    sectionTags: new Set(),
  })
  // superagent 停用后其 sidebar 贡献被清空：中枢/看门狗与 worker 会话
  // 不得掉进「我的对话」，仅人类自由对话保留（归属归一 + 历史标签兑底）
  assert.deepEqual(mine.map((c) => c.id), [11, 10])
})

test('buildSidebarGroups 输出人类对话；归档分组由 sidebar.section 声明驱动', () => {
  const groups = buildSidebarGroups(conversations, sidebarItems, sidebarSections)
  assert.deepEqual(groups.humanConversations.map((c) => c.id), [11, 10])
  // 无归档 section 声明时 worker-archived 会话同样不进入人类列表（历史标签兜底）
  const noArchive = buildSidebarGroups(
    [
      ...conversations,
      conv({ id: 31, title: 'Worker: 纯归档', profileId: 'coder', tags: ['worker-archived'] }),
    ],
    sidebarItems,
    [sidebarSections[0]!],
  )
  assert.deepEqual(noArchive.humanConversations.map((c) => c.id), [11, 10])
  // 声明归档 section 后同样不进入（分组去重由声明驱动）
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

// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

test('selectHumanConversations 排除插件托管、子代理派生与历史遗留系统会话（无任何 UI 贡献）', () => {
  const partition = { pinnedProfileIds: new Set<string>(), pinnedConversationIds: new Set<number>(), sectionTags: new Set<string>() }
  const mixed: ConversationSummary[] = [
    conv({ id: 1, profileId: 'assistant' }),
    conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent' }),
    conv({ id: 3, title: '巡检看门狗', profileId: 'watchdog' }),
    conv({ id: 12, profileId: 'coder', ownedBy: 'helm' }),
    conv({ id: 13, profileId: 'coder', ownedBy: 'bot' }),
    conv({ id: 14, profileId: 'assistant', parentConversationId: 1 }),
    conv({ id: 22, profileId: 'coder', tags: ['worker'], ownedBy: 'bot' }),
    conv({ id: 32, profileId: 'coder', tags: ['worker-archived'] }),
    conv({ id: 10, profileId: 'assistant' }),
    conv({ id: 11, profileId: 'coder', ownedBy: 'human' }),
  ]
  assert.deepEqual(selectHumanConversations(mixed, partition).map((c) => c.id), [11, 10])
})

test('selectHumanConversations 在插件停用（无 sidebar 贡献）时归档 worker 会话同样不进入我的对话', () => {
  const empty = { pinnedProfileIds: new Set<string>(), pinnedConversationIds: new Set<number>(), sectionTags: new Set<string>() }
  const archivedOnly = conv({ id: 40, profileId: 'coder', tags: ['worker-archived'], ownedBy: 'bot' })
  assert.deepEqual(selectHumanConversations([archivedOnly, conv({ id: 41 })], empty).map((c) => c.id), [41])
})

test('isProfileVisible：superagent 未启用时隐藏其自举 Profile（含未写 managedByPlugin 的历史数据）', () => {
  const disabled = new Set<string>(['builtin:assistant'])
  const plain: Profile = { id: 'coder', name: '编码' }
  const hubLegacy: Profile = { id: 'superagent', name: 'SuperAgent 中枢' }
  const watchdogLegacy: Profile = { id: 'watchdog', name: '巡检看门狗' }
  const managed: Profile = { id: 'custom-x', managedByPlugin: 'builtin:superagent' }
  const herdrManaged: Profile = { id: 'herdr-tool', managedByPlugin: 'builtin:herdr' }
  assert.equal(isProfileVisible(plain, disabled), true)
  assert.equal(isProfileVisible(hubLegacy, disabled), false)
  assert.equal(isProfileVisible(watchdogLegacy, disabled), false)
  assert.equal(isProfileVisible(managed, disabled), false)
  assert.equal(isProfileVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent', 'builtin:herdr'])
  assert.equal(isProfileVisible(hubLegacy, enabled), true)
  assert.equal(isProfileVisible(managed, enabled), true)
  assert.equal(isProfileVisible(herdrManaged, enabled), true)
})

test('isHumanSelectableProfile：插件常驻单例角色不进入新建对话下拉', () => {
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent'])
  const assistant: Profile = { id: 'assistant', name: '个人助理' }
  const hub: Profile = { id: 'superagent', name: 'SuperAgent 中枢' }
  const watchdog: Profile = { id: 'watchdog', name: '巡检看门狗' }
  const managedSingleton: Profile = { id: 'custom-hub', name: '自定义中枢', managedByPlugin: 'builtin:superagent' }
  const disabled = new Set<string>(['builtin:assistant'])
  assert.equal(isHumanSelectableProfile(assistant, enabled), true)
  assert.equal(isHumanSelectableProfile(hub, enabled), false)
  assert.equal(isHumanSelectableProfile(watchdog, enabled), false)
  assert.equal(isHumanSelectableProfile(managedSingleton, enabled), false)
  assert.equal(isHumanSelectableProfile(hub, disabled), false)
})

test('isSkillVisible：superagent 未启用时隐藏其自举 Skill（含 watchdog-playbooks 历史数据）', () => {
  const disabled = new Set<string>(['builtin:assistant'])
  const plain: SkillSummary = { id: 'weekly-report', name: '周报', references: [] }
  const legacy: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [] }
  const managed: SkillSummary = { id: 'herdr-flow', name: 'Herdr 流程', references: [], managedByPlugin: 'builtin:herdr' }
  assert.equal(isSkillVisible(plain, disabled), true)
  assert.equal(isSkillVisible(legacy, disabled), false)
  assert.equal(isSkillVisible(managed, disabled), false)
  const enabled = new Set<string>(['builtin:assistant', 'builtin:superagent', 'builtin:herdr'])
  assert.equal(isSkillVisible(legacy, enabled), true)
  assert.equal(isSkillVisible(managed, enabled), true)
})

test('collectEnabledPluginIds 仅收集启用插件', () => {
  const ids = collectEnabledPluginIds([
    { id: 'builtin:assistant', enabled: true },
    { id: 'builtin:herdr', enabled: false },
    { id: 'builtin:superagent', enabled: true },
  ])
  assert.deepEqual([...ids].sort(), ['builtin:assistant', 'builtin:superagent'])
})
