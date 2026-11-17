import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { createModels, type Provider } from '@earendil-works/pi-ai'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime, ModelRegistry } from '../src/runtime/index.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { CredentialService } from '../src/services/credentials.js'
import { ProviderService } from '../src/services/providers.js'
import { ConfigService, SecretStash, ensureDataDir } from '../src/services/index.js'
import { HelmError } from '@helm/protocol'
import { deferred, makeFauxModels, useTempDir, waitFor } from './helpers.js'

test('externally injected model catalog retains caller ownership across reloads', { timeout: 60_000 }, async () => {
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

test('full provider startup load, hot reload on key add/remove, and read failures without silent fallback', { timeout: 60_000 }, async () => {
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
    assert.ok(initial.every((entry) => entry.available), 'non-OpenAI/Anthropic credentials must also load at startup')

    await credentials.delete('deepseek')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => !entry.available), 'deleted API key must not continue reusing stale cache')

    await credentials.set('deepseek', 'fixture-deepseek-reloaded')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => entry.available), 'adding a built-in provider key requires no providers.json entry')

    const path = join(dataDir, 'credentials.json')
    const validStore = await readFile(path, 'utf8')
    try {
      await writeFile(path, '{invalid-json')
      await assert.rejects(() => kernel!.reloadModels(), /JSON|parse|illegal/)
      assert.ok((await entries()).every((entry) => entry.available), 'read failures must neither publish partial state nor silently mark models unavailable')
    } finally { await writeFile(path, validStore) }
  } finally {
    await kernel?.close()
    if (previousEnv === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousEnv
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('runtime provider registration: catalog/ownership/conflict rejection/idempotent unregister/event emission', { timeout: 60_000 }, async () => {
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

    // Catalog and ownership become immediately visible.
    assert.deepEqual(
      (await kernel.listModels()).models.filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )
    const summary = kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx')
    assert.equal(summary?.pluginId, 'builtin:demo')
    assert.ok(events.some((event) => event.type === 'models.changed'), 'emits models.changed after registration')

    // Conflict rejection: other owner / built-in / duplicate id in providers.json (even disabled) all 409 without overwriting.
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
    // Catalog remains untouched after conflict rejections.
    assert.deepEqual(
      (await kernel.listModels()).models.filter((entry) => entry.provider === 'plugin-fx').map((entry) => entry.modelId),
      ['fx-model'],
    )

    // Hot-reloading providers.json preserves runtime providers.
    await kernel.reloadModels()
    assert.ok(kernel.listModelProviders().some((provider) => provider.id === 'plugin-fx'))

    // Idempotent unregister: second call is a no-op; removes from catalog and re-emits event.
    events.length = 0
    await unregister()
    await unregister()
    assert.equal(kernel.listModelProviders().find((provider) => provider.id === 'plugin-fx'), undefined)
    assert.ok(events.some((event) => event.type === 'models.changed'), 'emits models.changed after unregistration')
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('runtime provider in-flight stream counter and teardown preflight (409 when busy, allowed once settled)', { timeout: 60_000 }, async () => {
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
    // Unregister handle rejected as busy once remains retryable; stale handle cannot remove a newly registered same-name provider.
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

test('disabling plugin rejects new model refreshes once service stop starts, avoiding post-preflight unload race', { timeout: 60_000 }, async () => {
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
    // Self-constructed runtime host uses deferServices: services start only after explicit kernel.start()
    // (production invokes kernel.start after all plugins register), so disable then triggers service stop
    // cleanly paired with start.
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

test('refreshModels: target filtering, error sanitization, models.changed event, and catalog snapshot', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-refresh-'))
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const events: Array<Record<string, unknown>> = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') events.push(event.payload as Record<string, unknown>)
    })

    // Full refresh: radius without credentials is skipped silently; event has providers: [].
    const full = await kernel.refreshModels()
    assert.equal(full.aborted, false)
    assert.deepEqual(full.providers, [])
    assert.ok(Array.isArray(full.models))
    assert.ok(full.providerCatalog.some((provider) => provider.id === 'radius'))
    assert.deepEqual(events.at(-1), { providers: [] })

    // Targeted providers: passes through + event carries target list; unknown or static providers reject explicitly.
    const scoped = await kernel.refreshModels({ providers: ['radius'] })
    assert.deepEqual(scoped.providers, ['radius'])
    assert.deepEqual(events.at(-1), { providers: ['radius'] })
    await assert.rejects(kernel.refreshModels({ providers: ['fixture-missing-provider'] }), { code: 'model_provider_not_found' })
    await assert.rejects(kernel.refreshModels({ providers: ['openai'] }), { code: 'model_provider_static' })

    // Runtime provider refreshModels failure populates errors map while preserving raw diagnostic message.
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

test('corrupted models-store.json causes reloadModels and startup to fail explicitly instead of resetting to empty catalog', { timeout: 60_000 }, async () => {
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
    // Startup path fails identically (open reads corrupted store offline).
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

test('provider unregister preserves registration and ownership when rebuild fails; retries cleanly once store is repaired', { timeout: 60_000 }, async () => {
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

test('externally injected model catalog rejects runtime registration and refresh explicitly rather than succeeding silently', { timeout: 60_000 }, async () => {
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

test('during provider unregister rebuild window: new stream acquisitions reject explicitly with runtime_provider_retiring', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-provider-retiring-')
  await ensureDataDir(dataDir)
  const providersSvc = new ProviderService(dataDir)
  const credentialsSvc = new CredentialService(dataDir)
  const configSvc = new ConfigService(dataDir)
  // Gate providersSvc.list: pause during the 2nd call (rebuild during unregister) to hold open the
  // window after busy-check passed and before catalog swap completes.
  let listCalls = 0
  const listGate = deferred()
  const gatedProviders = Object.create(providersSvc) as ProviderService
  ;(gatedProviders as unknown as { list: () => ReturnType<ProviderService['list']> }).list = async () => {
    listCalls += 1
    if (listCalls >= 2) await listGate.promise
    return providersSvc.list()
  }
  // Bind get directly to original instance so its internal this.list() does not pollute the call counter.
  ;(gatedProviders as unknown as { get: ProviderService['get'] }).get = (id) => providersSvc.get(id)

  let current = createModels()
  const published: string[] = []
  const registry = new ModelRegistry(
    {
      dataDir,
      providersSvc: gatedProviders,
      credentialsSvc,
      configSvc,
      stash: new SecretStash(),
      modelsStore: createFileModelsStore(dataDir),
      setModels: (m) => { current = m as typeof current },
      externalModels: false,
      events: { publish: (type) => { published.push(type) } },
      pluginHost: () => undefined,
      alignAllConversations: async () => {},
    },
    createModels(),
    {},
  )
  const { faux } = makeFauxModels({ provider: 'retire-p', models: [{ id: 'm1' }] })
  const unregister = await registry.registerRuntimeProvider(faux.provider, 'test:retire')
  assert.ok(published.includes('models.changed'))

  // Start unregistering and pause inside the rebuild window.
  const unregistering = unregister()
  await waitFor(() => listCalls >= 2, { timeoutMs: 10_000, intervalMs: 10 })
  assert.equal(listCalls, 2, 'unregister rebuild should pause at the gate window')

  // Inside window: old catalog still resolves the provider, yet new stream attempts reject explicitly.
  const wrapped = current.getProvider('retire-p')
  assert.ok(wrapped, 'provider remains addressable in old catalog during window')
  assert.throws(
    () => (wrapped as unknown as { stream: () => void }).stream(),
    (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_retiring' && err.status === 409,
  )

  listGate.resolve()
  await unregistering
  assert.ok(!registry.listModelProviders().some((p) => p.id === 'retire-p'), 'provider removed from catalog after unregister finishes')
})
