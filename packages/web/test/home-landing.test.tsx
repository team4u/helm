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

const { App } = await import('../src/App.js')

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
function stubFetch(options: {
  snapshotPayload: object
  profilesResponse?: () => Promise<unknown>
  modelsResponse?: () => Promise<unknown>
}): FetchStub {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const profilesResponse = options.profilesResponse ?? (async () => [{ id: 'assistant', name: 'Assistant' }])
  const modelsResponse = options.modelsResponse ?? (async () => [])
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
    if (path === '/api/models' || path.startsWith('/api/models?')) {
      return jsonResponse(await modelsResponse())
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
  profilesLoaded: boolean
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
  let observed: Observed = {
    target: '',
    authenticated: false,
    profilesLoaded: false,
    assetsLoaded: false,
    sseConnected: false,
    historyLength: 0,
  }
  let openTargetFn: ((target: ResolvedTarget) => void) | undefined

  function App(): React.ReactNode {
    const store = useHelmStore()
    observed = {
      target: describeTarget(store.primaryTarget),
      authenticated: store.authenticated,
      profilesLoaded: store.profilesLoaded,
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

// ---------------------------------------------------------------------------
// App 级集成：落地中性骨架屏（不闪 ProfileCenter）、连接横幅 1500ms 防抖与懒加载
// ---------------------------------------------------------------------------

test('App 空 Hash 落地期渲染 .home-landing-skeleton，绝不闪现 ProfileCenter 后再跳走', { timeout: 60_000 }, async (t) => {
  let releaseProfiles!: () => void
  const profilesGate = new Promise<void>((resolve) => { releaseProfiles = resolve })
  const stub = stubFetch({
    snapshotPayload: snapshotOf([CONV_ROOT]),
    profilesResponse: async () => {
      await profilesGate
      return [{ id: 'assistant', name: 'Assistant' }]
    },
  })
  t.after(() => {
    releaseProfiles()
    stub.restore()
  })
  resetEmptyHash()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let sawProfileCenter = false
  const observer = new MutationObserver(() => {
    if (host.textContent?.includes('Agent Profile Center')) sawProfileCenter = true
  })
  observer.observe(host, { childList: true, subtree: true, characterData: true })

  try {
    await act(async () => {
      root.render(e(App))
    })

    // 认证与 SSE 就绪但 profiles 尚未完成：homeLandingPending 为真，渲染中性骨架屏而非 ProfileCenter
    const deadline = Date.now() + 10_000
    while (host.querySelector('.home-landing-skeleton') === null) {
      if (Date.now() > deadline) throw new Error('等待 .home-landing-skeleton 超时')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
    }
    assert.ok(host.querySelector('.home-landing-skeleton') !== null, '落地等待期渲染 .home-landing-skeleton')
    assert.equal(sawProfileCenter, false, '落地等待期绝不闪现 ProfileCenter')

    // 释放 profiles：就绪后直接落入待命页，全程未闪现 ProfileCenter
    await act(async () => { releaseProfiles() })
    const settleDeadline = Date.now() + 10_000
    while (host.querySelector('.agent-standby-pane') === null) {
      if (Date.now() > settleDeadline) throw new Error('等待 .agent-standby-pane 超时')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
    }
    assert.equal(sawProfileCenter, false, '全程未瞬时挂载 ProfileCenter')
    assert.ok(host.querySelector('.home-landing-skeleton') === null, '落地完成后骨架屏退场')
    assert.equal(window.location.hash, '#/a/assistant')
  } finally {
    observer.disconnect()
    act(() => root.unmount())
    host.remove()
  }
})

test('App 空 Hash 且无任何角色/会话时：就绪后揭开 ProfileCenter 兜底（不永久卡在骨架屏）', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({
    snapshotPayload: snapshotOf([]),
    profilesResponse: async () => [],
  })
  t.after(() => stub.restore())
  resetEmptyHash()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(App))
    })
    const deadline = Date.now() + 10_000
    while (!host.textContent?.includes('Agent Profile Center')) {
      if (Date.now() > deadline) throw new Error(`等待 ProfileCenter 兜底超时: ${host.innerHTML}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    assert.ok(host.querySelector('.home-landing-skeleton') === null)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('App 连接横幅防抖：1500ms 内闪断不出现，断线持续 >=1500ms 才浮现，重连即消', { timeout: 60_000 }, async (t) => {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  let sendEventsCount = 0
  let closeStream: (() => void) | undefined
  let releaseSecondConnect: (() => void) | undefined

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') return jsonResponse({ configured: true, authenticated: true })
    if (path.startsWith('/api/events')) {
      sendEventsCount += 1
      if (sendEventsCount === 2 && releaseSecondConnect === undefined) {
        await new Promise<void>((resolve) => { releaseSecondConnect = resolve })
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshotOf([CONV_ROOT]))}\n\n`))
            closeStream = () => {
              try { controller.close() } catch { /* noop */ }
            }
            init?.signal?.addEventListener('abort', () => closeStream?.(), { once: true })
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (path === '/api/profiles') return jsonResponse([{ id: 'assistant', name: 'Assistant' }])
    return jsonResponse([])
  }) as typeof fetch
  t.after(() => {
    releaseSecondConnect?.()
    globalThis.fetch = originalFetch
  })

  window.history.replaceState(null, '', '#/a/assistant')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(App))
    })
    const waitReadyDeadline = Date.now() + 10_000
    while (host.querySelector('.agent-standby-pane') === null) {
      if (Date.now() > waitReadyDeadline) throw new Error('等待待命页超时')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
    }
    assert.ok(host.querySelector('.connection-banner') === null, '首次快速建连不闪现 connection-banner')

    // 触发断线并挂起第 2 次重连：在 1500ms 防抖期前绝不显示横幅
    await act(async () => {
      closeStream?.()
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    assert.ok(host.querySelector('.connection-banner') === null, '短断线（<1500ms）不闪现重连横幅')

    // 越过 1500ms 后横幅浮现
    const bannerDeadline = Date.now() + 5_000
    while (host.querySelector('.connection-banner') === null) {
      if (Date.now() > bannerDeadline) throw new Error('断线超过 1500ms 未展示 .connection-banner')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    }
    assert.ok(host.querySelector('.connection-banner') !== null)

    // 恢复连接后横幅立即消失
    await act(async () => {
      releaseSecondConnect?.()
    })
    const clearDeadline = Date.now() + 5_000
    while (host.querySelector('.connection-banner') !== null) {
      if (Date.now() > clearDeadline) throw new Error('重连后 .connection-banner 未消失')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    assert.ok(host.querySelector('.connection-banner') === null)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('App 懒加载中心路由（#/settings/models）：Suspense 后渲染 ModelCenter', { timeout: 60_000 }, async (t) => {
  const stub = stubFetch({ snapshotPayload: snapshotOf([CONV_ROOT]) })
  t.after(() => stub.restore())
  window.history.replaceState(null, '', '#/settings/models')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(App))
    })
    const deadline = Date.now() + 10_000
    while (!host.textContent?.includes('Models & Credentials Center')) {
      if (Date.now() > deadline) throw new Error(`等待 ModelCenter 懒加载超时: ${host.innerHTML}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    assert.ok(host.textContent?.includes('Models & Credentials Center'))
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('慢资产接口阻塞 assetsLoaded 时，只要 profilesLoaded 就绪即立即完成首页落地', { timeout: 60_000 }, async (t) => {
  let releaseModels!: () => void
  const modelsGate = new Promise<void>((resolve) => { releaseModels = resolve })
  const stub = stubFetch({
    snapshotPayload: snapshotOf([CONV_ROOT]),
    modelsResponse: async () => { await modelsGate; return [] },
  })
  t.after(() => stub.restore())
  resetEmptyHash()
  const app = mountApp()
  const historyLengthAtBoot = window.history.length
  try {
    await app.waitFor((o) => o.authenticated && o.profilesLoaded && o.sseConnected)
    await app.waitFor((o) => o.target === 'a/assistant')
    await app.settle()
    const current = app.probe()
    assert.equal(current.profilesLoaded, true, 'profiles 接口返回即置位 profilesLoaded')
    assert.equal(current.assetsLoaded, false, 'models 仍未返回时 assetsLoaded 保持 false，不得阻塞落地')
    assert.equal(current.target, 'a/assistant')
    assert.equal(window.location.hash, '#/a/assistant')
    assert.equal(current.historyLength, historyLengthAtBoot)
  } finally {
    releaseModels()
    app.unmount()
  }
})
