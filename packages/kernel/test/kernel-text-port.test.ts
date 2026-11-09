/**
 * KernelRuntime.completeConversationText 通用模型端口契约测试：
 * 真实 KernelRuntime + 真实 SDK（faux provider 包装 streamSimple 捕获实际
 * 请求的 (context, options)；已核实 Models.completeSimple 内部经
 * normalizeContext 折叠 systemPrompt/tools 为 leading system message 后调用
 * provider.streamSimple(model, transcript, options)，maxTokens 在 options）。
 *
 * 覆盖：
 * - maxTokens 位于请求 options（provider 第三参），transcript（Context）
 *   不含 maxTokens / tools 字段（无 tools 单次请求）；
 * - systemPrompt 与用户 text 均已过全局脱敏（stash secret 不进入模型输入）；
 * - 返回输出同样过全局脱敏；
 * - 会话 override 优先于全局模型（真实双 provider 区分请求归属）；
 * - stopReason 非 'stop'（error/length）显式拒绝；
 * - 会话不存在 / 未配置模型如实上抛；signal 预先 aborted 立即拒绝。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Provider } from '@earendil-works/pi-ai/models'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-kernel-text-port-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 捕获到的 provider.streamSimple 实参（SDK 真实调用路径）。 */
interface Captured {
  context: TranscriptContext
  maxTokens: number | undefined
  signal: AbortSignal | undefined
}

/** transcript 全文（system + 各消息文本块拼接）。 */
function transcriptText(context: TranscriptContext): string {
  return context.messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    )
    .join('\n')
}

/**
 * 包装 faux provider：捕获 streamSimple 的 (context, options) 再委托原实现。
 * 类型从原方法参数推断（Parameters<typeof original>），不用 as never。
 */
function captureProvider(base: Provider, sink: Captured[]): Provider {
  const original = base.streamSimple.bind(base)
  const streamSimple = (...args: Parameters<typeof original>) => {
    sink.push({
      context: args[1]!,
      maxTokens: args[2]?.maxTokens,
      signal: args[2]?.signal,
    })
    return original(...args)
  }
  return { ...base, streamSimple }
}

interface Env {
  kernel: KernelRuntime
  /** fauxA（全局模型）请求捕获。 */
  capturedA: Captured[]
  /** fauxB（override 专用）请求捕获。 */
  capturedB: Captured[]
  fauxA: ReturnType<typeof fauxProvider>
  fauxB: ReturnType<typeof fauxProvider>
  close(): Promise<void>
}

async function openEnv(options: { model?: string } = {}): Promise<Env> {
  const models = createModels()
  const capturedA: Captured[] = []
  const capturedB: Captured[] = []
  const fauxA = fauxProvider()
  const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'override-model' }] })
  models.setProvider(captureProvider(fauxA.provider, capturedA))
  models.setProvider(captureProvider(fauxB.provider, capturedB))
  const kernel = await KernelRuntime.open({
    dataDir: join(rootDir, `d-${Math.random().toString(36).slice(2)}`),
    cwd: rootDir,
    model: options.model ?? 'faux/faux-1',
    models: models as never,
    watchdogIntervalMs: 0,
    autoResume: false,
  })
  return {
    kernel,
    capturedA,
    capturedB,
    fauxA,
    fauxB,
    async close() {
      await kernel.close()
    },
  }
}

describe('completeConversationText（内核通用模型端口）', () => {
  it('maxTokens 在请求 options；transcript 无 maxTokens/tools；systemPrompt 与 text 进模型输入', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('plain output')])
      const text = await env.kernel.completeConversationText({
        conversationId: 1,
        systemPrompt: 'SYS-PROMPT-MARKER',
        text: 'USER-TEXT-MARKER',
        maxTokens: 640,
      })
      assert.equal(text, 'plain output')
      assert.equal(env.capturedA.length, 1)
      const captured = env.capturedA[0]!
      // maxTokens 传到 provider options（第三参），不是 Context 字段。
      assert.equal(captured.maxTokens, 640)
      // normalizeContext 产物只有 messages；不含 maxTokens 与 tools。
      const contextRecord = captured.context as unknown as Record<string, unknown>
      assert.equal('maxTokens' in contextRecord, false, 'Context 不得含 maxTokens')
      assert.equal('tools' in contextRecord, false, 'Context 不得含 tools（无 tools 单次请求）')
      // systemPrompt 折叠为 leading system message；用户 text 在后续消息。
      const full = transcriptText(captured.context)
      assert.ok(full.includes('SYS-PROMPT-MARKER'), 'systemPrompt 进入模型输入')
      assert.ok(full.includes('USER-TEXT-MARKER'), '用户文本进入模型输入')
    } finally {
      await env.close()
    }
  })

  it('输入输出脱敏：systemPrompt/text 中的 secret 不进模型；输出 secret 被脱敏', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.kernel.stash.addRedaction('SECRET-INPUT-42')
      env.kernel.stash.addRedaction('SECRET-OUTPUT-99')
      env.fauxA.setResponses([fauxAssistantMessage('结果包含 SECRET-OUTPUT-99')])
      const text = await env.kernel.completeConversationText({
        conversationId: 1,
        systemPrompt: '系统提示含 SECRET-INPUT-42',
        text: '快照含 SECRET-INPUT-42',
      })
      assert.ok(!text.includes('SECRET-OUTPUT-99'), '返回输出已过全局脱敏')
      assert.ok(text.includes('[REDACTED') || !text.includes('SECRET'), '输出含脱敏标记')
      const full = transcriptText(env.capturedA[0]!.context)
      assert.ok(!full.includes('SECRET-INPUT-42'), 'systemPrompt 与 text 中的 secret 不进入模型输入')
      assert.ok(full.includes('[REDACTED') || !full.includes('SECRET-INPUT'), '模型输入含脱敏标记')
    } finally {
      await env.close()
    }
  })

  it('会话 override 优先于全局模型：请求走 override provider', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      const conv = await env.kernel.createConversation({ title: 'override' })
      await env.kernel.updateConversation(conv.id, { model: 'faux-b/override-model' })
      env.fauxB.setResponses([fauxAssistantMessage('来自 override 模型')])
      const text = await env.kernel.completeConversationText({
        conversationId: conv.id,
        systemPrompt: 's',
        text: 't',
        maxTokens: 512,
      })
      assert.equal(text, '来自 override 模型')
      assert.equal(env.capturedB.length, 1, '请求落在 override provider')
      assert.equal(env.capturedB[0]!.maxTokens, 512)
      assert.equal(env.capturedA.length, 0, '不回落全局模型')
    } finally {
      await env.close()
    }
  })

  it('stopReason=error 显式拒绝，不返回部分文本', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('部分文本', { stopReason: 'error' })])
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_completion_unavailable')
          assert.ok(e.message.includes('error'))
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('stopReason=length 同样拒绝', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      env.fauxA.setResponses([fauxAssistantMessage('截断文本', { stopReason: 'length' })])
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_completion_unavailable')
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('会话不存在如实 404；signal 预先 aborted 立即拒绝且不发请求', { timeout: 60_000 }, async () => {
    const env = await openEnv()
    try {
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 999_999, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'not_found')
          return true
        },
      )
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        env.kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't', signal: controller.signal }),
        () => true,
      )
      assert.equal(env.capturedA.length, 0, '预先取消不发起请求')
    } finally {
      await env.close()
    }
  })

  it('未配置全局模型时如实上抛，不静默使用其它已注册模型', { timeout: 60_000 }, async () => {
    const models = createModels()
    const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'other' }] })
    models.setProvider(fauxB.provider)
    const kernel = await KernelRuntime.open({
      dataDir: join(rootDir, `bare-${Math.random().toString(36).slice(2)}`),
      cwd: rootDir,
      models: models as never,
      watchdogIntervalMs: 0,
      autoResume: false,
    })
    try {
      await assert.rejects(
        kernel.completeConversationText({ conversationId: 1, systemPrompt: 's', text: 't' }),
        (e: unknown) => {
          assert.ok(e instanceof HelmError)
          assert.equal(e.code, 'model_not_configured')
          return true
        },
      )
      assert.equal(fauxB.state.callCount, 0, '绝不静默改用其它已注册模型')
    } finally {
      await kernel.close()
    }
  })
})
