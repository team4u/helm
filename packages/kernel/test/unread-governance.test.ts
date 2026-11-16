/**
 * conversation not read governance integration test: turn compute unread policy zone person class and background derive sub-conversation.
 *
 * contract (emitSettled):
 * - top-level human direct connect conversation completed -> unread=true / status=done(since has semantics do not change);
 * - background derive sub-conversation (ownedBy=helm/bot and parentConversationId store in, such as managed
 *   subagent / SuperAgent Worker)completed -> unread=false / status=idle,
 *   do not fabricate person class not read noise sound; complete state and turn_settled event semantics consistent;
 * - person class fork(has parent chain but human ownership)completed -> unread=true(do not one blade cut);
 * - failed -> unread=false / status=error;aborted -> unread=false / status=idle
 *   (failed/abort contract lock).
 *
 * all real execute: true pi-durable SDK + SQLite + faux provider + true original generate spawn pipeline.
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, TurnSettledPayload } from '@helm/protocol'
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

/** register turn_settled collect plugin, return (by compute order) payload array. */
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
  root = await makeTempDir('helm-unread-governance-')
})

after(async () => {
  await cleanupDir(root)
})

describe('turn compute unread governance', { timeout: 60_000 }, () => {
  it('top-level human conversation completed:unread=true / done(since has semantics do not change)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('top-level answer')])
      await kernel.submitInput(1, 'top-level issue')
      await kernel.waitForIdle(1)
      const conv = kernel.getConversation(1)
      assert.equal(conv.unread, true)
      assert.equal(conv.status, 'done')
      assert.equal(conv.completionSeq, 1)
    } finally {
      await kernel.close()
    }
  })

  it('automatically subagent completed:unread=false / idle, state and event consistent; list filter dimension takes effect', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      const settled = await collectSettled(kernel)
      kernel.__faux.setResponses([fauxAssistantMessage('subagent answer')])
      const result = await kernel.spawnAgent({ parentConversationId: 1, prompt: 'sub- task' })
      assert.ok(result !== undefined)
      const child = kernel
        .listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, 'original generate spawn should create sub-conversation')
      await kernel.waitForIdle(child.id)

      const fresh = kernel.getConversation(child.id) as ConversationSummary & { ownedBy?: string }
      assert.equal(fresh.ownedBy, 'helm', 'original generate subagent ownership helm')
      assert.equal(fresh.parentConversationId, 1)
      assert.equal(fresh.unread, false, 'background subagent complete must not fabricate person class not read')
      assert.equal(fresh.status, 'idle', 'unread=false when complete state should be idle(and unread semantics consistent)')
      assert.equal(fresh.completionSeq, 1, 'complete watermark per common push enter')

      // event semantics consistent:turn_settled payload conversation terminal state and read interface same source.
      const childSettled = settled.find((p) => p.conversation.id === child.id)
      assert.ok(childSettled, 'subagent turn should exactly compute once')
      assert.equal(childSettled.outcome, 'completed')
      assert.equal(childSettled.conversation.unread, false)
      assert.equal(childSettled.conversation.status, 'idle')

      // parent conversation not by wave and (this turn not run): still without not read.
      const parent = kernel.getConversation(1)
      assert.equal(parent.unread, false)

      // process inside list filter dimension (HTTP drop noise server side implement):
      assert.ok(kernel.listConversations().some((c) => c.id === child.id), 'process inside without filter default still all amount')
      assert.ok(
        kernel.listConversations({ topLevelOnly: true }).every((c) => c.parentConversationId === undefined),
        'topLevelOnly should exclude sub-conversation',
      )
      assert.deepEqual(
        kernel.listConversations({ parentConversationId: 1 }).map((c) => c.id),
        [child.id],
        'parentConversationId precise match directly sub-conversation',
      )
    } finally {
      await kernel.close()
    }
  })

  it('person class fork(has parent chain,human ownership)completed:unread=true(do not one blade cut)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('original conversation answer'),
        fauxAssistantMessage('fork after answer'),
      ])
      await kernel.submitInput(1, 'original conversation issue')
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const entryId = Number(detail.entries[0]!.id)
      const forked = await kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork has parent chain')

      await kernel.submitInput(forked.id, 'fork after issue')
      await kernel.waitForIdle(forked.id)
      const fresh = kernel.getConversation(forked.id) as ConversationSummary & { ownedBy?: string }
      assert.notEqual(fresh.ownedBy, 'helm')
      assert.notEqual(fresh.ownedBy, 'bot')
      assert.equal(fresh.unread, true, 'person class fork complete still mark record not read')
      assert.equal(fresh.status, 'done')
    } finally {
      await kernel.close()
    }
  })

  it('failed contract:failed -> unread=false / error', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, 'trigger failed')
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'error')
      assert.equal(conv.unread, false, 'failed turn do not placement not read')
    } finally {
      await kernel.close()
    }
  })

  it('abort contract:aborted -> unread=false / idle', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('do not the need to second answer'),
      ])
      void kernel.submitInput(1, 'will by abort issue').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'idle')
      assert.equal(conv.unread, false, 'abort turn do not placement not read')
    } finally {
      await kernel.close()
    }
  })
})
