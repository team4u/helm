/**
 * Web shell 展示文案双语（en/zh-CN）行为测试——真实 HelmStoreProvider：
 * - 资产/节点加载失败 toast 与认证错误随当前 locale（helm:locale 持久化偏好，
 *   协议 createLocaleTranslator 语义），错误协议文本（HTTP error message）原样不译；
 * - 语言切换只更新 locale ref + stable translator：切换后不重新请求静态资产、
 *   不重连 SSE；切换后新产生的失败 toast 用切换后的语言（无陈旧闭包）；
 * - 后台通知偏好开关的权限拒绝 toast 随 locale；
 * - setLocale 持久化 helm:locale 并同步 <html lang>。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HelmStoreProvider } from '../src/lib/HelmStoreProvider.js'
import { useHelmStore } from '../src/lib/store-context.js'
import type { HelmStoreValue, ToastNotice } from '../src/lib/types.js'
import { hangingEventStream } from './helpers/sse-stream.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement

interface FetchPlan {
  /** /api/auth/status 返回 500 且 error.message 为该值（缺省认证通过）。 */
  authFailMessage?: string
  /** /api/skills 返回 503 且 error.message 为该值（缺省成功空列表）。 */
  skillsFailMessage?: string
  /** /api/nodes 返回 503 且 error.message 为该值（缺省成功空列表）。 */
  nodesFailMessage?: string
}

/** fetch 桩：按 plan 注入失败；记录 GET 路径计数供「不重新请求」断言。 */
function installFetch(plan: FetchPlan): {
  getCount: (path: string) => number
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  const counts = new Map<string, number>()
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === undefined || init.method === 'GET') counts.set(url, (counts.get(url) ?? 0) + 1)
    if (url === '/api/auth/status') {
      if (plan.authFailMessage !== undefined) {
        return jsonResponse({ error: { code: 'unavailable', message: plan.authFailMessage } }, 500)
      }
      return jsonResponse({ configured: true, authenticated: true })
    }
    if (url === '/api/events') {
      return new Response(
        hangingEventStream((send) => {
          send(new TextEncoder().encode(
            `event: snapshot\ndata: ${JSON.stringify({ bootId: 'locale-test-boot', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] })}\n\n`,
          ))
        }, { signal: init?.signal }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url === '/api/skills' && plan.skillsFailMessage !== undefined) {
      return jsonResponse({ error: { code: 'skills_down', message: plan.skillsFailMessage } }, 503)
    }
    if (url === '/api/nodes' && plan.nodesFailMessage !== undefined) {
      return jsonResponse({ error: { code: 'nodes_down', message: plan.nodesFailMessage } }, 503)
    }
    return jsonResponse([])
  }) as typeof fetch
  return {
    getCount: (path) => counts.get(path) ?? 0,
    restore: () => { globalThis.fetch = originalFetch },
  }
}

interface Mount {
  store: () => HelmStoreValue
  waitFor: (predicate: () => boolean, ms?: number) => Promise<void>
  settle: () => Promise<void>
  unmount: () => void
}

function mountProvider(): Mount {
  let current: HelmStoreValue | undefined
  function Probe(): React.ReactNode {
    current = useHelmStore()
    return e('div', { 'data-probe': 'locale' })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreProvider, null, e(Probe)))
  })
  return {
    store: () => current!,
    waitFor: async (predicate, ms = 15_000) => {
      const deadline = Date.now() + ms
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`waitFor 超时：store=${JSON.stringify(current?.notices ?? [])}`)
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      }
    },
    settle: async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    },
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

function noticeTitles(store: HelmStoreValue): string[] {
  return store.notices.map((notice: ToastNotice) => notice.title)
}

function withLocaleStorage(locale: 'en' | 'zh-CN' | null, fn: () => Promise<void>): Promise<void> {
  if (locale === null) localStorage.removeItem('helm:locale')
  else localStorage.setItem('helm:locale', locale)
  return fn().finally(() => localStorage.removeItem('helm:locale'))
}

test('zh-CN 持久化偏好：资产失败 toast 用中文标题，错误协议正文原样不译', { timeout: 60_000 }, async () => {
  await withLocaleStorage('zh-CN', async () => {
    const fetchStub = installFetch({ skillsFailMessage: 'skills backend down' })
    try {
      const mount = mountProvider()
      await mount.waitFor(() => mount.store().assetsLoaded && noticeTitles(mount.store()).length > 0)
      assert.equal(mount.store().locale, 'zh-CN')
      assert.equal(document.documentElement.lang, 'zh-CN', '<html lang> 同步当前 locale')
      const notice = mount.store().notices.find((n) => n.title === '技能加载失败')
      assert.ok(notice, `应有中文技能失败 toast，实际：${JSON.stringify(noticeTitles(mount.store()))}`)
      assert.equal(notice.body, 'skills backend down', '错误协议文本不翻译')
      mount.unmount()
    } finally {
      fetchStub.restore()
    }
  })
})

test('缺省 locale 为 en：同一失败用英文标题，错误正文同样原样', { timeout: 60_000 }, async () => {
  await withLocaleStorage(null, async () => {
    const fetchStub = installFetch({ skillsFailMessage: 'skills backend down' })
    try {
      const mount = mountProvider()
      await mount.waitFor(() => mount.store().assetsLoaded && noticeTitles(mount.store()).length > 0)
      assert.equal(mount.store().locale, 'en')
      const notice = mount.store().notices.find((n) => n.title === 'Skills failed to load')
      assert.ok(notice, `应有英文技能失败 toast，实际：${JSON.stringify(noticeTitles(mount.store()))}`)
      assert.equal(notice.body, 'skills backend down')
      mount.unmount()
    } finally {
      fetchStub.restore()
    }
  })
})

test('切换语言：不重新请求静态资产、不重连 SSE；切换后新失败 toast 用新语言且偏好落盘', { timeout: 60_000 }, async () => {
  await withLocaleStorage(null, async () => {
    const fetchStub = installFetch({ nodesFailMessage: 'nodes backend down' })
    try {
      const mount = mountProvider()
      await mount.waitFor(() => mount.store().assetsLoaded)
      const profileCalls = fetchStub.getCount('/api/profiles')
      const skillsCalls = fetchStub.getCount('/api/skills')
      const eventsCalls = fetchStub.getCount('/api/events')
      assert.ok(profileCalls >= 1 && skillsCalls >= 1 && eventsCalls >= 1, '初始加载确实发生')

      await act(async () => { mount.store().setLocale('zh-CN') })
      await mount.settle()
      assert.equal(mount.store().locale, 'zh-CN')
      assert.equal(localStorage.getItem('helm:locale'), 'zh-CN', '偏好持久化到既有 helm:locale 键')
      assert.equal(document.documentElement.lang, 'zh-CN')
      assert.equal(fetchStub.getCount('/api/profiles'), profileCalls, '切换语言不重新拉取角色')
      assert.equal(fetchStub.getCount('/api/skills'), skillsCalls, '切换语言不重新拉取技能')
      assert.equal(fetchStub.getCount('/api/events'), eventsCalls, '切换语言不重连 SSE')

      // 切换后新发生的失败：refreshNodes 挂载期创建（闭包语言为 en）仍按当前 locale 报中文
      await act(async () => { await mount.store().refreshNodes() })
      const notice = mount.store().notices.find((n) => n.title === '计算节点加载失败')
      assert.ok(notice, `切换后新失败应用中文标题，实际：${JSON.stringify(noticeTitles(mount.store()))}`)
      assert.equal(notice.body, 'nodes backend down', '错误协议文本不翻译')
      mount.unmount()
    } finally {
      fetchStub.restore()
    }
  })
})

test('后台通知权限被拒：警告 toast 随 locale（zh-CN）', { timeout: 60_000 }, async () => {
  await withLocaleStorage('zh-CN', async () => {
    const fetchStub = installFetch({})
    const originalNotification = (globalThis as Record<string, unknown>).Notification
    ;(globalThis as Record<string, unknown>).Notification = class {
      static permission: NotificationPermission = 'default'
      static requestPermission = async (): Promise<NotificationPermission> => 'denied'
    }
    try {
      const mount = mountProvider()
      await mount.waitFor(() => mount.store().assetsLoaded)
      await act(async () => { await mount.store().setQuietNotify(true) })
      const notice = mount.store().notices.find((n) => n.title === '浏览器通知权限未授予')
      assert.ok(notice, `应有中文权限未授予 toast，实际：${JSON.stringify(noticeTitles(mount.store()))}`)
      assert.equal(notice.body, '请在浏览器站点设置中允许通知后重新开启。')
      assert.equal(mount.store().quietNotifyEnabled, false, '拒绝时保持关闭，不静默装作已开启')
      mount.unmount()
    } finally {
      ;(globalThis as Record<string, unknown>).Notification = originalNotification
      fetchStub.restore()
    }
  })
})

test('内核连接失败：authError 前缀随 locale，协议错误详情原样', { timeout: 60_000 }, async () => {
  await withLocaleStorage('zh-CN', async () => {
    const fetchStub = installFetch({ authFailMessage: 'hub unreachable' })
    try {
      const mount = mountProvider()
      await mount.waitFor(() => mount.store().authReady)
      assert.ok(
        mount.store().authError?.startsWith('无法连接 Helm 内核：'),
        `中文前缀 + 原样错误，实际：${mount.store().authError}`,
      )
      assert.ok(mount.store().authError?.endsWith('hub unreachable'))
      mount.unmount()
    } finally {
      fetchStub.restore()
    }
  })
})

function withBrowserLanguages(initial: string[], fn: (setLangs: (next: string[]) => void) => Promise<void>): Promise<void> {
  const originalLanguages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages')
  const originalLanguage = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')
  const originalInstanceLanguages = Object.getOwnPropertyDescriptor(navigator, 'languages')
  const originalInstanceLanguage = Object.getOwnPropertyDescriptor(navigator, 'language')
  let current = initial
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => current })
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => current[0] ?? 'en' })
  return fn((next) => { current = next }).finally(() => {
    if (originalInstanceLanguages) Object.defineProperty(navigator, 'languages', originalInstanceLanguages)
    else delete (navigator as unknown as Record<string, unknown>).languages
    if (originalInstanceLanguage) Object.defineProperty(navigator, 'language', originalInstanceLanguage)
    else delete (navigator as unknown as Record<string, unknown>).language
    if (originalLanguages) Object.defineProperty(Navigator.prototype, 'languages', originalLanguages)
    if (originalLanguage) Object.defineProperty(Navigator.prototype, 'language', originalLanguage)
  })
}

test('auto 语言模式：跟随 navigator.languages 与 languagechange，手动覆盖后不再被浏览器语言覆盖', { timeout: 60_000 }, async () => {
  await withLocaleStorage(null, async () => {
    await withBrowserLanguages(['en-US'], async (setLangs) => {
      const fetchStub = installFetch({})
      try {
        const mount = mountProvider()
        await mount.waitFor(() => mount.store().assetsLoaded)
        assert.equal(mount.store().localePreference, 'auto')
        assert.equal(mount.store().locale, 'en')
        assert.equal(document.documentElement.lang, 'en')
        assert.equal(localStorage.getItem('helm:locale'), null)

        // 浏览器语言变化且偏好为 auto：自动切换为 zh-CN 并同步 <html lang>
        setLangs(['zh-CN', 'en-US'])
        await act(async () => {
          window.dispatchEvent(new Event('languagechange'))
        })
        await mount.settle()
        assert.equal(mount.store().localePreference, 'auto')
        assert.equal(mount.store().locale, 'zh-CN')
        assert.equal(document.documentElement.lang, 'zh-CN')
        assert.equal(localStorage.getItem('helm:locale'), null, 'auto 模式不写入 helm:locale')

        // 手动切换到 en：持久化 en，此后浏览器 languagechange 不得覆盖
        await act(async () => { mount.store().setLocalePreference?.('en') })
        await mount.settle()
        assert.equal(mount.store().localePreference, 'en')
        assert.equal(mount.store().locale, 'en')
        assert.equal(localStorage.getItem('helm:locale'), 'en')

        setLangs(['zh-TW'])
        await act(async () => {
          window.dispatchEvent(new Event('languagechange'))
        })
        await mount.settle()
        assert.equal(mount.store().localePreference, 'en', '手动覆盖后保持 en')
        assert.equal(mount.store().locale, 'en', 'languagechange 不得覆盖手动选择')
        assert.equal(document.documentElement.lang, 'en')

        // 切回 auto：清除 helm:locale 并立即按当前浏览器语言（zh-TW -> zh-CN）生效
        await act(async () => { mount.store().setLocalePreference?.('auto') })
        await mount.settle()
        assert.equal(mount.store().localePreference, 'auto')
        assert.equal(localStorage.getItem('helm:locale'), null)
        assert.equal(mount.store().locale, 'zh-CN')
        assert.equal(document.documentElement.lang, 'zh-CN')

        mount.unmount()
      } finally {
        fetchStub.restore()
      }
    })
  })
})
