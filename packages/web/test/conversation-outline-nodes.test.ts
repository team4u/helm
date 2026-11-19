/**
 * 会话大纲回合导航升级纯函数测试：
 * - 助手摘要节点（无标题正文）与 B 智能合并（有标题时由标题代表，不重复 assistant 摘要）；
 * - 业务卡节点：AssistantTurn 顶层 tool.view 卡（通用 toolName + 入参摘要、cardId 二级锚）
 *   与 timeline.renderer 接管的 plugin-card（helmx.input 文本首行摘要）；
 * - step-group 内普通工具与 thinking 不进大纲；无正文无卡片回合保留诚实状态摘要；
 * - 搜索（人类/助手全文、卡片摘要）与「仅提问」过滤、父提问保留、节点定位数据
 *   （entryId / headingIndex / cardId）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry } from '@helmx/protocol'
import type { QualifiedRenderer, QualifiedToolView } from '../src/conversation/timeline-model.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import {
  buildConversationOutline,
  filterOutlineNodes,
  summarizePluginCardEntry,
  type OutlineAssistantNode,
  type OutlineCardNode,
  type OutlineHeadingNode,
  type OutlineHumanNode,
} from '../src/conversation/outline-model.js'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 机制信号替身：tool.view 命中 subagent 工具（零插件特判，仅模拟宿主注册表）。 */
const TOOL_VIEWS: QualifiedToolView[] = [
  { pluginId: 'builtin:workflow', spec: { id: 'subagent-card', toolNames: ['subagent'], replaceRow: true } },
]

/** 机制信号替身：timeline.renderer 精确接管带 meta.renderer 标记的 helmx.input。 */
const RENDERERS: QualifiedRenderer[] = [
  {
    pluginId: 'builtin:workflow',
    spec: { id: 'background-report', kinds: ['helmx.input'], matchMeta: { renderer: 'workflow:background-report' } },
  },
]

function humanEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'helmx.input', data: { id: `in-${id}`, text, origin: 'human' }, createdAt: 1000 }
}

function assistantTextEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
}

function toolCallEntry(id: string, callId: string, toolName: string, input: unknown): ConversationEntry {
  return {
    id,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: toolName, arguments: input }] }],
  }
}

function toolResultEntry(id: string, callId: string, toolName: string, isError = false): ConversationEntry {
  return {
    id,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName,
        isError,
        content: [{ type: 'text', text: '结果文本' }],
      },
    ],
  }
}

const backgroundReportEntry: ConversationEntry = {
  id: '9',
  kind: 'helmx.input',
  data: {
    id: 'in-9',
    text: '后台子代理任务已结算。以下为运行 abc123 的结果数据（仅代表本次任务）：\n{"ok":true}',
    origin: 'agent',
    whenBusy: 'followUp',
    meta: { renderer: 'workflow:background-report', backgroundRunId: 'abc123', kind: 'subagent_report' },
  },
  createdAt: 3000,
}

function kindsOf(nodes: ReadonlyArray<ReturnType<typeof buildConversationOutline>[number]>): string[] {
  return nodes.map((n) => n.kind)
}

// ---------------------------------------------------------------------------
// B 智能合并：助手摘要节点 vs Markdown 标题节点
// ---------------------------------------------------------------------------

test('无标题正文回合：生成 assistant 摘要节点（首行摘要、全文可搜、entryId 锚定回合）', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '帮我总结现状'),
    assistantTextEntry('2', '现状分三块：\n内核、插件与 Web。'),
  ])
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'assistant'])

  const assistant = nodes[1] as OutlineAssistantNode
  assert.equal(assistant.entryId, '2')
  assert.equal(assistant.label, '现状分三块：')
  assert.equal(assistant.fullText, '现状分三块：\n内核、插件与 Web。')
  assert.equal(assistant.live, false)
  assert.equal(assistant.status, undefined, '有正文的摘要节点不携带状态标记')
  assert.equal(assistant.parentHumanKey, nodes[0]!.key, '命中搜索时保留父提问')
})

test('B 智能合并：有 Markdown 标题时不重复输出 assistant 摘要节点，由标题代表回合', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '分析架构'),
    assistantTextEntry('2', '# 架构总览\n正文。\n## 内核模块\n正文。'),
  ])
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'heading', 'heading'], '只有标题节点，无 assistant 摘要节点')
  assert.deepEqual(
    (nodes.slice(1) as OutlineHeadingNode[]).map((h) => [h.headingIndex, h.entryId]),
    [[0, '2'], [1, '2']],
    'headingIndex 连续且锚定回合 entryId',
  )
})

test('正文与顶层业务卡共存：assistant 摘要与卡片按段落真实顺序输出', { timeout: 60_000 }, () => {
  // 正文在前、卡片在后
  const textFirst = buildTimelineItems([
    humanEntry('1', '调研并汇报'),
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先说明调研计划。' },
            { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { prompt: '调研 outline 模块现状' } },
          ],
        },
      ],
    },
    toolResultEntry('3', 'call-1', 'subagent'),
  ], { toolViews: TOOL_VIEWS })
  const nodesA = buildConversationOutline(textFirst)
  assert.deepEqual(kindsOf(nodesA), ['human', 'assistant', 'card'], '正文摘要先于卡片')

  // 卡片在前、正文在后
  const cardFirst = buildTimelineItems([
    humanEntry('1', '先执行再总结'),
    toolCallEntry('2', 'call-1', 'subagent', { prompt: '执行构建' }),
    toolResultEntry('3', 'call-1', 'subagent'),
    assistantTextEntry('4', '构建已完成，产物就绪。'),
  ], { toolViews: TOOL_VIEWS })
  const nodesB = buildConversationOutline(cardFirst)
  assert.deepEqual(kindsOf(nodesB), ['human', 'card', 'assistant'], '卡片先于正文摘要')
})

// ---------------------------------------------------------------------------
// 业务卡节点（tool.view 顶层卡 + plugin-card）
// ---------------------------------------------------------------------------

test('同一助手回合标题与业务卡按时间线真实顺序排列，headingIndex 仍与正文 DOM 顺序一致', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '按顺序执行并总结'),
    assistantTextEntry('2', '# 执行前说明'),
    toolCallEntry('3', 'call-1', 'subagent', { prompt: '检查并执行' }),
    toolResultEntry('4', 'call-1', 'subagent'),
    assistantTextEntry('5', '## 执行后总结'),
  ], { toolViews: TOOL_VIEWS })
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'heading', 'card', 'heading'])
  assert.deepEqual(
    nodes.filter((node): node is OutlineHeadingNode => node.kind === 'heading').map((node) => [node.headingIndex, node.text]),
    [[0, '执行前说明'], [1, '执行后总结']],
  )
})

test('无正文有顶层 tool.view 业务卡：卡片代表回合，不产生空 assistant 节点；cardId 二级锚可用', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '派一个子代理去调研'),
    toolCallEntry('2', 'call-1', 'subagent', { prompt: '调研 outline 模块现状', description: '调研' }),
    toolResultEntry('3', 'call-1', 'subagent'),
  ], { toolViews: TOOL_VIEWS })
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'card'], '无正文时不输出空 assistant 节点')

  const card = nodes[1] as OutlineCardNode
  assert.equal(card.entryId, '2', '一级锚为回合包装 data-entry-id（entryIds[0]）')
  assert.equal(card.cardId, 'tool:call-1', '二级锚为 tool.key（DOM data-outline-card-id 同源）')
  assert.equal(card.label, 'subagent：调研 outline 模块现状', '通用 toolName + 入参摘要，零工具名特判')
  assert.equal(card.status, 'done', '工具状态进入节点供 UI 呈现')
  assert.equal(card.parentHumanKey, nodes[0]!.key)
})

test('step-group 内普通工具与 thinking 不进大纲：只有命中 tool.view 的工具独立成卡', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '改一下再验证'),
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看文件再动手。' },
            { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-edit', name: 'edit', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-sub', name: 'subagent', arguments: { prompt: '复查改动' } },
          ],
        },
      ],
    },
    toolResultEntry('3', 'call-read', 'read'),
    toolResultEntry('4', 'call-edit', 'edit'),
    toolResultEntry('5', 'call-sub', 'subagent'),
  ], { toolViews: TOOL_VIEWS })
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'card'], '普通 bash/read/edit 与 thinking 均不进大纲')
  const card = nodes[1] as OutlineCardNode
  assert.equal(card.cardId, 'tool:call-sub')
  assert.equal(card.label, 'subagent：复查改动')
})

test('tool.view 业务卡运行中：状态 running 保留在节点数据中', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '跑一个后台工作流'),
    toolCallEntry('2', 'call-1', 'subagent', { prompt: '长任务' }),
  ], { toolViews: TOOL_VIEWS, working: true })
  const nodes = buildConversationOutline(items)
  const card = nodes.find((n) => n.kind === 'card') as OutlineCardNode
  assert.ok(card !== undefined)
  assert.equal(card.status, 'running')
})

test('plugin-card（timeline.renderer 接管卡）：helmx.input 文本首行摘要 + entryId 精确定位', { timeout: 60_000 }, () => {
  const items = buildTimelineItems(
    [humanEntry('1', '开始任务'), backgroundReportEntry],
    { timelineRenderers: RENDERERS },
  )
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'card'])

  const card = nodes[1] as OutlineCardNode
  assert.equal(card.entryId, '9', 'plugin-card 用自身 entryId 一级锚定位')
  assert.equal(card.cardId, undefined, 'plugin-card 无二级锚')
  assert.equal(card.label, '后台子代理任务已结算。以下为运行 abc123 的结果数据（仅代表本次任务）：')
  assert.equal(card.status, undefined)
  assert.equal(card.parentHumanKey, nodes[0]!.key)
})

test('summarizePluginCardEntry：非 helmx.input 或空文本时回退稳定契约标识，绝不读插件私有渲染内容', { timeout: 60_000 }, () => {
  const fallback = summarizePluginCardEntry({ id: '1', kind: 'helmx.report' })
  assert.equal(fallback.label, 'helmx.report')
  const empty = summarizePluginCardEntry({ id: '2', kind: 'helmx.input', data: { text: '   ', origin: 'human' } })
  assert.equal(empty.label, 'helmx.input')
})

// ---------------------------------------------------------------------------
// 无正文无卡片回合的诚实状态摘要
// ---------------------------------------------------------------------------

test('无正文无卡片回合：live 标注生成中、最新失败回合标注失败、历史回合标注无正文', { timeout: 60_000 }, () => {
  // live 回合（仅 thinking 流式，无正文无业务卡）
  const liveItems = buildTimelineItems([humanEntry('1', '等等')], {
    working: true,
    live: { conversationId: 10, text: '', thinking: '思考中…', tools: [], updatedAt: 1 },
  })
  const liveNodes = buildConversationOutline(liveItems)
  const liveAssistant = liveNodes.find((n) => n.kind === 'assistant') as OutlineAssistantNode
  assert.ok(liveAssistant !== undefined)
  assert.equal(liveAssistant.status, 'generating')
  assert.equal(liveAssistant.label, 'Generating…')
  assert.equal(liveAssistant.live, true)

  // 已结算历史回合（仅普通工具 step-group，无正文无业务卡）
  const settledItems = buildTimelineItems([
    humanEntry('1', '查一下文件'),
    toolCallEntry('2', 'call-1', 'bash', { command: 'ls' }),
    toolResultEntry('3', 'call-1', 'bash'),
  ])
  const settledNodes = buildConversationOutline(settledItems)
  const settledAssistant = settledNodes.find((n) => n.kind === 'assistant') as OutlineAssistantNode
  assert.ok(settledAssistant !== undefined)
  assert.equal(settledAssistant.status, 'no-content')
  assert.equal(settledAssistant.label, 'No content')

  // 最新回合失败（ConversationSummary.status === 'error' 传入）：仅最新回合标注失败
  const failedItems = buildTimelineItems([
    humanEntry('1', '第一轮'),
    toolCallEntry('2', 'call-1', 'bash', { command: 'ls' }),
    toolResultEntry('3', 'call-1', 'bash'),
    humanEntry('4', '第二轮'),
    toolCallEntry('5', 'call-2', 'bash', { command: 'pwd' }),
    toolResultEntry('6', 'call-2', 'bash'),
  ])
  const failedNodes = buildConversationOutline(failedItems, { latestAssistantTurnFailed: true })
  const assistants = failedNodes.filter((n) => n.kind === 'assistant') as OutlineAssistantNode[]
  assert.equal(assistants.length, 2)
  assert.equal(assistants[0]!.status, 'no-content', '失败标注只作用于最新回合')
  assert.equal(assistants[1]!.status, 'failed')
  assert.equal(assistants[1]!.label, 'This turn failed')
})

// ---------------------------------------------------------------------------
// 搜索与过滤
// ---------------------------------------------------------------------------

function buildMixedNodes() {
  const items = buildTimelineItems(
    [
      humanEntry('1', '派子代理调研数据库索引'),
      toolCallEntry('2', 'call-1', 'subagent', { prompt: '调研数据库索引缺失' }),
      toolResultEntry('3', 'call-1', 'subagent'),
      humanEntry('4', '总结一下'),
      assistantTextEntry('5', '索引缺失是慢查询根因，建议补建复合索引。'),
      backgroundReportEntry,
    ],
    { toolViews: TOOL_VIEWS, timelineRenderers: RENDERERS },
  )
  return buildConversationOutline(items)
}

test('搜索：助手全文、卡片摘要与标题均可命中，且保留父提问节点', { timeout: 60_000 }, () => {
  const nodes = buildMixedNodes()

  // 助手正文全文命中（关键词不在首行 label 中）
  const byAssistant = filterOutlineNodes(nodes, { query: '复合索引' })
  assert.deepEqual(
    byAssistant.map((n) => n.kind),
    ['human', 'assistant'],
    '助手正文命中时保留其父提问',
  )

  // tool.view 卡片入参摘要命中（label 与 searchText 均可搜）
  const byCardLabel = filterOutlineNodes(nodes, { query: '调研数据库索引缺失' })
  assert.deepEqual(
    byCardLabel.map((n) => n.kind),
    ['human', 'card'],
  )

  // plugin-card 汇报文本命中（searchText 为 helmx.input 全文）
  const byReport = filterOutlineNodes(nodes, { query: '结果数据' })
  assert.deepEqual(
    byReport.map((n) => n.kind),
    ['human', 'card'],
  )

  // 工具名可搜索（卡片 searchText 含 toolName）
  const byToolName = filterOutlineNodes(nodes, { query: 'subagent' })
  assert.ok(byToolName.some((n) => n.kind === 'card'))
})

test('三态过滤模式：dialogue 过滤 card 与 agent/trigger 输入；questions 仅留人工提问与分割线；all 保留全部', { timeout: 60_000 }, () => {
  const items = buildTimelineItems(
    [
      humanEntry('1', '派子代理调研数据库索引'),
      toolCallEntry('2', 'call-1', 'subagent', { prompt: '调研数据库索引缺失' }),
      toolResultEntry('3', 'call-1', 'subagent'),
      { id: '3b', kind: 'helmx.input', data: { id: 'in-agent', text: '子代理自动跟进检查', origin: 'agent' }, createdAt: 1500 },
      { id: '3c', kind: 'helmx.input', data: { id: 'in-trigger', text: '定时巡检触发消息', origin: 'trigger' }, createdAt: 1600 },
      humanEntry('4', '总结一下'),
      assistantTextEntry('5', '索引缺失是慢查询根因，建议补建复合索引。'),
      backgroundReportEntry,
    ],
    { toolViews: TOOL_VIEWS, timelineRenderers: RENDERERS },
  )
  const nodes = buildConversationOutline(items)
  assert.deepEqual(kindsOf(nodes), ['human', 'card', 'human', 'human', 'human', 'assistant', 'card'])

  const dialogue = filterOutlineNodes(nodes, { mode: 'dialogue' })
  assert.deepEqual(
    dialogue.map((n) => (n.kind === 'human' ? `${n.kind}:${n.label}` : n.kind)),
    ['human:派子代理调研数据库索引', 'human:总结一下', 'assistant'],
    'dialogue 模式过滤掉 card 以及 agent/trigger 发起的 human 输入，仅保留人工对话与助手正文/标题/分割线',
  )

  const questionsOnly = filterOutlineNodes(nodes, { mode: 'questions' })
  assert.deepEqual(
    questionsOnly.map((n) => (n.kind === 'human' ? n.label : n.kind)),
    ['派子代理调研数据库索引', '总结一下'],
    'questions 模式仅保留 origin === human 的提问与 divider',
  )

  // all 与默认（不传 mode）保留完整大纲节点
  assert.deepEqual(kindsOf(filterOutlineNodes(nodes, { mode: 'all' })), kindsOf(nodes))
  assert.deepEqual(kindsOf(filterOutlineNodes(nodes)), kindsOf(nodes))
})

test('搜索不引入普通工具与 thinking：step-group 过程细节不可搜', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    humanEntry('1', '查文件'),
    toolCallEntry('2', 'call-1', 'bash', { command: 'ls -la /var/log/unique-marker' }),
    toolResultEntry('3', 'call-1', 'bash'),
  ])
  const nodes = buildConversationOutline(items)
  const hit = filterOutlineNodes(nodes, { query: 'unique-marker' })
  assert.equal(hit.length, 0, '普通 bash 工具入参不进大纲，不可搜')
})
