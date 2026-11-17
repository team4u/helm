/**
 * Browser Notification API and Service Worker notification boundary wrapper:
 * this is the only module in the whole Web app that touches the global
 * Notification and navigator.serviceWorker. Preferences and the state machine
 * live in store / quiet-notify-model so the remaining layers stay testable
 * under happy-dom and degrade honestly without Notification / in insecure
 * contexts.
 *
 * Desktop prefers the activated Service Worker (unified click-focus and routing
 * semantics) and falls back to `new Notification(...)` when it is inactive or
 * unavailable; Android Chrome (which only allows SW showNotification delivery
 * and forbids the `new Notification` constructor) is probed asynchronously via
 * `getRegistration('/')` for a redelivery while the SW is not cached yet — the
 * synchronous return stays honest either way (false when delivery is
 * unconfirmed).
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
      // Ignore unbind errors from the previous container
    }
  }
  if (typeof container.addEventListener !== 'function') return
  try {
    container.addEventListener('message', handleServiceWorkerMessage)
    messageListenerContainer = container
  } catch {
    // Ignore listener registration failures
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
    // Insecure context or container failure: degrade silently
  }
}

/**
 * Idempotently register the zero-cache Service Worker (/sw.js, scope '/') and
 * mount the single message listener. Degrades silently to null in insecure
 * contexts, when unsupported, or when the browser registration fails.
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

/** Reset module-level Service Worker caches, in-flight promises, click handlers and event listeners for unit tests. */
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
      // Ignore test-stand-in throws during cleanup
    }
  }
  messageListenerContainer = null
}

/** Read the current notification permission; hosts without the Notification API return 'unsupported'. */
export function readBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Whether the current page is foreground-active and focused:
 * - no document (non-DOM/SSR environment) returns false;
 * - otherwise the page must be visible (!document.hidden) and the window
 *   focused (document.hasFocus()).
 * Shared by foreground auto-clearing of unread (clear only while active) and
 * background notification delivery (deliver when !isPageActive()).
 */
export function isPageActive(): boolean {
  if (typeof document === 'undefined') return false
  return !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : false)
}

/**
 * Request notification permission (must be triggered by a user gesture such as
 * a toggle click): returns the final permission. The legacy callback form
 * (returning undefined) falls back to reading the current permission;
 * unsupported hosts return 'unsupported'. On granted, if no SW registration is
 * cached yet, registration is triggered non-blockingly to keep mobile-browser
 * delivery working.
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
  /** A new notification with the same tag replaces the old one (no pile-up). */
  tag?: string
  /** Same-origin relative path navigated to on notification click (e.g. `/#/c/123`). */
  url?: string
  onClick?: () => void
}

/** Deliver one browser notification; returns true once delivery is confirmed as started, false when unauthorized or unconfirmed. */
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
