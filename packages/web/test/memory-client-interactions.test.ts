import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginClientContext as ClientContext, ProfileDetailSlotProps } from '@helm/protocol'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import * as HelmPluginClient from '../src/lib/plugin-client-context.js'

// DOM 必须先于 react-dom/client 求值，合成 textarea 事件才会注册浏览器输入路径。
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const { act } = React
const e = React.createElement
const cacheDir = mkdtempSync(join(tmpdir(), 'helm-memory-client-'))
let MemorySection: React.ComponentType<ProfileDetailSlotProps>

before(async () => {
  Object.assign(globalThis, {
    __helm_shared_react: React,
    __helm_shared_react_jsx_runtime: ReactJsxRuntime,
    __helm_shared_lucide_react: LucideReact,
    __helm_shared_plugin_client: HelmPluginClient,
  })
  const clientRoot = fileURLToPath(new URL('../../kernel/src/builtin-plugins/memory/client', import.meta.url))
  const { code } = await compilePluginClientModule('builtin:memory', clientRoot, 'index.tsx', cacheDir)
  const compiled = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  MemorySection = compiled.ProfileMemorySection as React.ComponentType<ProfileDetailSlotProps>
})
after(() => rmSync(cacheDir, { recursive: true, force: true }))

interface MemoryResult { profileId: string; enabled: boolean; content: string; initialized: boolean }
function memory(profileId: string, content: string, enabled = true): MemoryResult {
  return { profileId, content, enabled, initialized: true }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
interface ActionCall { action: string; profileId: string; input: Record<string, unknown> }

function context(callAction: ClientContext['callAction']): ClientContext {
  return {
    pluginId: 'builtin:memory', callAction,
    submitInput: async () => {},
    openScreen: () => {}, openSplitScreen: () => {}, openConversationDrawer: () => {},
    openArtifact: () => {}, openWorkbench: () => {}, closeWorkbench: () => {}, notify: () => {},
    getPluginDoc: async () => undefined, getPluginSessionDoc: async () => undefined,
    theme: 'dark',
  }
}

async function mount(callAction: ClientContext['callAction']) {
  let activeContext = context(callAction)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = async (profileId: string, nextContext = activeContext) => {
    activeContext = nextContext
    await act(async () => {
      root.render(e(HelmPluginClient.PluginClientContext.Provider, { value: activeContext },
        e(MemorySection, { profileId, isNew: false, disabled: false })))
    })
  }
  await render('a')
  let unmounted = false
  return {
    host, render,
    unmount() {
      if (unmounted) return
      unmounted = true
      act(() => root.unmount())
      host.remove()
    },
  }
}

function editor(host: HTMLElement): HTMLTextAreaElement {
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="长期记忆"]')
  assert.ok(textarea, host.textContent ?? '应有记忆编辑器')
  return textarea
}
function saveButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.includes('保存记忆') || node.textContent?.includes('保存中'))
  assert.ok(button)
  return button
}
async function typeText(host: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const textarea = editor(host)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save(host: HTMLElement): Promise<void> {
  assert.equal(saveButton(host).disabled, false)
  await act(async () => { saveButton(host).click() })
}

// 编译与真实 React hooks/effects/DOM 事件全走生产组件；只控制动作 Promise 的完成时序。
test('A 保存的 set 未完成时切 B：旧成功不会再 get A，也不会把 A 草稿写 B', { timeout: 60_000 }, async () => {
  const setA = deferred<unknown>()
  const calls: ActionCall[] = []
  const action: ClientContext['callAction'] = async (name, input) => {
    const value = input as Record<string, unknown>
    const id = String(value.profileId)
    calls.push({ action: name, profileId: id, input: value })
    if (name === 'set' && id === 'a') return setA.promise
    if (name === 'get') return memory(id, id === 'a' ? 'A 原文' : 'B 原文')
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, 'A 修改')
    await save(ui.host)
    await ui.render('b')
    await typeText(ui.host, 'B 修改')
    await act(async () => { setA.resolve({ updated: true }) })
    assert.equal(editor(ui.host).value, 'B 修改')
    assert.equal(ui.host.querySelector('[role="alert"]'), null)
    assert.equal(calls.filter((call) => call.action === 'get' && call.profileId === 'a').length, 1)
    await save(ui.host)
    const bSet = calls.find((call) => call.action === 'set' && call.profileId === 'b')
    assert.equal(bSet?.input.text, 'B 修改')
  } finally { ui.unmount() }
})

test('A 保存后 get A 在途时切 B：旧内容与 finally 不覆盖 B 的加载请求', { timeout: 60_000 }, async () => {
  const refreshA = deferred<MemoryResult>()
  const loadB = deferred<MemoryResult>()
  let getsA = 0
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get' && id === 'a') return ++getsA === 1 ? memory('a', 'A 原文') : refreshA.promise
    if (name === 'get' && id === 'b') return loadB.promise
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, 'A 修改')
    await save(ui.host)
    await ui.render('b')
    assert.match(ui.host.textContent!, /加载记忆中/)
    await act(async () => { refreshA.resolve(memory('a', 'A 保存结果')) })
    assert.match(ui.host.textContent!, /加载记忆中/, 'A finally 不得清掉 B busy')
    assert.equal(ui.host.querySelector('textarea'), null)
    await act(async () => { loadB.resolve(memory('b', 'B 结果')) })
    assert.equal(editor(ui.host).value, 'B 结果')
  } finally { ui.unmount() }
})

test('A toggle 中切 B：旧 configure 完成后不再 load A、不作废 B 请求', { timeout: 60_000 }, async () => {
  const configureA = deferred<unknown>()
  const loadB = deferred<MemoryResult>()
  const calls: ActionCall[] = []
  const action: ClientContext['callAction'] = async (name, input) => {
    const value = input as Record<string, unknown>
    const id = String(value.profileId)
    calls.push({ action: name, profileId: id, input: value })
    if (name === 'configure') return configureA.promise
    return id === 'a' ? memory('a', 'A 原文') : loadB.promise
  }
  const ui = await mount(action)
  try {
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    await ui.render('b')
    await act(async () => { configureA.resolve({ profileId: 'a', enabled: false }) })
    assert.match(ui.host.textContent!, /加载记忆中/)
    assert.equal(calls.filter((call) => call.action === 'get' && call.profileId === 'a').length, 1)
    await act(async () => { loadB.resolve(memory('b', 'B 原文')) })
    assert.equal(editor(ui.host).value, 'B 原文')
    assert.equal(ui.host.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
  } finally { ui.unmount() }
})

test('configure 已开启但后续 get 失败时显示未知状态，不沿用已关闭的旧状态', { timeout: 60_000 }, async () => {
  let getCount = 0
  const ui = await mount(async (name) => {
    if (name === 'get') {
      if (++getCount === 1) return memory('a', 'A 原文', false)
      throw new Error('开启后读取失败')
    }
    return { profileId: 'a', enabled: true }
  })
  try {
    assert.match(ui.host.textContent!, /已为此角色关闭/)
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    assert.match(ui.host.textContent!, /开启后读取失败|无法读取记忆状态/)
    assert.doesNotMatch(ui.host.textContent!, /已为此角色关闭/)
    assert.equal(ui.host.querySelector('[role="switch"]'), null)
  } finally { ui.unmount() }
})

test('A toggle 晚失败与保存后卸载不污染当前视图，也不发起卸载后的刷新', { timeout: 60_000 }, async () => {
  const configureA = deferred<unknown>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    return name === 'configure' ? configureA.promise : memory(id, `${id} 原文`)
  }
  const ui = await mount(action)
  try {
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    await ui.render('b')
    await act(async () => { configureA.reject(new Error('A toggle 晚失败')) })
    assert.equal(editor(ui.host).value, 'b 原文')
    assert.equal(ui.host.querySelector('[role="alert"]'), null)
    assert.equal(ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled, false)
  } finally { ui.unmount() }

  const setA = deferred<unknown>()
  const calls: string[] = []
  const saving = await mount(async (name) => {
    calls.push(name)
    return name === 'set' ? setA.promise : memory('a', 'A 原文')
  })
  await typeText(saving.host, 'A 提交')
  await save(saving.host)
  saving.unmount()
  await act(async () => { setA.resolve({ updated: true }) })
  assert.deepEqual(calls, ['get', 'set'], '卸载使保存结果失效，不应再 get 或 setState')
})

test('保存期间续打保留：仅 submittedText 写盘，fresh 只更新已保存基线', { timeout: 60_000 }, async () => {
  const fresh = deferred<MemoryResult>()
  let gets = 0
  const submitted: unknown[] = []
  const action: ClientContext['callAction'] = async (name, input) => {
    if (name === 'set') { submitted.push(input); return {} }
    if (name === 'get') return ++gets === 1 ? memory('a', '原文') : fresh.promise
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, '提交文本')
    await save(ui.host)
    await typeText(ui.host, '提交文本 + 后续输入')
    await act(async () => { fresh.resolve(memory('a', '提交文本')) })
    assert.equal((submitted[0] as { text: string }).text, '提交文本')
    assert.equal(editor(ui.host).value, '提交文本 + 后续输入')
    assert.equal(saveButton(ui.host).disabled, false, '续打仍为 dirty，可再次保存')
  } finally { ui.unmount() }
})

test('宿主 ctx 重建不重置草稿，后续保存使用最新动作委托', { timeout: 60_000 }, async () => {
  const firstCalls: string[] = []
  const nextCalls: string[] = []
  const initial: ClientContext['callAction'] = async (name) => {
    firstCalls.push(name)
    return memory('a', 'A 原文')
  }
  const ui = await mount(initial)
  try {
    await typeText(ui.host, '未保存草稿')
    await ui.render('a', context(async (name) => {
      nextCalls.push(name)
      return name === 'get' ? memory('a', '未保存草稿') : {}
    }))
    assert.equal(editor(ui.host).value, '未保存草稿')
    assert.deepEqual(firstCalls, ['get'], 'context 重建不得触发 effect 重载')
    assert.deepEqual(nextCalls, [])
    await save(ui.host)
    assert.deepEqual(nextCalls, ['set', 'get'], '不得使用过时 context 闭包')
  } finally { ui.unmount() }
})

test('晚失败与卸载均使旧请求失效，get 失败不显示为已关闭', { timeout: 60_000 }, async () => {
  const saveA = deferred<unknown>()
  const loadB = deferred<MemoryResult>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'set') return saveA.promise
    return id === 'a' ? memory('a', 'A 原文') : loadB.promise
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, 'A 修改')
    await save(ui.host)
    await ui.render('b')
    await act(async () => { saveA.reject(new Error('A 晚到失败')) })
    assert.match(ui.host.textContent!, /加载记忆中/)
    assert.doesNotMatch(ui.host.textContent!, /A 晚到失败|已为此角色关闭/)
    await act(async () => { loadB.reject(new Error('B 加载失败')) })
    assert.match(ui.host.textContent!, /B 加载失败|无法读取记忆状态/)
    assert.doesNotMatch(ui.host.textContent!, /已为此角色关闭/)
    assert.equal(ui.host.querySelector('[role="switch"]'), null, '未知状态不可伪装为关闭开关')
  } finally { ui.unmount() }

  const pending = deferred<MemoryResult>()
  const unmounted = await mount(async () => pending.promise)
  unmounted.unmount()
  await act(async () => { pending.reject(new Error('卸载后的失败')) })
  assert.equal(document.body.contains(unmounted.host), false)
})
