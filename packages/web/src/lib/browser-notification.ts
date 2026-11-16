/**
 * 浏览器 Notification API 与 Service Worker 通知边界封装：
 * 全 Web 应用仅此模块触碰全局 Notification 与 navigator.serviceWorker。
 * 偏好与状态机在 store / quiet-notify-model，便于在 happy-dom 下测试其余层
 * 并在无 Notification / 非安全上下文时如实降级。
 *
 * 桌面端优先使用已激活的 Service Worker（统一点击聚焦与路由语义），未激活或
 * 不可用时回退 `new Notification(...)`；安卓 Chrome（仅允许经 SW showNotification
 * 投递且禁止 `new Notification` 构造）在 SW 尚未缓存完成时异步探测 `getRegistration('/')`
 * 补发，同步返回值始终保持诚实（未确认送达返回 false）。
 */
import type { BrowserNotificationPermission } from '../shell/quiet-notify-model.js'

const SERVICE_WORKER_SCRIPT_URL = '/sw.js'
const SERVICE_WORKER_SCOPE = '/'
const NOTIFICATION_ICON_URL = '/icon-192.png'
const NOTIFICATION_BADGE_URL = '/notification-badge-96.png'
const MAX_CLICK_HANDLERS = 100

let cachedRegistration: ServiceWorkerRegistration | null = null
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
let messageListenerContainer: ServiceWorkerContainer | null = null
let clickIdSeq = 0
let swStateGeneration = 0
const clickHandlers = new Map<string, () => void>()

function getServiceWorkerContainer(): ServiceWorkerContainer | null {
  if (typeof navigator === 'undefined') return null
  try {
    const container = navigator.serviceWorker
    if (container == null || typeof container !== 'object') return null
    return container
  } catch {
    return null
  }
}

function navigateToHashUrl(url: unknown): void {
  if (typeof url !== 'string' || !url.startsWith('/#') || typeof window === 'undefined') return
  const nextHash = url.slice(1)
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash
  }
}

function handleServiceWorkerMessage(event: Event): void {
  const data = (event as MessageEvent<unknown>).data
  if (typeof data !== 'object' || data === null) return
  const payload = data as { type?: unknown; url?: unknown; clickId?: unknown }
  if (payload.type !== 'helm:notification-click') return

  const clickId = typeof payload.clickId === 'string' && payload.clickId !== '' ? payload.clickId : undefined
  const handler = clickId !== undefined ? clickHandlers.get(clickId) : undefined
  if (clickId !== undefined) {
    clickHandlers.delete(clickId)
  }
  if (handler !== undefined) {
    handler()
    return
  }
  navigateToHashUrl(payload.url)
}

function ensureServiceWorkerMessageListener(container: ServiceWorkerContainer): void {
  if (messageListenerContainer === container) return
  if (messageListenerContainer !== null && typeof messageListenerContainer.removeEventListener === 'function') {
    try {
      messageListenerContainer.removeEventListener('message', handleServiceWorkerMessage)
    } catch {
      // 忽略旧容器解绑异常
    }
  }
  if (typeof container.addEventListener !== 'function') return
  try {
    container.addEventListener('message', handleServiceWorkerMessage)
    messageListenerContainer = container
  } catch {
    // 忽略监听器注册失败
  }
}

function registerClickHandler(onClick: () => void): string {
  const clickId = `helm-click-${++clickIdSeq}`
  clickHandlers.set(clickId, onClick)
  while (clickHandlers.size > MAX_CLICK_HANDLERS) {
    const oldestKey = clickHandlers.keys().next().value
    if (oldestKey === undefined) break
    clickHandlers.delete(oldestKey)
  }
  return clickId
}

function showViaServiceWorkerRegistration(
  reg: ServiceWorkerRegistration,
  request: BrowserNotificationRequest,
): boolean {
  if (reg.active == null || typeof reg.showNotification !== 'function') return false
  const container = getServiceWorkerContainer()
  if (container !== null) ensureServiceWorkerMessageListener(container)

  const clickId = request.onClick !== undefined ? registerClickHandler(request.onClick) : undefined
  const data: { url: string; clickId?: string } = {
    url: request.url ?? '/',
    ...(clickId !== undefined ? { clickId } : {}),
  }

  try {
    const pending = reg.showNotification(request.title, {
      body: request.body,
      tag: request.tag,
      icon: NOTIFICATION_ICON_URL,
      badge: NOTIFICATION_BADGE_URL,
      data,
    })
    if (pending !== undefined && typeof (pending as Promise<unknown>).catch === 'function') {
      void (pending as Promise<unknown>).catch(() => {
        if (clickId !== undefined) clickHandlers.delete(clickId)
      })
    }
    return true
  } catch {
    if (clickId !== undefined) clickHandlers.delete(clickId)
    return false
  }
}

async function fallbackViaExistingServiceWorkerRegistration(
  request: BrowserNotificationRequest,
  generation: number,
): Promise<void> {
  const container = getServiceWorkerContainer()
  if (container === null || typeof container.getRegistration !== 'function') return
  try {
    let reg = await container.getRegistration(SERVICE_WORKER_SCOPE)
    if (generation !== swStateGeneration) return
    if ((reg == null || reg.active == null) && container.ready != null) {
      reg = await container.ready
      if (generation !== swStateGeneration) return
    }
    if (reg == null) return
    cachedRegistration = reg
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    showViaServiceWorkerRegistration(reg, request)
  } catch {
    // 非安全上下文或容器异常静默降级
  }
}

/**
 * 幂等注册零缓存 Service Worker（/sw.js, scope '/'）并挂载单次 message 监听器。
 * 非安全上下文、不支持或浏览器注册失败时静默降级返回 null。
 */
export async function registerBrowserNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const container = getServiceWorkerContainer()
  if (container === null || typeof container.register !== 'function') return null
  ensureServiceWorkerMessageListener(container)

  if (cachedRegistration !== null) return cachedRegistration
  if (registrationPromise !== null) return registrationPromise

  const generation = swStateGeneration
  let task: Promise<ServiceWorkerRegistration | null> | null = null
  task = (async () => {
    try {
      const reg = await container.register(SERVICE_WORKER_SCRIPT_URL, { scope: SERVICE_WORKER_SCOPE })
      if (generation !== swStateGeneration) return null
      cachedRegistration = reg ?? null
      return cachedRegistration
    } catch {
      return null
    } finally {
      if (generation === swStateGeneration && registrationPromise === task) {
        registrationPromise = null
      }
    }
  })()

  registrationPromise = task
  return task
}

/** 供单元测试重置模块级 Service Worker 缓存、在途 Promise、click handler 与事件监听。 */
export function resetBrowserNotificationServiceWorkerForTest(): void {
  swStateGeneration += 1
  cachedRegistration = null
  registrationPromise = null
  clickHandlers.clear()
  clickIdSeq = 0
  if (messageListenerContainer !== null && typeof messageListenerContainer.removeEventListener === 'function') {
    try {
      messageListenerContainer.removeEventListener('message', handleServiceWorkerMessage)
    } catch {
      // 忽略清理期间测试替身抛错
    }
  }
  messageListenerContainer = null
}

/** 读取当前通知权限；宿主无 Notification API 返回 'unsupported'。 */
export function readBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * 判定当前页面是否处于前台活跃且聚焦态：
 * - 无 document（非 DOM/SSR 环境）返回 false；
 * - 否则要求页面未隐藏（!document.hidden）且窗口聚焦（document.hasFocus()）。
 * 供前台自动清未读（仅活跃时清）与后台通知投递（!isPageActive() 时投递）共用。
 */
export function isPageActive(): boolean {
  if (typeof document === 'undefined') return false
  return !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : false)
}

/**
 * 请求通知权限（必须由用户手势触发，如开关点击）：返回最终权限。旧回调
 * 形态（返回 undefined）回退读取当前权限；宿主不支持返回 'unsupported'。
 * 拿到 granted 时若尚未缓存 SW registration，非阻塞触发注册以保障移动浏览器投递。
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  let permission: BrowserNotificationPermission
  try {
    const outcome = await Notification.requestPermission()
    permission = outcome ?? readBrowserNotificationPermission()
  } catch {
    permission = readBrowserNotificationPermission()
  }
  if (
    permission === 'granted' &&
    cachedRegistration === null &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  ) {
    void registerBrowserNotificationServiceWorker()
  }
  return permission
}

export interface BrowserNotificationRequest {
  title: string
  body?: string
  /** 同 tag 的新通知替换旧通知（避免堆积）。 */
  tag?: string
  /** 点击通知后默认导航的同源相对路径（如 `/#/c/123`）。 */
  url?: string
  onClick?: () => void
}

/** 投递一条浏览器通知；确认发起投递返回 true，未授权或未确认送达返回 false。 */
export function showBrowserNotification(request: BrowserNotificationRequest): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false

  if (
    cachedRegistration !== null &&
    cachedRegistration.active != null &&
    typeof cachedRegistration.showNotification === 'function'
  ) {
    return showViaServiceWorkerRegistration(cachedRegistration, request)
  }

  try {
    const notification = new Notification(request.title, {
      body: request.body,
      tag: request.tag,
      icon: NOTIFICATION_ICON_URL,
    })
    const onClick = request.onClick
    if (onClick !== undefined) {
      notification.onclick = () => {
        window.focus()
        onClick()
      }
    } else if (typeof request.url === 'string' && request.url.startsWith('/#')) {
      const targetUrl = request.url
      notification.onclick = () => {
        window.focus()
        navigateToHashUrl(targetUrl)
      }
    }
    return true
  } catch {
    const container = getServiceWorkerContainer()
    if (container !== null && typeof container.getRegistration === 'function') {
      void fallbackViaExistingServiceWorkerRegistration(request, swStateGeneration)
    }
    return false
  }
}
