/**
 * Conversation timeline / tool bodies / markdown / outline display copy.
 * Owner: the timeline partition (see AGENTS.md i18n split).
 *
 * zh-CN copy is backfilled verbatim from the pre-English-migration baseline
 * (b4a611a65^) wherever the same string existed; new strings follow the
 * product glossary. Server/execution error text is never routed through this
 * table — it only enters as an interpolated {param}.
 */
import type { MessageTable } from '../messages.js'

export const conversationMessages = {
  // --- Attachments (timeline chips + inline media) -------------------------
  'conv.attachment.imageFailed': { en: 'Image failed to load: {reason}', 'zh-CN': '图片加载失败：{reason}' },
  'conv.attachment.clickToEnlarge': { en: 'Click to enlarge: {name}', 'zh-CN': '点击放大：{name}' },
  'conv.attachment.previewName': { en: 'Preview {name}', 'zh-CN': '预览 {name}' },
  'conv.attachment.clickToPreview': { en: 'Click to preview: {label}', 'zh-CN': '点击预览：{label}' },
  'conv.attachment.clickToPreviewArtifact': { en: 'Click to preview artifact', 'zh-CN': '点击预览产物' },
  'conv.attachment.fallbackLabel': { en: 'Artifacts', 'zh-CN': '产物' },

  // --- Input origin / queued-input badges -----------------------------------
  'conv.origin.agentReport': { en: 'From agent report', 'zh-CN': '来自智能体汇报' },
  'conv.origin.trigger': { en: 'From trigger', 'zh-CN': '来自触发器' },
  'conv.queued.steer': { en: 'Steer · injected at the next step boundary', 'zh-CN': '插话引导 · 待当前步骤后注入' },
  'conv.queued.followUp': { en: 'Queued · sent after the current turn ends', 'zh-CN': '排队中 · 待当前回合结束后发送' },

  // --- Human message row -----------------------------------------------------
  'conv.human.expandFullText': { en: 'Expand full text ({count} chars)', 'zh-CN': '展开全文（{count} 字符）' },
  'conv.human.cannotEditTitle': { en: 'Cannot edit this message', 'zh-CN': '无法编辑该消息' },
  'conv.human.cannotEditBody': {
    en: 'Message anchor invalid (entryId={entryId}); edit cancelled.',
    'zh-CN': '消息锚点无效（entryId={entryId}），已取消编辑。',
  },
  'conv.human.withdrawQueueAndEdit': { en: 'Withdraw queue and edit', 'zh-CN': '撤回排队并编辑' },
  'conv.human.editAndResend': { en: 'Edit and resend', 'zh-CN': '编辑并重发' },
  'conv.human.forkFromMessage': { en: 'Fork a new conversation from this message', 'zh-CN': '从此消息分叉新会话' },
  'conv.human.sentAt': { en: 'Sent at {time}', 'zh-CN': '发送于 {time}' },

  // --- Context dividers -------------------------------------------------------
  'conv.divider.handoffSummary': { en: 'Handoff summary', 'zh-CN': '交接摘要' },
  'conv.divider.compactionSummary': { en: 'Compaction summary', 'zh-CN': '精简摘要' },
  'conv.divider.compacting': { en: 'Compacting context…', 'zh-CN': '正在精简上下文…' },
  'conv.divider.reset': { en: 'Context reset', 'zh-CN': '上下文已重置' },
  'conv.divider.compacted': { en: 'Context compacted', 'zh-CN': '上下文已精简' },
  'conv.divider.collapse': { en: 'Collapse {label}', 'zh-CN': '收起{label}' },
  'conv.divider.expand': { en: 'Expand {label}', 'zh-CN': '展开{label}' },

  // --- Resolved asks ----------------------------------------------------------
  'conv.ask.approved': { en: 'Approved', 'zh-CN': '已批准' },
  'conv.ask.cancelled': { en: 'Cancelled', 'zh-CN': '已取消' },
  'conv.ask.superseded': { en: 'Handled by terminal (superseded)', 'zh-CN': '已由终端处理 (superseded)' },
  'conv.ask.rowTitle': { en: 'Approval', 'zh-CN': '审批' },

  // --- Turn failure ------------------------------------------------------------
  'conv.turnFailed.label': { en: 'This turn failed', 'zh-CN': '本回合失败' },
  'conv.turnFailed.prefix': { en: 'This turn failed: ', 'zh-CN': '本回合失败：' },
  'conv.turnFailed.fallback': {
    en: 'The model or service request failed; no reply was produced.',
    'zh-CN': '模型或服务请求未成功，未产生回答。',
  },
  'conv.turnFailed.editLatest': { en: 'Edit and resend the latest message', 'zh-CN': '编辑并重发最近一条消息' },

  // --- Timeline leading states -------------------------------------------------
  'conv.timeline.loadingHistory': { en: 'Loading history…', 'zh-CN': '正在加载历史…' },
  'conv.timeline.loadEarlier': { en: 'Load earlier messages', 'zh-CN': '加载更早的消息' },
  'conv.timeline.loadingConversation': { en: 'Loading conversation…', 'zh-CN': '正在加载会话…' },
  'conv.timeline.empty': {
    en: 'Describe your goal to the assistant, or pick a conversation on the left to start',
    'zh-CN': '向助理描述目标，或从左侧选择会话开始',
  },
  'conv.timeline.generating': { en: 'Generating', 'zh-CN': '正在生成' },
  'conv.timeline.backToBottom': { en: 'Back to bottom', 'zh-CN': '回到底部' },
  'conv.timeline.cardsLabel': { en: 'Timeline cards', 'zh-CN': '时间线卡片' },

  // --- Tool trace rows ----------------------------------------------------------
  'conv.tool.statusRunning': { en: 'Running', 'zh-CN': '运行中' },
  'conv.tool.statusFailed': { en: 'Failed', 'zh-CN': '失败' },
  'conv.tool.statusCompleted': { en: 'Completed', 'zh-CN': '完成' },
  'conv.tool.viewLabel': { en: 'Tool view {name}', 'zh-CN': '工具视图 {name}' },

  // --- Thinking / step groups ----------------------------------------------------
  'conv.thinking.stepsActive': { en: 'Thinking ({count} steps)…', 'zh-CN': '正在思考 ({count} 步)…' },
  'conv.thinking.steps': { en: 'Thinking ({count} steps)', 'zh-CN': '思考过程 ({count} 步)' },
  'conv.thinking.execActive': { en: 'Thinking and executing ({count} steps)…', 'zh-CN': '正在思考与执行 ({count} 步)…' },
  'conv.thinking.exec': { en: 'Thinking and execution ({count} steps)', 'zh-CN': '思考与执行过程 ({count} 步)' },
  'conv.thinking.collapseExec': { en: 'Collapse thinking and execution', 'zh-CN': '收起思考与执行过程' },
  'conv.thinking.expandExec': { en: 'Expand thinking and execution', 'zh-CN': '展开思考与执行过程' },
  'conv.thinking.errorCount': { en: '{count} failed', 'zh-CN': '含 {count} 项失败' },
  'conv.thinking.collapseThinking': { en: 'Collapse thinking', 'zh-CN': '收起思考过程' },
  'conv.thinking.expandThinking': { en: 'Expand thinking', 'zh-CN': '展开思考过程' },
  'conv.thinking.activeLabel': { en: 'Thinking…', 'zh-CN': '正在思考…' },
  'conv.thinking.label': { en: 'Thinking', 'zh-CN': '思考过程' },

  // --- Assistant turn footer / model identity ------------------------------------
  'conv.model.boundarySwitchedTo': { en: 'Effective model switched to {model}', 'zh-CN': '实际生成模型切换为 {model}' },
  'conv.model.boundarySwitched': { en: 'Effective model switched: {model}', 'zh-CN': '实际生成模型已切换：{model}' },
  'conv.model.effective': { en: 'Effective model: {model}', 'zh-CN': '实际生成模型：{model}' },
  'conv.model.thinkingSuffix': { en: '{base} · thinking {level}', 'zh-CN': '{base} · 思考 {level}' },
  'conv.turn.completedAtTook': { en: 'Completed at {time} · took {duration}', 'zh-CN': '完成于 {time} · 耗时 {duration}' },
  'conv.turn.completedAt': { en: 'Completed at {time}', 'zh-CN': '完成于 {time}' },
  'conv.turn.took': { en: 'Took {duration}', 'zh-CN': '耗时 {duration}' },
  'conv.turn.forkFromHere': { en: 'Fork a new conversation from here', 'zh-CN': '从此处分叉新会话' },

  // --- Conversation pane header / errors ---------------------------------------------
  'conv.pane.loadFailed': { en: 'Conversation #{id} failed to load: {error}', 'zh-CN': '会话 #{id} 加载失败：{error}' },
  'conv.pane.loading': { en: 'Loading conversation #{id}…', 'zh-CN': '正在加载会话 #{id}…' },
  'conv.pane.actionFailedTitle': { en: '{title} failed', 'zh-CN': '{title}失败' },
  'conv.pane.conversationRenamed': { en: 'Conversation renamed', 'zh-CN': '已重命名会话' },
  'conv.pane.ancestorNav': { en: 'Ancestor conversation navigation', 'zh-CN': '祖先会话导航' },
  'conv.pane.ancestorFallback': { en: 'Conversation {label}', 'zh-CN': '会话 {label}' },
  'conv.pane.goToAncestor': { en: 'Go to ancestor conversation #{id}', 'zh-CN': '前往祖先会话 #{id}' },
  'conv.pane.titleFallback': { en: 'Conversation #{id}', 'zh-CN': '会话 #{id}' },
  'conv.pane.metaConversationId': { en: 'Conversation ID', 'zh-CN': '会话 ID' },
  'conv.pane.metaAgents': { en: 'Agents', 'zh-CN': '智能体' },
  'conv.pane.metaNode': { en: 'Node', 'zh-CN': '节点' },
  'conv.pane.metaCwd': { en: 'Working directory', 'zh-CN': '工作目录' },
  'conv.pane.cwdNotSet': { en: '(not set)', 'zh-CN': '(未设置)' },
  'conv.pane.metaOwnership': { en: 'Ownership', 'zh-CN': '归属' },
  'conv.pane.metaModel': { en: 'Model', 'zh-CN': '模型' },
  'conv.pane.newTopic': { en: 'New topic', 'zh-CN': '新话题' },
  'conv.pane.newTopicTitle': { en: 'Start a new topic under the current agent', 'zh-CN': '在当前智能体下开始新话题' },
  'conv.pane.workbenchWithCount': { en: 'Workbench ({count})', 'zh-CN': '工作台（{count}）' },
  'conv.pane.workbench': { en: 'Workbench', 'zh-CN': '工作台' },
  'conv.pane.workbenchTitle': {
    en: 'Expand the right workbench (plugin panels and artifacts)',
    'zh-CN': '展开右侧工作台（插件面板与产物）',
  },
  'conv.pane.fullscreen': { en: 'Fullscreen', 'zh-CN': '全屏' },
  'conv.pane.openFullscreen': { en: 'Open this conversation fullscreen', 'zh-CN': '全屏打开此会话' },
  'conv.pane.openFullscreenTitle': {
    en: 'Open this conversation fullscreen in the main view',
    'zh-CN': '在主屏中全屏打开此会话',
  },
  'conv.pane.moreActions': { en: 'More conversation actions', 'zh-CN': '更多会话操作' },
  'conv.pane.renameConversation': { en: 'Rename conversation', 'zh-CN': '重命名会话' },
  'conv.pane.compactionSubmitted': { en: 'Compaction submitted', 'zh-CN': '精简任务已提交' },
  'conv.pane.compactContext': { en: 'Compact context (/compact)', 'zh-CN': '精简上下文 (/compact)' },
  'conv.pane.restored': { en: 'Conversations restored', 'zh-CN': '已恢复会话' },
  'conv.pane.archived': { en: 'Conversations archived', 'zh-CN': '已归档会话' },
  'conv.pane.restoreConversation': { en: 'Restore conversation', 'zh-CN': '恢复会话' },
  'conv.pane.archiveConversation': { en: 'Archive conversation', 'zh-CN': '归档会话' },
  'conv.pane.resetContextCmd': { en: 'Reset context (/reset)', 'zh-CN': '重置上下文 (/reset)' },
  'conv.pane.deleteConversation': { en: 'Delete conversation', 'zh-CN': '删除会话' },
  'conv.pane.closeDrawerAria': { en: 'Close drawer', 'zh-CN': '关闭抽屉' },
  'conv.pane.closeChildDrawer': { en: 'Close child conversation drawer (Esc)', 'zh-CN': '关闭子会话抽屉 (Esc)' },
  'conv.pane.childEnv': { en: 'Child conversation environment', 'zh-CN': '子会话环境上下文' },
  'conv.pane.ownerBadge': { en: 'Owner {owner}', 'zh-CN': '归属 {owner}' },
  'conv.pane.resetConfirmTitle': { en: 'Reset the context of conversation #{id}?', 'zh-CN': '重置会话 #{id} 的上下文？' },
  'conv.pane.resetConfirmDesc': {
    en: 'History is preserved; the model starts from a fresh context.',
    'zh-CN': '历史消息保留，模型将从全新上下文开始。',
  },
  'conv.pane.resetConfirmAction': { en: 'Reset context', 'zh-CN': '重置上下文' },
  'conv.pane.contextReset': { en: 'Context reset', 'zh-CN': '上下文已重置' },
  'conv.pane.deleteConfirmTitle': { en: 'Delete conversation #{id}?', 'zh-CN': '确定删除会话 #{id} 吗？' },
  'conv.pane.deleteConfirmDesc': { en: 'This action cannot be undone.', 'zh-CN': '此操作无法撤销。' },
  'conv.pane.conversationDeleted': { en: 'Conversation deleted', 'zh-CN': '已删除会话' },
  'conv.pane.conversationDeletedBody': { en: 'Conversation #{id} deleted', 'zh-CN': '会话 #{id} 已删除' },
  'conv.pane.deleteFailed': { en: 'Failed to delete conversation', 'zh-CN': '删除会话失败' },

  // --- Child conversation drawer ---------------------------------------------------
  'conv.drawer.closeChild': { en: 'Close child conversation drawer', 'zh-CN': '关闭子会话抽屉' },
  'conv.drawer.title': { en: 'Child conversation #{id} drawer', 'zh-CN': '子会话 #{id} 抽屉' },

  // --- Outline popover ---------------------------------------------------------------
  'conv.outline.trigger': { en: 'Outline', 'zh-CN': '大纲' },
  'conv.outline.searchPlaceholder': { en: 'Search questions, replies and cards…', 'zh-CN': '搜索提问、回复与卡片…' },
  'conv.outline.accessibility': { en: 'Conversation outline', 'zh-CN': '会话大纲' },
  'conv.outline.nav': { en: '{label} navigation', 'zh-CN': '{label}导航' },
  'conv.outline.triggerTitle': {
    en: 'Conversation outline navigation ({count} question turns)',
    'zh-CN': '会话大纲导航（共 {count} 轮提问）',
  },
  'conv.outline.filter': { en: 'Filter {label}', 'zh-CN': '筛选{label}' },
  'conv.outline.clearSearchAria': { en: 'Clear outline search', 'zh-CN': '清空大纲搜索' },
  'conv.outline.clearSearch': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'conv.outline.modeSwitch': { en: 'Outline level switch', 'zh-CN': '大纲层级切换' },
  'conv.outline.modeDialogue': { en: 'Conversation', 'zh-CN': '对话' },
  'conv.outline.modeQuestions': { en: 'Questions only', 'zh-CN': '仅提问' },
  'conv.outline.loadingEarlier': { en: 'Loading earlier history…', 'zh-CN': '正在加载更早历史…' },
  'conv.outline.loadEarlier': {
    en: 'Load earlier messages to complete the outline',
    'zh-CN': '加载更早的消息以补全大纲',
  },
  'conv.outline.entries': { en: 'Conversation outline entries', 'zh-CN': '会话大纲条目' },
  'conv.outline.noMatches': { en: 'No matching outline entries', 'zh-CN': '没有匹配的大纲条目' },
  'conv.outline.markdownTitle': { en: 'Markdown outline ({count} sections)', 'zh-CN': 'Markdown 大纲（共 {count} 个章节）' },
  'conv.outline.markdownSearch': { en: 'Search section titles…', 'zh-CN': '搜索章节标题…' },
  'conv.outline.markdownAccessibility': { en: 'Markdown outline', 'zh-CN': 'Markdown 大纲' },
  'conv.outline.assistantGenerating': { en: 'Generating…', 'zh-CN': '生成中…' },
  'conv.outline.assistantNoContent': { en: 'No content', 'zh-CN': '无正文' },
  'conv.outline.attachmentLabel': { en: '[attachment ×{count}]', 'zh-CN': '[附件 ×{count}]' },
  'conv.outline.emptyMessage': { en: '(empty message)', 'zh-CN': '（空消息）' },

  // --- Code blocks ---------------------------------------------------------------------
  'conv.codeblock.renderFailed': { en: 'Code block extension render failed', 'zh-CN': '代码块扩展渲染失败' },
  'conv.codeblock.retryLoading': { en: 'Retry loading', 'zh-CN': '重试加载' },
  'conv.codeblock.loadingRenderer': { en: 'Loading {language} renderer...', 'zh-CN': '正在加载 {language} 渲染组件...' },
  'conv.codeblock.viewBoundary': { en: '{language} render', 'zh-CN': '{language} 渲染' },
  'conv.codeblock.highlightFailed': {
    en: 'Syntax highlighting failed to load; full source shown below.',
    'zh-CN': '语法高亮加载失败，以下显示完整源码。',
  },

  // --- Edit diff views ------------------------------------------------------------------
  'conv.diff.expandRemaining': { en: 'Expand remaining {count} lines', 'zh-CN': '展开剩余 {count} 行' },
  'conv.diff.missingArgs': {
    en: 'Missing oldText/newText arguments; cannot compute change hunks (see raw data below).',
    'zh-CN': '缺少 oldText/newText 入参，无法计算变更片段（见下方原始数据）。',
  },
  'conv.diff.skipped': {
    en: 'Hunk diff not computed: {reason}. Diff computation was skipped to keep the UI responsive; expand the raw data for the full oldText/newText.',
    'zh-CN': '片段差异未计算：{reason}。为避免阻塞界面已跳过差异计算，可展开原始数据查看完整 oldText/newText。',
  },
  'conv.diff.tooLong': {
    en: 'Hunk diff too long; only the first {count} lines kept; +{added} −{removed}',
    'zh-CN': '片段差异过长，仅保留前 {count} 行；+{added} −{removed}',
  },
  'conv.diff.statsCoverAll': {
    en: 'Stats cover all changed lines; see raw data below for the full content.',
    'zh-CN': '统计覆盖全部变更行，完整内容见下方原始数据。',
  },
  'conv.diff.unchangedOmitted': { en: '… unchanged lines omitted …', 'zh-CN': '… 已省略未改动的行 …' },
  'conv.diff.someOmitted': {
    en: 'Some diff content was omitted due to length limits or redaction and cannot be recovered by expanding; +{added} −{removed} stats cover the whole replacement.',
    'zh-CN': '部分差异因长度限制或脱敏省略，展开也无法取回未传输内容；+{added} −{removed} 统计覆盖整个替换。',
  },

  // --- Server truncation / full-text fetch ------------------------------------------------
  'conv.trunc.fetchFailed': {
    en: 'Failed to fetch full text: {error}. The content above is still the server preview, not the full output.',
    'zh-CN': '取回全文失败：{error}。以上仍为服务端预览，不代表完整输出。',
  },
  'conv.trunc.unknownError': { en: 'Unknown error', 'zh-CN': '未知错误' },
  'conv.trunc.retryFetch': { en: 'Retry fetch', 'zh-CN': '重试取回' },
  'conv.trunc.stillTruncated': {
    en: 'The server entry was fetched but is still marked truncated; no extra content was obtained.',
    'zh-CN': '已取回服务端条目，但服务端仍标记截断，未能获得更多内容。',
  },
  'conv.trunc.linesTotalParens': { en: ' ({count} lines in total)', 'zh-CN': '（全文 {count} 行）' },
  'conv.trunc.spillNote': {
    en: '; the entry holds only the Spill preview — see the artifact entry below for the full text',
    'zh-CN': '；条目仅存 Spill 预览，完整原文见下方产物入口',
  },
  'conv.trunc.fetchingFullText': { en: 'Fetching full text…', 'zh-CN': '正在取回全文…' },
  'conv.trunc.expandFullText': { en: 'Expand full text{total}', 'zh-CN': '展开全文{total}' },
  'conv.trunc.previewOnly': {
    en: 'Output too long; the server returned a preview only',
    'zh-CN': '输出超长，服务端仅传回预览',
  },
  'conv.trunc.previewOnlyWithTotal': {
    en: 'Output too long; the server returned a preview only ({total})',
    'zh-CN': '输出超长，服务端仅传回预览（{total}）',
  },
  'conv.trunc.linesTotal': { en: '{count} lines in total', 'zh-CN': '全文 {count} 行' },
  'conv.trunc.charsTotal': { en: '{count} chars in total', 'zh-CN': '全文 {count} 字符' },

  // --- Copy gate (preview must never be copied as full text) -------------------------------
  'conv.copy.spillPreviewTitle': {
    en: 'This is a Spill artifact preview; open the full artifact to view or copy the whole text',
    'zh-CN': '这是 Spill 产物预览；请打开完整产物查看或复制全文',
  },
  'conv.copy.fetchingTitle': {
    en: 'Fetching full text from the server; copy becomes available once done',
    'zh-CN': '正在从服务端取回全文，完成后可复制',
  },
  'conv.copy.truncatedTitle': {
    en: 'Output is a server-truncated preview; the full text must be fetched before copying',
    'zh-CN': '输出为服务端截断预览，展开全文取回原文后才可复制',
  },
  'conv.copy.disabledAria': { en: '{label} (disabled: preview content)', 'zh-CN': '{label}（已禁用：内容为预览）' },

  // --- Raw tool data --------------------------------------------------------------------
  'conv.raw.toggle': { en: 'Raw data', 'zh-CN': '原始数据' },
  'conv.raw.inputJson': { en: 'Input (JSON)', 'zh-CN': '入参（JSON）' },
  'conv.raw.copyInputJson': { en: 'Copy input JSON', 'zh-CN': '复制入参 JSON' },
  'conv.raw.output': { en: 'Raw output', 'zh-CN': '原始输出' },
  'conv.raw.copyOutput': { en: 'Copy raw output', 'zh-CN': '复制原始输出' },
  'conv.raw.structuredJson': { en: 'Structured result (JSON)', 'zh-CN': '结构化结果（JSON）' },
  'conv.raw.copyStructured': { en: 'Copy structured result', 'zh-CN': '复制结构化结果' },

  // --- Edit tool body ----------------------------------------------------------------------
  'conv.edit.pendingHunks': { en: 'Pending change hunks{path}', 'zh-CN': '待执行的变更片段{path}' },
  'conv.edit.errorLabel': { en: 'Error{path}', 'zh-CN': '错误{path}' },
  'conv.edit.noErrorDetails': { en: '(no error details)', 'zh-CN': '（无错误详情）' },
  'conv.edit.requestedHunksFailed': {
    en: 'Requested change hunks (execution failed; file state undetermined)',
    'zh-CN': '请求的变更片段（执行失败，不判定文件是否已变）',
  },
  'conv.edit.appliedDiff': { en: 'Applied diff · {path} · +{added} −{removed}', 'zh-CN': '已应用的差异 · {path} · +{added} −{removed}' },
  'conv.edit.succeededNoDiff': { en: 'Execution succeeded · diff data unavailable', 'zh-CN': '执行成功 · 差异数据不可用' },
  'conv.edit.invalidMeta': {
    en: 'edit succeeded but diff metadata is missing or invalid ({reason}), so the real file diff cannot be shown; the raw input and output are kept below without fabricating file context.',
    'zh-CN': 'edit 成功但差异元数据缺失或非法（{reason}），无法展示真实文件差异；以下保留原始入参与输出，不伪造文件上下文。',
  },
  'conv.edit.missingStructured': { en: 'missing structuredOutput', 'zh-CN': '缺少 structuredOutput' },
  'conv.edit.resultUnknown': { en: 'Result unknown{path}', 'zh-CN': '结果未知{path}' },
  'conv.edit.noResult': {
    en: 'The tool returned no result (possibly not executed or interrupted); whether the change applied is undetermined; raw input below.',
    'zh-CN': '工具未返回结果（可能未执行或已中断），不判定变更是否已应用；原始入参如下。',
  },

  // --- Write tool body ------------------------------------------------------------------------
  'conv.write.pending': { en: 'Pending write', 'zh-CN': '待写入' },
  'conv.write.contentFailed': { en: 'Write content (execution failed)', 'zh-CN': '写入内容（执行失败）' },
  'conv.write.content': { en: 'Write content', 'zh-CN': '写入内容' },
  'conv.write.contentUnknown': { en: 'Write content (result unknown)', 'zh-CN': '写入内容（结果未知）' },
  'conv.write.wroteBytes': { en: ' · wrote {bytes}', 'zh-CN': ' · 已写入 {bytes}' },
  'conv.write.missingContent': { en: 'Missing content argument (see raw data below).', 'zh-CN': '缺少 content 入参（见下方原始数据）。' },
  'conv.write.copySource': { en: 'Copy source', 'zh-CN': '复制源码' },

  // --- Shared tool-body counters -----------------------------------------------------------------
  'conv.tool.linesTotal': { en: '{count} lines in total', 'zh-CN': '共 {count} 行' },
  'conv.tool.firstOfLines': { en: 'first {shown} / {total} lines', 'zh-CN': '前 {shown} / {total} 行' },
  'conv.tool.linesPreviewed': { en: '{count} lines previewed', 'zh-CN': '预览 {count} 行' },
  'conv.tool.firstOfPreview': { en: 'first {shown} / {total} lines previewed', 'zh-CN': '预览前 {shown} / {total} 行' },
  'conv.tool.expandAll': { en: 'Expand all ({count} lines)', 'zh-CN': '展开全部（共 {count} 行）' },
  'conv.tool.collapsedBelow': { en: '{count} lines collapsed below', 'zh-CN': '已折叠后 {count} 行' },
  'conv.tool.collapsedAbove': { en: '{count} lines collapsed above', 'zh-CN': '已折叠前 {count} 行' },
  'conv.tool.openFullArtifact': { en: 'Open full artifact #{id}', 'zh-CN': '打开完整产物 #{id}' },

  // --- Read tool body ------------------------------------------------------------------------------
  'conv.read.failed': { en: 'Read failed', 'zh-CN': '读取失败' },
  'conv.read.reading': { en: 'Reading', 'zh-CN': '读取中' },
  'conv.read.result': { en: 'Read result', 'zh-CN': '读取结果' },
  'conv.read.nothingYet': { en: 'Nothing read yet.', 'zh-CN': '尚无读取内容。' },
  'conv.read.noOutput': { en: 'No content output.', 'zh-CN': '无内容输出。' },
  'conv.read.withArtifacts': { en: 'Read result (with artifact references)', 'zh-CN': '读取结果（含产物引用）' },
  'conv.read.headPreviewNote': {
    en: 'This is the head preview of the output; see the artifact entry below for the full content.',
    'zh-CN': '以上为输出头部预览，完整内容见下方产物入口。',
  },
  'conv.read.copyContent': { en: 'Copy content', 'zh-CN': '复制内容' },

  // --- Bash tool body -------------------------------------------------------------------------------
  'conv.bash.command': { en: 'Command', 'zh-CN': '命令' },
  'conv.bash.noExitCode': { en: 'No exit code', 'zh-CN': '无退出码' },
  'conv.bash.exitCode': { en: 'Exit code {code}', 'zh-CN': '退出码 {code}' },
  'conv.bash.exitCodeNonZero': { en: 'Exit code {code}(non-zero)', 'zh-CN': '退出码 {code}（非 0）' },
  'conv.bash.timedOut': { en: ' · timed out', 'zh-CN': ' · 已超时' },
  'conv.bash.executing': { en: 'Executing; no output yet.', 'zh-CN': '执行中，暂无输出。' },
  'conv.bash.noOutput': { en: '(no output)', 'zh-CN': '（无输出）' },
  'conv.bash.output': { en: 'Output', 'zh-CN': '输出' },
  'conv.bash.outputExecuting': { en: 'Output (executing)', 'zh-CN': '输出（执行中）' },

  // --- Generic tool body ------------------------------------------------------------------------------
  'conv.generic.input': { en: 'Input', 'zh-CN': '入参' },
  'conv.generic.output': { en: 'Output', 'zh-CN': '输出' },

  // --- Tool row stats (tool-body-model) ------------------------------------------------------------------
  'conv.stats.appliedDiff': { en: 'Applied diff stats', 'zh-CN': '已应用差异统计' },
  'conv.stats.pendingHunks': { en: 'Pending change hunks (not applied yet)', 'zh-CN': '待执行变更片段统计（尚未应用）' },
  'conv.stats.writtenLines': { en: 'Written lines', 'zh-CN': '写入内容行数' },
  'conv.stats.linesCount': { en: '{count} lines', 'zh-CN': '{count} 行' },

  // --- Timeline entry actions (notices) -------------------------------------------------------------------
  'conv.fork.createdTitle': { en: 'Forked conversation created', 'zh-CN': '已创建分叉会话' },
  'conv.fork.failedTitle': { en: 'Fork failed', 'zh-CN': '分叉失败' },
  'conv.withdraw.cannotTitle': { en: 'Cannot withdraw queued message', 'zh-CN': '无法撤回排队消息' },
  'conv.withdraw.enteredExecutionBody': {
    en: 'Submission entered execution (status={status})',
    'zh-CN': '提交已进入执行（status={status}）',
  },
  'conv.withdraw.failedTitle': { en: 'Failed to withdraw queued message', 'zh-CN': '撤回排队消息失败' },
} satisfies MessageTable
