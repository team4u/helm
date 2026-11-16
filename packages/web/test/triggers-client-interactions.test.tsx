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
import { PluginClientContext } from '@helm/plugin-client'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

interface Components {
  TriggersManagerScreen: (p: Partial<ScreenProps> & { inlineDrawer?: boolean }) => React.ReactElement
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

test('manager screen：cron 行动作立即触发 / 删除；在途时统一禁用全部行按钮', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  let release: (() => void) | undefined
  spy.callAction = async (actionId, input) => {
    spy.actionCalls.push({ actionId, input })
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {}
  }
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
    // 在途期间：同一守卫的全部行按钮统一 disabled，不出现「看似可点实际无动作」
    const allRowButtons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.includes('立即触发') || b.textContent?.includes('删除'),
    )
    assert.equal(allRowButtons.length, 5, 'cron 2行×2 + webhook 1行×1 = 5 个行按钮')
    for (const b of allRowButtons) {
      assert.equal(b.disabled, true, `在途时行按钮统一禁用：${b.textContent}`)
    }
    // 恢复后重新可点
    await act(async () => {
      release?.()
    })
    for (const b of allRowButtons) {
      assert.equal(b.disabled, false, `完成后恢复可点：${b.textContent}`)
    }
    const del = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.includes('删除'))
    await act(async () => {
      del[0]!.click()
    })
    assert.deepEqual(spy.actionCalls[1], { actionId: 'cron_delete', input: { id: 'daily-report' } }, '触发 cron_delete')
    await act(async () => {
      release?.()
    })
    await act(async () => {
      del[2]!.click()
    })
    assert.deepEqual(spy.actionCalls[2], { actionId: 'webhook_delete', input: { id: 'ci' } }, '触发 webhook_delete')
    await act(async () => {
      release?.()
    })
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
    const errCallout = host.querySelector('.callout.callout-error')
    assert.ok(errCallout, '动作失败必须渲染统一 .callout-error 原语')
  } finally {
    unmount()
  }
})

test('manager screen：Screen .screen-heading 排版，点击 Cron / Webhook 行打开右侧详情抽屉', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {}, inlineDrawer: true }),
  )
  try {
    const heading = host.querySelector('.screen-header .screen-heading')
    assert.ok(heading, 'Screen 页头必须使用 .screen-heading 紧致组排')

    const brokenRow = Array.from(host.querySelectorAll('tbody tr')).find((tr) =>
      tr.textContent?.includes('broken'),
    )
    assert.ok(brokenRow, '应存在 broken cron 行')
    await act(async () => {
      brokenRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})

    const dialog = host.querySelector('[role="dialog"].primary-drawer-content')
    assert.ok(dialog, '点击行应展开右侧 540px 详情抽屉')
    assert.match(dialog.textContent ?? '', /broken/)
    assert.match(dialog.textContent ?? '', /0 \* \* \* \*/)
    assert.match(dialog.textContent ?? '', /失败任务/)
    assert.ok(dialog.querySelector('.callout.callout-error'), '抽屉内最近错误应使用 .callout-error')

    const closeBtn = dialog.querySelector('button.tg-drawer-close.btn-icon-sm')
    assert.ok(closeBtn, '抽屉右上角关闭按钮应具备 .tg-drawer-close.btn-icon-sm')
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.ok(host.querySelector('[role="dialog"].primary-drawer-content') === null, '关闭按钮应收起抽屉')

    const webhookRow = Array.from(host.querySelectorAll('tbody tr')).find((tr) =>
      tr.textContent?.includes('ci/main'),
    )
    assert.ok(webhookRow)
    await act(async () => {
      webhookRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    const whDialog = host.querySelector('[role="dialog"].primary-drawer-content')
    assert.ok(whDialog, '点击 Webhook 行应展开详情抽屉')
    assert.match(whDialog.textContent ?? '', /CI 构建/)
    assert.doesNotMatch(whDialog.textContent ?? '', /hasSecret/, '抽屉同样不得暴露 hasSecret 内部键名')
  } finally {
    unmount()
  }
})

test('静态规范契约：triggers/client/index.tsx 零 Emoji、无原生 <select>、保 Fast Refresh', { timeout: 60_000 }, async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const srcPath = fileURLToPath(new URL('../../plugins/src/triggers/client/index.tsx', import.meta.url))
  const src = readFileSync(srcPath, 'utf-8')
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

  assert.doesNotMatch(src, emojiRegex, 'triggers/client/index.tsx 严禁包含 Emoji')
  assert.ok(!/<select[\s>]/i.test(src), 'triggers/client/index.tsx 严禁使用原生 <select>')
  assert.ok(!src.includes('callout--'), 'triggers/client/index.tsx 不得残留 callout--* 旧类')
  assert.ok(!src.includes("from 'lucide-react'"), '应统一使用 @helm/plugin-client HelmIcon')
  const exports = src.match(/^export (?!interface|type)\s+(\w+)\s+([A-Za-z0-9_]+)/gm) ?? []
  assert.ok(
    exports.every((exp) => exp.includes('function TriggersManagerScreen') || exp.includes('function TriggersSettingsPanel')),
    'triggers/client/index.tsx 只导出 React 组件与 TS 类型以保证 Fast Refresh',
  )
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
