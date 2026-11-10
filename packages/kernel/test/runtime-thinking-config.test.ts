/** 真实 SQLite + pi-durable + faux：镜像、继承覆盖和 SDK 配置必须一致。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/runtime.js'

type Runtime = KernelRuntime & { faux: ReturnType<typeof fauxProvider> }
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
  const models = createModels()
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  models.setProvider(faux.provider)
  return Object.assign(await KernelRuntime.open({
    dataDir: dir, cwd: dir, models,
  }), { faux })
}

async function fixture(t: TestContext): Promise<{ dir: string; kernel: Runtime }> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-thinking-'))
  const kernel = await open(dir)
  t.after(async () => {
    await kernel.close()
    rmSync(dir, { recursive: true, force: true })
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
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', '真实 SDK 必须与镜像一致')
}

it('只改全局 thinking 保留模型；模型覆盖不阻断思考继承；刷新发事件且递增会话序号', { timeout: 60_000 }, async (t) => {
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

it('会话覆盖独立保护，清除后回到 Profile/全局；全部清除用 SDK null 回 off', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: '专家', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'medium')
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await kernel.setDefaultModel(undefined, 'high')
  await kernel.services.profiles.save({ id: 'expert', name: '专家', thinkingLevel: 'minimal' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'max', 'max')
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, 'minimal')
  await kernel.services.profiles.save({ id: 'expert', name: '专家' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high')
  await kernel.setDefaultModel(undefined, '')
  await assertThinking(kernel, conv.id, '')
  assert.equal((await sdkAgent(kernel, conv.id)).model?.modelId, 'faux-1')
})

it('Profile 保存刷新模型和思考；换 Profile 重算继承并保留显式覆盖', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: '专家', model: 'faux/faux-1', thinkingLevel: 'medium' })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await kernel.services.profiles.save({ id: 'expert', name: '专家', model: 'faux/faux-2', thinkingLevel: 'high' })
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

it('没有模型时也同步思考配置，清模型时删除 SDK 旧模型', { timeout: 60_000 }, async (t) => {
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

it('重启重算 root/普通会话继承，保留 root 与普通会话覆盖和已清除覆盖', { timeout: 60_000 }, async (t) => {
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
    await restarted.services.profiles.save({ id: 'assistant', name: '助理', thinkingLevel: 'high' })
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

it('fork 保留思考 override，清除分叉覆盖不影响原会话', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const conv = await kernel.createConversation()
  await kernel.updateConversation(conv.id, { thinkingLevel: 'high' })
  kernel.faux.setResponses([fauxAssistantMessage('分叉源回答')])
  await kernel.submitInput(conv.id, '回答')
  await kernel.waitForIdle(conv.id)
  const detail = await kernel.getConversationDetail(conv.id)
  const entry = detail.entries.findLast((entry) => entry.kind === 'pi.assistant')
  assert.ok(entry)
  // fork 的 SDK 快照来自旧条目，Helm 的当前覆盖仍须重新对齐到 max。
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  const forked = await kernel.forkConversation(conv.id, { entryId: Number(entry.id) })
  await kernel.setDefaultModel(undefined, 'medium')
  await assertThinking(kernel, forked.id, 'max', 'max')
  await kernel.updateConversation(forked.id, { thinkingLevel: '' })
  await assertThinking(kernel, forked.id, 'medium')
  await assertThinking(kernel, conv.id, 'max', 'max')
})

it('并发继承刷新与会话修改串行，覆盖、标题和递增序号均不丢失', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  const conv = await kernel.createConversation()
  await Promise.all([
    kernel.setDefaultModel(undefined, 'medium'),
    kernel.updateConversation(conv.id, { thinkingLevel: 'high', title: '保留标题' }),
    kernel.alignProfileConversations('assistant'),
  ])
  await assertThinking(kernel, conv.id, 'high', 'high')
  assert.equal(kernel.getConversation(conv.id).title, '保留标题')
  assert.ok(kernel.getConversation(conv.id).stateChangeSeq > conv.stateChangeSeq)
})

it('spawn 新建按 effort > Profile > 全局驱动真实 SDK；resume effort 同步覆盖与镜像', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux/faux-1', 'low')
  await kernel.services.profiles.save({ id: 'expert', name: '专家', thinkingLevel: 'medium' })
  kernel.faux.setResponses(Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(`回答 ${i}`)))
  async function spawn(agentType: string, effort?: string): Promise<number> {
    let child: number | undefined
    await kernel.spawnAgent({
      parentConversationId: 1, agentType, prompt: '回答', effort,
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
  await kernel.spawnAgent({ parentConversationId: 1, resume: String(effortChild), prompt: '继续', effort: 'off' })
  await assertThinking(kernel, effortChild, 'off', 'off')
  await kernel.spawnAgent({ parentConversationId: 1, resume: String(effortChild), prompt: '继续' })
  await assertThinking(kernel, effortChild, 'off', 'off')
  assert.equal(kernel.faux.state.callCount, 5, '五次 spawn/resume 都必须真正请求 faux')
  await kernel.updateConversation(effortChild, { thinkingLevel: '' })
  await assertThinking(kernel, effortChild, 'medium')
})
