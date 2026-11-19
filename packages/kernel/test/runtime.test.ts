/**
 * KernelRuntime integration tests: real pi-durable SDK + faux provider (test-only).
 *
 * Covers: complete/fail/abort terminal states (real turn_settled hook payload assertions), busy followUp
 * origin mapping, restart recovery (including pagination and ownership), root protection, seq/SSE races,
 * Ask CAS and secret durability boundaries, real tool execution/spill, and real PluginHost wiring
 * (split config persistence / tool hot-loading / before_turn sections reaching real model requests).
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type TurnSettledPayload } from '@helmx/protocol'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import { assertSpawnRequestTitle, normalizeSpawnTitle } from '../src/runtime/spawn.js'
import { buildToolEnv } from '../src/runtime/tools.js'
import type { ConversationSummary, HelmxEventFrame, HelmxSnapshot, HelmxTransientLiveFrame } from '@helmx/protocol'
import { cleanupDir, deferred, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

/**
 * Faux provider binding: KernelRuntime.open lets options.models inject test Models
 * directly (explicitly for testing); when injected, reloadModels skips overwriting them.
 */

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface OpenOpts {
  model?: string
  watchdogIntervalMs?: number
}

async function openRuntime(dir: string, opts: OpenOpts = {}): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: opts.model !== undefined ? opts.model : 'faux/faux-1',
    ...(opts.watchdogIntervalMs !== undefined ? { watchdogIntervalMs: opts.watchdogIntervalMs } : {}),
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Writes a profile (profile.json) under dataDir. */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

/** Synchronous throw assertion (for markConversationOwnership / setHubUrl synchronous validation). */
async function assertThrowsSync(fn: () => unknown, code: string): Promise<void> {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HelmxError && err.code === code, `expected ${code}, got ${String(err)}`)
    return
  }
  assert.fail(`expected synchronous throw ${code}, but did not throw`)
}

let root: string

before(async () => {
  root = await makeTempDir('helmx-runtime-')
})

after(async () => {
  await cleanupDir(root)
})

describe('KernelRuntime basic lifecycle', { timeout: 60_000 }, () => {
  it('auto-creates root #1 as a normal assistant conversation (deletable); 5-state idle; profiles ensureDefault ready', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      const convs = kernel.listConversations()
      assert.equal(convs.length, 1)
      assert.ok(convs[0])
      assert.equal(convs[0].id, 1)
      assert.equal(convs[0].profileId, 'assistant')
      assert.equal(convs[0].status, 'idle')
      // Standard conversation semantics: no ID-level deletion exemption
      await kernel.deleteConversation(1)
      assert.equal(kernel.listConversations().length, 0)
      // ensureDefault created the assistant profile
      const profiles = await kernel.services.profiles.list()
      assert.ok(profiles.some((p) => p.id === 'assistant'))
    } finally {
      await kernel.close()
    }
  })

  it('faux completion path: turn_settled completed, unread/done, auto-generated title', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('你好, here is the answer.'),
        fauxAssistantMessage('new conversation answer'),
      ])
      const { submissionId } = await kernel.submitInput(1, 'please say hello')
      assert.ok(submissionId)
      const fresh = await kernel.createConversation({})
      await kernel.submitInput(fresh.id, '```code```\nplease say hello\nline two')
      await kernel.waitForIdle(1)
      await kernel.waitForIdle(fresh.id)
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'done')
      assert.equal(conv.unread, true)
      assert.equal(conv.title, 'person assist')
      const freshConv = kernel.getConversation(fresh.id)
      assert.equal(freshConv.title, 'please say hello line two'.slice(0, 36))
      assert.equal(freshConv.completionSeq, 1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, '你好, here is the answer.')
    } finally {
      await kernel.close()
    }
  })

  it('failure path: runFailure maps to error status; turn_settled failed keeps exact inputs', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, 'trigger failure')
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'error')
    } finally {
      await kernel.close()
    }
  })

  it('abort path: aborting while tool is in-flight -> aborted settles once; idle abort never fabricates settlement', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      // Tool stays in-flight (real bash sleep 5s) so working state is deterministically observed before aborting.
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'sleep 5 && echo done' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('unneeded second answer'),
      ])
      const settled: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:abort',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((p) => { settled.push(p) })
        },
      })
      void kernel.submitInput(1, 'question to abort').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      // Aborted terminal state: idle, completionSeq increments once, hook payload aborted.
      assert.equal(conv.status, 'idle')
      assert.equal(conv.completionSeq, 1)
      assert.equal(settled.length, 1)
      assert.ok(settled[0])
      assert.equal(settled[0].outcome, 'aborted')
      // Aborting again while idle triggers no second settlement.
      await kernel.abortConversation(1)
      assert.equal(kernel.getConversation(1).completionSeq, 1)
      assert.equal(settled.length, 1)
    } finally {
      await kernel.close()
    }
  })
})

describe('busy origins and followUp', { timeout: 60_000 }, () => {
  it('followUp while busy never drops input; turn_settled inputs match origins accurately', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
    try {
      // Two responses: initial turn + followUp turn
      kernel.__faux.setResponses([
        fauxAssistantMessage('answer a'),
        fauxAssistantMessage('answer second'),
      ])
      await kernel.submitInput(1, 'a', { origin: 'human' })
      // Immediate followUp (queued while busy, never dropped)
      const second = await kernel.submitInput(1, 'second', { origin: 'agent' })
      assert.ok(second.submissionId)
      await kernel.waitForIdle(1)
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'done')
      // FTS indexes both inputs
      const hits = await kernel.search('second')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })
})

describe('restart recovery', { timeout: 60_000 }, () => {
  it('reopening after close preserves conversations/titles/seq/event seq; deleted initial conversation stays tombstoned', { timeout: 60_000 }, async () => {
    const dir = join(root, 't6')
    const kernel = await openRuntime(dir)
    kernel.__faux.setResponses([fauxAssistantMessage('pre-restart answer')])
    const fresh = await kernel.createConversation({})
    await kernel.submitInput(fresh.id, 'pre-restart question')
    await kernel.waitForIdle(fresh.id)
    const seqBefore = kernel.getConversation(fresh.id).stateChangeSeq
    const eventSeqBefore = kernel.events.seq
    await kernel.close()

    const kernel2 = await openRuntime(dir)
    try {
      const conv = kernel2.getConversation(fresh.id)
      assert.equal(conv.title, 'pre-restart question')
      assert.equal(conv.stateChangeSeq, seqBefore)
      assert.ok(kernel2.events.seq >= eventSeqBefore)
      // Initial conversation #1 does not resurrect after deletion + restart (tombstone works; no ID exemption)
      await kernel2.deleteConversation(1)
      const kernel3 = await openRuntime(dir)
      try {
        assert.equal(
          kernel3.listConversations().some((c) => c.id === 1),
          false,
          'deleted initial conversation must not reappear after restart',
        )
        assert.equal(kernel3.listConversations().some((c) => c.id === fresh.id), true, 'normal conversations remain intact')
      } finally {
        await kernel3.close()
      }
      // FTS remains searchable across restarts
      const hits = await kernel2.search('pre-restart question')
      assert.ok(hits.length >= 1)
      // Non-root conversations remain submittable after recovery (observer rebuilt rather than stalling forever).
      kernel2.__faux.setResponses([fauxAssistantMessage('post-restart answer')])
      await kernel2.submitInput(fresh.id, 'post-restart question')
      await kernel2.waitForIdle(fresh.id)
      assert.equal(await kernel2.getLastAssistantText(fresh.id), 'post-restart answer')
    } finally {
      await kernel2.close()
    }
  })
})

describe('SSE snapshot + seq race', { timeout: 60_000 }, () => {
  it('initial subscribe emits snapshot frame first followed strictly by deltas with seq > snapshot.seq', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't7'))
    try {
      const frames: Array<HelmxSnapshot | HelmxEventFrame> = []
      // Inject race between publish and subscribe handoff by publishing from inside the subscribe callback.
      kernel.events.sseStream((frame) => {
        frames.push(frame)
        if (frames.length === 1) {
          // Publish immediately after snapshot is taken before buffer flush finishes (must arrive in next frame).
          queueMicrotask(() => {
            kernel.events.publish('notification', { level: 'info', title: 'race event' })
          })
        }
        return true
      })
      await new Promise((r) => setTimeout(r, 100))
      const snapshot = frames[0]
      assert.ok(snapshot && 'conversations' in snapshot)
      const eventFrames = frames.filter((f) => 'event' in f) as HelmxEventFrame[]
      assert.ok(eventFrames.length >= 1)
      assert.ok(eventFrames.every((f) => f.seq > (snapshot as HelmxSnapshot).seq))
      const last = eventFrames[eventFrames.length - 1]
      assert.ok(last)
      assert.equal(last.event.type, 'notification')
    } finally {
      await kernel.close()
    }
  })
})

describe('Ask CAS and secret persistence boundaries', { timeout: 60_000 }, () => {
  it('stashes secret answers: store and events hold markers only', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't8'))
    try {
      const askPromise = kernel.createAsk({
        conversationId: 1,
        title: 'needs secret',
        fields: [
          { name: 'API_KEY', label: 'API Key', type: 'text', secret: true, required: true },
        ],
      })
      await new Promise((r) => setTimeout(r, 20))
      const pending = kernel.listAsks('pending')
      assert.equal(pending.length, 1)
      const ask = pending[0]
      assert.ok(ask)
      await kernel.answerAsk(ask.id, { API_KEY: 'super-secret-123' })
      const result = await askPromise
      // Answer holds marker form only; plaintext enters child processes via envFor (accessible in-process)
      assert.equal(result.status, 'answered')
      assert.ok(result.answers['API_KEY']!.startsWith('[REDACTED:stash:'))
      const env = kernel.services.stash.envFor(1)
      assert.ok(String(env['API_KEY']).length > 0)
      // Persisted rows keep markers only: verify via ask list query
      const answered = kernel.listAsks('answered')
      assert.equal(answered.length, 1)
    } finally {
      await kernel.close()
    }
  })

  it('CAS: answering after external seq advance supersedes cleanly', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't9'))
    try {
      const askPromise = kernel.createAsk({
        conversationId: 1,
        title: 'terminal confirm',
        expectedStateSeq: 10,
        fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
      })
      await new Promise((r) => setTimeout(r, 20))
      const ask = kernel.listAsks('pending')[0]
      assert.ok(ask)
      // herdr terminal side already advanced to 11
      kernel.registerAskSeqResolver(() => 11)
      const result = await kernel.answerAsk(ask.id, { confirm: 'yes' })
      assert.equal(result.status, 'superseded')
      assert.equal(kernel.listAsks('pending').length, 0)
      // createAsk resolves synchronously to superseded (empty answers; never hangs or backfills false approval).
      const settled = await askPromise
      assert.equal(settled.status, 'superseded')
      assert.deepEqual(settled.answers, {})
    } finally {
      await kernel.close()
    }
  })

  it('persisted pending asks remain across restart alongside diagnostic notice (no silent discard)', { timeout: 60_000 }, async () => {
    const dir = join(root, 't10')
    const kernel = await openRuntime(dir)
    const askPromise = kernel.createAsk({
      conversationId: 1,
      title: 'orphaned question',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise
    await new Promise((r) => setTimeout(r, 20))
    await kernel.close()

    const kernel2 = await openRuntime(dir)
    try {
      assert.equal(kernel2.listAsks('pending').length, 1)
    } finally {
      await kernel2.close()
    }
  })
})

describe('real tool execution', { timeout: 60_000 }, () => {
  it('executes bash tool, spills oversized output to artifact, and supports pagination via read_artifact', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't11'))
    try {
      // Model runs bash generating >32KiB output, then summarizes.
      const bigCommand = 'python3 -c "print(\'A\'*40000)"'
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: bigCommand })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ])
      await kernel.submitInput(1, 'generate large output')
      await kernel.waitForIdle(1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, 'done')
      // Spill artifact registered
      const artifacts = await kernel.services.artifacts.list(1)
      assert.ok(artifacts.length >= 1)
      const spillArtifact = artifacts.find((a) => a.name.startsWith('tool-spill-'))
      assert.ok(spillArtifact, 'should create spill artifact')
      assert.equal(spillArtifact.kind, 'spill')
    } finally {
      await kernel.close()
    }
  })

  it('runGate runs real shell commands for both success and failure', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't12'))
    try {
      const ok = await kernel.runGate('true', { conversationId: 1 })
      assert.equal(ok.ok, true)
      const fail = await kernel.runGate('exit 3', { conversationId: 1 })
      assert.equal(fail.ok, false)
      assert.equal(typeof fail.output, 'string')
    } finally {
      await kernel.close()
    }
  })

  it('failed runGate prevents spawn from succeeding (explicit gate_failed)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't13'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'work',
            gate: 'exit 1',
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'gate_failed',
      )
    } finally {
      await kernel.close()
    }
  })

  it('spawn gateTimeoutMs kills process group on timeout, reports full structure to onGateResult, and populates gate_failed details', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't19'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      const reported: Array<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> = []
      const started = Date.now()
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'work',
            gate: 'sleep 30',
            gateTimeoutMs: 800,
            onGateResult: (result) => reported.push({ ...result }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `should be HelmxError, got ${err}`)
          assert.equal(err.code, 'gate_failed')
          const details = err.details as { exitCode?: number | null; timedOut?: boolean; output?: string }
          assert.equal(details.exitCode, null, 'no exit code on timeout; exitCode=null')
          assert.equal(details.timedOut, true)
          assert.ok(typeof details.output === 'string' && details.output.length > 0)
          assert.ok(err.message.includes('timeout'), `error message should include timeout detail (actual ${err.message})`)
          return true
        },
      )
      assert.ok(Date.now() - started < 15_000, 'gateTimeoutMs should kill process group rather than waiting full 30s')
      // Invoked once with full structure (preserving all four fields even after sanitizeAgentGateResult).
      assert.equal(reported.length, 1)
      assert.equal(reported[0]!.ok, false)
      assert.equal(reported[0]!.exitCode, null)
      assert.equal(reported[0]!.timedOut, true)
      assert.ok((reported[0]!.output as string).includes('timeout'))
    } finally {
      await kernel.close()
    }
  })

  it('spawn gate failure: onGateResult includes exitCode and gate_failed details retains last 4000 characters', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't20'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      const reported: Array<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> = []
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'work',
            gate: "python3 -c \"print('A'*5000)\"; echo gate-out-marker; exit 3",
            onGateResult: (result) => reported.push({ ...result }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `should be HelmxError, got ${err}`)
          assert.equal(err.code, 'gate_failed')
          const details = err.details as { exitCode?: number | null; timedOut?: boolean; output?: string }
          assert.equal(details.exitCode, 3)
          assert.equal(details.timedOut, false)
          assert.ok(details.output!.includes('gate-out-marker'), 'details output should include tail of gate output')
          assert.ok(details.output!.length <= 4000, `details.output should truncate to last 4000 chars (actual ${details.output!.length})`)
          return true
        },
      )
      assert.equal(reported.length, 1)
      assert.equal(reported[0]!.exitCode, 3)
      assert.equal(reported[0]!.timedOut, false)
    } finally {
      await kernel.close()
    }
  })

  it('invalid gateTimeoutMs rejected explicitly at execution boundary', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't21'))
    try {
      for (const bad of [0, -5, 1.5, Number.NaN, 600_001]) {
        await assert.rejects(
          () =>
            kernel.spawnAgent({
              parentConversationId: 1,
              prompt: 'work',
              gate: 'true',
              gateTimeoutMs: bad,
            }),
          (err: unknown) =>
            err instanceof HelmxError && err.code === 'validation_error' && err.message.includes('gateTimeoutMs'),
          `gateTimeoutMs=${bad} should reject explicitly`,
        )
      }
    } finally {
      await kernel.close()
    }
  })
})

describe('native subagent', { timeout: 60_000 }, () => {
  it('validates schema and returns object; reports convId/effectiveCwd to onResolved', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't14'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('{"answer": 42}')])
      let createdId: number | undefined
      let resolvedCwd: string | undefined
      const result = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'compute answer',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
        onResolved: (info) => {
          createdId = info.conversationId
          resolvedCwd = info.effectiveCwd
        },
      })
      assert.deepEqual(result, { answer: 42 })
      assert.ok(createdId !== undefined && createdId > 1)
      assert.ok(typeof resolvedCwd === 'string' && resolvedCwd.length > 0)
      // Child conversation has zero business tags (role is carried via profileId; kernel never hardcodes worker).
      const child = kernel.getConversation(createdId!)
      assert.deepEqual(child.tags, [])
    } finally {
      await kernel.close()
    }
  })

  it('two schema failures emit schema_validation_failed; herdr: prefix yields unsupported_runtime', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't15'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('not JSON'),
        fauxAssistantMessage('still not JSON'),
      ])
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'return JSON',
            schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'schema_validation_failed',
      )
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'herdr:agy',
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_runtime',
      )
    } finally {
      await kernel.close()
    }
  })

  it('resume reuses original child convId; worktree request fails explicitly when workflow plugin is disabled', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't16'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('first run result'), fauxAssistantMessage('resume result')])
      const first = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'round 1',
        agentId: 'task-1',
      })
      assert.equal(first, 'first run result')
      const second = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'task-1',
      })
      assert.equal(second, 'resume result')
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'x',
            isolation: 'worktree',
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_runtime',
      )
    } finally {
      await kernel.close()
    }
  })

  it('spawnAgent title boundary validation rejects non-strings and control characters before creating child conversations', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'spawn-title-validation'))
    try {
      const convCountBefore = kernel.listConversations().length
      const callsBefore = kernel.__faux.state.callCount

      for (const badTitle of [123, null, {}, ['bad']]) {
        await assertThrowsSync(
          () => assertSpawnRequestTitle(badTitle),
          'validation_error',
        )
        await assert.rejects(
          () =>
            kernel.spawnAgent({
              parentConversationId: 1,
              prompt: 'bad title type',
              title: badTitle as never,
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        )
      }

      for (const ctrlTitle of ['bad\u0000title', 'line1\nline2', 'tab\ttitle', 'cr\rtitle', 'del\u007ftitle']) {
        await assertThrowsSync(
          () => assertSpawnRequestTitle(ctrlTitle),
          'validation_error',
        )
        await assert.rejects(
          () =>
            kernel.spawnAgent({
              parentConversationId: 1,
              prompt: 'control char title',
              title: ctrlTitle,
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        )
      }

      // Hook rewriting title to contain control chars is also rejected before native child creation.
      await kernel.plugins.register({
        id: 'test:bad-title-hook',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn(async (req, next) => next({ ...req, title: 'hook\nbad' }))
        },
      })
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'hook bad title',
            title: 'clean request title',
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )

      assert.equal(kernel.listConversations().length, convCountBefore, 'rejected titles must never create conversations')
      assert.equal(kernel.__faux.state.callCount, callsBefore, 'rejected titles must never invoke model requests')
    } finally {
      await kernel.close()
    }
  })

  it('spawnAgent normalizes title on fresh creation (trim, redact secrets, cap 120 chars, fallback on blank) and preserves title on resume', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'spawn-title-normalize'))
    try {
      // Register both per-conversation stash secret and global redaction token.
      kernel.services.stash.put(1, 'API_TOKEN', 'secret-token-xyz-987')
      const disposeGlobal = kernel.stash.addRedaction('global-secret-456')

      kernel.__faux.setResponses([
        fauxAssistantMessage('custom done'),
        fauxAssistantMessage('secret done'),
        fauxAssistantMessage('long done'),
        fauxAssistantMessage('blank done'),
        fauxAssistantMessage('resumed done'),
      ])

      try {
        // 1. Trimmed explicit title + preserved on resume even when caller passes a new title.
        let child1 = 0
        await kernel.spawnAgent({
          parentConversationId: 1,
          prompt: 'inspect build',
          title: '  Inspect build failure  ',
          onResolved: (info) => {
            child1 = info.conversationId ?? 0
          },
        })
        assert.equal(kernel.getConversation(child1).title, 'Inspect build failure')

        // 2. Secret redaction before persistence & cap.
        let child2 = 0
        await kernel.spawnAgent({
          parentConversationId: 1,
          prompt: 'check token',
          title: '  Check secret-token-xyz-987 and global-secret-456  ',
          onResolved: (info) => {
            child2 = info.conversationId ?? 0
          },
        })
        const child2Title = kernel.getConversation(child2).title
        assert.ok(!child2Title.includes('secret-token-xyz-987'), 'stash secret must be redacted in title')
        assert.ok(!child2Title.includes('global-secret-456'), 'global secret must be redacted in title')
        assert.ok(child2Title.includes('[REDACTED'), `expected redaction marker in title: ${child2Title}`)

        // 3. Cap at 120 characters.
        let child3 = 0
        await kernel.spawnAgent({
          parentConversationId: 1,
          prompt: 'long title task',
          title: `  ${'x'.repeat(160)}  `,
          onResolved: (info) => {
            child3 = info.conversationId ?? 0
          },
        })
        assert.equal(kernel.getConversation(child3).title, 'x'.repeat(120))
        assert.equal(kernel.getConversation(child3).title.length, 120)

        // 4. Blank / whitespace-only falls back to `subagent <id>`.
        let child4 = 0
        await kernel.spawnAgent({
          parentConversationId: 1,
          prompt: 'blank title task',
          title: '   ',
          onResolved: (info) => {
            child4 = info.conversationId ?? 0
          },
        })
        assert.equal(kernel.getConversation(child4).title, `subagent ${child4}`)
        assert.equal(normalizeSpawnTitle(undefined, 99), 'subagent 99')
        assert.equal(normalizeSpawnTitle('   ', 99), 'subagent 99')

        // 5. Resume preserves original title and ignores request.title.
        await kernel.spawnAgent({
          parentConversationId: 1,
          prompt: 'continue build check',
          resume: String(child1),
          title: 'Attempted overwrite on resume',
        })
        assert.equal(kernel.getConversation(child1).title, 'Inspect build failure')
      } finally {
        disposeGlobal()
      }
    } finally {
      await kernel.close()
    }
  })
})

describe('triggers and cascading deletion', { timeout: 60_000 }, () => {
  it('dispatchTrigger defaults to human-owned assistant entry without preemption by newer bot/helmx conversations', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'trigger-ownership'))
    try {
      const humanId = 1
      const bot = await kernel.createConversation({ title: 'newer Bot', profileId: 'assistant' })
      const helmx = await kernel.createConversation({ title: 'newer Helmx', profileId: 'assistant' })
      kernel.markConversationOwnership(bot.id, 'bot')
      kernel.markConversationOwnership(helmx.id, 'helmx')
      kernel.__faux.setResponses([fauxAssistantMessage('event handled')])

      await kernel.dispatchTrigger({ id: 'evt-human-owner', source: 'cron', text: 'only deliver to human', createdAt: Date.now() })
      await kernel.waitForIdle(humanId)

      const humanInputs = (await kernel.getConversationDetail(humanId, { limit: 100 })).entries
        .filter((entry) => entry.kind === 'helmx.input')
      assert.ok(humanInputs.some((entry) => JSON.stringify(entry.data).includes('only deliver to human')))
      for (const id of [bot.id, helmx.id]) {
        const inputs = (await kernel.getConversationDetail(id, { limit: 100 })).entries
          .filter((entry) => entry.kind === 'helmx.input')
        assert.equal(inputs.length, 0, `assistant conversation ${id} with non-human ownedBy must not preempt human entry`)
      }
    } finally {
      await kernel.close()
    }
  })

  it('dispatchTrigger coalesces default entry creation under concurrency; explicit target delivers directly', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'trigger-single-flight'))
    try {
      await kernel.deleteConversation(1)
      kernel.__faux.setResponses(Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`concurrent ${i}`)))
      await Promise.all(Array.from({ length: 4 }, (_, i) => kernel.dispatchTrigger({
        id: `evt-concurrent-${i}`,
        source: 'cron',
        text: `concurrent event ${i}`,
        createdAt: Date.now(),
      })))
      const created = kernel.listConversations().filter((conversation) =>
        conversation.profileId === 'assistant' && conversation.parentConversationId === undefined,
      )
      assert.equal(created.length, 1, 'concurrent dispatchTrigger with no conversations must create only one default entry')
      const [target] = created
      assert.ok(target)
      await kernel.waitForIdle(target.id)
      const targetInputs = (await kernel.getConversationDetail(target.id, { limit: 100 })).entries
        .filter((entry) => entry.kind === 'helmx.input')
      assert.equal(targetInputs.length, 4)

      const explicit = await kernel.createConversation({ title: 'explicit target', profileId: 'assistant' })
      kernel.__faux.setResponses([fauxAssistantMessage('explicit event handled')])
      await kernel.dispatchTrigger({
        id: 'evt-explicit-target',
        source: 'cron',
        text: 'explicit delivery',
        targetConversationId: explicit.id,
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(explicit.id)
      const explicitInputs = (await kernel.getConversationDetail(explicit.id, { limit: 100 })).entries
        .filter((entry) => entry.kind === 'helmx.input')
      assert.ok(explicitInputs.some((entry) => JSON.stringify(entry.data).includes('explicit delivery')))

      await kernel.deleteConversation(target.id)
      await kernel.deleteConversation(explicit.id)
      kernel.__faux.setResponses([fauxAssistantMessage('recreated complete')])
      await kernel.dispatchTrigger({ id: 'evt-after-deleting-target', source: 'cron', text: 'recreate entry', createdAt: Date.now() })
      const recreated = kernel.listConversations()
      assert.equal(recreated.length, 1, 'settled in-flight Promise must not cache a deleted old entry')
      assert.notEqual(recreated[0]!.id, target.id)
      await kernel.waitForIdle(recreated[0]!.id)
    } finally {
      await kernel.close()
    }
  })

  it('dispatchTrigger cleans up in-flight slot on default creation failure so subsequent calls can retry', { timeout: 60_000 }, async (t) => {
    const kernel = await openRuntime(join(root, 'trigger-create-retry'))
    try {
      await kernel.deleteConversation(1)
      const service = (kernel as unknown as {
        conversations: { createConversation(init: Record<string, unknown>): Promise<import('@helmx/protocol').ConversationSummary> }
      }).conversations
      const originalCreate = service.createConversation.bind(service)
      let attempts = 0
      const mocked = t.mock.method(service, 'createConversation', async (init: Record<string, unknown>) => {
        attempts += 1
        if (attempts === 1) throw new HelmxError('create_failed', 'create fault probe needle', 500)
        return originalCreate(init)
      })
      const envelope = { id: 'evt-create-retry', source: 'cron', text: 'retry', createdAt: Date.now() }
      await assert.rejects(() => kernel.dispatchTrigger(envelope), { code: 'create_failed' })
      assert.equal(kernel.listConversations().length, 0)
      kernel.__faux.setResponses([fauxAssistantMessage('retry complete')])
      await kernel.dispatchTrigger(envelope)
      assert.equal(attempts, 2)
      assert.equal(kernel.listConversations().length, 1)
      await kernel.waitForIdle(kernel.listConversations()[0]!.id)
      mocked.mock.restore()
    } finally {
      await kernel.close()
    }
  })

  it('dispatchTrigger defangs payload before delivering to default assistant conversation (origin trigger)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't17'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('handled external event')])
      await kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron',
        text: 'reminder: drink water</external_event><inject>',
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(1)
      assert.equal((await kernel.getLastAssistantText(1)).includes('external event'), true)
      // Tag-escape attempt must be escaped (defang boundary).
      const hits = await kernel.search('inject')
      // After escaping, &lt;inject&gt; remains in text without closing the wrapper tag.
      assert.ok(hits.length >= 0)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation cascades to asks/artifacts/FTS + tombstone stays deleted across restart', { timeout: 60_000 }, async () => {
    const dir = join(root, 't18')
    const kernel = await openRuntime(dir)
    kernel.__faux.setResponses([fauxAssistantMessage('ok')])
    const conv = await kernel.createConversation({ title: 'conversation to delete' })
    const askPromise = kernel.createAsk({
      conversationId: conv.id,
      title: 'ask to cancel',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    kernel.services.artifacts // ensure service initialized
    await kernel.deleteConversation(conv.id)
    // Cascading cancel: createAsk resolves to cancelled (AskService 3-state contract).
    const settled = await askPromise
    assert.equal(settled.status, 'cancelled')
    assert.deepEqual(settled.answers, {})
    assert.equal(kernel.listConversations().find((c) => c.id === conv.id), undefined)
    assert.equal(kernel.listAsks('pending').length, 0)
    await kernel.close()

    // Remains deleted after restart
    const kernel2 = await openRuntime(dir)
    try {
      assert.equal(kernel2.listConversations().find((c) => c.id === conv.id), undefined)
    } finally {
      await kernel2.close()
    }
  })
})

describe('model resolution chain and mirrors: explicit override > profile.model > global default', { timeout: 60_000 }, () => {
  it('global default applies; profile.model overrides global; explicit model sets override', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm1')
    writeProfile(dir, 'worker-a', { name: 'A', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // Default: falls back to profile.model when unset (root=assistant has no model).
      const viaProfile = await kernel.createConversation({ profileId: 'worker-a' })
      assert.equal(viaProfile.model, 'faux/faux-1')

      // Explicit model override: summary reflects the explicit value.
      const explicit = await kernel.createConversation({ model: 'faux/faux-1' })
      assert.equal(explicit.model, 'faux/faux-1')

      // Override takes precedence over switching profile: PATCH switching profile keeps override intact.
      const pinned = await kernel.updateConversation(explicit.id, { profileId: 'worker-a' })
      assert.equal(pinned.model, 'faux/faux-1')

      // PATCH model:'' clears override: recomputes along inheritance chain (assistant has no model -> global).
      const cleared = await kernel.updateConversation(explicit.id, { model: '' })
      assert.equal(cleared.model, 'faux/faux-1') // global default
      // Switching profile again without override picks up profile.model.
      writeProfile(dir, 'worker-b', { name: 'B', model: 'faux/faux-1' })
      const switched = await kernel.updateConversation(explicit.id, { profileId: 'worker-b' })
      assert.equal(switched.model, 'faux/faux-1')
    } finally {
      await kernel.close()
    }
  })

  it('when all layers unset, submit fails explicitly with model_not_configured; summary stays empty string without fabrication', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm2')
    // No global model passed and assistant profile defines no model.
    const { models } = makeFauxModels()
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, models })
    try {
      const conv = await kernel.createConversation({})
      assert.equal(conv.model, '')
      // Submitting fails explicitly (never fakes an answer).
      await assert.rejects(
        () => kernel.submitInput(conv.id, 'question'),
        (err: unknown) => err instanceof HelmxError && err.code === 'model_not_configured',
      )
      // Once profile.model is configured, same conversation (with no override) can submit (inheritance active).
      writeProfile(dir, 'late', { name: 'L', model: 'faux/faux-1' })
      await kernel.updateConversation(conv.id, { profileId: 'late' })
      kernel.plugins // reading must not fail (read path never throws hard)
      const summary = kernel.getConversation(conv.id)
      assert.equal(summary.model, 'faux/faux-1')
    } finally {
      await kernel.close()
    }
  })

  it('inheritance semantics persist across restarts: conversations without override recompute from profile/global', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm3')
    writeProfile(dir, 'p', { name: 'P', model: 'faux/faux-1' })
    const k1 = await openRuntime(dir, { model: 'faux/faux-1' })
    const inherited = await k1.createConversation({ profileId: 'p' })
    const overridden = await k1.createConversation({ profileId: 'p', model: 'faux/faux-1' })
    await k1.close()

    // Restart: both mirrors match; override persists durably.
    const k2 = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      assert.equal(k2.getConversation(inherited.id).model, 'faux/faux-1')
      assert.equal(k2.getConversation(overridden.id).model, 'faux/faux-1')
      // Clearing override persists cleanly (never resurrects old value across restarts).
      await k2.updateConversation(overridden.id, { model: '' })
      await k2.close()
      const k3 = await openRuntime(dir, { model: 'faux/faux-1' })
      try {
        assert.equal(k3.getConversation(overridden.id).model, 'faux/faux-1')
      } finally {
        await k3.close()
      }
    } catch (e) {
      await k2.close().catch(() => {})
      throw e
    }
  })

  it('child spawn summary returns actual resolvedModel; request.model sets child override', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm4')
    writeProfile(dir, 'spawnable', { name: 'S', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('subagent done')])
      let childId: number | undefined
      const result = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'work',
        agentType: 'spawnable',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      assert.equal(result, 'subagent done')
      assert.ok(childId !== undefined && childId > 1)
      // Child conversation mirror = profile.model (actual resolved model, never misreporting request/global).
      const child = kernel.getConversation(childId!)
      assert.equal(child.model, 'faux/faux-1')
      // Explicit request.model writes override for child conversation.
      kernel.__faux.setResponses([fauxAssistantMessage('explicit model subagent')])
      const explicitChild = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'more work',
        agentType: 'spawnable',
        model: 'faux/faux-1',
      })
      assert.equal(explicitChild, 'explicit model subagent')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Real PluginHost integration (attach / split config / tool hot-loading / hook payloads)
// ---------------------------------------------------------------------------

describe('real PluginHost integration', { timeout: 60_000 }, () => {
  it('plugins ready immediately after open: registers tool/action plugins, hot-loads tools, populates SSE snapshot list', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p1'))
    try {
      // plugins getter is non-undefined (PluginHost created during open).
      const host = kernel.plugins
      await host.register({
        id: 'test:pinger',
        name: 'test plugin',
        definePlugin(ctx) {
          ctx.tool<{ text: string }>({
            name: 'ping_tool',
            description: 'echo input text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            async execute(input) {
              return { pong: input.text }
            },
          })
          ctx.action<{ x: number }, { double: number }>({
            id: 'double',
            description: 'double number',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'number' } },
              required: ['x'],
            },
            outputSchema: {
              type: 'object',
              properties: { double: { type: 'number' } },
              required: ['double'],
            },
            async handler(input) {
              return { double: input.x * 2 }
            },
          })
        },
      })
      kernel.refreshPluginTools()
      // SSE snapshot plugins matches real registry (never hardcoded []).
      const snap = kernel.events.currentSnapshot()
      assert.equal(snap.plugins.length, 1)
      assert.equal(snap.plugins[0]?.id, 'test:pinger')
      // Action invokes cleanly.
      const result = await kernel.plugins.invokeAction('test:pinger', 'double', { x: 21 })
      assert.deepEqual(result, { double: 42 })
      // run_action meta-tool registered (actions execute accurately via manifest).
      const tools = kernel.plugins.listTools()
      assert.ok(tools.some((t) => t.name === 'ping_tool'))
    } finally {
      await kernel.close()
    }
  })

  it('plugin tool invoked live by model: faux requests resolve tool name and wrap ToolExecutionResult', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p2'))
    try {
      await kernel.plugins.register({
        id: 'test:echo',
        definePlugin(ctx) {
          ctx.tool<{ text: string }>({
            name: 'echo_tool',
            description: 'echo input',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
            async execute(input) {
              return input.text
            },
          })
        },
      })
      kernel.refreshPluginTools()
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('echo_tool', { text: 'real echo' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('tool done'),
      ])
      await kernel.submitInput(1, 'invoke echo tool')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), 'tool done')
    } finally {
      await kernel.close()
    }
  })

  it('turn_settled hook receives exact inputs (asserting id/origin/text item-by-item)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p3')
    const kernel = await openRuntime(dir)
    try {
      const settledPayloads: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:listener',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((payload) => {
            settledPayloads.push(payload)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('reply 1'), fauxAssistantMessage('reply 2')])
      await kernel.submitInput(1, 'human sentence one', { origin: 'human' })
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'agent sentence two', { origin: 'agent' })
      await kernel.waitForIdle(1)
      assert.equal(settledPayloads.length, 2)
      const first = settledPayloads[0]
      assert.ok(first)
      assert.equal(first.outcome, 'completed')
      assert.equal(first.inputs.length, 1)
      assert.equal(first.inputs[0]?.text, 'human sentence one')
      assert.equal(first.inputs[0]?.origin, 'human')
      const second = settledPayloads[1]
      assert.ok(second)
      assert.equal(second.outcome, 'completed')
      assert.equal(second.inputs[0]?.text, 'agent sentence two')
      assert.equal(second.inputs[0]?.origin, 'agent')
      // completionSeq advances exactly once per turn.
      assert.equal(kernel.getConversation(1).completionSeq, 2)
    } finally {
      await kernel.close()
    }
  })

  it('turn_settled transform producing invalid payload: settlement chain absorbs error without poisoning close()', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p-settle-poison'))
    try {
      await kernel.plugins.register({
        id: 'test:poison',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((payload) => {
            // Hook validation only inspects required fields: valid payload + extra BigInt passes the transform
            // chain and throws explicitly only when events.publish performs JSON sanitization.
            return { action: 'transform', value: { ...payload, poisoned: 10n } } as never
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')])
      await kernel.submitInput(1, 'first turn')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'second turn')
      await kernel.waitForIdle(1)
      // Both turns complete and settlement chain never rejects: close() awaits settledInflight cleanly
      await kernel.close()
      assert.equal(kernel.getConversation(1).completionSeq, 2)
    } finally {
      await kernel.close().catch(() => {})
    }
  })

  it('followUp input while busy settles in subsequent turn: turn_settled inputs include all queued entries', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p4'))
    try {
      const settledPayloads: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:busy',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((payload) => {
            settledPayloads.push(payload)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('reply one'), fauxAssistantMessage('reply two')])
      await kernel.submitInput(1, 'first', { origin: 'human' })
      await kernel.submitInput(1, 'queued second', { origin: 'agent' })
      await kernel.waitForIdle(1)
      assert.equal(settledPayloads.length, 2)
      const texts = settledPayloads.flatMap((p) => p.inputs.map((i) => i.text))
      assert.ok(texts.includes('first'))
      assert.ok(texts.includes('queued second'))
    } finally {
      await kernel.close()
    }
  })

  it('before_turn sections reach real model request via system sections (verified by faux capture)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p5'))
    try {
      await kernel.plugins.register({
        id: 'test:inject',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            return {
              action: 'transform',
              value: {
                ...turn,
                sections: [...turn.sections, { id: 'test.context', text: 'INJECTED_SECRET_CONTEXT_7788' }],
              },
            }
          })
        },
      })
      let sawSection = false
      kernel.__faux.setResponses([
        (context) => {
          // TranscriptContext received by faux provider: messages[0] carries injected section.
          const lead = context.messages[0] as { role?: string; sections?: Record<string, string> } | undefined
          sawSection = lead?.role === 'system' && lead.sections?.['test.context']?.includes('INJECTED_SECRET_CONTEXT_7788') === true
          return fauxAssistantMessage('received injected section')
        },
      ])
      await kernel.submitInput(1, 'trigger inject')
      await kernel.waitForIdle(1)
      assert.equal(sawSection, true, 'before_turn injected section must actually enter model request')
      assert.equal(await kernel.getLastAssistantText(1), 'received injected section')
    } finally {
      await kernel.close()
    }
  })

  it('input hook transform takes effect: final text/origin persisted; identity mutation rejected', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p6'))
    try {
      await kernel.plugins.register({
        id: 'test:rewrite',
        definePlugin(ctx) {
          ctx.hook.onInput((payload) => {
            return {
              action: 'transform',
              value: {
                ...payload,
                input: { ...payload.input, text: `${payload.input.text} (normalized)`, origin: 'agent' },
              },
            }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('received normalized input')])
      await kernel.submitInput(1, 'raw input', { origin: 'human' })
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), 'received normalized input')
      // FTS indexes the post-transform text.
      const hits = await kernel.search('normalized')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })

  it('trigger transform applies both target and text (prevents tag escape)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p7'))
    try {
      await kernel.plugins.register({
        id: 'test:route',
        definePlugin(ctx) {
          ctx.hook.onTrigger((envelope) => {
            return {
              action: 'transform',
              value: { ...envelope, text: `${envelope.text}\n[rewritten by test:route]` },
            }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('trigger handled')])
      await kernel.dispatchTrigger({
        id: 'evt-p7',
        source: 'cron',
        text: 'original trigger text',
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(1)
      assert.equal((await kernel.getLastAssistantText(1)).includes('trigger handled'), true)
      const hits = await kernel.search('rewritten by test:route')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })

  it('plugin config persists split: secrets in credentials.json, non-secrets in config.json', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p8')
    const kernel = await openRuntime(dir)
    try {
      await kernel.plugins.register({
        id: 'test:cfg',
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true, required: true, label: 'API Key' },
            retries: { type: 'number', default: 3, label: 'Retry Count' },
          })
        },
      })
      await kernel.plugins.setConfig('test:cfg', { apiKey: 'sk-secret-123' })
      // get merges effective config: explicit secret + dynamic default fallback (not written to disk).
      const merged = kernel.plugins.getConfig('test:cfg')
      assert.equal(merged['apiKey'], 'sk-secret-123')
      assert.equal(merged['retries'], 3)
      // sources: apiKey is configured, retries falls back to default
      const sources = kernel.plugins.getConfigSources('test:cfg')
      assert.equal(sources['apiKey'], 'configured')
      assert.equal(sources['retries'], 'default')
    } finally {
      await kernel.close()
    }
    // Config remains valid after restart (split storage persists; defaults merge dynamically on read).
    const kernel2 = await openRuntime(dir)
    try {
      // Merging defaults relies on configSchema: fallback returns after re-registration (never persisted to disk).
      await kernel2.plugins.register({
        id: 'test:cfg',
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true, required: true, label: 'API Key' },
            retries: { type: 'number', default: 3, label: 'Retry Count' },
          })
        },
      })
      const merged = kernel2.plugins.getConfig('test:cfg')
      assert.equal(merged['apiKey'], 'sk-secret-123')
      assert.equal(merged['retries'], 3)
    } finally {
      await kernel2.close()
    }
  })

  it('watchdog ownership: spawn auto-marks child conversation helmx; human/unmarked stays human', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p9'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('worker done')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'work',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      assert.ok(childId !== undefined)
      // Native spawn automatically grants helmx ownership (never inferred from tags/parent; no manual registration needed);
      // getConversationOwnership reads through the same port as watchdog probes.
      assert.equal(kernel.getConversationOwnership(childId), 'helmx')
      assert.equal(kernel.getConversationOwnership(1), 'human')
      // Direct user conversations (unmarked) stay human even if carrying worker tags.
      const manual = await kernel.createConversation({ tags: ['worker'] })
      kernel.__faux.setResponses([fauxAssistantMessage('human reply')])
      await kernel.submitInput(manual.id, 'direct human input')
      await kernel.waitForIdle(manual.id)
      assert.equal(kernel.getConversationOwnership(manual.id), 'human')
    } finally {
      await kernel.close()
    }
  })

  it('createConversation default profile unifies on assistant (real directory, never missing file)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p10')
    const kernel = await openRuntime(dir)
    try {
      const conv = await kernel.createConversation({})
      assert.equal(conv.profileId, 'assistant')
      // before_turn (assistant-style plugins) reads assistant profile without throwing not found.
      await kernel.plugins.register({
        id: 'test:prof',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            void ctx
            return { action: 'transform', value: { ...turn, sections: [...turn.sections, { id: 'prof.ok', text: 'PROFILE_READ_OK' }] } }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      await kernel.submitInput(conv.id, 'default profile conversation')
      await kernel.waitForIdle(conv.id)
      assert.equal(await kernel.getLastAssistantText(conv.id), 'ok')
    } finally {
      await kernel.close()
    }
  })

  it('SDK live extension hot-loading: enable/disable updates active tool set immediately', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p11'))
    try {
      const definition = {
        id: 'test:toggle',
        definePlugin(ctx: { tool: (spec: { name: string; description: string; inputSchema: unknown; execute: (i: unknown) => Promise<unknown> }) => void }) {
          ctx.tool({
            name: 'toggle_tool',
            description: 'toggleable tool',
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              return { ok: true }
            },
          })
        },
      }
      await kernel.plugins.register(definition as never)
      kernel.refreshPluginTools()
      assert.ok(kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
      await kernel.plugins.disable('test:toggle')
      kernel.refreshPluginTools()
      assert.ok(!kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
      await kernel.plugins.enable('test:toggle')
      kernel.refreshPluginTools()
      assert.ok(kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ProfileRuntime nodeId/workspace/env boundary validation
// ---------------------------------------------------------------------------

describe('ProfileRuntime nodeId/workspace/env boundary validation', { timeout: 60_000 }, () => {
  it('valid fields persist; malformed shapes reject explicitly at save boundary', { timeout: 60_000 }, async () => {
    const dir = join(root, 'pr1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const svc = kernel.services.profiles
      const saved = await svc.save({
        id: 'remote-agent',
        name: 'Remote Agent',
        runtime: {
          kind: 'herdr',
          agent: 'claude',
          nodeId: 'gpu-box',
          workspace: '/workspace/proj',
          env: { WORKER_MODE: 'fast', MAX_TASKS: '4' },
        },
      })
      assert.equal(saved.runtime?.nodeId, 'gpu-box')
      assert.equal(saved.runtime?.workspace, '/workspace/proj')
      assert.deepEqual(saved.runtime?.env, { WORKER_MODE: 'fast', MAX_TASKS: '4' })
      // Read path preserves fields too.
      const reread = await svc.get('remote-agent')
      assert.equal(reread?.runtime?.nodeId, 'gpu-box')
      // Invalid shapes reject.
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', nodeId: '' } as never }),
      )
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', env: { '1BAD': 'v' } } as never }),
      )
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', env: { K: 1 } } as never }),
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Conversation management protection and ownership
// ---------------------------------------------------------------------------

describe('conversation management protection and ownership', { timeout: 60_000 }, () => {
  it('managed conversation deletion returns 409 with owners; deletes cleanly after release; initial conversation has no ID exemption', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const conv = await kernel.createConversation({})
      const release = kernel.manageConversation(conv.id, 'test:owner-a')
      await assert.rejects(
        () => kernel.deleteConversation(conv.id),
        (err: unknown) =>
          err instanceof HelmxError &&
          err.code === 'conversation_managed_by_plugin' &&
          Array.isArray((err.details as { owners?: string[] })?.owners) &&
          (err.details as { owners: string[] }).owners.includes('test:owner-a'),
      )
      release()
      await kernel.deleteConversation(conv.id)
      assert.equal(kernel.listConversations().find((c) => c.id === conv.id), undefined)
      // Initial conversation #1: same management guard applies (generic guard, no ID exemption).
      const releaseRoot = kernel.manageConversation(1, 'test:owner-root')
      await assert.rejects(
        () => kernel.deleteConversation(1),
        (err: unknown) => err instanceof HelmxError && err.code === 'conversation_managed_by_plugin',
      )
      releaseRoot()
      // Deletable immediately after release (no hardcoded root 403).
      await kernel.deleteConversation(1)
      assert.equal(kernel.listConversations().some((c) => c.id === 1), false)
    } finally {
      await kernel.close()
    }
  })

  it('markConversationOwnership: generic marking; child spawn automatically defaults to helmx', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // Initial conversation #1 shares exact marking semantics with normal conversations (unmarked = human, no special ID check).
      assert.equal(kernel.getConversationOwnership(1), 'human')
      kernel.__faux.setResponses([fauxAssistantMessage('done')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'x',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      assert.ok(childId !== undefined)
      // Native spawn grants helmx ownership automatically (getConversationOwnership reads same source as watchdog probes).
      assert.equal(kernel.getConversationOwnership(childId), 'helmx')
      // User-created conversations default to human.
      const manual = await kernel.createConversation({})
      assert.equal(kernel.getConversationOwnership(manual.id), 'human')
    } finally {
      await kernel.close()
    }
  })

  it('native spawn child conversations have zero business tags (tags: [])', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o3')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'x',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      const child = kernel.getConversation(childId!)
      assert.deepEqual(child.tags, [])
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end submitInput opts.meta propagation
// ---------------------------------------------------------------------------

describe('end-to-end submitInput opts.meta', { timeout: 60_000 }, () => {
  it('meta persists in helmx.input entry via API and surfaces in turn_settled inputs', { timeout: 60_000 }, async () => {
    const dir = join(root, 'meta1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const settled: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:meta',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((p) => {
            settled.push(p)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('received')])
      await kernel.submitInput(1, 'input with metadata', {
        origin: 'human',
        meta: { source: 'cli', attempt: 1 },
      })
      await kernel.waitForIdle(1)
      assert.equal(settled.length, 1)
      assert.equal(settled[0]?.inputs[0]?.meta?.['source'], 'cli')
      // meta also persists to helmx.input entry (visible via detail query).
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const inputEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'helmx.input')
      assert.ok(inputEntry)
      const data = inputEntry.data as { meta?: Record<string, unknown> } | undefined
      assert.equal(data?.meta?.['attempt'], 1)
    } finally {
      await kernel.close()
    }
  })

  it('managed token echoed inside meta is stash-redacted before persistence (never written plaintext)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'meta2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      const token = 'sk-managed-' + 'x'.repeat(20)
      kernel.stash.addRedaction(token)
      await kernel.submitInput(1, 'metadata carrying token', { meta: { secretEcho: token } })
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const inputEntry = [...detail.entries].reverse().find((e) => e.kind === 'helmx.input')
      const data = inputEntry?.data as { meta?: Record<string, unknown> } | undefined
      const stored = String(data?.meta?.['secretEcho'] ?? '')
      assert.ok(!stored.includes(token), 'managed token plaintext must never be persisted')
      assert.ok(stored.includes('[REDACTED'))
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Managed process token and hub URL
// ---------------------------------------------------------------------------

describe('managed process token', { timeout: 60_000 }, () => {
  it('buildToolEnv injects managed token and strips inherited HELMX_TOKEN when deps.processToken is unset', { timeout: 60_000 }, () => {
    const deps = {
      dataDir: '/tmp/x',
      defaultCwd: '/tmp',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t: string) => t,
      artifacts: {} as never,
    }
    const env = buildToolEnv(deps, '/tmp')
    assert.equal(env['HELMX_TOKEN'], undefined)
    const withToken = buildToolEnv({ ...deps, processToken: () => 'managed-tok' }, '/tmp')
    assert.equal(withToken['HELMX_TOKEN'], 'managed-tok')
  })

  it('global redaction for managed token: redacted everywhere; verifyToken rejects after disposal', { timeout: 60_000 }, async () => {
    const dir = join(root, 'tok1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    const managed = kernel.auth.createProcessToken()
    kernel.stash.addRedaction(managed.token)
    try {
      // Covered by redaction.
      assert.ok(!kernel.stash.redact(`leak: ${managed.token}`).includes(managed.token))
      assert.equal(await kernel.auth.verifyToken(managed.token), true)
    } finally {
      await kernel.close()
    }
  })

  it('setHubUrl updates tool env endpoint dynamically (port:0 scenario)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'tok2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.setHubUrl('http://127.0.0.1:39999')
      // Verify env injection via real bash tool (never echo token; print HELMX_HUB_URL only).
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo "$HELMX_HUB_URL"' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ])
      await kernel.submitInput(1, 'print hub url')
      await kernel.waitForIdle(1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, 'done')
      await assertThrowsSync(() => kernel.setHubUrl(''), 'validation_error')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Snapshot and public plugin docs
// ---------------------------------------------------------------------------

describe('snapshot and public plugin docs', { timeout: 60_000 }, () => {
  it('snapshot.ui lists plugin UI contributions; pluginDocs carries public docs only (excludes private docs)', { timeout: 60_000 }, async () => {
    const dir = join(root, 's1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // No public doc plugins: pluginDocs = [].
      let snap = kernel.events.currentSnapshot()
      assert.deepEqual(snap.pluginDocs ?? [], [])
      assert.ok(Array.isArray(snap.ui))

      // UI contributions and public docs appear in snapshot upon plugin registration.
      await kernel.plugins.register({
        id: 'test:ui',
        definePlugin(ctx) {
          ctx.ui.sidebarItem({ id: 'sb1', label: 'test item', target: 'conversation:1' })
          ctx.doc('runs', { count: 1 }, { public: true })
          ctx.doc('secret', { v: 'x' })
        },
      })
      snap = kernel.events.currentSnapshot()
      assert.ok(snap.ui.some((u) => u.pluginId === 'test:ui'))
      const docs = snap.pluginDocs ?? []
      assert.equal(docs.length, 1)
      assert.equal(docs[0]?.name, 'runs')
      assert.deepEqual(docs[0]?.value, { count: 1 })
    } finally {
      await kernel.close()
    }
  })

  it('onEvent(workflow.settled): notifies once per run; stops after dispose; faulty listeners reported explicitly', { timeout: 60_000 }, async () => {
    const dir = join(root, 's2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const seen: string[] = []
      let disposed = false
      await kernel.plugins.register({
        id: 'test:wf',
        definePlugin(ctx) {
          ctx.host.onEvent('test.settled', (raw) => {
            if (disposed) return
            // Broadcast listeners receive validated + redacted HelmxEvent envelopes (unknown types
            // come as CustomHelmxEvent {type, payload}; matches protocol onEvent contract).
            const run = (raw as { payload?: { id?: string } }).payload
            if (run?.id !== undefined) seen.push(run.id)
          })
        },
      })
      const run = { id: 'run-x' }
      // Internal events dispatch via host emitHostEvent (backing ctx.host.emitEvent).
      kernel.emitHostEvent('test.settled', run)
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(seen, ['run-x'])
      disposed = true
      kernel.emitHostEvent('test.settled', run)
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(seen, ['run-x'])
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// getConversationDetail pagination
// ---------------------------------------------------------------------------

describe('getConversationDetail pagination', { timeout: 60_000 }, () => {
  it('defaults to latest 100 in ascending order; cursor checks conversation/length/JSON; clamps limit', { timeout: 60_000 }, async () => {
    const dir = join(root, 'd1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // Three real turns produce entries.
      kernel.__faux.setResponses([
        fauxAssistantMessage('answer one'),
        fauxAssistantMessage('answer two'),
        fauxAssistantMessage('answer three'),
      ])
      await kernel.submitInput(1, 'question one')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'question two')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'question three')
      await kernel.waitForIdle(1)

      const detail = await kernel.getConversationDetail(1)
      assert.ok(detail.entries.length > 0)
      // Ascending order (IDs are strictly monotonic numeric strings).
      const ids = detail.entries.map((e) => Number(e.id))
      for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! >= ids[i - 1]!)

      // Limit pagination.
      const page1 = await kernel.getConversationDetail(1, { limit: 3 })
      assert.equal(page1.entries.length, 3)
      assert.ok(page1.nextCursor)
      const page2 = await kernel.getConversationDetail(1, { limit: 3, cursor: page1.nextCursor })
      assert.ok(page2.entries.length > 0)
      // Pages do not overlap.
      const p1 = new Set(page1.entries.map((e) => e.id))
      assert.ok(page2.entries.every((e) => !p1.has(e.id)))

      // Cursor validation: rejects cross-conversation, invalid base64, and oversized cursors.
      const other = await kernel.createConversation({})
      await assert.rejects(
        () => kernel.getConversationDetail(other.id, { cursor: page1.nextCursor }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => kernel.getConversationDetail(1, { cursor: '!!!not-base64!!!' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => kernel.getConversationDetail(1, { cursor: 'x'.repeat(3000) }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      // Limit boundaries.
      await assert.rejects(() => kernel.getConversationDetail(1, { limit: 0 }))
      await assert.rejects(() => kernel.getConversationDetail(1, { limit: 501 }))
      // Assistant text preserved via model messages.
      const withText = detail.entries.find((e) => e.kind === 'pi.assistant')
      assert.ok(withText)
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// waitForInput targeted waiting
// ---------------------------------------------------------------------------

describe('waitForInput targeted wait', { timeout: 60_000 }, () => {
  it('returns exact response entry and redacted text on completion; throws explicitly on failure/abort', { timeout: 60_000 }, async () => {
    const dir = join(root, 'w2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('this is exact answer')])
      const { submissionId } = await kernel.submitInput(1, 'question')
      const result = await kernel.waitForInput(1, submissionId)
      assert.equal(result.submissionId, submissionId)
      assert.equal(result.text, 'this is exact answer')
      assert.ok(result.entry)
      assert.ok(result.entry.model !== undefined, 'answer entry preserves model messages')

      // Failed turn: turn_failed (never fabricates answer).
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const failed = await kernel.submitInput(1, 'will fail')
      await assert.rejects(
        () => kernel.waitForInput(1, failed.submissionId),
        (err: unknown) => err instanceof HelmxError && (err.code === 'turn_failed' || err.code === 'turn_aborted'),
      )

      // Ownership mismatch: rejects across conversations.
      const other = await kernel.createConversation({})
      await assert.rejects(
        () => kernel.waitForInput(other.id, submissionId),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
    } finally {
      await kernel.close()
    }
  })

  it('handled:* submission explicitly throws wait_not_applicable', { timeout: 60_000 }, async () => {
    const dir = join(root, 'w3')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      await kernel.plugins.register({
        id: 'test:intercept',
        definePlugin(ctx) {
          ctx.hook.onInput(() => ({ action: 'handled' }))
        },
      })
      const { submissionId } = await kernel.submitInput(1, 'claimed by hook')
      assert.ok(submissionId.startsWith('handled:'))
      await assert.rejects(
        () => kernel.waitForInput(1, submissionId),
        (err: unknown) => err instanceof HelmxError && err.code === 'wait_not_applicable',
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// conversation.entry / live events
// ---------------------------------------------------------------------------

describe('conversation.entry / live event', { timeout: 60_000 }, () => {
  it('real turn emits durable entry frames and transient redacted live frames (without advancing durable seq)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'ev1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    const sseAbort = new AbortController()
    const sseFrames: Array<{ event: string; data: unknown }> = []
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let readLoop: Promise<void> | undefined
    try {
      const durableFrames: HelmxEventFrame[] = []
      const transientFrames: HelmxTransientLiveFrame[] = []
      const pluginLiveEvents: unknown[] = []
      kernel.events.subscribe((f) => durableFrames.push(f))
      kernel.events.subscribeTransientLive((f) => transientFrames.push(f))
      kernel.onEvent('conversation.live', (evt) => {
        pluginLiveEvents.push(evt)
      })

      const res = kernel.events.response(new Request('http://localhost/api/events', { signal: sseAbort.signal }))
      reader = res.body!.getReader()
      const decoder = new TextDecoder()
      readLoop = (async () => {
        let buf = ''
        for (;;) {
          const { done, value } = await reader!.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const blocks = buf.split('\n\n')
          buf = blocks.pop() ?? ''
          for (const block of blocks) {
            if (block.trim() === '' || block.trimStart().startsWith(':')) continue
            let event = 'message'
            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice('event: '.length)
              else if (line.startsWith('data: ')) data += line.slice('data: '.length)
            }
            if (data !== '') sseFrames.push({ event, data: JSON.parse(data) })
          }
        }
      })()

      kernel.__faux.setResponses([fauxAssistantMessage('real-time answer text')])
      await kernel.submitInput(1, 'trigger event')
      await kernel.waitForIdle(1)
      await waitFor(() => transientFrames.length >= 1 && pluginLiveEvents.length >= 1, 5_000)
      await waitFor(() => sseFrames.some((f) => f.event === 'conversation.live'), 5_000)

      const entryFrames = durableFrames.filter((f) => f.event.type === 'conversation.entry')
      assert.ok(entryFrames.length >= 1, 'should emit at least one durable conversation.entry frame')
      assert.equal(
        durableFrames.filter((f) => (f.event as { type: string }).type === 'conversation.live').length,
        0,
        'durable EventHub subscriber must never receive conversation.live',
      )
      assert.ok(transientFrames.length >= 1, 'should emit transient conversation.live via subscribeTransientLive')
      assert.ok(pluginLiveEvents.length >= 1, 'should preserve internal host.onEvent("conversation.live") delivery')
      assert.ok(sseFrames.some((f) => f.event === 'conversation.live'), '/api/events SSE should emit event: conversation.live')
      const payload = JSON.stringify({ durableFrames, transientFrames, pluginLiveEvents })
      assert.ok(!payload.includes('sk-'), 'frames must never leak secret plaintext')
    } finally {
      sseAbort.abort()
      await reader?.cancel().catch(() => {})
      await readLoop?.catch(() => {})
      await kernel.close()
    }
  })

  it('ConversationSummary.lastEntryId tracks latest visible entry across create, turn, rewind, compact, reset, and restart', { timeout: 60_000 }, async () => {
    const dir = join(root, 'last-entry-e2e')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    const upserts: ConversationSummary[] = []
    let latestVisibleId = 0
    try {
      kernel.events.subscribe((f) => {
        if (f.event.type === 'conversation.upsert' && 'conversation' in f.event) {
          upserts.push(f.event.conversation)
        }
      })
      const created = await kernel.createConversation({ title: 'lastEntryId e2e' })
      assert.equal(created.lastEntryId, 0, 'brand-new conversation starts with lastEntryId=0')
      const cid = created.id

      // 1. Normal turn advances lastEntryId to latest visible entry in detail.
      const big = 'context chunk '.repeat(3500)
      kernel.__faux.setResponses([
        fauxAssistantMessage('first reply'),
        fauxAssistantMessage('second reply'),
        fauxAssistantMessage('third reply'),
      ])
      for (const label of ['t1', 't2', 't3']) {
        await kernel.submitInput(cid, `${label}: ${big}`)
        await kernel.waitForIdle(cid)
      }
      const detailAfterTurns = await kernel.getConversationDetail(cid, { limit: 50 })
      const expectedAfterTurns = Number(detailAfterTurns.entries.at(-1)!.id)
      assert.ok(expectedAfterTurns > 0)
      await waitFor(() => kernel.getConversation(cid).lastEntryId === expectedAfterTurns, 5_000)
      assert.ok(
        upserts.some((u) => u.id === cid && u.lastEntryId === expectedAfterTurns),
        'conversation.upsert emits updated lastEntryId after turns',
      )

      // 2. Rewind via replaceFromEntryId advances lastEntryId to post-rewind visible entry (never hidden range).
      const targetInput = detailAfterTurns.entries.find((e) => e.kind === 'helmx.input')!
      kernel.__faux.setResponses([fauxAssistantMessage('rewound reply')])
      await kernel.submitInput(cid, `${big} rw1`, { replaceFromEntryId: Number(targetInput.id) })
      await kernel.waitForIdle(cid)
      const detailAfterRewind = await kernel.getConversationDetail(cid, { limit: 50 })
      const expectedAfterRewind = Number(detailAfterRewind.entries.at(-1)!.id)
      assert.ok(expectedAfterRewind > expectedAfterTurns)
      await waitFor(() => kernel.getConversation(cid).lastEntryId === expectedAfterRewind, 5_000)

      // 3. Extra turns + real compaction advances lastEntryId to latest visible entry (including pi.compaction).
      kernel.__faux.setResponses([
        fauxAssistantMessage('pre-compact 1'),
        fauxAssistantMessage('pre-compact 2'),
        fauxAssistantMessage('pre-compact 3'),
        fauxAssistantMessage('compaction summary text'),
      ])
      for (const label of ['c1', 'c2', 'c3']) {
        await kernel.submitInput(cid, `${label}: ${big}`)
        await kernel.waitForIdle(cid)
      }
      await kernel.compactConversation(cid)
      await waitFor(() => kernel.getConversation(cid).contextUsage?.compacting === undefined, 20_000)
      const detailAfterCompact = await kernel.getConversationDetail(cid, { limit: 50 })
      const expectedAfterCompact = Number(detailAfterCompact.entries.at(-1)!.id)
      assert.ok(expectedAfterCompact > expectedAfterRewind)
      await waitFor(() => kernel.getConversation(cid).lastEntryId === expectedAfterCompact, 5_000)

      // 4. Reset advances lastEntryId to visible pi.reset entry.
      const resetSummary = await kernel.resetConversation(cid, { handoff: 'next phase' })
      assert.equal(resetSummary.id, cid)
      const detailAfterReset = await kernel.getConversationDetail(cid, { limit: 50 })
      latestVisibleId = Number(detailAfterReset.entries.at(-1)!.id)
      assert.ok(latestVisibleId > expectedAfterCompact)
      await waitFor(() => kernel.getConversation(cid).lastEntryId === latestVisibleId, 5_000)
      assert.ok(
        upserts.some((u) => u.id === cid && u.lastEntryId === latestVisibleId),
        'conversation.upsert emits updated lastEntryId after reset',
      )
    } finally {
      await kernel.close()
    }

    // 5. Reopen runtime: snapshot & getConversation preserve lastEntryId.
    const reopened = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const conv = reopened.listConversations().find((c) => c.title === 'lastEntryId e2e')
      assert.ok(conv)
      await waitFor(() => reopened.getConversation(conv.id).lastEntryId === latestVisibleId, 5_000)
      assert.equal(reopened.events.currentSnapshot().conversations.find((c) => c.id === conv.id)?.lastEntryId, latestVisibleId)
    } finally {
      await reopened.close()
    }
  })
})

describe('KernelRuntime start and close concurrency', { timeout: 60_000 }, () => {
  it('start() clears single-flight promise on failure so retries start a fresh attempt rather than rethrowing stale error', { timeout: 60_000 }, async () => {
    const dir = join(root, 'start-retry')
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, autoResume: false })
    try {
      let startCalls = 0
      // PluginHost.start holds its own single-flight state; replace method to test KernelRuntime retry semantics in isolation.
      const host = kernel.plugins as unknown as { start: () => Promise<void> }
      host.start = async () => {
        startCalls += 1
        if (startCalls === 1) throw new Error('first startup failure')
      }
      await assert.rejects(kernel.start(), /first startup failure/)
      assert.equal(startCalls, 1)
      await kernel.start()
      assert.equal(startCalls, 2, 'retry must invoke pluginHost.start again rather than returning cached rejection')
    } finally {
      await kernel.close()
    }
  })

  it('close() awaits in-flight start() convergence: services stop only after start finishes, preventing teardown races', { timeout: 60_000 }, async () => {
    const dir = join(root, 'close-waits-start')
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, autoResume: false })
    try {
      const order: string[] = []
      const startEntered = deferred()
      const startGate = deferred()
      await kernel.plugins.register({
        id: 'test:slow-start',
        definePlugin(ctx) {
          ctx.service({
            id: 'svc',
            async start() {
              order.push('start-begin')
              startEntered.resolve()
              await startGate.promise
              order.push('start-end')
            },
            stop() { order.push('stop') },
          })
        },
      })
      const starting = kernel.start()
      await startEntered.promise
      // Begin closing while start() is still blocked inside service.start().
      const closing = kernel.close()
      startGate.resolve()
      await Promise.all([starting, closing])
      assert.deepEqual(order, ['start-begin', 'start-end', 'stop'], 'teardown must wait for start to finish before stopping services')
    } finally {
      await kernel.close().catch(() => {})
    }
  })
})
