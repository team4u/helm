/**
 * Helm 零缓存 Service Worker：
 * 仅承担 PWA 安装满足条件、生命周期接管与通知点击路由，不做离线缓存或网络请求拦截，
 * 确保页面版本探测与热更新导航始终直达最新服务端响应。
 */

function resolveSafeRelativeUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/'
  }
  try {
    const parsed = new URL(raw, self.location.origin)
    if (parsed.origin !== self.location.origin) return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  if (notification && typeof notification.close === 'function') {
    notification.close()
  }

  const rawData =
    notification && typeof notification.data === 'object' && notification.data !== null
      ? notification.data
      : {}
  const url = resolveSafeRelativeUrl(rawData.url)
  const tag = typeof notification?.tag === 'string' && notification.tag !== '' ? notification.tag : undefined
  const clickId =
    typeof rawData.clickId === 'string' && rawData.clickId !== '' ? rawData.clickId : undefined

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const sameOriginClients = allClients.filter((client) => {
        try {
          return new URL(client.url).origin === self.location.origin
        } catch {
          return false
        }
      })

      const targetClient =
        sameOriginClients.find((client) => client.focused) ??
        sameOriginClients.find((client) => client.visibilityState === 'visible') ??
        sameOriginClients[0]

      if (targetClient) {
        if (typeof targetClient.focus === 'function') {
          try {
            await targetClient.focus()
          } catch {
            // 部分移动浏览器容器拒绝后台主动聚焦，仍需向已打开窗口派发点击路由消息
          }
        }
        targetClient.postMessage({
          type: 'helm:notification-click',
          url,
          tag,
          clickId,
        })
        return
      }

      if (typeof self.clients.openWindow === 'function') {
        await self.clients.openWindow(new URL(url, self.location.origin).href)
      }
    })(),
  )
})
