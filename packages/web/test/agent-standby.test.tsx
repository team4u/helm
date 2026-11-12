/**
 * 智能体待命页（Agent Standby）交互测试：真实 HelmStoreProvider + 真实 App。
 *
 * 覆盖：深链待命无 POST、Sidebar 名称/加号新建入口进待命态、首发链路
 * （create -> submit）与双击去重、create/submit 失败保留草稿与重试复用、
 * 附件发送前仅本地暂存、starter 不覆盖非空草稿、URL 环境继承、主/分屏草稿
 * 隔离、等待期切走不抢导航、新话题按钮进待命态、draft->真实会话 replace。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { App } = await import('../src/App.js')
const { getStandbyDraft, resetStandbyDrafts, standbyDraftKey } = await import("../src/conversation/standby-model.js")

const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined

interface Gate {
  promise: Promise<void>
  resolve: () => void
}

function makeGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function summary(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...overrides,
  }
}

const initialConversations = [
  summary(1),
  summary(3, { nodeId: 'remote-1', cwd: '/remote/work' }),
]

const state = {
  conversations: [...initialConversations],
  nextId: 9,
  createCalls: [] as Array<Record<string, unknown>>,
  submitCalls: [] as Array<{ id: number; body: Record<string, unknown> }>,
  patchCalls: [] as Array<{ id: number; body: Record<string, unknown> }>,
  uploadCalls: [] as Array<{ id: number; name: string }>,
  createGate: undefined as Gate | undefined,
  submitGate: undefined as Gate | undefined,
  uploadGate: undefined as Gate | undefined,
  assetsGate: undefined as Gate | undefined,
  createFailures: 0,
  submitFailures: 0,
  uploadFailures: 0,
  profilesFail: false,
  resetCalls: [] as number[],
}

function resetState(): void {
  state.conversations = [...initialConversations]
  state.nextId = 9
  state.createCalls = []
  state.submitCalls = []
  state.patchCalls = []
  state.uploadCalls = []
  state.resetCalls = []
  state.createGate = undefined
  state.submitGate = undefined
  state.uploadGate = undefined
  state.assetsGate = undefined
  state.createFailures = 0
  state.submitFailures = 0
  state.uploadFailures = 0
  state.profilesFail = false
}

const profiles = [
  {
    id: 'assistant',
    name: '个人助理',
    starters: [{ label: '打个招呼', prompt: 'say hi' }],
  },
  { id: 'coder', name: '编码专员' },
  { id: 'singleton', name: '常驻单例', humanSelectable: false },
  { id: 'managed', name: '插件托管角色', managedByPlugin: 'builtin:gone' },
]

const modelCatalog = {
  models: [
    { provider: 'faux', modelId: 'glm-4.6', available: true },
  ],
  thinkingLevels: { 'faux/glm-4.6': ['off', 'low', 'high'] },
}

function eventFrame(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ seq, event })}\n\n`)
}

let eventSeq = 1
let eventController: ReadableStreamDefaultController<Uint8Array> | undefined

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return jsonResponse({ configured: true, authenticated: true })
    }
    if (url === '/api/events') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller
          controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
            seq: eventSeq,
            conversations: state.conversations,
            pendingAsks: [],
            plugins: [],
            ui: [],
            nodes: [
              { id: 'local', name: '本机', online: true },
              { id: 'remote-1', name: '远端一', online: true },
            ],
          })}\n\n`))
        },
        cancel() { eventController = undefined },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url === '/api/profiles' && method === 'GET') {
      if (state.assetsGate !== undefined) await state.assetsGate.promise
      if (state.profilesFail) return jsonResponse({ error: { code: 'internal_error', message: 'profiles down' } }, 500)
      return jsonResponse(profiles)
    }
    if (url === '/api/models' && method === 'GET') return jsonResponse(modelCatalog)
    if (url === '/api/nodes' && method === 'GET') {
      return jsonResponse([
        { id: 'local', name: '本机', online: true },
        { id: 'remote-1', name: '远端一', online: true },
      ])
    }
    // create：POST /api/conversations（无 id 后缀）
    if (url === '/api/conversations' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      state.createCalls.push(body)
      if (state.createGate !== undefined) await state.createGate.promise
      if (state.createFailures > 0) {
        state.createFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'create failed' } }, 500)
      }
      const created = summary(state.nextId++, { profileId: String(body.profileId ?? 'assistant') })
      state.conversations = [created, ...state.conversations]
      eventController?.enqueue(eventFrame(++eventSeq, { type: 'conversation.upsert', conversation: created }))
      return jsonResponse(created)
    }
    const inputMatch = /^\/api\/conversations\/(\d+)\/input$/.exec(url)
    if (inputMatch && method === 'POST') {
      const id = Number(inputMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (state.submitGate !== undefined) await state.submitGate.promise
      state.submitCalls.push({ id, body })
      if (state.submitFailures > 0) {
        state.submitFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'submit failed' } }, 500)
      }
      return jsonResponse({ submissionId: 'sub-1' })
    }
    const uploadMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (uploadMatch && method === 'POST') {
      const id = Number(uploadMatch[1])
      const name = decodeURIComponent(new Headers(init?.headers as HeadersInit | undefined).get('X-Artifact-Filename') ?? 'attachment.bin')
      if (state.uploadGate !== undefined) await state.uploadGate.promise
      state.uploadCalls.push({ id, name })
      if (state.uploadFailures > 0) {
        state.uploadFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'upload failed' } }, 500)
      }
      return jsonResponse({ id: `art-${state.uploadCalls.length}`, name, size: 5, mimeType: 'text/plain' })
    }
    const resetMatch = /^\/api\/conversations\/(\d+)\/reset$/.exec(url)
    if (resetMatch && method === 'POST') {
      state.resetCalls.push(Number(resetMatch[1]))
      return jsonResponse(state.conversations.find((c) => c.id === Number(resetMatch[1])) ?? summary(1))
    }
    const patchMatch = /^\/api\/conversations\/(\d+)$/.exec(url)
    if (patchMatch && method === 'PATCH') {
      const id = Number(patchMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      state.patchCalls.push({ id, body })
      return jsonResponse(state.conversations.find((c) => c.id === id) ?? summary(id))
    }
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      const found = state.conversations.find((item) => item.id === id)
      return jsonResponse({ ...(found ?? summary(id)), entries: [] })
    }
    if (method === 'GET') return jsonResponse([])
    return jsonResponse({})
  }) as typeof fetch
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

async function mount(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  await act(async () => {
    root = createRoot(host!)
    root.render(e(App))
  })
  await settle()
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  eventController = undefined
  eventSeq = 1
  resetState()
  resetStandbyDrafts()
}

afterEach(reset)

function textarea(label: string): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  assert.ok(el, `应存在输入区 ${label}`)
  return el
}

const MAIN_LABEL = '向 个人助理 输入首条消息'

function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

function dropFiles(el: HTMLElement, files: File[]): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { files } })
  el.dispatchEvent(ev)
}

function clickButton(selector: string, container: ParentNode = document): void {
  const btn = container.querySelector<HTMLButtonElement>(selector)
  assert.ok(btn, `应存在按钮 ${selector}`)
  act(() => { btn.click() })
}

// ---------------------------------------------------------------------------

test('深链待命页：渲染引导与输入区，全程无 POST create', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  assert.ok(document.querySelector('.agent-standby-pane'), '主舞台渲染待命页')
  assert.ok(document.body.textContent?.includes('发送第一条消息开始新话题'), '展示开始新话题引导')
  assert.ok(document.body.textContent?.includes('打个招呼'), '展示 starter')
  assert.ok(textarea(MAIN_LABEL), '渲染草稿输入区')
  assert.equal(state.createCalls.length, 0, '访问待命页不得预创建会话')
})

test('Sidebar 新建入口：智能体行加号进入待命态，零会话待命智能体平铺且激活', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  clickButton('button[title="在 个人助理 下开始新话题"]')
  await settle()
  assert.equal(window.location.hash, '#/a/assistant', '加号进入待命态')
  assert.ok(document.querySelector('.agent-standby-pane'), '渲染待命页')
  assert.equal(state.createCalls.length, 0, '加号不得预创建会话')

  // 零会话智能体被选中（深链/导航）时：平铺可见、保持激活，不埋进折叠闲置组
  reset()
  await mount('#/a/coder')
  const coderRow = [...document.querySelectorAll<HTMLButtonElement>('.nav-item-main')]
    .find((btn) => btn.textContent?.includes('编码专员'))
  assert.ok(coderRow, '零会话待命智能体在侧栏平铺可见')
  const standing = coderRow!.closest('.agent-standing')
  const row = standing?.querySelector('.agent-standing-row')
  assert.ok(row?.className.includes('nav-item-active'), '待命智能体行保持激活态')
  assert.equal(state.createCalls.length, 0)
})

test('首发链路：Enter 创建会话并提交，双击去重，成功后 replace 进入真实会话', { timeout: 60_000 }, async () => {
  const pushes: string[] = []
  const replaces: string[] = []
  const originalPush = history.pushState.bind(history)
  const originalReplace = history.replaceState.bind(history)
  history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
    pushes.push(String(url))
    return originalPush(data, unused, url)
  }) as typeof history.pushState
  history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    replaces.push(String(url))
    return originalReplace(data, unused, url)
  }) as typeof history.replaceState
  try {
    state.createGate = makeGate()
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '你好，开始新话题') })
    await act(async () => { pressEnter(input); pressEnter(input) })
    assert.equal(state.createCalls.length, 1, '双击 Enter 只触发一次 create（同步去重）')
    assert.deepEqual(state.createCalls[0], { profileId: 'assistant' }, '未定制环境与模型时不携带额外字段')
    await act(async () => { state.createGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
    await settle()
    assert.equal(state.submitCalls.length, 1, 'submitInput 恰好一次')
    assert.equal(state.submitCalls[0]!.id, 9)
    assert.equal((state.submitCalls[0]!.body as { text?: string }).text, '你好，开始新话题')
    assert.equal((state.submitCalls[0]!.body as { origin?: string }).origin, 'human')
    assert.equal(window.location.hash, '#/c/9', '成功后导航到真实会话')
    assert.equal(replaces[replaces.length - 1], '#/c/9', 'draft->真实会话用 replace 不污染后退栈')
    assert.ok(document.body.textContent?.includes('会话 9'), '真实会话窗格渲染（HTTP 详情兜底，不依赖 SSE）')
    assert.equal(document.querySelector(`textarea[aria-label="${MAIN_LABEL}"]`), null, '待命输入区卸载')
  } finally {
    history.pushState = originalPush
    history.replaceState = originalReplace
  }
})

test('create 失败：保留草稿与附件，显式错误，重试成功', { timeout: 60_000 }, async () => {
  state.createFailures = 1
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '第一条') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1)
  const alert = document.querySelector('.agent-standby-error')
  assert.ok(alert, '显示显式错误横幅')
  assert.ok(alert!.textContent?.includes('create failed'))
  assert.equal(input.value, '第一条', '草稿保留')
  // 重试：第二次 create 成功
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 2, '重试重新 create（上次未成功）')
  assert.equal(state.submitCalls.length, 1, '重试后提交成功')
  assert.equal(window.location.hash, '#/c/9')
})

test('create 成功后 submit 失败：保留真实会话 ID，重试不重复 create', { timeout: 60_000 }, async () => {
  state.submitFailures = 1
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '会创建但发送失败') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1)
  assert.equal(state.submitCalls.length, 1)
  assert.ok(document.querySelector('.agent-standby-error'), '显示失败横幅')
  assert.equal(input.value, '会创建但发送失败', '草稿保留')
  assert.equal(window.location.hash, '#/a/assistant', '未全链路成功不导航')
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1, '重试复用已创建会话，不重复 create')
  assert.equal(state.submitCalls.length, 2, '重试重新提交')
  assert.equal(state.submitCalls[1]!.id, 9)
  assert.equal(window.location.hash, '#/c/9')
})

test('附件：发送前仅本地暂存不上传，首发时按 create -> 上传 -> 顺序提交', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  const box = document.querySelector<HTMLElement>('.agent-standby-pane .composer-box')
  assert.ok(box, '待命输入区容器存在')
  const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
  await act(async () => { dropFiles(box!, [file]) })
  await settle()
  assert.ok(document.body.textContent?.includes('note.txt'), '附件芯片展示')
  assert.ok(document.body.textContent?.includes('待发送'), '本地暂存标记')
  assert.equal(state.uploadCalls.length, 0, '发送前绝不上传（无真实会话）')
  assert.equal(state.createCalls.length, 0)
  act(() => { typeInto(input, '带附件') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1)
  assert.deepEqual(state.uploadCalls, [{ id: 9, name: 'note.txt' }], 'create 后上传到真实会话')
  assert.deepEqual((state.submitCalls[0]!.body as { attachments?: string[] }).attachments, ['art-1'])
  assert.equal(window.location.hash, '#/c/9')
})

test('starter：空草稿回填，非空草稿不覆盖并提示', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  const starterBtn = document.querySelector<HTMLButtonElement>('button.timeline-starter-btn')
  assert.ok(starterBtn, 'starter 按钮存在')
  act(() => { starterBtn!.click() })
  await settle()
  const input = textarea(MAIN_LABEL)
  assert.equal(input.value, 'say hi', '空草稿回填 starter')
  act(() => { typeInto(input, '我自己写的') })
  await act(async () => { starterBtn!.click() })
  await settle()
  assert.equal(textarea(MAIN_LABEL).value, '我自己写的', '非空草稿不被 starter 覆盖')
  assert.ok(document.body.textContent?.includes('请先处理当前草稿'), '给出显式提示')
})

test('URL 环境继承：待命目标携带远端节点与目录，create 如实携带', { timeout: 60_000 }, async () => {
  await mount(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
  const cwdInput = document.querySelector<HTMLInputElement>('input[aria-label="新会话工作目录"]')
  assert.ok(cwdInput, '环境条进入定制模式')
  assert.equal(cwdInput!.value, '/remote/work')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '继续远端工作') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.deepEqual(state.createCalls[0], {
    profileId: 'assistant',
    nodeId: 'remote-1',
    cwd: '/remote/work',
  }, '继承的远端坐标随 create 提交，不悄悄回落本机')
})

test('主/分屏草稿隔离：同一浏览器内两份待命草稿互不串扰', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant?split=a/coder')
  const main = textarea(MAIN_LABEL)
  const split = textarea('向 编码专员 输入首条消息')
  assert.ok(split, '分屏待命输入区存在')
  act(() => { typeInto(main, '主屏草稿') })
  await settle()
  assert.equal(textarea(MAIN_LABEL).value, '主屏草稿')
  assert.equal(textarea('向 编码专员 输入首条消息').value, '', '分屏草稿不受主屏影响')
})

test('等待期切走目标：成功后不抢导航，改为通知告知新会话', { timeout: 60_000 }, async () => {
  state.createGate = makeGate()
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '等待期切走') })
  await act(async () => { pressEnter(input) })
  // 用户在途切换到既有会话
  const convRow = [...document.querySelectorAll<HTMLButtonElement>('.nav-item-sub .nav-item-main')]
    .find((btn) => btn.textContent?.includes('会话 1'))
  assert.ok(convRow, '侧栏存在历史会话行')
  await act(async () => { convRow!.click() })
  await settle()
  assert.equal(window.location.hash, '#/c/1')
  await act(async () => { state.createGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
  await settle()
  assert.equal(state.submitCalls.length, 1, '发送链路完成')
  assert.equal(window.location.hash, '#/c/1', '迟到的成功不覆盖新导航')
  assert.ok(document.body.textContent?.includes('已发送并创建会话'), '给出可点击通知')
})

test('新话题按钮：进入待命态并继承远端环境，不预建会话', { timeout: 60_000 }, async () => {
  await mount('#/c/3')
  clickButton('button[title="在当前智能体下开始新话题"]')
  await settle()
  assert.equal(window.location.hash, `#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
  assert.equal(state.createCalls.length, 0, '新话题不预建空会话')
  const cwdInput = document.querySelector<HTMLInputElement>('input[aria-label="新会话工作目录"]')
  assert.equal(cwdInput?.value, '/remote/work', '待命环境条已继承远端目录')
})

test('不可用状态如实展示：人类不可选与插件停用角色', { timeout: 60_000 }, async () => {
  await mount('#/a/singleton')
  assert.ok(document.body.textContent?.includes('该角色不支持手动新建对话'), '常驻单例给出显式不可用')
  assert.equal(document.querySelectorAll('textarea').length, 0, '不渲染草稿输入区')
  await mount('#/a/managed')
  assert.ok(document.body.textContent?.includes('该角色不支持手动新建对话'), '插件停用托管的角色同样不可用')
  assert.equal(state.createCalls.length, 0)
})

test('资产未加载不误判不存在：显式加载中状态', { timeout: 60_000 }, async () => {
  state.assetsGate = makeGate()
  window.history.replaceState(null, '', '#/a/assistant')
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  await act(async () => {
    root = createRoot(host!)
    root.render(e(App))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  assert.ok(document.body.textContent?.includes('正在加载角色信息'), '加载中显式可见')
  assert.ok(!document.body.textContent?.includes('不存在或已删除'), '不得误判不存在')
  await act(async () => { state.assetsGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
  await settle()
  assert.ok(textarea(MAIN_LABEL), '资产就绪后渲染输入区')
})

test('模型与思考档位：模型随 create 提交，思考档位创建后 patch', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  clickButton('button.composer-model-button')
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover, '模型浮层打开')
  const glm = [...popover!.querySelectorAll<HTMLButtonElement>('button.popover-item')]
    .find((btn) => btn.textContent?.includes('glm-4.6'))
  assert.ok(glm, '目录中存在可用模型')
  await act(async () => { glm!.click() })
  await settle()
  const modelBtn = document.querySelector<HTMLButtonElement>('button.composer-model-button')
  assert.ok(modelBtn!.textContent?.includes('glm-4.6'), '按钮显示显式选择')
  await act(async () => { modelBtn!.click() })
  const popover2 = document.body.querySelector<HTMLElement>('.composer-model-popover')
  const high = [...popover2!.querySelectorAll<HTMLButtonElement>('.segmented-control-btn')]
    .find((btn) => btn.textContent?.trim() === 'high')
  assert.ok(high, '思考档位控件渲染')
  await act(async () => { high!.click() })
  await settle()
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '带模型偏好') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal((state.createCalls[0] as { model?: string }).model, 'faux/glm-4.6', '模型随 create 提交')
  assert.deepEqual(state.patchCalls, [{ id: 9, body: { thinkingLevel: 'high' } }], '思考档位创建后 patch')
  assert.equal(state.submitCalls.length, 1)
})

test('右屏待命首发：主屏会话保持不变，新会话只落在右屏', { timeout: 60_000 }, async () => {
  await mount('#/c/1?split=a/assistant')
  assert.ok(document.body.textContent?.includes('会话 1'), '主屏保持原会话')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '右屏首发') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1)
  assert.equal(state.submitCalls.length, 1)
  assert.equal(window.location.hash, '#/c/1?split=c%2F9', '新会话 replace 到右屏，不劫持主屏')
  assert.ok(document.body.textContent?.includes('会话 1'), '主屏会话仍渲染')
  const splitPanes = document.querySelectorAll('.helm-split-pane')
  assert.ok(splitPanes.length > 0 && splitPanes[0]!.textContent?.includes('会话 9'), '右屏渲染新会话')
})

test('模型选择可恢复默认：显式选择后仍可点回跟随角色默认，create 不传 model', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  clickButton('button.composer-model-button')
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  const glm = [...popover!.querySelectorAll<HTMLButtonElement>('button.popover-item')]
    .find((btn) => btn.textContent?.includes('glm-4.6'))
  await act(async () => { glm!.click() })
  await settle()
  assert.ok(document.querySelector('button.composer-model-button')?.textContent?.includes('glm-4.6'))
  await act(async () => { clickButton('button.composer-model-button') })
  const popover2 = document.body.querySelector<HTMLElement>('.composer-model-popover')
  const resetBtn = [...popover2!.querySelectorAll<HTMLButtonElement>('button.popover-item')]
    .find((btn) => btn.textContent?.includes('跟随角色默认'))
  assert.ok(resetBtn, '恢复默认项存在')
  assert.equal(resetBtn!.disabled, false, '显式选择后仍可点回跟随默认')
  await act(async () => { resetBtn!.click() })
  await settle()
  assert.ok(document.querySelector('button.composer-model-button')?.textContent?.includes('默认模型'))
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '默认模型发送') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.deepEqual(state.createCalls[0], { profileId: 'assistant' }, '恢复默认后 create 不携带 model')
})

test('有历史智能体名称入口：点击站位行进待命态而非旧会话，且展开列表时保持激活', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  // assistant 拥有历史会话且列表展开（手风琴跟随当前会话）
  assert.ok(document.querySelector('.agent-conversations-list'), '话题列表展开')
  const nameBtn = [...document.querySelectorAll<HTMLButtonElement>('.nav-item-main')]
    .find((btn) => btn.textContent?.includes('个人助理'))
  assert.ok(nameBtn, '智能体站位行存在')
  await act(async () => { nameBtn!.click() })
  await settle()
  assert.equal(window.location.hash, '#/a/assistant', '名称入口进入待命态，不跳旧会话')
  assert.ok(document.querySelector('.agent-standby-pane'), '渲染待命页')
  // 列表仍展开（跟随待命目标），站位行保持激活与 aria-current
  assert.ok(document.querySelector('.agent-conversations-list'), '话题列表仍展开')
  const row = nameBtn!.closest('.agent-standing')?.querySelector('.agent-standing-row')
  assert.ok(row?.className.includes('nav-item-active'), '展开状态下待命行仍激活')
  assert.equal(nameBtn!.getAttribute('aria-current'), 'page')
  assert.equal(state.createCalls.length, 0)
})

test('真实会话 Composer /new：进入待命态并继承环境，不 reset 不 create', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const composerInput = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')
  assert.ok(composerInput, '会话输入区存在')
  act(() => { typeInto(composerInput!, '/new') })
  // 第一次 Enter 被斜杠浮层捕获回填 '/new'，第二次 Enter 提交管理命令
  await act(async () => { pressEnter(composerInput!); await new Promise((r) => setTimeout(r, 10)) })
  await act(async () => { pressEnter(composerInput!); await new Promise((r) => setTimeout(r, 10)) })
  await settle()
  assert.equal(window.location.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`, '/new 进入待命态并继承当前目录')
  assert.equal(state.resetCalls.length, 0, '/new 不再 reset 原会话')
  assert.equal(state.createCalls.length, 0, '/new 不预建会话')
})

test('待命页管理命令：/new 清理草稿，/clear 提示需先创建会话，均不落库', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '/new') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 0)
  assert.equal(state.submitCalls.length, 0)
  assert.equal(input.value, '', '/new 清理草稿正文')
  act(() => { typeInto(input, '/clear') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 0, '/clear 不创建会话')
  assert.equal(state.submitCalls.length, 0, '/clear 不作为普通输入发送')
  assert.equal(input.value, '/clear', '/clear 保留草稿待用户处理')
  assert.ok(document.body.textContent?.includes('需要已有会话'), '显式提示需先创建会话')
})

test('Profile 资产加载失败：显式错误与重试，不用完成信号伪装成功', { timeout: 60_000 }, async () => {
  state.profilesFail = true
  await mount('#/a/assistant')
  assert.ok(document.body.textContent?.includes('角色信息加载失败'), '显示真实错误')
  assert.ok(document.body.textContent?.includes('profiles down'), '携带错误详情')
  assert.ok(!document.body.textContent?.includes('不存在或已删除'), '不得误判不存在')
  assert.equal(document.querySelectorAll('textarea').length, 0, '错误态不渲染输入区')
  const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((btn) => btn.textContent?.trim() === '重试')
  assert.ok(retry, '提供重试按钮')
  state.profilesFail = false
  await act(async () => { retry!.click() })
  await settle()
  assert.ok(textarea(MAIN_LABEL), '重试成功后渲染输入区')
})

// ---------------------------------------------------------------------------
// A. 完整坐标草稿身份 / B. 锚定配置锁定 / C. logout 世代释放
// ---------------------------------------------------------------------------

function navigateHash(hash: string): void {
  window.history.pushState(null, '', hash)
  window.dispatchEvent(new Event('hashchange'))
}

test('同 Profile 不同远端坐标：草稿按坐标隔离，首发用各自坐标，旧坐标保留', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
  act(() => { typeInto(textarea(MAIN_LABEL), 'r1 草稿') })
  await act(async () => { navigateHash('#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2') })
  await settle()
  const r2 = textarea(MAIN_LABEL)
  assert.equal(r2.value, '', 'r2 坐标草稿从零开始，不串 r1 正文')
  act(() => { typeInto(r2, 'r2 草稿') })
  await act(async () => { pressEnter(r2) })
  await settle()
  assert.deepEqual(state.createCalls[0], {
    profileId: 'assistant',
    nodeId: 'remote-2',
    cwd: '/remote/work2',
  }, 'create 使用 r2 坐标，绝不带 r1 环境')
  // 回到 r1：旧坐标草稿保留
  await act(async () => { navigateHash('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork') })
  await settle()
  assert.equal(textarea(MAIN_LABEL).value, 'r1 草稿', '旧坐标草稿保留')
})

test('在途首发切换同 Profile 其他环境：不抢导航不串草稿，回包转后台通知', { timeout: 60_000 }, async () => {
  state.createGate = makeGate()
  await mount('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
  const r1 = textarea(MAIN_LABEL)
  act(() => { typeInto(r1, 'r1 在途') })
  await act(async () => { pressEnter(r1) })
  await act(async () => { navigateHash('#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2') })
  await settle()
  const r2 = textarea(MAIN_LABEL)
  assert.equal(r2.value, '', 'r2 草稿不受 r1 在途任务影响')
  await act(async () => { state.createGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
  await settle()
  assert.equal(state.submitCalls.length, 1, 'r1 任务完成提交（用 r1 配置）')
  assert.deepEqual((state.createCalls[0] as { nodeId?: string }).nodeId, 'remote-1')
  assert.equal(window.location.hash, '#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2', '不抢新导航')
  assert.ok(document.body.textContent?.includes('已发送并创建会话'), '转后台通知')
})

test('恢复默认（无冲突）：正文随坐标转移到默认环境并移除 URL 继承参数', { timeout: 60_000 }, async () => {
  await mount(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
  act(() => { typeInto(textarea(MAIN_LABEL), '跟随正文') })
  const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((btn) => btn.textContent?.trim() === '恢复默认')
  assert.ok(resetBtn, '恢复默认按钮存在（URL 坐标定制模式）')
  await act(async () => { resetBtn!.click() })
  await settle()
  assert.equal(window.location.hash, '#/a/assistant', '唯一导航移除继承环境参数，刷新不复活')
  assert.equal(textarea(MAIN_LABEL).value, '跟随正文', '正文随坐标转移')
  assert.ok(document.body.textContent?.includes('执行环境跟随角色默认'), '环境回到默认态')
})

test('恢复默认（目标已有草稿）：不覆盖已有草稿并显式告知，源草稿保留', { timeout: 60_000 }, async () => {
  await mount('#/a/assistant')
  act(() => { typeInto(textarea(MAIN_LABEL), '默认坐标已有草稿') })
  await act(async () => { navigateHash(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`) })
  await settle()
  assert.equal(textarea(MAIN_LABEL).value, '', 'r1 坐标草稿独立')
  act(() => { typeInto(textarea(MAIN_LABEL), 'r1 正文') })
  const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((btn) => btn.textContent?.trim() === '恢复默认')
  await act(async () => { resetBtn!.click() })
  await settle()
  assert.equal(window.location.hash, '#/a/assistant')
  assert.ok(document.body.textContent?.includes('默认环境已有其他草稿'), '显式告知未覆盖')
  assert.equal(textarea(MAIN_LABEL).value, '默认坐标已有草稿', '已有草稿不被无声覆盖')
  await act(async () => { navigateHash(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`) })
  await settle()
  assert.equal(textarea(MAIN_LABEL).value, 'r1 正文', '源草稿保留在原坐标')
})

test('锚定后锁定创建配置：模型/环境不可改，横幅提示绑定会话，正文附件仍可改后重试', { timeout: 60_000 }, async () => {
  state.submitFailures = 1
  await mount('#/a/assistant')
  const input = textarea(MAIN_LABEL)
  act(() => { typeInto(input, '首发锚定') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.ok(document.body.textContent?.includes('已创建会话 #9'), '锁定横幅可见')
  assert.equal(document.querySelector<HTMLButtonElement>('button.composer-model-button')?.disabled, true, '模型选择锁定')
  const customizeBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((btn) => btn.textContent?.trim() === '自定义')
  assert.equal(customizeBtn?.disabled, true, '起始环境锁定')
  act(() => { typeInto(input, '（已修正）') })
  await act(async () => { pressEnter(input) })
  await settle()
  assert.equal(state.createCalls.length, 1, '重试复用会话')
  assert.equal(state.submitCalls.length, 2)
  assert.equal(window.location.hash, '#/c/9')
})

test('logout 于 create 等待期：释放草稿并作废在途回包，不复活不提交不通知', { timeout: 60_000 }, async () => {
  state.createGate = makeGate()
  await mount('#/a/assistant')
  act(() => { typeInto(textarea(MAIN_LABEL), '将被释放') })
  await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
  await act(async () => { window.dispatchEvent(new Event('helm:unauthorized')) })
  await settle()
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  assert.equal(getStandbyDraft(key).text, '', 'logout 同步释放草稿')
  await act(async () => { state.createGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
  await settle()
  assert.equal(state.createCalls.length, 1, '已发出的请求不假称能撤回')
  assert.equal(state.submitCalls.length, 0, '世代作废后不继续 submit')
  assert.equal(getStandbyDraft(key).conversationId, undefined, '回包不得写入锚点')
  assert.equal(getStandbyDraft(key).text, '', '回包不得复活正文')
  assert.ok(!document.body.textContent?.includes('已发送并创建会话'), '不发通知')
})

test('logout 于 upload 等待期：不继续 submit、不复活附件；重登同坐标草稿为空', { timeout: 60_000 }, async () => {
  state.uploadGate = makeGate()
  await mount('#/a/assistant')
  const box = document.querySelector<HTMLElement>('.agent-standby-pane .composer-box')!
  await act(async () => { dropFiles(box, [new File(['hi'], 'wait.txt', { type: 'text/plain' })]) })
  await settle()
  act(() => { typeInto(textarea(MAIN_LABEL), '上传中释放') })
  await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
  await new Promise((r) => setTimeout(r, 10))
  await act(async () => { window.dispatchEvent(new Event('helm:unauthorized')) })
  await settle()
  await act(async () => { state.uploadGate!.resolve(); await new Promise((r) => setTimeout(r, 30)) })
  await settle()
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  assert.equal(state.submitCalls.length, 0, '上传回包作废后不继续 submit')
  assert.equal(getStandbyDraft(key).uploaded.length, 0, '回包不得复活附件')
  assert.equal(getStandbyDraft(key).text, '', '重登同坐标无旧正文')
})
