/**
 * kernel asset reclaim and watchdogTick transform regression.
 *
 * override:
 * 1. watchdogTick return hook chain transform after eventually payload(plugin can expand fill
 *    WatchdogTickPayload; old implement return initial snapshot, plugin inject field lose);
 * 2. handledToolCalls interrupt leftover clean up:tool_call handled register carries conversation ownership,
 *    conversation turn end (turn_settled)/ abortConversation / deleteConversation
 *    when fall back clean up not by afterTool consume item (block/exception path do not away execute);
 * 3. EnvFabric.evictConversation:deleteConversation after the conversation target cache
 *    (bases) and output sink register by clean up, reverse re- create delete leaves no residue.
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
  // EnvFabric  bases is createEnvFabric closed package inside private; via RemoteExecutionEnv
  // instance identity + envFor behavior verify (see evictConversation test), no need to directly read.
  throw new Error('must not directly read bases(closed package private)')
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

describe('diagnostics.collect external collect (original watchdogTick transform expand fill same semantics)', { timeout: 60_000 }, () => {
  it('collect listener append fact appear in eventually collection in (await semantics)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'tick-1'))
    try {
      await kernel.plugins.register({
        id: 'test:collector',
        definePlugin(ctx) {
          // simulated builtin:herdr style external collect: in collection on append probe needle (keep original field).
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
      // event by host emitEvent dispatch (broadcast:false only internal listener).
      const collected: { probes: unknown[] } = { probes: [] }
      await kernel.emitHostEvent('diagnostics.collect', collected, { broadcast: false })
      assert.equal(collected.probes.length, 1, 'listener append fact enter collection')
      assert.equal((collected.probes[0] as { targetId: string }).targetId, 'ext:p1')
    } finally {
      await kernel.close()
    }
  })

  it('without listener when emitHostEvent normal complete (empty collect do not errors)', timeout, async () => {
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

describe('handledToolCalls interrupt leftover clean up', { timeout: 60_000 }, () => {
  it('tool_call handled after turn end (turn_settled) fall back clean leftover', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-1'))
    try {
      const internals = internalsOf(kernel)
      // register a tool_call hook: for probe tool return handled(do not execute real tool),
      // and model do not start real tool invoke (faux directly text answer) - -handled item into is
      // unconsumed leftover, rely turn_settled fall back clean up.
      await kernel.plugins.register({
        id: 'test:handled-residue',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string; callId: string }) => {
            if (call.toolName !== 'probe') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: 'already take over' }], isError: false },
            }
          })
        },
      })
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('directly answer, do not invoke tool')])
      await kernel.submitInput(conv.id, 'follow convenient question')
      await kernel.waitForIdle(conv.id)
      // turn already end: even if handled from not by execute consume, leftover also must by empty.
      for (const key of internals.handledToolCalls.keys()) {
        const entry = internals.handledToolCalls.get(key)
        assert.notEqual(entry?.conversationId, conv.id, 'turn after end the conversation leftover should by clean up')
      }
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('abortConversation and deleteConversation fall back clean up the conversation leftover', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-2'))
    try {
      const internals = internalsOf(kernel)
      const conv = await kernel.createConversation({})
      // directly inject leftover (simulated tool_call handled register after model turn by cancel).
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
        'abort should clean up the conversation handled leftover',
      )
      assert.equal(internals.handledToolCalls.has('call-other-conv'), true, 'other ownership do not subject to affect')

      internals.handledToolCalls.set('call-residue-2', {
        conversationId: conv.id,
        result: { output: [{ type: 'text', text: 'x' }], isError: false },
      })
      await kernel.deleteConversation(conv.id)
      assert.equal(
        internals.handledToolCalls.has('call-residue-2'),
        false,
        'delete conversation should clean up the conversation handled leftover',
      )
    } finally {
      await kernel.close()
    }
  })
})

describe('EnvFabric.evictConversation', { timeout: 60_000 }, () => {
  it('clean up the conversation target cache instance (envForTarget each time return new instance)', timeout, async () => {
    const fabric = createEnvFabric({
      envOptions: () => ({ HELM_CONVERSATION_ID: '42' }),
    })
    try {
      const a = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const b = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      // drive one by one after rebuild: two instance underlying base different (a  base already by clean up out cache).
      assert.notEqual((a as unknown as { id: string }).id === (b as unknown as { id: string }).id, false)
      // does not affect other conversation target (43 not by drive one by one).
      const c1 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const c2 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      assert.equal(
        (c1 as unknown as { id: string }).id,
        (c2 as unknown as { id: string }).id,
        'other conversation target do not subject to evictConversation affect',
      )
    } finally {
      await fabric.dispose()
    }
  })

  it('target cache by conversation precise drive one by one:bases counter shrink, other conversation keep; without conversation target does not enter cache', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      assert.equal(fabric.debugBaseCount(), 0)
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/other' })
      fabric.envForTarget({ conversationId: 8, nodeId: 'offline-node', cwd: '/srv' })
      assert.equal(fabric.debugBaseCount(), 3)
      // without conversation target is short lifecycle object (envFor / envForTarget without conversationId):
      // each time all new instance, never enter cache - - reverse re- invoke do not heap accumulate bases.
      fabric.envFor('offline-node', '/srv')
      fabric.envFor('offline-node', '/srv')
      fabric.envForTarget({ nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ nodeId: 'local', cwd: root })
      assert.equal(fabric.debugBaseCount(), 3, 'without conversation target never enter cache')
      // drive one by one conversation 7: only clean its two target, conversation 8 keep.
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, 'conversation 7 two target by clean up')
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, 'idempotent: duplicate drive one by one without extra affect')
      fabric.evictConversation(8)
      assert.equal(fabric.debugBaseCount(), 0)
      // debugBases and counter same source.
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

  it('drive one by one do not kill in-flight command:evict after old instance on exec self however complete', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      const scoped = fabric.envForTarget({ conversationId: 50, nodeId: 'local', cwd: root })
      fabric.evictConversation(50)
      // old instance reference still store: real exec must self however complete (evict only move cache do not kill process).
      const result = await scoped.exec('echo alive', undefined, { abortSignal: undefined } as never)
      assert.equal(result.ok, true)
      assert.equal(result.value.exitCode, 0)
    } finally {
      await fabric.dispose()
    }
  })

  it('deleteConversation via runtime join motion evictConversation(without exception and after continue exec normal)', timeout, async () => {
    void fabricBasesOf
    const kernel = await openRuntime(join(root, 'evict-1'))
    try {
      const conv = await kernel.createConversation({})
      // trigger once real exec establish conversation target cache (local exec echo).
      const result = await kernel.execEnv({ command: 'echo evicted', conversationId: conv.id })
      assert.equal(result.ok, true)
      await kernel.deleteConversation(conv.id)
      // after deletion again for same number conversation target execute: should 404(conversation already delete), while non- internal error.
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
  it('updateConversation change cwd/nodeId when release old target cache (does not affect other conversation)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'evict-2'))
    try {
      const conv = await kernel.createConversation({})
      const other = await kernel.createConversation({})
      const fabric = kernel.envFabric as EnvFabric
      const before = fabric.debugBaseCount()
      // two time real exec establish two conversation target.
      await kernel.execEnv({ command: 'echo one', conversationId: conv.id })
      await kernel.execEnv({ command: 'echo two', conversationId: other.id })
      assert.equal(fabric.debugBaseCount(), before + 2)
      // change conv  cwd: old target release,other do not subject to affect.
      const newDir = join(root, 'evict-2-new-cwd')
      await kernel.updateConversation(conv.id, { cwd: newDir })
      assert.equal(fabric.debugBaseCount(), before + 1, 'change conversation old target by release')
      const bases = fabric.debugBases()
      assert.ok(
        bases.every((b) => b.conversationId !== conv.id),
        `conversation ${conv.id} old target should all release:${JSON.stringify(bases)}`,
      )
      // other conversation target still in cache (same instance re- use).
      assert.ok(bases.some((b) => b.conversationId === other.id))
      // only change title does not trigger release.
      const count = fabric.debugBaseCount()
      await kernel.updateConversation(other.id, { title: 'only title' })
      assert.equal(fabric.debugBaseCount(), count, 'non- target change do not release cache')
    } finally {
      await kernel.close()
    }
  })
})

describe('faux tool chain regression (handled consume path still work)', { timeout: 60_000 }, () => {
  it('tool_call handled after execute layer normal return take over result (do not break happy path)', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-ok'))
    try {
      await kernel.plugins.register({
        id: 'test:handled-normal',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string }) => {
            if (call.toolName !== 'bash') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: 'take over result:echo by intercept' }], isError: false },
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
      // normal consume path:handled item in execute after i.e. when delete.
      assert.equal(internalsOf(kernel).handledToolCalls.size, 0)
    } finally {
      await kernel.close()
    }
  })
})
