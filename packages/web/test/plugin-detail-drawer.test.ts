import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../src/lib/api.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const e = React.createElement

// 动态导入待测组件
const { PluginDetailDrawer, PluginConfigForm } = await import('../src/plugins/PluginDetailDrawer.js')

// ---------------------------------------------------------------------------
// 辅助工具与 Mock 插件数据
// ---------------------------------------------------------------------------

function makePlugin(partial: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'builtin:workflow',
    name: '工作流引擎',
    version: '1.2.0',
    locked: false,
    enabled: true,
    hooks: ['before_turn', 'turn_settled'],
    actions: ['run', 'inspect'],
    tools: ['subagent', 'cleanup_worktree'],
    ...partial,
  }
}

/** 触发 React 受控 input 的 onChange 事件 */
function typeIntoInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// 1. SSR 渲染测试：抽屉元信息、常驻状态、能力清单透视与 0 Emoji 铁律
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：SSR 渲染包含抽屉主体、详细元信息、常驻状态与能力清单（Tools / Actions / Hooks）', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'builtin:workflow',
    name: '工作流引擎',
    version: '1.2.0',
    locked: true,
    enabled: true,
    tools: ['subagent', 'cleanup_worktree'],
    actions: ['run', 'inspect'],
    hooks: ['before_turn', 'turn_settled'],
  })

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

  // 1. 抽屉主体类名与 ARIA 语义
  assert.match(html, /class="[^"]*plugin-drawer-content[^"]*"/)
  assert.match(html, /role="dialog"/)

  // 2. 插件详细元信息：名称、唯一 ID、版本与常驻徽章
  assert.match(html, /工作流引擎/)
  assert.match(html, /builtin:workflow/)
  assert.match(html, /v1\.2\.0/)
  assert.match(html, /常驻/)

  // 3. 能力清单透视：Tools 清单、Actions 清单、Hooks 清单
  assert.match(html, /subagent/)
  assert.match(html, /cleanup_worktree/)
  assert.match(html, /run/)
  assert.match(html, /inspect/)
  assert.match(html, /before_turn/)
  assert.match(html, /turn_settled/)

  // 4. 启停控制与状态
  assert.match(html, /已启用/)
  assert.match(html, /停用插件/)

  // 5. 铁律：全界面 0 Emoji 表情
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('PluginDetailDrawer：当 open=false 时不渲染抽屉内容', { timeout: 60_000 }, () => {
  const plugin = makePlugin()

  const html = renderToString(
    e(PluginDetailDrawer, {
      plugin,
      open: false,
      inline: true,
      onClose: () => {},
      onToggleEnabled: async () => {},
      toggling: false,
    }),
  )

  assert.doesNotMatch(html, /class="[^"]*plugin-drawer-content[^"]*"/)
  assert.doesNotMatch(html, /工作流引擎/)
})

// ---------------------------------------------------------------------------
// 2. DOM 交互测试：关闭按钮与 Escape 退出
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：点击关闭按钮与按下 Escape 键触发 onClose 回调', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let closeCount = 0
  const plugin = makePlugin()

  await act(async () => {
    root.render(
      e(PluginDetailDrawer, {
        plugin,
        open: true,
        inline: true,
        onClose: () => {
          closeCount++
        },
        onToggleEnabled: async () => {},
        toggling: false,
      }),
    )
  })

  // 查找关闭按钮（带有 aria-label="关闭"）
  const closeBtn = container.querySelector('button[aria-label="关闭"]') as HTMLButtonElement | null
  assert.ok(closeBtn, '必须存在关闭按钮')

  await act(async () => {
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(closeCount, 1, '点击关闭按钮应触发一次 onClose')

  // 测试 Escape 键监听
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.ok(closeCount >= 2, '按下 Escape 键应触发 onClose')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 3. 启停控制测试：点击切换启停、常驻锁定与 409 在途任务处理
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：启停按钮响应用户操作并调用 onToggleEnabled', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })

  try {
    let toggledPlugin: PluginSummary | null = null
    const plugin = makePlugin({ enabled: false, locked: false })

    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async (p) => {
            toggledPlugin = p
          },
          toggling: false,
        }),
      )
    })

    // 启用按钮
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('启用插件'),
    ) as HTMLButtonElement | undefined
    assert.ok(toggleBtn, '已停用插件应展示“启用插件”按钮')
    assert.equal(toggleBtn.disabled, false, '未锁定且未 toggling 时按钮不应处于禁用态')

    await act(async () => {
      toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal((toggledPlugin as PluginSummary | null)?.id, 'builtin:workflow', '点击启用应触发 onToggleEnabled 并传递当前插件')

    // 测试常驻锁定不可停用
    const lockedPlugin = makePlugin({ enabled: true, locked: true })
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: lockedPlugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {},
          toggling: false,
        }),
      )
    })

    const lockedToggleBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('停用插件'),
    ) as HTMLButtonElement | undefined
    assert.ok(lockedToggleBtn, '已启用插件展示“停用插件”按钮')
    assert.equal(lockedToggleBtn.disabled, true, '常驻锁定插件启停按钮必须处于禁用态')

    // 测试 409 在途冲突提示
    const activePlugin = makePlugin({ enabled: true, locked: false })
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: activePlugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {
            const err = new ApiClientError('plugin_has_live_tasks', 'Plugin has live tasks', 409)
            throw err
          },
          toggling: false,
        }),
      )
    })

    const activeToggleBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('停用插件'),
    ) as HTMLButtonElement | undefined
    assert.ok(activeToggleBtn)

    await act(async () => {
      activeToggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // 验证错误提示框出现且包含在途任务解释
    const callout = container.querySelector('.callout--error')
    assert.ok(callout, '发生 409 错误时必须呈现错误提示条')
    assert.match(callout.textContent || '', /plugin_has_live_tasks/)
  } finally {
    pluginsApi.getConfig = originalGetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 4. 配置表单动态加载与保存测试
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：根据 Schema 动态加载与渲染 PluginConfigForm，支持表单保存', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  const originalSetConfig = pluginsApi.setConfig

  let savedPayload: Record<string, unknown> | null = null

  pluginsApi.getConfig = async (id: string) => {
    return {
      values: {
        timeout: 30,
        debug: true,
        apiKey: '******',
      },
      schema: {
        timeout: {
          type: 'number',
          label: '超时时间（秒）',
          description: '执行总超时设置',
        },
        debug: {
          type: 'boolean',
          label: '调试模式',
        },
        apiKey: {
          type: 'string',
          label: '访问令牌',
          secret: true,
        },
      },
    }
  }

  pluginsApi.setConfig = async (id: string, values: Record<string, unknown>) => {
    savedPayload = values
    return { ok: true }
  }

  try {
    const plugin = makePlugin({ id: 'test:custom' })

    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {},
          toggling: false,
        }),
      )
    })

    // 等待配置加载 effect 结算
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // 验证各字段生成
    const timeoutInput = container.querySelector('input[type="number"]') as HTMLInputElement | null
    assert.ok(timeoutInput, '必须生成数字配置项输入框')
    assert.equal(timeoutInput.value, '30')

    const secretInput = container.querySelector('input[type="password"]') as HTMLInputElement | null
    assert.ok(secretInput, 'Secret 字段必须生成 password 类型输入框')
    assert.equal(secretInput.value, '', '已配置的 Secret 字段初始值必须留空以防明文泄漏')

    // 查找保存按钮
    const saveBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('保存配置'),
    ) as HTMLButtonElement | undefined
    assert.ok(saveBtn, '必须存在保存配置按钮')

    // 修改输入并保存
    await act(async () => {
      typeIntoInput(timeoutInput, '60')
    })

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // 检查 setConfig 是否收到正确数据
    assert.ok(savedPayload !== null, '保存后必须调用 setConfig')
    assert.equal((savedPayload as Record<string, unknown>)['timeout'], 60)
  } finally {
    pluginsApi.getConfig = originalGetConfig
    pluginsApi.setConfig = originalSetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 5. 并发代数请求守卫测试：快速切换插件时废弃迟到的旧响应
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：快速切换插件时防并发竞争（configGeneration），迟到的旧响应不覆盖新插件视图', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig

  let resolvePluginA: ((res: PluginConfigResponse) => void) | null = null

  pluginsApi.getConfig = async (id: string) => {
    if (id === 'plugin:a') {
      return new Promise<PluginConfigResponse>((resolve) => {
        resolvePluginA = resolve
      })
    }
    return {
      values: { title: 'Plugin B Title' },
      schema: {
        title: { type: 'string', label: 'B 插件标题' },
      },
    }
  }

  try {
    const pluginA = makePlugin({ id: 'plugin:a', name: 'Plugin A' })
    const pluginB = makePlugin({ id: 'plugin:b', name: 'Plugin B' })

    // 1. 先载入插件 A（其 getConfig 挂起未决）
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: pluginA,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {},
          toggling: false,
        }),
      )
    })

    // 2. 快速切换至插件 B（其 getConfig 立即完成）
    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin: pluginB,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {},
          toggling: false,
        }),
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    // 此时页面应显示 Plugin B 的配置字段
    assert.match(container.textContent || '', /B 插件标题/)

    // 3. 此时插件 A 的慢请求才到达并 resolve
    await act(async () => {
      if (resolvePluginA) {
        resolvePluginA({
          values: { title: 'Plugin A Late Response' },
          schema: {
            title: { type: 'string', label: 'A 插件慢字段' },
          },
        })
      }
      await new Promise((r) => setTimeout(r, 20))
    })

    // 4. 验证：插件 A 的迟到响应绝未覆盖插件 B 的界面
    assert.doesNotMatch(container.textContent || '', /A 插件慢字段/)
    assert.match(container.textContent || '', /B 插件标题/)
  } finally {
    pluginsApi.getConfig = originalGetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 6. 自定义扩展面板挂载测试（settingsPanels -> PluginUiView）
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：当 store 中存在 settingsPanels 扩展时正确挂载自定义设置面板', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })

  try {
    const plugin = makePlugin({ id: 'builtin:workflow' })

    const store = makeTestStore({
      groupedUi: groupUiContributions([
        {
          pluginId: 'builtin:workflow',
          surface: 'settings.panel',
          spec: {
            id: 'workflow-advanced-settings',
            label: '工作流高级调控',
            order: 10,
            json: {
              type: 'box',
              children: [{ type: 'text', content: '工作流内部参数调优面板' }],
            },
          },
        },
      ]),
    })

    await act(async () => {
      root.render(
        e(
          HelmStoreContext.Provider,
          { value: store },
          e(PluginDetailDrawer, {
            plugin,
            open: true,
            inline: true,
            onClose: () => {},
            onToggleEnabled: async () => {},
            toggling: false,
          }),
        ),
      )
    })

    // 验证设置面板标题挂载区域
    const bodyText = container.textContent || ''
    assert.match(bodyText, /工作流高级调控/)
  } finally {
    pluginsApi.getConfig = originalGetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
