/**
 * KernelRuntime.completeConversationText through use model port contract test:
 * real KernelRuntime + real SDK(faux provider wrap streamSimple catch actual
 * request (context, options); already verify Models.completeSimple internal via
 * normalizeContext collapse systemPrompt/tools is leading system message after invoke
 * provider.streamSimple(model, transcript, options),maxTokens in options).
 *
 * override:
 * - maxTokens at request options(provider third reference),transcript(Context)
 *   excludes maxTokens / tools field (without tools single time request);
 * - systemPrompt and user text all already global redaction (stash secret does not enter model input);
 * - return output same global redaction;
 * - conversation override takes precedence at global model (real double provider zone request ownership);
 * - stopReason non- 'stop'(error/length) explicit reject;
 * - conversation missing / not config model such as on throw;signal pre- first aborted immediately reject.
 *
 * runner: tsx --test; each test explicit timeout: 60_000 guard against deadlock.
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Provider } from '@earendil-works/pi-ai/models'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-kernel-text-port-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** catch to provider.streamSimple reference (SDK real invoke path). */
interface Captured {
  context: TranscriptContext
  maxTokens: number | undefined
  signal: AbortSignal | undefined
}

/** transcript all text (system + each message text chunk concatenate). */
function transcriptText(context: TranscriptContext): string {
  return context.messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    )
    .join('\n')
}

/**
 * wrap faux provider: catch streamSimple  (context, options) again delegate original implement.
 * type from original method parameter push assert (Parameters<typeof original>), do not use as never.
 */
function captureProvider(base: Provider, sink: Captured[]): Provider {
  const original = base.streamSimple.bind(base)
  const streamSimple = (...args: Parameters<typeof original>) => {
    sink.push({
      context: args[1]!,
      maxTokens: args[2]?.maxTokens,
      signal: args[2]?.signal,
    })
    return original(...args)
  }
  return { ...base, streamSimple }
}

interface Env {
  kernel: KernelRuntime
  /** fauxA(global model) request catch. */
  capturedA: Captured[]
  /** fauxB(override dedicated use) request catch. */
  capturedB: Captured[]
  fauxA: ReturnType<typeof fauxProvider>
  fauxB: ReturnType<typeof fauxProvider>
  close(): Promise<void>
}

async function openEnv(options: { model?: string } = {}): Promise<Env> {
  const models = createModels()
  const capturedA: Captured[] = []
  const capturedB: Captured[] = []
  const fauxA = fauxProvider()
  const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'override-model' }] })
  models.setProvider(captureProvider(fauxA.provider, capturedA))
  models.setProvider(captureProvider(fauxB.provider, capturedB))
  const kernel = await KernelRuntime.open({
    dataDir: join(rootDir, `d-${Math.random().toString(36).slice(2)}`),
    cwd: rootDir,
    model: options.model ?? 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  return {
    kernel,
    capturedA,
    capturedB,
    fauxA,
    fauxB,
    async close() {
      await kernel.close()
    },
  }
}

describe('completeConversationText(kernel through use model port)', () => {
  it('maxTokens in request options;transcript without maxTokens/tools;systemPrompt and text enter model input', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('plain output')])
      const text = await env.kernel.completeConversationText({
        conversationId: 1,
        systemPrompt: 'SYS-PROMPT-MARKER',
        text: 'USER-TEXT-MARKER',
        maxTokens: 640,
      })
      assert.equal(text, 'plain output')
      assert.equal(env.capturedA.length, 1)
      const captured = env.capturedA[0]!
      // maxTokens pass to provider options(third reference), is not Context field.
      assert.equal(captured.maxTokens, 640)
      // normalizeContext artifact only messages; excludes maxTokens and tools.
      const contextRecord = captured.context as unknown as Record<string, unknown>
      assert.equal('maxTokens' in contextRecord, false, 'Context must not contains maxTokens')
      assert.equal('tools' in contextRecord, false, 'Context must not contains tools(without tools single time request)')
      // systemPrompt collapse is leading system message; user text in after continue message.
      const full = transcriptText(captured.context)
      assert.ok(full.includes('SYS-PROMPT-MARKER'), 'systemPrompt enter model input')
      assert.ok(full.includes('USER-TEXT-MARKER'), 'user text enter model input')
    } finally {
      await env.close()
    }
  })

  it('input output redaction:systemPrompt/text in secret does not enter model; output secret by redaction', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.kernel.stash.addRedaction('SECRET-INPUT-42')
      env.kernel.stash.addRedaction('SECRET-OUTPUT-99')
      env.fauxA.setResponses([fauxAssistantMessage('result contains SECRET-OUTPUT-99')])
      const text = await env.kernel.completeConversationText({
        conversationId: 1,
        systemPrompt: 'system hint contains SECRET-INPUT-42',
        text: 'snapshot contains SECRET-INPUT-42',
      })
      assert.ok(!text.includes('SECRET-OUTPUT-99'), 'return output already global redaction')
      assert.ok(text.includes('[REDACTED') || !text.includes('SECRET'), 'output contains redaction mark record')
      const full = transcriptText(env.capturedA[0]!.context)
      assert.ok(!full.includes('SECRET-INPUT-42'), 'systemPrompt and text in secret does not enter model input')
      assert.ok(full.includes('[REDACTED') || !full.includes('SECRET-INPUT'), 'model input contains redaction mark record')
    } finally {
      await env.close()
    }
  })

  it('conversation override takes precedence at global model: request away override provider', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      const conv = await env.kernel.createConversation({ title: 'override' })
      await env.kernel.updateConversation(conv.id, { model: 'faux-b/override-model' })
      env.fauxB.setResponses([fauxAssistantMessage('from override model')])
      const text = await env.kernel.completeConversationText({
        conversationId: conv.id,
        systemPrompt: 's',
        text: 't',
        maxTokens: 512,
      })
      assert.equal(text, 'from override model')
      assert.equal(env.capturedB.length, 1, 'request in override provider')
      assert.equal(env.capturedB[0]!.maxTokens, 512)
      assert.equal(env.capturedA.length, 0, 'do not back global model')
    } finally {
      await env.close()
    }
  })

  it('stopReason=error explicit reject, do not return part text', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('part text', { stopReason: 'error' })])
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_completion_unavailable')
          assert.ok(e.message.includes('error'))
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('stopReason=length same reject', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('truncate text', { stopReason: 'length' })])
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_completion_unavailable')
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('conversation missing such as 404;signal pre- first aborted immediately reject and do not request', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 999_999, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'not_found')
          return true
        },
      )
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't', signal: controller.signal }),
        () => true,
      )
      assert.equal(env.capturedA.length, 0, 'pre- first cancel do not start request')
    } finally {
      await env.close()
    }
  })

  it('not config global model when such as on throw, not silently use other registered model', { timeout: 60_000 }, async () => {
    const models = createModels()
    const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'other' }] })
    models.setProvider(fauxB.provider)
    const kernel = await KernelRuntime.open({
      dataDir: join(rootDir, `bare-${Math.random().toString(36).slice(2)}`),
      cwd: rootDir,
      models: models as never,
      autoResume: false,
    })
    try {
      await assert.rejects(
        kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_not_configured')
          return true
        },
      )
      assert.equal(fauxB.state.callCount, 0, 'never static default change use other registered model')
    } finally {
      await kernel.close()
    }
  })
})
