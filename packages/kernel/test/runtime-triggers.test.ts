/**
 * RuntimeTriggerDispatcher 缺省目标解析契约：
 * - resolveDefaultTriggerTarget 与 submitInput 之间的 TOCTOU 窗口（目标被删）：
 *   缺省路径 not_found 时重解析一次再投递（完成路由决策，非同目标投递重试）；
 * - 显式目标失效仍显式 not_found 上抛（不得被重路由掩盖）；
 * - 无候选时按需新建并合并并发创建（defaultTriggerTargetCreation 单飞）。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HelmError, type ExternalTriggerEnvelope } from '@helm/protocol'
import { RuntimeTriggerDispatcher } from '../src/runtime/runtime-triggers.js'

interface ConvMeta {
  id: number
  profileId: string
  parentConversationId?: number
  updatedAt: number
}

function makeDispatcher(over: {
  listConvs(): ConvMeta[]
  getConversation(id: number): { id: number }
  createConversation(init: { title?: string; profileId?: string }): Promise<{ id: number }>
  submitInput(id: number, text: string): Promise<void>
}) {
  return new RuntimeTriggerDispatcher({
    store: { listConvs: over.listConvs } as never,
    hookBridge: { runHookChain: async () => undefined } as never,
    getConversation: over.getConversation as never,
    getConversationOwnership: () => 'human' as const,
    createConversation: over.createConversation as never,
    submitInput: (async (id: number, text: string) => over.submitInput(id, text)) as never,
  })
}

const envelope = (over: Partial<ExternalTriggerEnvelope> = {}): ExternalTriggerEnvelope => ({
  id: 'cron:j1:1',
  source: 'cron:j1',
  text: 'payload',
  createdAt: 1,
  ...over,
})

test('缺省目标 TOCTOU：resolve 与 submit 之间目标被删 → not_found 重解析一次后投递新目标', { timeout: 60_000 }, async () => {
  // 解析时 #5 存在（human-owned assistant、无父链）；submitInput 时已被删除。
  let convs: ConvMeta[] = [{ id: 5, profileId: 'assistant', updatedAt: 1 }]
  const submitted: number[] = []
  let created = 0
  const dispatcher = makeDispatcher({
    listConvs: () => convs,
    getConversation: (id) => {
      if (id !== 9) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      return { id: 9 }
    },
    createConversation: async () => {
      created += 1
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async (id) => {
      if (id === 5) {
        convs = [] // #5 在 resolve 之后、submit 之前被删除
        throw new HelmError('not_found', '会话不存在：5', 404)
      }
      submitted.push(id)
    },
  })
  await dispatcher.dispatchTrigger(envelope())
  assert.deepEqual(submitted, [9], '重解析后投递到新目标（该次触发载荷不丢失）')
  assert.equal(created, 1)
})

test('缺省目标重解析后仍失败：如实上抛 not_found（不无限重试）', { timeout: 60_000 }, async () => {
  let convs: ConvMeta[] = []
  const dispatcher = makeDispatcher({
    listConvs: () => convs,
    getConversation: () => ({ id: 9 }),
    createConversation: async () => {
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async () => {
      convs = [] // 重解析命中的新目标在 submit 前又被删除（极端窗口）
      throw new HelmError('not_found', '会话不存在：9', 404)
    },
  })
  await assert.rejects(dispatcher.dispatchTrigger(envelope()), (err: unknown) => {
    assert.ok(err instanceof HelmError && err.code === 'not_found')
    return true
  })
})

test('显式目标在 submit 时失效：not_found 如实上抛，不被缺省重路由掩盖', { timeout: 60_000 }, async () => {
  const submitted: number[] = []
  const dispatcher = makeDispatcher({
    listConvs: () => [{ id: 5, profileId: 'assistant', updatedAt: 1 }],
    getConversation: () => ({ id: 5 }), // 预校验（hook 前）通过
    createConversation: async () => {
      throw new HelmError('unsupported', '显式目标路径不得新建会话', 501)
    },
    submitInput: async (id) => {
      submitted.push(id)
      throw new HelmError('not_found', `会话不存在：${id}`, 404)
    },
  })
  await assert.rejects(
    dispatcher.dispatchTrigger(envelope({ targetConversationId: 5 })),
    (err: unknown) => err instanceof HelmError && err.code === 'not_found',
  )
  assert.deepEqual(submitted, [5], '只尝试显式目标一次')
})

test('缺省目标无候选：并发触发合并一次按需创建（单飞）', { timeout: 60_000 }, async () => {
  let convs: ConvMeta[] = []
  let creations = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatcher = makeDispatcher({
    listConvs: () => convs,
    getConversation: (id) => ({ id }),
    createConversation: async () => {
      creations += 1
      await gate
      convs = [{ id: 11, profileId: 'assistant', updatedAt: 2 }]
      return { id: 11 }
    },
    submitInput: async () => {},
  })
  const a = dispatcher.dispatchTrigger(envelope({ id: 'a' }))
  const b = dispatcher.dispatchTrigger(envelope({ id: 'b' }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(creations, 1, '并发缺省触发只发起一次按需创建')
  release()
  await Promise.all([a, b])
  assert.equal(creations, 1)
})
