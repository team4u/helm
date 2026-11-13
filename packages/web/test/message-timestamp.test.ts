import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { formatFullTimestamp, formatMessageTime } from '../src/lib/format.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import type { AssistantTurn, HumanInputItem } from '../src/conversation/timeline-model.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore as makeMockStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

const stylesCss = readHostStyles()

// ---------------------------------------------------------------------------
// 1. formatMessageTime 纯函数测试
// ---------------------------------------------------------------------------

test('formatMessageTime：当天返回 HH:mm，跨天返回 MM-DD HH:mm，非法返回空串', { timeout: 60_000 }, () => {
  // 假定当前参考时间为 2026-11-10 16:30:00 (本地时间)
  const refDate = new Date(2026, 10, 10, 16, 30, 0)
  const now = refDate.getTime()

  // 同一天内的时刻（2026-11-10 14:28:05）-> "14:28"
  const sameDayMs = new Date(2026, 10, 10, 14, 28, 5).getTime()
  assert.equal(formatMessageTime(sameDayMs, now), '14:28')

  // 同一天凌晨（2026-11-10 09:05:00）补零 -> "09:05"
  const sameDayMorningMs = new Date(2026, 10, 10, 9, 5, 0).getTime()
  assert.equal(formatMessageTime(sameDayMorningMs, now), '09:05')

  // 跨天消息（2026-11-09 14:28:00）-> "11-09 14:28"
  const prevDayMs = new Date(2026, 10, 9, 14, 28, 0).getTime()
  assert.equal(formatMessageTime(prevDayMs, now), '11-09 14:28')

  // 跨更早月份（2026-05-04 08:06:00）-> "05-04 08:06"
  const earlierMonthMs = new Date(2026, 4, 4, 8, 6, 0).getTime()
  assert.equal(formatMessageTime(earlierMonthMs, now), '05-04 08:06')

  // 支持 options 传参形态
  assert.equal(formatMessageTime(sameDayMs, { now }), '14:28')
  assert.equal(formatMessageTime(prevDayMs, { now }), '11-09 14:28')

  // 非法或缺失参数返回空串
  assert.equal(formatMessageTime(undefined), '')
  assert.equal(formatMessageTime(0), '')
  assert.equal(formatMessageTime(-1), '')
  assert.equal(formatMessageTime(Number.NaN), '')
  assert.equal(formatMessageTime(Number.POSITIVE_INFINITY), '')
})

test('formatFullTimestamp：返回 YYYY-MM-DD HH:mm:ss 完整时间戳，非法返回空串', { timeout: 60_000 }, () => {
  const d = new Date(2026, 10, 10, 14, 28, 32)
  assert.equal(formatFullTimestamp(d.getTime()), '2026-11-10 14:28:32')

  assert.equal(formatFullTimestamp(undefined), '')
  assert.equal(formatFullTimestamp(0), '')
  assert.equal(formatFullTimestamp(-100), '')
  assert.equal(formatFullTimestamp(Number.NaN), '')
})

// ---------------------------------------------------------------------------
// 2. timeline-model 时间与耗时解析
// ---------------------------------------------------------------------------

test('timeline-model：HumanInputItem 透传 createdAt（helm.input 与 entry.createdAt 兜底）', { timeout: 60_000 }, () => {
  const t1 = 1731234500000
  const t2 = 1731234600000

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'helm.input',
      data: { text: '带数据 createdAt 的输入', origin: 'human', createdAt: t1 },
    },
    {
      id: '2',
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: '裸 pi.user 输入' }] }],
      createdAt: t2,
    },
  ]

  const items = buildTimelineItems(entries)
  assert.equal(items.length, 2)
  const item1 = items[0] as HumanInputItem
  const item2 = items[1] as HumanInputItem

  assert.equal(item1.kind, 'human')
  assert.equal(item1.createdAt, t1)

  assert.equal(item2.kind, 'human')
  assert.equal(item2.createdAt, t2)
})

test('timeline-model：live.queuedInputs 透传 createdAt', { timeout: 60_000 }, () => {
  const tQueued = 1731234700000
  const items = buildTimelineItems([], {
    live: {
      conversationId: 1,
      text: '',
      tools: [],
      updatedAt: 100,
      queuedInputs: [
        {
          id: 'q-1',
          submissionId: 'sub-1',
          text: '排队中的输入',
          mode: 'followUp',
          origin: 'human',
          createdAt: tQueued,
        },
      ],
    },
  })

  assert.equal(items.length, 1)
  const item = items[0] as HumanInputItem
  assert.equal(item.kind, 'human')
  assert.equal(item.createdAt, tQueued)
})

test('timeline-model：AssistantTurn 正确解析 startedAt, settledAt 与 durationMs', { timeout: 60_000 }, () => {
  const startMs = 1731234510000
  const durationMs = 3200

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: startMs,
          durationMs,
          content: [{ type: 'text', text: '你好！这是助手回答。' }],
          stopReason: 'stop',
        },
      ],
    },
  ]

  const items = buildTimelineItems(entries)
  assert.equal(items.length, 1)
  const turn = items[0] as AssistantTurn
  assert.equal(turn.kind, 'assistant')
  assert.equal(turn.startedAt, startMs)
  assert.equal(turn.settledAt, startMs + durationMs)
  assert.equal(turn.durationMs, durationMs)
})

test('timeline-model：多步骤回合累加 AssistantMessage durationMs 并以最小 startedAt 与最大 settledAt 结算', { timeout: 60_000 }, () => {
  const step1Start = 1731234510000
  const step1Duration = 1200 // 1731234511200 settled
  const step2Start = 1731234515000
  const step2Duration = 2000 // 1731234517000 settled

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: step1Start,
          durationMs: step1Duration,
          content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo 1' } }],
        },
      ],
    },
    {
      id: '2',
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'c1',
          content: '1',
          isError: false,
          durationMs: 400,
        },
      ],
    },
    {
      id: '3',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: step2Start,
          durationMs: step2Duration,
          content: [{ type: 'text', text: '执行完毕' }],
          stopReason: 'stop',
        },
      ],
    },
  ]

  const items = buildTimelineItems(entries)
  assert.equal(items.length, 1)
  const turn = items[0] as AssistantTurn
  assert.equal(turn.kind, 'assistant')
  assert.equal(turn.startedAt, step1Start)
  assert.equal(turn.settledAt, step2Start + step2Duration)
  // 累加两段 assistant duration: 1200 + 2000 = 3200
  assert.equal(turn.durationMs, 3200)
})

test('timeline-model：无显式 durationMs 但有跨度 timestamp 时得出 durationMs', { timeout: 60_000 }, () => {
  const step1Start = 1731234510000
  const step2Start = 1731234515000

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: step1Start,
          content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo 1' } }],
        },
      ],
    },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: step2Start,
          content: [{ type: 'text', text: '完成' }],
        },
      ],
    },
  ]

  const items = buildTimelineItems(entries)
  assert.equal(items.length, 1)
  const turn = items[0] as AssistantTurn
  assert.equal(turn.startedAt, step1Start)
  assert.equal(turn.settledAt, step2Start)
  assert.equal(turn.durationMs, step2Start - step1Start)
})

// ---------------------------------------------------------------------------
// 3. ConversationTimeline 界面渲染与样式契约
// ---------------------------------------------------------------------------

function makeSummary(id: number, status: 'idle' | 'working'): ConversationSummary {
  return {
    id,
    title: '测试会话',
    profileId: 'default',
    tags: [],
    cwd: '/root/test',
    model: '',
    thinkingLevel: '',
    status,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
  }
}

test('ConversationTimeline：完成回合渲染时间与耗时，以及 Tooltip 完整本地化时间', { timeout: 60_000 }, () => {
  const conv = makeSummary(1, 'idle')

  const d = new Date(2026, 10, 10, 14, 28, 32)
  const startMs = d.getTime()
  const durationMs = 3200

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'helm.input',
      data: { text: '查询状态', origin: 'human', createdAt: startMs - 5000 },
    },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: startMs,
          durationMs,
          content: [{ type: 'text', text: '全部服务正常运行。' }],
          stopReason: 'stop',
        },
      ],
    },
  ]

  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [conv] }) },
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: entries,
        onRequestEdit: () => {},
      }),
    ),
  )

  // 1. 用户消息渲染发送时间
  assert.match(html, /class="msg-human-footer"/)
  assert.match(html, /class="msg-time-meta"/)
  assert.match(html, /发送于\s+2026-11-10\s+14:28:27/)

  // 2. 助手消息渲染时间与耗时
  assert.match(html, /class="msg-ai-footer"/)
  assert.match(html, /耗时 3\.2s/)
  assert.match(html, /完成于\s+2026-11-10\s+14:28:35\s+·\s+耗时 3\.2s/)

  // 3. 极简无 Emoji：不包含任何 Emoji 表情图标
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('ConversationTimeline：回合处于 busy（working/live）时不提前渲染时间与耗时', { timeout: 60_000 }, () => {
  const convWorking = makeSummary(1, 'working')

  const startMs = 1731234510000
  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'helm.input',
      data: { text: '运行长任务', origin: 'human' },
    },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          timestamp: startMs,
          durationMs: 3200,
          content: [{ type: 'text', text: '正在进行中…' }],
        },
      ],
    },
  ]

  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: entries,
        live: {
          conversationId: 1,
          text: '正在进行中…',
          tools: [],
          updatedAt: startMs + 1000,
        },
        onRequestEdit: () => {},
      }),
    ),
  )

  // 响应中时不展示 AI 底部操作条与耗时信息
  assert.doesNotMatch(html, /class="msg-ai-footer"/)
  assert.doesNotMatch(html, /耗时 3\.2s/)
})

test('样式契约：msg-time-meta 与 msg-ai-footer / msg-human-footer 样式规范', { timeout: 60_000 }, () => {
  assert.match(stylesCss, /\.msg-ai-footer\s*\{[^}]*display:\s*flex/)
  assert.match(stylesCss, /\.msg-human-footer\s*\{[^}]*display:\s*flex/)
  assert.match(stylesCss, /\.msg-time-meta\s*\{[^}]*color:\s*var\(--fg-subtle\)/)
  assert.match(stylesCss, /\.msg-time-meta\s*\{[^}]*font-size:\s*11px/)
  assert.match(stylesCss, /\.msg-time-meta\s*\{[^}]*font-variant-numeric:\s*tabular-nums/)
})
