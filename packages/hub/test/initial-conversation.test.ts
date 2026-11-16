/**
 * initial conversation can delete and default trigger delivery end-to-end verify (real createHelm + faux provider).
 *
 * override (root #1 special design remove after new contract):
 * - initial assistant conversation via HTTP/CLI delete succeeded (without id level exemption);
 * - delete after restart does not resurrect (tombstone + ensureInitialConversation skip);
 * - delete empty after (zero conversation) plugin action still available, new conversation can create;
 * - without explicit target trigger delivery to assistant most new ordinary conversation; all empty when on demand creates new;
 * - explicit designate deleted target  trigger explicit 404, not silently change throw;
 * - manageConversation manage right protect still takes effect (409 conversation_managed_by_plugin).
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'

import { startHub } from '../../kernel/src/http/index.js'
import { createHubTestApp, type HubTestApp } from './helpers/hub-test-env.js'

async function buildApp(dataDir: string, model = 'faux/faux-1') {
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir, model })
  return { faux, app }
}

function initialConvOf(app: HubTestApp) {
  const conv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  assert.ok(conv, 'initial assistant conversation should store in')
  return conv
}

test('initial conversation delete and default trigger delivery', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'helm-initial-del-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await t.test('delete initial human conversation (kernel API) succeeded and restart does not resurrect', { timeout: 60_000 }, async () => {
    const dir = join(root, 't1')
    const first = await buildApp(dir)
    const initial = initialConvOf(first.app)
    await first.app.kernel.deleteConversation(initial.id)
    assert.equal(
      first.app.kernel.listConversations().some((c) => c.id === initial.id),
      false,
      'after deletion immediately invisible',
    )
    await first.app.close()

    const second = await buildApp(dir)
    try {
      assert.equal(
        second.app.kernel.listConversations().some((c) => c.id === initial.id),
        false,
        'after restart must not re-, must not reseed',
      )
      assert.equal(second.app.kernel.listConversations().length, 0, 'delete empty after is zero conversation')
      // zero conversation under still can creates new
      const created = await second.app.kernel.createConversation({ title: 'new conversation', profileId: 'assistant' })
      assert.equal(typeof created.id, 'number')
    } finally {
      await second.app.close()
    }
  })

  await t.test('HTTP/CLI delete initial conversation succeeded', { timeout: 60_000 }, async () => {
    const dir = join(root, 't2')
    const { app } = await buildApp(dir)
    const hub = await startHub({ kernel: app.kernel as never, port: 0 })
    try {
      const token = app.kernel.auth.createProcessToken().token
      const initial = initialConvOf(app)
      const res = await fetch(`${hub.url}/api/conversations/${initial.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200, `HTTP delete initial conversation should 200:${await res.text()}`)
      const gone = await fetch(`${hub.url}/api/conversations/${initial.id}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(gone.status, 404)
    } finally {
      await hub.close()
      await app.close()
    }
  })

  await t.test('manageConversation manage right protect still takes effect (409)', { timeout: 60_000 }, async () => {
    const dir = join(root, 't3')
    const { app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      const release = app.kernel.manageConversation(initial.id, 'test:owner')
      await assert.rejects(
        () => app.kernel.deleteConversation(initial.id),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_managed_by_plugin',
      )
      release()
      await app.kernel.deleteConversation(initial.id)
    } finally {
      await app.close()
    }
  })

  await t.test('without explicit target trigger: delivery to assistant most new ordinary conversation', { timeout: 60_000 }, async () => {
    const dir = join(root, 't4')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      faux.setResponses([fauxAssistantMessage('receives by default event')])
      await app.kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron:test',
        text: 'by default target event',
        createdAt: Date.now(),
      })
      await app.kernel.waitForIdle(initial.id)
      const detail = await app.kernel.getConversationDetail(initial.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('by default target event')),
        'without explicit target event should enter assistant most new ordinary conversation',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('all delete empty after trigger on demand creates new conversation and delivery (concurrency-safe)', { timeout: 60_000 }, async () => {
    const dir = join(root, 't5')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      await app.kernel.deleteConversation(initial.id)
      faux.setResponses([fauxAssistantMessage('rebuild after answer')])
      await app.kernel.dispatchTrigger({
        id: 'evt-2',
        source: 'cron:rebuild',
        text: 'delete empty after by default event',
        createdAt: Date.now(),
      })
      const convs = app.kernel.listConversations().filter((c) => c.profileId === 'assistant')
      assert.equal(convs.length, 1, 'delete empty after default trigger should on demand creates new exactly a assistant conversation')
      await app.kernel.waitForIdle(convs[0]!.id)
      const detail = await app.kernel.getConversationDetail(convs[0]!.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('delete empty after by default event')),
        'creates new conversation should receives event',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('explicit designate deleted target  trigger explicit 404, not silently change throw', { timeout: 60_000 }, async () => {
    const dir = join(root, 't6')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      const deadId = initial.id
      const other = await app.kernel.createConversation({ title: 'other conversation', profileId: 'assistant' })
      await app.kernel.deleteConversation(deadId)
      faux.setResponses([fauxAssistantMessage('must not receives')])
      await assert.rejects(
        () =>
          app.kernel.dispatchTrigger({
            id: 'evt-3',
            source: 'webhook:stale',
            text: 'points to already delete conversation event',
            targetConversationId: deadId,
            createdAt: Date.now(),
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // other conversation not received (not silently change throw)
      const otherDetail = await app.kernel.getConversationDetail(other.id, { limit: 10 })
      assert.equal(
        otherDetail.entries.filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('points to already delete conversation event')).length,
        0,
        'expires target must not static default change throw other conversation',
      )
    } finally {
      await app.close()
    }
  })
})
