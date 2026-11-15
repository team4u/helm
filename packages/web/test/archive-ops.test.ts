import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import {
  archiveBatchNotice,
  patchConversationArchived,
  patchConversationsArchived,
} from '../src/shell/archive-ops.js'
import { ARCHIVED_TAG } from '../src/shell/sidebar-model.js'

function conv(id: number, tags: string[] = []): Pick<ConversationSummary, 'id' | 'tags'> {
  return { id, tags }
}

test('patchConversationArchived 保留其他 tags 并发送归档/恢复 PATCH', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify({ id: 7, tags: ['keep', ARCHIVED_TAG] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await patchConversationArchived(conv(7, ['keep']), true)
    await patchConversationArchived(conv(7, ['keep', ARCHIVED_TAG]), false)
    assert.deepEqual(requests, [
      { url: '/api/conversations/7', method: 'PATCH', body: { tags: ['keep', ARCHIVED_TAG] } },
      { url: '/api/conversations/7', method: 'PATCH', body: { tags: ['keep'] } },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('patchConversationsArchived 汇总批量部分失败，archiveBatchNotice 如实报告', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/2')) {
      return new Response(JSON.stringify({ error: { code: 'conflict', message: '会话正在更新' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const outcome = await patchConversationsArchived([conv(1), conv(2)], true)
    assert.deepEqual(outcome, {
      attempted: 2,
      fulfilled: 1,
      rejected: 1,
      firstError: '会话正在更新',
    })
    assert.deepEqual(archiveBatchNotice(true, outcome), {
      type: 'notification',
      level: 'warning',
      title: '批量归档部分失败',
      body: '成功 1 个，失败 1 个：会话正在更新',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
