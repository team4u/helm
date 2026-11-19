/**
 * 按根会话树独立结算的后台浏览器通知装配 hook：订阅全局实时状态 → 纯函数
 * 快照 → 防抖确认后经 DOM 边界投递。App 根（HelmxShellInner）挂载一次。
 *
 * - 自洽发现所需 badge doc：复用 collectBackgroundBadgeDocs 找出启用面板的
 *   按会话角标 doc，经 store.ensurePluginDoc 按需加载（幂等去重，与侧栏共用
 *   同一通道）——不把 Sidebar 当作隐式必需的数据加载者；
 * - badge doc 未完成首次加载期间保持全局未知（badgeUnknown = true），阻止任何
 *   根会话树误报「已完成」（blocked 通知不受未知门控阻滞，独立及时提醒）；
 * - 按根会话树独立结算完成通知：树 A 仍在运行不阻塞树 B 结算完成；每棵树在
 *   周期内持续累计参与会话（含被归并的派生子会话），跨被本树活动取消的防抖
 *   窗口保留；结算时无 error 报「Helmx 会话已完成」，有 error 报「Helmx 会话已结束」
 *   （附「有失败」），tag 为 `helmx-conv-${rootId}`，点击跳转 rootId（仍存在时）；
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { resolveLocalizedText, type LocaleTranslator, type LocalizedText } from '@helmx/protocol/browser'
import {
  isPageActive,
  readBrowserNotificationPermission,
  showBrowserNotification,
} from '../lib/browser-notification.js'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  usePluginDocsState,
  useStoreActions,
  useThemePreferencesState,
} from '../lib/store-context.js'
import { collectBackgroundBadgeDocs, summarizeConversationBackgroundActivity } from './background-activity-model.js'
import {
  COMPLETED_NOTIFICATION_TITLE,
  ENDED_NOTIFICATION_TITLE,
  WAITING_NOTIFICATION_TITLE,
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
const treeNotificationTag = (rootId: number): string => `helmx-conv-${rootId}`

// ---------------------------------------------------------------------------
// 通知展示文案本地化（en/zh-CN）
//
// quiet-notify-model 以规范英文常量产出 draft（title 为三个导出常量，body 为
// ' · ' 连接的会话标签与固定片段）；本层在投递时刻按当前 locale 翻译：
// - title 与三个常量做恒等匹配，未知标题原样透传（不猜、不误翻会话内容）；
// - body 仅翻译模型自有的固定片段（前缀/「N pending in total」/「Has failures」
//   与根会话已删时的两句整句常量）；'#id 标题' 会话标签原样保留。片段与标题
//   内容恰好同文的极端情形按片段翻译——语义保持，仅语言切换；
// - 错误协议文本（errorText/HTTP 错误）不经此层，天然不翻译。
// ---------------------------------------------------------------------------

/** 三个规范标题常量 → 双语文案（恒等匹配，杜绝误翻）。 */
const NOTIFICATION_TITLE_COPY: ReadonlyMap<string, LocalizedText> = new Map([
  [COMPLETED_NOTIFICATION_TITLE, { en: COMPLETED_NOTIFICATION_TITLE, 'zh-CN': 'Helmx 会话已完成' }],
  [ENDED_NOTIFICATION_TITLE, { en: ENDED_NOTIFICATION_TITLE, 'zh-CN': 'Helmx 会话已结束' }],
  [WAITING_NOTIFICATION_TITLE, { en: WAITING_NOTIFICATION_TITLE, 'zh-CN': 'Helmx 等待你的处理' }],
])

/** blocked 正文前缀（模型固定输出，position-0 锚定）。 */
const PENDING_PREFIX = 'Pending input/approvals: '
/** 失败标注片段（模型作为最末片段追加）。 */
const FAILURE_PART = 'Has failures'
/** 折叠计数片段（超出 MAX_LISTED_CONVERSATIONS 时追加；标签恒以 '#id ' 开头，永不与之同形）。 */
const TOTALS_PART_PATTERN = /^(\d+) pending in total$/

/** 投递时刻把通知标题映射为当前 locale 文案；未知标题原样透传。 */
export function localizeQuietNotificationTitle(title: string, translate: LocaleTranslator): string {
  const copy = NOTIFICATION_TITLE_COPY.get(title)
  return copy === undefined ? title : translate(copy)
}

/** 投递时刻把模型产出的规范英文正文映射为当前 locale 文案（会话标签原样保留）。 */
export function localizeQuietNotificationBody(body: string, translate: LocaleTranslator): string {
  if (body === 'Conversation finished' || body === 'Conversation finished · with failures') {
    return translate({
      en: body,
      'zh-CN': body.endsWith('with failures') ? '会话已结束 · 有失败' : '会话已结束',
    })
  }
  return body
    .split(' · ')
    .map((part) => {
      if (part.startsWith(PENDING_PREFIX)) {
        return `${translate({ en: 'Pending input/approvals', 'zh-CN': '待处理输入/审批' })}: ${part.slice(PENDING_PREFIX.length)}`
      }
      if (part === FAILURE_PART) return translate({ en: FAILURE_PART, 'zh-CN': '有失败' })
      const totals = TOTALS_PART_PATTERN.exec(part)
      if (totals !== null) {
        const count = totals[1]!
        return translate({ en: `${count} pending in total`, 'zh-CN': `共 ${count} 个待处理` })
      }
      return part
    })
    .join(' · ')
}

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
  const conversations = useConversations()
  const pluginDocs = usePluginDocsState()
  const groupedUi = useGroupedUi()
  const { authenticated, sseConnected } = useAuthConnection()
  const { locale, quietNotifyEnabled } = useThemePreferencesState()
  const { ensurePluginDoc, openTarget } = useStoreActions()
  const panels = groupedUi.workbenchPanels

  // 语言切换只更新 locale ref，不进任何回调/effect 依赖：badge doc 发现与订阅
  // 不因切换语言重跑，投递时刻（防抖计时器/重连复核回调）读取当前 locale，
  // 既不重连重新请求，也不让旧闭包投递旧语言。
  const localeRef = useRef(locale)
  const translate = useCallback((text: LocalizedText) => resolveLocalizedText(text, localeRef.current), [])

  const background = useMemo(
    () => summarizeConversationBackgroundActivity({ panels, conversations, pluginDocs }),
    [panels, conversations, pluginDocs],
  )
  const badgeDocs = useMemo(() => collectBackgroundBadgeDocs(panels, conversations), [panels, conversations])

  // badge doc 自洽发现与按需加载（幂等去重由 ensurePluginDoc 保证）。当前启用
  // 面板所需 doc 只要不在 store 快照中就保持未知，包括插件重载清空后的窗口；
  // ensure 失败时 store 已明示 toast，未知持续到后续状态变化重试，绝不误报已完成。
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
  const flagsRef = useRef({ authenticated, quietNotifyEnabled, sseConnected })
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
    flagsRef.current = { authenticated, quietNotifyEnabled, sseConnected }
    localeRef.current = locale

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
      const currentFlags = flagsRef.current
      if (!currentFlags.authenticated || !currentFlags.quietNotifyEnabled) return
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
      if (!currentFlags.sseConnected) {
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
          authenticated: currentFlags.authenticated,
          preferenceEnabled: currentFlags.quietNotifyEnabled,
          permission: readBrowserNotificationPermission(),
          connected: currentFlags.sseConnected,
          pageActive: isPageActive(),
        })
      ) {
        return
      }
      const primaryConversationId = draft.primaryConversationId
      showBrowserNotification({
        title: localizeQuietNotificationTitle(draft.title, translate),
        body: localizeQuietNotificationBody(draft.body, translate),
        tag: treeNotificationTag(rootId),
        url: primaryConversationId === null ? undefined : `/#/c/${primaryConversationId}`,
        onClick:
          primaryConversationId === null
            ? undefined
            : () => openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
      })
    }

    settleBlockedRef.current = (rootId: number) => {
      const currentFlags = flagsRef.current
      if (!currentFlags.authenticated || !currentFlags.quietNotifyEnabled) return
      const currentState = stateRef.current
      const cycle = currentState.trees.get(rootId)
      const treeSnap = snapshotRef.current.trees.get(rootId)
      const currentConversations = conversationsRef.current
      const byId = buildConversationIndex(currentConversations)
      if (!hasUnacknowledgedBlocked(treeSnap, byId, currentState.handledBlockedWatermarks)) {
        if (cycle !== undefined) cycle.blockedHoldForReconnect = false
        return
      }
      if (!currentFlags.sseConnected) {
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
          authenticated: currentFlags.authenticated,
          preferenceEnabled: currentFlags.quietNotifyEnabled,
          permission: readBrowserNotificationPermission(),
          connected: currentFlags.sseConnected,
          pageActive: isPageActive(),
        })
      ) {
        return
      }
      const primaryConversationId = draft.primaryConversationId
      showBrowserNotification({
        title: localizeQuietNotificationTitle(draft.title, translate),
        body: localizeQuietNotificationBody(draft.body, translate),
        tag: treeNotificationTag(rootId),
        url: primaryConversationId === null ? undefined : `/#/c/${primaryConversationId}`,
        onClick:
          primaryConversationId === null
            ? undefined
            : () => openTarget({ kind: 'conversation', conversationId: primaryConversationId }),
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
