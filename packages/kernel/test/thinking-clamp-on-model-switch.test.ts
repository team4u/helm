/**
 * 切换模型后思考等级按目标模型能力自动收敛（真实 SQLite + pi-durable + faux 请求）。
 *
 * 参考 pi coding agent 的 setModel → setThinkingLevel 语义：目标模型能力未知时透传
 * （不虚构能力），能力已知且当前档位不被支持时按 SDK 可用档位序列就近收敛。
 *
 * 覆盖：
 * - 真实 reasoning 模型 A（thinkingLevelMap 声明支持 max）→ 模型 B（仅支持到 high）：
 *   显式覆盖 max 的会话切到 B 后 summary.thinkingLevel / thinkingLevelOverride /
 *   SDK agent.thinkingLevel 三者均为 high；
 * - 显式 max 覆盖 + Profile 模型 A→B 的 align：override/effective/SDK 均 high，
 *   且 align 持久化收敛结果——后续仅改标题不再变档、切回 A 仍 high；
 * - 生效档位（继承链，无覆盖）同样收敛：全局/Profile 配置 max 落到 B 时为 high；
 * - 空串（未配置）不得被误收敛为 'off'：保持继承链语义；
 * - faux 测试模型（reasoning:false、无 thinkingLevelMap、能力未知）契约不破坏：
 *   任意继承档位原样透传（与 runtime-thinking-config.test.ts 基线一致）；
 * - spawn 新建子代理按目标模型能力收敛 effort；resume 显式 effort 同样收敛。
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
 * 带 reasoning 能力元数据的 faux 网关：createFauxCore 提供流实现，
 * 模型定义后再补 thinkingLevelMap（faux 模型定义本身不暴露该字段）。
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
  /** 能力已知网关 A（faux-cap/model-a 支持 max；faux-cap/model-b 仅到 high）。 */
  capA: ReturnType<typeof reasoningFauxProvider>
  capB: ReturnType<typeof reasoningFauxProvider>
  /** 能力未知网关（faux 默认：reasoning:false 无 map，透传契约基线）。 */
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
        // A 显式声明支持到 max（xhigh/max 必须显式 map 才可用）。
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
        // B 仅支持到 high：xhigh/max 为 null。
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      },
    ],
  })
  // 能力未知基线：faux 默认形态（reasoning:false、无 thinkingLevelMap）。
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
  assert.equal((await sdkAgent(kernel, id)).thinkingLevel, effective || 'off', '真实 SDK 必须与镜像一致')
}

it('A(max) 切 B(仅 high)：summary、override、SDK agent 均收敛为 high', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  const conv = await kernel.createConversation()
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // 切到模型 B：max 不被支持 → 收敛到 high（按 SDK 可用档位序列就近收敛）。
  await kernel.updateConversation(conv.id, { model: 'faux-cap-b/model-b' })
  await assertThinking(kernel, conv.id, 'high', 'high')

  // 切回 A：收敛后的 high 仍是 A 支持的档位，保持不变（pi setThinkingLevel 语义：持久化收敛值）。
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'high', 'high')
})

it('继承链（无覆盖）同样收敛：全局 max 落到 B 为 high，回到 A 恢复 max', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'high', undefined)

  // 会话切到 A：继承的全局 max 重新可用。
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'max', undefined)
})

it('Profile 档位随 Profile 模型对齐；会话换 Profile 重算并收敛', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: '专家', model: 'faux-cap-a/model-a', thinkingLevel: 'max',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  await assertThinking(kernel, conv.id, 'max', undefined)

  // Profile 模型改到 B：档位 max 随继承链收敛为 high。
  await kernel.services.profiles.save({ id: 'expert', name: '专家', model: 'faux-cap-b/model-b', thinkingLevel: 'max' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', undefined)

  // 会话真实切换到另一个 Profile（模型同为 A、档位 high）：生效档随新继承链重算。
  await kernel.services.profiles.save({ id: 'reviewer', name: '评审', model: 'faux-cap-a/model-a', thinkingLevel: 'high' })
  await kernel.updateConversation(conv.id, { profileId: 'reviewer' })
  await assertThinking(kernel, conv.id, 'high', undefined)
})

it('显式 max 覆盖 + Profile 模型 A→B align：override/effective/SDK 均 high 且持久化', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a')
  await kernel.services.profiles.save({
    id: 'expert', name: '专家', model: 'faux-cap-a/model-a', thinkingLevel: 'medium',
  })
  const conv = await kernel.createConversation({ profileId: 'expert' })
  // 显式覆盖 max：A 支持时三层均为 max。
  await kernel.updateConversation(conv.id, { thinkingLevel: 'max' })
  await assertThinking(kernel, conv.id, 'max', 'max')

  // Profile 模型改到 B（仅支持到 high）后 align：显式覆盖同样收敛并持久化为 high。
  await kernel.services.profiles.save({ id: 'expert', name: '专家', model: 'faux-cap-b/model-b', thinkingLevel: 'medium' })
  await kernel.alignProfileConversations('expert')
  await assertThinking(kernel, conv.id, 'high', 'high')

  // 后续仅改标题（不动模型/档位）：档位不被任何链路重算或漂移。
  await kernel.updateConversation(conv.id, { title: '改个标题' })
  await assertThinking(kernel, conv.id, 'high', 'high')

  // 切回模型 A：收敛持久化的 high 是 A 支持的档位，保持不变。
  await kernel.updateConversation(conv.id, { model: 'faux-cap-a/model-a' })
  await assertThinking(kernel, conv.id, 'high', 'high')
})

it('空串（未配置）不被误收敛为 off；off 语义保持', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-b/model-b')
  // 全局未配置思考档位：创建会话后为空串，SDK off。
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, '', undefined)

  // 显式 off 覆盖：B 的 map.off 为 null（off 不在支持列表），但 SDK off 语义
  // 不得被 clamp 抬升到最小可用档（minimal）。
  await kernel.updateConversation(conv.id, { thinkingLevel: 'off' })
  await assertThinking(kernel, conv.id, 'off', 'off')

  // 清除覆盖回到空串继承。
  await kernel.updateConversation(conv.id, { thinkingLevel: '' })
  await assertThinking(kernel, conv.id, '', undefined)
})

it('能力未知（faux 默认形态）透传不破坏既有契约', { timeout: 60_000 }, async (t) => {
  const { kernel } = await fixture(t)
  // legacy-1 不声明任何能力（reasoning:false、无 map）：max 原样透传，
  // 与 runtime-thinking-config.test.ts 的 faux 基线一致。
  await kernel.setDefaultModel('faux-legacy/legacy-1', 'max')
  const conv = await kernel.createConversation()
  await assertThinking(kernel, conv.id, 'max', undefined)
  await kernel.updateConversation(conv.id, { thinkingLevel: 'xhigh' })
  await assertThinking(kernel, conv.id, 'xhigh', 'xhigh')
})

it('spawn 新建按目标模型能力收敛 effort；resume 显式 effort 同样收敛', { timeout: 60_000 }, async (t) => {
  const { kernel, capA, capB } = await fixture(t)
  await kernel.setDefaultModel('faux-cap-a/model-a', 'low')
  capA.core.setResponses([fauxAssistantMessage('A 完成')])
  capB.core.setResponses([fauxAssistantMessage('B 完成')])
  let childA = 0
  let childB = 0
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: '任务 A',
    model: 'faux-cap-a/model-a',
    effort: 'max',
    onResolved: (info) => { childA = info.conversationId ?? 0 },
  })
  await assertThinking(kernel, childA, 'max', 'max')

  // 目标模型 B 仅支持到 high：显式 effort max 收敛为 high。
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: '任务 B',
    model: 'faux-cap-b/model-b',
    effort: 'max',
    onResolved: (info) => { childB = info.conversationId ?? 0 },
  })
  await assertThinking(kernel, childB, 'high', 'high')

  // resume：换模型到 A 后不带 effort：镜像已收敛的 high 保持（A 也支持 high），
  // 不回退也不抬升。
  capA.core.setResponses([fauxAssistantMessage('A 续接')])
  await kernel.spawnAgent({
    parentConversationId: 1,
    prompt: '续接 A',
    resume: String(childB),
    model: 'faux-cap-a/model-a',
  })
  await assertThinking(kernel, childB, 'high', 'high')
})
