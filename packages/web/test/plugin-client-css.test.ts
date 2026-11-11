/**
 * 插件 client 模块样式生命周期测试：
 * - 编译产物仅携带样式文本导出（__helmClientCss），模块求值绝不写 DOM；
 *   样式注入/更新/回收全部由 loader 在有效性与 entry 身份校验后统一完成。
 * - node 测试将 Blob URL 转为独一 data URL（模块真实求值）；确定性 gate（模块顶层
 *   await）暂停 import，验证停用/reset 后迟到完成显式失效且零残留、不碰新 epoch 样式。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  loadPluginClientModule,
  seedPluginClientModule,
  evictPluginClientCache,
  resetPluginClientCache,
  getCachedClientComponent,
  requireClientExport,
  subscribePluginClientCacheInvalidation,
  getPluginClientCacheRevision,
  PluginClientError,
} from '../src/lib/plugin-client.js'

GlobalRegistrator.register()

const originalFetch = globalThis.fetch
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const CSS_PLUGIN_SELECTOR = 'style[data-helm-plugin-css-plugin]'

afterEach(() => {
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  resetPluginClientCache()
})

/** node 环境无 Blob URL 模块加载：转独一 data URL，保证模块按次真实求值（含重试）。 */
let moduleSeq = 0
let nextDataUrl: string | undefined
let nextCode = ''
let nextHash = ''
let objectUrlCalls = 0

function installDataUrlModuleServing(): void {
  globalThis.fetch = async () => new Response(nextCode, { headers: { 'x-helm-client-hash': nextHash } })
  URL.createObjectURL = (() => {
    objectUrlCalls++
    const url = nextDataUrl
    if (url === undefined) throw new Error('测试未预置模块 data URL，出现意外的重复 import')
    nextDataUrl = undefined
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
}

function serveModule(code: string, hash: string): void {
  nextHash = hash
  nextCode = code
  nextDataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`/*helm-css-${++moduleSeq}*/\n${code}`)}`
}

const cssExport = (css: string): string => `export const __helmClientCss = ${JSON.stringify(css)}\n`
const PANEL_EXPORT = 'export function Panel() { return "panel" }\n'
/** 顶层 await gate：模块求值暂停，直到测试显式放行（模拟 import 在途的确定窗口）；必须是纯 JS（data URL 不经转译）。 */
const GATED = 'await new Promise((resolve) => { globalThis.__helmCssGate = resolve })\n'

const gateSlot = globalThis as unknown as { __helmCssGate?: () => void }

async function waitForGate(timeoutMs = 5000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  while (gateSlot.__helmCssGate === undefined) {
    if (Date.now() > deadline) throw new Error('等待模块求值 gate 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const resume = gateSlot.__helmCssGate
  delete gateSlot.__helmCssGate
  return resume
}

const styleKey = (pluginId: string, moduleRef: string): string => `${pluginId}::${moduleRef}`

function pluginStyle(pluginId: string, moduleRef: string): HTMLStyleElement | null {
  return document.querySelector(`style[data-helm-plugin-css="${styleKey(pluginId, moduleRef)}"]`)
}

function allPluginStyles(): NodeListOf<HTMLStyleElement> {
  return document.querySelectorAll(CSS_PLUGIN_SELECTOR)
}

async function assertInvalidated(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
    '失效后的在途加载必须以 client_module_invalidated 显式报错收场',
  )
}

test('样式装载成功：单入口单 style 节点，属性齐全，模块命名空间原样返回', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
  const loaded = await loadPluginClientModule('p', 'index.tsx')
  assert.equal(loaded.contentHash, 'h1')
  assert.equal(loaded.module.__helmClientCss, '.a { color: red }')
  assert.equal(typeof loaded.module.Panel, 'function')
  const style = pluginStyle('p', 'index.tsx')
  assert.ok(style instanceof HTMLStyleElement, '模块装载成功后必须注入样式节点')
  assert.equal(style.getAttribute('data-helm-plugin-css-plugin'), 'p')
  assert.equal(style.getAttribute('data-helm-plugin-css-hash'), 'h1')
  assert.equal(style.textContent, '.a { color: red }')
  assert.ok(style.isConnected && document.head.contains(style), '样式节点应挂载在 head')
  // resolved 缓存发布不晚于样式装载：同步命中时样式必已在页面上
  assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), loaded.module.Panel)
})

test('同 hash 并发与缓存命中：单次 import 去重、同一节点复用不闪烁不累积', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
  objectUrlCalls = 0
  const [first, second] = await Promise.all([
    loadPluginClientModule('p', 'index.tsx'),
    loadPluginClientModule('p', 'index.tsx'),
  ])
  assert.equal(first.module, second.module, '同 hash 并发必须共享同一模块命名空间')
  assert.equal(objectUrlCalls, 1, '同 hash 并发只允许一次真实 import')
  assert.equal(allPluginStyles().length, 1, '并发去重不得产生重复 style 标签')
  const nodeBefore = pluginStyle('p', 'index.tsx')
  const third = await loadPluginClientModule('p', 'index.tsx')
  assert.equal(objectUrlCalls, 1, '缓存命中不得重新 import')
  assert.equal(third.module, first.module)
  assert.equal(pluginStyle('p', 'index.tsx'), nodeBefore, '缓存命中不得拆除重建样式节点（不闪烁）')
  assert.equal(allPluginStyles().length, 1)
})

test('同入口换 hash 原位更新；无样式导出与空字符串均移除旧样式', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`${cssExport('.v1 { color: red }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p', 'index.tsx')
  const v1 = pluginStyle('p', 'index.tsx')
  assert.ok(v1)

  serveModule(`${cssExport('.v2 { color: blue }')}${PANEL_EXPORT}`, 'h2')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(allPluginStyles().length, 1, '换 hash 必须原位替换，不得累积标签')
  const v2 = pluginStyle('p', 'index.tsx')
  assert.equal(v2, v1, '同入口更新复用同一节点')
  assert.equal(v2.textContent, '.v2 { color: blue }')
  assert.equal(v2.getAttribute('data-helm-plugin-css-hash'), 'h2')

  serveModule(PANEL_EXPORT, 'h3')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(pluginStyle('p', 'index.tsx'), null, '新版无样式导出必须移除旧样式')

  serveModule(`${cssExport('.v4 { color: green }')}${PANEL_EXPORT}`, 'h4')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.v4 { color: green }')

  serveModule(`${cssExport('')}${PANEL_EXPORT}`, 'h5')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(pluginStyle('p', 'index.tsx'), null, '空字符串样式等同无样式，必须移除旧标签')
  assert.equal(allPluginStyles().length, 0)
})

test('停用仅回收目标插件样式；重新启用后同 hash 重新装载', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p', 'index.tsx')
  serveModule(`${cssExport('.b { color: blue }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p2', 'index.tsx')
  assert.equal(allPluginStyles().length, 2)

  evictPluginClientCache('p')
  assert.equal(pluginStyle('p', 'index.tsx'), null, '停用必须回收该插件样式')
  assert.ok(pluginStyle('p2', 'index.tsx'), '不得误删其他插件样式')
  assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined)

  serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.a { color: red }', '重新启用后样式恢复')

  resetPluginClientCache()
  assert.equal(allPluginStyles().length, 0, 'reset（登出/快照重建）必须回收全部插件样式')
})

test('确定性 gate：import 在途时停用或 reset，放行后显式失效且零样式残留', { timeout: 60_000 }, async () => {
  for (const [label, invalidate] of [
    ['停用', () => evictPluginClientCache('p')],
    ['reset', () => resetPluginClientCache()],
  ] as const) {
    installDataUrlModuleServing()
    serveModule(`${GATED}${cssExport('.late { color: red }')}${PANEL_EXPORT}`, 'h1')
    const pending = loadPluginClientModule('p', 'index.tsx')
    const resume = await waitForGate()
    invalidate()
    resume()
    await assertInvalidated(pending)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(allPluginStyles().length, 0, `${label}后迟到的模块完成不得补挂样式`)
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined, `${label}后不得填回缓存`)
  }
})

test('旧 epoch 在途 import 完成不得改写或重建新 epoch 已装载的样式', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  // 场景一：新 epoch 换新 hash 已装样式，旧 epoch 同入口迟到完成
  serveModule(`${GATED}${cssExport('.old { color: red }')}${PANEL_EXPORT}`, 'h1')
  const stale = loadPluginClientModule('p', 'index.tsx')
  const resumeStale = await waitForGate()
  evictPluginClientCache('p')
  serveModule(`${cssExport('.new { color: blue }')}${PANEL_EXPORT}`, 'h2')
  await loadPluginClientModule('p', 'index.tsx')
  const fresh = pluginStyle('p', 'index.tsx')
  assert.equal(fresh?.textContent, '.new { color: blue }')

  resumeStale()
  await assertInvalidated(stale)
  assert.equal(pluginStyle('p', 'index.tsx'), fresh, '旧 epoch 完成不得拆除新 epoch 的样式节点')
  assert.equal(fresh?.textContent, '.new { color: blue }', '旧 epoch 完成不得改写新 epoch 的样式文本')
  assert.equal(fresh?.getAttribute('data-helm-plugin-css-hash'), 'h2')
  assert.equal(allPluginStyles().length, 1)

  // 场景二：停用已回收样式后，同 hash 旧 import 迟到完成不得重新创建样式
  serveModule(`${GATED}${cssExport('.gone { color: red }')}${PANEL_EXPORT}`, 'h1')
  const stale2 = loadPluginClientModule('p', 'index.tsx')
  const resumeStale2 = await waitForGate()
  evictPluginClientCache('p')
  assert.equal(allPluginStyles().length, 0)
  resumeStale2()
  await assertInvalidated(stale2)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(allPluginStyles().length, 0, '失效旧 import 不得按同 hash 重新创建已回收的样式')
})

test('import 抛错不装样式；同 hash 修复后可重试并装载', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`throw new Error('模块求值失败')\n${cssExport('.never { color: red }')}`, 'same')
  await assert.rejects(
    loadPluginClientModule('p', 'index.tsx'),
    (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_import_failed' && err.message.includes('模块求值失败'),
  )
  assert.equal(allPluginStyles().length, 0, 'import 失败不得装载样式')

  serveModule(`${cssExport('.fixed { color: green }')}${PANEL_EXPORT}`, 'same')
  const retried = await loadPluginClientModule('p', 'index.tsx')
  assert.equal(retried.module.__helmClientCss, '.fixed { color: green }')
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.fixed { color: green }', '同 hash 重试成功后正常装载')
})

test('保留导出非字符串属非法契约：显式报错、不装样式、缓存可重试', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  serveModule(`export const __helmClientCss = 42\n${PANEL_EXPORT}`, 'h1')
  await assert.rejects(
    loadPluginClientModule('p', 'index.tsx'),
    (err: unknown) =>
      err instanceof PluginClientError && err.code === 'client_module_css_invalid' && err.message.includes('number'),
    '保留导出类型非法必须显式 PluginClientError，不得静默忽略',
  )
  assert.equal(allPluginStyles().length, 0)
  assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined, '非法 metadata 不得发布缓存')

  serveModule(`${cssExport('.ok { color: red }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p', 'index.tsx')
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.ok { color: red }')
})

test('requireClientExport 的可用导出清单隐藏保留 CSS 字段', { timeout: 60_000 }, () => {
  const module = { Panel() {}, __helmClientCss: '.a { color: red }' }
  assert.equal(requireClientExport('p', 'index.tsx', 'Panel', module), module.Panel)
  assert.throws(
    () => requireClientExport('p', 'index.tsx', 'Missing', module),
    (err: unknown) => err instanceof PluginClientError && err.message.includes('Panel') && !err.message.includes('__helmClientCss'),
  )
})

test('seedPluginClientModule 遵循同一样式契约：装载、按新种子更新、非法类型显式报错', { timeout: 60_000 }, () => {
  const panel = () => null
  seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmClientCss: '.seed1 { color: red }' })
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.seed1 { color: red }')
  assert.equal(pluginStyle('p', 'index.tsx')?.getAttribute('data-helm-plugin-css-hash'), 'seeded')
  const node = pluginStyle('p', 'index.tsx')
  seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmClientCss: '.reseeded { color: green }' })
  assert.equal(pluginStyle('p', 'index.tsx'), node, '默认 seeded hash 相同也应按新命名空间原位更新')
  assert.equal(node?.textContent, '.reseeded { color: green }')

  // 无样式导出的新种子移除旧样式
  seedPluginClientModule('p', 'index.tsx', { Panel: panel }, 'seed2')
  assert.equal(pluginStyle('p', 'index.tsx'), null)

  seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmClientCss: '.seed3 { color: blue }' }, 'seed3')
  assert.equal(pluginStyle('p', 'index.tsx')?.textContent, '.seed3 { color: blue }')

  assert.throws(
    () => seedPluginClientModule('p', 'other.tsx', { Panel: panel, __helmClientCss: [] }),
    (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_css_invalid' && err.message.includes('object'),
  )
  assert.equal(getCachedClientComponent('p', 'other.tsx', 'Panel'), undefined, '非法 seed 不得写入缓存')
})

test('SSR 无 document：合法跳过样式注入且不报错，缓存照常发布', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  assert.ok(descriptor?.configurable, '测试前提：document 属性可配置')
  try {
    delete (globalThis as { document?: Document }).document
    serveModule(`${cssExport('.ssr { color: red }')}${PANEL_EXPORT}`, 'h1')
    const loaded = await loadPluginClientModule('p', 'index.tsx')
    assert.equal(loaded.module.__helmClientCss, '.ssr { color: red }')
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), loaded.module.Panel, 'SSR 下 resolved 照常发布')
    seedPluginClientModule('q', 'index.tsx', { Panel: () => null, __helmClientCss: '.q { color: red }' })
    serveModule(`export const __helmClientCss = 42\n${PANEL_EXPORT}`, 'invalid-ssr')
    await assert.rejects(
      loadPluginClientModule('bad-ssr', 'index.tsx'),
      (error: unknown) => error instanceof PluginClientError && error.code === 'client_module_css_invalid',
      'SSR 只跳过 DOM 写入，不能跳过产物契约校验',
    )
    assert.equal(getCachedClientComponent('bad-ssr', 'index.tsx', 'Panel'), undefined)
    assert.throws(
      () => seedPluginClientModule('bad-seed', 'index.tsx', { Panel: () => null, __helmClientCss: 42 }),
      (error: unknown) => error instanceof PluginClientError && error.code === 'client_module_css_invalid',
    )
  } finally {
    Object.defineProperty(globalThis, 'document', descriptor!)
  }
  assert.equal(allPluginStyles().length, 0, 'SSR 期间不得注入任何样式节点')
})

test('缓存失效通知：仅 evict/reset 触发，正常 load/seed 不通知；revision 稳定且只随失效变化', { timeout: 60_000 }, async () => {
  installDataUrlModuleServing()
  const notified: string[] = []
  const unsubscribe = subscribePluginClientCacheInvalidation(() => notified.push('tick'))
  const revisionBefore = getPluginClientCacheRevision('p')
  assert.equal(getPluginClientCacheRevision('p'), revisionBefore, '无失效时 revision 必须稳定（同值快照）')

  serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
  await loadPluginClientModule('p', 'index.tsx')
  seedPluginClientModule('q', 'index.tsx', { Panel: () => null })
  assert.deepEqual(notified, [], '正常 load/seed 不得触发失效通知（避免循环）')
  assert.equal(getPluginClientCacheRevision('p'), revisionBefore)

  evictPluginClientCache('p')
  assert.equal(notified.length, 1, '停用后必须通知')
  assert.notEqual(getPluginClientCacheRevision('p'), revisionBefore, '目标插件 revision 必须变化')
  const qRevisionBefore = getPluginClientCacheRevision('q')
  assert.equal(getPluginClientCacheRevision('q'), qRevisionBefore, '未停用插件的 revision 不变')

  resetPluginClientCache()
  assert.equal(notified.length, 2, 'reset 后必须通知')
  assert.notEqual(getPluginClientCacheRevision('q'), qRevisionBefore, 'reset 推进全局 cacheEpoch')

  unsubscribe()
  evictPluginClientCache('p')
  assert.equal(notified.length, 2, '退订后不得再收到通知')
})
