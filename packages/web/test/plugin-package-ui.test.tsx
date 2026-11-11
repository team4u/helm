/**
 * 插件包管理 Web 交互测试 (plugin-package-ui)
 *
 * 覆盖：
 * 1. PluginInstallModal：来源识别提示联动、安装请求（source/enable body）、
 *    安装成功导航至新插件、失败展示错误与 doctor 结构化检查结果、安装中禁重复；
 * 2. PluginDetailDrawer：managed 受管元数据展示、更新/卸载操作与互斥、
 *    卸载 AlertDialog 确认、409 在途任务诊断、卸载成功关闭抽屉并刷新；
 *    内置或未受管插件不展示包管理区块；
 * 3. PluginCenter：安装成功后列表刷新（syncPlugins）与详情抽屉联动。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

;(globalThis as Record<string, unknown>).React = React

import type {
  PluginInstallResult,
  PluginRemoveResult,
  PluginSummary,
  PluginUpdateResult,
} from '@helm/protocol'
import { ApiClientError, pluginsApi } from '../src/lib/api.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement

function typeIntoInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function makeManagedPlugin(partial: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'my-plugin',
    name: '我的外部插件',
    version: '1.0.0',
    locked: false,
    enabled: false,
    hooks: [],
    actions: [],
    tools: [],
    managed: {
      source: { kind: 'npm', raw: 'npm:my-plugin@1.0.0', spec: 'my-plugin@1.0.0' },
      installId: 'rec-1',
      installedVersion: '1.0.0',
      installedAt: Date.UTC(2026, 0, 15, 8, 30, 0),
    },
    ...partial,
  }
}

function installResult(pluginId: string): PluginInstallResult {
  return {
    record: {
      id: 'rec-1',
      pluginId,
      source: { kind: 'npm', raw: `npm:${pluginId}@1.0.0`, spec: `${pluginId}@1.0.0` },
      installPath: `/data/plugins/${pluginId}`,
      version: '1.0.0',
      installedAt: Date.now(),
      updatedAt: Date.now(),
    },
    summary: makeManagedPlugin({ id: pluginId }),
  }
}

// ---------------------------------------------------------------------------
// 1. PluginInstallModal：SSR 结构与来源识别
// ---------------------------------------------------------------------------

test('PluginInstallModal：SSR 渲染安全提示、来源输入与安装后启用开关', { timeout: 60_000 }, async () => {
  const { PluginInstallModal } = await import('../src/plugins/PluginInstallModal.js')
  const html = renderToString(e(PluginInstallModal, { open: true, onClose: () => {}, onInstalled: () => {}, inline: true }))
  assert.match(html, /安装插件/)
  assert.match(html, /Hub 进程内运行/)
  assert.match(html, /不是沙箱/)
  assert.match(html, /安装后启用/)
  assert.match(html, /modal-backdrop/, 'SSR 输出必须包含遮罩层容器')
  assert.match(html, /plugin-install-modal/, 'SSR 输出必须包含安装模态容器')
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('PluginInstallModal：输入旁来源识别提示随输入实时变化', { timeout: 60_000 }, async () => {
  const { PluginInstallModal } = await import('../src/plugins/PluginInstallModal.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  try {
    await act(async () => {
      root.render(e(PluginInstallModal, { open: true, onClose: () => {}, onInstalled: () => {}, inline: true }))
    })

    const backdropModal = host.querySelector('.modal-backdrop .plugin-install-modal')
    assert.ok(backdropModal, '安装模态必须置于 .modal-backdrop 内部以支持居中对齐与全屏遮罩')

    const input = host.querySelector<HTMLInputElement>('#plugin-install-source')
    assert.ok(input, '必须存在来源输入框')

    await act(async () => { typeIntoInput(input, 'npm:pkg@1.0.0') })
    let hint = host.querySelector('.plugin-source-hint')
    assert.equal(hint?.getAttribute('data-source-kind'), 'npm')
    assert.match(hint?.textContent ?? '', /npm 包/)

    await act(async () => { typeIntoInput(input, '/abs/path') })
    hint = host.querySelector('.plugin-source-hint')
    assert.equal(hint?.getAttribute('data-source-kind'), 'local')

    await act(async () => { typeIntoInput(input, 'garbage') })
    hint = host.querySelector('.plugin-source-hint')
    assert.equal(hint?.getAttribute('data-source-kind'), 'unknown')
    assert.match(hint?.className, /is-unknown/)

    // 未识别来源时安装按钮禁用
    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('安装') && !b.textContent?.includes('安装后') && !b.textContent?.includes('安装插件包') && b.className.includes('btn-primary'))
    assert.ok(submitBtn)
    assert.equal(submitBtn.disabled, true)
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 2. PluginInstallModal：安装请求 body 与成功导航
// ---------------------------------------------------------------------------

test('PluginInstallModal：安装请求携带 source 与 enable，成功后回调并关闭', { timeout: 60_000 }, async () => {
  const { PluginInstallModal } = await import('../src/plugins/PluginInstallModal.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalInstall = pluginsApi.install
  let capturedSource = ''
  let capturedEnable: boolean | undefined
  let installedId: string | null = null
  let closeCount = 0

  pluginsApi.install = async (source: string, enable?: boolean) => {
    capturedSource = source
    capturedEnable = enable
    return installResult('my-plugin')
  }

  try {
    await act(async () => {
      root.render(
        e(PluginInstallModal, {
          open: true,
          onClose: () => { closeCount++ },
          onInstalled: (id) => { installedId = id },
          inline: true,
        }),
      )
    })

    const input = host.querySelector<HTMLInputElement>('#plugin-install-source')
    assert.ok(input, '模态内必须存在来源输入框')
    await act(async () => { typeIntoInput(input, 'npm:my-plugin@1.0.0') })

    // 切换「安装后启用」开关（role=switch）
    const switchBtn = host.querySelector<HTMLButtonElement>('button[role="switch"]')
    assert.ok(switchBtn, '必须存在安装后启用开关')
    await act(async () => {
      switchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('安装') && b.className.includes('btn-primary'))
    assert.ok(submitBtn)
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(capturedSource, 'npm:my-plugin@1.0.0')
    assert.equal(capturedEnable, true)
    assert.equal(installedId, 'my-plugin')
    assert.ok(closeCount >= 1, '成功后必须关闭模态')
  } finally {
    pluginsApi.install = originalInstall
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('PluginInstallModal：默认不启用（enable 不上送），失败展示错误诊断', { timeout: 60_000 }, async () => {
  const { PluginInstallModal } = await import('../src/plugins/PluginInstallModal.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalInstall = pluginsApi.install
  let capturedEnable: boolean | undefined

  pluginsApi.install = async (_source: string, enable?: boolean) => {
    capturedEnable = enable
    throw new ApiClientError('install_failed', 'registry unreachable', 502)
  }

  try {
    await act(async () => {
      root.render(e(PluginInstallModal, { open: true, onClose: () => {}, onInstalled: () => {}, inline: true }))
    })

    const backdropModal = host.querySelector('.modal-backdrop .plugin-install-modal')
    assert.ok(backdropModal, '安装模态必须置于 .modal-backdrop 内部以支持居中对齐与全屏遮罩')

    const input = host.querySelector<HTMLInputElement>('#plugin-install-source')
    assert.ok(input, '模态内必须存在来源输入框')
    await act(async () => { typeIntoInput(input, 'git:https://github.com/u/r.git@main') })

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('安装') && b.className.includes('btn-primary'))
    assert.ok(submitBtn, '必须存在提交安装按钮')
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // enable 默认关闭：上送 false，请求体不带 enable 字段（api 层仅在 true 时携带）
    assert.equal(capturedEnable, false)
    const callout = host.querySelector('.callout--error')
    assert.ok(callout, '失败必须展示错误提示')
    assert.match(callout.textContent ?? '', /registry unreachable/)
  } finally {
    pluginsApi.install = originalInstall
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('PluginInstallModal：真实 Hub 422 失败时从 details.report 结构化渲染 doctor 检查', { timeout: 60_000 }, async () => {
  const { PluginInstallModal } = await import('../src/plugins/PluginInstallModal.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalInstall = pluginsApi.install

  pluginsApi.install = async () => {
    // 真实 Hub 安装预检失败形状：报告在 HelmError.details.report，
    // 经 HTTP 错误信封解析为 ApiClientError.details.report
    throw new ApiClientError(
      'plugin_package_doctor_failed',
      '插件包安装预检失败（后端加载：dist/index.js 不存在），已放弃安装',
      422,
      {
        source: { kind: 'local', raw: '/plugins/foo', path: '/plugins/foo' },
        staging: '/data/plugins/.staging/abc',
        report: {
          dir: '/data/plugins/.staging/abc',
          ok: false,
          checks: [
            { id: 'manifest', label: '清单检查' },
            { id: 'backend', label: '后端加载', error: { code: 'entry_missing', message: 'dist/index.js 不存在' } },
          ],
        },
      },
    )
  }

  try {
    await act(async () => {
      root.render(e(PluginInstallModal, { open: true, onClose: () => {}, onInstalled: () => {}, inline: true }))
    })

    const backdropModal = host.querySelector('.modal-backdrop .plugin-install-modal')
    assert.ok(backdropModal, '安装模态必须置于 .modal-backdrop 内部以支持居中对齐与全屏遮罩')

    const input = host.querySelector<HTMLInputElement>('#plugin-install-source')
    assert.ok(input, '模态内必须存在来源输入框')
    await act(async () => { typeIntoInput(input, '/plugins/foo') })

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('安装') && b.className.includes('btn-primary'))
    assert.ok(submitBtn, '必须存在提交安装按钮')
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const doctorBox = host.querySelector('.plugin-install-doctor')
    assert.ok(doctorBox, '真实 422 失败时必须从 details.report 渲染 doctor 检查结果区块')
    assert.equal(doctorBox.getAttribute('data-doctor-ok'), 'false')
    const checks = doctorBox.querySelectorAll('.plugin-doctor-check')
    assert.equal(checks.length, 2)
    assert.equal(checks[0]?.classList.contains('is-failed'), false, 'manifest 通过项不带失败态')
    assert.equal(checks[1]?.classList.contains('is-failed'), true)
    assert.match(doctorBox.textContent ?? '', /清单检查/)
    assert.match(doctorBox.textContent ?? '', /entry_missing: dist\/index\.js 不存在/)
  } finally {
    pluginsApi.install = originalInstall
    await act(async () => { root.unmount() })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 3. PluginDetailDrawer：受管包元数据与更新/卸载
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：managed 受管插件展示来源徽章、来源原文与包管理操作', { timeout: 60_000 }, async () => {
  const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')
  const plugin = makeManagedPlugin()

  const html = renderToString(
    e(PluginDetailDrawer, {
      plugin,
      open: true,
      inline: true,
      onClose: () => {},
      onToggleEnabled: async () => {},
      toggling: false,
    }),
  )

  assert.match(html, /包管理/)
  assert.match(html, /npm:my-plugin@1\.0\.0/)
  assert.match(html, /data-source-kind="npm"/)
  assert.match(html, /检查更新/)
  assert.match(html, /卸载插件/)
})

test('PluginDetailDrawer：内置或未受管插件不展示包管理区块', { timeout: 60_000 }, async () => {
  const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')

  const builtin: PluginSummary = {
    id: 'builtin:workflow', name: '工作流引擎', version: '1.2.0', locked: false, enabled: true,
    hooks: [], actions: [], tools: [],
  }
  const html = renderToString(
    e(PluginDetailDrawer, {
      plugin: builtin, open: true, inline: true,
      onClose: () => {}, onToggleEnabled: async () => {}, toggling: false,
    }),
  )
  assert.doesNotMatch(html, /包管理/)
  assert.doesNotMatch(html, /卸载插件/)
})

test('PluginDetailDrawer：更新操作调用 update 并回调刷新，changed=false 如实回显', { timeout: 60_000 }, async () => {
  const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalGetConfig = pluginsApi.getConfig
  const originalUpdate = pluginsApi.update
  let updatedId = ''
  let packageChangedCount = 0

  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })
  pluginsApi.update = async (id: string): Promise<PluginUpdateResult> => {
    updatedId = id
    return {
      record: {
        id: 'rec-1', pluginId: id,
        source: { kind: 'npm', raw: 'npm:my-plugin@1.0.0', spec: 'my-plugin@1.0.0' },
        installPath: '/data/plugins/my-plugin', version: '1.0.0',
        installedAt: Date.now(), updatedAt: Date.now(),
      },
      summary: makeManagedPlugin(),
      changed: false,
      previousVersion: '1.0.0',
    }
  }

  const notices: Array<{ title: string; body?: string }> = []
  const store = makeTestStore({ pushNotice: (n) => notices.push(n) })

  try {
    await act(async () => {
      root.render(
        e(HelmStoreContext.Provider, { value: store },
          e(PluginDetailDrawer, {
            plugin: makeManagedPlugin(), open: true, inline: true,
            onClose: () => {}, onToggleEnabled: async () => {}, toggling: false,
            onPackageChanged: () => { packageChangedCount++ },
          })),
      )
    })

    const updateBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('检查更新'))
    assert.ok(updateBtn, '受管插件必须提供更新按钮')

    await act(async () => {
      updateBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(updatedId, 'my-plugin')
    assert.equal(packageChangedCount, 1, '更新成功后必须请求列表刷新')
    assert.equal(notices.length, 1)
    assert.match(notices[0]?.body ?? '', /源未变化/, 'changed=false 时如实回显未变更')
  } finally {
    pluginsApi.getConfig = originalGetConfig
    pluginsApi.update = originalUpdate
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('PluginDetailDrawer：卸载需 AlertDialog 确认，成功后关闭抽屉并刷新列表', { timeout: 60_000 }, async () => {
  const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalGetConfig = pluginsApi.getConfig
  const originalRemove = pluginsApi.remove
  let removedId = ''
  let closeCount = 0
  let packageChangedCount = 0

  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })
  pluginsApi.remove = async (id: string): Promise<PluginRemoveResult> => {
    removedId = id
    return { pluginId: id, installPath: '/data/plugins/my-plugin', wasEnabled: false, installId: 'rec-1' }
  }

  try {
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: makeManagedPlugin({ enabled: true }), open: true, inline: true,
          onClose: () => { closeCount++ },
          onToggleEnabled: async () => {}, toggling: false,
          onPackageChanged: () => { packageChangedCount++ },
          onRemoved: () => { closeCount++ },
        }),
      )
    })

    // 1. 卸载按钮打开 AlertDialog 确认
    const removeBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('卸载插件'))
    assert.ok(removeBtn, '受管插件必须提供卸载按钮')
    await act(async () => {
      removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const confirmBox = host.querySelector('[role="alertdialog"]')
    assert.ok(confirmBox, '必须弹出卸载确认 AlertDialog')
    const confirmModal = host.querySelector('.modal-backdrop .plugin-remove-confirm')
    assert.ok(confirmModal, '卸载确认框必须置于 .modal-backdrop 内部以支持居中对齐与全屏遮罩')
    assert.match(confirmBox.textContent ?? '', /不可恢复/)
    assert.equal(removedId, '', '未确认前不得发起移除请求')

    // 2. 确认卸载
    const confirmBtn = Array.from(confirmBox.querySelectorAll('button')).find((b) => b.textContent?.includes('确认卸载'))
    assert.ok(confirmBtn, '确认框必须包含确认卸载按钮')
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(removedId, 'my-plugin')
    assert.ok(closeCount >= 1, '卸载成功后必须关闭抽屉')
    assert.equal(packageChangedCount, 1, '卸载成功后必须刷新列表')
  } finally {
    pluginsApi.getConfig = originalGetConfig
    pluginsApi.remove = originalRemove
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('PluginDetailDrawer：卸载 409 在途任务展示清晰诊断，不关闭抽屉', { timeout: 60_000 }, async () => {
  const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalGetConfig = pluginsApi.getConfig
  const originalRemove = pluginsApi.remove

  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })
  pluginsApi.remove = async () => {
    throw new ApiClientError('plugin_has_live_tasks', 'Plugin has live tasks', 409)
  }

  let removedCallbackCount = 0

  try {
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: makeManagedPlugin(), open: true, inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {}, toggling: false,
          onRemoved: () => { removedCallbackCount++ },
        }),
      )
    })

    const removeBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('卸载插件'))
    assert.ok(removeBtn, '受管插件必须提供卸载按钮')
    await act(async () => {
      removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const confirmBox = host.querySelector('[role="alertdialog"]')
    assert.ok(confirmBox, '必须弹出卸载确认 AlertDialog')
    const confirmBtn = Array.from(confirmBox.querySelectorAll('button')).find((b) => b.textContent?.includes('确认卸载'))
    assert.ok(confirmBtn, '确认框必须包含确认卸载按钮')
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const callout = host.querySelector('.callout--error')
    assert.ok(callout, '409 时必须展示诊断提示')
    assert.match(callout.textContent ?? '', /plugin_has_live_tasks/)
    assert.match(callout.textContent ?? '', /在途任务/)
    assert.equal(removedCallbackCount, 0, '失败时不得触发关闭抽屉回调')
    assert.ok(host.querySelector('.plugin-drawer-content'), '失败后抽屉保持展开')
  } finally {
    pluginsApi.getConfig = originalGetConfig
    pluginsApi.remove = originalRemove
    await act(async () => { root.unmount() })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 4. PluginCenter 集成：安装成功后刷新列表并选中新插件进入详情抽屉
// ---------------------------------------------------------------------------

test('PluginCenter 集成：安装成功后 syncPlugins 刷新列表并导航至新插件详情抽屉', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const originalInstall = pluginsApi.install
  const originalList = pluginsApi.list

  const builtinPlugin: PluginSummary = {
    id: 'builtin:profile', name: '个人助理', version: '1.0.0', locked: true, enabled: true,
    hooks: [], actions: [], tools: [],
  }
  let serverPlugins: PluginSummary[] = [builtinPlugin]
  const syncedLists: PluginSummary[][] = []
  const openedTargets: unknown[] = []

  pluginsApi.install = async () => installResult('my-plugin')
  pluginsApi.list = async () => serverPlugins

  const store = makeTestStore({
    plugins: [builtinPlugin],
    primaryTarget: { kind: 'plugins' },
    openTarget: (target) => { openedTargets.push(target) },
    syncPlugins: (list) => { syncedLists.push(list); store.plugins = list },
  })

  try {
    await act(async () => {
      root.render(e(HelmStoreContext.Provider, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    // 打开安装模态
    const installBtn = host.querySelector<HTMLButtonElement>('button[aria-label="安装插件"]')
    assert.ok(installBtn, '顶栏必须存在安装插件按钮')
    await act(async () => {
      installBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    let modal = host.querySelector('.modal-backdrop .plugin-install-modal')
    assert.ok(modal, '点击后必须在 .modal-backdrop 内部打开安装模态')

    // 服务端已注册新插件（模拟安装完成时刻的服务端状态）
    serverPlugins = [builtinPlugin, makeManagedPlugin()]

    const input = modal.querySelector<HTMLInputElement>('#plugin-install-source')
    assert.ok(input, '模态内必须存在来源输入框')
    await act(async () => { typeIntoInput(input, 'npm:my-plugin@1.0.0') })

    const submitBtn = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('安装') && b.className.includes('btn-primary'))
    assert.ok(submitBtn, '必须存在提交安装按钮')
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // 成功后：导航至新插件详情 + 列表经 syncPlugins 刷新
    assert.deepEqual(openedTargets[openedTargets.length - 1], { kind: 'plugins', pluginId: 'my-plugin' })
    assert.equal(syncedLists.length, 1, '必须恰好触发一次列表刷新')
    assert.equal(syncedLists[0]?.length, 2)

    // 模态已关闭
    modal = host.querySelector('.plugin-install-modal')
    assert.equal(modal, null, '安装成功后模态必须关闭')
  } finally {
    pluginsApi.install = originalInstall
    pluginsApi.list = originalList
    await act(async () => { root.unmount() })
    host.remove()
  }
})
