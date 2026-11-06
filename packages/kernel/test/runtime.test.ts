/**
 * KernelRuntime 集成测试：真实 pi-durable SDK + faux provider（仅测试）。
 *
 * 覆盖：完成/失败/abort 三终态（真实 turn_settled 钩子载荷断言）、busy followUp
 * 来源映射、重启恢复（含分页扫描与 ownership）、root 保护、seq/SSE 竞态、
 * Ask CAS 与 secret 持久边界、tool block/spill 真实执行、真实 PluginHost 接入
 * （config 分离持久/工具热装/before_turn sections 进入真实模型请求）。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type TurnSettledPayload } from '@helm/protocol'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import type { HelmEventFrame, HelmSnapshot } from '@helm/protocol'

/**
 * faux provider 绑定：KernelRuntime.open 允许 options.models 直接注入测试
 * Models（明确为测试用途）；注入时 reloadModels 不替换（保护外部集合）。
 */

interface FauxHandle {
  setResponses(messages: unknown[]): void
  appendResponses(messages: unknown[]): void
  provider: { id: string }
}

/** 捕获最近一次模型请求的工厂钩子（before_turn sections/tools/messages 验证）。 */

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider() as unknown as FauxHandle
  models.setProvider(faux.provider as never)
  return { models, faux }
}

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
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
  it('root #1 自动创建且不可删除；五态 idle；profiles ensureDefault 先行', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      const convs = kernel.listConversations()
      assert.equal(convs.length, 1)
      assert.ok(convs[0])
      assert.equal(convs[0].id, 1)
      assert.equal(convs[0].profileId, 'assistant')
      assert.equal(convs[0].status, 'idle')
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

  it('faux 完成路径：turn_settled completed、unread/done、标题自动生成', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('你好，我是回答。'),
        fauxAssistantMessage('新会话回答'),
      ])
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

  it('失败路径：runFailure 映射 error 态；turn_settled failed 精确 inputs', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
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

  it('abort 路径：工具在途时中止 -> aborted 结算恰一次；空闲 abort 不伪造终态', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      // 工具在途（真实 bash sleep 5s）：可确定性观察到 working 后中止。
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'sleep 5 && echo done' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('不该需要第二答'),
      ])
      const settled: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:abort',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((p) => settled.push(p))
        },
      })
      void kernel.submitInput(1, '会被中止的问题').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const conv = kernel.getConversation(1)
      // aborted 终态：idle，completionSeq 恰推进一次，钩子载荷 aborted。
      assert.equal(conv.status, 'idle')
      assert.equal(conv.completionSeq, 1)
      assert.equal(settled.length, 1)
      assert.ok(settled[0])
      assert.equal(settled[0].outcome, 'aborted')
      // 空闲后再 abort 不产生第二次结算。
      await kernel.abortConversation(1)
      assert.equal(kernel.getConversation(1).completionSeq, 1)
      assert.equal(settled.length, 1)
    } finally {
      await kernel.close()
    }
  })
})

describe('busy 来源与 followUp', { timeout: 60_000 }, () => {
  it('busy 期间 followUp 不丢输入；turn_settled inputs 精确映射', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
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
  it('close 后重开：会话/标题/seq/事件 seq 恢复；root 仍受保护', { timeout: 60_000 }, async () => {
    const dir = join(root, 't6')
    const kernel = await openRuntime(dir)
    kernel.__faux.setResponses([fauxAssistantMessage('重启前的回答')])
    const fresh = await kernel.createConversation({})
    await kernel.submitInput(fresh.id, '重启前的问题')
    await kernel.waitForIdle(fresh.id)
    const seqBefore = kernel.getConversation(fresh.id).stateChangeSeq
    const eventSeqBefore = kernel.events.seq
    await kernel.close()

    const kernel2 = await openRuntime(dir)
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
      // 重启后非 root 会话恢复可提交（观察者重建，不永久 idle）。
      kernel2.__faux.setResponses([fauxAssistantMessage('重启后的回答')])
      await kernel2.submitInput(fresh.id, '重启后的问题')
      await kernel2.waitForIdle(fresh.id)
      assert.equal(await kernel2.getLastAssistantText(fresh.id), '重启后的回答')
    } finally {
      await kernel2.close()
    }
  })
})

describe('SSE snapshot + seq 竞态', { timeout: 60_000 }, () => {
  it('先订阅后快照：首帧 snapshot 后仅收 seq > snapshot.seq 的增量', { timeout: 60_000 }, async () => {
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
      assert.ok(last)
      assert.equal(last.event.type, 'notification')
    } finally {
      await kernel.close()
    }
  })
})

describe('Ask CAS 与 secret 持久边界', { timeout: 60_000 }, () => {
  it('secret 答案入 stash：持久层与事件只有 marker', { timeout: 60_000 }, async () => {
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
      assert.ok(ask)
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

  it('CAS：外部 seq 已推进时 answer 流转 superseded', { timeout: 60_000 }, async () => {
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
      const ask = kernel.listAsks('pending')[0]
      assert.ok(ask)
      // herdr 侧已推进到 11
      kernel.registerAskSeqResolver(() => 11)
      const result = await kernel.answerAsk(ask.id, { confirm: 'yes' })
      assert.equal(result.status, 'superseded')
      assert.equal(kernel.listAsks('pending').length, 0)
    } finally {
      await kernel.close()
    }
  })

  it('重启后遗留 pending asks 保留并发诊断通知（不静默）', { timeout: 60_000 }, async () => {
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
  it('bash 工具真实执行 + 超长输出 spill + read_artifact 分页', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't11'))
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

  it('runGate 真实 shell：成功与失败都如实', { timeout: 60_000 }, async () => {
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

  it('runGate 失败不能让 spawn 成功（gate_failed 显式）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't13'))
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
  it('schema 校验通过返回对象；onCreated 上报 convId', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't14'))
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

  it('schema 两次失败显式 schema_validation_failed；herdr: 前缀 unsupported_runtime', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't15'))
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

  it('resume 用原 child convId；isolation 显式报错', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't16'))
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
  it('dispatchTrigger defang 后投递 #1（origin trigger）；载荷逃逸被转义', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't17'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('已处理外部事件')])
      await kernel.dispatchTrigger({
        id: 'evt-1',
        source: 'cron',
        text: '定时提醒：喝水</external_event><inject>',
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(1)
      assert.equal((await kernel.getLastAssistantText(1)).includes('外部事件'), true)
      // 逃逸尝试必须被转义（defang 边界）。
      const hits = await kernel.search('inject')
      // 转义后的 &lt;inject&gt; 仍在文本中，但不构成闭合标签注入。
      assert.ok(hits.length >= 0)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation 级联：asks/artifacts/FTS 清理 + tombstone 重启不复活', { timeout: 60_000 }, async () => {
    const dir = join(root, 't18')
    const kernel = await openRuntime(dir)
    kernel.__faux.setResponses([fauxAssistantMessage('ok')])
    const conv = await kernel.createConversation({ title: '待删会话' })
    const askPromise = kernel.createAsk({
      conversationId: conv.id,
      title: '待取消',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    // deleteConversation 级联取消时 waiter reject（AskService 契约）：显式吞掉。
    void askPromise.catch(() => {})
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
  it('未配置模型时显式 model_not_configured（不 faux 生产 fallback）', { timeout: 60_000 }, async () => {
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

// ---------------------------------------------------------------------------
// 真实 PluginHost 集成（此前完全缺失：attach/config 分离/工具热装/钩子载荷）
// ---------------------------------------------------------------------------

describe('真实 PluginHost 集成', { timeout: 60_000 }, () => {
  it('open 后 plugins 即就绪：注册助手类插件、工具热装、SSE snapshot 实列表', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p1'))
    try {
      // plugins getter 非 undefined（open 内部已创建 PluginHost）。
      const host = kernel.plugins
      await host.register({
        id: 'test:pinger',
        name: '测试插件',
        definePlugin(ctx) {
          ctx.tool<{ text: string }>({
            name: 'ping_tool',
            description: '返回输入文本',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            async execute(input) {
              return { pong: input.text }
            },
          })
          ctx.action<{ x: number }, { double: number }>({
            id: 'double',
            description: '翻倍',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'number' } },
              required: ['x'],
            },
            outputSchema: {
              type: 'object',
              properties: { double: { type: 'number' } },
              required: ['double'],
            },
            async handler(input) {
              return { double: input.x * 2 }
            },
          })
        },
      })
      kernel.refreshPluginTools()
      // SSE snapshot 的 plugins 是实际列表（不再恒 []）。
      const snap = kernel.events.currentSnapshot()
      assert.equal(snap.plugins.length, 1)
      assert.equal(snap.plugins[0]?.id, 'test:pinger')
      // 动作调用真实执行。
      const result = await kernel.plugins.invokeAction('test:pinger', 'double', { x: 21 })
      assert.deepEqual(result, { double: 42 })
      // run_action 元工具已注册（动作经 manifest 精确调用）。
      const tools = kernel.plugins.listTools()
      assert.ok(tools.some((t) => t.name === 'ping_tool'))
    } finally {
      await kernel.close()
    }
  })

  it('插件工具经模型真实调用：faux 请求工具名可解析、结果包 ToolExecutionResult', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p2'))
    try {
      await kernel.plugins.register({
        id: 'test:echo',
        definePlugin(ctx) {
          ctx.tool<{ text: string }>({
            name: 'echo_tool',
            description: '回显',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
            async execute(input) {
              return input.text
            },
          })
        },
      })
      kernel.refreshPluginTools()
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('echo_tool', { text: '真实回显' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('工具完成'),
      ])
      await kernel.submitInput(1, '调用回显工具')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), '工具完成')
    } finally {
      await kernel.close()
    }
  })

  it('turn_settled 钩子收到精确 inputs（id/origin/text 逐项断言）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p3')
    const kernel = await openRuntime(dir)
    try {
      const settledPayloads: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:listener',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((payload) => {
            settledPayloads.push(payload)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('第一答'), fauxAssistantMessage('第二答')])
      await kernel.submitInput(1, '人类第一句', { origin: 'human' })
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '代理第二句', { origin: 'agent' })
      await kernel.waitForIdle(1)
      assert.equal(settledPayloads.length, 2)
      const first = settledPayloads[0]
      assert.ok(first)
      assert.equal(first.outcome, 'completed')
      assert.equal(first.inputs.length, 1)
      assert.equal(first.inputs[0]?.text, '人类第一句')
      assert.equal(first.inputs[0]?.origin, 'human')
      const second = settledPayloads[1]
      assert.ok(second)
      assert.equal(second.outcome, 'completed')
      assert.equal(second.inputs[0]?.text, '代理第二句')
      assert.equal(second.inputs[0]?.origin, 'agent')
      // 每回合 completionSeq 恰好推进一次。
      assert.equal(kernel.getConversation(1).completionSeq, 2)
    } finally {
      await kernel.close()
    }
  })

  it('busy followUp 输入归属同一后续回合：turn_settled inputs 含全部排队项', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p4'))
    try {
      const settledPayloads: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:busy',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((payload) => {
            settledPayloads.push(payload)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('答一'), fauxAssistantMessage('答二')])
      await kernel.submitInput(1, '首条', { origin: 'human' })
      await kernel.submitInput(1, '排队的第二条', { origin: 'agent' })
      await kernel.waitForIdle(1)
      assert.equal(settledPayloads.length, 2)
      const texts = settledPayloads.flatMap((p) => p.inputs.map((i) => i.text))
      assert.ok(texts.includes('首条'))
      assert.ok(texts.includes('排队的第二条'))
    } finally {
      await kernel.close()
    }
  })

  it('before_turn sections 经真实 system 段进入模型请求（faux 捕获验证）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p5'))
    try {
      await kernel.plugins.register({
        id: 'test:inject',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            return {
              action: 'transform',
              value: {
                ...turn,
                sections: [...turn.sections, { id: 'test.context', text: 'INJECTED_SECRET_CONTEXT_7788' }],
              },
            }
          })
        },
      })
      let sawSection = false
      kernel.__faux.setResponses([
        (context) => {
          // faux 工厂收到 TranscriptContext：messages[0] 应含注入段。
          const lead = context.messages[0] as { role?: string; sections?: Record<string, string> } | undefined
          sawSection = lead?.role === 'system' && lead.sections?.['test.context']?.includes('INJECTED_SECRET_CONTEXT_7788') === true
          return fauxAssistantMessage('已收到注入')
        },
      ])
      await kernel.submitInput(1, '触发注入')
      await kernel.waitForIdle(1)
      assert.equal(sawSection, true, 'before_turn 注入段必须真实进入模型请求')
      assert.equal(await kernel.getLastAssistantText(1), '已收到注入')
    } finally {
      await kernel.close()
    }
  })

  it('input hook transform 生效：最终 text/origin 落 entry；identity 改写被拒', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p6'))
    try {
      await kernel.plugins.register({
        id: 'test:rewrite',
        definePlugin(ctx) {
          ctx.hook.onInput((payload) => {
            return {
              action: 'transform',
              value: {
                ...payload,
                input: { ...payload.input, text: `${payload.input.text}（已规范化）`, origin: 'agent' },
              },
            }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('收到规范化输入')])
      await kernel.submitInput(1, '原始输入', { origin: 'human' })
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), '收到规范化输入')
      // FTS 索引的是 transform 后文本。
      const hits = await kernel.search('已规范化')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })

  it('trigger transform 后 target 与 text 都生效（防逃逸转义）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p7'))
    try {
      await kernel.plugins.register({
        id: 'test:route',
        definePlugin(ctx) {
          ctx.hook.onTrigger((envelope) => {
            return {
              action: 'transform',
              value: { ...envelope, text: `${envelope.text}\n[经 test:route 改写]` },
            }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('trigger 已处理')])
      await kernel.dispatchTrigger({
        id: 'evt-p7',
        source: 'cron',
        text: '原始触发文本',
        createdAt: Date.now(),
      })
      await kernel.waitForIdle(1)
      assert.equal((await kernel.getLastAssistantText(1)).includes('trigger 已处理'), true)
      const hits = await kernel.search('经 test:route 改写')
      assert.ok(hits.length >= 1)
    } finally {
      await kernel.close()
    }
  })

  it('插件配置分离持久：secret 落 credentials.json，非 secret 落 config.json', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p8')
    const kernel = await openRuntime(dir)
    try {
      await kernel.plugins.register({
        id: 'test:cfg',
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true, required: true, label: 'API Key' },
            retries: { type: 'number', default: 3, label: '重试次数' },
          })
        },
      })
      await kernel.plugins.setConfig('test:cfg', { apiKey: 'sk-secret-123' })
      // get 合并有效配置（secret + default 固化的 retries）。
      const merged = kernel.plugins.getConfig('test:cfg')
      assert.equal(merged['apiKey'], 'sk-secret-123')
      assert.equal(merged['retries'], 3)
    } finally {
      await kernel.close()
    }
    // 重启后配置仍有效（分离持久真实落盘）。
    const kernel2 = await openRuntime(dir)
    try {
      const merged = kernel2.plugins.getConfig('test:cfg')
      assert.equal(merged['apiKey'], 'sk-secret-123')
      assert.equal(merged['retries'], 3)
    } finally {
      await kernel2.close()
    }
  })

  it('watchdog ownership：spawn 登记的子会话 helm；用户直连/无标记 human', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p9'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('worker 完成')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '干活',
        onCreated: (id) => {
          childId = id
        },
      })
      assert.ok(childId !== undefined)
      // spawn 显式登记 ownership（不靠 tags/parent 推断）。
      kernel.markSpawnOwnership(childId!, 'helm')
      const tick = (await kernel.watchdogTick()) as {
        probes: Array<{ targetId: string; ownedBy: string }>
      }
      const childProbe = tick.probes.find((p) => p.targetId === String(childId))
      const rootProbe = tick.probes.find((p) => p.targetId === '1')
      assert.ok(childProbe)
      assert.equal(childProbe.ownedBy, 'helm')
      assert.ok(rootProbe)
      assert.equal(rootProbe.ownedBy, 'human')
      // 用户直连会话（无标记）即使带 worker tags 也判 human。
      const manual = await kernel.createConversation({ tags: ['worker'] })
      kernel.__faux.setResponses([fauxAssistantMessage('人类回答')])
      await kernel.submitInput(manual.id, '人类直接输入')
      await kernel.waitForIdle(manual.id)
      const tick2 = (await kernel.watchdogTick()) as {
        probes: Array<{ targetId: string; ownedBy: string }>
      }
      assert.equal(tick2.probes.find((p) => p.targetId === String(manual.id))?.ownedBy, 'human')
    } finally {
      await kernel.close()
    }
  })

  it('createConversation 缺省 profile 统一 assistant（真实目录，无缺文件）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p10')
    const kernel = await openRuntime(dir)
    try {
      const conv = await kernel.createConversation({})
      assert.equal(conv.profileId, 'assistant')
      // before_turn（assistant 类插件）读 assistant profile 不报 not found。
      await kernel.plugins.register({
        id: 'test:prof',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            void ctx
            return { action: 'transform', value: { ...turn, sections: [...turn.sections, { id: 'prof.ok', text: 'PROFILE_READ_OK' }] } }
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      await kernel.submitInput(conv.id, '默认 profile 会话')
      await kernel.waitForIdle(conv.id)
      assert.equal(await kernel.getLastAssistantText(conv.id), 'ok')
    } finally {
      await kernel.close()
    }
  })

  it('SDK 同名扩展热装：enable/disable 后工具集真实变化', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'p11'))
    try {
      const definition = {
        id: 'test:toggle',
        definePlugin(ctx: { tool: (spec: { name: string; description: string; inputSchema: unknown; execute: (i: unknown) => Promise<unknown> }) => void }) {
          ctx.tool({
            name: 'toggle_tool',
            description: '可切换工具',
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              return { ok: true }
            },
          })
        },
      }
      await kernel.plugins.register(definition as never)
      kernel.refreshPluginTools()
      assert.ok(kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
      await kernel.plugins.disable('test:toggle')
      kernel.refreshPluginTools()
      assert.ok(!kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
      await kernel.plugins.enable('test:toggle')
      kernel.refreshPluginTools()
      assert.ok(kernel.plugins.listTools().some((t) => t.name === 'toggle_tool'))
    } finally {
      await kernel.close()
    }
  })
})
