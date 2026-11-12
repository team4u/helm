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
const { resetStandbyDrafts } = await import('../src/conversation/standby-model.js')

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
  assetsGate: undefined as Gate | undefined,
  createFailures: 0,
  submitFailures: 0,
  uploadFailures: 0,
}

function resetState(): void {
  state.conversations = [...initialConversations]
  state.nextId = 9
  state.createCalls = []
  state.submitCalls = []
  state.patchCalls = []
  state.uploadCalls = []
  state.createGate = undefined
  state.submitGate = undefined
  state.assetsGate = undefined
  state.createFailures = 0
  state.submitFailures = 0
  state.uploadFailures = 0
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
      state.uploadCalls.push({ id, name })
      if (state.uploadFailures > 0) {
        state.uploadFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'upload failed' } }, 500)
      }
      return jsonResponse({ id: `art-${state.uploadCalls.length}`, name, size: 5, mimeType: 'text/plain' })
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
