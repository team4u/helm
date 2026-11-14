/**
 * Composer 稳定回调与 await 快照纪律测试（真实 DOM：createRoot + act，happy-dom）：
 * - 附件上传 await 完成后以 liveDraftRef 活值同步：发起上传时渲染快照里的旧文本/锚点
 *   不得回灌活草稿（随后发送携带完整文本与附件）；
 * - A 会话上传在途时切 B（生产按 `composer-<id>` key 重挂载）：上传仍指向 A，
 *   完成后不向 B 草稿混入附件；
 * - A 会话发送在途时切 B：提交只落在 A（携带 A 的草稿快照），B 草稿不被回写污染；
 * - 切 A→B 后 B 草稿全新：B 的 prefill 回填正常落地，onlyIfEmpty 拒绝不串 A 残留；
 * - 斜杠浮层打开期间无关重渲染不重挂全局键盘监听（onPick/onClose/visible 身份稳定）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ArtifactMetadata, ConversationSummary } from '@helm/protocol'
import { conversationsApi } from '../src/lib/api.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'

const { Composer } = await import('../src/conversation/Composer.js')

const conv = (id: number): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId: 'coder', tags: [], cwd: '/w', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})
const convA = conv(1)
const convB = conv(2)

function makeStore(opts?: { detail?: boolean }): { store: HelmStoreValue; notices: Array<Record<string, unknown>> } {
  const noop = () => {}
  const asyncNoop = async () => undefined
  const notices: Array<Record<string, unknown>> = []
  const store = {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark' as const,
    themePreference: 'system' as const,
    conversations: [convA, convB],
    // 空 entries + idle：空会话展示起始环境配置条（SessionEnvBar）
    conversationDetails: opts?.detail === true ? { 1: { ...convA, entries: [] } } : {},
    conversationLives: {},
    conversationArtifacts: { 1: [], 2: [] }, pendingAsks: [], resolvedAsksByConv: {},
    plugins: [], uiContributions: [], groupedUi: groupUiContributions([]), pluginDocs: {},
    nodes: [], profiles: [], assetsLoaded: true, models: [], providers: [], credentials: [],
    skills: [], actions: [],
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts' as const, activeModal: null,
    highlightedEntry: null, notices,
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, syncPlugins: noop,
    refreshNodes: asyncNoop, loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop,
    loadConversationArtifacts: asyncNoop, ensurePluginDoc: asyncNoop, openTarget: noop,
    closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop, setWorkbenchTab: noop,
    openSpace: noop, setActiveModal: noop, dismissNotice: noop,
    pushNotice: (n: Record<string, unknown>) => { notices.push(n) },
    invokePluginAction: asyncNoop,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false }),
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  } as unknown as HelmStoreValue
  return { store, notices }
}

type Prefill = NonNullable<React.ComponentProps<typeof Composer>['prefill']>

interface Harness {
  host: HTMLElement
  show: (key: string, conversation: ConversationSummary, prefill?: Prefill | null) => void
  ta: () => HTMLTextAreaElement
  chips: () => HTMLElement[]
  slashPopover: () => HTMLElement | null
  unmount: () => void
}

function mountComposer(store: HelmStoreValue, onSendingChange?: (sending: boolean) => void): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const show = (key: string, conversation: ConversationSummary, prefill: Prefill | null = null): void => {
    act(() => {
      root.render(
        React.createElement(
          HelmStoreContext.Provider,
          { value: store },
          React.createElement(Composer, {
            key,
            conversation,
            prefill,
            ...(onSendingChange !== undefined ? { onSendingChange } : {}),
          }),
        ),
      )
    })
  }
  return {
    host,
    show,
    ta: () => host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!,
    chips: () => Array.from(host.querySelectorAll('.attachment-chip')),
    slashPopover: () => host.querySelector('.composer-popover'),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const type = async (ta: HTMLTextAreaElement, text: string): Promise<void> => {
  await act(async () => { typeInto(ta, text) })
}

const enter = async (ta: HTMLTextAreaElement): Promise<void> => {
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

/** 合成粘贴文件：React 合成 ClipboardEvent 从原生事件读 clipboardData.files。 */
function pasteFiles(ta: HTMLTextAreaElement, files: File[]): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: { files } })
  ta.dispatchEvent(ev)
}

const paste = async (ta: HTMLTextAreaElement, files: File[]): Promise<void> => {
  await act(async () => { pasteFiles(ta, files) })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

interface SubmitCall { id: number; payload: Record<string, unknown> }

function stubApi(opts?: { uploadGate?: Promise<void>; submitGate?: Promise<void> }): {
  uploads: Array<{ id: number; name: string }>
  submits: SubmitCall[]
  restore: () => void
} {
  const originalUpload = conversationsApi.uploadArtifact
  const originalSubmit = conversationsApi.submitInput
  const uploadsSeen: Array<{ id: number; name: string }> = []
  const submitsSeen: SubmitCall[] = []
  conversationsApi.uploadArtifact = (async (id: number, file: File) => {
    uploadsSeen.push({ id, name: file.name })
    if (opts?.uploadGate !== undefined) await opts.uploadGate
    const meta: ArtifactMetadata = {
      id: `art-${id}`, conversationId: id, name: file.name,
      path: `artifacts/${id}/${file.name}`, mimeType: file.type || 'application/octet-stream',
      size: file.size, createdAt: 1,
    }
    return meta
  }) as typeof conversationsApi.uploadArtifact
  conversationsApi.submitInput = (async (id: number, payload: Record<string, unknown>) => {
    submitsSeen.push({ id, payload })
    if (opts?.submitGate !== undefined) await opts.submitGate
    return { submissionId: 's1' }
  }) as unknown as typeof conversationsApi.submitInput
  return {
    uploads: uploadsSeen,
    submits: submitsSeen,
    restore: () => {
      conversationsApi.uploadArtifact = originalUpload
      conversationsApi.submitInput = originalSubmit
    },
  }
}

const flush = async (): Promise<void> => {
  await act(async () => {})
}

const testFile = (): File => new File(['x'], '笔记.txt', { type: 'text/plain' })

test('上传完成以活草稿同步：await 后旧渲染快照文本不回灌，随后的发送携带完整文本与附件', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'hello')
    await paste(app.ta(), [testFile()])
    // 上传在途期间继续输入：上传回调闭包里的旧文本绝不能覆盖这段活草稿
    await type(app.ta(), 'hello world')
    await act(async () => { gate.resolve() })
    await flush()
    assert.equal(app.chips().length, 1, '上传完成后附件条出现')
    assert.equal(app.ta().value, 'hello world', '活草稿文本不被发起上传时的旧快照覆盖')
    await enter(app.ta())
    assert.equal(api.submits.length, 1, '草稿完整即可发送')
    assert.equal(api.submits[0]!.id, 1)
    assert.deepEqual(
      {
        text: api.submits[0]!.payload.text,
        origin: api.submits[0]!.payload.origin,
        attachments: api.submits[0]!.payload.attachments,
      },
      { text: 'hello world', origin: 'human', attachments: ['art-1'] },
      '发送携带完整文本与已上传附件',
    )
  } finally {
    api.restore()
    app.unmount()
  }
})

test('A 会话上传在途时切到 B：上传目标锁定 A，完成后不向 B 草稿混入附件', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'a 草稿')
    await paste(app.ta(), [testFile()])
    // 生产按 composer-<id> key 挂载：切会话即重挂，B 是全新实例
    app.show('composer-2', convB)
    assert.equal(app.ta().value, '', 'B 草稿全新空白')
    await act(async () => { gate.resolve() })
    await flush()
    assert.deepEqual(api.uploads, [{ id: 1, name: '笔记.txt' }], '上传仍指向发起时的会话 A')
    assert.equal(app.chips().length, 0, 'A 的在途附件不污染 B 草稿')
    assert.equal(app.ta().value, '', 'B 正文不被 A 实例的回写触碰')
    await type(app.ta(), 'b 草稿')
    await enter(app.ta())
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.id, 2, 'B 发送只落在 B')
    assert.equal(api.submits[0]!.payload.text, 'b 草稿')
    assert.equal(api.submits[0]!.payload.attachments, undefined, 'B 提交不携带 A 的附件')
  } finally {
    api.restore()
    app.unmount()
  }
})

test('A 会话发送在途时切到 B：提交只落在 A，B 草稿不被 A 的回写污染', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ submitGate: gate.promise })
  const { store } = makeStore()
  const sending: boolean[] = []
  const app = mountComposer(store, (s) => { sending.push(s) })
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'msg-a')
    await enter(app.ta())
    assert.deepEqual(sending, [true], '在途反馈如实开启')
    app.show('composer-2', convB)
    await act(async () => { gate.resolve() })
    await flush()
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.id, 1, '提交目标是发起时的会话 A，绝不改投 B')
    assert.equal(api.submits[0]!.payload.text, 'msg-a')
    assert.deepEqual(sending, [true, false], '在途反馈如实收尾，不悬挂')
    assert.equal(app.ta().value, '', 'B 草稿保持空白')
    assert.equal(app.chips().length, 0)
  } finally {
    api.restore()
    app.unmount()
  }
})

test('切 A→B 后 B 草稿全新：prefill 回填正常落地，onlyIfEmpty 拒绝不串 A 残留', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const { store, notices } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'a 草稿')
    // 切 B（生产 Pane 亦按会话 key 重挂，prefill 状态随会话重置为 null）
    app.show('composer-2', convB)
    assert.equal(app.ta().value, '', 'B 不继承 A 草稿')
    // B 内触发引导词回填
    app.show('composer-2', convB, { text: 'B 引导词', tick: 1, onlyIfEmpty: true })
    await flush()
    assert.equal(app.ta().value, 'B 引导词', 'B 的回填正常落地')
    // 草稿非空时 onlyIfEmpty 回填被拒绝：警告归属 B，正文不动
    app.show('composer-2', convB, { text: '另一个引导词', tick: 2, onlyIfEmpty: true })
    await flush()
    assert.equal(app.ta().value, 'B 引导词', '非空草稿不被覆盖')
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.conversationId, 2, '拒绝警告归属当前会话 B')
    assert.match(String(notices[0]!.title), /请先处理当前草稿/)
    // 切回 A：全新草稿，无 A 旧文与 B 残留
    app.show('composer-1', convA)
    assert.equal(app.ta().value, '', '切回 A 同样是全新草稿（按会话 key 重挂）')
    assert.equal(app.chips().length, 0)
  } finally {
    api.restore()
    app.unmount()
  }
})

test('起始环境条阻塞态不因无关重渲染循环：blocker 回调出口身份稳定', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const { store } = makeStore({ detail: true })
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    const envBar = app.host.querySelector('.composer-env-bar')
    assert.notEqual(envBar, null, '空会话展示起始环境条')
    // 修改 cwd 草稿 → dirty → blocker={blocked:true} 每渲染新对象：
    // 若 onBlockerChange 身份不稳定，SessionEnvBar 的 blocker effect 将每 render 重跑并循环
    const cwdInput = envBar!.querySelector<HTMLInputElement>('input[aria-label="会话工作目录"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const tracker = (cwdInput as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(cwdInput, '/tmp/work')
      tracker?.setValue(prev)
      cwdInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const sendBtn = app.host.querySelector<HTMLButtonElement>('button.btn-send')!
    assert.equal(sendBtn.disabled, true, '未保存环境修改时发送被阻塞')
    // 无关重渲染（正文输入）不触发 blocker effect 重跑/循环；若循环将抛 Maximum update depth exceeded
    await type(app.ta(), 'hello')
    await type(app.ta(), 'hello world')
    assert.equal(app.host.querySelector<HTMLButtonElement>('button.btn-send')!.disabled, true, '阻塞持续且状态稳定')
    // Escape 取消 → 阻塞解除
    await act(async () => {
      cwdInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    assert.equal(app.host.querySelector<HTMLButtonElement>('button.btn-send')!.disabled, false, '取消后发送恢复')
  } finally {
    api.restore()
    app.unmount()
  }
})

test('斜杠浮层打开期间无关重渲染不重挂全局键盘监听（边界回调身份稳定）', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  // 挂载完成后再计数：只观测浮层自身的监听，排除挂载期无关监听
  const originalAdd = window.addEventListener.bind(window)
  const originalRemove = window.removeEventListener.bind(window)
  let keydownAdds = 0
  ;(window as unknown as Record<string, unknown>).addEventListener = function patchedAdd(
    this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'keydown') keydownAdds += 1
    return originalAdd(type, listener, options)
  } as unknown as typeof window.addEventListener
  ;(window as unknown as Record<string, unknown>).removeEventListener = function patchedRemove(
    this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions,
  ) {
    return originalRemove(type, listener, options)
  } as unknown as typeof window.removeEventListener
  try {
    app.show('composer-1', convA)
    await type(app.ta(), '/')
    assert.notEqual(app.slashPopover(), null, '斜杠浮层已打开')
    assert.equal(keydownAdds, 1, '浮层全局键盘监听只挂一次')
    // 无关状态更新（上传计数）触发重渲染：条目集未变，不得重挂监听
    await paste(app.ta(), [testFile()])
    await flush()
    assert.equal(keydownAdds, 1, '无关重渲染不重挂键盘监听（onPick/onClose/visible 身份稳定）')
    await act(async () => { gate.resolve() })
    await flush()
  } finally {
    ;(window as unknown as Record<string, unknown>).addEventListener = originalAdd as unknown as typeof window.addEventListener
    ;(window as unknown as Record<string, unknown>).removeEventListener = originalRemove as unknown as typeof window.removeEventListener
    api.restore()
    app.unmount()
  }
})
