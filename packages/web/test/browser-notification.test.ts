/**
 * 浏览器 Notification、Service Worker 注册与页面活跃状态 DOM 边界封装测试
 * （stub 全局 Notification 与 navigator.serviceWorker，happy-dom 提供 window/document）：
 * - 权限读取/请求：宿主无 Notification 如实返回 'unsupported'，不抛出；拿到
 *   granted 时若存在 navigator.serviceWorker 则非阻塞触发 SW 注册；
 * - 投递：权限未授予返回 false；有已激活 SW registration 时优先走
 *   registration.showNotification（含 icon/badge/data.url/clickId，即使桌面
 *   new Notification 构造抛 TypeError 也不受影响）；无已激活 SW 时回退
 *   new Notification；若 new Notification 抛错（Android Chrome 首载 SW 尚未
 *   缓存完成）且存在 getRegistration，异步探测 getRegistration('/') 补发并诚实
 *   同步返回 false；
 * - 点击回传：`helmx:notification-click` 优先命中并一次性清理 clickId 回调，
 *   无回调时仅对 `/#` 开头路径更新 window.location.hash；
 * - sw.js 沙箱行为校验：skipWaiting / clients.claim / notificationclick 同源窗口
 *   优先聚焦并 postMessage，无窗口则 openWindow，恶意跨源相对路径安全回退 `/`；
 * - isPageActive：仅在存在 document、!document.hidden 且 document.hasFocus()
 *   为 true 时返回 true。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const {
  isPageActive,
  readBrowserNotificationPermission,
  registerBrowserNotificationServiceWorker,
  requestBrowserNotificationPermission,
  resetBrowserNotificationServiceWorkerForTest,
  showBrowserNotification,
} = await import('../src/lib/browser-notification.js')

const SW_PATH = fileURLToPath(new URL('../public/sw.js', import.meta.url))

/** 可编程 Notification 替身：静态 permission / requestPermission + 实例记录。 */
interface FakeNotificationInstance {
  title: string
  options: NotificationOptions
  onclick: ((event: Event) => void) | null
}

interface FakeConfig {
  permission: NotificationPermission
  requestOutcome?: NotificationPermission | 'throw'
  constructThrows?: boolean | Error
}

function installFakeNotification(config: FakeConfig): FakeNotificationInstance[] {
  const instances: FakeNotificationInstance[] = []
  class FakeNotification {
    static permission: NotificationPermission = config.permission
    static requestPermission(): Promise<NotificationPermission> {
      if (config.requestOutcome === 'throw') return Promise.reject(new Error('request failed'))
      return Promise.resolve(config.requestOutcome ?? config.permission)
    }
    title: string
    options: NotificationOptions
    onclick: ((event: Event) => void) | null = null
    constructor(title: string, options: NotificationOptions) {
      if (config.constructThrows === true) throw new Error('constructor failed')
      if (config.constructThrows instanceof Error) throw config.constructThrows
      this.title = title
      this.options = options
      instances.push(this)
    }
  }
  ;(globalThis as Record<string, unknown>).Notification = FakeNotification
  return instances
}

/** happy-dom 无 Notification 实现：卸载替身后应如实报 unsupported。 */
function uninstallNotification(): void {
  delete (globalThis as Record<string, unknown>).Notification
}

interface CapturedSwNotification {
  title: string
  options: NotificationOptions & { badge?: string; data?: { url?: string; clickId?: string } }
}

interface FakeServiceWorkerHarness {
  registerCalls: Array<{ scriptUrl: string; options: RegistrationOptions | undefined }>
  getRegistrationCalls: Array<string | undefined>
  shownNotifications: CapturedSwNotification[]
  listenerCounts: { add: number; remove: number; activeMessageListeners: number }
  registration: ServiceWorkerRegistration
  dispatchMessage: (data: unknown) => void
  restore: () => void
}

function installFakeServiceWorker(options: {
  active?: boolean
  registerError?: Error
  getRegistrationResult?: ServiceWorkerRegistration | undefined
  showNotificationBehavior?: 'resolve' | 'reject' | 'throw'
} = {}): FakeServiceWorkerHarness {
  const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
  const registerCalls: Array<{ scriptUrl: string; options: RegistrationOptions | undefined }> = []
  const getRegistrationCalls: Array<string | undefined> = []
  const shownNotifications: CapturedSwNotification[] = []
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const listenerCounts = { add: 0, remove: 0, activeMessageListeners: 0 }

  const registration = {
    active: options.active === false ? null : ({ state: 'activated' } as ServiceWorker),
    showNotification(
      title: string,
      notifOptions: NotificationOptions & { badge?: string; data?: { url?: string; clickId?: string } } = {},
    ): Promise<void> {
      if (options.showNotificationBehavior === 'throw') {
        throw new Error('showNotification sync failed')
      }
      shownNotifications.push({ title, options: notifOptions })
      if (options.showNotificationBehavior === 'reject') {
        return Promise.reject(new Error('showNotification async failed'))
      }
      return Promise.resolve()
    },
  } as unknown as ServiceWorkerRegistration

  const container = {
    register(scriptUrl: string, regOptions?: RegistrationOptions): Promise<ServiceWorkerRegistration> {
      registerCalls.push({ scriptUrl, options: regOptions })
      if (options.registerError !== undefined) return Promise.reject(options.registerError)
      return Promise.resolve(registration)
    },
    getRegistration(clientUrl?: string): Promise<ServiceWorkerRegistration | undefined> {
      getRegistrationCalls.push(clientUrl)
      if (Object.hasOwn(options, 'getRegistrationResult')) {
        return Promise.resolve(options.getRegistrationResult)
      }
      return Promise.resolve(registration)
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type !== 'message') return
      listenerCounts.add += 1
      listeners.add(listener)
      listenerCounts.activeMessageListeners = listeners.size
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type !== 'message') return
      listenerCounts.remove += 1
      listeners.delete(listener)
      listenerCounts.activeMessageListeners = listeners.size
    },
  }

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: container,
  })

  return {
    registerCalls,
    getRegistrationCalls,
    shownNotifications,
    listenerCounts,
    registration,
    dispatchMessage: (data: unknown) => {
      const event = { data } as MessageEvent
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
    restore: () => {
      resetBrowserNotificationServiceWorkerForTest()
      if (originalDesc !== undefined) {
        Object.defineProperty(navigator, 'serviceWorker', originalDesc)
      } else {
        delete (navigator as unknown as Record<string, unknown>).serviceWorker
      }
    },
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('宿主无 Notification API：权限读取与请求均如实返回 unsupported', { timeout: 60_000 }, async () => {
  uninstallNotification()
  assert.equal(readBrowserNotificationPermission(), 'unsupported')
  assert.equal(await requestBrowserNotificationPermission(), 'unsupported')
  assert.equal(showBrowserNotification({ title: 'x' }), false)
})

test('权限读取与请求：default 态请求授予后返回 granted；拒绝返回 denied', { timeout: 60_000 }, async () => {
  const instances = installFakeNotification({ permission: 'default', requestOutcome: 'granted' })
  assert.equal(readBrowserNotificationPermission(), 'default')
  assert.equal(await requestBrowserNotificationPermission(), 'granted')
  assert.equal(instances.length, 0)

  installFakeNotification({ permission: 'denied', requestOutcome: 'denied' })
  assert.equal(await requestBrowserNotificationPermission(), 'denied')
  uninstallNotification()
})

test('请求抛出（旧回调形态返回 undefined / 宿主异常）：回退读取当前权限，不抛出', { timeout: 60_000 }, async () => {
  installFakeNotification({ permission: 'granted', requestOutcome: 'throw' })
  assert.equal(await requestBrowserNotificationPermission(), 'granted')
  uninstallNotification()
})

test('权限未授予时投递返回 false 且不构造通知', { timeout: 60_000 }, () => {
  const instances = installFakeNotification({ permission: 'denied' })
  assert.equal(showBrowserNotification({ title: 'Helmx conversation completed' }), false)
  assert.equal(instances.length, 0)
  uninstallNotification()
})

test('权限授予后无 SW 时回退 new Notification：透传 title/body/tag/icon，onclick 先聚焦窗口再回调', { timeout: 60_000 }, () => {
  resetBrowserNotificationServiceWorkerForTest()
  const instances = installFakeNotification({ permission: 'granted' })
  const clicked: string[] = []
  const focused: boolean[] = []
  const originalFocus = window.focus
  window.focus = () => {
    focused.push(true)
  }
  try {
    const delivered = showBrowserNotification({
      title: 'Helmx conversation completed',
      body: '#2 重构侧栏',
      tag: 'helmx-conv-2',
      onClick: () => clicked.push('navigate'),
    })
    assert.equal(delivered, true)
    assert.equal(instances.length, 1)
    const notification = instances[0]!
    assert.equal(notification.title, 'Helmx conversation completed')
    assert.equal(notification.options.body, '#2 重构侧栏')
    assert.equal(notification.options.tag, 'helmx-conv-2')
    assert.equal(notification.options.icon, '/icon-192.png')
    assert.equal(clicked.length, 0)
    notification.onclick?.({} as Event)
    assert.deepEqual(clicked, ['navigate'])
    assert.deepEqual(focused, [true])
  } finally {
    window.focus = originalFocus
    uninstallNotification()
  }
})

test('通知构造异常且无 SW：返回 false 不抛出（不伪造成功）', { timeout: 60_000 }, () => {
  resetBrowserNotificationServiceWorkerForTest()
  installFakeNotification({ permission: 'granted', constructThrows: true })
  assert.equal(showBrowserNotification({ title: 'x' }), false)
  uninstallNotification()
})

test('Service Worker 幂等注册、并发去重、消息监听去重与测试复位', { timeout: 60_000 }, async () => {
  resetBrowserNotificationServiceWorkerForTest()
  assert.equal(await registerBrowserNotificationServiceWorker(), null)

  const sw = installFakeServiceWorker()
  try {
    const [reg1, reg2] = await Promise.all([
      registerBrowserNotificationServiceWorker(),
      registerBrowserNotificationServiceWorker(),
    ])
    const reg3 = await registerBrowserNotificationServiceWorker()
    assert.equal(reg1, sw.registration)
    assert.equal(reg2, sw.registration)
    assert.equal(reg3, sw.registration)
    assert.equal(sw.registerCalls.length, 1)
    assert.deepEqual(sw.registerCalls[0], { scriptUrl: '/sw.js', options: { scope: '/' } })
    assert.equal(sw.listenerCounts.add, 1)
    assert.equal(sw.listenerCounts.activeMessageListeners, 1)

    resetBrowserNotificationServiceWorkerForTest()
    assert.equal(sw.listenerCounts.remove, 1)
    assert.equal(sw.listenerCounts.activeMessageListeners, 0)
  } finally {
    sw.restore()
  }
})

test('Service Worker 注册失败（非安全上下文 / 网络错误）：静默降级返回 null 且允许后续重试', { timeout: 60_000 }, async () => {
  const failingSw = installFakeServiceWorker({ registerError: new DOMException('Insecure context', 'SecurityError') })
  try {
    const reg = await registerBrowserNotificationServiceWorker()
    assert.equal(reg, null)
    assert.equal(failingSw.registerCalls.length, 1)
  } finally {
    failingSw.restore()
  }

  const healthySw = installFakeServiceWorker()
  try {
    const reg = await registerBrowserNotificationServiceWorker()
    assert.equal(reg, healthySw.registration)
  } finally {
    healthySw.restore()
  }
})

test('SW 激活态通过 registration.showNotification 投递（兼容 Android Chrome 禁止 new Notification），点击消息触发一次 onClick 后清理', { timeout: 60_000 }, async () => {
  const sw = installFakeServiceWorker({ active: true })
  installFakeNotification({
    permission: 'granted',
    constructThrows: new TypeError('Illegal constructor'),
  })
  try {
    const reg = await registerBrowserNotificationServiceWorker()
    assert.equal(reg, sw.registration)

    let clickCount = 0
    const delivered = showBrowserNotification({
      title: 'Helmx conversation completed',
      body: '#42 PWA 通知链路',
      tag: 'helmx-conv-42',
      url: '/#/c/42',
      onClick: () => {
        clickCount += 1
      },
    })
    assert.equal(delivered, true)
    assert.equal(sw.shownNotifications.length, 1)
    const sent = sw.shownNotifications[0]!
    assert.equal(sent.title, 'Helmx conversation completed')
    assert.equal(sent.options.body, '#42 PWA 通知链路')
    assert.equal(sent.options.tag, 'helmx-conv-42')
    assert.equal(sent.options.icon, '/icon-192.png')
    assert.equal(sent.options.badge, '/notification-badge-96.png')
    assert.equal(sent.options.data?.url, '/#/c/42')
    const clickId = sent.options.data?.clickId
    assert.ok(typeof clickId === 'string' && clickId.length > 0)

    // 首次点击命中并清理回调
    sw.dispatchMessage({ type: 'helmx:notification-click', url: '/#/c/42', tag: 'helmx-conv-42', clickId })
    assert.equal(clickCount, 1)

    // 同一 clickId 再次收到消息不再重复调用原回调
    sw.dispatchMessage({ type: 'helmx:notification-click', url: '/#/c/42', tag: 'helmx-conv-42', clickId })
    assert.equal(clickCount, 1)
  } finally {
    uninstallNotification()
    sw.restore()
  }
})

test('helmx:notification-click 无匹配回调时：仅对 /# 开头相对路径更新 window.location.hash', { timeout: 60_000 }, async () => {
  const sw = installFakeServiceWorker({ active: true })
  const originalHash = window.location.hash
  try {
    window.location.hash = '#/settings/profiles'
    await registerBrowserNotificationServiceWorker()

    sw.dispatchMessage({ type: 'helmx:notification-click', url: '/#/c/99', tag: 'helmx-conv-99' })
    assert.equal(window.location.hash, '#/c/99')

    // 忽略非 /# 开头或外部路径
    sw.dispatchMessage({ type: 'helmx:notification-click', url: 'https://evil.example/#/c/1' })
    assert.equal(window.location.hash, '#/c/99')

    sw.dispatchMessage({ type: 'helmx:notification-click', url: '/api/health' })
    assert.equal(window.location.hash, '#/c/99')

    // 无关消息类型忽略
    sw.dispatchMessage({ type: 'other:event', url: '/#/c/1' })
    assert.equal(window.location.hash, '#/c/99')
  } finally {
    window.location.hash = originalHash
    sw.restore()
  }
})

test('SW showNotification 异常或异步失败时清理 handler；超上限按 FIFO 淘汰最旧 handler', { timeout: 60_000 }, async () => {
  // 1) 同步抛出返回 false 且不残留 handler
  const throwingSw = installFakeServiceWorker({ active: true, showNotificationBehavior: 'throw' })
  installFakeNotification({ permission: 'granted', constructThrows: true })
  try {
    await registerBrowserNotificationServiceWorker()
    let clicked = false
    const delivered = showBrowserNotification({
      title: 'x',
      onClick: () => {
        clicked = true
      },
    })
    assert.equal(delivered, false)
    throwingSw.dispatchMessage({ type: 'helmx:notification-click', clickId: 'helmx-click-1', url: '/' })
    assert.equal(clicked, false)
  } finally {
    uninstallNotification()
    throwingSw.restore()
  }

  // 2) 异步拒绝会清理 handler
  const rejectingSw = installFakeServiceWorker({ active: true, showNotificationBehavior: 'reject' })
  installFakeNotification({ permission: 'granted', constructThrows: true })
  try {
    await registerBrowserNotificationServiceWorker()
    let clicked = false
    const delivered = showBrowserNotification({
      title: 'x',
      onClick: () => {
        clicked = true
      },
    })
    assert.equal(delivered, true)
    const clickId = rejectingSw.shownNotifications[0]!.options.data?.clickId
    await flushMicrotasks()
    rejectingSw.dispatchMessage({ type: 'helmx:notification-click', clickId, url: '/' })
    assert.equal(clicked, false)
  } finally {
    uninstallNotification()
    rejectingSw.restore()
  }

  // 3) 超过 100 条上限时淘汰最旧 clickId，保留最新
  const capSw = installFakeServiceWorker({ active: true })
  installFakeNotification({ permission: 'granted' })
  try {
    await registerBrowserNotificationServiceWorker()
    const fired: number[] = []
    for (let i = 1; i <= 105; i += 1) {
      showBrowserNotification({
        title: `n-${i}`,
        url: `/#/c/${i}`,
        onClick: () => fired.push(i),
      })
    }
    const oldestId = capSw.shownNotifications[0]!.options.data?.clickId
    const newestId = capSw.shownNotifications[104]!.options.data?.clickId
    capSw.dispatchMessage({ type: 'helmx:notification-click', clickId: oldestId, url: '/' })
    assert.deepEqual(fired, [], '最旧的 handler 应已被淘汰')
    capSw.dispatchMessage({ type: 'helmx:notification-click', clickId: newestId, url: '/#/c/105' })
    assert.deepEqual(fired, [105])
  } finally {
    uninstallNotification()
    capSw.restore()
  }
})

test('Android Chrome 首载未缓存 SW 时 new Notification 抛 TypeError：诚实返回 false，并异步探测 getRegistration("/") 补发', { timeout: 60_000 }, async () => {
  resetBrowserNotificationServiceWorkerForTest()
  const sw = installFakeServiceWorker({ active: true })
  installFakeNotification({
    permission: 'granted',
    constructThrows: new TypeError('Illegal constructor'),
  })
  try {
    let clicked = 0
    const syncDelivered = showBrowserNotification({
      title: '等待你的处理',
      body: '待处理输入/审批：#7 测试',
      tag: 'helmx-conv-7',
      url: '/#/c/7',
      onClick: () => {
        clicked += 1
      },
    })
    assert.equal(syncDelivered, false, '尚未确认经 SW 投递时同步返回值必须诚实为 false')

    await flushMicrotasks()
    assert.deepEqual(sw.getRegistrationCalls, ['/'])
    assert.equal(sw.shownNotifications.length, 1)
    assert.equal(sw.shownNotifications[0]!.options.data?.url, '/#/c/7')
    assert.equal(sw.shownNotifications[0]!.options.badge, '/notification-badge-96.png')

    const clickId = sw.shownNotifications[0]!.options.data?.clickId
    sw.dispatchMessage({ type: 'helmx:notification-click', url: '/#/c/7', tag: 'helmx-conv-7', clickId })
    assert.equal(clicked, 1)

    // 探测已缓存 registration，后续投递直接同步走 SW 并返回 true
    const nextDelivered = showBrowserNotification({
      title: 'Helmx conversation completed',
      body: '#7 测试',
      tag: 'helmx-conv-7',
      url: '/#/c/7',
    })
    assert.equal(nextDelivered, true)
    assert.equal(sw.shownNotifications.length, 2)
  } finally {
    uninstallNotification()
    sw.restore()
  }
})

test('requestBrowserNotificationPermission 在拿到 granted 时自动触发非阻塞 SW 注册', { timeout: 60_000 }, async () => {
  const sw = installFakeServiceWorker({ active: true })
  installFakeNotification({ permission: 'default', requestOutcome: 'granted' })
  try {
    const permission = await requestBrowserNotificationPermission()
    assert.equal(permission, 'granted')
    await flushMicrotasks()
    assert.equal(sw.registerCalls.length, 1)
    assert.deepEqual(sw.registerCalls[0], { scriptUrl: '/sw.js', options: { scope: '/' } })
  } finally {
    uninstallNotification()
    sw.restore()
  }
})

test('public/sw.js 沙箱运行时：生命周期接管、优先聚焦同源窗口并 postMessage、无窗口 openWindow 与跨源拦截', { timeout: 60_000 }, async () => {
  const swCode = readFileSync(SW_PATH, 'utf8')
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  let skipWaitingCalls = 0
  let claimCalls = 0
  let openWindowCalls: string[] = []
  let mockClients: Array<{
    url: string
    focused?: boolean
    visibilityState?: string
    focusCalls: number
    posted: unknown[]
    focus: () => Promise<void>
    postMessage: (msg: unknown) => void
  }> = []

  const fakeSelf = {
    location: { origin: 'https://helmx.example' },
    skipWaiting: () => {
      skipWaitingCalls += 1
      return Promise.resolve()
    },
    clients: {
      claim: () => {
        claimCalls += 1
        return Promise.resolve()
      },
      matchAll: async () => mockClients,
      openWindow: async (href: string) => {
        openWindowCalls.push(href)
        return null
      },
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
  }

  vm.runInNewContext(swCode, { self: fakeSelf, URL })
  assert.equal(listeners.has('fetch'), false, 'sw.js 严禁注册 fetch 监听器')

  const waitForEvent = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = []
    const wrappedEvent = {
      ...event,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    }
    for (const fn of listeners.get(type) ?? []) {
      fn(wrappedEvent)
    }
    await Promise.all(pending)
  }

  await waitForEvent('install', {})
  assert.equal(skipWaitingCalls, 1)

  await waitForEvent('activate', {})
  assert.equal(claimCalls, 1)

  // 1) 存在多个同源窗口时，优先选择 focused 窗口，调用 focus 并 postMessage
  const unfocusedClient = {
    url: 'https://helmx.example/#/settings/profiles',
    focused: false,
    visibilityState: 'hidden',
    focusCalls: 0,
    posted: [] as unknown[],
    focus: async () => {
      unfocusedClient.focusCalls += 1
    },
    postMessage: (msg: unknown) => unfocusedClient.posted.push(msg),
  }
  const focusedClient = {
    url: 'https://helmx.example/#/c/1',
    focused: true,
    visibilityState: 'visible',
    focusCalls: 0,
    posted: [] as unknown[],
    focus: async () => {
      focusedClient.focusCalls += 1
    },
    postMessage: (msg: unknown) => focusedClient.posted.push(msg),
  }
  const foreignClient = {
    url: 'https://other.example/',
    focused: true,
    visibilityState: 'visible',
    focusCalls: 0,
    posted: [] as unknown[],
    focus: async () => {
      foreignClient.focusCalls += 1
    },
    postMessage: (msg: unknown) => foreignClient.posted.push(msg),
  }
  mockClients = [foreignClient, unfocusedClient, focusedClient]

  let closedCount = 0
  await waitForEvent('notificationclick', {
    notification: {
      tag: 'helmx-conv-12',
      data: { url: '/#/c/12', clickId: 'c-1' },
      close: () => {
        closedCount += 1
      },
    },
  })
  assert.equal(closedCount, 1)
  assert.equal(foreignClient.posted.length, 0)
  assert.equal(unfocusedClient.posted.length, 0)
  assert.equal(focusedClient.focusCalls, 1)
  assert.deepEqual(structuredClone(focusedClient.posted), [
    { type: 'helmx:notification-click', url: '/#/c/12', tag: 'helmx-conv-12', clickId: 'c-1' },
  ])

  // 2) 恶意 URL 校（协议相对 //、反斜杠 /\、绝对外域）：统一降级回 '/'
  focusedClient.posted.length = 0
  for (const unsafeUrl of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/#/c/1']) {
    await waitForEvent('notificationclick', {
      notification: {
        tag: 'helmx-conv-1',
        data: { url: unsafeUrl, clickId: 'c-2' },
        close: () => {},
      },
    })
  }
  assert.deepEqual(
    focusedClient.posted.map((m) => (m as { url: string }).url),
    ['/', '/', '/'],
  )

  // 3) 无已打开同源窗口时调用 openWindow
  mockClients = [foreignClient]
  openWindowCalls = []
  await waitForEvent('notificationclick', {
    notification: {
      tag: 'helmx-conv-55',
      data: { url: '/#/c/55', clickId: 'c-3' },
      close: () => {},
    },
  })
  assert.deepEqual(openWindowCalls, ['https://helmx.example/#/c/55'])
})

test('isPageActive：仅在页面可见且窗口聚焦时返回 true；无 document 或缺 hasFocus 返回 false', { timeout: 60_000 }, () => {
  const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = document.hasFocus
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  }
  try {
    setHidden(false)
    document.hasFocus = () => true
    assert.equal(isPageActive(), true)

    setHidden(true)
    document.hasFocus = () => true
    assert.equal(isPageActive(), false)

    setHidden(false)
    document.hasFocus = () => false
    assert.equal(isPageActive(), false)

    setHidden(true)
    document.hasFocus = () => false
    assert.equal(isPageActive(), false)

    Object.defineProperty(document, 'hasFocus', { configurable: true, value: undefined })
    assert.equal(isPageActive(), false)
  } finally {
    if (originalHiddenDescriptor !== undefined) {
      Object.defineProperty(document, 'hidden', originalHiddenDescriptor)
    } else {
      delete (document as unknown as Record<string, unknown>).hidden
    }
    Object.defineProperty(document, 'hasFocus', { configurable: true, writable: true, value: originalHasFocus })
  }

  const originalDocDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined })
    assert.equal(isPageActive(), false)
  } finally {
    if (originalDocDescriptor !== undefined) {
      Object.defineProperty(globalThis, 'document', originalDocDescriptor)
    }
  }
})
