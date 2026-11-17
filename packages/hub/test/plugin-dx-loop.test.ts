/**
 * 外部插件生态 DX 闭环与包管理 HTTP 集成测试（合并原 plugin-dx-http / plugin-package-http，共享单实例 createHelm）：
 * - 代际加载器（?helmgen 模块图重初始化与相对依赖闭包传播，纯 node 子进程验证）；
 * - doctorPluginDir（健康摘要、损坏 manifest 提前终止、TS 语法错误文件定位、重复 action 边界、悬空与健康 client 导出）；
 * - PluginHost DX 操作（rescan 增量扫描、reload 热重载/预检失败保活/锁定 403/未知 404/在途 409/停用态保持/冲突回滚、按 id doctor）；
 * - DX HTTP 路由（POST /api/plugins/doctor | rescan | :id/reload 鉴权、body 校验与错误信封穿透）；
 * - 受管包管理 HTTP 路由（POST /api/plugins/install | :id/update | :id/remove、GET /api/plugins managed 映射与跨重启恢复）。
 */
import { createPluginBuildProvider } from '@helm/plugin-build'
import { HelmError as HostHelmError, type PluginReloadResult, type PluginRescanResult } from '@helm/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { doctorPluginDir } from '../../kernel/src/plugins/plugin-doctor.js'
import {
  createHubTestApp,
  openHubHandlerEnv,
  useTempDir,
  type HubHandlerTestEnv,
} from './helpers/hub-test-env.js'

let env: HubHandlerTestEnv

before(async () => {
  env = await openHubHandlerEnv({ prefix: 'helm-plugin-dx-' })
})

after(async () => {
  await env?.close().catch(() => {})
})

function writeMinimalPlugin(
  pluginsDir: string,
  dir: string,
  opts: { probeValue?: string } = {},
): { dirPath: string; counterName: string } {
  const counterName = `__dx_init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib'), { recursive: true })
  const probeValue = opts.probeValue ?? 'v1'
  writeFileSync(
    join(dirPath, 'index.ts'),
    `import { sharedDep } from './lib/shared.js'

declare global { var ${counterName}: number | undefined }
globalThis.${counterName} = (globalThis.${counterName} ?? 0) + 1

function definePlugin(ctx: any) {
  ctx.action({
    id: 'probe',
    description: 'probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['value', 'shared'],
      additionalProperties: false,
      properties: { value: { type: 'string' }, shared: { type: 'string' } },
    },
    idempotent: true,
    handler: () => ({ value: ${JSON.stringify(probeValue)}, shared: sharedDep() }),
  })
}

export default { id: '${dir}', name: 'DX plugin ${dir}', version: '0.1.0', definePlugin }
`,
  )
  writeFileSync(
    join(dirPath, 'lib', 'shared.ts'),
    `import { HelmError } from '@helm/protocol'
declare global { var ${counterName}_lib: number | undefined }
globalThis.${counterName}_lib = (globalThis.${counterName}_lib ?? 0) + 1
export const sharedDep = (): string => 'shared:' + (HelmError ? 'helm-ok' : 'helm-missing')
`,
  )
  return { dirPath, counterName }
}

function writeClientPlugin(
  pluginsDir: string,
  dir: string,
  opts: { actualExportName?: string; declaredExportName?: string } = {},
): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'client'), { recursive: true })
  const actualExport = opts.actualExportName ?? 'SamplePanel'
  const declaredExport = opts.declaredExportName ?? actualExport
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.ui.workbenchPanel({
    id: 'panel',
    label: 'panel',
    client: { module: 'client.tsx', export: ${JSON.stringify(declaredExport)} },
  })
}
export default { id: '${dir}', definePlugin, clientRoot: './client' }
`,
  )
  writeFileSync(
    join(dirPath, 'client', 'client.tsx'),
    `import React from 'react'
import { usePluginDoc } from '@helm/plugin-client'

export function ${actualExport}(): React.JSX.Element {
  const state = usePluginDoc<{ n: number }>('state')
  return React.createElement('div', null, 'n=', state?.n ?? 0)
}
`,
  )
  return dirPath
}

function writeSlashPlugin(pluginsDir: string, dir: string, slash: string): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.action({
    id: 'noop',
    description: 'empty action',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    idempotent: true,
    handler: () => ({ ok: true }),
  })
  ctx.ui.command({ id: 'cmd', label: 'command', slash: ${JSON.stringify(slash)}, actionId: 'noop' })
}
export default { id: '${dir}', definePlugin }
`,
  )
  return dirPath
}

const LOCAL_PKG_SRC = (id: string, version = '1.0.0') => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

function writeLocalPackage(parent: string, id: string, version = '1.0.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), LOCAL_PKG_SRC(id, version))
  return dir
}

// ---------------------------------------------------------------------------
// 1. 代际边界加载（纯 node 子进程）与 doctorPluginDir 四阶段静态自检
// ---------------------------------------------------------------------------

test('代际边界加载：?helmgen 入口重初始化模块图并向相对依赖闭包传播（纯 node 子进程）', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-dx-gen-')
  const loaderSrc = fileURLToPath(new URL('../../kernel/src/plugins/backend-ts-loader.ts', import.meta.url))
  const { dirPath, counterName } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-gen')
  const childSrc = `
const { registerPluginTsRoot, nextPluginGeneration } = await import(${JSON.stringify(loaderSrc)})
const { createPluginBuildProvider } = await import(${JSON.stringify(import.meta.resolve('@helm/plugin-build'))})
const entry = ${JSON.stringify(join(dirPath, 'index.ts'))}
const release = registerPluginTsRoot(${JSON.stringify(dirPath)}, { transform: createPluginBuildProvider().transformBackendTs })
const plain = (await import('file://' + entry)).default
if (plain.id !== 'dx-gen' || globalThis[${JSON.stringify(counterName)}] !== 1 || globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 1) process.exit(1)
const again = (await import('file://' + entry)).default
if (again !== plain || globalThis[${JSON.stringify(counterName)}] !== 1) process.exit(1)
const g1 = nextPluginGeneration(${JSON.stringify(dirPath)})
const gen1 = (await import('file://' + entry + '?helmgen=' + g1)).default
if (gen1 === plain || globalThis[${JSON.stringify(counterName)}] !== 2 || globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 2) process.exit(1)
const g2 = nextPluginGeneration(${JSON.stringify(dirPath)})
if (g2 <= g1) process.exit(1)
await import('file://' + entry + '?helmgen=' + g2)
if (globalThis[${JSON.stringify(counterName)}] !== 3 || globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 3) process.exit(1)
release()
console.log('CHILD_OK')
`
  const childPath = join(dirPath, 'gen-child.mjs')
  writeFileSync(childPath, childSrc)
  const out = execFileSync(process.execPath, ['--experimental-strip-types', childPath], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.ok(out.includes('CHILD_OK'))
})

test('doctorPluginDir：健康插件与前端组件通过，损坏 manifest / TS 语法 / 重复 action / 悬空 client 导出精确定位', { timeout: 60_000 }, async (t) => {
  const pluginsDir = join(useTempDir(t, 'helm-dx-doc-'), 'plugins')
  const buildProvider = createPluginBuildProvider()

  const healthy = await doctorPluginDir(writeMinimalPlugin(pluginsDir, 'dx-healthy').dirPath, { buildProvider })
  assert.equal(healthy.ok, true)
  assert.deepEqual(healthy.checks.map((c) => c.id), ['manifest', 'backend', 'register', 'client'])
  assert.equal(healthy.summary?.id, 'dx-healthy')
  assert.equal(healthy.summary?.enabled, false)

  const badManifestDir = join(pluginsDir, 'dx-bad-manifest')
  mkdirSync(badManifestDir, { recursive: true })
  writeFileSync(join(badManifestDir, 'plugin.json'), '{ not valid json')
  const badManifest = await doctorPluginDir(badManifestDir, { buildProvider })
  assert.equal(badManifest.ok, false)
  assert.deepEqual(badManifest.checks.map((c) => c.id), ['manifest'])
  assert.equal(badManifest.checks[0]!.error?.code, 'plugin_manifest_invalid')

  const syntaxDir = join(pluginsDir, 'dx-syntax')
  mkdirSync(syntaxDir, { recursive: true })
  writeFileSync(join(syntaxDir, 'index.ts'), 'export default { id: "dx-syntax", definePlugin( {}\n')
  const syntaxReport = await doctorPluginDir(syntaxDir, { buildProvider })
  assert.equal(syntaxReport.ok, false)
  const backendCheck = syntaxReport.checks.find((c) => c.id === 'backend')!
  assert.equal(backendCheck.error?.code, 'plugin_load_failed')
  assert.ok(backendCheck.error!.message.includes('index.ts'))

  const dupDir = join(pluginsDir, 'dx-dup-action')
  mkdirSync(dupDir, { recursive: true })
  writeFileSync(
    join(dupDir, 'index.ts'),
    `function definePlugin(ctx: any) {
  const spec = { id: 'dup', description: 'x', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) }
  ctx.action(spec); ctx.action(spec)
}
export default { id: 'dx-dup-action', definePlugin }\n`,
  )
  const dupReport = await doctorPluginDir(dupDir, { buildProvider })
  assert.equal(dupReport.ok, false)
  assert.equal(dupReport.checks.find((c) => c.id === 'register')?.error?.code, 'duplicate_action')

  const danglingDir = writeClientPlugin(pluginsDir, 'dx-dangling', {
    actualExportName: 'NotThePanelYouWant',
    declaredExportName: 'SamplePanel',
  })
  const danglingReport = await doctorPluginDir(danglingDir, { buildProvider })
  assert.equal(danglingReport.ok, false)
  const clientErr = danglingReport.checks.find((c) => c.id === 'client')!.error!
  assert.equal(clientErr.code, 'invalid_client_export')
  assert.ok(clientErr.message.includes('SamplePanel'))

  const clientOkReport = await doctorPluginDir(writeClientPlugin(pluginsDir, 'dx-client-ok'), { buildProvider })
  assert.equal(clientOkReport.ok, true)
  assert.equal(clientOkReport.checks.find((c) => c.id === 'client')?.error, undefined)
})

// ---------------------------------------------------------------------------
// 2. PluginHost rescan / reload / doctor 与 DX HTTP 路由契约
// ---------------------------------------------------------------------------

test('rescan 与 reload 全路径：增量注册不扰既有、热重载代际推进、预检失败保活、403/404/409 门禁、停用保持与冲突回滚', { timeout: 60_000 }, async () => {
  const pluginsDir = join(env.dataDir, 'plugins')

  // 1. rescan：新目录默认停用，已启用插件不受扰，二次扫描无新增
  writeMinimalPlugin(pluginsDir, 'dx-first')
  const firstScan = await env.kernel.plugins.rescanExternalPlugins()
  assert.ok(firstScan.registered.includes('dx-first'))
  await env.kernel.plugins.enable('dx-first')
  assert.equal(((await env.kernel.plugins.invokeAction('dx-first', 'probe', {})) as { value: string }).value, 'v1')

  writeMinimalPlugin(pluginsDir, 'dx-second')
  const secondScan = await env.kernel.plugins.rescanExternalPlugins()
  assert.deepEqual(secondScan.registered, ['dx-second'])
  assert.equal(secondScan.plugins.find((p) => p.id === 'dx-second')?.enabled, false)
  assert.equal(((await env.kernel.plugins.invokeAction('dx-first', 'probe', {})) as { value: string }).value, 'v1')
  assert.deepEqual((await env.kernel.plugins.rescanExternalPlugins()).registered, [])

  // 2. reload 健康代码：保持启用、代际递增、新模块图生效
  const { dirPath: liveDir, counterName } = writeMinimalPlugin(pluginsDir, 'dx-live')
  await env.kernel.plugins.rescanExternalPlugins()
  await env.kernel.plugins.enable('dx-live')
  assert.equal(((await env.kernel.plugins.invokeAction('dx-live', 'probe', {})) as { value: string }).value, 'v1')
  const initsBefore = (globalThis as Record<string, unknown>)[counterName] as number
  writeFileSync(join(liveDir, 'index.ts'), readFileSync(join(liveDir, 'index.ts'), 'utf8').replace('v1', 'v2'))
  const reloaded = await env.kernel.plugins.reloadExternalPlugin('dx-live')
  assert.equal(reloaded.wasEnabled, true)
  assert.ok(reloaded.generation >= 2 && reloaded.summary.enabled)
  assert.equal(((await env.kernel.plugins.invokeAction('dx-live', 'probe', {})) as { value: string }).value, 'v2')
  assert.ok(((globalThis as Record<string, unknown>)[counterName] as number) > initsBefore)

  // 3. reload 坏代码预检失败（422 + doctor report），旧实例继续服务
  const { dirPath: keepDir } = writeMinimalPlugin(pluginsDir, 'dx-keep')
  await env.kernel.plugins.rescanExternalPlugins()
  await env.kernel.plugins.enable('dx-keep')
  writeFileSync(join(keepDir, 'index.ts'), 'export default { id: "dx-keep", definePlugin(( {}\n')
  await assert.rejects(
    env.kernel.plugins.reloadExternalPlugin('dx-keep'),
    (err: unknown) =>
      err instanceof HostHelmError &&
      err.code === 'plugin_reload_preflight_failed' &&
      err.status === 422 &&
      (err.details as { report?: { ok?: boolean } })?.report?.ok === false,
  )
  assert.equal(((await env.kernel.plugins.invokeAction('dx-keep', 'probe', {})) as { value: string }).value, 'v1')

  // 4. 内置插件 403、未注册 404、在途任务 409、停用态保持停用
  await assert.rejects(
    env.kernel.plugins.reloadExternalPlugin('builtin:profile'),
    (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_locked' && err.status === 403,
  )
  await assert.rejects(
    env.kernel.plugins.reloadExternalPlugin('dx-never-exists'),
    (err: unknown) => err instanceof HostHelmError && err.code === 'unknown_plugin',
  )

  const { dirPath: offDir } = writeMinimalPlugin(pluginsDir, 'dx-off')
  await env.kernel.plugins.rescanExternalPlugins()
  let releaseBusy!: () => void
  const busyGate = new Promise<void>((resolve) => { releaseBusy = resolve })
  const inFlight = env.kernel.plugins.withTask('dx-first', 'dx-test-busy', async () => busyGate)
  await assert.rejects(
    env.kernel.plugins.reloadExternalPlugin('dx-first'),
    (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_has_live_tasks' && err.status === 409,
  )
  releaseBusy()
  await inFlight
  assert.equal((await env.kernel.plugins.reloadExternalPlugin('dx-first')).pluginId, 'dx-first')

  writeFileSync(join(offDir, 'index.ts'), readFileSync(join(offDir, 'index.ts'), 'utf8').replace('v1', 'v2'))
  const offReloaded = await env.kernel.plugins.reloadExternalPlugin('dx-off')
  assert.equal(offReloaded.wasEnabled, false)
  assert.equal(offReloaded.summary.enabled, false)

  // 5. 切换期冲突回滚（slash 唯一性冲突 → rolledBack=true，旧实例继续服务）
  const { dirPath: dirA } = writeMinimalPlugin(pluginsDir, 'dx-a')
  writeSlashPlugin(pluginsDir, 'dx-b', 'dxdupe')
  await env.kernel.plugins.rescanExternalPlugins()
  await env.kernel.plugins.enable('dx-a')
  await env.kernel.plugins.enable('dx-b')
  const originalA = readFileSync(join(dirA, 'index.ts'), 'utf8')
  const injectedA = originalA
    .replace('function definePlugin(ctx: any) {', 'function baseDefine(ctx: any) {')
    .replace(
      `export default { id: 'dx-a', name: 'DX plugin dx-a', version: '0.1.0', definePlugin }`,
      `function definePlugin(ctx: any) { baseDefine(ctx); ctx.ui.command({ id: 'dupe-cmd', label: 'conflict', slash: 'dxdupe', actionId: 'probe' }) }\nexport default { id: 'dx-a', name: 'DX plugin dx-a', version: '0.1.0', definePlugin }`,
    )
  writeFileSync(join(dirA, 'index.ts'), injectedA)
  await assert.rejects(
    env.kernel.plugins.reloadExternalPlugin('dx-a'),
    (err: unknown) =>
      err instanceof HostHelmError &&
      err.code === 'plugin_reload_failed' &&
      (err.details as { rolledBack?: boolean })?.rolledBack === true,
  )
  assert.equal(((await env.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }).value, 'v1')
  writeFileSync(join(dirA, 'index.ts'), originalA)
  assert.equal((await env.kernel.plugins.reloadExternalPlugin('dx-a')).summary.enabled, true)
})

test('DX HTTP 路由契约：POST /api/plugins/doctor | rescan | :id/reload 鉴权、参数校验与 404/422 信封', { timeout: 60_000 }, async () => {
  const pluginsDir = join(env.dataDir, 'plugins')
  const { dirPath } = writeMinimalPlugin(pluginsDir, 'dx-http-pl')
  await env.kernel.plugins.rescanExternalPlugins()
  await env.kernel.plugins.enable('dx-http-pl')

  // 按 id doctor 及互斥校验
  const byId = await env.kernel.plugins.doctorExternalPlugin({ id: 'dx-http-pl' })
  assert.equal(byId.ok, true)
  assert.equal(byId.requestedId, 'dx-http-pl')
  assert.ok(byId.dir.endsWith('dx-http-pl'))
  await assert.rejects(
    env.kernel.plugins.doctorExternalPlugin({ id: 'dx-not-registered' }),
    (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_source_missing',
  )
  await assert.rejects(
    env.kernel.plugins.doctorExternalPlugin({ id: 'dx-http-pl', dir: '/abs' }),
    (err: unknown) => err instanceof HostHelmError && err.code === 'validation_error',
  )

  // POST /api/plugins/doctor
  const okDoc = await env.call('POST', '/api/plugins/doctor', { dir: dirPath })
  assert.equal(okDoc.status, 200)
  assert.equal(okDoc.body.ok, true)
  assert.equal(okDoc.body.pluginId, 'dx-http-pl')
  assert.equal((await env.call('POST', '/api/plugins/doctor', {})).status, 400)
  assert.equal((await env.call('POST', '/api/plugins/doctor', { dir: 'relative/path' })).status, 400)
  assert.equal((await env.call('POST', '/api/plugins/doctor', { dir: dirPath, force: true })).status, 400)
  assert.equal((await env.call('POST', '/api/plugins/doctor', undefined, { rawBody: 'not json' })).status, 400)
  assert.equal((await env.call('POST', '/api/plugins/doctor', { dir: dirPath }, { auth: false })).status, 401)

  // POST /api/plugins/rescan
  writeMinimalPlugin(pluginsDir, 'dx-http-rescanned')
  const rescanRes = await env.call<PluginRescanResult>('POST', '/api/plugins/rescan', {})
  assert.equal(rescanRes.status, 200)
  assert.deepEqual(rescanRes.body.registered, ['dx-http-rescanned'])

  // POST /api/plugins/:id/reload（200 / 404 / 422 附 report）
  const reloadOk = await env.call<PluginReloadResult>('POST', '/api/plugins/dx-http-pl/reload', {})
  assert.equal(reloadOk.status, 200)
  assert.equal(reloadOk.body.pluginId, 'dx-http-pl')
  assert.equal(reloadOk.body.wasEnabled, true)

  const reloadMissing = await env.call('POST', '/api/plugins/missing-plugin/reload', {})
  assert.equal(reloadMissing.status, 404)
  assert.equal(reloadMissing.body.error.code, 'unknown_plugin')

  writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-http-pl", definePlugin(( {}\n')
  const reloadPreflight = await env.call('POST', '/api/plugins/dx-http-pl/reload', {})
  assert.equal(reloadPreflight.status, 422)
  assert.equal(reloadPreflight.body.error.code, 'plugin_reload_preflight_failed')
  assert.ok(reloadPreflight.body.error.details.report)
})

// ---------------------------------------------------------------------------
// 3. 受管插件包 HTTP 路由与跨重启持久化（原 plugin-package-http.test.ts）
// ---------------------------------------------------------------------------

test('受管包 HTTP 路由：install（默认停用与 enable:true / body 边界 400）、update、remove 与 managed 映射', { timeout: 60_000 }, async (t) => {
  const srcParent = useTempDir(t, 'helm-pkg-httpsrc-')

  // install 默认停用 + GET /api/plugins managed 映射 + enable: true
  const src1 = writeLocalPackage(srcParent, 'http-demo')
  const installed = await env.call('POST', '/api/plugins/install', { source: src1 })
  assert.equal(installed.status, 200)
  assert.equal(installed.body.record.pluginId, 'http-demo')
  assert.equal(installed.body.summary.enabled, false)
  assert.equal(installed.body.summary.managed.source.path, src1)
  assert.ok(existsSync(join(env.dataDir, 'plugins', 'http-demo', 'index.mjs')))

  const list = await env.call('GET', '/api/plugins')
  assert.ok(list.body.find((p: { id: string; managed?: unknown }) => p.id === 'http-demo')?.managed)

  const src2 = writeLocalPackage(srcParent, 'http-demo-2')
  const enabledInstall = await env.call('POST', '/api/plugins/install', { source: src2, enable: true })
  assert.equal(enabledInstall.status, 200)
  assert.equal(enabledInstall.body.summary.enabled, true)

  // install body 边界
  for (const bad of [
    { source: '/tmp/x', extra: true },
    { source: '' },
    { source: 'file:///tmp/x' },
    { source: 'builtin:profile' },
  ]) {
    assert.equal((await env.call('POST', '/api/plugins/install', bad)).status, 400)
  }

  // update：本地源码升版同步且保持启用；未受管/内置 404
  const srcUp = writeLocalPackage(srcParent, 'http-up', '1.0.0')
  assert.equal((await env.call('POST', '/api/plugins/install', { source: srcUp, enable: true })).status, 200)
  writeLocalPackage(srcParent, 'http-up', '2.0.0')
  const updated = await env.call('POST', '/api/plugins/http-up/update')
  assert.equal(updated.status, 200)
  assert.equal(updated.body.record.version, '2.0.0')
  assert.equal(updated.body.summary.version, '2.0.0')
  assert.equal(updated.body.summary.enabled, true)
  assert.equal((await env.call('POST', '/api/plugins/never-installed/update')).status, 404)
  assert.equal((await env.call('POST', '/api/plugins/builtin%3Aprofile/update')).status, 404)

  // remove：删除受管目录与 config 记录，保留用户源目录，重复删除 404
  const srcRm = writeLocalPackage(srcParent, 'http-rm')
  await env.call('POST', '/api/plugins/install', { source: srcRm, enable: true })
  const removed = await env.call('POST', '/api/plugins/http-rm/remove')
  assert.equal(removed.status, 200)
  assert.equal(removed.body.pluginId, 'http-rm')
  assert.equal(removed.body.wasEnabled, true)
  assert.ok(!existsSync(join(env.dataDir, 'plugins', 'http-rm')))
  assert.ok(existsSync(join(srcRm, 'index.mjs')))
  const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
  assert.equal(config.pluginPackages?.['http-rm'], undefined)
  assert.equal((await env.call('POST', '/api/plugins/http-rm/remove')).status, 404)
})

test('受管包跨重启恢复：config.json.pluginPackages 持久驱动 managed 映射与卸载能力', { timeout: 60_000 }, async (t) => {
  const dataDir = join(useTempDir(t, 'helm-pkg-restart-'), 'hub')
  const srcParent = useTempDir(t, 'helm-pkg-restart-src-')
  const src = writeLocalPackage(srcParent, 'restart-demo')

  const first = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    await first.kernel.plugins.installPluginPackage(src)
  } finally {
    await first.app.close()
  }

  const second = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    const summary = second.kernel.plugins.list().find((p) => p.id === 'restart-demo')
    assert.ok(summary?.managed)
    assert.equal(summary.managed.source.kind, 'local')
    assert.equal((await second.kernel.plugins.removePluginPackage('restart-demo')).pluginId, 'restart-demo')
  } finally {
    await second.app.close()
  }
})
