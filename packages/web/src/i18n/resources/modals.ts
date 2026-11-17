/**
 * Modal-support model copy (node picker option labels, node enrollment ID
 * validation, node upgrade gating hints, node usage label; provider auth and
 * profile editor skills models carry no display copy). Owner: the
 * profiles-skills partition.
 *
 * These models are consumed by modules owned by other partitions; their pure
 * functions take an optional `t` and default to the English bridge translator
 * so unmigrated call sites keep rendering English exactly as before.
 */
import type { MessageTable } from '../messages.js'

export const modalsMessages = {
  // Node enrollment ID validation (form display copy).
  'modals.nodeId.empty': { en: 'Enter a node ID', 'zh-CN': '请输入节点 ID' },
  'modals.nodeId.localReserved': {
    en: 'local is the built-in local node; no access token needed',
    'zh-CN': 'local 是内建本机节点，无需签发接入令牌',
  },
  'modals.nodeId.invalidChars': {
    en: 'Node ID must start with a letter or digit and contain only letters, digits and . _ - (max 128 characters)',
    'zh-CN': '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符',
  },

  // Node option labels for conversation/profile node pickers.
  'modals.nodeOption.local': { en: '{id} (local)', 'zh-CN': '{id} (本机)' },
  'modals.nodeOption.offline': { en: '{id} (offline)', 'zh-CN': '{id} (离线)' },

  // Node upgrade confirm gating hints.
  'modals.nodeUpgrade.offline': { en: 'Node is offline; cannot upgrade', 'zh-CN': '节点已离线，无法升级' },
  'modals.nodeUpgrade.invalidTarget': {
    en: 'Target version is not valid SemVer (e.g. 0.2.0)',
    'zh-CN': '目标版本不是合法 SemVer（示例 0.2.0）',
  },
  'modals.nodeUpgrade.checkFirst': {
    en: 'Check for updates first, or enter an explicit target version',
    'zh-CN': '请先检查更新，或填写明确的目标版本',
  },
  'modals.nodeUpgrade.upToDate': {
    en: 'Already up to date; tick force reinstall/retry or enter a target version',
    'zh-CN': '当前已是最新版本；可勾选强制重装/重试，或填写目标版本',
  },

  // Node resource usage summary label.
  'modals.nodeUsage.label': { en: '{used} / {total} ({percent}%)', 'zh-CN': '{used} / {total}（{percent}%）' },

  // Command palette (CommandPaletteModal)
  'modals.palette.dialogTitle': {
    en: 'Command palette and global search',
    'zh-CN': '命令面板与全局搜索',
  },
  'modals.palette.searchAria': {
    en: 'Search message text, jump to a conversation, or run a command',
    'zh-CN': '搜索消息正文、跳转会话或执行命令',
  },
  'modals.palette.searchPlaceholder': {
    en: 'Search message text, jump to a conversation, or run a command...',
    'zh-CN': '搜索消息正文、跳转会话或执行命令...',
  },
  'modals.palette.searching': { en: 'Searching', 'zh-CN': '搜索中' },
  'modals.palette.escToClose': { en: 'Esc to close', 'zh-CN': 'Esc 关闭' },
  'modals.palette.closePreview': { en: 'Close command content preview', 'zh-CN': '关闭命令内容预览' },
  'modals.palette.previewLabel': { en: 'Command {id} content', 'zh-CN': '命令 {id} 内容' },
  'modals.palette.noResults': { en: 'No matching results', 'zh-CN': '未找到匹配结果' },
  'modals.palette.emptyHint': {
    en: 'Type keywords to search, or pick a command below',
    'zh-CN': '输入关键词进行搜索，或选择下方快捷命令',
  },
  'modals.palette.cmdExecuted': { en: 'Command executed', 'zh-CN': '命令已执行' },
  'modals.palette.cmdFailed': { en: 'Command execution failed', 'zh-CN': '命令执行失败' },
  'modals.palette.convSnippet': { en: 'Conversation #{id} / {profileId}', 'zh-CN': '会话 #{id} / {profileId}' },
  'modals.palette.recentSnippet': {
    en: 'Recent conversation #{id} / {profileId}',
    'zh-CN': '最近会话 #{id} / {profileId}',
  },
  'modals.palette.pluginTitle': { en: 'Plugin: {name}', 'zh-CN': '插件：{name}' },
  'modals.palette.pluginHint': {
    en: 'View and configure {id} in the plugin center',
    'zh-CN': '在插件中心查看并配置 {id}',
  },
  'modals.palette.cmd.toggleModelPicker': { en: 'Switch current model', 'zh-CN': '切换当前模型' },
  'modals.palette.cmd.toggleProcessGroups': {
    en: 'Expand / collapse recent process steps',
    'zh-CN': '展开 / 收起最近过程步骤',
  },
  'modals.palette.cmd.closeWorkbench': { en: 'Close workbench drawer', 'zh-CN': '关闭右侧工作台' },
  'modals.palette.cmd.openWorkbench': { en: 'Open workbench drawer', 'zh-CN': '打开右侧工作台' },
  'modals.palette.cmd.newConversation': { en: 'New conversation', 'zh-CN': '新建会话' },
  'modals.palette.cmd.selectProfileFirst': { en: 'Select a profile first', 'zh-CN': '请先选择角色' },
  'modals.palette.cmd.closeSplit': { en: 'Close right split view', 'zh-CN': '关闭右侧分屏' },
  'modals.palette.cmd.expandSidebar': { en: 'Expand desktop sidebar', 'zh-CN': '展开桌面侧栏' },
  'modals.palette.cmd.collapseSidebar': { en: 'Collapse desktop sidebar', 'zh-CN': '收起桌面侧栏' },
  'modals.palette.cmd.gotoAssistant': { en: 'Open personal assistant profile', 'zh-CN': '打开个人助理角色' },
  'modals.palette.cmd.openProfiles': { en: 'Open agent profile center', 'zh-CN': '打开智能体角色中心' },
  'modals.palette.cmd.openModels': {
    en: 'Open models and credentials center',
    'zh-CN': '打开模型与凭证中心',
  },
  'modals.palette.cmd.openSkills': { en: 'Open skills center', 'zh-CN': '打开技能中心' },
  'modals.palette.cmd.openNodes': { en: 'Open compute nodes center', 'zh-CN': '打开计算节点中心' },
  'modals.palette.cmd.openPlugins': { en: 'Open plugins center', 'zh-CN': '打开插件中心' },
  'modals.palette.cmd.themeToLight': { en: 'Switch to light mode', 'zh-CN': '切换为浅色模式' },
  'modals.palette.cmd.themeToDark': { en: 'Switch to dark mode', 'zh-CN': '切换为暗色模式' },
  'modals.palette.cmd.themeToSystem': { en: 'Switch to system theme', 'zh-CN': '切换为跟随系统主题' },
  'modals.palette.cmd.localeToEnglish': { en: 'Switch language to English', 'zh-CN': '切换语言为 English' },
  'modals.palette.cmd.localeToZhCn': { en: 'Switch language to 简体中文', 'zh-CN': '切换语言为简体中文' },
  'modals.palette.cmd.localeToAuto': {
    en: 'Switch language to Auto (browser)',
    'zh-CN': '切换语言为自动（跟随浏览器）',
  },
  'modals.palette.cmd.quietNotifyDisable': {
    en: 'Disable background browser notifications',
    'zh-CN': '关闭后台浏览器通知',
  },
  'modals.palette.cmd.quietNotifyEnable': {
    en: 'Enable background browser notifications (alert when a conversation completes or awaits input while the page is in the background)',
    'zh-CN': '开启后台浏览器通知（页面在后台时，会话完成或需要输入将提醒）',
  },
} satisfies MessageTable
