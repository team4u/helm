import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// 顺序约束：happy-dom 必须先于 react-dom/client 注册，否则 react-dom 19 缓存
// 原生 addEventListener 引用后，合成事件委托收不到派发的 input/click（onChange 失效）。
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { ModelDetailDrawer } = await import('../src/models/ModelDetailDrawer.js')
import type { ProviderItem, ProviderModelItem } from '../src/models/model-center-model.js'

const e = React.createElement

/** 构造 N 个模型的供应商（offset 区分 ID/名称，便于断言首帧截断边界） */
function makeBulkProvider(count: number, enabledIds: string[] = []): ProviderItem {
  const enabled = new Set(enabledIds)
  const models: ProviderModelItem[] = Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    name: `Model ${i}`,
    enabled: enabled.has(`m-${i}`),
  }))
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'commercial',
    configured: true,
    modelsCount: count,
    models,
  }
}

/** 触发 React 受控 input 的 onChange 事件 */
function typeIntoInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })
    ._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (btn) => (btn.textContent ?? '').includes(text),
  )
}

function chipCheckedMap(container: HTMLElement): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const chip of container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')) {
    // title 形如 "Model 5 (m-5) - 点击启用/停用"
    const title = chip.getAttribute('title') ?? ''
    const id = title.match(/\((.+)\)/)?.[1] ?? title
    map.set(id, chip.getAttribute('aria-checked') === 'true')
  }
  return map
}

// ---------------------------------------------------------------------------
// 1. 模型胶囊首帧截断（无过滤且未展开时最多渲染前 80 个，启用项始终保留）
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: 大目录未展开时首帧严格截断为 80 个胶囊', { timeout: 60_000 }, () => {
  const provider = makeBulkProvider(100, ['m-95'])

  const html = renderToStaticMarkup(
    e(ModelDetailDrawer, { provider, open: true, inline: true, onClose: () => {} }),
  )

  // 前 80 个（m-0..m-79）正常渲染
  assert.match(html, /Model 0\b/)
  assert.match(html, /Model 79\b/)
  // 截断线外模型不渲染，即使当前处于启用态；搜索或展开后可定位/查看
  assert.doesNotMatch(html, /Model 81\b/)
  assert.doesNotMatch(html, /Model 95\b/)
  assert.doesNotMatch(html, /Model 99\b/)
  // 省略数量提示：100 - 80 = 20
  assert.match(html, /省略 20 个/)
  // 无过滤词时批量按钮保持全量语义文案
  assert.match(html, /全部启用/)
  assert.match(html, /全部停用/)
})

test('ModelDetailDrawer: 小目录（不足 80）无截断提示，有过滤词时完整渲染匹配结果', { timeout: 60_000 }, () => {
  // 小目录：无省略文案
  const small = renderToStaticMarkup(
    e(ModelDetailDrawer, {
      provider: makeBulkProvider(20, ['m-19']),
      open: true,
      inline: true,
      onClose: () => {},
    }),
  )
  assert.doesNotMatch(small, /省略 \d+ 个/)
  assert.match(small, /Model 19\b/)

  // 大目录 + 过滤词：visibleModels 直接取 filteredModels，不做截断（在交互测试中验证）
})

// ---------------------------------------------------------------------------
// 2. 交互：过滤词下的批量启停仅作用于匹配项，保存提交完整清单
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: 批量启停随过滤词收窄为「匹配项」，不影响搜索外的模型', { timeout: 60_000 }, async () => {
  const provider: ProviderItem = {
    id: 'openai',
    name: 'OpenAI',
    type: 'commercial',
    configured: true,
    modelsCount: 4,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', enabled: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', enabled: true },
      { id: 'o1', name: 'o1 Reasoning', enabled: true },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', enabled: true },
    ],
  }

  const savedPayloads: ProviderModelItem[][] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(ModelDetailDrawer, {
        provider,
        open: true,
        inline: true,
        onClose: () => {},
        onSave: async (_id, data) => {
          savedPayloads.push(data.models ?? [])
        },
      }),
    )
  })

  // 无过滤词：全量语义按钮
  assert.ok(findButtonByText(container, '全部停用'), '无过滤词时应显示「全部停用」')

  // 输入过滤词 gpt：按钮切换为匹配项语义并带数量
  const filterInput = container.querySelector('input[aria-label="过滤模型"]') as HTMLInputElement
  assert.ok(filterInput)
  await act(async () => {
    typeIntoInput(filterInput, 'gpt')
  })
  const disableBtn = findButtonByText(container, '停用匹配项')
  assert.ok(disableBtn, '有过滤词时应显示「停用匹配项」按钮')
  assert.match(disableBtn!.textContent ?? '', /停用匹配项（2）/)

  // 匹配结果完整渲染（过滤场景不截断）
  let chips = chipCheckedMap(container)
  assert.equal(chips.size, 2)

  // 点击停用匹配项：仅 gpt 系模型停用
  await act(async () => {
    disableBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  chips = chipCheckedMap(container)
  assert.equal(chips.get('gpt-4o'), false)
  assert.equal(chips.get('gpt-4o-mini'), false)
  // 计数徽章：全量 4 个中剩余 2 个启用
  assert.match(container.textContent ?? '', /已启用 2 \/ 共 4 个模型/)

  // 保存提交完整清单：搜索外的 o1 / llama 不受影响
  await act(async () => {
    findButtonByText(container, '保存配置')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  const payload = savedPayloads[savedPayloads.length - 1]
  assert.ok(payload)
  assert.equal(payload!.length, 4)
  assert.deepEqual(
    payload!.map((m) => [m.id, m.enabled]),
    [
      ['gpt-4o', false],
      ['gpt-4o-mini', false],
      ['o1', true],
      ['llama-3.3-70b', true],
    ],
  )

  // 启用匹配项恢复匹配结果（同样只动 gpt 系）
  const enableBtn = findButtonByText(container, '启用匹配项')
  assert.ok(enableBtn)
  await act(async () => {
    enableBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  chips = chipCheckedMap(container)
  assert.equal(chips.get('gpt-4o'), true)
  assert.equal(chips.get('gpt-4o-mini'), true)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('ModelDetailDrawer: 无过滤词时批量停用作用于全量模型', { timeout: 60_000 }, async () => {
  const provider: ProviderItem = {
    id: 'groq',
    name: 'Groq',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    models: [
      { id: 'llama-a', name: 'Llama A', enabled: true },
      { id: 'llama-b', name: 'Llama B', enabled: false },
    ],
  }

  const savedPayloads: ProviderModelItem[][] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(ModelDetailDrawer, {
        provider,
        open: true,
        inline: true,
        onClose: () => {},
        onSave: async (_id, data) => {
          savedPayloads.push(data.models ?? [])
        },
      }),
    )
  })

  await act(async () => {
    findButtonByText(container, '全部停用')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    findButtonByText(container, '保存配置')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  const payload = savedPayloads[savedPayloads.length - 1]
  assert.ok(payload)
  assert.equal(payload!.every((m) => m.enabled === false), true, '无过滤词时全部停用应作用于全量')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 3. 交互：展开后完整渲染全部模型，省略提示消失
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: 点击展开后渲染全部模型且省略提示消失，再点击折叠恢复截断', { timeout: 60_000 }, async () => {
  const provider = makeBulkProvider(100, ['m-95'])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(ModelDetailDrawer, { provider, open: true, inline: true, onClose: () => {} }),
    )
  })

  // 初始截断：只渲染前 80 个胶囊
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 80)

  // 展开：全部渲染
  await act(async () => {
    findButtonByText(container, '展开全部')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 100)
  assert.match(container.textContent ?? '', /Model 99\b/)
  assert.doesNotMatch(container.textContent ?? '', /省略 20 个/)

  // 折叠：恢复截断与省略提示
  await act(async () => {
    findButtonByText(container, '折叠列表')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 80)
  assert.match(container.textContent ?? '', /省略 20 个/)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
