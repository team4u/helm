/**
 * Shared cross-domain message table. Seeded once with the high-frequency
 * generic verbs/statuses from the en/zh translation baseline (b4a611a65);
 * domain tables must NOT redefine these ids.
 *
 * Usage rule for domain partitions: reuse a `common.*` key only when both the
 * English and the Chinese copy fit the usage exactly; otherwise declare a
 * domain-specific key in the owning resource file.
 */
import type { MessageTable } from '../messages.js'

export const commonMessages = {
  'common.close': { en: 'Close', 'zh-CN': '关闭' },
  'common.collapse': { en: 'Collapse', 'zh-CN': '收起' },
  'common.expandAll': { en: 'Expand all', 'zh-CN': '全部展开' },
  'common.retry': { en: 'Retry', 'zh-CN': '重试' },
  'common.cancel': { en: 'Cancel', 'zh-CN': '取消' },
  'common.delete': { en: 'Delete', 'zh-CN': '删除' },
  'common.save': { en: 'Save', 'zh-CN': '保存' },
  'common.rename': { en: 'Rename', 'zh-CN': '重命名' },
  'common.download': { en: 'Download', 'zh-CN': '下载' },
  'common.refresh': { en: 'Refresh', 'zh-CN': '刷新' },
  'common.search': { en: 'Search', 'zh-CN': '搜索' },
  'common.all': { en: 'All', 'zh-CN': '全部' },
  'common.online': { en: 'Online', 'zh-CN': '在线' },
  'common.offline': { en: 'Offline', 'zh-CN': '离线' },
  'common.loading': { en: 'Loading…', 'zh-CN': '加载中…' },
  'common.enabled': { en: 'Enabled', 'zh-CN': '已启用' },
  'common.disabled': { en: 'Disabled', 'zh-CN': '已停用' },
  'common.unknown': { en: 'Unknown', 'zh-CN': '未知' },
  'common.default': { en: 'Default', 'zh-CN': '默认' },
  'common.builtIn': { en: 'Built-in', 'zh-CN': '内置' },
  'common.none': { en: 'None', 'zh-CN': '无' },
  'common.local': { en: 'local', 'zh-CN': '本机' },
} satisfies MessageTable
