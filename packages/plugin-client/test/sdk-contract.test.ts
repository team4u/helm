/**
 * @helm/plugin-client standalone package contract tests (no web/kernel
 * implementation dependency):
 * 1. Export symbols are bidirectionally locked against the protocol
 *    PLUGIN_CLIENT_SHARED_EXPORTS list (every listed symbol actually exists at
 *    runtime; plugin-facing symbols are never undefined);
 * 2. Host port Provider contract: usePluginDoc / usePluginSessionDoc /
 *    useConversations / useConversation / usePlugins / usePluginContext all
 *    fetch data through the port injected via PluginClientHostContext; a
 *    missing port throws explicitly (never silently degraded);
 * 3. createPluginClientContext port-forwarding contract: callAction
 *    cross-plugin addressing, submitInput origin=agent payload, and
 *    navigation / notification / doc methods each forwarding to the real port;
 * 4. PluginSlot port contract: short-name qualification, single first item,
 *    fallback, and explicit cycle warning;
 * 5. MarkdownView / CodeBlockView port delegation: renders the host-injected
 *    implementations.
 *
 * Note: error-message regexes below pin the exact English messages thrown by
 * host-port.ts / plugin-context.ts so that explicit failure behavior remains
 * covered.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS, resolveLocalizedText } from '@helm/protocol'
import * as SDK from '../src/index.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// 1. Bidirectional export-list locking
// ---------------------------------------------------------------------------

test('every symbol in PLUGIN_CLIENT_SHARED_EXPORTS actually exists in this package runtime namespace', { timeout: 60_000 }, () => {
  const exportedNames = new Set(Object.keys(SDK))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `@helm/plugin-client is missing manifest symbol ${name} (PLUGIN_CLIENT_SHARED_EXPORTS drifted from the implementation)`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `symbol ${name} must not be undefined`)
  }
})

test('host-facing symbols (port / context / factory / explicit-addressing hooks) are really exported', { timeout: 60_000 }, () => {
  for (const name of [
    'PluginClientHostContext',
    'usePluginClientHost',
    'PluginClientContext',
    'usePluginContext',
    'createPluginClientContext',
    'usePluginDocValue',
    'usePluginSessionDocState',
    'usePluginSessionDocValue',
    'ToolActivityContext',
    'useToolActivity',
  ] as const) {
    assert.ok(name in SDK, `host-facing symbol ${name} must be exported`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `host-facing symbol ${name} must not be undefined`)
  }
})

// ---------------------------------------------------------------------------
// Test port (a behavioral minimal double: records calls and returns deterministic data)
// ---------------------------------------------------------------------------

interface PortLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }>
  inputs: Array<{ conversationId: number; text: string; origin: string; whenBusy?: string }>
  targets: Array<{ target: string; split?: boolean }>
  drawers: number[]
  artifacts: Array<{ artifactId: string; conversationId?: number }>
  workbench: Array<boolean | string>
  notices: Array<{ message: string; tone: string; conversationId?: number }>
  docs: Array<{ pluginId: string; docName: string; conversationId?: number }>
}

function makePort(log: PortLog, overrides: Partial<SDK.PluginClientHostPort> = {}): SDK.PluginClientHostPort {
  const slotRender = (item: SDK.PluginSlotPortItem, options: { slotProps?: Record<string, unknown>; label: string }): React.ReactNode =>
    e('div', { 'data-slot': `${item.pluginId}/${item.contributionId}`, 'data-label': options.label }, JSON.stringify(options.slotProps ?? null))
  return {
    authenticated: true,
    theme: 'dark',
    locale: 'zh-CN',
    translate: (text) => resolveLocalizedText(text, 'zh-CN'),
    conversations: [{ id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as SDK.PluginClientHostPort['conversations'][number]],
    conversationDetails: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [],
    screens: [],
    pluginDocs: { 'p1/state': { ok: 1 } },
    ensurePluginDoc: (pluginId, docName) => {
      log.docs.push({ pluginId, docName })
      return Promise.resolve({ ok: 1 })
    },
    getPluginSessionDoc: (pluginId, docName, conversationId) => {
      log.docs.push({ pluginId, docName, conversationId })
      return Promise.resolve({ session: true })
    },
    subscribeSessionDoc: () => () => {},
    getSessionDocState: (key) => ({
      hasValue: true,
      deleted: false,
      connected: true,
      value: { key: `${key.pluginId}/${key.docName}/${key.conversationId}` },
    }),
    invokePluginAction: (pluginId, actionId, input, conversationId) => {
      log.actions.push({ pluginId, actionId, input, conversationId })
      return Promise.resolve({ done: true })
    },
    submitConversationInput: (conversationId, input) => {
      log.inputs.push({ conversationId, ...input, origin: input.origin, whenBusy: input.whenBusy })
      return Promise.resolve()
    },
    openTarget: (target, options) => {
      log.targets.push({ target, split: options?.split })
    },
    openConversationDrawer: (conversationId) => {
      log.drawers.push(conversationId)
    },
    openArtifactPreview: (artifactId, conversationId) => {
      log.artifacts.push({ artifactId, conversationId })
    },
    setWorkbenchOpen: (open) => {
      log.workbench.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbench.push(tab)
    },
    notify: (message, tone, conversationId) => {
      log.notices.push({ message, tone, conversationId })
    },
    loadConversationDetail: () => Promise.resolve(undefined),
    slots: {
      collectItems: (qualifiedName) =>
        qualifiedName === 'owner/zone'
          ? [
              { pluginId: 'p2', contributionId: 'badge', spec: { id: 'badge', target: 'owner/zone' } },
              { pluginId: 'p3', contributionId: 'extra', spec: { id: 'extra', target: 'owner/zone' } },
            ]
          : [],
      renderItem: slotRender,
    },
    markdown: {
      view: ({ text, workspaceBaseDir }) => e('div', { 'data-md': 'host', 'data-base-dir': workspaceBaseDir ?? '' }, text),
      codeBlock: ({ code, language }) => e('pre', { 'data-code': 'host', 'data-lang': language }, code),
    },
    ...overrides,
  }
}

function mount(tree: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(tree))
  return { host, root }
}

// ---------------------------------------------------------------------------
// 2. Hooks fetch through the port; missing port throws explicitly
// ---------------------------------------------------------------------------

test('usePluginDoc / useConversations / usePlugins fetch through the port; first access auto-triggers ensurePluginDoc', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  let docValue: unknown = 'unset'
  let conversations: unknown[] | undefined
  let screens: unknown[] | undefined
  function Probe(): React.ReactNode {
    docValue = SDK.usePluginDoc('state', 'p1')
    conversations = SDK.useConversations()
    screens = SDK.usePlugins().screens
    return e('div', null, 'probe')
  }
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.deepEqual(docValue, { ok: 1 }, 'public doc comes from port pluginDocs')
  assert.equal(conversations?.length, 1, 'conversation summaries come from port conversations')
  assert.deepEqual(screens, [], 'screens come from the port')
  act(() => { void root.unmount() })
  void host
})

test('usePluginDoc auto-triggers ensurePluginDoc for a missing key (port forwarding)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  function Probe(): React.ReactNode {
    const value = SDK.usePluginDoc('missing')
    return e('div', null, String(value))
  }
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.equal(log.docs.length, 1, 'a missing doc triggers exactly one ensurePluginDoc through the port')
  assert.deepEqual(log.docs[0], { pluginId: 'p1', docName: 'missing' })
  act(() => { void root.unmount() })
})

test('usePluginSessionDoc: inherits the ctx conversation; explicit override wins; no conversation returns undefined', { timeout: 60_000 }, () => {
  const seen: string[] = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const states = new Map<string, unknown>()
  port.getSessionDocState = (key) => {
    seen.push(`${key.pluginId}/${key.docName}/${key.conversationId}`)
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    // Snapshot references stay stable (consistent with the real host cache):
    // useSyncExternalStore compares with Object.is
    let snapshot = states.get(cacheKey)
    if (snapshot === undefined) {
      snapshot = { hasValue: true, deleted: false, connected: true, value: 42 }
      states.set(cacheKey, snapshot)
    }
    return snapshot as SDK.PluginSessionDocState
  }
  let inherited: unknown = 'unset'
  let overridden: unknown = 'unset'
  let none: unknown = 'unset'
  // Three probes render under different context Providers (no conditional hook
  // calls within one component)
  function InheritedProbe(): React.ReactNode {
    inherited = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  function OverriddenProbe(): React.ReactNode {
    overridden = SDK.usePluginSessionDoc('runs', { conversationId: 9, pluginId: 'other' })
    return e('div', null, 'probe')
  }
  function NoneProbe(): React.ReactNode {
    none = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(InheritedProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(OverriddenProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', undefined) },
        e(NoneProbe))),
  )
  assert.equal(inherited, 42, 'subscribed value inheriting ctx.conversationId=7')
  assert.equal(overridden, 42, 'explicit override conversationId=9 / pluginId=other')
  assert.equal(none, undefined, 'no conversation context opens no stream and returns undefined')
  assert.deepEqual([...new Set(seen)], ['p1/runs/7', 'other/runs/9'], 'subscription tuples resolve by inheritance and override (no tuple without conversation context)')
})

test('hooks throw explicitly without a host port (never silently degraded)', { timeout: 60_000 }, () => {
  function Probe(): React.ReactNode {
    SDK.useConversations()
    return e('div', null, 'probe')
  }
  // The pinned message is thrown by host-port.ts, which is outside the SDK
  // anglicization scope — the regex must keep matching it verbatim.
  assert.throws(
    () => renderToString(e(Probe)),
    /usePluginClientHost must be called inside <PluginClientHostContext.Provider>/,
    'useConversations throws explicitly when the port is missing',
  )
})

// ---------------------------------------------------------------------------
// 3. createPluginClientContext port forwarding
// ---------------------------------------------------------------------------

test('createPluginClientContext: actions / input / navigation / notifications / docs each forward to the port', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', 7, { draft: '', attachments: [], sending: false, setDraft() {}, insertText() {}, submit: () => Promise.resolve() })
  assert.equal(ctx.pluginId, 'p1')
  assert.equal(ctx.conversationId, 7)
  assert.equal(ctx.theme, 'dark')
  assert.equal(ctx.locale, 'zh-CN', 'locale is injected by the port')
  assert.equal(ctx.translate('plain'), 'plain', 'translator passes plain strings through')
  assert.equal(ctx.translate({ en: 'Hi', 'zh-CN': '你好' }), '你好', 'translator resolves display text for the current locale')
  assert.equal(ctx.translate({ en: 'Hi' }), 'Hi', 'translator falls back to the default locale when the current locale is missing')
  assert.ok(ctx.composer !== undefined, 'an explicitly provided composer is passed through')

  await ctx.callAction('reload', { x: 1 })
  await ctx.callAction('reload', { x: 2 }, { pluginId: 'p2', conversationId: 9 })
  assert.deepEqual(log.actions, [
    { pluginId: 'p1', actionId: 'reload', input: { x: 1 }, conversationId: 7 },
    { pluginId: 'p2', actionId: 'reload', input: { x: 2 }, conversationId: 9 },
  ], 'callAction defaults to the current plugin and conversation; explicit parameters win')

  await ctx.submitInput('hello', { whenBusy: 'followUp' })
  assert.deepEqual(log.inputs, [{ conversationId: 7, text: 'hello', origin: 'agent', whenBusy: 'followUp' }], 'submitInput goes through the port with origin=agent')

  ctx.openScreen('conversation:1')
  ctx.openSplitScreen('screen:builtin:herdr/overview')
  assert.deepEqual(log.targets, [
    { target: 'conversation:1', split: undefined },
    { target: 'screen:builtin:herdr/overview', split: true },
  ], 'openScreen / openSplitScreen go through port openTarget')

  ctx.openConversationDrawer(3)
  ctx.openArtifact('art-1')
  ctx.openWorkbench('plugin:builtin:memory/main')
  ctx.closeWorkbench()
  assert.deepEqual(log.drawers, [3])
  assert.deepEqual(log.artifacts, [{ artifactId: 'art-1', conversationId: 7 }], 'artifact preview inherits the current conversation')
  assert.deepEqual(log.workbench, [true, 'plugin:builtin:memory/main', false])

  ctx.notify('boom', 'error')
  assert.deepEqual(log.notices, [{ message: 'boom', tone: 'error', conversationId: 7 }])

  await ctx.getPluginDoc('state')
  await ctx.getPluginDoc('state', 'p2')
  await ctx.getPluginSessionDoc('runs', { conversationId: 8 })
  assert.deepEqual(log.docs, [
    { pluginId: 'p1', docName: 'state' },
    { pluginId: 'p2', docName: 'state' },
    { pluginId: 'p1', docName: 'runs', conversationId: 8 },
  ], 'doc reads go through the port (cross-plugin and explicit conversation win)')
})

test('createPluginClientContext: submitInput without conversation context rejects explicitly; invalid conversation IDs throw', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', undefined)
  // The host and context implementations reject these cases explicitly.
  await assert.rejects(() => ctx.submitInput('x'), /submitInput has no target conversation/, 'without a conversation, never drop silently')
  assert.throws(() => { void ctx.callAction('a', 1, { conversationId: 0 }) }, /must be a positive integer/, 'invalid conversation ID rejected synchronously')
  await assert.rejects(() => ctx.getPluginSessionDoc('runs'), /getPluginSessionDoc has no target conversation/)
})

// ---------------------------------------------------------------------------
// 4. PluginSlot port contract
// ---------------------------------------------------------------------------

test('createPluginClientContext: missing port locale falls back to the default locale and derives a translator', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  delete port.locale
  delete port.translate
  const ctx = SDK.createPluginClientContext(port, 'p1', 7)
  assert.equal(ctx.locale, 'en', 'missing port locale falls back to DEFAULT_HELM_LOCALE')
  assert.equal(ctx.translate({ en: 'Hi', 'zh-CN': '你好' }), 'Hi', 'derived translator resolves using the fallback locale')
  assert.equal(ctx.translate({ 'zh-CN': '你好' }), '你好', 'derived translator falls back to the only declared locale')
})

test('usePluginLocale / usePluginTranslator: context takes precedence over port, then default', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const seen: Array<{ locale: string; translated: string }> = []

  function CtxProbe(): React.ReactNode {
    const translator = SDK.usePluginTranslator()
    seen.push({ locale: String(SDK.usePluginLocale()), translated: translator({ en: 'Hi', 'zh-CN': '你好' }) })
    return e('div', null, 'probe')
  }
  function PortProbe(): React.ReactNode {
    const translator = SDK.usePluginTranslator()
    seen.push({ locale: String(SDK.usePluginLocale()), translated: translator({ en: 'Hi', 'zh-CN': '你好' }) })
    return e('div', null, 'probe')
  }
  function BareProbe(): React.ReactNode {
    seen.push({ locale: String(SDK.usePluginLocale()), translated: SDK.usePluginTranslator()('plain') })
    return e('div', null, 'probe')
  }

  mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) }, e(CtxProbe)),
      e(PortProbe)),
  )
  mount(e(BareProbe))
  assert.deepEqual(seen, [
    { locale: 'zh-CN', translated: '你好' }, // context wins
    { locale: 'zh-CN', translated: '你好' }, // host port fallback
    { locale: 'en', translated: 'plain' },   // neither provider: default locale
  ])
})

test('shared primitives update labels with the host locale without changing selected values', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const options = Array.from({ length: 5 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }))
  const changes: string[][] = []
  const tree = (locale: 'en' | 'zh-CN') => e(SDK.PluginClientHostContext.Provider, { value: { ...port, locale } },
    e('div', null,
      e(SDK.CopyButton, { text: 'user text' }),
      e(SDK.DataTable, { loading: true, children: null }),
      e(SDK.DataTable, { empty: true, children: null }),
      e(SDK.MultiSelect, { options, value: ['v0', 'v1'], open: true, inline: true, onValuesChange: (values: string[]) => changes.push(values) })))
  const { root, host } = mount(tree('en'))
  try {
    assert.equal(host.querySelector('button')?.getAttribute('title'), 'Copy')
    assert.equal(host.querySelector('[role="status"]')?.textContent, 'Loading…')
    assert.equal(host.querySelector('.table-empty')?.textContent, 'No data')
    assert.equal(host.querySelector('.helm-select-label')?.textContent, '2 selected')
    assert.equal(host.querySelector('input')?.getAttribute('placeholder'), 'Search options…')
    act(() => root.render(tree('zh-CN')))
    assert.equal(host.querySelector('button')?.getAttribute('title'), '复制')
    assert.equal(host.querySelector('[role="status"]')?.textContent, '加载中…')
    assert.equal(host.querySelector('.table-empty')?.textContent, '暂无数据')
    assert.equal(host.querySelector('.helm-select-label')?.textContent, '已选择 2 项')
    assert.equal(host.querySelector('input')?.getAttribute('placeholder'), '搜索选项…')
    assert.equal(host.querySelectorAll('[role="option"][aria-selected="true"]').length, 2)
    assert.deepEqual(changes, [], 'changing locale never submits a selection change')
    act(() => root.render(tree('en')))
    assert.equal(host.querySelector('.helm-select-label')?.textContent, '2 selected')
    assert.equal(host.querySelector('button')?.getAttribute('title'), 'Copy')
  } finally {
    act(() => root.unmount())
  }
})

test('ViewBoundary translates its retry UI while preserving the original diagnostic across locale changes', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  let failing = true
  function Content(): React.ReactNode {
    if (failing) throw new Error('stable render diagnostic')
    return e('span', null, 'restored user content')
  }
  const tree = (locale: 'en' | 'zh-CN') => e(SDK.PluginClientHostContext.Provider, { value: { ...port, locale } },
    e(SDK.ViewBoundary, null, e(Content)))
  const previousConsoleError = console.error
  let mounted: ReturnType<typeof mount> | undefined
  try {
    console.error = () => {}
    mounted = mount(tree('en'))
    const { host, root } = mounted
    assert.equal(host.querySelector('strong')?.textContent, 'View failed to render')
    assert.equal(host.querySelector('p')?.textContent, 'stable render diagnostic')
    act(() => root.render(tree('zh-CN')))
    assert.equal(host.querySelector('strong')?.textContent, '视图渲染失败')
    assert.equal(host.querySelector('p')?.textContent, 'stable render diagnostic')
    const retry = host.querySelector<HTMLButtonElement>('button')
    assert.ok(retry)
    assert.equal(retry.textContent, '重新渲染')
    failing = false
    act(() => retry.click())
    assert.ok(host.querySelector('[role="alert"]') === null)
    assert.equal(host.textContent, 'restored user content')
  } finally {
    const root = mounted?.root
    if (root) act(() => root.unmount())
    console.error = previousConsoleError
  }
})

test('PluginSlot: short names qualify, lists render all matches, singles render the first, fallbacks render when empty, and missing owners warn', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const tree = (name: string, extra: Record<string, unknown> = {}, fallback?: React.ReactNode) =>
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'owner', undefined) },
        e(SDK.PluginSlot, { name, ...extra, ...(fallback !== undefined ? { fallback } : {}) })))

  const all = mount(tree('zone', { slotProps: { z: 1 } }))
  assert.equal(all.host.querySelectorAll('[data-slot]').length, 2, 'list mode renders every matched item')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.getAttribute('data-label'), 'Slot owner/zone/badge', 'the render label carries the fully qualified name')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.textContent, '{"z":1}', 'slotProps pass through to the host renderer')
  act(() => { void all.root.unmount() })

  const single = mount(tree('zone', { mode: 'single' }))
  assert.equal(single.host.querySelectorAll('[data-slot]').length, 1, 'single mode renders only the first item')
  act(() => { void single.root.unmount() })

  const empty = mount(tree('nope', {}, e('div', null, 'fallback-here')))
  assert.equal(empty.host.textContent, 'fallback-here', 'no matches render the fallback')
  act(() => { void empty.root.unmount() })

  const noOwner = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port }, e(SDK.PluginSlot, { name: 'zone' })))
  assert.match(noOwner.host.textContent ?? '', /no host plugin context/, 'missing owner warns explicitly')
  act(() => { void noOwner.root.unmount() })
})

test('PluginSlot: reappearing contribution on the render chain warns of a cycle explicitly without infinite recursion', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  // The host render implementation renders the same slot again (equivalent to
  // a real cycle where the contribution component nests a same-named slot)
  port.slots = {
    collectItems: (qualifiedName) =>
      qualifiedName === 'owner/loop'
        ? [{ pluginId: 'p2', contributionId: 'cycle', spec: { id: 'cycle', target: 'owner/loop' } }]
        : [],
    renderItem: (item) =>
      e(SDK.PluginClientHostContext.Provider, { value: port },
        e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, item.pluginId, undefined) },
          e(SDK.PluginSlot, { name: 'owner/loop' }))),
  }
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'owner', undefined) },
        e(SDK.PluginSlot, { name: 'loop' }))))
  assert.match(host.textContent ?? '', /cycle detected/, 'a cycle warns explicitly instead of a stack overflow')
  act(() => { void root.unmount() })
})

// ---------------------------------------------------------------------------
// 5. MarkdownView / CodeBlockView port delegation
// ---------------------------------------------------------------------------

test('MarkdownView / CodeBlockView render the host-port injected implementations (SSR safe)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const html = renderToString(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e('div', null,
        e(SDK.MarkdownView, { text: '# hi', workspaceBaseDir: 'docs/sub' }),
        e(SDK.CodeBlockView, { code: 'let x = 1', language: 'ts' }))))
  assert.match(html, /data-md="host"/, 'MarkdownView delegates to the host view')
  assert.match(html, /data-base-dir="docs\/sub"/, 'MarkdownView forwards workspaceBaseDir to host view')
  assert.match(html, /# hi/)
  assert.match(html, /data-code="host"/, 'CodeBlockView delegates to the host codeBlock')
  assert.match(html, /data-lang="ts"/)
})

test('markdownUrlTransform allows artifact:, file:, and Windows drive paths while filtering unsafe protocols', { timeout: 60_000 }, () => {
  assert.equal(SDK.markdownUrlTransform('artifact:art-1'), 'artifact:art-1')
  assert.equal(SDK.markdownUrlTransform('  file:///repo/README.md#L10  '), 'file:///repo/README.md#L10')
  assert.equal(SDK.markdownUrlTransform('FILE:///C:/repo/a.png'), 'FILE:///C:/repo/a.png')
  assert.equal(SDK.markdownUrlTransform('C:/repo/src/App.tsx#L10'), 'C:/repo/src/App.tsx#L10')
  assert.equal(SDK.markdownUrlTransform('d:\\repo\\a.png'), 'd:\\repo\\a.png')
  assert.equal(SDK.markdownUrlTransform('docs/guide.md#L5'), 'docs/guide.md#L5')
  assert.equal(SDK.markdownUrlTransform('https://example.com/a'), 'https://example.com/a')
  assert.equal(SDK.markdownUrlTransform('javascript:alert(1)'), '')
  assert.equal(SDK.markdownUrlTransform('data:text/html,<script>alert(1)</script>'), '')
  assert.equal(SDK.markdownUrlTransform('vbscript:msgbox(1)'), '')
  assert.equal(SDK.markdownUrlTransform('custom:foo'), '')
})

// ---------------------------------------------------------------------------
// 6. useConversation lazy detail option & useSharedNowMs shared ticker
// ---------------------------------------------------------------------------

test('useConversation: includeDetail defaults to true, skips auto-load when false while preserving cached detail and manual reload', { timeout: 60_000 }, () => {
  const loadCalls: Array<{ id: number; force?: boolean }> = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const cachedDetail = { id: 8, entries: [] } as unknown as SDK.PluginClientHostPort['conversationDetails'][number]
  const port = makePort(log, {
    conversations: [
      { id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as SDK.PluginClientHostPort['conversations'][number],
      { id: 8, title: 'c8', tags: [], profileId: 'p' } as unknown as SDK.PluginClientHostPort['conversations'][number],
    ],
    conversationDetails: { 8: cachedDetail },
    conversationLives: { 7: { conversationId: 7, status: 'working' } as unknown as SDK.PluginClientHostPort['conversationLives'][number] },
    pendingAsks: [{ id: 'ask-7', conversationId: 7 } as unknown as SDK.PluginClientHostPort['pendingAsks'][number]],
    loadConversationDetail: (id, force) => {
      loadCalls.push({ id, force })
      return Promise.resolve(undefined)
    },
  })

  let view7!: SDK.ConversationHookResult
  let view8!: SDK.ConversationHookResult
  function Probe({ includeDetail }: { includeDetail?: boolean }): React.ReactNode {
    view7 = SDK.useConversation(7, includeDetail === undefined ? undefined : { includeDetail })
    view8 = SDK.useConversation(8, { includeDetail: false })
    return e('div', null, 'probe')
  }

  // 1. includeDetail: false skips auto-load, still returns summary/live/pendingAsks and already-cached detail.
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, { includeDetail: false })),
  )
  try {
    assert.deepEqual(loadCalls, [], 'includeDetail: false must not auto-call loadConversationDetail')
    assert.equal(view7.summary?.id, 7)
    assert.equal(view7.detail, undefined)
    assert.equal(view7.live?.conversationId, 7)
    assert.equal(view7.pendingAsks.length, 1)
    assert.ok(view8.detail === cachedDetail, 'already-cached detail is still returned when includeDetail is false')

    // Manual reload still forces a detail fetch even when includeDetail is false.
    act(() => view7.reload())
    assert.deepEqual(loadCalls, [{ id: 7, force: true }])

    // 2. Flipping includeDetail to default/true triggers auto-load on missing detail.
    act(() => root.render(e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, {}))))
    assert.deepEqual(loadCalls, [
      { id: 7, force: true },
      { id: 7, force: undefined },
    ])
  } finally {
    act(() => root.unmount())
  }
})

test('useSharedNowMs: SSR returns undefined, 20 concurrent active consumers share one setInterval, and deactivation/unmount clears timer immediately', { timeout: 60_000 }, async () => {
  // 1. SSR deterministic first frame returns undefined even when active=true.
  let ssrValue: number | undefined = 123
  function SsrProbe(): React.ReactNode {
    ssrValue = SDK.useSharedNowMs(true, 25)
    return e('span', null, String(ssrValue))
  }
  const html = renderToString(e(SsrProbe))
  assert.equal(ssrValue, undefined)
  assert.equal(html, '<span>undefined</span>')

  // 2. Client shared ticker: 20 subscribers with same intervalMs create only 1 setInterval.
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  let setIntervalCount = 0
  let clearIntervalCount = 0
  const activeTimers = new Set<unknown>()

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    setIntervalCount += 1
    const handle = origSetInterval(handler, timeout, ...args)
    activeTimers.add(handle)
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (activeTimers.delete(handle)) {
      clearIntervalCount += 1
    }
    origClearInterval(handle)
  }) as typeof clearInterval

  let mounted: ReturnType<typeof mount> | undefined
  try {
    const latest = new Array<number | undefined>(20).fill(undefined)
    let fastValue: number | undefined
    function Card({ idx, active }: { idx: number; active: boolean }): React.ReactNode {
      latest[idx] = SDK.useSharedNowMs(active, 25)
      return e('span', null, String(latest[idx]))
    }
    function FastCard({ active }: { active: boolean }): React.ReactNode {
      fastValue = SDK.useSharedNowMs(active, 40)
      return e('span', null, String(fastValue))
    }
    const buildTree = (active20: boolean, activeFast: boolean) =>
      e('div', null,
        ...Array.from({ length: 20 }, (_, idx) => e(Card, { key: idx, idx, active: active20 })),
        e(FastCard, { active: activeFast }),
      )

    // Inactive mount creates zero timers.
    mounted = mount(buildTree(false, false))
    assert.equal(setIntervalCount, 0)
    assert.equal(activeTimers.size, 0)
    assert.ok(latest.every((v) => v === undefined))

    // Activating all 20 (interval=25ms) + 1 (interval=40ms) creates exactly 2 timers total.
    act(() => mounted!.root.render(buildTree(true, true)))
    assert.equal(setIntervalCount, 2, '20 cards at 25ms share 1 timer + 1 card at 40ms = 2 timers total')
    assert.equal(activeTimers.size, 2)
    assert.ok(latest.every((v) => typeof v === 'number'), 'all active hooks initialize Date.now() immediately')
    assert.equal(typeof fastValue, 'number')
    const initialSample = latest[0]!

    // Wait for shared tick to advance all 20 subscribers together to the exact same timestamp.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70))
    })
    assert.ok(latest[0]! > initialSample, 'shared ticker advances nowMs')
    assert.ok(latest.every((v) => v === latest[0]), 'all 20 subscribers receive identical tick timestamp')

    // Deactivating the 20 cards clears the 25ms timer immediately while keeping the 40ms timer alive.
    act(() => mounted!.root.render(buildTree(false, true)))
    assert.ok(latest.every((v) => v === undefined), 'active -> false immediately resets return value to undefined')
    assert.equal(clearIntervalCount, 1)
    assert.equal(activeTimers.size, 1)

    // Unmounting cleans up the remaining 40ms timer with zero leaks.
    act(() => mounted!.root.unmount())
    mounted = undefined
    assert.equal(clearIntervalCount, 2)
    assert.equal(activeTimers.size, 0)
  } finally {
    const remaining = mounted
    if (remaining) act(() => remaining.root.unmount())
    globalThis.setInterval = origSetInterval
    globalThis.clearInterval = origClearInterval
  }
})

// ---------------------------------------------------------------------------
// 7. usePluginConfig contract
// ---------------------------------------------------------------------------

test('usePluginConfig: returns current plugin publicConfig, falls back to stable empty object when absent, and updates reactively', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  port.plugins = [
    {
      id: 'p1',
      name: 'P1',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
      publicConfig: { slidingWindowMs: 1500, mode: 'auto' },
    },
    {
      id: 'p2',
      name: 'P2',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
    },
  ]

  const p1Seen: Array<{ slidingWindowMs?: number; mode?: string; apiKey?: string }> = []
  const p2Seen: Array<Record<string, unknown>> = []

  function P1Probe(): React.ReactNode {
    const cfg = SDK.usePluginConfig<{ slidingWindowMs?: number; mode?: string; apiKey?: string }>()
    p1Seen.push(cfg)
    return e('div', null, `${cfg.slidingWindowMs ?? 'none'}:${cfg.apiKey ?? 'no-secret'}`)
  }

  function P2Probe(): React.ReactNode {
    const cfg = SDK.usePluginConfig()
    p2Seen.push(cfg)
    return e('div', null, JSON.stringify(cfg))
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const renderTree = (activePort: SDK.PluginClientHostPort) =>
    act(() => {
      root.render(
        e(SDK.PluginClientHostContext.Provider, { value: activePort },
          e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(activePort, 'p1', undefined) }, e(P1Probe)),
          e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(activePort, 'p2', undefined) }, e(P2Probe))),
      )
    })

  try {
    renderTree(port)
    assert.deepEqual(p1Seen.at(-1), { slidingWindowMs: 1500, mode: 'auto' })
    assert.equal(p1Seen.at(-1)?.apiKey, undefined)
    assert.deepEqual(p2Seen.at(-1), {})
    const firstEmptyRef = p2Seen.at(-1)

    const updatedPort: SDK.PluginClientHostPort = {
      ...port,
      plugins: [
        {
          ...port.plugins[0]!,
          publicConfig: { slidingWindowMs: 2500, mode: 'fast' },
        },
        port.plugins[1]!,
      ],
    }
    renderTree(updatedPort)
    assert.deepEqual(p1Seen.at(-1), { slidingWindowMs: 2500, mode: 'fast' })
    assert.ok(p2Seen.at(-1) === firstEmptyRef, 'absent publicConfig reuses a referentially stable empty object')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('usePluginConfig: throws explicitly when called outside <PluginUiView>', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  function OutsideProbe(): React.ReactNode {
    SDK.usePluginConfig()
    return e('div', null, 'probe')
  }
  assert.throws(
    () => renderToString(e(SDK.PluginClientHostContext.Provider, { value: port }, e(OutsideProbe))),
    /usePluginContext/,
    'usePluginConfig throws outside <PluginUiView>',
  )
})
