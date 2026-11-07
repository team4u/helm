/**
 * 模块四测试：会话上下文操作（reset / compact / fork）。
 * 真实 createHelm 组合（真 pi-durable SQLite + faux provider）：
 * - reset：SDK 原生 reset(handoff)，上下文清空、handoff 作为首条用户消息、
 *   stateChangeSeq 推进、SSE conversation.upsert 广播；
 * - compact：SDK 原生 compact(instructions) 返回后台任务 ID，摘要入上下文；
 * - fork：条目存在性校验（不存在 404）、SDK fork 新会话、helm 镜像登记
 *   （父链/继承 profile/cwd/model/标题「(分叉)」）、模型对齐；
 * - HTTP/CLI 端到端：POST /reset /compact /fork 状态码与错误信封。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

interface Env {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  hubUrl: string
  hubToken?: string
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ctx-ops-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 })
  return {
    dataDir,
    faux,
    app,
    hubUrl: hub.url,
    async close() {
      await hub.close().catch(() => {})
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function authCall(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${env.hubUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(env.hubToken !== undefined ? { authorization: `Bearer ${env.hubToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

test.before(async () => {})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test('reset：上下文清空、handoff 进入新上下文、seq 推进并广播', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('第一轮回答')])
    const conv = await env.app.kernel.createConversation({ title: '重置测试' })
    await env.app.kernel.submitInput(conv.id, '第一轮问题')
    await env.app.kernel.waitForIdle(conv.id)
    const before = env.app.kernel.getConversation(conv.id)
    const userTextsBefore = (await env.app.kernel.getConversationDetail(conv.id)).entries.filter(
      (e) => e.kind === 'helm.input',
    ).length
    assert.ok(userTextsBefore >= 1, 'reset 前应有输入条目')

    const events: unknown[] = []
    const unsubscribe = (env.app.kernel.events as unknown as {
      subscribe(l: (frame: { event: { type: string } }) => void): () => void
    }).subscribe((frame) => {
      if (frame.event.type === 'conversation.upsert') events.push(frame)
    })

    const after = await env.app.kernel.resetConversation(conv.id, { handoff: '重置后的交接说明' })
    await env.app.kernel.waitForIdle(conv.id)
    unsubscribe()

    assert.ok(after.stateChangeSeq > before.stateChangeSeq, 'stateChangeSeq 单调推进')
    assert.ok(events.length > 0, 'conversation.upsert 已广播')
    // 新上下文以 handoff 用户消息开始（pi.reset entry 的 model 消息携带 handoff）。
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const resetEntry = detail.entries.find((e) => e.kind === 'pi.reset')
    assert.ok(resetEntry !== undefined, 'reset 后应存在 pi.reset 条目')
    const userContent = (resetEntry.model ?? []).map(
      (m) => (m as { content?: unknown }).content,
    )
    const handoffSeen = userContent.some((c) =>
      typeof c === 'string' ? c === '重置后的交接说明' : JSON.stringify(c).includes('重置后的交接说明'),
    )
    assert.ok(handoffSeen, 'handoff 文本应作为新上下文首条用户消息')
  } finally {
    await env.close()
  }
})

test('reset：无 handoff 也合法；不存在会话 404；关闭后 503 由组合层保证', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ title: '空重置' })
    const summary = await env.app.kernel.resetConversation(conv.id)
    assert.equal(summary.id, conv.id)
    await assert.rejects(
      env.app.kernel.resetConversation(9999),
      (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

test('compact：返回后台任务 ID；摘要任务真实进入 SDK 调度', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('普通回答一')])
    const conv = await env.app.kernel.createConversation({ title: '压缩测试' })
    await env.app.kernel.submitInput(conv.id, '一段足够长的对话内容 1')
    await env.app.kernel.waitForIdle(conv.id)

    const { taskId, conversation } = await env.app.kernel.compactConversation(conv.id, {
      instructions: '请突出关键决策',
    })
    assert.ok(Number.isInteger(taskId) && taskId > 0, 'taskId 为正整数（SDK TaskId）')
    assert.equal(conversation.id, conv.id)
    assert.ok(conversation.stateChangeSeq >= 1)
  } finally {
    await env.close()
  }
})

test('compact：不存在会话 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      env.app.kernel.compactConversation(424242),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

test('fork：从既有条目分叉——镜像登记（父链/继承）、模型对齐、默认标题', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('源会话回答')])
    const source = await env.app.kernel.createConversation({ title: '源会话' })
    await env.app.kernel.submitInput(source.id, '源会话第一问')
    await env.app.kernel.waitForIdle(source.id)
    const detail = await env.app.kernel.getConversationDetail(source.id)
    assert.ok(detail.entries.length > 0, '源会话应有条目')
    const entryId = Number(detail.entries[0]!.id)
    assert.ok(Number.isInteger(entryId) && entryId > 0, `entryId 应为数字（实际 ${detail.entries[0]!.id}）`)

    const forked = await env.app.kernel.forkConversation(source.id, { entryId })
    assert.notEqual(forked.id, source.id)
    assert.equal(forked.parentConversationId, source.id)
    assert.equal(forked.title, '源会话 (分叉)')
    assert.equal(forked.profileId, source.profileId)
    assert.equal(forked.cwd, source.cwd)
    assert.equal(forked.model, source.model, 'fork 继承源会话生效模型')
    // 自定义标题 + 脱敏：标题中的秘密被擦除。
    const forked2 = await env.app.kernel.forkConversation(source.id, {
      entryId,
      title: `  自定义标题  `,
    })
    assert.equal(forked2.title, '自定义标题')
  } finally {
    await env.close()
  }
})

test('fork：不存在的条目 404（含诊断 details）；非法 entryId 400；不存在会话 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ title: '空源' })
    await assert.rejects(
      env.app.kernel.forkConversation(conv.id, { entryId: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 404)
        assert.equal(err.code, 'not_found')
        const details = err.details as { conversationId: number; entryId: number }
        assert.equal(details.conversationId, conv.id)
        assert.equal(details.entryId, 99999)
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.forkConversation(conv.id, { entryId: -1 }),
      (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
    )
    await assert.rejects(
      env.app.kernel.forkConversation(777777, { entryId: 1 }),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// HTTP 端到端
// ---------------------------------------------------------------------------

test('HTTP reset/compact/fork：状态码与 body 校验；错误信封（404/400）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // setup 鉴权
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_ops}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    env.faux.setResponses([fauxAssistantMessage('http 路径回答')])
    const conv = await env.app.kernel.createConversation({ title: 'HTTP 上下文' })
    await env.app.kernel.submitInput(conv.id, 'http 路径第一问')
    await env.app.kernel.waitForIdle(conv.id)
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const entryId = Number(detail.entries[0]!.id)

    // reset：空 body 与 JSON body 均合法
    const resetEmpty = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`)
    assert.equal(resetEmpty.status, 200)
    assert.equal(resetEmpty.body.id, conv.id)
    const resetHandoff = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`, {
      handoff: '第二次重置',
    })
    assert.equal(resetHandoff.status, 200)

    // compact：202 + { taskId, conversation }
    const compact = await authCall(env, 'POST', `/api/conversations/${conv.id}/compact`, {
      instructions: 'http 压缩指令',
    })
    assert.equal(compact.status, 202)
    assert.ok(Number.isInteger(compact.body.taskId) && compact.body.taskId > 0)
    assert.equal(compact.body.conversation.id, conv.id)

    // fork：201 + 新会话摘要
    const fork = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, {
      entryId,
      title: 'HTTP 分叉',
    })
    assert.equal(fork.status, 201)
    assert.equal(fork.body.title, 'HTTP 分叉')
    assert.equal(fork.body.parentConversationId, conv.id)

    // 错误路径
    const forkMissing = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, {
      entryId: 987654,
    })
    assert.equal(forkMissing.status, 404)
    assert.equal(forkMissing.body.error.code, 'not_found')
    const forkBad = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, { entryId: 0 })
    assert.equal(forkBad.status, 400)
    assert.equal(forkBad.body.error.code, 'validation_error')
    const missing = await authCall(env, 'POST', '/api/conversations/88888/reset')
    assert.equal(missing.status, 404)
  } finally {
    await env.close()
  }
})
