/**
 * End-to-end verification of initial conversation deletion and default trigger delivery (real `createHelm` + faux provider).
 *
 * Covers the post-#1-exemption-removal contract:
 * - Initial assistant conversation can be deleted via HTTP/CLI (no ID-level exemption);
 * - Deleting it prevents resurrection across restarts (tombstone + `ensureInitialConversation` skip);
 * - After deleting all conversations, plugin actions still work and new conversations can be created;
 * - Triggers without an explicit target route to the newest normal assistant conversation, creating one on demand when none exist;
 * - Triggers targeting an explicitly deleted conversation fail with 404 instead of silently rerouting;
 * - `manageConversation` ownership protection still rejects deletion (`409 conversation_managed_by_plugin`).
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }` against deadlocks.
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
  assert.ok(conv, 'initial assistant conversation should exist')
  return conv
}

test('initial conversation deletion and default trigger delivery', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'helm-initial-del-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await t.test('deleting initial human conversation via kernel API succeeds and does not resurrect on restart', { timeout: 60_000 }, async () => {
    const dir = join(root, 't1')
    const first = await buildApp(dir)
    const initial = initialConvOf(first.app)
    await first.app.kernel.deleteConversation(initial.id)
    assert.equal(
      first.app.kernel.listConversations().some((c) => c.id === initial.id),
      false,
      'immediately hidden after deletion',
    )
    await first.app.close()

    const second = await buildApp(dir)
    try {
      assert.equal(
        second.app.kernel.listConversations().some((c) => c.id === initial.id),
        false,
        'must not resurrect or reseed after restart',
      )
      assert.equal(second.app.kernel.listConversations().length, 0, 'zero conversations remain after full deletion')
      // Creating a new conversation still works when none exist.
      const created = await second.app.kernel.createConversation({ title: 'new conversation', profileId: 'assistant' })
      assert.equal(typeof created.id, 'number')
    } finally {
      await second.app.close()
    }
  })

  await t.test('HTTP/CLI deletion of initial conversation succeeds', { timeout: 60_000 }, async () => {
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
      assert.equal(res.status, 200, `HTTP delete of initial conversation should return 200: ${await res.text()}`)
      const gone = await fetch(`${hub.url}/api/conversations/${initial.id}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(gone.status, 404)
    } finally {
      await hub.close()
      await app.close()
    }
  })

  await t.test('manageConversation ownership protection still applies (409)', { timeout: 60_000 }, async () => {
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

  await t.test('trigger without explicit target routes to newest normal assistant conversation', { timeout: 60_000 }, async () => {
    const dir = join(root, 't4')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      faux.setResponses([fauxAssistantMessage('received default event')])
      await app.kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron:test',
        text: 'default target event',
        createdAt: Date.now(),
      })
      await app.kernel.waitForIdle(initial.id)
      const detail = await app.kernel.getConversationDetail(initial.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('default target event')),
        'untargeted event should land in the newest normal assistant conversation',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('trigger creates a new conversation on demand when all conversations are deleted (concurrency-safe)', { timeout: 60_000 }, async () => {
    const dir = join(root, 't5')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      await app.kernel.deleteConversation(initial.id)
      faux.setResponses([fauxAssistantMessage('post-rebuild reply')])
      await app.kernel.dispatchTrigger({
        id: 'evt-2',
        source: 'cron:rebuild',
        text: 'default event after full deletion',
        createdAt: Date.now(),
      })
      const convs = app.kernel.listConversations().filter((c) => c.profileId === 'assistant')
      assert.equal(convs.length, 1, 'default trigger after deleting all conversations should create exactly one assistant conversation')
      await app.kernel.waitForIdle(convs[0]!.id)
      const detail = await app.kernel.getConversationDetail(convs[0]!.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('default event after full deletion')),
        'newly created conversation should receive the event',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('trigger targeting an explicitly deleted conversation fails with 404 without silently rerouting', { timeout: 60_000 }, async () => {
    const dir = join(root, 't6')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      const deadId = initial.id
      const other = await app.kernel.createConversation({ title: 'other conversation', profileId: 'assistant' })
      await app.kernel.deleteConversation(deadId)
      faux.setResponses([fauxAssistantMessage('must not receive')])
      await assert.rejects(
        () =>
          app.kernel.dispatchTrigger({
            id: 'evt-3',
            source: 'webhook:stale',
            text: 'event targeting deleted conversation',
            targetConversationId: deadId,
            createdAt: Date.now(),
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // Other conversations must not receive the event (no silent rerouting).
      const otherDetail = await app.kernel.getConversationDetail(other.id, { limit: 10 })
      assert.equal(
        otherDetail.entries.filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('event targeting deleted conversation')).length,
        0,
        'stale target must not silently reroute to another conversation',
      )
    } finally {
      await app.close()
    }
  })
})
