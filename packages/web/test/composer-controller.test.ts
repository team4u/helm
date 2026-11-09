/**
 * ComposerController 与插件命令派生测试（真实 React DOM 挂载 + 拦截 fetch）：
 * - controller 真实 draft / attachments / sending 读取（不虚构）；
 * - setDraft / insertText 光标插入与草稿同步；
 * - submit(undefined) 复用宿主发送链路（校验 / whenBusy / 附件 / 失败恢复）；
 * - submit(explicitText) 不消费草稿 / 编辑锚点 / 附件，失败如实 reject；
 * - 斜杠菜单合并插件命令、未知斜杠不吞草稿、跨插件 actionPluginId 路由；
 * - ⌘K 与 '/' 同一 command 行为一致（icon / description / 作用域）。
 *
 * store 为最小测试替身（数据真实、行为断言真实）；fetch 拦截捕获真实请求体。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// 重要顺序约束：happy-dom + react-dom 19 的合成事件委托要求在 import react-dom/client
// 之前挂载 happy-dom 全局；否则 react-dom 缓存原始 addEventListener 引用后，
// root 容器上的委托 listener 无法收到派发事件（onChange 永不触发，见探针验证）。
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

// 受控 textarea 的合成 onChange 需要原生 value tracker 感知程序赋值：
// 直接 ta.value= 不会推进 react-dom 的 _valueTracker，onChange 被判为无变化而不触发。
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ConversationSummary, PluginUiContribution } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  buildSlashMenuItems,
  commandActionPluginId,
  commandHint,
  commandsForConversation,
  insertAtCaret,
  isValidPluginSlash,
  matchExactPluginSlash,
  pluginSlashCommandsFor,
  removeTokenBeforeCaret,
} from '../src/lib/commands-model.js'

/** 真实用户键入路径：原生 setter 赋值 + 重置 value tracker + 派发 input。 */
function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  // tracker 重置为旧值，react-dom 才会判定 value 已变化并触发 onChange
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// 纯函数：commands-model
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

test('isValidPluginSlash：保留词与 skill: 前缀拒绝，合法小写触发词通过', { timeout: 60_000 }, () => {
  assert.equal(isValidPluginSlash('archive'), true)
  assert.equal(isValidPluginSlash('run-tests2'), true)
  assert.equal(isValidPluginSlash('a:b_c-d'), true)
  assert.equal(isValidPluginSlash('new'), false, '宿主保留词')
  assert.equal(isValidPluginSlash('clear'), false)
  assert.equal(isValidPluginSlash('compact'), false)
  assert.equal(isValidPluginSlash('skill:foo'), false, 'skill: 命名空间保留')
  assert.equal(isValidPluginSlash('Archive'), false, '大写拒绝')
  assert.equal(isValidPluginSlash(''), false)
  assert.equal(isValidPluginSlash('/x'), false)
})

test('pluginSlashCommandsFor：仅收声明 slash+actionId 且命中作用域的命令，重复 slash 取首个', { timeout: 60_000 }, () => {
  const commands = [
    cmd('p1', { slash: 'archive', actionId: 'archive' }),
    cmd('p1', { slash: 'noop' }), // 无 actionId：无从执行，不进补全
    cmd('p2', { slash: 'archive', actionId: 'archive2' }), // 重复 slash：取首个
    cmd('p3', { slash: 'worker-only', actionId: 'w', scope: { tags: ['worker'] } }),
    cmd('p4', { slash: 'new', actionId: 'x' }), // 保留词：防御性跳过
  ]
  const hit = pluginSlashCommandsFor(commands, conv(1))
  assert.deepEqual(hit.map((c) => c.spec.slash), ['archive'])
  const workerHit = pluginSlashCommandsFor(commands, conv(2, ['worker']))
  assert.deepEqual(workerHit.map((c) => c.spec.slash), ['archive', 'worker-only'])
  // 无会话上下文：仅不限作用域命令
  assert.deepEqual(pluginSlashCommandsFor(commands, undefined).map((c) => c.spec.slash), ['archive'])
})

test('buildSlashMenuItems：三源合并，插件命令 run 不回填', { timeout: 60_000 }, () => {
  const executed: string[] = []
  const items = buildSlashMenuItems(
    [{ id: 'review', name: '代码审查' }],
    [cmd('p1', { slash: 'archive', actionId: 'archive', title: '归档' })],
    (c) => executed.push(c.pluginId),
  )
  assert.deepEqual(
    items.map((i) => i.id),
    ['/new', '/clear', '/compact', '/skill:review', 'plugin:p1/cmd-p1'],
  )
  const pluginItem = items[4]!
  assert.equal(pluginItem!.label, '/archive')
  assert.equal(pluginItem!.apply, undefined, '插件命令不回填触发词')
  pluginItem!.run!()
  assert.deepEqual(executed, ['p1'])
})

test('matchExactPluginSlash：首 token 精确命中，带参数不命中', { timeout: 60_000 }, () => {
  const commands = [cmd('p1', { slash: 'archive', actionId: 'archive' })]
  assert.equal(matchExactPluginSlash('/archive', commands)?.pluginId, 'p1')
  assert.equal(matchExactPluginSlash('  /archive  ', commands)?.pluginId, 'p1')
  assert.equal(matchExactPluginSlash('/archive extra', commands), undefined, '带参数不命中')
  assert.equal(matchExactPluginSlash('/archivex', commands), undefined)
  assert.equal(matchExactPluginSlash('/new', commands), undefined, '保留词不命中插件命令')
})

test('insertAtCaret / removeTokenBeforeCaret：光标插入与触发词清理', { timeout: 60_000 }, () => {
  assert.deepEqual(insertAtCaret('hello', 5, '@a1 '), { next: 'hello@a1 ', nextCaret: 9 })
  assert.deepEqual(insertAtCaret('hello', 0, 'x'), { next: 'xhello', nextCaret: 1 })
  assert.deepEqual(insertAtCaret('hello', 99, '!'), { next: 'hello!', nextCaret: 6 }, '越界收敛到末尾')
  assert.deepEqual(insertAtCaret('hello', -3, '!'), { next: '!hello', nextCaret: 1 }, '负值收敛到 0')
  // 触发词清理：仅移除光标前最近 token（与 applyPopover 同一 token 正则：含前导空白一并发），其余草稿原样保留
  assert.deepEqual(removeTokenBeforeCaret('/ar rest', 3), { next: ' rest', nextCaret: 0 })
  assert.deepEqual(removeTokenBeforeCaret('text /archi', 10), { next: 'text i', nextCaret: 5 })
  assert.deepEqual(removeTokenBeforeCaret('plain', 5), { next: 'plain', nextCaret: 5 }, '无 token 不吞草稿')
})

test('commandActionPluginId / commandHint：跨插件路由与 hint 派生', { timeout: 60_000 }, () => {
  assert.equal(commandActionPluginId(cmd('p1', { actionId: 'a' })), 'p1')
  assert.equal(commandActionPluginId(cmd('p1', { actionId: 'a', actionPluginId: 'p2' })), 'p2')
  assert.equal(commandHint({ id: 'x', title: 't', description: '归档当前会话' } as never, 'p1'), '归档当前会话')
  assert.equal(commandHint({ id: 'x', title: 't', actionId: 'a' } as never, 'p1'), 'p1 / a')
  assert.equal(commandHint({ id: 'x', title: 't', actionId: 'a', actionPluginId: 'p2' } as never, 'p1'), 'p2 / a')
  assert.equal(commandHint({ id: 'x', title: 't' } as never, 'p1'), 'p1')
})

test('commandsForConversation：⌘K 与 / 同一作用域过滤', { timeout: 60_000 }, () => {
  const commands = [
    cmd('p1', { slash: 'archive', actionId: 'archive' }),
    cmd('p3', { actionId: 'w', scope: { tags: ['worker'] } }),
  ]
  assert.equal(commandsForConversation(commands, conv(1)).length, 1)
  assert.equal(commandsForConversation(commands, conv(2, ['worker'])).length, 2)
  assert.equal(commandsForConversation(commands, undefined).length, 1)
})

// ---------------------------------------------------------------------------
// 交互：真实挂载 Composer + controller
// ---------------------------------------------------------------------------

function summary(id: number, status: ConversationSummary['status'] = 'idle'): ConversationSummary {
  return { ...conv(id), title: `会话 ${id}`, status }
}

interface CapturedRequest {
  method: string
  path: string
  body: Record<string, unknown>
}

function makeStore(conversation: ConversationSummary, ui: PluginUiContribution[] = []): HelmStoreValue & { notices: Array<Record<string, unknown>>; actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> } {
  const noop = () => {}
  const asyncNoop = async () => undefined
  const notices: Array<Record<string, unknown>> = []
  const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  return {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark' as const, themePreference: 'system' as const,
    conversations: [conversation], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: ui,
    groupedUi: groupUiContributions(ui), pluginDocs: {}, nodes: [], profiles: [], models: [],
    providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: conversation.id }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null,
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop,
    pushNotice: (n: Record<string, unknown>) => notices.push(n),
    invokePluginAction: async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => {
      actionCalls.push({ pluginId, actionId, input, conversationId })
      return { ok: true }
    },
    notices,
    actionCalls,
  } as unknown as HelmStoreValue & { notices: Array<Record<string, unknown>>; actionCalls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> }
}

/** 拦截全局 fetch 捕获 /api/conversations/:id/input 请求体；reply 控制成败。 */
function stubFetch(captured: CapturedRequest[], ok: boolean): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
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

/** 挂载真实 Composer 组件树（真实用户路径断言：textarea 键入 + 键盘/按钮 + fetch 捕获）。 */
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
        HelmStoreContext.Provider,
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
  assert.ok(el !== null, '必须渲染输入框')
  return el
}

const sendButtonOf = (host: HTMLElement): HTMLButtonElement => {
  for (const btn of host.querySelectorAll<HTMLButtonElement>('button')) {
    if ((btn.getAttribute('aria-label') ?? '').includes('发送')) return btn
  }
  assert.fail('未找到发送按钮')
}

test('交互：键入草稿并提交，草稿清空且请求体正确；失败恢复草稿', { timeout: 60_000 }, async () => {
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
    assert.equal(ta.value, '', '提交后草稿清空')
  } finally {
    unmount()
    restore()
  }
})

test('交互：发送失败草稿恢复（乐观清空后回滚），错误如实可见', { timeout: 60_000 }, async () => {
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
    assert.equal(ta.value, '会失败的消息', '失败后活草稿未被用户改动，恢复回滚')
  } finally {
    unmount()
    restore()
  }
})

test('交互：busy 会话 Enter 走插话引导（whenBusy=steer），⌘Enter 排队（followUp）', { timeout: 60_000 }, async () => {
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
    assert.equal(captured[0]!.body.whenBusy, 'steer', 'busy 默认插话引导')
    await act(async () => {
      typeInto(ta, '排队')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(captured[1]!.body.whenBusy, 'followUp', '⌘Enter 排队发送')
  } finally {
    unmount()
    restore()
  }
})

test('交互：/new 等宿主管理命令不落输入请求（立即执行 reset）', { timeout: 60_000 }, async () => {
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
    // 第一次 Enter 被斜杠浮层捕获：回填选中项 '/new' 并关闭浮层
    await act(async () => {})
    assert.equal(ta.value, '/new')
    // 第二次 Enter 提交：宿主管理命令立即执行 reset，不落 input
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.filter((c) => c.path.endsWith('/input')).length, 0, '管理命令不走 input 提交')
    assert.equal(captured.some((c) => c.path.endsWith('/reset')), true, '/new 触发 reset')
  } finally {
    unmount()
    restore()
  }
})

test('交互：未知斜杠词不吞草稿，作为普通文本提交', { timeout: 60_000 }, async () => {
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
    // 第一次 Enter 被斜杠浮层捕获（无匹配项时浮层关闭不回填）
    await act(async () => {})
    // 第二次 Enter 提交：未知斜杠词按普通文本提交
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured[0]!.body.text, '/definitely-not-registered', '未知斜杠按普通文本提交，不吞草稿')
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

test('交互：草稿首 token 命中插件命令时执行 action（context 带会话 id），草稿清空', { timeout: 60_000 }, async () => {
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
    // 第一次 Enter 被斜杠浮层捕获：插件命令选中即执行（不回填草稿），浮层关闭
    await act(async () => {})
    // 第二次 Enter：草稿已清空，无提交动作（不落 input）
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    assert.equal(captured.filter((c) => c.path.endsWith('/input')).length, 0, '命中插件命令不走 input 提交')
    assert.equal(ta.value, '', '选中插件命令后草稿清空')
  } finally {
    unmount()
    restore()
  }
})

test('action 路由：actionPluginId 跨插件路由 + conversationId 第四参', { timeout: 60_000 }, async () => {
  const store = makeStore(summary(7, 'idle'), archiveCommandUi)
  const commands = store.groupedUi.commands
  const cross = commands.find((c) => c.spec.id === 'cross')!
  await store.invokePluginAction(commandActionPluginId(cross), cross.spec.actionId!, cross.spec.input, 7)
  const spy = store as unknown as { actionCalls: Array<{ pluginId: string; actionId: string; conversationId?: number }> }
  assert.equal(spy.actionCalls[0]!.pluginId, 'p9')
  assert.equal(spy.actionCalls[0]!.actionId, 'target-action')
  assert.equal(spy.actionCalls[0]!.conversationId, 7)
})

test('斜杠浮层合并插件命令：输入 /ar 弹出 /archive，选中执行不回填', { timeout: 60_000 }, async () => {
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
    assert.ok(popover !== null, '/ 前缀弹出斜杠浮层')
    assert.match(popover.textContent!, /\/archive/, '插件命令进入浮层')
    assert.match(popover.textContent!, /跨插件路由命令|\/cross-route/, '第二个插件命令进入浮层')
    // 继续输入 ar 过滤
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
