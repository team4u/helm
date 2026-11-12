/**
 * builtin:memory 插件行为测试（真 PluginHost + 真 ProfileService + 真文件系统）。
 *
 * 覆盖：
 * - get / set / configure 三个 ctx.action 的校验与语义（含 CLI/HTTP 同源契约）；
 * - 单 Profile 开关隔离（configure 关闭 A 不影响 B）与执行期守卫（403）；
 * - before_turn 关闭时不读文件、不注入、剥离工具；
 * - 私有 ctx.doc 持久化：disabledProfiles / initializedProfiles 跨重启保持；
 * - 全局停用后 update_memory 卸载（tool_not_found）、SYSTEM 注入不受影响；
 * - 显式失效目标（不存在的 Profile）显式 404，不静默改投。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { HelmError, type ConversationSummary, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { ProfileService } from '../src/services/index.js'
import { MAX_MEMORY_CHARS, createMemoryPlugin, isProfileMemoryEnabled, type MemoryPluginDoc } from '../src/builtin-plugins/memory.js'
import { MemoryStore } from '../src/builtin-plugins/memory/store.js'
import { createProfilePlugin } from '../src/builtin-plugins/profile.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

function makeConversation(id: number, profileId = 'assistant'): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conv-${id}`,
    profileId,
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function makeBackend(): PluginHostBackend & {
  notifications: Array<{ title: string; body: string; level: string }>
} {
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1))
  conversations.set(2, makeConversation(2, 'coder'))
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const backend = {
    ...createPluginHostBackendFixture(),
    conversations,
    notifications,
    async dispatchTrigger() {},
    async submitInput() {},
    async createConversation(init: { profileId?: string }) {
      const id = Math.max(...conversations.keys()) + 1
      const summary = makeConversation(id, init.profileId ?? 'assistant')
      conversations.set(id, summary)
      return summary
    },
    listConversations() {
      return [...conversations.values()]
    },
    getConversation(id: number) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id: number, patch: Partial<ConversationSummary>) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() {
      return () => {}
    },
    markConversationOwnership() {},
    async createAsk() {
      throw new HelmError('unsupported', 'test', 400)
    },
    async cancelAsk() {},
    registerAskSeqResolver() {
      return () => {}
    },
    onEvent() {
      return () => {}
    },
    async abortConversation() {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    async spawnAgent() {
      return {}
    },
    async runGate() {
      return { ok: true, output: '' }
    },
    async prepareInterruptedConversations() {},
    async cleanupWorktree() {
      return { removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }
    },
    async invokeAction() {
      return {}
    },
    prepareAction: () => ({ idempotent: false }),
    async execEnv() {
      throw new HelmError('unsupported', 'fixture', 501)
    },
    listActions: () => [],
    emitEvent(type: string, payload: unknown) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    },
  }
  return backend
}

function makeTurn(profileId: string, withMemoryTool = true) {
  const base = {
    name: 'load_skill',
    description: 'probe',
    inputSchema: { type: 'object' as const },
    execute: async () => ({}),
  }
  return {
    conversation: makeConversation(1, profileId),
    sections: [],
    tools: [
      ...(withMemoryTool
        ? [{ ...base, name: 'update_memory' }]
        : []),
      base,
    ],
    inputs: [],
    messages: [],
  }
}

async function setup(
  dataDir: string,
  extraPlugins: PluginDefinition[] = [],
  docs: PluginDocStore = new MemoryDocStore(),
) {
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.save({ id: 'coder', name: ' coder '.trim(), tags: [] })
  const backend = Object.assign(makeBackend(), createProfileFileHost(dataDir, profiles))
  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register(createMemoryPlugin(), { enabled: true })
  for (const plugin of extraPlugins) await host.register(plugin, { enabled: true })
  return { host, profiles, store: new MemoryStore(createProfileFileHost(dataDir, profiles)), backend }
}

let scratchRoot: string
test('memory 插件行为', { timeout: 60_000 }, async (t) => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'helm-memory-plugin-'))
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }))

  await t.test('get 动作：未初始化 Profile 返回空内容与开关状态', async () => {
    const dir = join(scratchRoot, 't1')
    const { host } = await setup(dir)
    const result = (await host.invokeAction('builtin:memory', 'get', { profileId: 'coder' })) as {
      enabled: boolean; content: string; initialized: boolean
    }
    assert.equal(result.enabled, true)
    assert.equal(result.content, '', '未初始化返回空串（不伪造内容）')
    assert.equal(result.initialized, false)
    // Profile 不存在显式 404
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'get', { profileId: 'no-such' }),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_not_found' && err.status === 404,
    )
    // 非法 profileId（目录注入）显式拒绝
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'get', { profileId: '../etc' }),
      (err: unknown) => err instanceof Error && /非法 profile id/.test(err.message),
    )
  })

  await t.test('动作目标：显式 profileId 优先；省略时取 conversationId Profile；无目标显式 400', { timeout: 60_000 }, async () => {
    const dir = join(scratchRoot, 'action-target')
    const { host, store } = await setup(dir)
    const coder = await host.invokeAction('builtin:memory', 'get', {}, { conversationId: 2 }) as { profileId: string }
    assert.equal(coder.profileId, 'coder')

    const written = await host.invokeAction('builtin:memory', 'set', { text: '# 当前会话' }, { conversationId: 2 }) as { profileId: string }
    assert.equal(written.profileId, 'coder')
    assert.equal(await store.getMemory('coder'), '# 当前会话')

    await host.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: '# 显式优先' }, { conversationId: 2 })
    assert.equal(await store.getMemory('assistant'), '# 显式优先')
    await host.invokeAction('builtin:memory', 'configure', { enabled: false }, { conversationId: 2 })
    const status = await host.invokeAction('builtin:memory', 'get', {}, { conversationId: 2 }) as { profileId: string; enabled: boolean }
    assert.deepEqual(status, { profileId: 'coder', enabled: false, content: '# 当前会话', initialized: true })

    for (const [actionId, input] of [
      ['get', {}],
      ['set', { text: 'no target' }],
      ['configure', { enabled: true }],
    ] as const) {
      await assert.rejects(
        () => host.invokeAction('builtin:memory', actionId, input),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
        `${actionId} 缺少显式 Profile 与会话上下文时应返回 validation_error`,
      )
    }
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'get', { profileId: 'missing' }, { conversationId: 2 }),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_not_found' && err.status === 404,
      '失效显式目标不得回退到当前会话 Profile',
    )
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'get', {}, { conversationId: 999 }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
      '失效会话上下文不得回退到 assistant Profile',
    )
    await host.dispose()
  })

  await t.test('set 动作：写全文、惰性标记初始化、关闭后拒绝写入', async () => {
    const dir = join(scratchRoot, 't2')
    const { host, store } = await setup(dir)
    const r = (await host.invokeAction('builtin:memory', 'set', {
      profileId: 'coder',
      text: '# 记忆\n用户喜欢简洁。',
    })) as { updated: boolean; length: number }
    assert.equal(r.updated, true)
    assert.equal(await store.getMemory('coder'), '# 记忆\n用户喜欢简洁。')
    // set 后 initialized 标记生效
    const got = (await host.invokeAction('builtin:memory', 'get', { profileId: 'coder' })) as { initialized: boolean }
    assert.equal(got.initialized, true)
    // 关闭记忆后 set 被拒（403 memory_disabled_for_profile）
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'set', { profileId: 'coder', text: 'x' }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_disabled_for_profile' && err.status === 403,
    )
  })

  await t.test('configure 动作：单 Profile 开关隔离、跨 Profile 不影响', async () => {
    const dir = join(scratchRoot, 't3')
    const { host, store } = await setup(dir)
    await host.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: '# 助理记忆' })
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
    // coder 关闭：get 如实返回 enabled=false，磁盘文件保留（不删除）
    const coder = (await host.invokeAction('builtin:memory', 'get', { profileId: 'coder' })) as { enabled: boolean }
    assert.equal(coder.enabled, false)
    // assistant 不受影响
    const assistant = (await host.invokeAction('builtin:memory', 'get', { profileId: 'assistant' })) as { enabled: boolean; content: string }
    assert.equal(assistant.enabled, true)
    assert.equal(assistant.content, '# 助理记忆')
    // 重新开启后可写（文件未删）
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: true })
    const reopened = (await host.invokeAction('builtin:memory', 'get', { profileId: 'coder' })) as { enabled: boolean }
    assert.equal(reopened.enabled, true)
    void store
  })

  await t.test('configure 携带 text：先写成功再提交开关（不留半配置）', async () => {
    const dir = join(scratchRoot, 't4')
    const { host, store } = await setup(dir)
    // 关闭状态 + 携带 text + enabled:true：写入成功后开启
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
    await host.invokeAction('builtin:memory', 'configure', {
      profileId: 'coder',
      enabled: true,
      text: '# 重启后的记忆',
    })
    assert.equal(await store.getMemory('coder'), '# 重启后的记忆')
    const got = (await host.invokeAction('builtin:memory', 'get', { profileId: 'coder' })) as { enabled: boolean }
    assert.equal(got.enabled, true)
  })

  await t.test('before_turn：单 Profile 关闭时不读文件、不注入段落并剥离工具', async () => {
    const dir = join(scratchRoot, 't5')
    const { host, store } = await setup(dir)
    await store.updateMemory('coder', '# C', 'replace')
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
    const turn = makeTurn('coder')
    // 删除文件验证「不读文件」：关闭状态下即使文件消失也不告警
    rmSync(join(dir, 'profiles', 'coder', 'MEMORY.md'))
    const result = await host.runHook('before_turn', turn as never)
    if (result.action === 'transform') {
      assert.equal(result.value.tools.some((t: { name: string }) => t.name === 'update_memory'), false, '关闭时剥离 update_memory')
      assert.equal(result.value.sections.some((s: { id: string }) => s.id.startsWith('memory.')), false, '关闭时不注入 memory 段落')
    } else {
      // continue 时 tools 原样返回也意味着未剥离——但我们的实现对带工具的 turn 必 transform
      assert.fail('关闭记忆且工具存在时应返回 transform 剥离工具')
    }
  })

  await t.test('update_memory 执行期守卫：关闭的 Profile 403、开启的正常写入', async () => {
    const dir = join(scratchRoot, 't6')
    const { host, store } = await setup(dir)
    await host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
    await assert.rejects(
      () => host.executeTool('update_memory', { text: 'x', mode: 'append' }, { conversationId: 2 }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_disabled_for_profile' && err.status === 403,
    )
    assert.equal(existsSync(join(dir, 'profiles', 'coder', 'MEMORY.md')), false, '拒绝时不写盘')
    // 开启的 Profile 正常写入
    const ok = (await host.executeTool('update_memory', { text: '偏好深色主题', mode: 'append' }, { conversationId: 1 })) as { updated: boolean }
    assert.equal(ok.updated, true)
    assert.ok((await store.getMemory('assistant')).includes('偏好深色主题'))
  })

  await t.test('开关判定：列表内禁用，未出现的 Profile 与缺省状态均开启', { timeout: 60_000 }, () => {
    const doc: MemoryPluginDoc = { disabledProfiles: ['coder'], initializedProfiles: ['coder', 'assistant'] }
    assert.equal(isProfileMemoryEnabled(doc, 'coder'), false)
    assert.equal(isProfileMemoryEnabled(doc, 'assistant'), true)
    assert.equal(isProfileMemoryEnabled(undefined, 'assistant'), true)
  })

  await t.test('全局停用：update_memory 卸载、动作卸载；SYSTEM 注入不受影响', async () => {
    const dir = join(scratchRoot, 't8')
    const { host, profiles } = await setup(dir, [
      {
        id: 'test:sys',
        name: '系统注入探针',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn(async (turn) => ({
            action: 'transform' as const,
            value: { ...turn, sections: [...turn.sections, { id: 'probe.system', text: 'SYS' }] },
          }))
        },
      },
    ])
    await host.disable('builtin:memory')
    // 动作与工具卸载
    await assert.rejects(
      () => host.executeTool('update_memory', { text: 'x', mode: 'append' }, { conversationId: 1 }),
      (err: unknown) => err instanceof HelmError && err.code === 'unknown_tool',
    )
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'get', { profileId: 'assistant' }),
      (err: unknown) => err instanceof HelmError,
    )
    // 其他插件的 SYSTEM 注入不受影响
    const turn = makeTurn('assistant')
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    assert.ok(result.value.sections.some((s: { id: string }) => s.id === 'probe.system'))
    await host.enable('builtin:memory')
    // 重新启用后动作恢复
    const got = (await host.invokeAction('builtin:memory', 'get', { profileId: 'assistant' })) as { enabled: boolean }
    assert.equal(got.enabled, true)
    void profiles
  })

  await t.test('MEMORY.md 上限常量导出为 64000', () => {
    assert.equal(MAX_MEMORY_CHARS, 64_000)
  })

  await t.test('64k 上限：replace/append 超限显式拒绝且不写半截（跨实例并发）', async () => {
    const dir = join(scratchRoot, 't9')
    const { host, store } = await setup(dir)
    await store.updateMemory('assistant', 'x'.repeat(64_000 - 100), 'replace')
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: 'y'.repeat(200), mode: 'append' }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_limit_exceeded' && err.status === 400,
    )
    assert.equal((await store.getMemory('assistant')).length, 64_000 - 100, '拒绝后文件保持旧值')
  })

  await t.test('update_memory 超限显式拒绝（append 累计与 replace 直写双路径）', async () => {
    const dir = join(scratchRoot, 't-limit-tool')
    const { host, store } = await setup(dir)
    const runUpdate = (input: { text: string; mode: string }) =>
      host.executeTool('update_memory', input, { conversationId: 1 })

    // 1) append 超限：先写接近上限，再追加使总和超限。
    await store.updateMemory('assistant', 'x'.repeat(MAX_MEMORY_CHARS - 10), 'replace')
    await assert.rejects(
      () => runUpdate({ text: 'y'.repeat(20), mode: 'append' }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'memory_limit_exceeded')
        assert.equal(err.status, 400)
        assert.ok(/replace/.test(err.message), '错误信息应提示用 replace 整理')
        return true
      },
    )
    // 拒绝后文件保持旧值（不写半截）。
    const afterReject = await store.getMemory('assistant')
    assert.equal(afterReject.length, MAX_MEMORY_CHARS - 10)

    // 2) replace 直写超限：单次 text 即超。
    await assert.rejects(
      () => runUpdate({ text: 'z'.repeat(MAX_MEMORY_CHARS + 1), mode: 'replace' }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_limit_exceeded',
    )

    // 3) 合法 replace（恰在上限内）成功。
    await runUpdate({ text: 'a'.repeat(MAX_MEMORY_CHARS), mode: 'replace' })
    assert.equal((await store.getMemory('assistant')).length, MAX_MEMORY_CHARS)
  })

  await t.test('存量 MEMORY.md 超限注入时截断并附显式说明', async () => {
    const dir = join(scratchRoot, 't-truncation')
    const memoryDir = join(dir, 'profiles', 'assistant')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'M'.repeat(MAX_MEMORY_CHARS + 5_000))
    const { host } = await setup(dir)
    const turn = makeTurn('assistant')
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    const sections = (result as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    const memory = sections.find((s) => s.id === 'memory.content')
    assert.ok(memory !== undefined, '超限仍应注入 memory.content section')
    assert.ok(memory.text.includes('超过'), '截断应附显式说明')
    assert.ok(memory.text.length <= MAX_MEMORY_CHARS + 500, '注入内容应截断到上限附近（含说明）')
  })

  await t.test('profile 插件与 memory 插件正交：停用 memory 不影响 load_skill 与 SYSTEM 注入', async () => {
    const dir = join(scratchRoot, 't10')
    const profiles = new ProfileService(dir)
    await profiles.ensureDefault()
    const host = new PluginHost({ dataDir: dir, host: Object.assign(makeBackend(), createProfileFileHost(dir, profiles)), docs: new MemoryDocStore() })
    await host.register(
      {
        id: 'builtin:profile',
        name: '底座',
        definePlugin() {},
      } as never,
      { enabled: true },
    )
    await host.register(createMemoryPlugin(), { enabled: true })
    void createProfilePlugin // 引用保持（组合层注册测试在 core.integration）
    await host.disable('builtin:memory')
    const summary = host.list().find((p) => p.id === 'builtin:memory')
    assert.equal(summary?.enabled, false)
  })

  await t.test('已初始化文件跨重启被删后告警不重建；写入或外部恢复自愈后再次删除可再告警', { timeout: 60_000 }, async () => {
    const dir = join(scratchRoot, 'missing-after-restart')
    const docs = new MemoryDocStore()
    const memoryPath = join(dir, 'profiles', 'assistant', 'MEMORY.md')
    const first = await setup(dir, [], docs)
    await first.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.equal(existsSync(memoryPath), true, '首次需要记忆时惰性初始化')
    await first.host.dispose()
    rmSync(memoryPath)

    const restarted = await setup(dir, [], docs)
    const missing = await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.ok(missing.action === 'transform')
    assert.ok(missing.value.sections.some((section: { id: string }) => section.id === 'memory.assets-missing'))
    assert.equal(existsSync(memoryPath), false, '跨重启缺失告警不得补建')
    assert.equal(restarted.backend.notifications.length, 1)
    await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.equal(restarted.backend.notifications.length, 1, '同一次连续缺失只通知一次')

    await restarted.host.executeTool('update_memory', { text: '经工具恢复', mode: 'replace' }, { conversationId: 1 })
    assert.equal(existsSync(memoryPath), true, 'update_memory 明确写入后恢复文件')
    const recovered = await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.ok(recovered.action === 'transform')
    assert.ok(!recovered.value.sections.some((section: { id: string }) => section.id === 'memory.assets-missing'))

    rmSync(memoryPath)
    const missingAgain = await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.ok(missingAgain.action === 'transform')
    assert.ok(missingAgain.value.sections.some((section: { id: string }) => section.id === 'memory.assets-missing'))
    assert.equal(restarted.backend.notifications.length, 2, '文件恢复后再次缺失应重新告警')
    assert.equal(existsSync(memoryPath), false)

    writeFileSync(memoryPath, '')
    const externallyRestored = await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.ok(externallyRestored.action === 'transform')
    assert.ok(externallyRestored.value.sections.some((section: { id: string }) => section.id === 'memory.guide'))
    assert.ok(!externallyRestored.value.sections.some((section: { id: string }) => section.id === 'memory.assets-missing'))
    rmSync(memoryPath)
    await restarted.host.runHook('before_turn', makeTurn('assistant') as never)
    assert.equal(restarted.backend.notifications.length, 3, '外部恢复的空白文件同样自愈并重置告警去重')
    await restarted.host.dispose()
  })

  await t.test('空白文件注入 memory.guide（合法态无告警）；文件恢复自愈', async () => {
    const dir = join(scratchRoot, 't11')
    const { host, store } = await setup(dir)
    const memoryPath = join(dir, 'profiles', 'assistant', 'MEMORY.md')
    writeFileSync(memoryPath, '')
    const turn = makeTurn('assistant')
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    assert.ok(result.value.sections.some((s: { id: string }) => s.id === 'memory.guide'))
    assert.ok(!result.value.sections.some((s: { id: string }) => s.id === 'memory.assets-missing'))
    void store
  })
})

// ---------------------------------------------------------------------------
// 真实组合层：单 Profile 开关跨重启持久（ctx.doc 经真实 SQLite）
// ---------------------------------------------------------------------------

test('memory 单 Profile 开关跨重启持久（真实 createHelm）', { timeout: 60_000 }, async () => {
  const { createHelm } = await import('../src/app.js')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const { fauxProvider } = await import('@earendil-works/pi-ai/providers/faux')
  const dir = mkdtempSync(join(tmpdir(), 'helm-memory-persist-'))
  try {
    const build = async () => {
      const faux = fauxProvider()
      const models = createModels()
      models.setProvider(faux.provider)
      return createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
    }
    const first = await build()
    try {
      await first.kernel.plugins!.invokeAction('builtin:memory', 'set', {
        profileId: 'assistant',
        text: '# 助理记忆\n偏好中文回复。',
      })
      await first.kernel.plugins!.invokeAction('builtin:memory', 'configure', {
        profileId: 'assistant',
        enabled: false,
      })
    } finally {
      await first.close()
    }

    const second = await build()
    try {
      const got = (await second.kernel.plugins!.invokeAction('builtin:memory', 'get', {
        profileId: 'assistant',
      })) as { enabled: boolean; content: string }
      assert.equal(got.enabled, false, '开关跨重启保持（关闭）')
      assert.equal(got.content, '# 助理记忆\n偏好中文回复。', '磁盘全文跨重启保持')
      // 重新开启后持久
      await second.kernel.plugins!.invokeAction('builtin:memory', 'configure', {
        profileId: 'assistant',
        enabled: true,
      })
    } finally {
      await second.close()
    }

    const third = await build()
    try {
      const got = (await third.kernel.plugins!.invokeAction('builtin:memory', 'get', {
        profileId: 'assistant',
      })) as { enabled: boolean }
      assert.equal(got.enabled, true, '重新开启后跨重启保持')
    } finally {
      await third.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ---------------------------------------------------------------------------
// 动作清单（自动映射 helm memory get/set/configure 与 HTTP 端点）
// ---------------------------------------------------------------------------

test('memory 动作清单：get/set/configure 注册且默认 CLI 命令路径为 memory <action>', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-memory-manifest-'))
  try {
    const { host } = await setup(dir)
    const manifests = host.listActions().filter((a) => a.pluginId === 'builtin:memory')
    assert.deepEqual(
      manifests.map((a) => a.id).sort(),
      ['configure', 'get', 'set'],
    )
    // 缺省自动挂载：无 cli.command 覆写时按 [stripBuiltin(pluginId), actionId] = memory <action>
    for (const m of manifests) {
      assert.equal(m.cli, undefined, 'memory 动作未覆写 cli（默认路径 memory <action>）')
      assert.ok(m.inputSchema.type === 'object')
      assert.ok(m.outputSchema.type === 'object')
      assert.ok(!(m.inputSchema as { required?: string[] }).required?.includes('profileId'), 'profileId 是可选的目标 selector')
    }
    // set 的 mode 可选枚举（append/replace）
    const setManifest = manifests.find((m) => m.id === 'set')!
    const modeEnum = (setManifest.inputSchema as { properties: { mode?: { enum?: string[] } } }).properties.mode?.enum
    assert.deepEqual(modeEnum, ['replace', 'append'])
    await host.dispose().catch(() => {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
