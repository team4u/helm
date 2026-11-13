/**
 * Activity Rail 空间导航（方案 B：一级图标切换整个工作空间）——浏览器式交互历史测试
 * （真实 HelmStoreProvider + happy-dom，真实 history push/back/forward）。
 *
 * 契约要点：
 * - Hash 只表达唯一主舞台目标，全程不出现 sidebar / sidebarSpace 查询参数（无双前缀形态）；
 * - 规范路径：`#/c/<id>`、`#/a/<profile>`、`#/views/<plugin>/<screen>`、
 *   `#/settings/profiles[/<id>]`、`#/settings/models[/<provider>]` 等设置中心同理；
 * - Rail 点击经 `store.openSpace(space)` 整体切换工作空间：主屏切到该空间记忆的最近目标
 *   （会话级记忆）；views 未访问过时落到首个可用 screen 侧栏项；settings 缺省 profiles；
 * - 打开 settings 项 / agent / screen 分别更新所在空间的记忆；
 * - 浏览器后退 / 前进经真实 popstate 还原位置。
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
import type { ResolvedTarget, SidebarSpace } from '../src/lib/types.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement

// ---------------------------------------------------------------------------
// HTTP / SSE 桩：auth 已认证、SSE snapshot（含两条有序视图侧栏项）后挂起、资产接口空列表
// ---------------------------------------------------------------------------

// 会话 1：深链 #/c/1 的记忆回跳目标须仍在会话列表中（isSpaceTargetAvailable 校验）。
const CONV_1 = {
  id: 1,
  title: '深链会话',
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

const snapshotPayload = {
  seq: 1,
  conversations: [CONV_1],
  pendingAsks: [],
  plugins: [],
  ui: [
    // 视图空间可用项按 order 排序：overview（10）在前、detail（20）在后，
    // 未访问过 views 的 Rail 点击必须落到首个可用项 overview；
    // 同步贡献 screen 扩展面，保证记忆的 screen 目标仍被判定为可用。
    { pluginId: 'test:nav', surface: 'sidebar.item', spec: { id: 'overview', label: '总览', icon: 'layout-grid', target: 'screen:test:nav/overview', order: 10 } },
    { pluginId: 'test:nav', surface: 'sidebar.item', spec: { id: 'detail', label: '详情', icon: 'list', target: 'screen:test:nav/detail', order: 20 } },
    { pluginId: 'test:nav', surface: 'screen', spec: { id: 'overview', label: '总览', icon: 'layout-grid' } },
    { pluginId: 'test:nav', surface: 'screen', spec: { id: 'detail', label: '详情', icon: 'list' } },
  ],
}

function stubFetch(): void {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path === '/api/events') {
      return new Response(hangingEventStream((send) => {
        send(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`))
      }, { signal: init?.signal }), { status: 200 })
    }
    // assistant 角色存在：agent 待命目标（#/a/assistant）的记忆回跳可用性校验依赖角色资产。
    if (path === '/api/profiles') {
      return new Response(JSON.stringify([{ id: 'assistant', name: 'Assistant' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  ;(globalThis.fetch as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// 挂载辅助：位置探针（主屏目标 + 地址栏）与 Rail / openTarget 驱动函数
// ---------------------------------------------------------------------------

interface ProbeSnapshot {
  target: string
  hash: string
  historyLength: number
}

interface Mount {
  probe: () => ProbeSnapshot
  rail: (space: SidebarSpace) => void
  openTarget: (target: ResolvedTarget) => void
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

/** 方案 B 铁律：任何时刻地址栏都不得出现 sidebar / sidebarSpace 查询参数。 */
function assertNoSidebarParam(hash: string): void {
  const query = hash.split('?')[1] ?? ''
  const params = new URLSearchParams(query)
  assert.equal(params.get('sidebar'), null, `地址栏不得携带 sidebar 参数：${hash}`)
  assert.equal(params.get('sidebarSpace'), null, `地址栏不得携带 sidebarSpace 参数：${hash}`)
}

function mountApp(): Mount {
  let captured: ProbeSnapshot = { target: '', hash: '', historyLength: 0 }
  let railFn: ((space: SidebarSpace) => void) | undefined
  let openTargetFn: ((target: ResolvedTarget) => void) | undefined

  function App(): React.ReactNode {
    const store = useHelmStore()
    captured = {
      target: describeTarget(store.primaryTarget),
      hash: '',
      historyLength: window.history.length,
    }
    railFn = (space) => store.openSpace(space)
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

test('空间导航：深链恢复、Rail 切换整空间入栈、后退/前进还原、地址栏始终无 sidebar 参数', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  // 1) conversation 深链：刷新 / 复制链接直达，主屏恢复该会话
  resetLocation('#/c/1')
  const app = mountApp()
  const observed: string[] = []
  const snap = (): ProbeSnapshot => {
    const current = app.probe()
    observed.push(current.hash)
    assertNoSidebarParam(current.hash)
    return current
  }
  try {
    await app.settle()
    let current = snap()
    assert.equal(current.target, 'c/1', '深链恢复主屏会话')
    assert.equal(current.hash, '#/c/1')

    // 2) 点击设置 Rail：主屏直接切到设置空间目标（缺省角色中心）并 push 入栈
    let before = snap()
    await act(async () => {
      app.rail('settings')
    })
    await app.settle()
    current = snap()
    assert.equal(current.target, 'settings/profiles', '设置 Rail 直达角色中心（settings 缺省目标）')
    assert.equal(current.hash, '#/settings/profiles')
    assert.equal(current.historyLength, before.historyLength + 1, 'Rail 切换必须 push 入栈')

    // 3) 从设置去 views：未访问过视图空间，直达首个可用 screen 侧栏项
    before = snap()
    await act(async () => {
      app.rail('views')
    })
    await app.settle()
    current = snap()
    assert.equal(current.target, 'views/test:nav/overview', '未访问过的 views 落到首个可用侧栏视图项')
    assert.equal(current.hash, '#/views/test:nav/overview')
    assert.equal(current.historyLength, before.historyLength + 1)

    // 4) 返回设置：恢复该空间记忆的原 settings 目标
    await act(async () => {
      app.rail('settings')
    })
    await app.settle()
    current = snap()
    assert.equal(current.target, 'settings/profiles', '返回设置恢复原 settings 目标')
    assert.equal(current.hash, '#/settings/profiles')

    // 5) 点击对话 Rail：从空间记忆恢复此前停留的会话
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    current = snap()
    assert.equal(current.target, 'c/1', '对话空间从记忆恢复深链会话')
    assert.equal(current.hash, '#/c/1')

    // 6) 浏览器后退 / 前进：经真实 popstate 还原位置（空间随主屏目标一并还原）
    await act(async () => {
      window.history.back()
    })
    await app.settle()
    current = snap()
    assert.equal(current.hash, '#/settings/profiles')
    assert.equal(current.target, 'settings/profiles')

    await act(async () => {
      window.history.back()
    })
    await app.settle()
    current = snap()
    assert.equal(current.hash, '#/views/test:nav/overview')
    assert.equal(current.target, 'views/test:nav/overview')

    await act(async () => {
      window.history.forward()
    })
    await app.settle()
    current = snap()
    assert.equal(current.hash, '#/settings/profiles')
    assert.equal(current.target, 'settings/profiles')
  } finally {
    app.unmount()
  }
})

test('空间记忆：打开 settings 项 / agent / screen 分别更新所在空间的最近目标', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  resetLocation('#/c/1')
  const app = mountApp()
  const snap = (): ProbeSnapshot => {
    const current = app.probe()
    assertNoSidebarParam(current.hash)
    return current
  }
  try {
    await app.settle()
    assert.equal(snap().target, 'c/1')

    // 打开 settings 项（模型中心）：settings 空间记忆更新
    await act(async () => {
      app.openTarget({ kind: 'models' })
    })
    await app.settle()
    assert.equal(snap().hash, '#/settings/models')

    // 回对话空间后打开 agent 待命页：conversations 空间记忆更新
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    assert.equal(snap().hash, '#/c/1', '对话空间先恢复记忆的会话')
    await act(async () => {
      app.openTarget({ kind: 'agent', profileId: 'assistant' })
    })
    await app.settle()
    assert.equal(snap().hash, '#/a/assistant')

    // 去设置恢复记忆目标，再打开非首个 screen：views 空间记忆更新
    await act(async () => {
      app.rail('settings')
    })
    await app.settle()
    assert.equal(snap().hash, '#/settings/models', '设置空间恢复记忆的模型中心')
    await act(async () => {
      app.openTarget({ kind: 'screen', pluginId: 'test:nav', screenId: 'detail' })
    })
    await app.settle()
    assert.equal(snap().hash, '#/views/test:nav/detail')

    // 三空间往返：全部从各自记忆恢复（views 恢复 detail 而非首个 overview，证明是记忆而非回退）
    await act(async () => {
      app.rail('conversations')
    })
    await app.settle()
    assert.equal(snap().hash, '#/a/assistant', '对话空间恢复 agent 待命页')
    await act(async () => {
      app.rail('views')
    })
    await app.settle()
    assert.equal(snap().hash, '#/views/test:nav/detail', '视图空间恢复记忆的 detail 屏')
    await act(async () => {
      app.rail('settings')
    })
    await app.settle()
    assert.equal(snap().hash, '#/settings/models', '设置空间恢复记忆的模型中心')
  } finally {
    app.unmount()
  }
})
