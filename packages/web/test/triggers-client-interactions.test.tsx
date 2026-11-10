/**
 * builtin:triggers 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：manager screen（cron / webhook 管理表、行动作 trigger/delete、空态与
 * 加载态、secret 提示文案）与 settingsPanel（计数、CLI 引导、管理入口导航）。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PluginClientContext as PluginClientContextType, ScreenProps } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface Components {
  TriggersManagerScreen: (p: Partial<ScreenProps>) => React.ReactElement
  TriggersSettingsPanel: () => React.ReactElement
}

let components: Components

before(async () => {
  const mod = await importBuiltinClientModule('builtin:triggers')
  components = {
    TriggersManagerScreen: mod['TriggersManagerScreen'] as Components['TriggersManagerScreen'],
    TriggersSettingsPanel: mod['TriggersSettingsPanel'] as Components['TriggersSettingsPanel'],
  }
}, { timeout: 60_000 })

interface SpyCtx extends PluginClientContextType {
  screenCalls: string[]
  actionCalls: Array<{ actionId: string; input: unknown }>
}

function makeSpyCtx(): SpyCtx {
  const screenCalls: string[] = []
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:triggers',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: (t) => {
      screenCalls.push(t)
    },
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
  return Object.assign(base, { screenCalls, actionCalls })
}

async function mount(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, element))
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

const CRONS_DOC = {
  version: 1,
  jobs: [
    { id: 'daily-report', schedule: '0 9 * * *', text: '生成日报', enabled: true, timezone: 'UTC', catchUp: false, lastRunAt: 1_800_000_000_000, nextRunAt: 1_800_086_400_000 },
    { id: 'broken', schedule: '0 * * * *', text: '失败任务', enabled: false, timezone: 'UTC', catchUp: false, lastError: '投递失败：目标会话不存在' },
  ],
}

const WEBHOOKS_DOC = {
  webhooks: [
    { id: 'ci', hasSecret: true, description: 'CI 构建', threadKey: 'ci/main', createdAt: 1_800_000_000_000 },
  ],
}

before(() => {
  setBuiltinClientStub({ docs: { crons: CRONS_DOC, webhooks: WEBHOOKS_DOC } })
})

test('manager screen：cron 表渲染行、状态徽章与错误列', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
  )
  try {
    assert.match(host.textContent ?? '', /触发器管理/, '标题')
    assert.match(host.textContent ?? '', /Cron 定时任务/, 'cron 区块')
    assert.match(host.textContent ?? '', /daily-report/, 'cron 行 id')
    assert.match(host.textContent ?? '', /生成日报/, 'cron 指令')
    assert.match(host.textContent ?? '', /启用/, '启用徽章')
    assert.match(host.textContent ?? '', /停用/, '停用徽章')
    assert.match(host.textContent ?? '', /投递失败：目标会话不存在/, '最近错误')
    assert.match(host.textContent ?? '', /Cron 2 · Webhook 1/, '统计')
  } finally {
    unmount()
  }
})

test('manager screen：cron 行动作立即触发 / 删除', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
  )
  try {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('立即触发'))
    assert.ok(trigger, '立即触发按钮')
    await act(async () => {
      trigger!.click()
    })
    assert.deepEqual(spy.actionCalls[0], { actionId: 'cron_trigger', input: { id: 'daily-report' } }, '触发 cron_trigger')
    const del = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.includes('删除'))
    assert.equal(del.length, 3, 'cron 2 行删除 + webhook 1 行删除')
    await act(async () => {
      del[0]!.click()
    })
    assert.deepEqual(spy.actionCalls[1], { actionId: 'cron_delete', input: { id: 'daily-report' } }, '触发 cron_delete')
    await act(async () => {
      del[2]!.click()
    })
    assert.deepEqual(spy.actionCalls[2], { actionId: 'webhook_delete', input: { id: 'ci' } }, '触发 webhook_delete')
  } finally {
    unmount()
  }
})

test('manager screen：webhook 表渲染与 secret 边界提示', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
  )
  try {
    assert.match(host.textContent ?? '', /Webhook 端点/, 'webhook 区块')
    assert.match(host.textContent ?? '', /ci/, 'webhook id')
    assert.match(host.textContent ?? '', /CI 构建/, '描述')
    assert.match(host.textContent ?? '', /ci\/main/, 'threadKey')
    assert.match(host.textContent ?? '', /secret 不在文档中展示/, 'secret 边界提示')
    assert.doesNotMatch(host.textContent ?? '', /hasSecret/, '布尔协作字段不进展示')
  } finally {
    unmount()
  }
})

test('manager screen：doc 未到达展示加载态、空 doc 展示空表', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { crons: undefined, webhooks: undefined } })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      assert.match(host.textContent ?? '', /Cron 任务读取中/, 'cron 加载态')
      assert.match(host.textContent ?? '', /Webhook 端点读取中/, 'webhook 加载态')
    } finally {
      unmount()
    }
    setBuiltinClientStub({ docs: { crons: { version: 1, jobs: [] }, webhooks: { webhooks: [] } } })
    const { host: host2, unmount: unmount2 } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      assert.match(host2.textContent ?? '', /暂无数据/, '空表如实展示')
      assert.doesNotMatch(host2.textContent ?? '', /读取中/, '空 doc 不残留加载态')
    } finally {
      unmount2()
    }
  } finally {
    setBuiltinClientStub({ docs: { crons: CRONS_DOC, webhooks: WEBHOOKS_DOC } })
  }
})

test('manager screen：动作失败显式展示错误不静默', { timeout: 60_000 }, async () => {
  const failing = makeSpyCtx()
  failing.callAction = async () => {
    throw new Error('目标会话不存在')
  }
  const { host, unmount } = await mount(
    failing,
    e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
  )
  try {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('立即触发'))
    await act(async () => {
      trigger!.click()
    })
    await act(async () => {})
    assert.match(host.textContent ?? '', /cron_trigger 失败：目标会话不存在/, '错误显式展示')
  } finally {
    unmount()
  }
})

test('settingsPanel：计数、CLI 引导与打开管理入口', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy, e(components.TriggersSettingsPanel, {}))
  try {
    assert.match(host.textContent ?? '', /触发器/, '标题')
    assert.match(host.textContent ?? '', /Cron 任务数/, 'KV 键')
    assert.match(host.textContent ?? '', /Webhook 端点数/, 'KV 键')
    assert.match(host.textContent ?? '', /helm CLI/, 'CLI 引导文案')
    const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('打开触发器管理'))
    assert.ok(open, '管理入口按钮')
    await act(async () => {
      open!.click()
    })
    assert.deepEqual(spy.screenCalls, ['screen:builtin:triggers/manager'], '入口导航到管理视图')
  } finally {
    unmount()
  }
})
