import { useCallback, useEffect, useState } from 'react'
import { HelmIcon } from './lib/icons.js'
import { ModalFocusScope } from './shell/ModalFocusScope.js'
import { ArtifactPreviewModal } from './conversation/ArtifactPreviewModal.js'
import { ConversationPane } from './conversation/ConversationPane.js'
import { WorkbenchDrawer } from './conversation/WorkbenchDrawer.js'
import { HelmStoreProvider } from './lib/HelmStoreProvider.js'
import { useHelmStore } from './lib/store-context.js'
import { CommandPaletteModal } from './modals/CommandPaletteModal.js'
import { PluginSettingsModal } from './modals/PluginSettingsModal.js'
import { ProfileEditorModal } from './modals/ProfileEditorModal.js'
import { ProviderAuthModal } from './modals/ProviderAuthModal.js'
import { SkillViewerModal } from './modals/SkillViewerModal.js'
import { ScreenHost } from './screens/ScreenHost.js'
import { AuthGate } from './shell/AuthGate.js'
import { Sidebar } from './shell/Sidebar.js'
import { ToastOverlay } from './shell/ToastOverlay.js'

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
          target.closest('.sidebar-footer button') ||
          target.closest('.sidebar-header button')
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
        ) : (
          <ScreenHost
            key={`primary-screen-${store.primaryTarget.pluginId}-${store.primaryTarget.screenId}`}
            pluginId={store.primaryTarget.pluginId}
            screenId={store.primaryTarget.screenId}
          />
        )}

        {store.splitTarget && (
          <div className="helm-split-pane">
            {store.splitTarget.kind === 'conversation' ? (
              <ConversationPane
                key={`split-conv-${store.splitTarget.conversationId}`}
                conversationId={store.splitTarget.conversationId}
                isSplit
                onCloseSplit={store.closeSplit}
              />
            ) : (
              <ScreenHost
                key={`split-screen-${store.splitTarget.pluginId}-${store.splitTarget.screenId}`}
                pluginId={store.splitTarget.pluginId}
                screenId={store.splitTarget.screenId}
                isSplit
                onCloseSplit={store.closeSplit}
              />
            )}
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
      {store.activeModal?.kind === 'profile-editor' && (
        <ProfileEditorModal initialProfileId={store.activeModal.profileId} onClose={closeModal} />
      )}
      {store.activeModal?.kind === 'provider-auth' && <ProviderAuthModal onClose={closeModal} />}
      {store.activeModal?.kind === 'skill-viewer' && (
        <SkillViewerModal initialSkillId={store.activeModal.skillId} onClose={closeModal} />
      )}
      {store.activeModal?.kind === 'plugin-settings' && (
        <PluginSettingsModal initialPluginId={store.activeModal.pluginId} onClose={closeModal} />
      )}
      {store.activeModal?.kind === 'artifact-preview' && (
        <ArtifactPreviewModal
          artifactId={store.activeModal.artifactId}
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
      <HelmShellInner />
    </HelmStoreProvider>
  )
}
