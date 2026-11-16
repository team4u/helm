/**
 * original generate spawn and Ask contract test: real pi-durable SDK(MemoryStorage)+ faux provider.
 *
 * override main proxy locate violate about point:
 * - schema:AJV all amount (enum/nested/many type/ additionalProperties),$async reject,
 *   null/mark amount legal top-level, across row object,StructuredOutput tool self-heal, two time failed explicit errors;
 * - abort: before creation reject, run in conversation.abort, without legacy task;
 * - resume: error ref never creates new, parent ownership validate,agentId mapping,onResolved on report original id;
 * - profile: invalid profile errors,herdr runtime explicit unsupported,effort illegal reject;
 * - gate:cwd use sub-conversation actual cwd;
 * - Ask:CAS conflict 409 / without resolver ask_state_unavailable / seq fall back superseded /
 *   cancel/superseded reject(non-empty answers)/ unknown field / select out of bounds / confirm illegal /
 *   secret name collision reject / empty secret do not stash / missing conversation reject.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface TestHarness {
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  close(): Promise<void>
}

/**
 * real SDK Harness(MemoryStorage)+ faux provider + complete NativeSpawnDeps stub.
 * registerChildConversation / resolveProfile / getParentOfConversation use process inside
 * Map simulated host (real implement by runtime.ts combine, this where test spawn itself contract).
 */
async function openSpawnHarness(options: { profiles?: Record<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }> } = {}): Promise<TestHarness> {
  const { models, faux } = makeFauxModels()
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    { models: () => models, registry },
    BACKGROUND_CONTEXT,
  )

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const profiles = new Map<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }>(
    Object.entries(options.profiles ?? { assistant: {} }),
  )
  // sub-conversation mirror (and produce HelmStore same semantics most small implement:profileId/cwd/model).
  const mirrors = new Map<
    number,
    { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }
  >()

  const deps: NativeSpawnDeps = {
    dataDir: '/tmp/helm-spawn-test',
    defaultCwd: process.cwd(),
    hubUrl: 'http://127.0.0.1:3200',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService('/tmp/helm-spawn-test', { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    structuredOutputSessions: new Map(),
    registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, _tags) => {
      parents.set(childId, parentId)
      mirrors.set(childId, {
        profileId,
        cwd: childCwd,
        model: modelMirror,
        title: `subagent ${childId}`,
        tags: [],
        createdAt: Date.now(),
      })
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      // sync observer: and produce tracker same mechanism (advance inside only record, without await).
      const observer = {
        advance: (call: { kind: string; value: { entries: Array<{ kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }> } }) => {
          if (call.kind !== 'value') return
          const view = call.value
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const entry = view.entries[i]!
            if (entry.kind !== 'pi.assistant') continue
            const text = (entry.model?.[0]?.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (text !== '') {
              lastTexts.set(childId, text)
              break
            }
          }
        },
        end: () => {},
      }
      const observation = await harness.observeConversation(childId as never, observer as never, BACKGROUND_CONTEXT)
      observers.set(childId, () => observation.detach())
    },
    resolveProfile: async (profileId) => {
      if (!profiles.has(profileId)) return undefined
      const p = profiles.get(profileId) as { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }
      return { model: p.model, cwd: p.cwd, runtime: p.runtime as never }
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: (childId) => mirrors.get(childId)?.modelOverride,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: m.title,
        profileId: m.profileId,
        tags: m.tags,
        cwd: m.cwd,
        model: m.model,
        thinkingLevel: '',
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      }
    },
    updateConversation: async (childId, patch) => {
      const m = mirrors.get(childId)
      if (!m) throw new HelmError('not_found', `conversation missing:${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      if (patch.model !== undefined) m.modelOverride = patch.model
      if (m.modelOverride === undefined) {
        const p = profiles.get(m.profileId)
        m.model = p?.model ?? 'faux/faux-1'
      } else {
        m.model = m.modelOverride
      }
      // and produce same order: real SDK configure first row, mirror after write.
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmError('not_found', `sub-conversation missing:${childId}`, 404)
      const slash = m.model.indexOf('/')
      await conv.configure(
        {
          ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
          model: { provider: m.model.slice(0, slash), modelId: m.model.slice(slash + 1) },
        } as never,
        BACKGROUND_CONTEXT,
      )
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
  }
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()

  return {
    harness,
    deps,
    faux,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
    },
  }
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helm-spawn-ask-')
})

after(async () => {
  await cleanupDir(rootDir)
})

// ---------------------------------------------------------------------------
// spawn:schema validate
// ---------------------------------------------------------------------------

describe('spawn schema:AJV all amount validate', { timeout: 60_000 }, () => {
  it('enum / nested / additionalProperties violate about all reject (no longer only inspect one layer)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // one round:enum violate about + illegal embed set -> tool reject -> second round tool to out legal value.
      th.faux.setResponses([
        fauxAssistantMessage('I first output a illegal'),
        fauxAssistantMessage('well'),
      ])
      // do not via tool, directly text choose also must by all amount validate intercept:
      const bad = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'return enumeration',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never).then(
        () => assert.fail('enum violate about must failed'),
        (err: unknown) => err as HelmError,
      )
      assert.equal(bad.code, 'schema_validation_failed')
    } finally {
      await th.close()
    }
  })

  it('null top-level legal:valid null and undefined zone', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // model first invoke tool commit null(schema allows null top-level).
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: null })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('committed'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'may without result',
        schema: { type: 'null' },
      } as never)
      assert.equal(result, null)
    } finally {
      await th.close()
    }
  })

  it('across row object text choose (without tool invoke) via all amount validate via', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('result below:\n{"answer":\n  42,\n "ok": true}'),
        fauxAssistantMessage('again come once'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'compute',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' }, ok: { type: 'boolean' } },
          required: ['answer', 'ok'],
        },
      } as never)
      assert.deepEqual(result, { answer: 42, ok: true })
    } finally {
      await th.close()
    }
  })

  it('$async schema explicit reject', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            schema: { $async: true, type: 'object' },
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_schema',
      )
    } finally {
      await th.close()
    }
  })

  it('StructuredOutput tool: error parameter by refuse, same turn retry, eventually via tool return', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // one turn: model first to error enum, tool reject (isError result), same turn retry to for.
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { level: 'bogus' } })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { level: 'high' } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('complete'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'evaluate',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(result, { level: 'high' })
    } finally {
      await th.close()
    }
  })

  it('StructuredOutput tool: support string form JSON guard against defend parse is object and succeeded validate', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // model because not declaration type structure result encode is JSON string pass
        fauxAssistantMessage(
          [
            fauxToolCall('register_structured_output', {
              output: JSON.stringify({
                difficulty: 'in etc.',
                intent: 'test intent',
                question: 'test question',
              }),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('completed out subject'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'out subject',
        schema: {
          type: 'object',
          properties: {
            difficulty: { type: 'string', enum: ['easy', 'in etc.', 'difficulty'] },
            intent: { type: 'string' },
            question: { type: 'string' },
          },
          required: ['difficulty', 'intent', 'question'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(result, {
        difficulty: 'in etc.',
        intent: 'test intent',
        question: 'test question',
      })
    } finally {
      await th.close()
    }
  })

  it('two time all failed explicit schema_validation_failed(contains conversation diagnose)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('I will not JSON'),
        fauxAssistantMessage('still will not'),
      ])
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'return JSON',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      } as never).then(
        () => assert.fail('must failed'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'schema_validation_failed')
      assert.ok((err.details as { conversationId?: number }).conversationId !== undefined)
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn:abort / signal
// ---------------------------------------------------------------------------

describe('spawn abort:signal connect to SDK', { timeout: 60_000 }, () => {
  it('before creation already abort: directly reject, do not create sub-conversation', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      const controller = new AbortController()
      controller.abort()
      const before = (th.deps.agentSessions as Map<string, number>).size
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            signal: controller.signal,
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'aborted',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, before)
    } finally {
      await th.close()
    }
  })

  it('run in abort:conversation.abort takes effect and do not live task', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // response work vendor suspended: do not resolve then turn stop in model request in,abort only then truly interrupt in-flight token.
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      th.faux.setResponses([
        () => gate.then(() => fauxAssistantMessage('latency answer')) as never,
      ])
      const controller = new AbortController()
      const promise = runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'slow task',
        agentId: 'slow-1',
        signal: controller.signal,
      } as never)
      // etc. sub-conversation create and enter run in, again trigger abort.
      await new Promise((r) => setTimeout(r, 150))
      controller.abort()
      release()
      const err = await promise.then(
        () => assert.fail('abort after must not succeeded'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'aborted')
      // do not live task (conversation idle).
      const childId = (th.deps.agentSessions as Map<string, number>).get('slow-1')!
      const conv = await th.harness.conversation(childId as never, BACKGROUND_CONTEXT)
      assert.ok(conv)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      const inspect = await th.harness.inspect(BACKGROUND_CONTEXT)
      const live = inspect.tasks.filter((t) => t.state.kind === 'running' || t.state.kind === 'waiting')
      assert.equal(live.length, 0, 'abort after must not legacy live task')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn:resume strictly
// ---------------------------------------------------------------------------

describe('spawn resume: never creates new false resume', { timeout: 60_000 }, () => {
  it('missing ref reject, do not create new sub-conversation', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('answer proposal')])
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: 'no-such-agent',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // '12abc' this kind of mixed number also reject (no longer parseInt wide contain).
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: '12abc',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, 0)
    } finally {
      await th.close()
    }
  })

  it('agentId mapping resume: re- use original conversation,onResolved on report original id', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('one segment'), fauxAssistantMessage('resume result')])
      let createdId: number | undefined
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'one segment',
        agentId: 'agent-a',
        onResolved: (info) => {
          createdId = info.conversationId
        },
      })
      assert.equal(first, 'one segment')
      const resumeResolved: Array<number | undefined> = []
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-a',
        onResolved: (info) => {
          resumeResolved.push(info.conversationId)
        },
      })
      assert.equal(second, 'resume result')
      assert.equal(resumeResolved.length, 1)
      assert.equal(resumeResolved[0], createdId, 'resume onResolved on report original convId')
    } finally {
      await th.close()
    }
  })

  it('parent ownership error reject resume(guard against across parent conversation hijack)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('one segment'), fauxAssistantMessage('do not the reach')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'one segment',
        agentId: 'agent-p',
      } as never)
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 999,
            prompt: 'hijack',
            resume: 'agent-p',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('resume carries schema: patch hang StructuredOutput tool and accept result', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // one segment without schema(pure text); resume carries schema: must patch hang tool and away tool commit.
      th.faux.setResponses([
        fauxAssistantMessage('one segment pure text'),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { n: 1 } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('complete'),
      ])
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'one segment',
        agentId: 'agent-s',
      } as never)
      assert.equal(first, 'one segment pure text')
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'resume and return structure',
        resume: 'agent-s',
        schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(second, { n: 1 })
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn:profile / effort / runtime / isolation / gate
// ---------------------------------------------------------------------------

describe('spawn profile and runtime declaration', { timeout: 60_000 }, () => {
  it('invalid profile explicit not_found', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'ghost-profile',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('profile declaration herdr runtime: without plugin take over explicit unsupported_runtime', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness({
      profiles: {
        assistant: {},
        'cli-agent': { runtime: { kind: 'herdr', agent: 'claude' } },
      },
    })
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'cli-agent',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'herdr:agy',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('effort illegal enumeration reject; legal value via', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            effort: 'ultra',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      th.faux.setResponses([fauxAssistantMessage('carries effort answer')])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        effort: 'high',
      } as never)
      assert.equal(result, 'carries effort answer')
    } finally {
      await th.close()
    }
  })

  it('isolation explicit unsupported_runtime', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            isolation: 'worktree',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('any namespace:kind external runtime (non- herdr) without plugin take over same unsupported_runtime(kernel zero plugin enumeration hard encode)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // kernel do not point name any plugin:docker:devbox,ssh:remote etc. everything naming empty between form
      // one rule via agent_spawn hook take over; without take over when unify explicit errors.
      for (const agentType of ['docker:devbox', 'ssh:remote', 'claude:code']) {
        await assert.rejects(
          () =>
            runNativeSpawn(th.deps, {
              parentConversationId: 1,
              prompt: 'x',
              agentType,
            } as never),
          (err: unknown) =>
            err instanceof HelmError && err.code === 'unsupported_runtime' && err.message.includes(agentType),
        )
      }
    } finally {
      await th.close()
    }
  })

  it('ordinary profileId(without smoke number) do not subject to naming empty between decide affect (continue away profile parse)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // without smoke number but not registered profile:not_found(is not unsupported_runtime).
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'no-such-profile',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('gate use sub-conversation actual cwd(request.cwd), failed keep diagnose', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('answer proposal'), fauxAssistantMessage('answer proposal2')])
      const marker = join(rootDir, 'gate-marker.txt')
      // gate in sub-conversation cwd under execute pwd and write file: verify cwd takes effect.
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        cwd: rootDir,
        gate: `pwd > "${marker}"`,
      } as never)
      assert.equal(result, 'answer proposal')
      const { readFileSync } = await import('node:fs')
      const pwd = readFileSync(marker, 'utf8').trim()
      assert.equal(pwd, rootDir)
      // gate failed: explicit gate_failed and diagnose keep.
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'y',
        cwd: rootDir,
        gate: 'echo boom-diagnostic >&2; exit 7',
      } as never).then(
        () => assert.fail('gate failed must errors'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'gate_failed')
      assert.ok(String(err.message).includes('boom-diagnostic'), 'gate diagnose must not discard')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Ask:CAS / cancel / validate
// ---------------------------------------------------------------------------

describe('Ask CAS and compute honest', { timeout: 60_000 }, () => {
  let service: AskService
  let store: HelmStore
  let stash: SecretStash
  let events: Array<{ type: string; payload: unknown }>
  let pendingChanged: number[]

  async function openAskService(options: { validateConversation?: (id: number) => boolean } = {}): Promise<void> {
    const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
    store = new HelmStore(db)
    await store.load()
    stash = new SecretStash()
    events = []
    pendingChanged = []
    service = new AskService({
      store,
      stash,
      onEvent: (type, payload) => events.push({ type, payload }),
      onConvPendingChanged: (id) => pendingChanged.push(id),
      validateConversation: options.validateConversation,
    })
  }

  it('client CAS seq and durable watermark different:409 reject (not silently override)', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'terminal confirm',
      expectedStateSeq: 10,
      fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    await assert.rejects(
      () => service.answerAsk(ask.id, { confirm: 'true' }, 9),
      (err: unknown) => err instanceof HelmError && err.code === 'ask_state_conflict',
    )
    await service.cancelAsk(ask.id)
    await store.close()
  })

  it('has CAS but without resolver:ask_state_unavailable, do not install act validate via', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'need to seq',
      expectedStateSeq: 5,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    await assert.rejects(
      () => service.answerAsk(ask.id, { x: 'v' }),
      (err: unknown) => err instanceof HelmError && err.code === 'ask_state_unavailable',
    )
    await service.cancelAsk(ask.id)
    await store.close()
  })

  it('target seq any inconsistent (contains fall back) all superseded; consistent then via', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'seq watermark',
      expectedStateSeq: 10,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    // fall back (9 < 10): old code only intercept > , now any inconsistent all deregister single.
    let target = 9
    service.registerSeqResolver(() => target)
    const superseded = await service.answerAsk(ask.id, { x: 'v' })
    assert.equal(superseded.status, 'superseded')
    // consistent: normal answered.
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: 'seq consistent',
      expectedStateSeq: 3,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void ask2Promise.catch(() => {})
    const ask2 = service.listAsks('pending')[0]!
    target = 3
    const answered = await service.answerAsk(ask2.id, { x: 'v' })
    assert.equal(answered.status, 'answered')
    await store.close()
  })

  it('cancel/superseded:createAsk promise resolve(status zone,answers is empty do not smoke fill batch allow)', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'cancel',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask = service.listAsks('pending')[0]!
    await service.cancelAsk(ask.id)
    const cancelled = await askPromise
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(cancelled.answers, {})
    // superseded same.
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: 'deregister single',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask2 = service.listAsks('pending')[0]!
    await service.cancelAsk(ask2.id, 'superseded')
    const superseded = await ask2Promise
    assert.equal(superseded.status, 'superseded')
    assert.deepEqual(superseded.answers, {})
    await store.close()
  })

  it('answer proposal validate: unknown field / non- string / select out of bounds / confirm illegal / required missing', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'table single',
      fields: [
        { name: 'color', label: 'color', type: 'select', options: [{ label: 'red', value: 'red' }, { label: 'blue', value: 'blue' }] },
        { name: 'agree', label: 'same intent', type: 'confirm', required: true },
        { name: 'note', label: 'prepare note', type: 'text' },
      ],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmError && err.code === 'validation_error')
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', rogue: 'x' } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 1 } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', color: 'green' }))
    await expectValidation(service.answerAsk(ask.id, { agree: 'yes' }))
    await expectValidation(service.answerAsk(ask.id, { color: 'red' }))
    // legal commit via.
    const ok = await service.answerAsk(ask.id, { agree: 'true', color: 'red', note: '' })
    assert.equal(ok.status, 'answered')
    await store.close()
  })

  it('secret:env name illegal reject, declaration keep original do not rotate large write merge, null value do not stash', { timeout: 60_000 }, async () => {
    await openAskService()
    // illegal env name (hyphen): create i.e. refuse (stash.put will throw, but now in createAsk boundary).
    await assert.rejects(
      () =>
        service.createAsk({
          conversationId: 1,
          title: 'broken name',
          fields: [{ name: 'api-key', label: 'K', type: 'text', secret: true }],
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
    )
    // 'api_key' and 'API_KEY' is two different field name: keep original shared store, do not merge override.
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'double secret',
      fields: [
        { name: 'api_key', label: 'small write', type: 'text', secret: true },
        { name: 'API_KEY', label: 'large write', type: 'text', secret: true },
      ],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    const answered = await service.answerAsk(ask.id, { api_key: 'lower-secret', API_KEY: 'upper-secret' })
    assert.equal(answered.status, 'answered')
    const env = stash.envFor(1)
    assert.equal(env['api_key'], 'lower-secret')
    assert.equal(env['API_KEY'], 'upper-secret')
    // empty secret do not stash: answer proposal store is empty string, without stash item.
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: 'empty secret',
      fields: [{ name: 'EMPTY_TOKEN', label: 'T', type: 'text', secret: true }],
    })
    void ask2Promise.catch(() => {})
    const ask2 = service.listAsks('pending')[0]!
    const settled2 = await service.answerAsk(ask2.id, { EMPTY_TOKEN: '' })
    assert.equal(settled2.status, 'answered')
    const row2 = store.getAsk(ask2.id)
    assert.equal(JSON.parse(row2!.resultJson!).EMPTY_TOKEN, '')
    await store.close()
  })

  it('createAsk boundary: duplicate name / illegal type / conversation missing / missing title', { timeout: 60_000 }, async () => {
    await openAskService({ validateConversation: (id) => id === 1 })
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmError && err.code === 'validation_error')
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'duplicate',
        fields: [
          { name: 'x', label: '1', type: 'text' },
          { name: 'x', label: '2', type: 'text' },
        ],
      }),
    )
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'broken type',
        fields: [{ name: 'x', label: 'X', type: 'radio' as never }],
      }),
    )
    await expectValidation(service.createAsk({ conversationId: 1, title: '', fields: [{ name: 'x', label: 'X', type: 'text' }] }))
    await assert.rejects(
      () =>
        service.createAsk({
          conversationId: 424242,
          title: 'missing conversation',
          fields: [{ name: 'x', label: 'X', type: 'text' }],
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )
    await store.close()
  })

  it('restart legacy pending: diagnose notify mention and secret reference expires', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'legacy',
      fields: [
        { name: 'x', label: 'X', type: 'text' },
        { name: 'TOKEN', label: 'T', type: 'text', secret: true },
      ],
    })
    void askPromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    service.reportOrphans()
    const notification = events.find(
      (e) => e.type === 'notification' && String((e.payload as { title?: string }).title).includes('legacy'),
    )
    assert.ok(notification, 'must has diagnose notify')
    assert.ok(
      String((notification.payload as { body?: string }).body).includes('expires'),
      'secret reference across restarts expires must such as note',
    )
    await service.cancelAsk(service.listAsks('pending')[0]!.id)
    await store.close()
  })
})

// ---------------------------------------------------------------------------
// spawn:parentToolCallId run phase real-time related pass-through
// ---------------------------------------------------------------------------

describe('spawn parentToolCallId: parent conversation tool invoke ID real-time related sub-conversation', { timeout: 60_000 }, () => {
  it('creates new derive:request.parentToolCallId original can reach, engine do not swallow field', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('complete')])
      let registeredChildId: number | undefined
      const originalRegister = th.deps.registerChildConversation
      th.deps.registerChildConversation = async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel) => {
        registeredChildId = childId
        return originalRegister(childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel)
      }
      // host runtime.ts in createSubagentTool in from api.callId inject parentToolCallId;
      // engine side contract: field original follow request pass, do not swallow do not change (mirror write by host call back complete).
      const request = {
        parentConversationId: 1,
        prompt: 'fix build',
        parentToolCallId: 'toolu_01ABC',
      }
      const result = await runNativeSpawn(th.deps, request as never)
      assert.equal(result, 'complete')
      assert.ok(registeredChildId !== undefined, 'sub-conversation must already register')
      assert.equal(request.parentToolCallId, 'toolu_01ABC')
    } finally {
      await th.close()
    }
  })

  it('resume resume: host bindChildToolCall receives this time tool invoke ID', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('one segment'), fauxAssistantMessage('resume complete')])
      const bound: Array<{ childId: number; parentToolCallId: string }> = []
      th.deps.bindChildToolCall = (childId, parentToolCallId) => {
        bound.push({ childId, parentToolCallId })
      }
      let createdId: number | undefined
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'one segment',
        agentId: 'agent-tc',
        onResolved: (info: { conversationId?: number }) => {
          createdId = info.conversationId
        },
      } as never)
      // creates new path do not invoke bindChildToolCall(by registerChildConversation  parentToolCallId).
      assert.equal(bound.length, 0)
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-tc',
        parentToolCallId: 'toolu_01RESUME',
      } as never)
      assert.equal(bound.length, 1)
      assert.equal(bound[0]!.parentToolCallId, 'toolu_01RESUME')
      assert.equal(bound[0]!.childId, createdId)
    } finally {
      await th.close()
    }
  })

  it('default do not carries parentToolCallId:resume does not trigger bindChildToolCall', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('one segment'), fauxAssistantMessage('again continue')])
      let called = 0
      th.deps.bindChildToolCall = () => {
        called += 1
      }
      await runNativeSpawn(th.deps, { parentConversationId: 1, prompt: 'one segment', agentId: 'agent-nt' } as never)
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-nt',
      } as never)
      assert.equal(called, 0, 'without parentToolCallId derive must not trigger bindChildToolCall')
    } finally {
      await th.close()
    }
  })
})
