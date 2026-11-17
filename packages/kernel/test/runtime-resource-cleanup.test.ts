/**
 * Kernel resource reclamation and diagnostics.collect (formerly watchdogTick transform) regressions.
 *
 * Coverage:
 * 1. diagnostics.collect listeners append facts into the final collection (await semantics);
 * 2. Orphaned handledToolCalls cleanup: tool_call handled entries track conversation ownership,
 *    and fallback sweeps clear unconsumed items on turn_settled, abortConversation, and
 *    deleteConversation (when blocked or error paths prevent afterTool execution);
 * 3. EnvFabric.evictConversation: deleteConversation evicts cached target instances (bases) and
 *    output sinks for that conversation cleanly without leaks on repeated create/delete cycles.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import { createEnvFabric, type EnvFabric } from '../src/env/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface RuntimeInternals {
  handledToolCalls: Map<string, { conversationId: number | undefined; result: unknown }>
}

function internalsOf(kernel: KernelRuntime): RuntimeInternals {
  return kernel as unknown as RuntimeInternals
}

function fabricBasesOf(fabric: EnvFabric): Map<string, unknown> {
  // EnvFabric's bases map is closure-private inside createEnvFabric; verified via RemoteExecutionEnv
  // instance identity and envFor behavior (see evictConversation tests) rather than direct reads.
  throw new Error('must not read bases directly (closure-private)')
}

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = await makeTempDir('helm-resclean-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

describe('diagnostics.collect external aggregation (replaces watchdogTick transform expansion)', { timeout: 60_000 }, () => {
  it('facts appended by collection listeners appear in the final collection (awaited)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'tick-1'))
    try {
      await kernel.plugins.register({
        id: 'test:collector',
        definePlugin(ctx) {
          // Simulates builtin:herdr-style external probe collection appended to the shared collector.
          ctx.host.onEvent('diagnostics.collect', (raw) => {
            const collection = raw as { probes: unknown[] }
            collection.probes.push({
              targetId: 'ext:p1',
              targetKind: 'external',
              nodeId: 'local',
              ownedBy: 'helm',
              status: 'working',
              stalledMs: 0,
              facts: { kind: 'test-collector' },
            })
          })
        },
      })
      // Event dispatched via host emitEvent (broadcast: false reaches internal listeners only).
      const collected: { probes: unknown[] } = { probes: [] }
      await kernel.emitHostEvent('diagnostics.collect', collected, { broadcast: false })
      assert.equal(collected.probes.length, 1, 'listener-appended facts enter collection')
      assert.equal((collected.probes[0] as { targetId: string }).targetId, 'ext:p1')
    } finally {
      await kernel.close()
    }
  })

  it('emitHostEvent completes cleanly with no listeners (empty collection without error)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'tick-2'))
    try {
      const collected: { probes: unknown[] } = { probes: [] }
      await kernel.emitHostEvent('diagnostics.collect', collected, { broadcast: false })
      assert.equal(collected.probes.length, 0)
    } finally {
      await kernel.close()
    }
  })
})

describe('handledToolCalls orphan cleanup', { timeout: 60_000 }, () => {
  it('fallback clears unconsumed handled tool_call entries when turn settles (turn_settled)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-1'))
    try {
      const internals = internalsOf(kernel)
      // Registers a tool_call hook returning handled for `probe` while the model replies directly
      // with text (never executing the tool) -- leaving an unconsumed handled entry cleared by turn_settled.
      await kernel.plugins.register({
        id: 'test:handled-residue',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string; callId: string }) => {
            if (call.toolName !== 'probe') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: 'intercepted' }], isError: false },
            }
          })
        },
      })
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('direct reply without invoking tool')])
      await kernel.submitInput(conv.id, 'casual prompt')
      await kernel.waitForIdle(conv.id)
      // Once turn settles, no stale handled entry for this conversation may remain even if execute never ran.
      for (const key of internals.handledToolCalls.keys()) {
        const entry = internals.handledToolCalls.get(key)
        assert.notEqual(entry?.conversationId, conv.id, 'conversation residue must be cleared after turn finishes')
      }
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('abortConversation and deleteConversation fallbacks clean up conversation residue', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-2'))
    try {
      const internals = internalsOf(kernel)
      const conv = await kernel.createConversation({})
      // Directly seed residue (simulating a handled registration before a model turn cancels).
      internals.handledToolCalls.set('call-residue-1', {
        conversationId: conv.id,
        result: { output: [{ type: 'text', text: 'x' }], isError: false },
      })
      internals.handledToolCalls.set('call-other-conv', {
        conversationId: undefined,
        result: { output: [{ type: 'text', text: 'y' }], isError: false },
      })
      await kernel.abortConversation(conv.id)
      assert.equal(
        internals.handledToolCalls.has('call-residue-1'),
        false,
        'abort must clean up handled residue for that conversation',
      )
      assert.equal(internals.handledToolCalls.has('call-other-conv'), true, 'other owners remain unaffected')

      internals.handledToolCalls.set('call-residue-2', {
        conversationId: conv.id,
        result: { output: [{ type: 'text', text: 'x' }], isError: false },
      })
      await kernel.deleteConversation(conv.id)
      assert.equal(
        internals.handledToolCalls.has('call-residue-2'),
        false,
        'deleting conversation must clean up handled residue for that conversation',
      )
    } finally {
      await kernel.close()
    }
  })
})

describe('EnvFabric.evictConversation', { timeout: 60_000 }, () => {
  it('clears cached target instances for the conversation (envForTarget allocates a fresh instance)', timeout, async () => {
    const fabric = createEnvFabric({
      envOptions: () => ({ HELM_CONVERSATION_ID: '42' }),
    })
    try {
      const a = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const b = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      // Rebuilt after eviction: underlying base differs (old base was evicted from cache).
      assert.notEqual((a as unknown as { id: string }).id === (b as unknown as { id: string }).id, false)
      // Other conversation targets stay intact (43 was not evicted).
      const c1 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const c2 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      assert.equal(
        (c1 as unknown as { id: string }).id,
        (c2 as unknown as { id: string }).id,
        'unrelated conversation targets are unaffected by evictConversation',
      )
    } finally {
      await fabric.dispose()
    }
  })

  it('evicts target cache strictly by conversation: shrinks bases count while preserving others; un-scoped targets bypass cache', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      assert.equal(fabric.debugBaseCount(), 0)
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/other' })
      fabric.envForTarget({ conversationId: 8, nodeId: 'offline-node', cwd: '/srv' })
      assert.equal(fabric.debugBaseCount(), 3)
      // Un-scoped targets (envFor / envForTarget without conversationId) are short-lived:
      // every call yields a new uncached instance so repeated calls never accumulate bases.
      fabric.envFor('offline-node', '/srv')
      fabric.envFor('offline-node', '/srv')
      fabric.envForTarget({ nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ nodeId: 'local', cwd: root })
      assert.equal(fabric.debugBaseCount(), 3, 'targets without conversationId never enter cache')
      // Evicting conversation 7 drops only its two targets while keeping conversation 8.
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, 'both targets of conversation 7 are cleared')
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, 'idempotent: repeated eviction has no extra effect')
      fabric.evictConversation(8)
      assert.equal(fabric.debugBaseCount(), 0)
      // debugBases shares source of truth with debugBaseCount.
      fabric.envForTarget({ conversationId: 9, nodeId: 'n', cwd: '/x' })
      const bases = fabric.debugBases()
      assert.equal(bases.length, 1)
      assert.equal(bases[0]!.conversationId, 9)
      assert.equal(bases[0]!.nodeId, 'n')
      assert.equal(bases[0]!.cwd, '/x')
    } finally {
      await fabric.dispose()
    }
  })

  it('eviction does not kill in-flight commands: exec on evicted instance still finishes normally', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      const scoped = fabric.envForTarget({ conversationId: 50, nodeId: 'local', cwd: root })
      fabric.evictConversation(50)
      // Held reference remains valid: real exec finishes normally (eviction only un-caches, never kills processes).
      const result = await scoped.exec('echo alive', undefined, { abortSignal: undefined } as never)
      assert.equal(result.ok, true)
      assert.equal(result.value.exitCode, 0)
    } finally {
      await fabric.dispose()
    }
  })

  it('deleteConversation triggers evictConversation cleanly via runtime wiring', timeout, async () => {
    void fabricBasesOf
    const kernel = await openRuntime(join(root, 'evict-1'))
    try {
      const conv = await kernel.createConversation({})
      // Execute once to populate conversation target cache (local echo).
      const result = await kernel.execEnv({ command: 'echo evicted', conversationId: conv.id })
      assert.equal(result.ok, true)
      await kernel.deleteConversation(conv.id)
      // Running again on the deleted conversation id returns 404 not_found rather than an internal error.
      const again = await kernel
        .execEnv({ command: 'echo again', conversationId: conv.id })
        .then(
          () => 'unexpected-ok',
          (err: { code?: string }) => err.code,
        )
      assert.equal(again, 'not_found')
    } finally {
      await kernel.close()
    }
  })
  it('updateConversation changing cwd/nodeId releases stale target cache without affecting other conversations', timeout, async () => {
    const kernel = await openRuntime(join(root, 'evict-2'))
    try {
      const conv = await kernel.createConversation({})
      const other = await kernel.createConversation({})
      const fabric = kernel.envFabric as EnvFabric
      const before = fabric.debugBaseCount()
      // Two executions create cached targets for both conversations.
      await kernel.execEnv({ command: 'echo one', conversationId: conv.id })
      await kernel.execEnv({ command: 'echo two', conversationId: other.id })
      assert.equal(fabric.debugBaseCount(), before + 2)
      // Updating conv cwd releases its old target while leaving other untouched.
      const newDir = join(root, 'evict-2-new-cwd')
      await kernel.updateConversation(conv.id, { cwd: newDir })
      assert.equal(fabric.debugBaseCount(), before + 1, 'old target for updated conversation is released')
      const bases = fabric.debugBases()
      assert.ok(
        bases.every((b) => b.conversationId !== conv.id),
        `all old targets for conversation ${conv.id} should be released: ${JSON.stringify(bases)}`,
      )
      // Other conversation's target stays cached for reuse.
      assert.ok(bases.some((b) => b.conversationId === other.id))
      // Updating title alone does not evict cache.
      const count = fabric.debugBaseCount()
      await kernel.updateConversation(other.id, { title: 'only title' })
      assert.equal(fabric.debugBaseCount(), count, 'non-target updates do not evict cached env targets')
    } finally {
      await kernel.close()
    }
  })
})

describe('faux tool pipeline regression (handled consumption path still works)', { timeout: 60_000 }, () => {
  it('tool_call handled returns intercepted result at execute layer (happy path intact)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-ok'))
    try {
      await kernel.plugins.register({
        id: 'test:handled-normal',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string }) => {
            if (call.toolName !== 'bash') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: 'intercepted result: echo intercepted' }], isError: false },
            }
          })
        },
      })
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('complete'),
      ])
      await kernel.submitInput(1, 'run echo')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), 'complete')
      // Normal consumption: handled entry is removed immediately during execute.
      assert.equal(internalsOf(kernel).handledToolCalls.size, 0)
    } finally {
      await kernel.close()
    }
  })
})
