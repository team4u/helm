/**
 * builtin:workflow 插件 client 组件的纯逻辑层（零 React/DOM 依赖）。
 *
 * 迁移并整合原 @helm/web 的 subagent-model.ts / subagent-live-model.ts /
 * workflow-card-model.ts：subagent / SubagentWorkflow 工具调用 ↔ 子会话 /
 * 工作流 run 的运行期关联解析、卡片状态徽章推导、阶段分组与格式化工具。
 * 仅依赖标准类型（@helm/protocol）与 @helm/plugin-client 公共 hooks，
 * 零宿主内部私有依赖。
 */
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ToolViewProps,
  ToolViewSiblingCall,
  WorkflowNodeState,
  WorkflowRunSummary,
} from '@helm/protocol'
import { formatDurationMs } from '@helm/plugin-client'

// ---------------------------------------------------------------------------
// 格式化工具（时长摘要统一复用宿主 lib/format.ts 经 @helm/plugin-client 共享的实现）
// ---------------------------------------------------------------------------

export function toolResultPreviewTruncated(preview: string | undefined): boolean {
  return preview?.endsWith('…') === true
}

export function isScrolledToBottom(element: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 36
}

/** 首行截断（trim 后超长加省略号）。 */
export function firstLineOf(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

// ---------------------------------------------------------------------------
// subagent / SubagentWorkflow 运行期关联（原 subagent-model.ts）
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

/** subagent 工具输出顶层 JSON 信封的 execution 元数据。 */
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

function subagentJsonConversationId(text: string | undefined): number | undefined {
  return parseSubagentExecutionInfo(text)?.conversationId
}

/** 工具入参字段提取（字符串且非空）。 */
function inputString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
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

/** 工具输出 JSON 里的 run id 字段（"id":"wf_xxx"）精确提取（不匹配子串/前缀）。 */
const WORKFLOW_RUN_ID_IN_RESULT_RE = /"id"\s*:\s*"([^"]+)"/

/** 解析 SubagentWorkflow 工具调用关联的工作流 run（精确关联，绝不猜最新）。 */
export function resolveWorkflowRunForTool(
  input: { callId: string | undefined; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkflowRunSummary | undefined {
  if (input.callId !== undefined && input.callId !== '') {
    const byCallId = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
    if (byCallId !== undefined) return byCallId
  }
  if (typeof input.result === 'string') {
    const runId = WORKFLOW_RUN_ID_IN_RESULT_RE.exec(input.result)?.[1]
    if (runId !== undefined) {
      const matched = workflowRuns.find(
        (r) => r.conversationId === parentConversationId && r.id === runId,
      )
      if (matched !== undefined) return matched
    }
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

// ---------------------------------------------------------------------------
// 卡片状态徽章与头部摘要（原 subagent-live-model.ts）
// ---------------------------------------------------------------------------

/** 子会话卡片状态。 */
export type SubagentCardStatus = 'working' | 'blocked' | 'error' | 'done' | 'pending'

export interface SubagentBadge {
  status: SubagentCardStatus
  label: string
  badge: string
}

/**
 * 卡片徽章状态：优先真实 summary.status，无 summary 时才以父工具 toolStatus 兜底；
 * background: true 的后台 run 状态必须参与判定——run 仍在 running 时绝不提前显示「已完成」。
 */
export function subagentBadge(
  summaryStatus: string | undefined,
  toolStatus: 'running' | 'done' | 'error' | 'unknown',
  backgroundRunStatus?: WorkflowRunSummary['status'],
): SubagentBadge {
  if (summaryStatus === 'blocked') return { status: 'blocked', label: '等待审批', badge: 'badge-warn' }
  if (summaryStatus === 'working') {
    return {
      status: 'working',
      label: backgroundRunStatus !== undefined ? '后台执行中' : '执行中',
      badge: 'badge-accent',
    }
  }
  if (
    backgroundRunStatus === 'running' &&
    (summaryStatus === 'idle' || summaryStatus === 'done' || summaryStatus === undefined)
  ) {
    return { status: 'working', label: '后台运行中', badge: 'badge-accent' }
  }
  if (backgroundRunStatus === 'failed') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (backgroundRunStatus === 'aborted') return { status: 'error', label: '已中止', badge: 'badge-warn' }
  if (summaryStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (summaryStatus === 'done' || summaryStatus === 'idle') {
    if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
    if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
    return { status: 'done', label: '已完成', badge: 'badge-ok' }
  }
  if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
  if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (toolStatus === 'done') return { status: 'done', label: '已完成', badge: 'badge-ok' }
  return { status: 'pending', label: '进行中', badge: 'badge-neutral' }
}

/** 卡片头部紧凑标题：仅当 summary.title 是有意义的用户标题时返回。 */
export function compactCardTitle(title: string | undefined, childConversationId: number): string | undefined {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') return undefined
  if (trimmed === `子代理 ${childConversationId}` || trimmed === `子会话 ${childConversationId}`) return undefined
  return trimmed
}

/** spawn 注入的结构化输出契约样板。 */
const STRUCTURED_OUTPUT_CONTRACT_RE = /<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g

function stripStructuredOutputContract(text: string): string {
  return text.replace(STRUCTURED_OUTPUT_CONTRACT_RE, '')
}

/** 文本最后一个非空行（去掉 # / - 引导前缀）。 */
function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    return line.replace(/^[#-]+\s+/, '')
  }
  return undefined
}

/** [subagent ...] 尾注行（内核 footer 元数据）。 */
const SUBAGENT_FOOTER_TAIL_RE = /\n*\[subagent [^\]]*\]\s*$/

function stripSubagentFooter(text: string): string {
  return text.replace(SUBAGENT_FOOTER_TAIL_RE, '')
}

/** 父工具轻量摘要（折叠态头部数据源）。 */
export interface SubagentParentToolSummary {
  prompt?: string
  startedAt?: number
  durationMs?: number
  resultText?: string
  isError?: boolean
}

/** 卡片头部任务标题：用户标题 > 父工具 prompt > 后台 run 首节点 label / prompt。 */
export function resolveSubagentTaskTitle(
  summary: ConversationSummary | undefined,
  childConversationId: number,
  toolSummary?: SubagentParentToolSummary,
  backgroundRun?: WorkflowRunSummary,
): string | undefined {
  const custom = compactCardTitle(summary?.title, childConversationId)
  if (custom !== undefined) return custom
  const prompt = toolSummary?.prompt
  if (prompt !== undefined && prompt.trim() !== '') {
    return firstLineOf(stripStructuredOutputContract(prompt), 60)
  }
  const firstNode = backgroundRun?.nodes?.[0]
  const label = firstNode?.label
  if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') {
    return firstLineOf(label, 60)
  }
  const nodePrompt = firstNode?.prompt
  if (nodePrompt !== undefined && nodePrompt.trim() !== '') {
    return firstLineOf(nodePrompt, 60)
  }
  return undefined
}

/** 模型短名：剥离 provider/ 前缀，空串返回 undefined。 */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/** 仅以本次调用或 run 的记录计时；未知边界时省略。 */
export function resolveSubagentElapsedMs(input: {
  backgroundRun?: WorkflowRunSummary
  toolSummary?: SubagentParentToolSummary
  startedAt?: number
  nowMs?: number
  isWorking?: boolean
}): number | undefined {
  if (input.isWorking) {
    const start = input.backgroundRun?.status === 'running'
      ? input.backgroundRun.createdAt
      : input.startedAt ?? input.toolSummary?.startedAt
    return start !== undefined && Number.isFinite(start) && input.nowMs !== undefined && input.nowMs >= start
      ? input.nowMs - start
      : undefined
  }
  const elapsed = input.backgroundRun !== undefined
    ? input.backgroundRun.nodes?.[0]?.durationMs ?? input.backgroundRun.updatedAt - input.backgroundRun.createdAt
    : input.toolSummary?.durationMs
  return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

/** 第 2 层动态副栏。 */
export interface SubagentHeaderSnippet {
  kind: 'tool' | 'thinking' | 'text' | 'doing' | 'blocked' | 'done' | 'error'
  tag?: string
  text: string
}

/** 仅缩短相对于子会话 cwd 的路径，兼容远端节点与 Windows 路径。 */
function shortenPath(p: string, cwd?: string): string {
  const separator = p.includes('\\') ? '\\' : '/'
  const prefix = cwd?.replace(/[\\/]+$/, '')
  const relative = prefix && p.startsWith(`${prefix}${separator}`) ? p.slice(prefix.length + 1) : p
  return relative.length > 48 ? `…${relative.slice(-46)}` : relative
}

/** 单行轨迹核心入参摘要（工具名 + 入参压缩为一行）。 */
export function toolSummaryText(toolName: string, input: unknown): string {
  void toolName
  let raw = ''
  if (typeof input === 'string') {
    raw = input
  } else if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const preferred = ['command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill_id']
    for (const key of preferred) {
      const v = record[key]
      if (typeof v === 'string' && v !== '') {
        raw = v
        break
      }
    }
    if (raw === '') {
      raw = Object.entries(record)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${summarizeValue(v)}`)
        .join(' ')
    }
  }
  const firstLine = raw.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

function summarizeValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** 活跃工具语义化动作提炼。 */
export function formatSemanticToolAction(toolName: string, input: unknown, cwd?: string): { tag: string; text: string } {
  switch (toolName) {
    case 'bash': {
      const command = inputString(input, 'command')
      return { tag: 'bash', text: command !== undefined ? firstLineOf(command, 80) : toolName }
    }
    case 'read':
    case 'read_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '读取', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'edit':
    case 'edit_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '编辑', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'write':
    case 'write_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '写入', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'grep': {
      const pattern = inputString(input, 'pattern')
      return { tag: '搜索', text: pattern !== undefined ? firstLineOf(pattern, 60) : toolName }
    }
    case 'find':
    case 'ls': {
      const target = inputString(input, 'pattern') ?? inputString(input, 'path')
      return { tag: '查找', text: target !== undefined ? shortenPath(firstLineOf(target, 80), cwd) : toolName }
    }
    default: {
      const text = toolSummaryText(toolName, input)
      return { tag: toolName, text: text !== '' ? text : toolName }
    }
  }
}

/** 从父工具 resultText 提取完成结论预览。 */
export function extractSubagentResultPreview(resultText: string | undefined): string | undefined {
  if (resultText === undefined) return undefined
  const trimmed = resultText.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        for (const key of ['result', 'output', 'summary']) {
          const v = record[key]
          if (typeof v === 'string' && v.trim() !== '') return firstLineOf(v, 100)
          if (v !== undefined && v !== null && typeof v === 'object') return firstLineOf(JSON.stringify(v), 100)
        }
        return firstLineOf(JSON.stringify(parsed), 100)
      }
    } catch {
      // 非 JSON：退回普通文本处理
    }
  }
  const stripped = stripSubagentFooter(trimmed)
  if (stripped.trim() === '') return undefined
  return firstLineOf(stripped, 100)
}

/** 从父工具 resultText 提取错误文本。 */
function errorTextFromToolSummary(toolSummary: SubagentParentToolSummary | undefined): string | undefined {
  if (toolSummary === undefined) return undefined
  const raw = toolSummary.resultText?.trim()
  if (raw !== undefined && raw !== '' && raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (record['ok'] === false && typeof record['error'] === 'string' && record['error'].trim() !== '') {
          return firstLineOf(record['error'], 100)
        }
      }
    } catch {
      // 非 JSON：按文本处理
    }
  }
  if (toolSummary.isError === true && raw !== undefined && raw !== '') {
    const stripped = stripSubagentFooter(raw)
    if (stripped.trim() !== '') return firstLineOf(stripped, 100)
  }
  return undefined
}

/** 后台 run 失败时的错误文本。 */
function backgroundRunError(backgroundRun: WorkflowRunSummary): string | undefined {
  if (backgroundRun.error !== undefined && backgroundRun.error.trim() !== '') {
    return firstLineOf(backgroundRun.error, 100)
  }
  const failed = backgroundRun.nodes?.find((n) => n.status === 'failed')
  if (failed === undefined) return '后台执行失败'
  if (failed.error !== undefined && failed.error.trim() !== '') return firstLineOf(failed.error, 100)
  if (failed.gate?.ok === false && failed.gate.output.trim() !== '') return firstLineOf(failed.gate.output, 100)
  return '后台执行失败'
}

/** 后台 run 产出的单行预览。 */
function backgroundRunResultPreview(backgroundRun: WorkflowRunSummary | undefined): string | undefined {
  if (backgroundRun === undefined) return undefined
  const nodeOutput = backgroundRun.nodes?.[0]?.output
  const preview = extractSubagentResultPreview(
    typeof nodeOutput === 'string' ? nodeOutput : nodeOutput !== undefined ? JSON.stringify(nodeOutput) : backgroundRun.result !== undefined ? (typeof backgroundRun.result === 'string' ? backgroundRun.result : JSON.stringify(backgroundRun.result)) : undefined,
  )
  return preview
}

/** entries 中最后一条报错工具输出或消息文本。 */
function lastErrorLine(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helm.input')
  const lines = buildSubagentStreamLines(latestInputIndex >= 0 ? entries.slice(latestInputIndex) : entries)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.kind === 'tool' && line.isError) {
      const text = line.resultPreview ?? line.summary
      return firstLineOf(text, 100)
    }
    if (line.kind === 'text' && /^(失败|错误|异常|error)/i.test(line.text.trim())) {
      return firstLineOf(line.text, 100)
    }
  }
  return undefined
}

/** entries 中最后一条 assistant 正文（剥离结构化输出契约样板）。 */
function lastAssistantText(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helm.input')
  const lines = buildSubagentStreamLines(latestInputIndex >= 0 ? entries.slice(latestInputIndex) : entries)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.kind !== 'text') continue
    const stripped = stripStructuredOutputContract(line.text).trim()
    if (stripped !== '') return firstLineOf(stripped, 100)
  }
  return undefined
}

/** 第 2 层动态副栏推导（badgeStatus 分流；无有效文本时 undefined）。 */
export function resolveSubagentHeaderSnippet(input: {
  badgeStatus: SubagentCardStatus
  summary?: ConversationSummary
  live?: ConversationLive
  entries?: ReadonlyArray<ConversationEntry>
  pendingAsk?: Pick<AskSpec, 'title' | 'description'>
  backgroundRun?: WorkflowRunSummary
  toolSummary?: SubagentParentToolSummary
  detailError?: string
}): SubagentHeaderSnippet | undefined {
  if (input.detailError !== undefined) {
    return { kind: 'error', tag: '加载失败', text: firstLineOf(input.detailError, 100) }
  }
  if (input.badgeStatus === 'blocked') {
    const text = input.pendingAsk?.title || input.pendingAsk?.description || input.summary?.doing || '等待人工确认'
    return { kind: 'blocked', tag: '等待审批', text: firstLineOf(text, 100) }
  }
  if (input.badgeStatus === 'error') {
    if (input.backgroundRun?.status === 'failed' || input.backgroundRun?.status === 'aborted') {
      return {
        kind: 'error',
        tag: input.backgroundRun.status === 'aborted' ? '已中止' : '后台执行失败',
        text: backgroundRunError(input.backgroundRun) ?? '后台执行失败',
      }
    }
    const toolErr = errorTextFromToolSummary(input.toolSummary)
    if (toolErr !== undefined) return { kind: 'error', tag: '失败', text: toolErr }
    const entryErr = lastErrorLine(input.entries)
    if (entryErr !== undefined) return { kind: 'error', tag: '异常', text: entryErr }
    return { kind: 'error', tag: '异常', text: firstLineOf(input.summary?.doing || '子代理执行异常', 100) }
  }
  if (input.badgeStatus === 'working') {
    const runningTools = (input.live?.tools ?? []).filter((t) => t.status === 'running')
    if (runningTools.length === 1) {
      const item = formatSemanticToolAction(runningTools[0]!.toolName, runningTools[0]!.input, input.summary?.cwd)
      return { kind: 'tool', tag: item.tag, text: item.text }
    }
    if (runningTools.length > 1) {
      const items = runningTools.slice(0, 2).map((t) => formatSemanticToolAction(t.toolName, t.input, input.summary?.cwd))
      const text = items.map((it) => `${it.tag} ${it.text}`).join(' · ') + (runningTools.length > 2 ? ' 等' : '')
      return { kind: 'tool', tag: `并行 ${runningTools.length} 项`, text }
    }
    const textLine = input.live?.text !== undefined ? lastMeaningfulLine(input.live.text) : undefined
    if (textLine !== undefined) return { kind: 'text', tag: '输出', text: firstLineOf(textLine, 100) }
    const thinkingLine = input.live?.thinking !== undefined ? lastMeaningfulLine(input.live.thinking) : undefined
    if (thinkingLine !== undefined) return { kind: 'thinking', tag: '思考', text: firstLineOf(thinkingLine, 100) }
    if (
      input.backgroundRun?.status === 'running' &&
      (input.summary?.status === 'idle' || input.summary?.status === 'done') &&
      input.backgroundRun.nodes?.some((n) => n.gateCommand !== undefined && n.gateCommand !== '')
    ) {
      const gateCommand = input.backgroundRun.nodes.find((n) => n.gateCommand !== undefined && n.gateCommand !== '')?.gateCommand
      if (gateCommand !== undefined) return { kind: 'doing', tag: 'Gate 验收', text: firstLineOf(gateCommand, 100) }
    }
    return { kind: 'doing', text: firstLineOf(input.summary?.doing || '正在启动子代理…', 100) }
  }
  if (input.badgeStatus === 'done') {
    const fromRun = backgroundRunResultPreview(input.backgroundRun)
    if (fromRun !== undefined) return { kind: 'done', text: fromRun }
    const fromEntries = lastAssistantText(input.entries)
    if (fromEntries !== undefined) return { kind: 'done', text: fromEntries }
    const fromTool = input.backgroundRun === undefined ? extractSubagentResultPreview(input.toolSummary?.resultText) : undefined
    if (fromTool !== undefined) return { kind: 'done', text: fromTool }
    return undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 子会话实时流（原 subagent-model.ts 展开逻辑）
// ---------------------------------------------------------------------------

/** 子会话紧凑活动行。 */
export type SubagentStreamLine =
  | { kind: 'prompt'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolName: string
      summary: string
      status: 'running' | 'done' | 'error' | 'unknown'
      isError: boolean
      durationMs?: number
      resultPreview?: string
    }
  | { kind: 'text'; key: string; text: string }

/** 展示层剥离的 spawn 注入结构化输出契约样板（末尾尾行）。 */
const STRUCTURED_OUTPUT_CONTRACT_TAIL_RE = /\n*<structured_output_contract>[\s\S]*?<\/structured_output_contract>\s*$/

/** 子会话实时内容流：detail.entries + ConversationLive 合并展开为紧凑活动行。 */
export function buildSubagentStreamLines(
  entries: ReadonlyArray<ConversationEntry>,
  live?: ConversationLive,
  working?: boolean,
): SubagentStreamLine[] {
  const lines: SubagentStreamLine[] = []
  const liveToolKeys = new Set((live?.tools ?? []).map((t) => `tool:${t.callId}`))
  const liveToolByKey = new Map((live?.tools ?? []).map((t) => [`tool:${t.callId}`, t] as const))
  let liveTextConsumed = false
  let seq = 0
  for (const entry of entries) {
    if (entry.kind === 'helm.input' || entry.kind === 'pi.user') {
      const text = entry.kind === 'helm.input'
        ? (entry.data !== null && typeof entry.data === 'object' && !Array.isArray(entry.data) ? (entry.data as Record<string, unknown>)['text'] : undefined)
        : undefined
      const finalText = typeof text === 'string' ? text : ''
      if (finalText.trim() !== '') {
        lines.push({ kind: 'prompt', key: `prompt:${entry.id}`, text: finalText.replace(STRUCTURED_OUTPUT_CONTRACT_TAIL_RE, '').trim() })
      }
      continue
    }
    if (entry.kind !== 'pi.assistant' && entry.kind !== 'pi.tool-result') continue
    const model = entry.model
    if (!Array.isArray(model)) continue
    for (let mi = 0; mi < model.length; mi++) {
      const msg = model[mi]
      if (msg === null || typeof msg !== 'object') continue
      const m0 = msg as { role?: unknown; content?: unknown }
      // 仅展开 assistant 消息的内容块；toolResult 消息（role=toolResult/tool）
      // 的 content 是结果文本，由下方配对逻辑合并进对应工具行，不另生正文行。
      if (m0.role !== undefined && m0.role !== 'assistant') continue
      const content = m0.content
      if (!Array.isArray(content)) continue
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi]
        if (block === null || typeof block !== 'object') continue
        const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; input?: unknown }
        const key = `${entry.id}:${mi}:${bi}`
        if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim() !== '') {
            lines.push({ kind: 'thinking', key: `think:${key}`, text: b.thinking })
          }
        } else if (b.type === 'text') {
          if (typeof b.text === 'string' && b.text !== '') lines.push({ kind: 'text', key: `text:${key}`, text: b.text })
        } else if (b.type === 'toolCall' || b.type === 'tool_use') {
          const callId = typeof b.id === 'string' ? b.id : typeof b.callId === 'string' ? b.callId : undefined
          const name = typeof b.name === 'string' ? b.name : '(unknown tool)'
          const input = 'arguments' in b ? b.arguments : b.input
          const lt = callId !== undefined ? liveToolByKey.get(`tool:${callId}`) : undefined
          lines.push({
            kind: 'tool',
            key: `tool:${callId ?? key}`,
            toolName: name,
            summary: toolSummaryText(name, input),
            status: lt?.status ?? (working === true ? 'running' : 'unknown'),
            isError: false,
          })
        }
      }
    }
    // pi.tool-result 配对补全（与 toolCall 行同 key 去重）。
    if (entry.kind === 'pi.tool-result') {
      for (let mi = 0; mi < model.length; mi++) {
        const msg = model[mi]
        if (msg === null || typeof msg !== 'object') continue
        const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown }
        if (m.role !== 'toolResult' && m.role !== 'tool') continue
        const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
        const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
        const isError = m.isError === true
        const durationMs = typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) ? m.durationMs : undefined
        const resultText = contentTextOf(m.content)
        const key = `tool:${callId ?? `${entry.id}:${mi}`}`
        const existing = lines.findLast((line) => line.kind === 'tool' && line.key === key)
        if (existing !== undefined && existing.kind === 'tool') {
          existing.status = isError ? 'error' : 'done'
          existing.isError = isError
          if (durationMs !== undefined) existing.durationMs = durationMs
          if (resultText !== '') existing.resultPreview = firstLineOf(resultText, 100)
          continue
        }
        lines.push({
          kind: 'tool',
          key,
          toolName,
          summary: toolSummaryText(toolName, undefined),
          status: isError ? 'error' : 'done',
          isError,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(resultText !== '' ? { resultPreview: firstLineOf(resultText, 100) } : {}),
        })
      }
    }
  }
  // live 合并：流式思考 / 未配对新工具 / 流式文本。
  if (typeof live?.thinking === 'string' && live.thinking.trim() !== '') {
    lines.push({ kind: 'thinking', key: 'think:live', text: live.thinking })
  }
  for (const lt of live?.tools ?? []) {
    if (typeof lt?.callId !== 'string' || liveToolKeys.has(`tool:${lt.callId}`) === false) continue
  }
  if (live?.tools !== undefined) {
    const seenCallIds = new Set(
      lines.filter((l): l is Extract<SubagentStreamLine, { kind: 'tool' }> => l.kind === 'tool' && l.key.startsWith('tool:'))
        .map((l) => l.key.slice('tool:'.length)),
    )
    for (const lt of live.tools) {
      if (typeof lt?.callId !== 'string' || seenCallIds.has(lt.callId)) continue
      const text = typeof lt.result === 'string' ? lt.result : undefined
      lines.push({
        kind: 'tool',
        key: `tool:${lt.callId}`,
        toolName: lt.toolName,
        summary: toolSummaryText(lt.toolName, lt.input),
        status: lt.status,
        isError: lt.status === 'error',
        ...(text !== undefined && text !== '' ? { resultPreview: firstLineOf(text, 100) } : {}),
      })
    }
  }
  if (!liveTextConsumed && typeof live?.text === 'string' && live.text.trim() !== '') {
    const persistedText = lines.findLast((line) => line.kind === 'text')?.text
    if (persistedText?.startsWith(live.text) !== true) {
      lines.push({ kind: 'text', key: `text:live:${seq++}`, text: live.text })
    }
  }
  return lines
}

function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

/** 头部极简统计尾注片段。 */
export function buildSubagentStatSegments(input: {
  summary?: ConversationSummary
  entries?: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  backgroundRun?: WorkflowRunSummary
  toolSummary?: SubagentParentToolSummary
  nowMs?: number
  startedAt?: number
  isWorking?: boolean
}): string[] {
  const segments: string[] = []
  const shortModel = formatShortModelName(input.summary?.model || input.backgroundRun?.nodes?.[0]?.model)
  if (shortModel !== undefined) segments.push(shortModel)
  if (input.summary?.thinkingLevel !== undefined && input.summary.thinkingLevel.trim() !== '' && input.summary.thinkingLevel !== 'off') {
    segments.push(input.summary.thinkingLevel)
  }
  const steps = countToolSteps(input.entries, input.live)
  if (steps !== undefined && steps > 0) segments.push(`已载 ${steps} 次工具`)
  const tokens = input.backgroundRun?.nodes?.[0]?.tokens
  if (tokens !== undefined && tokens > 0) segments.push(formatCompactTokens(tokens))
  const elapsed = resolveSubagentElapsedMs(input)
  if (elapsed !== undefined) segments.push(formatDurationMs(elapsed))
  return segments
}

/** 统计 entries 已落库 toolCall 总次数，加上 live.tools 中尚未落库的新 callId。 */
function countToolSteps(entries: ReadonlyArray<ConversationEntry> | undefined, live: ConversationLive | undefined): number | undefined {
  if (entries === undefined) {
    return live !== undefined && live.tools.length > 0 ? live.tools.length : undefined
  }
  const lines = buildSubagentStreamLines(entries)
  const seenCallIds = new Set<string>()
  let count = 0
  for (const line of lines) {
    if (line.kind !== 'tool') continue
    count++
    if (line.key.startsWith('tool:')) {
      const callId = line.key.slice('tool:'.length)
      if (callId !== '') seenCallIds.add(callId)
    }
  }
  for (const t of live?.tools ?? []) {
    if (t.callId !== '' && !seenCallIds.has(t.callId)) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// 工作流卡纯逻辑（原 workflow-card-model.ts）
// ---------------------------------------------------------------------------

/** 节点收起行主信息摘要。 */
export function hasNodeExtraDetail(node: WorkflowNodeState): boolean {
  return node.agentType !== undefined || node.executionId !== undefined || node.nodeId !== undefined ||
    node.effectiveCwd !== undefined || node.gateCommand !== undefined || node.prompt !== undefined
}

export interface NodeSummaryText {
  text?: string
  isError: boolean
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return '…'
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** 节点产出紧凑单行预览。 */
export function formatNodeOutputPreview(output: unknown, maxChars = 80): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') {
    const trimmed = output.trim()
    if (trimmed === '') return undefined
    return truncateWithEllipsis(firstLine(trimmed), maxChars)
  }
  let serialized: string
  try {
    serialized = JSON.stringify(output) ?? String(output)
  } catch {
    serialized = String(output)
  }
  if (serialized === '') return undefined
  return truncateWithEllipsis(serialized, maxChars)
}

/** 节点收起行主信息摘要（耗时在右侧单独渲染）。 */
export function resolveNodeSummaryText(
  node: WorkflowNodeState,
  childDoing?: string,
  childStatus?: ConversationSummary['status'],
  pendingAskTitle?: string,
): NodeSummaryText {
  if (node.status === 'running' && childStatus === 'blocked') {
    return { text: `等待审批：${pendingAskTitle || childDoing || '等待人工确认'}`, isError: false }
  }
  if (node.status === 'running') {
    const doing = childDoing?.trim()
    return { text: doing !== undefined && doing !== '' ? doing : (node.phaseTitle ?? '执行中…'), isError: false }
  }
  if (node.status === 'failed') {
    if (node.error !== undefined && node.error.trim() !== '') {
      return { text: truncateWithEllipsis(firstLine(node.error.trim()), 100), isError: true }
    }
    if (node.gate?.ok === false) {
      const gateOutput = node.gate.output.trim()
      const text = gateOutput !== '' ? truncateWithEllipsis(firstLine(gateOutput), 100) : 'Gate 验收未通过'
      return { text, isError: true }
    }
    return { text: '执行失败', isError: true }
  }
  if (node.status === 'skipped') {
    return { text: node.error ?? '已跳过', isError: false }
  }
  if (node.status === 'done') {
    return { text: formatNodeOutputPreview(node.output), isError: false }
  }
  return { text: '排队等待执行…', isError: false }
}

/** 按阶段分组的节点视图模型。 */
export interface WorkflowPhaseSection {
  key: string
  index: number
  title: string
  detail?: string
  status: 'pending' | 'running' | 'done' | 'failed'
  nodes: WorkflowNodeState[]
  doneCount: number
  totalCount: number
}

/**
 * 阶段分组状态：running 优先可见；failed 次之；全部结算（done / skipped）
 * 才判 done——存在 pending 未执行节点时，run 仍在跑为进行中，run 已终结
 * 也不得假完成（pending 不被 done 掩盖）。
 */
function sectionStatus(
  nodes: WorkflowNodeState[],
  runStatus: WorkflowRunSummary['status'],
): WorkflowPhaseSection['status'] {
  if (nodes.some((n) => n.status === 'running')) return 'running'
  if (nodes.length === 0 || nodes.every((n) => n.status === 'pending')) return 'pending'
  if (nodes.some((n) => n.status === 'failed')) return 'failed'
  if (nodes.every((n) => n.status === 'done' || n.status === 'skipped')) return 'done'
  return runStatus === 'running' ? 'running' : 'pending'
}

const DEFAULT_SECTION_TITLE = '默认阶段'

/** 构建按阶段分组的节点视图（不过滤任何节点）。 */
export function buildWorkflowPhaseSections(run: WorkflowRunSummary): WorkflowPhaseSection[] {
  const nodes = run.nodes ?? []
  const allNodes = [...nodes]

  const declared: Array<{ title: string; detail?: string }> = []
  const seen = new Set<string>()
  const declare = (title: string, detail?: string): void => {
    const key = title.trim()
    if (key === '' || seen.has(key)) return
    seen.add(key)
    declared.push({ title: key, detail })
  }
  for (const phase of run.phases ?? []) declare(phase.title, phase.detail)
  for (const p of run.progress ?? []) {
    if (p.kind === 'phase') declare(p.title)
  }
  for (const node of allNodes) {
    if (node.phaseTitle !== undefined) declare(node.phaseTitle)
  }

  if (declared.length === 0) {
    const doneCount = allNodes.filter((n) => n.status === 'done').length
    return [
      {
        key: 'default',
        index: 0,
        title: '',
        nodes: allNodes,
        status: sectionStatus(allNodes, run.status),
        doneCount,
        totalCount: allNodes.length,
      },
    ]
  }

  const buckets = new Map<string, WorkflowNodeState[]>()
  const defaultNodes: WorkflowNodeState[] = []
  for (const node of allNodes) {
    const key = node.phaseTitle?.trim()
    if (key !== undefined && key !== '' && seen.has(key)) {
      const bucket = buckets.get(key)
      if (bucket !== undefined) bucket.push(node)
      else buckets.set(key, [node])
    } else {
      defaultNodes.push(node)
    }
  }

  const sections: WorkflowPhaseSection[] = declared.map((phase, idx) => {
    const group = buckets.get(phase.title) ?? []
    const doneCount = group.filter((n) => n.status === 'done').length
    return {
      key: `phase:${idx}:${phase.title}`,
      index: idx,
      title: phase.title,
      ...(phase.detail !== undefined ? { detail: phase.detail } : {}),
      status: sectionStatus(group, run.status),
      nodes: group,
      doneCount,
      totalCount: group.length,
    }
  })
  if (defaultNodes.length > 0) {
    const doneCount = defaultNodes.filter((n) => n.status === 'done').length
    sections.push({
      key: `phase:${declared.length}:${DEFAULT_SECTION_TITLE}`,
      index: declared.length,
      title: DEFAULT_SECTION_TITLE,
      status: sectionStatus(defaultNodes, run.status),
      nodes: defaultNodes,
      doneCount,
      totalCount: defaultNodes.length,
    })
  }
  return sections
}

/** 脚本 log() 路标行。 */
export interface WorkflowLogLine {
  key: string
  at: number
  message: string
}

/** 提取脚本 log() 路标。 */
export function extractWorkflowLogs(run: WorkflowRunSummary): WorkflowLogLine[] {
  return (run.progress ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'log' }> => p.kind === 'log')
    .map((p, idx) => ({ key: `log:${idx}:${p.at}`, at: p.at, message: p.message }))
}

/** 断点恢复可用判定：仅 DSL 编排工作流失败或中止后可用。 */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && (run.status === 'failed' || run.status === 'aborted')
}

/**
 * 已完成 run 重放可用判定：非 subagent 的 completed DSL run（含内联脚本）。
 * resumeFromRunId 对 completed run 同样合法：engine 沿用原脚本源（已保存定义
 * 重读最新文件、内联沿用源码）与原 args（显式 args 可覆盖），新 run 保留原会话。
 * journal 缓存仅复用调用载荷完全相同的前缀节点，首次失配起真实重执行；
 * 不承诺改参必命中缓存，含外部副作用的节点照实重跑。
 */
export function canReplayWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && run.status === 'completed'
}

// ---------------------------------------------------------------------------
// 受管工作树只读检视（inspect_worktree 动作结果的宽松解析与视图模型）
// ---------------------------------------------------------------------------

/** inspect_worktree 动作结果的只读视图（非法形状解析为 undefined，不猜测）。 */
export interface WorktreeInspectView {
  worktreeId: string
  nodeId: string
  path: string
  branch: string
  baseCommit: string
  status: string
  origin: string
  exists: boolean
  unavailableReason?: string
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  dirtyFiles: string[]
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  commitsAhead?: number
  diffStat?: string
  diffPreview?: string
  diffTruncated: boolean
  diffBase: string
}

function inspectString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 非负安全整数（计数类字段类型边界）。 */
function inspectCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 宽松解析 inspect_worktree 动作结果（结构非法返回 undefined，不伪造）。
 *
 * 边界收紧：exists / dirtyFiles（纯 string[]）/ dirtyFileCount（非负安全整数，
 * 不再回退数组长度）/ dirtyFilesTruncated / diffTruncated（boolean）/ diffBase
 * （枚举）与 record 核心字段均为必需且类型正确；可选字段（unavailableReason /
 * status / origin / commitsAhead 等）出现非法取值同样整体拒绝。缺字段或类型
 * 错位的响应绝不降级显示成「已清理 / 无变更」，一律 undefined 拒收。
 * 一致性不变式：未截断时 dirtyFileCount === dirtyFiles.length；截断时计数大于列表长度。
 */
export function parseWorktreeInspectResult(raw: unknown): WorktreeInspectView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result = raw as Record<string, unknown>
  const record = result['record']
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const rec = record as Record<string, unknown>
  const worktreeId = inspectString(rec, 'id')
  const path = inspectString(rec, 'path')
  const branch = inspectString(rec, 'branch')
  const nodeId = inspectString(rec, 'nodeId')
  if (worktreeId === undefined || path === undefined || branch === undefined || nodeId === undefined) return undefined
  const baseCommit = rec['baseCommit']
  if (baseCommit !== undefined && typeof baseCommit !== 'string') return undefined
  const status = rec['status'] ?? 'active'
  if (status !== 'active' && status !== 'removed') return undefined
  const origin = rec['origin'] ?? 'native'
  if (origin !== 'native' && origin !== 'external') return undefined
  if (typeof result['exists'] !== 'boolean') return undefined
  const dirtyFilesRaw = result['dirtyFiles']
  if (!Array.isArray(dirtyFilesRaw) || dirtyFilesRaw.some((l) => typeof l !== 'string')) return undefined
  const dirtyFiles = dirtyFilesRaw as string[]
  if (!inspectCount(result['dirtyFileCount'])) return undefined
  const dirtyFileCount: number = result['dirtyFileCount']
  if (typeof result['dirtyFilesTruncated'] !== 'boolean') return undefined
  const dirtyFilesTruncated: boolean = result['dirtyFilesTruncated']
  if (typeof result['diffTruncated'] !== 'boolean') return undefined
  const diffBase = result['diffBase']
  if (diffBase !== 'baseCommit' && diffBase !== 'HEAD') return undefined
  if (dirtyFilesTruncated ? dirtyFileCount <= dirtyFiles.length : dirtyFileCount !== dirtyFiles.length) return undefined
  const unavailableReason = inspectString(result, 'unavailableReason')
  if (unavailableReason !== undefined && unavailableReason !== 'removed' && unavailableReason !== 'directory_missing') {
    return undefined
  }
  const currentBranch = inspectString(result, 'currentBranch')
  const currentHead = inspectString(result, 'currentHead')
  if (result['branchChanged'] !== undefined && typeof result['branchChanged'] !== 'boolean') return undefined
  const commitsAhead = result['commitsAhead']
  if (commitsAhead !== undefined && !inspectCount(commitsAhead)) return undefined
  const diffStat = inspectString(result, 'diffStat')
  const diffPreview = inspectString(result, 'diffPreview')
  return {
    worktreeId,
    nodeId,
    path,
    branch,
    baseCommit: baseCommit ?? '',
    status,
    origin,
    exists: result['exists'],
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    ...(currentBranch !== undefined ? { currentBranch } : {}),
    ...(currentHead !== undefined ? { currentHead } : {}),
    ...(result['branchChanged'] === true ? { branchChanged: true } : {}),
    dirtyFiles,
    dirtyFileCount,
    dirtyFilesTruncated,
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    ...(diffStat !== undefined ? { diffStat } : {}),
    ...(diffPreview !== undefined ? { diffPreview } : {}),
    diffTruncated: result['diffTruncated'],
    diffBase,
  }
}

/**
 * 构建 worktree 动作（inspect_worktree / cleanup_worktree）调用选择器：
 * 优先受管登记 ID（精确）；无 ID 时退化 path（+nodeId 消歧，避免跨节点
 * 同名路径误满）。仅作用于已登记 worktree，绝不携带任意目录。
 */
export function buildWorktreeSelector(
  worktree: { id?: string; path: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  return { path: worktree.path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
}

/** 「让主会话审阅并合入」请求文案：只含登记元数据与只读检视统计，不含执行指令伪装。 */
export function buildWorktreeReviewRequest(input: {
  path: string
  branch: string
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  inspect?: WorktreeInspectView
}): string {
  const lines: string[] = ['请审阅并合入以下受管工作树的改动（数据来自只读检视，实际内容请在目标节点以 git 复核）：']
  lines.push(`- 工作树：${input.path}${input.nodeId !== undefined && input.nodeId !== '' ? `（节点 ${input.nodeId}）` : ''}`)
  lines.push(`- 分支：${input.branch}${input.baseCommit !== undefined && input.baseCommit !== '' ? `（基于提交 ${input.baseCommit.slice(0, 12)}）` : ''}`)
  if (input.taskLabel !== undefined && input.taskLabel.trim() !== '') lines.push(`- 任务：${firstLineOf(input.taskLabel, 80)}`)
  const inspect = input.inspect
  if (inspect !== undefined) {
    if (!inspect.exists) {
      lines.push(`- 检视：目录${inspect.unavailableReason === 'removed' ? '登记已清理' : '不存在'}，无可检视改动`)
    } else {
      lines.push(`- 未提交修改：${inspect.dirtyFileCount} 个文件`)
      if (inspect.commitsAhead !== undefined) lines.push(`- 领先基线提交：${inspect.commitsAhead} 个`)
      if (inspect.branchChanged === true && inspect.currentBranch !== undefined) {
        lines.push(`- 注意：工作树当前分支 ${inspect.currentBranch} 与登记分支不一致，可能已被改签，请先核实归属`)
      }
    }
  }
  lines.push('请先只读复核（git diff / status），确认后合入主工作树；需要丢弃或清理工作树时请明确说明，不要静默 force 清理。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 工作流库（list/get/save 动作结果的严格解析与 args 严格解析）
// ---------------------------------------------------------------------------

/** 已保存工作流条目视图（与 SavedWorkflowSummary 同构；严格解析）。 */
export interface SavedWorkflowView {
  name: string
  path?: string
  /** 定义文件最后修改时间（epoch ms）。 */
  updatedAt: number
  /** 定义文件字节数。 */
  size: number
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** get 动作返回的完整定义视图（含只读源码）。 */
export interface SavedWorkflowDetailView extends SavedWorkflowView {
  script: string
}

/** 非负安全整数校验（文件事实字段类型边界）。 */
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 条目解析：条目非对象、缺 name、updatedAt/size 非非负安全整数、phases 非法时 undefined。 */
function parseSavedWorkflowEntry(item: unknown): SavedWorkflowView | undefined {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  const name = inspectString(record, 'name')
  if (name === undefined) return undefined
  if (!nonNegativeInteger(record['updatedAt'])) return undefined
  if (!nonNegativeInteger(record['size'])) return undefined
  let phases: Array<{ title: string; detail?: string; model?: string }> | undefined
  const phasesRaw = record['phases']
  if (phasesRaw !== undefined) {
    if (!Array.isArray(phasesRaw)) return undefined
    const parsedPhases: Array<{ title: string; detail?: string; model?: string }> = []
    for (const p of phasesRaw) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return undefined
      const phase = p as Record<string, unknown>
      const title = inspectString(phase, 'title')
      if (title === undefined) return undefined
      const detail = inspectString(phase, 'detail')
      const model = inspectString(phase, 'model')
      parsedPhases.push({
        title,
        ...(detail !== undefined ? { detail } : {}),
        ...(model !== undefined ? { model } : {}),
      })
    }
    phases = parsedPhases.length > 0 ? parsedPhases : undefined
  }
  return {
    name,
    updatedAt: record['updatedAt'],
    size: record['size'],
    ...(inspectString(record, 'path') !== undefined ? { path: inspectString(record, 'path') } : {}),
    ...(inspectString(record, 'metadataError') !== undefined ? { metadataError: inspectString(record, 'metadataError') } : {}),
    ...(inspectString(record, 'description') !== undefined ? { description: inspectString(record, 'description') } : {}),
    ...(inspectString(record, 'whenToUse') !== undefined ? { whenToUse: inspectString(record, 'whenToUse') } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }
}

/**
 * 严格解析 list 动作结果（非法形状返回 undefined，不伪造列表）。
 *
 * 边界收紧：条目非对象、缺 name、updatedAt/size 缺失或非非负安全整数、
 * phases 非数组或含非法阶段项时整体返回 undefined——不把异常条目静默丢弃
 * 成看似完整的列表（缺项列表会误导用户以为目录里只有这些工作流）。
 */
export function parseSavedWorkflowList(raw: unknown): SavedWorkflowView[] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflows = (raw as Record<string, unknown>)['workflows']
  if (!Array.isArray(workflows)) return undefined
  const out: SavedWorkflowView[] = []
  for (const item of workflows) {
    const entry = parseSavedWorkflowEntry(item)
    if (entry === undefined) return undefined
    out.push(entry)
  }
  return out
}

/**
 * 严格解析 get 动作结果（结构非法返回 undefined，不猜测）：workflow 必需且
 * 含非空 script（只读源码）；其余字段与列表条目同标准。
 */
export function parseWorkflowDetail(raw: unknown): SavedWorkflowDetailView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflow = (raw as Record<string, unknown>)['workflow']
  const entry = parseSavedWorkflowEntry(workflow)
  if (entry === undefined) return undefined
  const script = (workflow as Record<string, unknown>)['script']
  if (typeof script !== 'string' || script === '') return undefined
  return { ...entry, script }
}

/** 严格解析 save 动作结果：created 必需 boolean，workflow 必需合法摘要。 */
export function parseWorkflowSaveResult(raw: unknown): { created: boolean; workflow: SavedWorkflowView } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record['created'] !== 'boolean') return undefined
  const workflow = parseSavedWorkflowEntry(record['workflow'])
  if (workflow === undefined) return undefined
  return { created: record['created'], workflow }
}

/** 内联 run 一键保存为工作流定义的可用判定：非 subagent 且未按已保存定义发起。 */
export function canSaveRunAsWorkflow(run: Pick<WorkflowRunSummary, 'kind' | 'savedName'>): boolean {
  return run.kind !== 'subagent' && run.savedName === undefined
}

/** 「让 AI 修改」请求文案：只描述目标与能力入口，不在 Web 内伪造编辑。 */
export function buildWorkflowEditRequest(name: string, detail?: { description?: string }): string {
  const lines = [
    `请修改已保存工作流 ${name}（跨会话可复用资产）：`,
    '- 先用 workflow get 动作（或 helm workflows get ' + name + ' --json）读取当前源码与元数据；',
    '- 按需求修改后用 workflow save 动作（helm workflows save <文件或源码> --name ' + name + ' --overwrite）写回；保存前校验会自动做语法预检，默认拒绝覆盖、需显式 overwrite；',
    detail?.description !== undefined ? `- 当前描述：${firstLineOf(detail.description, 120)}` : undefined,
    '- 修改完成后告诉我保存结果与变化点，不要静默改动。',
  ].filter((line): line is string => line !== undefined)
  return lines.join('\n')
}

/** 库运行 args 输入严格解析：空串无 args；非空必须为合法 JSON（绝不静默当字符串透传）。 */
export function parseWorkflowArgsInput(text: string): { ok: true; args?: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true }
  try {
    return { ok: true, args: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { ok: false, error: `args 需为合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------------------------------------------------------------------------
// 工作台节点统计工具
// ---------------------------------------------------------------------------

/** 节点统计尾注：模型短名 + 紧凑 token。 */
export function formatWorkflowNodeStats(node: WorkflowNodeState): string[] {
  const segments: string[] = []
  const model = formatShortModelName(node.model)
  if (model !== undefined) segments.push(model)
  if (node.tokens !== undefined && node.tokens > 0) {
    segments.push(node.tokens >= 1000 ? `${(node.tokens / 1000).toFixed(1)}k` : `${node.tokens}`)
  }
  return segments
}

/** 从认领同一子会话的多个后台 run 中选出当前关联者。 */
function pickBackgroundRun(
  runs: ReadonlyArray<WorkflowRunSummary>,
  parentToolCallId: string | undefined,
): WorkflowRunSummary | undefined {
  if (runs.length === 0) return undefined
  if (parentToolCallId !== undefined && parentToolCallId !== '') {
    return runs.find((r) => r.parentToolCallId === parentToolCallId)
  }
  return runs.reduce((latest, r) => (r.createdAt > latest.createdAt ? r : latest))
}

// ---------------------------------------------------------------------------
// 统一执行树 ExecutionTree / ExecutionNode（任意深度递归视图模型）
// ---------------------------------------------------------------------------

/** 统一执行节点状态（与子会话卡片状态同一五值枚举）。 */
export type ExecutionNodeStatus = SubagentCardStatus

/**
 * 状态自底向上聚合：blocked > error > working 优先；「已完成」仅当全部状态
 * 均 done——存在 pending（如未执行的 phase 节点）时不得被 done 掩盖成整体
 * 完成（不以简单最轻值判全完成）；空集返回 pending。
 */
export function aggregateExecutionStatuses(statuses: ReadonlyArray<ExecutionNodeStatus>): ExecutionNodeStatus {
  if (statuses.length === 0) return 'pending'
  let hasBlocked = false
  let hasError = false
  let hasWorking = false
  let hasPending = false
  for (const status of statuses) {
    if (status === 'blocked') hasBlocked = true
    else if (status === 'error') hasError = true
    else if (status === 'working') hasWorking = true
    else if (status === 'pending') hasPending = true
  }
  if (hasBlocked) return 'blocked'
  if (hasError) return 'error'
  if (hasWorking) return 'working'
  if (hasPending) return 'pending'
  return 'done'
}

/**
 * 子树聚合统计（含自身与全部后代）。
 *
 * total / done / running / blocked / error 只计真实执行任务：workflow /
 * external 容器壳在有子节点时不计自身（一次真实执行只计一次，wrapper 不算
 * 独立完成任务；无子节点的空 run 仍计 1）；同一会话被多个历史/续接 run
 * 引用时由构树层保证单一挂载，同样不双计。
 */
export interface ExecutionAggregate {
  status: ExecutionNodeStatus
  /** 子树真实执行任务总数（容器壳不双计）。 */
  total: number
  done: number
  running: number
  blocked: number
  error: number
}

/** 执行树节点种类：原生子会话 / 工作流 run / run 内节点 / 外部执行。 */
export type ExecutionNodeKind = 'conversation' | 'workflow' | 'workflow-node' | 'external'

/** 统一执行树节点：SubagentLiveCard / WorkflowRunCard / WorkflowNodeCard / 外部执行摘要共用同一递归形状。 */
export interface ExecutionNode {
  key: string
  kind: ExecutionNodeKind
  /** 可打开的原生子会话 ID（workflow / workflow-node / 无会话 external 不携带）。 */
  conversationId?: number
  /** 关联工作流 run（conversation 节点为认领的后台 run；workflow / external 节点为自身 run）。 */
  run?: WorkflowRunSummary
  /** run 内原始节点（workflow 节点的子节点携带）。 */
  runNode?: WorkflowNodeState
  /** 展示标题（仅由真实数据提炼）。 */
  label?: string
  /** 实时会话摘要（存在时来自会话列表，绝不虚构）。 */
  summary?: ConversationSummary
  /** 叶子自身状态；整棵子树状态见 aggregated.status。 */
  status: ExecutionNodeStatus
  /** 下一级子节点。 */
  children: ExecutionNode[]
  /** 自底向上聚合（含自身与全部后代）。 */
  aggregated: ExecutionAggregate
  /** 排序用最新更新时间（summary / run 的最大值）。 */
  updatedAt: number
}

/** 会话节点状态：与卡片徽章同源（subagentBadge 权威），保证树聚合与卡片展示一致；无任何数据时 pending，不假完成。
 *
 * 审批事实额外以 pendingAskCount > 0 判定（与 AskDock 同源）：Herdr 外部执行
 * 的 AskDoc 归属原生父会话，此时会话 status 可能仍在 working——有单即 blocked，
 * 避免审批台有单而卡片/树不冒泡。 */
export function executionConversationStatus(
  summary: ConversationSummary | undefined,
  backgroundRun: WorkflowRunSummary | undefined,
  toolStatus?: 'running' | 'done' | 'error' | 'unknown',
): ExecutionNodeStatus {
  if (summary === undefined && backgroundRun === undefined && toolStatus === undefined) return 'pending'
  if ((summary?.pendingAskCount ?? 0) > 0) return 'blocked'
  return subagentBadge(
    summary?.status,
    toolStatus ?? executionToolStatus(summary, backgroundRun),
    backgroundRun?.status,
  ).status
}

/** 工作流 run 状态映射。 */
export function executionRunStatus(run: Pick<WorkflowRunSummary, 'status'>): ExecutionNodeStatus {
  if (run.status === 'running') return 'working'
  if (run.status === 'failed' || run.status === 'aborted') return 'error'
  return 'done'
}

/** run 内节点状态映射（skipped 视为已结算完成）。 */
export function executionRunNodeStatus(node: Pick<WorkflowNodeState, 'status'>): ExecutionNodeStatus {
  if (node.status === 'running') return 'working'
  if (node.status === 'failed') return 'error'
  if (node.status === 'pending') return 'pending'
  return 'done'
}

/**
 * run 卡有效状态：与执行树同源合成——自身 run 终态 + 子树聚合（无子树数据
 * 时即自身终态）。后台 / 深层子任务未结算（working / blocked / error /
 * pending）时主徽章不假完成。
 */
export function effectiveRunNodeStatus(
  run: Pick<WorkflowRunSummary, 'status'>,
  subtree: ExecutionAggregate | undefined,
): ExecutionNodeStatus {
  if (subtree === undefined || subtree.total === 0) return executionRunStatus(run)
  return aggregateExecutionStatuses([executionRunStatus(run), subtree.status])
}

/** 紧凑卡父工具状态推导（Active-First 排序与卡片徽章共用）。 */
export function executionToolStatus(
  summary: ConversationSummary | undefined,
  run: WorkflowRunSummary | undefined,
): 'running' | 'done' | 'error' {
  if (summary?.status === 'working' || summary?.status === 'blocked') return 'running'
  if (summary?.status === 'error') return 'error'
  if (summary !== undefined) return 'done'
  const runStatus = run?.status
  if (runStatus === 'running') return 'running'
  if (runStatus === 'failed' || runStatus === 'aborted') return 'error'
  return 'done'
}

/** 节点展示标题：用户标题 > run 节点 label / prompt > 会话与 run 兜底描述（不虚构）。 */
export function executionNodeTitle(node: ExecutionNode): string {
  const label = node.label ?? node.runNode?.label
  if (node.kind === 'conversation') {
    const custom = compactCardTitle(node.summary?.title, node.conversationId ?? 0)
    if (custom !== undefined) return custom
    if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') return firstLineOf(label, 60)
    const prompt = node.runNode?.prompt
    if (prompt !== undefined && prompt.trim() !== '') return firstLineOf(prompt, 60)
    return `子会话 #${node.conversationId}`
  }
  if (label !== undefined && label.trim() !== '') return firstLineOf(label, 60)
  return node.run?.name ?? '外部执行'
}

/** 前线活动条目：子树内正在执行节点的单行摘要。 */
export interface ExecutionFrontlineItem {
  key: string
  conversationId?: number
  text: string
}

function executionFrontlineText(node: ExecutionNode, hasDeeper: boolean): string | undefined {
  if (node.status !== 'working') return undefined
  if (node.kind === 'conversation') {
    const doing = node.summary?.doing?.trim()
    if (doing !== undefined && doing !== '') return `#${node.conversationId} ${doing}`
    // 无自身 doing 且子树已有更深前线：不再以兑底文案重复占位（父级等待状态不抢占）
    return hasDeeper ? undefined : `#${node.conversationId} 执行中`
  }
  // 容器（workflow / external run）的自身执行即其子节点：子树已有更深前线时跳过
  return hasDeeper ? undefined : `${node.runNode?.label ?? node.label ?? node.run?.name ?? node.key} 执行中`
}

/**
 * 前线活动摘要：后序深度优先（最深活跃前线优先），至多 limit 条；同一节点
 * key 只收集一次（多历史引用不重复）。自身实际工作（doing）保留在更深前线之后。
 */
export function collectExecutionFrontline(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 2,
): ExecutionFrontlineItem[] {
  const items: ExecutionFrontlineItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      const before = items.length
      visit(node.children)
      if (items.length >= limit) return
      if (seen.has(node.key)) continue
      const text = executionFrontlineText(node, items.length > before)
      if (text !== undefined) {
        seen.add(node.key)
        items.push({
          key: node.key,
          text,
          ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
        })
      }
    }
  }
  visit(nodes)
  return items
}

/** 后代审批条目（pendingAsk 标题不在会话列表数据中，仅以会话标识如实呈现）。 */
export interface ExecutionApprovalItem {
  key: string
  conversationId?: number
  text: string
}

/**
 * 后代审批摘要：子树内 blocked 会话节点（pendingAskCount>0 或 status=blocked，
 * 均在构树叶状态中归一为 blocked），至多 limit 条；同一节点 key 不重复。
 */
export function collectExecutionApprovals(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 3,
): ExecutionApprovalItem[] {
  const items: ExecutionApprovalItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      if (
        node.status === 'blocked' && node.kind === 'conversation' && node.conversationId !== undefined &&
        !seen.has(node.key)
      ) {
        seen.add(node.key)
        const title = compactCardTitle(node.summary?.title, node.conversationId)
        items.push({
          key: node.key,
          conversationId: node.conversationId,
          text: title !== undefined ? `#${node.conversationId} ${title}` : `#${node.conversationId} 等待审批`,
        })
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return items
}

/** 合并一组节点的聚合（用于卡片头部统计直接子树，不含任何“自身”）。 */
export function aggregateExecutionNodes(nodes: ReadonlyArray<ExecutionNode>): ExecutionAggregate {
  let total = 0
  let done = 0
  let running = 0
  let blocked = 0
  let error = 0
  const statuses: ExecutionNodeStatus[] = []
  for (const node of nodes) {
    const agg = node.aggregated
    total += agg.total
    done += agg.done
    running += agg.running
    blocked += agg.blocked
    error += agg.error
    statuses.push(agg.status)
  }
  return { status: aggregateExecutionStatuses(statuses), total, done, running, blocked, error }
}

/**
 * 子节点均已聚合的前提下计算自身聚合（含自身，后序遍历）。
 *
 * - 容器（workflow / external run 壳）有子节点时不计自身任务：一次真实执行
 *   只计一次，wrapper 不算独立完成任务；无子节点的空 run 仍计 1（run 本身
 *   即一次真实执行）；
 * - 状态经 aggregateExecutionStatuses 合成自身与后代：后代 active / error /
 *   blocked 未结算时（含后台子任务 running、phase 节点 pending）绝不判成
 *   整体完成。
 */
function finalizeExecutionNode(node: Omit<ExecutionNode, 'aggregated'>): ExecutionNode {
  const selfCounts = !(node.children.length > 0 && (node.kind === 'workflow' || node.kind === 'external'))
  let done = 0
  let running = 0
  let blocked = 0
  let error = 0
  if (selfCounts) {
    if (node.status === 'done') done = 1
    else if (node.status === 'working') running = 1
    else if (node.status === 'blocked') blocked = 1
    else if (node.status === 'error') error = 1
  }
  let total = selfCounts ? 1 : 0
  const statuses: ExecutionNodeStatus[] = [node.status]
  for (const child of node.children) {
    const agg = child.aggregated
    total += agg.total
    done += agg.done
    running += agg.running
    blocked += agg.blocked
    error += agg.error
    statuses.push(agg.status)
  }
  return { ...node, aggregated: { status: aggregateExecutionStatuses(statuses), total, done, running, blocked, error } }
}

/** 工作台排序：blocked > working > error > done/pending（Active-First），同级 updatedAt 降序。 */
const EXECUTION_SORT_ORDER: Record<ExecutionNodeStatus, number> = {
  blocked: 0,
  working: 1,
  error: 2,
  done: 3,
  pending: 3,
}

function sortExecutionSiblings(nodes: ExecutionNode[]): ExecutionNode[] {
  return nodes.sort((a, b) => {
    const rank = EXECUTION_SORT_ORDER[a.aggregated.status] - EXECUTION_SORT_ORDER[b.aggregated.status]
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt
  })
}

/** 构建执行树入参。 */
export interface BuildExecutionTreeInput {
  rootConversationId: number
  /** 全量会话摘要（useConversations）；任意深度经 parentConversationId 递归。 */
  conversations: ReadonlyArray<ConversationSummary>
  /** 根会话的祖先聚合 runs 投影（usePluginSessionDoc('runs')，含全部后代，
   * 各 run 保留原始 conversationId）；深层会话无 run 数据时仅以会话链递归，不虚构。 */
  runs?: ReadonlyArray<WorkflowRunSummary>
}

/** run 内无会话节点 / 会话在祖先链上的兜底叶子。 */
function executionRunLeafNode(run: WorkflowRunSummary, node: WorkflowNodeState): Omit<ExecutionNode, 'aggregated'> {
  return {
    key: `node:${run.id}:${node.id}`,
    kind: 'workflow-node',
    run,
    runNode: node,
    label: node.label,
    status: executionRunNodeStatus(node),
    updatedAt: run.updatedAt,
    children: [],
  }
}

/** DSL 引用归属：running 的 run 优先（续接后新 run 接管仍在跑的引用），
 * 其次 createdAt 最新，最后 id 稳定排序（与分片顺序无关）。 */
function isStrongerDslConvOwner(candidate: WorkflowRunSummary, current: WorkflowRunSummary): boolean {
  const candidateRunning = candidate.status === 'running'
  const currentRunning = current.status === 'running'
  if (candidateRunning !== currentRunning) return candidateRunning
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  return candidate.id > current.id
}

/**
 * 构建统一执行树：rootConversationId 的下一级执行节点（任意深度递归）。
 *
 * - 入参 runs 为「本会话 + 全部后代」的整棵投影（各 run 保留原始
 *   conversationId，由后端聚合分片提供）；同一 run id 重复到达时去重，
 *   不缺 run 丢树也不重复挂载；
 * - 会话子节点按 parentConversationId 递归；被 DSL run 认领的会话挂到 run
 *   节点下，不重复出现；同一会话被多个历史/续接 DSL run 引用时仅挂载一次
 *   （归属者见 isStrongerDslConvOwner），其余 run 的引用保留普通叶子行可
 *   显示但不双计；
 * - 后台单子代理 run 认领的直接子会话保持会话节点并携带 run；会话列表
 *   缺失时仅携带 run，不虚构 summary；
 * - 无任何会话关联的后台 run 为外部执行节点（run 内节点为叶子）；
 * - parentConversationId 链成环时按祖先链防御性截断。
 */
export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  const convById = new Map<number, ConversationSummary>()
  for (const conversation of conversations) convById.set(conversation.id, conversation)

  // 聚合分片可能重复携带同一 run（重叠投影/增量事件）：按 id 去重。
  const uniqueRuns: WorkflowRunSummary[] = []
  const seenRunIds = new Set<string>()
  for (const run of runs) {
    if (seenRunIds.has(run.id)) continue
    seenRunIds.add(run.id)
    uniqueRuns.push(run)
  }

  const runsByParent = new Map<number, WorkflowRunSummary[]>()
  const dslClaimedByParent = new Map<number, Set<number>>()
  const subagentClaimsByParent = new Map<number, Map<number, WorkflowRunSummary[]>>()
  const dslConvOwner = new Map<number, WorkflowRunSummary>()
  for (const run of uniqueRuns) {
    const siblings = runsByParent.get(run.conversationId)
    if (siblings !== undefined) siblings.push(run)
    else runsByParent.set(run.conversationId, [run])
    if (run.kind === 'subagent') {
      let claims = subagentClaimsByParent.get(run.conversationId)
      if (claims === undefined) {
        claims = new Map()
        subagentClaimsByParent.set(run.conversationId, claims)
      }
      for (const node of run.nodes ?? []) {
        if (node.conversationId === undefined) continue
        const list = claims.get(node.conversationId)
        if (list !== undefined) list.push(run)
        else claims.set(node.conversationId, [run])
      }
    } else {
      let claimed = dslClaimedByParent.get(run.conversationId)
      if (claimed === undefined) {
        claimed = new Set()
        dslClaimedByParent.set(run.conversationId, claimed)
      }
      for (const node of run.nodes ?? []) {
        if (node.conversationId === undefined) continue
        claimed.add(node.conversationId)
        const owner = dslConvOwner.get(node.conversationId)
        if (owner === undefined || isStrongerDslConvOwner(run, owner)) {
          dslConvOwner.set(node.conversationId, run)
        }
      }
    }
  }

  const childrenOf = (conversationId: number, ancestry: ReadonlySet<number>): ExecutionNode[] => {
    const nodes: ExecutionNode[] = []
    const dslClaimed = dslClaimedByParent.get(conversationId)
    const claims = subagentClaimsByParent.get(conversationId)

    // 1) 会话直接子节点：被 DSL run 认领的会话挂到 run 节点下，不在此重复出现。
    const directIds = new Set<number>()
    for (const conversation of conversations) {
      if (conversation.parentConversationId !== conversationId) continue
      directIds.add(conversation.id)
      if (dslClaimed?.has(conversation.id) === true) continue
      if (ancestry.has(conversation.id)) continue
      const backgroundRun = claims?.get(conversation.id) !== undefined
        ? pickBackgroundRun(claims.get(conversation.id) ?? [], conversation.parentToolCallId)
        : undefined
      nodes.push(
        finalizeExecutionNode({
          key: `conv:${conversation.id}`,
          kind: 'conversation',
          conversationId: conversation.id,
          summary: conversation,
          ...(backgroundRun !== undefined ? { run: backgroundRun } : {}),
          status: executionConversationStatus(conversation, backgroundRun),
          updatedAt: Math.max(conversation.updatedAt, backgroundRun?.updatedAt ?? 0),
          children: childrenOf(conversation.id, new Set(ancestry).add(conversation.id)),
        }),
      )
    }

    // 2) 仅后台 run 可见的会话（会话列表缺失摘要）：如实携带 run，不虚构 summary。
    if (claims !== undefined) {
      for (const [claimedId, claimedRuns] of claims) {
        if (directIds.has(claimedId) || dslClaimed?.has(claimedId) === true) continue
        if (ancestry.has(claimedId)) continue
        const run = pickBackgroundRun(claimedRuns, undefined)
        nodes.push(
          finalizeExecutionNode({
            key: `conv:${claimedId}`,
            kind: 'conversation',
            conversationId: claimedId,
            ...(run !== undefined ? { run } : {}),
            status: executionConversationStatus(undefined, run),
            updatedAt: run?.updatedAt ?? 0,
            children: childrenOf(claimedId, new Set(ancestry).add(claimedId)),
          }),
        )
      }
    }

    // 3) 本会话发起的 run：DSL 工作流挂节点子树；无会话关联的后台 run 为外部执行。
    for (const run of runsByParent.get(conversationId) ?? []) {
      const runNodes = run.nodes ?? []
      if (run.kind === 'subagent') {
        if (runNodes.some((n) => n.conversationId !== undefined)) continue // 会话关联 run 已在 1/2 挂载
        nodes.push(
          finalizeExecutionNode({
            key: `run:${run.id}`,
            kind: 'external',
            run,
            label: run.name,
            status: executionRunStatus(run),
            updatedAt: run.updatedAt,
            children: runNodes.map((node) => finalizeExecutionNode(executionRunLeafNode(run, node))),
          }),
        )
        continue
      }
      // 同一 run 内重复引用同一会话时也只挂载一次（后续引用保持叶子行）。
      const mountedConvIds = new Set<number>()
      nodes.push(
        finalizeExecutionNode({
          key: `run:${run.id}`,
          kind: 'workflow',
          run,
          label: run.name,
          status: executionRunStatus(run),
          updatedAt: run.updatedAt,
          children: runNodes.map((node) => {
            const convId = node.conversationId
            if (
              convId === undefined || ancestry.has(convId) ||
              dslConvOwner.get(convId) !== run || mountedConvIds.has(convId)
            ) {
              return finalizeExecutionNode(executionRunLeafNode(run, node))
            }
            mountedConvIds.add(convId)
            const summary = convById.get(convId)
            const runNodeToolStatus: 'running' | 'done' | 'error' | 'unknown' =
              node.status === 'running'
                ? 'running'
                : node.status === 'failed'
                  ? 'error'
                  : node.status === 'done'
                    ? 'done'
                    : 'unknown'
            return finalizeExecutionNode({
              key: `conv:${convId}`,
              kind: 'conversation',
              conversationId: convId,
              summary,
              run,
              runNode: node,
              label: node.label,
              status: executionConversationStatus(summary, undefined, runNodeToolStatus),
              updatedAt: Math.max(summary?.updatedAt ?? 0, run.updatedAt),
              children: childrenOf(convId, new Set(ancestry).add(convId)),
            })
          }),
        }),
      )
    }
    return sortExecutionSiblings(nodes)
  }

  return childrenOf(rootConversationId, new Set([rootConversationId]))
}

// ---------------------------------------------------------------------------
// siblingCalls 辅助（多次 resume 折叠判定）
// ---------------------------------------------------------------------------

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
