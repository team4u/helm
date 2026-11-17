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
} satisfies MessageTable
