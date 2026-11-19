/**
 * 全局并发态势 Hook：把 attention-model 纯函数接进 store 现场。
 *
 * 单一职责：从 store 各切片（会话 / 插件 / Profile / workbench 面板 / 插件
 * doc / 当前导航目标）推导后台在途索引与态势条目，并自洽发现、按需加载
 * workbench badge doc——不依赖侧栏抽屉是否展开（移动端合着抽屉时后台
 * 任务也不失明；ensurePluginDoc 幂等，多处挂载不重复请求）。
 * Sidebar 平铺区、移动端汉堡微标与桌面折叠 Rail 微标共用本 Hook 的同源输出。
 */
import { useEffect, useMemo } from 'react'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePluginDocsState,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import {
  buildAttentionModel,
  collectViewedConversationIds,
  type AttentionModelResult,
  type GlobalAttentionIndicator,
} from './attention-model.js'

export interface GlobalAttentionValue extends AttentionModelResult {
  /** 后台在途索引（与会话行单灯位、插件 SDK 快照共享同一事实源）。 */
  background: ConversationBackgroundIndex
}

export function useGlobalAttention(): GlobalAttentionValue {
  const { authenticated } = useAuthConnection()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const groupedUi = useGroupedUi()
  const conversations = useConversations()
  const pluginDocs = usePluginDocsState()
  const plugins = usePlugins()
  const { profiles } = useProfilesSlice()
  const { ensurePluginDoc } = useStoreActions()
  const { t } = useWebLocale()

  const background = useMemo(
    () =>
      summarizeConversationBackgroundActivity({
        panels: groupedUi.workbenchPanels,
        conversations,
        pluginDocs,
        t,
      }),
    [groupedUi.workbenchPanels, conversations, pluginDocs, t],
  )
  const badgeDocs = useMemo(
    () => collectBackgroundBadgeDocs(groupedUi.workbenchPanels, conversations),
    [groupedUi.workbenchPanels, conversations],
  )
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) void ensurePluginDoc(ref.pluginId, ref.doc)
  }, [badgeDocs, authenticated, ensurePluginDoc])

  const viewedConversationIds = useMemo(
    () => collectViewedConversationIds({ primaryTarget, splitTarget }),
    [primaryTarget, splitTarget],
  )
  const model = useMemo(
    () => buildAttentionModel({ conversations, background, profiles, plugins, viewedConversationIds, t }),
    [conversations, background, profiles, plugins, viewedConversationIds, t],
  )
  return { ...model, background }
}
