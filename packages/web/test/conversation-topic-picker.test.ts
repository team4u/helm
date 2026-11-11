/**
 * 主舞台顶栏话题切换器（TopicPicker）契约测试：
 * Radix Popover 结构、SSR 渲染行为与话题模型纯函数。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
import { TopicPicker } from '../src/conversation/conversation-topic-picker.js'
import { computeTopicPickerModel, searchTopicList } from '../src/conversation/conversation-topic-model.js'

const e = React.createElement
// SSR 渲染运行时依赖（与 shell-modals.test.ts 同策略）
;(globalThis as Record<string, unknown>).React = React
const pickerSource = readFileSync(new URL('../src/conversation/conversation-topic-picker.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')

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

function pickerStore(partial: Partial<HelmStoreValue> = {}): HelmStoreValue {
  return makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 10, title: '周末计划', profileId: 'assistant', updatedAt: 9000 }),
      conv({ id: 11, title: '代码审查', profileId: 'assistant', updatedAt: 8000, status: 'working', doing: '审查中' }),
      conv({ id: 40, title: '重构方案', profileId: 'coder', updatedAt: 9500 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    ...partial,
  })
}

test('TopicPicker 源码契约：Radix Popover 结构与无手写浮层', { timeout: 60_000 }, () => {
  assert.match(pickerSource, /import\s*\{[^}]*PopoverPortal[^}]*\}\s*from\s*'\.\.\/ui\/Popover\.js'/)
  assert.match(pickerSource, /<PopoverTrigger asChild>/)
  assert.match(pickerSource, /<PopoverPortal>/)
  assert.match(pickerSource, /<PopoverContent[^>]*topic-picker-popover/)
  // 不手写 document/window 事件监听，Esc/焦点交给 Radix
  assert.doesNotMatch(pickerSource, /addEventListener/)
  // 无原生 select
  assert.doesNotMatch(pickerSource, /<select/)
})

test('TopicPicker SSR：触发器展示当前智能体/话题身份与话题数', { timeout: 60_000 }, () => {
  const store = pickerStore({ primaryTarget: { kind: 'conversation', conversationId: 1 } })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(TopicPicker, { conversation: store.conversations[0]! })),
  )
  assert.ok(html.includes('topic-picker-trigger'), '触发器类名')
  assert.ok(html.includes('个人助理'), '当前 profile 名称')
  assert.ok(html.includes('个人助理</span>') || html.includes('个人助理'), '当前话题标题')
  assert.ok(html.includes('>3</span>'), '当前 profile 话题计数（含 #1/#10/#11）')
  // 关闭状态下 Popover 内容不渲染（Radix SSR 行为）
  assert.ok(!html.includes('topic-picker-search'), '关闭状态不渲染搜索框')
})

test('TopicPicker 切换目标：分屏窗格 openTarget 带 split 选项', { timeout: 60_000 }, () => {
  assert.match(
    pickerSource,
    /store\.openTarget\(\s*\{\s*kind:\s*'conversation',\s*conversationId:\s*convId\s*\},\s*isSplit \? \{ split: true \} : undefined,\s*\)/,
    '切换话题必须按窗格上下文决定 split 目标',
  )
})

test('ConversationPane 接入话题切换器且保留主顶栏新话题语义（标题身份收敛进切换器）', { timeout: 60_000 }, () => {
  assert.match(paneSource, /import\s*\{\s*TopicPicker\s*\}\s*from\s*'\.\/conversation-topic-picker\.js'/)
  assert.match(paneSource, /<TopicPicker\s+conversation=\{conversation\}/)
  // 主顶栏新话题入口保留，且与 Popover 共用同一 createNewThread（继承 node/cwd/profile）
  assert.match(paneSource, /const createNewThread = \(\): void => \{/)
  assert.match(paneSource, /onClick=\{createNewThread\}/)
  assert.match(paneSource, /profileId:\s*conversation\.profileId,\s*nodeId:\s*currentNodeId,\s*cwd:\s*conversation\.cwd/)
  // 顶栏不再保留独立的可重命名 pane-title；重命名收纳进「更多操作」菜单
  assert.doesNotMatch(paneSource, /title="点击重命名"/)
  assert.match(paneSource, /重命名会话/)
})

test('computeTopicPickerModel 推导身份与话题列表', { timeout: 60_000 }, () => {
  const store = pickerStore()
  const model = computeTopicPickerModel({
    conversation: store.conversations[0]!,
    conversations: store.conversations,
    profileLabel: '个人助理',
  })
  assert.equal(model.profileLabel, '个人助理')
  assert.equal(model.currentTitle, '个人助理')
  assert.equal(model.topicCount, 3)
  assert.deepEqual(model.topics.map((t) => t.conv.id), [10, 11, 1])
  // profile 缺失时回退 profileId，空标题回退 #id
  const fallback = computeTopicPickerModel({
    conversation: { ...conv({ id: 10, title: '', profileId: 'coder' }) },
    conversations: [conv({ id: 10, title: '', profileId: 'coder' })],
  })
  assert.equal(fallback.profileLabel, 'coder')
  assert.equal(fallback.currentTitle, '会话 #10')
})

test('searchTopicList 过滤话题列表', { timeout: 60_000 }, () => {
  const model = computeTopicPickerModel({
    conversation: conv({ id: 1, profileId: 'assistant' }),
    conversations: [
      conv({ id: 1, title: '周末计划', profileId: 'assistant' }),
      conv({ id: 2, title: '代码审查', profileId: 'assistant' }),
    ],
  })
  assert.deepEqual(searchTopicList(model.topics, '').map((t) => t.conv.id), [2, 1])
  assert.deepEqual(searchTopicList(model.topics, '代码').map((t) => t.conv.id), [2])
  assert.equal(searchTopicList(model.topics, 'zzz').length, 0)
})
