/**
 * Plugin center display copy (PluginCenter / PluginCard / PluginDetailDrawer /
 * PluginInstallModal plus plugin-card-model / plugin-center-model /
 * plugin-package-model).
 *
 * zh-CN copy is backfilled from the pre-English baseline (b4a611a65)
 * wherever the string existed; interpolation uses `{param}`.
 */
import type { MessageTable } from '../messages.js'

export const pluginsMessages = {
  // Shared plugin labels
  'plugins.resident': { en: 'Resident', 'zh-CN': '常驻' },
  'plugins.status.error': { en: 'Error', 'zh-CN': '异常' },
  'plugins.openView': { en: 'Open view', 'zh-CN': '打开视图' },
  'plugins.installPlugin': { en: 'Install plugin', 'zh-CN': '安装插件' },

  // Plugin descriptions & error stage labels (plugin-card-model)
  'plugins.desc.toolsPart': { en: '{count} tools', 'zh-CN': '{count} 个工具' },
  'plugins.desc.actionsPart': { en: '{count} actions', 'zh-CN': '{count} 个动作' },
  'plugins.desc.hooksPart': { en: '{count} hooks', 'zh-CN': '{count} 个钩子' },
  'plugins.desc.listSeparator': { en: ', ', 'zh-CN': '、' },
  'plugins.desc.providesCapabilities': {
    en: 'Provides {parts} capabilities.',
    'zh-CN': '提供 {parts}能力支持。',
  },
  'plugins.desc.default': {
    en: 'System extension plugin component.',
    'zh-CN': '系统扩展插件组件。',
  },
  'plugins.errorStage.scan': {
    en: 'Manifest/entry resolution (scan)',
    'zh-CN': '清单/入口解析（scan）',
  },
  'plugins.errorStage.load': {
    en: 'Module loading (load)',
    'zh-CN': '模块加载（load）',
  },
  'plugins.errorStage.define': {
    en: 'Definition registration (define)',
    'zh-CN': '定义注册（define）',
  },
  'plugins.errorStage.enable': {
    en: 'Enable activation (enable)',
    'zh-CN': '启用激活（enable）',
  },
  'plugins.errorStage.unknown': { en: 'Unknown stage', 'zh-CN': '未知阶段' },

  // PluginCard
  'plugins.card.switchLockedTitle': {
    en: 'Resident plugins cannot be disabled',
    'zh-CN': '常驻插件不可停用',
  },
  'plugins.card.switchLoadBrokenTitle': {
    en: 'Plugin failed to load; click to see error details',
    'zh-CN': '插件加载失败，请点击查看错误详情',
  },
  'plugins.card.switchDisableTitle': { en: 'Click to disable', 'zh-CN': '点击停用' },
  'plugins.card.switchEnableTitle': { en: 'Click to enable', 'zh-CN': '点击启用' },
  'plugins.card.versionTitle': { en: 'Version {version}', 'zh-CN': '版本 {version}' },
  'plugins.card.lockedTitle': {
    en: 'Resident core plugin; cannot be disabled',
    'zh-CN': '常驻核心插件，不可停用',
  },
  'plugins.card.failedFallbackTitle': {
    en: 'Plugin failed to load or enable',
    'zh-CN': '插件加载或启用失败',
  },
  'plugins.card.toolsTitle': { en: '{count} Agent Tools', 'zh-CN': '{count} 个 Agent Tools' },
  'plugins.card.actionsTitle': {
    en: '{count} CLI/HTTP Actions',
    'zh-CN': '{count} 个 CLI/HTTP Actions',
  },
  'plugins.card.hooksTitle': {
    en: '{count} kernel lifecycle hooks',
    'zh-CN': '{count} 个内核生命周期钩子',
  },
  'plugins.card.openViewTitle': { en: 'Open plugin view', 'zh-CN': '打开插件视图' },
  'plugins.card.openViewAria': { en: 'Open {name} view', 'zh-CN': '打开 {name} 视图' },
  'plugins.card.switchAria': { en: '{name} switch', 'zh-CN': '{name} 开关' },

  // PluginCenter
  'plugins.center.title': { en: 'Plugin Center', 'zh-CN': '扩展插件中心' },
  'plugins.center.installTitle': {
    en: 'Install external plugins from npm, Git or a local path',
    'zh-CN': '从 npm、Git 或本地路径安装外部插件',
  },
  'plugins.center.searchPlaceholder': {
    en: 'Search plugin name, ID, tool or action…',
    'zh-CN': '搜索插件名称、ID、Tool 或 Action…',
  },
  'plugins.center.searchAria': { en: 'Search plugins', 'zh-CN': '搜索插件' },
  'plugins.center.clearSearch': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'plugins.center.filterAria': { en: 'Filter by plugin status', 'zh-CN': '插件状态筛选' },
  'plugins.center.emptyTitle': { en: 'No matching plugins', 'zh-CN': '未找到匹配的插件' },
  'plugins.center.emptyHint': {
    en: 'Try adjusting the search keywords or switching the status filter.',
    'zh-CN': '请尝试调整搜索关键字或切换启用状态筛选。',
  },
  'plugins.center.resetSearch': { en: 'Reset search', 'zh-CN': '重置搜索条件' },

  // PluginCenter notices
  'plugins.notice.installEnableFailedTitle': {
    en: 'Plugin installed, but enable failed',
    'zh-CN': '插件已安装，但启用失败',
  },
  'plugins.notice.enabledTitle': { en: 'Plugin enabled', 'zh-CN': '插件已启用' },
  'plugins.notice.enabledBody': { en: '{name} enabled successfully', 'zh-CN': '{name} 已成功启用' },
  'plugins.notice.disabledTitle': { en: 'Plugin disabled', 'zh-CN': '插件已停用' },
  'plugins.notice.disabledBody': {
    en: '{name} disabled successfully',
    'zh-CN': '{name} 已成功停用',
  },
  'plugins.notice.enableFailedTitle': {
    en: 'Failed to enable plugin',
    'zh-CN': '启用插件失败',
  },
  'plugins.notice.disableFailedTitle': {
    en: 'Failed to disable plugin',
    'zh-CN': '停用插件失败',
  },
  'plugins.notice.liveTasksError': {
    en: 'Operation failed: plugin has live tasks ({code})',
    'zh-CN': '操作失败：插件存在在途任务（{code}）',
  },

  // Plugin package model & install modal
  'plugins.package.sourceKind.npm': { en: 'npm package', 'zh-CN': 'npm 包' },
  'plugins.package.sourceKind.git': { en: 'Git repository', 'zh-CN': 'Git 仓库' },
  'plugins.package.sourceKind.local': { en: 'Local path', 'zh-CN': '本地路径' },
  'plugins.package.sourceKind.unknown': { en: 'Unrecognized', 'zh-CN': '无法识别' },
  'plugins.package.sourceBadge.local': { en: 'Local', 'zh-CN': '本地' },
  'plugins.package.doctorPassed': {
    en: 'Pre-install doctor passed',
    'zh-CN': '安装前自检通过',
  },
  'plugins.package.doctorFailedItem': {
    en: '{id} ({code}): {message}',
    'zh-CN': '{id}（{code}）：{message}',
  },
  'plugins.package.doctorSeparator': { en: '; ', 'zh-CN': '；' },
  'plugins.package.doctorFailed': {
    en: 'Pre-install doctor failed with {count} failures: {details}',
    'zh-CN': '安装前自检未通过，共 {count} 项失败：{details}',
  },
  'plugins.package.action.install': { en: 'Install', 'zh-CN': '安装' },
  'plugins.package.action.update': { en: 'Update', 'zh-CN': '更新' },
  'plugins.package.action.uninstall': { en: 'Uninstall', 'zh-CN': '卸载' },
  'plugins.package.errorLiveTasks': {
    en: '{action} failed: plugin has live tasks ({code}). Wait for them to finish or abort, then retry.',
    'zh-CN': '{action}失败：插件存在在途任务（{code}）。请等待任务结束或中止后再试。',
  },
  'plugins.package.errorWithMessage': {
    en: '{action} failed: {message}',
    'zh-CN': '{action}失败：{message}',
  },
  'plugins.package.errorGeneric': { en: '{action} failed', 'zh-CN': '{action}失败' },
  'plugins.package.unknownVersion': { en: 'Unknown version', 'zh-CN': '未知版本' },
  'plugins.package.updatedBody': {
    en: 'Updated to {version} (was {previous})',
    'zh-CN': '已更新到 {version}（此前 {previous}）',
  },
  'plugins.package.unchangedBody': {
    en: 'Source unchanged; still at {version}',
    'zh-CN': '源未变化，当前仍为 {version}',
  },
  'plugins.package.updateNoticeTitle': {
    en: 'Plugin package updated',
    'zh-CN': '插件包已更新',
  },
  'plugins.package.updateNoticeBody': { en: '{name}: {detail}', 'zh-CN': '{name}：{detail}' },
  'plugins.package.removeNoticeTitle': {
    en: 'Plugin package uninstalled',
    'zh-CN': '插件包已卸载',
  },
  'plugins.package.removeNoticeBody': {
    en: '{name} removed ({id})',
    'zh-CN': '{name} 已移除（{id}）',
  },
  'plugins.package.sectionTitle': { en: 'Package', 'zh-CN': '包管理' },
  'plugins.package.sourceLabel': { en: 'Source', 'zh-CN': '来源' },
  'plugins.package.installedVersionLabel': {
    en: 'Installed version',
    'zh-CN': '已安装版本',
  },
  'plugins.package.installedAtLabel': { en: 'Installed at', 'zh-CN': '安装时间' },
  'plugins.package.updating': { en: 'Updating…', 'zh-CN': '正在更新…' },
  'plugins.package.checkUpdates': { en: 'Check for updates', 'zh-CN': '检查更新' },
  'plugins.package.uninstalling': { en: 'Uninstalling…', 'zh-CN': '正在卸载…' },
  'plugins.package.uninstallPlugin': { en: 'Uninstall plugin', 'zh-CN': '卸载插件' },
  'plugins.package.confirmUninstallAria': {
    en: 'Confirm plugin uninstall',
    'zh-CN': '确认卸载插件',
  },
  'plugins.package.confirmUninstallBody': {
    en: 'Uninstall {name} ({id})? The install directory and registry entry will be deleted; this cannot be undone.',
    'zh-CN': '确定卸载 {name}（{id}）？将删除安装目录与注册记录，该操作不可恢复。',
  },
  'plugins.package.confirmUninstall': { en: 'Confirm uninstall', 'zh-CN': '确认卸载' },

  // PluginInstallModal
  'plugins.install.description': {
    en: 'Install external plugins from an npm package, Git repository or local path',
    'zh-CN': '从 npm 包、Git 仓库或本地路径安装外部插件',
  },
  'plugins.install.sourceLabel': { en: 'Install source', 'zh-CN': '安装来源' },
  'plugins.install.enableAfterInstall': {
    en: 'Enable after install',
    'zh-CN': '安装后启用',
  },
  'plugins.install.enableNow': {
    en: 'Enable immediately after install',
    'zh-CN': '安装完成后立即启用',
  },
  'plugins.install.keepDisabled': {
    en: 'Keep disabled after install',
    'zh-CN': '安装后保持停用',
  },
  'plugins.install.securityWarning': {
    en: 'Plugins run inside the Hub process with host privileges and are not sandboxed. Only install plugin packages from trusted sources.',
    'zh-CN': '插件在 Hub 进程内运行，拥有宿主权限，不是沙箱。仅安装可信来源的插件包。',
  },
  'plugins.install.installing': { en: 'Installing…', 'zh-CN': '正在安装…' },
  'plugins.install.submit': { en: 'Install', 'zh-CN': '安装' },

  // PluginDetailDrawer
  'plugins.drawer.ariaSelected': { en: '{name} details', 'zh-CN': '{name} 详情' },
  'plugins.drawer.titleFallback': { en: 'Plugin details', 'zh-CN': '插件详情' },
  'plugins.drawer.dependenciesTitle': {
    en: 'Dependencies: {deps} (must be enabled first)',
    'zh-CN': '依赖插件：{deps}（启用前必须已启用）',
  },
  'plugins.drawer.dependenciesCount': { en: 'Dependencies {count}', 'zh-CN': '依赖 {count}' },
  'plugins.drawer.failedToLoad': { en: 'Failed to load', 'zh-CN': '加载失败' },
  'plugins.drawer.failedNoteDetail': {
    en: '{code}: {message} (stage {stage})',
    'zh-CN': '{code}：{message}（阶段 {stage}）',
  },
  'plugins.drawer.noSelection': { en: 'No plugin selected', 'zh-CN': '未选择插件' },
  'plugins.drawer.currentStatus': { en: 'Current status', 'zh-CN': '当前状态' },
  'plugins.drawer.errorBadgeTitle': {
    en: 'Plugin failed to load or enable; see diagnostics below',
    'zh-CN': '插件加载或启用失败，详见下方诊断信息',
  },
  'plugins.drawer.openMainViewTitle': { en: 'Open main view', 'zh-CN': '打开主视图' },
  'plugins.drawer.openMainViewMultiTitle': {
    en: 'Open main view {screenId} ({count} views in total)',
    'zh-CN': '打开主视图 {screenId}（共 {count} 个视图）',
  },
  'plugins.drawer.openSplitTitle': {
    en: 'Open side-by-side in the right split',
    'zh-CN': '在右侧分屏并排打开',
  },
  'plugins.drawer.openSplit': { en: 'Open in split', 'zh-CN': '右屏打开' },
  'plugins.drawer.disablePlugin': { en: 'Disable plugin', 'zh-CN': '停用插件' },
  'plugins.drawer.enablePlugin': { en: 'Enable plugin', 'zh-CN': '启用插件' },
  'plugins.drawer.disableInUseError': {
    en: 'Disable failed: the plugin holds persistent resources (plugin_in_use).',
    'zh-CN': '停用失败：插件存在关联的持久资源占用（plugin_in_use）。',
  },
  'plugins.drawer.disableLiveTasksError': {
    en: 'Disable failed: plugin has live tasks ({code}). Wait for them to finish or abort them, then retry.',
    'zh-CN': '停用失败：插件存在在途任务（{code}）。请等待任务结束或中止后再试。',
  },
  'plugins.drawer.diagnosticTitle': {
    en: 'Plugin failed to load or enable',
    'zh-CN': '插件加载或启用失败',
  },
  'plugins.drawer.diagnosticMetaPrefix': {
    en: 'Failure stage: {stage} · Error code: ',
    'zh-CN': '故障阶段：{stage} · 错误码：',
  },
  'plugins.drawer.inUseTitle': {
    en: 'Plugin resource confirmation (plugin_in_use)',
    'zh-CN': '插件资源占用确认（plugin_in_use）',
  },
  'plugins.drawer.inUseHint': {
    en: 'The related resources below go offline after disabling; configuration is kept and restored on next enable:',
    'zh-CN': '停用后以下关联资源将暂时失效，配置保留待下次启用恢复：',
  },
  'plugins.drawer.forceDisable': { en: 'Force disable', 'zh-CN': '强制停用' },
  'plugins.drawer.capabilities': { en: 'Capabilities', 'zh-CN': '能力清单' },
  'plugins.drawer.noTools': { en: 'No declared tools', 'zh-CN': '无声明工具' },
  'plugins.drawer.noActions': { en: 'No declared actions', 'zh-CN': '无声明动作' },
  'plugins.drawer.noHooks': { en: 'No hooks', 'zh-CN': '无拦截钩子' },
  'plugins.drawer.configuration': { en: 'Configuration', 'zh-CN': '配置项' },
  'plugins.drawer.loadingConfig': {
    en: 'Loading configuration...',
    'zh-CN': '正在读取配置...',
  },
  'plugins.drawer.configUnavailable': {
    en: 'Configuration load failed or not declared.',
    'zh-CN': '配置读取失败或未声明。',
  },
  'plugins.drawer.settingsPanelsCount': {
    en: 'Extension settings panels ({count})',
    'zh-CN': '扩展设置面板（{count}）',
  },
  'plugins.drawer.settingsPanels': {
    en: 'Extension settings panels',
    'zh-CN': '扩展设置面板',
  },
  'plugins.drawer.settingsPanelLabel': {
    en: 'Settings panel {id}',
    'zh-CN': '设置面板 {id}',
  },

  // PluginConfigForm
  'plugins.config.empty': {
    en: 'This plugin declares no configuration options.',
    'zh-CN': '该插件未声明配置项。',
  },
  'plugins.config.configuredTitle': {
    en: 'Explicitly configured by user',
    'zh-CN': '用户已显式配置',
  },
  'plugins.config.configured': { en: 'Configured', 'zh-CN': '已配置' },
  'plugins.config.defaultTitle': { en: 'Using default value', 'zh-CN': '当前使用默认值' },
  'plugins.config.switchOn': { en: 'On', 'zh-CN': '开启' },
  'plugins.config.switchOff': { en: 'Off', 'zh-CN': '关闭' },
  'plugins.config.secretConfiguredPlaceholder': {
    en: 'Configured (leave empty to keep unchanged)',
    'zh-CN': '已配置（留空保持不变）',
  },
  'plugins.config.secretUnconfiguredPlaceholder': {
    en: 'Not configured',
    'zh-CN': '未配置',
  },
  'plugins.config.clearSecretTitle': { en: 'Clear saved secret', 'zh-CN': '清除已保存密钥' },
  'plugins.config.resetDefaultTitle': { en: 'Reset to default', 'zh-CN': '重置为默认值' },
  'plugins.config.clear': { en: 'Clear', 'zh-CN': '清除' },
  'plugins.config.reset': { en: 'Reset', 'zh-CN': '重置' },
  'plugins.config.saved': { en: 'Saved', 'zh-CN': '已保存' },
  'plugins.config.save': { en: 'Save configuration', 'zh-CN': '保存配置' },
} satisfies MessageTable
