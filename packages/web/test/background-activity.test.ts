/**
 * 侧栏「会话后台在途」模型与渲染测试（单灯语义）：
 * - 纯函数层 summarizeConversationBackgroundActivity / collectBackgroundBadgeDocs /
 *   resolveStandingStatusIndicator / resolveStatusLight / backgroundAwareStatusTooltip
 *   的契约（tone=accent 才在途、neutral 历史计数与 warn 失败不误报、全局角标
 *   不参与、scope 过滤、插件贡献/doc 缺失归零、非 primary 会话后台活跃透出到
 *   一级站位行、error > blocked > working 优先级）；
 * - 单灯优先级：working/blocked/error 主会话状态灯独占（不渲染后台空心环、
 *   tooltip 不叠加后台摘要）；idle/done + 后台在途仅渲染空心环（done 绿点让位）；
 *   无后台在途保持五态原样；
 * - Sidebar SSR 渲染：会话行/折叠站位行/sidebar.section 分组行均只有一个灯，
 *   展开态站位行不重复显示、子会话行各自一个灯；
 * - 挂载路径：badge doc 经 Sidebar effect 按需 ensurePluginDoc（纯函数零副作用）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary, PluginUiContribution, WorkbenchPanelSpec } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { conversationStatusDotClass, conversationStatusTooltip } from '../src/shell/sidebar-model.js'
import {
  backgroundAwareStatusTooltip,
  collectBackgroundBadgeDocs,
  resolveStandingStatusIndicator,
  resolveStatusLight,
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from '../src/shell/background-activity-model.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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

const WORKFLOW_PANEL_SPEC: WorkbenchPanelSpec = {
  id: 'tasks',
  label: '工作流与子代理',
  badge: { doc: 'run-badges', byConversationField: 'byConversation' },
}

function panelContribution(
  overrides: { pluginId?: string; spec?: Partial<WorkbenchPanelSpec> } = {},
): PluginUiContribution {
  return {
    pluginId: overrides.pluginId ?? 'builtin:workflow',
    surface: 'workbench.panel',
    spec: { ...WORKFLOW_PANEL_SPEC, ...overrides.spec },
  }
}

function badgesDoc(
  entries: Record<string, { count: number; tone?: string; footerText?: string }>,
): Record<string, unknown> {
  return { byConversation: entries }
}

function summarize(input: {
  contributions?: PluginUiContribution[]
  conversations: ConversationSummary[]
  pluginDocs?: Record<string, unknown>
}) {
  return summarizeConversationBackgroundActivity({
    panels: groupUiContributions(input.contributions ?? [panelContribution()]).workbenchPanels,
    conversations: input.conversations,
    pluginDocs: input.pluginDocs ?? {},
  })
}

// ---------------------------------------------------------------------------
// 纯函数层：在途判定契约
// ---------------------------------------------------------------------------

test('tone=accent 的按会话角标判定在途并汇入 footerText；缺 footerText 仍为在途', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, status: 'idle' }), conv({ id: 2, status: 'done' })]
  const index = summarize({
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 运行中' },
        '2': { count: 1, tone: 'accent' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 运行中' })
  assert.deepEqual(index.get(2), { active: true, summary: '' })
})

test('neutral 历史计数与 warn 失败汇总都不误报为在途', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 }), conv({ id: 2 }), conv({ id: 3 })]
  const index = summarize({
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 7, tone: 'neutral', footerText: '7 条历史' },
        '2': { count: 3, tone: 'warn', footerText: '1 失败' },
      }),
    },
  })
  assert.equal(index.size, 0, 'neutral/warn 条目不得点亮任何会话在途')
})

test('tone=accent 且 count=0 仍按色调判在途（count 含历史，不参与判定）', { timeout: 60_000 }, () => {
  const index = summarize({
    conversations: [conv({ id: 1 })],
    pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 0, tone: 'accent' } }) },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '' })
})

test('全局角标（无 byConversationField）不参与会话在途，也不触发 doc 加载', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const contributions = [
    panelContribution({ spec: { badge: { doc: 'global-count', countField: 'total', toneField: 'tone' } } }),
  ]
  const index = summarize({
    contributions,
    conversations,
    pluginDocs: { 'builtin:workflow/global-count': { total: 5, tone: 'accent' } },
  })
  assert.equal(index.size, 0, '全局 accent 角标无法归属会话，不得点亮任何会话行')
  const docs = collectBackgroundBadgeDocs(groupUiContributions(contributions).workbenchPanels, conversations)
  assert.deepEqual(docs, [])
})

test('插件贡献缺失（停用）或 doc 未加载时摘要归零', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  assert.equal(summarize({ contributions: [], conversations }).size, 0)
  assert.equal(summarize({ conversations, pluginDocs: {} }).size, 0)
  // doc 已加载但缺该会话条目：同样无在途
  assert.equal(
    summarize({ conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '9': { count: 1, tone: 'accent' } }) } }).size,
    0,
  )
})

test('scope 未命中的会话不参与摘要，对应面板也不收集 doc 引用', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, profileId: 'assistant' })]
  const contributions = [
    panelContribution({ spec: { scope: { profileIds: ['superagent'] } } }),
  ]
  const panels = groupUiContributions(contributions).workbenchPanels
  assert.equal(summarize({ contributions, conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent' } }) } }).size, 0)
  assert.deepEqual(collectBackgroundBadgeDocs(panels, conversations), [])
  // scope 命中（无 scope = 不限）时收集去重后的 doc 引用
  assert.deepEqual(collectBackgroundBadgeDocs(groupUiContributions([panelContribution()]).workbenchPanels, conversations), [
    { pluginId: 'builtin:workflow', doc: 'run-badges' },
  ])
})

test('多面板聚合：footerText 去重后拼接，在途取并集', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const index = summarize({
    contributions: [panelContribution(), panelContribution({ pluginId: 'builtin:other', spec: { id: 'jobs' } })],
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 运行中' } }),
      'builtin:other/run-badges': badgesDoc({
        '1': { count: 3, tone: 'accent', footerText: '2 运行中' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 运行中' })
})

// ---------------------------------------------------------------------------
// 纯函数层：一级站位聚合、单灯优先级与 tooltip 组合
// ---------------------------------------------------------------------------

test('站位聚合优先级 error > blocked > working；并列取列表首个（primary 置顶序）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'working', updatedAt: 9000 }),
    conv({ id: 2, status: 'blocked' }),
    conv({ id: 3, status: 'error' }),
  ]
  const indicator = resolveStandingStatusIndicator(conversations, new Map())
  assert.equal(indicator?.representative.id, 3)

  const tie = [conv({ id: 1, status: 'working', updatedAt: 9000 }), conv({ id: 2, status: 'working' })]
  assert.equal(resolveStandingStatusIndicator(tie, new Map())?.representative.id, 1)

  // 无高优先级状态：代表会话保持列表首个（与旧「看 primary」行为兼容）
  const idle = [conv({ id: 1, updatedAt: 9000 }), conv({ id: 2, status: 'done' })]
  assert.equal(resolveStandingStatusIndicator(idle, new Map())?.representative.id, 1)

  assert.equal(resolveStandingStatusIndicator([], new Map()), null)
})

test('后台在途来自非 primary 会话也能透出，摘要跨会话去重', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', updatedAt: 9000 }),
    conv({ id: 2, status: 'idle' }),
    conv({ id: 3, status: 'idle' }),
  ]
  const background: ConversationBackgroundIndex = new Map([
    [2, { active: true, summary: '1 运行中' }],
    [3, { active: true, summary: '1 运行中' }],
  ])
  const indicator = resolveStandingStatusIndicator(conversations, background)
  assert.equal(indicator?.representative.id, 1, '代表会话仍为 primary')
  assert.equal(indicator?.backgroundActive, true, '非 primary 会话的后台在途必须透出')
  assert.equal(indicator?.backgroundSummary, '1 运行中', '相同 footerText 跨会话去重')
})

test('resolveStatusLight 单灯优先级：主状态独占灯位，idle/done 让位后台空心环', { timeout: 60_000 }, () => {
  // working/blocked/error：主会话状态灯独占，后台在途完全不参与灯位
  for (const status of ['working', 'blocked', 'error'] as const) {
    assert.deepEqual(
      resolveStatusLight(status, true),
      { dotClass: conversationStatusDotClass(status), background: false },
      `${status} 状态灯必须独占，不渲染后台空心环`,
    )
  }
  // idle/done + 后台在途：仅空心环（idle 的无灯与 done 的绿点让位）
  assert.deepEqual(resolveStatusLight('idle', true), { dotClass: 'status-dot status-dot-background', background: true })
  assert.deepEqual(resolveStatusLight('done', true), { dotClass: 'status-dot status-dot-background', background: true })
  // 无后台在途：保持五态原样
  assert.deepEqual(resolveStatusLight('working', false), { dotClass: 'status-dot status-dot-working', background: false })
  assert.deepEqual(resolveStatusLight('done', false), { dotClass: 'status-dot status-dot-done', background: false })
  assert.deepEqual(resolveStatusLight('idle', false), { dotClass: null, background: false })
})

test('tooltip 组合：状态灯独占时只陈述主回合；空心环灯位叠加基础状态 + 后台摘要', { timeout: 60_000 }, () => {
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: false }),
    conversationStatusTooltip('idle'),
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: true, backgroundSummary: '2 运行中' }),
    '空闲 · 后台任务: 2 运行中',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'done', backgroundActive: true, backgroundSummary: '' }),
    '已完成 · 后台任务运行中',
  )
  // working/blocked/error：即使后台在途，tooltip 也只显示主会话状态/doing/lastError
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'working', doing: '正在思考方案', backgroundActive: true, backgroundSummary: '2 运行中' }),
    '运行中: 正在思考方案',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'blocked', backgroundActive: true, backgroundSummary: '2 运行中' }),
    '待确认',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: true }),
    '异常: model_error: x',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: false }),
    '异常: model_error: x',
  )
})

// ---------------------------------------------------------------------------
// Sidebar 渲染：会话行与折叠站位行的单灯位
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function sidebarStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  return makeTestStore({
    profiles: BASE_PROFILES,
    ...overrides,
  })
}

function renderSidebar(store: HelmStoreValue): string {
  return renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))
}

/** 统计会话状态灯数量（排除 ActivityRail 的 SSE 连接点 status-dot-connected）。 */
function countStatusLights(html: string): number {
  return (
    html.match(/class="status-dot(?: status-dot-(?:working|blocked|done|error|background))?"/g) ?? []
  ).length
}

test('working/blocked/error 会话 + 后台在途：只渲染主会话状态灯，无 background class', { timeout: 60_000 }, () => {
  for (const [status, dotClass] of [
    ['working', 'status-dot-working'],
    ['blocked', 'status-dot-blocked'],
    ['error', 'status-dot-error'],
  ] as const) {
    const store = sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '主会话',
          profileId: 'assistant',
          status,
          doing: status === 'working' ? '正在思考方案' : undefined,
          lastError: status === 'error' ? 'model_error: boom' : undefined,
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      groupedUi: groupUiContributions([panelContribution()]),
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 3, tone: 'accent', footerText: '3 运行中' } }),
      },
    })
    const html = renderSidebar(store)
    assert.ok(html.includes(`class="status-dot ${dotClass}"`), `${status} 主会话状态灯保留`)
    assert.ok(!html.includes('status-dot-background'), `${status} 状态灯独占，不渲染后台空心环`)
    assert.ok(!html.includes('后台任务'), `${status} tooltip 不叠加后台摘要`)
    assert.equal(countStatusLights(html), 1, `${status} 折叠站位行只有一个灯`)
  }
})

test('idle 会话 + 后台在途：仅渲染后台空心环，tooltip 陈述空闲 + 后台摘要', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 运行中' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), '应渲染后台在途空心环')
  assert.ok(html.includes('title="空闲 · 后台任务: 2 运行中"'), 'tooltip 同时陈述基础状态与后台摘要')
  assert.ok(!html.includes('status-dot-working'), 'idle + 后台在途不得冒充会话自身 working')
  assert.equal(countStatusLights(html), 1, '折叠站位行只有一个灯')
})

test('done 会话 + 后台在途：绿点让位，仅渲染后台空心环', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent', footerText: '1 运行中' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), '后台在途空心环为唯一灯位')
  assert.ok(!html.includes('class="status-dot status-dot-done"'), 'done 绿点必须让位，不得与空心环并列')
  assert.ok(html.includes('title="已完成 · 后台任务: 1 运行中"'), 'tooltip 陈述已完成 + 后台摘要')
  assert.equal(countStatusLights(html), 1, '折叠站位行只有一个灯')
})

test('无后台在途：保持五态原样（done 绿点、idle 无灯）', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '闲置话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 5, tone: 'neutral', footerText: '5 条历史' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-done"'), '无在途时 done 保持绿点')
  assert.ok(!html.includes('status-dot-background'), 'neutral 历史计数不得点亮空心环')
  assert.equal(countStatusLights(html), 1, 'done 会话一个灯，idle 会话无灯')
})

test('展开态：站位行不重复显示指示，每个子会话行各自一个灯', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 3, title: '失败话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 1, tone: 'accent', footerText: '1 运行中' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('agent-conversations-list'), '当前智能体展开话题子列表')
  assert.ok(html.includes('title="空闲 · 后台任务: 1 运行中"'), 'idle 子会话行展示后台空心环')
  assert.ok(html.includes('class="status-dot status-dot-error"'), 'error 子会话行展示自身状态灯')
  assert.ok(html.includes('class="status-dot status-dot-done"'), 'done 子会话行保持绿点')
  // 三个子会话行各一个灯（done 绿点 / 后台空心环 / error 状态灯），站位行不重复
  assert.equal(countStatusLights(html), 3, '展开态每个子会话行恰好一个灯，站位行不显示')
  assert.equal(
    (html.match(/status-dot-background/g) ?? []).length,
    1,
    '后台空心环只在对应子会话行显示一次',
  )
})

test('折叠站位行：非 primary 后台在途 + 代表会话 working/blocked/error 时隐藏后台环', { timeout: 60_000 }, () => {
  // primary idle + 次会话 error：站位行透出 error（代表会话 = 次会话）
  const errorStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '失败话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const errorHtml = renderSidebar(errorStore)
  assert.ok(errorHtml.includes('class="status-dot status-dot-error"'), '次要会话 error 必须透出')
  assert.ok(errorHtml.includes('title="异常: model_error: boom"'))
  assert.ok(!errorHtml.includes('status-dot-background'), '无在途徽章时不渲染空心环')

  // primary idle + 次会话后台在途 + 另一次会话 blocked：状态灯独占，隐藏整个站位的后台环
  const blockedStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 3, title: '阻塞话题', profileId: 'assistant', status: 'blocked' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 4, tone: 'accent', footerText: '4 运行中' } }),
    },
  })
  const blockedHtml = renderSidebar(blockedStore)
  assert.ok(blockedHtml.includes('class="status-dot status-dot-blocked"'), '代表会话 blocked 状态灯透出')
  assert.ok(!blockedHtml.includes('status-dot-background'), '代表状态 blocked 时隐藏整个站位的后台环')
  assert.ok(!blockedHtml.includes('后台任务'), 'tooltip 只显示代表会话状态')
})

test('折叠站位行：代表会话 idle/done 时仅渲染一个后台空心环（非 primary 后台透出）', { timeout: 60_000 }, () => {
  // primary idle + 次会话后台在途：站位行仅一个空心环（代表会话仍为 primary）
  const idleStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 4, tone: 'accent', footerText: '4 运行中' } }),
    },
  })
  const idleHtml = renderSidebar(idleStore)
  assert.ok(idleHtml.includes('class="status-dot status-dot-background"'), '非 primary 会话的后台在途透出到站位行')
  assert.ok(idleHtml.includes('title="空闲 · 后台任务: 4 运行中"'))
  assert.equal(countStatusLights(idleHtml), 1, '站位行只有一个后台空心环，无并列基础圆点')

  // primary done + 次会话后台在途：done 绿点让位，同样仅一个空心环
  const doneStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 2, tone: 'accent', footerText: '2 运行中' } }),
    },
  })
  const doneHtml = renderSidebar(doneStore)
  assert.ok(!doneHtml.includes('class="status-dot status-dot-done"'), '代表 done 绿点让位')
  assert.ok(doneHtml.includes('class="status-dot status-dot-background"'), '仅渲染后台空心环')
  assert.ok(doneHtml.includes('title="已完成 · 后台任务: 2 运行中"'))
  assert.equal(countStatusLights(doneHtml), 1, '站位行只有一个后台空心环')
})

test('sidebar.section 分组会话行同样遵守单灯语义', { timeout: 60_000 }, () => {
  // idle + 后台在途：仅空心环
  const idleStore = sidebarStore({
    conversations: [
      conv({ id: 20, title: 'Worker A', profileId: 'coder', tags: ['worker'], status: 'idle' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([
      panelContribution(),
      { pluginId: 'builtin:superagent', surface: 'sidebar.section', spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' } },
    ]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '20': { count: 1, tone: 'accent', footerText: '1 运行中' } }),
    },
  })
  const idleHtml = renderSidebar(idleStore)
  assert.ok(idleHtml.includes('后台 Worker'), '分组渲染')
  assert.ok(idleHtml.includes('title="空闲 · 后台任务: 1 运行中"'), '分组会话行空心环 + 摘要')

  // working + 后台在途：仅主状态灯，无 background class
  const workingStore = sidebarStore({
    conversations: [
      conv({ id: 20, title: 'Worker A', profileId: 'coder', tags: ['worker'], status: 'working', doing: '执行任务' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([
      panelContribution(),
      { pluginId: 'builtin:superagent', surface: 'sidebar.section', spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' } },
    ]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '20': { count: 1, tone: 'accent', footerText: '1 运行中' } }),
    },
  })
  const workingHtml = renderSidebar(workingStore)
  assert.ok(workingHtml.includes('class="status-dot status-dot-working"'), '分组会话行主状态灯保留')
  assert.ok(!workingHtml.includes('status-dot-background'), '分组会话行不与后台空心环并列')
  assert.ok(!workingHtml.includes('后台任务'), 'tooltip 不叠加后台摘要')
})

test('插件停用（贡献消失）或仅剩 neutral 历史计数时无任何在途指示', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 50, title: '别处', profileId: 'coder' }),
  ]
  const common = { conversations, primaryTarget: { kind: 'conversation' as const, conversationId: 50 } }
  const disabled = renderSidebar(sidebarStore({ ...common, groupedUi: groupUiContributions([]), pluginDocs: {} }))
  assert.ok(!disabled.includes('status-dot-background'), '贡献消失（停用）后指示立即消失')
  const neutral = renderSidebar(
    sidebarStore({
      ...common,
      groupedUi: groupUiContributions([panelContribution()]),
      pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 9, tone: 'neutral', footerText: '9 条历史' } }) },
    }),
  )
  assert.ok(!neutral.includes('status-dot-background'), 'neutral 历史计数不得误报在途')
})

// ---------------------------------------------------------------------------
// 挂载路径：badge doc 经 Sidebar effect 按需加载（纯函数零副作用）
// ---------------------------------------------------------------------------

test('Sidebar 挂载后按需 ensurePluginDoc 加载命中面板的 badge doc', { timeout: 60_000 }, async () => {
  const loaded: Array<{ pluginId: string; doc: string }> = []
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: groupUiContributions([panelContribution()]),
    ensurePluginDoc: async (pluginId: string, docName: string) => {
      loaded.push({ pluginId, doc: docName })
      return undefined
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))
  })
  assert.deepEqual(loaded, [{ pluginId: 'builtin:workflow', doc: 'run-badges' }])
  await act(async () => {
    root?.unmount()
  })
  container.remove()
})
