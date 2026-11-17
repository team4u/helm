import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { compilePluginClientModule } from '@helm/plugin-build'
import { PluginUiView } from '../src/ui/PluginUiView.js'
import {
  getCachedClientComponent,
  getPluginClientCacheRevision,
  seedPluginClientModule,
  evictPluginClientCache,
  reconcilePluginClientCache,
  resetPluginClientCache,
  loadPluginClientModule,
  subscribePluginClientCacheInvalidation,
  PluginClientError,
} from '../src/lib/plugin-client.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { mountSharedPluginNamespaces } from './helpers/builtin-clients.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
mountSharedPluginNamespaces({ realHooks: true })
const e = React.createElement
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; resetPluginClientCache() })

test('同步缓存按 plugin/module/export 隔离，组件复用时不在新上下文渲染旧导出', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-client-identity-'))
  const renders: string[] = []
  Object.assign(globalThis, { __clientTestRenders: renders })
  const compile = async (pluginId: string, moduleRef: string, marker: string) => {
    const root = join(dir, marker)
    await mkdir(root)
    await writeFile(join(root, moduleRef), `
      import { usePluginContext } from '@helm/plugin-client'
      export function First() { const ctx = usePluginContext(); globalThis.__clientTestRenders.push(ctx.pluginId + ':${marker}:first'); return <div>${marker}:first</div> }
      export function Second() { const ctx = usePluginContext(); globalThis.__clientTestRenders.push(ctx.pluginId + ':${marker}:second'); return <div>${marker}:second</div> }
    `)
    const { code, contentHash } = await compilePluginClientModule(pluginId, root, moduleRef, dir)
    const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as Record<string, unknown>
    seedPluginClientModule(pluginId, moduleRef, mod, contentHash)
    return contentHash
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    const hashes = new Map([
      ['/api/plugins/alpha/client.mjs?module=index.tsx', await compile('alpha', 'index.tsx', 'a')],
      ['/api/plugins/alpha/client.mjs?module=other.tsx', await compile('alpha', 'other.tsx', 'b')],
      ['/api/plugins/beta/client.mjs?module=index.tsx', await compile('beta', 'index.tsx', 'c')],
    ])
    globalThis.fetch = async (url) => {
      const hash = hashes.get(String(url))
      assert.ok(hash, `意外下载：${String(url)}`)
      return new Response('', { headers: { 'x-helm-client-hash': hash } })
    }
    const store = makeTestStore()
    for (const [pluginId, module, name, expected] of [
      ['alpha', 'index.tsx', 'First', 'alpha:a:first'],
      ['alpha', 'index.tsx', 'Second', 'alpha:a:second'],
      ['alpha', 'other.tsx', 'First', 'alpha:b:first'],
      ['beta', 'index.tsx', 'First', 'beta:c:first'],
    ] as const) {
      renders.length = 0
      await act(async () => root.render(e(HostStoreProviders, { value: store },
        e(PluginUiView, { pluginId, spec: { client: { module, export: name } } }))))
      assert.ok(renders.length > 0)
      assert.ok(renders.every((value) => value === expected), `不能短暂渲染旧身份：${renders.join(', ')}`)
      assert.ok(!host.textContent?.includes('正在加载'), '同步缓存命中不得闪回 loading')
    }
    assert.equal(getCachedClientComponent('missing', 'index.tsx', 'First'), undefined)
    assert.equal(getCachedClientComponent('alpha', 'index.tsx', 'Missing'), undefined)
    assert.equal(getCachedClientComponent('alpha', 'absent.tsx', 'First'), undefined)
    renders.length = 0
    await act(async () => root.render(e(HostStoreProviders, { value: store },
      e(PluginUiView, { pluginId: 'beta', spec: { client: { module: 'index.tsx', export: 'Missing' } } }))))
    assert.match(host.textContent!, /has no export Missing/)
    assert.deepEqual(renders, [], '缺失导出不能误用同模块的上一个缓存组件')
    globalThis.fetch = async () => new Response('服务不可用', { status: 503 })
    await act(async () => root.render(e(HostStoreProviders, { value: store },
      e(PluginUiView, { pluginId: 'beta', spec: { client: { module: 'index.tsx', export: 'Second' } } }))))
    assert.match(host.textContent!, /HTTP 503/)
    globalThis.fetch = async () => new Response('', { headers: { 'x-helm-client-hash': hashes.get('/api/plugins/beta/client.mjs?module=index.tsx')! } })
    await act(async () => { (host.querySelector('button') as HTMLElement).click() })
    assert.match(host.textContent!, /c:second/)
    assert.doesNotMatch(host.textContent!, /加载失败/)
  } finally {
    await act(async () => root.unmount())
    delete (globalThis as Record<string, unknown>).__clientTestRenders
    await rm(dir, { recursive: true, force: true })
  }
})

test('停用仅清目标插件缓存，不误清具有相似 ID 的插件；重新挂载不能复用旧组件', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-client-evict-'))
  try {
    await writeFile(join(dir, 'index.tsx'), 'export function Panel() { return <div>有效组件</div> }')
    const { code } = await compilePluginClientModule('p', dir, 'index.tsx', join(dir, 'cache'))
    const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as Record<string, unknown>
    seedPluginClientModule('p', 'index.tsx', mod)
    seedPluginClientModule('p::nested', 'index.tsx', mod)
    evictPluginClientCache('p')
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined)
    assert.equal(getCachedClientComponent('p::nested', 'index.tsx', 'Panel'), mod.Panel)
    resetPluginClientCache()
    assert.equal(getCachedClientComponent('p::nested', 'index.tsx', 'Panel'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('停用或重建快照后，在途下载不得重新填回插件缓存', { timeout: 60_000 }, async () => {
  for (const invalidate of [() => evictPluginClientCache('p'), resetPluginClientCache]) {
    let respond!: (response: Response) => void
    globalThis.fetch = async () => await new Promise<Response>((resolve) => { respond = resolve })
    const pending = loadPluginClientModule('p', 'index.tsx')
    invalidate()
    respond(new Response('export function Panel() {}', { headers: { 'x-helm-client-hash': 'late' } }))
    await assert.rejects(pending, (error) => error instanceof PluginClientError && error.code === 'client_module_invalidated')
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined)
  }
})

test('模块导入失败显式报错且不毒化同 hash 的重试', { timeout: 60_000 }, async () => {
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  let attempts = 0
  globalThis.fetch = async () => new Response('throw new Error("真实模块求值失败")', { headers: { 'x-helm-client-hash': 'same' } })
  URL.createObjectURL = () => { attempts++; return 'data:text/javascript,throw%20new%20Error(%22真实模块求值失败%22)' }
  URL.revokeObjectURL = () => {}
  try {
    for (let n = 0; n < 2; n++) {
      await assert.rejects(loadPluginClientModule('p', 'index.tsx'), (error) =>
        error instanceof PluginClientError && error.code === 'client_module_import_failed' && error.message.includes('真实模块求值失败'))
    }
    assert.equal(attempts, 2, '失败后必须允许重新 import，而非复用 rejected Promise')
  } finally {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
})

test('插件样式随停用/登出回收：仅移除目标插件注入的 style，不误删其他插件', { timeout: 60_000 }, async () => {
  const addSheet = (key: string, pluginId: string): HTMLStyleElement => {
    const style = document.createElement('style')
    style.dataset.helmPluginCss = key
    style.dataset.helmPluginCssPlugin = pluginId
    style.textContent = `.${key} { color: red }`
    document.head.appendChild(style)
    return style
  }
  const alpha = addSheet('alpha::index.tsx', 'alpha')
  const alphaTwin = addSheet('alpha::other.tsx', 'alpha')
  const alphaLike = addSheet('alpha2::index.tsx', 'alpha2')
  evictPluginClientCache('alpha')
  assert.equal(alpha.isConnected, false)
  assert.equal(alphaTwin.isConnected, false)
  assert.equal(alphaLike.isConnected, true, '相似 ID 的插件样式不得误删')
  resetPluginClientCache()
  assert.equal(alphaLike.isConnected, false, '登出/全量重建必须回收全部插件样式')
})

test('并发加载同一插件模块合并为单次 fetch（in-flight 复用）', { timeout: 60_000 }, async () => {
  let fetchCount = 0
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'data:text/javascript,export%20function%20Test()%20{}'
  URL.revokeObjectURL = () => {}
  globalThis.fetch = async () => {
    fetchCount++
    await new Promise((r) => setTimeout(r, 10))
    return new Response('export function Test() {}', { headers: { 'x-helm-client-hash': 'hash-shared' } })
  }
  try {
    const [a, b, c] = await Promise.all([
      loadPluginClientModule('p-concurrent', 'index.tsx'),
      loadPluginClientModule('p-concurrent', 'index.tsx'),
      loadPluginClientModule('p-concurrent', 'index.tsx'),
    ])
    assert.equal(fetchCount, 1, '同屏多个图表/组件并发挂载时必须合并为 1 次 HTTP 请求')
    assert.equal(a.contentHash, 'hash-shared')
    assert.equal(b.contentHash, 'hash-shared')
    assert.equal(c.contentHash, 'hash-shared')
  } finally {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
})

test('O(1) expectedHash 内存命中零 fetch；缺失时请求携带 &hash=，409 或 hash 不匹配显式逐出不写脏缓存', { timeout: 60_000 }, async () => {
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  const urls: string[] = []
  let seq = 0
  URL.createObjectURL = () => `data:text/javascript,export%20const%20__helmClientCss%3D%22.h%7Bcolor%3Ared%7D%22%3Bexport%20function%20Panel()%7Breturn%20null%7D#${++seq}`
  URL.revokeObjectURL = () => {}
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('hash=h-ok')) {
      return new Response('export function Panel() {}', { headers: { 'x-helm-client-hash': 'h-ok' } })
    }
    if (url.includes('hash=h-409')) {
      return new Response(JSON.stringify({ error: { code: 'client_module_stale', message: 'module hash stale' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('hash=h-mismatch')) {
      return new Response('export function Panel() {}', { headers: { 'x-helm-client-hash': 'h-old' } })
    }
    return new Response('not found', { status: 404 })
  }
  try {
    const loaded = await loadPluginClientModule('p-hash', 'index.tsx', 'h-ok')
    assert.equal(loaded.contentHash, 'h-ok')
    assert.equal(urls.length, 1)
    assert.ok(urls[0]!.endsWith('module=index.tsx&hash=h-ok'), `URL 应携带 &hash=：${urls[0]}`)

    // 同 expectedHash 再次加载：直接命中内存缓存，0 fetch
    const hit = await loadPluginClientModule('p-hash', 'index.tsx', 'h-ok')
    assert.equal(hit.module, loaded.module)
    assert.equal(urls.length, 1, '命中 expectedHash 不得发起任何网络请求')

    // 409 client_module_stale：显式逐出旧缓存与样式并抛错
    await assert.rejects(
      loadPluginClientModule('p-hash', 'index.tsx', 'h-409'),
      (err) => err instanceof PluginClientError && err.code === 'client_module_stale' && err.status === 409,
    )
    assert.equal(getCachedClientComponent('p-hash', 'index.tsx', 'Panel'), undefined, '409 后旧缓存必须被逐出')
    assert.ok(document.querySelector('style[data-helm-plugin-css="p-hash::index.tsx"]') === null, '409 后旧样式必须移除')

    // 重新种子缓存后遇到响应 x-helm-client-hash 不匹配：逐出缓存、不把陈旧模块按 expectedHash 写入
    seedPluginClientModule('p-hash', 'index.tsx', { Panel: () => null, __helmClientCss: '.old{}' }, 'h-seed')
    await assert.rejects(
      loadPluginClientModule('p-hash', 'index.tsx', 'h-mismatch'),
      (err) => err instanceof PluginClientError && err.code === 'client_module_stale',
    )
    assert.equal(getCachedClientComponent('p-hash', 'index.tsx', 'Panel'), undefined)
    assert.ok(document.querySelector('style[data-helm-plugin-css="p-hash::index.tsx"]') === null)
  } finally {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
})

test('不同 expectedHash 在途请求竞争：新 hash 独立拉取并淘汰旧在途，绝不互相污染', { timeout: 60_000 }, async () => {
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  const urls: string[] = []
  let resolveOldFetch!: (res: Response) => void
  URL.createObjectURL = ((blob: Blob) => {
    const marker = urls.length
    return blob.size > 30
      ? `data:text/javascript,export%20const%20v%3D%22v2%22%3Bexport%20const%20__helmClientCss%3D%22.v2%7Bcolor%3Ablue%7D%22%3Bexport%20function%20Panel()%7Breturn%20%22v2%22%7D#${marker}`
      : `data:text/javascript,export%20const%20v%3D%22v1%22%3Bexport%20const%20__helmClientCss%3D%22.v1%7Bcolor%3Ared%7D%22%3Bexport%20function%20Panel()%7Breturn%20%22v1%22%7D#${marker}`
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = () => {}
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('hash=h1')) {
      return await new Promise<Response>((resolve) => { resolveOldFetch = resolve })
    }
    return new Response('export const v = "v2"; export function Panel() { return "v2" } // padded-for-v2', {
      headers: { 'x-helm-client-hash': 'h2' },
    })
  }
  try {
    const p1 = loadPluginClientModule('p-race', 'index.tsx', 'h1')
    const p2 = loadPluginClientModule('p-race', 'index.tsx', 'h2')
    assert.equal(urls.length, 2, '不同 expectedHash 不得复用旧在途 Promise')
    const r2 = await p2
    assert.equal(r2.contentHash, 'h2')
    assert.equal(r2.module.v, 'v2')

    // 旧请求迟到返回 h1：必须失效，不得覆盖 h2 缓存与样式
    resolveOldFetch(new Response('export const v = "v1"', { headers: { 'x-helm-client-hash': 'h1' } }))
    await assert.rejects(p1, (err) => err instanceof PluginClientError && err.code === 'client_module_invalidated')
    const hit = await loadPluginClientModule('p-race', 'index.tsx', 'h2')
    assert.equal(hit.module.v, 'v2')
    assert.equal(document.querySelector('style[data-helm-plugin-css="p-race::index.tsx"]')?.getAttribute('data-helm-plugin-css-hash'), 'h2')
  } finally {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
})

test('reconcilePluginClientCache 增量对账：保留未变更启用插件，逐出停用/变更项并精确通知', { timeout: 60_000 }, async () => {
  const PanelA = () => null
  const PanelB = () => null
  const PanelC = () => null
  seedPluginClientModule('keep-p', 'index.tsx', { Panel: PanelA, __helmClientCss: '.keep{}' }, 'hash-keep')
  seedPluginClientModule('change-p', 'index.tsx', { Panel: PanelB, __helmClientCss: '.chg{}' }, 'hash-old')
  seedPluginClientModule('disable-p', 'index.tsx', { Panel: PanelC, __helmClientCss: '.dis{}' }, 'hash-dis')

  let notifications = 0
  const unsub = subscribePluginClientCacheInvalidation(() => { notifications++ })
  const revKeep0 = getPluginClientCacheRevision('keep-p')
  const revChange0 = getPluginClientCacheRevision('change-p')
  const revDisable0 = getPluginClientCacheRevision('disable-p')

  try {
    // 1. 全部匹配且启用：0 逐出，不递增 revision，不通知
    const zero = reconcilePluginClientCache([
      { id: 'keep-p', name: 'K', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'hash-keep' } },
      { id: 'change-p', name: 'C', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'hash-old' } },
      { id: 'disable-p', name: 'D', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'hash-dis' } },
    ])
    assert.equal(zero, 0)
    assert.equal(notifications, 0)
    assert.equal(getPluginClientCacheRevision('keep-p'), revKeep0)

    // 2. keep-p 不变，change-p 换 hash，disable-p 停用：仅逐出后两者
    const evicted = reconcilePluginClientCache([
      { id: 'keep-p', name: 'K', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'hash-keep' } },
      { id: 'change-p', name: 'C', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'hash-new' } },
      { id: 'disable-p', name: 'D', locked: false, enabled: false, status: 'disabled', hooks: [], actions: [], tools: [] },
    ])
    assert.equal(evicted, 2)
    assert.equal(notifications, 1)
    assert.equal(getPluginClientCacheRevision('keep-p'), revKeep0, '未变更插件 revision 不变')
    assert.notEqual(getPluginClientCacheRevision('change-p'), revChange0)
    assert.notEqual(getPluginClientCacheRevision('disable-p'), revDisable0)
    assert.equal(getCachedClientComponent('keep-p', 'index.tsx', 'Panel', 'hash-keep'), PanelA)
    assert.ok(document.querySelector('style[data-helm-plugin-css="keep-p::index.tsx"]') !== null)
    assert.equal(getCachedClientComponent('change-p', 'index.tsx', 'Panel'), undefined)
    assert.equal(getCachedClientComponent('disable-p', 'index.tsx', 'Panel'), undefined)
    assert.ok(document.querySelector('style[data-helm-plugin-css="change-p::index.tsx"]') === null)
    assert.ok(document.querySelector('style[data-helm-plugin-css="disable-p::index.tsx"]') === null)
  } finally {
    unsub()
  }
})

test('PluginUiView 从 store.plugins 读取 clientHashes 传入 loader，切页重挂载零 fetch', { timeout: 60_000 }, async () => {
  let fetches = 0
  const Panel = () => React.createElement('div', null, 'cached-ui-panel')
  seedPluginClientModule('ui-hash-p', 'index.tsx', { Panel }, 'hash-ui-1')
  globalThis.fetch = async () => {
    fetches++
    return new Response('', { status: 500 })
  }
  const store = makeTestStore({
    plugins: [{
      id: 'ui-hash-p',
      name: 'UI Hash P',
      locked: false,
      enabled: true,
      status: 'active',
      hooks: [],
      actions: [],
      tools: [],
      clientHashes: { 'index.tsx': 'hash-ui-1' },
    }],
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(e(HostStoreProviders, { value: store },
      e(PluginUiView, { pluginId: 'ui-hash-p', spec: { client: { module: 'index.tsx', export: 'Panel' } } }))))
    assert.equal(host.textContent, 'cached-ui-panel')
    // 卸载再重新挂载（模拟切换页面/会话）：依然零 fetch
    await act(async () => root.render(e(HostStoreProviders, { value: store }, null)))
    await act(async () => root.render(e(HostStoreProviders, { value: store },
      e(PluginUiView, { pluginId: 'ui-hash-p', spec: { client: { module: 'index.tsx', export: 'Panel' } } }))))
    assert.equal(host.textContent, 'cached-ui-panel')
    assert.equal(fetches, 0, 'expectedHash 命中内存缓存时重挂载绝不发网络请求')
  } finally {
    await act(async () => root.unmount())
  }
})
