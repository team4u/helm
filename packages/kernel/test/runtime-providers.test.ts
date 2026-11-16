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

test('external inject model collection in directory and hot reload in keep caller ownership', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-external-providers-'))
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'fixture-external' }] }).provider)
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, models, autoResume: false })
    const initial = (await kernel.listModels()).models
    await kernel.credentials.set('deepseek', 'fixture-unused')
    await kernel.reloadModels()
    assert.deepEqual((await kernel.listModels()).models, initial)
    assert.deepEqual(kernel.listModelProviders().map((provider) => provider.id), ['faux'])
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('all amount provider start load, increase delete secret key hot update and failed to read not silently fall back', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-provider-registry-'))
  const previousEnv = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  const credentials = new CredentialService(dataDir)
  await credentials.set('deepseek', 'fixture-deepseek-startup')
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    assert.equal(kernel.listModelProviders().length, builtinProviders().length)
    const entries = () => kernel!.listModels().then((catalog) => catalog.models.filter((entry) => entry.provider === 'deepseek'))
    const initial = await entries()
    assert.ok(initial.length > 0)
    assert.ok(initial.every((entry) => entry.available), 'non- OpenAI/Anthropic credentials also must in at startup load')

    await credentials.delete('deepseek')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => !entry.available), 'delete secret key cannot continue re- use old cache')

    await credentials.set('deepseek', 'fixture-deepseek-reloaded')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => entry.available), 'new increase inside placement provider secret key no need to providers.json item')

    const path = join(dataDir, 'credentials.json')
    const validStore = await readFile(path, 'utf8')
    try {
      await writeFile(path, '{invalid-json')
      await assert.rejects(() => kernel!.reloadModels(), /JSON|parse|illegal/)
      assert.ok((await entries()).every((entry) => entry.available), 'failed to read must not publish half into product or model static default mark recorded as unavailable')
    } finally { await writeFile(path, validStore) }
  } finally {
    await kernel?.close()
    if (previousEnv === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousEnv
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('runtime provider register: directory/ownership/conflict reject/idempotent deregister/event publish', { timeout: 60_000 }, async () => {
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

    // directory and ownership immediately visible.
    assert.deepEqual(
      (await kernel.listModels()).models.filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )
    const summary = kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx')
    assert.equal(summary?.pluginId, 'builtin:demo')
    assert.ok(events.some((event) => event.type === 'models.changed'), 'register after publish models.changed')

    // conflict reject: other owner / inside placement / providers.json same id(contains not enabled) all 409, does not override.
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
    // conflict reject after directory not by override.
    assert.deepEqual(
      (await kernel.listModels()).models.filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )

    // providers.json hot reload keep runtime provider.
    await kernel.reloadModels()
    assert.ok(kernel.listModelProviders().some((provider) => provider.id === 'plugin-fx'))

    // idempotent deregister: second invoke empty operation; directory remove and event again publish.
    events.length = 0
    await unregister()
    await unregister()
    assert.equal(kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx'), undefined)
    assert.ok(events.some((event) => event.type === 'models.changed'), 'deregister after publish models.changed')
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('runtime provider in-flight stream counter and teardown preflight (busy 409 / settled after let through)', { timeout: 60_000 }, async () => {
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
    await kernel.submitInput(1, 'test in-flight model request')
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
    // on once because busy while failed release handle still can retry; old handle cannot delete same name new register.
    await unregister()
    const replacement = fauxProvider({ provider: 'plugin-busy', models: [{ id: 'replacement' }] })
    const unregisterReplacement = await kernel.registerRuntimeProvider(replacement.provider, 'builtin:busy')
    await unregister()
    assert.deepEqual((await kernel.listModels()).models.filter((entry) => entry.provider === 'plugin-busy').map((entry) => entry.modelId), ['replacement'])
    await unregisterReplacement()
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('plugin deactivate enter service stop after reject new model refresh, avoid preflight after unload race', { timeout: 60_000 }, async () => {
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
    // runtime self create host is deferServices pattern: explicit start after service only then truly start
    //(produce path kernel.start in plugin all register after unify invoke), then disable only then will
    // enter service stop(stop and start match for).
    await kernel.start()
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

test('refreshModels: target filter pass-through,errors redaction,models.changed event and directory snapshot', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-refresh-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const events: Array<Record<string, unknown>> = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') events.push(event.payload as Record<string, unknown>)
    })

    // all amount refresh:radius not config credentials -> skip (do not errors); event providers: [].
    const full = await kernel.refreshModels()
    assert.equal(full.aborted, false)
    assert.deepEqual(full.providers, [])
    assert.ok(Array.isArray(full.models))
    assert.ok(full.providerCatalog.some((provider) => provider.id === 'radius'))
    assert.deepEqual(events.at(-1), { providers: [] })

    // designate providers: pass-through + event carry target manifest; unknown or static provider explicit reject.
    const scoped = await kernel.refreshModels({ providers: ['radius'] })
    assert.deepEqual(scoped.providers, ['radius'])
    assert.deepEqual(events.at(-1), { providers: ['radius'] })
    await assert.rejects(kernel.refreshModels({ providers: ['fixture-missing-provider'] }), { code: 'model_provider_not_found' })
    await assert.rejects(kernel.refreshModels({ providers: ['openai'] }), { code: 'model_provider_static' })

    // runtime provider refreshModels error explicit enter errors(message original keep diagnose).
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

test('models-store.json corrupt when reloadModels explicit failed, not silently fall back empty directory', { timeout: 60_000 }, async () => {
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
    // start path same explicit failed (open inside offline restore read corrupt file).
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

test('provider deregister rebuild on failure keep register and ownership, fix cache after can retry', { timeout: 60_000 }, async () => {
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

test('external inject model collection: runtime register and refresh explicit unsupported, not silently succeeded', { timeout: 60_000 }, async () => {
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
