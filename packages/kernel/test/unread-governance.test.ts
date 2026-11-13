/**
 * 会话未读治理集成测试：回合结算 unread 策略区分人类与背景派生子会话。
 *
 * 契约（emitSettled）：
 * - 顶层 human 直连会话 completed -> unread=true / status=done（既有语义不变）；
 * - 背景派生子会话（ownedBy=helm/bot 且 parentConversationId 存在，如受管
 *   subagent / SuperAgent Worker）completed -> unread=false / status=idle，
 *   不制造人类未读噪音；完成状态与 turn_settled 事件语义一致；
 * - 人类 fork（有父链但 human 归属）completed -> unread=true（不一刀切）；
 * - failed -> unread=false / status=error；aborted -> unread=false / status=idle
 *   （失败/中止契约锁定）。
 *
 * 全部真实执行：真 pi-durable SDK + SQLite + faux provider + 真原生 spawn 管道。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, TurnSettledPayload } from '@helm/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
  return Object.assign(runtime, { __faux: faux })
}

/** 注册 turn_settled 采集插件，返回（按结算序）载荷数组。 */
async function collectSettled(kernel: KernelRuntime): Promise<TurnSettledPayload[]> {
  const settled: TurnSettledPayload[] = []
  await kernel.plugins.register({
    id: 'test:settled-collector',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        settled.push(payload)
      })
    },
  })
  return settled
}

let root: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-unread-governance-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('回合结算 unread 治理', { timeout: 60_000 }, () => {
  it('顶层 human 会话 completed：unread=true / done（既有语义不变）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('顶层回答')])
      await kernel.submitInput(1, '顶层问题')
      await kernel.waitForIdle(1)
      const conv = kernel.getConversation(1)
      assert.equal(conv.unread, true)
      assert.equal(conv.status, 'done')
      assert.equal(conv.completionSeq, 1)
    } finally {
      await kernel.close()
    }
  })

  it('自动子代理 completed：unread=false / idle，状态与事件一致；列表过滤维度生效', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      const settled = await collectSettled(kernel)
      kernel.__faux.setResponses([fauxAssistantMessage('子代理回答')])
      const result = await kernel.spawnAgent({ parentConversationId: 1, prompt: '子任务' })
      assert.ok(result !== undefined)
      const child = kernel
        .listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, '原生 spawn 应创建子会话')
      await kernel.waitForIdle(child.id)

      const fresh = kernel.getConversation(child.id) as ConversationSummary & { ownedBy?: string }
      assert.equal(fresh.ownedBy, 'helm', '原生子代理归属 helm')
      assert.equal(fresh.parentConversationId, 1)
      assert.equal(fresh.unread, false, '背景子代理完成不得制造人类未读')
      assert.equal(fresh.status, 'idle', 'unread=false 时完成状态应为 idle（与 unread 语义一致）')
      assert.equal(fresh.completionSeq, 1, '完成水位照常推进')

      // 事件语义一致：turn_settled 载荷的会话终态与读取接口同源。
      const childSettled = settled.find((p) => p.conversation.id === child.id)
      assert.ok(childSettled, '子代理回合应恰结算一次')
      assert.equal(childSettled.outcome, 'completed')
      assert.equal(childSettled.conversation.unread, false)
      assert.equal(childSettled.conversation.status, 'idle')

      // 父会话未被波及（本回合未运行）：仍无未读。
      const parent = kernel.getConversation(1)
      assert.equal(parent.unread, false)

      // 进程内列表过滤维度（HTTP 降噪的服务端实现）：
      assert.ok(kernel.listConversations().some((c) => c.id === child.id), '进程内无过滤缺省仍全量')
      assert.ok(
        kernel.listConversations({ topLevelOnly: true }).every((c) => c.parentConversationId === undefined),
        'topLevelOnly 应排除子会话',
      )
      assert.deepEqual(
        kernel.listConversations({ parentConversationId: 1 }).map((c) => c.id),
        [child.id],
        'parentConversationId 精确匹配直接子会话',
      )
    } finally {
      await kernel.close()
    }
  })

  it('人类 fork（有父链、human 归属）completed：unread=true（不一刀切）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('原会话回答'),
        fauxAssistantMessage('分叉后回答'),
      ])
      await kernel.submitInput(1, '原会话问题')
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const entryId = Number(detail.entries[0]!.id)
      const forked = await kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork 有父链')

      await kernel.submitInput(forked.id, '分叉后问题')
      await kernel.waitForIdle(forked.id)
      const fresh = kernel.getConversation(forked.id) as ConversationSummary & { ownedBy?: string }
      assert.notEqual(fresh.ownedBy, 'helm')
      assert.notEqual(fresh.ownedBy, 'bot')
      assert.equal(fresh.unread, true, '人类 fork 完成仍标记未读')
      assert.equal(fresh.status, 'done')
    } finally {
      await kernel.close()
    }
  })

  it('失败契约：failed -> unread=false / error', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, '触发失败')
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'error')
      assert.equal(conv.unread, false, '失败回合不置未读')
    } finally {
      await kernel.close()
    }
  })

  it('中止契约：aborted -> unread=false / idle', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('不该需要第二答'),
      ])
      void kernel.submitInput(1, '会被中止的问题').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'idle')
      assert.equal(conv.unread, false, '中止回合不置未读')
    } finally {
      await kernel.close()
    }
  })
})
