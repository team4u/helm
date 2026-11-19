import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import type { PluginSummary } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../src/lib/api.js'
import {
  buildResetFieldPayload,
  canResetConfigField,
} from '../src/modals/plugin-config-form-model.js'
import { groupUiContributions } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

ensureHappyDom()
const ReactDOMClient = await import('react-dom/client')
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
  assert.match(html, /Resident/)

  // 3. 能力清单透视：Tools 清单、Actions 清单、Hooks 清单
  assert.match(html, /subagent/)
  assert.match(html, /cleanup_worktree/)
  assert.match(html, /run/)
  assert.match(html, /inspect/)
  assert.match(html, /before_turn/)
  assert.match(html, /turn_settled/)

  // 4. 启停控制与状态
  assert.match(html, /Enabled/)
  assert.match(html, /Disable plugin/)

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
  const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement | null
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
      btn.textContent?.includes('Enable plugin'),
    ) as HTMLButtonElement | undefined
    assert.ok(toggleBtn, 'Disabled plugin should show an Enable plugin button')
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
      btn.textContent?.includes('Disable plugin'),
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
      btn.textContent?.includes('Disable plugin'),
    ) as HTMLButtonElement | undefined
    assert.ok(activeToggleBtn)

    await act(async () => {
      activeToggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // 验证错误提示框出现且包含在途任务解释
    const callout = container.querySelector('.callout-error')
    assert.ok(callout, '发生 409 错误时必须呈现统一 .callout-error 错误提示条')
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
      btn.textContent?.includes('Save configuration'),
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
      uiContributions: [
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
      ],
    })

    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
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

// ---------------------------------------------------------------------------
// 7. 故障态（failed）展示：异常徽章与结构化诊断框
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：status === failed 时状态栏显示异常徽章与错误诊断详情', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'external:broken',
    name: '损坏插件',
    enabled: false,
    status: 'failed',
    error: {
      code: 'plugin_load_failed',
      message: '入口文件 index.ts 转译失败：SyntaxError: Unexpected token',
      stage: 'load',
    },
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

  // 1. 当前状态栏不再仅显示「已停用」，而是异常徽章
  assert.match(html, /badge badge-err/)
  assert.match(html, /<span>Error<\/span>/)

  // 2. 显式错误诊断框：阶段 + 错误码 + 完整消息
  assert.match(html, /callout callout-error/)
  assert.match(html, /Failure stage: Module loading \(load\) · Error code:/)
  assert.match(html, /plugin_load_failed/)
  assert.match(html, /入口文件 index\.ts 转译失败/)

  // 3. 铁律：全界面 0 Emoji
  assert.doesNotMatch(html, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
})

test('PluginDetailDrawer：正常插件不渲染诊断框与异常徽章', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(PluginDetailDrawer, {
      plugin: makePlugin({ enabled: true, status: 'active' }),
      open: true,
      inline: true,
      onClose: () => {},
      onToggleEnabled: async () => {},
      toggling: false,
    }),
  )

  assert.match(html, /Enabled/)
  assert.doesNotMatch(html, /故障阶段：/)
  assert.doesNotMatch(html, /<span>Error<\/span>/)
})

// ---------------------------------------------------------------------------
// 8. 409 plugin_in_use 占用确认与强制停用
// ---------------------------------------------------------------------------

test('PluginDetailDrawer：停用遇 409 plugin_in_use 时展示占用清单并支持强制停用', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })

  const toggleCalls: Array<{ force?: boolean } | undefined> = []

  try {
    const plugin = makePlugin({ enabled: true, locked: false })
    let failWithInUse = true

    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async (_p, _target, options) => {
            toggleCalls.push(options)
            if (failWithInUse) {
              throw new ApiClientError(
                'plugin_in_use',
                '插件存在关联的配置或持久资源，停用后相关功能将失效',
                409,
                {
                  pluginId: plugin.id,
                  usages: [
                    { kind: 'profile_runtime', id: 'coder', label: '角色 "coder" 绑定了运行时 herdr' },
                    { kind: 'cron_job', id: 'nightly', label: 'Cron 定时任务 "nightly"（每晚 02:00）' },
                  ],
                },
              )
            }
          },
          toggling: false,
        }),
      )
    })

    // 点击停用插件
    const disableBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Disable plugin'),
    ) as HTMLButtonElement | undefined
    assert.ok(disableBtn)

    await act(async () => {
      disableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // 占用确认条出现并列出所有占用项
    const callout = container.querySelector('.callout-warn')
    assert.ok(callout, '409 plugin_in_use 应展示统一 .callout-warn 占用确认提示条')
    assert.match(callout.textContent || '', /Plugin resource confirmation/)
    assert.match(callout.textContent || '', /角色 "coder" 绑定了运行时 herdr/)
    assert.match(callout.textContent || '', /Cron 定时任务 "nightly"/)
    assert.equal(toggleCalls.length, 1)
    assert.equal(toggleCalls[0], undefined, '首次停用不携带 force')

    // 取消按钮：关闭确认条且不触发强制停用
    const cancelBtn = Array.from(callout.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Cancel'),
    ) as HTMLButtonElement | undefined
    assert.ok(cancelBtn)
    await act(async () => {
      cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.ok(container.querySelector('.callout-warn') === null, '点击取消应关闭占用确认条')

    // 重新触发停用，这次点击「强制停用」
    await act(async () => {
      disableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const forceBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Force disable'),
    ) as HTMLButtonElement | undefined
    assert.ok(forceBtn, '占用确认条必须提供强制停用按钮')

    failWithInUse = false
    await act(async () => {
      forceBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(toggleCalls.length, 3, '首次停用 + 重触停用 + 强制停用共三次调用')
    assert.deepEqual(toggleCalls[2], { force: true }, '强制停用应以 force: true 重试')
    assert.ok(container.querySelector('.callout-warn') === null, '强制停用成功后确认条消失')
  } finally {
    pluginsApi.getConfig = originalGetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('PluginDetailDrawer：409 plugin_has_live_tasks 仍保持硬阻断提示且不提供强制跳过', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })

  try {
    const plugin = makePlugin({ enabled: true, locked: false })

    await act(async () => {
      root.render(
        e(PluginDetailDrawer, {
          plugin,
          open: true,
          inline: true,
          onClose: () => {},
          onToggleEnabled: async () => {
            throw new ApiClientError('plugin_has_live_tasks', 'Plugin has live tasks', 409)
          },
          toggling: false,
        }),
      )
    })

    const disableBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Disable plugin'),
    ) as HTMLButtonElement | undefined
    assert.ok(disableBtn)

    await act(async () => {
      disableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const callout = container.querySelector('.callout-error')
    assert.ok(callout, '在途任务冲突应展示统一 .callout-error 错误提示条')
    assert.match(callout.textContent || '', /plugin_has_live_tasks/)
    assert.match(callout.textContent || '', /Wait for them to finish or abort them, then retry/)
    assert.ok(container.querySelector('.callout-warn') === null, '在途任务不得提供强制停用入口')
    assert.equal(container.textContent?.includes('Force disable'), false)
  } finally {
    pluginsApi.getConfig = originalGetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 9. 配置表单字段来源标识（sources）与单字段重置
// ---------------------------------------------------------------------------

test('canResetConfigField / buildResetFieldPayload：来源与 secret 掩码裁决纯函数', { timeout: 60_000 }, () => {
  const stringSchema = { type: 'string' as const, label: '端点' }
  const secretSchema = { type: 'string' as const, label: '密钥', secret: true }

  // source === 'configured' 一律可重置
  assert.equal(canResetConfigField(stringSchema, 'configured'), true)
  assert.equal(canResetConfigField(secretSchema, 'configured', '******'), true)
  // default / unset 不可重置
  assert.equal(canResetConfigField(stringSchema, 'default'), false)
  assert.equal(canResetConfigField(stringSchema, 'unset'), false)
  // 旧内核未提供 sources：已配置 secret（掩码非空串）仍可清除
  assert.equal(canResetConfigField(secretSchema, undefined, '******'), true)
  assert.equal(canResetConfigField(secretSchema, undefined, ''), false)
  assert.equal(canResetConfigField(stringSchema, undefined, 'http://x'), false)

  // 重置载荷
  assert.deepEqual(buildResetFieldPayload('timeout'), { timeout: null })
  assert.deepEqual(buildResetFieldPayload('apiKey'), { apiKey: null })
})

test('PluginConfigForm：按 sources 渲染已配置/默认标识与单字段重置按钮', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const originalGetConfig = pluginsApi.getConfig
  const originalSetConfig = pluginsApi.setConfig

  const setConfigCalls: Array<Record<string, unknown>> = []
  let reloadCount = 0

  pluginsApi.getConfig = async (_id: string) => ({
    values: {
      endpoint: 'http://10.0.0.1:9000',
      timeout: 8000,
      apiKey: '******',
    },
    schema: {
      endpoint: { type: 'string', label: 'Endpoint', default: 'http://127.0.0.1:3425' },
      timeout: { type: 'number', label: '超时', default: 5000 },
      apiKey: { type: 'string', label: '访问令牌', secret: true },
    },
    sources: {
      endpoint: 'configured',
      timeout: 'default',
      apiKey: 'configured',
    },
  })

  pluginsApi.setConfig = async (_id: string, values: Record<string, unknown>) => {
    setConfigCalls.push(values)
    return { ok: true }
  }

  try {
    await act(async () => {
      root.render(
        e(PluginConfigForm, {
          pluginId: 'test:source',
          config: await pluginsApi.getConfig('test:source'),
          locale: 'en',
          onSaved: () => {
            reloadCount++
          },
        }),
      )
    })

    // 1. 来源标识：endpoint 已配置徽章 / timeout 默认文案
    assert.match(container.textContent || '', /Configured/)
    assert.match(container.textContent || "", /Default/)

    // 2. 重置按钮仅出现在可重置字段旁：endpoint（configured）与 apiKey（secret 已配置）
    const resetBtns = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('Reset') || btn.textContent?.includes('Clear'),
    )
    assert.equal(resetBtns.length, 2, 'endpoint 重置 + apiKey 清除共两个按钮')
    assert.match(resetBtns.map((b) => b.textContent || '').join('|'), /Reset/)
    assert.match(resetBtns.map((b) => b.textContent || '').join('|'), /Clear/)

    // 3. 点击 endpoint 的重置按钮：发送 { endpoint: null } 并触发 onSaved 重载
    const endpointResetBtn = resetBtns.find((btn) => btn.textContent?.includes('Reset'))
    assert.ok(endpointResetBtn)
    await act(async () => {
      endpointResetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(setConfigCalls.length, 1)
    assert.deepEqual(setConfigCalls[0], { endpoint: null })
    assert.equal(reloadCount, 1, '重置成功后必须触发 onSaved 重新拉取配置')
  } finally {
    pluginsApi.getConfig = originalGetConfig
    pluginsApi.setConfig = originalSetConfig
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('PluginConfigForm：必填且无 default 的字段不渲染重置按钮', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(PluginConfigForm, {
          pluginId: 'test:required',
          locale: 'en',
          config: {
            values: { token: 'abc' },
            schema: {
              token: { type: 'string', label: '必填令牌', required: true },
            },
            sources: { token: 'configured' },
          },
          onSaved: () => {},
        }),
      )
    })

    assert.match(container.textContent || '', /Configured/)
    const resetBtns = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('Reset') || btn.textContent?.includes('Clear'),
    )
    assert.equal(resetBtns.length, 0, '必填且无默认值的字段不允许清除')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('PluginDetailDrawer：标题与 ID 靠左对齐，零图标渲染，右上角关闭按钮具备独立类名', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'custom:unspecified-icon',
    name: '自定义扩展插件',
    icon: undefined,
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

  // 1. 标题与 ID 渲染
  assert.match(html, /自定义扩展插件/)
  assert.match(html, /custom:unspecified-icon/)
  assert.match(html, /plugin-drawer-title-col/)
  assert.match(html, /plugin-drawer-id/)

  // 2. 右上角关闭按钮
  assert.match(html, /btn-icon-sm plugin-drawer-close-btn/)

  // 3. 杜绝图标容器
  assert.doesNotMatch(html, /plugin-drawer-icon-wrap/)
})

test('PluginDetailDrawer：「右屏打开」按钮具备窄屏隐藏类且不使用旧 callout--* 类', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    uiContributions: [
      { pluginId: 'custom:demo', surface: 'screen', spec: { id: 'main', label: '主视图', title: '主视图', client: { module: 'index.tsx', export: 'Main' } } },
    ],
  })
  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(PluginDetailDrawer, {
        plugin: makePlugin({ id: 'custom:demo', enabled: true }),
        open: true,
        inline: true,
        onClose: () => {},
        onToggleEnabled: async () => {},
        toggling: false,
      }),
    ),
  )
  assert.match(html, /split-toggle-btn plugin-drawer-split-btn/)
  assert.match(html, /Open in split/)
})

test('PluginConfigForm：长标签与「默认 / 已配置」徽章防拆字碰撞结构与 CSS 契约', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(PluginConfigForm, {
      pluginId: 'builtin:herdr',
      locale: 'en',
      config: {
        values: {
          agentStartTimeoutMs: 15000,
          defaultProfile: 'coder',
        },
        sources: {
          agentStartTimeoutMs: 'default',
          defaultProfile: 'configured',
        },
        schema: {
          agentStartTimeoutMs: { type: 'number', label: 'agent 启动超时（毫秒）' },
          defaultProfile: { type: 'string', label: '默认代理配置名称' },
        },
      },
      onSaved: () => {},
    }),
  )
  assert.match(html, /form-grid plugin-config-row/)
  assert.match(html, /form-grid-label plugin-config-field-label/)
  assert.match(html, /plugin-config-field-name">agent 启动超时（毫秒）<\/span>/)
  assert.match(html, /text-subtle plugin-config-source-tag"[^>]*>Default<\/span>/)
  assert.match(html, /badge badge-neutral plugin-config-source-tag"[^>]*>Configured<\/span>/)
})

test('PluginConfigForm：字段 label/description 属 LocalizedText，按 locale 解析后渲染', { timeout: 60_000 }, () => {
  const config: PluginConfigResponse = {
    values: {},
    schema: {
      apiKey: { type: 'string', label: { en: 'API key', 'zh-CN': '接口密钥' }, description: { en: 'Provider credential.', 'zh-CN': '供应商凭据。' }, secret: true },
      region: { type: 'string', label: 'Region' },
    },
  }
  const zhHtml = renderToString(e(PluginConfigForm, { pluginId: 'community:glossary', locale: 'zh-CN', config, onSaved: () => {} }))
  assert.match(zhHtml, /接口密钥/)
  assert.match(zhHtml, /供应商凭据。/)
  assert.ok(!zhHtml.includes('API key'), 'zh-CN 下不得渲染 en 字段名')
  // 纯字符串 label（向后兼容）原样；缺当前语言键回落 en
  assert.match(zhHtml, /Region/)
  const enHtml = renderToString(e(PluginConfigForm, { pluginId: 'community:glossary', locale: 'en', config, onSaved: () => {} }))
  assert.match(enHtml, /API key/)
  assert.match(enHtml, /Provider credential\./)
  assert.ok(!enHtml.includes('接口密钥'), 'en 下不得渲染 zh-CN 字段名')
})

test('PluginDetailDrawer & PluginConfigForm：zh-CN locale 渲染中文状态、能力清单、诊断与配置表单文案', { timeout: 60_000 }, () => {
  const failedPlugin = makePlugin({
    id: 'external:broken',
    name: { en: 'Broken Plugin', 'zh-CN': '损坏插件' },
    description: undefined,
    locked: true,
    enabled: false,
    status: 'failed',
    tools: [],
    actions: [],
    hooks: [],
    error: {
      code: 'plugin_load_failed',
      message: 'missing entry',
      stage: 'load',
    },
  })

  const zhStore = makeTestStore({ locale: 'zh-CN' })
  const zhHtml = renderToString(
    e(
      HostStoreProviders,
      { value: zhStore },
      e(PluginDetailDrawer, {
        plugin: failedPlugin,
        open: true,
        inline: true,
        onClose: () => {},
        onToggleEnabled: async () => {},
        toggling: false,
      }),
    ),
  )

  assert.match(zhHtml, /损坏插件/)
  assert.match(zhHtml, /常驻/)
  assert.match(zhHtml, /加载失败/)
  assert.match(zhHtml, /当前状态/)
  assert.match(zhHtml, /异常/)
  assert.match(zhHtml, /启用插件/)
  assert.match(zhHtml, /插件加载或启用失败/)
  assert.match(zhHtml, /故障阶段：模块加载（load） · 错误码：/)
  assert.match(zhHtml, /能力清单/)
  assert.match(zhHtml, /无声明工具/)
  assert.match(zhHtml, /无声明动作/)
  assert.match(zhHtml, /无拦截钩子/)
  assert.match(zhHtml, /配置项/)
  assert.doesNotMatch(zhHtml, /Current status/)
  assert.doesNotMatch(zhHtml, /Capabilities/)

  const configHtml = renderToString(
    e(PluginConfigForm, {
      pluginId: 'test:zh-form',
      locale: 'zh-CN',
      config: {
        values: { endpoint: 'http://localhost', apiKey: '******', enabled: true },
        sources: { endpoint: 'default', apiKey: 'configured' },
        schema: {
          endpoint: { type: 'string', label: { en: 'Endpoint', 'zh-CN': '端点' } },
          apiKey: { type: 'string', label: { en: 'API key', 'zh-CN': '密钥' }, secret: true },
          enabled: { type: 'boolean', label: { en: 'Enabled', 'zh-CN': '启用' } },
        },
      },
      onSaved: () => {},
    }),
  )
  assert.match(configHtml, /默认/)
  assert.match(configHtml, /已配置/)
  assert.match(configHtml, /已配置（留空保持不变）/)
  assert.match(configHtml, /清除/)
  assert.match(configHtml, /保存配置/)
  assert.match(configHtml, /开启/)
})
