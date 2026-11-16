/**
 * ConversationDetailService 并行化测试（faux host，确定性时序）：
 * - contextUsage 刷新（ensureContextUsage）与时间线分页并行；ensure 慢、
 *   detail 腿先完成时，两腿完成后重取的权威摘要合并进最终 detail
 *   （并行窗内抢先读取的旧摘要不得丢失新刷出的 contextUsage）；
 * - ensure 腿失败：整体拒绝，绝不返回伪造详情（Promise.all 传播）；
 * - detail 腿失败：同样整体拒绝。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationDetailService } from '../src/runtime/conversation-detail.js'

interface HostState {
  summary: ConversationSummary
  entries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>
  ensureDelayMs: number
  ensureError?: Error
}

function summaryOf(id: number, withUsage: boolean): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(withUsage ? { contextUsage: { tokens: 1234 } as never } : {}),
  }
}

function makeService(state: HostState): ConversationDetailService {
  const fauxConversation = {
    entries: async (_opts: unknown, limit: number, _cursor: unknown) => ({
      items: state.entries.slice(0, limit) as never,
    }),
  }
  return new ConversationDetailService({
    harness: { conversation: async () => fauxConversation } as never,
    store: {} as never,
    stash: {} as never,
    // 权威摘要现读：assembleDetail 与并行合并两处都会调用——本测试用它模拟
    // 「contextUsage 在并行窗内被刷出」的时序。
    getConversation: () => state.summary,
    collectRewindIntervals: async () => [],
    ensureContextUsage: async () => {
      if (state.ensureError !== undefined) throw state.ensureError
      await new Promise((resolve) => setTimeout(resolve, state.ensureDelayMs))
      state.summary = summaryOf(state.summary.id, true)
    },
  })
}

test('并行合并：ensure 慢、detail 先完成，最终 detail 携带新刷出的 contextUsage', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [
      { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '答案' }] }] },
      { id: 1, kind: 'helm.input', data: { id: 'i1', text: '问' } },
    ],
    ensureDelayMs: 40,
  }
  const service = makeService(state)
  const detail = await service.getConversationDetail(5, { limit: 10 })
  assert.ok((detail as { contextUsage?: unknown }).contextUsage !== undefined, '合并后的摘要应携带 contextUsage')
  assert.equal(detail.entries.length, 2)
  // 降序收集后 reverse：时间线为时间升序（旧在前）
  assert.equal(detail.entries[0]!.kind, 'helm.input')
  assert.equal(detail.entries[1]!.kind, 'pi.assistant')
})

test('ensure 腿失败：整体拒绝，绝不返回伪造详情', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [],
    ensureDelayMs: 5,
    ensureError: new HelmError('runtime_closed', '内核正在关闭', 503),
  }
  const service = makeService(state)
  await assert.rejects(
    service.getConversationDetail(5, { limit: 10 }),
    (err: unknown) => err instanceof HelmError && err.code === 'runtime_closed',
  )
})

test('detail 腿失败：整体拒绝（404 会话不存在语义透传）', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [],
    ensureDelayMs: 40,
  }
  const service = new ConversationDetailService({
    harness: { conversation: async () => undefined } as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => state.summary,
    collectRewindIntervals: async () => [],
    ensureContextUsage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      state.summary = summaryOf(5, true)
    },
  })
  await assert.rejects(
    service.getConversationDetail(5, { limit: 10 }),
    (err: unknown) => err instanceof HelmError && err.code === 'not_found',
  )
})
