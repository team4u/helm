import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createHelm } from '../src/app.js'

test('派工自动标题和召回元数据不持久化已登记机密', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-superagent-title-secret-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    await app.kernel.plugins.enable('builtin:superagent')
    const secret = 'private-title-token-9f4d2a'
    app.kernel.stash.put(1, 'PRIVATE_TOKEN', secret)
    faux.setResponses([fauxAssistantMessage('处理完成'), fauxAssistantMessage('已收到汇报')])
    const result = await app.kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: `处理 ${secret} 对应的任务`,
    }) as { workerConversationId: number }
    await app.kernel.waitForIdle(result.workerConversationId)
    const index = (await app.kernel.plugins.getPublicDoc('builtin:superagent', 'index')).value as { routerConversationId: number }
    await app.kernel.waitForIdle(index.routerConversationId)
    assert.equal(app.kernel.getConversation(result.workerConversationId).title.includes(secret), false)
    await app.kernel.documentStore.flush()
    const db = new DatabaseSync(join(dataDir, 'state.sqlite'), { readOnly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      for (const { name } of tables) {
        const quoted = name.replaceAll('"', '""')
        const rows = db.prepare(`SELECT * FROM "${quoted}"`).all()
        assert.equal(JSON.stringify(rows).includes(secret), false, `机密不得进入 ${name}`)
      }
    } finally {
      db.close()
    }
  } finally {
    try { await app.close() } finally { await rm(dataDir, { recursive: true, force: true }) }
  }
})
