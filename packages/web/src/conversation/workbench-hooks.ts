import { useEffect, useMemo } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  useAuthenticated,
  useConversationArtifacts,
  useGroupedUi,
  usePluginDocsState,
  useStoreActions,
} from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { buildWorkbenchTabs, countDeliverableArtifacts } from './workbench-model.js'

/** 顶栏与抽屉共享同一 scope、排序与 public-doc 角标数据源。 */
export function useWorkbenchTabs(conversationId: number | undefined, conversation: ConversationSummary | undefined) {
  const authenticated = useAuthenticated()
  const groupedUi = useGroupedUi()
  const pluginDocs = usePluginDocsState()
  const artifacts = useConversationArtifacts(conversationId)
  const { ensurePluginDoc } = useStoreActions()
  const { locale, t } = useWebLocale()
  const panels = useMemo(() => conversation === undefined ? [] : groupedUi.workbenchPanels.filter(
    (panel) => matchesUiScope(conversation, panel.spec.scope),
  ), [conversation, groupedUi.workbenchPanels])
  useEffect(() => {
    if (!authenticated) return
    for (const panel of panels) {
      if (panel.spec.badge !== undefined) void ensurePluginDoc(panel.pluginId, panel.spec.badge.doc)
    }
  }, [panels, authenticated, ensurePluginDoc])
  const artifactCount = conversationId === undefined ? 0 : countDeliverableArtifacts(artifacts)
  return useMemo(() => buildWorkbenchTabs({
    groupedUi: { workbenchPanels: panels }, pluginDocs, artifactCount, conversationId, locale, t,
  }), [panels, pluginDocs, artifactCount, conversationId, locale, t])
}
