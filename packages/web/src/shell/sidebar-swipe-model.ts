import { useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'

/**
 * 移动端侧栏滑动手势（方案 A）：
 * - 打开：会话底部 composer-shell 区域右滑（水平位移 ≥ 56px 且明显水平主导）；
 * - 关闭：侧栏抽屉（.helm-sidebar）或遮罩（.sidebar-backdrop）左滑；
 * - 左上角汉堡按钮（App.tsx .mobile-nav-toggle）保留为显式兜底入口。
 *
 * 手势以事件委托挂在应用壳根节点（App.tsx 展开返回的 handlers），避免把
 * 开关回调经 ConversationPane/AgentStandbyPane 逐层下钻；只在 touchend 做终态
 * 判定、从不 preventDefault，纵向滚动、输入与原生控件交互全程不被阻断；桌面
 * 鼠标不产生 touch 事件，天然不受影响。侧栏开合仍归 App.tsx 的 sidebarOpen
 * 唯一状态（不进 URL、不建平行导航状态），本模块只提供手势触发通道。
 */

/** 触发阈值：约 56px 水平位移（明显低于常见系统边缘手势距离，高于误触抖动）。 */
export const SWIPE_TRIGGER_PX = 56

/** 轴主导比：水平位移需至少 2 倍于垂直位移，与纵向滚动明确区分。 */
export const SWIPE_AXIS_RATIO = 2

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

/** 进行中的手势轨迹（ref 持有，不进 React 状态避免重渲染）。 */
export interface SidebarSwipeTrack {
  id: number
  startX: number
  startY: number
  intent: SidebarSwipeIntent
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
  return { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, intent }
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

/** 侧栏滑动手势 hook：事件委托 + 终态判定，不阻断任何原生触摸行为。 */
export function useSidebarSwipeGesture(options: {
  sidebarOpen: boolean
  onOpenChange: (open: boolean) => void
}): SidebarSwipeGestureHandlers {
  const trackRef = useRef<SidebarSwipeTrack | null>(null)
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
