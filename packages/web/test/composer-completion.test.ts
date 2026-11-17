/**
 * Core closed-loop tests for the composerCompleter frontend:
 * - pure model: token detection (Chinese / path-slash / email-URL boundaries), replacement,
 *   source filter & ordering, doc/action boundary validation, manifest verification, merge
 *   dedupe & truncation, filtering;
 * - interaction (real mounted Composer): '@' '#' ':' plugin-source completion without host
 *   artifact candidates injected, scope filtering, action real conversationId + manifest
 *   verification, debounce races (late responses never restore), keyboard cycling limited to
 *   visible candidates (>12), IME never submits by accident, caret replacement,
 *   prefill.onlyIfEmpty draft protection, and the '/' slash regression.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HostStoreProviders } from './helpers/host-store.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type {
  ActionManifest,
  ConversationSummary,
  PluginUiContribution,
} from '@helm/protocol'
import { conversationsApi } from '../src/lib/api.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  COMPLETION_VISIBLE_LIMIT,
  buildCompletionActionCall,
  completersForTrigger,
  detectCompletionToken,
  extractCompletionItems,
  filterByQuery,
  mergeCompletionItems,
  parseCompletionActionResult,
  replaceTriggerToken,
  verifyCompletionActionManifest,
} from '../src/conversation/composer-completion-model.js'

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

test('detectCompletionToken: Chinese/path-slash queries; emails/URLs/times never mis-trigger', { timeout: 60_000 }, () => {
  assert.deepEqual(detectCompletionToken('@'), { trigger: '@', query: '', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken('看 @中文文档'), { trigger: '@', query: '中文文档', tokenStart: 2 })
  assert.deepEqual(detectCompletionToken('@docs/子目录/文件'), { trigger: '@', query: 'docs/子目录/文件', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken('#标签'), { trigger: '#', query: '标签', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken(':命令'), { trigger: ':', query: '命令', tokenStart: 0 })
  // Boundaries: not at line start / no whitespace before -> no trigger
  assert.equal(detectCompletionToken('user@example.com'), null, 'mid-email never triggers')
  assert.equal(detectCompletionToken('a.com/@mention'), null, '@ inside a URL never triggers')
  assert.equal(detectCompletionToken('12:30'), null, 'a time colon never triggers')
  assert.equal(detectCompletionToken('a:b'), null, 'a colon without preceding whitespace never triggers')
  // The slash-command charset is separate
  assert.deepEqual(detectCompletionToken('/arc'), { trigger: '/', query: 'arc', tokenStart: 0 })
  assert.equal(detectCompletionToken('a/b'), null, 'a mid-path slash never triggers a command')
})

test('replaceTriggerToken: replaces only the pre-caret trigger token, keeping surrounding text', { timeout: 60_000 }, () => {
  // Caret 5 (after 旧, before the space): the token @旧 is replaced; the text after it (including the original space) stays verbatim
  assert.deepEqual(replaceTriggerToken('前缀 @旧 中缀 后缀', 5, '@新引用 '), {
    next: '前缀 @新引用  中缀 后缀',
    nextCaret: 8,
  })
  assert.deepEqual(replaceTriggerToken('#tag', 4, '#new-tag '), { next: '#new-tag ', nextCaret: 9 })
  // Chinese tokens replace as a whole too: 看=0 ␠=1 @=2 中=3 文=4, caret 5
  assert.deepEqual(replaceTriggerToken('看 @中文 呀', 5, '@文档 '), { next: '看 @文档  呀', nextCaret: 6 })
})

test('completersForTrigger: trigger + scope filtering with stable priority desc', { timeout: 60_000 }, () => {
  const mk = (pluginId: string, spec: Record<string, unknown>): PluginUiContribution => ({
    pluginId,
    surface: 'composer.completer',
    spec: { id: `c-${pluginId}`, label: `源 ${pluginId}`, trigger: '@', source: { kind: 'doc', name: 'd', itemsField: 'items' }, ...spec },
  })
  const conv: ConversationSummary = {
    id: 1, title: 't', profileId: 'coder', tags: ['worker'], cwd: '/w', model: 'p/m',
    thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
    unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
  }
  const grouped = groupUiContributions([
    mk('p1', {}),
    mk('p2', { trigger: '#', priority: 5 }),
    mk('p3', { priority: 10 }),
    mk('p4', { scope: { tags: ['other'] } }),
    mk('p5', { priority: 10 }),
  ])
  const at = completersForTrigger(grouped.composerCompleters, '@', conv)
  assert.deepEqual(at.map((c) => c.pluginId), ['p3', 'p5', 'p1'], 'stable priority desc; scope misses removed')
  assert.deepEqual(completersForTrigger(grouped.composerCompleters, '#', conv).map((c) => c.pluginId), ['p2'])
  assert.deepEqual(completersForTrigger(grouped.composerCompleters, ':', conv), [], 'unregistered sources stay inactive')
})

test('extract/parse: per-item boundary validation; invalid items dropped with diagnostics', { timeout: 60_000 }, () => {
  const good = { id: 'a', label: 'A', insertText: 'x' }
  const doc = extractCompletionItems({ items: [good, { id: '', label: 'B', insertText: 'y' }, null, { id: 'c', label: 'C', insertText: 'z', hint: 1 }] }, 'items')
  assert.equal(doc.items!.length, 1)
  assert.equal(doc.items![0]!.id, 'a')
  assert.match(doc.error!, /3 invalid candidates dropped/)
  assert.equal(extractCompletionItems({ nope: [] }, 'items').error !== undefined, true, 'a missing array field diagnoses explicitly')
  assert.equal(extractCompletionItems(undefined, 'items').items, null, 'not-loaded is not an error')
  const action = parseCompletionActionResult({ items: [good, 'bad'] })
  assert.equal(action.items!.length, 1)
  assert.match(action.error!, /1 invalid candidates dropped/)
  assert.match(parseCompletionActionResult({ nope: 1 }).error!, /missing the items array/)
})

test('verifyCompletionActionManifest: requires a real manifest with idempotent:true', { timeout: 60_000 }, () => {
  const actions: ActionManifest[] = [
    { pluginId: 'p1', id: 'search', description: '', inputSchema: {}, outputSchema: {}, idempotent: true },
    { pluginId: 'p1', id: 'mutate', description: '', inputSchema: {}, outputSchema: {} },
  ]
  assert.equal(verifyCompletionActionManifest(actions, 'p1', 'search'), null)
  assert.match(verifyCompletionActionManifest(actions, 'p1', 'mutate')!, /idempotent/)
  assert.match(verifyCompletionActionManifest(actions, 'p1', 'ghost')!, /not registered/)
})

test('buildCompletionActionCall: a real conversation passes conversationId; draft state decides profileId by schema or rejects explicitly', { timeout: 60_000 }, () => {
  const profileAware: ActionManifest = {
    pluginId: 'builtin:profile',
    id: 'list_mentionable',
    description: '',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, conversationId: { type: 'number' }, profileId: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: {},
  }
  const queryOnly: ActionManifest = {
    pluginId: 'p1',
    id: 'search',
    description: '',
    idempotent: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    outputSchema: {},
  }
  const convRequired: ActionManifest = {
    pluginId: 'p2',
    id: 'session_search',
    description: '',
    idempotent: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, conversationId: { type: 'number' } }, required: ['conversationId'] },
    outputSchema: {},
  }

  assert.deepEqual(buildCompletionActionCall(profileAware, 'co', { conversationId: 7, profileId: 'assistant' }), {
    input: { query: 'co', conversationId: 7 },
    conversationId: 7,
  })
  assert.deepEqual(buildCompletionActionCall(profileAware, 'co', { profileId: 'assistant' }), {
    input: { query: 'co', profileId: 'assistant' },
  })
  assert.deepEqual(buildCompletionActionCall(queryOnly, 'hi', { profileId: 'assistant' }), {
    input: { query: 'hi' },
  })
  const rejected = buildCompletionActionCall(convRequired, 'hi', { profileId: 'assistant' })
  assert.equal(rejected.input, null)
  assert.match(rejected.error!, /requires an existing conversation/)
})

test('merge/filter: plugin+source namespace dedupe, cap truncation, whitespace AND filtering', { timeout: 60_000 }, () => {
  const item = (id: string, label: string): { id: string; label: string; insertText: string } => ({ id, label, insertText: id })
  const merged = mergeCompletionItems([
    { pluginId: 'host', items: [item('a', '产物 A'), item('a', '产物 A 重复')] },
    { pluginId: 'p1', items: [item('a', '插件同 id 不去重')] },
  ])
  assert.equal(merged.items.length, 2, 'same id across plugins kept (namespace isolated); dedupe within a source')
  assert.equal(merged.items.filter((m) => m.key === `host\u0000a`).length, 1, 'dedupe within a source')
  const big = mergeCompletionItems([{ pluginId: 'p', items: Array.from({ length: 130 }, (_, i) => item(`i${i}`, `候选 ${i}`)) }])
  assert.equal(big.items.length, 100)
  assert.equal(big.truncated, true)
  assert.equal(big.total, 130)
  const filtered = filterByQuery([item('a', '部署 到 生产'), item('b', '部署')], '部署 生产')
  assert.deepEqual(filtered.map((f) => f.id), ['a'], 'whitespace-tokenized AND (Chinese)')
})

// ---------------------------------------------------------------------------
// Interaction: real mounted Composer
// ---------------------------------------------------------------------------

const { Composer } = await import('../src/conversation/Composer.js')

const conv = (id: number, tags: string[] = []): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId: 'coder', tags, cwd: '/w', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})

interface TestStoreOverrides {
  ui?: PluginUiContribution[]
  actions?: ActionManifest[]
  artifacts?: Array<{ id: string; name: string; mimeType: string; size: number }>
  docs?: Record<string, unknown>
  invokePluginAction?: (pluginId: string, actionId: string, input: unknown, conversationId?: number) => Promise<unknown>
}

function makeStore(conversation: ConversationSummary, opts: TestStoreOverrides = {}) {
  const noop = () => {}
  const asyncNoop = async () => undefined
  const notices: Array<Record<string, unknown>> = []
  const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  const store = {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark' as const, themePreference: 'system' as const,
    locale: 'en' as const,
    conversations: [conversation], conversationDetails: {}, conversationLives: {},
    conversationArtifacts: { [conversation.id]: opts.artifacts ?? [] },
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: opts.ui ?? [],
    groupedUi: groupUiContributions(opts.ui ?? []), pluginDocs: opts.docs ?? {}, nodes: [],
    profiles: [], profilesLoaded: true, assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: opts.actions ?? [],
    primaryTarget: { kind: 'conversation', conversationId: conversation.id }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices,
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop,
    setWorkbenchOpen: noop, setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop,
    pushNotice: (n: Record<string, unknown>) => { notices.push(n) },
    invokePluginAction: opts.invokePluginAction ?? (async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => {
      actionCalls.push({ pluginId, actionId, input, conversationId })
      return { items: [] }
    }),
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false }),
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  } as unknown as HelmStoreValue
  return { store, notices, actionCalls }
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mount(conversation: ConversationSummary, opts: TestStoreOverrides) {
  const made = makeStore(conversation, opts)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  let prefill: { text: string; tick: number; onlyIfEmpty?: boolean } | null = null
  const render = (p: { text: string; tick: number; onlyIfEmpty?: boolean } | null): void => {
    root = root ?? createRoot(host)
    const r = root
    act(() => {
      r.render(
        React.createElement(
          HostStoreProviders,
          { value: made.store },
          React.createElement(Composer, { conversation, prefill: p }),
        ),
      )
    })
  }
  render(null)
  const ta = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  const type = async (text: string): Promise<void> => {
    await act(async () => { typeInto(ta(), text) })
  }
  const key = async (k: string, init?: KeyboardEventInit): Promise<void> => {
    await act(async () => {
      ta().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
    })
  }
  const completionPopover = (): HTMLElement | null => host.querySelector('.composer-completion-popover')
  const completionItems = (): HTMLElement[] => Array.from(host.querySelectorAll('.composer-completion-popover [role="option"]'))
  return {
    ...made,
    host,
    type,
    key,
    ta,
    completionPopover,
    completionItems,
    rerenderPrefill: (p: { text: string; tick: number; onlyIfEmpty?: boolean } | null) => { render(p) },
    unmount: () => { act(() => root?.unmount()); host.remove() },
  }
}

const docCompleter = (pluginId: string, trigger: string, docName: string, extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId,
  surface: 'composer.completer',
  spec: { id: 'doc-c', label: `文档源 ${pluginId}`, trigger, source: { kind: 'doc', name: docName, itemsField: 'items' }, ...extra },
})

const actionCompleter = (pluginId: string, trigger: string, actionId: string, extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId,
  surface: 'composer.completer',
  spec: { id: 'act-c', label: `动作源 ${pluginId}`, trigger, source: { kind: 'action', actionId }, ...extra },
})

const manifest = (pluginId: string, id: string, idempotent = true): ActionManifest => ({
  pluginId, id, description: '', inputSchema: {}, outputSchema: {}, idempotent,
})

test('interaction: @ shows only plugin doc-source candidates, never host artifacts; picking keeps text and caret', { timeout: 60_000 }, async () => {
  const app = await mount(conv(1), {
    ui: [docCompleter('p1', '@', 'catalog')],
    docs: { 'p1/catalog': { items: [{ id: 'memory', label: '@记忆库', insertText: '@记忆库 ' }] } },
    artifacts: [{ id: 'art-1', name: '报告.pdf', mimeType: 'application/pdf', size: 1024 }],
  })
  try {
    await app.type('请看 @')
    await act(async () => {})
    const items = app.completionItems()
    assert.equal(items.length, 1, '仅展示插件源候选')
    assert.doesNotMatch(app.completionPopover()!.textContent!, /报告\.pdf/)
    assert.match(app.completionPopover()!.textContent!, /记忆库/)
    // Pick the plugin candidate via keyboard: replaces only @; surrounding text stays
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '请看 @记忆库 ')
    assert.equal(app.ta().selectionStart, '请看 @记忆库 '.length, 'the caret lands after the inserted text')
    assert.ok(app.completionPopover() === null, 'the popover closes after picking')
  } finally {
    app.unmount()
  }
})

test('interaction: Enter with the @ popover open only picks the profile and keeps it in the textarea — no message sent', { timeout: 60_000 }, async () => {
  const originalSubmit = conversationsApi.submitInput
  let submitCalls = 0
  conversationsApi.submitInput = (async () => {
    submitCalls++
    return { id: 1, text: '', role: 'user', createdAt: Date.now() } as any
  }) as any
  const app = await mount(conv(1), {
    ui: [docCompleter('builtin:profile', '@', 'profiles')],
    docs: { 'builtin:profile/profiles': { items: [{ id: 'coder', label: '@coder · 程序员', insertText: '@coder ' }] } },
  })
  try {
    await app.type('@')
    await act(async () => {})
    assert.equal(app.completionItems().length, 1, '弹窗展示角色候选')
    assert.match(app.completionPopover()!.textContent!, /coder/)

    // Press Enter to confirm the profile candidate
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    let propagationStopped = false
    ev.stopPropagation = () => { propagationStopped = true }
    await act(async () => {
      app.ta().dispatchEvent(ev)
    })
    await act(async () => {})

    assert.equal(ev.defaultPrevented, true, 'Enter is intercepted by the popover')
    assert.equal(propagationStopped, true, 'propagation stops so the textarea never sees it and sends')
    assert.equal(submitCalls, 0, 'picking a profile never calls submitInput to send directly')
    assert.equal(app.ta().value, '@coder ', '角色保留在文本框内')
    assert.equal(app.ta().selectionStart, '@coder '.length, 'the caret lands after the profile text')
    assert.ok(app.completionPopover() === null, 'the popover is closed')

    // Only after typing the rest of the message and pressing Enter does the send actually fire
    await app.type('@coder 帮我看下代码')
    await act(async () => {})
    assert.ok(app.completionPopover() === null, 'the popover is no longer active')
    await act(async () => {
      const sendEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      app.ta().dispatchEvent(sendEv)
    })
    await act(async () => {})
    assert.equal(submitCalls, 1, 'Enter after normal input sends normally')
  } finally {
    conversationsApi.submitInput = originalSubmit
    app.unmount()
  }
})

test('regression: with conversation artifacts but no registered @ sources, no popover opens and Enter is not swallowed', { timeout: 60_000 }, async () => {
  const app = await mount(conv(10), {
    artifacts: [{ id: 'art-1', name: '报告.pdf', mimeType: 'application/pdf', size: 1024 }],
  })
  try {
    await app.type('@')
    assert.ok(app.completionPopover() === null, 'no popover without registered sources')
    assert.equal(app.completionItems().length, 0, 'artifacts are not a built-in completion source')
    await app.type('@报告')
    assert.equal(app.completionItems().length, 0, 'searching never injects artifact candidates either')
    assert.equal(app.ta().value, '@报告', 'the trigger and typed text stay')
    // Without sources Enter is not swallowed by a popover: it takes the send branch
    // (unconditional preventDefault); the popover-intercept path never preventDefaults and
    // the popover is not even mounted.
    await act(async () => {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      app.ta().dispatchEvent(ev)
      assert.equal(ev.defaultPrevented, true, 'Enter takes the send branch instead of being swallowed by a popover')
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  } finally {
    app.unmount()
  }
})

test('interaction: # and : activate only registered sources; scope-missing sources never participate', { timeout: 60_000 }, async () => {
  const app = await mount(conv(2, ['worker']), {
    ui: [
      docCompleter('p1', '#', 'tags', { scope: { tags: ['worker'] } }),
      docCompleter('p2', ':', 'cmds', { scope: { tags: ['other'] } }),
    ],
    docs: {
      'p1/tags': { items: [{ id: 'bug', label: '#缺陷', insertText: '#缺陷 ' }] },
      'p2/cmds': { items: [{ id: 'run', label: ':运行', insertText: ':运行 ' }] },
    },
  })
  try {
    await app.type('#')
    await act(async () => {})
    assert.match(app.completionPopover()!.textContent!, /缺陷/, 'the scope-matching # source appears')
    await app.key('Escape')
    await app.type(':')
    await act(async () => {})
    assert.ok(app.completionPopover() === null, 'no registered : source after the scope miss, so no popover')
  } finally {
    app.unmount()
  }
})

test('interaction: action sources pass the real conversationId + manifest verification (unregistered/non-idempotent rejected and distinguishable)', { timeout: 60_000 }, async () => {
  const app = await mount(conv(3), {
    ui: [actionCompleter('p1', '@', 'search'), actionCompleter('p2', '#', 'mutate')],
    actions: [manifest('p1', 'search', true), manifest('p2', 'mutate', false)],
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      app.actionCalls.push({ pluginId, actionId, input, conversationId })
      assert.equal(conversationId, 3, 'the real conversation id must ride along')
      assert.deepEqual(input, { query: '', conversationId: 3 }, 'the query body carries the real conversation id; no fabricated nodeId/cwd')
      return { items: [{ id: 'hit', label: '@命中', insertText: '@命中 ' }] }
    },
  })
  try {
    await app.type('@')
    await act(async () => { await new Promise((r) => setTimeout(r, 220)) })
    assert.equal(app.actionCalls.length, 1, 'only manifest-verified sources issue calls')
    assert.equal(app.actionCalls[0]!.pluginId, 'p1')
    assert.match(app.completionPopover()!.textContent!, /命中/)
    await app.key('Escape')
    await app.type('#')
    await act(async () => {})
    assert.match(app.completionPopover()!.textContent!, /idempotent/, 'the non-idempotent action is rejected with a visible diagnosis')
    assert.equal(app.actionCalls.length, 1, 'no new calls issued')
  } finally {
    app.unmount()
  }
})

test('interaction: request race — a late response after switching conversations never restores the popover', { timeout: 60_000 }, async () => {
  let release: ((v: unknown) => void) | undefined
  const app = await mount(conv(4), {
    ui: [actionCompleter('p1', '@', 'search')],
    actions: [manifest('p1', 'search')],
    invokePluginAction: () => new Promise((resolve) => { release = resolve }),
  })
  try {
    await app.type('@')
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    assert.equal(app.completionPopover() !== null, true, 'the popover exists while the request is in flight (loading)')
    // Simulate the popover closing (equivalent to the generation advance after switching
    // conversations / disabling a source) before the response arrives
    await app.key('Escape')
    release?.({ items: [{ id: 'late', label: '@晚到', insertText: '@晚到 ' }] })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    const popover = app.completionPopover()
    assert.ok(popover === null, 'the late response never restores the popover')
    assert.equal(app.ta().value, '@', 'the draft is unaffected by the late response')
  } finally {
    app.unmount()
  }
})

test('interaction: with >12 candidates keyboard cycling stays within the visible set; the truncation hint shows', { timeout: 60_000 }, async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, label: `@候选${i}`, insertText: `@候选${i} ` }))
  const app = await mount(conv(5), {
    ui: [docCompleter('p1', '@', 'big')],
    docs: { 'p1/big': { items } },
  })
  try {
    await app.type('@')
    await act(async () => {})
    const visible = app.completionItems()
    assert.equal(visible.length, COMPLETION_VISIBLE_LIMIT, 'only 12 items shown')
    assert.match(app.completionPopover()!.textContent!, /showing the first 12/, 'the truncation hint is visible')
    // 13 consecutive ArrowDowns should wrap back to index 1 (12-item cycle); Enter picks a visible item
    for (let i = 0; i < 13; i++) await app.key('ArrowDown')
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '@候选1 ', 'the keyboard index matches the visible candidates (cycling never escapes into invisible items)')
  } finally {
    app.unmount()
  }
})

test('interaction: Enter during IME composing picks no candidate and submits no draft', { timeout: 60_000 }, async () => {
  const app = await mount(conv(6), {
    ui: [docCompleter('p1', '@', 'd')],
    docs: { 'p1/d': { items: [{ id: 'x', label: '@中文', insertText: '@中文 ' }] } },
  })
  try {
    await app.type('@')
    await act(async () => {})
    // happy-dom KeyboardEvent supports isComposing initialization
    await app.key('Enter', { isComposing: true } as KeyboardEventInit)
    assert.equal(app.ta().value, '@', 'Enter while composing picks no candidate')
    assert.notEqual(app.completionPopover(), null, 'the popover stays')
  } finally {
    app.unmount()
  }
})

test('interaction: mid-caret trigger — replaces the pre-caret token; post-caret text never moves', { timeout: 60_000 }, async () => {
  const app = await mount(conv(7), {
    ui: [docCompleter('p1', '#', 'd')],
    docs: { 'p1/d': { items: [{ id: 'x', label: '#词语', insertText: '#词语 ' }] } },
  })
  try {
    // Real editing path: type the full draft first, then select mid-token text and append input (the caret naturally lands inside the token)
    await app.type('#旧 后面的')
    await act(async () => {
      const ta = app.ta()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(ta, '#词 后面的')
      tracker?.setValue(prev)
      ta.setSelectionRange(2, 2)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {})
    assert.equal(app.ta().value, '#词 后面的')
    assert.equal(app.completionPopover() !== null, true, 'the popover activates while the caret sits inside the # trigger word')
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '#词语  后面的', 'only the pre-caret token is replaced; the text after it stays')
  } finally {
    app.unmount()
  }
})

test('interaction: prefill.onlyIfEmpty refuses with a warning on a non-empty draft; prefills normally when idle', { timeout: 60_000 }, async () => {
  const app = await mount(conv(8), {})
  try {
    await app.type('正在编辑的草稿')
    app.rerenderPrefill({ text: '引导词', tick: 1, onlyIfEmpty: true })
    await act(async () => {})
    assert.equal(app.ta().value, '正在编辑的草稿', 'the draft is unchanged')
    assert.ok(app.notices.some((n) => String(n.title).includes('Handle the current draft before picking a starter')), 'the warning notice is visible')
    // After clearing the draft, prefill is allowed
    await app.type('')
    app.rerenderPrefill({ text: '引导词', tick: 2, onlyIfEmpty: true })
    await act(async () => {})
    assert.equal(app.ta().value, '引导词', 'the idle draft prefills successfully')
    // Default (onlyIfEmpty omitted): the existing editing behavior is unchanged — direct overwrite
    app.rerenderPrefill({ text: 'Edit and resend', tick: 3 })
    await act(async () => {})
    assert.equal(app.ta().value, 'Edit and resend')
  } finally {
    app.unmount()
  }
})

test('regression: the three-source slash command & skill popover is unaffected', { timeout: 60_000 }, async () => {
  const app = await mount(conv(9), {})
  try {
    await app.type('/')
    await act(async () => {})
    const slash = app.host.querySelector('.composer-popover')
    assert.ok(slash !== null, 'the slash popover still renders')
    assert.match(slash!.textContent!, /\/new/)
    assert.match(slash!.textContent!, /\/compact/)
    await app.key('Escape')
    assert.ok(app.host.querySelector('.composer-popover') === null)
  } finally {
    app.unmount()
  }
})
