/**
 * conversation failed diagnose summary (ConversationSummary.lastError) regression test.
 *
 * defect background (this file lock fix):
 * - model/API request failed after sidebar state is error, but message stream no any response - -SDK failed
 *   save in pi.live.runFailure(reason/detail),helm only error send enter plugin
 *   turn_settled, no pass-through to ConversationSummary, frontend without from render reason.
 *
 * now contract:
 * 1. failed terminal state:getConversation / conversation.upsert event carry specific lastError
 *   ('model_error: <detail>' form);
 * 2. durable:lastError across process restart still visible (runFailure is pi.live right threat state);
 * 3. clear: under once succeeded turn after start lastError follow error state disappear;
 * 4. redaction: error detail contains already register stash secret when,lastError only see placeholder (and
 *    SecretStash all chain redaction same source), never via ConversationSummary back visible plaintext;
 * 5. semantics dedupe:lastError reference and summary semantics refer grain (error content change must update).
 *
 * via real KernelRuntime(faux provider + real SQLite + real observer link) drive.
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

test('failed terminal state:lastError pass-through to getConversation and conversation.upsert; under one succeeded turn clear', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-basic-')
  try {
    // one turn failed:faux return stopReason=error + errorMessage.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'provider 503 quota exceeded', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'will failed issue').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')

    // getConversation(API same link) carry specific error.
    const summary = env.kernel.getConversation(1)
    assert.equal(summary.status, 'error')
    assert.ok(summary.lastError, 'failed terminal state summary should carry lastError')
    assert.ok(
      summary.lastError!.startsWith('model_error'),
      `lastError should contains reason prefix, actual:${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes('provider 503 quota exceeded'),
      `lastError should contains specific detail, actual:${summary.lastError}`,
    )

    // conversation.upsert event (SSE same exit) same carry (first error frame i.e. has reason).
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.length >= 1, `should has error upsert frame, actual:${JSON.stringify(env.upserts.map((c) => c.status))}`)
    assert.ok(
      errorFrames[0]!.lastError?.includes('provider 503 quota exceeded'),
      `first error upsert frame i.e. should carry reason, actual:${errorFrames[0]!.lastError}`,
    )

    // second turn succeeded:error state and lastError one and clear (run re- start clear runFailure).
    env.faux.setResponses([fauxAssistantMessage('restore answer')])
    await env.kernel.submitInput(1, 'again mention question')
    await env.kernel.waitForIdle(1)
    await waitFor(() => env.kernel.getConversation(1).status === 'done')
    const after = env.kernel.getConversation(1)
    assert.equal(after.status, 'done')
    assert.equal(after.lastError, undefined, 'succeeded turn after lastError should clear')
    const lastErrorFrames = env.upserts.filter((c) => c.lastError !== undefined)
    assert.ok(
      lastErrorFrames.every((c) => c.status === 'error'),
      'lastError only should appear in error state summary on',
    )
  } finally {
    await env.close()
  }
})

test('failed durable:lastError across process restart still visible (pi.live right threat state)', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helm-last-error-restart-')
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'connection reset by peer', stopReason: 'error' }),
    ])
    await kernel.submitInput(1, 'restart before failed').catch(() => {})
    await kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'error')
    assert.ok(kernel.getConversation(1).lastError?.includes('connection reset by peer'))
  } finally {
    await kernel.close()
  }

  // restart: rely on pi.live.runFailure restore error state and diagnose summary.
  const { models: models2 } = makeFauxModels()
  const kernel2 = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: models2 })
  try {
    const summary = kernel2.getConversation(1)
    assert.equal(summary.status, 'error', 'after restart error state should stay')
    assert.ok(
      summary.lastError?.includes('connection reset by peer'),
      `after restart lastError should visible, actual:${summary.lastError}`,
    )
  } finally {
    await kernel2.close().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('redaction: error detail back visible already register stash secret when lastError only see placeholder', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-redact-')
  try {
    const secretValue = 'sk-helm-test-9f3ab2c7deadbeef'
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', secretValue)
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    // provider error detail in back visible secret plaintext (simulated upstream request head/parameter carries back error information).
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: `upstream 401 key=${secretValue}`, stopReason: 'error' }),
    ])
    await env.kernel.submitInput(conversation.id, 'carries secret failed').catch(() => {})
    await env.kernel.waitForIdle(conversation.id).catch(() => {})
    await waitFor(() => env.kernel.getConversation(conversation.id).status === 'error')

    const summary = env.kernel.getConversation(conversation.id)
    assert.ok(summary.lastError, 'failed summary should carry lastError')
    assert.ok(
      !summary.lastError!.includes(secretValue),
      `lastError must not back visible secret plaintext, actual:${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes(placeholder),
      `secret should with placeholder appear, actual:${summary.lastError}`,
    )
  } finally {
    await env.close()
  }
})

test('semantics refer grain: identical error state but error content change when summary update', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-dedup-')
  try {
    // first time failed.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'first failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'first time').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')
    assert.ok(env.kernel.getConversation(1).lastError?.includes('first failure'))

    // second time failed (different error text):error state do not change, but lastError change must push update.
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'second different failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, 'second time').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).lastError?.includes('second different failure') === true)
    const latest = env.kernel.getConversation(1).lastError
    assert.ok(latest !== undefined)
    assert.ok(
      !latest.includes('first failure'),
      'lastError should reverse reflect most new failed',
    )
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.some((c) => c.lastError?.includes('first failure')))
    assert.ok(errorFrames.some((c) => c.lastError?.includes('second different failure')))
  } finally {
    await env.close()
  }
})
