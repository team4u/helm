/**
 * builtin:workflow 插件 client 纯逻辑：SubagentWorkflow 工具调用 ↔ run 精确关联、
 * 工作流运行卡阶段分组 / log 路标 / 节点摘要 / 操作可用判定与节点统计
 * （原 workflow-card-model.ts；零 React/DOM 依赖）。
 */
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf, formatShortModelName, inputString, inspectString } from './model-format.ts'

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

/** 判定 SubagentWorkflow 工具返回文本是否为后台启动句柄（非最终结算结果）。 */
export function isBackgroundWorkflowResultHandle(result: unknown): boolean {
  if (typeof result !== 'string') return false
  const trimmed = result.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    return record['background'] === true
  } catch {
    return false
  }
}

/** 无关联 run 记录时从工具入参提取可读标题，避免裸露空白。 */
export function resolveWorkflowToolFallbackLabel(input: unknown): string {
  const name = inputString(input, 'name')
  if (name !== undefined) return firstLineOf(name, 60)
  const scriptPath = inputString(input, 'scriptPath')
  if (scriptPath !== undefined) return firstLineOf(scriptPath, 60)
  const resumeFromRunId = inputString(input, 'resumeFromRunId')
  if (resumeFromRunId !== undefined) return `恢复 ${resumeFromRunId}`
  const script = inputString(input, 'script')
  if (script !== undefined) {
    const metaName = /name\s*:\s*["']([^"']+)["']/.exec(script)?.[1]
    if (metaName !== undefined && metaName !== '') return metaName
    return firstLineOf(script, 60)
  }
  return 'SubagentWorkflow'
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

/** 断点恢复可用判定：仅 DSL 编排工作流失败或中止、且尚未被新续跑接管时可用。 */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  return (
    run.kind !== 'subagent' &&
    (run.status === 'failed' || run.status === 'aborted') &&
    run.resumedByRunId === undefined
  )
}

function hasRunExecutionHandle(run: WorkflowRunSummary): boolean {
  return (run.nodes ?? []).some(
    (node) =>
      (node.conversationId !== undefined && Number.isSafeInteger(node.conversationId) && node.conversationId > 0) ||
      (typeof node.executionId === 'string' && node.executionId.trim() !== ''),
  )
}

/** 后台子代理单卡恢复可用判定：subagent 失败或中止、未被接管且具备可续接执行句柄。 */
export function canResumeSubagentRun(
  run: WorkflowRunSummary | undefined,
  hasExecutionHandle: boolean,
): boolean {
  if (run === undefined) return false
  if (run.kind !== 'subagent') return false
  if (run.status !== 'failed' && run.status !== 'aborted') return false
  if (run.resumedByRunId !== undefined) return false
  return hasExecutionHandle || hasRunExecutionHandle(run)
}

function isNonResumableRunError(error: string | undefined): boolean {
  if (error === undefined) return false
  const normalized = error.toLowerCase()
  return (
    normalized.includes('workflow_action_uncertain') ||
    normalized.includes('[crash_recovery_limit]') ||
    normalized.includes('crash_recovery_limit') ||
    normalized.includes('secret_grant_expired_on_restart') ||
    normalized.includes('[validation_error]') ||
    normalized.includes('validation_error') ||
    normalized.includes('workflow script has a syntax error')
  )
}

/**
 * 筛选当前会话下可自动批量恢复的失败记录（排除已被接管、不可自动恢复错误
 * 及无续接句柄的后台单子代理）。
 */
export function listResumableFailedRuns(
  runs: ReadonlyArray<WorkflowRunSummary>,
  conversationId: number,
): WorkflowRunSummary[] {
  const seenIds = new Set<string>()
  const result: WorkflowRunSummary[] = []
  for (const run of runs) {
    if (seenIds.has(run.id)) continue
    seenIds.add(run.id)
    if (run.conversationId !== conversationId) continue
    if (run.status !== 'failed') continue
    if (run.resumedByRunId !== undefined) continue
    if (isNonResumableRunError(run.error)) continue
    if (run.kind === 'subagent' && !hasRunExecutionHandle(run)) continue
    result.push(run)
  }
  return result
}

export interface ResumeFailedSummaryView {
  resumedCount: number
  skippedCount: number
}

/** 严格解析 resume_failed 动作结果（非法形状返回 undefined，绝不猜计数）。 */
export function parseResumeFailedResult(raw: unknown): ResumeFailedSummaryView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const resumed = record['resumed']
  const skipped = record['skipped']
  if (!Array.isArray(resumed) || !Array.isArray(skipped)) return undefined
  for (const item of resumed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (inspectString(item as Record<string, unknown>, 'id') === undefined) return undefined
  }
  for (const item of skipped) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const entry = item as Record<string, unknown>
    if (inspectString(entry, 'runId') === undefined || typeof entry['reason'] !== 'string') return undefined
  }
  return { resumedCount: resumed.length, skippedCount: skipped.length }
}

/**
 * 「转入后台」查看方判定：当前查看会话（时间线即发起会话；工作台为面板会话）
 * 及其归属。ownedBy 缺省按 human（内核缺省值）；bot/helm（automation 会话）
 * 的前台同步 run 不显示按钮——服务端对 automation 归属一律拒绝（防早结算），
 * 前端如实隐藏，不展示注定失败的入口。
 */
export interface DetachViewerScope {
  conversationId?: number
  ownedBy?: string
}

/**
 * 前台同步 run「转入后台」可用判定：仅明确 runId 的运行中前台同步 run
 *（syncForeground 标记且尚未 detached），且当前查看会话即发起会话、归属
 * human（或缺省 human）；跨会话/工作台他处不显示，服务端仍会复核授权。
 */
export function canDetachForegroundRun(run: WorkflowRunSummary, viewer: DetachViewerScope | undefined): boolean {
  return (
    run.status === 'running' &&
    run.syncForeground === true &&
    run.detachedAt === undefined &&
    viewer?.conversationId === run.conversationId &&
    viewer.ownedBy !== 'bot' &&
    viewer.ownedBy !== 'helm'
  )
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

// ---------------------------------------------------------------------------
// 总耗时解析（仅以真实记录的边界计时，不伪造 0ms / 虚构值）
// ---------------------------------------------------------------------------

/**
 * run 总耗时：running 且客户端时钟有效（nowMs >= createdAt）时随 nowMs 动态
 * 推进；其余（含 SSR 首帧无时钟）用 updatedAt - createdAt 定格到最近快照，
 * 两者都是真实边界；非法时间差返回 undefined（调用方如实省略）。
 */
export function resolveRunElapsedMs(
  run: Pick<WorkflowRunSummary, 'status' | 'createdAt' | 'updatedAt'>,
  nowMs?: number,
): number | undefined {
  if (
    run.status === 'running' &&
    nowMs !== undefined && Number.isFinite(nowMs) &&
    Number.isFinite(run.createdAt) && nowMs >= run.createdAt
  ) {
    return nowMs - run.createdAt
  }
  const settled = run.updatedAt - run.createdAt
  return Number.isFinite(settled) && settled >= 0 ? settled : undefined
}

/**
 * run 内节点耗时：running 用 startedAt + nowMs 动态推进（无时钟或无起点
 * 如实省略，保证 SSR 确定性）；已结算用持久化 durationMs 定格；无真实边界
 * （既无 startedAt 也无 durationMs）省略，绝不显示虚构的 0ms。
 */
export function resolveNodeElapsedMs(
  node: Pick<WorkflowNodeState, 'status' | 'startedAt' | 'durationMs'>,
  nowMs?: number,
): number | undefined {
  if (node.status === 'running') {
    return node.startedAt !== undefined && Number.isFinite(node.startedAt) &&
      nowMs !== undefined && Number.isFinite(nowMs) && nowMs >= node.startedAt
      ? nowMs - node.startedAt
      : undefined
  }
  return node.durationMs !== undefined && Number.isFinite(node.durationMs) && node.durationMs >= 0
    ? node.durationMs
    : undefined
}
