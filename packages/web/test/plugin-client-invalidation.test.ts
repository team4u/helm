import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { evictPluginClientCache, resetPluginClientCache } from '../src/lib/plugin-client.js'
import { PluginUiView } from '../src/ui/PluginUiView.js'
import { makeTestStore } from './helpers/store.js'
import { mountSharedPluginNamespaces } from './helpers/workflow-client.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
mountSharedPluginNamespaces({ realHooks: true })

test('已挂载插件视图在快照重建后重载模块与样式，无关插件失效不重建视图', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-client-snapshot-'))
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const globals = globalThis as Record<string, unknown>
  globals.__helmCssViewGeneration = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await writeFile(join(dir, 'base.css'), '.revision-card { color: #cc0000; border: 1px solid #007700; }')
    await writeFile(join(dir, 'styles.css'), '.revision-card { color: #008800; }')
    await writeFile(join(dir, 'index.tsx'), `
      import { useState } from 'react'
      import './base.css'
      import './styles.css'
      export function Panel() {
        const [generation] = useState(() => ++globalThis.__helmCssViewGeneration)
        return <div className="revision-card" data-generation={generation}>持续挂载的插件视图</div>
      }
    `)
    const { code, contentHash } = await compilePluginClientModule('snapshot-plugin', dir, 'index.tsx', join(dir, 'cache'))
    let fetches = 0
    let imports = 0
    let onImport: ((url: string) => void) | undefined
    globalThis.fetch = async () => {
      fetches++
      return new Response(code, { headers: { 'x-helm-client-hash': contentHash } })
    }
    URL.createObjectURL = () => {
      const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#snapshot-${++imports}`
      assert.ok(onImport, '每次模块重载都必须对应预期的缓存失效')
      onImport(url)
      onImport = undefined
      return url
    }
    URL.revokeObjectURL = () => {}

    const reload = async (change: () => void) => {
      const started = new Promise<string>((resolve) => { onImport = resolve })
      await act(async () => { change() })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const url = await Promise.race([
          started,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('缓存失效后已挂载视图未重新加载模块')), 5_000) }),
        ])
        // 等待同一个原生 ESM 求值，而不额外调用 loader 掩盖视图未重载的问题。
        await act(async () => { await import(url) })
      } finally {
        if (timer) clearTimeout(timer)
      }
      assert.equal(host.querySelector('.revision-card')?.textContent, '持续挂载的插件视图')
      assert.equal(document.querySelectorAll('style[data-helm-plugin-css]').length, 1)
      const card = host.querySelector('.revision-card')!
      assert.equal(getComputedStyle(card).borderTopWidth, '1px', '第一份 CSS 必须保留并随视图恢复')
      const reference = document.createElement('span')
      reference.style.color = '#008800'
      document.body.appendChild(reference)
      try {
        assert.equal(getComputedStyle(card).color, getComputedStyle(reference).color, '第二份 CSS 必须按导入顺序覆盖同名规则')
      } finally {
        reference.remove()
      }
    }

    await reload(() => root.render(React.createElement(HelmStoreContext.Provider, { value: makeTestStore() },
      React.createElement(PluginUiView, { pluginId: 'snapshot-plugin', spec: { client: { module: 'index.tsx', export: 'Panel' } } }))))
    assert.equal(host.querySelector('.revision-card')?.getAttribute('data-generation'), '1')
    await act(async () => { evictPluginClientCache('another-plugin') })
    assert.equal(host.querySelector('.revision-card')?.getAttribute('data-generation'), '1', '其他插件失效不能丢失本视图局部状态')
    assert.equal(fetches, 1)

    await reload(resetPluginClientCache)
    assert.equal(host.querySelector('.revision-card')?.getAttribute('data-generation'), '2', '快照重建不能继续使用旧组件实例')
    await reload(() => evictPluginClientCache('snapshot-plugin'))
    assert.equal(host.querySelector('.revision-card')?.getAttribute('data-generation'), '3')
    assert.equal(fetches, 3)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    resetPluginClientCache()
    host.remove()
    delete globals.__helmCssViewGeneration
    await rm(dir, { recursive: true, force: true })
  }
})
