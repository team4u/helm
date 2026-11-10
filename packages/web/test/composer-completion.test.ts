/**
 * composerCompleter 前端闭环核心测试：
 * - 纯模型：token 检测（中文/路径斜杠/邮箱 URL 边界）、替换、源过滤排序、
 *   doc/action 边界校验、manifest 核对、合并去重截断、过滤；
 * - 交互（真实挂载 Composer）：'@' 合并内置产物 + 插件源、'#' ':' 仅注册源激活、
 *   scope 过滤、action 真实 conversationId 与 manifest 核对、防抖竞态（晚响应不恢复）、
 *   键盘只选可见候选（>12）、IME 不误提交、caret 替换、prefill.onlyIfEmpty 草稿保护、
 *   '/' 斜杠与 '@' 产物回归。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type {
  ActionManifest,
  ConversationSummary,
  PluginUiContribution,
} from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  COMPLETION_VISIBLE_LIMIT,
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
// 纯模型
// ---------------------------------------------------------------------------

test('detectCompletionToken：中文/路径斜杠查询；邮箱/URL/时间不误触发', { timeout: 60_000 }, () => {
  assert.deepEqual(detectCompletionToken('@'), { trigger: '@', query: '', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken('看 @中文文档'), { trigger: '@', query: '中文文档', tokenStart: 2 })
  assert.deepEqual(detectCompletionToken('@docs/子目录/文件'), { trigger: '@', query: 'docs/子目录/文件', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken('#标签'), { trigger: '#', query: '标签', tokenStart: 0 })
  assert.deepEqual(detectCompletionToken(':命令'), { trigger: ':', query: '命令', tokenStart: 0 })
  // 边界：非行首/非空白前置不触发
  assert.equal(detectCompletionToken('user@example.com'), null, '邮箱中段不触发')
  assert.equal(detectCompletionToken('a.com/@mention'), null, 'URL 内 @ 不触发')
  assert.equal(detectCompletionToken('12:30'), null, '时间冒号不触发')
  assert.equal(detectCompletionToken('a:b'), null, '无空白前置冒号不触发')
  // 斜杠命令字符集独立
  assert.deepEqual(detectCompletionToken('/arc'), { trigger: '/', query: 'arc', tokenStart: 0 })
  assert.equal(detectCompletionToken('a/b'), null, '路径中段斜杠不触发命令')
})

test('replaceTriggerToken：只替换光标前触发 token，保留前后文本', { timeout: 60_000 }, () => {
  // 光标 5（“旧”后空格前）：token “@旧” 替换，其后文本（含原空格）原样保留
  assert.deepEqual(replaceTriggerToken('前缀 @旧 中缀 后缀', 5, '@新引用 '), {
    next: '前缀 @新引用  中缀 后缀',
    nextCaret: 8,
  })
  assert.deepEqual(replaceTriggerToken('#tag', 4, '#new-tag '), { next: '#new-tag ', nextCaret: 9 })
  // 中文 token 同样整体替换：看=0 ␠=1 @=2 中=3 文=4，光标 5
  assert.deepEqual(replaceTriggerToken('看 @中文 呀', 5, '@文档 '), { next: '看 @文档  呀', nextCaret: 6 })
})

test('completersForTrigger：trigger + scope 过滤，priority 降序稳定', { timeout: 60_000 }, () => {
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
  assert.deepEqual(at.map((c) => c.pluginId), ['p3', 'p5', 'p1'], 'priority 降序稳定，scope 不命中剔除')
  assert.deepEqual(completersForTrigger(grouped.composerCompleters, '#', conv).map((c) => c.pluginId), ['p2'])
  assert.deepEqual(completersForTrigger(grouped.composerCompleters, ':', conv), [], '未注册源不激活')
})

test('extract/parse：逐项边界校验，非法项丢弃并诊断', { timeout: 60_000 }, () => {
  const good = { id: 'a', label: 'A', insertText: 'x' }
  const doc = extractCompletionItems({ items: [good, { id: '', label: 'B', insertText: 'y' }, null, { id: 'c', label: 'C', insertText: 'z', hint: 1 }] }, 'items')
  assert.equal(doc.items!.length, 1)
  assert.equal(doc.items![0]!.id, 'a')
  assert.match(doc.error!, /丢弃 3 个非法候选/)
  assert.equal(extractCompletionItems({ nope: [] }, 'items').error !== undefined, true, '缺数组字段显式诊断')
  assert.equal(extractCompletionItems(undefined, 'items').items, null, '未加载不是错误')
  const action = parseCompletionActionResult({ items: [good, 'bad'] })
  assert.equal(action.items!.length, 1)
  assert.match(action.error!, /丢弃 1 个非法候选/)
  assert.match(parseCompletionActionResult({ nope: 1 }).error!, /缺少 items/)
})

test('verifyCompletionActionManifest：需真实 manifest 且 idempotent:true', { timeout: 60_000 }, () => {
  const actions: ActionManifest[] = [
    { pluginId: 'p1', id: 'search', description: '', inputSchema: {}, outputSchema: {}, idempotent: true },
    { pluginId: 'p1', id: 'mutate', description: '', inputSchema: {}, outputSchema: {} },
  ]
  assert.equal(verifyCompletionActionManifest(actions, 'p1', 'search'), null)
  assert.match(verifyCompletionActionManifest(actions, 'p1', 'mutate')!, /idempotent/)
  assert.match(verifyCompletionActionManifest(actions, 'p1', 'ghost')!, /未注册/)
})

test('merge/filter：插件+源命名空间去重、上限截断、空格 AND 过滤', { timeout: 60_000 }, () => {
  const item = (id: string, label: string): { id: string; label: string; insertText: string } => ({ id, label, insertText: id })
  const merged = mergeCompletionItems([
    { pluginId: 'host', items: [item('a', '产物 A'), item('a', '产物 A 重复')] },
    { pluginId: 'p1', items: [item('a', '插件同 id 不去重')] },
  ])
  assert.equal(merged.items.length, 2, '跨插件同 id 保留（命名空间隔离），源内去重')
  assert.equal(merged.items.filter((m) => m.key === `host\u0000a`).length, 1, '源内去重')
  const big = mergeCompletionItems([{ pluginId: 'p', items: Array.from({ length: 130 }, (_, i) => item(`i${i}`, `候选 ${i}`)) }])
  assert.equal(big.items.length, 100)
  assert.equal(big.truncated, true)
  assert.equal(big.total, 130)
  const filtered = filterByQuery([item('a', '部署 到 生产'), item('b', '部署')], '部署 生产')
  assert.deepEqual(filtered.map((f) => f.id), ['a'], '空格分词 AND（中文）')
})

// ---------------------------------------------------------------------------
// 交互：真实挂载 Composer
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
    conversations: [conversation], conversationDetails: {}, conversationLives: {},
    conversationArtifacts: { [conversation.id]: opts.artifacts ?? [] },
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: opts.ui ?? [],
    groupedUi: groupUiContributions(opts.ui ?? []), pluginDocs: opts.docs ?? {}, nodes: [],
    profiles: [], models: [], providers: [], credentials: [], skills: [], actions: opts.actions ?? [],
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
          HelmStoreContext.Provider,
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

test('交互：@ 合并内置产物与 doc 源候选；选中替换触发 token 保留前后文本与光标', { timeout: 60_000 }, async () => {
  const app = await mount(conv(1), {
    ui: [docCompleter('p1', '@', 'catalog')],
    docs: { 'p1/catalog': { items: [{ id: 'memory', label: '@记忆库', insertText: '@记忆库 ' }] } },
    artifacts: [{ id: 'art-1', name: '报告.pdf', mimeType: 'application/pdf', size: 1024 }],
  })
  try {
    await app.type('请看 @')
    await act(async () => {})
    const items = app.completionItems()
    assert.ok(items.length >= 2, '内置产物与插件源合并展示')
    assert.match(app.completionPopover()!.textContent!, /报告\.pdf/)
    assert.match(app.completionPopover()!.textContent!, /记忆库/)
    // 键盘选中第一项（产物）：只替换 @，前后文本保留
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '请看 @art-1 ')
    assert.equal(app.ta().selectionStart, '请看 @art-1 '.length, '光标落在插入文本后')
    assert.equal(app.completionPopover(), null, '选中后浮层关闭')
  } finally {
    app.unmount()
  }
})

test('交互：# 与 : 仅注册源激活；scope 不命中的源不参与', { timeout: 60_000 }, async () => {
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
    assert.match(app.completionPopover()!.textContent!, /缺陷/, 'scope 命中的 # 源出现')
    await app.key('Escape')
    await app.type(':')
    await act(async () => {})
    assert.match(app.completionPopover()!.textContent!, /没有匹配的候选/, 'scope 不命中的 : 源不出现，仅空态')
  } finally {
    app.unmount()
  }
})

test('交互：action 源真实 conversationId + manifest 核对（未注册/非幂等拒绝且可辨）', { timeout: 60_000 }, async () => {
  const app = await mount(conv(3), {
    ui: [actionCompleter('p1', '@', 'search'), actionCompleter('p2', '#', 'mutate')],
    actions: [manifest('p1', 'search', true), manifest('p2', 'mutate', false)],
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      app.actionCalls.push({ pluginId, actionId, input, conversationId })
      assert.equal(conversationId, 3, '必须携带真实会话 id')
      assert.deepEqual(input, { query: '', conversationId: 3 }, '查询体带真实会话 id，不伪造 nodeId/cwd')
      return { items: [{ id: 'hit', label: '@命中', insertText: '@命中 ' }] }
    },
  })
  try {
    await app.type('@')
    await act(async () => { await new Promise((r) => setTimeout(r, 220)) })
    assert.equal(app.actionCalls.length, 1, '仅通过 manifest 核对的源发起调用')
    assert.equal(app.actionCalls[0]!.pluginId, 'p1')
    assert.match(app.completionPopover()!.textContent!, /命中/)
    await app.key('Escape')
    await app.type('#')
    await act(async () => {})
    assert.match(app.completionPopover()!.textContent!, /idempotent/, '非幂等动作被拒且诊断可见')
    assert.equal(app.actionCalls.length, 1, '未发起新调用')
  } finally {
    app.unmount()
  }
})

test('交互：请求竞态——切会话后晚到响应不恢复浮层', { timeout: 60_000 }, async () => {
  let release: ((v: unknown) => void) | undefined
  const app = await mount(conv(4), {
    ui: [actionCompleter('p1', '@', 'search')],
    actions: [manifest('p1', 'search')],
    invokePluginAction: () => new Promise((resolve) => { release = resolve }),
  })
  try {
    await app.type('@')
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    assert.equal(app.completionPopover() !== null, true, '请求在途浮层存在（loading）')
    // 模拟关闭浮层（等效切会话/停用源后的 generation 推进）后响应才返回
    await app.key('Escape')
    release?.({ items: [{ id: 'late', label: '@晚到', insertText: '@晚到 ' }] })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    const popover = app.completionPopover()
    assert.equal(popover, null, '晚到响应不恢复浮层')
    assert.equal(app.ta().value, '@', '草稿不受晚到响应影响')
  } finally {
    app.unmount()
  }
})

test('交互：>12 候选键盘循环只在可见集内；截断提示可见', { timeout: 60_000 }, async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, label: `@候选${i}`, insertText: `@候选${i} ` }))
  const app = await mount(conv(5), {
    ui: [docCompleter('p1', '@', 'big')],
    docs: { 'p1/big': { items } },
  })
  try {
    await app.type('@')
    await act(async () => {})
    const visible = app.completionItems()
    assert.equal(visible.length, COMPLETION_VISIBLE_LIMIT, '只显示 12 项')
    assert.match(app.completionPopover()!.textContent!, /仅显示前 12 项/, '截断提示可见')
    // 连续 ArrowDown 13 次应回到索引 1（12 项循环），Enter 选中的是可见项
    for (let i = 0; i < 13; i++) await app.key('ArrowDown')
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '@候选1 ', '键盘索引与可见候选一致（循环不出不可见项）')
  } finally {
    app.unmount()
  }
})

test('交互：IME composing 期间 Enter 不选中候选、不提交草稿', { timeout: 60_000 }, async () => {
  const app = await mount(conv(6), {
    ui: [docCompleter('p1', '@', 'd')],
    docs: { 'p1/d': { items: [{ id: 'x', label: '@中文', insertText: '@中文 ' }] } },
  })
  try {
    await app.type('@')
    await act(async () => {})
    // happy-dom KeyboardEvent 支持 isComposing 初始化
    await app.key('Enter', { isComposing: true } as KeyboardEventInit)
    assert.equal(app.ta().value, '@', '组合中 Enter 不选候选')
    assert.notEqual(app.completionPopover(), null, '浮层保持')
  } finally {
    app.unmount()
  }
})

test('交互：caret 中段触发——替换光标前 token，光标后文本不动', { timeout: 60_000 }, async () => {
  const app = await mount(conv(7), {
    ui: [docCompleter('p1', '#', 'd')],
    docs: { 'p1/d': { items: [{ id: 'x', label: '#词语', insertText: '#词语 ' }] } },
  })
  try {
    // 真实编辑路径：先输入完整草稿，再选中 token 中段文字追加输入（光标自然落在 token 内）
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
    assert.equal(app.completionPopover() !== null, true, '光标位于 # 触发词内时浮层激活')
    await app.key('Enter')
    await act(async () => {})
    assert.equal(app.ta().value, '#词语  后面的', '仅替换光标前 token，其后文本保留')
  } finally {
    app.unmount()
  }
})

test('交互：prefill.onlyIfEmpty 草稿非空拒绝回填并警告；空闲时正常回填', { timeout: 60_000 }, async () => {
  const app = await mount(conv(8), {})
  try {
    await app.type('正在编辑的草稿')
    app.rerenderPrefill({ text: '引导词', tick: 1, onlyIfEmpty: true })
    await act(async () => {})
    assert.equal(app.ta().value, '正在编辑的草稿', '草稿保持不变')
    assert.ok(app.notices.some((n) => String(n.title).includes('请先处理当前草稿')), '警告通知可见')
    // 清空草稿后允许回填
    await app.type('')
    app.rerenderPrefill({ text: '引导词', tick: 2, onlyIfEmpty: true })
    await act(async () => {})
    assert.equal(app.ta().value, '引导词', '空闲草稿回填成功')
    // 默认（未传 onlyIfEmpty）既有编辑行为不变：直接覆盖
    app.rerenderPrefill({ text: '编辑并重发', tick: 3 })
    await act(async () => {})
    assert.equal(app.ta().value, '编辑并重发')
  } finally {
    app.unmount()
  }
})

test('回归：斜杠三源命令与技能浮层不受影响', { timeout: 60_000 }, async () => {
  const app = await mount(conv(9), {})
  try {
    await app.type('/')
    await act(async () => {})
    const slash = app.host.querySelector('.composer-popover')
    assert.ok(slash !== null, '斜杠浮层仍渲染')
    assert.match(slash!.textContent!, /\/new/)
    assert.match(slash!.textContent!, /\/compact/)
    await app.key('Escape')
    assert.equal(app.host.querySelector('.composer-popover'), null)
  } finally {
    app.unmount()
  }
})
