/**
 * ConversationDetailService async decoupling test (faux host, deterministic):
 * - slow/suspended background contextUsage refresh never blocks `getConversationDetail`
 *   (timeline entries and current summary return immediately);
 * - background usage refresh failures never fail detail reads or leak unhandledRejection;
 * - already-cached contextUsage is included directly in the returned detail;
 * - missing conversation still rejects immediately with 404 without triggering refresh.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { ConversationDetailService } from '../src/runtime/conversation-detail.js'
import { deferred } from './helpers.js'

interface HostState {
  summary: ConversationSummary
  entries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>
  refreshGate?: ReturnType<typeof deferred<void>>
  refreshError?: Error
  scheduleCalls: number
  ensureCalls: number
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
    lastEntryId: 2,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(withUsage ? { contextUsage: { tokens: 1234 } as never } : {}),
  }
}

function makeService(
  state: HostState,
  opts: { useScheduleHost?: boolean; missingConversation?: boolean } = {},
): ConversationDetailService {
  const fauxConversation = {
    entries: async (_opts: unknown, limit: number, _cursor: unknown) => ({
      items: state.entries.slice(0, limit) as never,
    }),
  }
  return new ConversationDetailService({
    harness: {
      conversation: async () => (opts.missingConversation ? undefined : fauxConversation),
    } as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => state.summary,
    collectRewindIntervals: async () => [],
    ...(opts.useScheduleHost
      ? {
          scheduleContextUsage: () => {
            state.scheduleCalls += 1
          },
        }
      : {
          ensureContextUsage: async () => {
            state.ensureCalls += 1
            if (state.refreshGate !== undefined) {
              await state.refreshGate.promise
            }
            if (state.refreshError !== undefined) {
              throw state.refreshError
            }
            state.summary = summaryOf(state.summary.id, true)
          },
        }),
  })
}

test('async decoupling: suspended background contextUsage never blocks getConversationDetail', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [
      { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer proposal' }] }] },
      { id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'question' } },
    ],
    refreshGate: gate,
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state)

  // Detail returns immediately even while ensureContextUsage stays suspended on `gate`.
  const detail = await service.getConversationDetail(5, { limit: 10 })
  assert.equal(state.ensureCalls, 1, 'background contextUsage refresh should be triggered')
  assert.equal(detail.contextUsage, undefined, 'uncached usage is omitted on immediate return')
  assert.equal(detail.entries.length, 2)
  assert.equal(detail.entries[0]!.kind, 'helmx.input')
  assert.equal(detail.entries[1]!.kind, 'pi.assistant')

  // Once background calculation finishes, cached summary carries contextUsage for subsequent reads / upsert.
  gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  const next = await service.getConversationDetail(5, { limit: 10 })
  assert.deepEqual(next.contextUsage, { tokens: 1234 })
})

test('scheduleContextUsage host port is called fire-and-forget when provided', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(7, true),
    entries: [{ id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'q' } }],
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state, { useScheduleHost: true })
  const detail = await service.getConversationDetail(7, { limit: 10 })
  assert.equal(state.scheduleCalls, 1)
  assert.equal(state.ensureCalls, 0)
  assert.deepEqual(detail.contextUsage, { tokens: 1234 })
})

test('background ensureContextUsage failure does not reject getConversationDetail or leak unhandledRejection', { timeout: 60_000 }, async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const state: HostState = {
      summary: summaryOf(5, false),
      entries: [],
      refreshError: new HelmxError('runtime_closed', 'kernel is closing', 503),
      scheduleCalls: 0,
      ensureCalls: 0,
    }
    const service = makeService(state)
    const detail = await service.getConversationDetail(5, { limit: 10 })
    assert.equal(detail.id, 5)
    assert.equal(state.ensureCalls, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(unhandled.length, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('detail read failure: rejects overall (404 conversation missing) without triggering usage refresh', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [],
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state, { missingConversation: true })
  await assert.rejects(
    service.getConversationDetail(5, { limit: 10 }),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  assert.equal(state.ensureCalls, 0)
})
