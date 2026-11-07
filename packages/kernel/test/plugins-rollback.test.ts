/**
 * 插件返修第 5 批（第二批 commit 未尽事项的行为级回归）：
 *
 * 1. profiles-skills：MEMORY.md 大小防线收敛到 ProfileService.updateMemory
 *    文件锁内（合并后检查）——跨实例并发 append 不可能叠加突破上限；
 *    save(memory)（HTTP/CLI 唯一写入路径）同限拒绝，不写半截；
 * 2. assistant：update_memory 并发（同 Profile 双会话）最终内容 ≤ 上限且
 *    超限方显式 memory_limit_exceeded；资产缺失时向模型注入显式
 *    assets-missing 节（不沉默换人格）+ 每文件独立告警去重与恢复后可重新告警；
 * 3. superagent：dispatch_worker 建会话后的副作用（markOwnership/updateIndex/
 *    updateSubscriptions）任一步失败同样完整回滚（不残留僵尸/不锁死 threadKey）；
 * 4. watchdog：外部探针目标瞬时缺失（网络抖动/单 tick 未采到）即便总量超限
 *    也不淘汰近期动作过的去重键（防危险动作重放）；足够陈旧（at 早于门槛）
 *    才允许淘汰；abort 调用失败撤销去重标记后下一 tick 可重试（不永久丢失
 *    也不记假成功）。
 *
 * 组合纪律：真实插件代码路径 + 受控 PluginHost backend（失败注入需要确定性
 * 边界）；profile 边界用真实 ProfileService 临时目录验证纯文件行为。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HelmError,
  type ConversationSummary,
  type WatchdogProbe,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createAssistantPlugin } from '../src/builtin-plugins/assistant.js'
import { createSuperAgentPlugin } from '../src/builtin-plugins/superagent.js'
import { MAX_MEMORY_CHARS, ProfileService, SkillService } from '../src/services/index.js'
import type { SuperAgentDependencies } from '../src/builtin-plugins/superagent/contracts.js'

// ---------------------------------------------------------------------------
// 共享基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
}

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

interface ControlledBackend extends PluginHostBackend {
  conversations: Map<number, ConversationSummary>
  notifications: Array<{ title: string; body: string; level: string }>
  submits: Array<{ conversationId: number; origin?: string }>
  /** 会话级失败注入：createConversation 后首个副作用（markOwnership）抛错。 */
  failMarkOwnershipFor: Set<number>
  /** submitInput 拒绝规则。 */
  submitRejector: ((conversationId: number) => Error | undefined) | undefined
}

function makeControlledBackend(): ControlledBackend {
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1, { tags: ['root'] }))
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const submits: Array<{ conversationId: number; origin?: string }> = []
  const backend: ControlledBackend = {
    conversations,
    notifications,
    submits,
    failMarkOwnershipFor: new Set(),
    submitRejector: undefined,
    async dispatchTrigger() {},
    async submitInput(conversationId, _text, opts) {
      submits.push({ conversationId, origin: opts?.origin })
      const rejection = this.submitRejector?.(conversationId)
      if (rejection !== undefined) throw rejection
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const summary = makeConversation(id, {
        title: init.title ?? 'new',
        profileId: init.profileId ?? 'assistant',
        ...(init.tags !== undefined ? { tags: init.tags } : {}),
        ...(init.parentConversationId !== undefined ? { parentConversationId: init.parentConversationId } : {}),
      })
      conversations.set(id, summary)
      return summary
    },
    listConversations() { return [...conversations.values()] },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() { return () => {} },
    markConversationOwnership(id) {
      if (this.failMarkOwnershipFor.has(id)) {
        throw new HelmError('document_store_failed', '测试注入：归属标记写入失败', 500)
      }
    },
    async createAsk() { throw new HelmError('unsupported', 'test', 400) },
    async cancelAsk() {},
    registerAskSeqResolver() { return () => {} },
    onWorkflowSettled() { return () => {} },
    emitEvent(type, payload) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    },
  }
  return backend
}

// ---------------------------------------------------------------------------
// 1. ProfileService：锁内大小防线（并发 append 不可叠加突破）+ save 同限
// ---------------------------------------------------------------------------

test('profiles：并发 append（跨实例、锁内合并检查）最终不超上限且超限方显式拒绝', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-mem-limit-'))
  try {
    // 预置接近上限：剩余空间只够一次追加。
    const base = new ProfileService(dataDir)
    await base.ensureDefault()
    await base.updateMemory('assistant', 'x'.repeat(MAX_MEMORY_CHARS - 1_000), 'replace')

    // 跨实例并发 append（每个都单独看是合法的 800 字符）：合并后必有一笔超限。
    const services = Array.from({ length: 4 }, () => new ProfileService(dataDir))
    const outcomes = await Promise.allSettled(
      services.map((svc) => svc.updateMemory('assistant', 'y'.repeat(800), 'append', { maxChars: MAX_MEMORY_CHARS })),
    )
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    // 4 笔 × 800 = 3200 > 1000 余量：至少一笔被锁内拒绝；全部成功即防线失效。
    assert.ok(rejected.length >= 1, `至少一笔 append 应被锁内拒绝（实际 ${rejected.length} 笔被拒）`)
    for (const r of rejected) {
      assert.ok(r.reason instanceof HelmError, '拒绝应是 HelmError')
      assert.equal(r.reason.code, 'memory_limit_exceeded')
      assert.equal(r.reason.status, 400)
      assert.ok(/replace/.test(r.reason.message), '错误信息应提示 replace 整理')
    }
    // 最终文件 ≤ 上限（锁内串行合并，绝不写半截超限内容）。
    const final = await base.getMemory('assistant')
    assert.ok(final.length <= MAX_MEMORY_CHARS, `最终内容 ${final.length} 不得超过上限`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('profiles：save(memory) 超限在写盘前拒绝（profile.json 不半截写入）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-mem-save-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    await assert.rejects(
      () =>
        profiles.save({
          id: 'assistant',
          name: '助理',
          memory: 'M'.repeat(MAX_MEMORY_CHARS + 1),
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_limit_exceeded' && err.status === 400,
    )
    // 既有 MEMORY.md 未被破坏；profile.json 未因半截 save 损坏（服务仍可读）。
    const memory = await profiles.getMemory('assistant')
    assert.ok(!memory.startsWith('M'.repeat(100)), '超限 memory 不得落盘')
    const fetched = await profiles.get('assistant')
    assert.ok(fetched !== undefined)
    // 合法大小（恰在上限）通过。
    await profiles.save({ id: 'assistant', name: '助理', memory: 'M'.repeat(MAX_MEMORY_CHARS) })
    assert.equal((await profiles.getMemory('assistant')).length, MAX_MEMORY_CHARS)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('profiles：无 maxChars 时不设限（服务层 API 语义：上限由调用方显式声明）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-mem-nolimit-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    // 不传 maxChars：超限也允许（路径自选上限，服务层不强制全局策略）。
    const written = await profiles.updateMemory('assistant', 'x'.repeat(MAX_MEMORY_CHARS + 100), 'replace')
    assert.equal(written.length, MAX_MEMORY_CHARS + 100)
    // 非法 maxChars 显式拒绝。
    await assert.rejects(
      () => profiles.updateMemory('assistant', 'x', 'append', { maxChars: 0 }),
      /maxChars/,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. assistant：update_memory 并发 + 资产缺失的模型可见告知
// ---------------------------------------------------------------------------

test('assistant：同 Profile 双会话并发 update_memory append 最终不超上限', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-assistant-conc-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    await profiles.updateMemory('assistant', 'x'.repeat(MAX_MEMORY_CHARS - 1_000), 'replace')
    const backend = makeControlledBackend()
    backend.conversations.set(10, makeConversation(10))
    backend.conversations.set(20, makeConversation(20))
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createAssistantPlugin({ profiles, skills: new SkillService(dataDir) }), { enabled: true })

    const outcomes = await Promise.allSettled([
      host.executeTool('update_memory', { text: 'y'.repeat(800), mode: 'append' }, { conversationId: 10 }),
      host.executeTool('update_memory', { text: 'z'.repeat(800), mode: 'append' }, { conversationId: 20 }),
      host.executeTool('update_memory', { text: 'w'.repeat(800), mode: 'append' }, { conversationId: 1 }),
    ])
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.ok(rejected.length >= 1, '并发 append 必有超限方被锁内拒绝')
    for (const r of rejected) {
      assert.ok(r.reason instanceof HelmError && r.reason.code === 'memory_limit_exceeded')
    }
    const final = await profiles.getMemory('assistant')
    assert.ok(final.length <= MAX_MEMORY_CHARS, `最终 ${final.length} ≤ 上限`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('assistant：SYSTEM/MEMORY 缺失时向模型注入显式 assets-missing 节（不沉默换人格）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-assistant-missing-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    const backend = makeControlledBackend()
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createAssistantPlugin({ profiles, skills: new SkillService(dataDir) }), { enabled: true })

    unlinkSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))
    unlinkSync(join(dataDir, 'profiles', 'assistant', 'SYSTEM.md'))

    const turn = {
      conversation: makeConversation(1),
      sections: [{ id: 'base', text: 'base' }],
      tools: [],
      inputs: [],
      messages: [],
    }
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    const sections = (result as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    const missing = sections.find((s) => s.id === 'assistant.assets-missing')
    assert.ok(missing !== undefined, '必须注入 assets-missing 节')
    assert.ok(missing.text.includes('SYSTEM.md'), '显式点名 SYSTEM.md 缺失')
    assert.ok(missing.text.includes('MEMORY.md'), '显式点名 MEMORY.md 缺失')
    assert.ok(missing.text.includes('不要假装'), '明确指示模型不得假装拥有记忆/人格')
    // 人类侧告警也发出（双通道：模型可见 + 人类通知）。
    assert.ok(
      backend.notifications.some((n) => n.title.includes('MEMORY.md')),
      'MEMORY.md 缺失应有人类侧告警',
    )
    assert.ok(
      backend.notifications.some((n) => n.title.includes('SYSTEM.md')),
      'SYSTEM.md 缺失应有人类侧告警（每文件独立）',
    )

    // 同一缺失状态第二回合：不再重复告警（去重），但模型仍每回合可见。
    backend.notifications.length = 0
    const again = await host.runHook('before_turn', { ...turn, sections: [{ id: 'base', text: 'base' }] } as never)
    assert.ok(again.action === 'transform')
    assert.equal(backend.notifications.length, 0, '持续缺失不重复告警')
    const sections2 = (again as { value: { sections: Array<{ id: string }> } }).value.sections
    assert.ok(sections2.some((s) => s.id === 'assistant.assets-missing'), '模型每回合仍可见缺失说明')

    // 文件恢复：告警标记复位——再次缺失可重新告警。
    const memoryPath = join(dataDir, 'profiles', 'assistant', 'MEMORY.md')
    writeFileSync(memoryPath, '# Memory\n\n恢复的记忆。\n')
    const healed = await host.runHook('before_turn', { ...turn, sections: [] } as never)
    assert.ok(healed.action === 'transform')
    const healedSections = (healed as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    // SYSTEM 仍缺失：assets-missing 节仍在，但不再点名 MEMORY（恢复即移除）。
    const healedMissing = healedSections.find((s) => s.id === 'assistant.assets-missing')
    assert.ok(healedMissing !== undefined, 'SYSTEM 仍缺失时节仍在')
    assert.ok(!healedMissing.text.includes('MEMORY.md'), 'MEMORY 恢复后不再点名其缺失')
    assert.ok(healedSections.some((s) => s.id === 'assistant.memory'), '恢复后正常注入 memory')
    backend.notifications.length = 0
    unlinkSync(memoryPath)
    await host.runHook('before_turn', { ...turn, sections: [] } as never)
    assert.ok(
      backend.notifications.some((n) => n.title.includes('MEMORY.md')),
      '恢复后再次缺失应重新告警（去重状态已复位）',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('assistant：权限/IO 错误不被吞（仅 FileNotFoundError 走缺失路径）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-assistant-ioerr-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    // 把 MEMORY.md 换成同名目录：readFile 得 EISDIR（真实 IO 错，非 ENOENT 缺失）。
    unlinkSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))

    const backend = makeControlledBackend()
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createAssistantPlugin({ profiles, skills: new SkillService(dataDir) }), { enabled: true })
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [],
      inputs: [],
      messages: [],
    }
    await assert.rejects(
      () => host.runHook('before_turn', turn as never),
      (err: unknown) => {
        // 绝不被吞成「空记忆 + 缺失告警」：真实 IO 错误上抛（宿主包一层
        // HelmError 但保留 cause 与原始 EISDIR 信息），不足缺失路径。
        const message = err instanceof Error ? err.message : String(err)
        assert.ok(message.includes('EISDIR'), `应携带真实 EISDIR 错误（实际 ${message}）`)
        return true
      },
    )
    // 也没发缺失告警（不是缺失路径）。
    assert.equal(backend.notifications.filter((n) => n.title.includes('缺失')).length, 0)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. superagent：副作用序列失败（markOwnership/updateIndex）同样完整回滚
// ---------------------------------------------------------------------------

interface SuperAgentEnv {
  host: PluginHost
  backend: ControlledBackend
  docs: MemoryDocStore
  close(): Promise<void>
}

async function makeSuperAgentEnv(): Promise<SuperAgentEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-roll-'))
  const backend = makeControlledBackend()
  const docs = new MemoryDocStore()
  const host = new PluginHost({ dataDir, host: backend, docs })
  const profiles = new ProfileService(dataDir)
  const skills = new SkillService(dataDir)
  await profiles.ensureDefault()
  const deps: SuperAgentDependencies = {
    dataDir,
    profiles,
    skills,
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    listArtifacts: async () => [],
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }
  await host.register(createSuperAgentPlugin(deps), { enabled: true })
  return {
    host,
    backend,
    docs,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function readDoc<T>(env: SuperAgentEnv, name: string): T {
  return env.docs.store.get(`builtin:superagent:${name}`) as T
}

test('superagent：markOwnership 失败（首个副作用）也完整回滚：无僵尸、threadKey 不锁死、空会话归档', { timeout: 60_000 }, async () => {
  const env = await makeSuperAgentEnv()
  try {
    // 注入：所有新建 worker 的归属标记写入都失败（createConversation 之后第一步）。
    env.backend.failMarkOwnershipFor.clear()
    const originalMark = env.backend.markConversationOwnership.bind(env.backend)
    ;(env.backend as unknown as { markConversationOwnership: typeof originalMark }).markConversationOwnership = (id, owner) => {
      const summary = env.backend.conversations.get(id)
      if (summary?.tags.includes('worker')) {
        throw new HelmError('document_store_failed', '测试注入：归属标记写入失败', 500)
      }
      originalMark(id, owner)
    }

    await assert.rejects(
      () => env.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '任务', threadKey: 'tk-1' }, undefined),
      (err: unknown) => err instanceof HelmError && err.code === 'document_store_failed',
    )

    // 回滚 1：index 无 worker 残留。
    const index = readDoc<{ workers: Array<{ conversationId: number }> }>(env, 'index')
    assert.equal(index.workers.length, 0, '副作用失败后 index 不得残留 worker')

    // 回滚 2：threadKey 未被锁死——恢复正常后同 key 派工成功。
    ;(env.backend as unknown as { markConversationOwnership: typeof originalMark }).markConversationOwnership = originalMark
    const retry = (await env.host.invokeAction(
      'builtin:superagent',
      'dispatch_worker',
      { prompt: '重试', threadKey: 'tk-1' },
      undefined,
    )) as { workerConversationId: number }
    assert.ok(Number.isInteger(retry.workerConversationId), '同 threadKey 重试应成功')

    // 回滚 3：失败会话打上 worker-archived（空会话不进活跃集，保留审计）。
    const archived = [...env.backend.conversations.values()].filter((c) => c.tags.includes('worker-archived'))
    assert.equal(archived.length, 1, '失败派工的空会话应归档')

    // 回滚 4：显式错误通知（不静默）。
    assert.ok(
      env.backend.notifications.some((n) => n.title.includes('派工提交失败') || n.title.includes('回滚')),
      '副作用失败应显式通知',
    )

    // 回滚 5：subscriptions 只含成功那次。
    const subs = readDoc<{ subscriptions: Array<{ threadKey: string; workerConversationId: number }> }>(env, 'subscriptions')
    assert.equal(subs.subscriptions.length, 1)
    assert.equal(subs.subscriptions[0]!.workerConversationId, retry.workerConversationId)
  } finally {
    await env.close()
  }
})

test('superagent：submitInput 失败（既有第一批场景回归）不误删活跃任务、不重建重复回滚', { timeout: 60_000 }, async () => {
  const env = await makeSuperAgentEnv()
  try {
    // 先派一个成功 Worker（活跃任务），再注入后续提交失败。
    const ok = (await env.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '正常任务' }, undefined)) as {
      workerConversationId: number
    }
    env.backend.submitRejector = (conversationId) => {
      if (conversationId === ok.workerConversationId) return undefined // 活跃 Worker 不受影响
      const summary = env.backend.conversations.get(conversationId)
      if (summary?.tags.includes('worker')) {
        return new HelmError('conversation_not_accepting', '测试注入：提交被拒绝', 409)
      }
      return undefined
    }
    await assert.rejects(() =>
      env.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '会失败' }, undefined))
    // 活跃 Worker 仍在 index（回滚只清失败者）。
    const index = readDoc<{ workers: Array<{ conversationId: number }> }>(env, 'index')
    assert.ok(
      index.workers.some((w) => w.conversationId === ok.workerConversationId),
      '成功 Worker 不受失败派工回滚影响',
    )
    assert.equal(index.workers.length, 1)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. watchdog：外部键淘汰陈旧门槛 + abort 失败重试语义
// ---------------------------------------------------------------------------

interface WatchdogRecorded {
  notifications: Array<{ level: string; title: string; body: string }>
  aborts: number[]
  abortErrors: Array<number>
  submits: Array<{ conversationId: number; text: string; origin?: string }>
}

async function makeWatchdogHarness(opts: {
  ownership?: (id: number) => 'helm' | 'bot' | 'human'
} = {}) {
  const recorded: WatchdogRecorded = { notifications: [], aborts: [], abortErrors: [], submits: [] }
  /** 测试可变注入：true 时 abortConversation 拒绝（模拟调用失败）。 */
  let abortShouldFail = false
  const routerId = 100
  const watchdogId = 200
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(watchdogId, makeConversation(watchdogId, { profileId: 'watchdog', title: '巡检看门狗' }))
  conversations.set(routerId, makeConversation(routerId, { profileId: 'superagent', title: 'SuperAgent 中枢' }))
  conversations.set(1, makeConversation(1, { title: '个人助理' }))
  const docs = new MemoryDocStore()
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async (conversationId, text, o) => {
      recorded.submits.push({ conversationId, text, origin: o?.origin })
    },
    createConversation: async (init) => {
      const id = conversations.size + 1
      const summary = makeConversation(id, { title: init.title ?? 'new', profileId: init.profileId ?? 'assistant' })
      conversations.set(id, summary)
      return summary
    },
    listConversations: () => [...conversations.values()],
    getConversation: (id) => {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    updateConversation: async (id) => conversations.get(id) ?? makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'cancelled', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: (type, payload) => {
      if (type === 'notification') {
        const p = payload as { level?: string; title?: string; body?: string }
        recorded.notifications.push({ level: p.level ?? 'info', title: p.title ?? '', body: p.body ?? '' })
      }
    },
  }
  const host = new PluginHost({
    dataDir: mkdtempSync(join(tmpdir(), 'helm-wd-evict-')),
    host: backend,
    docs,
  })
  const config = {
    routerMode: true,
    mutedSources: '',
    watchdogEnabled: true,
    stalledAfterMs: 60_000,
    abortAfterMs: 600_000,
    errorThreshold: 3,
  }
  const deps = {
    dataDir: '/tmp/helm-test-wd',
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    getConversationDetail: async (id: number) => ({ ...makeConversation(id), entries: [] }),
    listArtifacts: async () => [],
    abortConversation: async (id: number) => {
      if (abortShouldFail) {
        recorded.abortErrors.push(id)
        throw new HelmError('abort_failed', '测试注入：abort 调用失败', 500)
      }
      recorded.aborts.push(id)
    },
    getConversationOwnership: (id: number) => opts.ownership?.(id) ?? (id === 1 ? 'human' : 'helm'),
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t: string) => t,
  }
  const { registerSuperAgentWatchdog } = await import('../src/builtin-plugins/superagent/watchdog.js')
  await host.register({
    id: 'builtin:superagent',
    name: 'SuperAgent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps as never, {
        getConfig: () => config,
        getRouterConversationId: () => routerId,
        getWatchdogConversationId: () => watchdogId,
        track: async <T,>(label: string, task: () => Promise<T>) => task(),
      } as never)
    },
  })
  return {
    host,
    recorded,
    conversations,
    docs,
    config,
    setAbortShouldFail(value: boolean) {
      abortShouldFail = value
    },
    async tick(probes: WatchdogProbe[]) {
      const payload = { timestamp: Date.now(), conversations: [...conversations.values()], probes }
      await host.runHook('watchdog_tick', payload as never)
      await new Promise((resolve) => setImmediate(resolve))
    },
    /** 直改去重文档（构造淘汰场景：预置大量陈旧/新鲜外部键）。 */
    dedupStore: docs,
  }
}

function externalProbe(nodeId: string, paneId: string, over: Partial<WatchdogProbe> = {}): WatchdogProbe {
  return {
    targetId: paneId,
    targetKind: 'external',
    nodeId,
    ownedBy: 'helm',
    stateChangeSeq: 10,
    status: 'working',
    facts: { kind: 'herdr', parentConversationId: 300, pendingAskCount: 0 },
    ...over,
  }
}

test('watchdog：外部目标瞬时缺失（探针未采到）不淘汰近期动作过的去重键', { timeout: 60_000 }, async () => {
  const h = await makeWatchdogHarness()
  try {
    // 目标 pane-active 在 tick1 出现并触发 notify（working 超长停滞通知）。
    h.config.abortAfterMs = 600_000
    const probe = externalProbe('local', 'pane-active', { stalledMs: 700_000, status: 'working' })
    await h.tick([probe])
    // 构造总量超限：预置 300 个「陈旧」外部键（at 早于 24h 门槛）——只有它们可淘汰。
    const staleAt = Date.now() - 25 * 60 * 60 * 1000
    const fired: Record<string, Record<string, { seq: number; at: number }>> = {}
    for (let i = 0; i < 300; i++) {
      fired[JSON.stringify(['external', 'local', `pane-stale-${i}`])] = { notify: { seq: 5, at: staleAt } }
    }
    const existing = (h.dedupStore.get('builtin:superagent:watchdog-dedup', { version: 1, fired: {} })) as {
      version: 1
      fired: Record<string, Record<string, { seq: number; at: number }>>
    }
    // 保留 pane-active 的真实标记（tick1 写入，at = 刚刚）。
    const activeKey = JSON.stringify(['external', 'local', 'pane-active'])
    const activeMark = existing.fired[activeKey]
    assert.ok(activeMark !== undefined, '前置：pane-active 已有去重标记')
    h.dedupStore.set('builtin:superagent:watchdog-dedup', { version: 1, fired: { ...fired, [activeKey]: activeMark } })

    // tick2：pane-active 瞬时缺失（网络抖动/单 tick 未采到），其余探针为空。
    await h.tick([])

    const after = (h.dedupStore.get('builtin:superagent:watchdog-dedup', { version: 1, fired: {} })) as {
      fired: Record<string, Record<string, { seq: number; at: number }>>
    }
    // 近期动作过的活跃键绝不被淘汰（防同水位重放通知/唤醒）。
    assert.ok(after.fired[activeKey] !== undefined, '近期动作过的外部键不得因瞬时缺失被淘汰')
    // 陈旧键按预算收敛（总量 ≤ 256 后停止淘汰）。
    const remaining = Object.keys(after.fired).length
    assert.ok(remaining <= 256, `陈旧键应收敛到预算内（实际 ${remaining}）`)
  } finally {
    await h.host.dispose().catch(() => {})
  }
})

test('watchdog：足够陈旧的外部键（无动作超 24h 且持续缺失）才允许淘汰', { timeout: 60_000 }, async () => {
  const h = await makeWatchdogHarness()
  try {
    const staleAt = Date.now() - 25 * 60 * 60 * 1000
    const fired: Record<string, Record<string, { seq: number; at: number }>> = {}
    for (let i = 0; i < 300; i++) {
      fired[JSON.stringify(['external', 'local', `pane-old-${i}`])] = { notify: { seq: 5, at: staleAt } }
    }
    h.dedupStore.set('builtin:superagent:watchdog-dedup', { version: 1, fired })
    await h.tick([]) // 持续缺失 + 超限 + 足够陈旧 → 淘汰最旧直至预算内
    const after = (h.dedupStore.get('builtin:superagent:watchdog-dedup', { version: 1, fired: {} })) as {
      fired: Record<string, unknown>
    }
    assert.ok(Object.keys(after.fired).length <= 256, '陈旧超限外部键应被淘汰收敛')
  } finally {
    await h.host.dispose().catch(() => {})
  }
})

test('watchdog：abort 调用失败撤销去重标记——下一 tick 同水位可重试且不记假成功', { timeout: 60_000 }, async () => {
  const h = await makeWatchdogHarness()
  try {
    h.config.abortAfterMs = 600_000
    h.setAbortShouldFail(true)
    // native 会话 55：超长停滞触发 auto_abort；注入 abort 首次失败。
    h.conversations.set(55, makeConversation(55, { status: 'working', stateChangeSeq: 10 }))
    await h.tick([
      {
        targetId: '55',
        targetKind: 'conversation',
        conversationId: 55,
        ownedBy: 'helm',
        status: 'working',
        stateChangeSeq: 10,
        stalledMs: 700_000,
        facts: { pendingAskCount: 0 },
      } as WatchdogProbe,
    ])
    // 首次 abort 失败：显式错误通知（含「已撤销去重标记，下一轮巡检可重试」）。
    assert.deepEqual(h.recorded.abortErrors, [55], 'abort 应调用过且失败')
    assert.equal(h.recorded.aborts.length, 0, '未记假成功')
    const failNote = h.recorded.notifications.find((n) => n.title.includes('自动中止失败'))
    assert.ok(failNote !== undefined, 'abort 失败应显式通知')
    assert.ok(failNote.body.includes('撤销'), '通知应说明已撤销去重标记')

    // 第二 tick 同水位：重试 abort（此时不再注入失败）→ 真实执行。
    h.setAbortShouldFail(false)
    await h.tick([
      {
        targetId: '55',
        targetKind: 'conversation',
        conversationId: 55,
        ownedBy: 'helm',
        status: 'working',
        stateChangeSeq: 10,
        stalledMs: 800_000,
        facts: { pendingAskCount: 0 },
      } as WatchdogProbe,
    ])
    assert.deepEqual(h.recorded.aborts, [55], '撤销标记后下一 tick 应重试 abort')
    const okNote = h.recorded.notifications.find((n) => n.title.includes('已自动中止'))
    assert.ok(okNote !== undefined, '重试成功后如实通知')
  } finally {
    await h.host.dispose().catch(() => {})
  }
})
