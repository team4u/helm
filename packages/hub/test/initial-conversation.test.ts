/**
 * 初始会话可删除与缺省触发器投递端到端验证（真实 createHelmx + faux provider）。
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError } from '@helmx/protocol'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHubTestApp, openHubHttpEnv, useTempDir, type HubTestApp } from './helpers/hub-test-env.js'

function initialConvOf(app: HubTestApp) {
  const conv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  assert.ok(conv, '初始 assistant 会话应存在')
  return conv
}

test('删除初始人类会话成功且重启不复活，零会话下仍可新建', { timeout: 60_000 }, async (t) => {
  const dir = join(useTempDir(t, 'helmx-initial-del-'), 'restart')
  const first = await createHubTestApp({ dataDir: dir, cwd: dir })
  const initial = initialConvOf(first.app)
  try {
    await first.kernel.deleteConversation(initial.id)
    assert.equal(first.kernel.listConversations().some((c) => c.id === initial.id), false)
  } finally {
    await first.app.close()
  }

  const second = await createHubTestApp({ dataDir: dir, cwd: dir })
  try {
    assert.equal(second.kernel.listConversations().some((c) => c.id === initial.id), false, '重启后不复活、不补种')
    assert.equal(second.kernel.listConversations().length, 0)
    const created = await second.kernel.createConversation({ title: 'new conversation', profileId: 'assistant' })
    assert.equal(typeof created.id, 'number')
  } finally {
    await second.app.close()
  }
})

test('HTTP 删除、受管保护与触发器路由契约（无显式目标投递 / 全删空按需新建 / 失效显式目标 404 不静默改投）', { timeout: 60_000 }, async () => {
  const env = await openHubHttpEnv({ prefix: 'helmx-initial-http-' })
  try {
    const initial = initialConvOf(env.app)

    // 1. manageConversation 保护生效（409），释放后允许后续删除
    const release = env.kernel.manageConversation(initial.id, 'test:owner')
    await assert.rejects(
      () => env.kernel.deleteConversation(initial.id),
      (err: unknown) => err instanceof HelmxError && err.code === 'conversation_managed_by_plugin',
    )
    release()

    // 2. 无显式目标触发器投递到 assistant 最新普通会话
    env.faux.setResponses([fauxAssistantMessage('receives by default event')])
    await env.kernel.dispatchTrigger({
      id: 'evt-1',
      source: 'cron:test',
      text: 'by default target event',
      createdAt: Date.now(),
    })
    await env.kernel.waitForIdle(initial.id)
    const detail1 = await env.kernel.getConversationDetail(initial.id, { limit: 10 })
    assert.ok(
      detail1.entries.some((e) => e.kind === 'helmx.input' && JSON.stringify(e.data).includes('by default target event')),
    )

    // 3. HTTP 删除初始会话成功（无 ID 级删除豁免），二次读取 404
    const del = await env.call('DELETE', `/api/conversations/${initial.id}`)
    assert.equal(del.status, 200)
    const gone = await env.call('GET', `/api/conversations/${initial.id}`)
    assert.equal(gone.status, 404)

    // 4. 全部删空后触发器按需新建唯一 assistant 会话并投递
    env.faux.setResponses([fauxAssistantMessage('rebuild after answer')])
    await env.kernel.dispatchTrigger({
      id: 'evt-2',
      source: 'cron:rebuild',
      text: 'delete empty after by default event',
      createdAt: Date.now(),
    })
    const convs = env.kernel.listConversations().filter((c) => c.profileId === 'assistant')
    assert.equal(convs.length, 1)
    const rebuiltId = convs[0]!.id
    await env.kernel.waitForIdle(rebuiltId)
    const detail2 = await env.kernel.getConversationDetail(rebuiltId, { limit: 10 })
    assert.ok(
      detail2.entries.some((e) => e.kind === 'helmx.input' && JSON.stringify(e.data).includes('delete empty after by default event')),
    )

    // 5. 显式指定已删目标的触发器显式 404，绝不静默改投其他会话
    const other = await env.kernel.createConversation({ title: 'other conversation', profileId: 'assistant' })
    await env.kernel.deleteConversation(rebuiltId)
    env.faux.setResponses([fauxAssistantMessage('must not receives')])
    await assert.rejects(
      () =>
        env.kernel.dispatchTrigger({
          id: 'evt-3',
          source: 'webhook:stale',
          text: 'points to already delete conversation event',
          targetConversationId: rebuiltId,
          createdAt: Date.now(),
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
    )
    const otherDetail = await env.kernel.getConversationDetail(other.id, { limit: 10 })
    assert.equal(
      otherDetail.entries.filter((e) => e.kind === 'helmx.input' && JSON.stringify(e.data).includes('points to already delete conversation event')).length,
      0,
    )
  } finally {
    await env.close()
  }
})
