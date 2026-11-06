/**
 * 全局模型配置与 Profile 遗留回归（0507188 行为锁定）：
 *
 * 模型解析链：options.model > HELM_MODEL > config.json.model（三者均无 = 未配置）；
 * 会话生效链：会话 override > Profile.model > 全局；Profile.model 为空串视为
 * 未配置（继承全局）；assistant 根 Profile 优先于全局且重启后保持。
 * 显式错误契约（不静默降级）：config.model 非法 -> config_corrupt；
 * Profile JSON 损坏 -> profile_read_failed（带 profileId）；既有会话引用的
 * Profile 被删 -> profile_not_found（即使有 override 也要求真实 Profile 存在）；
 * create 显式 profileId 不存在 -> validation_error（不再回落 assistant）。
 * 全部用真实 KernelRuntime + faux provider + 临时 dataDir；「真实请求」断言
 * assistant entry 模型消息的 provider/model 与 faux 调用计数。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type ConversationEntry } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>
type RuntimeWithFaux = KernelRuntime & { __faux: FauxHandle }

/** 双模型 faux 目录（faux-1/faux-2）用于区分优先级来源。 */
function makeFauxModels(ids: string[]): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider({ models: ids.map((id) => ({ id })) })
  models.setProvider(faux.provider)
  return { models, faux }
}

async function openRuntime(
  dir: string,
  opts: { model?: string; ids?: string[] } = {},
): Promise<RuntimeWithFaux> {
  const { models, faux } = makeFauxModels(opts.ids ?? ['faux-1'])
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** 在 dataDir 写一个 profile（profile.json）。 */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

/** 最近一条 pi.assistant entry（含模型消息，供断言真实请求所用模型）。 */
async function lastAssistantEntry(kernel: KernelRuntime, convId: number): Promise<ConversationEntry> {
  const detail = await kernel.getConversationDetail(convId, { limit: 50 })
  const entry = [...detail.entries].reverse().find((e) => e.kind === 'pi.assistant')
  assert.ok(entry, '应有 pi.assistant entry')
  return entry
}

/** 断言真实模型请求的 provider/modelId（faux 克隆消息时会改写为请求模型）。 */
function assertRequestModel(entry: ConversationEntry, provider: string, modelId: string): void {
  const message = (entry.model ?? [])[0] as { provider?: string; model?: string } | undefined
  assert.ok(message, 'assistant entry 应保留模型消息')
  assert.equal(message.provider, provider)
  assert.equal(message.model, modelId)
}

function isHelm(code: string): (err: unknown) => boolean {
  return (err) => err instanceof HelmError && err.code === code
}

let root: string
let savedHelmModel: string | undefined

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-model-cfg-'))
  // 本文件显式管理全部模型来源，隔离外部环境变量。
  savedHelmModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
})

after(async () => {
  if (savedHelmModel !== undefined) process.env['HELM_MODEL'] = savedHelmModel
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. config.json.model 单独生效（真实 faux 请求）
// ---------------------------------------------------------------------------

describe('config.json.model 全局模型', { timeout: 60_000 }, () => {
  it('无 options/env 时 config.model 生效于 root 与新会话，并驱动真实 faux 请求', { timeout: 60_000 }, async () => {
    const dir = join(root, 'c1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-1' }))
    const kernel = await openRuntime(dir)
    try {
      assert.equal(kernel.getConversation(1).model, 'faux/faux-1')
      const conv = await kernel.createConversation({})
      assert.equal(conv.model, 'faux/faux-1')
      kernel.__faux.setResponses([fauxAssistantMessage('配置模型回答')])
      await kernel.submitInput(1, '问')
      await kernel.waitForIdle(1)
      assertRequestModel(await lastAssistantEntry(kernel, 1), 'faux', 'faux-1')
      assert.ok(kernel.__faux.state.callCount >= 1, '应发生真实 faux 请求')
    } finally {
      await kernel.close()
    }
  })

  it('config.model 非法类型/格式时启动显式 config_corrupt', { timeout: 60_000 }, async () => {
    const dirNum = join(root, 'c2')
    mkdirSync(dirNum, { recursive: true })
    writeFileSync(join(dirNum, 'config.json'), JSON.stringify({ model: 123 }))
    await assert.rejects(() => openRuntime(dirNum), isHelm('config_corrupt'))

    const dirBad = join(root, 'c3')
    mkdirSync(dirBad, { recursive: true })
    writeFileSync(join(dirBad, 'config.json'), JSON.stringify({ model: 'faux-1' }))
    await assert.rejects(() => openRuntime(dirBad), isHelm('config_corrupt'))
  })
})

// ---------------------------------------------------------------------------
// 2. options.model > HELM_MODEL > config.json.model
// ---------------------------------------------------------------------------

describe('全局模型来源优先级', { timeout: 60_000 }, () => {
  it('env 覆盖 config；options 覆盖 env+config 且重启后对齐既有会话', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-2' }))
    process.env['HELM_MODEL'] = 'faux/faux-1'
    let k1: RuntimeWithFaux | undefined
    try {
      k1 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      const conv = await k1.createConversation({})
      assert.equal(conv.model, 'faux/faux-1', 'HELM_MODEL 应优先于 config.json.model')
      k1.__faux.setResponses([fauxAssistantMessage('env 回答')])
      await k1.submitInput(conv.id, '问')
      await k1.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(k1, conv.id), 'faux', 'faux-1')
      await k1.close()
      k1 = undefined
      delete process.env['HELM_MODEL']

      // options.model 最高优先：重启后既有会话按新全局对齐。
      const k2 = await openRuntime(dir, { model: 'faux/faux-2', ids: ['faux-1', 'faux-2'] })
      try {
        assert.equal(k2.getConversation(conv.id).model, 'faux/faux-2')
        k2.__faux.setResponses([fauxAssistantMessage('options 回答')])
        await k2.submitInput(conv.id, '问')
        await k2.waitForIdle(conv.id)
        assertRequestModel(await lastAssistantEntry(k2, conv.id), 'faux', 'faux-2')
      } finally {
        await k2.close()
      }
    } finally {
      if (k1) await k1.close().catch(() => {})
      delete process.env['HELM_MODEL']
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Profile 与会话覆盖优先级、空 model 继承
// ---------------------------------------------------------------------------

describe('Profile.model 与会话覆盖', { timeout: 60_000 }, () => {
  it('Profile 优先于全局；override 优先于 Profile；清除后回链；空 model 继承全局', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p3')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-2' })
    writeProfile(dir, 'empty', { name: 'E', model: '' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-2', 'Profile.model 应优先于全局')
      kernel.__faux.setResponses([fauxAssistantMessage('profile 模型回答')])
      await kernel.submitInput(conv.id, '问')
      await kernel.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(kernel, conv.id), 'faux', 'faux-2')

      const overridden = await kernel.updateConversation(conv.id, { model: 'faux/faux-1' })
      assert.equal(overridden.model, 'faux/faux-1', '会话 override 应优先于 Profile')
      const cleared = await kernel.updateConversation(conv.id, { model: '' })
      assert.equal(cleared.model, 'faux/faux-2', '清除 override 后回退 Profile.model')

      const inherited = await kernel.createConversation({ profileId: 'empty' })
      assert.equal(inherited.model, 'faux/faux-1', 'Profile.model 空串视为未配置，继承全局')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. assistant 根 Profile 优先与重启
// ---------------------------------------------------------------------------

describe('assistant 根 Profile 模型', { timeout: 60_000 }, () => {
  it('根 #1 用 assistant Profile.model（优先于全局）；无全局重启后保持并可提交', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p4')
    writeProfile(dir, 'assistant', { name: '助理', model: 'faux/faux-2' })
    const k1 = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      assert.equal(k1.getConversation(1).model, 'faux/faux-2', '根会话应取 assistant Profile 模型')
      k1.__faux.setResponses([fauxAssistantMessage('根会话回答')])
      await k1.submitInput(1, '问')
      await k1.waitForIdle(1)
      assertRequestModel(await lastAssistantEntry(k1, 1), 'faux', 'faux-2')
      await k1.close()

      // 重启且不提供任何全局来源：root 仍为 assistant Profile 模型（SDK 配置持久）。
      const k2 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      try {
        assert.equal(k2.getConversation(1).model, 'faux/faux-2')
        k2.__faux.setResponses([fauxAssistantMessage('重启后回答')])
        await k2.submitInput(1, '再问')
        await k2.waitForIdle(1)
        assertRequestModel(await lastAssistantEntry(k2, 1), 'faux', 'faux-2')
      } finally {
        await k2.close()
      }
    } catch (error) {
      await k1.close().catch(() => {})
      throw error
    }
  })
})

// ---------------------------------------------------------------------------
// 5. create 显式 profileId：缺失拒绝，创建真实 Profile 后绑定
// ---------------------------------------------------------------------------

describe('create 显式 profileId 校验', { timeout: 60_000 }, () => {
  it('不存在时 validation_error（不回落 assistant）；创建后正常绑定并可配置模型', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p5')
    const kernel = await openRuntime(dir)
    try {
      await assert.rejects(
        () => kernel.createConversation({ profileId: 'ghost' }),
        isHelm('validation_error'),
      )
      writeProfile(dir, 'ghost', { name: 'G', model: 'faux/faux-1' })
      const conv = await kernel.createConversation({ profileId: 'ghost' })
      assert.equal(conv.profileId, 'ghost')
      assert.equal(conv.model, 'faux/faux-1')
      // 模型引用格式边界同样显式拒绝。
      await assert.rejects(
        () => kernel.createConversation({ model: 'no-slash' }),
        isHelm('validation_error'),
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Profile 损坏 / 被删：显式错误且 faux 不被调用
// ---------------------------------------------------------------------------

describe('Profile 损坏与缺失的显式错误', { timeout: 60_000 }, () => {
  it('JSON 损坏 -> profile_read_failed；删除 -> profile_not_found / validation_error；faux 零调用', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p6')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir)
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-1')

      // 损坏 JSON：读路径统一显式上抛（不吞错、不静默当未配置）。
      writeFileSync(join(dir, 'profiles', 'worker', 'profile.json'), '{ broken json')
      await assert.rejects(
        () => kernel.createConversation({ profileId: 'worker' }),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'profile_read_failed' &&
          (err.details as { profileId?: string })?.profileId === 'worker',
      )
      await assert.rejects(
        () => kernel.updateConversation(conv.id, { title: 'x' }),
        isHelm('profile_read_failed'),
      )
      await assert.rejects(() => kernel.submitInput(conv.id, '问题'), isHelm('profile_read_failed'))
      assert.equal(kernel.__faux.state.callCount, 0, 'Profile 损坏时不得发起模型请求')

      // 既有会话的 Profile 被删：即使会话已有生效模型也要求真实 Profile 存在。
      rmSync(join(dir, 'profiles', 'worker'), { recursive: true, force: true })
      await assert.rejects(
        () => kernel.submitInput(conv.id, '问题'),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'profile_not_found' &&
          (err.details as { profileId?: string })?.profileId === 'worker',
      )
      await assert.rejects(() => kernel.updateConversation(conv.id, { title: 'y' }), isHelm('profile_not_found'))
      await assert.rejects(() => kernel.createConversation({ profileId: 'worker' }), isHelm('validation_error'))
      assert.equal(kernel.__faux.state.callCount, 0, 'Profile 缺失时不得发起模型请求')
    } finally {
      await kernel.close()
    }
  })
})
