/**
 * Skill center display copy. Owner: the profiles-skills partition.
 *
 * zh-CN copy is backfilled verbatim from the pre-English baseline (b4a611a65)
 * wherever the string existed; placeholders only adapt to `{param}` syntax.
 */
import type { MessageTable } from '../messages.js'

export const skillsMessages = {
  // Category taxonomy shared by the filter tabs and the source badges
  // ('all'/'builtin' reuse common.all / common.builtIn).
  'skills.category.plugins': { en: 'Plugins', 'zh-CN': '插件' },
  'skills.category.shared': { en: 'Shared', 'zh-CN': '共享' },
  'skills.category.node': { en: 'Node', 'zh-CN': '节点' },
  'skills.category.workspace': { en: 'Workspace', 'zh-CN': '工作区' },

  // Skill scope picker (physical nodeId+cwd coordinates; Hub is the default).
  'skills.scope.label': { en: 'Skill scope', 'zh-CN': '技能作用域' },
  'skills.scope.hub': { en: 'Hub (global)', 'zh-CN': 'Hub（全局）' },
  'skills.scope.hubMeta': { en: 'Hub dataDir and shared roots', 'zh-CN': 'Hub 数据目录与共享根' },
  'skills.scope.conversationMeta': { en: 'Conversation', 'zh-CN': '会话' },
  'skills.scope.profileMeta': { en: 'Profile', 'zh-CN': '角色' },
  'skills.scope.loading': { en: 'Loading merged catalog…', 'zh-CN': '正在加载合并目录…' },
  'skills.scope.loadFailed': {
    en: 'Failed to load the merged skill catalog: {error}',
    'zh-CN': '加载合并技能目录失败：{error}',
  },
  'skills.scope.retry': { en: 'Retry', 'zh-CN': '重试' },
  'skills.scope.nodeUnavailable': {
    en: 'Node skill library unavailable: {reason}',
    'zh-CN': '节点技能库不可用：{reason}',
  },
  'skills.scope.shadowed': {
    en: 'Same-name Hub skills win; node copies not listed: {ids}',
    'zh-CN': '同名 Hub 技能优先生效，节点副本未收录：{ids}',
  },
  'skills.scope.reloadTitle': { en: 'Reload the scoped skill catalog', 'zh-CN': '重新加载作用域技能目录' },

  // Node-sourced skill detail (scope note under the drawer title).
  'skills.drawer.nodeSource': { en: 'Node workspace source: {node} · {cwd}', 'zh-CN': '节点工作区来源：{node} · {cwd}' },

  // SkillCard copy.
  'skills.card.noDescription': { en: 'No description', 'zh-CN': '暂无描述' },
  'skills.card.sourceTitle': { en: 'Source: {label}', 'zh-CN': '来源：{label}' },
  'skills.card.copyCommandTitle': {
    en: 'Copy slash command {command}',
    'zh-CN': '复制斜杠指令 {command}',
  },
  'skills.card.copied': { en: 'Copied', 'zh-CN': '已复制' },
  'skills.card.referenceFiles': { en: '{count} reference files', 'zh-CN': '{count} 个参考文件' },

  // SkillCenter copy ('Refresh' button label reuses common.refresh).
  'skills.center.title': { en: 'Skills Center', 'zh-CN': '技能中心' },
  'skills.center.refreshTitle': { en: 'Refresh skill list', 'zh-CN': '刷新技能清单' },
  'skills.center.searchPlaceholder': {
    en: 'Search skill name, ID, description or reference files…',
    'zh-CN': '搜索技能名称、ID、描述或参考文件…',
  },
  'skills.center.searchLabel': { en: 'Search skills', 'zh-CN': '搜索技能' },
  'skills.center.clearSearch': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'skills.center.filterLabel': { en: 'Filter by skill category', 'zh-CN': '技能分类筛选' },
  'skills.center.emptyTitle': { en: 'No matching skills', 'zh-CN': '未找到匹配的技能' },
  'skills.center.emptyHint': {
    en: 'Try adjusting the search keywords or switching category tabs.',
    'zh-CN': '请尝试调整搜索关键字或切换分类标签。',
  },
  'skills.center.resetFilters': { en: 'Reset filters', 'zh-CN': '重置筛选条件' },

  // SkillDetailDrawer copy ('Close'/'Loading…' reuse common.close/common.loading).
  'skills.drawer.detailsTitle': { en: '{name} skill details', 'zh-CN': '{name} 技能详情' },
  'skills.drawer.detailsFallback': { en: 'Skill details', 'zh-CN': '技能详情' },
  'skills.drawer.machineSharedRoot': { en: 'Machine-level shared root', 'zh-CN': '机器级共享根' },
  'skills.drawer.noSkillSelected': { en: 'No skill selected', 'zh-CN': '未选择技能' },
  'skills.drawer.toolbarLabel': { en: 'Skill file reader toolbar', 'zh-CN': '技能文件阅读工具条' },
  'skills.drawer.chooseFile': { en: 'Choose a skill file', 'zh-CN': '选择技能文件' },
  'skills.drawer.readingMode': { en: 'Reading mode', 'zh-CN': '阅读模式' },
  'skills.drawer.richTitle': { en: 'Rich Markdown reading', 'zh-CN': 'Markdown 富文本阅读' },
  'skills.drawer.richMode': { en: 'Rich text', 'zh-CN': '富文本' },
  'skills.drawer.sourceTitle': { en: 'View monospace source', 'zh-CN': '查看等宽源码' },
  'skills.drawer.sourceMode': { en: 'Source', 'zh-CN': '源码' },
  'skills.drawer.fileIndexTitle': {
    en: 'File {index} of {total}',
    'zh-CN': '第 {index} 个文件，共 {total} 个',
  },
  'skills.drawer.linesTitle': { en: '{file} total lines', 'zh-CN': '{file} 总行数' },
  'skills.drawer.linesCount': { en: '{count} lines', 'zh-CN': '{count} 行' },
  'skills.drawer.copy': { en: 'Copy', 'zh-CN': '复制' },
  'skills.drawer.readFailed': { en: 'Failed to read: {error}', 'zh-CN': '读取失败：{error}' },
  'skills.drawer.readingContent': { en: 'Reading skill content…', 'zh-CN': '正在读取技能内容…' },
  'skills.drawer.fileEmpty': { en: 'The file is empty', 'zh-CN': '文件内容为空' },

  // Compact file reader model copy (frontmatter metadata table).
  'skills.reader.metadataHeading': { en: 'Skill metadata', 'zh-CN': '技能元数据' },
  'skills.reader.mainFile': { en: 'Main file', 'zh-CN': '主规程' },
  'skills.reader.fieldHeader': { en: 'Field', 'zh-CN': '字段' },
  'skills.reader.valueHeader': { en: 'Value', 'zh-CN': '内容' },
} satisfies MessageTable
