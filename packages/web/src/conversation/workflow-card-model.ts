/**
 * WorkflowRunCard 纯逻辑层（零 React/DOM 依赖，供单测直测）：
 * - 节点产出预览 / 主信息摘要：修复旧实现 durationMs 吞掉 error 的 Bug；
 * - 阶段分组：合并 meta.phases 声明、progress phase 路标与节点 phaseTitle，
 *   不过滤任何节点（action / cached / 外部 execution / pending 全保留）；
 * - 断点恢复判定与独立子会话过滤（工作台去重）。
 */
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { formatShortModelName, subagentBadge, type SubagentCardStatus } from './subagent-live-model.js'
import type { ToolTraceStatus } from './timeline-model.js'

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
 * - blocked 子会话：等待审批（pendingAsk 标题优先）；
 * - running：优先子会话实时 doing，其次 phaseTitle；
 * - failed：优先 error 首行（100 字符），其次 gate 失败输出；
 * - skipped：error 或「已跳过」；
 * - done：产出预览（不再显示耗时占位）；
 * - pending：排队提示。
 */
export function resolveNodeSummaryText(
  node: WorkflowNodeState,
  childDoing?: string,
  childStatus?: ConversationSummary['status'],
  pendingAskTitle?: string,
): NodeSummaryText {
  // 等待审批只对 running 节点成立：done/failed 等历史终态节点不随后来
  // child blocked 改写，避免已完成产出的摘要被污染成「等待审批」。
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

// ---------------------------------------------------------------------------
// 工作台子代理统一列表（Active-First）与任务汇总
// ---------------------------------------------------------------------------

/** 工作台子代理条目：独立子会话或单子代理后台 run 认领的子会话（去重后统一形状）。 */
export interface WorkbenchSubagentItem {
  /** 子会话 ID（run 节点确认即列出；会话摘要可能尚未推送）。 */
  conversationId: number
  /** 真实会话摘要（SSE 未推送时缺省，绝不虚构占位对象）。 */
  summary?: ConversationSummary
  /** 认领该子会话的后台单子代理 run（无则独立子会话）。 */
  backgroundRun?: WorkflowRunSummary
}

/** 节点统计尾注：模型短名 + 紧凑 token（模型短名复用 subagent-live-model 同一语义）。 */
export function formatWorkflowNodeStats(node: WorkflowNodeState): string[] {
  const segments: string[] = []
  const model = formatShortModelName(node.model)
  if (model !== undefined) segments.push(model)
  if (node.tokens !== undefined && node.tokens > 0) {
    segments.push(node.tokens >= 1000 ? `${(node.tokens / 1000).toFixed(1)}k` : `${node.tokens}`)
  }
  return segments
}

/** 工作台条目状态优先级：与卡片徽章同源（subagentBadge），blocked (0) > working (1) > error (2) > done/pending (3)。 */
const WORKBENCH_STATUS_RANK: Record<SubagentCardStatus, number> = {
  blocked: 0,
  working: 1,
  error: 2,
  done: 3,
  pending: 3,
}

/**
 * 条目伪 toolStatus（工作台无父工具行）：有真实 summary 时由 summary 推导，
 * 无 summary 时由 backgroundRun 推导，与 subagentBadge 共用同一判定链。
 */
function workbenchItemToolStatus(item: WorkbenchSubagentItem): ToolTraceStatus {
  const status = item.summary?.status
  if (status === 'working' || status === 'blocked') return 'running'
  if (status === 'error') return 'error'
  if (status !== undefined) return 'done'
  const runStatus = item.backgroundRun?.status
  if (runStatus === 'running') return 'running'
  if (runStatus === 'failed' || runStatus === 'aborted') return 'error'
  return 'done'
}

/** 排序优先级复用 subagentBadge 状态，保证工作台列表与卡片徽章口径一致。 */
function workbenchItemRank(item: WorkbenchSubagentItem): number {
  const badge = subagentBadge(item.summary?.status, workbenchItemToolStatus(item), item.backgroundRun?.status)
  return WORKBENCH_STATUS_RANK[badge.status]
}

function itemUpdatedAt(item: WorkbenchSubagentItem): number {
  return Math.max(item.summary?.updatedAt ?? 0, item.backgroundRun?.updatedAt ?? 0)
}

/**
 * 从认领同一子会话的多个后台 run 中选出当前关联者：
 * - 子会话携带真实 parentToolCallId（内核受信注入）时精确匹配 run.parentToolCallId；
 *   无匹配（如 resume 新 run 尚未推送）则不关联，绝不把上一轮失败挂到当前卡；
 * - 无 parentToolCallId 时按 createdAt 最新确定，避免按 updatedAt 把旧 run 推新。
 */
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

/**
 * 工作台子代理统一列表（去重 + Active-First）：
 * - 单子代理后台 run（kind=subagent）节点携带 conversationId 的，与独立子会话合并为同一条目
 *   （不再把有子会话的单子代理后台任务套进三层嵌套的 WorkflowRunCard）；
 * - 同一子会话被多个后台 run 认领时按 pickBackgroundRun 规则关联当前 run；
 * - 无 conversationId 的外部 subagent run（如 Herdr 外部窗格）不在此列表，仍由 WorkflowRunCard 渲染；
 * - 多节点编排工作流（DSL）认领的子会话不进入此列表（由工作流卡片内嵌展示）。
 */
export function buildWorkbenchSubagentItems(
  conversations: ReadonlyArray<ConversationSummary>,
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkbenchSubagentItem[] {
  // 本父会话的单子代理后台 run 按认领的 conversationId 归组；DSL 只认领不进列表。
  const runsByClaimedId = new Map<number, WorkflowRunSummary[]>()
  const claimedByDslRun = new Set<number>()
  for (const r of workflowRuns) {
    if (r.conversationId !== parentConversationId) continue
    const convIds = (r.nodes ?? []).map((n) => n.conversationId).filter((id): id is number => id !== undefined)
    if (r.kind === 'subagent') {
      for (const id of convIds) {
        const list = runsByClaimedId.get(id)
        if (list !== undefined) list.push(r)
        else runsByClaimedId.set(id, [r])
      }
    } else {
      for (const id of convIds) claimedByDslRun.add(id)
    }
  }
  // 独立子会话（未被任何 run 认领）与 run 认领的子会话合并去重。
  const items: WorkbenchSubagentItem[] = []
  const seen = new Set<number>()
  for (const c of conversations) {
    if (c.parentConversationId !== parentConversationId) continue
    seen.add(c.id)
    const backgroundRun = pickBackgroundRun(runsByClaimedId.get(c.id) ?? [], c.parentToolCallId)
    items.push(
      backgroundRun !== undefined
        ? { conversationId: c.id, summary: c, backgroundRun }
        : { conversationId: c.id, summary: c },
    )
  }
  // 后台 run 认领但会话列表尚未出现（SSE 未推）：仅列出 run 确认的 conversationId，
  // 不虚构 summary；关联 run 取 createdAt 最新。
  for (const [id, runs] of runsByClaimedId) {
    if (seen.has(id) || claimedByDslRun.has(id)) continue
    items.push({ conversationId: id, backgroundRun: pickBackgroundRun(runs, undefined) })
  }
  // Active-First：状态优先级升序，同优先级 updatedAt 降序；DSL 认领的子会话由工作流卡内嵌展示。
  return items
    .filter((it) => !claimedByDslRun.has(it.conversationId))
    .sort((a, b) => {
      const rank = workbenchItemRank(a) - workbenchItemRank(b)
      if (rank !== 0) return rank
      return itemUpdatedAt(b) - itemUpdatedAt(a)
    })
}

/** 工作台任务汇总（去重后统一计数）。 */
export interface WorkbenchTaskSummary {
  workflowCount: number
  subagentCount: number
  totalCount: number
  activeCount: number
  blockedCount: number
  errorCount: number
  doneCount: number
}

/**
 * 工作台任务汇总（自行按 parentConversationId 过滤，不依赖调用者预过滤）：
 * workflowCount 只计本父会话 DSL 编排工作流；subagentCount 为
 * buildWorkbenchSubagentItems 去重后的子代理条目数 + 外部 subagent run 数；
 * running DSL 任一 running 节点的真实 child blocked 时整个工作流计 blocked（仅一次）。
 */
export function summarizeWorkbenchTasks(
  conversations: ReadonlyArray<ConversationSummary>,
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkbenchTaskSummary {
  const ownRuns = workflowRuns.filter((r) => r.conversationId === parentConversationId)
  const dslRuns = ownRuns.filter((r) => r.kind !== 'subagent')
  const externalSubagentRuns = ownRuns.filter(
    (r) => r.kind === 'subagent' && !(r.nodes ?? []).some((n) => n.conversationId !== undefined),
  )
  const items = buildWorkbenchSubagentItems(conversations, parentConversationId, ownRuns)
  const blockedChildIds = new Set(
    conversations
      .filter((c) => c.parentConversationId === parentConversationId && c.status === 'blocked')
      .map((c) => c.id),
  )
  let activeCount = 0
  let blockedCount = 0
  let errorCount = 0
  let doneCount = 0
  for (const item of items) {
    const rank = workbenchItemRank(item)
    if (rank === 0) blockedCount++
    else if (rank === 1) activeCount++
    else if (rank === 2) errorCount++
    else doneCount++
  }
  for (const run of dslRuns) {
    if (run.status === 'running') {
      // 仅 running 节点看 child blocked：终态节点不随后来 blocked 改写历史口径。
      const childBlocked = (run.nodes ?? []).some(
        (n) => n.status === 'running' && n.conversationId !== undefined && blockedChildIds.has(n.conversationId),
      )
      if (childBlocked) blockedCount++
      else activeCount++
    } else if (run.status === 'failed' || run.status === 'aborted') errorCount++
    else doneCount++
  }
  for (const run of externalSubagentRuns) {
    if (run.status === 'running') activeCount++
    else if (run.status === 'failed' || run.status === 'aborted') errorCount++
    else doneCount++
  }
  return {
    workflowCount: dslRuns.length,
    subagentCount: items.length + externalSubagentRuns.length,
    totalCount: dslRuns.length + items.length + externalSubagentRuns.length,
    activeCount,
    blockedCount,
    errorCount,
    doneCount,
  }
}
