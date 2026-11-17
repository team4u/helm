/**
 * Conversation failure diagnostic summary (ConversationSummary.lastError) regression tests.
 *
 * Bug background (fixed and locked by this file):
 * - After a model/API request failed, sidebar status showed error, but the message stream had no response -- SDK failure
 *   details were stored in pi.live.runFailure (reason/detail), yet helm only forwarded errors to plugin
 *   turn_settled hooks without passing them to ConversationSummary, leaving the frontend unable to render a reason.
 *
 * Current contract:
 * 1. Failed terminal state: getConversation / conversation.upsert events carry concrete lastError
 *   ('model_error: <detail>' format);
 * 2. Durable: lastError stays visible across process restarts (runFailure is authoritative state in pi.live);
 * 3. Clear: cleared together with error state once the next turn succeeds;
 * 4. Redaction: when error detail echoes a registered stash secret, lastError shows only the placeholder
 *   (sharing the SecretStash redaction pipeline), never leaking plaintext via ConversationSummary;
 * 5. Semantic dedup: lastError participates in summary semantic equality (error content changes must emit updates).
 *
 * Driven through real KernelRuntime (faux provider + real SQLite + real observer pipeline).
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface Env {
  dataDir: string
  faux: FauxHandle
  kernel: KernelRuntime
  upserts: ConversationSummary[]
  stopRecording: () => void
  close(): Promise<void>
}

async function makeEnv(prefix: string): Promise<Env> {
  const dataDir = await makeTempDir(prefix)
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
  })
  const upserts: ConversationSummary[] = []
  const stopRecording = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id === 1) upserts.push(conversation)
  })
  return {
    dataDir,
    faux,
    kernel,
    upserts,
    stopRecording,
    async close() {
      stopRecording()
      try {
        await kernel.close()
      } finally {
        await cleanupDir(dataDir)
      }
    },
  }
}

test('failed terminal state: lastError passes through to getConversation and conversation.upsert; clears on next succeeded turn', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-basic-')
  try {
    // First turn fails: faux returns stopReason=error + errorMessage.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'provider 503 quota exceeded', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'failing question').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')

    // getConversation (API query path) carries the concrete error.
    const summary = env.kernel.getConversation(1)
    assert.equal(summary.status, 'error')
    assert.ok(summary.lastError, 'failed terminal state summary should carry lastError')
    assert.ok(
      summary.lastError!.startsWith('model_error'),
      `lastError should include reason prefix, actual: ${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes('provider 503 quota exceeded'),
      `lastError should include concrete detail, actual: ${summary.lastError}`,
    )

    // conversation.upsert events (SSE path) also carry it (first error frame already includes the reason).
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.length >= 1, `should emit error upsert frame, actual: ${JSON.stringify(env.upserts.map((c) => c.status))}`)
    assert.ok(
      errorFrames[0]!.lastError?.includes('provider 503 quota exceeded'),
      `first error upsert frame should already carry reason, actual: ${errorFrames[0]!.lastError}`,
    )

    // Second turn succeeds: error status and lastError clear together (run restart clears runFailure).
    env.faux.setResponses([fauxAssistantMessage('recovered answer')])
    await env.kernel.submitInput(1, 'ask again')
    await env.kernel.waitForIdle(1)
    await waitFor(() => env.kernel.getConversation(1).status === 'done')
    const after = env.kernel.getConversation(1)
    assert.equal(after.status, 'done')
    assert.equal(after.lastError, undefined, 'lastError should clear after succeeded turn')
    const lastErrorFrames = env.upserts.filter((c) => c.lastError !== undefined)
    assert.ok(
      lastErrorFrames.every((c) => c.status === 'error'),
      'lastError should only appear on error-state summaries',
    )
  } finally {
    await env.close()
  }
})

test('failure durability: lastError stays visible across process restart (authoritative state in pi.live)', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helm-last-error-restart-')
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'connection reset by peer', stopReason: 'error' }),
    ])
    await kernel.submitInput(1, 'failure before restart').catch(() => {})
    await kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'error')
    assert.ok(kernel.getConversation(1).lastError?.includes('connection reset by peer'))
  } finally {
    await kernel.close()
  }

  // Restart: rely on pi.live.runFailure to restore error status and diagnostic summary.
  const { models: models2 } = makeFauxModels()
  const kernel2 = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: models2 })
  try {
    const summary = kernel2.getConversation(1)
    assert.equal(summary.status, 'error', 'error status should remain after restart')
    assert.ok(
      summary.lastError?.includes('connection reset by peer'),
      `lastError should remain visible after restart, actual: ${summary.lastError}`,
    )
  } finally {
    await kernel2.close().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('redaction: when error detail echoes a registered stash secret, lastError shows only placeholder', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-redact-')
  try {
    const secretValue = 'sk-helm-test-9f3ab2c7deadbeef'
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', secretValue)
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    // Provider error detail echoes secret plaintext (simulating upstream response echoing request headers/params).
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: `upstream 401 key=${secretValue}`, stopReason: 'error' }),
    ])
    await env.kernel.submitInput(conversation.id, 'failure carrying secret').catch(() => {})
    await env.kernel.waitForIdle(conversation.id).catch(() => {})
    await waitFor(() => env.kernel.getConversation(conversation.id).status === 'error')

    const summary = env.kernel.getConversation(conversation.id)
    assert.ok(summary.lastError, 'failed summary should carry lastError')
    assert.ok(
      !summary.lastError!.includes(secretValue),
      `lastError must not leak secret plaintext, actual: ${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes(placeholder),
      `secret should appear as placeholder, actual: ${summary.lastError}`,
    )
  } finally {
    await env.close()
  }
})

test('semantic equality granularity: same error status with changed error content emits summary update', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-dedup-')
  try {
    // First failure.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'first failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'first run').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')
    assert.ok(env.kernel.getConversation(1).lastError?.includes('first failure'))

    // Second failure (different error text): status stays error, but changed lastError must push an update.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'second different failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'second run').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).lastError?.includes('second different failure') === true)
    const latest = env.kernel.getConversation(1).lastError
    assert.ok(latest !== undefined)
    assert.ok(
      !latest.includes('first failure'),
      'lastError should reflect the latest failure',
    )
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.some((c) => c.lastError?.includes('first failure')))
    assert.ok(errorFrames.some((c) => c.lastError?.includes('second different failure')))
  } finally {
    await env.close()
  }
})
