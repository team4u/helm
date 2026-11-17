/**
 * Thinking level resolution and clamping on model switches based on target model capabilities (real SQLite + pi-durable + faux provider).
 *
 * Mirrors pi coding agent setModel -> setThinkingLevel semantics: passes through when target model capabilities are unknown
 * (without fabricating capabilities), and clamps down along SDK-supported levels when the target model supports fewer levels.
 *
 * Covers:
 * - Model switches without a simultaneous explicit thinking change clear the stale conversation override so the new
 *   model's own default chain (per-model default > Profile > global) resolves fresh; explicit overrides still clamp
 *   to the target model while the model stays unchanged;
 * - Real reasoning model A (thinkingLevelMap declares up to max) -> model B (only up to high):
 *   inherited levels and per-model defaults clamp to high on B and recover on A;
 * - Empty string (unconfigured) must never be mistakenly clamped to 'off': preserves inheritance chain semantics;
 * - Faux test model (reasoning: false, no thinkingLevelMap, unknown capability) contract preserved:
 *   any inherited level passes through verbatim (consistent with runtime-thinking-config.test.ts baseline);
 * - spawn clamps effort for new subagents by target model capability; resume model switches without explicit
 *   effort also re-resolve through the per-model default chain.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/runtime.js'

type ThinkingSummary = ConversationSummary & { thinkingLevelOverride?: string }

let savedModel: string | undefined
before(() => {
  savedModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
})
after(() => {
  if (savedModel === undefined) delete process.env['HELM_MODEL']
  else process.env['HELM_MODEL'] = savedModel
})

/**
 * Faux provider with reasoning capability metadata: createFauxCore supplies the stream implementation,
 * then patches thinkingLevelMap onto model definitions (faux model definitions do not expose that field directly).
 */
function reasoningFauxProvider(options: {
  provider: string
  models: Array<{ id: string; thinkingLevelMap?: Record<string, string | null>; reasoning: boolean }>
}) {
  const core = createFauxCore({
    provider: options.provider,
    models: options.models.map((m) => ({ id: m.id, name: m.id })),
  })
  const enriched = core.models.map((model, index) => ({
    ...model,
    reasoning: options.models[index]!.reasoning,
    ...(options.models[index]!.thinkingLevelMap ? { thinkingLevelMap: options.models[index]!.thinkingLevelMap } : {}),
  }))
  const provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } },
    models: enriched,
    api: {
      stream: core.stream as never,
      streamSimple: core.streamSimple as never,
      fetchDeferred: core.fetchDeferred as never,
      cancelDeferred: core.cancelDeferred as never,
    },
  })
  return { provider, core }
}

interface Fixture {
  kernel: KernelRuntime
  /** Capability-aware provider A (faux-cap-a/model-a supports up to max). */
  capA: ReturnType<typeof reasoningFauxProvider>
  /** Capability-aware provider B (faux-cap-b/model-b supports up to high). */
  capB: ReturnType<typeof reasoningFauxProvider>
  /** Unknown-capability baseline provider (faux default: reasoning: false without map, passthrough baseline). */
  legacyFaux: ReturnType<typeof reasoningFauxProvider>
  dir: string
}

async function open(dir: string): Promise<Fixture> {
  const models = createModels()
  const capA = reasoningFauxProvider({
    provider: 'faux-cap-a',
    models: [
      {
        id: 'model-a',
        reasoning: true,
        // A explicitly declares support up to max (xhigh/max require explicit mapping to be available).
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      },
    ],
  })
  const capB = reasoningFauxProvider({
    provider: 'faux-cap-b',
    models: [
      {
        id: 'model-b',
        reasoning: true,
        // B supports up to high only: xhigh/max are null.
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      },
    ],
  })
  // Unknown-capability baseline: default faux shape (reasoning: false, no thinkingLevelMap).
  const legacyFaux = reasoningFauxProvider({
    provider: 'faux-legacy',
    models: [{ id: 'legacy-1', reasoning: false }],
  })
  models.setProvider(capA.provider)
  models.setProvider(capB.provider)
  models.setProvider(legacyFaux.provider)
  const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, models: models as never })
  return { kernel, capA, capB, legacyFaux, dir }
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-thinking-clamp-'))
  const env = await open(dir)
  t.after(async () => {
    await env.kernel.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return env
}

async function sdkAgent(kernel: KernelRuntime, id: number) {
  const harness = (kernel as unknown as { harness: Harness }).harness
  const conversation = await harness.conversation(id as Parameters<Harness['conversation']>[0], BACKGROUND_CONTEXT)
  assert.ok(conversation)
  return conversation.agent(BACKGROUND_CONTEXT)
}

async function assertThinking(kernel: KernelRuntime, id: number, effective: string, override?: string) {
  const summary = kernel.getConversation(id) as ThinkingSummary
  assert.equal(summary.thinkingLevel, effective)
  assert.equal(summary.thinkingLevelOverride, override)
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', 'real SDK state must match mirror')
}

it('explicit override clamps while the model stays; a model switch without thinking change clears the stale override', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  const conv = await kernel.createConversation()
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Title-only updates never recompute or drift the explicit override.
  await kernel.updateConversation(conv.id, { title: 'Updated title' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Switching to model B without a thinking change drops the override chosen for A; nothing else
  // is configured, so the effective level resolves to unconfigured ('' mirror, SDK off).
  await kernel.updateConversation(conv.id, { model: 'faux-cap-b/model-b' })
  await assertThinking(kernel, conv.id, '', undefined)
  // Switching back to A does not resurrect the old override.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, '', undefined)

  // A simultaneous explicit thinking level survives a model switch (clamped to the target model).
  await kernel.updateConversation(conv.id, { model: 'faux-cap-b/model-b', thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'high', 'high')
})

it('model switch clears the old override so the new model per-model default takes effect', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.setModelThinkingDefault('faux-cap-b/model-b', 'minimal')
  const conv = await kernel.createConversation()
  // Explicit override on A: max.
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Switch to B: the A-chosen override no longer shadows B's own per-model default.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-b/model-b' })
  await assertThinking(kernel, conv.id, 'minimal', undefined)

  // Switching back to A (no per-model default for A) falls through to unconfigured.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, '', undefined)
})

it('inheritance chain (no override) clamps too: global max becomes high on B and restores max on A', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'high', undefined)

  // Conversation switches to A: inherited global max becomes available again.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'max', undefined)
})

it('Profile level aligns with Profile model; changing conversation Profile recomputes and clamps', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: 'Expert', model: 'faux-cap-a/model-a', thinkingLevel: 'max',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'max', undefined)

  // Profile model changes to B: Profile max clamps along inheritance chain to high.
  await kernel.services.profiles.save({ id: 'expert', name: 'Expert', model: 'faux-cap-b/model-b', thinkingLevel: 'max' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', undefined)

  // Conversation switches to another Profile (model is A, level high): effective level recomputes along new inheritance chain.
  await kernel.services.profiles.save({ id: 'reviewer', name: 'Reviewer', model: 'faux-cap-a/model-a', thinkingLevel: 'high' })
  await kernel.updateConversation(conv.id, { profileId: 'reviewer' })
  await assertThinking(kernel, conv.id, 'high', undefined)
})

it('explicit max override + Profile model A->B alignment: override/effective/SDK all clamp to high and persist', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: 'Expert', model: 'faux-cap-a/model-a', thinkingLevel: 'medium',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  // Explicit max override: all three layers are max while on A.
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Profile model switches to B (supports up to high) and aligns: explicit override also clamps and persists as high.
  await kernel.services.profiles.save({ id: 'expert', name: 'Expert', model: 'faux-cap-b/model-b', thinkingLevel: 'medium' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', 'high')

  // Subsequent title-only update (without touching model/level): level is not recomputed or drifted by any step.
  await kernel.updateConversation(conv.id, { title: 'Updated title' })
  await assertThinking(kernel, conv.id, 'high', 'high')

  // An explicit conversation model switch back to A clears the override (no simultaneous thinking change):
  // the chain re-resolves through Profile.thinkingLevel (medium), which A supports as-is.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'medium', undefined)
})

it('empty string (unconfigured) is not mistakenly clamped to off; off semantics remain intact', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b')
  // Global thinking level unconfigured: newly created conversation starts at '', SDK at 'off'.
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, '', undefined)

  // Explicit off override: B's map.off is null (off is not in supported list), but SDK off semantics
  // must never be clamped up to the lowest supported level (minimal).
  await kernel.updateConversation(conv.id, { thinkingLevel: 'off' })
  await assertThinking(kernel, conv.id, 'off', 'off')

  // Clearing override returns to empty string inheritance.
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, '', undefined)
})

it('unknown capability (default faux shape) passes through without breaking existing contract', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  // legacy-1 declares no capabilities (reasoning: false, no map): max passes through verbatim,
  // matching the runtime-thinking-config.test.ts faux baseline.
  await kernel.setDefaultModel('faux-legacy/legacy-1', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'max', undefined)
  await kernel.updateConversation(conv.id, { thinkingLevel: 'xhigh' })
  await assertThinking(kernel, conv.id, 'xhigh', 'xhigh')
})

it('spawn creates child clamped by target model capability; resume also clamps explicit effort', { timeout: 60_000 }, async (t) => {
  const { kernel, capA, capB } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a', 'low')
  capA.core.setResponses([fauxAssistantMessage('A done')])
  capB.core.setResponses([fauxAssistantMessage('B done')])
  let childA = 0
  let childB = 0
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'task A',
    model: 'faux-cap-a/model-a',
    effort: 'max',
    onResolved: (info) => { childA = info.conversationId ?? 0 },
  })
  await assertThinking(kernel, childA, 'max', 'max')

  // Target model B supports up to high: explicit effort max clamps to high.
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'task B',
    model: 'faux-cap-b/model-b',
    effort: 'max',
    onResolved: (info) => { childB = info.conversationId ?? 0 },
  })
  await assertThinking(kernel, childB, 'high', 'high')

  // Resume: switching model to A without specifying effort re-resolves through the default chain —
  // the clamped-high override chosen for B is dropped and the global fallback (low, supported by A) applies.
  capA.core.setResponses([fauxAssistantMessage('A resume')])
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'resume A',
    resume: String(childB),
    model: 'faux-cap-a/model-a',
  })
  await assertThinking(kernel, childB, 'low', undefined)
})
