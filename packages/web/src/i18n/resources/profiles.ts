/**
 * Profile center display copy. Owner: the profiles-skills partition.
 *
 * zh-CN copy is backfilled verbatim from the pre-English baseline (b4a611a65)
 * wherever the string existed; placeholders only adapt to `{param}` syntax.
 */
import type { MessageTable } from '../messages.js'

export const profilesMessages = {
  // Category tab labels ('all'/'system' reuse common.all / common.builtIn).
  'profiles.tab.custom': { en: 'Custom', 'zh-CN': '自定义' },
  'profiles.tab.herdr': { en: 'Herdr', 'zh-CN': 'Herdr' },

  // Model binding select options (profile editor / detail drawer).
  'profiles.modelOption.followSystemDefault': { en: 'Follow system default', 'zh-CN': '跟随系统默认' },
  'profiles.modelOption.notConfigured': { en: '{model} (not configured)', 'zh-CN': '{model}（未配置）' },
  'profiles.modelOption.disabled': { en: '{model} (disabled)', 'zh-CN': '{model}（已禁用）' },

  // Starter draft validation errors (form display copy).
  'profiles.starter.error.titleEmpty': {
    en: 'Title cannot be empty after trimming whitespace',
    'zh-CN': '标题去除首尾空白后不能为空',
  },
  'profiles.starter.error.titleTooLong': {
    en: 'Title must be at most {max} Unicode code points',
    'zh-CN': '标题最多 {max} 个 Unicode 码点',
  },
  'profiles.starter.error.promptWhitespace': {
    en: 'Prompt cannot be whitespace only',
    'zh-CN': '提示词不能是纯空白',
  },
  'profiles.starter.error.promptTooLong': {
    en: 'Prompt must be at most {max} Unicode code points',
    'zh-CN': '提示词最多 {max} 个 Unicode 码点',
  },

  // Conversation activity state labels.
  'profiles.activity.pluginDisabled': { en: 'Plugin disabled', 'zh-CN': '插件已停用' },
  'profiles.activity.running': { en: 'Running', 'zh-CN': '运行中' },
  'profiles.activity.runningCount': { en: 'Running ({count})', 'zh-CN': '运行中 ({count})' },
  'profiles.activity.pendingApproval': { en: 'Pending approval', 'zh-CN': '待审批' },
  'profiles.activity.pendingApprovalCount': { en: 'Pending approval ({count})', 'zh-CN': '待审批 ({count})' },
  'profiles.activity.errors': { en: 'Errors ({count})', 'zh-CN': '异常 ({count})' },
  'profiles.activity.hasErrors': { en: 'Has errors', 'zh-CN': '存在异常' },
  'profiles.activity.conversations': { en: '{count} conversations', 'zh-CN': '{count} 个会话' },
  'profiles.activity.standingBy': { en: 'Standing by', 'zh-CN': '待命中' },

  // ProfileCard copy.
  'profiles.card.allSkills': { en: 'All available skills', 'zh-CN': '全部可用技能' },
  'profiles.card.skillsCount': { en: '{count} skills', 'zh-CN': '{count} 个技能' },
  'profiles.card.boundModel': { en: 'Bound model: {model}', 'zh-CN': '绑定模型：{model}' },
  'profiles.card.inheritModel': {
    en: 'Inherits global default model: {model}',
    'zh-CN': '继承全局默认模型：{model}',
  },
  'profiles.card.thinkingSuffix': { en: ' (thinking level: {level})', 'zh-CN': '（思考档位：{level}）' },
  'profiles.card.followGlobalTitle': {
    en: 'Follow global default model configuration',
    'zh-CN': '跟随全局默认模型配置',
  },
  'profiles.card.defaultCwd': { en: '{nodeId} · default working directory', 'zh-CN': '{nodeId} · 默认工作目录' },
  'profiles.card.systemPillTitle': { en: 'Built-in system profile', 'zh-CN': '系统内置角色' },
  'profiles.card.systemPill': { en: 'System', 'zh-CN': '系统' },
  'profiles.card.activityTitle': { en: 'Activity: {label}', 'zh-CN': '激活状态：{label}' },
  'profiles.card.noDescription': { en: 'No description', 'zh-CN': '暂无描述' },
  'profiles.card.locationTitle': { en: 'Node and directory: {location}', 'zh-CN': '节点与目录：{location}' },
  'profiles.card.followGlobalDefault': { en: 'Follow global default', 'zh-CN': '跟随全局默认' },
  'profiles.card.globalDefault': { en: 'Global default', 'zh-CN': '全局默认' },
  'profiles.card.skillsTitle': { en: 'Skills: {label}', 'zh-CN': '技能配置：{label}' },
  'profiles.card.herdrRuntimeTitle': { en: 'Herdr external runtime', 'zh-CN': 'Herdr 外部运行时' },
  'profiles.card.linkedConversations': {
    en: 'Linked to {count} conversations',
    'zh-CN': '关联 {count} 个会话',
  },
  'profiles.card.noLinkedConversations': { en: 'No linked conversations', 'zh-CN': '暂无关联会话' },
  'profiles.card.chatDisabledTitle': {
    en: 'The owning managed plugin is disabled; cannot start a new conversation',
    'zh-CN': '所属托管插件已停用，无法发起新对话',
  },
  'profiles.card.startConversationTitle': {
    en: 'Start a new conversation with {name}',
    'zh-CN': '与 {name} 发起新对话',
  },
  'profiles.card.conversationAction': { en: 'Conversation', 'zh-CN': '对话' },

  // ProfileCenter copy.
  'profiles.notice.savedTitle': { en: 'Profile saved', 'zh-CN': '角色已保存' },
  'profiles.notice.savedBody': { en: '{name} configuration updated', 'zh-CN': '{name} 配置已更新' },
  'profiles.notice.deletedTitle': { en: 'Profile deleted', 'zh-CN': '角色已删除' },
  'profiles.notice.deletedBody': { en: 'Profile {id} permanently deleted', 'zh-CN': '角色 {id} 已彻底删除' },
  'profiles.center.title': { en: 'Agent Profile Center', 'zh-CN': '智能体角色中心' },
  'profiles.center.newProfile': { en: 'New profile', 'zh-CN': '新建角色' },
  'profiles.center.searchPlaceholder': {
    en: 'Search profile name, ID, model, tags or skills…',
    'zh-CN': '搜索角色名称、ID、模型、标签或技能…',
  },
  'profiles.center.searchLabel': { en: 'Search profiles', 'zh-CN': '搜索角色' },
  'profiles.center.clearSearch': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'profiles.center.filterLabel': { en: 'Filter by profile category', 'zh-CN': '角色分类筛选' },
  'profiles.center.emptyTitle': { en: 'No matching profiles', 'zh-CN': '未找到匹配的角色' },
  'profiles.center.emptyHint': {
    en: 'Try adjusting the search keywords or switching category tabs.',
    'zh-CN': '请尝试调整搜索关键字或切换分类标签。',
  },
  'profiles.center.resetFilters': { en: 'Reset filters', 'zh-CN': '重置筛选条件' },

  // ProfileDetailDrawer copy.
  'profiles.drawer.newTitle': { en: 'New agent profile', 'zh-CN': '新建智能体角色' },
  'profiles.drawer.titleFallback': { en: 'Profile details', 'zh-CN': '角色详情' },
  'profiles.drawer.systemPillTitle': {
    en: 'Built-in system profile; protected',
    'zh-CN': '系统内置角色，受保护',
  },
  'profiles.drawer.closeAria': { en: 'Close drawer', 'zh-CN': '关闭抽屉' },
  'profiles.drawer.unboundNode': {
    en: 'Unbound (local node)',
    'zh-CN': '未绑定（本机 local）',
  },
  'profiles.drawer.unknownNode': { en: '{id} (unknown node)', 'zh-CN': '{id}（未知节点）' },
  'profiles.drawer.error.idRequired': { en: 'Enter a profile ID', 'zh-CN': '请输入角色 ID' },
  'profiles.drawer.error.idInvalid': {
    en: 'Profile ID must contain only lowercase letters, digits and hyphens (e.g. code-reviewer)',
    'zh-CN': '角色 ID 必须由小写字母、数字和连字符组成（例如 code-reviewer）',
  },
  'profiles.drawer.error.starterPrefix': {
    en: 'Starter {index}: {error}',
    'zh-CN': '引导词 {index}：{error}',
  },
  'profiles.drawer.field.id': { en: 'Profile ID', 'zh-CN': '角色 ID' },
  'profiles.drawer.field.idPlaceholder': {
    en: 'Letters, digits and hyphens, e.g. code-reviewer',
    'zh-CN': '字母、数字与连字符，如 code-reviewer',
  },
  'profiles.drawer.field.name': { en: 'Profile name', 'zh-CN': '角色名称' },
  'profiles.drawer.field.namePlaceholder': {
    en: 'e.g. Code Reviewer, Software Architect',
    'zh-CN': '例如：代码评审员、技术架构师',
  },
  'profiles.drawer.field.description': { en: 'Profile description', 'zh-CN': '角色描述' },
  'profiles.drawer.field.descriptionPlaceholder': {
    en: 'Briefly describe the duties, background and strengths of this profile...',
    'zh-CN': '简要描述该角色的职责、背景与能力专长...',
  },
  'profiles.drawer.field.defaultModel': { en: 'Default model', 'zh-CN': '默认模型' },
  'profiles.drawer.field.thinkingLevel': { en: 'Thinking level', 'zh-CN': '思考档位' },
  'profiles.drawer.thinking.unbound': {
    en: 'Follows the global default thinking level when no model is bound.',
    'zh-CN': '未绑定模型时跟随全局缺省思考档位。',
  },
  'profiles.drawer.thinking.unsupportedModel': {
    en: 'The selected model does not support thinking levels.',
    'zh-CN': '所选模型不支持思考档位。',
  },
  'profiles.drawer.thinking.unsupportedLevel': {
    en: 'Current level {level} is not supported by the selected model; adjust before saving.',
    'zh-CN': '当前档位 {level} 不在所选模型支持列表，保存前请调整。',
  },
  'profiles.drawer.field.defaultNode': { en: 'Default node', 'zh-CN': '默认节点' },
  'profiles.drawer.field.cwd': { en: 'Working directory', 'zh-CN': '工作目录' },
  'profiles.drawer.field.cwdPlaceholder': {
    en: 'Optional, e.g. /root/code/my-project',
    'zh-CN': '可选，例如 /root/code/my-project',
  },
  'profiles.drawer.system.title': {
    en: 'System prompt (SYSTEM.md)',
    'zh-CN': '系统提示词 (SYSTEM.md)',
  },
  'profiles.drawer.system.chars': { en: '{chars} characters', 'zh-CN': '{chars} 字符' },
  'profiles.drawer.system.charsAndLines': {
    en: '{chars} characters · {lines} lines',
    'zh-CN': '{chars} 字符 · {lines} 行',
  },
  'profiles.drawer.system.placeholder': {
    en: 'Enter the system prompt instructions for this profile (Markdown supported)...',
    'zh-CN': '输入该角色的系统提示词指令（支持 Markdown）...',
  },
  'profiles.drawer.system.aria': { en: 'System prompt', 'zh-CN': '系统提示词' },
  'profiles.drawer.system.hint': {
    en: 'Tip: the system prompt defines the core duties and ground rules of the profile; saving applies to future conversations immediately.',
    'zh-CN': '提示：系统指令定义角色的核心职责与行动准则，保存后对后续会话即时生效。',
  },
  'profiles.drawer.starters.title': {
    en: 'Empty-conversation starters',
    'zh-CN': '空白会话引导词',
  },
  'profiles.drawer.starters.empty': {
    en: 'Falls back to the system default starter prompts when unset.',
    'zh-CN': '未配置时使用系统默认引导提示。',
  },
  'profiles.drawer.starters.labelPlaceholder': {
    en: 'Title (max 24 code points)',
    'zh-CN': '标题（≤24 码点）',
  },
  'profiles.drawer.starters.labelAria': {
    en: 'Starter {index} title',
    'zh-CN': '引导词 {index} 标题',
  },
  'profiles.drawer.starters.promptPlaceholder': {
    en: 'Prompt filled into the composer on click (max 4000 code points; not sent automatically)',
    'zh-CN': '点击后回填到输入框的提示词（≤4000 码点，不自动发送）',
  },
  'profiles.drawer.starters.promptAria': {
    en: 'Starter {index} prompt',
    'zh-CN': '引导词 {index} 提示词',
  },
  'profiles.drawer.starters.deleteAria': {
    en: 'Delete starter {index}',
    'zh-CN': '删除引导词 {index}',
  },
  'profiles.drawer.starters.deleteTitle': {
    en: 'Delete this starter',
    'zh-CN': '删除此条引导词',
  },
  'profiles.drawer.starters.add': { en: 'Add starter', 'zh-CN': '添加引导词' },
  'profiles.drawer.skills.title': {
    en: 'Available skills allowlist',
    'zh-CN': '可用技能白名单',
  },
  'profiles.drawer.skills.allHint': {
    en: 'This profile may use every available skill without restriction.',
    'zh-CN': '已允许此角色无限制使用系统内所有可用技能。',
  },
  'profiles.drawer.skills.empty': { en: 'No skills loaded', 'zh-CN': '暂无已加载的技能' },
  'profiles.drawer.delete': { en: 'Delete profile', 'zh-CN': '删除角色' },
  'profiles.drawer.saving': { en: 'Saving…', 'zh-CN': '保存中…' },
  'profiles.drawer.save': { en: 'Save profile', 'zh-CN': '保存角色' },
  'profiles.drawer.deleting': { en: 'Deleting…', 'zh-CN': '删除中…' },
  'profiles.drawer.deleteConfirm.body': {
    en: 'Delete profile "{name}"? This action cannot be undone.',
    'zh-CN': '确定删除角色「{name}」？此操作不可撤销。',
  },
  'profiles.drawer.deleteConfirm.confirm': { en: 'Confirm deletion', 'zh-CN': '确认删除' },
  'profiles.drawer.discardConfirm.title': {
    en: 'Discard unsaved changes',
    'zh-CN': '放弃未保存的修改',
  },
  'profiles.drawer.discardConfirm.body': {
    en: 'The form has unsaved changes that will be lost on close. Discard them and close?',
    'zh-CN': '当前表单有尚未保存的修改，关闭后将丢失这些改动。确定要放弃修改并关闭吗？',
  },
  'profiles.drawer.discardConfirm.confirm': { en: 'Discard changes', 'zh-CN': '放弃修改' },
  'profiles.drawer.discardConfirm.cancel': { en: 'Keep editing', 'zh-CN': '继续编辑' },
} satisfies MessageTable
