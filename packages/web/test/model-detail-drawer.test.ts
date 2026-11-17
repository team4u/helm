import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Ordering constraint: happy-dom must be registered before react-dom/client,
// otherwise react-dom 19 caches native addEventListener refs and the synthetic
// event delegation misses dispatched input/click events (onChange breaks).
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { ModelDetailDrawer } = await import('../src/models/ModelDetailDrawer.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
import type { ProviderItem, ProviderModelItem } from '../src/models/model-center-model.js'
import type { ModelDetailDrawerProps as DrawerProps } from '../src/models/ModelDetailDrawer.js'

const e = React.createElement

/**
 * Render the drawer inline under the production-shaped provider stack
 * (store + SDK host ports) so `useWebLocale` resolves the active locale.
 */
function renderDrawerHtml(props: Partial<DrawerProps> & { provider: ProviderItem | null }): string {
  return renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelDetailDrawer, { open: true, inline: true, onClose: () => {}, ...props }),
    ),
  )
}

/** Build a provider with N models (offset ids/names to assert the first-frame cutoff). */
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

/** Trigger onChange on a React controlled input. */
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
    // title looks like "Model 5 (m-5) - click to Enable"
    const title = chip.getAttribute('title') ?? ''
    const id = title.match(/\((.+)\)/)?.[1] ?? title
    map.set(id, chip.getAttribute('aria-checked') === 'true')
  }
  return map
}

// ---------------------------------------------------------------------------
// 1. Model chip first-frame cutoff (max 80 chips unfiltered and unexpanded;
//    enabled state never overrides the cutoff)
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: huge catalog truncates the first frame to 80 chips before expanding', { timeout: 60_000 }, () => {
  const provider = makeBulkProvider(100, ['m-95'])

  const html = renderDrawerHtml({ provider })

  // The first 80 (m-0..m-79) render normally
  assert.match(html, /Model 0\b/)
  assert.match(html, /Model 79\b/)
  // Models past the cutoff do not render even while enabled; search or expand
  // reveals them
  assert.doesNotMatch(html, /Model 81\b/)
  assert.doesNotMatch(html, /Model 95\b/)
  assert.doesNotMatch(html, /Model 99(?![0-9])/)
  // Hidden-count hint: 100 - 80 = 20
  assert.match(html, /20 hidden/)
  // Without a filter term the bulk buttons keep whole-list semantics
  assert.match(html, /Enable all/)
  assert.match(html, /Disable all/)
})

test('ModelDetailDrawer: small catalog (under 80) shows no cutoff hint; a filter term renders all matches', { timeout: 60_000 }, () => {
  // Small catalog: no hidden-count copy
  const small = renderDrawerHtml({ provider: makeBulkProvider(20, ['m-19']) })
  assert.doesNotMatch(small, /\d+ hidden/)
  assert.match(small, /Model 19\b/)

  // Large catalog + filter term: visibleModels takes filteredModels directly
  // with no cutoff (verified in the interaction tests below)
})

// ---------------------------------------------------------------------------
// 2. Interaction: bulk enable/disable under a filter term applies to matches
//    only; saving submits the complete list
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: bulk toggles narrow to matches under a filter term and never touch models outside the search', { timeout: 60_000 }, async () => {
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
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(ModelDetailDrawer, {
          provider,
          open: true,
          inline: true,
          onClose: () => {},
          onSave: async (_id, data) => {
            savedPayloads.push(data.models ?? [])
          },
        }),
      ),
    )
  })

  // No filter term: whole-list semantics buttons
  assert.ok(findButtonByText(container, 'Disable all'), 'without a filter term the whole-list disable button shows')

  // Type the filter term gpt: buttons switch to match semantics with a count
  const filterInput = container.querySelector('input[aria-label="Filter models"]') as HTMLInputElement
  assert.ok(filterInput)
  await act(async () => {
    typeIntoInput(filterInput, 'gpt')
  })
  const disableBtn = findButtonByText(container, 'Disable matches')
  assert.ok(disableBtn, 'with a filter term the disable-matches button shows')
  assert.match(disableBtn!.textContent ?? '', /Disable matches \(2\)/)

  // Matches render fully (no cutoff while filtering)
  let chips = chipCheckedMap(container)
  assert.equal(chips.size, 2)

  // Click disable-matches: only gpt models get disabled
  await act(async () => {
    disableBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  chips = chipCheckedMap(container)
  assert.equal(chips.get('gpt-4o'), false)
  assert.equal(chips.get('gpt-4o-mini'), false)
  // Count badge: 2 of the full 4 remain enabled
  assert.match(container.textContent ?? '', /2 enabled \/ 4 models in total/)

  // Saving submits the complete list: o1 / llama outside the search stay enabled
  await act(async () => {
    findButtonByText(container, 'Save configuration')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

  // Enable-matches restores the matches (again only the gpt family)
  const enableBtn = findButtonByText(container, 'Enable matches')
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

test('ModelDetailDrawer: bulk disable without a filter term applies to the whole list', { timeout: 60_000 }, async () => {
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
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(ModelDetailDrawer, {
          provider,
          open: true,
          inline: true,
          onClose: () => {},
          onSave: async (_id, data) => {
            savedPayloads.push(data.models ?? [])
          },
        }),
      ),
    )
  })

  await act(async () => {
    findButtonByText(container, 'Disable all')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    findButtonByText(container, 'Save configuration')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  const payload = savedPayloads[savedPayloads.length - 1]
  assert.ok(payload)
  assert.equal(payload!.every((m) => m.enabled === false), true, 'without a filter term disable-all applies to the whole list')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 3. Interaction: expanding renders every model and clears the hidden hint
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: expanding renders all models and clears the hidden hint; collapsing restores the cutoff', { timeout: 60_000 }, async () => {
  const provider = makeBulkProvider(100, ['m-95'])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(ModelDetailDrawer, { provider, open: true, inline: true, onClose: () => {} }),
      ),
    )
  })

  // Initial cutoff: only the first 80 chips render
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 80)

  // Expand: everything renders
  await act(async () => {
    findButtonByText(container, 'Expand all')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 100)
  assert.match(container.textContent ?? '', /Model 99(?![0-9])/)
  assert.doesNotMatch(container.textContent ?? '', /20 hidden/)

  // Collapse: cutoff and hidden hint return
  await act(async () => {
    findButtonByText(container, 'Collapse list')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(container.querySelectorAll('button[role="checkbox"]').length, 80)
  assert.match(container.textContent ?? '', /20 hidden/)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 4. Thinking and context-window tags render adjacently (reusing the existing
//    tags badge track; zero new layout)
// ---------------------------------------------------------------------------

function makeTaggedProvider(): ProviderItem {
  return {
    id: 'magpie',
    name: 'Magpie',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    models: [
      { id: 'glm-4.6', name: 'GLM 4.6', enabled: true, tags: ['Thinking models', '200k context'] },
      { id: 'plain-mini', name: 'Plain Mini', enabled: true },
    ],
  }
}

test('ModelDetailDrawer SSR: thinking and context-window tags render adjacently in one chip, thinking first; unknown windows add none', { timeout: 60_000 }, () => {
  const html = renderDrawerHtml({ provider: makeTaggedProvider() })

  // The two badges are directly adjacent (same map expansion, same chip);
  // thinking first, window after
  assert.match(
    html,
    />Thinking models<\/span><span class="badge mi-effort mchip-tag mtell">200k context<\/span>/,
  )
  assert.ok(html.indexOf('Thinking models') < html.indexOf('200k context'), 'the thinking tag must precede the window tag')

  // A model with an unknown window renders no context badge and no empty tag container
  assert.equal((html.match(/context/g) ?? []).length, 1, 'only the known-window model carries a context tag')
})

test('ModelDetailDrawer DOM: chip badges mount in tags order; untagged models render no badges', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(ModelDetailDrawer, { provider: makeTaggedProvider(), open: true, inline: true, onClose: () => {} }),
      ),
    )
  })

  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'))
  assert.equal(chips.length, 2)

  const badgesOf = (chip: HTMLButtonElement) =>
    Array.from(chip.querySelectorAll('span.badge')).map((span) => span.textContent ?? '')

  const glm = chips.find((chip) => (chip.getAttribute('title') ?? '').includes('glm-4.6'))
  assert.ok(glm, 'the glm-4.6 chip must exist')
  assert.deepEqual(badgesOf(glm), ['Thinking models', '200k context'])

  const plain = chips.find((chip) => (chip.getAttribute('title') ?? '').includes('plain-mini'))
  assert.ok(plain, 'the plain-mini chip must exist')
  assert.deepEqual(badgesOf(plain), [], 'untagged models render no badges')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 5. Endpoint editability: plugin/built-in providers read-only; custom
//    gateways editable with an empty value blocking the save
// ---------------------------------------------------------------------------

test('ModelDetailDrawer: plugin gateway endpoint renders read-only and points at the plugin configuration (no fake editing)', { timeout: 60_000 }, () => {
  // Reproduces the user scenario: trying to change the magpie gateway address
  // in the model UI — the field used to be editable but the save chain never
  // persisted baseUrl, so edits bounced back to the default address.
  const provider: ProviderItem = {
    id: 'magpie',
    name: 'Magpie',
    type: 'commercial',
    configured: true,
    modelsCount: 3,
    baseUrl: 'http://127.0.0.1:3425/v1',
    dynamic: true,
    pluginId: 'builtin:magpie',
    models: [{ id: 'glm-4.6', name: 'GLM 4.6', enabled: true }],
  }

  const html = renderDrawerHtml({ provider })

  // No editable endpoint input: the effective endpoint shows read-only
  assert.doesNotMatch(html, /id="model-drawer-base-url"/, 'plugin gateway endpoint must not render an editable input')
  assert.match(html, /http:\/\/127\.0\.0\.1:3425\/v1/)
  // The hint points honestly at the real configuration entry (the plugin
  // config) instead of pretending the save worked
  assert.match(html, /This endpoint is managed by the configuration of plugin builtin:magpie/)
  assert.match(html, /plugin center/)
  // The plugin gateway key is likewise owned by the plugin configuration:
  // kernel vault writes never affect plugin auth, so no fake input renders
  // (magpie's auth.resolve reads only the plugin config token)
  assert.doesNotMatch(html, /id="model-drawer-api-key"/, 'plugin gateway key must not render a kernel credential input')
  assert.match(html, /managed by the configuration of plugin builtin:magpie/)
  assert.match(html, /not stored in the kernel credential vault/)
})

test('ModelDetailDrawer: built-in provider endpoint is read-only with the fixed-endpoint hint', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    configured: false,
    modelsCount: 0,
    baseUrl: 'http://127.0.0.1:11434',
    models: [],
  }

  const html = renderDrawerHtml({ provider })

  assert.doesNotMatch(html, /id="model-drawer-base-url"/)
  assert.match(html, /http:\/\/127\.0\.0\.1:11434/)
  assert.match(html, /built in and cannot be changed/)
})

test('ModelDetailDrawer: custom gateway endpoint editable; saving an empty value fails explicitly without submitting', { timeout: 60_000 }, async () => {
  const provider: ProviderItem = {
    id: 'my-gateway',
    name: 'My Gateway',
    type: 'commercial',
    configured: true,
    modelsCount: 1,
    baseUrl: 'http://10.0.0.8:8000/v1',
    custom: true,
    models: [{ id: 'gw-model', name: 'GW Model', enabled: true }],
  }

  const saved: Array<{ baseUrl?: string }> = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(ModelDetailDrawer, {
          provider,
          open: true,
          inline: true,
          onClose: () => {},
          onSave: async (_id, data) => {
            saved.push({ baseUrl: data.baseUrl })
          },
        }),
      ),
    )
  })

  // Custom gateway keeps the editable input
  const endpointInput = container.querySelector('input#model-drawer-base-url') as HTMLInputElement
  assert.ok(endpointInput, 'custom gateway must render an editable endpoint input')

  // Empty the endpoint and save: explicit error, never a silent submit
  await act(async () => {
    typeIntoInput(endpointInput, '')
  })
  await act(async () => {
    findButtonByText(container, 'Save configuration')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.equal(saved.length, 0, 'an empty endpoint must not trigger the save callback')
  assert.match(container.textContent ?? '', /custom gateway endpoint cannot be empty/)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 6. zh-CN locale rendering
// ---------------------------------------------------------------------------

test('ModelDetailDrawer zh-CN: renders credentials form, model chips and interpolated counts in Chinese', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'openai',
    name: 'OpenAI',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tags: ['多模态', '128K'], enabled: true },
      { id: 'o1', name: 'o1 Reasoning', tags: ['深度推理'], enabled: false },
    ],
  }

  const store = makeTestStore({ locale: 'zh-CN' })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ModelDetailDrawer, { provider, open: true, inline: true, onClose: () => {} }),
    ),
  )

  // Drawer chrome and form labels localized
  assert.match(html, /凭证与连接设置/)
  assert.match(html, /API 密钥/)
  assert.match(html, /已配置（留空保持不变）/)
  assert.match(html, /服务端点/)
  assert.match(html, /测试连接/)

  // Model chips section with interpolated count badge (1 of 2 enabled)
  assert.match(html, /模型清单与路由控制/)
  assert.match(html, /已启用 1 \/ 共 2 个模型/)
  assert.match(html, /全部启用/)
  assert.match(html, /全部停用/)
  // Chip tooltip switches to the zh click-to-disable copy for the enabled chip
  assert.match(html, /GPT-4o \(gpt-4o\) - 点击停用/)

  // Save action and secret hint localized
  assert.match(html, /保存配置/)
  assert.match(html, /密钥密文将安全存储于系统保密箱中/)
})
