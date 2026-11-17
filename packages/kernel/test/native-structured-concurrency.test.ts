import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'

test('concurrent native-spawn structured output subagents isolate validation and result slots per conversation', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-structured-concurrent-'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  let arrived = 0
  let release!: () => void
  let rejectBarrier!: (error: Error) => void
  const bothGenerating = new Promise<void>((resolve, reject) => { release = resolve; rejectBarrier = reject })
  const barrierTimeout = setTimeout(() => rejectBarrier(new Error('both subagents did not enter generation concurrently')), 5_000)
  const response: FauxResponseFactory = async (context) => {
    if (context.messages.some((message) => message.role === 'toolResult')) return fauxAssistantMessage('committed structured result')
    arrived += 1
    if (arrived === 2) release()
    await bothGenerating
    const tag = JSON.stringify(context.messages).includes('taskAunique') ? 'A' : 'B'
    return fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { tag } })], { stopReason: 'toolUse' })
  }
  faux.setResponses(Array.from({ length: 8 }, () => response))
  const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, models, model: 'faux/faux-1' })
  try {
    const schema = (tag: string) => ({ type: 'object', properties: { tag: { const: tag } }, required: ['tag'], additionalProperties: false })
    const results = await Promise.all([
      kernel.spawnAgent({ parentConversationId: 1, prompt: 'taskAunique', schema: schema('A') }),
      kernel.spawnAgent({ parentConversationId: 1, prompt: 'taskBunique', schema: schema('B') }),
    ])
    assert.deepEqual(results, [{ tag: 'A' }, { tag: 'B' }])
    assert.equal(arrived, 2)
    assert.equal(faux.state.callCount, 4, 'each subagent submits once and wraps up once without cross-conversation interference or repair turns')
  } finally {
    clearTimeout(barrierTimeout)
    release()
    await kernel.close()
    await rm(dir, { recursive: true, force: true })
  }
})
