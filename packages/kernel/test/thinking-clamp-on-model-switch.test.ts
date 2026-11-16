/**
 * switch model after think etc. level by target model capability automatically converge (real SQLite + pi-durable + faux request).
 *
 * see pi coding agent  setModel → setThinkingLevel semantics: target model capability unknown when pass-through
 * (do not virtual construct capability), capability known and when before Profile do not by support when by SDK available Profile sequence then near converge.
 *
 * override:
 * - real reasoning model A(thinkingLevelMap declaration support max)→ model B(only support to high):
 *   explicit override max conversation cut to B after summary.thinkingLevel / thinkingLevelOverride /
 *   SDK agent.thinkingLevel three all is high;
 * - explicit max override + Profile model A→B  align:override/effective/SDK all high,
 *   and align persist converge result - - after continue only change title no longer change Profile, cut back A still high;
 * - takes effect Profile (inherit chain, without override) same converge: global/Profile config max to B when is high;
 * - empty string (not config) must not by mistakenly converge is 'off': keep inherit chain semantics;
 * - faux test model (reasoning:false, without thinkingLevelMap, capability unknown) contract do not break:
 *   any inherit Profile original pass-through (and runtime-thinking-config.test.ts baseline consistent);
 * - spawn creates new subagent by target model capability converge effort;resume explicit effort same converge.
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
 * carries reasoning capability metadata faux gateway:createFauxCore provide stream implement,
 * model define after again patch thinkingLevelMap(faux model define itself do not expose the field).
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
  /** capability known gateway A(faux-cap/model-a support max;faux-cap/model-b only to high). */
  capA: ReturnType<typeof reasoningFauxProvider>
  capB: ReturnType<typeof reasoningFauxProvider>
  /** capability unknown gateway (faux by default:reasoning:false without map, pass-through contract baseline). */
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
        // A explicit declaration support to max(xhigh/max must explicit map only then available).
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
        // B only support to high:xhigh/max is null.
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      },
    ],
  })
  // capability unknown baseline:faux by default form (reasoning:false, without thinkingLevelMap).
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
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', 'real SDK must and mirror consistent')
}

it('A(max) cut B(only high):summary,override,SDK agent all converge is high', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  const conv = await kernel.createConversation()
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // cut to model B:max do not by support → converge to high(by SDK available Profile sequence then near converge).
  await kernel.updateConversation(conv.id, { model: 'faux-cap-b/model-b' })
  await assertThinking(kernel, conv.id, 'high', 'high')

  // cut back A: converge after high still is A support Profile, keep do not change (pi setThinkingLevel semantics: persist converge value).
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'high', 'high')
})

it('inherit chain (without override) same converge: global max to B is high, back to A restore max', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'high', undefined)

  // conversation cut to A: inherit global max re- available.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'max', undefined)
})

it('Profile Profile follow Profile model align; conversation swap Profile heavy compute and converge', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: 'dedicated household', model: 'faux-cap-a/model-a', thinkingLevel: 'max',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'max', undefined)

  // Profile model change to B: Profile max follow inherit chain converge is high.
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', model: 'faux-cap-b/model-b', thinkingLevel: 'max' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', undefined)

  // conversation real switch to another Profile(model same is A, Profile high): takes effect Profile follow new inherit chain heavy compute.
  await kernel.services.profiles.save({ id: 'reviewer', name: 'review review', model: 'faux-cap-a/model-a', thinkingLevel: 'high' })
  await kernel.updateConversation(conv.id, { profileId: 'reviewer' })
  await assertThinking(kernel, conv.id, 'high', undefined)
})

it('explicit max override + Profile model A→B align:override/effective/SDK all high and persist', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: 'dedicated household', model: 'faux-cap-a/model-a', thinkingLevel: 'medium',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  // explicit override max:A support when three layer all is max.
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Profile model change to B(only support to high) after align: explicit override same converge and persist is high.
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', model: 'faux-cap-b/model-b', thinkingLevel: 'medium' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', 'high')

  // after continue only change title (do not motion model/Profile): Profile do not by any link heavy compute or drift.
  await kernel.updateConversation(conv.id, { title: 'change title' })
  await assertThinking(kernel, conv.id, 'high', 'high')

  // cut back model A: converge persist high is A support Profile, keep do not change.
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'high', 'high')
})

it('empty string (not config) do not by mistakenly converge is off;off semantics keep', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b')
  // global not config think Profile: create conversation after is empty string,SDK off.
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, '', undefined)

  // explicit off override:B  map.off is null(off do not in support list), but SDK off semantics
  // must not by clamp lift rise to most small available Profile (minimal).
  await kernel.updateConversation(conv.id, { thinkingLevel: 'off' })
  await assertThinking(kernel, conv.id, 'off', 'off')

  // clear override back to empty string inherit.
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, '', undefined)
})

it('capability unknown (faux by default form) pass-through do not break since has contract', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  // legacy-1 do not declaration any capability (reasoning:false, without map):max original pass-through,
  // and runtime-thinking-config.test.ts  faux baseline consistent.
  await kernel.setDefaultModel('faux-legacy/legacy-1', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'max', undefined)
  await kernel.updateConversation(conv.id, { thinkingLevel: 'xhigh' })
  await assertThinking(kernel, conv.id, 'xhigh', 'xhigh')
})

it('spawn creates new by target model capability converge effort;resume explicit effort same converge', { timeout: 60_000 }, async (t) => {
  const { kernel, capA, capB } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a', 'low')
  capA.core.setResponses([fauxAssistantMessage('A complete')])
  capB.core.setResponses([fauxAssistantMessage('B complete')])
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

  // target model B only support to high: explicit effort max converge is high.
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'task B',
    model: 'faux-cap-b/model-b',
    effort: 'max',
    onResolved: (info) => { childB = info.conversationId ?? 0 },
  })
  await assertThinking(kernel, childB, 'high', 'high')

  // resume: swap model to A after do not carries effort: mirror already converge high keep (A also support high),
  // does not fall back also do not lift rise.
  capA.core.setResponses([fauxAssistantMessage('A resume')])
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'resume A',
    resume: String(childB),
    model: 'faux-cap-a/model-a',
  })
  await assertThinking(kernel, childB, 'high', 'high')
})
