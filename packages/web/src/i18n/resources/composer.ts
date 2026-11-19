/**
 * Composer / standby pane / ask dock / context usage display copy.
 * Owner: the composer partition.
 *
 * zh-CN copy for strings that existed before the en migration baseline
 * (b4a611a65) is backfilled verbatim from that commit; new strings follow the
 * project glossary. Execution copy (thrown errors, API bodies, errorText
 * output) intentionally stays out of this table.
 */
import type { MessageTable } from '../messages.js'

export const composerMessages = {
  // ---- Standby pane chrome & states ----
  'composer.standby.newTopic': { en: 'Start new topic', 'zh-CN': '开始新话题' },
  'composer.standby.profileLoadFailed': { en: 'Profile info failed to load: {error}', 'zh-CN': '角色信息加载失败：{error}' },
  'composer.standby.loadingProfile': { en: 'Loading profile info…', 'zh-CN': '正在加载角色信息…' },
  'composer.standby.profileMissing': { en: 'Profile {profileId} does not exist or was deleted', 'zh-CN': '角色 {profileId} 不存在或已删除' },
  'composer.standby.goToProfiles': { en: 'Go to profile center', 'zh-CN': '前往角色中心' },
  'composer.standby.notHumanSelectable': {
    en: 'This profile does not support manual new conversations (resident profiles are managed by their owning plugin)',
    'zh-CN': '该角色不支持手动新建对话（常驻角色由其托管插件管理）',
  },
  'composer.standby.introHint': {
    en: 'Send the first message to start a new topic; the conversation is created on first send',
    'zh-CN': '发送第一条消息开始新话题；会话将在首次发送时创建',
  },
  'composer.standby.sentInBackgroundTitle': { en: 'Sent and conversation created', 'zh-CN': '已发送并创建会话' },
  'composer.standby.sentInBackgroundBody': { en: 'First message sent to conversation #{id}', 'zh-CN': '首条消息已发送到会话 #{id}' },
  'composer.standby.attachmentRejectedTitle': { en: 'Attachment cannot be staged: {name}', 'zh-CN': '附件无法暂存：{name}' },
  'composer.standby.unnamedFile': { en: 'Unnamed file', 'zh-CN': '未命名文件' },
  'composer.draft.handleBeforeStarter': {
    en: 'Handle the current draft before picking a starter',
    'zh-CN': '请先处理当前草稿，再选择引导词',
  },
  'composer.standby.newDraftStartedTitle': { en: 'New draft started', 'zh-CN': '已开始新草稿' },
  'composer.standby.newDraftStartedBody': { en: 'Just keep typing the new first message', 'zh-CN': '继续输入新的首条消息即可' },
  'composer.standby.needsConversationTitle': { en: '{command} requires an existing conversation', 'zh-CN': '{command} 需要已有会话' },
  'composer.standby.needsConversationBody': {
    en: 'Send the first message to create a conversation before using this command',
    'zh-CN': '请先发送首条消息创建会话后再使用该命令',
  },
  'composer.standby.defaultEnvHasDraftTitle': { en: 'The default environment already has another draft', 'zh-CN': '默认环境已有其他草稿' },
  'composer.standby.defaultEnvHasDraftBody': {
    en: 'Draft not overwritten; it stays at its original environment coordinates',
    'zh-CN': '未覆盖该草稿；当前草稿仍保留在原环境坐标',
  },
  'composer.standby.fixEnvFirst': { en: 'Fix the starting environment first', 'zh-CN': '请先修正起始环境' },
  'composer.standby.sendFailedRetryTitle': { en: 'Send failed; retry available (conversation created)', 'zh-CN': '发送失败，可重试（会话已创建）' },
  'composer.standby.createFailedTitle': { en: 'Failed to create conversation; draft preserved', 'zh-CN': '创建会话失败，草稿已保留' },

  // ---- Standby composer: anchored banner / attachments / textarea / send ----
  'composer.standby.anchoredNotice': {
    en: 'Conversation #{id} created: model and starting environment are locked with it; edit the text or attachments and retry',
    'zh-CN': '已创建会话 #{id}：模型与起始环境已随会话锁定，可修改正文与附件后重试',
  },
  'composer.standby.openCreatedInPanel': { en: 'Open the created conversation in this panel', 'zh-CN': '在当前面板查看已创建的会话' },
  'composer.standby.viewConversation': { en: 'View conversation', 'zh-CN': '查看会话' },
  'composer.standby.attachmentPending': { en: 'Pending', 'zh-CN': '待发送' },
  'composer.standby.attachmentUploaded': { en: 'Uploaded', 'zh-CN': '已上传' },
  'composer.standby.removeAttachmentTitle': { en: 'Remove attachment {name}', 'zh-CN': '移除附件 {name}' },
  'composer.standby.removeAttachment': { en: 'Remove attachment', 'zh-CN': '移除附件' },
  'composer.standby.firstMessageAria': { en: 'Type the first message to {name}', 'zh-CN': '向 {name} 输入首条消息' },
  'composer.standby.placeholderMobile': { en: 'Type a message to start a new topic…', 'zh-CN': '输入消息开始新话题…' },
  'composer.standby.placeholder': {
    en: 'Type a message to start a new topic; / commands and skills · @ mentions, ⌘V to paste attachments',
    'zh-CN': '输入消息开始新话题；/ 命令与技能 · @ 点名，⌘V 粘贴附件',
  },
  'composer.standby.chooseAttachments': { en: 'Choose attachments (uploaded on send)', 'zh-CN': '选择附件（发送时才上传）' },
  'composer.standby.sendTitle': { en: 'Send (Enter); the conversation is created on first send', 'zh-CN': '发送 (Enter)；会话将在首次发送时创建' },
  'composer.standby.sendingAria': { en: 'Sending', 'zh-CN': '发送中' },

  // ---- Conversation composer placeholder (pure model) ----
  'composer.placeholder.idleMobile': { en: 'Type a message…', 'zh-CN': '输入消息…' },
  'composer.placeholder.idle': {
    en: 'Type a message; / for commands and skills, ⌘V to paste attachments',
    'zh-CN': '输入消息；/ 命令与技能，⌘V 粘贴附件',
  },
  'composer.placeholder.workingMobile': { en: 'Add notes or queued instructions…', 'zh-CN': '补充说明或排队指令…' },
  'composer.placeholder.working': {
    en: 'Add notes or type the next instruction (Enter steers · ⌘/Ctrl+Enter queues)',
    'zh-CN': '补充说明或输入下一条指令（Enter 插话引导 · ⌘/Ctrl+Enter 排队发送）',
  },

  // ---- Send / stop controls (busy steering & queueing) ----
  'composer.sendControls.updateWorkingTitle': {
    en: 'Update and regenerate (overwrites this message and everything after it and stops the current execution) (Enter)',
    'zh-CN': '更新并重新生成（将覆盖此条及后续对话并停止当前执行） (Enter)',
  },
  'composer.sendControls.updateTitle': {
    en: 'Update and regenerate (overwrites this message and everything after it) (Enter)',
    'zh-CN': '更新并重新生成（将覆盖此条及后续对话） (Enter)',
  },
  'composer.sendControls.updateShort': { en: 'Update and regenerate', 'zh-CN': '更新并重新生成' },
  'composer.sendControls.sendTitle': { en: 'Send (Enter); Shift+Enter for a newline', 'zh-CN': '发送 (Enter)；Shift+Enter 换行' },
  'composer.sendControls.uploading': { en: 'Uploading ({count})', 'zh-CN': '上传中 ({count})' },
  'composer.sendControls.send': { en: 'Send', 'zh-CN': '发送' },
  'composer.sendControls.stopExecution': { en: 'Stop the current execution', 'zh-CN': '停止当前执行' },
  'composer.sendControls.steer': { en: 'Steer', 'zh-CN': '插话引导' },
  'composer.sendControls.steerShort': { en: 'Steer', 'zh-CN': '插话' },
  'composer.sendControls.queueSend': { en: 'Queue send', 'zh-CN': '排队发送' },
  'composer.sendControls.queue': { en: 'Queue', 'zh-CN': '排队' },
  'composer.sendControls.steerHint': { en: 'Inject at the next step boundary', 'zh-CN': '下一个步骤边界注入' },
  'composer.sendControls.steerHintEnter': { en: 'Inject at the next step boundary (Enter)', 'zh-CN': '下一个步骤边界注入（Enter）' },
  'composer.sendControls.queueHint': { en: 'Handle after the current turn ends', 'zh-CN': '当前回合结束后处理' },
  'composer.sendControls.queueHintKbd': { en: 'Handle after the current turn ends (⌘/Ctrl+Enter)', 'zh-CN': '当前回合结束后处理（⌘/Ctrl+Enter）' },
  'composer.sendControls.chooseStrategy': { en: 'Choose a send strategy', 'zh-CN': '选择发送策略' },
  'composer.sendControls.chooseStrategyTitle': { en: 'Choose a send strategy (steer / queue)', 'zh-CN': '选择发送策略（插话 / 排队）' },
  'composer.sendControls.stopMenuTitle': { en: 'Stop execution', 'zh-CN': '停止执行' },
  'composer.sendControls.abortNow': { en: 'Abort the current turn immediately', 'zh-CN': '立即中止当前回合' },
  'composer.sendControls.updateLabel': { en: 'Update', 'zh-CN': '更新' },
  'composer.sendControls.insertLabel': { en: 'Insert', 'zh-CN': '插话' },

  // ---- Model picker (shared by conversation & standby) ----
  'composer.model.currentTitle': { en: 'Current model: {model}{thinking} ({shortcut})', 'zh-CN': '当前模型：{model}{thinking} ({shortcut})' },
  'composer.model.followsDefaultTitle': { en: 'Follows profile/global default model{thinking} ({shortcut})', 'zh-CN': '跟随角色/全局默认模型{thinking} ({shortcut})' },
  'composer.model.thinkingSuffix': { en: ' · thinking {level}', 'zh-CN': ' · 思考 {level}' },
  'composer.model.lockedNote': {
    en: 'Locked with the conversation (or sending); retry reuses this configuration',
    'zh-CN': '已随会话锁定（或发送中），重试复用当前配置',
  },
  'composer.model.followProfileDefault': { en: 'Follow profile default', 'zh-CN': '跟随角色默认' },
  'composer.model.followProfileDefaultModel': { en: 'Follow profile default ({model})', 'zh-CN': '跟随角色默认（{model}）' },
  'composer.model.standbyResetTitle': {
    en: 'No model specified on creation; the server resolves it from the profile/global default',
    'zh-CN': '创建会话时不指定模型，由服务器按角色/全局默认解析',
  },
  'composer.model.clearOverride': {
    en: 'Clear the explicit override and recompute the Profile/global inheritance chain',
    'zh-CN': '清除显式覆盖，重算 Profile/全局继承链',
  },
  'composer.model.buttonAria': { en: 'Model and thinking level: {model}{level}', 'zh-CN': '模型与思考档位：{model}{level}' },
  'composer.model.levelSuffix': { en: ' · {level}', 'zh-CN': ' · {level}' },
  'composer.model.defaultLabel': { en: 'Default model', 'zh-CN': '默认模型' },
  'composer.model.searchAria': { en: 'Search models', 'zh-CN': '搜索模型' },
  'composer.model.searchPlaceholder': { en: 'Search models…', 'zh-CN': '搜索模型…' },
  'composer.model.refreshCatalog': { en: 'Refresh dynamic model catalog', 'zh-CN': '刷新动态模型目录' },
  'composer.model.listHeader': { en: 'Model list', 'zh-CN': '模型列表' },
  'composer.model.emptyCatalog': {
    en: 'No models available; configure a provider key in Models & credentials first',
    'zh-CN': '暂无可用模型；请先在「模型与凭据」配置供应商密钥',
  },
  'composer.model.noMatches': { en: 'No matching models', 'zh-CN': '没有匹配的模型' },
  'composer.model.thinkingHeader': { en: 'Thinking level', 'zh-CN': '思考档位' },
  'composer.model.applyDefault': { en: 'Use default level', 'zh-CN': '使用默认档位' },
  'composer.model.catalogPartialFailure': { en: 'Some provider catalog refreshes failed', 'zh-CN': '部分供应商目录刷新失败' },
  'composer.model.catalogRefreshed': { en: 'Model catalog refreshed', 'zh-CN': '已刷新模型目录' },
  'composer.model.catalogCount': { en: '{count} models available', 'zh-CN': '共 {count} 个可用模型' },
  'composer.model.catalogRefreshFailed': { en: 'Failed to refresh model catalog', 'zh-CN': '刷新模型目录失败' },
  'composer.model.switchFailed': { en: 'Failed to switch model', 'zh-CN': '切换模型失败' },
  'composer.model.thinkingSwitchFailed': { en: 'Failed to switch thinking level', 'zh-CN': '切换思考等级失败' },
  'composer.model.restoreFailed': { en: 'Failed to restore default configuration', 'zh-CN': '恢复默认配置失败' },

  // ---- Starting environment bar (session & standby) ----
  'composer.env.saveOrCancelFirst': { en: 'Save or cancel the starting environment changes first', 'zh-CN': '请先保存或取消起始环境修改' },
  'composer.env.blockerSaving': { en: 'Saving conversation environment…', 'zh-CN': '正在保存会话环境…' },
  'composer.env.savedTitle': { en: 'Conversation environment saved', 'zh-CN': '已保存会话环境' },
  'composer.env.saveFailed': { en: 'Failed to save conversation environment', 'zh-CN': '保存会话环境失败' },
  'composer.env.nodeAria': { en: 'Conversation execution node', 'zh-CN': '会话执行节点' },
  'composer.env.cwdAria': { en: 'Conversation working directory', 'zh-CN': '会话工作目录' },
  'composer.env.cwdPlaceholderSameNode': { en: '/absolute/path', 'zh-CN': '/绝对路径' },
  'composer.env.cwdPlaceholder': { en: 'Absolute path on the target node, e.g. /home/user/work', 'zh-CN': '目标节点上的绝对路径，例如 /home/user/work' },
  'composer.env.nodeOfflineAfterSave': {
    en: 'Node offline; execution waits until the node comes online after saving',
    'zh-CN': '节点离线，保存后仍需节点上线才能执行',
  },
  'composer.env.lockedHint': { en: 'Locked after the first message is sent', 'zh-CN': '首条消息发送后锁定' },
  'composer.env.errorRequired': { en: 'Enter the working directory on the target node (absolute path)', 'zh-CN': '请填写目标节点上的工作目录（绝对路径）' },
  'composer.env.errorAbsolute': {
    en: 'Working directory must be an absolute path (POSIX / or Windows drive letter)',
    'zh-CN': '工作目录必须是绝对路径（POSIX / 或 Windows 盘符开头）',
  },
  'composer.env.subtitleTooltip': {
    en: 'Agent: {profileId} · Node: {nodeId} · Working directory: {cwd}',
    'zh-CN': '智能体：{profileId} · 节点：{nodeId} · 工作目录：{cwd}',
  },
  'composer.env.notSet': { en: '(not set)', 'zh-CN': '(未设置)' },
  'composer.env.nodeUnknownOption': { en: '{nodeId} (unknown)', 'zh-CN': '{nodeId}（未知）' },

  // ---- Standby environment bar specifics ----
  'composer.standby.envNodeAria': { en: 'New conversation execution node', 'zh-CN': '新会话执行节点' },
  'composer.standby.envCwdAria': { en: 'New conversation working directory', 'zh-CN': '新会话工作目录' },
  'composer.standby.envFollowsProfile': { en: 'Execution environment follows the profile default{node}{cwd}', 'zh-CN': '执行环境跟随角色默认{node}{cwd}' },
  'composer.standby.envSuffix': { en: ' · {value}', 'zh-CN': ' · {value}' },
  'composer.standby.customEnvButton': { en: 'Custom', 'zh-CN': '自定义' },
  'composer.standby.restoreDefaults': { en: 'Restore defaults', 'zh-CN': '恢复默认' },
  'composer.standby.envLockedTitle': { en: 'Sending or locked with the conversation', 'zh-CN': '发送中或已随会话锁定' },
  'composer.standby.clearEnvTitle': {
    en: 'Clear inherited/custom environment and follow the profile default',
    'zh-CN': '清除继承/自定义环境，跟随角色默认',
  },
  'composer.standby.envEffectOnSend': { en: 'Takes effect on first send', 'zh-CN': '首次发送时生效' },
  'composer.standby.nodeOfflineWarn': {
    en: 'Node offline; execution waits until the node comes online',
    'zh-CN': '节点离线，发送后仍需节点上线才能执行',
  },

  // ---- Session management commands & compaction notices ----
  'composer.send.newTopicFromTopBar': {
    en: 'Start new topics from the New topic action in the conversation top bar',
    'zh-CN': '请从会话顶栏「新话题」开始新话题',
  },
  'composer.compaction.resetDone': { en: 'Context reset', 'zh-CN': '上下文已重置' },
  'composer.compaction.resetFailed': { en: 'Failed to reset context', 'zh-CN': '重置上下文失败' },
  'composer.compaction.inProgress': { en: 'Context compaction in progress', 'zh-CN': '上下文精简正在进行中' },
  'composer.compaction.submitted': { en: 'Compaction submitted', 'zh-CN': '精简任务已提交' },
  'composer.compaction.failed': { en: 'Failed to compact context', 'zh-CN': '精简上下文失败' },

  // ---- Sending pipeline notices ----
  'composer.attach.uploadFailedTitle': { en: 'Attachment upload failed: {name}', 'zh-CN': '附件上传失败：{name}' },
  'composer.attach.tooLarge': { en: 'File exceeds the 15 MiB limit', 'zh-CN': '文件超过 15 MiB 上限' },
  'composer.attach.unsupportedSource': {
    en: 'Unsupported attachment source (not a readable file object); add files via picker, drag and drop, or paste',
    'zh-CN': '不支持的附件来源（非可读取的文件对象），请通过文件选择/拖拽/粘贴添加',
  },
  'composer.send.withdrawnTitle': { en: 'Queued message withdrawn', 'zh-CN': '已撤回排队消息' },
  'composer.send.withdrawnBody': { en: 'Current draft not empty; input not overwritten: {text}', 'zh-CN': '当前草稿非空，未覆盖输入：{text}' },
  'composer.send.enteredExecutionTitle': { en: 'Message entered execution', 'zh-CN': '消息已进入执行' },
  'composer.send.enteredExecutionBody': { en: 'Current draft not empty; not entering history message editing', 'zh-CN': '当前草稿非空，未进入历史消息编辑' },
  'composer.send.cannotWithdrawTitle': { en: 'Cannot withdraw queued message', 'zh-CN': '无法撤回排队消息' },
  'composer.send.cannotWithdrawBody': { en: 'Submission entered execution (status={status})', 'zh-CN': '提交已进入执行（status={status}）' },
  'composer.send.withdrawFailed': { en: 'Failed to withdraw queued message', 'zh-CN': '撤回排队消息失败' },
  'composer.send.updateFailed': { en: 'Failed to update message', 'zh-CN': '更新消息失败' },
  'composer.send.sendFailed': { en: 'Send failed', 'zh-CN': '发送失败' },

  // ---- Slash command popover ----
  'composer.command.newHint': { en: 'Start new topic', 'zh-CN': '开始新话题' },
  'composer.command.clearHint': { en: 'Reset context', 'zh-CN': '重置上下文' },
  'composer.command.compactHint': { en: 'Compact context', 'zh-CN': '精简上下文' },
  'composer.command.header': { en: 'Commands and skills', 'zh-CN': '命令与技能' },
  'composer.command.noMatches': { en: 'No matching commands or skills', 'zh-CN': '没有匹配的命令或技能' },

  // ---- Completion popover & sources ----
  'composer.completion.triggerMentions': { en: 'Mentions and completion', 'zh-CN': '引用与补全' },
  'composer.completion.triggerCompletion': { en: 'Completion', 'zh-CN': '补全' },
  'composer.completion.candidatesAria': { en: '{title} candidates', 'zh-CN': '{title}候选' },
  'composer.completion.listAria': { en: '{title} candidate list', 'zh-CN': '{title}候选列表' },
  'composer.completion.querying': { en: 'Querying candidates…', 'zh-CN': '正在查询候选…' },
  'composer.completion.sourceError': { en: 'Source {source}: {message}', 'zh-CN': '源 {source}：{message}' },
  'composer.completion.noMatches': { en: 'No matching candidates', 'zh-CN': '没有匹配的候选' },
  'composer.completion.tooManyTitle': {
    en: 'Too many candidates; showing the first {limit}; keep typing to filter',
    'zh-CN': '候选过多，仅显示前 {limit} 项，可继续输入过滤',
  },
  'composer.completion.tooMany': { en: 'Too many candidates; showing the first {limit}', 'zh-CN': '候选超过上限，仅显示前 {limit} 项' },
  'composer.completion.tooManyTotal': {
    en: 'Too many candidates; showing the first {limit} ({total} in total)',
    'zh-CN': '候选超过上限，仅显示前 {limit} 项（共 {total} 项）',
  },
  'composer.completion.fallbackUnsupported': { en: 'The current context does not support this completion action', 'zh-CN': '当前上下文不支持该补全动作' },
  'composer.completion.fallbackInvalidResult': { en: 'Completion action returned an invalid result', 'zh-CN': '补全动作返回无效' },
  'composer.completion.docLoadFailed': { en: 'Failed to load document: {error}', 'zh-CN': '文档读取失败：{error}' },
  'composer.completion.sessionDocNeedsConversation': {
    en: 'Conversation document completion requires an existing conversation (available after the first message creates one)',
    'zh-CN': '会话文档补全源需要已有会话（发送首条消息创建后可用）',
  },
  'composer.completion.docNotObject': { en: 'Document value is not an object', 'zh-CN': '文档值不是对象' },
  'composer.completion.docMissingField': { en: 'Document missing array field {field}', 'zh-CN': '文档缺少数组字段 {field}' },
  'composer.completion.droppedItems': { en: '{count} invalid candidates dropped', 'zh-CN': '已丢弃 {count} 个非法候选' },
  'composer.completion.invalidActionResult': { en: 'Completion action returned an invalid format', 'zh-CN': '补全动作返回格式无效' },
  'composer.completion.missingItemsArray': { en: 'Completion action response missing the items array', 'zh-CN': '补全动作返回缺少 items 数组' },
  'composer.completion.actionNotRegistered': {
    en: 'Action {pluginId}/{actionId} not registered or plugin disabled',
    'zh-CN': '动作 {pluginId}/{actionId} 未注册或插件已停用',
  },
  'composer.completion.actionNotIdempotent': {
    en: 'Action {pluginId}/{actionId} does not declare idempotent; forbidden as a completion source',
    'zh-CN': '动作 {pluginId}/{actionId} 未声明 idempotent，禁止作为补全源',
  },
  'composer.completion.actionNeedsConversation': {
    en: 'Action {pluginId}/{actionId} requires an existing conversation (available after the first message creates one)',
    'zh-CN': '动作 {pluginId}/{actionId} 需要已有会话（发送首条消息创建后可用）',
  },

  // ---- Keyboard hints ----
  'composer.kbd.navConfirmClose': { en: '↑↓ select · Enter confirm · Esc close', 'zh-CN': '↑↓ 选择 · Enter 确认 · Esc 关闭' },
  'composer.kbd.navConfirm': { en: '↑↓ select · Enter confirm', 'zh-CN': '↑↓ 选择 · Enter 确认' },

  // ---- Context usage readout ----
  'composer.context.compactingStatus': { en: 'Compacting…', 'zh-CN': '精简中…' },
  'composer.context.unknownAfterCompaction': {
    en: 'No new reply since the last compaction; context usage unknown',
    'zh-CN': '最近一次精简后尚无新的回答，上下文用量未知',
  },
  'composer.context.unknownNoWindow': { en: 'Context usage unknown (model window unknown)', 'zh-CN': '上下文用量未知（模型窗口未知）' },
  'composer.context.estimateTitle': {
    en: 'Context estimate {tokens} tokens (model window unknown; no percentage shown)',
    'zh-CN': '上下文估算 {tokens} tokens（模型窗口未知，不显示百分比）',
  },
  'composer.context.usageTitle': {
    en: 'Context usage {percent}% (about {used} / {window} tokens)',
    'zh-CN': '上下文占用 {percent}%（约 {used} / {window} tokens）',
  },

  // ---- Ask dock ----
  'composer.ask.selectPlaceholder': { en: 'Select…', 'zh-CN': '请选择…' },
  'composer.ask.awaitingApproval': { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  'composer.ask.metaAria': { en: 'Approval details', 'zh-CN': '审批详情' },
  'composer.ask.metaOwner': { en: 'Owner plugin', 'zh-CN': '归属插件' },
  'composer.ask.metaSeq': { en: 'CAS seq', 'zh-CN': 'CAS 水位' },
  'composer.ask.approve': { en: 'Approve', 'zh-CN': '确认' },
  'composer.ask.reject': { en: 'Reject', 'zh-CN': '拒绝' },
  'composer.ask.submit': { en: 'Submit', 'zh-CN': '提交' },
  'composer.ask.secretPlaceholder': { en: 'Secret values go to the in-memory SecretStash only', 'zh-CN': '机密值仅入内存 SecretStash' },
  'composer.ask.secretHint': {
    en: 'Secrets stay in the in-memory SecretStash, never stored in the database',
    'zh-CN': '机密直入内存 SecretStash，不落数据库',
  },
  'composer.ask.casTitle': { en: 'CAS watermark: auto-cancelled once the terminal handles it', 'zh-CN': 'CAS 水位线：终端已处理时自动销单' },
  'composer.ask.openChildTitle': { en: 'Open child conversation #{id} ({title})', 'zh-CN': '打开子会话 #{id}（{title}）' },
  'composer.ask.openChildDrawer': { en: 'Open child conversation #{id} drawer', 'zh-CN': '打开子会话 #{id}抽屉' },
  'composer.ask.fromSource': { en: 'From #{id}', 'zh-CN': '来自 #{id}' },
  'composer.ask.terminalSnapshot': { en: 'Terminal snapshot (last 40 lines)', 'zh-CN': '终端快照（最后 40 行）' },
} satisfies MessageTable
