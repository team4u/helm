/**
 * useStableCallback 契约测试（真实 DOM：createRoot + act，happy-dom）：
 * - 包装函数身份跨 render 恒定，调用转发到最新实现（参数/返回值透传）；
 * - 子组件 layoutEffect 在同一 commit 内即可见到本次 render 的实现
 *   （useInsertionEffect 先于所有 layout effect，区别于 passive effect 方案）；
 * - 渲染期调用见到的是上一次 commit 的实现（因此渲染期需要的 memo factory 不可替换）；
 * - 实例级隔离、卸载后无模块级缓存：旧包装函数只指向该实例最后一次 commit，
 *   不影响后续实例。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStableCallback } = await import('../src/lib/use-stable-callback.js')

interface ProbeCapture {
  stable: ((delta: number) => number) | null
  /** 子组件 layoutEffect 中调用稳定包装看到的结果。 */
  layoutSeen: number | null
  /** 渲染期调用稳定包装看到的结果（契约上 = 上一次 commit 的实现）。 */
  renderSeen: number | null
}

/** 每次测试新建组件定义，capture 不跨实例共享，避免测试间串扰。 */
function makeProbe(): { capture: ProbeCapture; Probe: React.FunctionComponent<{ value: number }> } {
  const capture: ProbeCapture = { stable: null, layoutSeen: null, renderSeen: null }
  function Child({ stable }: { stable: (delta: number) => number }): null {
    React.useLayoutEffect(() => {
      capture.layoutSeen = stable(0)
    })
    return null
  }
  function Probe({ value }: { value: number }): React.ReactElement {
    const handler = (delta: number): number => value + delta
    const stable = useStableCallback(handler)
    capture.stable = stable
    capture.renderSeen = stable(0)
    return React.createElement(Child, { stable })
  }
  return { capture, Probe }
}

function renderValue(root: ReturnType<typeof createRoot>, Probe: React.FunctionComponent<{ value: number }>, value: number): void {
  act(() => {
    root.render(React.createElement(Probe, { value }))
  })
}

test('身份跨 render 恒定；调用转发最新实现并透传参数/返回值', { timeout: 60_000 }, () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const { capture, Probe } = makeProbe()
    renderValue(root, Probe, 1)
    const first = capture.stable!
    assert.equal(first(10), 11, '参数透传并返回实现结果')
    renderValue(root, Probe, 2)
    assert.equal(capture.stable, first, '多次重渲染包装函数身份不变')
    assert.equal(first(100), 102, '旧引用也转发到最新实现')
    renderValue(root, Probe, 3)
    assert.equal(capture.stable, first)
    assert.equal(first(0), 3)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('子组件 layoutEffect 在同一 commit 内见到本次 render 的实现', { timeout: 60_000 }, () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const { capture, Probe } = makeProbe()
    renderValue(root, Probe, 1)
    assert.equal(capture.layoutSeen, 1, '首挂：layout effect 在插入 effect 之后运行')
    renderValue(root, Probe, 2)
    assert.equal(capture.layoutSeen, 2, '更新 commit：子 layout effect 已见到本次实现而非上次')
    renderValue(root, Probe, 3)
    assert.equal(capture.layoutSeen, 3)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('渲染期调用见到上一次 commit 的实现（memo factory 不可替换的根因）', { timeout: 60_000 }, () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const { capture, Probe } = makeProbe()
    renderValue(root, Probe, 1)
    assert.equal(capture.renderSeen, 1, '首渲染 ref 初始化为本次实现')
    renderValue(root, Probe, 2)
    assert.equal(capture.renderSeen, 1, '渲染期调用停留在上一次 commit（插入 effect 尚未运行）')
    renderValue(root, Probe, 3)
    assert.equal(capture.renderSeen, 2)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('实例级隔离：卸载后的旧包装不指向新实例，无模块级缓存串扰', { timeout: 60_000 }, () => {
  const hostA = document.createElement('div')
  document.body.appendChild(hostA)
  const rootA = createRoot(hostA)
  const probeA = makeProbe()
  renderValue(rootA, probeA.Probe, 1)
  const stableA = probeA.capture.stable!
  act(() => rootA.unmount())
  hostA.remove()

  const hostB = document.createElement('div')
  document.body.appendChild(hostB)
  const rootB = createRoot(hostB)
  const probeB = makeProbe()
  renderValue(rootB, probeB.Probe, 99)
  const stableB = probeB.capture.stable!
  try {
    assert.notEqual(stableA, stableB, '每个实例各自的包装函数')
    assert.equal(stableA(0), 1, '旧包装只指向 A 实例最后一次 commit 的实现')
    assert.equal(stableB(0), 99, '新实例不受旧实例残留影响')
    assert.equal(probeB.capture.layoutSeen, 99, 'B 正常工作')
  } finally {
    act(() => rootB.unmount())
    hostB.remove()
  }
})
