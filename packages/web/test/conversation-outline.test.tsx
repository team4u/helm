import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import {
  buildConversationOutline,
  buildMarkdownOutline,
  countOutlineTurns,
  extractMarkdownHeadings,
  filterOutlineNodes,
  resolveActiveOutlineEntryId,
  stripInlineMarkdown,
  summarizeHumanOutlineText,
} from '../src/conversation/outline-model.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import { makeTestStore } from './helpers/store.js'

try {
  GlobalRegistrator.register()
} catch {
  // 已注册
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HelmStoreContext } = await import('../src/lib/store-context.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const e = React.createElement

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 1. outline-model 纯函数测试
// ---------------------------------------------------------------------------

test('stripInlineMarkdown 与 summarizeHumanOutlineText：清理行内格式、取首个非空行并回退附件计数', { timeout: 60_000 }, () => {
  assert.equal(stripInlineMarkdown('**加粗** 与 `code` 及 [链接](https://example.com)'), '加粗 与 code 及 链接')
  assert.equal(summarizeHumanOutlineText('\n\n# 第一行标题\n第二行正文'), '第一行标题')
  assert.equal(summarizeHumanOutlineText('   ', 2), '[附件 ×2]')
  assert.equal(summarizeHumanOutlineText(''), '（空消息）')
})

test('buildMarkdownOutline：为 Markdown H1~H3 生成稳定定位节点', { timeout: 60_000 }, () => {
  assert.deepEqual(buildMarkdownOutline('# 总览\n\n## 安装\n\n### 验证\n#### 细节'), [
    { kind: 'heading', key: 'outline:markdown:0', entryId: 'markdown-preview', headingIndex: 0, level: 1, text: '总览' },
    { kind: 'heading', key: 'outline:markdown:1', entryId: 'markdown-preview', headingIndex: 1, level: 2, text: '安装' },
    { kind: 'heading', key: 'outline:markdown:2', entryId: 'markdown-preview', headingIndex: 2, level: 3, text: '验证' },
  ])
})

test('extractMarkdownHeadings：提取 H1~H3 并严格跳过代码块围栏内的 # 注释', { timeout: 60_000 }, () => {
  const md = [
    '# 架构总览',
    '一些介绍文字',
    '```bash',
    '# 这是 bash 注释，绝不能当成标题',
    'echo "hello"',
    '```',
    '## 核心模块 `kernel`',
    '~~~python',
    '## python comment',
    '~~~',
    '### 1. 状态机设计 ###',
    '> ### 引用中的章节',
    '#### H4 粒度过细不提取',
  ].join('\n')

  const headings = extractMarkdownHeadings(md)
  assert.deepEqual(headings, [
    { level: 1, text: '架构总览' },
    { level: 2, text: '核心模块 kernel' },
    { level: 3, text: '1. 状态机设计' },
    { level: 3, text: '引用中的章节' },
  ])
})

test('buildConversationOutline 与 filterOutlineNodes：构建完整树、支持关键词过滤与父提问保留', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { id: 'in-1', text: '帮我分析数据库慢查询\n附上日志', origin: 'human' }, createdAt: 1000 },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '# 慢查询根因\n\n## 索引缺失分析\n正文内容' }],
        },
      ],
    },
    { id: '3', kind: 'pi.reset', data: { handoff: '已重置' } },
    { id: '4', kind: 'helm.input', data: { id: 'in-2', text: '接下来优化 Redis 缓存策略', origin: 'human' }, createdAt: 2000 },
    {
      id: '5',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '## 缓存过期与淘汰策略' }],
        },
      ],
    },
  ]

  const items = buildTimelineItems(entries)
  const nodes = buildConversationOutline(items)

  assert.equal(countOutlineTurns(nodes), 2)
  assert.deepEqual(
    nodes.map((n) => (n.kind === 'human' ? `Q#${n.turnIndex}:${n.label}` : n.kind === 'heading' ? `H${n.level}:${n.text}` : `D:${n.divider}`)),
    [
      'Q#1:帮我分析数据库慢查询',
      'H1:慢查询根因',
      'H2:索引缺失分析',
      'D:reset',
      'Q#2:接下来优化 Redis 缓存策略',
      'H2:缓存过期与淘汰策略',
    ],
  )

  // 仅看提问模式：过滤掉所有 heading，保留 human 与 divider
  const questionsOnly = filterOutlineNodes(nodes, { includeHeadings: false })
  assert.deepEqual(
    questionsOnly.map((n) => n.kind),
    ['human', 'divider', 'human'],
  )

  // 搜索子标题 "索引缺失"：自动保留所属父提问 Q#1
  const byHeading = filterOutlineNodes(nodes, { query: '索引缺失' })
  assert.deepEqual(
    byHeading.map((n) => (n.kind === 'human' ? `Q#${n.turnIndex}` : n.kind === 'heading' ? n.text : n.kind)),
    ['Q#1', '索引缺失分析'],
  )

  // 搜索全文（第二行 "附上日志" 虽然不在首行 label 中，但仍在 fullText 中可搜到）
  const byFullText = filterOutlineNodes(nodes, { query: '附上日志' })
  assert.equal(byFullText.length, 1)
  assert.equal(byFullText[0]?.kind, 'human')
  assert.equal(byFullText[0]?.entryId, '1')

  // 按轮次号 "#2" 精确匹配第 2 轮提问
  const byTurnTag = filterOutlineNodes(nodes, { query: '#2' })
  assert.equal(byTurnTag.length, 1)
  assert.equal(byTurnTag[0]?.entryId, '4')
})

test('resolveActiveOutlineEntryId：按滚动基准线推导当前激活条目', { timeout: 60_000 }, () => {
  assert.equal(resolveActiveOutlineEntryId([]), undefined)
  // 全部在基准线下方（刚在顶部）时取首项
  assert.equal(
    resolveActiveOutlineEntryId([
      { entryId: '1', top: 120 },
      { entryId: '2', top: 400 },
    ], 96),
    '1',
  )
  // 取最后一个已越过基准线（top <= 96）的锚点
  assert.equal(
    resolveActiveOutlineEntryId([
      { entryId: '1', top: -320 },
      { entryId: '2', top: 40 },
      { entryId: '4', top: 260 },
    ], 96),
    '2',
  )
})

// ---------------------------------------------------------------------------
// 2. ConversationPane 大纲浮层 DOM 交互与滚动定位测试
// ---------------------------------------------------------------------------

function makeConv(id: number): ConversationSummary {
  return {
    id,
    title: '长对话压测',
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 2,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
  }
}

test('ConversationPane 顶栏渲染大纲按钮，打开浮层后支持搜索过滤与点击滚动定位目标消息/章节', { timeout: 60_000 }, async () => {
  const conv = makeConv(10)
  const entries: ConversationEntry[] = [
    { id: '101', kind: 'helm.input', data: { id: 'q1', text: '第一个问题：如何配置节点隧道？', origin: 'human' }, createdAt: 1000 },
    {
      id: '102',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '# 隧道配置指南\n正文一\n## 端口转发命令\n正文二' }],
        },
      ],
    },
    { id: '103', kind: 'helm.input', data: { id: 'q2', text: '第二个问题：如何排查插件加载失败？', origin: 'human' }, createdAt: 2000 },
    {
      id: '104',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '排查步骤如下。' }],
        },
      ],
    },
  ]

  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: {
      10: { ...conv, entries },
    },
  })

  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmStoreContext.Provider, { value: store }, e(ConversationPane, { conversationId: 10 })))
  })

  // 1. 顶栏出现「大纲」触发按钮且角标显示 2 轮提问
  const triggerBtn = document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')
  assert.ok(triggerBtn, '会话非空时顶栏应渲染大纲按钮')
  assert.match(triggerBtn.textContent ?? '', /大纲/)
  assert.match(triggerBtn.textContent ?? '', /2/)

  // 2. 点击展开大纲 Popover
  await act(async () => {
    triggerBtn.click()
  })
  const popover = document.querySelector<HTMLElement>('.conversation-outline-popover')
  assert.ok(popover, '点击后应展开会话大纲浮层')

  const options = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
  assert.equal(options.length, 4, '应渲染 2 条提问 + 2 条 Markdown 标题')

  // 3. 点击第 2 个标题（H2 端口转发命令，对应 entryId=102, headingIndex=1）触发精准滚动
  const scrolledElements: HTMLElement[] = []
  const origScrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () {
    scrolledElements.push(this)
  }

  try {
    const h2Option = options.find((btn) => (btn.textContent ?? '').includes('端口转发命令'))
    assert.ok(h2Option, '大纲列表应包含「端口转发命令」H2 标题项')
    await act(async () => {
      h2Option.click()
    })

    // 点击后浮层关闭，且目标 H2 元素被 scrollIntoView，所属回合包装容器获得 entry-highlighted 高亮类
    assert.ok(scrolledElements.length > 0, '点击大纲项应触发 scrollIntoView')
    const lastScrolled = scrolledElements[scrolledElements.length - 1]!
    assert.equal(lastScrolled.tagName.toLowerCase(), 'h2', '点击子标题应精确滚动到对应 <h2> DOM 节点')
    assert.match(lastScrolled.textContent ?? '', /端口转发命令/)

    const turnWrapper = host.querySelector<HTMLElement>('[data-entry-id="102"]')
    assert.ok(turnWrapper?.className.includes('entry-highlighted'), '目标回合容器应触发 entry-highlighted 高亮动效')
  } finally {
    HTMLElement.prototype.scrollIntoView = origScrollIntoView
  }
})
