import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { PluginUiView } from '../src/ui/PluginUiView.js'
import { getCachedClientComponent, seedPluginClientModule, evictPluginClientCache, resetPluginClientCache, loadPluginClientModule, PluginClientError } from '../src/lib/plugin-client.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'
import { mountSharedPluginNamespaces } from './helpers/workflow-client.js'

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
      await act(async () => root.render(e(HelmStoreContext.Provider, { value: store },
        e(PluginUiView, { pluginId, spec: { client: { module, export: name } } }))))
      assert.ok(renders.length > 0)
      assert.ok(renders.every((value) => value === expected), `不能短暂渲染旧身份：${renders.join(', ')}`)
      assert.ok(!host.textContent?.includes('正在加载'), '同步缓存命中不得闪回 loading')
    }
    assert.equal(getCachedClientComponent('missing', 'index.tsx', 'First'), undefined)
    assert.equal(getCachedClientComponent('alpha', 'index.tsx', 'Missing'), undefined)
    assert.equal(getCachedClientComponent('alpha', 'absent.tsx', 'First'), undefined)
    renders.length = 0
    await act(async () => root.render(e(HelmStoreContext.Provider, { value: store },
      e(PluginUiView, { pluginId: 'beta', spec: { client: { module: 'index.tsx', export: 'Missing' } } }))))
    assert.match(host.textContent!, /不存在导出 Missing/)
    assert.deepEqual(renders, [], '缺失导出不能误用同模块的上一个缓存组件')
    globalThis.fetch = async () => new Response('服务不可用', { status: 503 })
    await act(async () => root.render(e(HelmStoreContext.Provider, { value: store },
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
