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
import type { PluginClientContext as ClientContext, ProfileDetailSlotProps } from '@helmx/protocol'
import * as HelmxPluginClient from '@helmx/plugin-client'
import { compilePluginClientModule } from '@helmx/plugin-build'

// DOM 必须先于 react-dom/client 求值，合成 textarea 事件才会注册浏览器输入路径。
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const { act } = React
const e = React.createElement
const cacheDir = mkdtempSync(join(tmpdir(), 'helmx-memory-client-'))
let MemorySection: React.ComponentType<ProfileDetailSlotProps>

before(async () => {
  Object.assign(globalThis, {
    __helmx_shared_react: React,
    __helmx_shared_react_jsx_runtime: ReactJsxRuntime,
    __helmx_shared_lucide_react: LucideReact,
    __helmx_shared_plugin_client: HelmxPluginClient,
  })
  const clientRoot = fileURLToPath(new URL('../../plugins/src/memory/client', import.meta.url))
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

interface DreamStatus {
  config: { enabled: boolean; hour: number; timezone: string }
  nextRunAt?: number
  running: string[]
  profiles: Array<{
    profileId: string
    candidateCount: number
    memoryChars: number | null
    lastRun?: { lastRunAt?: number; ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; error?: string }
  }>
}
function dreamStatus(profileId: string, extra: Partial<DreamStatus> = {}): DreamStatus {
  return {
    config: { enabled: true, hour: 3, timezone: 'UTC' },
    nextRunAt: 1_900_000_000_000,
    running: [],
    profiles: [{ profileId, candidateCount: 2, memoryChars: 20 }],
    ...extra,
  }
}

function context(callAction: ClientContext['callAction']): ClientContext {
  return {
    pluginId: 'builtin:memory', callAction,
    submitInput: async () => {},
    openScreen: () => {}, openSplitScreen: () => {}, openConversationDrawer: () => {},
    openArtifact: () => {}, openWorkbench: () => {}, closeWorkbench: () => {}, notify: () => {},
    getPluginDoc: async () => undefined, getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    locale: 'en',
    translate: (text) => (typeof text === 'string' ? text : ''),
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
      root.render(e(HelmxPluginClient.PluginClientContext.Provider, { value: activeContext },
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
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Long-term memory"]')
  assert.ok(textarea, host.textContent ?? '应有记忆编辑器')
  return textarea
}
function saveButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.includes('Save memory') || node.textContent?.includes('Saving…'))
  assert.ok(button)
  return button
}
function dreamRunButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.includes('Organize now') || node.textContent?.includes('Organizing…'))
  assert.ok(button, host.textContent ?? '应有「立即整理」按钮')
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
    if (name === 'dream_status') return dreamStatus(id)
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
    assert.ok(ui.host.querySelector('[role="alert"]') === null)
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
    if (name === 'dream_status') return dreamStatus(id)
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, 'A 修改')
    await save(ui.host)
    await ui.render('b')
    assert.match(ui.host.textContent!, /Loading memory/)
    await act(async () => { refreshA.resolve(memory('a', 'A 保存结果')) })
    assert.match(ui.host.textContent!, /Loading memory/, 'A finally 不得清掉 B busy')
    assert.ok(ui.host.querySelector('textarea') === null)
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
    if (name === 'dream_status') return dreamStatus(id)
    return id === 'a' ? memory('a', 'A 原文') : loadB.promise
  }
  const ui = await mount(action)
  try {
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    await ui.render('b')
    await act(async () => { configureA.resolve({ profileId: 'a', enabled: false }) })
    assert.match(ui.host.textContent!, /Loading memory/)
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
    if (name === 'dream_status') return dreamStatus('a')
    return { profileId: 'a', enabled: true }
  })
  try {
    assert.match(ui.host.textContent!, /Long-term memory is disabled for this profile/)
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    assert.match(ui.host.textContent!, /开启后读取失败|Cannot read the memory state/)
    assert.doesNotMatch(ui.host.textContent!, /Long-term memory is disabled for this profile/)
    assert.ok(ui.host.querySelector('[role="switch"]') === null)
  } finally { ui.unmount() }
})

test('A toggle 晚失败与保存后卸载不污染当前视图，也不发起卸载后的刷新', { timeout: 60_000 }, async () => {
  const configureA = deferred<unknown>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'dream_status') return dreamStatus(id)
    return name === 'configure' ? configureA.promise : memory(id, `${id} 原文`)
  }
  const ui = await mount(action)
  try {
    await act(async () => { ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    await ui.render('b')
    await act(async () => { configureA.reject(new Error('A toggle 晚失败')) })
    assert.equal(editor(ui.host).value, 'b 原文')
    assert.ok(ui.host.querySelector('[role="alert"]') === null)
    assert.equal(ui.host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled, false)
  } finally { ui.unmount() }

  const setA = deferred<unknown>()
  const calls: string[] = []
  const saving = await mount(async (name) => {
    calls.push(name)
    if (name === 'dream_status') return dreamStatus('a')
    return name === 'set' ? setA.promise : memory('a', 'A 原文')
  })
  await typeText(saving.host, 'A 提交')
  await save(saving.host)
  saving.unmount()
  await act(async () => { setA.resolve({ updated: true }) })
  assert.deepEqual(calls, ['get', 'dream_status', 'set'], '卸载使保存结果失效，不应再 get 或 setState')
})

test('保存期间续打保留：仅 submittedText 写盘，fresh 只更新已保存基线', { timeout: 60_000 }, async () => {
  const fresh = deferred<MemoryResult>()
  let gets = 0
  const submitted: unknown[] = []
  const action: ClientContext['callAction'] = async (name, input) => {
    if (name === 'set') { submitted.push(input); return {} }
    if (name === 'get') return ++gets === 1 ? memory('a', '原文') : fresh.promise
    if (name === 'dream_status') return dreamStatus('a')
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
    if (name === 'dream_status') return dreamStatus('a')
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
    assert.deepEqual(firstCalls, ['get', 'dream_status'], 'context 重建不得触发 effect 重载')
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
    if (name === 'dream_status') return dreamStatus(id)
    return id === 'a' ? memory('a', 'A 原文') : loadB.promise
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, 'A 修改')
    await save(ui.host)
    await ui.render('b')
    await act(async () => { saveA.reject(new Error('A 晚到失败')) })
    assert.match(ui.host.textContent!, /Loading memory/)
    assert.doesNotMatch(ui.host.textContent!, /A 晚到失败|Long-term memory is disabled for this profile/)
    await act(async () => { loadB.reject(new Error('B 加载失败')) })
    assert.match(ui.host.textContent!, /B 加载失败|Cannot read the memory state/)
    assert.doesNotMatch(ui.host.textContent!, /Long-term memory is disabled for this profile/)
    assert.ok(ui.host.querySelector('[role="switch"]') === null, '未知状态不可伪装为关闭开关')
  } finally { ui.unmount() }

  const pending = deferred<MemoryResult>()
  const unmounted = await mount(async () => pending.promise)
  unmounted.unmount()
  await act(async () => { pending.reject(new Error('卸载后的失败')) })
  assert.equal(document.body.contains(unmounted.host), false)
})

// ---------------------------------------------------------------------------
// Dream（每日自动整理）客户端行为
// ---------------------------------------------------------------------------

test('dream 整理成功后：干净编辑区展示新正文、状态刷新、保存不误判 dirty', { timeout: 60_000 }, async () => {
  let gets = 0
  let statusCalls = 0
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, ++gets === 1 ? '原文' : '原文\n- 整理新增行')
    if (name === 'dream_status') { statusCalls += 1; return dreamStatus(id) }
    if (name === 'dream') return { profileId: id, ran: true, applied: true, conflict: false, candidateCount: 2, consumed: 2 }
    return {}
  }
  const ui = await mount(action)
  try {
    await act(async () => { dreamRunButton(ui.host).click() })
    assert.equal(editor(ui.host).value, '原文\n- 整理新增行', '干净编辑区应刷新为整理后正文')
    assert.match(ui.host.textContent!, /Dream applied \(2 candidates merged\)/)
    assert.ok(statusCalls >= 2, '整理后应刷新 dream 状态')
    assert.equal(saveButton(ui.host).disabled, true, '编辑区与基线一致，保存不应显示可点')
    assert.doesNotMatch(ui.host.textContent!, /Unsaved changes/, '干净编辑区不得出现未保存提示')
  } finally { ui.unmount() }
})

test('dream 整理应用时未保存草稿被保留，并警示保存会覆盖整理结果', { timeout: 60_000 }, async () => {
  let gets = 0
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, ++gets === 1 ? '原文' : '原文\n- 整理新增行')
    if (name === 'dream_status') return dreamStatus(id)
    if (name === 'dream') return { profileId: id, ran: true, applied: true, conflict: false, candidateCount: 2, consumed: 2 }
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, '我的未保存修改')
    assert.match(ui.host.textContent!, /Unsaved changes/)
    await act(async () => { dreamRunButton(ui.host).click() })
    assert.equal(editor(ui.host).value, '我的未保存修改', '未保存草稿必须保留，绝不静默覆盖')
    assert.match(ui.host.textContent!, /Dream applied \(2 candidates merged\)/)
    assert.match(ui.host.textContent!, /Unsaved edits in the editor were kept/, '应警示保存草稿会覆盖整理结果')
    assert.match(ui.host.textContent!, /Unsaved changes/, '未保存提示保持')
    assert.equal(saveButton(ui.host).disabled, false, '脏草稿仍可显式保存')
  } finally { ui.unmount() }
})

test('dream_status 读取失败：失败文案与可用的手动运行控件一致，运行后恢复', { timeout: 60_000 }, async () => {
  let statusFails = true
  let gets = 0
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, ++gets === 1 ? '原文' : '原文\n- 整理新增行')
    if (name === 'dream_status') {
      if (statusFails) throw new Error('boom: dream_status 503')
      return dreamStatus(id)
    }
    if (name === 'dream') return { profileId: id, ran: true, applied: true, conflict: false, candidateCount: 2, consumed: 2 }
    return {}
  }
  const ui = await mount(action)
  try {
    assert.match(ui.host.textContent!, /Dream status unavailable; manual organizing still works/, '失败文案承诺手动整理可用')
    assert.equal(dreamRunButton(ui.host).disabled, false, '状态读取失败时手动整理按钮必须可用')
    assert.match(ui.host.textContent!, /boom: dream_status 503/, '原始错误如实透出')
    statusFails = false
    await act(async () => { dreamRunButton(ui.host).click() })
    assert.match(ui.host.textContent!, /Dream applied \(2 candidates merged\)/)
    assert.match(ui.host.textContent!, /daily 03:00/, '整理后状态行恢复')
    assert.equal(editor(ui.host).value, '原文\n- 整理新增行')
  } finally { ui.unmount() }
})

test('Profile 切换后旧 Profile 迟到的 get / dream_status 响应不得污染新 Profile', { timeout: 60_000 }, async () => {
  const lateGet = deferred<unknown>()
  const lateStatus = deferred<unknown>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (id === 'a') return name === 'get' ? lateGet.promise : lateStatus.promise
    if (name === 'get') return memory('b', 'B 原文')
    return dreamStatus('b', { config: { enabled: false, hour: 5, timezone: 'Asia/Shanghai' } })
  }
  const ui = await mount(action)
  try {
    await ui.render('b')
    assert.equal(editor(ui.host).value, 'B 原文')
    assert.match(ui.host.textContent!, /paused/, 'B 的暂停调度展示')
    await act(async () => {
      lateGet.resolve(memory('a', '迟到的 A 正文'))
      lateStatus.resolve(dreamStatus('a'))
    })
    assert.equal(editor(ui.host).value, 'B 原文', '迟到的 A 正文不得改写 B 编辑区')
    assert.match(ui.host.textContent!, /paused/, '迟到的 A 状态不得回滚 B 的调度行')
    assert.doesNotMatch(ui.host.textContent!, /daily 03:00/, 'A 的调度不得出现在 B 视图')
  } finally { ui.unmount() }
})

test('dream 状态行展示 lastRun 时间、失败短诊断与下次运行时间', { timeout: 60_000 }, async () => {
  const lastRunAt = 1_899_999_000_000
  const longError = `dream_model_failed: ${'x'.repeat(300)}`
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, '原文')
    if (name === 'dream_status') {
      return dreamStatus(id, {
        nextRunAt: 1_900_000_000_000,
        profiles: [{ profileId: id, candidateCount: 4, memoryChars: 20, lastRun: { lastRunAt, ran: true, applied: false, error: longError } }],
      })
    }
    return {}
  }
  const ui = await mount(action)
  try {
    const when = new Date(lastRunAt).toLocaleString('en')
    const next = new Date(1_900_000_000_000).toLocaleString('en')
    assert.ok(ui.host.textContent!.includes(when), 'lastRun 展示绝对时间')
    assert.ok(ui.host.textContent!.includes(`next run ${next}`), '展示调度的下次运行时间')
    assert.match(ui.host.textContent!, /last run .*: failed/, '失败结局进入 lastRun 行')
    const diag = ui.host.querySelector('.memory-dream-diag')
    assert.ok(diag, '诊断行渲染')
    assert.ok((diag.textContent ?? '').startsWith('last error: dream_model_failed: xxx'))
    assert.ok((diag.textContent ?? '').length <= 'last error: '.length + 161, '诊断超 160 字符显式截断')
  } finally { ui.unmount() }
})

test('dream_status 载荷畸形：诚实报错、整节不崩溃、手动运行仍可用', { timeout: 60_000 }, async () => {
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, '原文')
    if (name === 'dream_status') return {}
    if (name === 'dream') return { profileId: id, ran: true, applied: true, conflict: false, candidateCount: 2, consumed: 2 }
    return {}
  }
  const ui = await mount(action)
  try {
    assert.equal(editor(ui.host).value, '原文', '记忆编辑区不受畸形状态影响')
    assert.match(ui.host.textContent!, /Dream status response is malformed/, '畸形载荷如实报错')
    assert.match(ui.host.textContent!, /Dream status unavailable; manual organizing still works/)
    assert.equal(dreamRunButton(ui.host).disabled, false, '畸形状态下手动整理按钮仍可用')
    assert.ok(ui.host.querySelector('[role="switch"]') !== null, '整节不崩溃，开关仍在')
  } finally { ui.unmount() }
})

test('dream 运行/刷新期间阻止 Save 与 Switch 分叉，textarea 仍可形成草稿；反向亦然', { timeout: 60_000 }, async () => {
  const dreamGate = deferred<unknown>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') return memory(id, '原文')
    if (name === 'dream_status') return dreamStatus(id)
    if (name === 'dream') return dreamGate.promise
    return {}
  }
  const ui = await mount(action)
  try {
    await act(async () => { dreamRunButton(ui.host).click() })
    assert.match(ui.host.textContent!, /Organizing…/)
    await typeText(ui.host, '运行期间的新草稿')
    assert.equal(editor(ui.host).value, '运行期间的新草稿', 'textarea 在整理期间仍可编辑')
    assert.equal(saveButton(ui.host).disabled, true, '整理在途（含写回与刷新窗口）Save 必须锁定')
    const switchNode = ui.host.querySelector<HTMLButtonElement>('[role="switch"]')
    assert.ok(switchNode !== null)
    assert.equal(switchNode.disabled, true, '整理在途 Switch 必须锁定')
    await act(async () => { dreamGate.resolve({ profileId: 'a', ran: true, applied: true, candidateCount: 2, consumed: 2 }) })
    assert.equal(editor(ui.host).value, '运行期间的新草稿', '脏草稿跨整理保留')
    assert.equal(saveButton(ui.host).disabled, false, '整理结束后 Save 解锁（脏草稿可显式保存）')
    assert.equal(switchNode.disabled, false, '整理结束后 Switch 解锁')
  } finally { ui.unmount() }
})

test('Save 在途时不得开整理（双向互斥）', { timeout: 60_000 }, async () => {
  const setGate = deferred<unknown>()
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'set') return setGate.promise
    if (name === 'get') return memory(id, '原文')
    if (name === 'dream_status') return dreamStatus(id)
    return {}
  }
  const ui = await mount(action)
  try {
    await typeText(ui.host, '待保存草稿')
    await act(async () => { saveButton(ui.host).click() })
    assert.equal(dreamRunButton(ui.host).disabled, true, 'Save 在途时整理按钮必须禁用')
    await act(async () => { setGate.resolve({ ok: true }) })
    assert.equal(dreamRunButton(ui.host).disabled, false, 'Save 结束后整理恢复可用')
  } finally { ui.unmount() }
})

test('整理后正文刷新失败：显式告警与重试，成功后编辑区追上新正文', { timeout: 60_000 }, async () => {
  let gets = 0
  const action: ClientContext['callAction'] = async (name, input) => {
    const id = String((input as { profileId: string }).profileId)
    if (name === 'get') {
      gets += 1
      if (gets === 2) throw new Error('刷新读取失败')
      return memory(id, gets === 1 ? '原文' : '原文\n- 整理新增行')
    }
    if (name === 'dream_status') return dreamStatus(id)
    if (name === 'dream') return { profileId: id, ran: true, applied: true, conflict: false, candidateCount: 2, consumed: 2 }
    return {}
  }
  const ui = await mount(action)
  try {
    await act(async () => { dreamRunButton(ui.host).click() })
    assert.equal(editor(ui.host).value, '原文', '刷新失败时编辑区不伪造新正文')
    assert.match(ui.host.textContent!, /Dream applied \(2 candidates merged\)/, '整理本身的成果如实报告')
    const alert = ui.host.querySelector('[role="alert"].memory-dream-refresh-error')
    assert.ok(alert !== null, '刷新失败必须有显式告警')
    assert.match(ui.host.textContent!, /failed to reload it; the editor still shows the previous version/)
    const retry = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Retry')
    assert.ok(retry !== undefined, '刷新失败提供重试入口')
    await act(async () => { retry.click() })
    assert.equal(editor(ui.host).value, '原文\n- 整理新增行', '重试成功后编辑区追上整理后正文')
    assert.ok(ui.host.querySelector('[role="alert"].memory-dream-refresh-error') === null, '成功后告警消除')
    assert.match(ui.host.textContent!, /\/ 4000 chars/, '编辑区字数上限展示与 4000 硬上限一致')
  } finally { ui.unmount() }
})
