/**
 * Contract tests for KernelRuntime.completeConversationText generic model port:
 * Real KernelRuntime + real SDK (wraps faux provider streamSimple to capture actual
 * requests (context, options); verifies Models.completeSimple internally collapses
 * systemPrompt/tools into the leading system message before calling
 * provider.streamSimple(model, transcript, options), keeping maxTokens in options).
 *
 * Coverage:
 * - maxTokens passes in request options (provider arg 3) while transcript (Context) omits
 *   maxTokens and tools (single-shot request with no tools);
 * - both systemPrompt and user text are globally redacted (stash secrets never reach model input);
 * - returned output is also globally redacted;
 * - conversation model override takes precedence over global model (distinct providers confirm routing);
 * - non-'stop' stopReason (error/length) rejects explicitly;
 * - missing conversation / unconfigured model throws as expected; pre-aborted signal rejects immediately.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 to guard against deadlocks.
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

/** Captures arguments passed to provider.streamSimple (actual SDK invocation path). */
interface Captured {
  context: TranscriptContext
  maxTokens: number | undefined
  signal: AbortSignal | undefined
}

/** Extracts all text across transcript messages (system + message text blocks). */
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
 * Wraps faux provider to capture (context, options) on streamSimple before delegating.
 * Infers types directly from the original method (Parameters<typeof original>) without `as never`.
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
  /** Captured requests for fauxA (global model). */
  capturedA: Captured[]
  /** Captured requests for fauxB (conversation override). */
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

describe('completeConversationText (generic kernel model port)', () => {
  it('passes maxTokens in request options; transcript omits maxTokens/tools; systemPrompt and text reach model input', { timeout: 60_000 }, async () => {
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
      // maxTokens passes through provider options (3rd arg), not Context fields.
      assert.equal(captured.maxTokens, 640)
      // normalizeContext output contains messages only, without maxTokens or tools.
      const contextRecord = captured.context as unknown as Record<string, unknown>
      assert.equal('maxTokens' in contextRecord, false, 'Context must not contain maxTokens')
      assert.equal('tools' in contextRecord, false, 'Context must not contain tools (toolless single-shot request)')
      // systemPrompt collapses into leading system message; user text follows in subsequent message.
      const full = transcriptText(captured.context)
      assert.ok(full.includes('SYS-PROMPT-MARKER'), 'systemPrompt reaches model input')
      assert.ok(full.includes('USER-TEXT-MARKER'), 'user text reaches model input')
    } finally {
      await env.close()
    }
  })

  it('input/output redaction: secrets in systemPrompt/text never enter model; output secrets are redacted', { timeout: 60_000 }, async () => {
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
      assert.ok(!text.includes('SECRET-OUTPUT-99'), 'returned output undergoes global redaction')
      assert.ok(text.includes('[REDACTED') || !text.includes('SECRET'), 'output retains redaction marker')
      const full = transcriptText(env.capturedA[0]!.context)
      assert.ok(!full.includes('SECRET-INPUT-42'), 'secrets in systemPrompt and text never enter model input')
      assert.ok(full.includes('[REDACTED') || !full.includes('SECRET-INPUT'), 'model input contains redaction marker')
    } finally {
      await env.close()
    }
  })

  it('conversation model override takes precedence over global model and routes to override provider', { timeout: 60_000 }, async () => {
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
      assert.equal(env.capturedB.length, 1, 'request hits override provider')
      assert.equal(env.capturedB[0]!.maxTokens, 512)
      assert.equal(env.capturedA.length, 0, 'does not fall back to global model')
    } finally {
      await env.close()
    }
  })

  it('rejects stopReason=error explicitly without returning partial text', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('partial text', { stopReason: 'error' })])
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

  it('rejects stopReason=length identically', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('truncated text', { stopReason: 'length' })])
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

  it('missing conversation returns 404; pre-aborted signal rejects immediately without sending request', { timeout: 60_000 }, async () => {
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
      assert.equal(env.capturedA.length, 0, 'pre-aborted signal must not start any request')
    } finally {
      await env.close()
    }
  })

  it('throws as expected when global model is unconfigured without silently switching to another registered model', { timeout: 60_000 }, async () => {
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
      assert.equal(fauxB.state.callCount, 0, 'never silently falls back to another registered model')
    } finally {
      await kernel.close()
    }
  })
})
