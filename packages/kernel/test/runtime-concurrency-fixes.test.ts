/**
 * concurrency defect fix regression test (runtime / model-registry layer).
 *
 * override:
 * - turn compute chain toxic: plugin turn_settled transform produce out illegal event payload when,
 *   dispatchTurnSettled must not reject(otherwise settledInflight aggregate chain by toxic,
 *   close  teardown interrupt,SQLite handle leak leak);
 * - dispatchInternalEvent one by one listener isolated (caller statement invoke do not await);
 * - start() single fly failed after can retry (startPromise leaves no residue stale reject);
 * - close() wait for in-flight start() converge (teardown do not and plugin start hand over wrong);
 * - plugin.changed  refreshPluginTools failed do not lose event;
 * - runtime provider deregister TOCTOU:rebuild await window inside new stream acquire explicit failed.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime, ModelRegistry } from '../src/runtime/index.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { CredentialService, ConfigService, ProviderService, SecretStash, ensureDataDir } from '../src/services/index.js'
import { deferred, makeFauxModels, useTempDir, waitFor } from './helpers.js'

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: ReturnType<typeof makeFauxModels>['faux'] }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
  return Object.assign(runtime, { __faux: faux })
}

test('turn_settled transform produce out illegal event payload: compute chain absorb error,close do not by toxic interrupt', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-settle-poison-')
  const kernel = await openRuntime(dataDir)
  try {
    await kernel.plugins.register({
      id: 'test:poison',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          // hook payload validate only inspect must want field: legal payload + extra BigInt field can through
          // transform pipeline, to events.publish  JSON redaction where only then explicit throws
          return { action: 'transform', value: { ...payload, poisoned: 10n } } as never
        })
      },
    })
    kernel.__faux.setResponses([fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')])
    await kernel.submitInput(1, 'one turn')
    await kernel.waitForIdle(1)
    await kernel.submitInput(1, 'second turn')
    await kernel.waitForIdle(1)
    // two turn all complete and compute chain do not is rejected:close internal three time await settledInflight,
    // fix before first time reject i.e. interrupt teardown(store/database/events close by skip).
    await kernel.close()
    assert.equal(kernel.getConversation(1).completionSeq, 2)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('dispatchInternalEvent one by one listener isolated: throws do not block assert after continue listener, also produces no unhandledRejection', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-internal-event-')
  const kernel = await openRuntime(dataDir)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    let secondRan = false
    kernel.onEvent('test:probe', async () => { throw new Error('a listener failed') })
    kernel.onEvent('test:probe', async () => { secondRan = true })
    // caller statement invoke (do not await do not catch) - - and plugin-host emitEvent same posture momentum
    void kernel.emitHostEvent('test:probe', { a: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await kernel.emitHostEvent('test:probe', { a: 2 })
    assert.equal(secondRan, true, 'before a listener throws must not block assert after continue listener')
    assert.equal(unhandled.length, 0, 'dispatchInternalEvent return promise must not reject')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await kernel.close()
  }
})

test('start() failed clear single fly handle: retry start all new attempt, while non- forever receives stale reject', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-start-retry-')
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    let startCalls = 0
    // note:pluginHost.start itself also has single fly leftover (do not in this time fix blank name single inside), this in
    // replace instance method with isolated verify KernelRuntime layer retry semantics.
    const host = kernel.plugins as unknown as { start: () => Promise<void> }
    host.start = async () => {
      startCalls += 1
      if (startCalls === 1) throw new Error('first time failed to start')
    }
    await assert.rejects(kernel.start(), /first time failed to start/)
    assert.equal(startCalls, 1)
    await kernel.start()
    assert.equal(startCalls, 2, 'retry must re- invoke pluginHost.start, while is not return cache stale reject')
  } finally {
    await kernel.close()
  }
})

test('close() wait for in-flight start() converge: service stop in start complete after,teardown do not and start hand over wrong', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-close-waits-start-')
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const order: string[] = []
    const startGate = deferred()
    await kernel.plugins.register({
      id: 'test:slow-start',
      definePlugin(ctx) {
        ctx.service({
          id: 'svc',
          async start() { order.push('start-begin'); await startGate.promise; order.push('start-end') },
          stop() { order.push('stop') },
        })
      },
    })
    const starting = kernel.start()
    await new Promise((resolve) => setTimeout(resolve, 25))
    // start still in-flight (service start by latch suspended) when start close
    const closing = kernel.close()
    startGate.resolve()
    await Promise.all([starting, closing])
    assert.deepEqual(order, ['start-begin', 'start-end', 'stop'], 'teardown must etc. start after completion again stop service')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('plugin.changed:refreshPluginTools throws do not block assert event publish', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-plugin-changed-')
  const kernel = await openRuntime(dataDir)
  try {
    ;(kernel as unknown as { refreshPluginTools: () => void }).refreshPluginTools = () => {
      throw new Error('tool hot install failed')
    }
    const seen: string[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string }
      if (event.type === 'plugin.changed') seen.push(event.type)
    })
    kernel.emitHostEvent('plugin.changed', { plugin: { id: 'test:hot', version: '1.0.0', enabled: true, locked: false } })
    assert.equal(seen.length, 1, 'hot install failed still must publish plugin.changed(client cannot lose plugin state change)')
  } finally {
    await kernel.close()
  }
})

test('provider deregister rebuild window inside: new stream acquire explicit failed (runtime_provider_retiring), no longer produce cannot detect in-flight stream', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-provider-retiring-')
  await ensureDataDir(dataDir)
  const providersSvc = new ProviderService(dataDir)
  const credentialsSvc = new CredentialService(dataDir)
  const configSvc = new ConfigService(dataDir)
  // latch providersSvc.list: 2 time (deregister rebuild) in window inside suspended, fabricate
  // usage check already,rebuild not completely await window
  let listCalls = 0
  const listGate = deferred()
  const gatedProviders = Object.create(providersSvc) as ProviderService
  ;(gatedProviders as unknown as { list: () => ReturnType<ProviderService['list']> }).list = async () => {
    listCalls += 1
    if (listCalls >= 2) await listGate.promise
    return providersSvc.list()
  }
  // get explicit points to original instance: its internal this.list() otherwise will mistakenly count gate control time count
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

  // start deregister and in rebuild window inside stop
  const unregistering = unregister()
  await waitFor(() => listCalls >= 2, { timeoutMs: 10_000, intervalMs: 10 })
  assert.equal(listCalls, 2, 'deregister rebuild should enter latch window')

  // window inside: old set still contains the provider, but new stream acquire must explicit failed
  const wrapped = current.getProvider('retire-p')
  assert.ok(wrapped, 'window inside old set still can seek address the provider')
  assert.throws(
    () => (wrapped as unknown as { stream: () => void }).stream(),
    (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_retiring' && err.status === 409,
  )

  listGate.resolve()
  await unregistering
  assert.ok(!registry.listModelProviders().some((p) => p.id === 'retire-p'), 'deregister after completion directory remove')
})
