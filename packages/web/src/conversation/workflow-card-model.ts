/**
 * WorkflowRunCard 纯逻辑层（零 React/DOM 依赖，供单测直测）：
 * - 节点产出预览 / 主信息摘要：修复旧实现 durationMs 吞掉 error 的 Bug；
 * - 阶段分组：合并 meta.phases 声明、progress phase 路标与节点 phaseTitle，
 *   不过滤任何节点（action / cached / 外部 execution / pending 全保留）；
 * - 断点恢复判定与独立子会话过滤（工作台去重）。
 */
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'

/** 节点收起行主信息摘要：text 缺省表示无可展示内容。 */
export interface NodeSummaryText {
  text?: string
  isError: boolean
}

/** 按阶段分组的节点视图模型（title 为空串表示无阶段命名的默认分组）。 */
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

/** 脚本 log() 路标行。 */
export interface WorkflowLogLine {
  key: string
  at: number
  message: string
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return '…'
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/**
 * 节点产出紧凑单行预览：
 * - undefined / null / 空串 -> undefined；
 * - 字符串取首行 trim（超长截断加省略号）；
 * - 对象/数组/其他 JSON.stringify（同样截断），stringify 失败回退 String()。
 */
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

/**
 * 节点收起行主信息摘要（耗时在右侧单独渲染，不与本字段抢占）：
 * - running：优先子会话实时 doing，其次 phaseTitle；
 * - failed：优先 error 首行（100 字符），其次 gate 失败输出；
 * - skipped：error 或「已跳过」；
 * - done：产出预览（不再显示耗时占位）；
 * - pending：排队提示。
 */
export function resolveNodeSummaryText(node: WorkflowNodeState, childDoing?: string): NodeSummaryText {
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

function sectionStatus(
  nodes: WorkflowNodeState[],
  doneCount: number,
  totalCount: number,
  runStatus: WorkflowRunSummary['status'],
): WorkflowPhaseSection['status'] {
  if (nodes.some((n) => n.status === 'running')) return 'running'
  if (nodes.length === 0 || nodes.every((n) => n.status === 'pending')) return 'pending'
  if (nodes.some((n) => n.status === 'failed')) return 'failed'
  if (totalCount > 0 && doneCount === totalCount) return 'done'
  return runStatus === 'running' ? 'running' : 'done'
}

const DEFAULT_SECTION_TITLE = '默认阶段'

/**
 * 构建按阶段分组的节点视图：阶段顺序优先 run.phases 蓝图声明，
 * 其次 progress phase 路标，最后节点 phaseTitle 首次出现顺序；
 * 未匹配命名阶段的节点归入「默认阶段」（排在已声明阶段之后）。
 * 完全无阶段信息时返回单个 title 为空串的默认分组（UI 不画阶段标题栏）。
 */
export function buildWorkflowPhaseSections(run: WorkflowRunSummary): WorkflowPhaseSection[] {
  const nodes = run.nodes ?? []
  const allNodes = [...nodes]

  // 1) 收集声明顺序：run.phases -> progress phase -> 节点 phaseTitle（去重保留首现）。
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
        status: sectionStatus(allNodes, doneCount, allNodes.length, run.status),
        doneCount,
        totalCount: allNodes.length,
      },
    ]
  }

  // 2) 按 trim 后的 phaseTitle 归组；未匹配命名阶段的节点进入默认阶段（置于末尾）。
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
      status: sectionStatus(group, doneCount, group.length, run.status),
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
      status: sectionStatus(defaultNodes, doneCount, defaultNodes.length, run.status),
      nodes: defaultNodes,
      doneCount,
      totalCount: defaultNodes.length,
    })
  }
  return sections
}

/** 提取脚本 log() 路标（progress 中 kind === 'log' 条目）。 */
export function extractWorkflowLogs(run: WorkflowRunSummary): WorkflowLogLine[] {
  return (run.progress ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'log' }> => p.kind === 'log')
    .map((p, idx) => ({ key: `log:${idx}:${p.at}`, at: p.at, message: p.message }))
}

/**
 * 断点恢复可用判定：仅 DSL 编排工作流（kind !== 'subagent'）失败或中止后可
 * 用 resumeFromRunId 从 journal 前缀重放；后台单子代理无编排账本可恢复。
 */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && (run.status === 'failed' || run.status === 'aborted')
}

/**
 * 过滤「未被工作流卡片覆盖」的独立子会话：所有 run（含 workflow 与 subagent
 * 后台单）节点上出现过的 conversationId 视为已被卡片认领，工作台顶部列表
 * 只展示真正独立的子会话，消除与卡片内 SubagentLiveCard 的重复列出。
 */
export function filterStandaloneSubagents(
  conversations: ReadonlyArray<ConversationSummary>,
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): ConversationSummary[] {
  const claimedIds = new Set<number>()
  for (const run of workflowRuns) {
    for (const node of run.nodes ?? []) {
      if (node.conversationId !== undefined) claimedIds.add(node.conversationId)
    }
  }
  return conversations.filter((c) => c.parentConversationId === parentConversationId && !claimedIds.has(c.id))
}
