/**
 * Sidebar "conversation background in-flight" model and rendering tests
 * (single-light semantics):
 * - pure-layer contracts of summarizeConversationBackgroundActivity /
 *   collectBackgroundBadgeDocs / resolveStandingStatusIndicator /
 *   resolveStatusLight / backgroundAwareStatusTooltip (only tone=accent counts
 *   as in flight; neutral history counts and warn failure summaries never
 *   misreport; global badges do not participate; scope filtering; plugin
 *   contribution/doc absence zeroes out; non-primary conversations' background
 *   activity surfaces onto the level-one standing row; error > blocked >
 *   working > done > idle priority);
 * - single-light priority: working/blocked/error keep the main status light
 *   exclusive (no background hollow ring, no summary appended to the tooltip);
 *   idle/done with background in flight render only the hollow ring (the done
 *   green dot yields); with no background work the five states stay as-is;
 * - Sidebar SSR rendering: conversation rows / collapsed standing rows /
 *   sidebar.section group rows each carry exactly one light; the expanded
 *   standing row does not duplicate it and each child row keeps its own light;
 * - mount path: badge docs are loaded on demand via the Sidebar effect calling
 *   ensurePluginDoc (the pure functions have zero side effects).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary, HelmLocale, PluginUiContribution, WorkbenchPanelSpec } from '@helm/protocol'
import { groupUiContributions } from '../src/lib/types.js'
import { ARCHIVED_TAG, conversationStatusDotClass, conversationStatusTooltip } from '../src/shell/sidebar-model.js'
import {
  backgroundAwareStatusTooltip,
  collectBackgroundBadgeDocs,
  resolveAgentSubListPreview,
  resolveStandingStatusIndicator,
  resolveStatusLight,
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from '../src/shell/background-activity-model.js'
import { makeTestStore, HelmExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import { useHelmStore } from '../src/lib/store-context.js'
import type { HelmExternalStore } from '../src/lib/helm-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { Sidebar } = await import('../src/shell/Sidebar.js')
const { AgentStandingsGroup } = await import('../src/shell/SidebarAgentStandings.js')

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
// Pure layer: in-flight verdict contracts
// ---------------------------------------------------------------------------

test('per-conversation badges with tone=accent count as in flight and merge footerText; missing footerText still in flight', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, status: 'idle' }), conv({ id: 2, status: 'done' })]
  const index = summarize({
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 Running' },
        '2': { count: 1, tone: 'accent' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 Running' })
  assert.deepEqual(index.get(2), { active: true, summary: '' })
})

test('neutral history counts and warn failure summaries never misreport as in flight', { timeout: 60_000 }, () => {
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
  assert.equal(index.size, 0, 'neutral/warn entries must not light any conversation as in flight')
})

test('tone=accent with count=0 is still in flight by tone alone (count includes history and never participates)', { timeout: 60_000 }, () => {
  const index = summarize({
    conversations: [conv({ id: 1 })],
    pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 0, tone: 'accent' } }) },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '' })
})

test('global badges (no byConversationField) drive no per-conversation in-flight state and load no docs', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const contributions = [
    panelContribution({ spec: { badge: { doc: 'global-count', countField: 'total', toneField: 'tone' } } }),
  ]
  const index = summarize({
    contributions,
    conversations,
    pluginDocs: { 'builtin:workflow/global-count': { total: 5, tone: 'accent' } },
  })
  assert.equal(index.size, 0, 'a global accent badge cannot be attributed to a conversation and must light no row')
  const docs = collectBackgroundBadgeDocs(groupUiContributions(contributions).workbenchPanels, conversations)
  assert.deepEqual(docs, [])
})

test('missing plugin contribution (disabled) or unloaded doc zeroes the summary', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  assert.equal(summarize({ contributions: [], conversations }).size, 0)
  assert.equal(summarize({ conversations, pluginDocs: {} }).size, 0)
  // doc loaded but missing this conversation's entry: equally no in-flight state
  assert.equal(
    summarize({ conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '9': { count: 1, tone: 'accent' } }) } }).size,
    0,
  )
})

test('conversations missing the scope join no summary and their panels collect no doc references', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, profileId: 'assistant' })]
  const contributions = [
    panelContribution({ spec: { scope: { profileIds: ['superagent'] } } }),
  ]
  const panels = groupUiContributions(contributions).workbenchPanels
  assert.equal(summarize({ contributions, conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent' } }) } }).size, 0)
  assert.deepEqual(collectBackgroundBadgeDocs(panels, conversations), [])
  // with the scope hit (no scope = unrestricted), collect the deduplicated doc references
  assert.deepEqual(collectBackgroundBadgeDocs(groupUiContributions([panelContribution()]).workbenchPanels, conversations), [
    { pluginId: 'builtin:workflow', doc: 'run-badges' },
  ])
})

test('multi-panel aggregation: footerText joined after dedup, in-flight unioned', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const index = summarize({
    contributions: [panelContribution(), panelContribution({ pluginId: 'builtin:other', spec: { id: 'jobs' } })],
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
      'builtin:other/run-badges': badgesDoc({
        '1': { count: 3, tone: 'accent', footerText: '2 Running' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 Running' })
})

test('contextUsage.compacting=true marks background in flight and merges the compaction summary (dedup-joined with panel badges)', { timeout: 60_000 }, () => {
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
  assert.deepEqual(index.get(1), { active: true, summary: 'Compacting context' })
  assert.deepEqual(index.get(2), { active: true, summary: 'Compacting context' })
  assert.equal(index.get(3), undefined, 'compacting=false must not mark in flight')
  assert.equal(index.get(4), undefined, 'a missing compacting field must not mark in flight')

  const combined = summarize({
    conversations: [
      conv({ id: 1, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
      conv({ id: 2, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
    ],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 Running' },
        '2': { count: 1, tone: 'accent', footerText: 'Compacting context' },
      }),
    },
  })
  assert.deepEqual(combined.get(1), { active: true, summary: '2 Running · Compacting context' })
  assert.deepEqual(combined.get(2), { active: true, summary: 'Compacting context' })
})

// ---------------------------------------------------------------------------
// Pure layer: level-one standing aggregation, single-light priority and tooltip composition
// ---------------------------------------------------------------------------

test('agent sub-list collapsed preview always retains the current and in-flight conversations', { timeout: 60_000 }, () => {
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
  assert.equal(activePreview.visible.length, conversations.length, 'existing behavior: an active conversation beyond the preview expands the whole group')

  const idlePreview = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: null,
    background: new Map(),
  })
  assert.deepEqual(idlePreview.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6])
  assert.equal(idlePreview.hiddenCount, 2)
  assert.equal(resolveAgentSubListPreview({ conversations, showAll: true, activeId: null, background: new Map() }).hiddenCount, 0)

  // the collapsed preview retains a compacting conversation (even idle and positioned after the 5th row)
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

test('resolveAgentSubListPreview: any conversation in activeIds beyond the preview count expands the whole group (split protection)', { timeout: 60_000 }, () => {
  const conversations = Array.from({ length: 8 }, (_, index) => conv({ id: index + 1 }))

  // primary active within the first 5 (id=1), split active deep down (id=7, index=6): the whole group expands so the split conversation is never hidden
  const splitDeep = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: 1,
    activeIds: new Set([1, 7]),
    background: new Map(),
  })
  assert.deepEqual(splitDeep.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(splitDeep.hiddenCount, 0)

  // passing only activeIds (activeId=null) hitting a deep conversation (id=8) likewise expands the whole group
  const onlySetDeep = resolveAgentSubListPreview({
    conversations,
    showAll: false,
    activeId: null,
    activeIds: new Set([8]),
    background: new Map(),
  })
  assert.deepEqual(onlySetDeep.visible.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(onlySetDeep.hiddenCount, 0)

  // with every activeIds entry inside the first 5, folding behaves normally
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

test('standing aggregation priority error > blocked > working > done > idle; ties keep the list head (pinned-first order)', { timeout: 60_000 }, () => {
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

  // a later unread finished (done) conversation outranks idle so the collapsed state surfaces the green dot; with background in flight the single-light semantics still yield to the hollow ring
  const idleWithDone = [conv({ id: 1, updatedAt: 9000 }), conv({ id: 2, status: 'done' })]
  const doneIndicator = resolveStandingStatusIndicator(idleWithDone, new Map())
  assert.equal(doneIndicator?.representative.id, 2)
  assert.equal(doneIndicator?.representative.status, 'done')

  // an all-idle list keeps its head (compatible with the old "watch primary" behavior)
  const pureIdle = [conv({ id: 1, status: 'idle', updatedAt: 9000 }), conv({ id: 2, status: 'idle' })]
  assert.equal(resolveStandingStatusIndicator(pureIdle, new Map())?.representative.id, 1)

  assert.equal(resolveStandingStatusIndicator([], new Map()), null)
})

test('background in flight from a non-primary conversation still surfaces; summaries dedupe across conversations', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', updatedAt: 9000 }),
    conv({ id: 2, status: 'idle' }),
    conv({ id: 3, status: 'idle' }),
  ]
  const background: ConversationBackgroundIndex = new Map([
    [2, { active: true, summary: '1 Running' }],
    [3, { active: true, summary: '1 Running' }],
  ])
  const indicator = resolveStandingStatusIndicator(conversations, background)
  assert.equal(indicator?.representative.id, 1, 'the representative stays the primary')
  assert.equal(indicator?.backgroundActive, true, 'background in flight from a non-primary conversation must surface')
  assert.equal(indicator?.backgroundSummary, '1 Running', 'identical footerText dedupes across conversations')
})

test('resolveStatusLight single-light priority: main status is exclusive; idle/done yield to the background hollow ring', { timeout: 60_000 }, () => {
  // working/blocked/error: the main status light is exclusive; background work never joins the light slot
  for (const status of ['working', 'blocked', 'error'] as const) {
    assert.deepEqual(
      resolveStatusLight(status, true),
      { dotClass: conversationStatusDotClass(status), background: false },
      `${status} status light must be exclusive with no background hollow ring`,
    )
  }
  // idle/done with background in flight: hollow ring only (idle's no-light and done's green dot yield)
  assert.deepEqual(resolveStatusLight('idle', true), { dotClass: 'status-dot status-dot-background', background: true })
  assert.deepEqual(resolveStatusLight('done', true), { dotClass: 'status-dot status-dot-background', background: true })
  // no background work: the five states stay as-is
  assert.deepEqual(resolveStatusLight('working', false), { dotClass: 'status-dot status-dot-working', background: false })
  assert.deepEqual(resolveStatusLight('done', false), { dotClass: 'status-dot status-dot-done', background: false })
  assert.deepEqual(resolveStatusLight('idle', false), { dotClass: null, background: false })
})

test('tooltip composition: an exclusive status light states only the main turn; the hollow-ring slot appends base status + background summary', { timeout: 60_000 }, () => {
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: false }),
    conversationStatusTooltip('idle'),
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Idle · background task: 2 Running',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'done', backgroundActive: true, backgroundSummary: '' }),
    'Completed · background task running',
  )
  // working/blocked/error: even with background in flight, the tooltip shows only the main status/doing/lastError
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'working', doing: '正在思考方案', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Running: 正在思考方案',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'blocked', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Awaiting confirmation',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: true }),
    'Error: model_error: x',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: false }),
    'Error: model_error: x',
  )
})

// ---------------------------------------------------------------------------
// Sidebar rendering: single light slots on conversation rows and collapsed standings
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function sidebarStore(overrides: TestStoreOverrides = {}): HelmExternalStore {
  return makeTestStore({
    profiles: BASE_PROFILES,
    ...overrides,
  })
}

function renderSidebar(store: HelmExternalStore): string {
  return renderToString(e(HelmExternalStoreContext.Provider, { value: store }, e(Sidebar)))
}

/** Count conversation status lights (excluding the ActivityRail SSE status-dot-connected dot). */
function countStatusLights(html: string): number {
  return (
    html.match(/class="status-dot(?: status-dot-(?:working|blocked|done|error|background))?"/g) ?? []
  ).length
}

test('working/blocked/error conversations + background in flight: only the main status light renders, no background class', { timeout: 60_000 }, () => {
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
      uiContributions: [panelContribution()],
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 3, tone: 'accent', footerText: '3 Running' } }),
      },
    })
    const html = renderSidebar(store)
    assert.ok(html.includes(`class="status-dot ${dotClass}"`), `${status} keeps the main status light`)
    assert.ok(!html.includes('status-dot-background'), `${status} status light is exclusive with no background hollow ring`)
    assert.ok(!html.includes('background task'), `${status} tooltip appends no background summary`)
    assert.equal(countStatusLights(html), 1, `${status} collapsed standing row carries exactly one light`)
  }
})

test('idle conversation + background in flight: only the background hollow ring renders; the tooltip states idle + background summary', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), 'the background in-flight hollow ring must render')
  assert.ok(html.includes('title="Idle · background task: 2 Running"'), 'the tooltip states both the base status and the background summary')
  assert.ok(!html.includes('status-dot-working'), 'idle + background in flight must not masquerade as the conversation itself working')
  assert.equal(countStatusLights(html), 1, 'the collapsed standing row carries exactly one light')
})

test('done conversation + background in flight: the green dot yields and only the background hollow ring renders', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), 'the background in-flight hollow ring is the sole light')
  assert.ok(!html.includes('class="status-dot status-dot-done"'), 'the done green dot must yield, never side by side with the hollow ring')
  assert.ok(html.includes('title="Completed · background task: 1 Running"'), 'the tooltip states completed + background summary')
  assert.equal(countStatusLights(html), 1, 'the collapsed standing row carries exactly one light')
})

test('no background work: the five states stay as-is (done green dot, idle no light)', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '闲置话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 5, tone: 'neutral', footerText: '5 条历史' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-done"'), 'done keeps its green dot with nothing in flight')
  assert.ok(!html.includes('status-dot-background'), 'neutral history counts must not light the hollow ring')
  assert.equal(countStatusLights(html), 1, 'one light for the done conversation, none for idle')
})

test('expanded state: the standing row does not duplicate the indicator; each child conversation row keeps its own light', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 3, title: '失败话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('agent-conversations-list'), 'the current agent expands its topic sub-list')
  assert.ok(html.includes('title="Idle · background task: 1 Running"'), 'the idle child row shows the background hollow ring')
  assert.ok(html.includes('class="status-dot status-dot-error"'), 'the error child row shows its own status light')
  assert.ok(html.includes('class="status-dot status-dot-done"'), 'the done child row keeps its green dot')
  // each of the three child rows carries one light (done green dot / background hollow ring / error status light); the standing row duplicates none
  assert.equal(countStatusLights(html), 3, 'expanded state: exactly one light per child row, none on the standing row')
  assert.equal(
    (html.match(/status-dot-background/g) ?? []).length,
    1,
    'the background hollow ring appears exactly once on its own child row',
  )
})

test('collapsed standing row: non-primary background in flight + representative working/blocked/error hides the background ring', { timeout: 60_000 }, () => {
  // primary idle + secondary in error: the standing row surfaces error (representative = the secondary)
  const errorStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '失败话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const errorHtml = renderSidebar(errorStore)
  assert.ok(errorHtml.includes('class="status-dot status-dot-error"'), 'a secondary conversation in error must surface')
  assert.ok(errorHtml.includes('title="Error: model_error: boom"'))
  assert.ok(!errorHtml.includes('status-dot-background'), 'no in-flight badge means no hollow ring')

  // primary idle + secondary background in flight + another secondary blocked: the status light is exclusive, hiding the whole standing's background ring
  const blockedStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 3, title: '阻塞话题', profileId: 'assistant', status: 'blocked' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 4, tone: 'accent', footerText: '4 Running' } }),
    },
  })
  const blockedHtml = renderSidebar(blockedStore)
  assert.ok(blockedHtml.includes('class="status-dot status-dot-blocked"'), 'the representative blocked status light surfaces')
  assert.ok(!blockedHtml.includes('status-dot-background'), 'with the representative blocked, the whole standing background ring hides')
  assert.ok(!blockedHtml.includes('background task'), 'the tooltip shows only the representative status')
})

test('collapsed standing row: representative idle/done renders exactly one background hollow ring (non-primary background surfaced)', { timeout: 60_000 }, () => {
  // primary idle + secondary background in flight: the standing row shows a single hollow ring (the representative stays the primary)
  const idleStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 4, tone: 'accent', footerText: '4 Running' } }),
    },
  })
  const idleHtml = renderSidebar(idleStore)
  assert.ok(idleHtml.includes('class="status-dot status-dot-background"'), 'a non-primary conversation background in flight surfaces onto the standing row')
  assert.ok(idleHtml.includes('title="Idle · background task: 4 Running"'))
  assert.equal(countStatusLights(idleHtml), 1, 'the standing row shows a single background hollow ring with no parallel base dot')

  // primary done + secondary background in flight: the done green dot yields; likewise a single hollow ring
  const doneStore = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 2, tone: 'accent', footerText: '2 Running' } }),
    },
  })
  const doneHtml = renderSidebar(doneStore)
  assert.ok(!doneHtml.includes('class="status-dot status-dot-done"'), 'the representative done green dot yields')
  assert.ok(doneHtml.includes('class="status-dot status-dot-background"'), 'only the background hollow ring renders')
  assert.ok(doneHtml.includes('title="Completed · background task: 2 Running"'))
  assert.equal(countStatusLights(doneHtml), 1, 'the standing row shows a single background hollow ring')
})

test('sidebar.section group conversation rows obey the same single-light semantics', { timeout: 60_000 }, () => {
  // idle + background in flight: hollow ring only
  const idleStore = sidebarStore({
    conversations: [
      conv({ id: 20, title: 'Worker A', profileId: 'coder', tags: ['worker'], status: 'idle' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [
      panelContribution(),
      { pluginId: 'builtin:superagent', surface: 'sidebar.section', spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' } },
    ],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '20': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const idleHtml = renderSidebar(idleStore)
  assert.ok(idleHtml.includes('后台 Worker'), 'the group renders')
  assert.ok(idleHtml.includes('title="Idle · background task: 1 Running"'), 'group conversation row: hollow ring + summary')

  // working + background in flight: main status light only, no background class
  const workingStore = sidebarStore({
    conversations: [
      conv({ id: 20, title: 'Worker A', profileId: 'coder', tags: ['worker'], status: 'working', doing: '执行任务' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [
      panelContribution(),
      { pluginId: 'builtin:superagent', surface: 'sidebar.section', spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' } },
    ],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '20': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const workingHtml = renderSidebar(workingStore)
  assert.ok(workingHtml.includes('class="status-dot status-dot-working"'), 'group conversation rows keep the main status light')
  assert.ok(!workingHtml.includes('status-dot-background'), 'group conversation rows never pair with the background hollow ring')
  assert.ok(!workingHtml.includes('background task'), 'the tooltip appends no background summary')
})

test('plugin disabled (contributions gone) or only neutral history counts left: no in-flight indicator at all', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 50, title: '别处', profileId: 'coder' }),
  ]
  const common = { conversations, primaryTarget: { kind: 'conversation' as const, conversationId: 50 } }
  const disabled = renderSidebar(sidebarStore({ ...common, uiContributions: [], pluginDocs: {} }))
  assert.ok(!disabled.includes('status-dot-background'), 'with the contribution gone (disabled), the indicator disappears immediately')
  const neutral = renderSidebar(
    sidebarStore({
      ...common,
      uiContributions: [panelContribution()],
      pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 9, tone: 'neutral', footerText: '9 条历史' } }) },
    }),
  )
  assert.ok(!neutral.includes('status-dot-background'), 'neutral history counts must not misreport as in flight')
})

// ---------------------------------------------------------------------------
// Leading fixed light slot (nav-status-slot): the structural contract keeping every row's light vertically aligned
// ---------------------------------------------------------------------------

/** Assert that the row's leading segment before the title contains the status light inside nav-status-slot (the light precedes nav-item-label). */
function dotBeforeLabel(html: string, title: string): boolean {
  const labelIdx = html.indexOf(`>${title}</span>`)
  if (labelIdx < 0) return false
  const rowStart = html.lastIndexOf('<div class="nav-item', labelIdx)
  return /<span class="nav-status-slot"><span class="status-dot /.test(html.slice(rowStart, labelIdx))
}

test('leading fixed light slot: working/done/idle+background lights all sit before the title inside nav-status-slot', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '当前在跑', profileId: 'assistant', status: 'working', doing: '正在思考方案' }),
      conv({ id: 2, title: 'Completed', profileId: 'assistant', status: 'done' }),
      conv({ id: 3, title: '纯空闲', profileId: 'assistant' }),
      conv({ id: 4, title: '后台在跑', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '4': { count: 2, tone: 'accent', footerText: '2 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(dotBeforeLabel(html, '当前在跑'), 'the working status light precedes the title')
  assert.ok(dotBeforeLabel(html, 'Completed'), 'the done status light precedes the title')
  assert.ok(dotBeforeLabel(html, '后台在跑'), 'the background hollow-ring light precedes the title')
  // idle empty slot: no light renders but the slot stays so wrapped titles keep alignment
  assert.ok(
    html.includes('<span class="nav-status-slot"></span><span class="nav-item-label">纯空闲</span>'),
    'the idle row keeps its empty slot (no light renders, the slot remains)',
  )
  // slot count matches row count: every conversation row (nav-item-sub) and every standing row carries exactly one nav-status-slot
  const subRows = (html.match(/class="nav-item nav-item-sub/g) ?? []).length
  const standingRows = (html.match(/class="nav-item agent-standing-row/g) ?? []).length
  const slots = (html.match(/class="nav-status-slot"/g) ?? []).length
  assert.equal(subRows, 4, 'all four conversation child rows render')
  assert.equal(slots, subRows + standingRows, 'every conversation row has a light slot (idle empty slots count too); standing rows have slots as well')
})

test('collapsed standing light leads the row: the standing indicator renders inside nav-status-slot before the name', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '在跑', profileId: 'coder', status: 'working', doing: '重构中' }),
      conv({ id: 50, title: '别处', profileId: 'assistant' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const html = renderSidebar(store)
  // collapsed standing row: a nav-status-slot precedes the name and holds the representative's status light
  const labelIdx = html.indexOf('>编码专员</span>')
  assert.ok(labelIdx > 0, 'the collapsed standing row renders')
  const rowStart = html.lastIndexOf('<div class="nav-item agent-standing-row', labelIdx)
  const head = html.slice(rowStart, labelIdx)
  assert.match(head, /<span class="nav-status-slot"><span class="status-dot status-dot-working"/, 'the standing indicator sits in the fixed light slot before the name')
})


// ---------------------------------------------------------------------------
// Mount path: badge docs load on demand via the Sidebar effect (pure functions have zero side effects)
// ---------------------------------------------------------------------------

test('after Sidebar mounts, ensurePluginDoc loads the badge docs of hit panels on demand', { timeout: 60_000 }, async () => {
  // 真实 ensurePluginDoc 经 pluginsApi.getPublicDoc 拉取；以拦截到的请求 URL 断言按需加载目标。
  const docUrls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    docUrls.push(url)
    return new Response(JSON.stringify({ key: 'stub', value: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const store = sidebarStore({
    plugins: [{ id: 'builtin:workflow', name: 'Workflow', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    assert.deepEqual(docUrls, ['/api/plugins/builtin%3Aworkflow/docs/run-badges'])
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// Sidebar rendering and DOM updates: the contextUsage.compacting background hollow ring and single-light semantics
// ---------------------------------------------------------------------------

test('Sidebar render: idle/done conversations with compacting=true render the background hollow ring, working keeps the main light exclusive, workflow badges dedupe-join', { timeout: 60_000 }, () => {
  // idle + compacting=true -> hollow ring + compaction summary
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
  assert.ok(idleHtml.includes('class="status-dot status-dot-background"'), 'idle + compacting must render the background hollow ring')
  assert.ok(idleHtml.includes('title="Idle · background task: Compacting context"'), 'the tooltip must include the compaction summary')
  assert.equal(countStatusLights(idleHtml), 1)

  // done + compacting=true -> green dot yields to the hollow ring
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
  assert.ok(doneHtml.includes('class="status-dot status-dot-background"'), 'done + compacting must render the background hollow ring')
  assert.ok(!doneHtml.includes('class="status-dot status-dot-done"'), 'the done green dot must yield')
  assert.ok(doneHtml.includes('title="Completed · background task: Compacting context"'))
  assert.equal(countStatusLights(doneHtml), 1)

  // working + compacting=true -> the solid working light stays exclusive (single-light invariant)
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
  assert.ok(workingHtml.includes('class="status-dot status-dot-working"'), 'the working main status light must be exclusive')
  assert.ok(!workingHtml.includes('status-dot-background'), 'no background hollow ring while working')
  assert.ok(!workingHtml.includes('Compacting context'), 'no background summary appended to the tooltip while working')
  assert.equal(countStatusLights(workingHtml), 1)

  // idle + compacting=true + workflow accent badge -> combined summary "2 Running · Compacting context"
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
      uiContributions: [panelContribution()],
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
      },
    }),
  )
  assert.ok(combinedHtml.includes('class="status-dot status-dot-background"'))
  assert.ok(combinedHtml.includes('title="Idle · background task: 2 Running · Compacting context"'))
  assert.equal(countStatusLights(combinedHtml), 1)
})

test('Sidebar DOM update: flipping a conversation compacting false -> true lights the hollow ring immediately (no stale closure)', { timeout: 60_000 }, async () => {
  const convIdle = conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 })
  const store = sidebarStore({
    conversations: [convIdle, conv({ id: 50, title: '别处', profileId: 'coder' })],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    pluginDocs: {},
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HelmExternalStoreContext.Provider, { value: store }, e(Sidebar)))
  })
  assert.ok(container.querySelector('.status-dot-background') === null, 'no hollow ring initially without compacting')

  // conversations 领域原位推进（与 SSE conversation.updated 同一链路），验证无过期闭包
  await act(async () => {
    store.updateLive((prev) => ({
      ...prev,
      conversations: [
        { ...convIdle, contextUsage: { tokens: 3000, compacting: true } },
        ...prev.conversations.filter((c) => c.id !== 1),
      ],
    }))
  })
  const ring = container.querySelector('.status-dot-background')
  assert.ok(ring !== null, 'after the conversations update with compacting=true, the hollow ring lights immediately')
  assert.equal(ring.getAttribute('title'), 'Idle · background task: Compacting context')

  await act(async () => {
    root?.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// Sidebar dynamic groups, views/settings space navigation and the archived group: split presence, focus ticks and micro-badge SSR regressions
// ---------------------------------------------------------------------------

function findNavRow(html: string, label: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  const match = [...host.querySelectorAll('.nav-item')].find(
    (row) => row.querySelector('.nav-item-label')?.textContent === label,
  )
  assert.ok(match, `sidebar row titled "${label}" not found`)
  return match
}

test('sidebar.section conversation rows in split presence: a splitTarget hit renders .nav-item-split and the Split micro badge; focusing split switches .nav-item-active.nav-item-focused', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    {
      pluginId: 'builtin:superagent',
      surface: 'sidebar.section',
      spec: { id: 'workers', label: '后台 Worker', filterTag: 'worker' },
    },
  ]
  const conversations = [
    conv({ id: 20, title: 'Worker A', profileId: 'coder', tags: ['worker'] }),
    conv({ id: 21, title: 'Worker B', profileId: 'coder', tags: ['worker'] }),
    conv({ id: 50, title: '主控会话', profileId: 'assistant' }),
  ]

  const splitSecondaryHtml = renderSidebar(
    sidebarStore({
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      splitTarget: { kind: 'conversation', conversationId: 20 },
      uiContributions: contributions,
    }),
  )
  const workerSecondary = findNavRow(splitSecondaryHtml, 'Worker A')
  assert.equal(workerSecondary.classList.contains('nav-item-split'), true)
  assert.equal(workerSecondary.classList.contains('nav-item-active'), false)
  assert.equal(workerSecondary.classList.contains('nav-item-focused'), false)
  assert.equal(workerSecondary.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  const secondaryMeta = workerSecondary.querySelector('.nav-item-meta')
  assert.ok(secondaryMeta, 'Worker A must render .nav-item-meta')
  const secondaryTag = secondaryMeta.children[0]
  assert.equal(secondaryTag?.className, 'nav-pane-tag', 'the paneTag must lead .nav-item-meta')
  assert.equal(secondaryTag?.textContent, 'Split')
  assert.equal(secondaryTag?.getAttribute('title'), 'Open in split view')
  assert.equal(secondaryMeta.children[1]?.textContent, '#20')

  const workerOther = findNavRow(splitSecondaryHtml, 'Worker B')
  assert.equal(workerOther.classList.contains('nav-item-split'), false)
  assert.equal(workerOther.classList.contains('nav-item-active'), false)
  assert.ok(workerOther.querySelector('.nav-pane-tag') === null)

  const splitFocusedHtml = renderSidebar(
    sidebarStore({
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      splitTarget: { kind: 'conversation', conversationId: 20 },
      focusedPanel: 'split',
      uiContributions: contributions,
    }),
  )
  const workerFocused = findNavRow(splitFocusedHtml, 'Worker A')
  assert.equal(workerFocused.classList.contains('nav-item-active'), true)
  assert.equal(workerFocused.classList.contains('nav-item-focused'), true)
  assert.equal(workerFocused.classList.contains('nav-item-split'), false)
  assert.equal(workerFocused.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(workerFocused.querySelector('.nav-pane-tag')?.textContent, 'Split')
  assert.equal(workerFocused.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in split view')
})

test('ViewNavGroup and SettingsNavGroup split double-open: main/split highlights, focus ticks and .nav-pane-tag (single screen adds no Settings meta)', { timeout: 60_000 }, () => {
  const viewContributions: PluginUiContribution[] = [
    {
      pluginId: 'builtin:herdr',
      surface: 'sidebar.item',
      spec: { id: 'herdr', label: 'Herdr 终端', icon: 'terminal', target: 'screen:builtin:herdr/overview' },
    },
    {
      pluginId: 'builtin:workflow',
      surface: 'sidebar.item',
      spec: { id: 'runs', label: '工作流总览', icon: 'activity', target: 'screen:builtin:workflow/runs' },
    },
  ]
  const viewSplitHtml = renderSidebar(
    sidebarStore({
      uiContributions: viewContributions,
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs' },
      focusedPanel: 'split',
    }),
  )
  const herdrRow = findNavRow(viewSplitHtml, 'Herdr 终端')
  assert.equal(herdrRow.classList.contains('nav-item-split'), true)
  assert.equal(herdrRow.classList.contains('nav-item-active'), false)
  assert.equal(herdrRow.classList.contains('nav-item-focused'), false)
  assert.equal(herdrRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(herdrRow.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.equal(herdrRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in main view')

  const runsRow = findNavRow(viewSplitHtml, '工作流总览')
  assert.equal(runsRow.classList.contains('nav-item-active'), true)
  assert.equal(runsRow.classList.contains('nav-item-focused'), true)
  assert.equal(runsRow.classList.contains('nav-item-split'), false)
  assert.equal(runsRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(runsRow.querySelector('.nav-pane-tag')?.textContent, 'Split')
  assert.equal(runsRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in split view')

  const viewSameHtml = renderSidebar(
    sidebarStore({
      uiContributions: viewContributions,
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
    }),
  )
  const herdrBothRow = findNavRow(viewSameHtml, 'Herdr 终端')
  assert.equal(herdrBothRow.classList.contains('nav-item-active'), true)
  assert.equal(herdrBothRow.classList.contains('nav-item-focused'), true)
  assert.equal(herdrBothRow.querySelector('.nav-pane-tag')?.textContent, 'Main·Split')
  assert.equal(herdrBothRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in both main and split views')

  const singleSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: null,
    }),
  )
  const singleProfiles = findNavRow(singleSettingsHtml, 'Profile')
  assert.equal(singleProfiles.classList.contains('settings-nav-item'), true)
  assert.equal(singleProfiles.classList.contains('nav-item-active'), true)
  assert.equal(singleProfiles.classList.contains('nav-item-focused'), false)
  assert.ok(singleProfiles.querySelector('.nav-item-meta') === null, 'single-screen SettingsNavGroup renders no .nav-item-meta')

  const splitSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: { kind: 'models' },
      focusedPanel: 'split',
    }),
  )
  const profilesRow = findNavRow(splitSettingsHtml, 'Profile')
  assert.equal(profilesRow.classList.contains('settings-nav-item'), true)
  assert.equal(profilesRow.classList.contains('nav-item-split'), true)
  assert.equal(profilesRow.classList.contains('nav-item-active'), false)
  assert.equal(profilesRow.classList.contains('nav-item-focused'), false)
  assert.equal(profilesRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(profilesRow.querySelector('.nav-item-meta .nav-pane-tag')?.textContent, 'Main')
  assert.equal(profilesRow.querySelector('.nav-item-meta .nav-pane-tag')?.getAttribute('title'), 'Open in main view')

  const modelsRow = findNavRow(splitSettingsHtml, 'Models & credentials')
  assert.equal(modelsRow.classList.contains('settings-nav-item'), true)
  assert.equal(modelsRow.classList.contains('nav-item-active'), true)
  assert.equal(modelsRow.classList.contains('nav-item-focused'), true)
  assert.equal(modelsRow.classList.contains('nav-item-split'), false)
  assert.equal(modelsRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(modelsRow.querySelector('.nav-item-meta .nav-pane-tag')?.textContent, 'Split')
  assert.equal(modelsRow.querySelector('.nav-item-meta .nav-pane-tag')?.getAttribute('title'), 'Open in split view')

  const skillsRow = findNavRow(splitSettingsHtml, 'Skills')
  assert.ok(skillsRow.querySelector('.nav-item-meta') === null, 'unhit settings entries render no .nav-item-meta')

  const sameSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: { kind: 'profiles', profileId: 'coder' },
      focusedPanel: 'primary',
    }),
  )
  const profilesBothRow = findNavRow(sameSettingsHtml, 'Profile')
  assert.equal(profilesBothRow.classList.contains('nav-item-active'), true)
  assert.equal(profilesBothRow.classList.contains('nav-item-focused'), true)
  assert.equal(profilesBothRow.querySelector('.nav-pane-tag')?.textContent, 'Main·Split')
  assert.equal(profilesBothRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in both main and split views')
})

test('ArchivedConversationsGroup split hit on an archived conversation: auto-expands and renders .nav-item-split / .nav-item-active.nav-item-focused and .nav-pane-tag', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '活跃会话', profileId: 'assistant' }),
    conv({ id: 77, title: '已归档历史', profileId: 'assistant', tags: [ARCHIVED_TAG] }),
  ]

  const splitSecondaryHtml = renderSidebar(
    sidebarStore({
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'conversation', conversationId: 77 },
    }),
  )
  const secondaryHost = document.createElement('div')
  secondaryHost.innerHTML = splitSecondaryHtml
  assert.equal(
    secondaryHost.querySelector('.archived-conversations-group .sidebar-group-header-toggle')?.getAttribute('aria-expanded'),
    'true',
    'the group auto-expands when splitTarget points at an archived conversation',
  )
  const archivedSecondary = findNavRow(splitSecondaryHtml, '已归档历史')
  assert.equal(archivedSecondary.classList.contains('nav-item-sub'), true)
  assert.equal(archivedSecondary.classList.contains('nav-item-split'), true)
  assert.equal(archivedSecondary.classList.contains('nav-item-active'), false)
  assert.equal(archivedSecondary.classList.contains('nav-item-focused'), false)
  assert.equal(archivedSecondary.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  const metaChildren = [...(archivedSecondary.querySelector('.nav-item-meta')?.children ?? [])]
  assert.equal(metaChildren[0]?.className, 'nav-pane-tag', 'the paneTag must precede the archived-profile-label')
  assert.equal(metaChildren[0]?.textContent, 'Split')
  assert.equal(metaChildren[0]?.getAttribute('title'), 'Open in split view')
  assert.equal(metaChildren[1]?.classList.contains('archived-profile-label'), true)

  const splitFocusedHtml = renderSidebar(
    sidebarStore({
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'conversation', conversationId: 77 },
      focusedPanel: 'split',
    }),
  )
  const archivedFocused = findNavRow(splitFocusedHtml, '已归档历史')
  assert.equal(archivedFocused.classList.contains('nav-item-sub'), true)
  assert.equal(archivedFocused.classList.contains('nav-item-active'), true)
  assert.equal(archivedFocused.classList.contains('nav-item-focused'), true)
  assert.equal(archivedFocused.classList.contains('nav-item-split'), false)
  assert.equal(archivedFocused.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(archivedFocused.querySelector('.nav-pane-tag')?.textContent, 'Split')

  const sameArchivedHtml = renderSidebar(
    sidebarStore({
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 77 },
      splitTarget: { kind: 'conversation', conversationId: 77 },
    }),
  )
  const archivedBoth = findNavRow(sameArchivedHtml, '已归档历史')
  assert.equal(archivedBoth.classList.contains('nav-item-active'), true)
  assert.equal(archivedBoth.classList.contains('nav-item-focused'), true)
  assert.equal(archivedBoth.querySelector('.nav-pane-tag')?.textContent, 'Main·Split')
  assert.equal(archivedBoth.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in both main and split views')
})

test('ArchivedConversationsGroup stays collapsed after the open conversation is archived and the view jumps to the agent standby target', { timeout: 60_000 }, () => {
  // 归档迁移的落点状态：会话带宿主归档 tag，主屏已被 SSE 迁移导航替换为该智能体
  // 待命页（新建会话页，菜单路径与导航断言见 conversation-archive-menu.test.tsx）。
  // 归档成员不再是活动目标，折叠组不得自动展开（自动展开仅服务「正在查看归档
  // 成员」的深链/分屏场景，见上一用例）。
  const standbyHtml = renderSidebar(
    sidebarStore({
      conversations: [conv({ id: 1, title: '已收尾的话题', profileId: 'assistant', tags: [ARCHIVED_TAG] })],
      primaryTarget: { kind: 'agent', profileId: 'assistant', cwd: '/root/code/helm' },
    }),
  )
  const standbyHost = document.createElement('div')
  standbyHost.innerHTML = standbyHtml
  assert.ok(standbyHost.querySelector('.archived-conversations-group'), 'the archived group renders with one item')
  assert.equal(
    standbyHost.querySelector('.archived-conversations-group .sidebar-group-header-toggle')?.getAttribute('aria-expanded'),
    'false',
    'archiving the open conversation and jumping to standby must not auto-expand the archived group',
  )

  // 分屏落点同理：分屏目标被替换为待命页后，归档成员不再是活动目标。
  const splitHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({ id: 1, title: '活跃会话', profileId: 'assistant' }),
        conv({ id: 77, title: '已归档历史', profileId: 'assistant', tags: [ARCHIVED_TAG] }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'assistant' },
    }),
  )
  const splitHost = document.createElement('div')
  splitHost.innerHTML = splitHtml
  assert.equal(
    splitHost.querySelector('.archived-conversations-group .sidebar-group-header-toggle')?.getAttribute('aria-expanded'),
    'false',
    'a split pane replaced by the standby target must not keep the archived group expanded',
  )
})

// ---------------------------------------------------------------------------
// Locale wiring: shell chrome copy follows the active store locale
// ---------------------------------------------------------------------------

test('zh-CN sidebar render: agents group shows Chinese chrome copy', { timeout: 60_000 }, () => {
  const store = sidebarStore({ locale: 'zh-CN' })
  const html = renderSidebar(store)
  assert.ok(html.includes('<span>智能体</span>'), 'agents group title renders the zh-CN catalog copy')
  assert.ok(html.includes('筛选智能体与话题'), 'filter tooltip/aria-label renders zh-CN')
  assert.ok(html.includes('批量管理会话'), 'bulk-manage title renders zh-CN')
  assert.ok(!html.includes('<span>Agents</span>'), 'no leftover English group title under zh-CN')
})

test('AgentStandingsGroup switches copy immediately on setLocale (en -> zh-CN -> en)', { timeout: 60_000 }, async () => {
  // 真实 store.setLocale 驱动 prefs 领域订阅：Shell 铨印文案原位切换（与生产同一链路）。
  const store = sidebarStore({ locale: 'en' })
  function StandingsView(): React.JSX.Element {
    const view = useHelmStore()
    return e(AgentStandingsGroup, { store: view, background: new Map() })
  }
  function Harness(): React.JSX.Element {
    return e(HelmExternalStoreContext.Provider, { value: store }, e(StandingsView))
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  try {
    await act(async () => { root.render(e(Harness)) })
    const groupTitle = host.querySelector('.sidebar-group-header > span')
    assert.ok(groupTitle !== null, 'agents group header renders')
    assert.equal(groupTitle.textContent, 'Agents', 'renders the en catalog copy by default')

    await act(async () => { store.setLocale('zh-CN') })
    assert.equal(store.getPrefsSlice().locale, 'zh-CN')
    const groupTitleZh = host.querySelector('.sidebar-group-header > span')
    assert.ok(groupTitleZh !== null)
    assert.equal(groupTitleZh.textContent, '智能体', 'locale switch re-renders shell chrome in place')

    await act(async () => { store.setLocale('en') })
    assert.equal(store.getPrefsSlice().locale, 'en')
    assert.equal(host.querySelector('.sidebar-group-header > span')?.textContent, 'Agents', 'switching back to en restores English immediately')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})
