/** Real SQLite + pi-durable + faux: mirror, inheritance/overrides, and SDK config must remain consistent. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmxEventFrame } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { assertRejectsCode, cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type Runtime = KernelRuntime & { faux: ReturnType<typeof makeFauxModels>['faux'] }
type ThinkingSummary = ConversationSummary & { thinkingLevelOverride?: string }
let savedModel: string | undefined
before(() => {
  savedModel = process.env['HELMX_MODEL']
  delete process.env['HELMX_MODEL']
})
after(() => {
  if (savedModel === undefined) delete process.env['HELMX_MODEL']
  else process.env['HELMX_MODEL'] = savedModel
})

async function open(dir: string): Promise<Runtime> {
  const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  return Object.assign(await KernelRuntime.open({
    dataDir: dir, cwd: dir, models,
  }), { faux })
}

async function fixture(t: TestContext): Promise<{ dir: string; kernel: Runtime }> {
  const dir = await makeTempDir('helmx-thinking-')
  const kernel = await open(dir)
  t.after(async () => {
    await kernel.close()
    await cleanupDir(dir)
  })
  return { dir, kernel }
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
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', 'real SDK must match mirror')
}

it('changing global thinking keeps model; model override does not block thinking inheritance; refreshes emit events and advance seq', { timeout: 60_000 }, async (t) => {
  const { dir, kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const inherited = await kernel.createConversation()
  const modelOverride = await kernel.createConversation({ model: 'faux/faux-2' })
  const seq = modelOverride.stateChangeSeq
  const frames: HelmxEventFrame[] = []
  const subscription = kernel.events.subscribe((frame) => frames.push(frame))
  t.after(subscription)

  await kernel.setDefaultModel(undefined, 'high')
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(config.model, 'faux/faux-1')
  assert.equal((await kernel.listModels()).defaultModel, 'faux/faux-1')
  for (const id of [1, inherited.id, modelOverride.id]) await assertThinking(kernel, id, 'high')
  assert.equal((await sdkAgent(kernel, inherited.id)).model?.modelId, 'faux-1')
  assert.equal((await sdkAgent(kernel, modelOverride.id)).model?.modelId, 'faux-2')
  assert.ok(kernel.getConversation(modelOverride.id).stateChangeSeq > seq)
  assert.ok(frames.some(({ event }) => event.type === 'conversation.upsert' && 'conversation' in event && event.conversation.id === modelOverride.id && event.conversation.thinkingLevel === 'high'))

  await kernel.setDefaultModel('faux/faux-2')
  await kernel.setDefaultModel()
  await assertThinking(kernel, inherited.id, 'high')
  assert.equal((await sdkAgent(kernel, inherited.id)).model?.modelId, 'faux-2')
})

it('conversation override stays isolated and falls back to Profile/global when cleared; all cleared resets SDK to off', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'medium')
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await kernel.setDefaultModel(undefined, 'high')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', thinkingLevel: 'minimal' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'max', 'max')
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, 'minimal')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high')
  await kernel.setDefaultModel(undefined, '')
  await assertThinking(kernel, conv.id, '')
  assert.equal((await sdkAgent(kernel, conv.id)).model?.modelId, 'faux-1')
})

it('saving Profile refreshes model and thinking; switching Profile recomputes inheritance while retaining explicit overrides', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', model: 'faux/faux-1', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', model: 'faux/faux-2', thinkingLevel: 'high' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high')
  assert.equal((await sdkAgent(kernel, conv.id)).model?.modelId, 'faux-2')
  await kernel.updateConversation(conv.id, { profileId: 'assistant' })
  await assertThinking(kernel, conv.id, 'low')
  await kernel.updateConversation(conv.id, { thinkingLevel: 'off', model: 'faux/faux-2' })
  await kernel.updateConversation(conv.id, { profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'off', 'off')
  await kernel.updateConversation(conv.id, { profileId: 'assistant', thinkingLevel: '', model: '' })
  await assertThinking(kernel, conv.id, 'low')
  assert.equal((await sdkAgent(kernel, conv.id)).model?.modelId, 'faux-1')
})

it('syncs thinking config even without model; clearing model removes stale SDK model', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel(undefined, 'high')
  const conv = await kernel.createConversation()
  for (const id of [1, conv.id]) {
    await assertThinking(kernel, id, 'high')
    assert.equal((await sdkAgent(kernel, id)).model, undefined)
  }
  await kernel.setDefaultModel('faux/faux-1')
  await kernel.setDefaultModel('')
  assert.equal(kernel.getConversation(conv.id).model, '')
  assert.equal((await sdkAgent(kernel, conv.id)).model, undefined)
  await assertThinking(kernel, conv.id, 'high')
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await kernel.setDefaultModel(undefined, '')
  await assertThinking(kernel, conv.id, 'max', 'max')
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, '')
})

it('restarts recompute root and regular conversation inheritance while retaining overrides and cleared overrides', { timeout: 60_000 }, async (t) => {
  const { dir, kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const inherited = await kernel.createConversation()
  const overridden = await kernel.createConversation()
  const cleared = await kernel.createConversation()
  await kernel.updateConversation(1, { thinkingLevel: 'max' })
  await kernel.updateConversation(overridden.id, { thinkingLevel: 'off' })
  await kernel.updateConversation(cleared.id, { thinkingLevel: 'high' })
  await kernel.updateConversation(cleared.id, { thinkingLevel: '' })
  await kernel.close()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-2', thinkingLevel: 'medium' }))
  const restarted = await open(dir)
  try {
    await assertThinking(restarted, 1, 'max', 'max')
    await assertThinking(restarted, inherited.id, 'medium')
    await assertThinking(restarted, overridden.id, 'off', 'off')
    await assertThinking(restarted, cleared.id, 'medium')
    await restarted.updateConversation(1, { thinkingLevel: '' })
    await restarted.services.profiles.save({ id: 'assistant', name: 'assist', thinkingLevel: 'high' })
  } finally {
    await restarted.close()
  }
  const again = await open(dir)
  try {
    await assertThinking(again, 1, 'high')
    await assertThinking(again, inherited.id, 'high')
    await assertThinking(again, overridden.id, 'off', 'off')
    assert.equal((await sdkAgent(again, inherited.id)).model?.modelId, 'faux-2')
  } finally {
    await again.close()
  }
})

it('fork preserves thinking override; clearing fork override does not affect original conversation', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const conv = await kernel.createConversation()
  await kernel.updateConversation(conv.id, { thinkingLevel: 'high' })
  kernel.faux.setResponses([fauxAssistantMessage('fork source answer')])
  await kernel.submitInput(conv.id, 'answer')
  await kernel.waitForIdle(conv.id)
  const detail = await kernel.getConversationDetail(conv.id)
  const entry = detail.entries.findLast((entry) => entry.kind === 'pi.assistant')
  assert.ok(entry)
  // Forked SDK snapshot comes from an older entry, yet Helmx must still align the forked conversation's current override (max).
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  const forked = await kernel.forkConversation(conv.id, { entryId: Number(entry.id) })
  await kernel.setDefaultModel(undefined, 'medium')
  await assertThinking(kernel, forked.id, 'max', 'max')
  await kernel.updateConversation(forked.id, { thinkingLevel: '' })
  await assertThinking(kernel, forked.id, 'medium')
  await assertThinking(kernel, conv.id, 'max', 'max')
})

it('concurrent inheritance refresh and conversation updates serialize without losing override, title, or monotonic seq', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const conv = await kernel.createConversation()
  await Promise.all([
    kernel.setDefaultModel(undefined, 'medium'),
    kernel.updateConversation(conv.id, { thinkingLevel: 'high', title: 'keep title' }),
    kernel.alignProfileConversations('assistant'),
  ])
  await assertThinking(kernel, conv.id, 'high', 'high')
  assert.equal(kernel.getConversation(conv.id).title, 'keep title')
  assert.ok(kernel.getConversation(conv.id).stateChangeSeq > conv.stateChangeSeq)
})

it('spawn creates child with effort > Profile > global driving real SDK; resume syncs effort override and mirror', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', thinkingLevel: 'medium' })
  kernel.faux.setResponses(Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(`answer ${i}`)))
  async function spawn(agentType: string, effort?: string): Promise<number> {
    let child: number | undefined
    await kernel.spawnAgent({
      parentConversationId: 1, agentType, prompt: 'answer', effort,
      onResolved: (info) => { child = info.conversationId },
    })
    assert.ok(child)
    return child
  }
  const globalChild = await spawn('assistant')
  const profileChild = await spawn('expert')
  const effortChild = await spawn('expert', 'high')
  await assertThinking(kernel, globalChild, 'low')
  await assertThinking(kernel, profileChild, 'medium')
  await assertThinking(kernel, effortChild, 'high', 'high')
  await kernel.setDefaultModel(undefined, 'max')
  await assertThinking(kernel, globalChild, 'max')
  await assertThinking(kernel, profileChild, 'medium')
  await assertThinking(kernel, effortChild, 'high', 'high')
  await kernel.spawnAgent({ parentConversationId: 1, resume: String(effortChild), prompt: 'continue', effort: 'off' })
  await assertThinking(kernel, effortChild, 'off', 'off')
  await kernel.spawnAgent({ parentConversationId: 1, resume: String(effortChild), prompt: 'continue' })
  await assertThinking(kernel, effortChild, 'off', 'off')
  assert.equal(kernel.faux.state.callCount, 5, 'all 5 spawn/resume calls must invoke faux')
  await kernel.updateConversation(effortChild, { thinkingLevel: '' })
  await assertThinking(kernel, effortChild, 'medium')
})

// ---------------------------------------------------------------------------
// Global per-model thinking defaults (config.json.modelThinkingLevels)
// ---------------------------------------------------------------------------

it('per-model default resolves between conversation override and Profile level, above the global fallback', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'medium')

  // Per-model default outranks the Profile level for its own model only.
  await kernel.setModelThinkingDefault('faux/faux-1', 'high')
  await assertThinking(kernel, conv.id, 'high')
  // Other models without an entry keep the Profile level.
  const other = await kernel.createConversation({ profileId: 'expert', model: 'faux/faux-2' })
  await assertThinking(kernel, other.id, 'medium')

  // Explicit conversation override still outranks the per-model default.
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, 'high')

  // Clearing the per-model entry falls back to Profile, then the global fallback.
  await kernel.setModelThinkingDefault('faux/faux-1', '')
  await assertThinking(kernel, conv.id, 'medium')
  await kernel.services.profiles.save({ id: 'expert', name: 'expert' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'low')

  // New conversations and the root conversation follow the per-model default too.
  await kernel.setModelThinkingDefault('faux/faux-2', 'max')
  await assertThinking(kernel, 1, 'low')
  const conv2 = await kernel.createConversation({ model: 'faux/faux-2', profileId: 'expert' })
  await assertThinking(kernel, conv2.id, 'max')
})

it('setModelThinkingDefault persists config.json entries, clears single entries, and removes the field when empty', { timeout: 60_000 }, async (t) => {
  const { dir, kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1')
  await kernel.setModelThinkingDefault('faux/faux-1', 'high')
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(config.modelThinkingLevels, { 'faux/faux-1': 'high' })
  assert.deepEqual((await kernel.listModels()).modelThinkingLevels, { 'faux/faux-1': 'high' })

  // Model IDs containing slashes keep the full reference as the map key.
  await kernel.setModelThinkingDefault('faux/faux-2', 'max')
  await kernel.setModelThinkingDefault('faux/faux-1', '')
  const config2 = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(config2.modelThinkingLevels, { 'faux/faux-2': 'max' })
  assert.deepEqual((await kernel.listModels()).modelThinkingLevels, { 'faux/faux-2': 'max' })

  // Clearing the last entry deletes the whole field.
  await kernel.setModelThinkingDefault('faux/faux-2', '')
  const config3 = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal('modelThinkingLevels' in config3, false)
  assert.equal((await kernel.listModels()).modelThinkingLevels, undefined)

  // Full-map replacement validates before writing any global model setting.
  await assertRejectsCode(
    () => kernel.setDefaultModel(undefined, 'low', undefined, undefined, { 'faux/faux-1': 'bogus' } as never),
    'validation_error',
  )
  const afterInvalidMap = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(afterInvalidMap.thinkingLevel, undefined)
  assert.deepEqual(afterInvalidMap.modelThinkingLevels, undefined)

  // A CLI-style single-model update shares one config transaction with ordinary defaults.
  await kernel.setDefaultModel(undefined, 'low', undefined, undefined, undefined, {
    model: 'faux/faux-1', level: 'high',
  })
  const afterAtomicUpdate = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(afterAtomicUpdate.thinkingLevel, 'low')
  assert.deepEqual(afterAtomicUpdate.modelThinkingLevels, { 'faux/faux-1': 'high' })
  await assertRejectsCode(
    () => kernel.setDefaultModel(undefined, 'medium', undefined, undefined, undefined, {
      model: 'faux/faux-2', level: 'bogus',
    }),
    'validation_error',
  )
  const afterInvalidUpdate = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(afterInvalidUpdate.thinkingLevel, 'low')
  assert.deepEqual(afterInvalidUpdate.modelThinkingLevels, { 'faux/faux-1': 'high' })

  // Invalid references and levels are rejected explicitly.
  await assertRejectsCode(() => kernel.setModelThinkingDefault('no-slash-ref', 'high'), 'validation_error')
  await assertRejectsCode(() => kernel.setModelThinkingDefault('faux/faux-1', 'bogus'), 'validation_error')
  await assertRejectsCode(() => kernel.setModelThinkingDefault('', 'high'), 'validation_error')
  await kernel.setModelThinkingDefault('faux/faux-1', '')
  const config4 = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal('modelThinkingLevels' in config4, false)
})

it('startup loads config.json.modelThinkingLevels including slashed model IDs; corrupt shapes fail explicitly', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir('helmx-thinking-permodel-')
  t.after(async () => { await cleanupDir(dir) })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    model: 'faux/faux-1',
    modelThinkingLevels: { 'faux/faux-1': 'high', 'faux/vendored/nested': 'max' },
  }))
  const kernel = await open(dir)
  try {
    const conv = await kernel.createConversation()
    await assertThinking(kernel, conv.id, 'high')
    // Slashed model IDs key the map by the full reference: the lookup must rebuild 'faux' + '/' + 'vendored/nested'.
    const nested = await kernel.createConversation({ model: 'faux/vendored/nested' })
    await assertThinking(kernel, nested.id, 'max')
  } finally {
    await kernel.close()
  }

  for (const bad of [
    { 'faux/faux-1': '' },
    { 'no-slash-ref': 'high' },
    { 'faux/faux-1': 7 },
    ['faux/faux-1'],
  ]) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelThinkingLevels: bad }))
    await assertRejectsCode(() => open(dir), 'config_corrupt')
  }
})
