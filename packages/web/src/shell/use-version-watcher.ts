/**
 * 版本感知装配 hook（App 根挂载一次；纯逻辑见 version-watch-model.ts）：
 *
 * - 启用门控：启动时从当前 document 识别生产入口指纹（dev `/src/main.tsx`、
 *   单测环境识别不到即整体休眠，不注册任何 timer/listener）；
 * - 触发探测：SSE snapshot 的 bootId 变化（首次 snapshot 只建基线，不视为
 *   更新）、visibilitychange 变 visible 与 window.focus（约 5s 节流）、页面
 *   visible 期间每 60s 轮询（hidden 期间跳过）、Vite `vite:preloadError`
 *   触发入口探测（仅确认指纹已变才走升级刷新，指纹未变走可恢复错误状态）；
 *   在途探测期间收到的新触发不丢弃（完成后立刻补探）；
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
 * - 刷新策略：clean 时检测到新版本立即刷新；挂起时显示持久横幅（非自动
 *   消失 toast，状态驱动不堆积）并提供「立即刷新」；挂起条件全部解除（含
 *   输入失焦）后自动补刷；
 * - 刷新执行是 WebView-safe 顶层导航（部分 Android WebView/WKWebView 壳会
 *   吞掉 `location.reload()` 或对同址导航回吐旧缓存）：第一次尝试用
 *   `location.replace()` 保持原 pathname/query/hash 的干净同址导航（真文档
 *   reload 语义）；短延迟后页面仍存活（导航被吞）即升级为带唯一
 *   cache-buster 的 replace 重试一次（每次新值替换旧值，地址不累积、不碰
 *   hash 路由），升级前复查挂起条件防误伤刚开始的输入；
 * - 手动「立即刷新」是显式动作：不受自动刷新的一次性闸门（reloadTriggered）、
 *   preloadError 名额或指纹跨页防环约束——自动刷新已尝试过而浏览器未真正
 *   导航时，再次点击必须仍能发起导航（且直接进入带 buster 的高一级尝试）；
 * - 自动刷新防环：页内 reloadTriggered 只触发一次（重复探测/重复通知不再
 *   刷）；preloadError 证据驱动的刷新占用每 tab 一次的 sessionStorage 名额
 *   （storage 不可用一律拒绝自动刷新）；指纹变化驱动的刷新对同一目标入口
 *   每 tab 只自动发起一次（WebView 回吐旧缓存时不无限循环，正常连续部署
 *   的入口不同不受影响；storage 不可用同样拒绝自动刷新，只留横幅与手动）；
 * - vite:preloadError 恒 preventDefault（Vite 6 契约：未取消会重抛底层错误
 *   覆盖提示）；
 * - 卸载后在途探测回包不再推进状态机或触发刷新、升级重试 timer 一并清理
 *   （代际守卫）；
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
  buildVersionReloadUrl,
  claimFingerprintAutoReload,
  detectDocumentProductionEntry,
  initialVersionWatchState,
  isTextInputElement,
  probeAllowed,
  probeLatestIndexEntry,
  shouldReloadNow,
  versionUpdatePending,
  type VersionDeferReason,
  type VersionReloadLocation,
  type VersionWatchState,
} from './version-watch-model.js'

/** 时序参数（集中定义；对象引用共享，测试可临时改写后复原，与 sseClientTimings 同约定）。 */
export const versionWatchTimings = {
  /** visibilitychange / window.focus 触发探测的节流窗口（毫秒）。 */
  visibilityThrottleMs: 5_000,
  /** 页面可见期间的周期探测间隔（毫秒）；hidden 期间跳过。 */
  pollIntervalMs: 60_000,
  /** 刷新升级重试延迟（毫秒）：同址 replace 后页面仍存活视为导航被吞，
   *  升级为带 cache-buster 的重试。 */
  reloadEscalateMs: 2_000,
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
  /** 刷新导航完全接管（缺省 WebView-safe location.replace 阶梯；测试注入）。
   *  注入后不注册升级重试——调用方自持导航语义与计数。 */
  reload?: () => void
  /** 刷新导航的 location（缺省 window.location；测试注入替身观察导航 URL）。 */
  location?: VersionReloadLocation
}

/** 自动刷新挂起原因：null = 未挂起（clean）。 */
export type { VersionDeferReason }

export interface VersionWatcherView {
  /** 探测到待刷新的新版本（最新入口指纹 ≠ 当前页面入口指纹）。 */
  updateAvailable: boolean
  /** 自动刷新挂起原因（草稿事实/焦点保护/弹窗；横幅文案依据；null = 未挂起）。 */
  deferReason: VersionDeferReason
  /** 横幅「立即刷新」动作：显式手动刷新，不受自动闸门/名额/跨页防环约束，
   *  可重复触发（WebView 吞掉前次导航后再次点击仍会发起导航）。 */
  reloadNow: () => void
  /** 弱网等瞬时原因导致懒加载 chunk 失败但服务端指纹未变时为 true（不强刷整页，供用户/lazy 边界重试）。 */
  preloadError: boolean
  /** 用户或 lazy 边界重试时复位瞬态 preloadError 状态。 */
  clearPreloadError: () => void
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
  const [preloadError, setPreloadError] = useState(false)
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
  const preloadProbePendingRef = useRef(false)
  const pushNoticeRef = useRef(store.pushNotice)
  pushNoticeRef.current = store.pushNotice
  const reloadTriggeredRef = useRef(false)
  const probingRef = useRef(false)
  /** 在途探测期间收到的新触发（如 bootId 变化）：完成后立刻补一次，不吞快速触发。 */
  const probeQueuedRef = useRef(false)
  const lastProbeAtRef = useRef<number | null>(null)
  const bootIdSeenRef = useRef<string | null>(null)
  const reloadRef = useRef<(() => void) | undefined>(options.reload)
  reloadRef.current = options.reload
  const locationRef = useRef<VersionReloadLocation | undefined>(options.location)
  locationRef.current = options.location
  /** 已发起的刷新导航次数（自动+手动共用）：≥2 起每次携带新 buster。 */
  const reloadAttemptsRef = useRef(0)
  /** 同址导航被 WebView 吞掉后的升级重试 timer（卸载时清理）。 */
  const escalateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 装配存活标记：卸载后迟到的探测回包不再推进状态机或触发 reload。 */
  const activeRef = useRef(true)
  /** 清理未决的升级重试 timer（新导航尝试或卸载时调用；只触碰 ref，任意渲染代实例等价）。 */
  const clearReloadEscalation = useCallback((): void => {
    if (escalateTimerRef.current !== null) {
      clearTimeout(escalateTimerRef.current)
      escalateTimerRef.current = null
    }
  }, [])
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      clearReloadEscalation()
    }
  }, [clearReloadEscalation])

  /**
   * 发起一次刷新导航（WebView-safe）：
   * - 先清理未决的升级重试 timer：新导航（尤其用户手动点击）取代旧尝试，
   *   不得在其之后再追加一条自动导航；
   * - 注入 reload 时完全委托（测试语义）；
   * - 第一次尝试 = 保持 pathname/query/hash 的干净同址 `location.replace()`
   *   （真文档 reload 语义，桌面行为不变、地址不引入参数）；
   * - 此后每次尝试（升级重试或用户再次手动触发）携带唯一 cache-buster，
   *   每次新值替换旧值，地址不累积、不触碰 hash 路由；
   * - 第一次尝试后短延迟内页面仍存活（导航被容器吞掉）且仍待刷新、无本地
   *   交互现场时，自动升级重试一次；之后不再自动升级（防循环，手动始终可用）。
   */
  const issueReloadNavigation = useCallback(function navigate(): void {
    clearReloadEscalation()
    reloadAttemptsRef.current += 1
    const attempt = reloadAttemptsRef.current
    const injected = reloadRef.current
    if (injected !== undefined) {
      injected()
      return
    }
    const loc = locationRef.current ?? (typeof window !== 'undefined' ? window.location : undefined)
    if (loc === undefined) return
    const nonce = attempt === 1 ? null : `${Date.now().toString(36)}-${attempt}`
    loc.replace(buildVersionReloadUrl(loc, nonce))
    if (attempt !== 1) return
    escalateTimerRef.current = setTimeout(() => {
      escalateTimerRef.current = null
      // 导航确实没有发生（页面还活着）：仍待刷新、且挂起条件未在窗口内出现
      // 才升级重试；用户刚开始输入则放弃自动升级，横幅与手动动作保留。
      if (!activeRef.current || !pendingRef.current) return
      if (draftDirtyRef.current || modalOpenRef.current || textFocusRef.current) return
      navigate()
    }, versionWatchTimings.reloadEscalateMs)
  }, [clearReloadEscalation])

  /** 自动刷新一次性闸门：本页生命周期内自动路径只发起一次（防重复探测/通知循环）。 */
  const autoReloadOnce = useCallback((): void => {
    if (reloadTriggeredRef.current) return
    reloadTriggeredRef.current = true
    issueReloadNavigation()
  }, [issueReloadNavigation])

  /** 状态机推进 + pending 变化通知渲染 + clean 时自动刷新判定。 */
  const settle = useCallback((): void => {
    const fingerprintPending = versionUpdatePending(stateRef.current)
    if (fingerprintPending !== pendingRef.current) {
      pendingRef.current = fingerprintPending
      setUpdateAvailable(fingerprintPending)
    }
    if (
      !shouldReloadNow({
        pending: fingerprintPending,
        dirty: draftDirtyRef.current || modalOpenRef.current || textFocusRef.current,
        reloadTriggered: reloadTriggeredRef.current,
      })
    ) {
      return
    }
    // 指纹驱动的自动刷新对同一目标入口每 tab 只发起一次（sessionStorage
    // 名额，跨 tab 不共享）：WebView 对同址导航回吐旧缓存时不再无限循环，
    // 保留横幅与手动动作；连续部署（入口不同）不受影响。storage 不可用
    // 时 fail-closed 拒绝自动刷新（禁 storage 的 WebView + 回吐旧缓存 =
    // 跨页无限刷新），只保留横幅与手动。
    if (claimFingerprintAutoReload(safeSessionStorage(), stateRef.current.latestEntry)) autoReloadOnce()
  }, [autoReloadOnce])

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
        const pending = versionUpdatePending(stateRef.current)
        if (pending) {
          preloadProbePendingRef.current = false
          setPreloadError(false)
        } else if (preloadProbePendingRef.current && !probeQueuedRef.current) {
          // vite:preloadError 触发探测后，/index.html 指纹未变化（或探测失败离线）：
          // 说明是弱网瞬断导致的懒加载 chunk 失败，绝不整页强刷丢失当前会话或草稿，
          // 改为暴露可恢复错误状态与通知供当前 lazy 边界或用户重试。
          preloadProbePendingRef.current = false
          setPreloadError(true)
          pushNoticeRef.current({
            type: 'notification',
            level: 'warning',
            title: 'Failed to load view module',
            body: 'Network connection interrupted while loading a view. Retry when ready; your current session was preserved.',
          })
        }
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
  // 强制挂起）即自动补刷（自动路径一次性闸门防循环）。
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
      //（cancelable: true）。先取消默认行为，再调用 runProbe() 向服务端探测
      // /index.html 指纹——仅当指纹确已变更时才走版本更新逻辑，指纹未变则走
      // 可恢复重试路径，避免弱网瞬断强刷丢失草稿与对话。
      event.preventDefault()
      preloadProbePendingRef.current = true
      void runProbe()
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
  }, [currentEntry, runProbe, issueReloadNavigation, settle])

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
  const clearPreloadError = useCallback((): void => {
    setPreloadError(false)
  }, [])

  return {
    updateAvailable: currentEntry !== null && updateAvailable,
    deferReason: currentEntry !== null ? deferReason : null,
    // 手动动作直发导航：不被自动闸门/名额短路，WebView 吞掉前次导航后
    // 再次点击自动升到带 buster 的尝试。
    reloadNow: issueReloadNavigation,
    preloadError: currentEntry !== null && preloadError,
    clearPreloadError,
  }
}
