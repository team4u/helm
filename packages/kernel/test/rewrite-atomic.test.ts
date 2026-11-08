/**
 * 原地覆盖重发（replaceFromEntryId）原子性回归测试（真实 pi-durable SDK）：
 * - 单事务 commit：同批事件同时含 rewind 与新 input，无半成品 rewind；
 * - 并发两次编辑同一 entry：最多一次成功，另一次 409；
 * - input hook 阻拦：保留旧问答（不 rewind）；
 * - 非 human / 非 helm.input 目标拒绝（400/409）；
 * - 分页投影：marker 滑出第一页后旧记录不复活（加载全部页仍不含旧内容），
 *   同时 SDK raw entries 验证历史仍保存；
 * - FTS 重建排除旧记录且保留同事务新输入；
 * - 新回答失败时 getLastAssistantText 不返回被覆盖答案；
 * - faux factory 捕获真实 provider TranscriptContext，验证不含被覆盖旧问答。
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
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'

interface Env {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-rewind-atomic-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function harnessOf(env: Env): Harness {
  return (env.app.kernel as unknown as { harness: Harness }).harness
}

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
  data?: unknown
}

/** 会话全量条目摘要（SDK raw entries；证明历史仍保存）。 */
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
      out.push({ id: Number(raw.id), kind: raw.kind, text, data: raw.data })
    }
    if (!page.next) break
    cursor = page.next
  }
  return out
}

async function askTurn(env: Env, convId: number, text: string): Promise<void> {
  await env.app.kernel.submitInput(convId, text)
  await env.app.kernel.waitForIdle(convId)
}

test('原子事务：同批 commit 事件含 rewind 与新 input；SDK raw 历史仍保存；provider 上下文不含旧问答', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 最后一次 faux 响应用工厂函数捕获真实 TranscriptContext。
    const contexts: TranscriptContext[] = []
    env.faux.setResponses([
      fauxAssistantMessage('第一轮回答'),
      fauxAssistantMessage('第二轮旧回答'),
      (async (ctx: TranscriptContext) => {
        contexts.push(ctx)
        return fauxAssistantMessage('重发后的新回答')
      }) as never,
    ])
    const conv = await env.app.kernel.createConversation({ title: '原子重发' })
    await askTurn(env, conv.id, '第一轮问题')
    await askTurn(env, conv.id, '第二轮旧问题')

    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === '第二轮旧问题')
    assert.ok(secondInput, '应存在第二轮 helm.input')

    // 观察同批 commit 事件：rewind 与新 input 应在同一批 entry 落库中。
    const { submissionId } = await env.app.kernel.submitInput(conv.id, '改写后的新问题', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // 1) rewind 标记携带闭区间契约（fromEntryId/throughEntryId/omittedInputIds）。
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, '应存在 helm.rewind 标记')
    const rewindData = rewind.data as {
      fromEntryId: number
      throughEntryId: number
      omittedEntryIds: number[]
      omittedInputIds: string[]
    }
    assert.equal(rewindData.fromEntryId, secondInput.id)
    assert.ok(rewindData.throughEntryId >= secondInput.id, 'throughEntryId 覆盖目标')
    // 新 input 条目 ID 必须 > throughEntryId（不被自家区间误删）。
    const newInput = after.find((e) => e.kind === 'helm.input' && e.text === '改写后的新问题')
    assert.ok(newInput, '新输入应落库')
    assert.ok(Number(newInput.id) > rewindData.throughEntryId, '新输入 ID 高于覆盖区间上界')
    // omittedInputIds 收集被覆盖的人类输入 request id。
    assert.ok(
      rewindData.omittedInputIds.some((id) => id.length > 0),
      'omittedInputIds 应包含被覆盖输入的 request id',
    )

    // 2) SDK raw entries：旧问答仍物理保存（逻辑隐藏而非删除）。
    assert.ok(
      after.some((e) => e.kind === 'helm.input' && e.text === '第二轮旧问题'),
      'SDK raw entries 应仍保存旧提问（逻辑隐藏）',
    )
    assert.ok(
      after.some((e) => e.kind === 'pi.assistant' && e.text === '第二轮旧回答'),
      'SDK raw entries 应仍保存旧回答',
    )

    // 3) 详情投影：旧内容隐藏，新内容出现，第一轮保留。
    const detail = await env.app.kernel.getConversationDetail(conv.id, { limit: 200 })
    const detailTexts = detail.entries
      .map((e) => {
        const dataText = (e.data as { text?: unknown } | undefined)?.text
        if (typeof dataText === 'string' && e.kind === 'helm.input') return dataText
        const model = e.model as Array<{ content?: unknown }> | undefined
        const content = model?.[0]?.content
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
          return (content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('\n')
        }
        return ''
      })
      .filter((t) => t !== '')
    assert.ok(!detailTexts.some((t) => t === '第二轮旧问题'), `旧提问应被投影隐藏：${JSON.stringify(detailTexts)}`)
    assert.ok(!detailTexts.some((t) => t === '第二轮旧回答'), '旧回答应被投影隐藏')
    assert.ok(detailTexts.some((t) => t.includes('第一轮问题')), '第一轮保留')
    assert.ok(detailTexts.some((t) => t.includes('改写后的新问题')), '新提问出现')
    assert.ok(detailTexts.some((t) => t.includes('重发后的新回答')), '新回答出现')

    // 4) 真实 provider TranscriptContext：模型请求不含被覆盖旧问答。
    assert.equal(contexts.length, 1, '工厂函数应捕获一次 provider 调用')
    const providerTexts = messageTexts(contexts[0]!.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(
      !providerTexts.some((t) => t.includes('第二轮旧问题')),
      `provider 上下文不应含旧提问：${JSON.stringify(providerTexts)}`,
    )
    assert.ok(
      !providerTexts.some((t) => t.includes('第二轮旧回答')),
      'provider 上下文不应含旧回答',
    )
    assert.ok(providerTexts.some((t) => t.includes('改写后的新问题')), 'provider 上下文含新提问')
    assert.ok(providerTexts.some((t) => t.includes('第一轮问题')), 'provider 上下文保留第一轮')
  } finally {
    await env.close()
  }
})

test('并发两次编辑同一 entry：最多一次成功，另一次 409，无半成品 rewind', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('并发旧回答'),
      fauxAssistantMessage('并发新回答 A'),
      fauxAssistantMessage('并发新回答 B'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '并发重发' })
    await askTurn(env, conv.id, '并发旧问题')
    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === '并发旧问题')
    assert.ok(target)

    // 同一 tick 并发两次编辑：两个事务都读同一尾部，后落者 rewind 区间
    // 核验（first 已被覆盖）或 submit 冲突必须失败。
    const [a, b] = await Promise.allSettled([
      env.app.kernel.submitInput(conv.id, '并发新问题 A', { replaceFromEntryId: target.id }),
      env.app.kernel.submitInput(conv.id, '并发新问题 B', { replaceFromEntryId: target.id }),
    ])
    const settled = [a, b]
    const fulfilled = settled.filter((r) => r.status === 'fulfilled')
    const rejected = settled.filter((r) => r.status === 'rejected')
    assert.ok(fulfilled.length >= 1, '至少一次成功')
    assert.ok(rejected.length >= 1, '至少一次 409 拒绝')
    for (const r of rejected) {
      const err = r.reason as HelmError
      assert.ok(
        err instanceof HelmError && (err.status === 409 || err.status === 404),
        `拒绝应为 409/404（实际 ${String(err?.status)} ${String(err?.code)}）`,
      )
    }
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // 无半成品 rewind：成功者区间完整，且成功的新输入仍可见。
    const after = await entrySummaries(env, conv.id)
    const rewinss = after.filter((e) => e.kind === 'helm.rewind')
    assert.ok(rewinss.length <= 2, 'rewind 标记数量受控')
    for (const marker of rewinss) {
      const data = marker.data as { fromEntryId: number; throughEntryId: number; omittedEntryIds: number[] }
      assert.ok(Number.isSafeInteger(data.throughEntryId), 'rewind 携带 throughEntryId')
      assert.ok(data.throughEntryId >= data.fromEntryId, '覆盖区间合法')
    }
    const winnerText = fulfilled.length === 1
      ? (fulfilled[0] as PromiseFulfilledResult<{ submissionId: string }>).value
      : undefined
    assert.ok(winnerText !== undefined || fulfilled.length === 1, '成功者返回 submissionId')
  } finally {
    await env.close()
  }
})

test('陈旧编辑在 input 钩子挂起后恢复：拒绝时不得中止已成功编辑的新回合', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let releaseHook!: () => void
  let enteredHook!: () => void
  let releaseModel!: () => void
  let startedModel!: () => void
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
  const hookEntered = new Promise<void>((resolve) => { enteredHook = resolve })
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
  const modelStarted = new Promise<void>((resolve) => { startedModel = resolve })
  try {
    const kernel = env.app.kernel
    env.faux.setResponses([
      fauxAssistantMessage('旧回答'),
      async () => {
        startedModel()
        await modelGate
        return fauxAssistantMessage('成功编辑的回答')
      },
    ])
    const conv = await kernel.createConversation({ title: '延迟编辑竞态' })
    await askTurn(env, conv.id, '旧问题')
    const target = (await entrySummaries(env, conv.id)).find((entry) => entry.kind === 'helm.input')!
    await kernel.plugins.register({
      id: 'test:delayed-edit',
      definePlugin(ctx) {
        ctx.hook.onInput(async (payload) => {
          if (payload.input.text === '陈旧编辑') {
            enteredHook()
            await hookGate
          }
        })
      },
    }, { enabled: true })
    const stale = kernel.submitInput(conv.id, '陈旧编辑', { replaceFromEntryId: target.id })
      .then(() => undefined, (error: unknown) => error)
    await hookEntered
    const accepted = await kernel.submitInput(conv.id, '成功编辑', { replaceFromEntryId: target.id })
    await modelStarted
    releaseHook()
    const error = await stale
    assert.ok(error instanceof HelmError && error.status === 409)
    assert.equal(kernel.getConversation(conv.id).status, 'working', '陈旧编辑不能中止成功者')
    releaseModel()
    await kernel.waitForIdle(conv.id)
    assert.equal((await kernel.waitForInput(conv.id, accepted.submissionId)).text, '成功编辑的回答')
  } finally {
    releaseHook()
    releaseModel()
    await env.close()
  }
})

test('input hook 阻拦：旧问答保留（无 rewind 副作用）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 经内核插件宿主挂一个接管型 input hook：对接管文本不产生真实回合
    //（input 钩子语义：handled 接管；AGENTS.md 中 block 属 tool_call）。
    let armed = true
    await env.app.kernel.plugins.register({
      id: 'test:input-block',
      definePlugin(ctx) {
        ctx.hook.onInput((payload: { input: { text: string } }) => {
          if (armed && payload.input.text === '被阻拦的编辑') {
            return { action: 'handled', result: '测试接管' }
          }
          return undefined
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('阻拦前回答')])
    const conv = await env.app.kernel.createConversation({ title: 'hook 阻拦' })
    await askTurn(env, conv.id, '阻拦前问题')

    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === '阻拦前问题')
    assert.ok(target)

    // 接管：不产生 rewind，旧问答完好，无真实回合提交。
    const handled = await env.app.kernel.submitInput(conv.id, '被阻拦的编辑', {
      replaceFromEntryId: target.id,
    })
    assert.ok(handled.submissionId.startsWith('handled:'), '接管提交返回 handled: 前缀')
    const afterBlock = await entrySummaries(env, conv.id)
    assert.ok(!afterBlock.some((e) => e.kind === 'helm.rewind'), '阻拦后不得有 rewind')
    const ctxAfter = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsAfter = messageTexts(ctxAfter.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsAfter.some((t) => t.includes('阻拦前问题')), '旧提问保留')
    assert.ok(textsAfter.some((t) => t.includes('阻拦前回答')), '旧回答保留')

    // 解除阻拦后同一目标可正常编辑。
    armed = false
    env.faux.setResponses([fauxAssistantMessage('解除后新回答')])
    await env.app.kernel.submitInput(conv.id, '解除后的编辑', { replaceFromEntryId: target.id })
    await env.app.kernel.waitForIdle(conv.id)
    const ctxOk = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsOk = messageTexts(ctxOk.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsOk.some((t) => t.includes('解除后的编辑')), '解除后编辑生效')
    assert.ok(!textsOk.some((t) => t.includes('阻拦前回答')), '旧回答被覆盖')
  } finally {
    await env.close()
  }
})

test('非 human / 非 helm.input 目标拒绝：assistant 400；agent/trigger 来源 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('目标判定旧回答')])
    const conv = await env.app.kernel.createConversation({ title: '目标判定' })
    // agent 来源输入。
    await env.app.kernel.submitInput(conv.id, 'agent 来源问题', { origin: 'agent' })
    await env.app.kernel.waitForIdle(conv.id)
    // trigger 来源输入。
    await env.app.kernel.submitInput(conv.id, 'trigger 来源问题', { origin: 'trigger' })
    await env.app.kernel.waitForIdle(conv.id)
    // human 来源输入。
    await askTurn(env, conv.id, 'human 来源问题')

    const entries = await entrySummaries(env, conv.id)
    const agentInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'agent 来源问题')
    const triggerInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'trigger 来源问题')
    const assistant = entries.find((e) => e.kind === 'pi.assistant')
    assert.ok(agentInput && triggerInput && assistant)

    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: assistant.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 400)
        assert.equal(err.code, 'entry_not_editable')
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: agentInput.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 409)
        assert.equal(err.code, 'entry_not_editable')
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: triggerInput.id }),
      (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_not_editable',
    )
  } finally {
    await env.close()
  }
})

test('分页投影：小 limit 跨页且 marker 滑出第一页，加载全部页仍不含旧内容', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('分页第一轮回答'),
      fauxAssistantMessage('分页第二轮旧回答'),
      fauxAssistantMessage('分页新回答'),
      fauxAssistantMessage('分页后续回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '分页投影' })
    await askTurn(env, conv.id, '分页第一轮问题')
    await askTurn(env, conv.id, '分页第二轮旧问题')

    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === '分页第二轮旧问题')
    assert.ok(secondInput)
    await env.app.kernel.submitInput(conv.id, '分页新问题', { replaceFromEntryId: secondInput.id })
    await env.app.kernel.waitForIdle(conv.id)
    // rewind 之后再补一轮正常对话，把 marker 推得离尾部更远（滑出小页）。
    await askTurn(env, conv.id, '分页后续问题')

    // limit=2 逐页加载直到耗尽。
    const seenTexts: string[] = []
    let cursor: string | undefined = undefined
    let pages = 0
    for (;;) {
      const page = await env.app.kernel.getConversationDetail(conv.id, {
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      pages += 1
      for (const e of page.entries) {
        if (e.kind === 'helm.input') {
          const dataText = (e.data as { text?: unknown } | undefined)?.text
          if (typeof dataText === 'string') seenTexts.push(dataText)
        } else if (e.kind === 'pi.assistant') {
          const model = e.model as Array<{ content?: unknown }> | undefined
          const content = model?.[0]?.content
          if (typeof content === 'string') seenTexts.push(content)
          else if (Array.isArray(content)) {
            const t = (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (t !== '') seenTexts.push(t)
          }
        }
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
      assert.ok(pages < 50, '分页不得死循环')
    }
    assert.ok(pages >= 2, '至少跨两页')
    // 全部页加载完：被覆盖旧内容绝不复活。
    assert.ok(
      !seenTexts.some((t) => t === '分页第二轮旧问题'),
      `全部页不应含被覆盖旧提问：${JSON.stringify(seenTexts)}`,
    )
    assert.ok(
      !seenTexts.some((t) => t === '分页第二轮旧回答'),
      '全部页不应含被覆盖旧回答',
    )
    // 有效内容全部在册（新问答与前后轮保留）。
    assert.ok(seenTexts.some((t) => t.includes('分页第一轮问题')), '第一轮可见')
    assert.ok(seenTexts.some((t) => t.includes('分页新问题')), '新提问可见')
    assert.ok(seenTexts.some((t) => t.includes('分页后续问题')), '后续轮可见')
  } finally {
    await env.close()
  }
})

test('FTS：原子事务新输入立即可检索；rebuildFts 排除旧记录且保留新内容', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('ftsa 第一轮回答'),
      fauxAssistantMessage('ftsb 旧回答正文'),
      fauxAssistantMessage('ftsc 新回答正文'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'FTS 重发' })
    await askTurn(env, conv.id, 'ftsq1 第一轮提问')
    await askTurn(env, conv.id, 'ftsq2 旧提问正文')
    const entries = await entrySummaries(env, conv.id)
    const second = entries.find((e) => e.kind === 'helm.input' && e.text === 'ftsq2 旧提问正文')
    assert.ok(second)
    await env.app.kernel.submitInput(conv.id, 'ftsq3 独有新提问', { replaceFromEntryId: second.id })
    await env.app.kernel.waitForIdle(conv.id)

    // 原子事务新输入入索引（观察路径 indexFts onInputCommitted）。
    const newHit = await env.app.kernel.search('ftsq3')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), '新提问应命中 FTS')
    // 旧内容不再命中（唯一 token，避免前缀误命中其他条目）。
    const oldQ = await env.app.kernel.search('ftsq2')
    assert.equal(oldQ.filter((h) => h.conversationId === conv.id).length, 0, '旧提问不命中')
    const oldA = await env.app.kernel.search('ftsb')
    assert.equal(oldA.filter((h) => h.conversationId === conv.id).length, 0, '旧回答不命中')

    // rebuildFts 后：旧内容仍不命中，新内容保留。
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('ftsb')
    assert.equal(rebuiltOld.filter((h) => h.conversationId === conv.id).length, 0, 'rebuild 后旧回答不命中')
    const rebuiltNew = await env.app.kernel.search('ftsq3')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'rebuild 后新提问保留')
    const rebuiltNewA = await env.app.kernel.search('ftsc')
    assert.ok(rebuiltNewA.some((h) => h.conversationId === conv.id), 'rebuild 后新回答保留')
  } finally {
    await env.close()
  }
})

test('新回答失败：getLastAssistantText 不返回被覆盖答案', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('失败前第一轮回答'),
      fauxAssistantMessage('将被覆盖的旧回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '失败缓存' })
    await askTurn(env, conv.id, '失败前第一轮问题')
    await askTurn(env, conv.id, '将被覆盖的问题')

    const before = await env.app.kernel.getLastAssistantText(conv.id)
    assert.equal(before, '将被覆盖的旧回答')

    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === '将被覆盖的问题')
    assert.ok(target)

    // 新回答注入失败：faux 工厂抛错（faux.setResponses 空 → 出错路径）。
    env.faux.setResponses([
      (async () => {
        throw new Error('faux 模型注入失败')
      }) as never,
    ])
    await env.app.kernel.submitInput(conv.id, '注定失败的编辑', { replaceFromEntryId: target.id })
    // 等待回合结算（失败也是终态）。
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // 缓存已被 rewind 失效：不返回被覆盖旧答案。
    const after = await env.app.kernel.getLastAssistantText(conv.id)
    assert.notEqual(after, '将被覆盖的旧回答', '不得返回被覆盖旧答案')
  } finally {
    await env.close()
  }
})
