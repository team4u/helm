/**
 * 宿主通用时间线插件接管与 queued 长文本折叠测试：
 * - timeline.renderer 按 matchMeta.renderer 精确接管 helm.input，未标记输入不受影响；
 * - queuedAgentTextCollapse / HumanMessage 对 agent 长文的折叠、展开/收起与统一灰色胶囊样式。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  PluginUiContribution,
} from '@helm/protocol'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { emptyLiveState } from '../src/lib/live-state.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'
import { buildTimelineItems, queuedAgentTextCollapse } from '../src/conversation/timeline-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { readHostStyles } from './helpers/host-styles.js'

const e = React.createElement

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

// ---------------------------------------------------------------------------
// 1. 宿主派发：matchMeta.renderer 精确接管
// ---------------------------------------------------------------------------

test('宿主派发: renderer 标记的 helm.input 接管为插件卡，未标记输入不受影响', { timeout: 60_000 }, () => {
  const sampleUi: PluginUiContribution[] = [
    {
      pluginId: 'sample:report',
      surface: 'timeline.renderer',
      spec: {
        id: 'sample-report',
        kinds: ['helm.input'],
        matchMeta: { renderer: 'sample:report-card' },
        client: { module: 'index.tsx', export: 'SampleReportCard' },
      },
    },
  ]
  const renderers = groupUiContributions(sampleUi).timelineRenderers
  assert.equal(renderers.length, 1)
  assert.equal(renderers[0]!.pluginId, 'sample:report')

  const markedEntry: ConversationEntry = {
    id: '51',
    kind: 'helm.input',
    data: {
      id: 'sample:report:1',
      text: '后台任务已结算',
      origin: 'agent',
      createdAt: 100,
      meta: { renderer: 'sample:report-card' },
    },
  }
  const items = buildTimelineItems(
    [markedEntry, { id: '52', kind: 'helm.input', data: { text: '普通输入', origin: 'human' } }],
    { timelineRenderers: renderers },
  )
  assert.equal(items[0]!.kind, 'plugin-card')
  if (items[0]!.kind === 'plugin-card') {
    assert.equal(items[0]!.renderer.pluginId, 'sample:report')
    assert.equal(items[0]!.entryId, '51')
  }
  assert.equal(items[1]!.kind, 'human', '未标记 renderer 的 helm.input 仍走通用人类消息渲染')
})

// ---------------------------------------------------------------------------
// 2. 排队中的非人类长文本通用折叠（HumanMessage）
// ---------------------------------------------------------------------------

test('queuedAgentTextCollapse: 阈值判定与预览截断', { timeout: 60_000 }, () => {
  assert.equal(queuedAgentTextCollapse('短文本').collapsed, false)
  assert.equal(queuedAgentTextCollapse('a'.repeat(600)).collapsed, false, '不超 600 字符不折叠')
  const long = queuedAgentTextCollapse(`引导语\n${'a'.repeat(700)}`)
  assert.equal(long.collapsed, true)
  assert.ok(long.preview.endsWith('…'))
  const manyLines = queuedAgentTextCollapse(Array.from({ length: 10 }, (_, i) => `行${i}`).join('\n'))
  assert.equal(manyLines.collapsed, true, '超过 8 行即折叠')
})

function makeStore(live: ConversationLive | undefined, entries: ConversationEntry[]): HelmStoreValue {
  const conversation: ConversationSummary = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status: live !== undefined ? 'working' : 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    ...emptyLiveState(),
    conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, groupedUi: groupUiContributions([]),
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark', locale: 'en', quietNotifyEnabled: false,
    profiles: [], profilesLoaded: true, assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, setLocale: noop, setQuietNotify: asyncNoop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, openSpace: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  }
}

async function mountTimeline(
  live: ConversationLive | undefined,
  entries: ConversationEntry[],
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = makeStore(live, entries)
  const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: store },
        e(ConversationTimeline, { conversation: store.conversations[0]!, detailEntries: entries, ...(live ? { live } : {}), onRequestEdit: () => {} }),
      ),
    )
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

test('HumanMessage: 排队 agent 长文折叠可展开收起，复制入口保留；human 不折叠', { timeout: 60_000 }, async () => {
  const reportText = `后台子代理任务已结算。\n${JSON.stringify({ runId: 'wf_q', status: 'completed', result: 'x'.repeat(700), otherRunningTasks: [] })}`
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 9,
    queuedInputs: [
      { id: 'fu-agent', submissionId: '30', text: reportText, mode: 'followUp', origin: 'agent', createdAt: 5 },
      { id: 'fu-human', submissionId: '31', text: `人类排队长文：${'人'.repeat(700)}`, mode: 'followUp', origin: 'human', createdAt: 6 },
    ],
  }
  const { host, unmount } = await mountTimeline(live, [])

  const agentPill = host.querySelector('.msg-human-pill-collapsible')
  assert.ok(agentPill, '排队 agent 长文折叠展示')
  const agentRow = agentPill!.closest('.msg-human-row')
  assert.ok(agentRow !== null, 'agent 排队胶囊外层应包含 .msg-human-row')
  assert.equal(agentRow.classList.contains('msg-human-row-external'), true, 'origin=agent 应附加 .msg-human-row-external')
  assert.equal(agentPill!.classList.contains('msg-human-pill'), true)
  assert.equal(agentPill!.classList.contains('msg-human-pill-queued'), true)
  assert.ok(agentRow.querySelector('.msg-origin-tag') !== null)
  assert.ok(agentRow.querySelector('.msg-human-footer') !== null)
  assert.match(agentPill!.querySelector('.msg-human-collapsed-text')?.textContent ?? '', /后台子代理任务已结算/)
  // 折叠态只见预览，不见全文。
  assert.equal(agentPill!.textContent?.includes('otherRunningTasks'), false)
  const expand = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Expand full text'))
  assert.ok(expand, '展开按钮存在')
  assert.equal(expand!.getAttribute('aria-expanded'), 'false')
  assert.ok(document.getElementById(expand!.getAttribute('aria-controls')!), '折叠状态控件目标存在')
  expand!.focus()

  act(() => expand!.click())
  assert.equal(expand!.isConnected, true, '展开时保留同一个按钮')
  assert.ok(document.activeElement === expand, '展开时保留键盘焦点')
  const openPill = host.querySelector('.msg-human-pill-collapsible')
  assert.ok(openPill!.textContent?.includes('otherRunningTasks'), '展开后可见全文')
  assert.equal(openPill!.textContent?.includes('Expand full text'), false)
  const collapse = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Collapse')
  assert.ok(collapse, '收起按钮存在')
  assert.equal(collapse!.getAttribute('aria-expanded'), 'true')
  act(() => collapse!.click())
  assert.ok(document.activeElement === expand, '收起时保留键盘焦点')
  assert.equal(host.querySelector('.msg-human-pill-collapsible')?.textContent?.includes('otherRunningTasks'), false)

  // 人类排队长文与正式消息不折叠，也不附加外部来源类名。
  const humanPills = Array.from(host.querySelectorAll('.msg-human-pill')).filter((p) => p.textContent?.includes('人类排队长文'))
  assert.equal(humanPills.length, 1)
  const humanRow = humanPills[0]!.closest('.msg-human-row')
  assert.ok(humanRow !== null, 'human 胶囊外层应包含 .msg-human-row')
  assert.equal(humanRow.classList.contains('msg-human-row-external'), false, 'origin=human 不得附加 .msg-human-row-external')
  assert.equal(humanPills[0]!.classList.contains('msg-human-pill-collapsible'), false, 'human 输入不折叠')
  assert.ok(humanPills[0]!.textContent?.includes('人人人'), 'human 长文直接全文展示')
  unmount()
})

test('HumanMessage: 所有来源和模式的待处理卡片在折叠、展开时使用统一灰色样式', { timeout: 60_000 }, async () => {
  const style = document.createElement('style')
  style.textContent = readHostStyles()
  document.head.appendChild(style)
  const originalTheme = document.documentElement.getAttribute('data-theme')
  const queuedInputs: NonNullable<ConversationLive['queuedInputs']> = []
  for (const origin of ['human', 'agent', 'trigger'] as const) {
    for (const mode of ['steer', 'followUp'] as const) {
      for (const long of [false, true]) {
        const id = `${origin}-${mode}-${long ? 'long' : 'short'}`
        queuedInputs.push({
          id, submissionId: String(queuedInputs.length + 1), origin, mode, createdAt: 5,
          text: `${id}: ${long ? '完整消息'.repeat(200) : '简短消息'}`,
        })
      }
    }
  }
  try {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', theme)
      const { host, unmount } = await mountTimeline({ conversationId: 1, text: '', tools: [], queuedInputs, updatedAt: 9 }, [])
      try {
        const palette = getComputedStyle(document.documentElement)
        const expectedBackground = palette.getPropertyValue('--bg-subtle').trim()
        const expectedColor = palette.getPropertyValue('--fg-muted').trim()
        assert.ok(expectedBackground && expectedColor)
        const pills = Array.from(host.querySelectorAll<HTMLElement>('.msg-human-pill'))
        assert.equal(pills.length, queuedInputs.length)
        assert.equal(host.querySelectorAll('.msg-human-collapse-btn').length, 4)
        const assertMuted = (pill: HTMLElement): void => {
          const computed = getComputedStyle(pill)
          assert.equal(computed.backgroundColor, expectedBackground)
          assert.equal(computed.color, expectedColor)
          assert.equal(computed.borderTopStyle, 'solid')
          assert.equal(computed.borderLeftStyle, 'solid')
          assert.equal(computed.borderTopWidth, '1px')
          assert.equal(computed.borderLeftWidth, '1px')
          assert.equal(computed.boxShadow, 'none')
          assert.equal(Number(computed.opacity || '1'), 1)
          assert.equal(computed.fontSize, '15px')
          const body = pill.querySelector('span')
          assert.ok(body)
          assert.equal(getComputedStyle(body).color, expectedColor)
          assert.equal(getComputedStyle(body).fontSize, '15px')
        }
        for (const pill of pills) {
          assertMuted(pill)
          const toggle = pill.querySelector<HTMLButtonElement>('.msg-human-collapse-btn')
          if (toggle === null) continue
          assert.equal(toggle.getAttribute('aria-expanded'), 'false')
          act(() => toggle.click())
          assert.equal(toggle.getAttribute('aria-expanded'), 'true')
          assertMuted(pill)
          act(() => toggle.click())
          assert.equal(toggle.getAttribute('aria-expanded'), 'false')
          assertMuted(pill)
        }
      } finally {
        unmount()
      }
    }
  } finally {
    style.remove()
    if (originalTheme === null) document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', originalTheme)
  }
})
