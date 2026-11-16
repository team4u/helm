/** single time question answer real CLI → HTTP → SDK turn contract, model use official faux provider. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { runCli } from '../../cli/src/index.js'
import { startHub } from '../../kernel/src/http/index.js'
import { createHubTestApp } from './helpers/hub-test-env.js'

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-cli-ask-'))
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir })
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

test('helm ask real turn: answer and durable item same source, pipeline content write this time input', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    f.faux.setResponses([fauxAssistantMessage('real question answer result')])
    const result = await f.ask(['analyze or fewer content'], 'log fragment')
    assert.equal(result.code, 0, result.err)
    const value = JSON.parse(result.out)
    assert.equal(value.answer, 'real question answer result')
    assert.equal(value.deleted, false)
    const detail = await f.app.kernel.getConversationDetail(value.conversationId)
    assert.ok(detail.entries.some((entry) => entry.id === value.entryId), 'answer item from this time real conversation')
    assert.match(JSON.stringify(detail.entries), /analyze or fewer content\\n\\nlog fragment/)
  } finally { await f.close() }
})

test('helm ask --delete-on-success real delete this time conversation and keep other conversation', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    const before = f.app.kernel.listConversations().map((conversation) => conversation.id)
    f.faux.setResponses([fauxAssistantMessage('can clean up result')])
    const result = await f.ask(['mention question', '--delete-on-success'])
    assert.equal(result.code, 0, result.err)
    const value = JSON.parse(result.out)
    assert.equal(value.answer, 'can clean up result')
    assert.equal(value.deleted, true)
    assert.ok(!f.app.kernel.listConversations().some((conversation) => conversation.id === value.conversationId))
    assert.deepEqual(f.app.kernel.listConversations().map((conversation) => conversation.id), before)
  } finally { await f.close() }
})

test('helm ask real model failed: exit non-zero and keep can troubleshoot conversation', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    f.faux.setResponses([fauxAssistantMessage('failed', { errorMessage: 'ask integration failure', stopReason: 'error' })])
    const result = await f.ask(['mention question', '--delete-on-success'])
    assert.notEqual(result.code, 0)
    assert.equal(result.out, '')
    const error = JSON.parse(result.err).error
    assert.equal(error.code, 'turn_failed')
    const conversationId = error.details.conversationId
    assert.ok(Number.isSafeInteger(conversationId))
    assert.equal(f.app.kernel.getConversation(conversationId).status, 'error')
  } finally { await f.close() }
})
