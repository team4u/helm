/**
 * 会话总览（#/overview 并发主入口）测试：
 * - 纯函数契约：buildOverviewCards（含安静树、桶序 + createdAt 倒序、后代
 *   芯片信号优先与截断计数、暴露边界继承态势口径、诚实摘要复用）、
 *   filterOverviewCards（桶/角色/节点 AND 组合、quiet 仅在 all、本机节点归一）、
 *   overviewProfileOptions / overviewNodeOptions 去重；
 * - URL：#/overview 解析/序列化往返、hashHasPrimaryTarget、对话空间归属；
 * - 交互：卡片网格渲染与筛选切换、卡面/后代芯片直进主屏会话（与会话列表
 *   点击一致）、抽屉速览与右分屏收进卡片 `...` 菜单（托管卡也保留）、顶栏
 *   新话题（单候选直进 / 多候选下拉选角）、Rail 总览按钮一键直达与 tone 灯点。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helmx/protocol'
import { ARCHIVED_TAG, type ResolvedSidebarBadge, type SidebarViewItem } from '../src/shell/sidebar-model.js'
import type { ConversationBackgroundIndex } from '../src/shell/background-activity-model.js'
import {
  buildOverviewCards,
  filterOverviewCards,
  overviewBucketCounts,
  overviewFilterParamsRepair,
  overviewNodeKey,
  overviewNodeOptions,
  overviewProfileOptions,
  parseOverviewFilterParams,
  OVERVIEW_DESCENDANT_LIMIT,
} from '../src/overview/overview-model.js'
import { formatLocationHash, hashHasPrimaryTarget, parseLocationHash, shouldPushLocationHistory } from '../src/lib/url-hash-model.js'
import { spaceForTarget } from '../src/lib/types.js'
import { makeTestStore, HelmxExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// 受控输入契约：createRoot 须在 happy-dom 注册之后动态加载（react-dom 在
// import 期绑定事件委托的全局 DOM，先于 register 静态加载会让受控输入的
// onChange 静默失效；与 ask-dock.test.tsx 同约定）。
const { createRoot } = await import('react-dom/client')

const { ConversationOverview } = await import('../src/overview/ConversationOverview.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { OVERVIEW_CARD_META_SLOT } = await import('@helmx/protocol/browser')
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

function buildCards(
  conversations: ConversationSummary[],
  background: ConversationBackgroundIndex = new Map(),
  overrides: { profiles?: Array<{ id: string; name?: string; managedByPlugin?: string }>; plugins?: Array<{ id: string; enabled: boolean }>; sectionTags?: ReadonlySet<string> } = {},
) {
  return buildOverviewCards({
    conversations,
    background,
    profiles: overrides.profiles ?? [],
    plugins: overrides.plugins ?? [],
    ...(overrides.sectionTags !== undefined ? { sectionTags: overrides.sectionTags } : {}),
  })
}

// ---------------------------------------------------------------------------
// 纯函数：卡片构建与排序
// ---------------------------------------------------------------------------

test('buildOverviewCards: attention trees lead, quiet trees follow; bucket order then createdAt descending', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked' }),
    conv({ id: 2, status: 'working' }),
    conv({ id: 3, status: 'done', unread: true }),
    conv({ id: 4, status: 'idle' }),
    conv({ id: 5, status: 'done', unread: false }),
  ])
  assert.deepEqual(
    cards.map((card) => [card.root.id, card.bucket]),
    [
      [1, 'needs_attention'],
      [2, 'running'],
      [3, 'unread_done'],
      [5, 'quiet'],
      [4, 'quiet'],
    ],
    'quiet trees only appear in the overview (never in the attention flat group), still createdAt-descending inside their bucket',
  )
})

test('buildOverviewCards: descendants list is signal-first and deterministic; hidden count stays honest against the view cap', { timeout: 60_000 }, () => {
  const members = [
    conv({ id: 1, createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'idle', createdAt: 9100 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200 }),
    conv({ id: 13, parentConversationId: 1, status: 'working', createdAt: 9300 }),
    conv({ id: 14, parentConversationId: 1, status: 'idle', createdAt: 9400 }),
    conv({ id: 15, parentConversationId: 1, status: 'idle', createdAt: 9500 }),
    conv({ id: 16, parentConversationId: 1, status: 'idle', createdAt: 9600 }),
    conv({ id: 17, parentConversationId: 1, status: 'idle', createdAt: 9700 }),
  ]
  const cards = buildCards(members)
  assert.equal(cards.length, 1)
  const card = cards[0]!
  // 契约修订：descendants 携带全量确定性排序列表（信号优先 + createdAt 倒序），
  // 展示截断由视图按 OVERVIEW_DESCENDANT_LIMIT 切片，展开补齐剩余时不重排。
  assert.equal(card.descendants.length, members.length - 1)
  assert.equal(card.descendants[0]!.conv.id, 13, 'signal descendants (blocked/working) lead; within signals createdAt descending')
  assert.equal(card.descendants[1]!.conv.id, 12)
  assert.deepEqual(
    card.descendants.slice(0, OVERVIEW_DESCENDANT_LIMIT).map((d) => d.conv.id),
    [13, 12, 17, 16, 15],
    'the collapsed view slice matches the previous capped contract exactly',
  )
  assert.equal(card.hiddenDescendantCount, members.length - 1 - OVERVIEW_DESCENDANT_LIMIT)
  assert.equal(card.targetConversationId, 12, 'the direct target is the newest waiting descendant')
  assert.equal(card.summaryText, '2 sub-conversations active', 'honest summary falls back to the active descendant count')
})

test('buildOverviewCards inherits the attention exposure boundaries', { timeout: 60_000 }, () => {
  const archived = buildCards([conv({ id: 1, tags: [ARCHIVED_TAG], status: 'working' })])
  assert.equal(archived.length, 0, 'archived root trees never enter the overview')
  const hidden = buildCards([conv({ id: 2, status: 'working' })], new Map(), {
    profiles: [{ id: 'assistant', managedByPlugin: 'builtin:off' }],
    plugins: [{ id: 'builtin:off', enabled: false }],
  })
  assert.equal(hidden.length, 0, 'trees of profiles hidden behind disabled plugins stay out')
  const named = buildCards(
    [conv({ id: 3, status: 'working', profileId: 'coder' })],
    new Map(),
    { profiles: [{ id: 'coder', name: '编码专员' }] },
  )
  assert.equal(named[0]!.profileLabel, '编码专员')
})

// ---------------------------------------------------------------------------
// 纯函数：筛选
// ---------------------------------------------------------------------------

test('filterOverviewCards: bucket/profile/node AND combos; quiet only in all; local node normalization', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked', profileId: 'assistant' }),
    conv({ id: 2, status: 'working', profileId: 'coder', nodeId: 'remote-1' }),
    conv({ id: 3, status: 'idle', profileId: 'coder' }),
  ])
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1, 2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'needs_attention', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: 'coder', nodeId: '' }).map((c) => c.root.id),
    [2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'remote-1' }).map((c) => c.root.id),
    [2],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'local' }).map((c) => c.root.id),
    [],
    'nodeId local aggregates unset node ids; remote trees do not match',
  )
  assert.equal(overviewNodeKey({ nodeId: undefined }), 'local')
  assert.equal(overviewNodeKey({ nodeId: 'remote-1' }), 'remote-1')
  assert.deepEqual(overviewProfileOptions(cards).map((option) => option.id), ['assistant', 'coder'])
  assert.deepEqual(overviewNodeOptions(cards).sort(), ['local', 'remote-1'])
})

// ---------------------------------------------------------------------------
// 纯函数：来源筛选（managed 判定与 sidebarSection filterTag 同源）
// ---------------------------------------------------------------------------

test('buildOverviewCards: managed trees follow the sidebar sectionTags (non-archived tag hits); memberIds carry the whole tree', { timeout: 60_000 }, () => {
  const sectionTags = new Set(['task', 'worker-archived'])
  const cards = buildCards(
    [
      conv({ id: 1, tags: ['task'], status: 'working' }),
      conv({ id: 11, parentConversationId: 1, status: 'idle' }),
      conv({ id: 2, tags: ['worker-archived'], status: 'idle' }),
      conv({ id: 3, tags: [ARCHIVED_TAG], status: 'idle' }),
      conv({ id: 4, status: 'idle' }),
    ],
    new Map(),
    { sectionTags },
  )
  const byId = new Map(cards.map((card) => [card.root.id, card]))
  assert.equal(byId.get(1)!.managed, true, 'a section filterTag hit marks the tree managed')
  assert.equal(byId.get(2)!.managed, true, 'any declared filterTag matches (e.g. worker-archived), zero plugin-id special casing')
  assert.equal(byId.get(4)!.managed, false, 'untagged trees stay regular')
  assert.deepEqual(byId.get(1)!.memberIds, [1, 11], 'memberIds carry the whole tree (root included) for the meta slot props')
  assert.deepEqual(byId.get(4)!.memberIds, [4], 'a single-member tree lists just the root')
  // 归档标签不参与 managed 判定（树本身也不进总览，这里验证无残留）。
  assert.equal(byId.has(3), false, 'archived roots never enter the overview')
  // 未传 sectionTags（无插件 section 贡献）时全部树视为常规会话。
  const noTags = buildCards([conv({ id: 1, tags: ['task'], status: 'working' })])
  assert.equal(noTags[0]!.managed, false, 'without section contributions every tree stays regular')
})

test('filterOverviewCards: source filter ANDs with the other dimensions; default all keeps everything', { timeout: 60_000 }, () => {
  const cards = buildCards(
    [
      conv({ id: 1, tags: ['task'], status: 'blocked' }),
      conv({ id: 2, status: 'working', profileId: 'coder' }),
      conv({ id: 3, status: 'idle', profileId: 'coder' }),
    ],
    new Map(),
    { sectionTags: new Set(['task']) },
  )
  const base = { bucket: 'all' as const, profileId: '', nodeId: '' }
  assert.deepEqual(filterOverviewCards(cards, base).map((c) => c.root.id), [1, 2, 3], 'omitted source defaults to all')
  assert.deepEqual(filterOverviewCards(cards, { ...base, source: 'all' }).map((c) => c.root.id), [1, 2, 3])
  assert.deepEqual(filterOverviewCards(cards, { ...base, source: 'regular' }).map((c) => c.root.id), [2, 3], 'regular keeps only non-managed trees')
  assert.deepEqual(filterOverviewCards(cards, { ...base, source: 'managed' }).map((c) => c.root.id), [1], 'managed keeps only section-tagged trees')
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: '', source: 'regular' }).map((c) => c.root.id),
    [2],
    'source ANDs with bucket/profile/node',
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: '', source: 'managed' }),
    [],
    'a running coder tree that is managed drops out of the regular+managed combo intersection',
  )
})

test('filterOverviewCards: query matches root title, profile label, honest summary and descendant titles; ANDs with the other dimensions', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'error', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
    conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
    conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
  ])
  const base = { bucket: 'all' as const, profileId: '', nodeId: '' }
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '重构' }).map((c) => c.root.id), [1], 'root title substring matches (case-insensitive)')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: 'REFACTOR' }).map((c) => c.root.id), [], 'matching is case-insensitive but never fabricates absent text')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '检索' }).map((c) => c.root.id), [2], 'the honest doing summary is searchable')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '待审批' }).map((c) => c.root.id), [1], 'descendant titles keep their tree findable')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '  ' }).map((c) => c.root.id), [1, 2, 3], 'a blank query filters nothing')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '#11' }).map((c) => c.root.id), [1], 'an exact #id form matches the descendant id')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '2' }).map((c) => c.root.id), [2], 'a bare numeric needle matches the root id exactly, not substrings of other ids')
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: '', nodeId: '', query: '调研' }).map((c) => c.root.id),
    [2],
    'query ANDs with bucket/profile/node/source',
  )
})

test('overviewBucketCounts: bucket badges count inside the profile/node/source/query context, never misleading global totals', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, title: '出错的重构', status: 'blocked', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 2, title: '在跑的调研', status: 'working', profileId: 'coder', createdAt: 8000, updatedAt: 8000 }),
    conv({ id: 3, title: '安静会话', status: 'idle', profileId: 'coder', createdAt: 7000, updatedAt: 7000 }),
  ])
  assert.deepEqual(
    overviewBucketCounts(cards),
    { all: 3, needs_attention: 1, running: 1, unread_done: 0 },
    'no context: every bucket badge reflects the full card set',
  )
  assert.deepEqual(
    overviewBucketCounts(cards, { profileId: 'coder' }),
    { all: 2, needs_attention: 0, running: 1, unread_done: 0 },
    'inside the coder context the needs-attention badge honestly reads zero (the assistant tree is out of context)',
  )
  assert.deepEqual(
    overviewBucketCounts(cards, { query: '安静' }),
    { all: 1, needs_attention: 0, running: 0, unread_done: 0 },
    'query context scopes the badges as well',
  )
})

test('parseOverviewFilterParams / overviewFilterParamsRepair: deep-link params parse to the canonical filter; invalid values fall back and get repaired', { timeout: 60_000 }, () => {
  assert.deepEqual(parseOverviewFilterParams(undefined), {
    bucket: 'all',
    profileId: '',
    nodeId: '',
    source: 'all',
    query: '',
  }, 'no params: pure defaults')
  assert.deepEqual(parseOverviewFilterParams({ bucket: 'running', profile: 'coder', node: 'local', source: 'managed', q: '调研' }), {
    bucket: 'running',
    profileId: 'coder',
    nodeId: 'local',
    source: 'managed',
    query: '调研',
  }, 'every known key parses verbatim')
  assert.equal(parseOverviewFilterParams({ bucket: 'bogus' }).bucket, 'all', 'an invalid bucket value falls back to all (hash-model invalid-segment philosophy)')
  assert.equal(parseOverviewFilterParams({ bucket: 'all' }).bucket, 'all', 'the redundant all value parses as the default')
  assert.equal(parseOverviewFilterParams({ source: 'weird' }).source, 'all', 'an invalid source value falls back to all')
  assert.equal(parseOverviewFilterParams({ profile: 'some-stale-id' }).profileId, 'some-stale-id', 'profile/node/q are opaque ids kept verbatim')

  assert.equal(overviewFilterParamsRepair(undefined), null, 'no params: nothing to repair')
  assert.equal(
    overviewFilterParamsRepair({ bucket: 'running', profile: 'coder', q: 'x' }),
    null,
    'already-canonical params produce no patch (no write amplification)',
  )
  assert.deepEqual(overviewFilterParamsRepair({ bucket: 'bogus', q: 'x' }), { bucket: undefined }, 'an invalid bucket value is deleted')
  assert.deepEqual(overviewFilterParamsRepair({ bucket: 'all', source: 'all' }), { bucket: undefined, source: undefined }, 'redundant default enums are deleted')
  assert.deepEqual(overviewFilterParamsRepair({ tab: 'runs' }), { tab: undefined }, 'unknown keys are deleted (the overview owns its sp. namespace)')
})

// ---------------------------------------------------------------------------
// URL：#/overview 解析与序列化
// ---------------------------------------------------------------------------

test('#/overview parses and serializes round-trip; belongs to the conversations space', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/overview')
  assert.deepEqual(parsed.primaryTarget, { kind: 'overview' })
  assert.equal(hashHasPrimaryTarget('#/overview'), true)
  assert.equal(formatLocationHash({ ...parsed, splitTarget: null, workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null }), '#/overview')
  assert.equal(spaceForTarget({ kind: 'overview' }), 'conversations', 'the overview is a conversations-space host stage')
  const splitParsed = parseLocationHash('#/overview?split=overview')
  assert.deepEqual(splitParsed.splitTarget, { kind: 'overview' }, 'the overview can ride the split pane (same canonical path via the split param)')
})

test('#/overview filter state rides the sp./ssp. route-param namespaces round-trip; history policy keeps param-only changes replace', { timeout: 60_000 }, () => {
  // 深链解析：主屏 sp.* 归主屏 overview，分屏 ssp.* 归分屏 overview。
  const parsed = parseLocationHash('#/overview?sp.bucket=running&sp.profile=coder&sp.q=%E8%B0%83%E7%A0%94&split=overview&ssp.source=managed')
  assert.deepEqual(parsed.primaryTarget, {
    kind: 'overview',
    params: { bucket: 'running', profile: 'coder', q: '调研' },
  })
  assert.deepEqual(parsed.splitTarget, { kind: 'overview', params: { source: 'managed' } }, 'the split overview carries its own ssp.* filter params')
  // 序列化往返无损（键按字典序稳定输出）。
  const state = { ...parsed, workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null }
  const hash = formatLocationHash(state)
  assert.equal(hash, '#/overview?split=overview&sp.bucket=running&sp.profile=coder&sp.q=%E8%B0%83%E7%A0%94&ssp.source=managed')
  assert.deepEqual(parseLocationHash(hash), state, 'round-trip is lossless')
  // 主屏从 overview 切回会话：sp.* 无处可挂自然丢弃（重新进入即未筛选态）。
  const leftOverview = parseLocationHash('#/c/1?sp.bucket=running&split=overview&ssp.source=managed')
  assert.deepEqual(leftOverview.primaryTarget, { kind: 'conversation', conversationId: 1 })
  assert.deepEqual(leftOverview.splitTarget, { kind: 'overview', params: { source: 'managed' } }, 'the split overview keeps its params')
  // 非法 sp.* 键与空值沿用 Hash 模型的丢弃纪律（不产生半损参数）。
  assert.deepEqual(
    parseLocationHash('#/overview?sp.bucket=running&sp.bad%20key=v&sp.profile=').primaryTarget,
    { kind: 'overview', params: { bucket: 'running' } },
  )
  // 历史策略：仅筛选参数变化 replace（不污染后退栈）；坐标级切换 push。
  const base = { splitTarget: null, workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null }
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview' } },
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
    ),
    false,
    'a filter-only change replaces the current history entry',
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running', q: 'x' } } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
      { ...base, primaryTarget: { kind: 'conversation', conversationId: 1 } },
    ),
    true,
    'leaving the overview for a conversation pushes',
  )
})

// ---------------------------------------------------------------------------
// 交互：总览渲染、筛选、抽屉直达与 Rail 入口
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function overviewStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  return makeTestStore({ profiles: BASE_PROFILES, ...overrides })
}

function overviewScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
}

test('ConversationOverview card light matches the sidebar row verdict: idle root with background in-flight renders the hollow ring', { timeout: 60_000 }, async () => {
  // 通用统一口径回归：根 idle + 树内后台在途（workbench badge doc accent）→
  // 卡面灯位渲染空心蓝环，与侧栏会话行完全一致；在跑的后台子代理（working
  // 后代）不再以代表位身份抢占卡面灯——由芯片自带灯呈现。
  const workflowPanel = {
    pluginId: 'builtin:workflow',
    surface: 'workbench.panel' as const,
    spec: {
      id: 'runs',
      label: { en: 'Runs' },
      badge: { doc: 'run-badges', byConversationField: 'byConversation' },
    },
  }
  const store = overviewStore({
    conversations: [
      conv({ id: 5, title: '后台在跑', profileId: 'coder', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 51, parentConversationId: 5, title: '后台子代理', status: 'working', createdAt: 9100, updatedAt: 9200 }),
    ],
    primaryTarget: { kind: 'overview' },
    uiContributions: [workflowPanel],
    pluginDocs: {
      'builtin:workflow/run-badges': { byConversation: { '5': { count: 1, tone: 'accent', footerText: '1 Running' } } },
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const card = container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null, 'the tree card renders')
    assert.ok(
      card.querySelector('.overview-card-head .status-dot-background') !== null,
      'idle root + tree background in-flight renders the hollow ring (row-consistent)',
    )
    assert.ok(
      card.querySelector('.overview-card-head .status-dot-working') === null,
      'the working background descendant no longer steals the card head light',
    )
    assert.ok(
      card.querySelector('.overview-chip .status-dot-working') !== null,
      'the background descendant chip carries its own working light',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview renders the card grid with honest facts and directly opens conversations in the main view', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 3, 'attention trees first, quiet tree last (all filter)')
    assert.ok(cards[0]!.textContent?.includes('出错的重构'), 'the needs-attention tree leads')
    // 灯位口径与侧栏行统一（根锚定）：根 #1 为 idle，卡面灯位零灯（不编造）；
    // blocked 的后代由芯片自带灯呈现，摘要如实说明等待事实。
    assert.ok(cards[0]!.querySelector('.overview-card-head .status-dot') === null, 'the idle root keeps the card head light off (row-consistent)')
    assert.ok(cards[0]!.querySelector('.overview-chip .status-dot-blocked') !== null, 'the blocked descendant chip carries its own light')
    assert.ok(cards[0]!.textContent?.includes('待审批子任务'), 'the waiting descendant renders as a chip')
    assert.ok(cards[1]!.querySelector('.overview-card-head .status-dot-working') !== null, 'the working root lights the card head exactly like a sidebar row')
    assert.ok(cards[1]!.textContent?.includes('正在检索文档'), 'the running card states the real doing text')
    assert.ok(container.textContent?.includes('3 trees'), 'the stats line counts visible cards')

    // 直进语义：点卡片直达 targetConversationId（树内有等待人类的后代时直达
    // 审批现场 #11），不弹抽屉、与会话列表点击完全一致。
    await act(async () => {
      ;(cards[0] as HTMLElement).click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 11 },
      'clicking the card navigates the main view straight to the waiting descendant',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'card clicks never open the conversation drawer')

    // 后代芯片直达该成员会话（同样直进主屏，不弹抽屉）。
    const chip = container.querySelector<HTMLButtonElement>('.overview-chip')
    assert.ok(chip !== null)
    await act(async () => {
      chip.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 11 },
      'the descendant chip navigates straight to the member conversation',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'chip clicks never open the conversation drawer')

    // 卡片 `...` 菜单收进速览/分屏：抽屉速览打开 conversation-drawer 模态。
    const menuTrigger = cards[0]!.querySelector<HTMLButtonElement>('.overview-card-actions button')
    assert.ok(menuTrigger !== null, 'the card actions menu renders')
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const peekItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Peek in drawer'),
    )
    assert.ok(peekItem !== undefined, 'the menu offers the drawer peek action')
    const splitItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Open in right split'),
    )
    assert.ok(splitItem !== undefined, 'the menu offers the right-split action')
    assert.ok(
      [...document.querySelectorAll('[role="separator"]')].length > 0,
      'the prepend view actions are separated from the host archive action',
    )
    await act(async () => {
      peekItem.click()
    })
    assert.deepEqual(
      store.getNavSlice().activeModal,
      { kind: 'conversation-drawer', conversationId: 11 },
      'drawer peek opens the existing conversation drawer at the card target',
    )

    // 右分屏打开：splitTarget 直达卡片目标，主屏不动。
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const splitItemAgain = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Open in right split'),
    )
    assert.ok(splitItemAgain !== undefined)
    await act(async () => {
      splitItemAgain.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'conversation', conversationId: 11 },
      'the right-split action opens the card target in the split pane',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview hides the unread completion light as soon as the conversation becomes viewed', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 8, status: 'done', unread: true }),
      conv({ id: 9, status: 'done', unread: false }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const unreadCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) => card.textContent?.includes('#8'))
    const readCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) => card.textContent?.includes('#9'))
    assert.ok(unreadCard?.querySelector('.status-dot-done'), 'unread completed card has a done light')
    assert.ok(readCard?.querySelector('.status-dot-done') === null, 'read completed card has no unread light')
    await act(async () => store.openTarget({ kind: 'conversation', conversationId: 8 }))
    assert.ok(unreadCard?.querySelector('.status-dot-done') === null, 'opening the conversation hides its light immediately before the PATCH response')
  } finally {
    await act(async () => root?.unmount())
    container.remove()
  }
})

test('ConversationOverview bucket filter narrows the grid (segmented control) and rides the URL hash model', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 3)
    const runningTab = [...container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.includes('Running'),
    ) as HTMLElement | undefined
    assert.ok(runningTab !== undefined, 'the segmented bucket filter renders')
    await act(async () => {
      runningTab.click()
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 1)
    assert.ok(cards[0]!.textContent?.includes('在跑的调研'), 'only the running tree stays visible')
    // 筛选变化写入 overview 目标的 sp.* 路由参数（唯一导航模型，replace 语义）。
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { bucket: 'running' } },
      'the bucket filter persists into the overview route params',
    )
    // 切回 all：参数键删除，目标形状回到无 params 的稳定形态。
    const allTab = [...container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.startsWith('All'),
    ) as HTMLElement | undefined
    await act(async () => {
      allTab?.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview' },
      'returning to the all bucket deletes the param key (canonical shape)',
    )
    assert.equal(container.querySelectorAll('.overview-card').length, 3, 'the grid restores')

    // 浏览器后退语义（hashchange/popstate 同链路）：applyExternalLocation
    // 以地址栏为唯一事实源恢复上一组筛选参数。
    await act(async () => {
      runningTab.click()
    })
    await act(async () => {
      store.applyExternalLocation(parseLocationHash('#/overview'))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 3, 'an external back-to-unfiltered location restores the full grid')
    assert.ok(store.getNavSlice().primaryTarget.kind === 'overview', 'the nav state follows the external location')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview restores filter state from a deep-linked #/overview?sp.* location and repairs invalid params', { timeout: 60_000 }, async () => {
  // 深链/刷新恢复：主屏目标带参数挂载即按参数渲染（不闪全量再收敛）。
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'error', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview', params: { profile: 'coder' } },
  })
  const mount = await mountOverview(store)
  try {
    const cards = mount.container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 2, 'the deep-linked profile filter restores without flashing the unfiltered grid')
    assert.ok(mount.container.textContent?.includes('2 of 3 trees'), 'the stats line states the filtered count over the total')
    // 未知参数键一次自愈删除（replace 修正地址栏，不产生额外历史项）。
    await act(async () => {
      store.applyExternalLocation(parseLocationHash('#/overview?sp.bucket=bogus&sp.q=%E8%B0%83%E7%A0%94'))
    })
    await overviewSettle()
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { q: '调研' } },
      'the invalid bucket value is repaired away while the valid query survives',
    )
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'the surviving query keeps filtering')
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('在跑的调研'))
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview source filter: appears only with managed trees, narrows the grid per source', { timeout: 60_000 }, async () => {
  const appSection = {
    pluginId: 'builtin:apps',
    surface: 'sidebar.section' as const,
    spec: { id: 'app-runs', label: { en: 'App runs' }, icon: 'check-square', filterTag: 'app' },
  }
  // 无托管树：来源筛选不渲染（零无效控件噪音）。
  const regularOnly = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: regularOnly }, e(ConversationOverview)))
    })
    assert.ok(container.querySelector('[aria-label="Filter by source"]') === null, 'no managed trees: the source select stays hidden')

    // 有托管树：来源筛选渲染，切换 managed 只留任务树、regular 只留常规树。
    const mixed = overviewStore({
      conversations: [
        conv({ id: 1, title: '应用会话', profileId: 'assistant', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
        conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      ],
      primaryTarget: { kind: 'overview' },
      uiContributions: [appSection],
    })
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: mixed }, e(ConversationOverview)))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 2, 'both trees render under the all filter')
    const sourceSelect = container.querySelector<HTMLElement>('[aria-label="Filter by source"]')
    assert.ok(sourceSelect !== null, 'with a managed tree present the source select renders')

    await act(async () => {
      sourceSelect.click()
    })
    const managedOption = [...document.body.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes('Managed conversations'),
    ) as HTMLElement | undefined
    assert.ok(managedOption !== undefined, 'the managed option lists in the open listbox')
    await act(async () => {
      managedOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    let cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 1, 'only the managed tree stays visible')
    assert.ok(cards[0]!.textContent?.includes('应用会话'))

    // 插件 section 贡献消失（停用）但深链/地址栏仍停在 managed：筛选器保持
    // 可见防困住，卡片如实归零（绝不伪报常规树为托管）。筛选状态现在住在
    // URL 参数里，用「带参挂载 + 无 section 贡献」还原真实停用后刷新场景。
    const disabled = overviewStore({
      conversations: [
        conv({ id: 1, title: '应用会话', profileId: 'assistant', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
        conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      ],
      primaryTarget: { kind: 'overview', params: { source: 'managed' } },
    })
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: disabled }, e(ConversationOverview)))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 0, 'with the managed filter held, no managed tree stays visible')
    assert.ok(container.querySelector('[aria-label="Filter by source"]') !== null, 'the source select stays visible (never traps the user on a stale value)')
    assert.ok(container.textContent?.includes('No conversations match'), 'the filtered-empty semantics point at the filters, not at the system being empty')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
  // 全新挂载（筛选值回到默认 all）：无 section 贡献时一切归常规，筛选器隐藏。
  {
    const fresh = overviewStore({
      conversations: [
        conv({ id: 1, title: '应用会话', profileId: 'assistant', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
        conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      ],
      primaryTarget: { kind: 'overview' },
    })
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    let root2: Root | undefined
    try {
      await act(async () => {
        root2 = createRoot(container2)
        root2.render(e(HostStoreProviders, { value: fresh }, e(ConversationOverview)))
      })
      const cards = container2.querySelectorAll('.overview-card')
      assert.equal(cards.length, 2, 'no section contributions: every tree is regular again and stays visible')
      assert.ok(container2.querySelector('[aria-label="Filter by source"]') === null, 'a fresh mount without managed trees hides the source select')
    } finally {
      await act(async () => {
        root2?.unmount()
      })
      container2.remove()
    }
  }
})

test('ConversationOverview card meta slot: contributions render with tree props; no contribution leaves zero residue', { timeout: 60_000 }, async () => {
  const received: Array<Record<string, unknown>> = []
  seedPluginClientModule('builtin:apps', 'overview-meta.tsx', {
    AppOverviewCardMeta: (props: Record<string, unknown>) => {
      received.push(props)
      const root = props['rootConversation'] as { id: number }
      return e(
        'button',
        {
          type: 'button',
          className: 'app-overview-pill-stub',
          onClick: (event: React.SyntheticEvent) => {
            event.stopPropagation()
          },
        },
        `A-1 @${root.id}`,
      )
    },
  })
  const slotContribution = {
    pluginId: 'builtin:apps',
    surface: 'plugin.slot' as const,
    spec: {
      id: 'overview-card-meta',
      target: OVERVIEW_CARD_META_SLOT,
      scope: { tags: ['app'] },
      client: { module: 'overview-meta.tsx', export: 'AppOverviewCardMeta' },
    },
  }
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '应用会话', profileId: 'assistant', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '子代理', status: 'idle', createdAt: 9100, updatedAt: 9100 }),
      conv({ id: 2, title: '常规会话', profileId: 'coder', status: 'idle', createdAt: 8000, updatedAt: 8000 }),
    ],
    // clientHashes 对齐 seedPluginClientModule 的 contentHash（'seeded'）：
    // PluginUiView 走内存缓存快路径，零网络请求（about:blank 下相对 URL fetch 必炸）。
    plugins: [{ id: 'builtin:apps', name: 'Apps', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [], clientHashes: { 'overview-meta.tsx': 'seeded' } }],
    primaryTarget: { kind: 'overview' },
    uiContributions: [slotContribution],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    // 先验证无贡献路径：scope 不命中的常规树零渲染。
    const regularCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
      card.textContent?.includes('常规会话'),
    )
    assert.ok(regularCard?.querySelector('.overview-card-meta-slot') === null, 'an out-of-scope card mounts no slot residue')

    const appCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
      card.textContent?.includes('应用会话'),
    )
    const slotHost = appCard?.querySelector<HTMLElement>('.overview-card-meta-slot') ?? null
    assert.ok(slotHost !== null, 'the meta slot mounts inside the matching card')
    const pill = slotHost.querySelector<HTMLElement>('.app-overview-pill-stub')
    assert.ok(pill !== null, 'the contribution component renders inside the slot')
    assert.ok(pill.textContent?.includes('A-1 @1'))
    const last = received.at(-1)!
    assert.equal((last['rootConversation'] as { id: number }).id, 1, 'slotProps carry the root conversation summary')
    assert.deepEqual(last['memberIds'], [1, 11], 'slotProps carry the whole-tree member ids')

    // 胶囊自身 stopPropagation：点击不误开卡片会话抽屉（外层不拦截冒泡，由贡献元素自理）。
    await act(async () => {
      pill.click()
    })
    assert.equal(store.getNavSlice().activeModal, null, 'clicking the pill does not trigger the card drawer')

    // 贡献消失（插件停用）：插槽零残留。
    await act(async () => {
      store.updateLive((state) => ({ ...state, uiContributions: [] }))
    })
    assert.ok(appCard?.querySelector('.overview-card-meta-slot') === null, 'a disabled plugin leaves no slot residue')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('Sidebar overview entry: the rail button is gone; the header button opens #/overview with the same-source count badge', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    // Rail 总览按钮整特性删除：入口唯一收敛到侧栏头部（对话空间）。
    assert.ok(container.querySelector('.rail-overview-btn') === null, 'the rail overview button is gone for good')
    const overviewBtn = container.querySelector<HTMLButtonElement>('.sidebar-overview-open-btn')
    assert.ok(overviewBtn !== null, 'the host overview entry renders in the sidebar header')
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('Conversation overview'),
      'the tooltip label states the overview',
    )
    const badge = overviewBtn.querySelector<HTMLElement>('.overview-count-badge[data-tone="running"]')
    assert.ok(badge !== null, 'the same-source attention count badge rides the button')
    assert.ok(badge.textContent === '1', 'the badge states the honest signal-tree count (1 working tree)')
    await act(async () => {
      overviewBtn.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'overview', 'clicking navigates to the overview stage')

    // 主屏停总览时空间按钮一律不亮（Rail 已无总览按钮，双高亮无从谈起）。
    const spaceBtns = [...container.querySelectorAll<HTMLButtonElement>('.rail-space-btn')]
    assert.ok(spaceBtns.length === 3, 'three space buttons render')
    for (const btn of spaceBtns) {
      assert.ok(
        !btn.classList.contains('rail-btn-active'),
        `space button stays unlit on the overview stage (got: ${btn.getAttribute('aria-label')})`,
      )
    }

    // 总览不占对话空间记忆位：从总览点「对话」空间按钮跳回记忆的会话目标，
    // 绝不 no-op、绝不被总览劫持。
    await act(async () => {
      store.openTarget({ kind: 'conversation', conversationId: 50 })
    })
    await act(async () => {
      store.openTarget({ kind: 'overview' })
    })
    await act(async () => {
      store.openSpace('conversations')
    })
    const jumped = store.getPrimaryTarget()
    assert.ok(
      jumped.kind === 'conversation' && jumped.conversationId === 50,
      'the conversations space button jumps back to the remembered conversation target',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }

  // 无信号时徽标不渲染（诚实：无信号不装忙）
  const quiet = overviewStore({
    conversations: [conv({ id: 50, title: '安静', profileId: 'coder' })],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const html = renderToString(e(HelmxExternalStoreContext.Provider, { value: quiet }, e(Sidebar)))
  assert.ok(!html.includes('rail-overview-btn'), 'the rail overview button never renders')
  assert.ok(html.includes('sidebar-overview-open-btn'), 'the header entry always renders in the conversations space')
  assert.ok(!html.includes('overview-count-badge'), 'no count badge without any signal')
})

// ---------------------------------------------------------------------------
// #58 修订：移动端免开汉堡一键直达（根挂载快捷导航簇）与总览数据就绪门
// ---------------------------------------------------------------------------

const { MobileQuickNav } = await import('../src/shell/MobileQuickNav.js')

function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

test('MobileQuickNav: one-tap direct navigation with the shared count badge; entries hide when their view is already on stage', { timeout: 60_000 }, async () => {
  const restoreMobile = stubMatchMedia(true)
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 2 },
  })
  const quickEntry = {
    key: 'builtin:apps/app-center',
    pluginId: 'builtin:apps',
    label: 'App Center',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'builtin:apps', screenId: 'app-center' } as const,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: store },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 1, unreadDoneCount: 0, totalCount: 1, tone: 'running' },
            quickEntry,
          }),
        ),
      )
    })
    const buttons = container.querySelectorAll('.mobile-quick-btn')
    assert.equal(buttons.length, 2, 'quick entry + overview render side by side without opening the drawer')
    assert.ok(buttons[0]!.getAttribute('aria-label') === 'App Center', 'the quick entry keeps the plugin-provided label')
    const overviewBtn = container.querySelector<HTMLButtonElement>('.mobile-quick-overview-btn')
    assert.ok(overviewBtn !== null)
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('Conversation overview'),
      'the overview button aria states the destination',
    )
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('1 running'),
      'the attention summary rides the overview button aria for screen readers',
    )
    const badge = overviewBtn.querySelector<HTMLElement>('.overview-count-badge[data-tone="running"]')
    assert.ok(badge !== null, 'the count badge rides the overview button (same source as the sidebar header entry)')
    assert.ok(badge.textContent === '1', 'the badge states the honest signal-tree count')

    const quickBtn = buttons[0] as HTMLElement
    await act(async () => {
      quickBtn.click()
    })
    let primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'screen' && primary.screenId === 'app-center', 'one tap enters the first quickEntry view')

    await act(async () => {
      overviewBtn.click()
    })
    primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'overview', 'one tap on the badge button opens the conversation overview')

    // 无 quickEntry 时只渲染总览按钮；无信号时灯点不渲染（诚实）。
    const quiet = overviewStore({
      conversations: [conv({ id: 50, title: '安静', profileId: 'coder' })],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    })
    await act(async () => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: quiet },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 0, unreadDoneCount: 0, totalCount: 0, tone: null },
            quickEntry: null,
          }),
        ),
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'overview-only cluster without any quickEntry')
    assert.ok(container.querySelector('.overview-count-badge') === null, 'no count badge without any signal')

    // 主屏已停在入口目标时对应按钮就地隐藏：总览页只留 quickEntry，
    // quickEntry 视图只留总览；两钮皆隐时整簇不渲染（零占位残留）。
    const renderNav = (store: ReturnType<typeof overviewStore>, entry: typeof quickEntry | null): void => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: store },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 1, unreadDoneCount: 0, totalCount: 1, tone: 'running' },
            quickEntry: entry,
          }),
        ),
      )
    }
    await act(async () => {
      renderNav(
        overviewStore({
          conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
          primaryTarget: { kind: 'overview' },
        }),
        quickEntry,
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'on the overview screen only the quick entry remains')
    assert.ok(container.querySelector('.mobile-quick-overview-btn') === null, 'the overview button hides when the overview is already on stage')

    await act(async () => {
      renderNav(
        overviewStore({
          conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
          primaryTarget: { kind: 'screen', pluginId: 'builtin:apps', screenId: 'app-center' },
        }),
        quickEntry,
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'on the quick-entry view only the overview button remains')
    assert.ok(container.querySelector('.mobile-quick-btn')?.getAttribute('aria-label')?.includes('Conversation overview') === true, 'the remaining button is the overview entry')

    await act(async () => {
      renderNav(overviewStore({ primaryTarget: { kind: 'overview' } }), null)
    })
    assert.ok(container.querySelector('.mobile-quick-nav') === null, 'no quickEntry and already on the overview: the whole cluster unmounts')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    restoreMobile()
  }
})

test('MobileQuickNav renders nothing on desktop viewports (the collapsed rail carries the same entries)', { timeout: 60_000 }, () => {
  const restoreDesktop = stubMatchMedia(false)
  try {
    const html = renderToString(
      e(
        HelmxExternalStoreContext.Provider,
        { value: overviewStore() },
        e(MobileQuickNav, {
          indicator: { needsAttentionCount: 1, runningCount: 0, unreadDoneCount: 0, totalCount: 1, tone: 'blocked' },
          quickEntry: null,
        }),
      ),
    )
    assert.ok(!html.includes('mobile-quick-nav'), 'desktop keeps the root chrome clean')
  } finally {
    restoreDesktop()
  }
})

test('ConversationOverview data-ready gate: loading state before the first snapshot, honest empty only when truly synced', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    // 快照未到（0 会话）且资产/SSE 未就绪：加载态，绝不伪报空。
    const loading = overviewStore({
      conversations: [],
      profilesLoaded: false,
      assetsLoaded: false,
      sseConnected: false,
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: loading }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('Loading conversations'), 'pre-snapshot renders the loading state')
    assert.ok(!container.textContent?.includes('No conversations yet'), 'never misreports unloaded as empty')

    // 资产 + SSE 双就绪且真实无会话：如实空态（区分真实空系统与筛选无命中）。
    const empty = overviewStore({
      conversations: [],
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: empty }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('No conversations yet'), 'a genuinely empty synced workspace shows the honest empty-system state')
    assert.ok(!container.textContent?.includes('Loading conversations'), 'loading never sticks once data is ready')

    // 有会话即卡片（即使 SSE 瞬时断连也保留快照，不闪加载）。
    const stale = overviewScenarioStore()
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: stale }, e(ConversationOverview)))
    })
    assert.ok(container.querySelectorAll('.overview-card').length > 0, 'cards render from the kept snapshot')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 移动端快捷导航簇徽标（sidebar.item badge：计数徽标 / 静默灯点 / 摘要 aria）
// ---------------------------------------------------------------------------

function quickNavItem(badge?: SidebarViewItem['badge']): SidebarViewItem {
  return {
    key: 'builtin:apps/app-center',
    pluginId: 'builtin:apps',
    label: 'App Center',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'builtin:apps', screenId: 'app-center' },
    badge,
  }
}

const QUIET_INDICATOR = {
  needsAttentionCount: 0,
  runningCount: 0,
  unreadDoneCount: 0,
  totalCount: 0,
  tone: null,
} as unknown as Parameters<typeof MobileQuickNav>[0]['indicator']

interface QuickNavMount {
  container: HTMLDivElement
  unmount(): Promise<void>
}

async function mountQuickNav(
  item: SidebarViewItem | null,
  badge: ResolvedSidebarBadge | null,
): Promise<QuickNavMount> {
  const store = overviewStore({ conversations: [conv({ id: 50 })] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(
      e(
        HelmxExternalStoreContext.Provider,
        { value: store },
        e(MobileQuickNav, { indicator: QUIET_INDICATOR, quickEntry: item, quickEntryBadge: badge }),
      ),
    )
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

test('MobileQuickNav: numeric badge, quiet dot, summary aria-label and zero noise', { timeout: 60_000 }, async () => {
  const restore = stubMatchMedia(true)
  const mounts: QuickNavMount[] = []
  try {
    // 计数徽标：tone 上色 + 计数 + 摘要进 title/aria
    const numeric = await mountQuickNav(quickNavItem(), { count: 4, tone: 'error', dot: false, summary: '2 awaiting review · 2 blocked' })
    mounts.push(numeric)
    const numericBtn = numeric.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')
    assert.ok(numericBtn !== null, 'the mobile quick entry button renders')
    assert.equal(numericBtn.getAttribute('aria-label'), 'App Center · 2 awaiting review · 2 blocked', 'the badge summary is appended to the accessible label')
    const badgeEl = numeric.container.querySelector<HTMLElement>('.mobile-quick-badge')
    assert.ok(badgeEl !== null, 'the numeric badge renders')
    assert.equal(badgeEl.getAttribute('data-tone'), 'error')
    assert.equal(badgeEl.textContent, '4')
    assert.ok(numeric.container.querySelector('.mobile-quick-dot') === null, 'no dot alongside a count badge')

    // 99+ 上限折叠
    const capped = await mountQuickNav(quickNavItem(), { count: 120, tone: 'warn', dot: false, summary: '' })
    mounts.push(capped)
    assert.equal(capped.container.querySelector('.mobile-quick-badge')?.textContent, '99+')

    // 静默灯点：无数字、tone accent、摘要仍进 aria
    const dotted = await mountQuickNav(quickNavItem(), { count: 0, tone: 'accent', dot: true, summary: '2 running quietly' })
    mounts.push(dotted)
    assert.ok(dotted.container.querySelector('.mobile-quick-dot') !== null, 'the quiet dot renders')
    assert.equal(dotted.container.querySelector('.mobile-quick-dot')?.getAttribute('data-tone'), 'accent')
    assert.ok(dotted.container.querySelector('.mobile-quick-badge') === null, 'no count badge in dot mode')
    assert.equal(dotted.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')?.getAttribute('aria-label'), 'App Center · 2 running quietly')

    // 无信号（null）：零徽标残留，label 原样
    const silent = await mountQuickNav(quickNavItem(), null)
    mounts.push(silent)
    assert.ok(silent.container.querySelector('.mobile-quick-badge') === null && silent.container.querySelector('.mobile-quick-dot') === null, 'zero badge residue when the badge is silent')
    assert.equal(silent.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')?.getAttribute('aria-label'), 'App Center')
  } finally {
    for (const mount of mounts.reverse()) await mount.unmount()
    restore()
  }
})

// ---------------------------------------------------------------------------
// 交互：批量管理（勾选/保护口径/归档/删除）、卡面操作菜单与紧凑元信息行
// ---------------------------------------------------------------------------

/** 总览批量/菜单交互的 fetch 桩：记录会话 PATCH（归档 tag）与 DELETE。 */
function installConversationMutationStub(): {
  patches: Array<{ id: number; tags?: string[] }>
  deletes: number[]
  restore: () => void
} {
  const original = globalThis.fetch
  const patches: Array<{ id: number; tags?: string[] }> = []
  const deletes: number[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = /^\/api\/conversations\/(\d+)$/.exec(url)
    const method = init?.method ?? 'GET'
    if (match !== null && method === 'PATCH') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { tags?: string[] })
      patches.push({ id: Number(match[1]), tags: body.tags })
      return new Response(JSON.stringify({ id: Number(match[1]), tags: body.tags ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (match !== null && method === 'DELETE') {
      deletes.push(Number(match[1]))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { patches, deletes, restore: () => { globalThis.fetch = original } }
}

async function mountOverview(store: HelmxExternalStore): Promise<{
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

async function overviewSettle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}

/** 批量场景：常规根 x2 + 托管根（sidebarSection filterTag 接管）+ bot 根。 */
function batchScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '常规根 A', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '常规根 B', profileId: 'coder', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '托管应用根', tags: ['app'], createdAt: 7000, updatedAt: 7000 }),
      conv({ id: 4, title: 'bot 会话根', ownedBy: 'bot', createdAt: 6000, updatedAt: 6000 }),
    ],
    primaryTarget: { kind: 'overview' },
    uiContributions: [
      {
        pluginId: 'builtin:apps',
        surface: 'sidebar.section' as const,
        spec: { id: 'app-conversations', label: { en: 'Apps' }, filterTag: 'app' },
      },
    ],
  })
}

function cardById(container: HTMLElement, id: number): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
    card.textContent?.includes(`#${id}`),
  )
}

test('ConversationOverview batch mode: card click toggles selection, managed/bot roots stay protected, exit clears', { timeout: 60_000 }, async () => {
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    const toggle = mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')
    assert.ok(toggle !== null, 'the toolbar renders the batch toggle')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'no batch bar before entering batch mode')
    await act(async () => {
      toggle.click()
    })
    assert.ok(mount.container.querySelector('.overview-batch-bar') !== null, 'entering batch mode renders the batch bar')

    const cards = [...mount.container.querySelectorAll<HTMLElement>('.overview-card')]
    assert.equal(cards.length, 4)
    for (const card of cards) {
      assert.ok(card.querySelector('.overview-card-batch-check') !== null, 'every card carries a batch checkbox')
    }
    // 保护口径与侧栏批量模式同界：托管（sidebarSection 接管）与 bot 根不可勾选。
    assert.equal(cardById(mount.container, 1)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, false)
    assert.equal(cardById(mount.container, 3)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, true, 'the managed root is not selectable')
    assert.equal(cardById(mount.container, 4)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, true, 'the bot root is not selectable')

    // 批量模式点击卡片 = 勾选（不打开会话抽屉）
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected'), 'clicking the card selects it')
    assert.equal(store.getNavSlice().activeModal, null, 'batch clicks never open the conversation drawer')
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected') === false, 'clicking again deselects')

    // 全选只覆盖可勾选卡片（常规根 A/B），托管与 bot 根保持未选。
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    assert.ok(selectAll !== null)
    await act(async () => {
      selectAll!.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected'))
    assert.ok(cardById(mount.container, 2)?.classList.contains('is-selected'))
    assert.ok(cardById(mount.container, 3)?.classList.contains('is-selected') === false)
    assert.ok(cardById(mount.container, 4)?.classList.contains('is-selected') === false)
    assert.ok(mount.container.textContent?.includes('2 selected'), 'the bar states the honest selection count')

    // 退出批量模式：清空勾选、恢复直达语义
    const exit = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Exit')
    assert.ok(exit !== null)
    await act(async () => {
      exit!.click()
    })
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'exit removes the batch bar')
    assert.ok(mount.container.querySelector('.overview-card-batch-check') === null, 'checkboxes disappear with batch mode')
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 1 },
      'normal mode restores the direct main-view navigation',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'normal mode never opens the drawer')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview batch archive PATCHes every selected root and exits batch mode', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    const archiveBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Archive (2)')
    assert.ok(archiveBtn !== null, 'the archive button reflects the selection count')
    await act(async () => {
      archiveBtn!.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id).sort(),
      [1, 2],
      'batch archive PATCHes exactly the selected human roots',
    )
    for (const patch of stub.patches) {
      assert.ok(patch.tags?.includes(ARCHIVED_TAG), `archive PATCH for #${patch.id} appends the host archive tag`)
    }
    assert.ok(store.getNotices().some((notice) => notice.title === 'Bulk Archive completed'), 'the batch outcome lands as a notice')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'a successful batch archive exits batch mode')
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview batch delete requires confirmation and DELETEs each selected root', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    const deleteBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent?.startsWith('Delete'))
    assert.ok(deleteBtn !== null)

    // 先取消：不发起任何 DELETE
    await act(async () => {
      deleteBtn!.click()
    })
    await overviewSettle()
    const dialog = document.querySelector('[role="alertdialog"]')
    assert.ok(dialog !== null, 'batch delete opens a confirmation dialog first')
    assert.ok(dialog.textContent?.includes('Delete 2 selected conversations?'), 'the confirm copy carries the count')
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Cancel')
    await act(async () => {
      cancel?.click()
    })
    await overviewSettle()
    assert.deepEqual(stub.deletes, [], 'cancelling the dialog issues no deletes')

    // 确认：逐会话 DELETE + 通知 + 退出批量模式
    await act(async () => {
      deleteBtn!.click()
    })
    await overviewSettle()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Delete conversation')
    assert.ok(confirm !== null)
    await act(async () => {
      confirm!.click()
    })
    await overviewSettle()
    assert.deepEqual([...stub.deletes].sort(), [1, 2], 'confirming DELETEs every selected root')
    assert.ok(store.getNotices().some((notice) => notice.title === 'Bulk delete completed'), 'the batch delete outcome lands as a notice')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'a successful batch delete exits batch mode')
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview card actions menu: archive and delete for human roots, none for protected roots', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    const humanCard = cardById(mount.container, 1)
    const botCard = cardById(mount.container, 4)
    const managedCard = cardById(mount.container, 3)
    assert.ok(humanCard?.querySelector('.overview-card-actions button') !== null, 'the human root card renders the "..." menu trigger')
    // bot 根：宿主归档/删除不参与，但只读视图动作（抽屉速览/右分屏）照常提供。
    assert.ok(botCard?.querySelector('.overview-card-actions button') !== null, 'the bot root card still renders the "..." menu (view-only actions)')

    // 菜单打开（Radix 挂 body）：归档 + 删除两项都在；托管根只有删除（面板同语义）。
    const trigger = humanCard?.querySelector<HTMLButtonElement>('.overview-card-actions button')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await overviewSettle()
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent ?? '')
    assert.ok(items.some((label) => label.includes('Archive conversation')), 'the card menu offers archive')
    assert.ok(items.some((label) => label.includes('Delete conversation')), 'the card menu offers delete')
    const archiveItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Archive conversation'))
    await act(async () => {
      archiveItem?.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id),
      [1],
      'archiving from the card menu PATCHes that root conversation',
    )
    assert.ok(stub.patches[0]?.tags?.includes(ARCHIVED_TAG))

    // 托管根：无归档项，仅删除项（人类自有可删除，与会话面板一致）
    const managedTrigger = managedCard?.querySelector<HTMLButtonElement>('.overview-card-actions button')
    assert.ok(managedTrigger !== null, 'the managed root still gets the menu (delete-only)')
    await act(async () => {
      managedTrigger!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await overviewSettle()
    const managedItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent ?? '')
    assert.ok(managedItems.some((label) => label.includes('Delete conversation')), 'delete stays available for the managed root')
    assert.ok(
      managedItems.every((label) => !label.includes('Archive conversation')),
      'archive is not offered for a managed root (no visible effect)',
    )
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

// ---------------------------------------------------------------------------
// 交互：搜索、无结果语义与清除筛选、+N 展开、卡片语义可访问性
// ---------------------------------------------------------------------------

test('ConversationOverview search box narrows by title/summary and rides the q route param with a clear button', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const input = mount.container.querySelector<HTMLInputElement>('.overview-search-box input')
    assert.ok(input !== null, 'the toolbar renders the search input')
    assert.equal(input.getAttribute('aria-label'), 'Search overview by title or summary')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3)
    // React 受控输入需绕过原生 value setter 才能触发 onChange（与 ask-dock 同法）。
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, '调研')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'the query narrows the grid')
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('在跑的调研'))
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { q: '调研' } },
      'the query persists into the q route param',
    )
    assert.ok(mount.container.textContent?.includes('1 of 3 trees'), 'the stats line states visible over total')
    const clear = mount.container.querySelector<HTMLButtonElement>('.overview-search-clear')
    assert.ok(clear !== null, 'a non-empty query renders the clear button')
    await act(async () => {
      clear.click()
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'clearing deletes the q param')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3, 'the grid restores')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview empty semantics: filtered no-match offers clear filters; a truly empty system stays distinct', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      store.setScreenParams({ q: '不存在的词' }, {})
    })
    await overviewSettle()
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 0)
    assert.ok(mount.container.textContent?.includes('No conversations match'), 'the filtered empty state points at the filters')
    assert.ok(!mount.container.textContent?.includes('No conversations yet'), 'never misreports a filter miss as an empty system')
    const clearBtn = mount.container.querySelector<HTMLButtonElement>('.overview-clear-filters')
    assert.ok(clearBtn !== null, 'the clear-filters entry renders')
    assert.equal(clearBtn.textContent, 'Clear filters')
    await act(async () => {
      clearBtn.click()
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'clearing drops every filter param at once')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3, 'all trees return')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview +N more is a real entry: expanding reveals the remaining descendants in the same deterministic order', { timeout: 60_000 }, async () => {
  const conversations = [
    conv({ id: 1, title: '多子代理任务', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    ...Array.from({ length: 7 }, (_, index) =>
      conv({ id: 11 + index, parentConversationId: 1, title: `子任务 ${index + 1}`, status: 'idle', createdAt: 9100 + index }),
    ),
  ]
  const store = overviewStore({ conversations, primaryTarget: { kind: 'overview' } })
  const mount = await mountOverview(store)
  try {
    const chips = mount.container.querySelectorAll('.overview-chip')
    assert.equal(chips.length, OVERVIEW_DESCENDANT_LIMIT, 'the collapsed card shows exactly the capped slice')
    const collapsedLabels = [...chips].map((chip) => chip.querySelector('.overview-chip-label')?.textContent ?? '')
    const more = mount.container.querySelector<HTMLButtonElement>('.overview-chip-more')
    assert.ok(more !== null, 'the +N affordance renders as a real button')
    assert.equal(more.tagName, 'BUTTON')
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(more.textContent, '+2 more', 'the hidden count stays honest')
    await act(async () => {
      more.click()
    })
    const expandedChips = mount.container.querySelectorAll('.overview-chip')
    assert.equal(expandedChips.length, 7, 'expanding reveals every descendant in-card')
    const expandedLabels = [...expandedChips].map((chip) => chip.querySelector('.overview-chip-label')?.textContent ?? '')
    // 折叠切片是展开列表的前缀（同一确定性排序，展开仅补齐不重排）。
    assert.deepEqual(expandedLabels.slice(0, OVERVIEW_DESCENDANT_LIMIT), collapsedLabels, 'expanding appends in the same deterministic order, never reshuffles')
    const collapse = mount.container.querySelector<HTMLButtonElement>('.overview-chip-more')
    assert.equal(collapse?.getAttribute('aria-expanded'), 'true')
    assert.equal(collapse?.textContent, 'Show less')
    const navTarget = store.getNavSlice().primaryTarget
    assert.ok(navTarget.kind === 'overview' && navTarget.params === undefined, 'expansion is card-local UI state and never enters the URL')
    await act(async () => {
      collapse?.click()
    })
    assert.equal(mount.container.querySelectorAll('.overview-chip').length, OVERVIEW_DESCENDANT_LIMIT, 'collapsing restores the capped slice')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview card semantics: the open action is a real button with readable status label; keyboard Enter opens; batch mode carries aria-pressed', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const cards = mount.container.querySelectorAll('.overview-card')
    assert.ok(cards.length === 3)
    const card = [...cards].find((el) => el.textContent?.includes('在跑的调研'))
    assert.ok(card !== undefined, 'the working-root card renders')
    const open = card.querySelector<HTMLButtonElement>('.overview-card-open')
    assert.ok(open !== null, 'the title cluster renders as a real semantic button')
    assert.equal(open.tagName, 'BUTTON')
    assert.equal(card.querySelectorAll('button button').length, 0, 'no interactive control is ever nested inside another button')
    // 可访问名称来自按钮内容：状态灯的 aria-label（真实运行事实）与标题。
    const light = open.querySelector('.nav-status-slot [aria-label]')
    assert.ok(light !== null, 'the status light carries a readable label inside the semantic entry')
    assert.ok((light.getAttribute('aria-label') ?? '').length > 0)
    assert.ok(open.textContent?.includes('在跑的调研'))
    assert.equal(open.getAttribute('aria-pressed'), null, 'normal mode never fakes a pressed state')
    // 原生按钮 = 键盘契约本体（Tab 可达、Enter/Space 由浏览器激活）；
    // happy-dom 不合成按键激活，这里断言可聚焦与默认 Tab 序，点击语义另行验证。
    assert.equal(open.disabled, false, 'the semantic entry stays focusable in the default tab order')
    open.focus()
    assert.equal(document.activeElement === open, true, 'the button takes focus')
    await act(async () => {
      open.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 2 },
      'the semantic button navigates exactly like a whole-card click',
    )
    // 批量模式：同一按钮承载勾选语义（aria-pressed），整卡点击仍是勾选。
    const toggle = mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')
    await act(async () => {
      toggle?.click()
    })
    const batchOpen = mount.container.querySelector<HTMLButtonElement>('.overview-card-open')
    assert.equal(batchOpen?.getAttribute('aria-pressed'), 'false', 'batch mode exposes the toggle state')
    await act(async () => {
      batchOpen?.click()
    })
    assert.equal(mount.container.querySelector<HTMLElement>('.overview-card')?.classList.contains('is-selected'), true)
    assert.equal(mount.container.querySelector<HTMLButtonElement>('.overview-card-open')?.getAttribute('aria-pressed'), 'true')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview batch boundary: selection stays within the visible selectable cards as filters change', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    assert.ok(mount.container.textContent?.includes('2 selected'), 'both visible human roots are selected')

    // 收窄筛选：常规根 A 出局（assistant），选择集合立即收敛到可见项。
    await act(async () => {
      store.setScreenParams({ profile: 'coder' }, {})
    })
    await overviewSettle()
    assert.ok(mount.container.textContent?.includes('1 selected'), 'hidden selections drop out immediately')
    assert.equal(cardById(mount.container, 2)?.classList.contains('is-selected'), true, 'the still-visible selection survives')
    const archiveBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent?.startsWith('Archive'))
    assert.ok(archiveBtn?.textContent === 'Archive (1)', 'the action labels reflect the effective selection')
    await act(async () => {
      archiveBtn?.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id),
      [2],
      'batch archive only ever touches the visible selected card (never the hidden one)',
    )
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview compact meta line: profile, remote node and summary share one row', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({
        id: 9,
        title: '远端调研',
        profileId: 'coder',
        nodeId: 'remote-1',
        status: 'working',
        doing: 'researching docs',
        createdAt: 9000,
        updatedAt: 9000,
      }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const card = mount.container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null)
    const sub = card.querySelector<HTMLElement>('.overview-card-sub')
    assert.ok(sub !== null, 'the meta line renders')
    assert.ok(sub.textContent?.includes('编码专员'), 'the agent label rides the meta line')
    assert.ok(sub.textContent?.includes('@remote-1'), 'the remote node folds into the same line (no dedicated row)')
    assert.ok(sub.textContent?.includes('researching docs'), 'the honest summary still shares the line')
    assert.ok(mount.container.querySelector('.overview-card-node') === null, 'the old dedicated node line is gone')
    assert.equal(sub.querySelectorAll('.overview-card-sub > *').length, 5, 'profile + sep + node + sep + summary = five inline parts')
  } finally {
    await mount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 并发主入口：顶栏新话题（单候选直进 / 多候选下拉选角 / 无候选不渲染）
// ---------------------------------------------------------------------------

test('ConversationOverview new topic: the only creatable agent gets a direct standby button', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'coder', name: '编码专员' }],
    conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const btn = mount.container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    assert.ok(btn !== null, 'a single creatable agent renders the direct new-topic button')
    assert.ok(btn.getAttribute('aria-haspopup') === null, 'a single candidate never opens a dropdown')
    assert.ok(mount.container.textContent?.includes('New topic'), 'the button reuses the shared new-topic copy')
    await act(async () => {
      btn.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'agent', profileId: 'coder' },
      'clicking the button opens the agent standby (first send persists the conversation)',
    )
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview new topic: multiple agents open a dropdown with the latest-active agent first and @node suffixes', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '最近的助手会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '远端编码会话', profileId: 'coder', nodeId: 'lx', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const trigger = mount.container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    assert.ok(trigger !== null, 'multiple creatable agents render the new-topic dropdown trigger')
    assert.ok(trigger.getAttribute('aria-haspopup') === 'menu', 'the trigger announces its menu')
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) =>
      el.closest('.helmx-dropdown-content') !== null,
    )
    assert.ok(items.length === 2, 'the dropdown lists every creatable agent')
    assert.ok(items[0]!.textContent?.includes('个人助理'), 'the latest-active root conversation owner leads the list')
    assert.ok(items[1]!.textContent?.includes('编码专员') && items[1]!.textContent?.includes('@lx'), 'the remote agent carries its @node suffix')
    await act(async () => {
      items[1]!.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'agent', profileId: 'coder' },
      'picking an agent opens its standby page',
    )
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview new topic: no creatable agent renders no button', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'bot1', name: '机器人', humanSelectable: false }],
    conversations: [conv({ id: 4, title: 'bot 会话根', ownedBy: 'bot', createdAt: 6000, updatedAt: 6000 })],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    assert.ok(mount.container.querySelector('.overview-newtopic-btn') === null, 'no creatable agent: zero new-topic residue')
  } finally {
    await mount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 并发主入口：托管/受保护卡的 `...` 菜单仍提供只读视图动作；分屏实例直进同侧
// ---------------------------------------------------------------------------

test('ConversationOverview managed card keeps the view-only menu actions (peek + right split)', { timeout: 60_000 }, async () => {
  const appSection = {
    pluginId: 'builtin:apps',
    surface: 'sidebar.section' as const,
    spec: { id: 'app-runs', label: { en: 'App runs' }, icon: 'check-square', filterTag: 'app' },
  }
  // bot 归属的托管根：宿主归档/删除均不参与——菜单只剩两个只读视图动作
  // （prepend-only 分支：无分隔线、无后续宿主动作）。
  const store = overviewStore({
    conversations: [
      conv({ id: 7, title: '应用会话', profileId: 'assistant', ownedBy: 'bot', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
    ],
    primaryTarget: { kind: 'overview' },
    uiContributions: [appSection],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const menuTrigger = container.querySelector<HTMLButtonElement>('.overview-card-actions button')
    assert.ok(menuTrigger !== null, 'the managed card still renders its actions menu (prepend view actions)')
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) =>
      el.closest('.helmx-dropdown-content') !== null,
    )
    assert.ok(items.length === 2, 'the managed card menu carries exactly the two read-only view actions')
    assert.ok(items[0]!.textContent?.includes('Peek in drawer'), 'drawer peek survives on managed cards')
    assert.ok(items[1]!.textContent?.includes('Open in right split'), 'right split survives on managed cards')
    assert.ok(document.querySelectorAll('[role="separator"]').length === 0, 'nothing follows the prepend actions: no separator, no host archive')
    await act(async () => {
      items[0]!.click()
    })
    assert.deepEqual(
      store.getNavSlice().activeModal,
      { kind: 'conversation-drawer', conversationId: 7 },
      'drawer peek works on managed cards',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview split instance navigates conversations into the same split pane', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: [conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 })],
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
    splitTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview, { isSplit: true })))
    })
    const card = container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null, 'the split overview renders its card grid')
    const newTopicBtn = container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    await act(async () => {
      card.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'conversation', conversationId: 1 },
      'clicking a card inside the split overview navigates the same split pane',
    )
    assert.ok(store.getNavSlice().primaryTarget.kind === 'agent', 'the main pane stays untouched')
    await act(async () => {
      newTopicBtn?.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'agent', profileId: 'assistant' },
      'the new-topic button also opens standby inside the same split pane',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})
