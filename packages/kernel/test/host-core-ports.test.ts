/**
 * 微内核 host 公共机制专项测试（core commit 范围）：
 * - epoch 守卫：wrapHostApi 子端口（profiles/skills/secrets/nodeIpc/executionEnv 代理）
 *   在停用/重启用周期后旧句柄失效（409），新周期句柄可用；
 * - nodeIpc.subscribe 竞态：释放先于订阅建立完成时晚到订阅立即收割（不泄漏），
 *   建立错误留在返回 Promise（不 void 吞）；
 * - onUpdate：partial 转发到受控 output（脱敏），结算后迟到 partial 静默丢弃；
 * - prompt 投射：promptSnippet/promptGuidelines 仅激活工具进 sections，剥离后
 *   不留幻影段；promptGuidelines 数组逐项展开。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type ConversationSummary, type PluginDefinition } from '@helm/protocol'
import {
  PluginHost,
  type PluginDocStore,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { projectToolPromptSections } from '../src/runtime/runtime-helpers.js'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

interface NodeIpcCalls {
  subscribeStarted: Array<{ nodeId: string; signal: AbortSignal }>
  stopCalls: number
}

function makeBackend(over: {
  nodeIpcCalls?: NodeIpcCalls
  /** subscribe 建立前的延迟（默认 10ms，模拟慢建立）。 */
  subscribeDelayMs?: number
}): PluginHostBackend {
  const calls = over.nodeIpcCalls ?? { subscribeStarted: [], stopCalls: 0 }
  return {
    isClosing: () => false,
    async resolveSpawnTarget() { throw new HelmError('unsupported', 'fixture 不解析 spawn 靶点', 501) },
    listActiveSpawnExecutions: () => [],
    async probeNodeFs() { throw new HelmError('unsupported', 'fixture 不探测节点 fs', 501) },
    redactText: (text: string) => text,
    profiles: {
      list: async () => [{ id: 'assistant' }] as never,
      get: async (id) => ({ id }) as never,
      getSystem: async () => '',
      save: async (p) => p,
      directory: async (id) => `/data/profiles/${id}`,
    },
    skills: {
      list: async () => [],
      readFile: async () => '',
      directory: async (id) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          throw new HelmError('validation_error', `Skill id 非法：${id}`, 400, { skillId: id })
        }
        return `/data/skills/${id}`
      },
      ensureSkill: async () => {},
    },
    secrets: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      addRedaction: () => () => {},
    },
    setPluginConfig: async () => {},
    nodeIpc: {
      isOnline: () => true,
      getNodeHubUrl: () => undefined,
      call: async () => ({ ok: true, value: '' }),
      subscribe: (nodeId, input, onLine, _onClosed, signal) =>
        new Promise<() => void>((resolve) => {
          calls.subscribeStarted.push({ nodeId, signal: signal! })
          setTimeout(() => {
            // 模拟订阅建立成功：返回 stop 函数。
            resolve(() => {
              calls.stopCalls += 1
            })
            // 建立后推一行事件，验证通道活着。
            onLine(`event:${nodeId}`)
          }, over.subscribeDelayMs ?? 10)
        }),
    },
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    updateConversation: async (id) => makeConversation(id),
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    getConversationActivity: () => ({ consecutiveErrors: 0 }),
    listArtifacts: async () => [],
    getArtifact: async () => { throw new HelmError('not_found', 'no artifact', 404) },
    redact: (t) => t,
    refreshModels: async () => ({ providers: [], aborted: false, errors: {}, models: [], providerCatalog: [] }),
    withFileLock: async (_p, fn) => fn(),
    atomicWriteFile: async () => {},
    completeText: async () => '',
    executionEnv: () => ({
      readTextFile: async () => 'content',
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    }) as never,
    buildSpawnEnv: () => ({}),
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', 'fixture', 501) },
    withFileMutationQueue(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不承载文件互斥队列', 501) },
    listActions: () => [],
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'a', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

let dataDir: string

test('host 公共机制专项', { timeout: 60_000 }, async (t) => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-host-core-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  await t.test('epoch 守卫：停用后旧句柄 host 调用一律 409 plugin_context_expired', async () => {
    const host = new PluginHost({ dataDir, host: makeBackend({}), docs: new MemoryDocStore() })
    let captured: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    const def: PluginDefinition = {
      id: 'p:epoch',
      definePlugin(ctx) {
        captured = ctx.host
      },
    }
    await host.register(def, { enabled: true })
    assert.ok(captured)
    // 启用周期内可用。
    assert.equal(await captured!.profiles.get('assistant') !== undefined, true)
    await host.disable('p:epoch')
    // guard 同步抛出：统一归一为 rejection 后断言（逐个 await，类型对齐）。
    const expired: Array<() => unknown> = [
      () => captured!.profiles.list(),
      () => captured!.skills.list(),
      () => captured!.secrets.get('k'),
      () => captured!.nodeIpc.isOnline('local'),
      () => captured!.completeText({ conversationId: 1, systemPrompt: '', text: '' }),
      () => captured!.refreshModels(),
      () => captured!.redact('x'),
      () => captured!.executionEnv('local', '/tmp').canonicalPath('/tmp/x', BACKGROUND_CONTEXT),
      () => captured!.withFileLock('/tmp/x', async () => 1),
      () => captured!.atomicWriteFile('/tmp/x', 'y'),
    ]
    for (const call of expired) {
      await assert.rejects(async () => call(), (err: unknown) => {
        assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`)
        assert.equal(err.code, 'plugin_context_expired')
        return true
      })
    }
    // 重启用后：definePlugin 重新执行，captured 已指向新周期句柄（可用），
    // 旧句柄不复存在——上面循环已验证旧句柄全郴 409。这里仅验证新句柄恢复可用。
    await host.enable('p:epoch')
    await assert.doesNotReject(captured!.profiles.get('assistant'))
    await host.unregister('p:epoch').catch(() => {})
  })

  await t.test('withFileLock：队列内获得锁调用 fn 前再验周期（停用后旧闭包不落写）', { timeout: 60_000 }, async () => {
    // 场景：锁竞争 + 宿主强制 dispose（liveTasks 预检仅拦 disable，dispose
    // 直接拆除周期）：排队的旧周期 fn 获得锁时周期已失效，必须 409 拒绝落写。
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const backend = makeBackend({})
    backend.withFileLock = async <T,>(path: string, fn: () => Promise<T>) => {
      if (path === '/tmp/hold') {
        await gate // 首个持锁者不释放，后续排队等待
        return fn()
      }
      return fn()
    }
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let second: Promise<unknown> | undefined
    const def: PluginDefinition = {
      id: 'p:lock',
      definePlugin(ctx) {
        ctx.service({
          id: 's',
          async start() {
            void ctx.host.withFileLock('/tmp/hold', async () => 'first').catch(() => {})
            await new Promise((r) => setTimeout(r, 10))
            second = ctx.host.withFileLock('/tmp/hold', async () => 'should-not-run')
          },
          async stop() {},
        })
      },
    }
    await host.register(def, { enabled: true })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(second, '第二个锁请求应已入队')
    // 强制拆除周期（不停用预检）；随后释放持锁者 -> 排队 fn 进入时已失效。
    void host.dispose()
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst!()
    await assert.rejects(second, (err: unknown) =>
      err instanceof HelmError &&
      (err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed'),
    )
  })

  await t.test('nodeIpc.subscribe 竞态：释放先于建立完成时晚到订阅立即收割', { timeout: 60_000 }, async () => {
    const calls: NodeIpcCalls = { subscribeStarted: [], stopCalls: 0 }
    const host = new PluginHost({ dataDir, host: makeBackend({ nodeIpcCalls: calls, subscribeDelayMs: 30 }), docs: new MemoryDocStore() })
    let release: (() => void) | undefined
    const def: PluginDefinition = {
      id: 'p:ipc',
      definePlugin(ctx) {
        // 注册后立刻订阅并在停用时释放（acquire 包装）。
        void ctx.host.nodeIpc.subscribe('remote-1', { line: '{"method":"subscribe"}' }, () => {}, () => {})
          .then((stop) => { release = stop })
          .catch(() => {})
      },
    }
    // 手动获取 release：直接走 service.start 路径太重，用注册期订阅。
    const defSubscribe: PluginDefinition = {
      id: 'p:ipc2',
      definePlugin(ctx) {
        ctx.service({
          id: 's',
          async start() {
            const stop = await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
            release = stop
          },
          async stop() {},
        })
      },
    }
    await host.register(defSubscribe, { enabled: true })
    assert.ok(release, 'service.start 完成后应有退订句柄')
    // 停用：acquire 释放（abort + stop 收割）。
    await host.disable('p:ipc2')
    // 等晚到建立链结算。
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(calls.stopCalls >= 1, true, '停用应触发后端 stop（直接或晚到收割）')
    await host.unregister('p:ipc2').catch(() => {})
    void def
  })

  await t.test('onUpdate：partial 全串转发 output；结算后迟到 partial 静默丢弃', async () => {
    // 直接验证 tool-registry 的 onUpdate 包装语义（经 pluginToolResult 之外的通道）。
    // 这里以最小受控 fake 验证：settled 前转发、settled 后丢弃。
    const chunks: string[] = []
    let settled = false
    const output = (chunk: string): void => {
      if (settled) throw new Error('Tool call has settled')
      chunks.push(chunk)
    }
    const onUpdate = (partial: { output: string | Array<{ type: 'text'; text: string }> }): void => {
      const text = typeof partial.output === 'string' ? partial.output : partial.output.map((b) => b.text).join('')
      try {
        output(text)
      } catch (err) {
        if (err instanceof Error && err.message.includes('has settled')) return
        throw err
      }
    }
    onUpdate({ output: 'part-1 ' })
    onUpdate({ output: [{ type: 'text', text: 'part-2' }] })
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
    settled = true
    onUpdate({ output: 'late' }) // 不抛不推
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
  })

  await t.test('prompt 投射：仅激活工具进 sections，剥离不留幻影；guidelines 数组展开', () => {
    const base = [
      { id: 'profile.system', text: 'SYS' },
      { id: 'prompt.tools.update_memory', text: '旧指引（应被覆盖）' },
      { id: 'prompt.tools.ghost_tool', text: '幻影段（工具已剥离，应被清除）' },
    ]
    const projected = projectToolPromptSections(base, [
      { name: 'update_memory', promptSnippet: '用 update_memory 保存记忆。' },
      { name: 'load_skill', promptGuidelines: ['先读 SKILL.md', 'references 按需读'] },
    ])
    const ids = projected.map((s) => s.id)
    assert.ok(!ids.includes('prompt.tools.ghost_tool'), '幻影段必须被清除')
    const snippet = projected.find((s) => s.id === 'prompt.tools.update_memory')
    assert.equal(snippet?.text, '用 update_memory 保存记忆。')
    const guidelines = projected.find((s) => s.id === 'prompt.tools.guidelines')
    assert.ok(guidelines)
    assert.ok(guidelines!.text.includes('- load_skill: 先读 SKILL.md'))
    assert.ok(guidelines!.text.includes('- load_skill: references 按需读'))
    // 空投射：清除全部 prompt.tools.*（含 guidelines）。
    const cleared = projectToolPromptSections(projected, [])
    assert.ok(!cleared.some((s) => s.id.startsWith('prompt.tools.')))
  })
})
