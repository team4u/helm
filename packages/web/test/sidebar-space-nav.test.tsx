/**
 * 侧栏空间（Activity Rail 三档）导航位置化：浏览器式交互历史测试
 * （真实 HelmStoreProvider + happy-dom，真实 history push/back/forward）。
 *
 * 覆盖：
 * - 深链 `#/c/<id>?sidebar=<space>` 刷新恢复侧栏空间（主屏仍是会话）；
 * - Rail 点击（store.setSidebarSpace）写回 sidebar 参数并 push 入栈，重复点击不产生历史项；
 * - 浏览器后退/前进经真实 popstate 还原侧栏空间；
 * - 跨空间导航（openTarget 到系统中心）自动对齐侧栏空间并省略 sidebar 参数；
 * - 回到隐含空间的 Rail 点击移除 sidebar 参数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HelmStoreProvider } from '../src/lib/HelmStoreProvider.js'
import { useHelmStore } from '../src/lib/store-context.js'
import type { SidebarSpace } from '../src/lib/types.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement

// ---------------------------------------------------------------------------
// HTTP / SSE 桩：auth 已认证、SSE snapshot 后挂起、资产接口空列表
// ---------------------------------------------------------------------------

const snapshotPayload = {
  seq: 1,
  conversations: [],
  pendingAsks: [],
  plugins: [],
  ui: [],
}

function stubFetch(): void {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path === '/api/events') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`))
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  ;(globalThis.fetch as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// 挂载辅助：位置探针（主屏目标 + 侧栏空间）与 Rail 驱动函数
// ---------------------------------------------------------------------------

interface ProbeSnapshot {
  primaryKind: string
  sidebarSpace: SidebarSpace
  hash: string
  historyLength: number
}

interface Mount {
  probe: () => ProbeSnapshot
  rail: (space: SidebarSpace) => void
  openTarget: (target: { kind: 'profiles' }) => void
  settle: () => Promise<void>
  unmount: () => void
}

function mountApp(): Mount {
  let captured: ProbeSnapshot = { primaryKind: '', sidebarSpace: 'conversations', hash: '', historyLength: 0 }
  let railFn: ((space: SidebarSpace) => void) | undefined
  let openTargetFn: ((target: { kind: 'profiles' }) => void) | undefined

  function App(): React.ReactNode {
    const store = useHelmStore()
    captured = {
      primaryKind: store.primaryTarget.kind,
      sidebarSpace: store.sidebarSpace,
      hash: '',
      historyLength: window.history.length,
    }
    railFn = (space) => store.setSidebarSpace(space)
    openTargetFn = (target) => store.openTarget(target)
    return e('div', { 'data-probe': 'root' })
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreProvider, null, e(App)))
  })
  return {
    probe: () => ({ ...captured, hash: window.location.hash, historyLength: window.history.length }),
    rail: (space) => railFn!(space),
    openTarget: (target) => openTargetFn!(target),
    settle: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

function resetLocation(hash: string): void {
  window.history.replaceState(null, '', hash)
}

// ---------------------------------------------------------------------------

test('侧栏空间导航：深链恢复、Rail 点击入栈、后退还原、跨空间对齐省略 sidebar', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  // 1) 深链：主屏会话 + 侧栏显式停在设置空间（刷新 / 复制链接直达语义）
  resetLocation('#/c/1?sidebar=settings')
  const app = mountApp()
  try {
    await app.settle()
    let current = app.probe()
    assert.equal(current.primaryKind, 'conversation', '主屏仍是会话')
    assert.equal(current.sidebarSpace, 'settings', '深链恢复侧栏设置空间')
    assert.equal(current.hash, '#/c/1?sidebar=settings')

    // 2) Rail 点击回对话空间：sidebar 与隐含一致被移除，且 push 入栈
    const before = app.probe()
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    current = app.probe()
    assert.equal(current.sidebarSpace, 'conversations')
    assert.equal(current.hash, '#/c/1', '回到隐含空间时移除 sidebar 参数')
    assert.equal(current.historyLength, before.historyLength + 1, 'Rail 点击必须 push 入栈')

    // 3) 重复点击当前空间：不产生历史项、地址栏不变
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    current = app.probe()
    assert.equal(current.historyLength, before.historyLength + 1, '重复点击当前空间不入栈')
    assert.equal(current.hash, '#/c/1')

    // 4) 浏览器后退：经真实 popstate/hashchange 还原设置空间
    await act(async () => {
      window.history.back()
    })
    await app.settle()
    current = app.probe()
    assert.equal(current.sidebarSpace, 'settings', '后退还原侧栏设置空间')
    assert.equal(current.hash, '#/c/1?sidebar=settings')

    // 5) 跨空间导航（openTarget 到角色中心）：侧栏自动对齐设置空间并省略 sidebar
    await act(async () => {
      app.openTarget({ kind: 'profiles' })
    })
    await app.settle()
    current = app.probe()
    assert.equal(current.primaryKind, 'profiles')
    assert.equal(current.sidebarSpace, 'settings', '跨空间导航自动对齐')
    assert.equal(current.hash, '#/profiles', '与隐含一致时省略 sidebar 参数')
  } finally {
    app.unmount()
  }
})

test('侧栏空间导航：主屏在系统中心时 Rail 切到对话空间序列化 sidebar=conversations', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  resetLocation('#/profiles')
  const app = mountApp()
  try {
    await app.settle()
    assert.equal(app.probe().sidebarSpace, 'settings', '无 nav 时跟随主屏隐含空间')
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    const current = app.probe()
    assert.equal(current.sidebarSpace, 'conversations')
    assert.equal(current.hash, '#/profiles?sidebar=conversations', '偏离隐含空间时序列化 sidebar')
  } finally {
    app.unmount()
  }
})
