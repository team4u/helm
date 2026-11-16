/** real SQLite + pi-durable + faux: mirror, inherit override and SDK config must consistent. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type Runtime = KernelRuntime & { faux: ReturnType<typeof makeFauxModels>['faux'] }
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

async function open(dir: string): Promise<Runtime> {
  const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  return Object.assign(await KernelRuntime.open({
    dataDir: dir, cwd: dir, models,
  }), { faux })
}

async function fixture(t: TestContext): Promise<{ dir: string; kernel: Runtime }> {
  const dir = await makeTempDir('helm-thinking-')
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
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', 'real SDK must and mirror consistent')
}

it('only change global thinking keep model; model override do not block assert think inherit; refresh event and pass increase conversation ordinal', { timeout: 60_000 }, async (t) => {
  const { dir, kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const inherited = await kernel.createConversation()
  const modelOverride = await kernel.createConversation({ model: 'faux/faux-2' })
  const seq = modelOverride.stateChangeSeq
  const frames: HelmEventFrame[] = []
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

it('conversation override independent protect, clear after back to Profile/global; all clear use SDK null back off', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'medium')
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await kernel.setDefaultModel(undefined, 'high')
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', thinkingLevel: 'minimal' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'max', 'max')
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, 'minimal')
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high')
  await kernel.setDefaultModel(undefined, '')
  await assertThinking(kernel, conv.id, '')
  assert.equal((await sdkAgent(kernel, conv.id)).model?.modelId, 'faux-1')
})

it('Profile save refresh model and think; swap Profile heavy compute inherit and keep explicit override', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', model: 'faux/faux-1', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', model: 'faux/faux-2', thinkingLevel: 'high' })
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

it('no model when also sync think config, clean model when delete SDK old model', { timeout: 60_000 }, async (t) => {
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

it('restart heavy compute root/ordinary conversation inherit, keep root and ordinary conversation override and already clear override', { timeout: 60_000 }, async (t) => {
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

it('fork keep think override, clear fork override does not affect original conversation', { timeout: 60_000 }, async (t) => {
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
  // fork  SDK snapshot from old item,Helm when before override still must re- align to max.
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  const forked = await kernel.forkConversation(conv.id, { entryId: Number(entry.id) })
  await kernel.setDefaultModel(undefined, 'medium')
  await assertThinking(kernel, forked.id, 'max', 'max')
  await kernel.updateConversation(forked.id, { thinkingLevel: '' })
  await assertThinking(kernel, forked.id, 'medium')
  await assertThinking(kernel, conv.id, 'max', 'max')
})

it('concurrency inherit refresh and conversation modify serial, override, title and pass increase ordinal all without losing', { timeout: 60_000 }, async (t) => {
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

it('spawn creates new by effort > Profile > global drive real SDK;resume effort sync override and mirror', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: 'dedicated household', thinkingLevel: 'medium' })
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
  assert.equal(kernel.faux.state.callCount, 5, 'five time spawn/resume all must truly request faux')
  await kernel.updateConversation(effortChild, { thinkingLevel: '' })
  await assertThinking(kernel, effortChild, 'medium')
})
