import type { LocalizedText } from '@helm/protocol/browser'

/** Defaults shared by host and plugin UI primitives. */
export const uiCopy = {
  copy: { en: 'Copy', 'zh-CN': '复制' },
  copied: { en: 'Copied', 'zh-CN': '已复制' },
  copyFailed: { en: 'Copy failed', 'zh-CN': '复制失败' },
  copyFailureHint: {
    en: 'Copy failed (environment restriction; select and copy manually)',
    'zh-CN': '复制失败（环境限制，请选中文字手动复制）',
  },
  loading: { en: 'Loading…', 'zh-CN': '加载中…' },
  noData: { en: 'No data', 'zh-CN': '暂无数据' },
  select: { en: 'Select…', 'zh-CN': '请选择…' },
  searchOptions: { en: 'Search options', 'zh-CN': '搜索选项' },
  searchPlaceholder: { en: 'Search options…', 'zh-CN': '搜索选项…' },
  selectAll: { en: 'Select all', 'zh-CN': '全选' },
  clear: { en: 'Clear', 'zh-CN': '清空' },
  view: { en: 'View', 'zh-CN': '视图' },
  renderAgain: { en: 'Render again', 'zh-CN': '重新渲染' },
} as const satisfies Record<string, LocalizedText>
