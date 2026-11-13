/**
 * builtin:workflow 插件 client 纯逻辑：subagent 运行期关联（工具调用 ↔ 子会话 /
 * 后台 run / 工作树 / 外部执行）、卡片状态徽章与头部摘要、子会话实时流展开、
 * siblingCalls 多次 resume 折叠判定（原 subagent-model.ts / subagent-live-model.ts；
 * 零 React/DOM 依赖）。
 */
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ToolViewProps,
  WorkflowRunSummary,
} from '@helm/protocol'
import { formatDurationMs } from '@helm/plugin-client'
import { firstLineOf, inputString } from './model-format.ts'

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
