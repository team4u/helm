/**
 * 定位滚动的最终锚点校准（纯 DOM 模块，零 React / 零全局状态依赖）。
 *
 * 背景：时间线历史行渲染隔离（content-visibility）使滚动路径上邻行的估高在
 * 平滑滚动动画期间与收敛后陆续转为真实高度（实测动画可长达 2.6s，收敛后数百
 * 毫秒仍可能晚发位移；解除目标行隔离还会引发 end-scrolled 容器再贴底滚动），
 * smooth 目的地按调用瞬间布局结算且滚动容器 overflow-anchor:none 无补偿，
 * 目标会偏出视口。
 *
 * 机制：有界双稳定侦测——逐帧观察滚动位置与目标偏差，连续 N 帧均不变（平台）
 * 即校正一次并重置现望；对齐后持续现望一个静默期，期间再位移则再次校正；
 * 校正次数与帧数均有硬上界，不无限追踪、不 sleep 猜测。用户主动输入
 * （wheel/pointer/touch/keydown）立即取消。返回 cancel：立即取消待执行帧并
 * 解除全部监听，由调用方在新定位/换会话/卸载时显式调用（后台标签页 rAF
 * 暂停时也不残留监听与待执行帧）。
 *
 * 同模块还提供 `calibrateInitialStickToBottom`：一次性初始贴底校准（见该函数
 * 注释），与锚点校准共用「被动输入监听 + 有界帧循环 + cancel 句柄」的生命
 * 周期形态，不引入第二套通用滚动框架。
 */

/** 目标与滚动容器的对齐偏差口径：start = 顶对顶；center = 目标中心对容器中心。 */
export type AnchorAlignment = 'start' | 'center'

const ANCHOR_TOLERANCE_PX = 2
/** 平台判定：滚动位置与目标偏差连续 N 帧均不变。 */
const ANCHOR_SETTLE_STABLE_FRAMES = 3
/** 对齐后的静默现望期（帧）：实测收敛后数百毫秒仍可能出现估高转真实高度的晚发位移。 */
const ANCHOR_WATCH_GRACE_FRAMES = 45
const ANCHOR_SETTLE_MAX_FRAMES = 450
const ANCHOR_MAX_CORRECTIONS = 3

const USER_CANCEL_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const

/**
 * 对 `scroller` 内的 `target` 启动最终锚点校准；返回 cancel（幂等）。
 * 仅供刚发起 `scrollIntoView({ behavior: 'smooth' })` 之后调用。
 */
export function calibrateAnchorAfterSmoothScroll(opts: {
  scroller: HTMLElement
  target: HTMLElement
  alignment: AnchorAlignment
}): () => void {
  const { scroller, target, alignment } = opts
  let finished = false
  let corrections = 0
  let frame = 0
  const finish = (): void => {
    if (finished) return
    finished = true
    if (frame !== 0) cancelAnimationFrame(frame)
    for (const type of USER_CANCEL_EVENTS) scroller.removeEventListener(type, finish)
  }
  for (const type of USER_CANCEL_EVENTS) scroller.addEventListener(type, finish, { passive: true })

  const measureDelta = (): number => {
    const t = target.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    return alignment === 'center' ? (t.top + t.height / 2) - (s.top + s.height / 2) : t.top - s.top
  }

  let lastTop = scroller.scrollTop
  let lastDelta = Number.NaN
  let quietFrames = 0
  let frames = 0
  const tick = (): void => {
    if (finished) return
    if (!target.isConnected) {
      finish()
      return
    }
    frames += 1
    if (frames > ANCHOR_SETTLE_MAX_FRAMES) {
      finish()
      return
    }
    const top = scroller.scrollTop
    const delta = measureDelta()
    const settled = top === lastTop && Math.abs(delta - lastDelta) <= 1
    lastTop = top
    lastDelta = delta
    quietFrames = settled ? quietFrames + 1 : 0
    if (quietFrames >= ANCHOR_SETTLE_STABLE_FRAMES) {
      if (Math.abs(delta) > ANCHOR_TOLERANCE_PX) {
        if (corrections >= ANCHOR_MAX_CORRECTIONS) {
          finish()
          return
        }
        corrections += 1
        quietFrames = 0
        scroller.scrollTop += delta
      } else if (quietFrames >= ANCHOR_WATCH_GRACE_FRAMES) {
        finish()
      }
    }
    if (!finished) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return finish
}

// ---------------------------------------------------------------------------
// 初始贴底校准
// ---------------------------------------------------------------------------

/** 距底容差（px）：|scrollHeight - scrollTop - clientHeight| 不超过该值视为已贴底。 */
const BOTTOM_TOLERANCE_PX = 1
/** 平台判定：scrollTop 与 scrollHeight 连续 N 帧均不变（高度在变 = 仍在收敛）。 */
const BOTTOM_STABLE_FRAMES = 3
/** 已贴底后的静默现望期（帧）：估高转真实高度的晚发位移在此期间仍被纠正。 */
const BOTTOM_WATCH_GRACE_FRAMES = 48
/** 硬上界：窗口总帧数；连续高度变化只能耗尽上界，绝不无限 rAF。 */
const BOTTOM_MAX_FRAMES = 300
/** 硬上界：贴底校正总次数。 */
const BOTTOM_MAX_CORRECTIONS = 8
/** 视为用户接管滚动的方向键（含向下键：窗口期内任何接管都不再属于初始贴底）。 */
const SCROLL_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/** 初始贴底窗口的结束原因：自然收敛 / 用户物理输入接管 / 调用方显式 cancel。 */
export type InitialBottomEndReason = 'settled' | 'user-input' | 'cancelled'

/**
 * 一次性初始贴底校准。
 *
 * 背景：历史行渲染隔离（content-visibility 估高）使首次 `scrollTop =
 * scrollHeight` 按估算总高落位；随后视口附近行转真实布局，总高变化导致初始
 * 位置悬在半空。会话空闲（idle）时贴底 ResizeObserver 保护（不扰动用户历史
 * 浏览）使该误差无人追赶。
 *
 * 机制：有界帧循环，逐帧度量「距底距离 + 总高」。平台（两者连续 N 帧不变）
 * 且距底超容差时校正一次（`scrollTop = scrollHeight`，浏览器按上限截断）；
 * 已贴底后继续现望一个静默期，晚发位移同样纠正。帧数与校正次数均有硬上界，
 * 连续高度变化只会耗尽上界。用户物理输入（wheel / pointerdown / touchstart /
 * 滚动方向键）立即结束并上报 `'user-input'`，由调用方同步释放贴底吸附——
 * 不等 scroll 事件（scroll 异步派发，流式增长的跟底写入可能先于它到达）。
 *
 * 返回 cancel（幂等）：取消待执行帧并解除监听，以 `'cancelled'` 结束；调用方
 * 换会话 / 卸载 / 被显式定位取代时使用，可与自然结束区分以决定是否允许重启。
 */
export function calibrateInitialStickToBottom(opts: {
  scroller: HTMLElement
  /** 窗口以任何方式结束恰好触发一次。`'user-input'` 时调用方须同步释放贴底。 */
  onEnd?: (reason: InitialBottomEndReason) => void
}): () => void {
  const { scroller, onEnd } = opts
  let finished = false
  let frame = 0
  const finish = (reason: InitialBottomEndReason): void => {
    if (finished) return
    finished = true
    if (frame !== 0) cancelAnimationFrame(frame)
    for (const type of USER_CANCEL_EVENTS) {
      if (type !== 'keydown') scroller.removeEventListener(type, onPhysical)
    }
    scroller.removeEventListener('keydown', onKeyDown)
    onEnd?.(reason)
  }
  const onPhysical = (): void => finish('user-input')
  const onKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_NAV_KEYS.has(event.key)) finish('user-input')
  }
  for (const type of USER_CANCEL_EVENTS) {
    if (type !== 'keydown') scroller.addEventListener(type, onPhysical, { passive: true })
  }
  scroller.addEventListener('keydown', onKeyDown, { passive: true })

  let corrections = 0
  let quietFrames = 0
  let frames = 0
  let lastTop = Number.NaN
  let lastHeight = Number.NaN
  const tick = (): void => {
    if (finished) return
    // 滚动容器已脱离文档（组件卸载）：按自然结束处理（effect cleanup 的 cancel
    // 随后到达时幂等无操作）。
    if (!scroller.isConnected) {
      finish('settled')
      return
    }
    frames += 1
    if (frames > BOTTOM_MAX_FRAMES) {
      finish('settled')
      return
    }
    const top = scroller.scrollTop
    const height = scroller.scrollHeight
    const distanceFromBottom = height - top - scroller.clientHeight
    const settled = top === lastTop && height === lastHeight
    lastTop = top
    lastHeight = height
    quietFrames = settled ? quietFrames + 1 : 0
    if (quietFrames >= BOTTOM_STABLE_FRAMES) {
      if (distanceFromBottom > BOTTOM_TOLERANCE_PX) {
        if (corrections >= BOTTOM_MAX_CORRECTIONS) {
          finish('settled')
          return
        }
        corrections += 1
        quietFrames = 0
        // 浏览器把超界写入截断到 scrollHeight - clientHeight；回读同步基线。
        scroller.scrollTop = scroller.scrollHeight
        lastTop = scroller.scrollTop
      } else if (quietFrames >= BOTTOM_WATCH_GRACE_FRAMES) {
        finish('settled')
        return
      }
    }
    if (!finished) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => finish('cancelled')
}
