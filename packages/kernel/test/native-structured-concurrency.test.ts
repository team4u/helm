import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'

test('并行原生子代理的结构化输出工具按真实子会话隔离校验与结果槽', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-structured-concurrent-'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  let arrived = 0
  let release!: () => void
  let rejectBarrier!: (error: Error) => void
  const bothGenerating = new Promise<void>((resolve, reject) => { release = resolve; rejectBarrier = reject })
  const barrierTimeout = setTimeout(() => rejectBarrier(new Error('两个子代理未同时进入生成阶段')), 5_000)
  const response: FauxResponseFactory = async (context) => {
    if (context.messages.some((message) => message.role === 'toolResult')) return fauxAssistantMessage('已提交结构化结果')
    arrived += 1
    if (arrived === 2) release()
    await bothGenerating
    const tag = JSON.stringify(context.messages).includes('任务A唯一') ? 'A' : 'B'
    return fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { tag } })], { stopReason: 'toolUse' })
  }
  faux.setResponses(Array.from({ length: 8 }, () => response))
  const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, models, model: 'faux/faux-1' })
  try {
    const schema = (tag: string) => ({ type: 'object', properties: { tag: { const: tag } }, required: ['tag'], additionalProperties: false })
    const results = await Promise.all([
      kernel.spawnAgent({ parentConversationId: 1, prompt: '任务A唯一', schema: schema('A') }),
      kernel.spawnAgent({ parentConversationId: 1, prompt: '任务B唯一', schema: schema('B') }),
    ])
    assert.deepEqual(results, [{ tag: 'A' }, { tag: 'B' }])
    assert.equal(arrived, 2)
    assert.equal(faux.state.callCount, 4, '每个子代理各一次提交与一次收尾，无串会话造成的额外修复回合')
  } finally {
    clearTimeout(barrierTimeout)
    release()
    await kernel.close()
    await rm(dir, { recursive: true, force: true })
  }
})
