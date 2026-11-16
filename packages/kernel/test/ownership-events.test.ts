import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

// keep real tracker publish call back, determinism simulated after deletion only then reach async summary.
function summaryCallback(kernel: KernelRuntime): (summary: ConversationSummary) => void {
  const internals = kernel as unknown as {
    tracker: { events: { onSummaryChanged(summary: ConversationSummary): void } }
  }
  return internals.tracker.events.onSummaryChanged
}

test('after deletion late to tracker summary do not publish upsert re- conversation', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-ownership-events-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const conversation = await kernel.createConversation({ title: 'await delete background conversation' })
    kernel.markConversationOwnership(conversation.id, 'helm')
    const staleSummary = kernel.getConversation(conversation.id)
    const callback = summaryCallback(kernel)
    const frames: HelmEventFrame[] = []
    const unsubscribe = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      await kernel.deleteConversation(conversation.id)
      assert.ok(frames.some((frame) => frame.event.type === 'conversation.deleted'))
      frames.length = 0
      callback(staleSummary)
      assert.equal(frames.length, 0, 'deleted conversation late to summary cannot produce any new event')
      assert.ok(!kernel.listConversations().some((entry) => entry.id === conversation.id))
    } finally {
      unsubscribe()
    }
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('ownership document failed to read cannot fabricate human summary event', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-ownership-error-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const conversation = await kernel.createConversation({ title: 'ownership exception' })
    const frames: HelmEventFrame[] = []
    const unsubscribe = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      kernel.documentStore.set('conversation-ownership', null)
      assert.throws(() => summaryCallback(kernel)(conversation))
      assert.equal(frames.filter((frame) => frame.event.type === 'conversation.upsert').length, 0)
    } finally {
      kernel.documentStore.set('conversation-ownership', {})
      unsubscribe()
    }
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
