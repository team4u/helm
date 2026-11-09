/**
 * herdr AskCoordinator.seqResolver + 真实 AskService 重试 ID 契约测试：
 * 修复回归——parseAskId 曾因 lastIndexOf(':') 把 ':r1' 吞进 seq 段再用
 * 可选后缀 regex 匹配，导致重开后的 askId 永远解析失败（resolver 不命中，
 * 真实 AskService 以 ask_state_unavailable 拒答）。
 *
 * 验证链路（全部真实组件，不 FakeBackend）：
 * - AskCoordinator（真 parseAskId/条目归属校验）
 *   -> registerSeqResolver（真实 AskService.registerSeqResolver）
 *   -> AskService.answerAsk（真实 CAS 路径）；
 * - 重开 :r1 后成功回答（resolver 命中返回当前真实水位 -> answered）；
 * - 旧 askId（无后缀原 ID）不再命中当前条目（attempt 已推进）；
 * - 非规范伪造 ID（r01/r0/超大 seq/未知 pane）解析失败 -> resolver 返回
 *   undefined -> AskService ask_state_unavailable（绝不装作校验通过）。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
 */

import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { SecretStash } from '../src/services/index.js'
import { AskCoordinator } from '../src/builtin-plugins/herdr/asks.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-askseq-retry-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

interface Ctx {
  service: AskService
  coordinator: AskCoordinator
  store: HelmStore
  close(): Promise<void>
}

async function openCtx(): Promise<Ctx> {
  const db = await openHelmDatabase(join(rootDir, `a-${Math.random().toString(36).slice(2)}`))
  const store = new HelmStore(db)
  await store.load()
  const stash = new SecretStash()
  const service = new AskService({
    store,
    stash,
    onEvent: () => {},
    onConvPendingChanged: () => {},
    validateConversation: () => true,
  })
  const coordinator = new AskCoordinator(() => {})
  // 权威水位：模拟远端 agent.get 现查（可推进）。
  const state = { seq: 10 }
  service.registerSeqResolver((askId) =>
    coordinator.seqResolver(askId, async () => state.seq),
  )
  return {
    service,
    coordinator,
    store,
    async close() {
      await store.close()
      await db.close()
    },
  }
}

/** 登记条目并置为已发键（重开前置条件），返回当前 askId。 */
function blockedEntrySent(coordinator: AskCoordinator, paneId = 'w1:p2', seq = 10): string {
  const begin = coordinator.beginBlocked(undefined, paneId, seq)
  assert.ok('owner' in begin)
  coordinator.markPending(begin.owner)
  coordinator.settle(begin.owner, { keysSent: true, sentKeys: ['y'] })
  return begin.owner.askId
}

function specOf(id: string) {
  return {
    id,
    conversationId: 1,
    ownerPluginId: 'builtin:herdr',
    title: '终端确认',
    fields: [{ name: 'decision', label: '选择', type: 'select' as const, required: true, options: [{ label: 'y', value: 'allow-y' }] }],
    expectedStateSeq: 10,
  }
}

/** 创建 pending ask 并等待入库（不 await 终态）。 */
async function createPending(service: AskService, id: string): Promise<void> {
  void service.createAsk(specOf(id)).catch(() => {})
  for (let i = 0; i < 100; i += 1) {
    if (service.getAsk(id)?.status === 'pending') return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`ask ${id} 未入库`)
}

describe('seqResolver 重试 ID：coordinator + 真实 AskService', () => {
  it('重开 :r1 后成功回答；旧无后缀 askId 不再可用', { timeout: 60_000 }, async () => {
    const ctx = await openCtx()
    try {
      const firstId = blockedEntrySent(ctx.coordinator)
      assert.equal(firstId, 'herdr:local:w1:p2:10')
      await createPending(ctx.service, firstId)

      // 重开：askId 变为 <key>:r1，旧结算通道清理。
      const reopened = ctx.coordinator.reopenUnresolved(undefined, 'w1:p2', 10)
      assert.ok(reopened !== undefined)
      const retryId = reopened.askId
      assert.equal(retryId, 'herdr:local:w1:p2:10:r1')
      await createPending(ctx.service, retryId)

      // 旧 askId 先结算取消（真实路径），再以重开 ID 回答：resolver 经
      // parseAskId 命中条目并返回当前权威水位（10 未推进）-> answered。
      await ctx.service.cancelAsk(firstId, 'superseded')
      const settled = await ctx.service.answerAsk(retryId, { decision: 'allow-y' })
      assert.equal(settled.status, 'answered', '重开 :r1 的回答经真实 resolver 路径成功')
      const row = ctx.store.getAsk(retryId)
      assert.ok(row !== undefined && row.status === 'answered')
      assert.ok(row!.resultJson !== undefined && row!.resultJson!.includes('allow-y'), '答案持久化')

      // 旧 ID 已被结算，重复回答显式 409。
      await assert.rejects(
        ctx.service.answerAsk(firstId, { decision: 'allow-y' }),
        (e: unknown) => e instanceof HelmError && e.code === 'ask_already_settled',
      )
    } finally {
      await ctx.close()
    }
  })

  it('伪造/非规范 askId 不命中 resolver -> ask_state_unavailable（不装作校验通过）', { timeout: 60_000 }, async () => {
    const ctx = await openCtx()
    try {
      const firstId = blockedEntrySent(ctx.coordinator)
      await createPending(ctx.service, firstId)
      // 非规范形状：r01（前导零）/ r0（零）/ 尾段非纯数字。
      for (const badId of [
        'herdr:local:w1:p2:10:r01',
        'herdr:local:w1:p2:10:r0',
        'herdr:local:w1:p2:r1',
        'herdr:local:w1:p2:9999999999999999999999',
      ]) {
        // 条目归属校验：非当前条目 ID 一律 undefined。
        const resolved = await ctx.coordinator.seqResolver(badId, async () => 10)
        assert.equal(resolved, undefined, `${badId} 不命中`)
      }
      // 带 expectedStateSeq 的伪造 ask：resolver 无命中 -> 显式拒绝。
      await createPending(ctx.service, 'herdr:local:w1:p2:11')
      await assert.rejects(
        ctx.service.answerAsk('herdr:local:w1:p2:11', { decision: 'allow-y' }),
        (e: unknown) => e instanceof HelmError && e.code === 'ask_state_unavailable',
      )
    } finally {
      await ctx.close()
    }
  })

  it('paneId 自带冒号照常解析；未知 paneId 不命中', { timeout: 60_000 }, async () => {
    const ctx = await openCtx()
    try {
      const id = blockedEntrySent(ctx.coordinator, 'wR:p2', 3916)
      assert.equal(id, 'herdr:local:wR:p2:3916')
      const hit = await ctx.coordinator.seqResolver('herdr:local:wR:p2:3916', async (nodeId, paneId) => {
        assert.equal(nodeId, undefined)
        assert.equal(paneId, 'wR:p2')
        return 3916
      })
      assert.equal(hit, 3916, 'paneId 含冒号正常解析')
      const retry = await ctx.coordinator.seqResolver('herdr:local:wR:p2:3916:r2', async () => 3916)
      assert.equal(retry, undefined, '重试后缀不匹配当前 attempt（0）时不命中')
      const miss = await ctx.coordinator.seqResolver('herdr:local:other:1', async () => 1)
      assert.equal(miss, undefined, '未知 pane 不命中')
    } finally {
      await ctx.close()
    }
  })
})
