import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'

function createHostBackend(): PluginHostBackend {
  const unused = (): never => { throw new Error('本测试只验证 UI 启用，不应执行宿主业务操作') }
  return {
    dispatchTrigger: unused, submitInput: unused, createConversation: unused,
    listConversations: () => [], getConversation: unused, updateConversation: unused,
    abortConversation: unused, manageConversation: () => () => {},
    getConversationActivity: () => ({ consecutiveErrors: 0 }),
    getConversationOwnership: () => 'human' as const,
    isClosing: false,
    markConversationOwnership: unused, spawnAgent: unused, runGate: unused,
    prepareInterruptedConversations: unused, cleanupWorktree: unused,
    execEnv: unused, withFileMutationQueue: unused, prepareAction: unused, invokeAction: unused, listActions: () => [],
    createAsk: unused, cancelAsk: unused, registerAskSeqResolver: () => () => {},
    onEvent: () => () => {}, emitEvent: () => {},
  }
}

// 两次持久化都挂起后再放行，确定性覆盖「预检通过 → await → 最终发布」窗口。
test('并发启用重复 slash：只发布一个插件，失败方回滚持久开关且不残留贡献', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ui-activation-'))
  const enabled = new Map<string, boolean>()
  const docs = new Map<string, unknown>()
  let arrived = 0
  let release!: () => void
  let bothArrived!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { bothArrived = resolve })
  const host = new PluginHost({
    dataDir,
    host: createHostBackend(),
    docs: {
      get: <T>(key: string, initial: T): T => (docs.has(key) ? docs.get(key) as T : initial),
      set: (key, value) => { docs.set(key, value) },
      flush: async () => {},
    },
    config: {
      get: () => ({}),
      set: () => {},
      getEnabled: (id) => enabled.get(id),
      setEnabled: async (id, value) => {
        enabled.set(id, value)
        if (!value) return
        arrived++
        if (arrived === 2) bothArrived()
        await gate
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
    await ready
    release()
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
    release()
    await host.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
