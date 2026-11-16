/**
 * 空 Hash 首页落地（对话空间缺省目标）——真实 HelmStoreProvider + happy-dom + 真实 history。
 *
 * 契约（docs/conventions/web-navigation.md §2.0 首页落地）：
 * - 空 Hash（无显式主屏目标且无弹窗）进入不是导航意图：认证、会话快照与静态资产
 *   全部就绪后，主屏以 replace 落到对话空间缺省目标——最新根会话所属角色的待命页，
 *   无会话时首个可用角色——replace 不产生历史项，后退不回到角色中心；
 * - 数据就绪前位置被移动（用户点击 / 外部前进后退 / 程序导航）：既有意图优先，取消落地；
 * - 显式主屏目标或弹窗深链入口不触发落地；无任何可用角色时保持解析缺省（角色中心）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HelmStoreProvider } from '../src/lib/HelmStoreProvider.js'
import { useHelmStore } from '../src/lib/store-context.js'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { ResolvedTarget } from '../src/lib/types.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement

// ---------------------------------------------------------------------------
// HTTP / SSE 桩：auth 已认证、/api/events 发 snapshot 后挂起、未匹配路径一律空列表
// ---------------------------------------------------------------------------

// 根会话（parentConversationId 未设置、未归档）：defaultSpaceTarget('conversations')
// 取最新根会话所属角色（updatedAt 并列时 id 大者胜）作为待命页目标。
const CONV_ROOT = {
  id: 1,
  title: '根会话',
  profileId: 'assistant',
  tags: [],
  cwd: '/root/code/helm',
  model: 'test/model',
  thinkingLevel: '',
  status: 'idle',
  stateChangeSeq: 1,
  completionSeq: 1,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

const snapshotOf = (conversations: unknown[]) => ({
  bootId: 'test-boot',
  seq: 1,
  conversations,
  pendingAsks: [],
  plugins: [],
  ui: [],
})

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

interface FetchStub {
  restore: () => void
}

/**
 * fetch 桩：`profilesResponse` 可控（默认立即返回 assistant）；
 * 挂起它即可把 assetsLoaded 钉在 false（首页落地的就绪前提），实现「就绪前导航」。
 */
function stubFetch(options: { snapshotPayload: object; profilesResponse?: () => Promise<unknown> }): FetchStub {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const profilesResponse = options.profilesResponse ?? (async () => [{ id: 'assistant', name: 'Assistant' }])
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return jsonResponse({ configured: true, authenticated: true })
    }
    if (path === '/api/events') {
      return new Response(hangingEventStream((send) => {
        send(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(options.snapshotPayload)}\n\n`))
      }, { signal: init?.signal }), { status: 200 })
    }
    if (path === '/api/profiles') {
      return jsonResponse(await profilesResponse())
    }
    return jsonResponse([])
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = originalFetch } }
}

// ---------------------------------------------------------------------------
// 挂载辅助：位置/就绪探针、openTarget 驱动、waitFor 轮询与 settle 收尾
// ---------------------------------------------------------------------------

interface Observed {
  target: string
  authenticated: boolean
  assetsLoaded: boolean
  sseConnected: boolean
  historyLength: number
}

interface Mount {
  probe: () => Observed
  openTarget: (target: ResolvedTarget) => void
  waitFor: (predicate: (observed: Observed) => boolean, ms?: number) => Promise<void>
  settle: () => Promise<void>
  unmount: () => void
}

/** 主屏目标的紧凑描述（与规范路径同构，便于直接断言）。 */
function describeTarget(target: ResolvedTarget): string {
  switch (target.kind) {
    case 'conversation': return `c/${target.conversationId}`
    case 'agent': return `a/${target.profileId}`
    case 'screen': return `views/${target.pluginId}/${target.screenId}`
    case 'profiles': return target.profileId !== undefined ? `settings/profiles/${target.profileId}` : 'settings/profiles'
    case 'models': return target.providerId !== undefined ? `settings/models/${target.providerId}` : 'settings/models'
    case 'skills': return target.skillId !== undefined ? `settings/skills/${target.skillId}` : 'settings/skills'
    case 'nodes': return target.nodeId !== undefined ? `settings/nodes/${target.nodeId}` : 'settings/nodes'
    case 'plugins': return target.pluginId !== undefined ? `settings/plugins/${target.pluginId}` : 'settings/plugins'
  }
}

/** 全部就绪：认证 + 静态资产 + SSE 快照（首页落地 effect 的三个前置）。 */
const allReady = (o: Observed): boolean => o.authenticated && o.assetsLoaded && o.sseConnected

function mountApp(): Mount {
  let observed: Observed = { target: '', authenticated: false, assetsLoaded: false, sseConnected: false, historyLength: 0 }
  let openTargetFn: ((target: ResolvedTarget) => void) | undefined

  function App(): React.ReactNode {
    const store = useHelmStore()
    observed = {
      target: describeTarget(store.primaryTarget),
      authenticated: store.authenticated,
      assetsLoaded: store.assetsLoaded,
      sseConnected: store.sseConnected,
      historyLength: window.history.length,
    }
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
    probe: () => observed,
    openTarget: (target) => openTargetFn!(target),
    waitFor: async (predicate: (o: Observed) => boolean, ms = 15_000): Promise<void> => {
      const deadline = Date.now() + ms
      while (!predicate(observed)) {
        if (Date.now() > deadline) {
          throw new Error(`waitFor 超时：${JSON.stringify(observed)} hash=${window.location.hash}`)
        }
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      }
    },
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

/**
 * 空挂载重置：清掉地址栏 hash。
 * 注意 `replaceState(null, '', '')` 按 WHATWG 规范以文档 URL 解析空串、保留既有
 * fragment（同文件内前序用例遗留的 hash 清不掉），因此显式用 pathname+search 重置。
 */
function resetEmptyHash(): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
}

// ---------------------------------------------------------------------------

test('空 Hash 首页落地：最新根会话所属角色的待命页，replace 全程不入历史栈', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({ snapshotPayload: snapshotOf([CONV_ROOT]) })
  t.after(() => stub.restore())
  resetEmptyHash()
  const app = mountApp()
  const historyLengthAtBoot = window.history.length
  try {
    await app.waitFor(allReady)
    await app.waitFor((o) => o.target === 'a/assistant')
    const current = app.probe()
    assert.equal(current.target, 'a/assistant', '就绪后主屏落到最新根会话所属角色的待命页')
    assert.equal(window.location.hash, '#/a/assistant')
    assert.equal(current.historyLength, historyLengthAtBoot, '观测期（含落地当拍）历史长度不变')
    assert.equal(window.history.length, historyLengthAtBoot, '落地是 replace，绝不产生历史项')
  } finally {
    app.unmount()
  }
})

test('空 Hash 首页落地：无会话时落到首个可用角色', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({ snapshotPayload: snapshotOf([]) })
  t.after(() => stub.restore())
  resetEmptyHash()
  const app = mountApp()
  try {
    await app.waitFor(allReady)
    await app.waitFor((o) => o.target === 'a/assistant')
    assert.equal(app.probe().target, 'a/assistant', '无任何会话时落到首个可用角色的待命页')
    assert.equal(window.location.hash, '#/a/assistant')
  } finally {
    app.unmount()
  }
})

test('显式主屏目标不触发落地：保持角色中心与原 URL', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({ snapshotPayload: snapshotOf([CONV_ROOT]) })
  t.after(() => stub.restore())
  window.history.replaceState(null, '', '#/settings/profiles')
  const app = mountApp()
  try {
    await app.waitFor(allReady)
    await app.settle()
    assert.equal(app.probe().target, 'settings/profiles', '显式目标是导航意图，绝不覆盖')
    assert.equal(window.location.hash, '#/settings/profiles', 'URL 保持不变（写回与当前 hash 一致，不产生写入）')
  } finally {
    app.unmount()
  }
})

test('取消落地：就绪前已有导航则以既有意图优先，不再落地', { timeout: 60_000 }, async (t) => {
  let releaseProfiles!: () => void
  const gate = new Promise<void>((resolve) => { releaseProfiles = resolve })
  const stub = stubFetch({
    snapshotPayload: snapshotOf([CONV_ROOT]),
    // /api/profiles 挂起：assetsLoaded 钉在 false，落地条件在释放前恒不满足。
    profilesResponse: async () => { await gate; return [{ id: 'assistant', name: 'Assistant' }] },
  })
  t.after(() => stub.restore())
  resetEmptyHash()
  const app = mountApp()
  try {
    // profiles 未返回（未就绪）期间程序导航到模型中心。
    await act(async () => { app.openTarget({ kind: 'models' }) })
    await app.waitFor((o) => o.target === 'settings/models')
    await app.waitFor((o) => o.authenticated && o.sseConnected)
    await app.waitFor(() => window.location.hash === '#/settings/models')
    // 释放 profiles、等待全部就绪：既有导航意图优先，落地必须被取消。
    await act(async () => { releaseProfiles() })
    await app.waitFor(allReady)
    await app.settle()
    assert.equal(app.probe().target, 'settings/models', '就绪后不得再落地')
    assert.equal(window.location.hash, '#/settings/models')
  } finally {
    releaseProfiles()
    app.unmount()
  }
})

test('弹窗深链入口不落地：无显式主屏目标但有弹窗时主屏保持角色中心', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({ snapshotPayload: snapshotOf([CONV_ROOT]) })
  t.after(() => stub.restore())
  window.history.replaceState(null, '', '#/?modal=artifact&id=abc')
  const app = mountApp()
  try {
    await app.waitFor(allReady)
    await app.settle()
    assert.equal(app.probe().target, 'settings/profiles', '弹窗深链不算首页进入，主屏保持解析缺省')
    // 既有写回行为会把 URL 规范化为 #/settings/profiles?modal=artifact&id=abc：弹窗参数保留。
    const params = new URLSearchParams((window.location.hash.split('?')[1] ?? ''))
    assert.equal(params.get('modal'), 'artifact', '弹窗参数在 URL 中保留')
    assert.equal(params.get('id'), 'abc')
    assert.notEqual(window.location.hash, '#/a/assistant')
  } finally {
    app.unmount()
  }
})
