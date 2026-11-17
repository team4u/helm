import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { isAssistantTurnBusy } = await import('../src/conversation/timeline-model.js')
type AssistantTurn = import('../src/conversation/timeline-model.js').AssistantTurn
const { makeTestStore: makeMockStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

const stylesCss = readHostStyles()

// ---------------------------------------------------------------------------
// 1. 样式契约：无卡边框、无卡背景、纯按钮图标
// ---------------------------------------------------------------------------

test('样式契约：.msg-hover-bar 无背景、无边框、无阴影，纯按钮图标避免喧宾夺主', { timeout: 60_000 }, () => {
  // .msg-hover-bar 容器本身透明且无边框阴影
  assert.match(stylesCss, /\.msg-hover-bar\s*\{[^}]*background:\s*transparent/)
  assert.match(stylesCss, /\.msg-hover-bar\s*\{[^}]*border:\s*none/)
  assert.match(stylesCss, /\.msg-hover-bar\s*\{[^}]*box-shadow:\s*none/)
  assert.match(stylesCss, /\.msg-hover-bar\s*\{[^}]*padding:\s*0/)

  // 内部按钮小巧且默认静音色，悬停轻度高亮
  assert.match(stylesCss, /\.msg-hover-bar\s+\.btn\s*\{[^}]*background:\s*transparent/)
  assert.match(stylesCss, /\.msg-hover-bar\s+\.btn\s*\{[^}]*border:\s*none/)
  assert.match(stylesCss, /\.msg-hover-bar\s+\.btn\s*\{[^}]*color:\s*var\(--fg-muted\)/)
  assert.match(stylesCss, /\.msg-hover-bar\s+\.btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--bg-hover\)/)
})

// ---------------------------------------------------------------------------
// 2. 状态判定纯函数：isAssistantTurnBusy
// ---------------------------------------------------------------------------

test('isAssistantTurnBusy：turn.live 为 true 时判定为响应中', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [{ kind: 'text', key: 'txt:1', text: '正在输出…' }],
    live: true,
  }
  const conv = { id: 1, status: 'idle' }
  assert.equal(isAssistantTurnBusy(turn, conv), true)
})

test('isAssistantTurnBusy：最新回合且父会话为 working 或 blocked 时判定为响应中', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [{ kind: 'text', key: 'txt:1', text: '已有一段输出' }],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: true }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'blocked' }, { isLatestTurn: true }), true)
  // 非最新回合（历史回合）不受父会话当前 working 影响
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: false }), false)
})

test('isAssistantTurnBusy：回合内有 running 工具或激活的分组步骤时判定为响应中', { timeout: 60_000 }, () => {
  const turnWithRunningTool: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:1',
        tool: { key: 't:1', toolName: 'bash', status: 'running', isError: false },
      },
    ],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turnWithRunningTool, { id: 1, status: 'idle' }), true)

  const turnWithActiveStepGroup: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:2',
    entryIds: ['2'],
    segments: [
      {
        kind: 'step-group',
        key: 'g:1',
        stepCount: 1,
        active: true,
        steps: [{ kind: 'thinking', thinking: { key: 'th:1', text: '思考中' } }],
      },
    ],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turnWithActiveStepGroup, { id: 1, status: 'idle' }), true)
})

test('isAssistantTurnBusy：后台工具已返回但插件报告活动时仍 busy，终态释放后完成', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:wf',
        tool: {
          key: 't:wf',
          toolName: 'background_job',
          callId: 'call_bg_1',
          status: 'done',
          isError: false,
        },
      },
    ],
    live: false,
  }

  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set(['call_bg_1']) }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set() }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set(['another-turn']) }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: true }), true)
})

test('isAssistantTurnBusy：任意插件工具均按本次工具状态判定，不按工具名称特判', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:sub',
        tool: {
          key: 't:sub',
          toolName: 'subagent',
          callId: 'call_sub_1',
          status: 'done',
          isError: false,
        },
      },
    ],
    live: false,
  }

  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }), false)
  for (const status of ['running', 'unknown'] as const) {
    const segment = turn.segments[0]!
    assert.ok(segment.kind === 'tool')
    segment.tool.status = status
    assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }), true)
  }
})

// ---------------------------------------------------------------------------
// 3. ConversationTimeline SSR 渲染：响应中无悬停操作栏，完成后才出现
// ---------------------------------------------------------------------------

test('step-group 中 done 工具的后台活动也参与汇总；没有 callId 的工具不能误关联', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = { kind: 'assistant', key: 'g', entryIds: ['1'], live: false, segments: [{
    kind: 'step-group', key: 'group', stepCount: 2, active: false, steps: [
      { kind: 'tool', tool: { key: 't', callId: 'call', toolName: 'custom_tool', status: 'done', isError: false } },
      { kind: 'tool', tool: { key: 'no-id', toolName: 'custom_tool', status: 'done', isError: false } },
    ],
  }] }
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set(['call']) }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set(['no-id']) }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set() }), false)
})

test('ConversationTimeline：agent 回合响应中不显示复制与分叉按钮，完成后才出现', { timeout: 60_000 }, () => {
  const convWorking: ConversationSummary = {
    id: 1,
    title: '工作流演示',
    profileId: 'default',
    tags: [],
    cwd: '/workspace',
    model: '',
    thinkingLevel: '',
    status: 'working',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 100,
    updatedAt: 200,
  }

  const entriesDuringResponse: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '简单演示下工作流编排', origin: 'human' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '正在进行工作流编排…' }],
        },
      ],
    },
  ]

  // 1. 响应中（working + live）：无 msg-hover-bar，不提前渲染「从此处分叉新会话」
  const htmlDuring = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: entriesDuringResponse,
        live: {
          conversationId: 1,
          text: '正在进行工作流编排…',
          tools: [],
          updatedAt: 210,
        },
        onRequestEdit: () => {},
      }),
    ),
  )

  // 人类输入有自己的操作按钮，但 AI 回复块中绝对不得出现分叉与复制按钮
  assert.doesNotMatch(htmlDuring, /Fork a new conversation from here/)

  // 2. 响应彻底完成（idle，live 消除）：展示「从此处分叉新会话」与复制按钮
  const convIdle: ConversationSummary = { ...convWorking, status: 'idle' }
  const htmlSettled = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convIdle] }) },
      e(ConversationTimeline, {
        conversation: convIdle,
        detailEntries: entriesDuringResponse,
        onRequestEdit: () => {},
      }),
    ),
  )

  assert.match(htmlSettled, /Fork a new conversation from here/)
})

test('ConversationTimeline：含工具调用的多段回合，复制按钮只复制最后一段助手回复文本', { timeout: 60_000 }, async () => {
  const convIdle: ConversationSummary = {
    id: 1,
    title: '多段回复复制',
    profileId: 'default',
    tags: [],
    cwd: '/workspace',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 100,
    updatedAt: 200,
  }

  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '帮我查一下配置', origin: 'human' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先读取配置文件看一下。' },
            { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'config.json' } },
          ],
        },
      ],
    },
    {
      id: '3',
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'read',
          content: [{ type: 'text', text: '{"port":3202}' }],
        },
      ],
    },
    {
      id: '4',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '端口配置为 3202，运行正常。' }],
        },
      ],
    },
  ]

  let copiedText = ''
  const navWithClipboard = globalThis.navigator as Navigator & {
    clipboard?: { writeText?: (text: string) => Promise<void> }
  }
  const origClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copiedText = text
      },
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [convIdle] }) },
          e(ConversationTimeline, {
            conversation: convIdle,
            detailEntries: entries,
            onRequestEdit: () => {},
          }),
        ),
      )
    })

    const copyBtn = host.querySelector<HTMLButtonElement>('.msg-ai-block .msg-ai-footer .msg-hover-bar button[aria-label="Copy"]')
    assert.ok(copyBtn !== null, '助手回合底部存在复制按钮')
    await act(async () => {
      copyBtn.click()
      await Promise.resolve()
    })
    assert.equal(copiedText, '端口配置为 3202，运行正常。')
    assert.equal(navWithClipboard !== undefined, true)
  } finally {
    act(() => root.unmount())
    host.remove()
    if (origClipboardDesc !== undefined) {
      Object.defineProperty(globalThis.navigator, 'clipboard', origClipboardDesc)
    } else {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard')
    }
  }
})
