/** 单次问答真实 CLI → HTTP → SDK 回合契约（共享单实例 createHelm + startHub）。 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { runCli } from '../../cli/src/index.js'
import { openHubHttpEnv, type HubHttpTestEnv } from './helpers/hub-test-env.js'

let env: HubHttpTestEnv

before(async () => {
  env = await openHubHttpEnv({ prefix: 'helm-cli-ask-' })
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

async function ask(args: string[], stdinText?: string) {
  let out = ''
  let err = ''
  const code = await runCli(['ask', ...args, '--json'], {
    env: { HELM_HUB_URL: env.hubUrl, HELM_TOKEN: env.token, HELM_DATA_DIR: env.dataDir },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    stdin: { isTTY: stdinText === undefined, readAll: async () => stdinText ?? '' },
  })
  return { code, out, err }
}

test('helm ask 真实回合：回答与持久条目同源，管道内容写入本次输入', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('real question answer result')])
  const result = await ask(['analyze or fewer content'], 'log fragment')
  assert.equal(result.code, 0, result.err)
  const value = JSON.parse(result.out)
  assert.equal(value.answer, 'real question answer result')
  assert.equal(value.deleted, false)
  const detail = await env.kernel.getConversationDetail(value.conversationId)
  assert.ok(detail.entries.some((entry) => entry.id === value.entryId))
  assert.match(JSON.stringify(detail.entries), /analyze or fewer content\\n\\nlog fragment/)
})

test('helm ask --delete-on-success 真实删除本次会话并保留其他会话', { timeout: 60_000 }, async () => {
  const beforeIds = env.kernel.listConversations().map((conversation) => conversation.id)
  env.faux.setResponses([fauxAssistantMessage('can clean up result')])
  const result = await ask(['mention question', '--delete-on-success'])
  assert.equal(result.code, 0, result.err)
  const value = JSON.parse(result.out)
  assert.equal(value.answer, 'can clean up result')
  assert.equal(value.deleted, true)
  assert.ok(!env.kernel.listConversations().some((conversation) => conversation.id === value.conversationId))
  assert.deepEqual(env.kernel.listConversations().map((conversation) => conversation.id), beforeIds)
})

test('helm ask 真实模型失败：非零退出并保留可排查会话', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('failed', { errorMessage: 'ask integration failure', stopReason: 'error' })])
  const result = await ask(['mention question', '--delete-on-success'])
  assert.notEqual(result.code, 0)
  assert.equal(result.out, '')
  const error = JSON.parse(result.err).error
  assert.equal(error.code, 'turn_failed')
  const conversationId = error.details.conversationId
  assert.ok(Number.isSafeInteger(conversationId))
  assert.equal(env.kernel.getConversation(conversationId).status, 'error')
})
