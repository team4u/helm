import type { AskSpec, ConversationEntry, ConversationLive, ConversationSummary, WorkflowRunSummary } from '@helm/protocol'
import { buildSubagentStreamLines } from './subagent-model.js'
import { formatDurationMs } from '../lib/format.js'
import { toolSummaryText, type ToolTraceStatus } from './timeline-model.js'

/** 子会话卡片状态：优先真实 summary.status，无 summary 再退回父工具 toolStatus。 */
export type SubagentCardStatus = 'working' | 'blocked' | 'error' | 'done' | 'pending'

export interface SubagentBadge {
  status: SubagentCardStatus
  label: string
  badge: string
}

/** 父工具轻量摘要：时间线内嵌卡片据此折叠态也能展示任务标题、耗时与结论。 */
export interface SubagentParentToolSummary {
  /** 父工具入参中的任务描述或指令摘要。 */
  prompt?: string
  /** 本次父工具调用的已记录起始时间；未知时不推算会话运行时长。 */
  startedAt?: number
  /** 父工具执行耗时（毫秒）。 */
  durationMs?: number
  /** 父工具原始输出文本（JSON 信封或含 [subagent ...] 尾注文本）。 */
  resultText?: string
  /** 父工具是否处于错误态。 */
  isError?: boolean
}

/** SubagentLiveCard 属性（纯类型放 .ts 模块，.tsx 组件文件只导出组件以保 Fast Refresh）。 */
export interface SubagentLiveCardProps {
  childConversationId: number
  toolStatus: ToolTraceStatus
  /** background: true 派生的后台工作流 run：工具行返回句柄后，真实执行态以 run 为准。 */
  backgroundRun?: WorkflowRunSummary
  /** 关联的隔离工作树；缺省时卡片回退 backgroundRun 节点上的 worktree。 */
  worktree?: { path: string; branch: string }
  /** 是否为缓存/历史重放任务。 */
  cached?: boolean
  /** 初始是否展开实时流（默认 false 折叠态零请求；工作流节点展开体内嵌时传 true）。 */
  defaultExpanded?: boolean
  /** 父工具轻量摘要：折叠态头部任务标题 / 统计尾注 / 结论预览的数据源。 */
  toolSummary?: SubagentParentToolSummary
  /** 额外统计尾注（例如工作流节点模型与 token 统计）。 */
  extraStats?: string
  /** 工作流节点指定耗时（毫秒）。 */
  durationMs?: number
  /** 时间线原始调用，供卡片内按需查看本次入参和结果。 */
  toolCall?: import('./timeline-model.js').ToolTrace
  /** 工作流节点已记录的起始时间。 */
  startedAt?: number
  /** 点击“进入会话 / 并排查看”后的附加回调（例如工作台窄屏抽屉自动收起）。 */
  onNavigate?: () => void
}

/**
 * 卡片徽章状态：实时跟随子会话自身最新状态（summary.status），
 * 无 summary 时才以父工具 toolStatus 兜底；background: true 的 subagent
 * 工具行会立即返回句柄（toolStatus=done、子会话暂 idle），此后台 run
 * 的状态必须参与判定——run 仍在 running 时绝不提前显示“已完成”；
 * run failed/aborted 不得被子会话旧 idle 覆盖，blocked 按真实审批优先。
 */
export function subagentBadge(
  summaryStatus: string | undefined,
  toolStatus: ToolTraceStatus,
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
  // 关键：后台 run 仍在 running（如 gate 验收命令执行期、后台子会话刚启动）
  // 而子会话 summary 尚为 idle/done/undefined 时，绝不假完成。
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
    // 子会话已 idle/done 但父工具行仍 running（前台 gate 验收 / 结构化输出
    // 修复期）：同一契约不假完成；仅父工具自身终态才显示完成/失败。
    if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
    if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
    return { status: 'done', label: '已完成', badge: 'badge-ok' }
  }
  // 无 summary（尚未出现在会话列表）：退回父工具状态。
  if (toolStatus === 'running') return { status: 'working', label: '执行中', badge: 'badge-accent' }
  if (toolStatus === 'error') return { status: 'error', label: '异常', badge: 'badge-err' }
  if (toolStatus === 'done') return { status: 'done', label: '已完成', badge: 'badge-ok' }
  return { status: 'pending', label: '进行中', badge: 'badge-neutral' }
}

/** 工具 resultPreview 由 buildSubagentStreamLines 截到首行 100 字符；带省略号即视为被截断。 */
export function toolResultPreviewTruncated(preview: string): boolean {
  return preview.endsWith('…')
}

/**
 * 卡片头部紧凑标题：仅当 summary.title 是有意义的用户标题（非默认生成形态
 * 「子代理 N」/「子会话 N」）时返回，否则 undefined（头部只显示编号）。
 */
export function compactCardTitle(title: string | undefined, childConversationId: number): string | undefined {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') return undefined
  if (trimmed === `子代理 ${childConversationId}` || trimmed === `子会话 ${childConversationId}`) return undefined
  return trimmed
}

/** 滚动贴底判定：距底部不超过容差即视为贴底（供测试与组件共用同一语义）。 */
export const STICK_BOTTOM_TOLERANCE_PX = 36

export function isScrolledToBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_TOLERANCE_PX
}

// ---------------------------------------------------------------------------
// 双层自适应胶囊卡：标题 / 统计尾注 / 第 2 层动态副栏（纯函数层）
// ---------------------------------------------------------------------------

/** 首行截断（trim 后超长加省略号）。 */
function firstLineOf(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

/** spawn 注入的结构化输出契约样板：头部标题与完成结论预览均需剥离。 */
const STRUCTURED_OUTPUT_CONTRACT_RE = /<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g

function stripStructuredOutputContract(text: string): string {
  return text.replace(STRUCTURED_OUTPUT_CONTRACT_RE, '')
}

/** 文本最后一个非空行（去掉 # / - 引导前缀），供流式思考 / 正文尾部提炼。 */
function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    return line.replace(/^[#-]+\s+/, '')
  }
  return undefined
}

/** [subagent ...] 尾注行（内核 footer 元数据），提炼结论时剥离。 */
const SUBAGENT_FOOTER_TAIL_RE = /\n*\[subagent [^\]]*\]\s*$/

/** 剥离 [subagent ...] 尾注后的首行。 */
function stripSubagentFooter(text: string): string {
  return text.replace(SUBAGENT_FOOTER_TAIL_RE, '')
}

/**
 * 卡片头部任务标题：优先用户自定义标题，其次父工具 prompt 摘要，
 * 最后后台 run 首节点 label / prompt（忽略与默认名 'subagent' 相同的占位）。
 */
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

/** 模型短名：剥离 provider/ 前缀（'openai/glm-5' -> 'glm-5'），空串返回 undefined。 */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

/** 统计 entries 已落库 toolCall 总次数，加上 live.tools 中尚未落库的新 callId。 */
function countToolSteps(entries: ReadonlyArray<ConversationEntry> | undefined, live: ConversationLive | undefined): number | undefined {
  if (entries === undefined) {
    return live !== undefined && live.tools.length > 0 ? live.tools.length : undefined
  }
  let count = 0
  const seenCallIds = new Set<string>()
  for (const line of buildSubagentStreamLines(entries)) {
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

function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/** 头部极简统计尾注片段（`·` 分隔，无值跳过不留占位）。 */
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

/** 仅以本次调用或 run 的记录计时；未知边界时省略，禁止使用会话存续时长。 */
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

/** 第 2 层动态副栏：折叠态单行展示当前动作 / 思考 / 结论 / 错误。 */
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

/** 工具入参字段提取（字符串且非空）。 */
function inputString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** 活跃工具语义化动作提炼：把工具名 + 入参压缩为一行「人在做什么」。 */
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

/** 从父工具 resultText 提取完成结论预览：JSON 信封（result/output/summary）或剥离尾注后的首行。 */
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
      // 非合法 JSON：退回普通文本处理
    }
  }
  const stripped = stripSubagentFooter(trimmed)
  if (stripped.trim() === '') return undefined
  return firstLineOf(stripped, 100)
}

/** 从父工具 resultText 提取错误文本：JSON { ok:false, error } 或 isError 时剥离尾注后的首行。 */
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

/** 后台 run 失败时的错误文本：run.error 或首个失败节点 error / gate 输出。 */
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

/** 后台 run 产出的单行预览（节点 output 或 run.result）。 */
function backgroundRunResultPreview(backgroundRun: WorkflowRunSummary | undefined): string | undefined {
  if (backgroundRun === undefined) return undefined
  const nodeOutput = backgroundRun.nodes?.[0]?.output
  const preview = extractSubagentResultPreview(
    typeof nodeOutput === 'string' ? nodeOutput : nodeOutput !== undefined ? JSON.stringify(nodeOutput) : backgroundRun.result !== undefined ? (typeof backgroundRun.result === 'string' ? backgroundRun.result : JSON.stringify(backgroundRun.result)) : undefined,
  )
  return preview
}

/**
 * 第 2 层动态副栏推导：按 badgeStatus 分流（加载失败 > 等待审批 > 异常 >
 * 执行中 > 已完成）；无有效文本时返回 undefined（不渲染副栏）。
 * entries 未加载（默认折叠态零请求）时从 toolSummary / backgroundRun 提取，绝不发请求。
 */
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
  // 1) 详情加载失败：显式报错，绝不静默停在加载中。
  if (input.detailError !== undefined) {
    return { kind: 'error', tag: '加载失败', text: firstLineOf(input.detailError, 100) }
  }
  // 2) 等待审批：pendingAsk 标题优先。
  if (input.badgeStatus === 'blocked') {
    const text = input.pendingAsk?.title || input.pendingAsk?.description || input.summary?.doing || '等待人工确认'
    return { kind: 'blocked', tag: '等待审批', text: firstLineOf(text, 100) }
  }
  // 3) 异常：后台 run 失败 > 父工具错误 > 子会话最后报错 > 兜底。
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
  // 4) 执行中：活跃工具语义化 > 流式思考 > 流式正文 > 后台 Gate 验收 > 兜底。
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
    // 正文出现后，保留的 thinking 快照已是前一阶段，不能盖住当前生成内容。
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
  // 后台父工具仅返回启动句柄；完成结论必须读 run 产出，不能把启动 JSON 当作结果。
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
