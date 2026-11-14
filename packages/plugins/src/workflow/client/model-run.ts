/**
 * builtin:workflow 插件 client 纯逻辑：SubagentWorkflow 工具调用 ↔ run 精确关联、
 * 工作流运行卡阶段分组 / log 路标 / 节点摘要 / 操作可用判定与节点统计
 * （原 workflow-card-model.ts；零 React/DOM 依赖）。
 */
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { formatShortModelName } from './model-subagent.ts'

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
