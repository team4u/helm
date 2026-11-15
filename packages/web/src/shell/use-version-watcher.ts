/**
 * 版本感知装配 hook（App 根挂载一次；纯逻辑见 version-watch-model.ts）：
 *
 * - 启用门控：启动时从当前 document 识别生产入口指纹（dev `/src/main.tsx`、
 *   单测环境识别不到即整体休眠，不注册任何 timer/listener）；
 * - 触发探测：SSE snapshot 的 bootId 变化（首次 snapshot 只建基线，不视为
 *   更新）、visibilitychange 变 visible 与 window.focus（约 5s 节流）、页面
 *   visible 期间每 60s 轮询（hidden 期间跳过）、Vite `vite:preloadError`
 *   动态 chunk 失效兜底；在途探测期间收到的新触发不丢弃（完成后立刻补探）；
 * - 刷新挂起条件 = 浏览器本地交互现场（三者并集，宁可保守）：
 *   ① 会话 Composer（文本/编辑目标/附件/发送上传在途，经 composer-dirty 桥接）
 *   ∪ 任意坐标待命草稿（standby-model）——权威草稿事实；
 *   ② 当前焦点位于 input/textarea ——保守表单编辑保护（焦点内可能存在
 *   Composer/standby 之外的未提交输入，如各中心检索框；仅作额外 guard，
 *   不是唯一来源，文案并入「未提交内容」）；
 *   ③ 任意打开中的弹窗（activeModal 非空即挂起——弹窗是聚焦交互现场，
 *   skill-viewer/artifact-preview 等只读弹窗同样不在自动刷新下冒险，
 *   且 ActiveModal 无稳定的「只读」标记可依赖，按类型枚举会随形态演化腐烂）。
 *   服务端已持久化的会话流不构成挂起条件；
 * - 刷新策略：clean 时检测到新版本立即 reload；挂起时显示持久横幅（非自动
 *   消失 toast，状态驱动不堆积）并提供「立即刷新」；挂起条件全部解除（含
 *   输入失焦）后自动补刷；reload 只触发一次（防循环/重复探测/重复通知）；
 *   vite:preloadError 恒 preventDefault（Vite 6 契约：未取消会重抛底层错误
 *   覆盖提示），其证据驱动的自动刷新占用每 tab 一次的 sessionStorage 名额
 *   （跨 reload 防环：瞬态错误反复触发时重试一次后仅保留提示、手动刷新；
 *   storage 不可用一律拒绝自动刷新；指纹变化驱动的正常刷新不设跨页标记）；
 *   卸载后在途探测回包不再推进状态机或触发 reload（代际守卫）；
 * - bootId 变化只触发探测，是否刷新仍由入口指纹比对决定（内核重启未必更换
 *   Web 产物）；断线提示仍由 App 连接横幅负责，两套提示互不替代。
 * 本模块只导出 hook 与纯类型（无组件），保持 .ts Fast Refresh 约定。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useHelmStore } from '../lib/store-context.js'
import { composerDirty, subscribeComposerDirty } from '../conversation/composer-dirty.js'
import { standbyDraftsDirty, subscribeStandbyDrafts } from '../conversation/standby-model.js'
import {
  applyProbeResult,
  claimPreloadAutoReload,
  detectDocumentProductionEntry,
  initialVersionWatchState,
  isTextInputElement,
  probeAllowed,
  probeLatestIndexEntry,
  shouldReloadNow,
  versionUpdatePending,
  type VersionDeferReason,
  type VersionWatchState,
} from './version-watch-model.js'

/** 时序参数（集中定义；对象引用共享，测试可临时改写后复原，与 sseClientTimings 同约定）。 */
export const versionWatchTimings = {
  /** visibilitychange / window.focus 触发探测的节流窗口（毫秒）。 */
  visibilityThrottleMs: 5_000,
  /** 页面可见期间的周期探测间隔（毫秒）；hidden 期间跳过。 */
  pollIntervalMs: 60_000,
}

/** 安全读取 sessionStorage（隐私模式 getter 抛错 / 无 window 环境均返回 null）。 */
function safeSessionStorage(): Storage | null {
  try {
    return sessionStorage
  } catch {
    return null
  }
}

export interface VersionWatcherOptions {
  /** 刷新执行（默认 window.location.reload；测试注入）。 */
  reload?: () => void
}

/** 自动刷新挂起原因：null = 未挂起（clean）。 */
export type { VersionDeferReason }

export interface VersionWatcherView {
  /** 探测到待刷新的新版本（最新入口指纹 ≠ 当前页面入口指纹，或资产失效兜底）。 */
  updateAvailable: boolean
  /** 自动刷新挂起原因（草稿事实/焦点保护/弹窗；横幅文案依据；null = 未挂起）。 */
  deferReason: VersionDeferReason
  /** 横幅「立即刷新」动作：显式触发一次刷新（幂等，不重复 reload）。 */
  reloadNow: () => void
}

export function useVersionWatcher(options: VersionWatcherOptions = {}): VersionWatcherView {
  const store = useHelmStore()
  // 本地未提交草稿现场（外部 store 聚合布尔值；getSnapshot 为原始值天然稳定）。
  const composerDirtyNow = useSyncExternalStore(subscribeComposerDirty, composerDirty, () => false)
  const standbyDirtyNow = useSyncExternalStore(subscribeStandbyDrafts, standbyDraftsDirty, () => false)
  const draftDirty = composerDirtyNow || standbyDirtyNow
  // 弹窗现场：任意 activeModal（含只读预览）都挂起自动刷新，理由见文件头。
  const modalOpen = store.activeModal !== null
  // 焦点现场：焦点在 input/textarea 即保守视为存在未提交输入（额外 guard）。
  const [textInputFocused, setTextInputFocused] = useState<boolean>(() =>
    typeof document !== 'undefined' && isTextInputElement(document.activeElement),
  )

  // 启用门控：当前页面生产入口指纹（惰性一次性读取；null = 探测器休眠）。
  const [currentEntry] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : detectDocumentProductionEntry(document),
  )

  const [updateAvailable, setUpdateAvailable] = useState(false)
  // 回调侧最新事实经 ref 转发（listener/interval 不持有渲染闭包）。
  const stateRef = useRef<VersionWatchState>(
    currentEntry !== null ? initialVersionWatchState(currentEntry) : { currentEntry: '', latestEntry: null },
  )
  const draftDirtyRef = useRef(draftDirty)
  draftDirtyRef.current = draftDirty
  const modalOpenRef = useRef(modalOpen)
  modalOpenRef.current = modalOpen
  const textFocusRef = useRef(textInputFocused)
  textFocusRef.current = textInputFocused
  const pendingRef = useRef(false)
  /** preloadError 强制挂起（页面资产已失效，横幅不得被后续未变化探测解除）。 */
  const forcedPendingRef = useRef(false)
  const reloadTriggeredRef = useRef(false)
  const probingRef = useRef(false)
  /** 在途探测期间收到的新触发（如 bootId 变化）：完成后立刻补一次，不吞快速触发。 */
  const probeQueuedRef = useRef(false)
  const lastProbeAtRef = useRef<number | null>(null)
  const bootIdSeenRef = useRef<string | null>(null)
  const reloadRef = useRef<(() => void) | undefined>(options.reload)
  reloadRef.current = options.reload
  /** 装配存活标记：卸载后迟到的探测回包不再推进状态机或触发 reload。 */
  const activeRef = useRef(true)
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const reloadOnce = useCallback((): void => {
    if (reloadTriggeredRef.current) return
    reloadTriggeredRef.current = true
    const reload = reloadRef.current ?? (typeof window !== 'undefined' ? () => window.location.reload() : undefined)
    reload?.()
  }, [])

  /** 状态机推进 + pending 变化通知渲染 + clean 时自动刷新判定。 */
  const settle = useCallback((): void => {
    // preloadError 已证实当前页面资产失效：pending 锁定直到刷新，后续探测
    //（指纹恰好未变）不得解除提示。
    const fingerprintPending = versionUpdatePending(stateRef.current)
    const pending = forcedPendingRef.current || fingerprintPending
    if (pending !== pendingRef.current) {
      pendingRef.current = pending
      setUpdateAvailable(pending)
    }
    if (
      !shouldReloadNow({
        pending,
        dirty: draftDirtyRef.current || modalOpenRef.current || textFocusRef.current,
        reloadTriggered: reloadTriggeredRef.current,
      })
    ) {
      return
    }
    // 纯 preloadError 证据驱动的刷新占用每 tab 一次的自动重试名额（跨 reload
    // 防环：瞬态错误或部署窗口反复触发时，重试一次后仅保留提示、手动刷新）；
    // 真实指纹变化驱动的刷新不经此守卫（正常升级路径无跨页标记）。
    if (!fingerprintPending && forcedPendingRef.current) {
      if (claimPreloadAutoReload(safeSessionStorage())) reloadOnce()
      return
    }
    reloadOnce()
  }, [reloadOnce])

  const runProbe = useCallback(async (): Promise<void> => {
    if (currentEntry === null) return
    if (probingRef.current) {
      probeQueuedRef.current = true
      return
    }
    probingRef.current = true
    try {
      do {
        probeQueuedRef.current = false
        const entry = await probeLatestIndexEntry({
          fetchHtml: (url, init) => fetch(url, init),
        })
        // 卸载后迟到的回包：不推进状态机、不触发 reload，直接丢弃。
        if (!activeRef.current) return
        // 探测失败（null）不改变判定；成功才推进状态机。
        stateRef.current = applyProbeResult(stateRef.current, entry)
        settle()
      } while (probeQueuedRef.current && activeRef.current)
    } finally {
      probingRef.current = false
    }
  }, [currentEntry, settle])

  // bootId 触发：SSE snapshot 的内核启动代变化。首次 snapshot 只建基线
  //（当前页面刚加载/首连不视为更新）；之后变化立即探测（不受 5s 节流）。
  // 登出不重置 kernelBootId：它是「最近见过的内核启动代」这一事实，重新
  // 登录后快照同代不探测、跨代（登出期间内核重启）才探测。
  const kernelBootId = store.kernelBootId ?? null
  useEffect(() => {
    if (currentEntry === null) return
    const prev = bootIdSeenRef.current
    bootIdSeenRef.current = kernelBootId
    if (kernelBootId === null || prev === null || prev === kernelBootId) return
    void runProbe()
  }, [kernelBootId, currentEntry, runProbe])

  // 挂起条件（草稿/弹窗/文本焦点）全部解除：仍有待刷新版本（含 preloadError
  // 强制挂起）即自动补刷（reloadOnce 幂等防循环）。
  useEffect(() => {
    if (currentEntry === null) return
    if (!draftDirty && !modalOpen && !textInputFocused) settle()
  }, [draftDirty, modalOpen, textInputFocused, currentEntry, settle])

  // 事件与轮询装配：visibility/focus 节流探测、visible 期间 60s 轮询
  //（hidden 跳过）、vite:preloadError 兜底；卸载全部清理。
  useEffect(() => {
    if (currentEntry === null) return
    const probeThrottled = (): void => {
      if (!probeAllowed(Date.now(), lastProbeAtRef.current, versionWatchTimings.visibilityThrottleMs)) return
      lastProbeAtRef.current = Date.now()
      void runProbe()
    }
    const onVisibilityChange = (): void => {
      if (!document.hidden) probeThrottled()
    }
    const onFocus = (): void => probeThrottled()
    const onPreloadError = (event: Event): void => {
      // Vite 6 preload helper：事件未 preventDefault 时会重新抛出底层错误
      //（cancelable: true）。本 handler 恒接管（自动刷新或保留提示），必须
      // 取消默认行为，避免 dirty 挂起路径上未处理异常覆盖提示。
      event.preventDefault()
      forcedPendingRef.current = true
      // 统一走 settle：clean 时按名额守卫决定自动刷新或保留提示；有本地交互
      // 现场则挂起为待刷新（横幅 + 立即刷新），等待挂起条件解除补刷。
      settle()
    }
    // 焦点保护：focusin/focusout 后按 document.activeElement 重算（焦点在
    // input/textarea 之间直接转移时两次事件同任务批处理，不产生中间态提交）。
    const syncTextInputFocus = (): void => {
      const focused = isTextInputElement(document.activeElement)
      if (focused === textFocusRef.current) return
      textFocusRef.current = focused
      setTextInputFocused(focused)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    window.addEventListener('vite:preloadError', onPreloadError)
    document.addEventListener('focusin', syncTextInputFocus)
    document.addEventListener('focusout', syncTextInputFocus)
    const timer = setInterval(() => {
      if (document.hidden) return
      void runProbe()
    }, versionWatchTimings.pollIntervalMs)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('vite:preloadError', onPreloadError)
      document.removeEventListener('focusin', syncTextInputFocus)
      document.removeEventListener('focusout', syncTextInputFocus)
      clearInterval(timer)
    }
  }, [currentEntry, runProbe, reloadOnce, settle])

  // 会话 Composer 脏状态由各组件实例自行上报与清除（composer-dirty 桥接），
  // 本 hook 只订阅聚合结果，无需额外清理。

  // 「未提交内容」语义 = 权威草稿事实 ∪ 焦点保护（焦点内可能存在其他未提交输入）。
  const draftLike = draftDirty || textInputFocused
  const deferReason: VersionDeferReason = !draftLike && !modalOpen
    ? null
    : draftLike && modalOpen
      ? 'draft-and-modal'
      : draftLike
        ? 'draft'
        : 'modal'
  return {
    updateAvailable: currentEntry !== null && updateAvailable,
    deferReason: currentEntry !== null ? deferReason : null,
    reloadNow: reloadOnce,
  }
}
