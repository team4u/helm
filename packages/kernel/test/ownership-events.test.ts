import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

// 保留真实 tracker 发布回调，确定性模拟删除后才到达的异步摘要。
function summaryCallback(kernel: KernelRuntime): (summary: ConversationSummary) => void {
  const internals = kernel as unknown as {
    tracker: { events: { onSummaryChanged(summary: ConversationSummary): void } }
  }
  return internals.tracker.events.onSummaryChanged
}

test('删除后迟到的 tracker 摘要不发布 upsert 复活会话', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-ownership-events-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false, watchdogIntervalMs: 0 })
  try {
    const conversation = await kernel.createConversation({ title: '待删除的后台会话' })
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
      assert.equal(frames.length, 0, '已删除会话的迟到摘要不能产生任何新事件')
      assert.ok(!kernel.listConversations().some((entry) => entry.id === conversation.id))
    } finally {
      unsubscribe()
    }
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('归属文档读取失败不能伪造 human 摘要事件', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-ownership-error-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false, watchdogIntervalMs: 0 })
  try {
    const conversation = await kernel.createConversation({ title: '归属异常' })
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
