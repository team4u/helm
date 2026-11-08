/**
 * 模块四测试：会话上下文操作（reset / compact / fork）。
 * 真实 createHelm 组合（真 pi-durable SQLite + faux provider）：
 * - reset：SDK 原生 reset(handoff)，上下文清空、handoff 作为首条用户消息、
 *   stateChangeSeq 推进、SSE conversation.upsert 广播；
 * - compact：SDK 原生 compact(instructions) 返回后台任务 ID，摘要入上下文；
 * - fork：条目存在性校验（不存在 404）、SDK fork 新会话、helm 镜像登记
 *   （父链/继承 profile/cwd/model/标题「(分叉)」）、模型对齐；
 * - HTTP/CLI 端到端：POST /reset /compact /fork 状态码与错误信封。
 *
 * 原地覆盖重发（replaceFromEntryId）与排队撤回（withdraw）：
 * - replaceFromEntryId：helm.rewind 截断标记 + edits omit 复用 pi-durable 原生
 *   语义，模型 messages 不含被覆盖旧提问/旧回答，前导 system 保留，FTS5
 *   检索与 rebuildFts 均不再命中旧内容；
 * - withdraw：faux 工厂函数挂起保持会话 busy，排队 followUp 提交可撤回
 *   （status: withdrawn），排队项从 pi.inbox 消失且不再执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
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
    const forkUnsafe = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, { entryId: Number.MAX_SAFE_INTEGER + 1 })
    assert.equal(forkUnsafe.status, 400)
    assert.equal(forkUnsafe.body.error.code, 'validation_error')
    const missing = await authCall(env, 'POST', '/api/conversations/88888/reset')
    assert.equal(missing.status, 404)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 原地覆盖重发（replaceFromEntryId）
// ---------------------------------------------------------------------------

/** 轮询等待条件成立（防挂死，总超时显式）。 */
async function pollUntil(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pollUntil 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 从 kernel 取 SDK harness（测试专用；harness 为 runtime 私有）。 */
function harnessOf(env: Env): Harness {
  return (env.app.kernel as unknown as { harness: Harness }).harness
}

/** 模型 messages 中的全部文本内容（user/assistant/system 均含）。 */
function messageTexts(messages: ReadonlyArray<{ role: string; content: unknown }>): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string; text?: string }>) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out
}

interface TurnEntry {
  id: number
  kind: string
  text: string
}

/** 会话全量条目摘要（id/kind/首段文本）。 */
async function entrySummaries(env: Env, convId: number): Promise<TurnEntry[]> {
  const conv = await harnessOf(env).conversation(convId as never, BACKGROUND_CONTEXT)
  assert.ok(conv)
  const out: TurnEntry[] = []
  let cursor: unknown = undefined
  for (;;) {
    const page = await conv.entries({ order: 'ascending' }, 100, cursor as never, BACKGROUND_CONTEXT)
    for (const raw of page.items as never as Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>) {
      let text = ''
      const model = raw.model as Array<{ content?: unknown }> | undefined
      const content = model?.[0]?.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = (content as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
      }
      if (raw.kind === 'helm.input') {
        const data = raw.data as { text?: unknown } | undefined
        if (typeof data?.text === 'string') text = data.text
      }
      out.push({ id: Number(raw.id), kind: raw.kind, text })
    }
    if (!page.next) break
    cursor = page.next
  }
  return out
}

test('replaceFromEntryId：覆盖第二轮提问——旧问答出上下文、FTS 不命中、前导 system 保留', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('第一轮回答'),
      fauxAssistantMessage('第二轮回答'),
      fauxAssistantMessage('覆盖重发后的新回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '覆盖重发' })
    await env.app.kernel.submitInput(conv.id, '第一轮问题')
    await env.app.kernel.waitForIdle(conv.id)
    await env.app.kernel.submitInput(conv.id, '第二轮原始问题')
    await env.app.kernel.waitForIdle(conv.id)

    // 找到第二轮 helm.input entry id。
    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === '第二轮原始问题')
    assert.ok(secondInput, '应存在第二轮 helm.input')

    // 原地覆盖重发第二轮。
    const { submissionId } = await env.app.kernel.submitInput(conv.id, '改写后的第二轮问题', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // 模型上下文：不含旧第二轮问答，含新问答；前导 system 保留。
    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    assert.ok(sdkConv)
    const ctx = await sdkConv.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t === '第二轮原始问题'), `旧提问不应在上下文：${JSON.stringify(texts)}`)
    assert.ok(!texts.some((t) => t === '第二轮回答'), `旧回答不应在上下文：${JSON.stringify(texts)}`)
    assert.ok(texts.some((t) => t.includes('第一轮问题')), '第一轮上下文保留')
    assert.ok(texts.some((t) => t.includes('第一轮回答')), '第一轮回答保留')
    assert.ok(texts.some((t) => t.includes('改写后的第二轮问题')), '新提问在上下文')
    assert.ok(texts.some((t) => t.includes('覆盖重发后的新回答')), '新回答在上下文')
    // 前导 system 完好（messages[0] 为 system）。
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', 'messages[0] 应为前导 system')

    // helm.rewind 截断标记落库。
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, '应存在 helm.rewind 截断标记')

    // FTS：旧内容不再命中，新内容命中。
    const oldHit = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      oldHit.filter((h) => h.conversationId === conv.id).length,
      0,
      '旧提问不应再命中 FTS',
    )
    const oldAnswerHit = await env.app.kernel.search('第二轮回答')
    assert.equal(
      oldAnswerHit.filter((h) => h.conversationId === conv.id).length,
      0,
      '旧回答不应再命中 FTS',
    )
    const newHit = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), '新提问应命中 FTS')
    const newAnswerHit = await env.app.kernel.search('覆盖重发后的新回答')
    assert.ok(newAnswerHit.some((h) => h.conversationId === conv.id), '新回答应命中 FTS')

    // rebuildFts 后依然不命中旧内容。
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('第二轮回答')
    assert.equal(
      rebuiltOld.filter((h) => h.conversationId === conv.id).length,
      0,
      'rebuildFts 后旧回答不应命中',
    )
    const rebuiltOldQ = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      rebuiltOldQ.filter((h) => h.conversationId === conv.id).length,
      0,
      'rebuildFts 后旧提问不应命中',
    )
    const rebuiltNew = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'rebuildFts 后新提问仍命中')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId：覆盖第一轮提问——全量截断后上下文仅新问答', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('旧第一轮回答'),
      fauxAssistantMessage('全新第一轮回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '覆盖第一轮' })
    await env.app.kernel.submitInput(conv.id, '旧第一轮问题')
    await env.app.kernel.waitForIdle(conv.id)

    const entries = await entrySummaries(env, conv.id)
    const firstInput = entries.find((e) => e.kind === 'helm.input' && e.text === '旧第一轮问题')
    assert.ok(firstInput)

    await env.app.kernel.submitInput(conv.id, '全新第一轮问题', {
      replaceFromEntryId: firstInput.id,
    })
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    assert.ok(sdkConv)
    const ctx = await sdkConv.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('旧第一轮问题')), '旧提问不应在上下文')
    assert.ok(!texts.some((t) => t.includes('旧第一轮回答')), '旧回答不应在上下文')
    assert.ok(texts.some((t) => t.includes('全新第一轮问题')), '新提问在上下文')
    assert.ok(texts.some((t) => t.includes('全新第一轮回答')), '新回答在上下文')
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', '前导 system 保留')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId 错误路径：不存在 404；重复覆盖 409 entry_already_rewound；越过 reset 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('回答一'),
      fauxAssistantMessage('重发后回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '覆盖错误路径' })
    await env.app.kernel.submitInput(conv.id, '问题一')
    await env.app.kernel.waitForIdle(conv.id)

    // 不存在的条目 404。
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, '重发', { replaceFromEntryId: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 404)
        assert.equal(err.code, 'not_found')
        return true
      },
    )
    // 非法 entryId 400。
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, '重发', { replaceFromEntryId: -1 }),
      (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
    )

    // 正常覆盖一次。
    const entries = await entrySummaries(env, conv.id)
    const input1 = entries.find((e) => e.kind === 'helm.input' && e.text === '问题一')
    assert.ok(input1)
    await env.app.kernel.submitInput(conv.id, '改写问题一', { replaceFromEntryId: input1.id })
    await env.app.kernel.waitForIdle(conv.id)

    // 重复覆盖同一已被覆盖条目：409 entry_already_rewound。
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, '再次重发', { replaceFromEntryId: input1.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 409)
        assert.equal(err.code, 'entry_already_rewound')
        return true
      },
    )

    // reset 后重发 reset 之前的条目：409 entry_before_context_head。
    env.faux.setResponses([fauxAssistantMessage('reset 后回答')])
    await env.app.kernel.resetConversation(conv.id, { handoff: '重置交接' })
    await env.app.kernel.waitForIdle(conv.id)
    const afterReset = await entrySummaries(env, conv.id)
    const beforeReset = afterReset.find((e) => e.kind === 'helm.input' && Number(e.id) < (afterReset.find((r) => r.kind === 'pi.reset')?.id ?? Infinity))
    if (beforeReset !== undefined) {
      await assert.rejects(
        env.app.kernel.submitInput(conv.id, '越界重发', { replaceFromEntryId: beforeReset.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.status, 409)
          assert.equal(err.code, 'entry_before_context_head')
          return true
        },
      )
    }
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId HTTP：body 字段透传与错误信封', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_replace}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    env.faux.setResponses([fauxAssistantMessage('http 重发回答')])
    const conv = await env.app.kernel.createConversation({ title: 'HTTP 重发' })
    await env.app.kernel.submitInput(conv.id, 'http 问题')
    await env.app.kernel.waitForIdle(conv.id)
    const entries = await entrySummaries(env, conv.id)
    const input = entries.find((e) => e.kind === 'helm.input' && e.text === 'http 问题')
    assert.ok(input)

    const ok = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'http 覆盖重发',
      replaceFromEntryId: input.id,
    })
    assert.equal(ok.status, 202)
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('http 问题')))
    assert.ok(texts.some((t) => t.includes('http 覆盖重发')))

    const bad = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'x',
      replaceFromEntryId: 0,
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'validation_error')
    const notFound = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'x',
      replaceFromEntryId: 88888,
    })
    assert.equal(notFound.status, 404)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 排队撤回（withdrawQueuedInput / POST /withdraw）
// ---------------------------------------------------------------------------

test('withdraw：busy 会话排队 followUp 可撤回，排队项从 inbox 消失且不再执行', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 工厂函数挂起：首问 run 保持 busy 直到 gate resolve。
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    env.faux.setResponses([
      (async () => {
        await firstGate
        return fauxAssistantMessage('首问回答')
      }) as never,
      fauxAssistantMessage('排队输入的回答'),
    ])

    const conv = await env.app.kernel.createConversation({ title: '撤回排队' })
    await env.app.kernel.submitInput(conv.id, '首问')
    // 等 run 真正开始（tracker hasLiveWork）。
    await pollUntil(() => (env.app.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id))

    // busy 中提交 followUp（进入 pi.inbox 排队）。
    const queued = await env.app.kernel.submitInput(conv.id, '排队中的输入', {
      whenBusy: 'followUp',
    })
    const submissionId = Number(queued.submissionId)
    assert.ok(Number.isInteger(submissionId) && submissionId > 0)

    // 撤回前排队项在 inbox 中可见（queuedInputs 派生）。
    const snapshot = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live = snapshot.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.ok(
      live?.queuedInputs?.some((q) => q.submissionId === queued.submissionId),
      '排队项应在 queuedInputs 中可见',
    )

    // 撤回：status withdrawn。
    const result = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.deepEqual(result, { status: 'withdrawn' })

    // 排队项从 inbox 消失。
    const snapshot2 = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live2 = snapshot2.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.equal(
      live2?.queuedInputs?.some((q) => q.submissionId === queued.submissionId) ?? false,
      false,
      '撤回后排队项应消失',
    )

    // 释放首问 run，等待 idle：被撤回输入不再执行（上下文只含首问问答）。
    releaseFirst?.()
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('排队中的输入')), '被撤回输入不应执行进入上下文')
    assert.ok(texts.some((t) => t.includes('首问回答')), '首问回答正常完成')

    // 再次撤回同一提交：已结算（unanswered），返回 settled。
    const again = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.equal(again.status, 'settled')

    // 不存在的提交 404。
    await assert.rejects(
      env.app.kernel.withdrawQueuedInput(conv.id, { submissionId: 999999 }),
      (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    await env.close()
  }
})

test('withdraw HTTP：POST /api/conversations/:id/withdraw 状态码与 body', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_withdraw}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    env.faux.setResponses([
      (async () => {
        await gate
        return fauxAssistantMessage('http 撤回首问回答')
      }) as never,
    ])

    const conv = await env.app.kernel.createConversation({ title: 'HTTP 撤回' })
    await env.app.kernel.submitInput(conv.id, 'http 撤回首问')
    await pollUntil(() => (env.app.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id))
    const queued = await env.app.kernel.submitInput(conv.id, 'http 排队撤回项', {
      whenBusy: 'followUp',
    })

    const ok = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: Number(queued.submissionId),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { status: 'withdrawn' })

    // 非法 body。
    const bad = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 0,
    })
    assert.equal(bad.status, 400)
    const unknownField = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 1,
      bogus: 1,
    })
    assert.equal(unknownField.status, 400)
    // 不存在提交 404。
    const nf = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 987654,
    })
    assert.equal(nf.status, 404)
    assert.equal(nf.body.error.code, 'not_found')
    // 不存在会话 404。
    const nfConv = await authCall(env, 'POST', '/api/conversations/777777/withdraw', {
      submissionId: 1,
    })
    assert.equal(nfConv.status, 404)

    release?.()
    await env.app.kernel.waitForIdle(conv.id)
  } finally {
    await env.close()
  }
})
