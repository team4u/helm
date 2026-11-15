/**
 * builtin:workflow 插件 client 纯逻辑：subagent 卡片状态徽章、任务标题、
 * 总耗时与第 2 层动态副栏摘要（原 subagent-live-model.ts；零 React/DOM 依赖）。
 */
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
} from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf } from './model-format.ts'
import type { SubagentParentToolSummary } from './model-subagent-link.ts'
import { buildSubagentStreamLines, formatSemanticToolAction } from './model-subagent-stream.ts'

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

/**
 * 卡片总耗时：仅以真实记录的边界计时——本次父工具调用 startedAt/durationMs、
 * 后台 run createdAt / 首节点 durationMs。自身 working / blocked（在途，含等待
 * 审批）有时钟则随 nowMs 动态推进；其余（含后代仍在跑而自身已结算）定格在
 * 自身持久化 duration，不用会话 createdAt 伪造一次 resume 的总耗时；无本轮
 * 可靠边界时返回 undefined（调用方如实省略）。
 */
export function resolveSubagentElapsedMs(input: {
  backgroundRun?: WorkflowRunSummary
  toolSummary?: SubagentParentToolSummary
  startedAt?: number
  nowMs?: number
  /** 自身有效状态：working / blocked 视为在途动态计时，其余定格。 */
  status?: SubagentCardStatus
}): number | undefined {
  if (input.status === 'working' || input.status === 'blocked') {
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
