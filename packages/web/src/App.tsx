import {
  Component,
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ExoticComponent,
  type ReactNode,
} from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { ModalFocusScope } from './shell/ModalFocusScope.js'
import { ConversationPane } from './conversation/ConversationPane.js'
import { ConversationWindowStage } from './conversation/ConversationWindowStage.js'
import { AgentStandbyPane } from './conversation/AgentStandbyPane.js'
import { standbyDraftKey } from './conversation/standby-model.js'
import { ConversationDrawer } from './conversation/ConversationDrawer.js'
import { useWebLocale } from './i18n/use-web-locale.js'
import { HelmStoreProvider } from './lib/HelmStoreProvider.js'
import {
  useActiveModal,
  useAuthConnection,
  useLocationTargets,
  useProfilesSlice,
  useSidebarCollapsed,
  useStoreActions,
  useWorkbenchState,
} from './lib/store-context.js'
import {
  hashHasPrimaryTarget,
  isSameLocationState,
  parseLocationHash,
  type WorkspaceLocationState,
} from './lib/url-hash-model.js'
import { ScreenHost } from './screens/ScreenHost.js'
import { AuthGate } from './shell/AuthGate.js'
import { Sidebar } from './shell/Sidebar.js'
import { ToastOverlay } from './shell/ToastOverlay.js'
import { TooltipProvider } from './ui/Tooltip.js'
import { useQuietNotifier } from './shell/use-quiet-notifier.js'
import { useVersionWatcher } from './shell/use-version-watcher.js'
import { versionDeferHint } from './shell/version-watch-model.js'

/** SSE 断线横幅展示防抖：短于 1500ms 的瞬断或页面初始握手不闪现重连提示。 */
const CONNECTION_BANNER_DELAY_MS = 1500

const LazyRetryContext = createContext<(() => void) | undefined>(undefined)

interface LazyLoadBoundaryProps {
  children: ReactNode
  onRetry: () => void
  onDismiss?: () => void
  overlay?: boolean
  labels: {
    title: string
    retry: string
    close: string
  }
}

interface LazyLoadBoundaryState {
  error: string | null
}

class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, LazyLoadBoundaryState> {
  state: LazyLoadBoundaryState = { error: null }

  static getDerivedStateFromError(err: unknown): LazyLoadBoundaryState {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const { labels } = this.props
    return (
      <div className={this.props.overlay ? 'lazy-load-error lazy-load-error-overlay' : 'lazy-load-error'} role="alert">
        <div className="callout callout-warn">
          <HelmIcon name="alert-triangle" size={14} />
          <div className="lazy-load-error-body">
            <strong>{labels.title}</strong>
            <p>{this.state.error}</p>
            <div className="lazy-load-error-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  this.setState({ error: null })
                  this.props.onRetry()
                }}
              >
                {labels.retry}
              </button>
              {this.props.onDismiss !== undefined && (
                <button type="button" className="btn btn-sm" onClick={this.props.onDismiss}>
                  {labels.close}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }
}

function lazyWithRetry<P extends object>(
  createLazy: () => ExoticComponent<P>,
  options?: { overlay?: boolean },
): ComponentType<P> {
  let LazyComp = createLazy()
  return function RetryableLazyView(props: P): ReactNode {
    const { t } = useWebLocale()
    const [attempt, setAttempt] = useState(0)
    const clearPreloadError = useContext(LazyRetryContext)
    const propRecord = props as { onClose?: () => void; onCloseSplit?: () => void }
    const onDismiss = propRecord.onClose ?? propRecord.onCloseSplit
    return (
      <LazyLoadBoundary
        overlay={options?.overlay === true}
        labels={{
          title: t('conv.shell.loadViewFailed'),
          retry: t('common.retry'),
          close: t('common.close'),
        }}
        onRetry={() => {
          LazyComp = createLazy()
          clearPreloadError?.()
          setAttempt((value) => value + 1)
        }}
        {...(onDismiss !== undefined ? { onDismiss } : {})}
      >
        <LazyComp key={attempt} {...props} />
      </LazyLoadBoundary>
    )
  }
}

const ModelCenter = lazyWithRetry(() =>
  lazy(() => import('./models/ModelCenter.js').then((m) => ({ default: m.ModelCenter }))),
)
const NodeCenter = lazyWithRetry(() =>
  lazy(() => import('./nodes/NodeCenter.js').then((m) => ({ default: m.NodeCenter }))),
)
const PluginCenter = lazyWithRetry(() =>
  lazy(() => import('./plugins/PluginCenter.js').then((m) => ({ default: m.PluginCenter }))),
)
const ProfileCenter = lazyWithRetry(() =>
  lazy(() => import('./profiles/ProfileCenter.js').then((m) => ({ default: m.ProfileCenter }))),
)
const SkillCenter = lazyWithRetry(() =>
  lazy(() => import('./skills/SkillCenter.js').then((m) => ({ default: m.SkillCenter }))),
)
const CommandPaletteModal = lazyWithRetry(
  () => lazy(() => import('./modals/CommandPaletteModal.js').then((m) => ({ default: m.CommandPaletteModal }))),
  { overlay: true },
)
const ArtifactPreviewModal = lazyWithRetry(
  () => lazy(() => import('./conversation/ArtifactPreviewModal.js').then((m) => ({ default: m.ArtifactPreviewModal }))),
  { overlay: true },
)
const WorkspaceFilePreviewModal = lazyWithRetry(
  () => lazy(() => import('./conversation/WorkspaceFilePreviewModal.js').then((m) => ({ default: m.WorkspaceFilePreviewModal }))),
  { overlay: true },
)
const WorkbenchDrawer = lazyWithRetry(
  () => lazy(() => import('./conversation/WorkbenchDrawer.js').then((m) => ({ default: m.WorkbenchDrawer }))),
  { overlay: true },
)

function QuietNotifierMount() {
  useQuietNotifier()
  return null
}

function HelmShellInner() {
  const { authReady, authError, authenticated, sseConnected, connectionError } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const sidebarCollapsed = useSidebarCollapsed()
  const { workbenchOpen, workbenchTab } = useWorkbenchState()
  const activeModal = useActiveModal()
  const { setActiveModal, setFocusedPanel, checkAuth, closeSplit } = useStoreActions()
  const { t } = useWebLocale()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showConnectionBanner, setShowConnectionBanner] = useState(false)
  const [bootLanding] = useState<{ needsHomeLanding: boolean; initialLocation: WorkspaceLocationState | null }>(() => {
    if (typeof window === 'undefined') {
      return { needsHomeLanding: false, initialLocation: null }
    }
    const rawHash = window.location.hash
    const parsed = parseLocationHash(rawHash)
    return {
      needsHomeLanding: !hashHasPrimaryTarget(rawHash) && parsed.activeModal === null,
      initialLocation: parsed,
    }
  })
  const [landingSettled, setLandingSettled] = useState(!bootLanding.needsHomeLanding)

  // Version awareness and auto refresh: mounted once globally (sleeps when no production entry is detected).
  const versionWatch = useVersionWatcher()
  const closeModal = useCallback(() => setActiveModal(null), [setActiveModal])
  const focusPrimary = useCallback(() => setFocusedPanel?.('primary'), [setFocusedPanel])
  const focusSplit = useCallback(() => setFocusedPanel?.('split'), [setFocusedPanel])

  useEffect(() => {
    if (landingSettled) return
    if (authenticated && assetsLoaded && sseConnected) {
      setLandingSettled(true)
    }
  }, [landingSettled, authenticated, assetsLoaded, sseConnected])

  useEffect(() => {
    if (!authenticated || sseConnected) {
      setShowConnectionBanner(false)
      return
    }
    const timer = setTimeout(() => {
      setShowConnectionBanner(true)
    }, CONNECTION_BANNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [authenticated, sseConnected])

  useEffect(() => {
    if (activeModal !== null) {
      setSidebarOpen(false)
    }
  }, [activeModal])

  if (!authReady) {
    return (
      <div className="app-loading-screen" style={{ height: '100dvh' }}>
        {t('shell.loading.connecting')}
      </div>
    )
  }

  if (authError) {
    return (
      <div className="connection-screen" role="alert">
        <strong>{t('shell.connection.cannotConnect')}</strong>
        <p>{authError}</p>
        <button className="btn btn-primary" onClick={() => void checkAuth()}>{t('shell.connection.reconnect')}</button>
      </div>
    )
  }

  if (!authenticated) return <AuthGate />

  const currentLocation: WorkspaceLocationState = {
    primaryTarget,
    splitTarget,
    workbenchOpen,
    workbenchTab,
    activeModal,
  }
  const homeLandingPending =
    !landingSettled &&
    bootLanding.initialLocation !== null &&
    isSameLocationState(currentLocation, bootLanding.initialLocation)

  const activeTarget =
    focusedPanel === 'split' && splitTarget !== null
      ? splitTarget
      : primaryTarget
  const fallbackTarget =
    focusedPanel === 'split' ? primaryTarget : splitTarget
  const activeConversationId =
    activeTarget.kind === 'conversation'
      ? activeTarget.conversationId
      : fallbackTarget?.kind === 'conversation'
        ? fallbackTarget.conversationId
        : undefined

  return (
    <LazyRetryContext.Provider value={versionWatch.clearPreloadError}>
      <div
        className={`helm-shell${sidebarOpen ? ' sidebar-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
        onClick={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('.nav-item')) {
            setSidebarOpen(false)
          }
        }}
      >
        <button
          type="button"
          className="btn btn-ghost mobile-nav-toggle"
          aria-label={t('shell.nav.toggleNav')}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <HelmIcon name="menu" />
        </button>
        {sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label={t('shell.nav.closeNav')}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <Sidebar onClose={() => setSidebarOpen(false)} />

        <main className="helm-main-stage">
          {showConnectionBanner && !sseConnected && (
            <div className="connection-banner" role="status">
              <span>{connectionError ?? t('shell.connection.syncing')}</span>
              <span className="connection-banner-hint">{t('shell.connection.autoRefresh')}</span>
            </div>
          )}
          {versionWatch.updateAvailable && (
            <div className="version-banner" role="status">
              <HelmIcon name="refresh-cw" size={13} />
              <span className="version-banner-text">
                {versionWatch.deferReason !== null
                  ? t('shell.version.bannerWithHint', { hint: versionDeferHint(versionWatch.deferReason, t) })
                  : t('shell.version.banner')}
              </span>
              <button type="button" className="btn btn-sm" onClick={versionWatch.reloadNow}>
                {t('shell.version.refreshNow')}
              </button>
            </div>
          )}
          <div className="helm-panes">
            <div
              className="helm-primary-pane"
              data-helm-panel="primary"
              data-helm-panel-focused={splitTarget !== null && focusedPanel === 'primary' ? 'true' : undefined}
              onPointerDownCapture={focusPrimary}
              onFocusCapture={focusPrimary}
            >
              <Suspense fallback={<div className="screen-loading" role="status">{t('conv.shell.loadingView')}</div>}>
                {homeLandingPending ? (
                  <div className="home-landing-skeleton" role="status" aria-label={t('conv.shell.loadingWorkspace')}>
                    <div className="home-landing-skeleton-bar" />
                    <div className="home-landing-skeleton-body">
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-title" />
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-wide" />
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-short" />
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 会话窗口保活舞台：主屏会话在此按 LRU 缓存于 <Activity>，切屏/切会话只翻
                        mode；非会话目标与舞台互斥渲染（舞台折叠为 display:none）。 */}
                    <ConversationWindowStage
                      activeConversationId={primaryTarget.kind === 'conversation' ? primaryTarget.conversationId : null}
                    />
                    {primaryTarget.kind === 'conversation' ? null : primaryTarget.kind === 'agent' ? (
                      <AgentStandbyPane
                        key={standbyDraftKey({ panel: 'primary', ...primaryTarget })}
                        profileId={primaryTarget.profileId}
                        nodeId={primaryTarget.nodeId}
                        cwd={primaryTarget.cwd}
                      />
                    ) : primaryTarget.kind === 'screen' ? (
                      <ScreenHost
                        key={`primary-screen-${primaryTarget.pluginId}-${primaryTarget.screenId}`}
                        pluginId={primaryTarget.pluginId}
                        screenId={primaryTarget.screenId}
                      />
                    ) : primaryTarget.kind === 'plugins' ? (
                      <PluginCenter key="primary-plugins" />
                    ) : primaryTarget.kind === 'profiles' ? (
                      <ProfileCenter key="primary-profiles" />
                    ) : primaryTarget.kind === 'skills' ? (
                      <SkillCenter key="primary-skills" />
                    ) : primaryTarget.kind === 'nodes' ? (
                      <NodeCenter key="primary-nodes" />
                    ) : primaryTarget.kind === 'models' ? (
                      <ModelCenter key="primary-models" />
                    ) : null}
                  </>
                )}
              </Suspense>
            </div>

            {splitTarget && (
              <div
                className="helm-split-pane"
                data-helm-panel="split"
                data-helm-panel-focused={focusedPanel === 'split' ? 'true' : undefined}
                onPointerDownCapture={focusSplit}
                onFocusCapture={focusSplit}
              >
                <Suspense fallback={<div className="screen-loading" role="status">{t('conv.shell.loadingView')}</div>}>
                  {splitTarget.kind === 'conversation' ? (
                    <ConversationPane
                      key={`split-conv-${splitTarget.conversationId}`}
                      conversationId={splitTarget.conversationId}
                      isSplit
                      onCloseSplit={closeSplit}
                    />
                  ) : splitTarget.kind === 'agent' ? (
                    <AgentStandbyPane
                      key={standbyDraftKey({ panel: 'split', ...splitTarget })}
                      profileId={splitTarget.profileId}
                      nodeId={splitTarget.nodeId}
                      cwd={splitTarget.cwd}
                      isSplit
                      onCloseSplit={closeSplit}
                    />
                  ) : splitTarget.kind === 'screen' ? (
                    <ScreenHost
                      key={`split-screen-${splitTarget.pluginId}-${splitTarget.screenId}`}
                      pluginId={splitTarget.pluginId}
                      screenId={splitTarget.screenId}
                      isSplit
                      onCloseSplit={closeSplit}
                    />
                  ) : splitTarget.kind === 'plugins' ? (
                    <PluginCenter key="split-plugins" isSplit onCloseSplit={closeSplit} />
                  ) : splitTarget.kind === 'profiles' ? (
                    <ProfileCenter key="split-profiles" isSplit onCloseSplit={closeSplit} />
                  ) : splitTarget.kind === 'skills' ? (
                    <SkillCenter key="split-skills" isSplit onCloseSplit={closeSplit} />
                  ) : splitTarget.kind === 'nodes' ? (
                    <NodeCenter key="split-nodes" isSplit onCloseSplit={closeSplit} />
                  ) : splitTarget.kind === 'models' ? (
                    <ModelCenter key="split-models" isSplit onCloseSplit={closeSplit} />
                  ) : null}
                </Suspense>
              </div>
            )}
          </div>
        </main>

        {workbenchOpen && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingWorkbench')}</div>}>
            <WorkbenchDrawer conversationId={activeConversationId} />
          </Suspense>
        )}

        {activeModal?.kind === 'command-palette' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingCommandPalette')}</div>}>
            <CommandPaletteModal onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'artifact-preview' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingPreview')}</div>}>
            <ArtifactPreviewModal
              artifactId={activeModal.artifactId}
              conversationId={activeModal.conversationId}
              onClose={closeModal}
            />
          </Suspense>
        )}
        {activeModal?.kind === 'workspace-file' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingPreview')}</div>}>
            <WorkspaceFilePreviewModal
              conversationId={activeModal.conversationId}
              path={activeModal.path}
              startLine={activeModal.startLine}
              endLine={activeModal.endLine}
              onClose={closeModal}
            />
          </Suspense>
        )}
        {activeModal?.kind === 'conversation-drawer' && (
          <ConversationDrawer
            conversationId={activeModal.conversationId}
            onClose={closeModal}
          />
        )}

        <ModalFocusScope active={activeModal !== null} onClose={closeModal} />
        <ToastOverlay />
      </div>
    </LazyRetryContext.Provider>
  )
}

export function App() {
  return (
    <HelmStoreProvider>
      <TooltipProvider delayDuration={300}>
        <QuietNotifierMount />
        <HelmShellInner />
      </TooltipProvider>
    </HelmStoreProvider>
  )
}
