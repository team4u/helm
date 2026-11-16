/**
 * 侧栏「会话后台在途」模型与渲染测试（单灯语义）：
 * - 纯函数层 summarizeConversationBackgroundActivity / collectBackgroundBadgeDocs /
 *   resolveStandingStatusIndicator / resolveStatusLight / backgroundAwareStatusTooltip
 *   的契约（tone=accent 才在途、neutral 历史计数与 warn 失败不误报、全局角标
 *   不参与、scope 过滤、插件贡献/doc 缺失归零、非 primary 会话后台活跃透出到
 *   一级站位行、error > blocked > working > done > idle 优先级）；
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
  resolveAgentSubListPreview,
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

test('contextUsage.compacting=true 判定会话后台在途并合并「上下文精简中」（支持与面板角标去重拼接）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
    conv({ id: 2, status: 'done', contextUsage: { tokens: null, compacting: true } }),
    conv({ id: 3, status: 'idle', contextUsage: { tokens: 800, compacting: false } }),
    conv({ id: 4, status: 'done' }),
  ]
  const index = summarize({
    contributions: [],
    conversations,
  })
  assert.deepEqual(index.get(1), { active: true, summary: '上下文精简中' })
  assert.deepEqual(index.get(2), { active: true, summary: '上下文精简中' })
  assert.equal(index.get(3), undefined, 'compacting=false 不得标为在途')
  assert.equal(index.get(4), undefined, '无 compacting 字段不得标为在途')

  const combined = summarize({
    conversations: [
      conv({ id: 1, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
      conv({ id: 2, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
    ],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 运行中' },
        '2': { count: 1, tone: 'accent', footerText: '上下文精简中' },
      }),
    },
  })
  assert.deepEqual(combined.get(1), { active: true, summary: '2 运行中 · 上下文精简中' })
  assert.deepEqual(combined.get(2), { active: true, summary: '上下文精简中' })
})

// ---------------------------------------------------------------------------
// 纯函数层：一级站位聚合、单灯优先级与 tooltip 组合
// ---------------------------------------------------------------------------

test('Agent 子列表折叠预览始终保留当前会话与在途会话', { timeout: 60_000 }, () => {
  const conversations = Array.from({ length: 8 }, (_, index) => conv({ id: index + 1 }))
  conversations[5] = conv({ id: 6, status: 'working' })
  conversations[6] = conv({ id: 7, status: 'idle' })
  conversations[7] = conv({ id: 8, status: 'done' })
  const preview = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: 8,
    background: new Map([[7, { active: true, summary: '工作流运行中' }]]),
  })
  assert.deepEqual(preview.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(preview.hiddenCount, 0)

  const activePreview = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: 8,
    background: new Map(),
  })
  assert.equal(activePreview.visible.length, conversations.length, '既有行为：激活会话超出预览时展开整组')

  const idlePreview = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: null,
    background: new Map(),
  })
  assert.deepEqual(idlePreview.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6])
  assert.equal(idlePreview.hiddenCount, 2)
  assert.equal(resolveAgentSubListPreview({ conversations, showAll: true, activeId: null, background: new Map() }).hiddenCount, 0)

  // 折叠预览保留正在上下文精简的会话（即使处于闲置态且位于第 6 条之后）
  const compactingConvs = Array.from({ length: 8 }, (_, index) => conv({ id: index + 1 }))
  compactingConvs[6] = conv({ id: 7, status: 'idle', contextUsage: { tokens: 1500, compacting: true } })
  const compactingBg = summarize({ contributions: [], conversations: compactingConvs })
  const compactingPreview = resolveAgentSubListPreview({
    conversations: compactingConvs,
    showAll: false,
    activeId: null,
    background: compactingBg,
  })
  assert.deepEqual(compactingPreview.visible.map((item) => item.id), [1, 2, 3, 4, 5, 7])
  assert.equal(compactingPreview.hiddenCount, 2)
})

test('resolveAgentSubListPreview：activeIds 中任一会话超出预览条数时整组展开（分屏保护）', { timeout: 60_000 }, () => {
  const conversations = Array.from({ length: 8 }, (_, index) => conv({ id: index + 1 }))

  // 主屏活跃在前 5 条内（id=1），分屏活跃在深度位置（id=7，index=6）：整组展开不隐藏分屏会话
  const splitDeep = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: 1,
    activeIds: new Set([1, 7]),
    background: new Map(),
  })
  assert.deepEqual(splitDeep.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(splitDeep.hiddenCount, 0)

  // 仅传 activeIds（activeId=null）命中深度会话（id=8）同样整组展开
  const onlySetDeep = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: null,
    activeIds: new Set([8]),
    background: new Map(),
  })
  assert.deepEqual(onlySetDeep.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(onlySetDeep.hiddenCount, 0)

  // activeIds 全部位于前 5 条内时正常折叠
  const bothShallow = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: 1,
    activeIds: new Set([1, 3]),
    background: new Map(),
  })
  assert.deepEqual(bothShallow.visible.map((item) => item.id), [1, 2, 3, 4, 5])
  assert.equal(bothShallow.hiddenCount, 3)
})

test('站位聚合优先级 error > blocked > working > done > idle；并列取列表首个（primary 置顶序）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'working', updatedAt: 9000 }),
    conv({ id: 2, status: 'blocked' }),
    conv({ id: 3, status: 'error' }),
    conv({ id: 4, status: 'done' }),
  ]
  const indicator = resolveStandingStatusIndicator(conversations, new Map())
  assert.equal(indicator?.representative.id, 3)

  const workingBeatsDone = [conv({ id: 1, status: 'done', updatedAt: 9000 }), conv({ id: 2, status: 'working' })]
  assert.equal(resolveStandingStatusIndicator(workingBeatsDone, new Map())?.representative.id, 2)

  const tie = [conv({ id: 1, status: 'working', updatedAt: 9000 }), conv({ id: 2, status: 'working' })]
  assert.equal(resolveStandingStatusIndicator(tie, new Map())?.representative.id, 1)

  // 非首条会话未读已完成（done）优先于 idle，确保折叠态能透出绿点；若存在后台在途则单灯语义仍让位空心环
  const idleWithDone = [conv({ id: 1, updatedAt: 9000 }), conv({ id: 2, status: 'done' })]
  const doneIndicator = resolveStandingStatusIndicator(idleWithDone, new Map())
  assert.equal(doneIndicator?.representative.id, 2)
  assert.equal(doneIndicator?.representative.status, 'done')

  // 纯 idle 时保持列表首个（与旧「看 primary」行为兼容）
  const pureIdle = [conv({ id: 1, status: 'idle', updatedAt: 9000 }), conv({ id: 2, status: 'idle' })]
  assert.equal(resolveStandingStatusIndicator(pureIdle, new Map())?.representative.id, 1)

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
// 状态灯前置行首固定灯位（nav-status-slot）：各行灯垂直对齐的结构契约
// ---------------------------------------------------------------------------

/** 断言行标题之前的行首段包含 nav-status-slot 内的状态灯（灯在 nav-item-label 之前）。 */
function dotBeforeLabel(html: string, title: string): boolean {
  const labelIdx = html.indexOf(`>${title}</span>`)
  if (labelIdx < 0) return false
  const rowStart = html.lastIndexOf('<div class="nav-item', labelIdx)
  return /<span class="nav-status-slot"><span class="status-dot /.test(html.slice(rowStart, labelIdx))
}

test('状态灯前置行首：working/done/idle+后台在途的灯均在标题之前的固定灯位内', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '当前在跑', profileId: 'assistant', status: 'working', doing: '正在思考方案' }),
      conv({ id: 2, title: '已完成', profileId: 'assistant', status: 'done' }),
      conv({ id: 3, title: '纯空闲', profileId: 'assistant' }),
      conv({ id: 4, title: '后台在跑', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    groupedUi: groupUiContributions([panelContribution()]),
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '4': { count: 2, tone: 'accent', footerText: '2 运行中' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(dotBeforeLabel(html, '当前在跑'), 'working 状态灯在标题之前')
  assert.ok(dotBeforeLabel(html, '已完成'), 'done 状态灯在标题之前')
  assert.ok(dotBeforeLabel(html, '后台在跑'), '后台空心环灯在标题之前')
  // idle 空槽：灯不渲染但槽保留，续行标题保持对齐
  assert.ok(
    html.includes('<span class="nav-status-slot"></span><span class="nav-item-label">纯空闲</span>'),
    'idle 行空槽保留（灯不渲染槽仍在）',
  )
  // 槽位数量与行数一致：每条会话行（nav-item-sub）与每个站位行各恰好一个 nav-status-slot
  const subRows = (html.match(/class="nav-item nav-item-sub/g) ?? []).length
  const standingRows = (html.match(/class="nav-item agent-standing-row/g) ?? []).length
  const slots = (html.match(/class="nav-status-slot"/g) ?? []).length
  assert.equal(subRows, 4, '四条会话子行全部渲染')
  assert.equal(slots, subRows + standingRows, '会话行行行有灯槽（idle 空槽也计入），站位行同样有槽')
})

test('折叠站位行状态灯前置：standing indicator 渲染在 nav-status-slot 内且位于名称之前', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '在跑', profileId: 'coder', status: 'working', doing: '重构中' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const html = renderSidebar(store)
  // 折叠站位行：名称之前有 nav-status-slot 且其内含代表会话状态灯
  const labelIdx = html.indexOf('>编码专员</span>')
  assert.ok(labelIdx > 0, '折叠站位行渲染')
  const rowStart = html.lastIndexOf('<div class="nav-item agent-standing-row', labelIdx)
  const head = html.slice(rowStart, labelIdx)
  assert.match(head, /<span class="nav-status-slot"><span class="status-dot status-dot-working"/, '站位指示灯在名称之前的固定灯位内')
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

// ---------------------------------------------------------------------------
// Sidebar 渲染与 DOM 更新：contextUsage.compacting 后台空心环与单灯语义
// ---------------------------------------------------------------------------

test('Sidebar 渲染：idle/done 会话 compacting=true 渲染后台空心环，working 保持主灯独占，叠加 workflow 角标去重拼接', { timeout: 60_000 }, () => {
  // idle + compacting=true -> 空心环 + 上下文精简中
  const idleHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '精简中会话',
          profileId: 'assistant',
          status: 'idle',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(idleHtml.includes('class="status-dot status-dot-background"'), 'idle + compacting 应渲染后台空心环')
  assert.ok(idleHtml.includes('title="空闲 · 后台任务: 上下文精简中"'), 'tooltip 应包含 上下文精简中')
  assert.equal(countStatusLights(idleHtml), 1)

  // done + compacting=true -> 绿点让位空心环
  const doneHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '已完成但精简中',
          profileId: 'assistant',
          status: 'done',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(doneHtml.includes('class="status-dot status-dot-background"'), 'done + compacting 应渲染后台空心环')
  assert.ok(!doneHtml.includes('class="status-dot status-dot-done"'), 'done 绿点必须让位')
  assert.ok(doneHtml.includes('title="已完成 · 后台任务: 上下文精简中"'))
  assert.equal(countStatusLights(doneHtml), 1)

  // working + compacting=true -> 实心 working 灯独占（单灯不变式）
  const workingHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '运行中且精简',
          profileId: 'assistant',
          status: 'working',
          doing: '生成回答',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(workingHtml.includes('class="status-dot status-dot-working"'), 'working 主状态灯必须独占')
  assert.ok(!workingHtml.includes('status-dot-background'), 'working 时不得渲染后台空心环')
  assert.ok(!workingHtml.includes('上下文精简中'), 'working 时 tooltip 不叠加后台摘要')
  assert.equal(countStatusLights(workingHtml), 1)

  // idle + compacting=true + workflow accent badge -> 组合摘要「2 运行中 · 上下文精简中」
  const combinedHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '双后台任务',
          profileId: 'assistant',
          status: 'idle',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      groupedUi: groupUiContributions([panelContribution()]),
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 运行中' } }),
      },
    }),
  )
  assert.ok(combinedHtml.includes('class="status-dot status-dot-background"'))
  assert.ok(combinedHtml.includes('title="空闲 · 后台任务: 2 运行中 · 上下文精简中"'))
  assert.equal(countStatusLights(combinedHtml), 1)
})

test('Sidebar DOM 更新：conversations 的 compacting 从 false 变为 true 时即时点亮空心环（无陈旧闭包）', { timeout: 60_000 }, async () => {
  const basePanels = groupUiContributions([])
  const initialStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: basePanels,
    pluginDocs: {},
  })
  const nextStore = sidebarStore({
    conversations: [
      conv({
        id: 1,
        title: '主会话',
        profileId: 'assistant',
        status: 'idle',
        contextUsage: { tokens: 3000, compacting: true },
        createdAt: 9000,
        updatedAt: 9000,
      }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    groupedUi: basePanels,
    pluginDocs: initialStore.pluginDocs,
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HelmStoreContext.Provider, { value: initialStore }, e(Sidebar)))
  })
  assert.ok(container.querySelector('.status-dot-background') === null, '初始无 compacting 不渲染空心环')

  await act(async () => {
    root?.render(e(HelmStoreContext.Provider, { value: nextStore }, e(Sidebar)))
  })
  const ring = container.querySelector('.status-dot-background')
  assert.ok(ring !== null, 'conversations 更新 compacting=true 后应即时点亮空心环')
  assert.equal(ring.getAttribute('title'), '空闲 · 后台任务: 上下文精简中')

  await act(async () => {
    root?.unmount()
  })
  container.remove()
})
