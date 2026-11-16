import { useEffect, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'

/**
 * 移动端侧栏滑动手势（方案 A）：
 * - 打开：会话底部 composer-shell 区域右滑（水平位移 ≥ 56px 且明显水平主导）；
 * - 关闭：侧栏抽屉（.helm-sidebar）或遮罩（.sidebar-backdrop）左滑；
 * - 左上角汉堡按钮（App.tsx .mobile-nav-toggle）保留为显式兜底入口。
 *
 * 手势以事件委托挂在应用壳根节点（App.tsx 展开返回的 handlers），避免把
 * 开关回调经 ConversationPane/AgentStandbyPane 逐层下钻；终态判定仍在 touchend，
 * 但真机上水平滑动会被浏览器接管（Android Chrome overscroll 历史导航、iOS 边缘
 * 橡皮筋），触摸流被掐断为 touchcancel、touchend 永不派发——因此另在原生
 * window touchmove（passive: false）里先做轴锁，横轴锁定后 preventDefault 接管，
 * 保住触摸流直到 touchend；锁定前与纵向滚动全程不 preventDefault，点击、聚焦、
 * 文本选择与纵向滚动不被阻断。桌面鼠标不产生 touch 事件，天然不受影响。侧栏
 * 开合仍归 App.tsx 的 sidebarOpen 唯一状态（不进 URL、不建平行导航状态），本
 * 模块只提供手势触发通道。
 */

/** 触发阈值：约 56px 水平位移（明显低于常见系统边缘手势距离，高于误触抖动）。 */
export const SWIPE_TRIGGER_PX = 56

/** 轴主导比：水平位移需至少 2 倍于垂直位移，与纵向滚动明确区分。 */
export const SWIPE_AXIS_RATIO = 2

/** 轴锁阈值：主轴位移达到约 8px 才判定方向——高于手指落点的常见抖动（避免点击
 *  误锁），又远低于 56px 终态阈值，让「是否横滑」尽早定案，抢在浏览器接管
 *  overscroll/历史导航之前 preventDefault。 */
export const SWIPE_AXIS_LOCK_PX = 8

/** 手势禁入目标：交互控件与可选中文本（.selectable 为全站 user-select: text 标记）。
 *  触摸起点落在其上时手势让位，不抢输入框光标、按钮点击与文本选择。 */
const SWIPE_BLOCKED_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a',
  'summary',
  'label',
  '[role="button"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[draggable="true"]',
  '.selectable',
].join(',')

export type SidebarSwipeIntent = 'open' | 'close'

/** 触摸点最小契约（Touch 的结构子集；测试可用普通对象/数组模拟）。 */
export interface TouchLike {
  identifier: number
  clientX: number
  clientY: number
}

export type SidebarSwipeMatchMedia = (query: string) => { matches: boolean }

/** 手势环境门禁：移动端/粗指针，或已进入侧栏抽屉断点（≤860px）。
 *  拆成两条独立查询做 OR（部分引擎与测试环境不支持逗号 OR 媒体查询）。 */
export function isSidebarSwipeEnvironment(win?: { matchMedia: SidebarSwipeMatchMedia }): boolean {
  const probe = win ?? (typeof window !== 'undefined' ? window : undefined)
  if (probe === undefined || typeof probe.matchMedia !== 'function') return false
  return probe.matchMedia('(pointer: coarse)').matches || probe.matchMedia('(max-width: 860px)').matches
}

/** 元素自身是否直接持有可见文本（命中即视为文本选择手势面，手势让位；
 *  表单控件的值不是文本节点，不受影响）。 */
function hasOwnText(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i += 1) {
    const node = el.childNodes[i]!
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true
  }
  return false
}

/** 触摸起点是否落在禁入目标上：交互控件/可选中文本/直接文本，或位于横向
 *  滚动容器内（横向位移交给原生滚动；向上扫描止于手势面 composer-shell）。 */
export function isSidebarSwipeBlockedTarget(el: Element | null): boolean {
  if (el === null) return true
  if (el.closest(SWIPE_BLOCKED_SELECTOR) !== null) return true
  if (hasOwnText(el)) return true
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const overflowX = window.getComputedStyle(node).overflowX
    if (overflowX === 'auto' || overflowX === 'scroll') return true
    if (node.classList.contains('composer-shell')) break
  }
  return false
}

/** 触摸起点归属的手势意图：
 *  - open：侧栏关闭时，起点在 composer-shell 内且不在禁入目标上；
 *  - close：侧栏打开时，起点在侧栏抽屉或遮罩内（整面可滑——横向滑动不会触发
 *    行按钮点击，纵向滚动由轴主导比区分，故不套用禁入过滤）；
 *  - null：其余（时间线、遮罩外主舞台、非手势环境等）不构成侧栏手势。 */
export function sidebarSwipeIntentFor(
  target: EventTarget | null,
  options: { sidebarOpen: boolean; environmentEnabled: boolean },
): SidebarSwipeIntent | null {
  if (!options.environmentEnabled || !(target instanceof Element)) return null
  if (options.sidebarOpen) {
    return target.closest('.helm-sidebar, .sidebar-backdrop') !== null ? 'close' : null
  }
  if (target.closest('.composer-shell') === null) return null
  return isSidebarSwipeBlockedTarget(target) ? null : 'open'
}

/** 终态位移判定：沿意图方向位移过阈值且明显水平主导（垂直 ≤ 水平的一半）。 */
export function qualifiesSidebarSwipe(dx: number, dy: number, intent: SidebarSwipeIntent): boolean {
  const forward = intent === 'open' ? dx : -dx
  return forward >= SWIPE_TRIGGER_PX && Math.abs(dy) * SWIPE_AXIS_RATIO <= forward
}

/** 进行中的手势轨迹（ref 持有，不进 React 状态避免重渲染）。
 *  axis 为轴锁状态：null 尚未判定（未达阈值，绝不 preventDefault）；
 *  'horizontal' 已锁横轴（此后原生 touchmove 持续接管）。垂直主导时轨迹
 *  直接清空弃权（等价于第三态 'vertical'，本次触摸不再 preventDefault），
 *  无需把弃权态存进轨迹。 */
export interface SidebarSwipeTrack {
  id: number
  startX: number
  startY: number
  intent: SidebarSwipeIntent
  axis: 'horizontal' | null
}

/** 轴锁判定结果：
 *  - pending：位移未达轴锁阈值，维持现状（不锁轴、不弃权，绝不 preventDefault）；
 *  - locked：水平位移严格大于垂直位移，锁横轴（本次 touchmove 起接管）；
 *  - abandon：垂直位移 ≥ 水平位移，本次触摸是纵向滚动，放弃轨迹交还浏览器。 */
export type SidebarSwipeAxisDecision = 'pending' | 'locked' | 'abandon'

/** touchmove 轴锁步骤（纯函数，不改动轨迹）：以起点为基准比较位移绝对值，
 *  主轴达到 SWIPE_AXIS_LOCK_PX 才判定方向；已锁横轴后不再改判——半途放行会让
 *  浏览器在滑行中接管并掐断触摸流，手势前功尽弃。 */
export function lockSidebarSwipeAxis(track: SidebarSwipeTrack, touch: TouchLike): SidebarSwipeAxisDecision {
  if (track.axis === 'horizontal') return 'locked'
  const dx = Math.abs(touch.clientX - track.startX)
  const dy = Math.abs(touch.clientY - track.startY)
  if (Math.max(dx, dy) < SWIPE_AXIS_LOCK_PX) return 'pending'
  return dx > dy ? 'locked' : 'abandon'
}

/** touchstart 步骤：仅单指建立轨迹（多指捏合等不构成侧栏手势）。 */
export function beginSidebarSwipeTrack(
  touches: ArrayLike<TouchLike>,
  target: EventTarget | null,
  options: { sidebarOpen: boolean; environmentEnabled: boolean },
): SidebarSwipeTrack | null {
  if (touches.length !== 1) return null
  const intent = sidebarSwipeIntentFor(target, options)
  if (intent === null) return null
  const touch = touches[0]!
  return { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, intent, axis: null }
}

/** touchend 步骤：跟踪指位移达标时返回应执行的意图，否则 null。
 *  changedTouches 里没有跟踪指（先抬起的是别的手指）也返回 null。 */
export function finishSidebarSwipeTrack(
  track: SidebarSwipeTrack | null,
  changedTouches: ArrayLike<TouchLike>,
): SidebarSwipeIntent | null {
  if (track === null) return null
  for (let i = 0; i < changedTouches.length; i += 1) {
    const touch = changedTouches[i]!
    if (touch.identifier !== track.id) continue
    return qualifiesSidebarSwipe(touch.clientX - track.startX, touch.clientY - track.startY, track.intent)
      ? track.intent
      : null
  }
  return null
}

/** 供 App.tsx 展开到壳根节点的委托 handlers。 */
export interface SidebarSwipeGestureHandlers {
  onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void
  onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => void
  onTouchCancel: (event: ReactTouchEvent<HTMLElement>) => void
}

/** 侧栏滑动手势 hook：事件委托 + 横轴锁定接管 + 终态判定。
 *  真机上水平滑动会被浏览器接管（Android Chrome overscroll 历史导航、iOS 边缘
 *  橡皮筋），触摸流被掐断为 touchcancel、touchend 永不派发，只在 touchend 判
 *  终态的方案在真机必然失效——因此横轴锁定后必须 preventDefault 接管；锁定前
 *  与纵向滚动全程不 preventDefault，点击、聚焦、文本选择不受影响。 */
export function useSidebarSwipeGesture(options: {
  sidebarOpen: boolean
  onOpenChange: (open: boolean) => void
}): SidebarSwipeGestureHandlers {
  const trackRef = useRef<SidebarSwipeTrack | null>(null)
  // React 合成 onTouchMove 注册的是被动监听、无法带 { passive: false }，其中
  // preventDefault 不生效；接管必须用原生 window 监听（桌面无触摸流时监听
  // 存在但无轨迹直返，开销可忽略）。
  useEffect(() => {
    const onTouchMove = (event: TouchEvent): void => {
      const track = trackRef.current
      if (track === null) return
      for (let i = 0; i < event.changedTouches.length; i += 1) {
        const touch = event.changedTouches[i]!
        if (touch.identifier !== track.id) continue
        const decision = lockSidebarSwipeAxis(track, touch)
        if (decision === 'abandon') {
          // 纵向滚动让位：清空轨迹，本次触摸此后不再 preventDefault。
          trackRef.current = null
          return
        }
        if (decision === 'locked') {
          track.axis = 'horizontal'
          // 锁横轴即接管：阻断历史导航/overscroll，保证后续 touchend 能派发。
          event.preventDefault()
        }
        return
      }
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      window.removeEventListener('touchmove', onTouchMove)
    }
  }, [])
  const onTouchStart = (event: ReactTouchEvent<HTMLElement>): void => {
    trackRef.current = beginSidebarSwipeTrack(event.touches, event.target, {
      sidebarOpen: options.sidebarOpen,
      environmentEnabled: isSidebarSwipeEnvironment(),
    })
  }
  const onTouchEnd = (event: ReactTouchEvent<HTMLElement>): void => {
    const intent = finishSidebarSwipeTrack(trackRef.current, event.changedTouches)
    trackRef.current = null
    if (intent !== null) options.onOpenChange(intent === 'open')
  }
  const onTouchCancel = (): void => {
    trackRef.current = null
  }
  return { onTouchStart, onTouchEnd, onTouchCancel }
}
