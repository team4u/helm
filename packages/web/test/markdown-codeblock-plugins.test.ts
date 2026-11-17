/**
 * markdown.codeBlock 扩展机制集成测试（真实编译 + 真实运行）：
 * - 纯函数裁决：语言匹配 / priority 降序稳定 / 无命中返回 null（enable-disable 语义）；
 * - CodeBlockRenderer：无插件命中回退宿主普通代码块；命中后经真实
 *   compilePluginClientModule 加载插件组件渲染（json-render 合法 JSON 卡片、
 *   非法 JSON 回退源码）；
 * - builtin:json-render / builtin:mermaid clientRoot 经真实编译器产出可运行模块
 *  （含依赖闭包、共享 shim 与受控 npm bundle 边界）；
 * - 加载失败显式诊断 + 源码可复制（诚实性纪律）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginUiContribution } from '@helm/protocol'
import * as HelmPluginClient from '@helm/plugin-client'
import { compilePluginClientModule, safeDirName, safeFileName } from '@helm/plugin-build'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const e = React.createElement
const here = dirname(fileURLToPath(import.meta.url))

// 宿主共享命名空间（与浏览器一致；mermaid bundle 不依赖共享 mermaid——已自带）
;(globalThis as Record<string, unknown>).__helm_shared_react = React
;(globalThis as Record<string, unknown>).__helm_shared_react_jsx_runtime = await import('react/jsx-runtime')
;(globalThis as Record<string, unknown>).__helm_shared_react_dom = await import('react-dom')
;(globalThis as Record<string, unknown>).__helm_shared_react_dom_client = await import('react-dom/client')
;(globalThis as Record<string, unknown>).__helm_shared_lucide_react = await import('lucide-react')
;(globalThis as Record<string, unknown>).__helm_shared_plugin_client = HelmPluginClient

const { matchMarkdownCodeBlock } = await import('../src/conversation/codeblock-registry-model.js')
const { CodeBlockRenderer } = await import('../src/conversation/CodeBlockRenderer.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')

const JSON_RENDER_ROOT = resolve(here, '../../plugins/src/json-render/client')
const MERMAID_ROOT = resolve(here, '../../plugins/src/mermaid/client')
const PLUGINS_ROOT = resolve(here, '../../plugins')
const CACHE = fileURLToPath(new URL('../../../node_modules/.cache/helm-test-plugin-clients', import.meta.url))
mkdirSync(CACHE, { recursive: true })

// ---------------------------------------------------------------------------
// 1. 纯函数裁决
// ---------------------------------------------------------------------------

const cbContribution = (pluginId: string, id: string, languages: string[], extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId,
  surface: 'markdown.codeBlock',
  spec: { id, languages, ...extra },
})

test('matchMarkdownCodeBlock：语言精确匹配、大小写归一、未命中返回 null', { timeout: 60_000 }, () => {
  const contributions = [cbContribution('builtin:json-render', 'json-cards', ['ui', 'json-render'])]
  assert.ok(matchMarkdownCodeBlock(contributions, 'ui') !== null)
  assert.ok(matchMarkdownCodeBlock(contributions, 'JSON-RENDER'.toLowerCase()) !== null)
  assert.equal(matchMarkdownCodeBlock(contributions, 'mermaid'), null, '未声明语言不命中')
  assert.equal(matchMarkdownCodeBlock(contributions, 'uix'), null, '不做前缀/子串匹配')
  assert.equal(matchMarkdownCodeBlock([], 'ui'), null, '无贡献（停用后）不命中')
})

test('matchMarkdownCodeBlock：priority 降序稳定裁决（同分保持贡献顺序）', { timeout: 60_000 }, () => {
  const contributions = [
    cbContribution('p1', 'a', ['ui']),
    cbContribution('p2', 'b', ['ui'], { priority: 10 }),
    cbContribution('p3', 'c', ['ui'], { priority: 10 }),
    cbContribution('p4', 'd', ['ui'], { priority: -1 }),
  ]
  assert.equal(matchMarkdownCodeBlock(contributions, 'ui')!.spec.id, 'b', '高优先级在前；同分取贡献顺序在先者')
})

test('enable/disable 语义：贡献移除后同语言回退 null（不按插件 ID 硬编码）', { timeout: 60_000 }, () => {
  const withPlugin = [cbContribution('builtin:json-render', 'json-cards', ['ui'])]
  const afterDisable: PluginUiContribution[] = []
  assert.ok(matchMarkdownCodeBlock(withPlugin, 'ui') !== null)
  assert.equal(matchMarkdownCodeBlock(afterDisable, 'ui'), null)
})

// ---------------------------------------------------------------------------
// 2. 宿主回退：无插件命中渲染普通代码块
// ---------------------------------------------------------------------------

test('CodeBlockRenderer：无命中回退宿主普通代码块（语言标签 + 源码全文）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(
      HostStoreProviders, { value: store },
      e(CodeBlockRenderer, { language: 'python', code: 'print("hi")' }),
    ))
  })
  assert.match(host.textContent ?? '', /python/)
  assert.match(host.textContent ?? '', /print\("hi"\)/)
  act(() => { root!.unmount() })
})

// ---------------------------------------------------------------------------
// 3. 真实编译：json-render / mermaid clientRoot 产物可运行
// ---------------------------------------------------------------------------

async function importCompiled(root: string, pluginId: string, npmRoots?: Array<{ specifiers: string[]; packageRoot: string }>): Promise<Record<string, unknown>> {
  const { code } = await compilePluginClientModule(pluginId, root, 'index.tsx', CACHE, npmRoots ? { npmRoots } : undefined)
  return await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`) as Record<string, unknown>
}

test('json-render client 真实编译：模块可导入且导出 JsonRenderCodeBlock 组件与插件样式', { timeout: 60_000 }, async () => {
  const mod = await importCompiled(JSON_RENDER_ROOT, 'builtin:json-render')
  assert.equal(typeof mod['JsonRenderCodeBlock'], 'function', 'JsonRenderCodeBlock 导出为组件函数')
  assert.equal(typeof mod['__helmClientCss'], 'string', '__helmClientCss 导出为 string')
  assert.ok((mod['__helmClientCss'] as string).includes('.jr-card'), '必须包含 .jr-card 样式')
  assert.ok((mod['__helmClientCss'] as string).includes('.jr-metric-grid'), '必须包含 .jr-metric-grid 样式')
})

test('mermaid client 真实编译（受控 npm bundle）：模块可导入且不依赖宿主 mermaid 全局', { timeout: 120_000 }, async () => {
  // 不挂载 __helm_shared_mermaid：mermaid 经插件受控 npm 依赖自带，宿主零绑定
  ;(globalThis as Record<string, unknown>).__helm_shared_mermaid = undefined
  const mod = await importCompiled(MERMAID_ROOT, 'builtin:mermaid', [
    { specifiers: ['mermaid'], packageRoot: PLUGINS_ROOT },
  ])
  assert.equal(typeof mod['MermaidCodeBlock'], 'function', 'MermaidCodeBlock 导出为组件函数')
})

test('mermaid 编译器边界：未声明 npm 说明符显式拒绝（不留旁门）', { timeout: 120_000 }, async () => {
  const { HelmError } = await import('@helm/protocol')
  // 直接以空 npmRoots 编译 mermaid client：import 'mermaid' 必须被拒绝
  await assert.rejects(
    compilePluginClientModule('builtin:mermaid', MERMAID_ROOT, 'index.tsx', CACHE),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      assert.match(msg, /拒绝裸依赖 "mermaid"|mermaid/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 4. json-render 运行：合法 JSON 卡片 / 非法 JSON 回退源码 / 流式截断不伪报成功
// ---------------------------------------------------------------------------

function renderBlock(contributions: PluginUiContribution[], language: string, code: string): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = makeTestStore({
    uiContributions: contributions,
  })
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(
      HostStoreProviders, { value: store },
      e(CodeBlockRenderer, { language, code, conversationId: 1 }),
    ))
  })
  return Promise.resolve({ host, unmount: () => act(() => { root!.unmount() }) })
}

const jsonContribs = [cbContribution('builtin:json-render', 'json-cards', ['ui', 'json-render'], {
  client: { module: 'index.tsx', export: 'JsonRenderCodeBlock' },
})]

test('CodeBlockRenderer + json-render：合法 JSON 渲染卡片（真实编译产物 + ViewBoundary）', { timeout: 120_000 }, async () => {
  const mod = await importCompiled(JSON_RENDER_ROOT, 'builtin:json-render')
  seedPluginClientModule('builtin:json-render', 'index.tsx', mod)
  const spec = JSON.stringify({ component: 'Card', title: '指标', children: [
    { component: 'MetricGrid', cols: 2, children: [
      { component: 'MetricCard', label: '在线', value: '3', tone: 'ok' },
      { component: 'MetricCard', label: '离线', value: '1', tone: 'err' },
    ] },
    { component: 'Text', text: 'hello-spec' },
  ] })
  const { host, unmount } = await renderBlock(jsonContribs, 'ui', spec)
  const text = host.textContent ?? ''
  assert.match(text, /指标/)
  assert.match(text, /hello-spec/)
  assert.match(text, /在线/)
  unmount()
})

test('CodeBlockRenderer + json-render：非法 JSON 诚实回退源码（不伪报成功）', { timeout: 120_000 }, async () => {
  const mod = await importCompiled(JSON_RENDER_ROOT, 'builtin:json-render')
  seedPluginClientModule('builtin:json-render', 'index.tsx', mod)
  const broken = '{"component": "Card", "title": "流式截断' // JSON.parse 必败
  const { host, unmount } = await renderBlock(jsonContribs, 'ui', broken)
  const text = host.textContent ?? ''
  assert.match(text, /流式截断/, '源码原文可见（可复制）')
  assert.ok(!text.includes('界面声明无效'), '解析失败不冒充渲染降级')
  unmount()
})

test('CodeBlockRenderer：加载失败显式诊断 + 源码可复制（诚实性纪律）', { timeout: 60_000 }, async () => {
  // 命中贡献但模块 404（fetch 失败）：显示错误横幅与源码全文
  const store = makeTestStore({ uiContributions: jsonContribs })
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  const code = '{"component": "Text", "text": "x"}'
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('{"error":{"message":"not found"}}', { status: 404 })) as typeof fetch
  const { CodeBlockRenderer: CBR } = await import('../src/conversation/CodeBlockRenderer.js')
  act(() => {
    root = createRoot(host)
    root.render(e(
      HostStoreProviders, { value: store },
      e(CBR, { language: 'ui', code }),
    ))
  })
  // 等待异步加载失败呈现
  await new Promise((r) => setTimeout(r, 50))
  act(() => { root!.render(e(HostStoreProviders, { value: store }, e(CBR, { language: 'ui', code }))) })
  const text = host.textContent ?? ''
  assert.match(text, /render failed|Failed to load/)
  assert.match(text, /not found|404/)
  assert.ok(text.includes('"component"'), '源码原文保留（可复制）')
  globalThis.fetch = origFetch
  act(() => { root!.unmount() })
})

test('CodeBlockRenderer 从 store.plugins 读取 clientHashes：命中 O(1) 缓存零请求，未命中携带 &hash=', { timeout: 60_000 }, async () => {
  const { resetPluginClientCache } = await import('../src/lib/plugin-client.js')
  resetPluginClientCache()
  const origFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input))
    return new Response(JSON.stringify({ error: { message: 'miss' } }), { status: 404 })
  }) as typeof fetch

  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  try {
    const CustomBlock = (props: { code: string }) => e('div', { className: 'custom-hash-cb' }, props.code)
    seedPluginClientModule('cb-hash-plugin', 'index.tsx', { CustomBlock }, 'cb-hash-1')
    const cbContribs = [cbContribution('cb-hash-plugin', 'custom', ['customlang'], {
      client: { module: 'index.tsx', export: 'CustomBlock' },
    })]
    const storeHit = makeTestStore({
      uiContributions: cbContribs,
      plugins: [{
        id: 'cb-hash-plugin',
        name: 'CB',
        locked: false,
        enabled: true,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'cb-hash-1' },
      }],
    })
    await act(async () => {
      root = createRoot(host)
      root.render(e(HostStoreProviders, { value: storeHit }, e(CodeBlockRenderer, { language: 'customlang', code: 'ok' })))
    })
    assert.equal(host.querySelector('.custom-hash-cb')?.textContent, 'ok')
    assert.equal(requestedUrls.length, 0, 'expectedHash 命中时不得发网络请求')

    // 未命中新 hash 时，发起请求必须附带 &hash=cb-hash-2
    const storeMiss = {
      ...storeHit,
      plugins: [{ ...storeHit.plugins[0]!, clientHashes: { 'index.tsx': 'cb-hash-2' } }],
    }
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: storeMiss }, e(CodeBlockRenderer, { language: 'customlang', code: 'ok' })))
    })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(requestedUrls.some((u) => u.includes('module=index.tsx&hash=cb-hash-2')), `未命中应携带 &hash=：${JSON.stringify(requestedUrls)}`)
  } finally {
    if (root !== undefined) await act(async () => root!.unmount())
    globalThis.fetch = origFetch
    resetPluginClientCache()
  }
})

// ---------------------------------------------------------------------------
// 5. 缓存清单验证
// ---------------------------------------------------------------------------

test('共享编译缓存写出 deps.json 清单（不删除共享缓存目录）', { timeout: 60_000 }, () => {
  const baseName = safeFileName('index.tsx')
  for (const pluginId of ['builtin:json-render', 'builtin:mermaid']) {
    const depsPath = join(CACHE, 'plugin-staging', safeDirName(pluginId), `${baseName}.deps.json`)
    assert.ok(existsSync(depsPath), `${pluginId} 应写出共享缓存清单：${depsPath}`)
    const manifest = JSON.parse(readFileSync(depsPath, 'utf8')) as { module?: string; contentHash?: string }
    assert.equal(manifest.module, 'index.tsx')
    assert.ok(typeof manifest.contentHash === 'string' && manifest.contentHash.length > 0)
  }
})
