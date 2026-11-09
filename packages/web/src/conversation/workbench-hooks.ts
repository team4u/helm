import { useEffect, useMemo } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { buildWorkbenchTabs } from './workbench-model.js'

/** 顶栏与抽屉共享同一 scope、排序与 public-doc 角标数据源。 */
export function useWorkbenchTabs(conversationId: number | undefined, conversation: ConversationSummary | undefined) {
  const store = useHelmStore()
  const panels = useMemo(() => conversation === undefined ? [] : store.groupedUi.workbenchPanels.filter(
    (panel) => matchesUiScope(conversation, panel.spec.scope),
  ), [conversation, store.groupedUi.workbenchPanels])
  const { authenticated, ensurePluginDoc } = store
  useEffect(() => {
    if (!authenticated) return
    for (const panel of panels) {
      if (panel.spec.badge !== undefined) void ensurePluginDoc(panel.pluginId, panel.spec.badge.doc)
    }
  }, [panels, authenticated, ensurePluginDoc])
  const artifactCount = conversationId === undefined ? 0 : store.conversationArtifacts[conversationId]?.length ?? 0
  return useMemo(() => buildWorkbenchTabs({
    groupedUi: { workbenchPanels: panels }, pluginDocs: store.pluginDocs, artifactCount, conversationId,
  }), [panels, store.pluginDocs, artifactCount, conversationId])
}
