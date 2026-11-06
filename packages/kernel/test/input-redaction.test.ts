/**
 * 输入脱敏回归测试（对齐1 根因修复的最小真实回归）。
 *
 * 背景：core-alignment.integration.test.ts:292 真实失败——submitInput 只对
 * meta 脱敏，text/effectiveText 原样进入 SDK content 与 helm.input.data，
 * 导致已登记秘密（受管 Token、SecretStash marker）明文进入模型上下文与
 * state.sqlite。
 *
 * 本文件以真实 KernelRuntime + faux provider + 临时 dataDir 验证：
 * 1. 直接输入含受管 token / stash 秘密 → 模型请求、helm.input entry、
 *    自动标题、FTS、state.sqlite 全链只见 marker/占位符；
 * 2. input hook transform 产物含秘密 → 同样全链脱敏（transform 语义保留：
 *    transform 后的 text/origin 生效）。
 *
 * 诚实性：全部断言基于真实 SQLite 文件与 faux 捕获的模型请求，无 mock 断言。
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

import { KernelRuntime } from '../src/runtime/index.js'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import assert from 'node:assert/strict'

interface Env {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  kernel: KernelRuntime
  managedToken: string
  close(): Promise<void>
}

async function makeEnv(prefix: string): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const managedToken = (kernel as unknown as {
    toolDeps: { processToken(): string | undefined }
  }).toolDeps.processToken()
  assert.ok(managedToken, 'runtime ctor 应创建受管进程 token')
  return {
    dataDir,
    faux,
    kernel,
    managedToken,
    async close() {
      try {
        await kernel.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}

/** sqlite 全表扫描：包含 needle 的表名集合（与 core-alignment 同法）。 */
function sqliteTablesContaining(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hits: string[] = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]
      if (rows.map((r) => JSON.stringify(r)).join('\n').includes(needle)) hits.push(name)
    }
    return hits
  } finally {
    db.close()
  }
}

test('直接输入含受管 token 与 stash 秘密：text/meta/标题/entry/FTS/SQLite 全链脱敏', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-input-redact-direct-')
  try {
    // 会话级 stash 秘密（marker 形态：redact 后为 [REDACTED:stash:<uuid>]）。
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', 'sk-secret-plain-value-9f3k')
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    const requests: string[] = []
    env.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('收到')
      },
    ])

    await env.kernel.submitInput(
      conversation.id,
      `凭据是 ${env.managedToken} 与 sk-secret-plain-value-9f3k，另外 meta 也带`,
      { meta: { token: env.managedToken, key: 'sk-secret-plain-value-9f3k' } },
    )
    await env.kernel.waitForIdle(conversation.id)

    // 1) 模型请求（SDK content）不得含任何明文。
    assert.equal(requests.length, 1, '应捕获一次模型请求')
    assert.ok(!requests[0]!.includes(env.managedToken), '模型请求不得含受管 Token 明文')
    assert.ok(!requests[0]!.includes('sk-secret-plain-value-9f3k'), '模型请求不得含 stash 秘密明文')
    // 脱敏值真实进入模型（非空壳）。
    assert.ok(requests[0]!.includes('[REDACTED]'), '受管 token 应以 [REDACTED] marker 进入模型')
    assert.ok(requests[0]!.includes(placeholder), 'stash 秘密应以占位符进入模型')

    // 2) 全库扫描：任何表不得存明文（含 helm.input entry、标题列、FTS）。
    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'state.sqlite 不得含受管 Token 明文')
    assert.deepEqual(sqliteTablesContaining(dbPath, 'sk-secret-plain-value-9f3k'), [], 'state.sqlite 不得含 stash 秘密明文')

    // 3) 标题脱敏（首输入自动标题取 effectiveText）。
    const conv = env.kernel.getConversation(conversation.id)
    assert.ok(conv.title.includes('[REDACTED]'), '首输入应生成包含脱敏文本的标题')
    assert.ok(!conv.title.includes(env.managedToken), '自动标题不得含受管 Token 明文')
    const detail = await env.kernel.getConversationDetail(conversation.id)
    const input = detail.entries.find((entry) => entry.kind === 'helm.input')?.data as
      { text: string; meta: Record<string, unknown> } | undefined
    assert.ok(input, '详情应保留真实输入条目')
    assert.equal(input.text, `凭据是 [REDACTED] 与 ${placeholder}，另外 meta 也带`)
    assert.deepEqual(input.meta, { token: '[REDACTED]', key: placeholder })

    // 4) FTS 检索得到脱敏文本而非明文。
    const hits = await env.kernel.search('[REDACTED]')
    assert.ok(hits.length >= 1, '脱敏文本应可被 FTS 检索')
    for (const hit of hits) {
      assert.ok(!JSON.stringify(hit).includes(env.managedToken), 'FTS 结果不得回显明文')
    }
  } finally {
    await env.close()
  }
})

test('input hook transform 产物含秘密：同样全链脱敏，transform 语义保留', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-input-redact-transform-')
  try {
    await env.kernel.plugins.register({
      id: 'test:inject-secret',
      definePlugin(ctx) {
        ctx.hook.onInput((payload) => {
          return {
            action: 'transform',
            value: {
              ...payload,
              input: {
                ...payload.input,
                text: `${payload.input.text} 附加秘密 ${env.managedToken}`,
                origin: 'agent',
                meta: { injected: env.managedToken },
              },
            },
          }
        })
      },
    })

    const requests: string[] = []
    env.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('收到 transform 输入')
      },
    ])

    await env.kernel.submitInput(ROOT_CONVERSATION_ID, '原始输入')
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.equal(requests.length, 1, '应捕获一次模型请求')
    assert.ok(!requests[0]!.includes(env.managedToken), 'transform 产物不得把受管 Token 明文送入模型')
    // transform 语义保留：改写后的文本与 origin 真实生效。
    assert.ok(requests[0]!.includes('附加秘密'), 'transform 追加文本应生效')
    assert.ok(requests[0]!.includes('[REDACTED]'), 'transform 产物中秘密应以 marker 进入模型')

    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'transform 产物不得在 state.sqlite 留明文')

    // turn_settled 输入清单里的 text 同为脱敏值（钩子载荷从 entry 重建）。
    const settledTexts: string[] = []
    await env.kernel.plugins.register({
      id: 'test:settled-observer',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledTexts.push(...payload.inputs.map((i) => i.text))
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('第二回合')])
    await env.kernel.submitInput(ROOT_CONVERSATION_ID, `再来一次 ${env.managedToken}`)
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(settledTexts.length >= 1, '应捕获 turn_settled')
    for (const text of settledTexts) {
      assert.ok(!text.includes(env.managedToken), 'turn_settled inputs.text 不得含明文')
    }
  } finally {
    await env.close()
  }
})
