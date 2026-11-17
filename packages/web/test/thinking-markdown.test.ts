import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helm/protocol'
import { makeTestStore as makeMockStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { StepGroup, ThinkingRow } = await import('../src/conversation/TimelineRows.js')
const stylesCss = readHostStyles()

test('思考样式契约：.thinking-expanded-body 100% 宽度撑满，段落与列表解除 74ch 限制', { timeout: 60_000 }, () => {
  assert.match(stylesCss, /\.trace-expanded-body\.thinking-expanded-body\s*\{[^}]*max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s*\{[^}]*max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s+p[\s\S]*?max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s+h1[\s\S]*?max-width:\s*100%/)
})

test('消息正文与气泡宽度样式契约：AI 正文段落与列表解除 74ch 限制，人类消息气泡放宽至 840px', { timeout: 60_000 }, () => {
  // 验证 .msg-ai-body p 与 ul/ol 不再包含 74ch
  assert.doesNotMatch(stylesCss, /\.msg-ai-body\s+p\s*\{[^}]*max-width:\s*74ch/)
  assert.doesNotMatch(stylesCss, /\.msg-ai-body\s+ul[\s\S]*?max-width:\s*74ch/)
  // 验证 .msg-human-pill 放宽至 min(88%, 840px)
  assert.match(stylesCss, /\.msg-human-pill\s*\{[^}]*max-width:\s*min\(88%,\s*840px\)/)
})

test('ThinkingRow 组件渲染：展开时使用 MarkdownView 渲染标题与列表并具备 thinking-expanded-body 类', { timeout: 60_000 }, () => {
  const markdownText = '# Deep thinking\n\n- 步骤一\n- 步骤二'
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1, defaultOpen: true }),
    ),
  )

  // 1. 验证 ThinkingRow 正确挂载了 thinking-expanded-body 类名
  assert.match(html, /trace-expanded-body[^"]*thinking-expanded-body/)

  // 2. 验证 Markdown 格式被解析渲染（包含 h1 和 li 标签，而不是裸 pre/code）
  assert.match(html, /<h1[^>]*>Deep thinking<\/h1>/)
  assert.match(html, /<li>步骤一<\/li>/)
  assert.match(html, /<li>步骤二<\/li>/)
  assert.doesNotMatch(html, /code-block-pre-flush/)
})

test('思考过程折叠契约：非进行中（思考结束或历史会话）默认自动折叠，不展开内容正文', { timeout: 60_000 }, () => {
  const markdownText = '# 思考内容\n\n已完成'
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1 }),
    ),
  )

  // 1. 验证默认展示收起摘要按钮「思考过程」与右箭头
  assert.match(html, /Thinking/)
  assert.match(html, /title="Expand thinking"/)
  assert.doesNotMatch(html, /Thinking…/)

  // 2. 验证思考正文未展开（自动折叠）
  assert.doesNotMatch(html, /thinking-expanded-body/)
  assert.doesNotMatch(html, /<h1[^>]*>思考内容<\/h1>/)
})

test('思考进行中契约：active=true 时默认展开并展示转圈 loader 与「正在思考…」', { timeout: 60_000 }, () => {
  const markdownText = '# 思考中…'
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1, active: true }),
    ),
  )

  assert.match(html, /Thinking…/)
  assert.match(html, /spin-slow/)
  assert.match(html, /thinking-expanded-body/)
  assert.match(html, /title="Collapse thinking"/)
})

test('响应与等待态：使用 spinner 转圈指示器，不带「正在等待响应…」文本', { timeout: 60_000 }, () => {
  const convWorking: ConversationSummary = {
    id: 1,
    profileId: 'assistant',
    title: '测试',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: 'off',
    status: 'working',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        onRequestEdit: () => {},
      }),
    ),
  )

  assert.match(html, /aria-label="Generating"/)
  assert.match(html, /spin-slow/)
  assert.doesNotMatch(html, /正在等待响应…/)
})

test('会话时间线思考生命周期契约：思考中展开，思考完后自动折叠并展现正文', { timeout: 60_000 }, () => {
  const convWorking: ConversationSummary = {
    id: 1,
    profileId: 'assistant',
    title: '测试思考生命周期',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: 'medium',
    status: 'working',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  // 1. 思考中阶段（仅流式思考 live.thinking，尚无正文）：呈现「正在思考…」且展开思考内容
  const htmlThinking = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        live: { conversationId: 1, text: '', thinking: '正在Deep thinking方案…', tools: [], updatedAt: 1 },
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlThinking, /Thinking…/)
  assert.match(htmlThinking, /thinking-expanded-body/)
  assert.match(htmlThinking, /正在Deep thinking方案…/)
  // 仅单思考步骤时不显示多余嵌套的「思考与执行过程 (1 步)」
  assert.doesNotMatch(htmlThinking, /思考与执行过程/)

  // 2. 思考完毕开始产出正文阶段（live.text 到达）：思考过程自动折叠，正文露出
  const htmlTextStreaming = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        live: { conversationId: 1, text: '这是最终生成的回复内容', thinking: '正在Deep thinking方案…', tools: [], updatedAt: 2 },
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlTextStreaming, /Thinking/)
  assert.match(htmlTextStreaming, /这是最终生成的回复内容/)
  // 思考已完，自动折叠正文
  assert.doesNotMatch(htmlTextStreaming, /thinking-expanded-body/)
  assert.doesNotMatch(htmlTextStreaming, /Thinking…/)

  // 3. 回合结算落库后（历史会话）：思考过程默认保持折叠
  const convSettled: ConversationSummary = { ...convWorking, status: 'idle' }
  const settledEntry = {
    id: '100',
    conversationId: 1,
    kind: 'pi.assistant' as const,
    model: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '历史沉淀的思考细节' },
          { type: 'text', text: '历史正文' },
        ],
      },
    ],
    createdAt: 1000,
  }

  const htmlSettled = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convSettled] }) },
      e(ConversationTimeline, {
        conversation: convSettled,
        detailEntries: [settledEntry],
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlSettled, /Thinking/)
  assert.match(htmlSettled, /历史正文/)
  // 历史思考默认折叠
  assert.doesNotMatch(htmlSettled, /thinking-expanded-body/)
})



// ---------------------------------------------------------------------------
// 折叠组过程耗时展示契约（诚实口径：不冒充墙钟、不把整段响应标成思考耗时）
// ---------------------------------------------------------------------------

test('ThinkingRow 耗时契约：思考单行不显示模型响应耗时，已知耗时由组头单独标注', { timeout: 60_000 }, () => {
  // 已知模型耗时时，单思考步骤也使用组头显示 Model 标注；耗时不冒充 ThinkingRow 的思考耗时。
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(StepGroup, {
        steps: [{ kind: 'thinking', thinking: { key: 'think:1:0:0', text: '决策过程', responseDurationMs: 3200 } }],
        active: false,
        conversationId: 1,
        siblingCalls: [],
      }),
    ),
  )
  assert.match(html, /Thinking \(1 steps\)/)
  assert.match(html, /Model 3\.2s/)
  assert.match(html, /trace-group-meta/)
  assert.doesNotMatch(html, /Thinking3\.2s/)
})

test('折叠组耗时契约：合格模型响应耗时与工具累计耗时以两个分别标注的徽标展示', { timeout: 60_000 }, () => {
  // 思考（归属 3.2s）+ 两个并行 5s 工具：Model 3.2s 与 Tools 10.0s 分别标注，且带说明性 tooltip
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(StepGroup, {
        steps: [
          { kind: 'thinking', thinking: { key: 'think:1:0:0', text: '决策过程', responseDurationMs: 3200 } },
          { kind: 'tool', tool: { key: 'tool:c1', toolName: 'bash', status: 'done', isError: false, durationMs: 5000 } },
          { kind: 'tool', tool: { key: 'tool:c2', toolName: 'read', status: 'done', isError: false, durationMs: 5000 } },
        ],
        active: false,
        conversationId: 1,
        siblingCalls: [],
      }),
    ),
  )
  assert.match(html, /Model 3\.2s/)
  assert.match(html, /Tools 10\.0s/)
  // 徽标必须带语义说明（累计口径、并行各计自身、非墙钟流逝）
  assert.match(html, /title="Cumulative model response time[^"]*not wall-clock elapsed time"/)
  assert.match(html, /title="Cumulative tool execution time[^"]*parallel tools each count their own execution/)
  // 不允许退回无标注的裸耗时徽标（会把并行累计冒充为流逝时间）
  assert.doesNotMatch(html, /trace-group-meta[^>]*>\s*[\d.]+m?s\s*</)
})

test('折叠组耗时契约：进行中（active）不展示耗时徽标；缺耗时不伪造', { timeout: 60_000 }, () => {
  const activeHtml = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(StepGroup, {
        steps: [
          { kind: 'thinking', thinking: { key: 'think:1:0:0', text: '进行中思考' } },
          { kind: 'tool', tool: { key: 'tool:c1', toolName: 'bash', status: 'running', isError: false } },
        ],
        active: true,
        conversationId: 1,
        siblingCalls: [],
      }),
    ),
  )
  assert.doesNotMatch(activeHtml, /Model /)
  assert.doesNotMatch(activeHtml, /Tools /)
  assert.doesNotMatch(activeHtml, /trace-group-meta/)

  // 无任何已知耗时：不显示徽标，也不显示占位
  const idleHtml = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore() },
      e(StepGroup, {
        steps: [
          { kind: 'thinking', thinking: { key: 'think:1:0:0', text: '无耗时数据的历史思考' } },
          { kind: 'tool', tool: { key: 'tool:c1', toolName: 'bash', status: 'done', isError: false } },
        ],
        active: false,
        conversationId: 1,
        siblingCalls: [],
      }),
    ),
  )
  assert.doesNotMatch(idleHtml, /Model /)
  assert.doesNotMatch(idleHtml, /Tools /)
  assert.doesNotMatch(idleHtml, /trace-group-meta/)
})
