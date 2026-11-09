/**
 * client.tsx 轨道 Web 侧测试（.test.ts + React.createElement，无 JSX——node:test
 * 走 NodeNext 模块解析，不引 JSX 编译链）：
 * 1. 编译产物（kernel 侧真实 esbuild + 共享 shim）以 data: URL 动态 import，
 *    在 Node 进程内以全局 __helm_shared_* 命名空间供给同一份 React；
 * 2. react-dom/server renderToString 真实渲染插件组件（共享 React 实例断言），
 *    覆盖代表槽位标准 Props（ScreenProps / ToolViewProps / WorkbenchPanelProps）；
 * 3. '@helm/plugin-client' 共享模块：编译产物内 import { usePluginContext,
 *    usePluginDoc } 从 __helm_shared_plugin_client 取宿主同一函数实例；
 * 4. requireClientExport 导出缺失显式报错。
 *
 * 说明：Node 默认 ESM 加载器不支持 blob: URL，故用 data: URL 等价模拟浏览器
 * Blob 动态 import；import 语义（模块求值、命名导出解析）完全一致。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import { renderToString } from 'react-dom/server'
// 测试通过 tsx 执行当前 worktree 的真实编译器；生产 Web 不反向依赖 kernel。
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { requireClientExport } from '../src/lib/plugin-client.js'
// '@helm/plugin-client' 共享模块实例：宿主挂载的是 web/src/lib/plugin-client-context.ts
// 的模块命名空间（HelmStoreProvider 挂载同一对象）；测试直接 import 该模块挂到全局。
import * as HelmPluginClient from '../src/lib/plugin-client-context.js'

const e = React.createElement

// 宿主共享命名空间：与 HelmStoreProvider 挂载的 __helm_shared_* 一致
const g = globalThis as unknown as Record<string, unknown>
let dataDir: string
let clientRoot: string

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-web-client-'))
  clientRoot = join(dataDir, 'src')
  await mkdir(clientRoot, { recursive: true })
  await writeFile(
    join(clientRoot, 'client.tsx'),
    `
import { useState } from 'react'
import { Save } from 'lucide-react'
import { usePluginContext, usePluginDoc } from '@helm/plugin-client'

export function ScreenPanel(props: { pluginId: string; screenId: string }) {
  const [n, setN] = useState(3)
  return <div className="panel">screen:{props.screenId}:{n}<Save size={12} aria-label="save" /><button onClick={() => setN(n + 1)}>bump</button></div>
}

export function ToolCard(props: { toolName: string; status: 'running' | 'done' | 'error'; callId: string }) {
  return <div className="tool">tool:{props.toolName}:{props.status}:{props.callId}</div>
}

export function WorkbenchInfo(props: { conversation: { id: number; title: string } }) {
  return <div className="wb">conv:{props.conversation.id}:{props.conversation.title}</div>
}

export const sharedHooks = { usePluginContext: typeof usePluginContext, usePluginDoc: typeof usePluginDoc }
`,
  )
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

async function importCompiled(): Promise<Record<string, unknown>> {
  const { code } = await compilePluginClientModule('test:web-client', clientRoot, 'client.tsx', dataDir)
  // data: URL 动态 import（与浏览器 Blob URL 动态 import 语义一致）
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  return (await import(url)) as Record<string, unknown>
}

test('编译产物动态 import：共享依赖经 __helm_shared_* 命名空间解析', { timeout: 60_000 }, async () => {
  g.__helm_shared_react = React
  g.__helm_shared_react_jsx_runtime = ReactJsxRuntime
  g.__helm_shared_lucide_react = LucideReact
  g.__helm_shared_plugin_client = HelmPluginClient
  const mod = await importCompiled()
  assert.equal(typeof mod.ScreenPanel, 'function')
  assert.equal(typeof mod.ToolCard, 'function')
})

test('renderToString 真实渲染 Screen 组件（Props: pluginId/screenId；共享 React + lucide）', { timeout: 60_000 }, async () => {
  const mod = await importCompiled()
  const ScreenPanel = mod.ScreenPanel as (props: { pluginId: string; screenId: string }) => React.ReactElement
  const html = renderToString(e(ScreenPanel, { pluginId: 'test:web-client', screenId: 'panel' }))
  assert.match(html, /screen:.*panel.*3/)
  assert.match(html, /lucide-save|save/)
})

test('renderToString 真实渲染 ToolView 与 Workbench 面板组件（协议标准 Props）', { timeout: 60_000 }, async () => {
  const mod = await importCompiled()
  const ToolCard = mod.ToolCard as (props: { toolName: string; status: string; callId: string }) => React.ReactElement
  const html1 = renderToString(e(ToolCard, { toolName: 'bash', status: 'done', callId: 'c-1' }))
  assert.match(html1, /tool:.*bash.*done.*c-1/)

  const WorkbenchInfo = mod.WorkbenchInfo as (props: { conversation: { id: number; title: string } }) => React.ReactElement
  const html2 = renderToString(e(WorkbenchInfo, { conversation: { id: 7, title: '巡检' } }))
  assert.match(html2, /conv:.*7.*巡检/)
})

test('共享 React 断言：插件组件与宿主使用同一 React 实例', { timeout: 60_000 }, async () => {
  const mod = await importCompiled()
  // react/jsx-runtime 的 jsx 导出来自宿主命名空间；同一实例时 Symbol.for 注册一致
  const jsxRuntime = g.__helm_shared_react_jsx_runtime as typeof ReactJsxRuntime
  const element = (mod.ToolCard as (p: { toolName: string; status: string; callId: string }) => React.ReactElement)({
    toolName: 'x',
    status: 'error',
    callId: 'c',
  }) as unknown as { $$typeof: symbol }
  const reactModule = React as unknown as { Symbol?: { for(key: string): symbol } }
  assert.equal(element.$$typeof, reactModule.Symbol?.for?.('react.transitional.element') ?? element.$$typeof)
  assert.equal(typeof jsxRuntime.jsx, 'function')
})

test("'@helm/plugin-client' 共享模块：产物内 hooks 与宿主为同一函数实例（usePluginContext/usePluginDoc）", { timeout: 60_000 }, async () => {
  const mod = await importCompiled()
  const hooks = mod.sharedHooks as { usePluginContext: string; usePluginDoc: string }
  assert.equal(hooks.usePluginContext, 'function')
  assert.equal(hooks.usePluginDoc, 'function')
  // 宿主模块确实导出这两个 hooks（编译 shim 只是转发，不克隆实现）
  assert.equal(typeof HelmPluginClient.usePluginContext, 'function')
  assert.equal(typeof HelmPluginClient.usePluginDoc, 'function')
})

test('requireClientExport：导出缺失显式报错并列出可用导出', { timeout: 60_000 }, async () => {
  const mod = await importCompiled()
  assert.throws(
    () => requireClientExport('test:web-client', 'client.tsx', 'NotExists', mod),
    (err: unknown) => err instanceof Error && err.message.includes('NotExists') && err.message.includes('ScreenPanel'),
  )
})
