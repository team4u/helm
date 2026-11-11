/**
 * 外部插件生态 DX 闭环测试：generation loader（代际加载）+ doctor（静态自检）
 * + reload（受控热重载）+ rescan（增量重扫描）。
 *
 * 组合纪律：真实 createHelm（真 SQLite + 真 PluginHost + 真外部插件源文件目录）+
 * faux provider；不 mock app、不 fake host。fixture 全部落在临时开发 dataDir。
 *
 * 覆盖（要求真验证项）：
 * - 代际加载：?helmgen 入口重新初始化模块（模块级计数器递增）；相对依赖闭包
 *   传播代际标记（本地依赖同样重新初始化）；@helm/* 裸说明符跨代共享同一实例；
 * - doctor：健康插件 ok=true 且附真实注册 summary；损坏 manifest / 语法错误 /
 *   注册边界违约 / 悬空 client export 分别落在对应检查项；
 * - reload：预检失败旧实例保持可用（动作仍可调）；健康代码重载成功且启用状态
 *   保持；内置插件 403；在途任务 409；
 * - rescan：新目录注册且默认停用；已注册插件不被打扰（动作照常）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { HelmError as HostHelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

async function createApp(dataDir: string) {
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
}

// ---------------------------------------------------------------------------
// fixture 写入
// ---------------------------------------------------------------------------

/**
 * 最小健康 TS 插件：index.ts + 一个 idempotent 探针动作 + 模块级初始化计数器。
 * counterName 用于断言「同代只初始化一次 / 新代重新初始化」。
 */
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
    description: '探针',
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

export default { id: '${dir}', name: 'DX 插件 ${dir}', version: '0.1.0', definePlugin }
`,
  )
  // 本地 TS 依赖（.js 说明符映射）+ 自身模块级计数（验证代际传播到依赖闭包）
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

/** 带前端组件声明的插件（doctor client 检查消费）。 */
function writeClientPlugin(
  pluginsDir: string,
  dir: string,
  opts: { exportName?: string } = {},
): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'client'), { recursive: true })
  const exportName = opts.exportName ?? 'SamplePanel'
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.ui.workbenchPanel({
    id: 'panel',
    label: '面板',
    client: { module: 'client.tsx', export: ${JSON.stringify(exportName)} },
  })
}
export default { id: '${dir}', definePlugin }
`,
  )
  // 修正：clientRoot 是 PluginDefinition 字段（模块导出），在导入后由
  // normalizeDefinition 解析为绝对路径——通过重写尾行注入相对 clientRoot。
  const entryFile = join(dirPath, 'index.ts')
  writeFileSync(
    entryFile,
    readFileSync(entryFile, 'utf8').replace(
      `export default { id: '${dir}', definePlugin }`,
      `export default { id: '${dir}', definePlugin, clientRoot: './client' }`,
    ),
  )
  writeFileSync(
    join(dirPath, 'client', 'client.tsx'),
    `import React from 'react'
import { usePluginDoc } from '@helm/plugin-client'

export function ${exportName}(): React.JSX.Element {
  const state = usePluginDoc<{ n: number }>('state')
  return React.createElement('div', null, 'n=', state?.n ?? 0)
}
`,
  )
  return dirPath
}

// ---------------------------------------------------------------------------
// 代际加载（generation loader）
// 注：代际传播断言在纯 node 子进程运行（--experimental-strip-types）。
// 开发期 tsx 加载器会重写 URL 与缓存模块解析（tsx-commonjs-virtual-query），
// 其行为不代表生产语义；外部插件加载器同款验证方式见 external-plugin-ts.test.ts。
// ---------------------------------------------------------------------------

test('代际加载：?helmgen 入口重新初始化模块图，相对依赖闭包传播（纯 node 子进程）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-gen-'))
  const loaderSrc = fileURLToPath(new URL('../src/plugins/backend-ts-loader.ts', import.meta.url))
  try {
    const { dirPath, counterName } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-gen')
    const childSrc = `
const { registerPluginTsRoot, nextPluginGeneration } = await import(${JSON.stringify(loaderSrc)})
const entry = ${JSON.stringify(join(dirPath, 'index.ts'))}
const release = registerPluginTsRoot(${JSON.stringify(dirPath)})
const plain = (await import('file://' + entry)).default
if (plain.id !== 'dx-gen') { console.log('FAIL id'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 1) { console.log('FAIL plain-init'); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 1) { console.log('FAIL plain-lib-init'); process.exit(1) }
const again = (await import('file://' + entry)).default
if (again !== plain) { console.log('FAIL same-url-identity'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 1) { console.log('FAIL cache-reinit'); process.exit(1) }
const g1 = nextPluginGeneration(${JSON.stringify(dirPath)})
const gen1 = (await import('file://' + entry + '?helmgen=' + g1)).default
if (gen1 === plain) { console.log('FAIL gen-new-instance'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 2) { console.log('FAIL gen1-init:' + globalThis[${JSON.stringify(counterName)}]); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 2) { console.log('FAIL gen1-lib-init:' + globalThis[${JSON.stringify(`${counterName}_lib`)}]); process.exit(1) }
const g2 = nextPluginGeneration(${JSON.stringify(dirPath)})
if (g2 <= g1) { console.log('FAIL gen-monotonic'); process.exit(1) }
await import('file://' + entry + '?helmgen=' + g2)
if (globalThis[${JSON.stringify(counterName)}] !== 3) { console.log('FAIL gen2-init:' + globalThis[${JSON.stringify(counterName)}]); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 3) { console.log('FAIL gen2-lib-init:' + globalThis[${JSON.stringify(`${counterName}_lib`)}]); process.exit(1) }
release()
console.log('CHILD_OK')
`
    const childPath = join(dirPath, 'gen-child.mjs')
    writeFileSync(childPath, childSrc)
    let out = ''
    try {
      out = execFileSync(process.execPath, ['--experimental-strip-types', childPath], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const errOut = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
      assert.fail(`纯 node 子进程失败：${out}${errOut.slice(0, 800)}`)
    }
    assert.ok(out.includes('CHILD_OK'), `子进程应全契约通过，输出：${out}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor：健康插件 ok=true 且附真实注册 summary', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-healthy')
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, true, `健康插件应通过：${JSON.stringify(report.checks)}`)
    assert.equal(report.pluginId, 'dx-healthy')
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest', 'backend', 'register', 'client'],
    )
    assert.ok(report.summary, '附真实注册 summary')
    assert.equal(report.summary!.id, 'dx-healthy')
    assert.equal(report.summary!.enabled, false, 'doctor 注册默认停用（无副作用）')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor：损坏 manifest 落在 manifest 检查项', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-bad-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ not valid json')
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, false)
    const manifest = report.checks.find((c) => c.id === 'manifest')
    assert.ok(manifest?.error, 'manifest 检查失败')
    assert.equal(manifest!.error!.code, 'plugin_manifest_invalid')
    // 后继依赖检查不执行（避免误导性的连环失败）
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest'],
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor：TS 语法错误落在 backend 检查项（含文件定位）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-syntax')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-syntax", definePlugin( {}\n')
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, false)
    const backend = report.checks.find((c) => c.id === 'backend')
    assert.ok(backend?.error)
    assert.equal(backend!.error!.code, 'plugin_load_failed')
    assert.ok(backend!.error!.message.includes('index.ts'), '诊断含文件定位')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor：注册边界违约（重复动作 id）落在 register 检查项', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-dup-action')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.ts'),
      `function definePlugin(ctx: any) {
  const spec = {
    id: 'dup',
    description: 'x',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    handler: () => ({ ok: true }),
  }
  ctx.action(spec)
  ctx.action(spec)
}
export default { id: 'dx-dup-action', definePlugin }
`,
    )
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, false)
    const register = report.checks.find((c) => c.id === 'register')
    assert.ok(register?.error)
    assert.equal(register!.error!.code, 'duplicate_action')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor：悬空 client export 落在 client 检查项（真实编译产物导出校验）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    // 声明的 export 名在模块中不存在（写成了别的名字）
    const dirPath = writeClientPlugin(join(dataDir, 'plugins'), 'dx-dangling', {
      exportName: 'NotThePanelYouWant',
    })
    // 声明引用正确的名字（与实际导出不一致 -> 悬空）
    const entry = readFileSync(join(dirPath, 'index.ts'), 'utf8')
    writeFileSync(
      join(dirPath, 'index.ts'),
      entry.replace('NotThePanelYouWant', 'SamplePanel'),
    )
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, false)
    const client = report.checks.find((c) => c.id === 'client')
    assert.ok(client?.error, `client 检查应失败：${JSON.stringify(report.checks)}`)
    assert.equal(client!.error!.code, 'invalid_client_export')
    assert.ok(client!.error!.message.includes('SamplePanel'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor：健康前端组件通过 client 检查', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = writeClientPlugin(join(dataDir, 'plugins'), 'dx-client-ok')
    const report = await doctorPluginDir(dirPath)
    assert.equal(report.ok, true, JSON.stringify(report.checks))
    const client = report.checks.find((c) => c.id === 'client')
    assert.ok(client && client.error === undefined)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// rescan（增量重扫描）
// ---------------------------------------------------------------------------

test('rescan：新目录注册且默认停用；已注册插件不受打扰', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-rescan-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-first')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-first')
    const before = (await app.kernel.plugins.invokeAction('dx-first', 'probe', {})) as {
      value: string
    }
    assert.equal(before.value, 'v1')

    // 放入新插件目录后 rescan：只注册新插件，默认停用
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-second')
    const result = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(result.registered, ['dx-second'])
    const second = result.plugins.find((p) => p.id === 'dx-second')
    assert.ok(second)
    assert.equal(second.enabled, false, 'rescan 注册的新插件默认停用')

    // 已注册插件不受打扰（仍是启用态，动作照常）
    const after = (await app.kernel.plugins.invokeAction('dx-first', 'probe', {})) as {
      value: string
    }
    assert.equal(after.value, 'v1')
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-first')?.enabled, true)

    // 再次 rescan：无新插件
    const again = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(again.registered, [])
    assert.ok(again.skipped >= 2, `已注册与数据目录计入 skipped：${again.skipped}`)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// reload（受控热重载）
// ---------------------------------------------------------------------------

test('reload：健康代码重载成功且启用状态保持；新代码生效', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath, counterName } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-live')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-live')
    const v1 = (await app.kernel.plugins.invokeAction('dx-live', 'probe', {})) as {
      value: string
    }
    assert.equal(v1.value, 'v1')
    const initsAfterFirstEnable = (globalThis as Record<string, unknown>)[counterName] as number

    // 修改代码（动作返回值变化）
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )

    const result = await app.kernel.plugins.reloadExternalPlugin('dx-live')
    assert.equal(result.pluginId, 'dx-live')
    assert.equal(result.wasEnabled, true)
    assert.ok(result.generation >= 2)
    assert.equal(result.summary.enabled, true, '重载后保持启用')

    const v2 = (await app.kernel.plugins.invokeAction('dx-live', 'probe', {})) as {
      value: string
    }
    assert.equal(v2.value, 'v2', '重载后新代码生效')
    const initsAfterReload = (globalThis as Record<string, unknown>)[counterName] as number
    assert.ok(
      initsAfterReload > initsAfterFirstEnable,
      '重载使用新代际模块图（模块重新初始化）',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：坏代码预检失败，旧实例保持可用（动作照常、状态不变）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-keep')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-keep')

    // 写坏代码（语法错误）
    writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-keep", definePlugin(( {}\n')

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-keep'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError)
        assert.equal(err.code, 'plugin_reload_preflight_failed')
        assert.equal(err.status, 422)
        const details = err.details as { report?: { ok?: boolean } }
        assert.equal(details?.report?.ok, false, '错误附完整 doctor 报告')
        return true
      },
    )

    // 旧实例保持可用：仍是启用态，动作照常返回旧值
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-keep')?.enabled, true)
    const probe = (await app.kernel.plugins.invokeAction('dx-keep', 'probe', {})) as {
      value: string
    }
    assert.equal(probe.value, 'v1', '旧实例代码继续服务')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：内置插件 403 拒绝', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('builtin:profile'),
      (err: unknown) =>
        err instanceof HostHelmError && err.code === 'plugin_locked' && err.status === 403,
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：未注册插件 404', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-never-exists'),
      (err: unknown) => err instanceof HostHelmError && err.code === 'unknown_plugin',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：在途任务 409 拒绝（在途工具执行期间）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-busy')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-busy')

    // 构造在途任务：withTask 包裹期间触发 reload
    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    const task = app.kernel.plugins.withTask('dx-busy', 'dx-test-busy', async () => gate)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-busy'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError)
        assert.equal(err.code, 'plugin_has_live_tasks')
        assert.equal(err.status, 409)
        return true
      },
    )
    await task
    // 在途任务结束后 reload 可成功
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-busy')
    assert.equal(result.pluginId, 'dx-busy')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：停用状态插件重载后保持停用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-off')
    app = await createApp(dataDir)
    // 默认停用（不 enable）
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-off')?.enabled, false)
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-off')
    assert.equal(result.wasEnabled, false)
    assert.equal(result.summary.enabled, false, '重载后保持停用')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor by id / reload 切换失败回滚
// ---------------------------------------------------------------------------

test('doctor by id：已注册插件按 id 解析源目录；未注册 id 404', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-docid-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-docid')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-docid')

    const report = await app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid' })
    assert.equal(report.ok, true, JSON.stringify(report.checks))
    assert.equal(report.requestedId, 'dx-docid')
    assert.ok(report.dir.endsWith('dx-docid'), `按 id 解析到源目录：${report.dir}`)
    assert.equal(report.pluginId, 'dx-docid')

    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-not-registered' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_source_missing',
    )
    // id 与 dir 互斥
    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid', dir: '/abs' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'validation_error',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload：新代码切换失败时回滚到旧实例（旧定义继续可用）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-rollback-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    // 插件 A（待重载）与插件 B（占用 slash 触发词 dxdupe）
    const dirA = join(dataDir, 'plugins', 'dx-a')
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-a')
    writeSlashPlugin(join(dataDir, 'plugins'), 'dx-b', 'dxdupe')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-a')
    await app.kernel.plugins.enable('dx-b')

    // 旧实例可用
    const v1 = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(v1.value, 'v1')

    // 新代码：doctor 可过（沙箱内无 B），但启用注册与 B 的 slash 冲突 -> 切换失败。
    // 保留原 handler 行为，追加冲突的 command 声明。
    const original = readFileSync(join(dirA, 'index.ts'), 'utf8')
    // 重命名原 definePlugin 为 baseDefine，再声明带冲突 slash 的新 definePlugin。
    const injected = original
      .replace('function definePlugin(ctx: any) {', 'function baseDefine(ctx: any) {')
      .replace(
        `export default { id: 'dx-a', name: 'DX 插件 dx-a', version: '0.1.0', definePlugin }`,
        `function definePlugin(ctx: any) {
  baseDefine(ctx)
  ctx.ui.command({ id: 'dupe-cmd', label: '冲突命令', slash: 'dxdupe', actionId: 'probe' })
}
export default { id: 'dx-a', name: 'DX 插件 dx-a', version: '0.1.0', definePlugin }`,
      )
    assert.notEqual(injected, original, '注入应生效（模板匹配失败时显式暴露）')
    writeFileSync(join(dirA, 'index.ts'), injected)

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-a'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError, `应抛 HelmError：${String(err)}`)
        assert.equal(err.code, 'plugin_reload_failed')
        const details = err.details as { rolledBack?: boolean }
        assert.equal(details?.rolledBack, true, '切换失败后应回滚到旧实例')
        return true
      },
    )

    // 回滚后：插件仍在清单且启用，旧代码继续服务
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-a')?.enabled, true, '回滚后保持启用')
    const probe = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(probe.value, 'v1', '回滚后旧实例代码继续服务')

    // 恢复无冲突代码后 reload 成功
    writeFileSync(join(dirA, 'index.ts'), original)
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-a')
    assert.equal(result.summary.enabled, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/** 带 commandPalette slash 声明的插件（用于跨插件唯一性冲突）。 */
function writeSlashPlugin(pluginsDir: string, dir: string, slash: string): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.action({
    id: 'noop',
    description: '空动作',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    idempotent: true,
    handler: () => ({ ok: true }),
  })
  ctx.ui.command({
    id: 'cmd',
    label: '命令',
    slash: ${JSON.stringify(slash)},
    actionId: 'noop',
  })
}
export default { id: '${dir}', definePlugin }
`,
  )
  return dirPath
}
