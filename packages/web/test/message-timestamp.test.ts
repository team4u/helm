import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { formatFullTimestamp, formatMessageTime } from '../src/lib/format.js'
import { createServerClock } from '../src/lib/server-clock.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import type { AssistantTurn, FoldableStep, HumanInputItem } from '../src/conversation/timeline-model.js'
import { summarizeStepGroup } from '../src/conversation/tool-body-model.js'
import { makeTestStore as makeMockStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

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

test('timeline-model：HumanInputItem 透传 createdAt（helmx.input 与 entry.createdAt 兜底）', { timeout: 60_000 }, () => {
  const t1 = 1731234500000
  const t2 = 1731234600000

  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'helmx.input',
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

test('timeline-model：toolCall 运行耗时锚点 = 响应结束时刻（timestamp+durationMs），缺 durationMs 不锚定', { timeout: 60_000 }, () => {
  const startMs = 1731234510000
  const durationMs = 2800
  const toolEntry = (message: Record<string, unknown>): ConversationEntry => ({
    id: '5',
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 30' } }],
        stopReason: 'toolCall',
        ...message,
      },
    ],
  })
  /** 工具段可能被折叠进 step-group，递归下钻取第一个 ToolTrace。 */
  const firstToolOf = (turn: AssistantTurn): { startedAt?: number } | undefined => {
    for (const seg of turn.segments as ReadonlyArray<{ kind: string; tool?: { startedAt?: number }; steps?: ReadonlyArray<{ kind: string; tool?: { startedAt?: number } }> }>) {
      if (seg.kind === 'tool' && seg.tool !== undefined) return seg.tool
      if (seg.kind === 'step-group') {
        for (const step of seg.steps ?? []) {
          if (step.kind === 'tool' && step.tool !== undefined) return step.tool
        }
      }
    }
    return undefined
  }

  // 有 timestamp+durationMs：锚点为响应结束（工具回合派发）时刻
  const anchored = buildTimelineItems([toolEntry({ timestamp: startMs, durationMs })])
  const anchoredTool = firstToolOf(anchored[0] as AssistantTurn)
  assert.equal(anchoredTool?.startedAt, startMs + durationMs, '锚点 = 请求起点 + 响应时长')

  // 缺 durationMs（遗留 / deferred 响应）：不锚定，避免从请求起点起算虚高
  const unanchored = buildTimelineItems([toolEntry({ timestamp: startMs })])
  const unanchoredTool = firstToolOf(unanchored[0] as AssistantTurn)
  assert.equal(unanchoredTool?.startedAt, undefined, '无 durationMs 不编造起点')
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
// 2.5 折叠组过程耗时归属（合格响应 = 思考 + 工具调用且无非空正文）
// ---------------------------------------------------------------------------

interface AssistantMsgSpec {
  id: string
  content: unknown[]
  durationMs?: number
}

function processEntry(spec: AssistantMsgSpec): ConversationEntry {
  return {
    id: spec.id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        timestamp: 1731234510000,
        ...(spec.durationMs !== undefined ? { durationMs: spec.durationMs } : {}),
        content: spec.content,
        stopReason: 'stop',
      },
    ],
  }
}

function resultEntry(id: string, callId: string, durationMs?: number): ConversationEntry {
  return {
    id,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'bash',
        content: 'ok',
        isError: false,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ],
  }
}

function firstGroup(turn: AssistantTurn): Extract<AssistantTurn['segments'][number], { kind: 'step-group' }> {
  const seg = turn.segments.find((s) => s.kind === 'step-group')
  assert.ok(seg !== undefined && seg.kind === 'step-group', 'expected a step-group segment')
  return seg
}

test('timeline-model：合格响应（思考+工具调用、无正文）的模型耗时归属到首个思考块，组内各计一次', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 3200,
      content: [
        { type: 'thinking', thinking: '先看文件' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
      ],
    }),
    resultEntry('2', 'c1', 500),
  ]

  const items = buildTimelineItems(entries)
  const turn = items[0] as AssistantTurn
  const group = firstGroup(turn)
  assert.equal(group.steps.length, 2)
  assert.equal(group.steps[0]!.kind, 'thinking')
  assert.equal((group.steps[0] as { thinking: { responseDurationMs?: number } }).thinking.responseDurationMs, 3200)
  assert.equal(group.steps[1]!.kind, 'tool')
  assert.equal((group.steps[1] as { tool: { durationMs?: number } }).tool.durationMs, 500)

  // 折叠组两个分别标注的累计口径：模型响应 3.2s、工具执行 0.5s
  const summary = summarizeStepGroup(group.steps)
  assert.equal(summary.modelDurationMs, 3200)
  assert.equal(summary.toolDurationMs, 500)
  // footer 回合耗时语义不变：仍是本回合全部 assistant duration 之和
  assert.equal(turn.durationMs, 3200)
})

test('timeline-model：含非空可见正文的响应不进入过程统计，footer 回合耗时保持原语义', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 3200,
      content: [
        { type: 'thinking', thinking: '想想' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: '这是给用户的回答正文。' },
      ],
    }),
    resultEntry('2', 'c1', 500),
  ]

  const items = buildTimelineItems(entries)
  const turn = items[0] as AssistantTurn
  const group = firstGroup(turn)
  assert.equal(group.steps[0]!.kind, 'thinking')
  assert.equal((group.steps[0] as { thinking: { responseDurationMs?: number } }).thinking.responseDurationMs, undefined)
  const summary = summarizeStepGroup(group.steps)
  assert.equal('modelDurationMs' in summary, false)
  assert.equal(summary.toolDurationMs, 500)
  // footer 仍计完整回合（不因正文而清零）
  assert.equal(turn.durationMs, 3200)
})

test('timeline-model：同一响应含多个思考块时耗时只归属一次（首个思考块）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 2000,
      content: [
        { type: 'thinking', thinking: '第一段思考' },
        { type: 'thinking', thinking: '第二段思考' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', 100),
  ]

  const items = buildTimelineItems(entries)
  const turn = items[0] as AssistantTurn
  const group = firstGroup(turn)
  const think1 = group.steps[0] as { thinking: { responseDurationMs?: number } }
  const think2 = group.steps[1] as { thinking: { responseDurationMs?: number } }
  assert.equal(think1.thinking.responseDurationMs, 2000)
  assert.equal(think2.thinking.responseDurationMs, undefined)
  assert.equal(summarizeStepGroup(group.steps).modelDurationMs, 2000)
})

test('timeline-model：正文把回合拆成多个折叠组时，每条响应耗时只进入其所在组（跨组去重）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 1000,
      content: [
        { type: 'thinking', thinking: '第一轮' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', 500),
    processEntry({
      id: '3',
      durationMs: 800,
      content: [{ type: 'text', text: '中间一段说明文字。' }],
    }),
    processEntry({
      id: '4',
      durationMs: 2000,
      content: [
        { type: 'thinking', thinking: '第二轮' },
        { type: 'toolCall', id: 'c2', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('5', 'c2', 700),
  ]

  const items = buildTimelineItems(entries)
  assert.equal(items.length, 1)
  const turn = items[0] as AssistantTurn
  const groups = turn.segments.filter((s) => s.kind === 'step-group')
  assert.equal(groups.length, 2)
  const summary1 = summarizeStepGroup((groups[0] as { steps: FoldableStep[] }).steps)
  const summary2 = summarizeStepGroup((groups[1] as { steps: FoldableStep[] }).steps)
  assert.equal(summary1.modelDurationMs, 1000)
  assert.equal(summary1.toolDurationMs, 500)
  assert.equal(summary2.modelDurationMs, 2000)
  assert.equal(summary2.toolDurationMs, 700)
  // 跨组合计恰为两条合格响应各一次（1000 + 2000），无重复计入
  assert.equal(summary1.modelDurationMs! + summary2.modelDurationMs!, 3000)
  // footer 回合耗时 = 全部 assistant duration 之和（1000 + 800 + 2000），语义不变
  assert.equal(turn.durationMs, 3800)
})

test('timeline-model：toolView 特殊卡把工具行拆出折叠组后，响应耗时仍只随思考块归属一次', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 1500,
      content: [
        { type: 'thinking', thinking: '派发子任务' },
        { type: 'toolCall', id: 'c1', name: 'special', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', 300),
  ]

  const items = buildTimelineItems(entries, {
    toolViews: [{ pluginId: 'builtin:test', spec: { id: 'special-view', toolNames: ['special'] } }],
  })
  const turn = items[0] as AssistantTurn
  // 思考块独占折叠组（后续渲染为 ThinkingRow，不显示耗时），特殊卡独立成段
  const group = firstGroup(turn)
  assert.equal(group.steps.length, 1)
  assert.equal(group.steps[0]!.kind, 'thinking')
  assert.equal((group.steps[0] as { thinking: { responseDurationMs?: number } }).thinking.responseDurationMs, 1500)
  const standalone = turn.segments.find((s) => s.kind === 'tool')
  assert.ok(standalone !== undefined, 'toolView card stays a standalone segment')
})

test('timeline-model：非法（NaN/负数/Infinity）与缺失的 durationMs 不伪造归属，边界处剔除负的工具耗时', { timeout: 60_000 }, () => {
  for (const bad of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) {
    const entries: ConversationEntry[] = [
      processEntry({
        id: '1',
        durationMs: bad,
        content: [
          { type: 'thinking', thinking: '思考' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
        ],
      }),
      resultEntry('2', 'c1', 100),
    ]
    const turn = buildTimelineItems(entries)[0] as AssistantTurn
    const group = firstGroup(turn)
    const think = group.steps[0] as { thinking: { responseDurationMs?: number } }
    assert.equal(think.thinking.responseDurationMs, undefined, `durationMs=${bad} must not be attributed`)
  }

  // 缺失 durationMs 的旧 assistant 条目：不归属
  const legacyEntries: ConversationEntry[] = [
    processEntry({
      id: '1',
      content: [
        { type: 'thinking', thinking: '旧数据思考' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', 100),
  ]
  const legacyTurn = buildTimelineItems(legacyEntries)[0] as AssistantTurn
  const legacyGroup = firstGroup(legacyTurn)
  const legacyThink = legacyGroup.steps[0] as { thinking: { responseDurationMs?: number } }
  assert.equal(legacyThink.thinking.responseDurationMs, undefined)
  // 工具侧不受影响
  assert.equal(summarizeStepGroup(legacyGroup.steps).toolDurationMs, 100)

  // 工具结果 durationMs 为负：入口边界剔除，不进入累计也不展示
  const negativeEntries: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 900,
      content: [
        { type: 'thinking', thinking: '思考' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', -50),
  ]
  const negativeTurn = buildTimelineItems(negativeEntries)[0] as AssistantTurn
  const negativeGroup = firstGroup(negativeTurn)
  const toolStep = negativeGroup.steps[1] as { tool: { durationMs?: number } }
  assert.equal(toolStep.tool.durationMs, undefined)
  assert.equal('toolDurationMs' in summarizeStepGroup(negativeGroup.steps), false)
})

test('timeline-model：并行工具与顺序工具在累计口径下如实求和，缺失耗时的旧工具不贡献', { timeout: 60_000 }, () => {
  // 两个并行工具各 5s：累计口径为 10s（UI 端以「工具累计」标注，不冒充墙钟流逝）
  const parallel: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 800,
      content: [
        { type: 'thinking', thinking: '并行执行' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
        { type: 'toolCall', id: 'c2', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1', 5000),
    resultEntry('3', 'c2', 5000),
  ]
  const parallelTurn = buildTimelineItems(parallel)[0] as AssistantTurn
  const parallelSummary = summarizeStepGroup(firstGroup(parallelTurn).steps)
  assert.equal(parallelSummary.modelDurationMs, 800)
  assert.equal(parallelSummary.toolDurationMs, 10000)

  // 顺序工具同样如实累计；缺失 durationMs 的旧结果不贡献也不阻断
  const sequential: ConversationEntry[] = [
    processEntry({
      id: '1',
      durationMs: 800,
      content: [
        { type: 'thinking', thinking: '顺序执行' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('2', 'c1'),
    processEntry({
      id: '3',
      durationMs: 400,
      content: [
        { type: 'thinking', thinking: '继续' },
        { type: 'toolCall', id: 'c2', name: 'bash', arguments: {} },
      ],
    }),
    resultEntry('4', 'c2', 1200),
  ]
  const sequentialTurn = buildTimelineItems(sequential)[0] as AssistantTurn
  const sequentialSummary = summarizeStepGroup(firstGroup(sequentialTurn).steps)
  assert.equal(sequentialSummary.modelDurationMs, 1200)
  assert.equal(sequentialSummary.toolDurationMs, 1200)
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
      kind: 'helmx.input',
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
      HostStoreProviders,
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
  assert.match(html, /Sent at\s+2026-11-10\s+14:28:27/)

  // 2. 助手消息渲染时间与耗时
  assert.match(html, /class="msg-ai-footer"/)
  assert.match(html, /Took 3\.2s/)
  assert.match(html, /Completed at\s+2026-11-10\s+14:28:35\s+·\s+took 3\.2s/)

  // 3. 极简无 Emoji：不包含任何 Emoji 表情图标
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('ConversationTimeline：回合处于 busy（working/live）时不提前渲染时间与耗时', { timeout: 60_000 }, () => {
  const convWorking = makeSummary(1, 'working')

  const startMs = 1731234510000
  const entries: ConversationEntry[] = [
    {
      id: '1',
      kind: 'helmx.input',
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
      HostStoreProviders,
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
  assert.doesNotMatch(html, /Took 3\.2s/)
})


// ---------------------------------------------------------------------------
// 3. server-clock：浏览器↔Hub 时钟偏差估计（运行中秒表的服务端时钟域）
// ---------------------------------------------------------------------------

test('server-clock：offset 样本被单向网络延迟抬高，滑窗取最小值逼近真实偏差', { timeout: 60_000 }, () => {
  let local = 10_000
  const clock = createServerClock(() => local)
  // 服务端真实时刻 ≈ 8000（真实偏差 +2000）；网络延迟 50/120/30ms 只会让样本比 2000 更大
  clock.observeServerEpoch(8000 - 50) // 样本 2050
  clock.observeServerEpoch(8000 - 120) // 样本 2120
  clock.observeServerEpoch(8000 - 30) // 样本 2030 —— 当前最小
  assert.equal(clock.offsetMs(), 2030)
  assert.equal(clock.now(), 10000 - 2030)

  // 更低延迟样本到达后继续收敛
  clock.observeServerEpoch(7999) // 样本 2001
  assert.equal(clock.offsetMs(), 2001)
  assert.equal(clock.now(), 10000 - 2001)

  // 高延迟样本（背压/重放）不会回退估计
  clock.observeServerEpoch(7000) // 样本 3000
  assert.equal(clock.offsetMs(), 2001)
})

test('server-clock：本地时钟中途被校正后，窗口轮换自愈到新偏差', { timeout: 60_000 }, () => {
  let local = 10_000
  const clock = createServerClock(() => local)
  for (let i = 0; i < 32; i++) {
    local = 10_000 + i
    clock.observeServerEpoch(9000 + i) // 旧偏差 +1000
  }
  assert.equal(clock.offsetMs(), 1000)

  // NTP 把本地时钟回拨 5s：新样本偏差 -4000；旧样本被滑窗挤出去后估计翻新
  for (let i = 0; i < 32; i++) {
    local = 5000 + i
    clock.observeServerEpoch(9000 + i)
  }
  assert.equal(clock.offsetMs(), -4000)
  assert.equal(clock.now(), (5000 + 31) - -4000)
})

test('server-clock：非法 epoch 忽略，无样本时偏差为 0（等价旧行为）', { timeout: 60_000 }, () => {
  const clock = createServerClock(() => 10_000)
  clock.observeServerEpoch(Number.NaN)
  clock.observeServerEpoch(0)
  clock.observeServerEpoch(Number.POSITIVE_INFINITY)
  clock.observeServerEpoch(-5)
  assert.equal(clock.offsetMs(), 0)
  assert.equal(clock.now(), 10_000)
})
