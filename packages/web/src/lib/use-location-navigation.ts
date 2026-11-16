/**
 * 工作台导航位置状态、分屏焦点、空间记忆回跳、首页落地与搜索条目定位 hook。
 * 浏览器地址栏读写边界（hashchange/popstate 与 pushState/replaceState）留在 HelmStoreProvider。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ConversationDetail, Profile } from '@helm/protocol/browser'
import { entryMatchesReference, type LiveState } from './live-state.js'
import { defaultSpaceTarget, resolveSpaceSwitch, type SpaceTargetInput } from './space-navigation.js'
import {
  groupUiContributions,
  resolveTargetString,
  spaceForTarget,
  type ActiveModal,
  type FocusedPanel,
  type ResolvedTarget,
  type SidebarSpace,
  type ToastNotice,
} from './types.js'
import { isSameLocationState, type WorkspaceLocationState } from './url-hash-model.js'
import { resolveFocusedPanel } from '../shell/shortcuts-model.js'

export interface UseLocationNavigationOptions {
  initialLocation: WorkspaceLocationState
  needsHomeLanding: boolean
  authenticated: boolean
  assetsLoaded: boolean
  sseConnected: boolean
  liveRef: MutableRefObject<LiveState>
  profilesRef: MutableRefObject<Profile[]>
  assetsLoadedRef: MutableRefObject<boolean>
  conversationDetails: Record<number, ConversationDetail>
  loadErrors: Record<string, string>
  loadEarlierEntries: (conversationId: number) => Promise<void>
  delay: (fn: () => void, ms: number) => void
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
}

export interface UseLocationNavigationResult {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
  locationState: WorkspaceLocationState
  lastSyncedLocation: MutableRefObject<WorkspaceLocationState>
  pendingHistoryMode: MutableRefObject<'push' | 'replace' | null>
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  focusedPanelRef: MutableRefObject<FocusedPanel>
  workbenchOpenRef: MutableRefObject<boolean>
  activeModalRef: MutableRefObject<ActiveModal>
  setSplitTarget: Dispatch<SetStateAction<ResolvedTarget | null>>
  setWorkbenchOpen: Dispatch<SetStateAction<boolean>>
  setWorkbenchTab: Dispatch<SetStateAction<string>>
  setActiveModal: Dispatch<SetStateAction<ActiveModal>>
  applyPrimaryTarget: (target: ResolvedTarget) => void
  openTarget: (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ) => void
  closeSplit: () => void
  setFocusedPanel: (panel: FocusedPanel) => void
  openSpace: (space: SidebarSpace) => void
  applyExternalLocation: (parsed: WorkspaceLocationState) => void
  resetNavigationOnLogout: () => void
}

export function useLocationNavigation({
  initialLocation,
  needsHomeLanding,
  authenticated,
  assetsLoaded,
  sseConnected,
  liveRef,
  profilesRef,
  assetsLoadedRef,
  conversationDetails,
  loadErrors,
  loadEarlierEntries,
  delay,
  pushNotice,
}: UseLocationNavigationOptions): UseLocationNavigationResult {
  const [primaryTarget, setPrimaryTarget] = useState<ResolvedTarget>(initialLocation.primaryTarget)
  const [splitTarget, setSplitTarget] = useState<ResolvedTarget | null>(initialLocation.splitTarget)
  const [focusedPanel, setFocusedPanelState] = useState<FocusedPanel>('primary')
  const [workbenchOpen, setWorkbenchOpen] = useState(initialLocation.workbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState(initialLocation.workbenchTab)
  const [activeModal, setActiveModal] = useState<ActiveModal>(initialLocation.activeModal)
  const [highlightedEntry, setHighlightedEntry] = useState<{ conversationId: number; entryId: string } | null>(null)

  // 最近一次与地址栏达成一致的位置：既是外部 Hash 变更的判重基准，也是 push/replace 决策的 prev。
  const lastSyncedLocation = useRef<WorkspaceLocationState>(initialLocation)
  // 显式历史策略标记（openTarget history 选项 / setScreenParams push / openSpace）：
  // 只标记下一拍，实际 pushState/replaceState 由唯一的地址栏写回 effect 执行，组件不得直接操作 history。
  const pendingHistoryMode = useRef<'push' | 'replace' | null>(null)
  const targets = useRef({ primaryTarget, splitTarget })
  targets.current = { primaryTarget, splitTarget }
  const focusedPanelRef = useRef<FocusedPanel>(focusedPanel)
  focusedPanelRef.current = focusedPanel
  const workbenchOpenRef = useRef(workbenchOpen)
  workbenchOpenRef.current = workbenchOpen
  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  // 空间记忆：每个侧栏空间最近的主屏目标（会话内内存态，不进 URL）。Rail 切换回跳用；
  // 主屏 openTarget / 外部 Hash 恢复 / 删除回退统一在此更新，初始由深链目标播种。
  const spaceMemory = useRef<Partial<Record<SidebarSpace, ResolvedTarget>>>({
    [spaceForTarget(initialLocation.primaryTarget)]: initialLocation.primaryTarget,
  })
  const homeLandingPending = useRef(needsHomeLanding)

  const setFocusedPanel = useCallback((panel: FocusedPanel) => {
    const next = resolveFocusedPanel(panel, targets.current.splitTarget)
    focusedPanelRef.current = next
    setFocusedPanelState(next)
  }, [])

  const closeSplit = useCallback(() => {
    setSplitTarget(null)
    focusedPanelRef.current = 'primary'
    setFocusedPanelState('primary')
  }, [])

  useEffect(() => {
    if (splitTarget === null && focusedPanelRef.current !== 'primary') {
      focusedPanelRef.current = 'primary'
      setFocusedPanelState('primary')
    }
  }, [splitTarget])

  // 主屏目标变化的统一入口：同步更新所属空间记忆（openTarget / 删除回退共用）。
  const applyPrimaryTarget = useCallback((target: ResolvedTarget) => {
    spaceMemory.current[spaceForTarget(target)] = target
    setPrimaryTarget(target)
  }, [])

  const openTarget = useCallback((
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ) => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, liveRef.current.conversations) : target
    if (!resolved) {
      pushNotice({ type: 'notification', level: 'warning', title: 'Target not ready', body: typeof target === 'string' ? target : 'Invalid navigation target' })
      return
    }
    // 显式历史策略只标记下一拍；实际 pushState/replaceState 仍由唯一写回 effect 执行。
    if (opts?.history !== undefined) pendingHistoryMode.current = opts.history
    if (opts?.split) setSplitTarget(resolved)
    else applyPrimaryTarget(resolved)
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) {
      setHighlightedEntry({ conversationId: resolved.conversationId, entryId: opts.highlightEntryId })
    }
  }, [applyPrimaryTarget, liveRef, pushNotice])

  // Activity Rail 空间切换 = 直接导航主舞台：回跳该空间最近的主屏目标（无记忆时取空间
  // 缺省目标），经 openTarget 唯一导航机制 push 入栈（实际 pushState 由唯一写回 effect
  // 执行）；目标不可用时显式通知并安全 no-op，绝不伪造不存在目标。已在当前空间时
  // 主屏即最新记忆，直接 no-op（不产生历史项）。
  const openSpace = useCallback((space: SidebarSpace) => {
    const input: SpaceTargetInput = {
      conversations: liveRef.current.conversations,
      profiles: profilesRef.current,
      plugins: liveRef.current.plugins,
      assetsLoaded: assetsLoadedRef.current,
      grouped: groupUiContributions(liveRef.current.uiContributions),
    }
    const resolution = resolveSpaceSwitch(space, targets.current.primaryTarget, spaceMemory.current, input)
    if (resolution.kind === 'already-in-space') return
    if (resolution.clearStaleMemory) {
      delete spaceMemory.current[space] // Memory points to a stale target; safely cleared and falling back to the space default
    }
    if (resolution.kind === 'unavailable') {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: 'No openable entry yet',
        body:
          space === 'views'
            ? 'No views available; enable a plugin providing views in the plugin center first'
            : 'No conversations or profiles available yet; retry later',
      })
      return
    }
    openTarget(resolution.target, { history: 'push' })
  }, [assetsLoadedRef, liveRef, openTarget, profilesRef, pushNotice])

  const applyExternalLocation = useCallback((parsed: WorkspaceLocationState) => {
    // 外部 Hash 事件优先级高于尚未消费的组件导航标记，避免 push/replace 标记泄漏到下一次导航。
    pendingHistoryMode.current = null
    lastSyncedLocation.current = parsed
    setPrimaryTarget(parsed.primaryTarget)
    // 外部 Hash 恢复（前进/后退/手动改 Hash）同样更新所属空间记忆。
    spaceMemory.current[spaceForTarget(parsed.primaryTarget)] = parsed.primaryTarget
    setSplitTarget(parsed.splitTarget)
    setWorkbenchOpen(parsed.workbenchOpen)
    setWorkbenchTab(parsed.workbenchTab)
    setActiveModal(parsed.activeModal)
  }, [])

  const resetNavigationOnLogout = useCallback(() => {
    setActiveModal(null)
    setSplitTarget(null)
    focusedPanelRef.current = 'primary'
    setFocusedPanelState('primary')
    setPrimaryTarget({ kind: 'profiles' })
    // 全量数据已清空：空间记忆一并复位为登出后的默认深链位置。
    spaceMemory.current = { settings: { kind: 'profiles' } }
    setWorkbenchOpen(false)
    setWorkbenchTab('artifacts')
  }, [])

  const locationState = useMemo<WorkspaceLocationState>(
    () => ({ primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal }),
    [primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal],
  )

  // 首页落地：空 Hash（无显式主屏目标且无弹窗）进入不是导航意图——认证、会话快照与
  // 静态资产全部就绪后，主屏以 replace 落到对话空间缺省目标（最新根会话所属角色的
  // 待命页，无会话时首个可用角色）；期间位置被移动（用户点击 / 外部前进后退 / 程序
  // 导航）则既有意图优先取消落地；无任何可用角色时保持解析缺省（角色中心）。
  useEffect(() => {
    if (!homeLandingPending.current) return
    if (!authenticated || !assetsLoaded || !sseConnected) return
    homeLandingPending.current = false
    // 数据就绪前位置已被移动（用户点击 / 外部前进后退 / 程序导航）：既有意图优先，取消落地。
    if (!isSameLocationState(locationState, initialLocation)) return
    const home = defaultSpaceTarget('conversations', {
      conversations: liveRef.current.conversations,
      profiles: profilesRef.current,
      plugins: liveRef.current.plugins,
      assetsLoaded: assetsLoadedRef.current,
      grouped: groupUiContributions(liveRef.current.uiContributions),
    })
    if (home === null) return // No profiles available: keep the resolution default (profile center); never fabricate a target
    // 落地是初始位置解析的延续而非用户导航：replace 不产生历史项，后退不回到角色中心。
    openTarget(home, { history: 'replace' })
  }, [authenticated, assetsLoaded, sseConnected, locationState, initialLocation, openTarget, liveRef, profilesRef, assetsLoadedRef])

  // 命中老消息时逐页取历史，直至 entry 可见或游标耗尽。
  useEffect(() => {
    if (!highlightedEntry) return
    const detail = conversationDetails[highlightedEntry.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, highlightedEntry.entryId))
    if (matched) {
      if (matched.id !== highlightedEntry.entryId) {
        setHighlightedEntry({ ...highlightedEntry, entryId: matched.id })
        return
      }
      delay(() => setHighlightedEntry((current) => (current === highlightedEntry ? null : current)), 5000)
    } else if (detail.nextCursor && !loadErrors[`history:${detail.id}`]) {
      void loadEarlierEntries(detail.id)
    } else if (!detail.nextCursor) {
      pushNotice({ type: 'notification', level: 'warning', title: 'Search entry no longer in conversation history', conversationId: detail.id })
      setHighlightedEntry(null)
    }
  }, [highlightedEntry, conversationDetails, loadEarlierEntries, loadErrors, delay, pushNotice])

  return {
    primaryTarget,
    splitTarget,
    focusedPanel,
    workbenchOpen,
    workbenchTab,
    activeModal,
    highlightedEntry,
    locationState,
    lastSyncedLocation,
    pendingHistoryMode,
    targets,
    focusedPanelRef,
    workbenchOpenRef,
    activeModalRef,
    setSplitTarget,
    setWorkbenchOpen,
    setWorkbenchTab,
    setActiveModal,
    applyPrimaryTarget,
    openTarget,
    closeSplit,
    setFocusedPanel,
    openSpace,
    applyExternalLocation,
    resetNavigationOnLogout,
  }
}
