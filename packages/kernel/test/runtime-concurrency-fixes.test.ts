/**
 * Regression tests for runtime / model-registry concurrency fixes:
 * - Turn settlement poisoning guard: when a plugin's turn_settled transform produces an invalid event
 *   payload, dispatchTurnSettled must not reject (otherwise settledInflight poisons subsequent
 *   settlements, aborts close() teardown, and leaks SQLite handles);
 * - dispatchInternalEvent isolates listener failures (unawaited fire-and-forget callers never fail);
 * - start() clears single-flight handle on failure so subsequent retries run cleanly without stuck rejects;
 * - close() waits for in-flight start() to settle so teardown never races plugin startup;
 * - refreshPluginTools errors during plugin.changed never drop the emitted event;
 * - runtime provider unregister TOCTOU: acquiring a stream during rebuild fails explicitly.
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

test('turn_settled transform producing invalid payload: settlement chain absorbs error without poisoning close()', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-settle-poison-')
  const kernel = await openRuntime(dataDir)
  try {
    await kernel.plugins.register({
      id: 'test:poison',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          // Hook validation only inspects required fields: valid payload + extra BigInt passes the transform
          // chain and throws explicitly only when events.publish performs JSON sanitization.
          return { action: 'transform', value: { ...payload, poisoned: 10n } } as never
        })
      },
    })
    kernel.__faux.setResponses([fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')])
    await kernel.submitInput(1, 'first turn')
    await kernel.waitForIdle(1)
    await kernel.submitInput(1, 'second turn')
    await kernel.waitForIdle(1)
    // Both turns complete and settlement chain never rejects: close() awaits settledInflight three times
    // (previously first rejection aborted teardown and skipped closing store/database/events).
    await kernel.close()
    assert.equal(kernel.getConversation(1).completionSeq, 2)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('dispatchInternalEvent isolates listener throws: subsequent listeners run and no unhandledRejection occurs', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-internal-event-')
  const kernel = await openRuntime(dataDir)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    let secondRan = false
    kernel.onEvent('test:probe', async () => { throw new Error('a listener failed') })
    kernel.onEvent('test:probe', async () => { secondRan = true })
    // Fire-and-forget invocation (without await/catch), matching plugin-host emitEvent call posture.
    void kernel.emitHostEvent('test:probe', { a: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await kernel.emitHostEvent('test:probe', { a: 2 })
    assert.equal(secondRan, true, 'first listener throwing must not block subsequent listeners')
    assert.equal(unhandled.length, 0, 'promise returned by dispatchInternalEvent must not reject')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await kernel.close()
  }
})

test('start() clears single-flight promise on failure so retries start a fresh attempt rather than rethrowing stale error', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-start-retry-')
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    let startCalls = 0
    // Note: pluginHost.start itself also holds a single-flight state; here we replace the instance
    // method to test KernelRuntime-layer retry semantics in isolation.
    const host = kernel.plugins as unknown as { start: () => Promise<void> }
    host.start = async () => {
      startCalls += 1
      if (startCalls === 1) throw new Error('first startup failure')
    }
    await assert.rejects(kernel.start(), /first startup failure/)
    assert.equal(startCalls, 1)
    await kernel.start()
    assert.equal(startCalls, 2, 'retry must invoke pluginHost.start again rather than returning cached rejection')
  } finally {
    await kernel.close()
  }
})

test('close() awaits in-flight start() convergence: services stop only after start finishes, preventing teardown races', { timeout: 60_000 }, async (t) => {
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
    // Begin closing while start() is still blocked inside service.start().
    const closing = kernel.close()
    startGate.resolve()
    await Promise.all([starting, closing])
    assert.deepEqual(order, ['start-begin', 'start-end', 'stop'], 'teardown must wait for start to finish before stopping services')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('plugin.changed emits even if refreshPluginTools throws', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-plugin-changed-')
  const kernel = await openRuntime(dataDir)
  try {
    ;(kernel as unknown as { refreshPluginTools: () => void }).refreshPluginTools = () => {
      throw new Error('tool hot-reload failed')
    }
    const seen: string[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string }
      if (event.type === 'plugin.changed') seen.push(event.type)
    })
    kernel.emitHostEvent('plugin.changed', { plugin: { id: 'test:hot', version: '1.0.0', enabled: true, locked: false } })
    assert.equal(seen.length, 1, 'plugin.changed must still emit on hot-reload failure so clients never miss state transitions')
  } finally {
    await kernel.close()
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
