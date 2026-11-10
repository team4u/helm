import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createHelm } from '../src/app.js'
import type { RecallGraphDoc } from '../src/builtin-plugins/superagent/contracts.js'

test('真实组合：编辑 Worker 历史输入经 SDK 事件清理对应召回节点并保留前轮', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-rewrite-recall-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const { kernel } = app
    await kernel.profiles.save({ id: 'rewrite-expert', name: '编辑回归专家' })
    await kernel.plugins.enable('builtin:superagent')
    const index = kernel.plugins.getPublicDoc('builtin:superagent', 'index').value as { routerConversationId: number }
    faux.setResponses([fauxAssistantMessage('初始任务完成'), fauxAssistantMessage('中枢已记录')])
    const worker = await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '准备初始任务', profileId: 'rewrite-expert',
    }) as { workerConversationId: number }
    const id = worker.workerConversationId
    await kernel.waitForIdle(id)
    await kernel.waitForIdle(index.routerConversationId)
    const nodes = () => (kernel.plugins.getPublicDoc('builtin:superagent', 'recall-graph').value as RecallGraphDoc)
      .nodes.filter((node) => node.conversationId === id)
    assert.equal(nodes().length, 1)

    faux.setResponses([
      fauxAssistantMessage('应保留的第一轮回答'),
      fauxAssistantMessage('应失效的第二轮旧回答'),
      fauxAssistantMessage('编辑后的第二轮回答'),
    ])
    await kernel.submitInput(id, '应保留的第一轮提问')
    await kernel.waitForIdle(id)
    await kernel.submitInput(id, '应失效的第二轮旧提问')
    await kernel.waitForIdle(id)
    const oldNodes = nodes()
    assert.equal(oldNodes.length, 3)
    const detail = await kernel.getConversationDetail(id)
    const oldInput = detail.entries.find((entry) => entry.kind === 'helm.input'
      && (entry.data as { text?: string }).text === '应失效的第二轮旧提问')
    assert.ok(oldInput)
    const inputId = (oldInput.data as { id: string }).id
    const oldNode = oldNodes.find((node) => node.inputIds.includes(inputId))
    assert.ok(oldNode)
    const retainedIds = oldNodes.filter((node) => node.id !== oldNode.id).map((node) => node.id)

    await kernel.submitInput(id, '编辑后的第二轮提问', { replaceFromEntryId: Number(oldInput.id) })
    await kernel.waitForIdle(id)
    const updated = nodes()
    assert.equal(updated.length, 3, '旧节点被移除，新回合生成一个新节点')
    assert.equal(updated.some((node) => node.id === oldNode.id || node.inputIds.includes(inputId)), false)
    assert.ok(retainedIds.every((nodeId) => updated.some((node) => node.id === nodeId)), '前轮召回节点保留')
    assert.ok(updated.some((node) => node.summary.includes('编辑后的第二轮回答')))
    assert.equal(JSON.stringify((await kernel.getConversationDetail(id)).entries).includes('应失效的第二轮旧回答'), false)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
