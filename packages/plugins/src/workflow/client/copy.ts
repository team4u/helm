/**
 * Display copy and visual badge/icon maps for the builtin:workflow client
 * (pure copy table + compact template builders, zero component exports — Fast Refresh friendly).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale, type LocalizedText } from '@helm/plugin-client'
import type { WorkflowPhaseSection } from './model-run.ts'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const t0 = (en: string, zh: string) => (locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(L(en, zh), locale)
const t1 = <A>(fn: (a: A) => LocalizedText) => (a: A, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(fn(a), locale)
const t2 = <A, B>(fn: (a: A, b: B) => LocalizedText) => (a: A, b: B, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(fn(a, b), locale)
const t3 = <A, B, C>(fn: (a: A, b: B, c: C) => LocalizedText) => (a: A, b: B, c: C, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(fn(a, b, c), locale)

// ---------------------------------------------------------------------------
// Visual presentation maps (merged from presentation.ts)
// ---------------------------------------------------------------------------

export const SPIN = 'spin-slow'
export const PHASE_ICON: Record<WorkflowPhaseSection['status'], string> = {
  pending: 'circle', running: 'loader', done: 'check', failed: 'x',
}

// ---------------------------------------------------------------------------
// Shared status labels
// ---------------------------------------------------------------------------

const RUN_STATUS_LABELS: Record<string, LocalizedText> = {
  running: L('Running', '执行中'),
  completed: L('Completed', '已完成'),
  failed: L('Failed', '失败'),
  aborted: L('Aborted', '已中止'),
}
const NODE_STATUS_LABELS: Record<string, LocalizedText> = {
  pending: L('Pending', '待执行'),
  running: L('Running', '运行中'),
  done: L('Done', '完成'),
  failed: L('Failed', '失败'),
  skipped: L('Skipped', '跳过'),
}
const EXECUTION_STATUS_LABELS: Record<string, LocalizedText> = {
  blocked: L('Awaiting approval', '等待审批'),
  error: L('Error', '异常'),
  working: L('Running', '执行中'),
  done: L('Done', '已完成'),
  pending: L('In progress', '进行中'),
  aborted: L('Aborted', '已中止'),
}

export type SubagentBadgeLabelKey =
  | 'blocked' | 'working' | 'workingBackground' | 'error' | 'aborted' | 'done' | 'pending'

const SUBAGENT_BADGE_LABELS: Record<SubagentBadgeLabelKey, LocalizedText> = {
  blocked: L('Awaiting approval', '等待审批'),
  working: L('Running', '执行中'),
  workingBackground: L('Running in background', '后台运行中'),
  error: L('Error', '异常'),
  aborted: L('Aborted', '已中止'),
  done: L('Done', '已完成'),
  pending: L('In progress', '进行中'),
}

export const runStatusLabel = (status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(RUN_STATUS_LABELS[status] ?? status, locale)
export const nodeStatusLabel = (status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(NODE_STATUS_LABELS[status] ?? status, locale)
export const executionStatusLabel = (status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(EXECUTION_STATUS_LABELS[status] ?? status, locale)
export const subagentBadgeLabel = (key: SubagentBadgeLabelKey, locale: HelmLocale = DEFAULT_HELM_LOCALE): string =>
  resolveLocalizedText(SUBAGENT_BADGE_LABELS[key], locale)
export const runFailureFallbackLabel = t1((isTrueBackground: boolean) =>
  isTrueBackground ? L('Background run failed', '后台执行失败') : L('Execution failed', '执行失败'),
)

// ---------------------------------------------------------------------------
// Timeline trace rows (SubagentToolView / WorkflowToolView)
// ---------------------------------------------------------------------------

export const TRACE_SUBAGENT_TOOL_NAME = L('Subagent', '子代理')
export const TRACE_EXTERNAL_TOOL_NAME = L('External agent', '外部代理')
export const TRACE_SUBAGENT_CALL = L('Subagent call', '子代理调用')
export const traceSubagentWithId = t1((id: number) => L(`Subagent #${id}`, `子代理 #${id}`))
export const TRACE_RESUMED_BELOW = L('Resumed below', '已在下文续接')
export const traceOpenChildLabel = t1((id: number) => L(`Open subagent #${id}`, `打开子会话 #${id}`))
export const traceOpenWorkbenchRunLabel = t1((runId: string) =>
  L(`View run ${runId} in the workbench`, `在工作台查看运行 ${runId}`),
)
export const TRACE_COLLAPSE_DETAILS = L('Collapse subagent call details', '收起子代理调用详情')
export const TRACE_EXPAND_DETAILS = L('Expand subagent call details', '展开子代理调用详情')
export const TRACE_RUN_FAILED = L('Failed', '失败')
export const TRACE_RUN_BACKGROUND = L('Running in background', '后台运行中')
export const TRACE_RUN_RUNNING = L('Running', '运行中')
export const TRACE_RUN_COMPLETED = L('Completed', '已完成')
export const TRACE_BG_DISPATCHED = L('Dispatched to background', '已派发后台运行')
export const traceToggleDetailsLabel = t2((title: string, open: boolean) =>
  L(`${title} — ${open ? 'collapse' : 'expand'} details`, `${title} — ${open ? '收起' : '展开'}详情`),
)
export const traceWorkflowRowLabel = t2((name: string, summary: string | undefined) => {
  const mid = summary !== undefined && summary !== '' ? ` · ${summary}` : ''
  return L(`Workflow ${name}${mid} — view details in the workbench`, `工作流 ${name}${mid} — 在工作台查看详情`)
})
export const traceNodeProgress = t2((done: number, total: number) => L(`${done}/${total} nodes`, `${done}/${total} 节点`))
export const traceActiveNode = t1((label: string) => L(`In progress: ${label}`, `进行中: ${label}`))
export const traceResumeFallbackLabel = t1((runId: string) => L(`Resume ${runId}`, `恢复 ${runId}`))

// ---------------------------------------------------------------------------
// Background report card
// ---------------------------------------------------------------------------

export const REPORT_INVALID_TITLE = L('Background report', '后台汇报')
export const REPORT_SUBAGENT_TITLE = L('Subagent report', '子代理汇报')
export const REPORT_WORKFLOW_TITLE = L('Workflow report', '工作流汇报')
export const REPORT_INVALID_PREVIEW = L('Malformed report payload; expand to view the raw message', '汇报数据格式异常，展开查看原始报文')
export const REPORT_INVALID_BADGE = L('Malformed report', '汇报数据格式异常')
export const reportToggleLabel = t2((title: string, open: boolean) =>
  L(`${open ? 'Collapse' : 'Expand'} ${title} details`, `${open ? '收起' : '展开'}${title}详情`),
)
export const reportOpenChildTitle = t1((id: number) => L(`Open subagent #${id}`, `打开子会话 #${id}`))
export const REPORT_INVALID_CALLOUT = L('Malformed report payload (raw message snapshot below)', '汇报数据格式异常（以下为原始报文快照）')
export const REPORT_KV_RUN_ID = L('Run ID', '运行 ID')
export const REPORT_KV_TASK_NAME = L('Task name', '任务名称')
export const REPORT_KV_DELIVERED_AT = L('Delivered at', '投递时间')
export const REPORT_KV_TASK_TYPE = L('Task type', '任务类型')
export const REPORT_KIND_SUBAGENT = L('Background subagent', '后台子代理')
export const REPORT_KIND_WORKFLOW = L('Workflow', '工作流')
export const REPORT_KV_SUBAGENT = L('Subagent', '子会话')
export const REPORT_RESULT_SECTION = L('Result body', '结果正文')
export const REPORT_NO_RESULT = L('This run reported no result data.', '本次运行未携带结果数据。')
export const REPORT_OTHER_TASKS_SECTION = L('Other in-flight tasks at delivery (snapshot)', '投递时其余在途任务（快照）')

// ---------------------------------------------------------------------------
// Subagent live card & stream
// ---------------------------------------------------------------------------

export const cardOpenChildLabel = t1((id: number) => L(`Open subagent #${id} drawer`, `打开子会话 #${id} 抽屉`))
export const cardOpenChildTooltip = t0('Click to open the subagent drawer', '点击打开子会话抽屉')
export const cardSubagentHeading = t1((id: number) => L(`Subagent #${id}`, `子会话 #${id}`))
export const worktreeBadgeTitle = t1((path: string) => L(`Isolated worktree: ${path}`, `隔离工作树：${path}`))
export const selfStatusLabel = t1((selfLabel: string) => L(`Self: ${selfLabel}`, `自身${selfLabel}`))
export const selfAggregateTitle = t2((selfLabel: string, aggregateLabel: string) =>
  L(`Self: ${selfLabel}; subtree aggregate: ${aggregateLabel}`, `自身${selfLabel}，子树聚合：${aggregateLabel}`),
)
export const subtreeProgressTitle = t3((done: number, total: number, running: number) =>
  L(`Subtree progress: ${done}/${total} done, ${running} running`, `子树执行进度：${done}/${total} 完成、${running} 执行中`),
)
export const subtreeBadge = t2((done: number, total: number) => L(`Subtree ${done}/${total}`, `子树 ${done}/${total}`))
export const approvalsTitle = t1((items: string[]) =>
  L(`Descendants awaiting approval: ${items.join('; ')}`, `后代等待审批：${items.join('；')}`),
)
export const approvalsBadge = t1((count: number) => L(`Approvals ${count}`, `审批 ${count}`))
export const ACTION_ABORT = L('Abort', '中止')
export const ACTION_ABORT_BG_TITLE = L('Abort this background subagent task', '中止该后台子代理任务')
export const actionAbortFailed = t1((err: string) => L(`Failed to abort background subagent: ${err}`, `中止后台子代理失败：${err}`))
export const ACTION_DETACH = L('Move to background', '转入后台')
export const ACTION_DETACH_SUBAGENT_TITLE = L(
  'Move this foreground-sync subagent to the background: the blocked call immediately returns a background handle, and a follow-up report arrives on completion',
  '把该前台同步子代理转入后台：阻塞中的调用立即返回后台句柄，完成后自动 followUp 汇报',
)
export const ACTION_DETACH_SUBAGENT_ARIA = L('Move this foreground-sync subagent to the background', '把该前台同步子代理转入后台')
export const actionDetachDone = t1((runId: string) =>
  L(
    `Moved to background (run ${runId}): the current call receives a background handle and a report will follow on completion`,
    `已转入后台（运行 ${runId}）：当前调用将收到后台句柄，完成后自动汇报`,
  ),
)
export const actionDetachFailed = t1((err: string) => L(`Failed to move to background: ${err}`, `转入后台失败：${err}`))
export const ACTION_CLEANUP_WORKTREE = L('Clean up worktree', '清理工作树')
export const ACTION_CLEANUP_WORKTREE_TITLE = L(
  'Clean up the isolated worktree (registered ID first for precise targeting, avoiding same-path ambiguity across nodes)',
  '清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）',
)
export const ACTION_CLEANUP_WORKTREE_ARIA = L('Clean up isolated worktree', '清理隔离工作树')
export const actionCleanupDone = t1((branch: string) => L(`Cleaned up isolated worktree ${branch}`, `已清理隔离工作树 ${branch}`))
export const actionCleanupFailed = t1((err: string) => L(`Failed to clean up worktree: ${err}`, `清理工作树失败：${err}`))
export const BADGE_CACHED = L('Cached', '已缓存')
export const ACTION_RESUME_SUBAGENT = L('Resume', '恢复')
export const ACTION_RESUME_SUBAGENT_TITLE = L('Resume this failed or aborted background subagent task', '恢复该失败或中止的后台子代理任务')
export const ACTION_RESUME_SUBAGENT_ARIA = L('Resume this background subagent task', '恢复该后台子代理任务')
export const actionResumeSubagentStarted = t1((runId: string) => L(`Resume initiated (source run ${runId})`, `已发起恢复（源运行 ${runId}）`))
export const actionResumeSubagentFailed = t1((err: string) => L(`Failed to resume background subagent: ${err}`, `恢复后台子代理失败：${err}`))
export const ACTION_RETRY = L('Retry', '重试')
export const ACTION_RETRY_TITLE = L('Reload subagent details', '重新加载子会话详情')
export const SUBLINE_FRONTLINE_TAG = L('Frontline', '前线')

// Metadata disclosure (machine facts moved out of the always-visible surface)
export const META_TOGGLE_ARIA = L('Toggle run metadata', '切换运行元数据')
export const META_TOGGLE_LABEL = L('Metadata', '元数据')
export const META_KV_LOCATION = L('Location', '位置')
export const META_KV_CREATED = L('Created', '创建时间')
export const META_KV_RUN_ID = L('Run ID', '运行 ID')
export const META_KV_WORKTREE = L('Worktree', '工作树')
export const META_KV_EXECUTION = L('Execution', '外部执行')

export const SNIPPET_LOAD_FAILED = L('Load failed', '加载失败')
export const SNIPPET_AWAITING_APPROVAL = L('Awaiting approval', '等待审批')
export const SNIPPET_AWAITING_HUMAN = L('Awaiting human confirmation', '等待人工确认')
export const SNIPPET_FAILED = L('Failed', '失败')
export const SNIPPET_ERROR = L('Error', '异常')
export const SNIPPET_SUBAGENT_ERROR = L('Subagent execution error', '子代理执行异常')
export const SNIPPET_OUTPUT = L('Output', '输出')
export const SNIPPET_THINKING = L('Thinking', '思考')
export const SNIPPET_GATE_CHECK = L('Gate check', 'Gate 验收')
export const SNIPPET_STARTING = L('Starting subagent…', '正在启动子代理…')
export const snippetParallelTools = t1((count: number) => L(`Parallel ×${count}`, `并行 ${count} 项`))
export const SNIPPET_PARALLEL_MORE = L(' …', ' 等')

export const STREAM_PROMPT_TAG = L('Prompt', '指令')
export const STREAM_THINKING_TAG = L('Thinking', '思考')
export const STREAM_REPLY_TAG = L('Reply', '回复')
export const STREAM_TRUNCATED = L('(truncated)', '（已截断）')
export const streamPreviewSeparator = t0(': ', '：')

export const TOOL_TAG_READ = L('Read', '读取')
export const TOOL_TAG_EDIT = L('Edit', '编辑')
export const TOOL_TAG_WRITE = L('Write', '写入')
export const TOOL_TAG_SEARCH = L('Search', '搜索')
export const TOOL_TAG_FIND = L('Find', '查找')
export const statToolSteps = t1((steps: number) => L(`${steps} tools loaded`, `已载 ${steps} 次工具`))
export const summarizeJsonMoreSuffix = t1((count: number) => L(` (+${count} more)`, ` 等 ${count} 项`))

export const DETAILS_SUMMARY = L('Call details', '调用详情')
export const DETAILS_INPUT = L('Input', '入参')
export const DETAILS_OUTPUT = L('Output', '输出')
export const detailsOpenArtifactLabel = t1((artifactId: string) => L(`Open full artifact #${artifactId}`, `打开完整产物 #${artifactId}`))

// ---------------------------------------------------------------------------
// External run summary
// ---------------------------------------------------------------------------

export const EXTERNAL_TITLE = L('External agent', '外部代理')
export const ACTION_DETACH_EXTERNAL_TITLE = L(
  'Move this foreground-sync external run to the background: the blocked call immediately returns a background handle, and a follow-up report arrives on completion',
  '把该前台同步外部执行转入后台：阻塞中的调用立即返回后台句柄，完成后自动 followUp 汇报',
)
export const ACTION_DETACH_EXTERNAL_ARIA = L('Move this foreground-sync external run to the background', '把该前台同步外部执行转入后台')
const EXTERNAL_IDLE_STATE: Record<'active' | 'error' | 'settled', LocalizedText> = {
  active: L('in progress', '进行中'),
  error: L('error', '异常'),
  settled: L('settled', '已结束'),
}
export const externalIdleLine = (state: 'active' | 'error' | 'settled', locale: HelmLocale = DEFAULT_HELM_LOCALE): string => {
  const s = resolveLocalizedText(EXTERNAL_IDLE_STATE[state], locale)
  return resolveLocalizedText(L(`External run ${s} (no subagent)`, `外部执行${s}（无子会话）`), locale)
}
export const externalBackgroundTaskLabel = t1((runId: string) => L(`Background task ${runId}`, `后台任务 ${runId}`))
export const externalNodeFailedLabel = t1((error: string) => L(`Node failed: ${error}`, `节点失败：${error}`))
export const externalRunningNodes = t1((count: number) => L(`${count} node${count > 1 ? 's' : ''} running`, `${count} 个节点执行中`))
export const externalErrorJoiner = t0(': ', '：')

// ---------------------------------------------------------------------------
// Workbench run card / node cards / replay form
// ---------------------------------------------------------------------------

export const RUN_CARD_ABORT_FAILED = L('Failed to abort workflow', '中止工作流失败')
export const RUN_CARD_DETACH_FAILED = L('Failed to move to background', '转入后台失败')
export const RUN_CARD_RESUME_FAILED = L('Failed to resume from checkpoint', '断点恢复失败')
export const RUN_CARD_REPLAY_FAILED = L('Failed to replay', '重放失败')
export const RUN_CARD_SAVE_FAILED = L('Failed to save workflow', '保存工作流失败')
export const runCardAriaLabel = t1((name: string) => L(`Workflow: ${name}`, `工作流：${name}`))
export const RUN_CARD_COLLAPSE_TITLE = L('Collapse workflow card', '收起工作流卡')
export const RUN_CARD_EXPAND_TITLE = L('Expand workflow card', '展开工作流卡')
export const runCardSelfTitle = t2((runLabel: string, effectiveLabel: string) =>
  L(
    `Run itself ${runLabel}; subtree still has unsettled tasks (${effectiveLabel})`,
    `run 自身${runLabel}；子树仍有未结算任务（${effectiveLabel}）`,
  ),
)
export const runCardSelfStateTitle = t1((runLabel: string) => L(`Run status: ${runLabel}`, `run 自身状态：${runLabel}`))
export const RUN_CARD_CACHED_REPLAY = L('Cached replay', 'cached 重放')
export const runCardReplayBadgeTitle = t1((sourceRunId: string) =>
  L(`Replayed from a journal prefix (source run ${sourceRunId})`, `从 journal 前缀重放恢复（源 run ${sourceRunId}）`),
)
export const runCardSavedBadgeTitle = t1((name: string) => L(`Saved as workflow: ${name}`, `已保存工作流：${name}`))
export const RUN_CARD_SAVED_BADGE = L('Saved definition', '已保存定义')
export const runCardNodesStat = t2((done: number, total: number) => L(`Nodes ${done}/${total}`, `节点 ${done}/${total}`))
export const runCardSubtreeStat = t2((done: number, total: number) => L(`Subtree ${done}/${total}`, `子树 ${done}/${total}`))
export const runCardTokensStat = t1((tokens: number) => L(`${tokens.toLocaleString()} Tokens`, `${tokens.toLocaleString()} Token`))
export const RUN_CARD_MORE_ARIA = L('More actions', '更多操作')
export const RUN_CARD_MORE_TITLE = L('More workflow actions', '更多工作流操作')
export const RUN_CARD_REPLAY = L('Replay', '重放')
export const RUN_CARD_SAVE_AS = L('Save as workflow', '保存为工作流')
export const RUN_CARD_WORKBENCH_DETAILS = L('Workbench details', '工作台详情')
export const RUN_CARD_DETACH_TITLE = L(
  'Move this foreground-sync run to the background: the blocked tool call immediately returns a background handle, and a follow-up report arrives when the run completes',
  '把该前台同步运行转入后台：阻塞中的工具调用立即返回后台句柄，运行完成后自动 followUp 汇报',
)
export const RUN_CARD_RESUME = L('Resume from checkpoint', '断点恢复')
export const RUN_CARD_RESUME_TITLE = L(
  "Resume from this run's journal checkpoint: replays the completed prefix and only re-runs failed/incomplete nodes (keeps the original script and args; no parameter or target changes)",
  '从同 run 的 journal 断点恢复：重放已完成前缀，仅重跑失败/未完成节点（沿用原脚本与 args；不支持改参换目标）',
)
export const runCardSaveInvalidResult = t0(
  'Save returned an invalid shape (unexpected action payload)',
  '保存返回结构不合法（动作返回非预期形状）',
)
export const runCardSaveCreated = t1((name: string) =>
  L(`Saved as workflow definition ${name} (visible in the workflow library)`, `已保存为工作流定义 ${name}（可在工作流库查看）`),
)
export const runCardSaveOverwritten = t1((name: string) => L(`Overwrote workflow definition ${name}`, `已覆盖工作流定义 ${name}`))
export const runCardReplayAccepted = t1((runId: string) =>
  L(
    `Replay accepted (source run ${runId}; the new run keeps the original conversation and script source)`,
    `重放已受理（源 run ${runId}；新 run 保留原会话与原脚本源）`,
  ),
)
export const RUN_KV_RUN_ID = L('Run ID', '运行 ID')
export const RUN_KV_CREATED_AT = L('Started at', '发起时间')
export const RUN_KV_UPDATED_AT = L('Updated at', '更新时间')
export const RUN_KV_SOURCE_RUN = L('Source run', '源 run')
export const RUN_KV_SAVED_DEF = L('Saved definition', '保存定义')
export const RUN_NO_NODES = L('No node status yet', '暂无节点状态')
export const RUN_RESULT_SECTION = L('Final output', '最终产出')
export const RUN_COLLAPSE_RESULT = L('Collapse full result', '收起完整结果')
export const RUN_EXPAND_RESULT = L('Expand full result', '展开完整结果')
export const RUN_RESULT_LOADING = L('Loading full result…', '正在加载完整结果…')
export const runResultInspectFailed = t1((err: string) => L(`Failed to load full result: ${err}`, `加载完整结果失败：${err}`))

export const NODE_BADGE_ACTION = L('Action', '动作')
export const NODE_BADGE_EXTERNAL = L('External run', '外部执行')
export const NODE_BADGE_SUBAGENT = L('Subagent node', '子代理节点')
export const NODE_GATE_PASSED = L('Gate passed', 'Gate 通过')
export const NODE_GATE_FAILED = L('Gate failed', 'Gate 失败')
export const nodeAttemptBadge = t1((attempt: number) => L(`Attempt ${attempt}`, `第 ${attempt} 次`))
export const NODE_TAG_ERROR = L('Error', '错误')
export const NODE_TAG_OUTPUT = L('Output', '产出')
export const NODE_SECTION_PROMPT = L('Prompt', '指令')
export const NODE_KV_STARTED_AT = L('Started at', '开始时间')
export const NODE_KV_BACKEND = L('Backend', '执行后端')
export const NODE_KV_EXTERNAL = L('External run', '外部执行')
export const NODE_KV_NODE = L('Node', '执行节点')
export const NODE_KV_CWD = L('Working directory', '工作目录')
export const NODE_KV_WORKTREE = L('Worktree', '工作树')
export const NODE_KV_MODEL = L('Model', '模型')
export const NODE_KV_DURATION = L('Duration', '耗时')
export const NODE_KV_TOKENS = L('Tokens', 'Token')

export function replayMeta(runId: string, conversationId: number, savedName: string | undefined, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const sourceNote = resolveLocalizedText(
    savedName !== undefined
      ? L(`saved definition ${savedName} executes the latest file content`, `已保存定义 ${savedName} 按最新文件内容执行`)
      : L('inline script keeps its original source', '内联脚本沿用原源码'),
    locale,
  )
  return resolveLocalizedText(
    L(`Source run ${runId} (conversation #${conversationId}; ${sourceNote})`, `源 run ${runId}（会话 #${conversationId}；${sourceNote}）`),
    locale,
  )
}
export const REPLAY_HINT = L(
  'The cache only reuses prefix nodes whose call payloads match exactly; re-execution starts at the first mismatch, so changed args are not guaranteed to hit the cache and nodes with external side effects really re-run.',
  '缓存仅复用调用载荷完全相同的前缀节点；首次载荷失配起真实重执行，改参不保证命中缓存，含外部副作用的节点会照实重跑。',
)
export const REPLAY_ARGS_PLACEHOLDER = L(
  'args JSON (optional; blank keeps original args, non-empty strictly parsed)',
  'args JSON（可选；空白沿用原 args，非空严格解析）',
)
export const replayArgsAria = t1((runId: string) => L(`args JSON override for replaying run ${runId}`, `重放 run ${runId} 的 args JSON 覆盖`))
export const REPLAY_SUBMIT_ARIA = L('Start replay', '发起重放')
export const REPLAY_SUBMIT_TITLE = L(
  'Start a replay via resumeFromRunId (the new run keeps the original conversation; blank args keep the original args)',
  '按 resumeFromRunId 发起重放（新 run 保留原会话；空白 args 沿用原 args）',
)
export const REPLAY_SUBMIT = L('Replay', '发起重放')

export function nodeAwaitingApproval(pendingAskTitle: string | undefined, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const fallback = resolveLocalizedText(SNIPPET_AWAITING_HUMAN, locale)
  return `${resolveLocalizedText(L('Awaiting approval: ', '等待审批：'), locale)}${pendingAskTitle || fallback}`
}
export const NODE_RUNNING_FALLBACK = L('Running…', '执行中…')
export const NODE_GATE_FAILED_FALLBACK = L('Gate check failed', 'Gate 验收未通过')
export const NODE_EXECUTION_FAILED = L('Execution failed', '执行失败')
export const NODE_SKIPPED = L('Skipped', '已跳过')
export const NODE_QUEUED = L('Queued…', '排队等待执行…')
export const DEFAULT_PHASE_TITLE = L('Default phase', '默认阶段')

// ---------------------------------------------------------------------------
// Workflow library
// ---------------------------------------------------------------------------

export const LIB_SCREEN_TITLE = L('Workflow library', '工作流库')
export const LIB_SCREEN_SUBTITLE = t2((count: number, isSplit: boolean) =>
  L(`${count} reusable orchestration assets${isSplit ? ' · split view' : ''}`, `跨会话可复用编排资产 ${count} 个${isSplit ? ' · 分屏' : ''}`),
)
export const LIB_REFRESH_TITLE = L('Reload the workflow library', '重新读取工作流目录')
export const LIB_REFRESH = L('Refresh', '刷新')
export const LIB_SEARCH_PLACEHOLDER = L('Search name, description or when-to-use…', '搜索名称、描述或适用场景…')
export const LIB_SEARCH_ARIA = L('Search workflows', '搜索工作流')
export const LIB_SEARCH_CLEAR_TITLE = L('Clear search', '清空搜索')
export const LIB_SEARCH_CLEAR_ARIA = L('Clear search', '清空搜索')
export const LIB_LOADING = L('Loading workflow library…', '工作流目录读取中…')
export const LIB_LOAD_FAILED = t1((error: string) => L(`Failed to load the workflow library: ${error}`, `读取工作流目录失败：${error}`))
export const LIB_RETRY = L('Retry', '重试')
export const LIB_EMPTY = L(
  'No saved workflows yet. After running SubagentWorkflow inline in a conversation, use "Save as workflow", or let the AI / CLI call the workflow save action to persist a definition.',
  '暂无已保存工作流。在会话中用 SubagentWorkflow 内联运行后点「保存为工作流」，或让 AI / CLI 调用 workflow save 保存定义。',
)
export const LIB_NO_MATCH = t1((query: string) => L(`No workflows match "${query}"`, `未找到匹配「${query}」的工作流`))
export const libListInvalid = t0(
  'Workflow library returned an invalid shape (unexpected action payload)',
  '工作流目录返回结构不合法（动作返回非预期形状）',
)
export const libCardAria = t1((name: string) => L(`View workflow ${name} details`, `查看工作流 ${name} 详情`))
export const libMetadataError = t1((error: string) => L(`Metadata validation failed: ${error}`, `元数据校验失败：${error}`))
export const LIB_CARD_NO_DESCRIPTION = L('No description', '无描述')
export const libPhases = t2((count: number, titles: string) => L(`${count} phases: ${titles}`, `${count} 阶段：${titles}`))
export const libDefinitionFileTitle = t1((path: string) => L(`Definition file: ${path}`, `定义文件：${path}`))
export const LIB_METADATA_BADGE = L('Metadata error', '元数据异常')
export const LIB_KV_DESCRIPTION = L('Description', '描述')
export const LIB_KV_WHEN_TO_USE = L('When to use', '适用场景')
export const LIB_KV_PHASES = L('Phases', '阶段')
export const LIB_PHASES_UNDECLARED = L('Not declared', '未声明')
export const LIB_SOURCE_SECTION = L('Source (read-only)', '源码（只读）')
export const LIB_SOURCE_RELOAD_TITLE = L('Reload source', '重新读取源码')
export const LIB_SOURCE_LOADING = L('Loading source…', '源码读取中…')
export const libDetailInvalid = t0(
  'Definition detail returned an invalid shape (unexpected action payload; refusing to fabricate a view)',
  '定义详情返回结构不合法（动作返回非预期形状，拒绝伪造展示）',
)
export const libSourceLoadFailed = t1((error: string) => L(`Failed to load source: ${error}`, `读取源码失败：${error}`))
export const LIB_COPY_SOURCE = L('Copy full source', '复制完整源码')
export const LIB_EDIT_HINT = L(
  'Creating and modifying workflows is done by the AI / CLI via the save action; the Web UI does not provide a source editor.',
  '工作流的创建与修改由 AI / CLI 调用 save 动作完成，Web 端不提供源码编辑器。',
)
export const LIB_RUN_SECTION = L('Run (pick a target conversation)', '运行（选择目标会话）')
export const LIB_RUN_SELECT_PLACEHOLDER = L('Pick a target conversation', '选择目标会话')
export const LIB_RUN_SELECT_ARIA = L('Pick the target conversation to run in', '选择运行目标会话')
export const LIB_ARGS_PLACEHOLDER = L('args JSON (optional, strictly parsed)', 'args JSON（可选，严格解析）')
export const libArgsAria = t1((name: string) => L(`args JSON for workflow ${name}`, `工作流 ${name} 的 args JSON`))
export const libPickConversationFirst = t0('Pick a target conversation first', '请先选择目标会话')
export const LIB_NO_TOP_LEVEL_CONVERSATIONS = L('No top-level conversations available', '无可用顶层会话')
export const libRunButtonTitle = t1((name: string) => L(`Run workflow ${name} in the selected conversation`, `在选定会话运行工作流 ${name}`))
export const LIB_RUN = L('Run', '运行')
export const libRunStarted = t2((name: string, conversationId: string) =>
  L(`Workflow ${name} started in conversation #${conversationId}`, `工作流 ${name} 已在会话 #${conversationId} 启动`),
)
export const libRunFailed = t1((err: string) => L(`Failed to start workflow: ${err}`, `启动工作流失败：${err}`))
export const libDeleted = t1((name: string) =>
  L(`Deleted workflow definition ${name} (historical runs are unaffected)`, `已删除工作流定义 ${name}（历史运行记录不受影响）`),
)
export const LIB_EDIT_SECTION = L('Let the AI edit', '让 AI 修改')
export const LIB_EDIT_HINT_2 = L(
  'Copy the request below and send it to an AI in any conversation: it reads the source, applies the changes and writes them back via the save action; this page never edits files directly.',
  '复制以下请求发给任意会话中的 AI，由它读取源码、修改并经 save 动作写回；本页不直接改动文件。',
)
export const LIB_COPY_EDIT_REQUEST = L('Copy edit request', '复制修改请求')
export const libDeleteConfirm = t1((name: string) =>
  L(`Delete workflow definition ${name}? Historical runs are kept.`, `确认删除工作流定义 ${name}？历史运行记录保留。`),
)
export const LIB_CANCEL = L('Cancel', '取消')
export const LIB_DELETE_CONFIRM = L('Confirm delete', '确认删除')
export const LIB_DELETING = L('Deleting…', '正在删除…')
export const LIB_CLOSE = L('Close', '关闭')
export const LIB_DELETE = L('Delete', '删除')
export const LIB_DELETE_TITLE = L('Delete the definition file (historical runs are unaffected)', '删除定义文件（历史运行记录不受影响）')
export const libDrawerAria = t1((name: string) => L(`Workflow ${name} details`, `工作流 ${name} 详情`))
export const libArgsInvalidJson = t1((err: string) => L(`args must be valid JSON: ${err}`, `args 需为合法 JSON：${err}`))

export function workflowEditRequestLines(name: string, descriptionLine: string | undefined, locale: HelmLocale): string[] {
  if (locale === 'zh-CN') {
    return [
      `请修改已保存工作流 ${name}（跨会话可复用资产）：`,
      `- 先用 workflow get 动作（或 helm workflows get ${name} --json）读取当前源码与元数据；`,
      `- 按需求修改后用 workflow save 动作（helm workflows save <文件或源码> --name ${name} --overwrite）写回；保存前校验会自动做语法预检，默认拒绝覆盖、需显式 overwrite；`,
      ...(descriptionLine !== undefined ? [descriptionLine] : []),
      '- 修改完成后告诉我保存结果与变化点，不要静默改动。',
    ]
  }
  return [
    `Please modify the saved workflow ${name} (a cross-conversation reusable asset):`,
    `- First read the current source and metadata via the workflow get action (or helm workflows get ${name} --json);`,
    `- After applying the changes, write them back with the workflow save action (helm workflows save <file-or-source> --name ${name} --overwrite); the pre-save check runs a syntax preflight, overwriting is refused by default and requires an explicit overwrite;`,
    ...(descriptionLine !== undefined ? [descriptionLine] : []),
    '- After saving, tell me the save result and what changed; do not modify anything silently.',
  ]
}
export const workflowEditDescriptionLine = t1((description: string) => L(`- Current description: ${description}`, `- 当前描述：${description}`))

// ---------------------------------------------------------------------------
// Worktree inspect section
// ---------------------------------------------------------------------------

export const wtInspectInvalid = t0(
  'Inspection result has an invalid shape (unexpected action payload; refusing to fabricate a view)',
  '检视结果结构不合法（动作返回非预期形状，拒绝伪造展示）',
)
export const wtSubmitFailed = t1((err: string) => L(`Failed to submit the review request: ${err}`, `提交审阅请求失败：${err}`))
export const WT_SUBMITTED = L('Review request submitted to the main conversation', '已向主会话提交工作树审阅请求')
export const WT_UNAVAILABLE_REMOVED = L('Registration cleaned up (the worktree has been removed)', '登记已清理（工作树已被移除）')
export const WT_UNAVAILABLE_MISSING = L(
  'Directory no longer exists (confirmed by a real probe on the node; the registration is kept)',
  '目录已不存在（节点真实探测证实；登记仍保留）',
)
export const wtUnavailableCta = t1((reason: string) =>
  L(`${reason}; git inspection is unavailable. Showing registration metadata only.`, `${reason}，无法执行 git 检视；仅展示登记元数据。`),
)
export const WT_COLLAPSE_TITLE = L('Collapse the worktree change overview', '收起工作树改动概览')
export const WT_EXPAND_TITLE = L(
  'Expand the read-only worktree change overview (real git inspection on the target node)',
  '展开工作树只读改动概览（目标节点真实 git 检视）',
)
export const WT_OVERVIEW = L('Change overview', '改动概览')
export const WT_REINSPECT_TITLE = L('Re-inspect (read-only)', '重新检视（只读）')
export const WT_REFRESH = L('Refresh', '刷新')
export const WT_INSPECTING = L('Read-only inspection on the target node…', '目标节点只读检视中…')
export const WT_RETRY = L('Retry', '重试')
export const wtInspectFailed = t1((error: string) => L(`Read-only inspection failed: ${error}`, `只读检视失败：${error}`))
export const WT_KV_BRANCH = L('Branch', '分支')
export const wtBranchMismatchBadgeTitle = t1((branch: string) =>
  L(`Registered branch ${branch}; the worktree may have been switched`, `登记分支 ${branch}；工作树可能已被改签`),
)
export const WT_BRANCH_MISMATCH = L('Differs from registration', '与登记不一致')
export const WT_KV_BASE = L('Base', '基线')
export const wtBaseValue = t2((baseCommit: string, diffBase: string) => {
  const short = baseCommit.slice(0, 12)
  return L(
    `${short} (${diffBase === 'HEAD' ? 'no base, against HEAD' : 'registered base'})`,
    `${short}（${diffBase === 'HEAD' ? '无基线，按 HEAD' : '登记基线'}）`,
  )
})
export const WT_NO_BASE = L('No registered base (uncommitted changes inspected against HEAD)', '无登记基线（按 HEAD 检视未提交改动）')
export const WT_KV_DIRTY = L('Uncommitted changes', '未提交修改')
export function wtDirtyCount(count: number, truncated: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const suffix = truncated
    ? resolveLocalizedText(L(' (list truncated; showing the first items)', '（列表已截断，仅显示前若干项）'), locale)
    : ''
  return resolveLocalizedText(L(`${count} file${count > 1 ? 's' : ''}${suffix}`, `${count} 个文件${suffix}`), locale)
}
export const WT_KV_AHEAD = L('Commits ahead of base', '领先基线提交')
export const wtAheadCount = t1((count: number) => L(`${count}`, `${count} 个`))
export const WT_KV_HEAD = L('Current HEAD', '当前 HEAD')
export const WT_NO_DIRTY = L('No uncommitted changes in the worktree', '工作区无未提交修改')
export const WT_DIFF_NOTE = L('The diff covers tracked files only; untracked files are in the status list.', 'Diff 仅包含已跟踪文件；未跟踪文件见状态列表。')
export const wtDiffStatSection = t1((diffBase: string) =>
  L(`Diff stats (vs ${diffBase === 'HEAD' ? 'HEAD' : 'base'})`, `Diff 统计（相对${diffBase === 'HEAD' ? ' HEAD' : '基线'}）`),
)
export const WT_DIFF_PREVIEW_SECTION = L('Diff preview (read-only, capped)', 'Diff 预览（只读，有上限）')
export const WT_DIFF_TRUNCATED = L('Truncated', '已截断')
export const WT_NO_DIFF = L('No tracked-file diff', '无已跟踪文件 diff')
export const WT_REVIEW_BUTTON = L('Ask the main conversation to review and merge', '让主会话审阅并合入')
export const WT_REVIEW_TITLE = L(
  'Submit a review-and-merge request to the main conversation (actual inspection and merging are done there)',
  '向主会话提交审阅与合入请求（实际检视与合入由主会话执行）',
)
export const WT_COPY_REVIEW = L('Copy review request', '复制审阅请求文本')

export function worktreeReviewLines(
  input: {
    path: string
    branch: string
    nodeId?: string
    baseCommit?: string
    taskLine?: string
    inspectLine?: (locale: HelmLocale) => string[]
  },
  locale: HelmLocale,
): string[] {
  const nodeSuffix = input.nodeId !== undefined && input.nodeId !== ''
    ? resolveLocalizedText(L(` (node ${input.nodeId})`, `（节点 ${input.nodeId}）`), locale)
    : ''
  const baseSuffix = input.baseCommit !== undefined && input.baseCommit !== ''
    ? resolveLocalizedText(L(` (based on commit ${input.baseCommit.slice(0, 12)})`, `（基于提交 ${input.baseCommit.slice(0, 12)}）`), locale)
    : ''
  if (locale === 'zh-CN') {
    return [
      '请审阅并合入以下受管工作树的改动（数据来自只读检视，实际内容请在目标节点以 git 复核）：',
      `- 工作树：${input.path}${nodeSuffix}`,
      `- 分支：${input.branch}${baseSuffix}`,
      ...(input.taskLine !== undefined ? [input.taskLine] : []),
      ...(input.inspectLine !== undefined ? input.inspectLine(locale) : []),
      '请先只读复核（git diff / status），确认后合入主工作树；需要丢弃或清理工作树时请明确说明，不要静默 force 清理。',
    ]
  }
  return [
    'Please review and merge the changes of the following managed worktree (data comes from a read-only inspection; verify the actual content with git on the target node):',
    `- Worktree: ${input.path}${nodeSuffix}`,
    `- Branch: ${input.branch}${baseSuffix}`,
    ...(input.taskLine !== undefined ? [input.taskLine] : []),
    ...(input.inspectLine !== undefined ? input.inspectLine(locale) : []),
    'Review read-only first (git diff / status) and merge into the main worktree after confirming; state explicitly if the worktree should be discarded or cleaned up — never force-clean silently.',
  ]
}
export const wtReviewTaskLine = t1((task: string) => L(`- Task: ${task}`, `- 任务：${task}`))
export function wtReviewInspectMissing(removed: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const reason = resolveLocalizedText(removed ? L('registration cleaned up', '登记已清理') : L('directory missing', '不存在'), locale)
  return resolveLocalizedText(L(`- Inspection: ${reason}; nothing to inspect`, `- 检视：目录${reason}，无可检视改动`), locale)
}
export const wtReviewDirtyLine = t1((count: number) => L(`- Uncommitted changes: ${count} file${count > 1 ? 's' : ''}`, `- 未提交修改：${count} 个文件`))
export const wtReviewAheadLine = t1((count: number) => L(`- Commits ahead of base: ${count}`, `- 领先基线提交：${count} 个`))
export const wtReviewBranchChanged = t1((currentBranch: string) =>
  L(
    `- Note: the worktree is currently on branch ${currentBranch}, which differs from the registered branch — it may have been switched; verify ownership first`,
    `- 注意：工作树当前分支 ${currentBranch} 与登记分支不一致，可能已被改签，请先核实归属`,
  ),
)

// ---------------------------------------------------------------------------
// Active tray / execution tree rows / workbench panel
// ---------------------------------------------------------------------------

export function trayCount(blocked: number, running: number, active: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  if (blocked > 0) {
    return running > 0
      ? resolveLocalizedText(L(`${blocked} awaiting approval · ${running} running`, `${blocked} 项待审批 · ${running} 项运行中`), locale)
      : resolveLocalizedText(L(`${blocked} awaiting approval`, `${blocked} 项待审批`), locale)
  }
  return resolveLocalizedText(L(`${active} running`, `${active} 项运行中`), locale)
}
export const TRAY_REGION_ARIA = L('In-flight orchestration tasks', '在途编排任务')
export const TRAY_COLLAPSE = L('Collapse', '收起')
export const TRAY_EXPAND = L('Expand', '展开')
export function trayToggleLabel(expanded: boolean, countText: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    L(
      `${expanded ? 'Collapse' : 'Expand'} in-flight tasks — ${countText}`,
      `${expanded ? '收起' : '展开'}在途任务 — ${countText}`,
    ),
    locale,
  )
}
export const TRAY_WORKBENCH = L('Workbench', '工作台')
export function trayRowOpenConversationLabel(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Open conversation #${id} drawer`, `打开会话 #${id} 抽屉`), locale)
}
export function trayRowOpenRunLabel(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Open run ${runId} in workbench`, `在工作台打开运行 ${runId}`), locale)
}
export function trayActionFailed(action: 'abort' | 'detach', err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const label = resolveLocalizedText(action === 'abort' ? ACTION_ABORT : ACTION_DETACH, locale)
  return resolveLocalizedText(L(`${label} failed: ${err}`, `${label}失败：${err}`), locale)
}

export const execOpenConversationLabel = t1((id: number) => L(`Open conversation #${id} drawer`, `打开会话 #${id} 抽屉`))
export const execCollapseChildrenLabel = t1((title: string) => L(`Collapse direct children of ${title}`, `收起 ${title} 直系子项`))
export const execExpandChildrenLabel = t1((title: string) => L(`Expand direct children of ${title}`, `展开 ${title} 直系子项`))
export const execOpenConversationTitle = t1((id: number) => L(`Click to open conversation #${id} drawer`, `点击打开会话 #${id} 抽屉`))
export const EXEC_COLLAPSE_CHILDREN_TITLE = L('Click to collapse direct children', '点击收起直系子项')
export const EXEC_EXPAND_CHILDREN_TITLE = L(
  'Click to expand direct children (deep workflow / external run, no standalone conversation)',
  '点击展开直系子项（深层工作流 / 外部执行，无独立会话）',
)
export const execApprovalBadge = t1((count: number) => L(`Approvals ${count}`, `审批 ${count}`))
export const execConversationTitle = t1((id: number) => L(`Subagent #${id}`, `子会话 #${id}`))
export const EXEC_EXTERNAL_FALLBACK = L('External run', '外部执行')
export const execFrontlineConversation = t1((id: number) => L(`#${id} running`, `#${id} 执行中`))
export const execFrontlineContainer = t1((label: string) => L(`${label} running`, `${label} 执行中`))
export const execApprovalItem = t1((id: number) => L(`#${id} awaiting approval`, `#${id} 等待审批`))

export const WORKBENCH_HEAD_TITLE = L('Current conversation tasks', '当前会话任务')
export const WORKBENCH_LIBRARY = L('Workflow library', '工作流库')
export const WORKBENCH_EMPTY_NO_CONVERSATION = L(
  'Open a conversation first; the workbench will show its workflows and subagent tasks.',
  '请先打开一个会话，工作台将展示当前会话的工作流与子代理任务。',
)
export const WORKBENCH_EMPTY_NO_RUNS = L(
  'No workflow or subagent runs in this conversation yet.',
  '当前会话暂无工作流或子代理运行记录。',
)
export const WORKBENCH_RESULT_SECTION = L('Run output', '运行产出')
export const WORKBENCH_RESUME_FAILED_TITLE = L(
  'Batch-resume auto-resumable failed tasks in the current conversation',
  '批量恢复当前会话下可自动续跑的失败任务',
)
export const workbenchResumeFailedButton = t1((count: number) => L(`Resume failed (${count})`, `恢复失败 (${count})`))
export const workbenchResumeInvalidResult = t0(
  'Batch resume returned an invalid shape (unexpected action payload)',
  '批量恢复返回结构不合法（动作返回非预期形状）',
)
export const workbenchResumeAllSkipped = t1((skippedCount: number) =>
  L(
    `No new resume tasks started (skipped ${skippedCount} non-auto-resumable task${skippedCount === 1 ? '' : 's'})`,
    `未拉起新恢复任务（跳过 ${skippedCount} 个不可自动恢复任务）`,
  ),
)
export const WORKBENCH_RESUME_NONE_NEEDED = L('No failed tasks need resuming', '当前没有需要恢复的失败任务')
export const workbenchResumeStarted = t2((resumedCount: number, skippedCount: number) =>
  skippedCount > 0
    ? L(
        `Initiated resume for ${resumedCount} failed task${resumedCount === 1 ? '' : 's'} (skipped ${skippedCount} non-auto-resumable)`,
        `已发起恢复 ${resumedCount} 个失败任务，跳过 ${skippedCount} 个不可自动恢复任务`,
      )
    : L(
        `Initiated resume for ${resumedCount} failed task${resumedCount === 1 ? '' : 's'}`,
        `已发起恢复 ${resumedCount} 个失败任务`,
      ),
)
export const workbenchResumeFailed = t1((err: string) => L(`Batch resume failed: ${err}`, `批量恢复失败：${err}`))
export function execFrontlineNamed(
  name: string,
  id: number,
  doing: string | undefined,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  if (doing !== undefined && doing !== '') {
    return `${name} (#${id}) · ${doing}`
  }
  return resolveLocalizedText(L(`${name} (#${id}) running`, `${name} (#${id}) 执行中`), locale)
}
export const execApprovalItemNamed = t2((name: string, id: number) =>
  L(`${name} (#${id}) awaiting approval`, `${name} (#${id}) 等待审批`),
)
