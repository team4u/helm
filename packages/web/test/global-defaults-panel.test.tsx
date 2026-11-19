/**
 * GlobalDefaultsPanel per-model thinking defaults (Settings -> Models -> Global default tab):
 * - pure row/validate helpers of `global-defaults-model.ts` (map <-> rows, partial/duplicate
 *   rejection and complete-map conversion for atomic save);
 * - panel behavior with a real happy-dom mount: saved per-model defaults render as ModelPickerControl
 *   rows, remove + save submits one empty map, and a partially filled row blocks saving with a
 *   locale error before any request.
 *
 * Import convention: `ensureHappyDom()` must run before dynamically loading the Radix dependency
 * graph (same as agent-standby / composer tests), otherwise interactive popovers cannot expand.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { ModelCenter } = await import('../src/models/ModelCenter.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const {
  modelThinkingLevelsFromRows,
  reviewModelThinkingRows,
  rowsFromModelThinkingLevels,
} = await import('../src/models/global-defaults-model.js')

const e = React.createElement

const CATALOG_MODELS = [
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini', available: true, thinkingLevels: ['off', 'low', 'medium'] },
]

test('global-defaults-model: rows map conversion and validation', { timeout: 60_000 }, () => {
  const rows = rowsFromModelThinkingLevels({
    'openai/gpt-4o': 'high',
    'openrouter/vendor/nested': 'max',
  })
  assert.deepEqual(rows, [
    { model: 'openai/gpt-4o', level: 'high' },
    { model: 'openrouter/vendor/nested', level: 'max' },
  ])
  assert.deepEqual(rowsFromModelThinkingLevels(undefined), [])

  // Validation: empty rows are skipped; partial and duplicate rows are rejected.
  assert.equal(reviewModelThinkingRows([]), null)
  assert.equal(reviewModelThinkingRows([{ model: '', level: '' }]), null)
  assert.deepEqual(reviewModelThinkingRows([{ model: 'p/m1', level: '' }]), { kind: 'missingLevel', model: 'p/m1' })
  assert.deepEqual(
    reviewModelThinkingRows([
      { model: 'p/m1', level: 'high' },
      { model: 'p/m1', level: 'low' },
    ]),
    { kind: 'duplicate', model: 'p/m1' },
  )

  assert.deepEqual(
    modelThinkingLevelsFromRows([
      { model: 'p/m1', level: 'max' },
      { model: 'p/m3', level: 'off' },
    ]),
    { 'p/m1': 'max', 'p/m3': 'off' },
  )
  assert.deepEqual(modelThinkingLevelsFromRows([{ model: '', level: '' }]), {})
})

interface PanelMount {
  container: HTMLElement
  putBodies: Array<Record<string, unknown>>
  unmount: () => Promise<void>
}

/** Mount ModelCenter on the defaults tab with a fetch mock echoing per-model pair updates. */
async function mountDefaultsPanel(savedMap: Record<string, string>): Promise<PanelMount> {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', tab: 'defaults' },
    models: CATALOG_MODELS,
  })
  const levels: Record<string, string> = { ...savedMap }
  const putBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (path === '/api/models/providers') return new Response(JSON.stringify([]), { status: 200 })
    if (path === '/api/models/default' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      putBodies.push(body)
      if (body.modelThinkingLevels !== undefined) {
        for (const key of Object.keys(levels)) delete levels[key]
        Object.assign(levels, body.modelThinkingLevels)
      }
      if (body.modelThinking !== undefined) {
        if (body.modelThinkingLevel === '') delete levels[String(body.modelThinking)]
        else levels[String(body.modelThinking)] = String(body.modelThinkingLevel)
      }
      return new Response(
        JSON.stringify({
          ok: true,
          defaultModel: '',
          defaultThinkingLevel: '',
          modelThinkingLevels: { ...levels },
          defaultCompactionModel: '',
          defaultCompactionThinkingLevel: '',
        }),
        { status: 200 },
      )
    }
    if (path === '/api/models/default') {
      return new Response(
        JSON.stringify({
          defaultModel: '',
          defaultThinkingLevel: '',
          modelThinkingLevels: { ...savedMap },
          defaultCompactionModel: '',
          defaultCompactionThinkingLevel: '',
        }),
        { status: 200 },
      )
    }
    // 真实 refreshAssets 会重拉资产端点：数组响应保持目录切片形状合法
    if (
      path === '/api/credentials' || path === '/api/skills' || path === '/api/profiles' ||
      path === '/api/models' || path === '/api/providers' || path === '/api/actions'
    ) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })))
  })
  return {
    container,
    putBodies,
    unmount: async () => {
      globalThis.fetch = originalFetch
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

const click = (el: Element): Promise<void> =>
  act(async () => {
    ;(el as HTMLElement).click()
  })

test('GlobalDefaultsPanel: per-model rows render from saved defaults; remove + save submits an empty map', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({ 'anthropic/claude-3-7-sonnet': 'high' })
  try {
    // Saved per-model default renders as one picker row showing model + level.
    const rowBtn = panel.container.querySelector('#model-defaults-permodel-0') as HTMLButtonElement
    assert.ok(rowBtn, 'per-model row must render a ModelPickerControl trigger button')
    assert.match(rowBtn.textContent ?? '', /claude-3-7-sonnet/)
    assert.match(rowBtn.textContent ?? '', /high/)
    assert.match(panel.container.textContent ?? '', /Per-model thinking defaults/)

    // Removing the row and saving submits the complete map in the same request.
    const removeBtn = panel.container.querySelector('button.model-defaults-row-remove') as HTMLButtonElement
    assert.ok(removeBtn, 'row remove button must render')
    await click(removeBtn)
    assert.ok(panel.container.querySelector('#model-defaults-permodel-0') === null, 'row disappears after removal')

    const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await click(saveBtn)

    assert.equal(panel.putBodies.length, 1)
    assert.deepEqual(panel.putBodies[0], {
      model: '',
      thinkingLevel: '',
      compactionModel: '',
      compactionThinkingLevel: '',
      modelThinkingLevels: {},
    })
  } finally {
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: partially filled per-model rows block saving with a locale error and no request', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({})
  try {
    const addBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Add model default'),
    )!
    await click(addBtn)
    assert.ok(panel.container.querySelector('#model-defaults-permodel-0'), 'added row renders a picker')

    // Open the picker popover (portalled to document.body); staging a model does not commit,
    // applying with the default level leaves the row partial (model without a level).
    const rowBtn = panel.container.querySelector('#model-defaults-permodel-0') as HTMLButtonElement
    await click(rowBtn)
    const popover = document.body.querySelector('.composer-model-popover')
    assert.ok(popover, 'the model picker popover opens')
    const pickBtn = Array.from(popover.querySelectorAll('button.popover-item')).find(
      (btn) => (btn.textContent ?? '').includes('claude-3-7-sonnet'),
    )
    assert.ok(pickBtn, 'model option must appear in the picker popover')
    await click(pickBtn!)
    assert.match(rowBtn.textContent ?? '', /Select a model/, 'staging alone does not commit the row')
    const defaultLevelBtn = Array.from(popover.querySelectorAll('button.composer-model-default-btn')).find(
      (btn) => (btn.textContent ?? '').includes('Use default level'),
    )
    assert.ok(defaultLevelBtn, 'the apply bar offers the default-level action')
    await click(defaultLevelBtn!)

    const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await click(saveBtn)
    assert.equal(panel.putBodies.length, 0, 'partial row (model without level) must block any PUT')
    assert.match(panel.container.textContent ?? '', /Set a thinking level for anthropic\/claude-3-7-sonnet/)
  } finally {
    await panel.unmount()
  }
})
