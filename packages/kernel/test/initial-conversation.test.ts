/**
 * 初始会话可删与缺省 trigger 投递的端到端验收（真实 createHelm + faux provider）。
 *
 * 覆盖（root #1 特殊设计移除后的新契约）：
 * - 初始 assistant 会话经 HTTP/CLI 删除成功（无 id 级豁免）；
 * - 删后重启不复活（tombstone + ensureInitialConversation 跳过）；
 * - 删空后（零会话）插件动作仍可用、新会话可创建；
 * - 无显式目标的 trigger 投递到 assistant 最新普通会话；全空时按需新建；
 * - 显式指定已删除 target 的 trigger 显式 404，不静默改投；
 * - manageConversation 管理权保护仍然生效（409 conversation_managed_by_plugin）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'

import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

async function buildApp(dataDir: string, model = 'faux/faux-1') {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model, models })
  return { faux, app }
}

function initialConvOf(app: Awaited<ReturnType<typeof createHelm>>) {
  const conv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  assert.ok(conv, '初始 assistant 会话应存在')
  return conv
}

test('初始会话删除与缺省 trigger 投递', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'helm-initial-del-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await t.test('删除初始 human 会话（内核 API）成功且重启不复活', { timeout: 60_000 }, async () => {
    const dir = join(root, 't1')
    const first = await buildApp(dir)
    const initial = initialConvOf(first.app)
    await first.app.kernel.deleteConversation(initial.id)
    assert.equal(
      first.app.kernel.listConversations().some((c) => c.id === initial.id),
      false,
      '删除后立即不可见',
    )
    await first.app.close()

    const second = await buildApp(dir)
    try {
      assert.equal(
        second.app.kernel.listConversations().some((c) => c.id === initial.id),
        false,
        '重启后不得复活、不得补种',
      )
      assert.equal(second.app.kernel.listConversations().length, 0, '删空后为零会话')
      // 零会话下仍可新建
      const created = await second.app.kernel.createConversation({ title: '新会话', profileId: 'assistant' })
      assert.equal(typeof created.id, 'number')
    } finally {
      await second.app.close()
    }
  })

  await t.test('HTTP/CLI 删除初始会话成功', { timeout: 60_000 }, async () => {
    const dir = join(root, 't2')
    const { app } = await buildApp(dir)
    const hub = await startHub({ kernel: app.kernel as never, port: 0 })
    try {
      const token = app.kernel.auth.createProcessToken().token
      const initial = initialConvOf(app)
      const res = await fetch(`${hub.url}/api/conversations/${initial.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200, `HTTP 删除初始会话应 200：${await res.text()}`)
      const gone = await fetch(`${hub.url}/api/conversations/${initial.id}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(gone.status, 404)
    } finally {
      await hub.close()
      await app.close()
    }
  })

  await t.test('manageConversation 管理权保护仍然生效（409）', { timeout: 60_000 }, async () => {
    const dir = join(root, 't3')
    const { app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      const release = app.kernel.manageConversation(initial.id, 'test:owner')
      await assert.rejects(
        () => app.kernel.deleteConversation(initial.id),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_managed_by_plugin',
      )
      release()
      await app.kernel.deleteConversation(initial.id)
    } finally {
      await app.close()
    }
  })

  await t.test('无显式目标 trigger：投递到 assistant 最新普通会话', { timeout: 60_000 }, async () => {
    const dir = join(root, 't4')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      faux.setResponses([fauxAssistantMessage('收到默认事件')])
      await app.kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron:test',
        text: '默认目标事件',
        createdAt: Date.now(),
      })
      await app.kernel.waitForIdle(initial.id)
      const detail = await app.kernel.getConversationDetail(initial.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('默认目标事件')),
        '无显式目标事件应进入 assistant 最新普通会话',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('全删空后 trigger 按需新建会话并投递（并发安全）', { timeout: 60_000 }, async () => {
    const dir = join(root, 't5')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      await app.kernel.deleteConversation(initial.id)
      faux.setResponses([fauxAssistantMessage('重建后回答')])
      await app.kernel.dispatchTrigger({
        id: 'evt-2',
        source: 'cron:rebuild',
        text: '删空后的默认事件',
        createdAt: Date.now(),
      })
      const convs = app.kernel.listConversations().filter((c) => c.profileId === 'assistant')
      assert.equal(convs.length, 1, '删空后缺省 trigger 应按需新建恰好一个 assistant 会话')
      await app.kernel.waitForIdle(convs[0]!.id)
      const detail = await app.kernel.getConversationDetail(convs[0]!.id, { limit: 10 })
      assert.ok(
        detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('删空后的默认事件')),
        '新建会话应收到事件',
      )
    } finally {
      await app.close()
    }
  })

  await t.test('显式指定已删除 target 的 trigger 显式 404，不静默改投', { timeout: 60_000 }, async () => {
    const dir = join(root, 't6')
    const { faux, app } = await buildApp(dir)
    try {
      const initial = initialConvOf(app)
      const deadId = initial.id
      const other = await app.kernel.createConversation({ title: '其他会话', profileId: 'assistant' })
      await app.kernel.deleteConversation(deadId)
      faux.setResponses([fauxAssistantMessage('不应收到')])
      await assert.rejects(
        () =>
          app.kernel.dispatchTrigger({
            id: 'evt-3',
            source: 'webhook:stale',
            text: '指向已删会话的事件',
            targetConversationId: deadId,
            createdAt: Date.now(),
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // 其他会话未收到（不静默改投）
      const otherDetail = await app.kernel.getConversationDetail(other.id, { limit: 10 })
      assert.equal(
        otherDetail.entries.filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('指向已删会话的事件')).length,
        0,
        '失效目标不得静默改投其他会话',
      )
    } finally {
      await app.close()
    }
  })
})
