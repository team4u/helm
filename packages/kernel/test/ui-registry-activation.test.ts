import assert from 'node:assert/strict'
import test from 'node:test'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, deferred, useTempDir } from './helpers.js'

function createHostBackend(): PluginHostBackend {
  const unused = (): never => { throw new Error('this test only verify UI enable, must not execute host business operation') }
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

// two time persist all suspended after again let through, determinism override preflight via → await → eventually publish window.
test('concurrency enable duplicate slash: only publish a plugin, failed way rollback durable switch and leaves no residue contribution', { timeout: 60_000 }, async (t) => {
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
