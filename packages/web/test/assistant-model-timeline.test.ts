/**
 * 助手实际生成模型边界与标签：
 * - 只基于 pi.assistant entry 的 model[0]（provider/model）派生，
 *   绝不读取 conversation.model 冒充历史事实；
 * - 模型身份只比较 provider+model：thinkingLevel 不参与拆分与边界，
 *   且仅在本回合全部条目一致时才在完整标签中展示；
 * - 相邻 assistant 回合模型不同（含同一工具回合 A→B、以及中间隔了 human
 *   输入的正常对话）在新模型回合前渲染边界，保留 tool-result 配对；
 * - 身份不完整/非法不拆分、不产生边界；回合内混入不可信 entry 时该回合整体
 *   不归因任何已知模型（不把未知内容伪装成已知模型产出）；先未知后已知
 *   不比较、不拆分、不贴标签；
 * - live / rewind 不产生假边界；busy 回合不展示模型标签。
 */
import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helmx/protocol'
import {
  assistantModelFullLabel,
  assistantModelShortLabel,
  buildAssistantModelBoundaries,
  buildTimelineItems,
  parseAssistantModelIdentity,
  sameAssistantModelIdentity,
  type AssistantModelIdentity,
  type AssistantTurn,
} from '../src/conversation/timeline-model.js'
import { makeTestStore as makeMockStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

const stylesCss = readHostStyles()

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

/** 携带真实生成元数据（provider/model/thinkingLevel）的 pi.assistant entry。 */
function modelAssistantEntry(
  id: string,
  provider: string,
  model: string,
  blocks: unknown[],
  opts: { thinkingLevel?: string } = {},
): ConversationEntry {
  return {
    id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        provider,
        model,
        ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
        content: blocks,
        timestamp: 1731234510000,
        stopReason: 'stop',
      },
    ],
  }
}

/** 无生成元数据的旧格式 pi.assistant entry。 */
function legacyAssistantEntry(id: string, blocks: unknown[]): ConversationEntry {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: blocks }] }
}

function humanInputEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'helmx.input', data: { text, origin: 'human' } }
}

function toolResultEntry(id: string, callId: string, text: string): ConversationEntry {
  return {
    id,
    kind: 'pi.tool-result',
    model: [{ role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text }], isError: false }],
  }
}

const assistantTurns = (items: ReturnType<typeof buildTimelineItems>): AssistantTurn[] =>
  items.filter((i): i is AssistantTurn => i.kind === 'assistant')

const boundaryKeys = (items: ReturnType<typeof buildTimelineItems>): string[] =>
  [...buildAssistantModelBoundaries(items).keys()]

interface TraceShape {
  key: string
  status: string
  resultText?: string
  callId?: string
}

function collectTraces(turn: AssistantTurn): TraceShape[] {
  const traces: TraceShape[] = []
  for (const seg of turn.segments) {
    if (seg.kind === 'tool') traces.push(seg.tool)
    else if (seg.kind === 'step-group') {
      for (const step of seg.steps) if (step.kind === 'tool') traces.push(step.tool)
    }
  }
  return traces
}

// ---------------------------------------------------------------------------
// 1. 身份解析与标签纯函数
// ---------------------------------------------------------------------------

test('parseAssistantModelIdentity：合法形状解析身份；thinkingLevel 空串视为缺省', { timeout: 60_000 }, () => {
  const entry = modelAssistantEntry('1', 'faux', 'glm-4.7', [{ type: 'text', text: '回答' }], { thinkingLevel: 'high' })
  assert.deepEqual(parseAssistantModelIdentity(entry), { provider: 'faux', model: 'glm-4.7', thinkingLevel: 'high' })

  const noLevel = modelAssistantEntry('2', 'faux', 'glm-4.7', [])
  assert.deepEqual(parseAssistantModelIdentity(noLevel), { provider: 'faux', model: 'glm-4.7' })

  const emptyLevel = modelAssistantEntry('3', 'faux', 'glm-4.7', [], { thinkingLevel: '  ' })
  assert.deepEqual(parseAssistantModelIdentity(emptyLevel), { provider: 'faux', model: 'glm-4.7' })
})

test('parseAssistantModelIdentity：身份不完整/非法返回 undefined，绝不伪造', { timeout: 60_000 }, () => {
  // provider / model 缺失或空白
  assert.equal(parseAssistantModelIdentity(modelAssistantEntry('1', '', 'glm-4.7', [])), undefined)
  assert.equal(parseAssistantModelIdentity(modelAssistantEntry('2', 'faux', '  ', [])), undefined)
  // 首消息角色不是 assistant（model[0] 非 AssistantMessage）
  assert.equal(
    parseAssistantModelIdentity({
      id: '3',
      kind: 'pi.assistant',
      model: [{ role: 'user', content: 'x', provider: 'faux', model: 'glm-4.7' }],
    }),
    undefined,
  )
  // model 非数组 / 空数组 / 首元素非对象
  assert.equal(parseAssistantModelIdentity({ id: '4', kind: 'pi.assistant' }), undefined)
  assert.equal(parseAssistantModelIdentity({ id: '5', kind: 'pi.assistant', model: [] }), undefined)
  assert.equal(parseAssistantModelIdentity({ id: '6', kind: 'pi.assistant', model: ['x'] }), undefined)
  // 非 pi.assistant kind（如 pi.tool-result）不解析
  assert.equal(parseAssistantModelIdentity(toolResultEntry('7', 'c1', 'ok')), undefined)
})

test('模型标签：短标签取 model 末段，完整标签 provider/model（+ 思考档位）', { timeout: 60_000 }, () => {
  const id: AssistantModelIdentity = { provider: 'faux', model: 'glm-4.7', thinkingLevel: 'high' }
  assert.equal(assistantModelShortLabel(id), 'glm-4.7')
  assert.equal(assistantModelFullLabel(id), 'faux/glm-4.7 · thinking high')
  assert.equal(assistantModelFullLabel({ provider: 'faux', model: 'glm-4.7' }), 'faux/glm-4.7')
  // 与 Composer 模型按钮同口径：含 '/' 的 model id 取末段
  assert.equal(assistantModelShortLabel({ provider: 'p', model: 'vendor/glm-4.7' }), 'glm-4.7')
})

test('sameAssistantModelIdentity：只比较 provider+model；thinkingLevel 不参与', { timeout: 60_000 }, () => {
  const a: AssistantModelIdentity = { provider: 'faux', model: 'glm-4.7' }
  assert.ok(sameAssistantModelIdentity(a, { provider: 'faux', model: 'glm-4.7' }))
  assert.ok(sameAssistantModelIdentity(a, { provider: 'faux', model: 'glm-4.7', thinkingLevel: 'low' }))
  assert.ok(sameAssistantModelIdentity({ ...a, thinkingLevel: 'high' }, { provider: 'faux', model: 'glm-4.7', thinkingLevel: 'low' }))
  assert.ok(!sameAssistantModelIdentity(a, { provider: 'faux', model: 'glm-4.6' }))
  assert.ok(!sameAssistantModelIdentity(a, { provider: 'other', model: 'glm-4.7' }))
})

// ---------------------------------------------------------------------------
// 2. 回合拆分（模型层；thinkingLevel 不拆分）
// ---------------------------------------------------------------------------

test('同模型不同 thinkingLevel：仍是一个回合、无模型边界，且不伪造单一档位', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.7', [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ], { thinkingLevel: 'high' }),
    toolResultEntry('2', 'call-1', '/tmp'),
    modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: '完成' }], { thinkingLevel: 'low' }),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1, 'provider+model 相同不拆分（thinkingLevel 不是模型身份）')
  assert.deepEqual(turns[0]!.entryIds, ['1', '2', '3'])
  assert.deepEqual(turns[0]!.model, { provider: 'faux', model: 'glm-4.7' }, '档位不一致时整块不展示单一档位')
  assert.deepEqual(boundaryKeys(items), [])
})

test('同模型同 thinkingLevel：归并一个回合，完整标签保留档位', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.7', [{ type: 'text', text: '第一段' }], { thinkingLevel: 'high' }),
    modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: '第二段' }], { thinkingLevel: 'high' }),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0]!.model, { provider: 'faux', model: 'glm-4.7', thinkingLevel: 'high' })
})

test('已知 A 后混入未知 entry：回合不拆分、整体不贴模型标签、无边界（不把未知内容伪装成 A）', { timeout: 60_000 }, () => {
  // A 可信 -> 不可信 entry -> 再来一个可信 A：污染持续，不因后续同模型 entry 恢复标签
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.7', [{ type: 'text', text: '可信段' }], { thinkingLevel: 'high' }),
    legacyAssistantEntry('2', [{ type: 'text', text: '未知模型段' }]),
    modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: '又一段可信段' }], { thinkingLevel: 'high' }),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1, '未知 entry 不拆分、不产生边界')
  assert.deepEqual(turns[0]!.entryIds, ['1', '2', '3'])
  assert.equal(turns[0]!.model, undefined, '回合内含未知内容时整体不归因任何已知模型')
  assert.deepEqual(boundaryKeys(items), [])
})

test('污染回合后遇明确不同模型 entry：重新开回合并带新标签；前一回合无标签故无边界', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 可信段' }]),
    legacyAssistantEntry('2', [{ type: 'text', text: '未知模型段' }]),
    modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 明确不同模型' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2, '比较基准保留：明确不同模型重新开回合')
  assert.deepEqual(turns[0]!.entryIds, ['1', '2'])
  assert.equal(turns[0]!.model, undefined, '含未知内容的回合不贴标签')
  assert.deepEqual(turns[1]!.entryIds, ['3'])
  assert.deepEqual(turns[1]!.model, { provider: 'faux', model: 'glm-4.7' }, '新回合从可信 entry 重新锁定身份')
  // 前一回合无标签：不与其比较、不产生边界（不造假）
  assert.deepEqual(boundaryKeys(items), [])
})

test('先未知后已知：不比较、不拆分、不贴标签（基准从未建立，后续不同模型也不比较）', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    legacyAssistantEntry('1', [{ type: 'text', text: '未知模型段' }]),
    modelAssistantEntry('2', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 段' }]),
    modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 段' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1, '首个 entry 未知时不建立比较基准，全回合不比较不拆分')
  assert.equal(turns[0]!.model, undefined)
  assert.deepEqual(boundaryKeys(items), [])
})

test('相邻 assistant entry 模型不同：拆分为两个回合，各自携带实际模型', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 的回答' }]),
    modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 的回答' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0]!.model, { provider: 'faux', model: 'glm-4.6' })
  assert.deepEqual(turns[1]!.model, { provider: 'faux', model: 'glm-4.7' })
  assert.deepEqual(turns[0]!.entryIds, ['1'])
  assert.deepEqual(turns[1]!.entryIds, ['2'])
  // 边界锚定新模型回合
  assert.deepEqual(buildAssistantModelBoundaries(items).get(turns[1]!.key), { provider: 'faux', model: 'glm-4.7' })
})

test('同一工具回合 A→B：按新模型 entry 拆分，tool-result 仍与 A 回合配对', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.6', [
      { type: 'text', text: '先查一下' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ]),
    toolResultEntry('2', 'call-1', '/root/code/helm'),
    modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 收尾回答' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2, 'A→B 应在新模型 entry 前拆分')
  // A 回合保留 toolCall + tool-result 配对
  assert.deepEqual(turns[0]!.entryIds, ['1', '2'])
  const tracesA = collectTraces(turns[0]!)
  assert.equal(tracesA.length, 1)
  assert.equal(tracesA[0]!.callId, 'call-1')
  assert.equal(tracesA[0]!.status, 'done')
  assert.equal(tracesA[0]!.resultText, '/root/code/helm')
  // B 回合不含 A 的工具
  assert.deepEqual(turns[1]!.entryIds, ['3'])
  assert.equal(collectTraces(turns[1]!).length, 0)
  assert.deepEqual(turns[1]!.model, { provider: 'faux', model: 'glm-4.7' })
  assert.deepEqual(boundaryKeys(items), [turns[1]!.key])
})

test('A→B→C 三段模型：拆分为三个回合，前两个新模型回合各产生一处边界', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'm-a', [{ type: 'text', text: 'A' }]),
    modelAssistantEntry('2', 'faux', 'm-b', [{ type: 'text', text: 'B' }]),
    modelAssistantEntry('3', 'openai', 'm-c', [{ type: 'text', text: 'C' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 3)
  assert.equal(assistantModelFullLabel(turns[0]!.model!), 'faux/m-a')
  assert.equal(assistantModelFullLabel(turns[1]!.model!), 'faux/m-b')
  assert.equal(assistantModelFullLabel(turns[2]!.model!), 'openai/m-c')
  // 首个回合无边界；B、C 两个新模型回合各一处
  assert.deepEqual(boundaryKeys(items), [turns[1]!.key, turns[2]!.key])
})

test('正常对话 assistant-human-assistant：跨 human 输入回看，A→B 仍渲染边界', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanInputEntry('1', '第一问'),
    modelAssistantEntry('2', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 的回答' }]),
    humanInputEntry('3', '第二问'),
    modelAssistantEntry('4', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 的回答' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2)
  assert.deepEqual(
    buildAssistantModelBoundaries(items).get(turns[1]!.key),
    { provider: 'faux', model: 'glm-4.7' },
    '跨 human 输入回看最近 assistant 回合，模型不同即边界',
  )
})

test('同模型跨 human 输入的正常对话：不产生边界（回归）', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanInputEntry('1', '第一问'),
    modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: 'A' }]),
    humanInputEntry('3', '第二问'),
    modelAssistantEntry('4', 'faux', 'glm-4.7', [{ type: 'text', text: 'B' }]),
  ])
  assert.equal(assistantTurns(items).length, 2)
  assert.deepEqual(boundaryKeys(items), [])
})

test('reset / compaction 上下文边界停止回看：边界后的首个新模型回合无边界', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanInputEntry('1', '问'),
    modelAssistantEntry('2', 'faux', 'glm-4.6', [{ type: 'text', text: '旧上下文回答' }]),
    { id: '3', kind: 'pi.reset', data: { handoff: 'Handoff summary' } },
    humanInputEntry('4', '新问'),
    modelAssistantEntry('5', 'faux', 'glm-4.7', [{ type: 'text', text: '新上下文回答' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2)
  assert.deepEqual(boundaryKeys(items), [], '上下文分割线之前的模型历史不与当前回合比较')
})

test('身份不完整/非法：不拆分、不贴标签、不与已知模型比较产生边界', { timeout: 60_000 }, () => {
  // 首个 assistant 身份非法：后续合法身份既不拆分也不冒充
  const items = buildTimelineItems([
    legacyAssistantEntry('1', [{ type: 'text', text: '旧格式回答' }]),
    modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: '新回答' }]),
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1, '首身份不可知时不拆分')
  assert.equal(turns[0]!.model, undefined, '首身份不可知时不贴任何模型标签')
  assert.deepEqual(boundaryKeys(items), [])

  // 已知模型回合之后跟未知模型回合（隔 human 输入）：不能与未知比较，无边界
  const mixed = buildTimelineItems([
    humanInputEntry('1', '第一问'),
    modelAssistantEntry('2', 'faux', 'glm-4.6', [{ type: 'text', text: '已知模型回答' }]),
    humanInputEntry('3', '第二问'),
    legacyAssistantEntry('4', [{ type: 'text', text: '未知模型回答' }]),
  ])
  const mixedTurns = assistantTurns(mixed)
  assert.equal(mixedTurns.length, 2)
  assert.equal(mixedTurns[1]!.model, undefined)
  assert.deepEqual(boundaryKeys(mixed), [], '未知模型不与已知模型比较，绝不造假')

  // 两个回合均无身份：维持各自回合，无边界
  const legacy = buildTimelineItems([
    humanInputEntry('1', '第一问'),
    legacyAssistantEntry('2', [{ type: 'text', text: '一' }]),
    humanInputEntry('3', '第二问'),
    legacyAssistantEntry('4', [{ type: 'text', text: '二' }]),
  ])
  assert.equal(assistantTurns(legacy).length, 2)
  assert.deepEqual(boundaryKeys(legacy), [])
})

// ---------------------------------------------------------------------------
// 3. live / rewind 不产生假边界
// ---------------------------------------------------------------------------

test('live 合并：流式内容并入当前回合，不产生假模型边界', { timeout: 60_000 }, () => {
  // 纯 live（尚无任何 assistant entry）：不标模型
  const pureLive = buildTimelineItems([], {
    live: { conversationId: 1, text: '流式回答', tools: [], updatedAt: 5 },
  })
  const liveTurn = assistantTurns(pureLive)[0]!
  assert.equal(liveTurn.live, true)
  assert.equal(liveTurn.model, undefined, '尚无落库 entry 时不标任何模型')

  // A 已落库 + live 继续流式：仍是一个回合，模型是 A 的实际身份
  const items = buildTimelineItems([modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 部分' }])], {
    live: { conversationId: 1, text: '流式部分', tools: [], updatedAt: 6 },
  })
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.live, true)
  assert.deepEqual(turns[0]!.model, { provider: 'faux', model: 'glm-4.6' })
  assert.deepEqual(boundaryKeys(items), [], '首个（唯一）回合无边界')
})

test('live 合并落在拆分后的新模型回合（最后回合）上', { timeout: 60_000 }, () => {
  const items = buildTimelineItems(
    [
      modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: 'A' }]),
      modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: 'B' }]),
    ],
    { live: { conversationId: 1, text: 'B 继续流式', tools: [], updatedAt: 7 } },
  )
  const turns = assistantTurns(items)
  assert.equal(turns.length, 2)
  assert.equal(turns[1]!.live, true)
  assert.deepEqual(turns[1]!.model, { provider: 'faux', model: 'glm-4.7' })
  assert.ok(turns[1]!.segments.some((s) => s.kind === 'text' && s.text.includes('B 继续流式')))
  // B 的 entry 已落库：边界如实存在（锚定 B 回合，非 live 时刻）
  assert.deepEqual(boundaryKeys(items), [turns[1]!.key])
})

test('rewind 覆盖的新模型 entry 不产生边界（被覆盖历史不参与派生）', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: '保留的回答' }]),
    modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: '被覆盖的回答' }]),
    { id: '3', kind: 'helmx.rewind', data: { fromEntryId: 2, throughEntryId: 2 } },
  ])
  const turns = assistantTurns(items)
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0]!.model, { provider: 'faux', model: 'glm-4.6' })
  assert.deepEqual(boundaryKeys(items), [])
})

// ---------------------------------------------------------------------------
// 4. ConversationTimeline 界面渲染契约
// ---------------------------------------------------------------------------

function makeSummary(id: number, status: 'idle' | 'working'): ConversationSummary {
  return {
    id,
    title: '测试会话',
    profileId: 'default',
    tags: [],
    cwd: '/root/test',
    model: 'other/current-config',
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

function renderTimeline(entries: ConversationEntry[], conv: ConversationSummary, live?: ConversationLive): string {
  return renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [conv] }) },
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: entries,
        ...(live !== undefined ? { live } : {}),
        onRequestEdit: () => {},
      }),
    ),
  )
}

test('ConversationTimeline：assistant-human-assistant 的 A→B 渲染边界与各块标签', { timeout: 60_000 }, () => {
  const conv = makeSummary(1, 'idle')
  const entries: ConversationEntry[] = [
    humanInputEntry('1', '第一问'),
    modelAssistantEntry('2', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 的回答' }]),
    humanInputEntry('3', '第二问'),
    modelAssistantEntry('4', 'faux', 'glm-4.7', [{ type: 'text', text: 'B 的回答' }], { thinkingLevel: 'high' }),
  ]
  const html = renderTimeline(entries, conv)

  // 边界锚定 B 回合之前，短标签 + 完整值 title（不使用 conversation.model）
  assert.match(html, /class="model-boundary"/)
  assert.match(html, /aria-label="Effective model switched to faux\/glm-4\.7 · thinking high"/)
  assert.match(html, /title="Effective model switched: faux\/glm-4\.7 · thinking high"/)
  assert.ok(!html.includes('other/current-config'), '绝不读取当前会话配置冒充历史')

  // 各块 footer 实际模型短标签与完整值
  assert.match(html, /title="Effective model: faux\/glm-4\.6"/)
  assert.match(html, /title="Effective model: faux\/glm-4\.7 · thinking high"/)
  assert.match(html, /class="mono">glm-4\.6</)
  assert.match(html, /class="mono">glm-4\.7</)

  // 极简无 Emoji
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('ConversationTimeline：同模型不同 thinkingLevel 不渲染边界；回合内档位混合时 title 不伪造单一档位', { timeout: 60_000 }, () => {
  // 跨 human 的两个回合各自档位一致：无边界，各自如实展示自己的档位
  const twoTurns = renderTimeline(
    [
      humanInputEntry('1', '第一问'),
      modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: 'A' }], { thinkingLevel: 'high' }),
      humanInputEntry('3', '第二问'),
      modelAssistantEntry('4', 'faux', 'glm-4.7', [{ type: 'text', text: 'B' }], { thinkingLevel: 'low' }),
    ],
    makeSummary(1, 'idle'),
  )
  assert.ok(!twoTurns.includes('model-boundary'), '同模型（仅档位不同）不渲染模型切换边界')
  assert.match(twoTurns, /title="Effective model: faux\/glm-4\.7 · thinking high"/)
  assert.match(twoTurns, /title="Effective model: faux\/glm-4\.7 · thinking low"/)

  // 同一回合内档位混合：不拆分、无边界，title 不伪造单一档位（只给 provider/model）
  const mixedTurn = renderTimeline(
    [
      humanInputEntry('1', '问'),
      modelAssistantEntry('2', 'faux', 'glm-4.7', [{ type: 'text', text: '第一段' }], { thinkingLevel: 'high' }),
      modelAssistantEntry('3', 'faux', 'glm-4.7', [{ type: 'text', text: '第二段' }], { thinkingLevel: 'low' }),
    ],
    makeSummary(1, 'idle'),
  )
  assert.ok(!mixedTurn.includes('model-boundary'))
  assert.match(mixedTurn, /title="Effective model: faux\/glm-4\.7"/)
  assert.ok(!mixedTurn.includes('思考'), '回合内档位不一致时完整标签不出现任何单一档位')
})

test('ConversationTimeline：身份缺失不渲染边界与标签；busy 回合不展示模型标签', { timeout: 60_000 }, () => {
  // 旧格式（无 provider/model）：无边界、无标签
  const idle = renderTimeline(
    [
      legacyAssistantEntry('1', [{ type: 'text', text: '旧回答' }]),
      humanInputEntry('2', '再问'),
      legacyAssistantEntry('3', [{ type: 'text', text: '新回答' }]),
    ],
    makeSummary(1, 'idle'),
  )
  assert.ok(!idle.includes('model-boundary'))
  assert.ok(!idle.includes('实际生成模型'))

  // working + live：回合 busy（含待生成内容），不展示 footer 模型标签，也无边界
  const working = renderTimeline(
    [modelAssistantEntry('1', 'faux', 'glm-4.6', [{ type: 'text', text: 'A 部分' }])],
    makeSummary(1, 'working'),
    { conversationId: 1, text: '流式中', tools: [], updatedAt: 9 },
  )
  assert.ok(!working.includes('实际生成模型'), 'busy 回合不把待生成内容归属任何模型')
  assert.ok(!working.includes('model-boundary'))
})

test('样式契约：model-boundary 分割线复用 context-divider 视觉语汇', { timeout: 60_000 }, () => {
  assert.match(stylesCss, /\.model-boundary\s*\{[^}]*display:\s*flex/)
  assert.match(stylesCss, /\.model-boundary\s*\{[^}]*font-size:\s*11px/)
  assert.match(stylesCss, /\.model-boundary::before,\n\.model-boundary::after\s*\{/)
  assert.match(stylesCss, /\.model-boundary-label\s*\{[^}]*display:\s*inline-flex/)
})
