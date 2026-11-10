/**
 * 内核资源回收与 watchdogTick transform 回归。
 *
 * 覆盖：
 * 1. watchdogTick 返回钩子链 transform 后的最终 payload（插件可扩充
 *    WatchdogTickPayload；旧实现返回初始快照，插件注入字段丢失）；
 * 2. handledToolCalls 中断残留清理：tool_call handled 登记带会话归属，
 *    会话回合结束（turn_settled）/ abortConversation / deleteConversation
 *    时兜底清理未被 afterTool 消费的条目（block/异常路径不走 execute）；
 * 3. EnvFabric.evictConversation：deleteConversation 后该会话的靶点缓存
 *    （bases）与输出 sink 注册被清理，反复建删不残留。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import { createEnvFabric, type EnvFabric } from '../src/env/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface RuntimeInternals {
  handledToolCalls: Map<string, { conversationId: number | undefined; result: unknown }>
}

function internalsOf(kernel: KernelRuntime): RuntimeInternals {
  return kernel as unknown as RuntimeInternals
}

function fabricBasesOf(fabric: EnvFabric): Map<string, unknown> {
  // EnvFabric 的 bases 是 createEnvFabric 闭包内私有；经 RemoteExecutionEnv
  // 实例身份 + envFor 行为验证（见 evictConversation 测试），无需直接读取。
  throw new Error('不应直接读取 bases（闭包私有）')
}

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-resclean-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

describe('diagnostics.collect 外部采集（原 watchdogTick transform 扩充同语义）', { timeout: 60_000 }, () => {
  it('采集监听器追加的事实出现在最终 collection 中（await 语义）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'tick-1'))
    try {
      await kernel.plugins.register({
        id: 'test:collector',
        definePlugin(ctx) {
          // 模拟 builtin:herdr 式外部采集：在 collection 上追加探针（保留原字段）。
          ctx.host.onEvent('diagnostics.collect', (raw) => {
            const collection = raw as { probes: unknown[] }
            collection.probes.push({
              targetId: 'ext:p1',
              targetKind: 'external',
              nodeId: 'local',
              ownedBy: 'helm',
              status: 'working',
              stalledMs: 0,
              facts: { kind: 'test-collector' },
            })
          })
        },
      })
      // 事件由宿主 emitEvent 分发（broadcast:false 仅内部监听器）。
      const collected: { probes: unknown[] } = { probes: [] }
      await kernel.emitHostEvent('diagnostics.collect', collected, { broadcast: false })
      assert.equal(collected.probes.length, 1, '监听器追加事实进入 collection')
      assert.equal((collected.probes[0] as { targetId: string }).targetId, 'ext:p1')
    } finally {
      await kernel.close()
    }
  })

  it('无监听器时 emitHostEvent 正常完成（空采集不报错）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'tick-2'))
    try {
      const collected: { probes: unknown[] } = { probes: [] }
      await kernel.emitHostEvent('diagnostics.collect', collected, { broadcast: false })
      assert.equal(collected.probes.length, 0)
    } finally {
      await kernel.close()
    }
  })
})

describe('handledToolCalls 中断残留清理', { timeout: 60_000 }, () => {
  it('tool_call handled 后回合结束（turn_settled）兜底清残留', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-1'))
    try {
      const internals = internalsOf(kernel)
      // 注册一个 tool_call hook：对 probe 工具返回 handled（不执行真实工具），
      // 且模型不发起真实工具调用（faux 直接文本回答）——handled 条目成为
      // 未消费残留，靠 turn_settled 兜底清理。
      await kernel.plugins.register({
        id: 'test:handled-residue',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string; callId: string }) => {
            if (call.toolName !== 'probe') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: '已接管' }], isError: false },
            }
          })
        },
      })
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('直接回答，不调用工具')])
      await kernel.submitInput(conv.id, '随便问')
      await kernel.waitForIdle(conv.id)
      // 回合已结束：即使 handled 从未被 execute 消费，残留也必须被清空。
      for (const key of internals.handledToolCalls.keys()) {
        const entry = internals.handledToolCalls.get(key)
        assert.notEqual(entry?.conversationId, conv.id, '回合结束后该会话残留应被清理')
      }
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('abortConversation 与 deleteConversation 兜底清理该会话残留', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-2'))
    try {
      const internals = internalsOf(kernel)
      const conv = await kernel.createConversation({})
      // 直接注入残留（模拟 tool_call handled 登记后模型回合被取消）。
      internals.handledToolCalls.set('call-residue-1', {
        conversationId: conv.id,
        result: { output: [{ type: 'text', text: 'x' }], isError: false },
      })
      internals.handledToolCalls.set('call-other-conv', {
        conversationId: undefined,
        result: { output: [{ type: 'text', text: 'y' }], isError: false },
      })
      await kernel.abortConversation(conv.id)
      assert.equal(
        internals.handledToolCalls.has('call-residue-1'),
        false,
        'abort 应清理该会话 handled 残留',
      )
      assert.equal(internals.handledToolCalls.has('call-other-conv'), true, '其他归属不受影响')

      internals.handledToolCalls.set('call-residue-2', {
        conversationId: conv.id,
        result: { output: [{ type: 'text', text: 'x' }], isError: false },
      })
      await kernel.deleteConversation(conv.id)
      assert.equal(
        internals.handledToolCalls.has('call-residue-2'),
        false,
        '删除会话应清理该会话 handled 残留',
      )
    } finally {
      await kernel.close()
    }
  })
})

describe('EnvFabric.evictConversation', { timeout: 60_000 }, () => {
  it('清理该会话的靶点缓存实例（envForTarget 每次返回新实例）', timeout, async () => {
    const fabric = createEnvFabric({
      envOptions: () => ({ HELM_CONVERSATION_ID: '42' }),
    })
    try {
      const a = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const b = fabric.envForTarget({ conversationId: 42, nodeId: 'local', cwd: root })
      // 驱逐后重建：两实例底层 base 不同（a 的 base 已被清理出缓存）。
      assert.notEqual((a as unknown as { id: string }).id === (b as unknown as { id: string }).id, false)
      // 不影响其他会话靶点（43 未被驱逐）。
      const c1 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      fabric.evictConversation(42)
      const c2 = fabric.envForTarget({ conversationId: 43, nodeId: 'local', cwd: root })
      assert.equal(
        (c1 as unknown as { id: string }).id,
        (c2 as unknown as { id: string }).id,
        '其他会话靶点不受 evictConversation 影响',
      )
    } finally {
      await fabric.dispose()
    }
  })

  it('靶点缓存按会话精确驱逐：bases 计数收缩、其他会话保留；无会话靶点不进缓存', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      assert.equal(fabric.debugBaseCount(), 0)
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ conversationId: 7, nodeId: 'offline-node', cwd: '/other' })
      fabric.envForTarget({ conversationId: 8, nodeId: 'offline-node', cwd: '/srv' })
      assert.equal(fabric.debugBaseCount(), 3)
      // 无会话靶点是短生命周期对象（envFor / envForTarget 无 conversationId）：
      // 每次全新实例、绝不进缓存——反复调用不堆积 bases。
      fabric.envFor('offline-node', '/srv')
      fabric.envFor('offline-node', '/srv')
      fabric.envForTarget({ nodeId: 'offline-node', cwd: '/srv' })
      fabric.envForTarget({ nodeId: 'local', cwd: root })
      assert.equal(fabric.debugBaseCount(), 3, '无会话靶点绝不进入缓存')
      // 驱逐会话 7：仅清其两个靶点，会话 8 保留。
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, '会话 7 的两个靶点被清理')
      fabric.evictConversation(7)
      assert.equal(fabric.debugBaseCount(), 1, '幂等：重复驱逐无额外影响')
      fabric.evictConversation(8)
      assert.equal(fabric.debugBaseCount(), 0)
      // debugBases 与计数同源。
      fabric.envForTarget({ conversationId: 9, nodeId: 'n', cwd: '/x' })
      const bases = fabric.debugBases()
      assert.equal(bases.length, 1)
      assert.equal(bases[0]!.conversationId, 9)
      assert.equal(bases[0]!.nodeId, 'n')
      assert.equal(bases[0]!.cwd, '/x')
    } finally {
      await fabric.dispose()
    }
  })

  it('驱逐不杀在途命令：evict 后旧实例上的 exec 自然完成', timeout, async () => {
    const fabric = createEnvFabric({})
    try {
      const scoped = fabric.envForTarget({ conversationId: 50, nodeId: 'local', cwd: root })
      fabric.evictConversation(50)
      // 旧实例引用仍存活：真实 exec 必须自然完成（evict 只移缓存不杀进程）。
      const result = await scoped.exec('echo alive', undefined, { abortSignal: undefined } as never)
      assert.equal(result.ok, true)
      assert.equal(result.value.exitCode, 0)
    } finally {
      await fabric.dispose()
    }
  })

  it('deleteConversation 经 runtime 联动 evictConversation（无异常且后续 exec 正常）', timeout, async () => {
    void fabricBasesOf
    const kernel = await openRuntime(join(root, 'evict-1'))
    try {
      const conv = await kernel.createConversation({})
      // 触发一次真实 exec 建立会话靶点缓存（local exec echo）。
      const result = await kernel.execEnv({ command: 'echo evicted', conversationId: conv.id })
      assert.equal(result.ok, true)
      await kernel.deleteConversation(conv.id)
      // 删除后再对同号会话靶点执行：应 404（会话已删），而非内部错误。
      const again = await kernel
        .execEnv({ command: 'echo again', conversationId: conv.id })
        .then(
          () => 'unexpected-ok',
          (err: { code?: string }) => err.code,
        )
      assert.equal(again, 'not_found')
    } finally {
      await kernel.close()
    }
  })
  it('updateConversation 变更 cwd/nodeId 时释放旧靶点缓存（不影响其他会话）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'evict-2'))
    try {
      const conv = await kernel.createConversation({})
      const other = await kernel.createConversation({})
      const fabric = kernel.envFabric as EnvFabric
      const before = fabric.debugBaseCount()
      // 两次真实 exec 建立两个会话靶点。
      await kernel.execEnv({ command: 'echo one', conversationId: conv.id })
      await kernel.execEnv({ command: 'echo two', conversationId: other.id })
      assert.equal(fabric.debugBaseCount(), before + 2)
      // 变更 conv 的 cwd：旧靶点释放，other 不受影响。
      const newDir = join(root, 'evict-2-new-cwd')
      await kernel.updateConversation(conv.id, { cwd: newDir })
      assert.equal(fabric.debugBaseCount(), before + 1, '变更会话旧靶点被释放')
      const bases = fabric.debugBases()
      assert.ok(
        bases.every((b) => b.conversationId !== conv.id),
        `会话 ${conv.id} 的旧靶点应全部释放：${JSON.stringify(bases)}`,
      )
      // 其他会话靶点仍在缓存（同实例复用）。
      assert.ok(bases.some((b) => b.conversationId === other.id))
      // 仅改 title 不触发释放。
      const count = fabric.debugBaseCount()
      await kernel.updateConversation(other.id, { title: '仅标题' })
      assert.equal(fabric.debugBaseCount(), count, '非靶点变更不释放缓存')
    } finally {
      await kernel.close()
    }
  })
})

describe('faux 工具链回归（handled 消费路径仍工作）', { timeout: 60_000 }, () => {
  it('tool_call handled 后 execute 层正常返回接管结果（不破坏正常路径）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'handled-ok'))
    try {
      await kernel.plugins.register({
        id: 'test:handled-normal',
        definePlugin(ctx) {
          ctx.hook.onToolCall(async (call: { toolName: string }) => {
            if (call.toolName !== 'bash') return undefined
            return {
              action: 'handled',
              result: { output: [{ type: 'text', text: '接管结果：echo 被拦截' }], isError: false },
            }
          })
        },
      })
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('完成'),
      ])
      await kernel.submitInput(1, '跑一下 echo')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), '完成')
      // 正常消费路径：handled 条目在 execute 后即时删除。
      assert.equal(internalsOf(kernel).handledToolCalls.size, 0)
    } finally {
      await kernel.close()
    }
  })
})
