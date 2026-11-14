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
