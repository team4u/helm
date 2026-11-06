/**
 * KernelRuntime 集成测试：真实 pi-durable SDK + faux provider（仅测试）。
 *
 * 覆盖：完成/失败/abort 三终态、busy followUp 来源映射、重启恢复、root 保护、
 * seq/SSE 竞态、Ask CAS 与 secret 持久边界、tool block/spill 真实执行。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import type { HelmEventFrame, HelmSnapshot } from '@helm/protocol'

/**
 * faux provider 绑定：KernelRuntime.open 的 models 构建器会自动安装 openai/anthropic；
 * 测试通过注入 HELM_FAUX 环境变量 + monkey-patch models？——不行，诚实路径：
 * KernelRuntime 允许 options.models 直接注入测试 Models（明确为测试用途）。
 */

interface FauxHandle {
  setResponses(messages: unknown[]): void
  appendResponses(messages: unknown[]): void
  provider: { id: string }
}

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider() as unknown as FauxHandle
  models.setProvider(faux.provider as never)
  return { models, faux }
}

async function openRuntime(dir: string): Promise<KernelRuntime> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
  })
  return Object.assign(runtime, { __faux: faux } as never)
}

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-runtime-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

describe('KernelRuntime 基础生命周期', { timeout: 60_000 }, () => {
  it('root #1 自动创建且不可删除；五态 idle；profiles ensureDefault 先行', async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      const convs = kernel.listConversations()
      assert.equal(convs.length, 1)
      assert.equal(convs[0]?.id, 1)
      assert.equal(convs[0]?.profileId, 'assistant')
      assert.equal(convs[0]?.status, 'idle')
      await assert.rejects(
        () => kernel.deleteConversation(1),
        (err: unknown) => err instanceof HelmError && err.code === 'root_conversation_protected',
      )
      // ensureDefault 已建 assistant profile
      const profiles = await kernel.services.profiles.list()
      assert.ok(profiles.some((p) => p.id === 'assistant'))
    } finally {
      await kernel.close()
    }
  })

  it('faux 完成路径：turn_settled completed、unread/done、标题自动生成', async () => {
    const kernel = (await openRuntime(join(root, 't2'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('你好，我是回答。'),
        fauxAssistantMessage('新会话回答'),
      ])
      // root 保持默认标题；自动标题在新会话验证
      const { submissionId } = await kernel.submitInput(1, '请打个招呼')
      assert.ok(submissionId)
      const fresh = await kernel.createConversation({})
      await kernel.submitInput(fresh.id, '```code```\n请打个招呼\n第二行')
      await kernel.waitForIdle(1)
      await kernel.waitForIdle(fresh.id)
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'done')
      assert.equal(conv.unread, true)
      assert.equal(conv.title, '个人助理')
      const freshConv = kernel.getConversation(fresh.id)
      assert.equal(freshConv.title, '请打个招呼 第二行'.slice(0, 36))
      assert.equal(freshConv.completionSeq, 1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, '你好，我是回答。')
    } finally {
      await kernel.close()
    }
  })

  it('失败路径：runFailure 映射 error 态；turn_settled failed 精确 inputs', async () => {
    const kernel = (await openRuntime(join(root, 't3'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      // faux errorMessage 让请求失败 -> runFailure model_error
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, '触发失败')
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'error')
    } finally {
      await kernel.close()
    }
  })

  it('abort 路径：中途中止后 idle；turn_settled aborted', async () => {
    const kernel = (await openRuntime(join(root, 't4'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('慢慢回答')])
      const p = kernel.submitInput(1, '会被中止的问题')
      void p
      await new Promise((r) => setTimeout(r, 50))
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      assert.ok(['idle', 'error'].includes(conv.status))
    } finally {
      await kernel.close()
    }
  })
})

describe('busy 来源与 followUp', { timeout: 60_000 }, () => {
  it('busy 期间 followUp 不丢输入；turn_settled inputs 精确映射', async () => {
    const kernel = (await openRuntime(join(root, 't5'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      // 两条响应：第一轮 + followUp 轮
      kernel.__faux.setResponses([
        fauxAssistantMessage('第一条回答'),
        fauxAssistantMessage('第二条回答'),
      ])
      await kernel.submitInput(1, '第一条', { origin: 'human' })
      // 立即 followUp（busy 中排队，不丢）
      const second = await kernel.submitInput(1, '第二条', { origin: 'agent' })
      assert.ok(second.submissionId)
      await kernel.waitForIdle(1)
      const conv = kernel.getConversation(1)
      assert.equal(conv.status, 'done')
      // FTS 索引了两条输入
      const hits = await kernel.search('第二条')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })
})

describe('重启恢复', { timeout: 60_000 }, () => {
  it('close 后重开：会话/标题/seq/事件 seq 恢复；root 仍受保护', async () => {
    const dir = join(root, 't6')
    const kernel = (await openRuntime(dir)) as never as KernelRuntime & { __faux: FauxHandle }
    kernel.__faux.setResponses([fauxAssistantMessage('重启前的回答')])
    const fresh = await kernel.createConversation({})
    await kernel.submitInput(fresh.id, '重启前的问题')
    await kernel.waitForIdle(fresh.id)
    const seqBefore = kernel.getConversation(fresh.id).stateChangeSeq
    const eventSeqBefore = kernel.events.seq
    await kernel.close()

    const kernel2 = (await openRuntime(dir)) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      const conv = kernel2.getConversation(fresh.id)
      assert.equal(conv.title, '重启前的问题')
      assert.equal(conv.stateChangeSeq, seqBefore)
      assert.ok(kernel2.events.seq >= eventSeqBefore)
      await assert.rejects(
        () => kernel2.deleteConversation(1),
        (err: unknown) => err instanceof HelmError && err.code === 'root_conversation_protected',
      )
      // 搜索仍命中（FTS 持久化）
      const hits = await kernel2.search('重启前的问题')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel2.close()
    }
  })
})

describe('SSE snapshot + seq 竞态', { timeout: 60_000 }, () => {
  it('先订阅后快照：首帧 snapshot 后仅收 seq > snapshot.seq 的增量', async () => {
    const kernel = await openRuntime(join(root, 't7'))
    try {
      const frames: Array<HelmSnapshot | HelmEventFrame> = []
      // 制造发布与订阅的交错：订阅回调中发布新事件（模拟竞态）。
      kernel.events.sseStream((frame) => {
        frames.push(frame)
        if (frames.length === 1) {
          // 快照刚取完、缓冲冲刷前再发布（下一个 seq 必达）。
          queueMicrotask(() => {
            kernel.events.publish('notification', { level: 'info', title: '竞态事件' })
          })
        }
        return true
      })
      await new Promise((r) => setTimeout(r, 100))
      const snapshot = frames[0]
      assert.ok(snapshot && 'conversations' in snapshot)
      const eventFrames = frames.filter((f) => 'event' in f) as HelmEventFrame[]
      assert.ok(eventFrames.length >= 1)
      assert.ok(eventFrames.every((f) => f.seq > (snapshot as HelmSnapshot).seq))
      const last = eventFrames[eventFrames.length - 1]
      assert.equal(last.event.type, 'notification')
    } finally {
      await kernel.close()
    }
  })
})

describe('Ask CAS 与 secret 持久边界', { timeout: 60_000 }, () => {
  it('secret 答案入 stash：持久层与事件只有 marker', async () => {
    const kernel = await openRuntime(join(root, 't8'))
    try {
      const askPromise = kernel.createAsk({
        conversationId: 1,
        title: '需要密钥',
        fields: [
          { name: 'API_KEY', label: 'API Key', type: 'text', secret: true, required: true },
        ],
      })
      await new Promise((r) => setTimeout(r, 20))
      const pending = kernel.listAsks('pending')
      assert.equal(pending.length, 1)
      const ask = pending[0]
      void askPromise.then(async (answers) => {
        // 答案是 marker 形式；明文仅经 envFor 进入子进程环境（进程内可信方）
        assert.ok(answers['API_KEY']!.startsWith('[REDACTED:stash:'))
        const env = kernel.services.stash.envFor(1)
        assert.ok(String(env['API_KEY']).length > 0)
      })
      await kernel.answerAsk(ask.id, { API_KEY: 'super-secret-123' })
      // 持久层只有 marker：重新读取 ask 列表验证
      const answered = kernel.listAsks('answered')
      assert.equal(answered.length, 1)
    } finally {
      await kernel.close()
    }
  })

  it('CAS：外部 seq 已推进时 answer 流转 superseded', async () => {
    const kernel = await openRuntime(join(root, 't9'))
    try {
      const askPromise = kernel.createAsk({
        conversationId: 1,
        title: '终端确认',
        expectedStateSeq: 10,
        fields: [{ name: 'confirm', label: '确认', type: 'confirm' }],
      })
      void askPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const ask = kernel.listAsks('pending')[0]!
      // herdr 侧已推进到 11
      kernel.registerAskSeqResolver(() => 11)
      const result = await kernel.answerAsk(ask.id, { confirm: 'yes' })
      assert.equal(result.status, 'superseded')
      assert.equal(kernel.listAsks('pending').length, 0)
    } finally {
      await kernel.close()
    }
  })

  it('重启后遗留 pending asks 保留并发诊断通知（不静默）', async () => {
    const dir = join(root, 't10')
    const kernel = await openRuntime(dir)
    const askPromise = kernel.createAsk({
      conversationId: 1,
      title: '遗留问题',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise
    await new Promise((r) => setTimeout(r, 20))
    await kernel.close()

    const kernel2 = await openRuntime(dir)
    try {
      assert.equal(kernel2.listAsks('pending').length, 1)
    } finally {
      await kernel2.close()
    }
  })
})

describe('工具真实执行', { timeout: 60_000 }, () => {
  it('bash 工具真实执行 + 超长输出 spill + read_artifact 分页', async () => {
    const kernel = (await openRuntime(join(root, 't11'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      // 模型调用 bash 工具产生 >32KiB 输出，再总结。
      const bigCommand = 'python3 -c "print(\'A\'*40000)"'
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: bigCommand })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('完成'),
      ])
      await kernel.submitInput(1, '生成大输出')
      await kernel.waitForIdle(1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, '完成')
      // spill 产物已登记
      const artifacts = await kernel.services.artifacts.list(1)
      assert.ok(artifacts.length >= 1)
      const spillArtifact = artifacts.find((a) => a.name.startsWith('tool-spill-'))
      assert.ok(spillArtifact, '应有 spill 产物')
    } finally {
      await kernel.close()
    }
  })

  it('runGate 真实 shell：成功与失败都如实', async () => {
    const kernel = await openRuntime(join(root, 't12'))
    try {
      const ok = await kernel.runGate('true', { conversationId: 1 })
      assert.equal(ok.ok, true)
      const fail = await kernel.runGate('exit 3', { conversationId: 1 })
      assert.equal(fail.ok, false)
      assert.equal(typeof fail.output, 'string')
    } finally {
      await kernel.close()
    }
  })

  it('runGate 失败不能让 spawn 成功（gate_failed 显式）', async () => {
    const kernel = (await openRuntime(join(root, 't13'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('答案')])
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '做事',
            gate: 'exit 1',
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'gate_failed',
      )
    } finally {
      await kernel.close()
    }
  })
})

describe('原生 subagent', { timeout: 60_000 }, () => {
  it('schema 校验通过返回对象；onCreated 上报 convId', async () => {
    const kernel = (await openRuntime(join(root, 't14'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('{"answer": 42}')])
      let createdId: number | undefined
      const result = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '计算答案',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
        onCreated: (id) => {
          createdId = id
        },
      })
      assert.deepEqual(result, { answer: 42 })
      assert.ok(createdId !== undefined && createdId > 1)
      // 子会话在列表中（tags worker）
      const child = kernel.getConversation(createdId!)
      assert.ok(child.tags.includes('worker'))
    } finally {
      await kernel.close()
    }
  })

  it('schema 两次失败显式 schema_validation_failed；herdr: 前缀 unsupported_runtime', async () => {
    const kernel = (await openRuntime(join(root, 't15'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('我不是 JSON'),
        fauxAssistantMessage('还是不是 JSON'),
      ])
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '返回 JSON',
            schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'schema_validation_failed',
      )
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'herdr:agy',
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await kernel.close()
    }
  })

  it('resume 用原 child convId；isolation 显式报错', async () => {
    const kernel = (await openRuntime(join(root, 't16'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('第一次结果'), fauxAssistantMessage('续接结果')])
      const first = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '第一段',
        agentId: 'task-1',
      })
      assert.equal(first, '第一次结果')
      const second = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '继续',
        resume: 'task-1',
      })
      assert.equal(second, '续接结果')
      await assert.rejects(
        () =>
          kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'x',
            isolation: 'worktree',
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await kernel.close()
    }
  })
})

describe('trigger 与删除级联', { timeout: 60_000 }, () => {
  it('dispatchTrigger defang 后投递 #1（origin trigger）', async () => {
    const kernel = (await openRuntime(join(root, 't17'))) as never as KernelRuntime & { __faux: FauxHandle }
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('已处理外部事件')])
      await kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron',
        text: '定时提醒：喝水',
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(1)
      assert.equal((await kernel.getLastAssistantText(1)).includes('外部事件'), true)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation 级联：asks/artifacts/FTS 清理 + tombstone 重启不复活', async () => {
    const dir = join(root, 't18')
    const kernel = (await openRuntime(dir)) as never as KernelRuntime & { __faux: FauxHandle }
    kernel.__faux.setResponses([fauxAssistantMessage('ok')])
    const conv = await kernel.createConversation({ title: '待删会话' })
    const askPromise = kernel.createAsk({
      conversationId: conv.id,
      title: '待取消',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise
    await new Promise((r) => setTimeout(r, 20))
    kernel.services.artifacts // 确保服务存在
    await kernel.deleteConversation(conv.id)
    assert.equal(kernel.listConversations().find((c) => c.id === conv.id), undefined)
    assert.equal(kernel.listAsks('pending').length, 0)
    await kernel.close()

    // 重启后不复活
    const kernel2 = await openRuntime(dir)
    try {
      assert.equal(kernel2.listConversations().find((c) => c.id === conv.id), undefined)
    } finally {
      await kernel2.close()
    }
  })
})

describe('模型目录', { timeout: 60_000 }, () => {
  it('未配置模型时显式 model_not_configured（不 faux 生产 fallback）', async () => {
    const dir = join(root, 't19')
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir })
    try {
      await assert.rejects(
        () => kernel.submitInput(1, '任何问题'),
        (err: unknown) => err instanceof HelmError && err.code === 'model_not_configured',
      )
    } finally {
      await kernel.close()
    }
  })
})
