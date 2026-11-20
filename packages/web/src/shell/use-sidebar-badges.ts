/**
 * 侧栏视图徽标 Hook：把 sidebar.item badge 声明接进 store 现场。
 *
 * 单一职责：为携带 badge 声明的视图项（Rail 快捷入口 / 左栏视图行 / 移动端
 * 快捷导航簇同源）按需发现并加载对应插件 public doc（ensurePluginDoc 幂等，
 * 多处挂载不重复请求），并从 pluginDocs 解析出「项 key -> 已解析徽标」映射。
 * 无信号（计数为 0 且无静默灯点）不进映射——消费方零视觉残留；插件停用后
 * 其 UI 贡献与 doc 均从 store 消失，徽标自然归零，无需特判插件 ID。
 */
import { useEffect, useMemo } from 'react'
import { useAuthConnection, usePluginDocsState, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  collectSidebarBadgeDocs,
  resolveSidebarItemBadge,
  type ResolvedSidebarBadge,
  type SidebarViewItem,
} from './sidebar-model.js'

/** 返回「视图项 key（`${pluginId}/${spec.id}`）-> 已解析徽标」只读映射（无信号项缺省）。 */
export function useSidebarBadges(items: ReadonlyArray<SidebarViewItem>): ReadonlyMap<string, ResolvedSidebarBadge> {
  const { authenticated } = useAuthConnection()
  const { locale } = useWebLocale()
  const pluginDocs = usePluginDocsState()
  const { ensurePluginDoc } = useStoreActions()

  const badgeDocs = useMemo(() => collectSidebarBadgeDocs(items), [items])
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) void ensurePluginDoc(ref.pluginId, ref.doc)
  }, [badgeDocs, authenticated, ensurePluginDoc])

  return useMemo(() => {
    const map = new Map<string, ResolvedSidebarBadge>()
    for (const item of items) {
      const badge = item.badge
      if (badge === undefined) continue
      const resolved = resolveSidebarItemBadge(badge, pluginDocs[`${item.pluginId}/${badge.doc}`], locale)
      if (resolved !== null) map.set(item.key, resolved)
    }
    return map
  }, [items, pluginDocs, locale])
}
