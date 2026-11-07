import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { createModels, type Provider } from '@earendil-works/pi-ai'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import { CredentialService } from '../src/services/credentials.js'
import { ProviderService } from '../src/services/providers.js'
import { HelmError } from '@helm/protocol'

test('外部注入模型集在目录与热重载中保持调用方所有权', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-external-providers-'))
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'fixture-external' }] }).provider)
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, models, autoResume: false })
    const initial = await kernel.listModels()
    await kernel.credentials.set('deepseek', 'fixture-unused')
    await kernel.reloadModels()
    assert.deepEqual(await kernel.listModels(), initial)
    assert.deepEqual(kernel.listModelProviders().map((provider) => provider.id), ['faux'])
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('全量供应商启动加载、增删密钥热更新与读取失败不静默降级', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-provider-registry-'))
  const previousEnv = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  const credentials = new CredentialService(dataDir)
  await credentials.set('deepseek', 'fixture-deepseek-startup')
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    assert.equal(kernel.listModelProviders().length, builtinProviders().length)
    const entries = () => kernel!.listModels().then((catalog) => catalog.filter((entry) => entry.provider === 'deepseek'))
    const initial = await entries()
    assert.ok(initial.length > 0)
    assert.ok(initial.every((entry) => entry.available), '非 OpenAI/Anthropic 的凭据也必须在启动时加载')

    await credentials.delete('deepseek')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => !entry.available), '删除密钥不能继续复用旧缓存')

    await credentials.set('deepseek', 'fixture-deepseek-reloaded')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => entry.available), '新增内置供应商密钥无需 providers.json 条目')

    const path = join(dataDir, 'credentials.json')
    const validStore = await readFile(path, 'utf8')
    try {
      await writeFile(path, '{invalid-json')
      await assert.rejects(() => kernel!.reloadModels(), /JSON|解析|非法/)
      assert.ok((await entries()).every((entry) => entry.available), '读取失败不应发布半成品或把模型静默标记为不可用')
    } finally { await writeFile(path, validStore) }
  } finally {
    await kernel?.close()
    if (previousEnv === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousEnv
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('运行时供应商注册：目录/归属/冲突拒绝/幂等注销/事件发布', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-register-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const events: Array<{ type: string; payload: unknown }> = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') events.push({ type: event.type, payload: event.payload })
    })

    const faux = fauxProvider({ provider: 'plugin-fx', models: [{ id: 'fx-model' }] })
    const unregister = await kernel.registerRuntimeProvider(faux.provider, 'builtin:demo')

    // 目录与归属立即可见。
    assert.deepEqual(
      (await kernel.listModels()).filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )
    const summary = kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx')
    assert.equal(summary?.pluginId, 'builtin:demo')
    assert.ok(events.some((event) => event.type === 'models.changed'), '注册后发布 models.changed')

    // 冲突拒绝：其他 owner / 内置 / providers.json 同 id（含未启用）均 409，不覆盖。
    const other = fauxProvider({ provider: 'plugin-fx', models: [{ id: 'other' }] })
    await assert.rejects(
      () => kernel!.registerRuntimeProvider(other.provider, 'builtin:other'),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_conflict' && err.status === 409,
    )
    await assert.rejects(
      () => kernel!.registerRuntimeProvider(fauxProvider({ provider: 'deepseek', models: [{ id: 'x' }] }).provider),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_conflict' && err.status === 409,
    )
    const providersSvc = new ProviderService(dataDir)
    await providersSvc.save([
      { id: 'gw-x', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], enabled: false },
    ])
    await assert.rejects(
      () => kernel!.registerRuntimeProvider(fauxProvider({ provider: 'gw-x', models: [{ id: 'x' }] }).provider),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_conflict' && err.status === 409,
    )
    // 冲突拒绝后目录未被覆盖。
    assert.deepEqual(
      (await kernel.listModels()).filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )

    // providers.json 热重载保留运行时供应商。
    await kernel.reloadModels()
    assert.ok(kernel.listModelProviders().some((provider) => provider.id === 'plugin-fx'))

    // 幂等注销：二次调用空操作；目录移除且事件再次发布。
    events.length = 0
    await unregister()
    await unregister()
    assert.equal(kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx'), undefined)
    assert.ok(events.some((event) => event.type === 'models.changed'), '注销后发布 models.changed')
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('运行时供应商在途流计数与 teardown 预检（busy 409 / settled 后放行）', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-busy-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const faux = fauxProvider({ provider: 'plugin-busy', models: [{ id: 'busy-model' }] })
    const unregister = await kernel.registerRuntimeProvider(faux.provider, 'builtin:busy')
    kernel.assertRuntimeProvidersIdle('builtin:busy')

    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let answer!: (message: ReturnType<typeof fauxAssistantMessage>) => void
    const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { answer = resolve })
    faux.setResponses([async () => { entered(); return response }])
    await kernel.updateConversation(1, { model: 'plugin-busy/busy-model' })
    await kernel.submitInput(1, '测试在途模型请求')
    await started
    try {
      assert.throws(() => kernel!.assertRuntimeProvidersIdle('builtin:busy'), { code: 'plugin_has_live_tasks' })
      await assert.rejects(unregister(), { code: 'plugin_has_live_tasks' })
      assert.ok(kernel.listModelProviders().some((provider) => provider.id === 'plugin-busy'))
    } finally {
      answer(fauxAssistantMessage('done'))
      await kernel.waitForIdle(1)
    }
    kernel.assertRuntimeProvidersIdle('builtin:busy')
    // 上一次因忙而失败的释放句柄仍可重试；旧句柄不能删除同名的新注册。
    await unregister()
    const replacement = fauxProvider({ provider: 'plugin-busy', models: [{ id: 'replacement' }] })
    const unregisterReplacement = await kernel.registerRuntimeProvider(replacement.provider, 'builtin:busy')
    await unregister()
    assert.deepEqual((await kernel.listModels()).filter((entry) => entry.provider === 'plugin-busy').map((entry) => entry.modelId), ['replacement'])
    await unregisterReplacement()
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('插件停用进入服务 stop 后拒绝新模型刷新，避免预检后的卸载竞态', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-provider-stop-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  let stopEntered!: () => void
  let finishStop!: () => void
  const stopping = new Promise<void>((resolve) => { stopEntered = resolve })
  const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
  let disabling: Promise<void> | undefined
  try {
    await kernel.plugins.register({
      id: 'test:provider-stop',
      definePlugin(ctx) {
        ctx.provider(fauxProvider({ provider: 'stopping-provider', models: [{ id: 'fixture' }] }).provider)
        ctx.service({ id: 'fixture', start() {}, async stop() { stopEntered(); await stopGate } })
      },
    })
    disabling = kernel.plugins.disable('test:provider-stop')
    await stopping
    await assert.rejects(kernel.refreshModels({ providers: ['stopping-provider'] }), { code: 'plugin_disabled' })
    finishStop()
    await disabling
    assert.ok(!kernel.listModelProviders().some((provider) => provider.id === 'stopping-provider'))
  } finally {
    finishStop()
    await disabling?.catch(() => {})
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('refreshModels：目标过滤透传、errors 脱敏、models.changed 事件与目录快照', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-refresh-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const events: Array<Record<string, unknown>> = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') events.push(event.payload as Record<string, unknown>)
    })

    // 全量刷新：radius 未配置凭据 -> 跳过（不报错）；事件 providers: []。
    const full = await kernel.refreshModels()
    assert.equal(full.aborted, false)
    assert.deepEqual(full.providers, [])
    assert.ok(Array.isArray(full.models))
    assert.ok(full.providerCatalog.some((provider) => provider.id === 'radius'))
    assert.deepEqual(events.at(-1), { providers: [] })

    // 指定 providers：透传 + 事件携带目标清单；未知供应商忽略（SDK 语义）。
    const scoped = await kernel.refreshModels({ providers: ['radius'] })
    assert.deepEqual(scoped.providers, ['radius'])
    assert.deepEqual(events.at(-1), { providers: ['radius'] })

    // 运行时供应商 refreshModels 错误显式进入 errors（message 原样保留诊断）。
    const failing: Provider = {
      ...fauxProvider({ provider: 'plugin-fail', models: [{ id: 'fail-model' }] }).provider,
      refreshModels: async () => {
        throw new Error('gateway exploded')
      },
    }
    await kernel.registerRuntimeProvider(failing, 'builtin:failing')
    const withError = await kernel.refreshModels({ providers: ['plugin-fail'] })
    assert.equal(withError.errors['plugin-fail'], 'gateway exploded')
    assert.equal(withError.aborted, false)
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('models-store.json 损坏时 reloadModels 显式失败，不静默降级空目录', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-corrupt-store-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const path = join(dataDir, 'models-store.json')
    await writeFile(path, '{invalid-json')
    await assert.rejects(
      () => kernel!.reloadModels(),
      (err: unknown) => err instanceof HelmError && err.code === 'models_store_corrupted',
    )
    // 启动路径同样显式失败（open 内离线恢复读损坏文件）。
    await kernel.close()
    kernel = undefined
    await assert.rejects(
      () => KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false }),
      (err: unknown) => err instanceof HelmError && err.code === 'models_store_corrupted',
    )
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('供应商注销重建失败时保留注册和归属，修复缓存后可重试', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-unregister-retry-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const faux = fauxProvider({ provider: 'plugin-retry', models: [{ id: 'retry-model' }] })
    const unregister = await kernel.registerRuntimeProvider(faux.provider, 'test:retry')
    await writeFile(join(dataDir, 'models-store.json'), '{invalid')
    await assert.rejects(unregister(), { code: 'models_store_corrupted' })
    assert.equal(kernel.listModelProviders().find((provider) => provider.id === 'plugin-retry')?.pluginId, 'test:retry')
    await writeFile(join(dataDir, 'models-store.json'), '{}')
    await unregister()
    assert.ok(!kernel.listModelProviders().some((provider) => provider.id === 'plugin-retry'))
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('外部注入模型集：运行时注册与刷新显式 unsupported，不静默成功', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-external-unsupported-'))
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'fixture-external' }] }).provider)
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, models, autoResume: false })
    const faux = fauxProvider({ provider: 'plugin-x', models: [{ id: 'x' }] })
    await assert.rejects(
      () => kernel!.registerRuntimeProvider(faux.provider),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_unsupported',
    )
    await assert.rejects(
      () => kernel!.refreshModels(),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_unsupported',
    )
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
