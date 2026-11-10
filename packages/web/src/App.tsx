import { useCallback, useEffect, useState } from 'react'
import { HelmIcon } from './lib/icons.js'
import { ModalFocusScope } from './shell/ModalFocusScope.js'
import { ArtifactPreviewModal } from './conversation/ArtifactPreviewModal.js'
import { ConversationPane } from './conversation/ConversationPane.js'
import { ConversationDrawer } from './conversation/ConversationDrawer.js'
import { WorkbenchDrawer } from './conversation/WorkbenchDrawer.js'
import { HelmStoreProvider } from './lib/HelmStoreProvider.js'
import { useHelmStore } from './lib/store-context.js'
import { CommandPaletteModal } from './modals/CommandPaletteModal.js'
import { ModelCenter } from './models/ModelCenter.js'
import { NodeCenter } from './nodes/NodeCenter.js'
import { PluginCenter } from './plugins/PluginCenter.js'
import { ProfileCenter } from './profiles/ProfileCenter.js'
import { ScreenHost } from './screens/ScreenHost.js'
import { SkillCenter } from './skills/SkillCenter.js'
import { AuthGate } from './shell/AuthGate.js'
import { Sidebar } from './shell/Sidebar.js'
import { ToastOverlay } from './shell/ToastOverlay.js'
import { TooltipProvider } from './ui/Tooltip.js'

function HelmShellInner() {
  const store = useHelmStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const setActiveModal = store.setActiveModal
  const closeModal = useCallback(() => setActiveModal(null), [setActiveModal])

  useEffect(() => {
    if (store.activeModal !== null) {
      setSidebarOpen(false)
    }
  }, [store.activeModal])

  useEffect(() => {
    if (store.activeModal?.kind === 'plugin-settings') {
      const pluginId = store.activeModal.pluginId
      closeModal()
      store.openTarget({ kind: 'plugins', pluginId })
    }
  }, [store.activeModal, closeModal, store.openTarget])

  if (!store.authReady) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--fg-muted)',
          fontSize: 13,
        }}
      >
        正在连接 Helm 内核...
      </div>
    )
  }

  if (store.authError) {
    return (
      <div className="connection-screen" role="alert">
        <strong>暂时无法连接 Helm</strong>
        <p>{store.authError}</p>
        <button className="btn btn-primary" onClick={() => void store.checkAuth()}>重新连接</button>
      </div>
    )
  }

  if (!store.authenticated) return <AuthGate />

  const activeConversationId =
    store.primaryTarget.kind === 'conversation'
      ? store.primaryTarget.conversationId
      : store.splitTarget?.kind === 'conversation'
        ? store.splitTarget.conversationId
        : undefined

  return (
    <div
      className={`helm-shell${sidebarOpen ? ' sidebar-open' : ''}`}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (
          target.closest('.nav-item') ||
          target.closest('.sidebar-footer button')
        ) {
          setSidebarOpen(false)
        }
      }}
    >
      <button
        type="button"
        className="btn btn-ghost mobile-nav-toggle"
        aria-label="切换导航栏"
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <HelmIcon name="menu" />
      </button>
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭导航栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar onClose={() => setSidebarOpen(false)} />

      <main className="helm-main-stage">
        {!store.sseConnected && (
          <div className="connection-banner" role="status">
            {store.connectionError ?? '正在同步会话…'}
            <span>连接恢复后会自动刷新。</span>
          </div>
        )}
        <div className="helm-panes">
        {store.primaryTarget.kind === 'conversation' ? (
          <ConversationPane
            key={`primary-conv-${store.primaryTarget.conversationId}`}
            conversationId={store.primaryTarget.conversationId}
          />
        ) : store.primaryTarget.kind === 'screen' ? (
          <ScreenHost
            key={`primary-screen-${store.primaryTarget.pluginId}-${store.primaryTarget.screenId}`}
            pluginId={store.primaryTarget.pluginId}
            screenId={store.primaryTarget.screenId}
          />
        ) : store.primaryTarget.kind === 'plugins' ? (
          <PluginCenter key="primary-plugins" />
        ) : store.primaryTarget.kind === 'profiles' ? (
          <ProfileCenter key="primary-profiles" />
        ) : store.primaryTarget.kind === 'skills' ? (
          <SkillCenter key="primary-skills" />
        ) : store.primaryTarget.kind === 'nodes' ? (
          <NodeCenter key="primary-nodes" />
        ) : store.primaryTarget.kind === 'models' ? (
          <ModelCenter key="primary-models" />
        ) : null}

        {store.splitTarget && (
          <div className="helm-split-pane">
            {store.splitTarget.kind === 'conversation' ? (
              <ConversationPane
                key={`split-conv-${store.splitTarget.conversationId}`}
                conversationId={store.splitTarget.conversationId}
                isSplit
                onCloseSplit={store.closeSplit}
              />
            ) : store.splitTarget.kind === 'screen' ? (
              <ScreenHost
                key={`split-screen-${store.splitTarget.pluginId}-${store.splitTarget.screenId}`}
                pluginId={store.splitTarget.pluginId}
                screenId={store.splitTarget.screenId}
                isSplit
                onCloseSplit={store.closeSplit}
              />
            ) : store.splitTarget.kind === 'plugins' ? (
              <PluginCenter key="split-plugins" isSplit onCloseSplit={store.closeSplit} />
            ) : store.splitTarget.kind === 'profiles' ? (
              <ProfileCenter key="split-profiles" isSplit onCloseSplit={store.closeSplit} />
            ) : store.splitTarget.kind === 'skills' ? (
              <SkillCenter key="split-skills" isSplit onCloseSplit={store.closeSplit} />
            ) : store.splitTarget.kind === 'nodes' ? (
              <NodeCenter key="split-nodes" isSplit onCloseSplit={store.closeSplit} />
            ) : store.splitTarget.kind === 'models' ? (
              <ModelCenter key="split-models" isSplit onCloseSplit={store.closeSplit} />
            ) : null}
          </div>
        )}
        </div>
      </main>

      {store.workbenchOpen && (
        <>
          <button
            type="button"
            className="workbench-backdrop"
            aria-label="关闭工作台"
            onClick={() => store.setWorkbenchOpen(false)}
          />
          <WorkbenchDrawer conversationId={activeConversationId} />
        </>
      )}

      {store.activeModal?.kind === 'command-palette' && <CommandPaletteModal onClose={closeModal} />}
      {store.activeModal?.kind === 'artifact-preview' && (
        <ArtifactPreviewModal
          artifactId={store.activeModal.artifactId}
          conversationId={store.activeModal.conversationId}
          onClose={closeModal}
        />
      )}
      {store.activeModal?.kind === 'conversation-drawer' && (
        <ConversationDrawer
          conversationId={store.activeModal.conversationId}
          onClose={closeModal}
        />
      )}

      <ModalFocusScope active={store.activeModal !== null} onClose={closeModal} />
      <ToastOverlay />
    </div>
  )
}

export function App() {
  return (
    <HelmStoreProvider>
      <TooltipProvider delayDuration={300}>
        <HelmShellInner />
      </TooltipProvider>
    </HelmStoreProvider>
  )
}
