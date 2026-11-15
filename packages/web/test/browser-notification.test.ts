/**
 * 浏览器 Notification DOM 边界封装测试（stub 全局 Notification，happy-dom
 * 提供 window/document）：
 * - 权限读取/请求：宿主无 Notification 如实返回 'unsupported'，不抛出；
 * - 投递：权限未授予返回 false；授予后构造通知并透传 title/body/tag，
 *   onclick 先聚焦窗口再回调；构造异常返回 false 不抛出。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const {
  readBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  showBrowserNotification,
} = await import('../src/lib/browser-notification.js')

/** 可编程 Notification 替身：静态 permission / requestPermission + 实例记录。 */
interface FakeNotificationInstance {
  title: string
  options: NotificationOptions
  onclick: ((event: Event) => void) | null
}

interface FakeConfig {
  permission: NotificationPermission
  requestOutcome?: NotificationPermission | 'throw'
  constructThrows?: boolean
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
})

test('请求抛出（旧回调形态返回 undefined / 宿主异常）：回退读取当前权限，不抛出', { timeout: 60_000 }, async () => {
  installFakeNotification({ permission: 'granted', requestOutcome: 'throw' })
  assert.equal(await requestBrowserNotificationPermission(), 'granted')
})

test('权限未授予时投递返回 false 且不构造通知', { timeout: 60_000 }, () => {
  const instances = installFakeNotification({ permission: 'denied' })
  assert.equal(showBrowserNotification({ title: 'Helm 已全部空闲' }), false)
  assert.equal(instances.length, 0)
})

test('权限授予后投递：透传 title/body/tag，onclick 先聚焦窗口再回调', { timeout: 60_000 }, () => {
  const instances = installFakeNotification({ permission: 'granted' })
  const clicked: string[] = []
  const focused: boolean[] = []
  const originalFocus = window.focus
  window.focus = () => {
    focused.push(true)
  }
  try {
    const delivered = showBrowserNotification({
      title: 'Helm 已全部空闲',
      body: '#2 重构侧栏',
      tag: 'helm-quiet',
      onClick: () => clicked.push('navigate'),
    })
    assert.equal(delivered, true)
    assert.equal(instances.length, 1)
    const notification = instances[0]!
    assert.equal(notification.title, 'Helm 已全部空闲')
    assert.equal(notification.options.body, '#2 重构侧栏')
    assert.equal(notification.options.tag, 'helm-quiet')
    assert.equal(clicked.length, 0)
    notification.onclick?.({} as Event)
    assert.deepEqual(clicked, ['navigate'])
    assert.deepEqual(focused, [true])
  } finally {
    window.focus = originalFocus
    uninstallNotification()
  }
})

test('通知构造异常：返回 false 不抛出（不伪造成功）', { timeout: 60_000 }, () => {
  installFakeNotification({ permission: 'granted', constructThrows: true })
  assert.equal(showBrowserNotification({ title: 'x' }), false)
  uninstallNotification()
})
