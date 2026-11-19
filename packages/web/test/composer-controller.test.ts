/**
 * ComposerController and plugin command derivation tests (real React DOM mount + intercepted fetch):
 * - controller reads the real draft / attachments / sending (nothing fabricated);
 * - setDraft / insertText caret insertion and draft sync;
 * - submit(undefined) reuses the host send chain (validation / whenBusy / attachments / failure restore);
 * - submit(explicitText) consumes no draft / edit anchor / attachments and rejects honestly on failure;
 * - the slash menu merges plugin commands; unknown slash words never swallow the draft;
 *   cross-plugin actionPluginId routing;
 * - ⌘K and '/' share the same command behavior (icon / description / scope).
 *
 * The store is a minimal test double (real data, real behavior assertions); the fetch
 * interception captures real request bodies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

// Critical ordering constraint: synthetic event delegation with happy-dom + react-dom 19
// requires the happy-dom globals to be registered before importing react-dom/client; otherwise
// react-dom caches the original addEventListener reference and delegated listeners on the root
// container never receive dispatched events (onChange never fires; verified by probe).
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

// Synthetic onChange of a controlled textarea needs the native value tracker to notice programmatic
// assignment: a direct ta.value= does not advance react-dom's _valueTracker, so onChange is judged
// unchanged and never fires.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ComposerController, ConversationSummary, PluginUiContribution } from '@helmx/protocol'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { usePluginContext } from '@helmx/plugin-client'
import { groupUiContributions } from '../src/lib/types.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import {
  buildSlashMenuItems,
  commandActionPluginId,
  commandHint,
  commandsForConversation,
  executePluginSlashAction,
  insertAtCaret,
  isValidPluginSlash,
  matchExactPluginSlash,
  pluginSlashCommandsFor,
  removeTokenBeforeCaret,
  replaceSlashToken,
} from '../src/lib/commands-model.js'

/** Real user typing path: native setter assignment + value tracker reset + input dispatch. */
function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  // Only after the tracker resets to the old value will react-dom see the value as changed and fire onChange
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Pure functions: commands-model
// ---------------------------------------------------------------------------

const conv = (id: number, tags: string[] = []): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId: 'coder', tags, cwd: '/tmp', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})

const cmd = (pluginId: string, spec: Record<string, unknown>) => ({
  pluginId,
  spec: { id: `cmd-${pluginId}`, title: `命令 ${pluginId}`, ...spec },
})

test('isValidPluginSlash: reserved words and the skill: prefix are rejected; valid lowercase triggers pass', { timeout: 60_000 }, () => {
  assert.equal(isValidPluginSlash('archive'), true)
  assert.equal(isValidPluginSlash('run-tests2'), true)
  assert.equal(isValidPluginSlash('a:b_c-d'), true)
  assert.equal(isValidPluginSlash('new'), false, 'host reserved word')
  assert.equal(isValidPluginSlash('clear'), false)
  assert.equal(isValidPluginSlash('compact'), false)
  assert.equal(isValidPluginSlash('skill:foo'), false, 'the skill: namespace is reserved')
  assert.equal(isValidPluginSlash('Archive'), false, 'uppercase rejected')
  assert.equal(isValidPluginSlash(''), false)
  assert.equal(isValidPluginSlash('/x'), false)
})

test('pluginSlashCommandsFor: only commands declaring slash+actionId and matching scope; duplicate slash takes the first', { timeout: 60_000 }, () => {
  const commands = [
    cmd('p1', { slash: 'archive', actionId: 'archive' }),
    cmd('p1', { slash: 'noop' }), // no actionId: nothing to execute, excluded from completion
    cmd('p2', { slash: 'archive', actionId: 'archive2' }), // duplicate slash: first wins
    cmd('p3', { slash: 'worker-only', actionId: 'w', scope: { tags: ['worker'] } }),
    cmd('p4', { slash: 'new', actionId: 'x' }), // reserved word: defensively skipped
  ]
  const hit = pluginSlashCommandsFor(commands, conv(1))
  assert.deepEqual(hit.map((c) => c.spec.slash), ['archive'])
  const workerHit = pluginSlashCommandsFor(commands, conv(2, ['worker']))
  assert.deepEqual(workerHit.map((c) => c.spec.slash), ['archive', 'worker-only'])
  // No conversation context: only scope-free commands
  assert.deepEqual(pluginSlashCommandsFor(commands, undefined).map((c) => c.spec.slash), ['archive'])
})

test('buildSlashMenuItems: three-source merge; plugin commands run without write-back', { timeout: 60_000 }, () => {
  const executed: string[] = []
  const items = buildSlashMenuItems(
    [{ id: 'review', name: '代码审查' }],
    [cmd('p1', { slash: 'archive', actionId: 'archive', title: '归档' })],
    (c) => executed.push(c.pluginId),
    'en',
  )
  assert.deepEqual(
    items.map((i) => i.id),
    ['/new', '/clear', '/compact', '/skill:review', 'plugin:p1/cmd-p1'],
  )
  const pluginItem = items[4]!
  assert.equal(pluginItem!.label, '/archive')
  assert.equal(pluginItem!.apply, undefined, 'plugin commands never write the trigger word back')
  pluginItem!.run!()
  assert.deepEqual(executed, ['p1'])
})

test('matchExactPluginSlash: exact first-token hit; arguments never hit', { timeout: 60_000 }, () => {
  const commands = [cmd('p1', { slash: 'archive', actionId: 'archive' })]
  assert.equal(matchExactPluginSlash('/archive', commands)?.pluginId, 'p1')
  assert.equal(matchExactPluginSlash('  /archive  ', commands)?.pluginId, 'p1')
  assert.equal(matchExactPluginSlash('/archive extra', commands), undefined, 'with arguments it never hits')
  assert.equal(matchExactPluginSlash('/archivex', commands), undefined)
  assert.equal(matchExactPluginSlash('/new', commands), undefined, 'reserved words never hit plugin commands')
})

test('insertAtCaret / removeTokenBeforeCaret / replaceSlashToken: caret insertion and trigger-token replacement', { timeout: 60_000 }, () => {
  assert.deepEqual(insertAtCaret('hello', 5, '@a1 '), { next: 'hello@a1 ', nextCaret: 9 })
  assert.deepEqual(insertAtCaret('hello', 0, 'x'), { next: 'xhello', nextCaret: 1 })
  assert.deepEqual(insertAtCaret('hello', 99, '!'), { next: 'hello!', nextCaret: 6 }, 'out-of-range clamps to the end')
  assert.deepEqual(insertAtCaret('hello', -3, '!'), { next: '!hello', nextCaret: 1 }, 'negative clamps to 0')
  // Trigger cleanup: removes only the nearest token before the caret (same token regex as applyPopover:
  // leading whitespace included); the rest of the draft is kept verbatim
  assert.deepEqual(removeTokenBeforeCaret('/ar rest', 3), { next: ' rest', nextCaret: 0 })
  assert.deepEqual(removeTokenBeforeCaret('text /archi', 10), { next: 'text i', nextCaret: 5 })
  assert.deepEqual(removeTokenBeforeCaret('plain', 5), { next: 'plain', nextCaret: 5 }, 'no token: the draft is not swallowed')
  assert.deepEqual(replaceSlashToken('/rev', 4, '/skill:review '), { next: '/skill:review ', nextCaret: 14 })
  assert.deepEqual(replaceSlashToken('请用 /rev 检查', 7, '/skill:review '), { next: '请用 /skill:review  检查', nextCaret: 17 })
  assert.deepEqual(replaceSlashToken('plain', 5, '/new'), { next: 'plain/new', nextCaret: 9 })
})

test('executePluginSlashAction: unified success/failure notices and optional conversationId passthrough', { timeout: 60_000 }, async () => {
  const notices: Array<{ level: string; title: string; conversationId?: number }> = []
  const invoked: Array<{ pluginId: string; actionId: string; conversationId?: number }> = []
  await executePluginSlashAction(cmd('p1', { slash: 'ping', title: '诊断', actionId: 'ping' }), {
    invokePluginAction: async (pluginId, actionId, _input, conversationId) => {
      invoked.push({ pluginId, actionId, conversationId })
      return { ok: true }
    },
    pushNotice: (n) => { notices.push(n) },
    locale: 'en',
  })
  assert.deepEqual(invoked, [{ pluginId: 'p1', actionId: 'ping', conversationId: undefined }])
  assert.equal(notices[0]!.level, 'info')
  assert.equal(notices[0]!.conversationId, undefined)

  await assert.rejects(
    executePluginSlashAction(cmd('p1', { slash: 'ping', title: '诊断', actionId: 'ping' }), {
      invokePluginAction: async () => { throw new Error('offline') },
      pushNotice: (n) => { notices.push(n) },
      locale: 'en',
      conversationId: 7,
    }),
    /offline/,
  )
  assert.equal(notices[1]!.level, 'error')
  assert.equal(notices[1]!.conversationId, 7)
  assert.match(notices[1]!.title, /\/ping/)
})

test('commandActionPluginId / commandHint: cross-plugin routing and hint derivation', { timeout: 60_000 }, () => {
  assert.equal(commandActionPluginId(cmd('p1', { actionId: 'a' })), 'p1')
  assert.equal(commandActionPluginId(cmd('p1', { actionId: 'a', actionPluginId: 'p2' })), 'p2')
  assert.equal(commandHint({ id: 'x', title: 't', description: '归档当前会话' } as never, 'p1', 'en'), '归档当前会话')
  assert.equal(commandHint({ id: 'x', title: 't', actionId: 'a' } as never, 'p1', 'en'), 'p1 / a')
  assert.equal(commandHint({ id: 'x', title: 't', actionId: 'a', actionPluginId: 'p2' } as never, 'p1', 'en'), 'p2 / a')
  assert.equal(commandHint({ id: 'x', title: 't' } as never, 'p1', 'en'), 'p1')
})

test('LocalizedText 命令元数据：hint 与通知正文按 locale 解析，纯字符串透传', { timeout: 60_000 }, async () => {
  // commandHint：description 地图按 locale 解析；空解析回落 action 寻址
  const localizedSpec = {
    id: 'x',
    title: { en: 'Archive', 'zh-CN': '归档会话' },
    description: { en: 'Archive the current conversation.', 'zh-CN': '归档当前会话。' },
    actionId: 'archive',
  } as never
  assert.equal(commandHint(localizedSpec, 'p1', 'zh-CN'), '归档当前会话。')
  assert.equal(commandHint(localizedSpec, 'p1', 'en'), 'Archive the current conversation.')
  assert.equal(commandHint({ id: 'x', title: 't', description: { en: '' } } as never, 'p1', 'zh-CN'), 'p1', '空描述回落 action 寻址')

  // buildSlashMenuItems：hint 优先解析后的 description，缺省回落解析后的 title
  const items = buildSlashMenuItems(
    [],
    [
      cmd('p1', { slash: 'archive', actionId: 'archive', title: { en: 'Archive', 'zh-CN': '归档' }, description: { en: 'Archive it.', 'zh-CN': '归档它。' } }),
      cmd('p2', { slash: 'clean', actionId: 'clean', title: { en: 'Clean', 'zh-CN': '清理' } }),
    ],
    () => {},
    'zh-CN',
  )
  assert.equal(items.find((i) => i.id === 'plugin:p1/cmd-p1')?.hint, '归档它。')
  assert.equal(items.find((i) => i.id === 'plugin:p2/cmd-p2')?.hint, '清理')
  const enItems = buildSlashMenuItems(
    [],
    [cmd('p2', { slash: 'clean', actionId: 'clean', title: { en: 'Clean', 'zh-CN': '清理' } })],
    () => {},
    'en',
  )
  assert.equal(enItems.find((i) => i.id === 'plugin:p2/cmd-p2')?.hint, 'Clean')

  // executePluginSlashAction：成功通知正文中的 title 按注入 locale 解析
  const notices: Array<{ level: string; body?: string }> = []
  await executePluginSlashAction(
    cmd('p3', { slash: 'ping', actionId: 'ping', title: { en: 'Ping', 'zh-CN': '探测' } }),
    {
      invokePluginAction: async () => undefined,
      pushNotice: (n) => { notices.push(n as { level: string; body?: string }) },
      locale: 'zh-CN',
    },
  )
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.body, '/ping · 探测', '通知正文消费解析后的 title 显示文案')
})

test('commandsForConversation: ⌘K and / share the same scope filtering', { timeout: 60_000 }, () => {
  const commands = [
    cmd('p1', { slash: 'archive', actionId: 'archive' }),
    cmd('p3', { actionId: 'w', scope: { tags: ['worker'] } }),
  ]
  assert.equal(commandsForConversation(commands, conv(1)).length, 1)
  assert.equal(commandsForConversation(commands, conv(2, ['worker'])).length, 2)
  assert.equal(commandsForConversation(commands, undefined).length, 1)
})

// ---------------------------------------------------------------------------
// Interaction: real mounted Composer + controller
// ---------------------------------------------------------------------------

function summary(id: number, status: ConversationSummary['status'] = 'idle'): ConversationSummary {
  return { ...conv(id), title: `会话 ${id}`, status }
}

interface CapturedRequest {
  method: string
  path: string
  body: Record<string, unknown>
}

/** 真实 external store + 动作捕获（invokePluginAction 换 spy、notices 经可观察状态读取）。 */
function makeStore(
  conversation: ConversationSummary,
  ui: PluginUiContribution[] = [],
): HelmxExternalStore & { actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> } {
  const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  const store = makeTestStore({
    conversations: [conversation],
    uiContributions: ui,
    primaryTarget: { kind: 'conversation', conversationId: conversation.id },
  })
  ;(store.actions as unknown as { invokePluginAction: (pluginId: string, actionId: string, input: unknown, conversationId?: number) => Promise<unknown> }).invokePluginAction =
    async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => {
      actionCalls.push({ pluginId, actionId, input, conversationId })
      return { ok: true }
    }
  return Object.assign(store, { actionCalls })
}

/** Intercept global fetch to capture /api/conversations/:id/input bodies; reply controls success/failure. */
function stubFetch(captured: CapturedRequest[], ok: boolean): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.includes('/client.mjs')) return new Response('', { headers: { 'x-helmx-client-hash': 'seeded' } })
    captured.push({ method: String(init?.method ?? 'GET'), path, body: init?.body ? JSON.parse(String(init.body)) : {} })
    if (!ok) {
      return new Response(JSON.stringify({ error: { code: 'validation_error', message: '服务端拒绝' } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ submissionId: 's1' }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const { Composer } = await import('../src/conversation/Composer.js')

/** Mount the real Composer tree (real user-path assertions: textarea typing + keyboard/buttons + fetch capture). */
function mountComposer(
  conversation: ConversationSummary,
  ui: PluginUiContribution[],
): { host: HTMLElement; store: ReturnType<typeof makeStore>; unmount: () => void } {
  const store = makeStore(conversation, ui)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  act(() => {
    root = createRoot(host)
    root.render(
      React.createElement(
        HostStoreProviders,
        { value: store },
        React.createElement(Composer, { conversation, prefill: null }),
      ),
    )
  })
  return {
    host,
    store,
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

const textareaOf = (host: HTMLElement): HTMLTextAreaElement => {
  const el = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
  assert.ok(el !== null, 'the input must render')
  return el
}

const sendButtonOf = (host: HTMLElement): HTMLButtonElement => {
  for (const btn of host.querySelectorAll<HTMLButtonElement>('button')) {
    if ((btn.getAttribute('aria-label') ?? '').includes('发送')) return btn
  }
  assert.fail('send button not found')
}

test('interaction: type a draft and submit; the draft clears and the request body is correct; failure restores it', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const conversation = summary(1, 'idle')
  const { host, unmount } = mountComposer(conversation, [])
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '你好，世界')
    })
    assert.equal(ta.value, '你好，世界')
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.path, '/api/conversations/1/input')
    assert.equal(captured[0]!.body.text, '你好，世界')
    assert.equal(captured[0]!.body.origin, 'human')
    assert.equal(ta.value, '', 'the draft clears after submit')
  } finally {
    unmount()
    restore()
  }
})

test('interaction: draft restore on send failure (rollback after optimistic clear); the error stays visible', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, false)
  const conversation = summary(2, 'idle')
  const { host, unmount } = mountComposer(conversation, [])
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '会失败的消息')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.length, 1)
    assert.equal(ta.value, '会失败的消息', 'the live draft was untouched by the user, so the restore rolls back')
  } finally {
    unmount()
    restore()
  }
})

test('interaction: busy conversation Enter steers (whenBusy=steer); ⌘Enter queues (followUp)', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const conversation = summary(3, 'working')
  const { host, unmount } = mountComposer(conversation, [])
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '插话')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(captured[0]!.body.whenBusy, 'steer', 'busy defaults to steering')
    await act(async () => {
      typeInto(ta, '排队')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(captured[1]!.body.whenBusy, 'followUp', '⌘Enter queues the send')
  } finally {
    unmount()
    restore()
  }
})

test('interaction: /new without a host callback neither resets nor lands input; /clear still resets the context immediately', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const { host, unmount } = mountComposer(summary(4, 'idle'), [])
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '/new')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    // The first Enter is captured by the slash popover: it writes the picked '/new' back and closes
    await act(async () => {})
    assert.equal(ta.value, '/new')
    // The second Enter submits: /new is the new-topic entry; without a host callback it notifies
    // explicitly — no reset of the original conversation and no input landing
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.filter((c) => c.path.endsWith('/input')).length, 0, 'management commands never submit via input')
    assert.equal(captured.some((c) => c.path.endsWith('/reset')), false, '/new no longer triggers reset')

    // /clear keeps the original reset semantics
    await act(async () => {
      typeInto(ta, '/clear')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.some((c) => c.path.endsWith('/reset')), true, '/clear triggers reset')
    assert.equal(captured.filter((c) => c.path.endsWith('/input')).length, 0, '/clear does not submit via input')
  } finally {
    unmount()
    restore()
  }
})

test('interaction: unknown slash words never swallow the draft; they submit as plain text', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const { host, unmount } = mountComposer(summary(5, 'idle'), [])
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '/definitely-not-registered')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    // The first Enter is captured by the slash popover (with no matches it closes without write-back)
    await act(async () => {})
    // The second Enter submits: the unknown slash word goes as plain text
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured[0]!.body.text, '/definitely-not-registered', 'unknown slash submits as plain text; the draft is not swallowed')
  } finally {
    unmount()
    restore()
  }
})

const archiveCommandUi: PluginUiContribution[] = [
  {
    pluginId: 'p1',
    surface: 'command',
    spec: {
      id: 'arch',
      title: '归档当前会话',
      slash: 'archive',
      description: '归档并释放资源',
      actionId: 'archive',
      input: { mode: 'soft' },
      icon: 'archive',
    },
  },
  {
    pluginId: 'p2',
    surface: 'command',
    spec: {
      id: 'cross',
      title: '跨插件路由命令',
      slash: 'cross-route',
      actionId: 'target-action',
      actionPluginId: 'p9',
    },
  },
]

test('interaction: a draft whose first token hits a plugin command executes the action (context carries the conversation id) and clears', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const { host, unmount } = mountComposer(summary(6, 'idle'), archiveCommandUi)
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '/archive')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    // The first Enter is captured by the slash popover: the plugin command runs on pick (no draft write-back) and the popover closes
    await act(async () => {})
  // Note: never assert.equal(element, null) — on failure node would serialize the whole DOM+Fiber cyclic
  // tree and once blew a single-process heap past 20GB+.
    assert.ok(host.querySelector('.composer-popover') === null, 'the popover closes after executing the plugin command')
    // The second Enter: the draft is already empty, no submit happens (nothing lands in input)
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.filter((c) => c.path.endsWith('/input')).length, 0, 'a plugin command hit never submits via input')
    assert.equal(ta.value, '', 'the draft clears after picking the plugin command')
  } finally {
    unmount()
    restore()
  }
})

test('action routing: actionPluginId cross-plugin routing + conversationId as the fourth argument', { timeout: 60_000 }, async () => {
  const store = makeStore(summary(7, 'idle'), archiveCommandUi)
  const commands = store.getGroupedUi().commands
  const cross = commands.find((c: { spec: { id: string } }) => c.spec.id === 'cross')!
  await store.actions.invokePluginAction(commandActionPluginId(cross), cross.spec.actionId!, cross.spec.input, 7)
  assert.equal(store.actionCalls[0]!.pluginId, 'p9')
  assert.equal(store.actionCalls[0]!.actionId, 'target-action')
  assert.equal(store.actionCalls[0]!.conversationId, 7)
})

test('the slash popover merges plugin commands: typing /ar pops /archive; picking runs without write-back', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const { host, unmount } = mountComposer(summary(8, 'idle'), archiveCommandUi)
  try {
    const ta = textareaOf(host)
    await act(async () => {
      typeInto(ta, '/')
    })
    await act(async () => {})
    const popover = host.querySelector('.composer-popover')
    assert.ok(popover !== null, "'/' prefix opens the slash popover")
    assert.match(popover.textContent!, /\/archive/, 'plugin commands enter the popover')
    assert.match(popover.textContent!, /跨插件路由命令|\/cross-route/, 'the second plugin command enters the popover')
    // Keep typing ar to filter
    await act(async () => {
      typeInto(ta, '/ar')
    })
    await act(async () => {})
    assert.match(host.querySelector('.composer-popover')!.textContent!, /\/archive/)
  } finally {
    unmount()
    restore()
  }
})

function mountControllerProbe(conversation: ConversationSummary) {
  let controller: ComposerController | undefined
  function Probe(props: { composer: ComposerController }) {
    controller = usePluginContext().composer
    assert.equal(controller, props.composer, 'props and the shared SDK context use the same controller')
    return React.createElement('span', null, 'controller probe')
  }
  seedPluginClientModule('test:controller', 'probe.tsx', { Probe })
  const mounted = mountComposer(conversation, [{ pluginId: 'test:controller', surface: 'composer.widget', spec: {
    id: 'probe', client: { module: 'probe.tsx', export: 'Probe' },
  } }])
  assert.ok(controller)
  return { ...mounted, controller: controller! }
}

test('controller real integration: setDraft then submit in the same event uses the newest draft; a reject busy policy never becomes steer', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, true)
  const app = mountControllerProbe(summary(31, 'working'))
  try {
    await act(async () => {
      app.controller.setDraft('立即提交的新草稿')
      assert.equal(app.controller.draft, '立即提交的新草稿')
      await app.controller.submit(undefined, { whenBusy: 'reject' })
    })
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.body.text, '立即提交的新草稿')
    assert.equal(captured[0]!.body.whenBusy, 'reject')
  } finally { app.unmount(); restore() }
})

test('controller real integration: failure rejects and restores the draft; explicit text consumes no draft; insertion replaces the selection', { timeout: 60_000 }, async () => {
  const captured: CapturedRequest[] = []
  let restore = stubFetch(captured, false)
  const app = mountControllerProbe(summary(32))
  try {
    await act(async () => {
      app.controller.setDraft('abcdef')
      await assert.rejects(app.controller.submit(), /服务端拒绝/)
    })
    assert.equal(textareaOf(app.host).value, 'abcdef')
    restore()
    restore = stubFetch(captured, true)
    await act(async () => { await app.controller.submit('独立消息') })
    assert.equal(textareaOf(app.host).value, 'abcdef')
    assert.equal(captured.at(-1)!.body.text, '独立消息')
    await act(async () => {
      textareaOf(app.host).setSelectionRange(1, 4)
      app.controller.insertText('X')
    })
    assert.equal(textareaOf(app.host).value, 'aXef')
  } finally { app.unmount(); restore() }
})

test('a failing plugin slash keeps the original draft and diagnoses explicitly', { timeout: 60_000 }, async () => {
  const restore = stubFetch([], true)
  const app = mountComposer(summary(33), [{ pluginId: 'test:slash', surface: 'commandPalette', spec: {
    id: 'archive', title: '归档', slash: 'archive', actionId: 'archive',
  } }])
  ;(app.store.actions as unknown as { invokePluginAction: () => Promise<unknown> }).invokePluginAction = async () => { throw new Error('action unavailable') }
  try {
    await act(async () => { typeInto(textareaOf(app.host), '/archive') })
    await act(async () => {
      textareaOf(app.host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(textareaOf(app.host).value, '/archive')
    assert.ok(app.store.getNotices().some((notice: { title: string }) => String(notice.title).includes('Command failed')))
  } finally { app.unmount(); restore() }
})
