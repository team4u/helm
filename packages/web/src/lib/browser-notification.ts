/**
 * 浏览器 Notification API 的 DOM 边界封装：全 Web 应用仅此模块触碰全局
 * Notification 对象。偏好与状态机在 store / quiet-notify-model，便于在
 * happy-dom（无 Notification 实现）下测试其余层并如实降级为 'unsupported'。
 *
 * 平台约束如实：无 Service Worker，通知仅在页面保持打开（含后台标签页）时
 * 可投递；权限被浏览器收回时投递返回 false，不抛出、不伪造成功。
 */
import type { BrowserNotificationPermission } from '../shell/quiet-notify-model.js'

/** 读取当前通知权限；宿主无 Notification API 返回 'unsupported'。 */
export function readBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * 请求通知权限（必须由用户手势触发，如开关点击）：返回最终权限。旧回调
 * 形态（返回 undefined）回退读取当前权限；宿主不支持返回 'unsupported'。
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    const outcome = await Notification.requestPermission()
    return outcome ?? readBrowserNotificationPermission()
  } catch {
    return readBrowserNotificationPermission()
  }
}

export interface BrowserNotificationRequest {
  title: string
  body?: string
  /** 同 tag 的新通知替换旧通知（避免堆积）。 */
  tag?: string
  onClick?: () => void
}

/** 投递一条浏览器通知；成功返回 true（权限被收回等失败静默返回 false）。 */
export function showBrowserNotification(request: BrowserNotificationRequest): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  try {
    const notification = new Notification(request.title, {
      body: request.body,
      tag: request.tag,
      icon: '/favicon.svg',
    })
    const onClick = request.onClick
    if (onClick !== undefined) {
      notification.onclick = () => {
        window.focus()
        onClick()
      }
    }
    return true
  } catch {
    return false
  }
}
