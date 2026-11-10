/**
 * 会话失败诊断摘要（ConversationSummary.lastError）回归测试。
 *
 * 缺陷背景（本文件锁定修复）：
 * - 模型/API 请求失败后侧栏状态为 error，但消息流没有任何响应——SDK 将失败
 *   保存在 pi.live.runFailure（reason/detail），helm 只把 error 送进 plugin
 *   turn_settled，没有透传到 ConversationSummary，前端无从展示原因。
 *
 * 现契约：
 * 1. 失败终态：getConversation / conversation.upsert 事件携带具体 lastError
 *   （'model_error: <detail>' 形态）；
 * 2. 持久性：lastError 跨进程重启仍可见（runFailure 是 pi.live 权威状态）；
 * 3. 清除：下一次成功回合开始后 lastError 随 error 状态消失；
 * 4. 脱敏：错误 detail 含已登记 stash 秘密时，lastError 只见占位符（与
 *    SecretStash 全链脱敏同源），绝不经 ConversationSummary 回显明文；
 * 5. 语义去重：lastError 参与 summary 语义指纹（错误内容变化需更新）。
 *
 * 经真实 KernelRuntime（faux provider + 真实 SQLite + 真实观察者链路）驱动。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface Env {
  dataDir: string
  faux: FauxHandle
  kernel: KernelRuntime
  upserts: ConversationSummary[]
  stopRecording: () => void
  close(): Promise<void>
}

async function makeEnv(prefix: string): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
  })
  const upserts: ConversationSummary[] = []
  const stopRecording = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id === 1) upserts.push(conversation)
  })
  return {
    dataDir,
    faux,
    kernel,
    upserts,
    stopRecording,
    async close() {
      stopRecording()
      try {
        await kernel.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 15))
  }
}

test('失败终态：lastError 透传到 getConversation 与 conversation.upsert；下一成功回合清除', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-basic-')
  try {
    // 第一回合失败：faux 返回 stopReason=error + errorMessage。
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'provider 503 quota exceeded', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, '会失败的问题').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')

    // getConversation（API 同链路）携带具体错误。
    const summary = env.kernel.getConversation(1)
    assert.equal(summary.status, 'error')
    assert.ok(summary.lastError, '失败终态摘要应携带 lastError')
    assert.ok(
      summary.lastError!.startsWith('model_error'),
      `lastError 应含 reason 前缀，实际：${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes('provider 503 quota exceeded'),
      `lastError 应含具体 detail，实际：${summary.lastError}`,
    )

    // conversation.upsert 事件（SSE 同出口）同样携带（首个 error 帧即有原因）。
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.length >= 1, `应有 error upsert 帧，实际：${JSON.stringify(env.upserts.map((c) => c.status))}`)
    assert.ok(
      errorFrames[0]!.lastError?.includes('provider 503 quota exceeded'),
      `首个 error upsert 帧即应携带原因，实际：${errorFrames[0]!.lastError}`,
    )

    // 第二回合成功：error 状态与 lastError 一并清除（run 重新启动清除 runFailure）。
    env.faux.setResponses([fauxAssistantMessage('恢复的回答')])
    await env.kernel.submitInput(1, '再次提问')
    await env.kernel.waitForIdle(1)
    await waitFor(() => env.kernel.getConversation(1).status === 'done')
    const after = env.kernel.getConversation(1)
    assert.equal(after.status, 'done')
    assert.equal(after.lastError, undefined, '成功回合后 lastError 应清除')
    const lastErrorFrames = env.upserts.filter((c) => c.lastError !== undefined)
    assert.ok(
      lastErrorFrames.every((c) => c.status === 'error'),
      'lastError 只应出现在 error 状态的摘要上',
    )
  } finally {
    await env.close()
  }
})

test('失败持久性：lastError 跨进程重启仍可见（pi.live 权威状态）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-last-error-restart-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'connection reset by peer', stopReason: 'error' }),
    ])
    await kernel.submitInput(1, '重启前失败').catch(() => {})
    await kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'error')
    assert.ok(kernel.getConversation(1).lastError?.includes('connection reset by peer'))
  } finally {
    await kernel.close()
  }

  // 重启：凭 pi.live.runFailure 恢复 error 状态与诊断摘要。
  const faux2 = fauxProvider()
  const models2 = createModels()
  models2.setProvider(faux2.provider)
  const kernel2 = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: models2 })
  try {
    const summary = kernel2.getConversation(1)
    assert.equal(summary.status, 'error', '重启后 error 状态应保持')
    assert.ok(
      summary.lastError?.includes('connection reset by peer'),
      `重启后 lastError 应可见，实际：${summary.lastError}`,
    )
  } finally {
    await kernel2.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('脱敏：错误 detail 回显已登记 stash 秘密时 lastError 只见占位符', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-redact-')
  try {
    const secretValue = 'sk-helm-test-9f3ab2c7deadbeef'
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', secretValue)
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    // provider 错误 detail 中回显秘密明文（模拟上游把请求头/参数带回错误信息）。
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: `upstream 401 key=${secretValue}`, stopReason: 'error' }),
    ])
    await env.kernel.submitInput(conversation.id, '带秘密的失败').catch(() => {})
    await env.kernel.waitForIdle(conversation.id).catch(() => {})
    await waitFor(() => env.kernel.getConversation(conversation.id).status === 'error')

    const summary = env.kernel.getConversation(conversation.id)
    assert.ok(summary.lastError, '失败摘要应携带 lastError')
    assert.ok(
      !summary.lastError!.includes(secretValue),
      `lastError 不得回显秘密明文，实际：${summary.lastError}`,
    )
    assert.ok(
      summary.lastError!.includes(placeholder),
      `秘密应以占位符出现，实际：${summary.lastError}`,
    )
  } finally {
    await env.close()
  }
})

test('语义指纹：相同 error 状态但错误内容变化时摘要更新', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-last-error-dedup-')
  try {
    // 第一次失败。
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'first failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, '第一次').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).status === 'error')
    assert.ok(env.kernel.getConversation(1).lastError?.includes('first failure'))

    // 第二次失败（不同错误文本）：error 状态不变，但 lastError 变化必须推送更新。
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'second different failure', stopReason: 'error' }),
    ])
    await env.kernel.submitInput(1, '第二次').catch(() => {})
    await env.kernel.waitForIdle(1).catch(() => {})
    await waitFor(() => env.kernel.getConversation(1).lastError?.includes('second different failure') === true)
    const latest = env.kernel.getConversation(1).lastError
    assert.ok(latest !== undefined)
    assert.ok(
      !latest.includes('first failure'),
      'lastError 应反映最新失败',
    )
    const errorFrames = env.upserts.filter((c) => c.status === 'error')
    assert.ok(errorFrames.some((c) => c.lastError?.includes('first failure')))
    assert.ok(errorFrames.some((c) => c.lastError?.includes('second different failure')))
  } finally {
    await env.close()
  }
})
