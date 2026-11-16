/**
 * ConversationDetailService parallel test (faux host, determinism when order):
 * - contextUsage refresh (ensureContextUsage) and timeline page parallel;ensure slow,
 *   detail leg first complete when, two leg after completion heavy take right threat summary merge enter eventually detail
 *   (parallel window inside grab first read old summary must not lose new refresh out contextUsage);
 * - ensure leg failed: whole reject, never return fabricate detail situation (Promise.all pass broadcast);
 * - detail leg failed: same whole reject.
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
    title: `conversation ${id}`,
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
    // right threat summary now read:assembleDetail and parallel merge two where all will invoke - - this test use it simulated
    // contextUsage in parallel window inside by refresh out when order.
    getConversation: () => state.summary,
    collectRewindIntervals: async () => [],
    ensureContextUsage: async () => {
      if (state.ensureError !== undefined) throw state.ensureError
      await new Promise((resolve) => setTimeout(resolve, state.ensureDelayMs))
      state.summary = summaryOf(state.summary.id, true)
    },
  })
}

test('parallel merge:ensure slow,detail first complete, eventually detail carry new refresh out contextUsage', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [
      { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer proposal' }] }] },
      { id: 1, kind: 'helm.input', data: { id: 'i1', text: 'question' } },
    ],
    ensureDelayMs: 40,
  }
  const service = makeService(state)
  const detail = await service.getConversationDetail(5, { limit: 10 })
  assert.ok((detail as { contextUsage?: unknown }).contextUsage !== undefined, 'merge after summary should carry contextUsage')
  assert.equal(detail.entries.length, 2)
  // drop order collect after reverse: timeline is time rise order (old in before)
  assert.equal(detail.entries[0]!.kind, 'helm.input')
  assert.equal(detail.entries[1]!.kind, 'pi.assistant')
})

test('ensure leg failed: whole reject, never return fabricate detail situation', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [],
    ensureDelayMs: 5,
    ensureError: new HelmError('runtime_closed', 'kernel is now close', 503),
  }
  const service = makeService(state)
  await assert.rejects(
    service.getConversationDetail(5, { limit: 10 }),
    (err: unknown) => err instanceof HelmError && err.code === 'runtime_closed',
  )
})

test('detail leg failed: whole reject (404 conversation missing semantics pass-through)', { timeout: 60_000 }, async () => {
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
