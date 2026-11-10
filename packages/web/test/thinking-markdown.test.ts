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

test('ThinkingRow 组件渲染：使用 MarkdownView 渲染标题与列表并具备 thinking-expanded-body 类', { timeout: 60_000 }, () => {
  const markdownText = '# 深度思考\n\n- 步骤一\n- 步骤二'
  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore() },
      e(ThinkingRow, { text: markdownText, conversationId: 1 }),
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

