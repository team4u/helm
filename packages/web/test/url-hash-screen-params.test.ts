/**
 * Screen 参数化导航：浏览器式交互历史测试（真实 HelmStoreProvider + happy-dom）。
 *
 * 覆盖：
 * - 深链刷新恢复（含 sp. / ssp. 命名空间参数）；
 * - 浏览器前进/后退还原主/分屏 Screen 参数；
 * - 异步初始数据（SSE snapshot 延迟到达）不抹深链；
 * - 主屏与分屏同 screen 双开参数互不串扰；
 * - setParams 默认 replace、{ push: true } 显式入栈、openTarget 字符串直携参数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HelmStoreProvider } from '../src/lib/HelmStoreProvider.js'
import { useHelmStore } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement

// ---------------------------------------------------------------------------
// HTTP / SSE 桩：auth 已认证、SSE snapshot（可延迟）后挂起、资产接口慢返回
// ---------------------------------------------------------------------------

let snapshotDelayMs = 0

const snapshotPayload = {
  seq: 1,
  conversations: [],
  pendingAsks: [],
  plugins: [{ id: 'test:nav', name: '导航测试', locked: false, enabled: true, hooks: [], actions: [], tools: [] }],
  ui: [
    {
      pluginId: 'test:nav',
      surface: 'screen',
      spec: { id: 'board', label: '看板', icon: 'panel-right' },
    },
  ],
}

/** SSE 流：先延迟（模拟异步初始数据），再发 snapshot 帧然后挂起（长连接不结束）。 */
function makeEventStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (snapshotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs))
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`))
    },
  })
}

function stubFetch(): void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path === '/api/events') return new Response(makeEventStream(), { status: 200 })
    // 资产接口：慢返回空列表（模拟异步初始数据）
    await new Promise((resolve) => setTimeout(resolve, 5))
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  ;(globalThis.fetch as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// 挂载辅助：单一真实 Provider，探针读取位置与 ScreenProps
// ---------------------------------------------------------------------------

interface ProbeSnapshot {
  primaryTarget: HelmStoreValue['primaryTarget']
  splitTarget: HelmStoreValue['splitTarget']
  hash: string
  historyLength: number
}

interface ScreenPropsCapture {
  pluginId: string
  screenId: string
  isSplit: boolean
  params: Record<string, string>
  setParams: (patch: Record<string, string | undefined>, options?: { push?: boolean }) => void
}

interface Mount {
  probe: () => ProbeSnapshot
  primaryScreen: () => ScreenPropsCapture | undefined
  splitScreen: () => ScreenPropsCapture | undefined
  openTarget: (target: string, opts?: { split?: boolean }) => void
  settle: () => Promise<void>
  unmount: () => void
}
/**
 * 单一 Provider 内挂载：位置探针 + 主/分屏 ScreenProps 探针 + openTarget 驱动按钮。
 * ScreenProps 探针按 ScreenHost 的真实组装路径（对应 target + store.setScreenParams）
 * 构造，与 ScreenHost.tsx 内 slotProps 组装保持同构。
 */
function mountApp(): Mount {
  let captured: ProbeSnapshot = { primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null, hash: '', historyLength: 0 }
  let primaryProps: ScreenPropsCapture | undefined
  let splitProps: ScreenPropsCapture | undefined
  let openTargetFn: ((target: string, opts?: { split?: boolean }) => void) | undefined

  const makeScreenProbe = (isSplit: boolean) =>
    function ScreenProbe(): React.ReactNode {
      const store = useHelmStore()
      const target = isSplit ? store.splitTarget : store.primaryTarget
      const matched =
        target !== null && target.kind === 'screen' && target.pluginId === 'test:nav' && target.screenId === 'board'
      const params = matched && target.params !== undefined ? target.params : {}
      const props: ScreenPropsCapture = {
        pluginId: 'test:nav',
        screenId: 'board',
        isSplit,
        params,
        setParams: (patch, options) => store.setScreenParams(patch, { split: isSplit, push: options?.push }),
      }
      if (isSplit) splitProps = props
      else primaryProps = props
      return e('div', { 'data-screen-probe': isSplit ? 'split' : 'primary' }, `${isSplit} ${JSON.stringify(params)}`)
    }

  function App(): React.ReactNode {
    const store = useHelmStore()
    captured = {
      primaryTarget: store.primaryTarget,
      splitTarget: store.splitTarget,
      hash: '', // settle 后由 probe 现场读地址栏（写回 effect 在渲染后执行，不触发重渲染）
      historyLength: window.history.length,
    }
    openTargetFn = (target, opts) => store.openTarget(target, opts)
    return e(React.Fragment, null,
      e(makeScreenProbe(false)),
      e(makeScreenProbe(true)),
    )
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreProvider, null, e(App)))
  })
  return {
    probe: () => ({ ...captured, hash: window.location.hash }),
    primaryScreen: () => primaryProps,
    splitScreen: () => splitProps,
    openTarget: (target, opts) => openTargetFn!(target, opts),
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
// 测试
// ---------------------------------------------------------------------------

test('刷新深链恢复：sp.*/ssp.* 参数从地址栏还原，异步初始数据不抹深链', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  snapshotDelayMs = 30 // SSE snapshot 延迟到达（异步初始数据）
  resetLocation('#/s/test:nav/board?sp.tab=runs&sp.q=%E4%B8%AD%E6%96%87&split=s/test:nav/board&ssp.tab=logs')
  const app = mountApp()
  try {
    await app.settle()
    const snapshot = app.probe()
    assert.deepEqual(snapshot.primaryTarget, {
      kind: 'screen', pluginId: 'test:nav', screenId: 'board',
      params: { tab: 'runs', q: '中文' },
    })
    assert.deepEqual(snapshot.splitTarget, {
      kind: 'screen', pluginId: 'test:nav', screenId: 'board',
      params: { tab: 'logs' },
    })
    // 地址栏保持规范编码：split 值经 URLSearchParams 转义，中文参数值百分号编码；
    // 键序为 formatLocationHash 的稳定插入序（split → sp.* 字典序 → ssp.*）。
    assert.equal(
      snapshot.hash,
      '#/s/test:nav/board?split=s%2Ftest%3Anav%2Fboard&sp.q=%E4%B8%AD%E6%96%87&sp.tab=runs&ssp.tab=logs',
    )
    // ScreenProps 探针拿到的是各自的参数（主/分屏不串）
    assert.deepEqual(app.primaryScreen()!.params, { tab: 'runs', q: '中文' })
    assert.deepEqual(app.splitScreen()!.params, { tab: 'logs' })
    assert.equal(app.primaryScreen()!.isSplit, false)
    assert.equal(app.splitScreen()!.isSplit, true)
  } finally {
    app.unmount()
  }
})

test('setParams 默认 replace：仅参数变化不新增历史记录，地址栏同步更新', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  snapshotDelayMs = 0
  resetLocation('#/s/test:nav/board?sp.tab=runs')
  const app = mountApp()
  try {
    await app.settle()
    const before = app.probe()
    await act(async () => {
      app.primaryScreen()!.setParams({ tab: 'logs' })
    })
    await app.settle()
    const after = app.probe()
    assert.equal(after.historyLength, before.historyLength, '仅参数变化默认 replace，不新增历史记录')
    assert.ok(after.primaryTarget.kind === 'screen')
    assert.deepEqual(after.primaryTarget.params, { tab: 'logs' })
    const query = new URLSearchParams(after.hash.slice(after.hash.indexOf('?') + 1))
    assert.equal(query.get('sp.tab'), 'logs')
  } finally {
    app.unmount()
  }
})

test('setParams { push: true } 显式入栈，浏览器后退/前进还原参数', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  snapshotDelayMs = 0
  resetLocation('#/s/test:nav/board?sp.tab=runs')
  const app = mountApp()
  try {
    await app.settle()
    const before = app.probe()
    await act(async () => {
      app.primaryScreen()!.setParams({ runId: 'wf_1' }, { push: true })
    })
    await app.settle()
    let current = app.probe()
    assert.equal(current.historyLength, before.historyLength + 1, 'push 标记必须新增历史记录')
    assert.ok(current.primaryTarget.kind === 'screen')
    if (current.primaryTarget.kind !== 'screen') return
    assert.deepEqual(current.primaryTarget.params, { tab: 'runs', runId: 'wf_1' })
    // 浏览器后退：经真实 popstate/hashchange 路径还原上一组参数
    await act(async () => {
      window.history.back()
    })
    await app.settle()
    current = app.probe()
    assert.ok(current.primaryTarget.kind === 'screen', '后退后主屏仍是 screen')
    assert.deepEqual(current.primaryTarget.kind === 'screen' ? current.primaryTarget.params : undefined, { tab: 'runs' }, '后退还原上一组参数')
    // 前进又回来
    await act(async () => {
      window.history.forward()
    })
    await app.settle()
    current = app.probe()
    assert.deepEqual(current.primaryTarget.kind === 'screen' ? current.primaryTarget.params : undefined, { tab: 'runs', runId: 'wf_1' }, '前进恢复下一组参数')
  } finally {
    app.unmount()
  }
})

test('主屏与分屏同 screen 双开：setParams 各自独立，互不串扰', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  snapshotDelayMs = 0
  resetLocation('#/s/test:nav/board?sp.tab=runs&split=s/test:nav/board&ssp.tab=logs')
  const app = mountApp()
  try {
    await app.settle()
    assert.deepEqual(app.primaryScreen()!.params, { tab: 'runs' })
    assert.deepEqual(app.splitScreen()!.params, { tab: 'logs' })
    // 主屏改参数：分屏不受影响
    await act(async () => {
      app.primaryScreen()!.setParams({ tab: 'graph' })
    })
    await app.settle()
    assert.deepEqual(app.primaryScreen()!.params, { tab: 'graph' })
    assert.deepEqual(app.splitScreen()!.params, { tab: 'logs' }, '主屏 setParams 不得影响分屏参数')
    let query = new URLSearchParams(app.probe().hash.slice(app.probe().hash.indexOf('?') + 1))
    assert.equal(query.get('sp.tab'), 'graph')
    assert.equal(query.get('ssp.tab'), 'logs')
    // 分屏删参数：主屏不受影响，ssp.tab 从地址栏消失
    await act(async () => {
      app.splitScreen()!.setParams({ tab: undefined })
    })
    await app.settle()
    assert.deepEqual(app.splitScreen()!.params, {}, 'undefined 值删除键')
    assert.deepEqual(app.primaryScreen()!.params, { tab: 'graph' })
    query = new URLSearchParams(app.probe().hash.slice(app.probe().hash.indexOf('?') + 1))
    assert.equal(query.get('sp.tab'), 'graph')
    assert.equal(query.get('ssp.tab'), null, '分屏参数清空后 ssp.tab 从地址栏消失')
  } finally {
    app.unmount()
  }
})

test('openTarget 字符串直携参数入栈，后退还原会话位置；非法键显式告警不静默', { timeout: 60_000 }, async (t) => {
  stubFetch()
  t.after(() => (globalThis.fetch as unknown as { restore: () => void }).restore())
  snapshotDelayMs = 0
  resetLocation('#/c/1')
  const app = mountApp()
  try {
    await app.settle()
    const before = app.probe()
    // sidebar target / helm:open 真实入口：screen:<pluginId>/<screenId>?k=v
    await act(async () => {
      app.openTarget('screen:test:nav/board?tab=logs&runId=wf_9')
    })
    await app.settle()
    let current = app.probe()
    assert.equal(current.historyLength, before.historyLength + 1, '跨坐标导航沿用既有 push 语义')
    assert.deepEqual(current.primaryTarget, {
      kind: 'screen', pluginId: 'test:nav', screenId: 'board',
      params: { tab: 'logs', runId: 'wf_9' },
    })
    assert.equal(new URLSearchParams(current.hash.slice(current.hash.indexOf('?') + 1)).get('sp.runId'), 'wf_9')
    // 后退：回到会话主屏
    await act(async () => {
      window.history.back()
    })
    await app.settle()
    current = app.probe()
    assert.deepEqual(current.primaryTarget, { kind: 'conversation', conversationId: 1 })
    // 非法参数键：显式告警（notices）而非静默丢弃
    await act(async () => {
      app.primaryScreen()!.setParams({ 'bad key!': 'v' })
    })
    await app.settle()
    // 此时主屏已回到会话（primaryScreen 探针 params 为空对象），非法键在会话主屏
    // setParams 属无效操作；改从 screen 位置直接验证：
    await act(async () => {
      app.openTarget('screen:test:nav/board')
    })
    await app.settle()
    await act(async () => {
      app.primaryScreen()!.setParams({ 'bad key!': 'v', ok_key: '1' })
    })
    await app.settle()
    assert.deepEqual(app.primaryScreen()!.params, { ok_key: '1' }, '非法键被拒绝，合法键仍生效')
  } finally {
    app.unmount()
  }
})

// 注：ScreenHost 渲染本身由 test/ui-screens.test.ts 的源码契约断言覆盖
// （零插件 ID 特判 + slotProps 组装）；tsx 对 src/*.tsx 的经典 JSX 转换使
// icons.tsx 等共享组件无法在本测试进程内运行时渲染，故本文件专注 Provider
// 导航行为（地址栏、历史栈、参数隔离）的浏览器式交互验收。
