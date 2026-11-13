import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore as makeMockStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline, ThinkingRow } = await import('../src/conversation/ConversationTimeline.js')
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('思考样式契约：.thinking-expanded-body 100% 宽度撑满，段落与列表解除 74ch 限制', { timeout: 60_000 }, () => {
  assert.match(stylesCss, /\.trace-expanded-body\.thinking-expanded-body\s*\{[^}]*max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s*\{[^}]*max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s+p[\s\S]*?max-width:\s*100%/)
  assert.match(stylesCss, /\.thinking-expanded-body\s+\.msg-ai-body\s+h1[\s\S]*?max-width:\s*100%/)
})

test('消息正文与气泡宽度样式契约：AI 正文段落与列表解除 74ch 限制，人类消息气泡放宽至 720px', { timeout: 60_000 }, () => {
  // 验证 .msg-ai-body p 与 ul/ol 不再包含 74ch
  assert.doesNotMatch(stylesCss, /\.msg-ai-body\s+p\s*\{[^}]*max-width:\s*74ch/)
  assert.doesNotMatch(stylesCss, /\.msg-ai-body\s+ul[\s\S]*?max-width:\s*74ch/)
  // 验证 .msg-human-pill 放宽至 min(88%, 720px)
  assert.match(stylesCss, /\.msg-human-pill\s*\{[^}]*max-width:\s*min\(88%,\s*720px\)/)
})

test('ThinkingRow 组件渲染：展开时使用 MarkdownView 渲染标题与列表并具备 thinking-expanded-body 类', { timeout: 60_000 }, () => {
  const markdownText = '# 深度思考\n\n- 步骤一\n- 步骤二'
  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1, defaultOpen: true }),
    ),
  )

  // 1. 验证 ThinkingRow 正确挂载了 thinking-expanded-body 类名
  assert.match(html, /trace-expanded-body[^"]*thinking-expanded-body/)

  // 2. 验证 Markdown 格式被解析渲染（包含 h1 和 li 标签，而不是裸 pre/code）
  assert.match(html, /<h1[^>]*>深度思考<\/h1>/)
  assert.match(html, /<li>步骤一<\/li>/)
  assert.match(html, /<li>步骤二<\/li>/)
  assert.doesNotMatch(html, /code-block-pre-flush/)
})

test('思考过程折叠契约：非进行中（思考结束或历史会话）默认自动折叠，不展开内容正文', { timeout: 60_000 }, () => {
  const markdownText = '# 思考内容\n\n已完成'
  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1 }),
    ),
  )

  // 1. 验证默认展示收起摘要按钮「思考过程」与右箭头
  assert.match(html, /思考过程/)
  assert.match(html, /title="展开思考过程"/)
  assert.doesNotMatch(html, /正在思考…/)

  // 2. 验证思考正文未展开（自动折叠）
  assert.doesNotMatch(html, /thinking-expanded-body/)
  assert.doesNotMatch(html, /<h1[^>]*>思考内容<\/h1>/)
})

test('思考进行中契约：active=true 时默认展开并展示转圈 loader 与「正在思考…」', { timeout: 60_000 }, () => {
  const markdownText = '# 思考中…'
  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1, active: true }),
    ),
  )

  assert.match(html, /正在思考…/)
  assert.match(html, /spin-slow/)
  assert.match(html, /thinking-expanded-body/)
  assert.match(html, /title="收起思考过程"/)
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
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        onRequestEdit: () => {},
      }),
    ),
  )

  assert.match(html, /aria-label="正在生成"/)
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
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        live: { conversationId: 1, text: '', thinking: '正在深度思考方案…', tools: [], updatedAt: 1 },
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlThinking, /正在思考…/)
  assert.match(htmlThinking, /thinking-expanded-body/)
  assert.match(htmlThinking, /正在深度思考方案…/)
  // 仅单思考步骤时不显示多余嵌套的「思考与执行过程 (1 步)」
  assert.doesNotMatch(htmlThinking, /思考与执行过程/)

  // 2. 思考完毕开始产出正文阶段（live.text 到达）：思考过程自动折叠，正文露出
  const htmlTextStreaming = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: [],
        live: { conversationId: 1, text: '这是最终生成的回复内容', thinking: '正在深度思考方案…', tools: [], updatedAt: 2 },
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlTextStreaming, /思考过程/)
  assert.match(htmlTextStreaming, /这是最终生成的回复内容/)
  // 思考已完，自动折叠正文
  assert.doesNotMatch(htmlTextStreaming, /thinking-expanded-body/)
  assert.doesNotMatch(htmlTextStreaming, /正在思考…/)

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
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [convSettled] }) },
      e(ConversationTimeline, {
        conversation: convSettled,
        detailEntries: [settledEntry],
        onRequestEdit: () => {},
      }),
    ),
  )
  assert.match(htmlSettled, /思考过程/)
  assert.match(htmlSettled, /历史正文/)
  // 历史思考默认折叠
  assert.doesNotMatch(htmlSettled, /thinking-expanded-body/)
})


