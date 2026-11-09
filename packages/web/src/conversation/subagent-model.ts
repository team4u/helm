/**
 * subagent / SubagentWorkflow 关联与子会话实时流（纯 .ts，零 React/DOM 依赖）。
 *
 * 从 timeline-model 拆出：本模块只负责「subagent 工具调用 ↔ 子会话 / 工作流 run」
 * 的运行期关联解析（结构化 JSON 信封优先，footer 兜底，绝不 regex 猜业务文本）
 * 与 SubagentLiveCard 的紧凑活动行展开。
 */

import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  WorkflowRunSummary,
} from '@helm/protocol'
import { buildTimelineItems, toolSummaryText, type AssistantTurn, type TimelineItem, type ToolTrace, type ToolTraceStatus } from './timeline-model.js'

// ---------------------------------------------------------------------------
// subagent / SubagentWorkflow 运行期关联
// ---------------------------------------------------------------------------

/** 内核 subagentFooter 标准元数据行 `[subagent ...]`（多行中取最后一次：footer 总在末尾，正文伪造行不能抢占）。 */
const SUBAGENT_FOOTER_LINE_RE = /\[subagent ([^\]]*)\]/g

/** footer 内的 `key=value` token（value 允许含除空白/]/ 外的字符，覆盖 `worktree=PATH@BRANCH`）。 */
const FOOTER_TOKEN_RE = /(\w+)=([^\s\]]+)/g

/** 提取最后一个 footer 行里的指定键值（footer 总在末尾，正文伪造行不能抢占）。 */
function subagentFooterToken(text: string, key: string): string | undefined {
  let footer: string | undefined
  for (const match of text.matchAll(SUBAGENT_FOOTER_LINE_RE)) {
    if (match[0].includes('=')) footer = match[1]
  }
  if (footer === undefined) return undefined
  let last: string | undefined
  for (const match of footer.matchAll(FOOTER_TOKEN_RE)) {
    if (match[1] === key && match[2] !== '') last = match[2]
  }
  return last
}

function subagentFooterConversationId(text: string): number | undefined {
  const raw = subagentFooterToken(text, 'conversationId')
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 从工具输出解析顶层 JSON 信封的 execution 元数据。
 *
 * 契约：正文（去掉末尾 `[subagent ...]` footer 后）为内核 JSON 信封
 * `{ok, result, execution: {nodeId, conversationId|executionId, effectiveCwd,
 * worktree: {path, branch, ...}}, runId?}`。只读取顶层字段（JSON.parse 结构化
 * 读取），绝不用 regex 去业务 result 文本里猜 conversationId/runId——路径含
 * 空格/Windows 反斜杠也可靠还原。非 JSON 正文返回 undefined（走 footer 兜底）。
 */
export interface SubagentExecutionInfo {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: { path: string; branch: string }
  runId?: string
}

function parseSubagentExecutionInfo(text: string | undefined): SubagentExecutionInfo | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  // 分离末尾 footer：正文才是 JSON 信封（footer 非合法 JSON 成员）。
  const body = text.replace(SUBAGENT_FOOTER_LINE_RE, '').trim()
  if (!body.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const envelope = parsed as Record<string, unknown>
  if (envelope['execution'] === undefined && envelope['runId'] === undefined) return undefined
  const info: SubagentExecutionInfo = {}
  const execution = envelope['execution']
  if (execution !== null && typeof execution === 'object' && !Array.isArray(execution)) {
    const exec = execution as Record<string, unknown>
    if (typeof exec['nodeId'] === 'string' && exec['nodeId'] !== '') info.nodeId = exec['nodeId']
    if (typeof exec['conversationId'] === 'number' && Number.isSafeInteger(exec['conversationId']) && exec['conversationId'] > 0) {
      info.conversationId = exec['conversationId']
    }
    if (typeof exec['executionId'] === 'string' && exec['executionId'] !== '') info.executionId = exec['executionId']
    if (typeof exec['effectiveCwd'] === 'string' && exec['effectiveCwd'] !== '') info.effectiveCwd = exec['effectiveCwd']
    const wt = exec['worktree']
    if (
      wt !== null && typeof wt === 'object' && !Array.isArray(wt) &&
      typeof (wt as Record<string, unknown>)['path'] === 'string' && (wt as Record<string, unknown>)['path'] !== '' &&
      typeof (wt as Record<string, unknown>)['branch'] === 'string'
    ) {
      info.worktree = { path: (wt as Record<string, unknown>)['path'] as string, branch: (wt as Record<string, unknown>)['branch'] as string }
    }
  }
  if (typeof envelope['runId'] === 'string' && envelope['runId'] !== '') info.runId = envelope['runId']
  return info.conversationId !== undefined ||
    info.executionId !== undefined ||
    info.worktree !== undefined ||
    info.runId !== undefined
    ? info
    : undefined
}

/** JSON 顶层信封解析出的子会话 ID（结构化读取，非 regex 猜业务文本）。 */
function subagentJsonConversationId(text: string | undefined): number | undefined {
  return parseSubagentExecutionInfo(text)?.conversationId
}

/**
 * 解析 subagent 工具调用关联的子会话 ID：
 * 1) 已完成：优先顶层 JSON 信封 execution.conversationId（结构化读取，
 *    绝不用 regex 猜业务 result 文本），其次内核 subagentFooter 标准末尾
 *    元数据行 `[subagent ... conversationId=N ...]`；数字需为正 safe integer；
 * 2) 运行期：内核已把父会话工具调用 ID 写入子会话摘要（parentToolCallId），
 *    按 callId 精确关联同父会话（0ms，不等工具返回，不跨父会话串卡）；
 * 3) resume：入参携带数字续接 ref 时匹配同父会话的该子会话。
 */
export function resolveSubagentConversationId(
  tool: ToolTrace,
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  if (tool.toolName !== 'subagent') return undefined
  const resultText = tool.resultText
  if (resultText !== undefined) {
    const fromJson = subagentJsonConversationId(resultText)
    if (fromJson !== undefined) return fromJson
    const fromFooter = subagentFooterConversationId(resultText)
    if (fromFooter !== undefined) return fromFooter
  }
  if (tool.callId !== undefined && tool.callId !== '') {
    for (const c of conversations) {
      if (c.parentConversationId === parentConversationId && c.parentToolCallId === tool.callId) {
        return c.id
      }
    }
  }
  const resumeRef =
    tool.input !== null && typeof tool.input === 'object' && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)['resume']
      : undefined
  // resume 兼容正整数 number 与纯数字 string 两种入参形态（safe integer，负数/小数不命中）。
  const resumeId =
    typeof resumeRef === 'number' && Number.isSafeInteger(resumeRef) && resumeRef > 0
      ? resumeRef
      : typeof resumeRef === 'string' && /^\d+$/.test(resumeRef)
        ? Number(resumeRef)
        : undefined
  if (
    resumeId !== undefined && Number.isSafeInteger(resumeId) && resumeId > 0 &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

/**
 * 扫描时间线条目中所有关联到子会话的 subagent 工具调用，返回每个
 * childConversationId 最后一次出现的 tool.key 映射（childConversationId -> tool.key）。
 *
 * 当同一子会话被反复 resume 时，时间线仅在最新一次调用处挂载 SubagentLiveCard，
 * 前序调用仅保留单行 trace-row（标注“已在下文续接”），避免多张相同实时卡刷屏与状态污染。
 */
export function collectLatestSubagentToolKeys(
  items: ReadonlyArray<TimelineItem>,
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): ReadonlyMap<number, string> {
  const latestByChild = new Map<number, string>()
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'tool') {
        const childId = resolveSubagentConversationId(seg.tool, parentConversationId, conversations)
        if (childId !== undefined) latestByChild.set(childId, seg.tool.key)
      } else if (seg.kind === 'step-group') {
        // 防御性遍历：subagent 正常豁免折叠，但孤儿 tool-result 等异常形态可能落入分组。
        for (const step of seg.steps) {
          if (step.kind !== 'tool') continue
          const childId = resolveSubagentConversationId(step.tool, parentConversationId, conversations)
          if (childId !== undefined) latestByChild.set(childId, step.tool.key)
        }
      }
    }
  }
  return latestByChild
}

/** 工具输出 JSON 里的 run id 字段（"id":"wf_xxx"）精确提取（不匹配子串/前缀）。 */
const WORKFLOW_RUN_ID_IN_RESULT_RE = /"id"\s*:\s*"([^"]+)"/

/**
 * 解析 SubagentWorkflow 工具调用关联的工作流 run（精确关联，绝不猜最新）：
 * - 运行期与完成态优先：run.parentToolCallId === tool.callId 且同会话
 *   （内核受信注入，0ms，不受同会话并行 run 干扰）；
 * - 完成态双保险：结果 JSON 里精确提取的 run id 命中同会话 run
 *   （id 全等比较，不做任意 includes 误前缀）；
 * - 无关联（旧 run 无 parentToolCallId / 输出无 id / 跨会话）：undefined，
 *   显示原工具行而非错误挂到其他 run。
 */
export function resolveWorkflowRunForTool(
  tool: ToolTrace,
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkflowRunSummary | undefined {
  if (tool.toolName !== 'SubagentWorkflow') return undefined
  if (tool.callId !== undefined && tool.callId !== '') {
    const byCallId = workflowRuns.find(
      (r) =>
        r.conversationId === parentConversationId &&
        r.parentToolCallId === tool.callId,
    )
    if (byCallId !== undefined) return byCallId
  }
  if (tool.resultText !== undefined) {
    const runId = WORKFLOW_RUN_ID_IN_RESULT_RE.exec(tool.resultText)?.[1]
    if (runId !== undefined) {
      const matched = workflowRuns.find(
        (r) => r.conversationId === parentConversationId && r.id === runId,
      )
      if (matched !== undefined) return matched
    }
  }
  return undefined
}

export interface SubagentExecutionMeta {
  /** background: true 派生的后台工作流 run（仅确切关联时返回）。 */
  run?: WorkflowRunSummary
  /** 隔离工作树坐标（run 节点 / 顶层 JSON execution / footer 三级提取）。 */
  worktree?: { path: string; branch: string }
  /** 外部运行时（如 Herdr 窗格）执行标识：无子会话时展示后台任务摘要用。 */
  executionId?: string
  /** 实际执行节点。 */
  nodeId?: string
  /** 实际生效工作目录。 */
  effectiveCwd?: string
}

/** footer `worktree=PATH@BRANCH`：内核 PATH@BRANCH 形态；PATH 含空格时不可靠（JSON 优先）。 */
function worktreeFromFooterToken(token: string): { path: string; branch: string } | undefined {
  const at = token.lastIndexOf('@')
  if (at <= 0 || at === token.length - 1) return undefined
  const path = token.slice(0, at)
  const branch = token.slice(at + 1)
  return path !== '' && branch !== '' ? { path, branch } : undefined
}

/**
 * 解析 subagent 工具调用的执行元数据（后台 run / 工作树 / 外部执行标识）：
 * - run 优先 parentToolCallId + 同父会话精确关联（内核受信注入，0ms），
 *   其次顶层 JSON 信封 runId / footer runId= 在同会话 workflowRuns 全等匹配；
 * - worktree 优先关联 run 节点坐标，其次顶层 JSON execution.worktree（路径含
 *   空格/Windows 可靠），最后 footer `worktree=PATH@BRANCH` 兑底；
 * - executionId/nodeId/effectiveCwd 仅从顶层 JSON execution 读取；
 * - 无确切关联时字段均为 undefined（不猜最新，不伪造）。
 */
export function resolveSubagentExecutionMeta(
  tool: ToolTrace,
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  if (tool.toolName !== 'subagent') return {}
  let run: WorkflowRunSummary | undefined
  if (tool.callId !== undefined && tool.callId !== '') {
    run = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === tool.callId,
    )
  }
  const info = parseSubagentExecutionInfo(tool.resultText)
  if (run === undefined) {
    const runId = info?.runId ?? subagentFooterToken(tool.resultText ?? '', 'runId')
    if (runId !== undefined && runId.startsWith('wf_')) {
      run = workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === runId)
    }
  }
  const fromRun = run?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const fromJson = info?.worktree
  const fromFooter = worktreeFromFooterToken(subagentFooterToken(tool.resultText ?? '', 'worktree') ?? '')
  const worktree = fromRun ?? fromJson ?? fromFooter
  return {
    ...(run !== undefined ? { run } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(info?.executionId !== undefined ? { executionId: info.executionId } : {}),
    ...(info?.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
    ...(info?.effectiveCwd !== undefined ? { effectiveCwd: info.effectiveCwd } : {}),
  }
}

// ---------------------------------------------------------------------------
// 子会话实时流（SubagentLiveCard 内容纯函数层）
// ---------------------------------------------------------------------------

/** 子会话紧凑活动行（任务指令 / 思考 / 工具 / 回复正文）。 */
export type SubagentStreamLine =
  | { kind: 'prompt'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolName: string
      summary: string
      status: ToolTraceStatus
      isError: boolean
      durationMs?: number
      resultPreview?: string
    }
  | { kind: 'text'; key: string; text: string }

/** spawn 注入的结构化输出契约样板（末尾尾行），展示层剥离保留干净指令。 */
const STRUCTURED_OUTPUT_CONTRACT_RE = /\n*<structured_output_contract>[\s\S]*?<\/structured_output_contract>\s*$/

function firstLineOf(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

/** 展开时间线 item 为紧凑活动行（prompt / thinking / tool / text 按时间序）。 */
function linesOfTimelineItems(items: ReadonlyArray<TimelineItem>): SubagentStreamLine[] {
  const lines: SubagentStreamLine[] = []
  for (const item of items) {
    if (item.kind === 'human') {
      if (item.text.trim() === '') continue
      lines.push({
        kind: 'prompt',
        key: item.key,
        text: item.text.replace(STRUCTURED_OUTPUT_CONTRACT_RE, '').trim(),
      })
      continue
    }
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'text') {
        if (seg.text.trim() !== '') lines.push({ kind: 'text', key: seg.key, text: seg.text })
        continue
      }
      if (seg.kind === 'step-group') {
        for (const step of seg.steps) {
          if (step.kind === 'thinking') {
            if (step.thinking.text.trim() !== '') {
              lines.push({ kind: 'thinking', key: step.thinking.key, text: step.thinking.text })
            }
            continue
          }
          lines.push(toolLineOf(step.tool))
        }
        continue
      }
      lines.push(toolLineOf(seg.tool))
    }
  }
  return lines
}

function toolLineOf(tool: ToolTrace): SubagentStreamLine {
  return {
    kind: 'tool',
    key: tool.key,
    toolName: tool.toolName,
    summary: toolSummaryText(tool.toolName, tool.input),
    status: tool.status,
    isError: tool.isError,
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.resultText !== undefined && tool.resultText !== ''
      ? { resultPreview: firstLineOf(tool.resultText, 100) }
      : {}),
  }
}

/**
 * 子会话实时内容流：detail.entries + ConversationLive 合并展开为紧凑活动行。
 * live 为流式快照（thinking / text / tools）；working 控制进行中回合活性。
 */
export function buildSubagentStreamLines(
  entries: ReadonlyArray<ConversationEntry>,
  live?: ConversationLive,
  working?: boolean,
): SubagentStreamLine[] {
  const items = buildTimelineItems(entries, {
    ...(live !== undefined ? { live } : {}),
    ...(working !== undefined ? { working } : {}),
  })
  return linesOfTimelineItems(items)
}

export interface AssistantTurnBusyOptions {
  isLatestTurn?: boolean
  workflowRuns?: ReadonlyArray<WorkflowRunSummary>
  conversations?: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId' | 'status'>>
}

/**
 * 判定 assistant 回合是否仍在响应或执行在途任务中：
 * 1. turn.live 为 true（进行中 / 流式输出 / 思考中）；
 * 2. 最新回合且父会话处于 working 或 blocked 状态；
 * 3. 回合内任一工具状态为 running 或 unknown；
 * 4. step-group 仍处于 active 激活态；
 * 5. 关联的 SubagentWorkflow 仍在 running；
 * 6. 关联的 subagent 后台 run 仍在 running 或子会话仍为 working / blocked。
 *
 * 只有当本回合所有任务与响应彻底完成时才返回 false（此时才展示复制/分叉按钮组）。
 */
export function isAssistantTurnBusy(
  turn: AssistantTurn,
  conversation: { id: number; status?: string },
  options?: AssistantTurnBusyOptions,
): boolean {
  if (turn.live) return true
  if (
    options?.isLatestTurn &&
    (conversation.status === 'working' || conversation.status === 'blocked')
  ) {
    return true
  }

  const workflowRuns = options?.workflowRuns ?? []
  const conversations = options?.conversations ?? []

  const isToolRunning = (tool: ToolTrace): boolean => {
    if (tool.status === 'running' || tool.status === 'unknown') return true
    if (tool.toolName === 'SubagentWorkflow') {
      const wf = resolveWorkflowRunForTool(tool, conversation.id, workflowRuns)
      if (wf?.status === 'running') return true
    }
    if (tool.toolName === 'subagent') {
      const meta = resolveSubagentExecutionMeta(tool, conversation.id, workflowRuns)
      if (meta.run?.status === 'running') return true
      const childId = resolveSubagentConversationId(tool, conversation.id, conversations)
      if (childId !== undefined) {
        const childConv = conversations.find((c) => c.id === childId)
        if (childConv?.status === 'working' || childConv?.status === 'blocked') return true
      }
    }
    return false
  }

  for (const seg of turn.segments) {
    if (seg.kind === 'tool') {
      if (isToolRunning(seg.tool)) return true
    } else if (seg.kind === 'step-group') {
      if (seg.active) return true
      for (const step of seg.steps) {
        if (step.kind === 'tool' && isToolRunning(step.tool)) return true
      }
    }
  }

  return false
}
