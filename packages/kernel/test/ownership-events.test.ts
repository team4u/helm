import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationSummary, HelmxEventFrame } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

// Holds the real tracker emission callback to deterministically simulate an async summary arriving after deletion.
function summaryCallback(kernel: KernelRuntime): (summary: ConversationSummary) => void {
  const internals = kernel as unknown as {
    tracker: { events: { onSummaryChanged(summary: ConversationSummary): void } }
  }
  return internals.tracker.events.onSummaryChanged
}

test('late tracker summary after deletion never publishes upsert or resurrects conversation', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helmx-ownership-events-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const conversation = await kernel.createConversation({ title: 'background conversation to delete' })
    kernel.markConversationOwnership(conversation.id, 'helmx')
    const staleSummary = kernel.getConversation(conversation.id)
    const callback = summaryCallback(kernel)
    const frames: HelmxEventFrame[] = []
    const unsubscribe = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      await kernel.deleteConversation(conversation.id)
      assert.ok(frames.some((frame) => frame.event.type === 'conversation.deleted'))
      assert.equal(
        frames.some((frame) => frame.event.type === 'notification'),
        false,
        'deleteConversation must not emit UI notification events; clients react to conversation.deleted',
      )
      frames.length = 0
      callback(staleSummary)
      assert.equal(frames.length, 0, 'late summary for deleted conversation must produce zero new events')
      assert.ok(!kernel.listConversations().some((entry) => entry.id === conversation.id))
    } finally {
      unsubscribe()
    }
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('unreadable ownership document must never fabricate human summary event', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helmx-ownership-error-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const conversation = await kernel.createConversation({ title: 'ownership error' })
    const frames: HelmxEventFrame[] = []
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
