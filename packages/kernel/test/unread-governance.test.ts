/**
 * Conversation unread governance integration tests: turn-settled unread policy distinguishes human vs background spawned sub-conversations.
 *
 * Contract (emitSettled):
 * - Top-level human direct conversation completed -> unread=true / status=done (existing semantics unchanged);
 * - Background spawned sub-conversation (ownedBy=helmx/bot and parentConversationId present, such as managed
 *   subagent / SuperAgent Worker) completed -> unread=false / status=idle,
 *   never fabricating human unread noise; completion state stays consistent with turn_settled event semantics;
 * - Human fork (has parent chain, human ownership) completed -> unread=true (not treated uniformly as background);
 * - failed -> unread=false / status=error; aborted -> unread=false / status=idle
 *   (failure/abort contract locked).
 *
 * Full real execution: real pi-durable SDK + SQLite + faux provider + real native spawn pipeline.
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, TurnSettledPayload } from '@helmx/protocol'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
  return Object.assign(runtime, { __faux: faux })
}

/** Registers a turn_settled collector plugin and returns the payload array ordered by settlement. */
async function collectSettled(kernel: KernelRuntime): Promise<TurnSettledPayload[]> {
  const settled: TurnSettledPayload[] = []
  await kernel.plugins.register({
    id: 'test:settled-collector',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        settled.push(payload)
      })
    },
  })
  return settled
}

let root: string

before(async () => {
  root = await makeTempDir('helmx-unread-governance-')
})

after(async () => {
  await cleanupDir(root)
})

describe('turn settlement unread governance', { timeout: 60_000 }, () => {
  it('top-level human conversation completed: unread=true / done (existing semantics unchanged)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('top-level answer')])
      await kernel.submitInput(1, 'top-level question')
      await kernel.waitForIdle(1)
      const conv = kernel.getConversation(1)
      assert.equal(conv.unread, true)
      assert.equal(conv.status, 'done')
      assert.equal(conv.completionSeq, 1)
    } finally {
      await kernel.close()
    }
  })

  it('autonomous subagent completed: unread=false / idle, state consistent with events; list filters take effect', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      const settled = await collectSettled(kernel)
      kernel.__faux.setResponses([fauxAssistantMessage('subagent answer')])
      const result = await kernel.spawnAgent({ parentConversationId: 1, prompt: 'subtask' })
      assert.ok(result !== undefined)
      const child = kernel
        .listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, 'native spawn should create child conversation')
      await kernel.waitForIdle(child.id)

      const fresh = kernel.getConversation(child.id) as ConversationSummary & { ownedBy?: string }
      assert.equal(fresh.ownedBy, 'helmx', 'native subagent is owned by helmx')
      assert.equal(fresh.parentConversationId, 1)
      assert.equal(fresh.unread, false, 'background subagent completion must not fabricate human unread state')
      assert.equal(fresh.status, 'idle', 'completion status when unread=false should be idle (matching unread semantics)')
      assert.equal(fresh.completionSeq, 1, 'completion sequence increments as normal')

      // Event semantics stay consistent: turn_settled payload terminal state matches the query interface.
      const childSettled = settled.find((p) => p.conversation.id === child.id)
      assert.ok(childSettled, 'subagent turn should settle once')
      assert.equal(childSettled.outcome, 'completed')
      assert.equal(childSettled.conversation.unread, false)
      assert.equal(childSettled.conversation.status, 'idle')

      // Parent conversation is unaffected (no turn executed): remains unread=false.
      const parent = kernel.getConversation(1)
      assert.equal(parent.unread, false)

      // In-process list filtering dimensions (backend implementation for HTTP noise reduction):
      assert.ok(kernel.listConversations().some((c) => c.id === child.id), 'in-process list without filter returns all conversations')
      assert.ok(
        kernel.listConversations({ topLevelOnly: true }).every((c) => c.parentConversationId === undefined),
        'topLevelOnly should exclude child conversations',
      )
      assert.deepEqual(
        kernel.listConversations({ parentConversationId: 1 }).map((c) => c.id),
        [child.id],
        'parentConversationId should match direct child conversations exactly',
      )
    } finally {
      await kernel.close()
    }
  })

  it('human fork (has parent chain, human ownership) completed: unread=true (not uniformly suppressed)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('original conversation answer'),
        fauxAssistantMessage('post-fork answer'),
      ])
      await kernel.submitInput(1, 'original conversation question')
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const entryId = Number(detail.entries[0]!.id)
      const forked = await kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork has parent chain')

      await kernel.submitInput(forked.id, 'post-fork question')
      await kernel.waitForIdle(forked.id)
      const fresh = kernel.getConversation(forked.id) as ConversationSummary & { ownedBy?: string }
      assert.notEqual(fresh.ownedBy, 'helmx')
      assert.notEqual(fresh.ownedBy, 'bot')
      assert.equal(fresh.unread, true, 'human fork completion still marks conversation unread')
      assert.equal(fresh.status, 'done')
    } finally {
      await kernel.close()
    }
  })

  it('failure contract: failed -> unread=false / error', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, 'trigger failure')
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'error')
      assert.equal(conv.unread, false, 'failed turn does not mark unread')
    } finally {
      await kernel.close()
    }
  })

  it('abort contract: aborted -> unread=false / idle', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('unneeded second answer'),
      ])
      void kernel.submitInput(1, 'question to be aborted').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'idle')
      assert.equal(conv.unread, false, 'aborted turn does not mark unread')
    } finally {
      await kernel.close()
    }
  })
})
