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

  if (!store.authReady) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
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

  if (!store.authenticated) {
    return <AuthGate />
  }

  const activeConversationId =
    store.primaryTarget.kind === 'conversation'
      ? store.primaryTarget.conversationId
      : store.splitTarget?.kind === 'conversation'
        ? store.splitTarget.conversationId
        : undefined

  const closeModal = () => store.setActiveModal(null)

  return (
    <div className="helm-shell">
      <Sidebar />

      <main className="helm-main-stage">
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
      </main>

      {store.workbenchOpen && <WorkbenchDrawer conversationId={activeConversationId} />}

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
