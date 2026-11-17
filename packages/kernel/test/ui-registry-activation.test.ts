import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { UiRegistry } from '../src/plugins/ui-registry.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, deferred, useTempDir } from './helpers.js'

function createHostBackend(): PluginHostBackend {
  const unused = (): never => { throw new Error('this test only verifies UI activation and must not execute host business operations') }
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: unused, submitInput: unused, createConversation: unused,
    listConversations: () => [], getConversation: unused, updateConversation: unused,
    abortConversation: unused, manageConversation: () => () => {},
    getConversationOwnership: () => 'human' as const,
    markConversationOwnership: unused, spawnAgent: unused, runGate: unused,
    execEnv: unused, withFileMutationQueue: unused,
    createAsk: unused, cancelAsk: unused, registerAskSeqResolver: () => () => {},
    onEvent: () => () => {}, emitEvent: () => {},
  }
}

// Suspend both persistence calls before releasing so the preflight -> await -> commit window overlaps deterministically.
test('concurrent enable with duplicate slash publishes only one plugin, rolls back loser toggle, and leaves zero UI contribution', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-ui-activation-')
  const enabled = new Map<string, boolean>()
  let arrived = 0
  const gate = deferred()
  const ready = deferred()
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: createHostBackend(),
    docs: new MemoryDocStore(),
    config: {
      get: () => ({}),
      set: () => {},
      getEnabled: (id) => enabled.get(id),
      setEnabled: async (id, value) => {
        enabled.set(id, value)
        if (!value) return
        arrived++
        if (arrived === 2) ready.resolve()
        await gate.promise
      },
    },
  })
  const plugin = (id: string): PluginDefinition => ({
    id,
    definePlugin(ctx) {
      ctx.ui.command({ id: 'run', title: 'Run', slash: 'same-word', actionId: 'run' })
    },
  })
  try {
    await host.register(plugin('test:first'), { enabled: false })
    await host.register(plugin('test:second'), { enabled: false })
    const pending = [host.enable('test:first'), host.enable('test:second')]
    await ready.promise
    gate.resolve()
    const results = await Promise.allSettled(pending)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    assert.ok(failed.reason instanceof HelmError)
    assert.equal(failed.reason.code, 'duplicate_command_slash')
    const plugins = host.list()
    const winner = plugins.find((item) => item.enabled)!
    const loser = plugins.find((item) => !item.enabled)!
    assert.equal(enabled.get(winner.id), true)
    assert.equal(enabled.get(loser.id), false)
    assert.deepEqual(host.listUi().map((item) => item.pluginId), [winner.id])
  } finally {
    gate.resolve()
    await host.dispose()
  }
})

test('UiRegistry: precompileClientModules caches hashes, updates on tracked recompile, and clears on clear/removePlugin', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-ui-hashes-')
  const clientRoot = join(dataDir, 'client')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function Main() { return "v1" }\n')
  writeFileSync(join(clientRoot, 'adhoc.tsx'), 'export function Adhoc() { return "adhoc" }\n')

  const ui = new UiRegistry(createPluginBuildProvider())
  ui.registerUi('p1', 'screen', { id: 's1', label: 'S1', client: { module: 'index.tsx', export: 'Main' } }, 'screen', clientRoot)
  ui.registerUi('p1', 'workbench.panel', { id: 'p1', label: 'P1', client: { module: 'index.tsx', export: 'Main' } }, 'workbenchPanel', clientRoot)
  assert.deepEqual(ui.getDeclaredClientModules('p1'), ['index.tsx'])

  const lifecycle = {
    identity: {},
    enabled: true,
    phase: 'idle',
    epoch: 1,
    clientRoot,
  }
  const opts = {
    getPluginLifecycle: (id: string) => (id === 'p1' ? lifecycle : undefined),
    dataDir,
    isDisposed: () => false,
  }

  await ui.precompileClientModules('p1', opts)
  const initialHashes = ui.getClientHashes('p1')
  assert.ok(initialHashes?.['index.tsx'])

  // Undeclared module fetch must not pollute clientHashes.
  await ui.getClientModule('p1', 'adhoc.tsx', opts)
  assert.deepEqual(ui.getClientHashes('p1'), initialHashes)

  // Tracked module edit + recompile keeps cached hash synchronized.
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function Main() { return "v2" }\n')
  const updated = await ui.getClientModule('p1', 'index.tsx', opts)
  assert.notEqual(updated.contentHash, initialHashes['index.tsx'])
  assert.deepEqual(ui.getClientHashes('p1'), { 'index.tsx': updated.contentHash })

  // Mismatched hash without chunk explicitly rejects client_module_stale.
  await assert.rejects(
    ui.getClientModule('p1', 'index.tsx', { ...opts, hash: initialHashes['index.tsx'] }),
    (err: unknown) => err instanceof HelmError && err.code === 'client_module_stale' && err.status === 409,
  )

  // clear() and removePlugin() both discard cached hashes.
  ui.clear('p1')
  assert.equal(ui.getClientHashes('p1'), undefined)
  ui.registerUi('p1', 'screen', { id: 's1', label: 'S1', client: { module: 'index.tsx', export: 'Main' } }, 'screen', clientRoot)
  await ui.precompileClientModules('p1', opts)
  assert.ok(ui.getClientHashes('p1')?.['index.tsx'])
  ui.removePlugin('p1')
  assert.equal(ui.getClientHashes('p1'), undefined)
})
