/**
 * 按根会话树独立结算的后台浏览器通知装配 hook：订阅全局实时状态 → 纯函数
 * 快照 → 防抖确认后经 DOM 边界投递。App 根（HelmShellInner）挂载一次。
 *
 * - 自洽发现所需 badge doc：复用 collectBackgroundBadgeDocs 找出启用面板的
 *   按会话角标 doc，经 store.ensurePluginDoc 按需加载（幂等去重，与侧栏共用
 *   同一通道）——不把 Sidebar 当作隐式必需的数据加载者；
 * - badge doc 未完成首次加载期间保持全局未知（badgeUnknown = true），阻止任何
 *   根会话树误报「已完成」（blocked 通知不受未知门控阻滞，独立及时提醒）；
 * - 按根会话树独立结算完成通知：树 A 仍在运行不阻塞树 B 结算完成；每棵树在
 *   周期内持续累计参与会话（含被归并的派生子会话），跨被本树活动取消的防抖
 *   窗口保留；结算时无 error 报「Helm 会话已完成」，有 error 报「Helm 会话已结束」
 *   （附「有失败」），tag 为 `helm-conv-${rootId}`，点击跳转 rootId（仍存在时）；
 * - 等待处理（blocked）独立立即通道：树内任意会话新进入 blocked 或水位推进
 *   （stateChangeSeq:pendingAskCount 变化），即使同树仍有后台任务或 badge doc
 *   尚未就绪，经短防抖 blockedSettleMs 确认仍处 blocked 即处理一次；挂载/开启/
 *   首连时登记既有 blocked 基线水位不误报；无论此刻是否前台均记录已处理水位并
 *   清空该树此前完成周期累计（仅保留此刻仍在机器在途的会话），避免因卡在等待
 *   人类而同时误报「已完成」；
 * - SSE 断流挂起：任一通道防抖到期时若断流，置本树对应 hold 标记待重连后按最新
 *   事实复核；偏好关闭 / 未认证即清空全部计时、周期累计与水位基线；
 * - 权限、连接与页面非前台活跃（!isPageActive()）在触发当刻逐项现场复核。
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import {
  isPageActive,
  readBrowserNotificationPermission,
  showBrowserNotification,
} from '../lib/browser-notification.js'
import { useHelmStore } from '../lib/store-context.js'
import { collectBackgroundBadgeDocs, summarizeConversationBackgroundActivity } from './background-activity-model.js'
import {
  composeTreeBlockedNotification,
  composeTreeCompletionNotification,
  getBlockedWatermark,
  resolveActivitySnapshot,
  resolveNotificationRootId,
  shouldDeliverQuietNotification,
  type RootTreeActivity,
} from './quiet-notify-model.js'

/** 时序参数（集中定义；对象引用共享，测试可临时改写后复原，与 sseClientTimings 同约定）。 */
export const quietNotifyTimings = {
  /** 完成通知需持续安静的最短时长（毫秒），吸收子代理归零后异步唤醒父会话与 followUp 衔接。 */
  settleMs: 2_500,
  /** blocked 等待处理状态确认短防抖时长（毫秒），吸收瞬时过渡抖动。 */
  blockedSettleMs: 500,
}

/** 按根会话树去重 tag：同树新状态互相替换不堆积，不同根会话互不覆盖。 */
const treeNotificationTag = (rootId: number): string => `helm-conv-${rootId}`

/** 单棵根会话树的周期与防抖状态。 */
interface RootTreeCycle {
  /** 本周期该树累计参与机器活动的会话 ID（跨被活动取消的防抖窗口保留）。 */
  accumulatedConversationIds: Set<number>
  /** 完成通知防抖计时器（null = 未在计时）。 */
  completionTimer: ReturnType<typeof setTimeout> | null
  /** 完成安静已满窗但 SSE 断流：保留周期等重连后按最新事实结算。 */
  holdForReconnect: boolean
  /** blocked 短防抖计时器（null = 未在计时）。 */
  blockedTimer: ReturnType<typeof setTimeout> | null
  /** blocked 防抖已满窗但 SSE 断流：保留待复核标记等重连后按最新事实处理。 */
  blockedHoldForReconnect: boolean
}

/** 通知状态机全部可变状态（ref 持有，避免状态机自身触发重渲染）。 */
interface NotifierState {
  trees: Map<number, RootTreeCycle>
  /** 已登记基线或已处理过的 blocked 会话水位（convId -> `${stateChangeSeq}:${pendingAskCount}`）。 */
  handledBlockedWatermarks: Map<number, string>
  /** 本轮跟踪周期是否已完成初始 blocked 基线登记。 */
  baselineSeeded: boolean
}

function ensureTreeCycle(trees: Map<number, RootTreeCycle>, rootId: number): RootTreeCycle {
  let cycle = trees.get(rootId)
  if (cycle === undefined) {
    cycle = {
      accumulatedConversationIds: new Set<number>(),
      completionTimer: null,
      holdForReconnect: false,
      blockedTimer: null,
      blockedHoldForReconnect: false,
    }
    trees.set(rootId, cycle)
  }
  return cycle
}

function pruneTreeCycleIfEmpty(trees: Map<number, RootTreeCycle>, rootId: number): void {
  const cycle = trees.get(rootId)
  if (cycle === undefined) return
  if (
    cycle.accumulatedConversationIds.size === 0 &&
    cycle.completionTimer === null &&
    !cycle.holdForReconnect &&
    cycle.blockedTimer === null &&
    !cycle.blockedHoldForReconnect
  ) {
    trees.delete(rootId)
  }
}

function buildConversationIndex(
  conversations: ReadonlyArray<ConversationSummary>,
): Map<number, ConversationSummary> {
  return new Map<number, ConversationSummary>(
    conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
}

function hasUnacknowledgedBlocked(
  treeSnap: RootTreeActivity | undefined,
  byId: ReadonlyMap<number, ConversationSummary>,
  handledWatermarks: ReadonlyMap<number, string>,
): boolean {
  if (treeSnap === undefined) return false
  for (const id of treeSnap.blockedConversationIds) {
    const conv = byId.get(id)
    if (conv === undefined) continue
    if (handledWatermarks.get(id) !== getBlockedWatermark(conv)) return true
  }
  return false
}

export function useQuietNotifier(): void {
  const store = useHelmStore()
  const { conversations, pluginDocs, groupedUi } = store
  const panels = groupedUi.workbenchPanels

  const background = useMemo(
    () => summarizeConversationBackgroundActivity({ panels, conversations, pluginDocs }),
    [panels, conversations, pluginDocs],
  )
  const badgeDocs = useMemo(() => collectBackgroundBadgeDocs(panels, conversations), [panels, conversations])

  // badge doc 自洽发现与按需加载（幂等去重由 ensurePluginDoc 保证）。当前启用
  // 面板所需 doc 只要不在 store 快照中就保持未知，包括插件重载清空后的窗口；
  // ensure 失败时 store 已明示 toast，未知持续到后续状态变化重试，绝不误报已完成。
  const { authenticated, ensurePluginDoc, quietNotifyEnabled, sseConnected } = store
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) void ensurePluginDoc(ref.pluginId, ref.doc)
  }, [badgeDocs, authenticated, ensurePluginDoc, pluginDocs])

  const pendingBadgeDocs = useMemo(() => {
    const pending = new Set<string>()
    for (const ref of badgeDocs) {
      const key = `${ref.pluginId}/${ref.doc}`
      if (!Object.hasOwn(pluginDocs, key)) pending.add(key)
    }
    return pending
  }, [badgeDocs, pluginDocs])

  const snapshot = useMemo(
    () => resolveActivitySnapshot({ conversations, background, pendingBadgeDocs }),
    [conversations, background, pendingBadgeDocs],
  )

  // 计时器仅从已提交 render 后的 layout/passive effect 启动，latest refs 同步也
  // 放在 layout effect，避免并发 React 放弃 render 时泄漏未提交快照。
  const snapshotRef = useRef(snapshot)
  const conversationsRef = useRef(conversations)
  const storeRef = useRef(store)
  const stateRef = useRef<NotifierState>({
    trees: new Map(),
    handledBlockedWatermarks: new Map(),
    baselineSeeded: false,
  })

  const settleCompletionRef = useRef<(rootId: number) => void>(() => {})
  const settleBlockedRef = useRef<(rootId: number) => void>(() => {})

  useLayoutEffect(() => {
    snapshotRef.current = snapshot
    conversationsRef.current = conversations
    storeRef.current = store

    const state = stateRef.current
    if (authenticated && quietNotifyEnabled) {
      const byId = buildConversationIndex(conversations)

      // 首次进入跟踪状态（挂载初值、关闭后重开、或初始 SSE 快照首达）时先登记
      // 已处于 blocked 态的基线水位，确保页面打开时已待审批会话不误报。
      if (!state.baselineSeeded && sseConnected) {
        for (const conv of conversations) {
          if (conv.status === 'blocked') {
            state.handledBlockedWatermarks.set(conv.id, getBlockedWatermark(conv))
          }
        }
        state.baselineSeeded = true
      }

      // 离开 blocked 态的会话释放其水位，后续再次进入 blocked 时视为新待处理。
      const currentBlockedIds = new Set<number>()
      for (const treeSnap of snapshot.trees.values()) {
        for (const id of treeSnap.blockedConversationIds) currentBlockedIds.add(id)
      }
      for (const id of state.handledBlockedWatermarks.keys()) {
        if (!currentBlockedIds.has(id)) state.handledBlockedWatermarks.delete(id)
      }

      // 父节点被删时将存活参与者迁移到新存活根，避免旧根在子会话仍在途时抢跑结算。
      for (const [treeId, cycle] of state.trees) {
        for (const cid of [...cycle.accumulatedConversationIds]) {
          if (!byId.has(cid)) continue
          const currentRootId = resolveNotificationRootId(byId, cid)
          if (currentRootId !== treeId) {
            cycle.accumulatedConversationIds.delete(cid)
            ensureTreeCycle(state.trees, currentRootId).accumulatedConversationIds.add(cid)
          }
        }
      }

      // 累计各树当前机器在途参与者。
      for (const [rootId, treeSnap] of snapshot.trees) {
        if (treeSnap.activeConversationIds.size === 0) continue
        const cycle = ensureTreeCycle(state.trees, rootId)
        for (const id of treeSnap.activeConversationIds) {
          cycle.accumulatedConversationIds.add(id)
        }
      }
    }

    settleCompletionRef.current = (rootId: number) => {
      const currentStore = storeRef.current
      if (!currentStore.authenticated || !currentStore.quietNotifyEnabled) return
      const currentState = stateRef.current
      const cycle = currentState.trees.get(rootId)
      if (cycle === undefined || cycle.accumulatedConversationIds.size === 0) return
      const currentSnapshot = snapshotRef.current
      const treeSnap = currentSnapshot.trees.get(rootId)
      const isTreeIdle =
        !currentSnapshot.badgeUnknown &&
        (treeSnap === undefined ||
          (treeSnap.activeConversationIds.size === 0 && treeSnap.blockedConversationIds.size === 0))
      if (!isTreeIdle) return
      if (!currentStore.sseConnected) {
        cycle.holdForReconnect = true
        return
      }
      const accumulated = new Set(cycle.accumulatedConversationIds)
      cycle.accumulatedConversationIds.clear()
      cycle.holdForReconnect = false
      const draft = composeTreeCompletionNotification({
        rootId,
        accumulatedConversationIds: accumulated,
        conversations: conversationsRef.current,
      })
      pruneTreeCycleIfEmpty(currentState.trees, rootId)
      if (draft === null) return
      if (
        !shouldDeliverQuietNotification({
          authenticated: currentStore.authenticated,
          preferenceEnabled: currentStore.quietNotifyEnabled,
          permission: readBrowserNotificationPermission(),
          connected: currentStore.sseConnected,
          pageActive: isPageActive(),
        })
      ) {
        return
      }
      const primaryConversationId = draft.primaryConversationId
      showBrowserNotification({
        title: draft.title,
        body: draft.body,
        tag: treeNotificationTag(rootId),
        onClick:
          primaryConversationId === null
            ? undefined
            : () => currentStore.openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
      })
    }

    settleBlockedRef.current = (rootId: number) => {
      const currentStore = storeRef.current
      if (!currentStore.authenticated || !currentStore.quietNotifyEnabled) return
      const currentState = stateRef.current
      const cycle = currentState.trees.get(rootId)
      const treeSnap = snapshotRef.current.trees.get(rootId)
      const currentConversations = conversationsRef.current
      const byId = buildConversationIndex(currentConversations)
      if (!hasUnacknowledgedBlocked(treeSnap, byId, currentState.handledBlockedWatermarks)) {
        if (cycle !== undefined) cycle.blockedHoldForReconnect = false
        return
      }
      if (!currentStore.sseConnected) {
        ensureTreeCycle(currentState.trees, rootId).blockedHoldForReconnect = true
        return
      }
      const activeNow = treeSnap?.activeConversationIds ?? new Set<number>()
      const blockedNow = treeSnap?.blockedConversationIds ?? new Set<number>()
      const draft = composeTreeBlockedNotification({
        rootId,
        blockedConversationIds: blockedNow,
        accumulatedConversationIds: cycle?.accumulatedConversationIds,
        conversations: currentConversations,
      })
      // 无论页面此刻是否在前台，均标记本次 blocked 水位已处理（防切后台后滞后补弹或重复提醒）。
      for (const id of blockedNow) {
        const conv = byId.get(id)
        if (conv !== undefined) currentState.handledBlockedWatermarks.set(id, getBlockedWatermark(conv))
      }
      // 清空该树此前的完成周期累计（仅保留此刻仍在机器在途的会话），避免因卡在等待人类停下而误报「已完成」。
      if (cycle !== undefined) {
        cycle.blockedHoldForReconnect = false
        cycle.accumulatedConversationIds = new Set(activeNow)
        if (cycle.completionTimer !== null) {
          clearTimeout(cycle.completionTimer)
          cycle.completionTimer = null
        }
        cycle.holdForReconnect = false
        pruneTreeCycleIfEmpty(currentState.trees, rootId)
      }
      if (draft === null) return
      if (
        !shouldDeliverQuietNotification({
          authenticated: currentStore.authenticated,
          preferenceEnabled: currentStore.quietNotifyEnabled,
          permission: readBrowserNotificationPermission(),
          connected: currentStore.sseConnected,
          pageActive: isPageActive(),
        })
      ) {
        return
      }
      const primaryConversationId = draft.primaryConversationId
      showBrowserNotification({
        title: draft.title,
        body: draft.body,
        tag: treeNotificationTag(rootId),
        onClick:
          primaryConversationId === null
            ? undefined
            : () => currentStore.openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
      })
    }
  })

  useEffect(() => {
    const state = stateRef.current
    if (!authenticated || !quietNotifyEnabled) {
      // 明确放弃周期：清空全部计时、周期累计、重连待结算与 blocked 基线（关闭期间不追踪）。
      for (const cycle of state.trees.values()) {
        if (cycle.completionTimer !== null) clearTimeout(cycle.completionTimer)
        if (cycle.blockedTimer !== null) clearTimeout(cycle.blockedTimer)
      }
      state.trees.clear()
      state.handledBlockedWatermarks.clear()
      state.baselineSeeded = false
      return
    }

    const byId = buildConversationIndex(conversations)
    const allRootIds = new Set<number>([...snapshot.trees.keys(), ...state.trees.keys()])
    for (const rootId of allRootIds) {
      const treeSnap = snapshot.trees.get(rootId)
      const cycle = state.trees.get(rootId)

      // 1) blocked 等待处理通道：独立于同树其他并行后台任务与 badgeUnknown。
      const pendingBlocked = hasUnacknowledgedBlocked(treeSnap, byId, state.handledBlockedWatermarks)
      if (!pendingBlocked) {
        if (cycle !== undefined) {
          if (cycle.blockedTimer !== null) {
            clearTimeout(cycle.blockedTimer)
            cycle.blockedTimer = null
          }
          cycle.blockedHoldForReconnect = false
        }
      } else {
        const targetCycle = ensureTreeCycle(state.trees, rootId)
        if (targetCycle.blockedHoldForReconnect) {
          if (sseConnected) {
            targetCycle.blockedHoldForReconnect = false
            settleBlockedRef.current(rootId)
          }
        } else if (targetCycle.blockedTimer === null) {
          targetCycle.blockedTimer = setTimeout(() => {
            const current = stateRef.current.trees.get(rootId)
            if (current !== undefined) current.blockedTimer = null
            settleBlockedRef.current(rootId)
          }, quietNotifyTimings.blockedSettleMs)
        }
      }

      // 2) 完成通知通道：该树无在途、无 blocked 且 !badgeUnknown 才进入防抖窗口。
      const latestCycle = state.trees.get(rootId)
      if (latestCycle === undefined) continue
      const treeActive = (treeSnap?.activeConversationIds.size ?? 0) > 0
      const treeBlocked = (treeSnap?.blockedConversationIds.size ?? 0) > 0
      const treeIdleForCompletion = !snapshot.badgeUnknown && !treeActive && !treeBlocked

      if (!treeIdleForCompletion) {
        if (latestCycle.completionTimer !== null) {
          clearTimeout(latestCycle.completionTimer)
          latestCycle.completionTimer = null
        }
        latestCycle.holdForReconnect = false
      } else if (latestCycle.holdForReconnect) {
        if (sseConnected) {
          latestCycle.holdForReconnect = false
          settleCompletionRef.current(rootId)
        }
      } else if (latestCycle.accumulatedConversationIds.size > 0 && latestCycle.completionTimer === null) {
        latestCycle.completionTimer = setTimeout(() => {
          const current = stateRef.current.trees.get(rootId)
          if (current !== undefined) current.completionTimer = null
          settleCompletionRef.current(rootId)
        }, quietNotifyTimings.settleMs)
      }

      pruneTreeCycleIfEmpty(state.trees, rootId)
    }
  }, [snapshot, conversations, authenticated, quietNotifyEnabled, sseConnected])

  useEffect(
    () => () => {
      for (const cycle of stateRef.current.trees.values()) {
        if (cycle.completionTimer !== null) {
          clearTimeout(cycle.completionTimer)
          cycle.completionTimer = null
        }
        if (cycle.blockedTimer !== null) {
          clearTimeout(cycle.blockedTimer)
          cycle.blockedTimer = null
        }
      }
    },
    [],
  )
}
