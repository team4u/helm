/** 单次问答的真实 CLI → HTTP → SDK 回合契约，模型使用官方 faux provider。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { runCli } from '../../cli/src/index.js'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-cli-ask-'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const auth = app.kernel.auth.createProcessToken()
  const hub = await startHub({ kernel: app.kernel, port: 0 })
  return {
    app,
    faux,
    async ask(args: string[], stdinText?: string) {
      let out = ''
      let err = ''
      const code = await runCli(['ask', ...args, '--json'], {
        env: { HELM_HUB_URL: hub.url, HELM_TOKEN: auth.token, HELM_DATA_DIR: dataDir },
        stdout: (text) => { out += text },
        stderr: (text) => { err += text },
        stdin: { isTTY: stdinText === undefined, readAll: async () => stdinText ?? '' },
      })
      return { code, out, err }
    },
    async close() {
      try { await hub.close() } finally {
        try { await app.close() } finally {
          auth.dispose()
          await rm(dataDir, { recursive: true, force: true })
        }
      }
    },
  }
}

test('helm ask 真实回合：回答与持久条目同源，管道内容写入本次输入', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    f.faux.setResponses([fauxAssistantMessage('真实问答结果')])
    const result = await f.ask(['分析以下内容'], '日志片段')
    assert.equal(result.code, 0, result.err)
    const value = JSON.parse(result.out)
    assert.equal(value.answer, '真实问答结果')
    assert.equal(value.deleted, false)
    const detail = await f.app.kernel.getConversationDetail(value.conversationId)
    assert.ok(detail.entries.some((entry) => entry.id === value.entryId), '回答条目来自本次真实会话')
    assert.match(JSON.stringify(detail.entries), /分析以下内容\\n\\n日志片段/)
  } finally { await f.close() }
})

test('helm ask --delete-on-success 真实删除本次会话并保留其他会话', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    const before = f.app.kernel.listConversations().map((conversation) => conversation.id)
    f.faux.setResponses([fauxAssistantMessage('可清理的结果')])
    const result = await f.ask(['提问', '--delete-on-success'])
    assert.equal(result.code, 0, result.err)
    const value = JSON.parse(result.out)
    assert.equal(value.answer, '可清理的结果')
    assert.equal(value.deleted, true)
    assert.ok(!f.app.kernel.listConversations().some((conversation) => conversation.id === value.conversationId))
    assert.deepEqual(f.app.kernel.listConversations().map((conversation) => conversation.id), before)
  } finally { await f.close() }
})

test('helm ask 真实模型失败：退出非零并保留可排查的会话', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    f.faux.setResponses([fauxAssistantMessage('失败', { errorMessage: 'ask integration failure', stopReason: 'error' })])
    const result = await f.ask(['提问', '--delete-on-success'])
    assert.notEqual(result.code, 0)
    assert.equal(result.out, '')
    const error = JSON.parse(result.err).error
    assert.equal(error.code, 'turn_failed')
    const conversationId = error.details.conversationId
    assert.ok(Number.isSafeInteger(conversationId))
    assert.equal(f.app.kernel.getConversation(conversationId).status, 'error')
  } finally { await f.close() }
})
