/**
 * Display copy for the builtin:workflow client (pure copy table + label
 * builders, no component exports — Fast Refresh friendly).
 *
 * Every human-visible string of the workflow client resolves through these
 * LocalizedText entries / builders against the active host locale (via
 * usePluginTranslator / usePluginLocale in components, or the explicit
 * `locale` parameter threaded through the pure model-*.ts functions). Copy is
 * grouped by UI domain: shared status labels / timeline trace rows / subagent
 * card / workbench run card / workflow library / worktree inspect / active
 * tray / execution tree rows.
 *
 * Not localized here (execution copy, never changes with locale): backend run
 * summaries, journal text, error messages from actions, model output (task
 * titles, results), runId / executionId / nodeId:cwd identifiers, and
 * kernel-generated conversation titles such as `子代理 #N`.
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale, type LocalizedText } from '@helm/plugin-client'

// ---------------------------------------------------------------------------
// Shared status labels (run / node / execution-tree five-value enums)
// ---------------------------------------------------------------------------

/** Workflow run terminal/live status badge text. */
export function runStatusLabel(status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      running: { en: 'Running', 'zh-CN': '执行中' },
      completed: { en: 'Completed', 'zh-CN': '已完成' },
      failed: { en: 'Failed', 'zh-CN': '失败' },
      aborted: { en: 'Aborted', 'zh-CN': '已中止' },
    }[status] ?? status,
    locale,
  )
}

/** Workflow run node status badge text. */
export function nodeStatusLabel(status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      pending: { en: 'Pending', 'zh-CN': '待执行' },
      running: { en: 'Running', 'zh-CN': '运行中' },
      done: { en: 'Done', 'zh-CN': '完成' },
      failed: { en: 'Failed', 'zh-CN': '失败' },
      skipped: { en: 'Skipped', 'zh-CN': '跳过' },
    }[status] ?? status,
    locale,
  )
}

/** Unified execution-tree node status badge text (five-value enum). */
export function executionStatusLabel(status: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      blocked: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
      error: { en: 'Error', 'zh-CN': '异常' },
      working: { en: 'Running', 'zh-CN': '执行中' },
      done: { en: 'Done', 'zh-CN': '已完成' },
      pending: { en: 'In progress', 'zh-CN': '进行中' },
    }[status] ?? status,
    locale,
  )
}

/**
 * Subagent card badge labels keyed by semantic variant (true-background runs
 * must say "background"; foreground-sync runs must not — honesty rule kept by
 * the model layer choosing the key).
 */
export type SubagentBadgeLabelKey =
  | 'blocked'
  | 'working'
  | 'workingBackground'
  | 'error'
  | 'aborted'
  | 'done'
  | 'pending'

export function subagentBadgeLabel(key: SubagentBadgeLabelKey, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      blocked: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
      working: { en: 'Running', 'zh-CN': '执行中' },
      workingBackground: { en: 'Running in background', 'zh-CN': '后台运行中' },
      error: { en: 'Error', 'zh-CN': '异常' },
      aborted: { en: 'Aborted', 'zh-CN': '已中止' },
      done: { en: 'Done', 'zh-CN': '已完成' },
      pending: { en: 'In progress', 'zh-CN': '进行中' },
    }[key],
    locale,
  )
}

/** Failure fallback for a linked run: foreground sync vs true background differ. */
export function runFailureFallbackLabel(isTrueBackground: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    isTrueBackground
      ? { en: 'Background run failed', 'zh-CN': '后台执行失败' }
      : { en: 'Execution failed', 'zh-CN': '执行失败' },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Timeline trace rows (SubagentToolView / WorkflowToolView)
// ---------------------------------------------------------------------------

export const TRACE_SUBAGENT_TOOL_NAME: LocalizedText = { en: 'Subagent', 'zh-CN': '子代理' }
export const TRACE_EXTERNAL_TOOL_NAME: LocalizedText = { en: 'External agent', 'zh-CN': '外部代理' }
export const TRACE_SUBAGENT_CALL: LocalizedText = { en: 'Subagent call', 'zh-CN': '子代理调用' }
/** Trace tool name with child id: `Subagent #21`. */
export function traceSubagentWithId(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Subagent #${id}`, 'zh-CN': `子代理 #${id}` }, locale)
}
export const TRACE_RESUMED_BELOW: LocalizedText = { en: 'Resumed below', 'zh-CN': '已在下文续接' }
export function traceOpenChildLabel(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Open subagent #${id}`, 'zh-CN': `打开子会话 #${id}` }, locale)
}
export function traceOpenWorkbenchRunLabel(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `View run ${runId} in the workbench`, 'zh-CN': `在工作台查看运行 ${runId}` },
    locale,
  )
}
export const TRACE_COLLAPSE_DETAILS: LocalizedText = { en: 'Collapse subagent call details', 'zh-CN': '收起子代理调用详情' }
export const TRACE_EXPAND_DETAILS: LocalizedText = { en: 'Expand subagent call details', 'zh-CN': '展开子代理调用详情' }
/** Workflow tool row fallback badge (no linked run record). */
export const TRACE_RUN_FAILED: LocalizedText = { en: 'Failed', 'zh-CN': '失败' }
export const TRACE_RUN_BACKGROUND: LocalizedText = { en: 'Running in background', 'zh-CN': '后台运行中' }
export const TRACE_RUN_RUNNING: LocalizedText = { en: 'Running', 'zh-CN': '运行中' }
export const TRACE_RUN_COMPLETED: LocalizedText = { en: 'Completed', 'zh-CN': '已完成' }
export const TRACE_BG_DISPATCHED: LocalizedText = { en: 'Dispatched to background', 'zh-CN': '已派发后台运行' }
export function traceToggleDetailsLabel(title: string, open: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `${title} — ${open ? 'collapse' : 'expand'} details`, 'zh-CN': `${title} — ${open ? '收起' : '展开'}详情` },
    locale,
  )
}
export function traceWorkflowRowLabel(name: string, summary: string | undefined, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Workflow ${name}${summary !== undefined && summary !== '' ? ` · ${summary}` : ''} — view details in the workbench`,
      'zh-CN': `工作流 ${name}${summary !== undefined && summary !== '' ? ` · ${summary}` : ''} — 在工作台查看详情`,
    },
    locale,
  )
}
export function traceNodeProgress(done: number, total: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${done}/${total} nodes`, 'zh-CN': `${done}/${total} 节点` }, locale)
}
export function traceActiveNode(label: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `In progress: ${label}`, 'zh-CN': `进行中: ${label}` }, locale)
}
export function traceResumeFallbackLabel(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Resume ${runId}`, 'zh-CN': `恢复 ${runId}` }, locale)
}

// ---------------------------------------------------------------------------
// Background report card (timeline renderer for settled background deliveries)
// ---------------------------------------------------------------------------

export const REPORT_INVALID_TITLE: LocalizedText = { en: 'Background report', 'zh-CN': '后台汇报' }
export const REPORT_SUBAGENT_TITLE: LocalizedText = { en: 'Subagent report', 'zh-CN': '子代理汇报' }
export const REPORT_WORKFLOW_TITLE: LocalizedText = { en: 'Workflow report', 'zh-CN': '工作流汇报' }
export const REPORT_INVALID_PREVIEW: LocalizedText = {
  en: 'Malformed report payload; expand to view the raw message',
  'zh-CN': '汇报数据格式异常，展开查看原始报文',
}
export const REPORT_INVALID_BADGE: LocalizedText = { en: 'Malformed report', 'zh-CN': '汇报数据格式异常' }
export function reportToggleLabel(title: string, open: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `${open ? 'Collapse' : 'Expand'} ${title} details`, 'zh-CN': `${open ? '收起' : '展开'}${title}详情` },
    locale,
  )
}
export function reportOpenChildTitle(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Open subagent #${id}`, 'zh-CN': `打开子会话 #${id}` }, locale)
}
export const REPORT_INVALID_CALLOUT: LocalizedText = {
  en: 'Malformed report payload (raw message snapshot below)',
  'zh-CN': '汇报数据格式异常（以下为原始报文快照）',
}
export const REPORT_KV_RUN_ID: LocalizedText = { en: 'Run ID', 'zh-CN': '运行 ID' }
export const REPORT_KV_TASK_NAME: LocalizedText = { en: 'Task name', 'zh-CN': '任务名称' }
export const REPORT_KV_DELIVERED_AT: LocalizedText = { en: 'Delivered at', 'zh-CN': '投递时间' }
export const REPORT_KV_TASK_TYPE: LocalizedText = { en: 'Task type', 'zh-CN': '任务类型' }
export const REPORT_KIND_SUBAGENT: LocalizedText = { en: 'Background subagent', 'zh-CN': '后台子代理' }
export const REPORT_KIND_WORKFLOW: LocalizedText = { en: 'Workflow', 'zh-CN': '工作流' }
export const REPORT_KV_SUBAGENT: LocalizedText = { en: 'Subagent', 'zh-CN': '子会话' }
export const REPORT_RESULT_SECTION: LocalizedText = { en: 'Result body', 'zh-CN': '结果正文' }
export const REPORT_NO_RESULT: LocalizedText = { en: 'This run reported no result data.', 'zh-CN': '本次运行未携带结果数据。' }
export const REPORT_OTHER_TASKS_SECTION: LocalizedText = {
  en: 'Other in-flight tasks at delivery (snapshot)',
  'zh-CN': '投递时其余在途任务（快照）',
}

// ---------------------------------------------------------------------------
// Subagent live card (heading badges / actions / sublines / stream)
// ---------------------------------------------------------------------------

export function cardOpenChildLabel(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Open subagent #${id} drawer`, 'zh-CN': `打开子会话 #${id} 抽屉` },
    locale,
  )
}
export function cardOpenChildTooltip(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Click to open the subagent drawer', 'zh-CN': '点击打开子会话抽屉' },
    locale,
  )
}
export function cardSubagentHeading(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Subagent #${id}`, 'zh-CN': `子会话 #${id}` }, locale)
}
export function worktreeBadgeTitle(path: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Isolated worktree: ${path}`, 'zh-CN': `隔离工作树：${path}` }, locale)
}
/** Composite self badge when the effective status differs from the self status. */
export function selfStatusLabel(selfLabel: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Self: ${selfLabel}`, 'zh-CN': `自身${selfLabel}` }, locale)
}
/** Subagent card title when the aggregate differs from the self status. */
export function selfAggregateTitle(selfLabel: string, aggregateLabel: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Self: ${selfLabel}; subtree aggregate: ${aggregateLabel}`, 'zh-CN': `自身${selfLabel}，子树聚合：${aggregateLabel}` },
    locale,
  )
}
export function subtreeProgressTitle(done: number, total: number, running: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Subtree progress: ${done}/${total} done, ${running} running`,
      'zh-CN': `子树执行进度：${done}/${total} 完成、${running} 执行中`,
    },
    locale,
  )
}
export function subtreeBadge(done: number, total: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Subtree ${done}/${total}`, 'zh-CN': `子树 ${done}/${total}` }, locale)
}
export function approvalsTitle(items: string[], locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Descendants awaiting approval: ${items.join('; ')}`, 'zh-CN': `后代等待审批：${items.join('；')}` },
    locale,
  )
}
export function approvalsBadge(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Approvals ${count}`, 'zh-CN': `审批 ${count}` }, locale)
}
export const ACTION_ABORT: LocalizedText = { en: 'Abort', 'zh-CN': '中止' }
export const ACTION_ABORT_BG_TITLE: LocalizedText = { en: 'Abort this background subagent task', 'zh-CN': '中止该后台子代理任务' }
export function actionAbortFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to abort background subagent: ${err}`, 'zh-CN': `中止后台子代理失败：${err}` },
    locale,
  )
}
export const ACTION_DETACH: LocalizedText = { en: 'Move to background', 'zh-CN': '转入后台' }
export const ACTION_DETACH_SUBAGENT_TITLE: LocalizedText = {
  en: 'Move this foreground-sync subagent to the background: the blocked call immediately returns a background handle, and a follow-up report arrives on completion',
  'zh-CN': '把该前台同步子代理转入后台：阻塞中的调用立即返回后台句柄，完成后自动 followUp 汇报',
}
export const ACTION_DETACH_SUBAGENT_ARIA: LocalizedText = {
  en: 'Move this foreground-sync subagent to the background',
  'zh-CN': '把该前台同步子代理转入后台',
}
export function actionDetachDone(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Moved to background (run ${runId}): the current call receives a background handle and a report will follow on completion`,
      'zh-CN': `已转入后台（运行 ${runId}）：当前调用将收到后台句柄，完成后自动汇报`,
    },
    locale,
  )
}
export function actionDetachFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to move to background: ${err}`, 'zh-CN': `转入后台失败：${err}` },
    locale,
  )
}
export const ACTION_CLEANUP_WORKTREE: LocalizedText = { en: 'Clean up worktree', 'zh-CN': '清理工作树' }
export const ACTION_CLEANUP_WORKTREE_TITLE: LocalizedText = {
  en: 'Clean up the isolated worktree (registered ID first for precise targeting, avoiding same-path ambiguity across nodes)',
  'zh-CN': '清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）',
}
export const ACTION_CLEANUP_WORKTREE_ARIA: LocalizedText = { en: 'Clean up isolated worktree', 'zh-CN': '清理隔离工作树' }
export function actionCleanupDone(branch: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Cleaned up isolated worktree ${branch}`, 'zh-CN': `已清理隔离工作树 ${branch}` },
    locale,
  )
}
export function actionCleanupFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to clean up worktree: ${err}`, 'zh-CN': `清理工作树失败：${err}` },
    locale,
  )
}
export const BADGE_CACHED: LocalizedText = { en: 'Cached', 'zh-CN': '已缓存' }
export const ACTION_RESUME_SUBAGENT: LocalizedText = { en: 'Resume', 'zh-CN': '恢复' }
export const ACTION_RESUME_SUBAGENT_TITLE: LocalizedText = {
  en: 'Resume this failed or aborted background subagent task',
  'zh-CN': '恢复该失败或中止的后台子代理任务',
}
export const ACTION_RESUME_SUBAGENT_ARIA: LocalizedText = {
  en: 'Resume this background subagent task',
  'zh-CN': '恢复该后台子代理任务',
}
export function actionResumeSubagentStarted(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Resume initiated (source run ${runId})`, 'zh-CN': `已发起恢复（源运行 ${runId}）` },
    locale,
  )
}
export function actionResumeSubagentFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to resume background subagent: ${err}`, 'zh-CN': `恢复后台子代理失败：${err}` },
    locale,
  )
}
export const ACTION_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }
export const ACTION_RETRY_TITLE: LocalizedText = { en: 'Reload subagent details', 'zh-CN': '重新加载子会话详情' }
export const SUBLINE_FRONTLINE_TAG: LocalizedText = { en: 'Frontline', 'zh-CN': '前线' }

// Header snippet tags / fallback texts (model-subagent-card)
export const SNIPPET_LOAD_FAILED: LocalizedText = { en: 'Load failed', 'zh-CN': '加载失败' }
export const SNIPPET_AWAITING_APPROVAL: LocalizedText = { en: 'Awaiting approval', 'zh-CN': '等待审批' }
export const SNIPPET_AWAITING_HUMAN: LocalizedText = { en: 'Awaiting human confirmation', 'zh-CN': '等待人工确认' }
export const SNIPPET_FAILED: LocalizedText = { en: 'Failed', 'zh-CN': '失败' }
export const SNIPPET_ERROR: LocalizedText = { en: 'Error', 'zh-CN': '异常' }
export const SNIPPET_SUBAGENT_ERROR: LocalizedText = { en: 'Subagent execution error', 'zh-CN': '子代理执行异常' }
export const SNIPPET_OUTPUT: LocalizedText = { en: 'Output', 'zh-CN': '输出' }
export const SNIPPET_THINKING: LocalizedText = { en: 'Thinking', 'zh-CN': '思考' }
export const SNIPPET_GATE_CHECK: LocalizedText = { en: 'Gate check', 'zh-CN': 'Gate 验收' }
export const SNIPPET_STARTING: LocalizedText = { en: 'Starting subagent…', 'zh-CN': '正在启动子代理…' }
export function snippetParallelTools(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Parallel ×${count}`, 'zh-CN': `并行 ${count} 项` }, locale)
}
/** Trailing "more" marker after the first two parallel tool summaries. */
export const SNIPPET_PARALLEL_MORE: LocalizedText = { en: ' …', 'zh-CN': ' 等' }

// Live stream line tags (SubagentStream)
export const STREAM_PROMPT_TAG: LocalizedText = { en: 'Prompt', 'zh-CN': '指令' }
export const STREAM_THINKING_TAG: LocalizedText = { en: 'Thinking', 'zh-CN': '思考' }
export const STREAM_REPLY_TAG: LocalizedText = { en: 'Reply', 'zh-CN': '回复' }
export const STREAM_TRUNCATED: LocalizedText = { en: '(truncated)', 'zh-CN': '（已截断）' }
/** Separator between tool summary and result preview on a stream line. */
export function streamPreviewSeparator(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: ': ', 'zh-CN': '：' }, locale)
}

// Semantic tool action tags (model-subagent-stream)
export const TOOL_TAG_READ: LocalizedText = { en: 'Read', 'zh-CN': '读取' }
export const TOOL_TAG_EDIT: LocalizedText = { en: 'Edit', 'zh-CN': '编辑' }
export const TOOL_TAG_WRITE: LocalizedText = { en: 'Write', 'zh-CN': '写入' }
export const TOOL_TAG_SEARCH: LocalizedText = { en: 'Search', 'zh-CN': '搜索' }
export const TOOL_TAG_FIND: LocalizedText = { en: 'Find', 'zh-CN': '查找' }
export function statToolSteps(steps: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${steps} tools loaded`, 'zh-CN': `已载 ${steps} 次工具` }, locale)
}
/** Trailing "more items" marker when a JSON array summary drops items. */
export function summarizeJsonMoreSuffix(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: ` (+${count} more)`, 'zh-CN': ` 等 ${count} 项` }, locale)
}

// Tool call details inline block
export const DETAILS_SUMMARY: LocalizedText = { en: 'Call details', 'zh-CN': '调用详情' }
export const DETAILS_INPUT: LocalizedText = { en: 'Input', 'zh-CN': '入参' }
export const DETAILS_OUTPUT: LocalizedText = { en: 'Output', 'zh-CN': '输出' }
export function detailsOpenArtifactLabel(artifactId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Open full artifact #${artifactId}`, 'zh-CN': `打开完整产物 #${artifactId}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// External run summary (runtime panes without a native subagent)
// ---------------------------------------------------------------------------

export const EXTERNAL_TITLE: LocalizedText = { en: 'External agent', 'zh-CN': '外部代理' }
export const ACTION_DETACH_EXTERNAL_TITLE: LocalizedText = {
  en: 'Move this foreground-sync external run to the background: the blocked call immediately returns a background handle, and a follow-up report arrives on completion',
  'zh-CN': '把该前台同步外部执行转入后台：阻塞中的调用立即返回后台句柄，完成后自动 followUp 汇报',
}
export const ACTION_DETACH_EXTERNAL_ARIA: LocalizedText = {
  en: 'Move this foreground-sync external run to the background',
  'zh-CN': '把该前台同步外部执行转入后台',
}
export function externalIdleLine(state: 'active' | 'error' | 'settled', locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const stateText = resolveLocalizedText(
    {
      active: { en: 'in progress', 'zh-CN': '进行中' },
      error: { en: 'error', 'zh-CN': '异常' },
      settled: { en: 'settled', 'zh-CN': '已结束' },
    }[state],
    locale,
  )
  return resolveLocalizedText(
    { en: `External run ${stateText} (no subagent)`, 'zh-CN': `外部执行${stateText}（无子会话）` },
    locale,
  )
}
export function externalBackgroundTaskLabel(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Background task ${runId}`, 'zh-CN': `后台任务 ${runId}` }, locale)
}
export function externalNodeFailedLabel(error: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Node failed: ${error}`, 'zh-CN': `节点失败：${error}` }, locale)
}
export function externalRunningNodes(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${count} node${count > 1 ? 's' : ''} running`, 'zh-CN': `${count} 个节点执行中` }, locale)
}
/** Error line prefix when both a fallback label and an error text are joined. */
export function externalErrorJoiner(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: ': ', 'zh-CN': '：' }, locale)
}

// ---------------------------------------------------------------------------
// Workbench run card (WorkflowRunCardBody / node cards / replay form)
// ---------------------------------------------------------------------------

export const RUN_CARD_ABORT_FAILED: LocalizedText = { en: 'Failed to abort workflow', 'zh-CN': '中止工作流失败' }
export const RUN_CARD_DETACH_FAILED: LocalizedText = { en: 'Failed to move to background', 'zh-CN': '转入后台失败' }
export const RUN_CARD_RESUME_FAILED: LocalizedText = { en: 'Failed to resume from checkpoint', 'zh-CN': '断点恢复失败' }
export const RUN_CARD_REPLAY_FAILED: LocalizedText = { en: 'Failed to replay', 'zh-CN': '重放失败' }
export const RUN_CARD_SAVE_FAILED: LocalizedText = { en: 'Failed to save workflow', 'zh-CN': '保存工作流失败' }
export function runCardAriaLabel(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Workflow: ${name}`, 'zh-CN': `工作流：${name}` }, locale)
}
export const RUN_CARD_COLLAPSE_TITLE: LocalizedText = { en: 'Collapse workflow card', 'zh-CN': '收起工作流卡' }
export const RUN_CARD_EXPAND_TITLE: LocalizedText = { en: 'Expand workflow card', 'zh-CN': '展开工作流卡' }
export function runCardSelfTitle(runLabel: string, effectiveLabel: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Run itself ${runLabel}; subtree still has unsettled tasks (${effectiveLabel})`,
      'zh-CN': `run 自身${runLabel}；子树仍有未结算任务（${effectiveLabel}）`,
    },
    locale,
  )
}
export function runCardSelfStateTitle(runLabel: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Run status: ${runLabel}`, 'zh-CN': `run 自身状态：${runLabel}` }, locale)
}
export const RUN_CARD_CACHED_REPLAY: LocalizedText = { en: 'Cached replay', 'zh-CN': 'cached 重放' }
export function runCardReplayBadgeTitle(sourceRunId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Replayed from a journal prefix (source run ${sourceRunId})`, 'zh-CN': `从 journal 前缀重放恢复（源 run ${sourceRunId}）` },
    locale,
  )
}
export function runCardSavedBadgeTitle(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Saved as workflow: ${name}`, 'zh-CN': `已保存工作流：${name}` },
    locale,
  )
}
export const RUN_CARD_SAVED_BADGE: LocalizedText = { en: 'Saved definition', 'zh-CN': '已保存定义' }
export function runCardNodesStat(done: number, total: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Nodes ${done}/${total}`, 'zh-CN': `节点 ${done}/${total}` }, locale)
}
export function runCardSubtreeStat(done: number, total: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Subtree ${done}/${total}`, 'zh-CN': `子树 ${done}/${total}` }, locale)
}
export function runCardTokensStat(tokens: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `${tokens.toLocaleString()} Tokens`, 'zh-CN': `${tokens.toLocaleString()} Token` },
    locale,
  )
}
export const RUN_CARD_MORE_ARIA: LocalizedText = { en: 'More actions', 'zh-CN': '更多操作' }
export const RUN_CARD_MORE_TITLE: LocalizedText = { en: 'More workflow actions', 'zh-CN': '更多工作流操作' }
export const RUN_CARD_REPLAY: LocalizedText = { en: 'Replay', 'zh-CN': '重放' }
export const RUN_CARD_SAVE_AS: LocalizedText = { en: 'Save as workflow', 'zh-CN': '保存为工作流' }
export const RUN_CARD_WORKBENCH_DETAILS: LocalizedText = { en: 'Workbench details', 'zh-CN': '工作台详情' }
export const RUN_CARD_DETACH_TITLE: LocalizedText = {
  en: 'Move this foreground-sync run to the background: the blocked tool call immediately returns a background handle, and a follow-up report arrives when the run completes',
  'zh-CN': '把该前台同步运行转入后台：阻塞中的工具调用立即返回后台句柄，运行完成后自动 followUp 汇报',
}
export const RUN_CARD_RESUME: LocalizedText = { en: 'Resume from checkpoint', 'zh-CN': '断点恢复' }
export const RUN_CARD_RESUME_TITLE: LocalizedText = {
  en: 'Resume from this run\'s journal checkpoint: replays the completed prefix and only re-runs failed/incomplete nodes (keeps the original script and args; no parameter or target changes)',
  'zh-CN': '从同 run 的 journal 断点恢复：重放已完成前缀，仅重跑失败/未完成节点（沿用原脚本与 args；不支持改参换目标）',
}
export function runCardSaveInvalidResult(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Save returned an invalid shape (unexpected action payload)', 'zh-CN': '保存返回结构不合法（动作返回非预期形状）' },
    locale,
  )
}
export function runCardSaveCreated(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Saved as workflow definition ${name} (visible in the workflow library)`, 'zh-CN': `已保存为工作流定义 ${name}（可在工作流库查看）` },
    locale,
  )
}
export function runCardSaveOverwritten(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Overwrote workflow definition ${name}`, 'zh-CN': `已覆盖工作流定义 ${name}` },
    locale,
  )
}
export function runCardReplayAccepted(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Replay accepted (source run ${runId}; the new run keeps the original conversation and script source)`,
      'zh-CN': `重放已受理（源 run ${runId}；新 run 保留原会话与原脚本源）`,
    },
    locale,
  )
}
export const RUN_KV_RUN_ID: LocalizedText = { en: 'Run ID', 'zh-CN': '运行 ID' }
export const RUN_KV_CREATED_AT: LocalizedText = { en: 'Started at', 'zh-CN': '发起时间' }
export const RUN_KV_UPDATED_AT: LocalizedText = { en: 'Updated at', 'zh-CN': '更新时间' }
export const RUN_KV_SOURCE_RUN: LocalizedText = { en: 'Source run', 'zh-CN': '源 run' }
export const RUN_KV_SAVED_DEF: LocalizedText = { en: 'Saved definition', 'zh-CN': '保存定义' }
export const RUN_NO_NODES: LocalizedText = { en: 'No node status yet', 'zh-CN': '暂无节点状态' }
export const RUN_RESULT_SECTION: LocalizedText = { en: 'Final output', 'zh-CN': '最终产出' }
export const RUN_COLLAPSE_RESULT: LocalizedText = { en: 'Collapse full result', 'zh-CN': '收起完整结果' }
export const RUN_EXPAND_RESULT: LocalizedText = { en: 'Expand full result', 'zh-CN': '展开完整结果' }

// Workflow node cards
export const NODE_BADGE_ACTION: LocalizedText = { en: 'Action', 'zh-CN': '动作' }
export const NODE_BADGE_EXTERNAL: LocalizedText = { en: 'External run', 'zh-CN': '外部执行' }
export const NODE_BADGE_SUBAGENT: LocalizedText = { en: 'Subagent node', 'zh-CN': '子代理节点' }
export const NODE_GATE_PASSED: LocalizedText = { en: 'Gate passed', 'zh-CN': 'Gate 通过' }
export const NODE_GATE_FAILED: LocalizedText = { en: 'Gate failed', 'zh-CN': 'Gate 失败' }
export function nodeAttemptBadge(attempt: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Attempt ${attempt}`, 'zh-CN': `第 ${attempt} 次` }, locale)
}
export const NODE_TAG_ERROR: LocalizedText = { en: 'Error', 'zh-CN': '错误' }
export const NODE_TAG_OUTPUT: LocalizedText = { en: 'Output', 'zh-CN': '产出' }
export const NODE_SECTION_PROMPT: LocalizedText = { en: 'Prompt', 'zh-CN': '指令' }
export const NODE_KV_STARTED_AT: LocalizedText = { en: 'Started at', 'zh-CN': '开始时间' }
export const NODE_KV_BACKEND: LocalizedText = { en: 'Backend', 'zh-CN': '执行后端' }
export const NODE_KV_EXTERNAL: LocalizedText = { en: 'External run', 'zh-CN': '外部执行' }
export const NODE_KV_NODE: LocalizedText = { en: 'Node', 'zh-CN': '执行节点' }
export const NODE_KV_CWD: LocalizedText = { en: 'Working directory', 'zh-CN': '工作目录' }
export const NODE_KV_WORKTREE: LocalizedText = { en: 'Worktree', 'zh-CN': '工作树' }
export const NODE_KV_MODEL: LocalizedText = { en: 'Model', 'zh-CN': '模型' }
export const NODE_KV_DURATION: LocalizedText = { en: 'Duration', 'zh-CN': '耗时' }
export const NODE_KV_TOKENS: LocalizedText = { en: 'Tokens', 'zh-CN': 'Token' }

// Replay form
export function replayMeta(runId: string, conversationId: number, savedName: string | undefined, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const sourceNote = resolveLocalizedText(
    savedName !== undefined
      ? { en: `saved definition ${savedName} executes the latest file content`, 'zh-CN': `已保存定义 ${savedName} 按最新文件内容执行` }
      : { en: 'inline script keeps its original source', 'zh-CN': '内联脚本沿用原源码' },
    locale,
  )
  return resolveLocalizedText(
    {
      en: `Source run ${runId} (conversation #${conversationId}; ${sourceNote})`,
      'zh-CN': `源 run ${runId}（会话 #${conversationId}；${sourceNote}）`,
    },
    locale,
  )
}
export const REPLAY_HINT: LocalizedText = {
  en: 'The cache only reuses prefix nodes whose call payloads match exactly; re-execution starts at the first mismatch, so changed args are not guaranteed to hit the cache and nodes with external side effects really re-run.',
  'zh-CN': '缓存仅复用调用载荷完全相同的前缀节点；首次载荷失配起真实重执行，改参不保证命中缓存，含外部副作用的节点会照实重跑。',
}
export const REPLAY_ARGS_PLACEHOLDER: LocalizedText = {
  en: 'args JSON (optional; blank keeps original args, non-empty strictly parsed)',
  'zh-CN': 'args JSON（可选；空白沿用原 args，非空严格解析）',
}
export function replayArgsAria(runId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `args JSON override for replaying run ${runId}`, 'zh-CN': `重放 run ${runId} 的 args JSON 覆盖` },
    locale,
  )
}
export const REPLAY_SUBMIT_ARIA: LocalizedText = { en: 'Start replay', 'zh-CN': '发起重放' }
export const REPLAY_SUBMIT_TITLE: LocalizedText = {
  en: 'Start a replay via resumeFromRunId (the new run keeps the original conversation; blank args keep the original args)',
  'zh-CN': '按 resumeFromRunId 发起重放（新 run 保留原会话；空白 args 沿用原 args）',
}
export const REPLAY_SUBMIT: LocalizedText = { en: 'Replay', 'zh-CN': '发起重放' }

// Model-layer run card copy (model-run.ts)
export function nodeAwaitingApproval(pendingAskTitle: string | undefined, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const fallback = resolveLocalizedText(
    { en: 'Awaiting human confirmation', 'zh-CN': '等待人工确认' },
    locale,
  )
  const label = resolveLocalizedText({ en: 'Awaiting approval: ', 'zh-CN': '等待审批：' }, locale)
  return `${label}${pendingAskTitle || fallback}`
}
export const NODE_RUNNING_FALLBACK: LocalizedText = { en: 'Running…', 'zh-CN': '执行中…' }
export const NODE_GATE_FAILED_FALLBACK: LocalizedText = { en: 'Gate check failed', 'zh-CN': 'Gate 验收未通过' }
export const NODE_EXECUTION_FAILED: LocalizedText = { en: 'Execution failed', 'zh-CN': '执行失败' }
export const NODE_SKIPPED: LocalizedText = { en: 'Skipped', 'zh-CN': '已跳过' }
export const NODE_QUEUED: LocalizedText = { en: 'Queued…', 'zh-CN': '排队等待执行…' }
export const DEFAULT_PHASE_TITLE: LocalizedText = { en: 'Default phase', 'zh-CN': '默认阶段' }

// ---------------------------------------------------------------------------
// Workflow library (screen / card / drawer)
// ---------------------------------------------------------------------------

export const LIB_SCREEN_TITLE: LocalizedText = { en: 'Workflow library', 'zh-CN': '工作流库' }
export function LIB_SCREEN_SUBTITLE(count: number, isSplit: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `${count} reusable orchestration assets${isSplit ? ' · split view' : ''}`,
      'zh-CN': `跨会话可复用编排资产 ${count} 个${isSplit ? ' · 分屏' : ''}`,
    },
    locale,
  )
}
export const LIB_REFRESH_TITLE: LocalizedText = { en: 'Reload the workflow library', 'zh-CN': '重新读取工作流目录' }
export const LIB_REFRESH: LocalizedText = { en: 'Refresh', 'zh-CN': '刷新' }
export const LIB_SEARCH_PLACEHOLDER: LocalizedText = {
  en: 'Search name, description or when-to-use…',
  'zh-CN': '搜索名称、描述或适用场景…',
}
export const LIB_SEARCH_ARIA: LocalizedText = { en: 'Search workflows', 'zh-CN': '搜索工作流' }
export const LIB_SEARCH_CLEAR_TITLE: LocalizedText = { en: 'Clear search', 'zh-CN': '清空搜索' }
export const LIB_SEARCH_CLEAR_ARIA: LocalizedText = { en: 'Clear search', 'zh-CN': '清空搜索' }
export const LIB_LOADING: LocalizedText = { en: 'Loading workflow library…', 'zh-CN': '工作流目录读取中…' }
export function LIB_LOAD_FAILED(error: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to load the workflow library: ${error}`, 'zh-CN': `读取工作流目录失败：${error}` },
    locale,
  )
}
export const LIB_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }
export const LIB_EMPTY: LocalizedText = {
  en: 'No saved workflows yet. After running SubagentWorkflow inline in a conversation, use "Save as workflow", or let the AI / CLI call the workflow save action to persist a definition.',
  'zh-CN': '暂无已保存工作流。在会话中用 SubagentWorkflow 内联运行后点「保存为工作流」，或让 AI / CLI 调用 workflow save 保存定义。',
}
export function LIB_NO_MATCH(query: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `No workflows match "${query}"`, 'zh-CN': `未找到匹配「${query}」的工作流` },
    locale,
  )
}
export function libListInvalid(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Workflow library returned an invalid shape (unexpected action payload)', 'zh-CN': '工作流目录返回结构不合法（动作返回非预期形状）' },
    locale,
  )
}
export function libCardAria(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `View workflow ${name} details`, 'zh-CN': `查看工作流 ${name} 详情` },
    locale,
  )
}
export function libMetadataError(error: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Metadata validation failed: ${error}`, 'zh-CN': `元数据校验失败：${error}` },
    locale,
  )
}
export const LIB_CARD_NO_DESCRIPTION: LocalizedText = { en: 'No description', 'zh-CN': '无描述' }
export function libPhases(count: number, titles: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${count} phases: ${titles}`, 'zh-CN': `${count} 阶段：${titles}` }, locale)
}
export function libDefinitionFileTitle(path: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Definition file: ${path}`, 'zh-CN': `定义文件：${path}` }, locale)
}
export const LIB_CARD_VIEW_DETAILS: LocalizedText = { en: 'View details', 'zh-CN': '查看详情' }
export const LIB_METADATA_BADGE: LocalizedText = { en: 'Metadata error', 'zh-CN': '元数据异常' }
export const LIB_KV_DESCRIPTION: LocalizedText = { en: 'Description', 'zh-CN': '描述' }
export const LIB_KV_WHEN_TO_USE: LocalizedText = { en: 'When to use', 'zh-CN': '适用场景' }
export const LIB_KV_PHASES: LocalizedText = { en: 'Phases', 'zh-CN': '阶段' }
export const LIB_PHASES_UNDECLARED: LocalizedText = { en: 'Not declared', 'zh-CN': '未声明' }
export const LIB_SOURCE_SECTION: LocalizedText = { en: 'Source (read-only)', 'zh-CN': '源码（只读）' }
export const LIB_SOURCE_RELOAD_TITLE: LocalizedText = { en: 'Reload source', 'zh-CN': '重新读取源码' }
export const LIB_SOURCE_LOADING: LocalizedText = { en: 'Loading source…', 'zh-CN': '源码读取中…' }
export function libDetailInvalid(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Definition detail returned an invalid shape (unexpected action payload; refusing to fabricate a view)', 'zh-CN': '定义详情返回结构不合法（动作返回非预期形状，拒绝伪造展示）' },
    locale,
  )
}
export function libSourceLoadFailed(error: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to load source: ${error}`, 'zh-CN': `读取源码失败：${error}` },
    locale,
  )
}
export const LIB_COPY_SOURCE: LocalizedText = { en: 'Copy full source', 'zh-CN': '复制完整源码' }
export const LIB_EDIT_HINT: LocalizedText = {
  en: 'Creating and modifying workflows is done by the AI / CLI via the save action; the Web UI does not provide a source editor.',
  'zh-CN': '工作流的创建与修改由 AI / CLI 调用 save 动作完成，Web 端不提供源码编辑器。',
}
export const LIB_RUN_SECTION: LocalizedText = { en: 'Run (pick a target conversation)', 'zh-CN': '运行（选择目标会话）' }
export const LIB_RUN_SELECT_PLACEHOLDER: LocalizedText = { en: 'Pick a target conversation', 'zh-CN': '选择目标会话' }
export const LIB_RUN_SELECT_ARIA: LocalizedText = { en: 'Pick the target conversation to run in', 'zh-CN': '选择运行目标会话' }
export const LIB_ARGS_PLACEHOLDER: LocalizedText = {
  en: 'args JSON (optional, strictly parsed)',
  'zh-CN': 'args JSON（可选，严格解析）',
}
export function libArgsAria(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `args JSON for workflow ${name}`, 'zh-CN': `工作流 ${name} 的 args JSON` },
    locale,
  )
}
export function libPickConversationFirst(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Pick a target conversation first', 'zh-CN': '请先选择目标会话' },
    locale,
  )
}
export const LIB_NO_TOP_LEVEL_CONVERSATIONS: LocalizedText = { en: 'No top-level conversations available', 'zh-CN': '无可用顶层会话' }
export function libRunButtonTitle(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Run workflow ${name} in the selected conversation`, 'zh-CN': `在选定会话运行工作流 ${name}` },
    locale,
  )
}
export const LIB_RUN: LocalizedText = { en: 'Run', 'zh-CN': '运行' }
export function libRunStarted(name: string, conversationId: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Workflow ${name} started in conversation #${conversationId}`, 'zh-CN': `工作流 ${name} 已在会话 #${conversationId} 启动` },
    locale,
  )
}
export function libRunFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to start workflow: ${err}`, 'zh-CN': `启动工作流失败：${err}` },
    locale,
  )
}
export function libDeleted(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Deleted workflow definition ${name} (historical runs are unaffected)`, 'zh-CN': `已删除工作流定义 ${name}（历史运行记录不受影响）` },
    locale,
  )
}
export const LIB_EDIT_SECTION: LocalizedText = { en: 'Let the AI edit', 'zh-CN': '让 AI 修改' }
export const LIB_EDIT_HINT_2: LocalizedText = {
  en: 'Copy the request below and send it to an AI in any conversation: it reads the source, applies the changes and writes them back via the save action; this page never edits files directly.',
  'zh-CN': '复制以下请求发给任意会话中的 AI，由它读取源码、修改并经 save 动作写回；本页不直接改动文件。',
}
export const LIB_COPY_EDIT_REQUEST: LocalizedText = { en: 'Copy edit request', 'zh-CN': '复制修改请求' }
export function libDeleteConfirm(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Delete workflow definition ${name}? Historical runs are kept.`, 'zh-CN': `确认删除工作流定义 ${name}？历史运行记录保留。` },
    locale,
  )
}
export const LIB_CANCEL: LocalizedText = { en: 'Cancel', 'zh-CN': '取消' }
export const LIB_DELETE_CONFIRM: LocalizedText = { en: 'Confirm delete', 'zh-CN': '确认删除' }
export const LIB_DELETING: LocalizedText = { en: 'Deleting…', 'zh-CN': '正在删除…' }
export const LIB_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }
export const LIB_DELETE: LocalizedText = { en: 'Delete', 'zh-CN': '删除' }
export const LIB_DELETE_TITLE: LocalizedText = {
  en: 'Delete the definition file (historical runs are unaffected)',
  'zh-CN': '删除定义文件（历史运行记录不受影响）',
}
export function libDrawerAria(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Workflow ${name} details`, 'zh-CN': `工作流 ${name} 详情` },
    locale,
  )
}
export function libArgsInvalidJson(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `args must be valid JSON: ${err}`, 'zh-CN': `args 需为合法 JSON：${err}` },
    locale,
  )
}

// AI-facing request builders (model-library.ts / model-worktree.ts)
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
export function workflowEditDescriptionLine(description: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `- Current description: ${description}`, 'zh-CN': `- 当前描述：${description}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Worktree inspect section
// ---------------------------------------------------------------------------

export function wtInspectInvalid(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: 'Inspection result has an invalid shape (unexpected action payload; refusing to fabricate a view)', 'zh-CN': '检视结果结构不合法（动作返回非预期形状，拒绝伪造展示）' },
    locale,
  )
}
export function wtSubmitFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Failed to submit the review request: ${err}`, 'zh-CN': `提交审阅请求失败：${err}` },
    locale,
  )
}
export const WT_SUBMITTED: LocalizedText = { en: 'Review request submitted to the main conversation', 'zh-CN': '已向主会话提交工作树审阅请求' }
export const WT_UNAVAILABLE_REMOVED: LocalizedText = {
  en: 'Registration cleaned up (the worktree has been removed)',
  'zh-CN': '登记已清理（工作树已被移除）',
}
export const WT_UNAVAILABLE_MISSING: LocalizedText = {
  en: 'Directory no longer exists (confirmed by a real probe on the node; the registration is kept)',
  'zh-CN': '目录已不存在（节点真实探测证实；登记仍保留）',
}
export function wtUnavailableCta(reason: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `${reason}; git inspection is unavailable. Showing registration metadata only.`, 'zh-CN': `${reason}，无法执行 git 检视；仅展示登记元数据。` },
    locale,
  )
}
export const WT_COLLAPSE_TITLE: LocalizedText = { en: 'Collapse the worktree change overview', 'zh-CN': '收起工作树改动概览' }
export const WT_EXPAND_TITLE: LocalizedText = {
  en: 'Expand the read-only worktree change overview (real git inspection on the target node)',
  'zh-CN': '展开工作树只读改动概览（目标节点真实 git 检视）',
}
export const WT_OVERVIEW: LocalizedText = { en: 'Change overview', 'zh-CN': '改动概览' }
export const WT_REINSPECT_TITLE: LocalizedText = { en: 'Re-inspect (read-only)', 'zh-CN': '重新检视（只读）' }
export const WT_REFRESH: LocalizedText = { en: 'Refresh', 'zh-CN': '刷新' }
export const WT_INSPECTING: LocalizedText = { en: 'Read-only inspection on the target node…', 'zh-CN': '目标节点只读检视中…' }
export const WT_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }
export function wtInspectFailed(error: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Read-only inspection failed: ${error}`, 'zh-CN': `只读检视失败：${error}` },
    locale,
  )
}
export const WT_KV_BRANCH: LocalizedText = { en: 'Branch', 'zh-CN': '分支' }
export function wtBranchMismatchBadgeTitle(branch: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Registered branch ${branch}; the worktree may have been switched`, 'zh-CN': `登记分支 ${branch}；工作树可能已被改签` },
    locale,
  )
}
export const WT_BRANCH_MISMATCH: LocalizedText = { en: 'Differs from registration', 'zh-CN': '与登记不一致' }
export const WT_KV_BASE: LocalizedText = { en: 'Base', 'zh-CN': '基线' }
export function wtBaseValue(baseCommit: string, diffBase: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const short = baseCommit.slice(0, 12)
  return resolveLocalizedText(
    {
      en: `${short} (${diffBase === 'HEAD' ? 'no base, against HEAD' : 'registered base'})`,
      'zh-CN': `${short}（${diffBase === 'HEAD' ? '无基线，按 HEAD' : '登记基线'}）`,
    },
    locale,
  )
}
export const WT_NO_BASE: LocalizedText = {
  en: 'No registered base (uncommitted changes inspected against HEAD)',
  'zh-CN': '无登记基线（按 HEAD 检视未提交改动）',
}
export const WT_KV_DIRTY: LocalizedText = { en: 'Uncommitted changes', 'zh-CN': '未提交修改' }
export function wtDirtyCount(count: number, truncated: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const suffix = truncated
    ? resolveLocalizedText({ en: ' (list truncated; showing the first items)', 'zh-CN': '（列表已截断，仅显示前若干项）' }, locale)
    : ''
  return resolveLocalizedText(
    { en: `${count} file${count > 1 ? 's' : ''}${suffix}`, 'zh-CN': `${count} 个文件${suffix}` },
    locale,
  )
}
export const WT_KV_AHEAD: LocalizedText = { en: 'Commits ahead of base', 'zh-CN': '领先基线提交' }
export function wtAheadCount(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${count}`, 'zh-CN': `${count} 个` }, locale)
}
export const WT_KV_HEAD: LocalizedText = { en: 'Current HEAD', 'zh-CN': '当前 HEAD' }
export const WT_NO_DIRTY: LocalizedText = { en: 'No uncommitted changes in the worktree', 'zh-CN': '工作区无未提交修改' }
export const WT_DIFF_NOTE: LocalizedText = {
  en: 'The diff covers tracked files only; untracked files are in the status list.',
  'zh-CN': 'Diff 仅包含已跟踪文件；未跟踪文件见状态列表。',
}
export function wtDiffStatSection(diffBase: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `Diff stats (vs ${diffBase === 'HEAD' ? 'HEAD' : 'base'})`,
      'zh-CN': `Diff 统计（相对${diffBase === 'HEAD' ? ' HEAD' : '基线'}）`,
    },
    locale,
  )
}
export const WT_DIFF_PREVIEW_SECTION: LocalizedText = { en: 'Diff preview (read-only, capped)', 'zh-CN': 'Diff 预览（只读，有上限）' }
export const WT_DIFF_TRUNCATED: LocalizedText = { en: 'Truncated', 'zh-CN': '已截断' }
export const WT_NO_DIFF: LocalizedText = { en: 'No tracked-file diff', 'zh-CN': '无已跟踪文件 diff' }
export const WT_REVIEW_BUTTON: LocalizedText = { en: 'Ask the main conversation to review and merge', 'zh-CN': '让主会话审阅并合入' }
export const WT_REVIEW_TITLE: LocalizedText = {
  en: 'Submit a review-and-merge request to the main conversation (actual inspection and merging are done there)',
  'zh-CN': '向主会话提交审阅与合入请求（实际检视与合入由主会话执行）',
}
export const WT_COPY_REVIEW: LocalizedText = { en: 'Copy review request', 'zh-CN': '复制审阅请求文本' }

// Review request text (model-worktree.ts)
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
    ? resolveLocalizedText({ en: ` (node ${input.nodeId})`, 'zh-CN': `（节点 ${input.nodeId}）` }, locale)
    : ''
  const baseSuffix = input.baseCommit !== undefined && input.baseCommit !== ''
    ? resolveLocalizedText(
        { en: ` (based on commit ${input.baseCommit.slice(0, 12)})`, 'zh-CN': `（基于提交 ${input.baseCommit.slice(0, 12)}）` },
        locale,
      )
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
export function wtReviewTaskLine(task: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `- Task: ${task}`, 'zh-CN': `- 任务：${task}` }, locale)
}
export function wtReviewInspectMissing(removed: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const reason = resolveLocalizedText(
    removed ? { en: 'registration cleaned up', 'zh-CN': '登记已清理' } : { en: 'directory missing', 'zh-CN': '不存在' },
    locale,
  )
  return resolveLocalizedText(
    { en: `- Inspection: ${reason}; nothing to inspect`, 'zh-CN': `- 检视：目录${reason}，无可检视改动` },
    locale,
  )
}
export function wtReviewDirtyLine(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `- Uncommitted changes: ${count} file${count > 1 ? 's' : ''}`, 'zh-CN': `- 未提交修改：${count} 个文件` },
    locale,
  )
}
export function wtReviewAheadLine(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `- Commits ahead of base: ${count}`, 'zh-CN': `- 领先基线提交：${count} 个` },
    locale,
  )
}
export function wtReviewBranchChanged(currentBranch: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `- Note: the worktree is currently on branch ${currentBranch}, which differs from the registered branch — it may have been switched; verify ownership first`,
      'zh-CN': `- 注意：工作树当前分支 ${currentBranch} 与登记分支不一致，可能已被改签，请先核实归属`,
    },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Active tray (bottom in-flight HUD)
// ---------------------------------------------------------------------------

export function trayCount(blocked: number, running: number, active: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  if (blocked > 0) {
    return running > 0
      ? resolveLocalizedText(
          { en: `${blocked} awaiting approval · ${running} running`, 'zh-CN': `${blocked} 项待审批 · ${running} 项运行中` },
          locale,
        )
      : resolveLocalizedText({ en: `${blocked} awaiting approval`, 'zh-CN': `${blocked} 项待审批` }, locale)
  }
  return resolveLocalizedText({ en: `${active} running`, 'zh-CN': `${active} 项运行中` }, locale)
}
export const TRAY_REGION_ARIA: LocalizedText = { en: 'In-flight orchestration tasks', 'zh-CN': '在途编排任务' }
export const TRAY_COLLAPSE: LocalizedText = { en: 'Collapse', 'zh-CN': '收起' }
export const TRAY_EXPAND: LocalizedText = { en: 'Expand', 'zh-CN': '展开' }
export const TRAY_WORKBENCH: LocalizedText = { en: 'Workbench', 'zh-CN': '工作台' }
export const TRAY_VIEW: LocalizedText = { en: 'View', 'zh-CN': '查看' }
export const TRAY_DETAILS: LocalizedText = { en: 'Details', 'zh-CN': '详情' }
export const TRAY_ABORT: LocalizedText = { en: 'Abort', 'zh-CN': '中止' }
export function trayActionFailed(action: 'abort' | 'detach', err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const label = resolveLocalizedText(
    action === 'abort' ? { en: 'Abort', 'zh-CN': '中止' } : { en: 'Move to background', 'zh-CN': '转入后台' },
    locale,
  )
  return resolveLocalizedText(
    { en: `${label} failed: ${err}`, 'zh-CN': `${label}失败：${err}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Execution tree rows (children rows / model-execution-view)
// ---------------------------------------------------------------------------

export function execOpenConversationLabel(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Open conversation #${id} drawer`, 'zh-CN': `打开会话 #${id} 抽屉` },
    locale,
  )
}
export function execCollapseChildrenLabel(title: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Collapse direct children of ${title}`, 'zh-CN': `收起 ${title} 直系子项` },
    locale,
  )
}
export function execExpandChildrenLabel(title: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Expand direct children of ${title}`, 'zh-CN': `展开 ${title} 直系子项` },
    locale,
  )
}
export function execOpenConversationTitle(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `Click to open conversation #${id} drawer`, 'zh-CN': `点击打开会话 #${id} 抽屉` },
    locale,
  )
}
export const EXEC_COLLAPSE_CHILDREN_TITLE: LocalizedText = { en: 'Click to collapse direct children', 'zh-CN': '点击收起直系子项' }
export const EXEC_EXPAND_CHILDREN_TITLE: LocalizedText = {
  en: 'Click to expand direct children (deep workflow / external run, no standalone conversation)',
  'zh-CN': '点击展开直系子项（深层工作流 / 外部执行，无独立会话）',
}
export function execApprovalBadge(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Approvals ${count}`, 'zh-CN': `审批 ${count}` }, locale)
}
export function execConversationTitle(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Subagent #${id}`, 'zh-CN': `子会话 #${id}` }, locale)
}
export const EXEC_EXTERNAL_FALLBACK: LocalizedText = { en: 'External run', 'zh-CN': '外部执行' }
export function execFrontlineConversation(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `#${id} running`, 'zh-CN': `#${id} 执行中` }, locale)
}
export function execFrontlineNamed(
  name: string,
  id: number,
  doing: string | undefined,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  if (doing !== undefined && doing !== '') {
    return `${name} (#${id}) · ${doing}`
  }
  return resolveLocalizedText({ en: `${name} (#${id}) running`, 'zh-CN': `${name} (#${id}) 执行中` }, locale)
}
export function execFrontlineContainer(label: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `${label} running`, 'zh-CN': `${label} 执行中` }, locale)
}
export function execApprovalItem(id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `#${id} awaiting approval`, 'zh-CN': `#${id} 等待审批` }, locale)
}
export function execApprovalItemNamed(name: string, id: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    { en: `${name} (#${id}) awaiting approval`, 'zh-CN': `${name} (#${id}) 等待审批` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Workbench panel
// ---------------------------------------------------------------------------

export const WORKBENCH_HEAD_TITLE: LocalizedText = { en: 'Current conversation tasks', 'zh-CN': '当前会话任务' }
export const WORKBENCH_LIBRARY: LocalizedText = { en: 'Workflow library', 'zh-CN': '工作流库' }
export const WORKBENCH_EMPTY_NO_CONVERSATION: LocalizedText = {
  en: 'Open a conversation first; the workbench will show its workflows and subagent tasks.',
  'zh-CN': '请先打开一个会话，工作台将展示当前会话的工作流与子代理任务。',
}
export const WORKBENCH_EMPTY_NO_RUNS: LocalizedText = {
  en: 'No workflow or subagent runs in this conversation yet.',
  'zh-CN': '当前会话暂无工作流或子代理运行记录。',
}
export const WORKBENCH_RESULT_SECTION: LocalizedText = { en: 'Run output', 'zh-CN': '运行产出' }
export const WORKBENCH_RESUME_FAILED_TITLE: LocalizedText = {
  en: 'Batch-resume auto-resumable failed tasks in the current conversation',
  'zh-CN': '批量恢复当前会话下可自动续跑的失败任务',
}
export function workbenchResumeFailedButton(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Resume failed (${count})`, 'zh-CN': `恢复失败 (${count})` }, locale)
}
export function workbenchResumeInvalidResult(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: 'Batch resume returned an invalid shape (unexpected action payload)',
      'zh-CN': '批量恢复返回结构不合法（动作返回非预期形状）',
    },
    locale,
  )
}
export function workbenchResumeAllSkipped(skippedCount: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    {
      en: `No new resume tasks started (skipped ${skippedCount} non-auto-resumable task${skippedCount === 1 ? '' : 's'})`,
      'zh-CN': `未拉起新恢复任务（跳过 ${skippedCount} 个不可自动恢复任务）`,
    },
    locale,
  )
}
export const WORKBENCH_RESUME_NONE_NEEDED: LocalizedText = {
  en: 'No failed tasks need resuming',
  'zh-CN': '当前没有需要恢复的失败任务',
}
export function workbenchResumeStarted(
  resumedCount: number,
  skippedCount: number,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  if (skippedCount > 0) {
    return resolveLocalizedText(
      {
        en: `Initiated resume for ${resumedCount} failed task${resumedCount === 1 ? '' : 's'} (skipped ${skippedCount} non-auto-resumable)`,
        'zh-CN': `已发起恢复 ${resumedCount} 个失败任务，跳过 ${skippedCount} 个不可自动恢复任务`,
      },
      locale,
    )
  }
  return resolveLocalizedText(
    {
      en: `Initiated resume for ${resumedCount} failed task${resumedCount === 1 ? '' : 's'}`,
      'zh-CN': `已发起恢复 ${resumedCount} 个失败任务`,
    },
    locale,
  )
}
export function workbenchResumeFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText({ en: `Batch resume failed: ${err}`, 'zh-CN': `批量恢复失败：${err}` }, locale)
}
