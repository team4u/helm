/**
 * 「全部空闲 / 等待你的处理」浏览器通知装配 hook：订阅全局实时状态 → 纯函数
 * 快照 → 安静持续满防抖窗口后经 DOM 边界投递。App 根（HelmShellInner）挂载一次。
 *
 * - 自洽发现所需 badge doc：复用 collectBackgroundBadgeDocs 找出启用面板的
 *   按会话角标 doc，经 store.ensurePluginDoc 按需加载（幂等去重，与侧栏共用
 *   同一通道）——不把 Sidebar 当作隐式必需的数据加载者；
 * - badge doc 未完成首次加载期间保持未知（quiet 不成立），绝不把「还没读到
 *   角标」当成「没有后台在途」；快照 pluginDocs 首帧直投则天然无未知窗口；
 * - 忙碌周期累积：机器活动期间持续累计参与会话，跨多个被活动取消的安静
 *   防抖窗口保留（多阶段收尾不丢早期参与者），结算投递/明确放弃周期时清空；
 * - 结算时用最新 conversations 事实组装：派生子会话归并到根会话，存在
 *   blocked 会话则改发「等待你的处理」并优先跳转该会话（见 quiet-notify-model）；
 * - 防抖到期时若 SSE 断流：不按陈旧状态投递，保留周期等待重连后按新事实
 *   结算——不静默丢掉整轮，也不重复投递；
 * - 偏好关闭 / 未认证即明确放弃周期（计时与累积清空），重新开启后只追踪
 *   新周期内的活动；
 * - 权限、连接与页面失焦在触发当刻逐项复核（quiet-notify-model 门控）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { readBrowserNotificationPermission, showBrowserNotification } from '../lib/browser-notification.js'
import { useHelmStore } from '../lib/store-context.js'
import { collectBackgroundBadgeDocs, summarizeConversationBackgroundActivity } from './background-activity-model.js'
import {
  composeQuietNotification,
  resolveActivitySnapshot,
  shouldDeliverQuietNotification,
} from './quiet-notify-model.js'

/** 时序参数（集中定义；对象引用共享，测试可临时改写后复原，与 sseClientTimings 同约定）。 */
export const quietNotifyTimings = {
  /** 安静需持续的最短时长（毫秒），吸收状态与角标推进的瞬时抖动。 */
  settleMs: 2_500,
}

/** 通知去重 tag：同 tag 新通知替换旧通知，连续多轮安静不堆积。 */
const QUIET_NOTIFICATION_TAG = 'helm-quiet'

/** 一个忙碌周期的全部可变状态（ref 持有，避免状态机自身触发重渲染）。 */
interface BusyCycle {
  /** 本周期累计参与机器活动的会话 ID（跨被取消的防抖窗口保留）。 */
  activeConversationIds: Set<number>
  /** 安静防抖计时器（null = 未在计时）。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 安静已满窗但 SSE 断流：保留周期等重连后按最新事实结算。 */
  holdForReconnect: boolean
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
  // ensure 失败时 store 已明示 toast，未知持续到后续状态变化重试，绝不误报安静。
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
  const cycleRef = useRef<BusyCycle>({ activeConversationIds: new Set(), timer: null, holdForReconnect: false })

  /** 安静结算回调由 layout effect 更新，只暴露最后一次已提交状态。 */
  const settleRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    snapshotRef.current = snapshot
    conversationsRef.current = conversations
    storeRef.current = store
    if (authenticated && quietNotifyEnabled) {
      for (const id of snapshot.activeConversationIds) cycleRef.current.activeConversationIds.add(id)
    }

    settleRef.current = () => {
      const cycle = cycleRef.current
      const currentSnapshot = snapshotRef.current
      if (!currentSnapshot.quiet) return
      const currentStore = storeRef.current
      if (!currentStore.sseConnected) {
        cycle.holdForReconnect = true
        return
      }
      const accumulated = new Set(cycle.activeConversationIds)
      cycle.activeConversationIds.clear()
      const draft = composeQuietNotification({
        accumulatedConversationIds: accumulated,
        blockedConversationIds: currentSnapshot.blockedConversationIds,
        conversations: conversationsRef.current,
      })
      if (draft === null) return
      if (
        !shouldDeliverQuietNotification({
          authenticated: currentStore.authenticated,
          preferenceEnabled: currentStore.quietNotifyEnabled,
          permission: readBrowserNotificationPermission(),
          connected: currentStore.sseConnected,
          pageVisible: !document.hidden,
          pageFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
        })
      ) {
        return
      }
      const primaryConversationId = draft.primaryConversationId
      showBrowserNotification({
        title: draft.title,
        body: draft.body,
        tag: QUIET_NOTIFICATION_TAG,
        onClick:
          primaryConversationId === null
            ? undefined
            : () => currentStore.openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
      })
    }
  })

  useEffect(() => {
    const cycle = cycleRef.current
    if (!authenticated || !quietNotifyEnabled) {
      // 明确放弃周期：清空计时、累积与重连待结算（偏好关闭/未认证期间不追踪，
      // 重新开启后只报告新周期内观察到的活动）。
      if (cycle.timer !== null) {
        clearTimeout(cycle.timer)
        cycle.timer = null
      }
      cycle.activeConversationIds.clear()
      cycle.holdForReconnect = false
      return
    }
    if (!snapshot.quiet) {
      // 机器在途或 badge doc 未知：防抖取消、丢弃重连待结算，累积保留继续周期。
      if (cycle.timer !== null) {
        clearTimeout(cycle.timer)
        cycle.timer = null
      }
      cycle.holdForReconnect = false
      return
    }
    if (cycle.holdForReconnect) {
      if (!sseConnected) return
      cycle.holdForReconnect = false
      settleRef.current()
      return
    }
    if (cycle.activeConversationIds.size > 0 && cycle.timer === null) {
      cycle.timer = setTimeout(() => {
        cycleRef.current.timer = null
        settleRef.current()
      }, quietNotifyTimings.settleMs)
    }
  }, [snapshot, authenticated, quietNotifyEnabled, sseConnected])

  useEffect(
    () => () => {
      if (cycleRef.current.timer !== null) clearTimeout(cycleRef.current.timer)
    },
    [],
  )
}
