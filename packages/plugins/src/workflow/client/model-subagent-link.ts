/**
 * builtin:workflow 插件 client 纯逻辑：subagent 运行期关联——工具调用 ↔ 子会话 /
 * 后台 run / 工作树 / 外部执行的解析（footer 与 JSON 信封解析、callId / resume
 * 精确关联、siblingCalls 多次 resume 折叠判定；零 React/DOM 依赖）。
 */
import type { ConversationSummary, ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { inputString } from './model-format.ts'

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

/** subagent 工具输出顶层 JSON 信封的 execution 元数据。 */
export interface SubagentExecutionInfo {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: { path: string; branch: string }
  runId?: string
  background?: boolean
  status?: string
}

export function parseSubagentExecutionInfo(text: string | undefined): SubagentExecutionInfo | undefined {
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
  if (typeof envelope['background'] === 'boolean') info.background = envelope['background']
  if (typeof envelope['status'] === 'string' && envelope['status'] !== '') info.status = envelope['status']
  return info.conversationId !== undefined ||
    info.executionId !== undefined ||
    info.worktree !== undefined ||
    info.runId !== undefined
    ? info
    : undefined
}

function subagentJsonConversationId(text: string | undefined): number | undefined {
  return parseSubagentExecutionInfo(text)?.conversationId
}

/**
 * 解析 subagent 工具调用关联的子会话 ID：
 * 1) 已完成：优先顶层 JSON 信封 execution.conversationId（结构化读取），
 *    其次内核 subagentFooter 标准末尾元数据行；
 * 2) 运行期：按 callId 与子会话 parentToolCallId 精确关联；
 * 3) resume：入参携带数字续接 ref 时匹配同父会话的该子会话。
 */
export function resolveSubagentConversationId(
  input: {
    callId: string | undefined
    input: unknown
    result?: unknown
  },
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  const resultText = typeof input.result === 'string' ? input.result : undefined
  if (resultText !== undefined) {
    const fromJson = subagentJsonConversationId(resultText)
    if (fromJson !== undefined) return fromJson
    const fromFooter = subagentFooterConversationId(resultText)
    if (fromFooter !== undefined) return fromFooter
  }
  if (input.callId !== undefined && input.callId !== '') {
    for (const c of conversations) {
      if (c.parentConversationId === parentConversationId && c.parentToolCallId === input.callId) {
        return c.id
      }
    }
  }
  const resumeRefRaw =
    input.input !== null && typeof input.input === 'object' && !Array.isArray(input.input)
      ? (input.input as Record<string, unknown>)['resume']
      : undefined
  // resume 兼容正整数 number 与纯数字 string 两种入参形态（safe integer，负数/小数不命中）。
  const resumeId =
    typeof resumeRefRaw === 'number' && Number.isSafeInteger(resumeRefRaw) && resumeRefRaw > 0
      ? resumeRefRaw
      : typeof resumeRefRaw === 'string' && /^\d+$/.test(resumeRefRaw)
        ? Number(resumeRefRaw)
        : undefined
  if (
    resumeId !== undefined && Number.isSafeInteger(resumeId) && resumeId > 0 &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

/** footer `worktree=PATH@BRANCH`：内核 PATH@BRANCH 形态；PATH 含空格时不可靠（JSON 优先）。 */
function worktreeFromFooterToken(token: string): { path: string; branch: string } | undefined {
  const at = token.lastIndexOf('@')
  if (at <= 0 || at === token.length - 1) return undefined
  const path = token.slice(0, at)
  const branch = token.slice(at + 1)
  return path !== '' && branch !== '' ? { path, branch } : undefined
}

/** subagent 工具调用的执行元数据（后台 run / 工作树 / 外部执行标识）。 */
export interface SubagentExecutionMeta {
  run?: WorkflowRunSummary
  /** 受管工作树坐标（run 节点路径携带登记 id/baseCommit 时如实保留，供精确检视/清理）。 */
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  executionId?: string
  nodeId?: string
  effectiveCwd?: string
}

/** 解析 subagent 工具调用的执行元数据（后台 run / 工作树 / 外部执行标识）。 */
export function resolveSubagentExecutionMeta(
  input: { callId: string | undefined; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  let run: WorkflowRunSummary | undefined
  if (input.callId !== undefined && input.callId !== '') {
    run = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
  }
  const resultText = typeof input.result === 'string' ? input.result : undefined
  const info = parseSubagentExecutionInfo(resultText)
  if (run === undefined) {
    const runId = info?.runId ?? subagentFooterToken(resultText ?? '', 'runId')
    if (runId !== undefined && runId.startsWith('wf_')) {
      run = workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === runId)
    }
  }
  const fromRun = run?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const fromJson = info?.worktree
  const fromFooter = worktreeFromFooterToken(subagentFooterToken(resultText ?? '', 'worktree') ?? '')
  const worktree = fromRun ?? fromJson ?? fromFooter
  return {
    ...(run !== undefined ? { run } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(info?.executionId !== undefined ? { executionId: info.executionId } : {}),
    ...(info?.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
    ...(info?.effectiveCwd !== undefined ? { effectiveCwd: info.effectiveCwd } : {}),
  }
}

/** 父工具轻量摘要（折叠态头部数据源）。 */
export interface SubagentParentToolSummary {
  prompt?: string
  startedAt?: number
  durationMs?: number
  resultText?: string
  isError?: boolean
}

/**
 * 判断当前 callId 是否为同一原生/外部执行目标在 siblingCalls 中的最后一次 subagent 调用：
 * 前序被后续 resume 接替的旧调用仅渲染单行摘要胶囊，最新调用挂载实时子会话流。
 */
export function isLatestSubagentCallForTarget(
  props: Pick<ToolViewProps, 'callId' | 'input' | 'result' | 'siblingCalls' | 'conversationId'>,
  childConversationId: number | undefined,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
  externalExecutionId?: string,
): boolean {
  if (childConversationId === undefined && externalExecutionId === undefined) return true
  const siblings = props.siblingCalls ?? []
  const selfIndex = siblings.findIndex((call) => call.callId === props.callId)
  if (selfIndex === -1) return true
  for (const call of siblings.slice(selfIndex + 1)) {
    if (call.toolName !== 'subagent') continue
    if (childConversationId !== undefined) {
      const resolved = resolveSubagentConversationId(
        { callId: call.callId, input: call.input, result: call.result },
        props.conversationId,
        conversations,
      )
      if (resolved === childConversationId) return false
    } else {
      const execution = parseSubagentExecutionInfo(typeof call.result === 'string' ? call.result : undefined)
      if ((execution?.executionId ?? inputString(call.input, 'resume')) === externalExecutionId) return false
    }
  }
  return true
}

/** 从 ToolViewProps 构造父工具轻量摘要。 */
export function parentToolSummaryOf(props: ToolViewProps): SubagentParentToolSummary {
  return {
    ...(inputString(props.input, 'prompt') !== undefined ? { prompt: inputString(props.input, 'prompt')! } : {}),
    ...(props.startedAt !== undefined ? { startedAt: props.startedAt } : {}),
    ...(props.durationMs !== undefined ? { durationMs: props.durationMs } : {}),
    ...(typeof props.result === 'string' ? { resultText: props.result } : {}),
    ...(props.isError === true ? { isError: true } : {}),
  }
}
