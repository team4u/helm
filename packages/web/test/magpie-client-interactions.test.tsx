/**
 * builtin:magpie 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：settingsPanel（状态概览 KV、诊断 / 配额 / 路由三表、缓存计数标注、
 * 刷新动作与失败显式错误、加载态与空态）。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PluginClientContext as PluginClientContextType } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let MagpieSettingsPanel: () => React.ReactElement

before(async () => {
  const mod = await importBuiltinClientModule('builtin:magpie')
  MagpieSettingsPanel = mod['MagpieSettingsPanel'] as () => React.ReactElement
}, { timeout: 60_000 })

interface SpyCtx extends PluginClientContextType {
  actionCalls: Array<{ actionId: string; input: unknown }>
}

function makeSpyCtx(): SpyCtx {
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:magpie',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
  }
  return Object.assign(base, { actionCalls })
}

async function mount(
  ctx: PluginClientContextType,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, e(MagpieSettingsPanel, {})))
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

const STATUS_DOC = {
  gatewayUrl: 'http://127.0.0.1:3425',
  configuredRoot: false,
  local: true,
  reachable: true,
  modelCount: 12,
  groupCount: 2,
  lastRefreshedAt: 1_800_000_000_000,
  summaryText: 'Magpie · 12 模型',
  quotas: [
    { provider: 'opencode-go', account: 'team', windowLabel: '5h', remainingPercent: 16, resetText: '3h' },
    { provider: 'moonshot', windowLabel: 'daily', remainingPercent: 60 },
  ],
  routes: [
    { group: 'relay', strategy: 'round-robin', provider: 'opencode-go', model: 'glm-4.7', timestamp: '2026-11-10T12:00:00Z' },
  ],
  diagnostics: [],
}

before(() => {
  setBuiltinClientStub({ docs: { status: STATUS_DOC } })
})

test('状态概览：KV 网关地址 / 可达 / 模型数 / 路由组数 / 最近刷新', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    assert.match(host.textContent ?? '', /Magpie 网关/, '标题')
    assert.match(host.textContent ?? '', /Magpie · 12 模型/, 'summaryText')
    assert.match(host.textContent ?? '', /http:\/\/127\.0\.0\.1:3425/, '网关地址')
    assert.match(host.textContent ?? '', /本机 loopback/, 'KV 键')
    assert.match(host.textContent ?? '', /模型数/, '可达时模型数不带缓存标注')
    assert.match(host.textContent ?? '', /路由组数/, 'KV 键')
    assert.doesNotMatch(host.textContent ?? '', /模型数（缓存）/, 'reachable=true 不标注缓存')
    assert.doesNotMatch(host.textContent ?? '', /最近错误/, '无错误时不渲染最近错误行')
  } finally {
    unmount()
  }
})

test('配额与路由轨迹表渲染（窗口 / 剩余 / 重置 / 命中模型）', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    assert.match(host.textContent ?? '', /诊断/, '诊断区块标题')
    assert.match(host.textContent ?? '', /无诊断信息/, '空诊断如实展示')
    assert.match(host.textContent ?? '', /配额/, '配额区块标题')
    assert.match(host.textContent ?? '', /opencode-go/, '配额 provider')
    assert.match(host.textContent ?? '', /5h/, '窗口列')
    assert.match(host.textContent ?? '', /3h/, '重置列')
    assert.match(host.textContent ?? '', /moonshot/, '第二行 provider')
    assert.match(host.textContent ?? '', /路由轨迹/, '路由区块标题')
    assert.match(host.textContent ?? '', /relay/, '路由组')
    assert.match(host.textContent ?? '', /round-robin/, '策略')
    assert.match(host.textContent ?? '', /glm-4\.7/, '命中模型')
  } finally {
    unmount()
  }
})

test('reachable=false 时模型数标注缓存、lastError 与诊断如实展示', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({
    docs: {
      status: {
        ...STATUS_DOC,
        reachable: false,
        modelCount: 5,
        summaryText: 'Magpie · 未连接',
        lastError: 'connect ECONNREFUSED',
        diagnostics: ['配额不可用：timeout'],
      },
    },
  })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy)
    try {
      assert.match(host.textContent ?? '', /模型数（缓存）/, '不可达时标注缓存计数')
      assert.match(host.textContent ?? '', /connect ECONNREFUSED/, 'lastError 如实展示')
      assert.match(host.textContent ?? '', /配额不可用：timeout/, '诊断如实展示')
      assert.match(host.textContent ?? '', /Magpie · 未连接/, 'summaryText 未连接')
    } finally {
      unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('刷新按钮触发 refresh 动作；失败显式展示错误', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('刷新模型目录'))
    assert.ok(refresh, '刷新按钮存在')
    await act(async () => {
      refresh!.click()
    })
    assert.deepEqual(
      spy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'refresh', input: {} }],
      '点击触发 refresh 动作',
    )
  } finally {
    unmount()
  }
  const failing = makeSpyCtx()
  failing.callAction = async () => {
    throw new Error('网关不可达')
  }
  const { host: host2, unmount: unmount2 } = await mount(failing)
  try {
    const refresh = [...host2.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('刷新'))
    await act(async () => {
      refresh!.click()
    })
    await act(async () => {})
    assert.match(host2.textContent ?? '', /网关不可达/, '刷新失败显式展示错误')
  } finally {
    unmount2()
  }
})

test('doc 未到达展示加载态、空 doc 展示空表', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { status: undefined } })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy)
    try {
      assert.match(host.textContent ?? '', /网关状态读取中/, '加载态展示')
    } finally {
      unmount()
    }
    setBuiltinClientStub({ docs: { status: { ...STATUS_DOC, quotas: [], routes: [], diagnostics: [], summaryText: '' } } })
    const { host: host2, unmount: unmount2 } = await mount(spy)
    try {
      assert.match(host2.textContent ?? '', /暂无配额数据/, '空配额如实展示')
      assert.match(host2.textContent ?? '', /暂无路由记录/, '空路由如实展示')
      assert.match(host2.textContent ?? '', /无诊断信息/, '空诊断如实展示')
      assert.doesNotMatch(host2.textContent ?? '', /读取中/, '空 doc 不残留加载态')
    } finally {
      unmount2()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})
