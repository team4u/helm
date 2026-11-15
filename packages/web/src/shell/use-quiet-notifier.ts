/**
 * 「全部空闲」浏览器通知装配 hook：订阅全局实时状态 → 纯函数快照/转移 →
 * 安静持续满防抖窗口后经 DOM 边界投递。App 根（HelmShellInner）挂载一次。
 *
 * - 后台在途索引复用侧栏同源纯函数（summarizeConversationBackgroundActivity），
 *   侧栏空心环与通知的「在途」判定永不分裂；
 * - 状态机只认「忙碌 → 安静」转移：打开页面即安静、持续安静都不提醒；
 * - 防抖窗口内活动恢复即取消（主回合落定与后台角标推进之间的缝隙、
 *   SSE 重同步瞬间 doc 清空的假安静都被吸收）；
 * - 偏好关闭 / 未认证时不挂计时，但快照水位照常推进，中途开启也能正确
 *   识别下一次转移；
 * - 权限、连接与页面失焦在触发当刻逐项复核（quiet-notify-model 门控）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { readBrowserNotificationPermission, showBrowserNotification } from '../lib/browser-notification.js'
import { useHelmStore } from '../lib/store-context.js'
import type { HelmStoreValue } from '../lib/types.js'
import { summarizeConversationBackgroundActivity } from './background-activity-model.js'
import {
  composeQuietNotification,
  resolveActivitySnapshot,
  shouldDeliverQuietNotification,
  type ActivitySnapshot,
  type QuietNotificationDraft,
} from './quiet-notify-model.js'

/** 时序参数（集中定义；对象引用共享，测试可临时改写后复原，与 sseClientTimings 同约定）。 */
export const quietNotifyTimings = {
  /** 安静需持续的最短时长（毫秒），吸收状态与角标推进的瞬时抖动。 */
  settleMs: 2_500,
}

/** 通知去重 tag：同 tag 新通知替换旧通知，连续多轮安静不堆积。 */
const QUIET_NOTIFICATION_TAG = 'helm-quiet'

/** 触发当刻投递：一切现场复核，绝不依赖防抖窗口开启时的旧状态。 */
function deliverQuietNotification(input: {
  draft: QuietNotificationDraft
  snapshot: ActivitySnapshot
  store: HelmStoreValue
}): void {
  if (!input.snapshot.quiet) return
  if (
    !shouldDeliverQuietNotification({
      preferenceEnabled: input.store.quietNotifyEnabled,
      permission: readBrowserNotificationPermission(),
      connected: input.store.sseConnected,
      pageVisible: !document.hidden,
      pageFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
    })
  ) {
    return
  }
  const primaryConversationId = input.draft.primaryConversationId
  showBrowserNotification({
    title: input.draft.title,
    body: input.draft.body,
    tag: QUIET_NOTIFICATION_TAG,
    onClick:
      primaryConversationId === null
        ? undefined
        : () => input.store.openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
  })
}

export function useQuietNotifier(): void {
  const store = useHelmStore()
  const { conversations, pluginDocs, groupedUi } = store

  const background = useMemo(
    () => summarizeConversationBackgroundActivity({ panels: groupedUi.workbenchPanels, conversations, pluginDocs }),
    [groupedUi.workbenchPanels, conversations, pluginDocs],
  )
  const snapshot = useMemo(() => resolveActivitySnapshot({ conversations, background }), [conversations, background])

  // 供计时器回调读取最新事实：快照、会话列表与 store 方法均经 ref 转发。
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const storeRef = useRef(store)
  storeRef.current = store
  /** 上一份已观察快照（null = 尚未观察，打开页面的首个快照不构成转移）。 */
  const prevSnapshotRef = useRef<ActivitySnapshot | null>(null)
  /** 防抖窗口在途的安静转移（计时器 + 转移时刻组装的通知内容）。 */
  const pendingRef = useRef<{ timer: ReturnType<typeof setTimeout> } | null>(null)

  const disarm = () => {
    if (pendingRef.current === null) return
    clearTimeout(pendingRef.current.timer)
    pendingRef.current = null
  }
  useEffect(() => disarm, [])

  useEffect(() => {
    const prev = prevSnapshotRef.current
    prevSnapshotRef.current = snapshot
    if (!store.authenticated || !store.quietNotifyEnabled) {
      disarm()
      return
    }
    if (prev !== null && !prev.quiet && snapshot.quiet && pendingRef.current === null) {
      const draft = composeQuietNotification(prev, snapshot, conversationsRef.current)
      if (draft !== null) {
        pendingRef.current = {
          timer: setTimeout(() => {
            pendingRef.current = null
            deliverQuietNotification({ draft, snapshot: snapshotRef.current, store: storeRef.current })
          }, quietNotifyTimings.settleMs),
        }
      }
    }
    if (!snapshot.quiet) disarm()
  }, [snapshot, store.authenticated, store.quietNotifyEnabled])
}
