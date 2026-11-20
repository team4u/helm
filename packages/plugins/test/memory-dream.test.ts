/**
 * builtin:memory 每日 Dream（记忆整理）测试。
 *
 * 覆盖（与需求逐项映射）：
 * - 纯函数：parseDreamModelOutput 严格 JSON/形状/空白/上限/预算、低价值输入过滤、
 *   nextDailyRunAt 每日/时区、extractFinalAssistantText 只取文本块、dreamBudgetChars；
 * - MemoryStore CAS：成功写回、内容变更冲突不写、文件消失冲突不写、64k 锁内拒绝；
 * - 引擎：0 候选零 completeText、模型成功 CAS 应用并消费候选、坏 JSON 零写回保留候选、
 *   预算超限拒绝、无模型会话合法跳过、disabled Profile 403、CAS 冲突放弃写回；
 * - 采集：turn_settled 只收 human/top-level/completed/启用 Profile，脱敏 + 有界 + 去重，
 *   非 human/子会话/失败回合/低价值输入不落盘；
 * - 调度：nextRunAt 恢复、每日推进、暂停后零调用、stop abort + 等待、liveTasks 拦截停用。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；可控时钟驱动真实 timer 流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type ConversationDetail, type ConversationSummary, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { PluginHost, type PluginDocStore } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary, waitFor, type Deferred, deferred } from './helpers/plugin-test-env.js'
import { MAX_MEMORY_CHARS, MemoryStore, MEMORY_DEFAULT } from '../src/memory/store.js'
import {
  DREAM_TARGET_CHARS,
  MAX_CANDIDATE_HUMAN_CHARS,
  createDreamEngine,
  dreamBudgetChars,
  extractFinalAssistantText,
  looksLikeLowValueHumanInput,
  nextDailyRunAt,
  parseDreamModelOutput,
  type DreamClock,
  type DreamHostPorts,
} from '../src/memory/dream.js'
import { createMemoryPlugin } from '../src/memory.js'

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('dream 纯函数：parseDreamModelOutput 严格校验', { timeout: 60_000 }, () => {
  // 合法：裸 JSON 与围栏 JSON
  assert.equal(parseDreamModelOutput('{"memory":"# Memory\\n偏好中文"}', 8000).memory, '# Memory\n偏好中文')
  assert.equal(parseDreamModelOutput('```json\n{"memory":"x"}\n```', 8000).memory, 'x')
  // 非 JSON / 形状错误 / 空白 / 超硬上限 / 超预算
  const cases: Array<[string, number, string]> = [
    ['not json at all', 8000, 'not_json'],
    ['[]', 8000, 'shape'],
    ['{"memory":"a","extra":1}', 8000, 'shape'],
    ['{"memo":"a"}', 8000, 'shape'],
    ['{"memory":123}', 8000, 'shape'],
    ['{"memory":"   "}', 8000, 'blank'],
    [`{"memory":"${'x'.repeat(MAX_MEMORY_CHARS + 1)}"}`, MAX_MEMORY_CHARS + 10, 'over_cap'],
    [`{"memory":"${'x'.repeat(9_000)}"}`, 8000, 'over_budget'],
  ]
  for (const [raw, budget, reason] of cases) {
    assert.throws(
      () => parseDreamModelOutput(raw, budget),
      (err: unknown) => err instanceof HelmxError && err.code === 'dream_output_invalid' && err.details?.reason === reason,
      `${reason} 应被拒绝：${raw.slice(0, 40)}`,
    )
  }
  // 预算边界：目标预算 max(2x 目标, 当前 + 1000)
  assert.equal(dreamBudgetChars(0), DREAM_TARGET_CHARS * 2)
  assert.equal(dreamBudgetChars(60_000), 61_000)
})

test('dream 纯函数：低价值输入过滤（保守机械过滤，价值判断交给模型）', { timeout: 60_000 }, () => {
  assert.equal(looksLikeLowValueHumanInput('ok'), true, '极短输入过滤')
  assert.equal(looksLikeLowValueHumanInput('/clear'), true, '斜杠命令过滤')
  assert.equal(looksLikeLowValueHumanInput('git status'), true, '纯 shell 命令（无散文）过滤')
  assert.equal(
    looksLikeLowValueHumanInput(['const a = 1', 'let b = 2', 'export default a', '}'].join('\n')),
    true,
    '代码块过滤',
  )
  assert.equal(looksLikeLowValueHumanInput(['at foo (bar.js:1:1)', 'at baz (bar.js:2:3)', 'at qux (bar.js:3:5)'].join('\n')), true, '堆栈过滤')
  assert.equal(looksLikeLowValueHumanInput('以后回复都用中文，简洁一点'), false, '用户偏好保留')
  assert.equal(looksLikeLowValueHumanInput('git 提交信息要用中文写'), false, '命令开头但含散文（CJK）保留')
  assert.equal(looksLikeLowValueHumanInput('Please always use conventional commits.'), false, '英文偏好保留')
})

test('dream 纯函数：nextDailyRunAt 每日时区计算', { timeout: 60_000 }, () => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  // UTC：当日 03:00
  assert.equal(nextDailyRunAt(3, 'UTC', t0), Date.parse('2026-01-15T03:00:00Z'))
  // 恰好在触发点：严格下一个（次日）
  assert.equal(nextDailyRunAt(3, 'UTC', Date.parse('2026-01-15T03:00:00Z')), Date.parse('2026-01-16T03:00:00Z'))
  // 上海 +8：UTC 00:00 = 当地 08:00，次日当地 03:00 = UTC 前一日 19:00？-> 次日 03:00 CST = 2026-01-15T19:00:00Z
  assert.equal(nextDailyRunAt(3, 'Asia/Shanghai', t0), Date.parse('2026-01-15T19:00:00Z'))
  // 非法时区显式拒绝
  assert.throws(
    () => nextDailyRunAt(3, 'Mars/Olympus', t0),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
  )
})

test('dream 纯函数：extractFinalAssistantText 只取最终 assistant 文本块', { timeout: 60_000 }, () => {
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'inner' }, { type: 'text', text: 'early' }] }] },
    { id: '2', kind: 'pi.tool_result', data: {} },
    { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }, { type: 'text', text: 'final answer' }] }] },
  ]
  assert.equal(extractFinalAssistantText(entries as never, 800), 'final answer')
  // 截断
  assert.ok(extractFinalAssistantText(entries as never, 3)!.endsWith('[truncated]'))
  // 无 assistant 文本
  assert.equal(extractFinalAssistantText([{ id: '1', kind: 'pi.user' }], 800), undefined)
})

// ---------------------------------------------------------------------------
// MemoryStore CAS
// ---------------------------------------------------------------------------

test('MemoryStore 梦境 CAS：成功、冲突、文件消失、64k 锁内拒绝', { timeout: 60_000 }, async (t) => {
  const dir = scratchDir(t, 'memory-cas')
  const fileHost = createProfileFileHost(dir)
  const store = new MemoryStore(fileHost)
  await store.ensureMemory('assistant')

  const { hash } = await store.readMemoryWithHash('assistant')
  // 成功写回
  assert.deepEqual(await store.commitDreamMemory('assistant', hash, '# New'), { applied: true })
  assert.equal(await store.getMemory('assistant'), '# New')

  // 旧 hash 再写：内容已变，冲突放弃
  assert.deepEqual(await store.commitDreamMemory('assistant', hash, '# Stale'), { applied: false })
  assert.equal(await store.getMemory('assistant'), '# New')

  // 基于当前 hash 但文件被删：冲突放弃（不重建）
  const { hash: hash2 } = await store.readMemoryWithHash('assistant')
  rmSync(join(dir, 'profiles', 'assistant', 'MEMORY.md'))
  assert.deepEqual(await store.commitDreamMemory('assistant', hash2, '# Rebuild'), { applied: false })
  assert.equal(existsSync(join(dir, 'profiles', 'assistant', 'MEMORY.md')), false)

  // 64k 锁内拒绝（正确 hash）
  await store.ensureMemory('assistant')
  const { hash: hash3 } = await store.readMemoryWithHash('assistant')
  await assert.rejects(
    () => store.commitDreamMemory('assistant', hash3, 'z'.repeat(MAX_MEMORY_CHARS + 1)),
    (err: unknown) => err instanceof HelmxError && err.code === 'memory_limit_exceeded',
  )
  assert.equal(await store.getMemory('assistant'), MEMORY_DEFAULT, '拒绝时文件保持旧值')
})

// ---------------------------------------------------------------------------
// 测试基建：PluginHost + 可控时钟 + 脚本化 completeText
// ---------------------------------------------------------------------------

/** 可控时钟：手动推进 now；setTimeout 暂存，advance 时依序触发到期项。 */
class FakeClock {
  private current: number
  private seq = 0
  private pending: Array<{ at: number; seq: number; fn: () => void; cleared: boolean }> = []

  readonly api: DreamClock = {
    now: () => this.current,
    setTimeout: (fn, ms) => {
      const entry = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cleared: false }
      this.pending.push(entry)
      return { clear: () => { entry.cleared = true } }
    },
  }

  constructor(start: number) {
    this.current = start
  }

  /** 推进 ms，依序触发沿途到期 timer；每个 timer 触发后让出微任务轮。 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      const due = this.pending.filter((e) => !e.cleared && e.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      this.current = due.at
      due.cleared = true
      due.fn()
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
    }
    this.current = target
  }

  activeTimers(): number {
    return this.pending.filter((e) => !e.cleared).length
  }
}

interface DreamHarness {
  host: PluginHost
  docs: MemoryDocStore
  clock: FakeClock
  dataDir: string
  store: MemoryStore
  backend: DreamBackendFixture
  engine?: ReturnType<typeof createDreamEngine>
}

interface DreamBackendFixture {
  completeTextCalls: Array<{ conversationId: number; systemPrompt: string; text: string; signal?: AbortSignal }>
  completeTextImpl: (input: { conversationId: number; systemPrompt: string; text: string; signal?: AbortSignal }) => Promise<string>
  conversations: Map<number, ConversationSummary>
  detailEntries: Map<number, ConversationDetail['entries']>
  events: Array<{ title: string; body: string }>
}

function makeSettled(
  conversation: ConversationSummary,
  inputs: Array<{ text: string; origin: 'human' | 'agent' | 'trigger' }>,
  outcome: TurnSettledPayload['outcome'] = 'completed',
): TurnSettledPayload {
  return {
    conversation,
    inputs: inputs.map((input, index) => ({ id: `s${index}`, text: input.text, origin: input.origin, createdAt: 1 })),
    outcome,
    settledAt: 1,
  }
}

function makeDetailEntries(assistantText?: string): ConversationDetail['entries'] {
  return [
    { id: '1', kind: 'pi.user' },
    ...(assistantText === undefined
      ? []
      : [{
          id: '2',
          kind: 'pi.assistant',
          model: [{ role: 'assistant', content: [{ type: 'text', text: assistantText }] }],
        }]),
  ] as ConversationDetail['entries']
}

async function makeHarness(t: test.TestContext, options: { startMs?: number } = {}): Promise<DreamHarness> {
  const dataDir = scratchDir(t, 'memory-dream')
  const docs = new MemoryDocStore()
  const clock = new FakeClock(options.startMs ?? Date.parse('2026-01-15T00:00:00Z'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.save({ id: 'coder', name: 'coder', tags: [] })

  const fixture: DreamBackendFixture = {
    completeTextCalls: [],
    completeTextImpl: async () => '{"memory":"# Memory"}',
    conversations: new Map(),
    detailEntries: new Map(),
    events: [],
  }
  const conversations = fixture.conversations
  const backend = {
    redact: (text: string) => text.replaceAll('sk-secret-123', '[redacted]'),
    completeText: async (input: { conversationId: number; systemPrompt: string; text: string; signal?: AbortSignal }) => {
      fixture.completeTextCalls.push(input)
      return fixture.completeTextImpl(input)
    },
    listConversations: (filter?: { profileId?: string; topLevelOnly?: boolean }) =>
      [...conversations.values()].filter(
        (c) =>
          (filter?.profileId === undefined || c.profileId === filter.profileId) &&
          (!filter?.topLevelOnly || c.parentConversationId === undefined),
      ),
    getConversationDetail: async (id: number) => ({
      ...makeConversationSummary({ id, profileId: conversations.get(id)?.profileId ?? 'assistant' }),
      entries: fixture.detailEntries.get(id) ?? [],
    }),
    emitEvent: (type: string, payload: unknown) => {
      if (type === 'notification') fixture.events.push(payload as { title: string; body: string })
    },
  }

  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    host: Object.assign(backend, createProfileFileHost(dataDir, profiles)) as never,
  })
  await host.register(createMemoryPlugin({ dream: { clock: clock.api } }), { enabled: true })

  const h: DreamHarness = {
    host,
    docs,
    clock,
    dataDir,
    store: new MemoryStore(createProfileFileHost(dataDir, profiles)),
    backend: fixture,
  }
  // 引用保持（引擎句柄经 action 面驱动；此处仅保留字段以便扩展）
  h.engine = undefined
  return h
}

function scratchDir(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `helmx-${prefix}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function dreamDirOf(h: DreamHarness, profileId: string): string {
  return join(h.dataDir, 'plugins', 'builtin%3Amemory', 'dream', profileId)
}

function readCandidates(h: DreamHarness, profileId: string): Array<{ humanText: string; assistantText?: string; conversationId: number; id: string }> {
  const raw = readFileSync(join(dreamDirOf(h, profileId), 'candidates.json'), 'utf8')
  return (JSON.parse(raw) as { candidates: typeof raw extends never ? never : Array<{ humanText: string; assistantText?: string; conversationId: number; id: string }> }).candidates
}

async function seedCandidate(h: DreamHarness, profileId: string, text = '以后都使用中文回复我', conversationId = 1): Promise<void> {
  const conversation = makeConversationSummary({ id: conversationId, profileId })
  h.backend.conversations.set(conversationId, conversation)
  h.backend.detailEntries.set(conversationId, makeDetailEntries('好的，已了解你的偏好。'))
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text, origin: 'human' }]) as never)
}

// ---------------------------------------------------------------------------
// 引擎：候选采集
// ---------------------------------------------------------------------------

test('dream 采集：turn_settled 过滤与脱敏/有界', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  const conversation = makeConversationSummary({ id: 1, profileId: 'assistant', title: '聊天 sk-secret-123' })
  h.backend.conversations.set(1, conversation)
  h.backend.detailEntries.set(1, makeDetailEntries('收到，已记住你的偏好 sk-secret-123'))

  // 非 human / 失败回合 / 子会话 / agent-owned 不采集
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: '以后都用中文回复我', origin: 'agent' }]) as never)
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: '以后都用中文回复我', origin: 'human' }], 'failed') as never)
  await h.host.runHook(
    'turn_settled',
    makeSettled({ ...conversation, id: 2, parentConversationId: 1 }, [{ text: '以后都用中文回复我', origin: 'human' }]) as never,
  )
  await h.host.runHook(
    'turn_settled',
    makeSettled({ ...conversation, id: 3, ownedBy: 'bot' }, [{ text: '以后都用中文回复我', origin: 'human' }]) as never,
  )
  // 低价值输入不采集
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: 'ok', origin: 'human' }]) as never)
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: 'pnpm install', origin: 'human' }]) as never)
  assert.equal(existsSync(dreamDirOf(h, 'assistant')), false, '全部过滤时不落盘')

  // 合法回合：脱敏 + 标题截断 + 正文有界 + assistant 摘要有界
  const long = '请记住我的 API 密钥是 sk-secret-123，'.repeat(120)
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: long, origin: 'human' }]) as never)
  const candidates = readCandidates(h, 'assistant')
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]!
  assert.ok(!candidate.humanText.includes('sk-secret-123'), '候选过 redact')
  assert.ok(candidate.humanText.includes('[redacted]'))
  assert.ok(candidate.humanText.length <= MAX_CANDIDATE_HUMAN_CHARS + 20, '单条有界')
  assert.ok(candidate.assistantText !== undefined && candidate.assistantText.includes('[redacted]'), 'assistant 摘要脱敏')

  // 去重：同会话同文本不重复
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: long, origin: 'human' }]) as never)
  assert.equal(readCandidates(h, 'assistant').length, 1)

  // 关闭记忆的 Profile 不采集
  await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
  const coderConversation = makeConversationSummary({ id: 9, profileId: 'coder' })
  h.backend.conversations.set(9, coderConversation)
  await h.host.runHook('turn_settled', makeSettled(coderConversation, [{ text: '以后都用中文回复我哦', origin: 'human' }]) as never)
  assert.equal(existsSync(dreamDirOf(h, 'coder')), false, '关闭记忆的 Profile 不采集')
  await h.host.dispose().catch(() => {})
})

// ---------------------------------------------------------------------------
// 引擎：dream 执行
// ---------------------------------------------------------------------------

test('dream 执行：0 候选零模型调用；无模型会话合法跳过', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.ensureMemory('assistant')
  // 0 候选：合法跳过
  const none = (await h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })) as { ran: boolean; reason?: string }
  assert.equal(none.ran, false)
  assert.equal(none.reason, 'no_candidates')
  assert.equal(h.backend.completeTextCalls.length, 0)

  // 有候选但无该 Profile 的会话：显式跳过（不创建会话）
  await seedCandidate(h, 'assistant', '偏好深色主题', 77)
  h.backend.conversations.delete(77)
  const noConv = (await h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })) as { ran: boolean; reason?: string }
  assert.equal(noConv.ran, false)
  assert.equal(noConv.reason, 'no_conversation_for_model')
  assert.equal(h.backend.completeTextCalls.length, 0, '零 completeText 调用')
  await h.host.dispose().catch(() => {})
})

test('dream 执行：模型成功经 CAS 应用并消费候选', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '以后都用中文回复', 5)

  h.backend.completeTextImpl = async (input) => {
    assert.equal(input.conversationId, 5, '绑定该 Profile 的真实现存会话')
    assert.ok(input.systemPrompt.includes('never invent'), '系统提示词含严格规则')
    assert.ok(input.text.includes('以后都用中文回复'), '用户文本含候选')
    assert.ok(input.text.includes('旧偏好'), '用户文本含当前记忆')
    return '{"memory":"# Memory\\n- 以后都用中文回复\\n- 旧偏好"}'
  }
  const result = (await h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })) as {
    ran: boolean; applied: boolean; consumed?: number; afterChars?: number
  }
  assert.equal(result.ran, true)
  assert.equal(result.applied, true)
  assert.equal(result.consumed, 1)
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n- 以后都用中文回复\n- 旧偏好')
  assert.equal(readCandidates(h, 'assistant').length, 0, '成功后候选被消费')
  // 状态视图如实反映
  const status = (await h.host.invokeAction('builtin:memory', 'dream_status', {})) as {
    profiles: Array<{ profileId: string; candidateCount: number; memoryChars: number | null; lastRun?: { applied?: boolean } }>
  }
  const row = status.profiles.find((p) => p.profileId === 'assistant')!
  assert.equal(row.candidateCount, 0)
  assert.equal(row.memoryChars, (await h.store.getMemory('assistant')).length)
  assert.equal(row.lastRun?.applied, true)
  // 快照存在且数量有界
  assert.equal(readdirSync(join(dreamDirOf(h, 'assistant'), 'snapshots')).length, 1)
  await h.host.dispose().catch(() => {})
})

test('dream 执行：坏 JSON / 超预算零写回且保留候选', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)

  h.backend.completeTextImpl = async () => '这不是 JSON'
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_output_invalid',
  )
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '坏 JSON 不写回')
  assert.equal(readCandidates(h, 'assistant').length, 1, '候选保留供下次重试')

  h.backend.completeTextImpl = async () => `{"memory":"${'x'.repeat(9_500)}"}`
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && (err.details as { reason?: string })?.reason === 'over_budget',
  )
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '超预算不写回')
  assert.equal(readCandidates(h, 'assistant').length, 1)
  await h.host.dispose().catch(() => {})
})

test('dream 执行：模型调用期间记忆被改 -> CAS 冲突放弃写回', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)

  const gate: Deferred<void> = deferred()
  h.backend.completeTextImpl = async () => {
    await gate.promise
    return '{"memory":"# Memory\\n- 整理后的记忆"}'
  }
  const pending = h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })
  await new Promise((resolve) => setImmediate(resolve))
  // 模型在途时人类手改 MEMORY.md
  await h.store.updateMemory('assistant', '# Memory\n人类手改的新内容', 'replace')
  gate.resolve()
  const result = (await pending) as { ran: boolean; applied?: boolean; conflict?: boolean }
  assert.equal(result.ran, true)
  assert.equal(result.applied, false)
  assert.equal(result.conflict, true)
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n人类手改的新内容', '绝不覆盖并发人类编辑')
  assert.equal(readCandidates(h, 'assistant').length, 1, '冲突时候选保留')
  await h.host.dispose().catch(() => {})
})

test('dream 执行：关闭记忆的 Profile 403；动作目标解析纪律', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'coder', enabled: false })
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'coder' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'memory_disabled_for_profile' && err.status === 403,
  )
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', {}),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'missing' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'profile_not_found' && err.status === 404,
  )
  await h.host.dispose().catch(() => {})
})

// ---------------------------------------------------------------------------
// 调度：每日推进 / 恢复 / 暂停 / stop abort / liveTasks
// ---------------------------------------------------------------------------

test('dream 调度：nextRunAt 恢复与每日推进（可控时钟）', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = await makeHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)

  h.backend.completeTextImpl = async () => '{"memory":"# Memory\\n- 偏好深色主题"}'
  // 注册即 start：nextRunAt 缺失 -> catch-up now+1
  const seeded = h.docs.peek<{ nextRunAt?: number }>('builtin:memory:dream')
  assert.ok(seeded?.nextRunAt !== undefined && seeded.nextRunAt <= t0 + 10, '启动写入 catch-up 点')
  await h.clock.advance(5)
  await waitFor(() => h.backend.completeTextCalls.length === 1, { timeoutMs: 10_000, message: 'catch-up 应触发一次整理' })
  const after = h.docs.peek<{ nextRunAt?: number }>('builtin:memory:dream')
  assert.ok(after!.nextRunAt! > t0 + 5, '推进到下一个低峰点')
  assert.equal(h.clock.activeTimers() >= 1, true, '已排下次 timer')

  // 次日到点再触发：候选为空（已消费） -> 零模型调用
  await h.clock.advance(after!.nextRunAt! - (t0 + 5) + 10)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.backend.completeTextCalls.length, 1, '无候选跳过，不再调用模型')
  await h.host.dispose().catch(() => {})
})

test('dream 调度：暂停后零调用；configure 校验', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = await makeHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)

  const paused = (await h.host.invokeAction('builtin:memory', 'dream_configure', { enabled: false })) as {
    enabled: boolean; nextRunAt?: number
  }
  assert.equal(paused.enabled, false)
  assert.equal(paused.nextRunAt, undefined, '暂停后无下次运行点')
  await h.clock.advance(3 * 24 * 3600 * 1_000)
  assert.equal(h.backend.completeTextCalls.length, 0, '暂停期间零模型调用')

  const resumed = (await h.host.invokeAction('builtin:memory', 'dream_configure', { enabled: true, hour: 4, timezone: 'UTC' })) as {
    enabled: boolean; hour: number; nextRunAt: number
  }
  assert.equal(resumed.hour, 4)
  assert.equal(resumed.nextRunAt, Date.parse('2026-01-18T04:00:00Z'), '恢复后从新时区/小时排程')

  for (const [input, message] of [
    [{ hour: 24 }, 'hour 越界'],
    [{ hour: 1.5 }, 'hour 非整数'],
    [{ timezone: 'Mars/Olympus' }, '非法时区'],
    [{}, '空补丁'],
  ] as const) {
    await assert.rejects(
      () => h.host.invokeAction('builtin:memory', 'dream_configure', input as never),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      message,
    )
  }
  await h.host.dispose().catch(() => {})
})

test('dream 生命周期：在途 dream 经 liveTasks 拦截停用；stop abort 并等待收敛', { timeout: 60_000 }, async (t) => {
  // 引擎级（不经 PluginHost 的 disable 门）：stop 必须 abort 在途模型调用并等待
  const dir = scratchDir(t, 'memory-dream-stop')
  const docs = new MemoryDocStore()
  const profiles = new ProfileService(dir)
  await profiles.ensureDefault()
  const fileHost = createProfileFileHost(dir, profiles)
  const store = new MemoryStore(fileHost)
  await store.updateMemory('assistant', '# Memory', 'replace')
  mkdirSync(join(dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant'), { recursive: true })
  writeFileSync(
    join(dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'candidates.json'),
    JSON.stringify({
      version: 1,
      candidates: [{ id: 'c1', conversationId: 1, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: Date.now() }],
    }),
    { flag: 'wx' },
  )

  let observedSignal: AbortSignal | undefined
  let enteredModel: Deferred<void> | undefined
  const ports: DreamHostPorts = {
    dataDir: join(dir, 'plugins', 'builtin%3Amemory'),
    doc: {
      get: () => ({ version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {} }),
      set: () => {},
      update: () => {},
      flush: async () => {},
    } as never,
    redact: (text) => text,
    completeText: async (input) => {
      observedSignal = input.signal
      input.signal?.throwIfAborted()
      enteredModel?.resolve()
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000)
        input.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new HelmxError('aborted', 'cancelled', 409))
        }, { once: true })
      })
      return '{"memory":"# Memory"}'
    },
    listConversations: () => [makeConversationSummary({ id: 1, profileId: 'assistant' })],
    getConversationDetail: async () => ({ entries: [] }) as never,
    store,
    profiles: { list: async () => [{ id: 'assistant' }] },
    isMemoryEnabled: () => true,
    emitError: () => {},
  }
  const clock = new FakeClock(Date.parse('2026-01-15T00:00:00Z'))
  const engine = createDreamEngine(ports, { clock: clock.api })
  enteredModel = deferred()
  const pending = engine.dreamFor('assistant')
  await enteredModel.promise // 确定性等待：模型调用确已进入在途
  assert.deepEqual(engine.liveTasks(), ['memory-dream:assistant'], '在途任务对 liveTasks 可见')
  await engine.stop()
  assert.ok(observedSignal?.aborted, 'stop 中止在途模型调用信号')
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof HelmxError,
  )
  assert.deepEqual(engine.liveTasks(), [], '收敛后 liveTasks 清空')

  // 模型调用前的 stop（读文件阶段）：abort 检查点使 dream 有界收敛，stop 不悬挂
  const earlyEngine = createDreamEngine(ports, { clock: clock.api })
  const earlyPending = earlyEngine.dreamFor('assistant')
  await new Promise((resolve) => setImmediate(resolve))
  await earlyEngine.stop()
  await assert.rejects(() => earlyPending, () => true, '早停也必须有界拒绝（绝不悬挂）')
  assert.deepEqual(earlyEngine.liveTasks(), [])

  // PluginHost 层：在途 dream 期间 disable 被 409 拦截（不可 force）
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)
  const gate: Deferred<void> = deferred()
  h.backend.completeTextImpl = async () => {
    await gate.promise
    return '{"memory":"# Memory\\n- 偏好深色主题"}'
  }
  const pendingAction = h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    () => h.host.disable('builtin:memory'),
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks',
    '在途 dream 必须拦截停用',
  )
  gate.resolve()
  await pendingAction
  await h.host.disable('builtin:memory') // 收敛后可停用
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream_status', {}),
    () => true,
    '停用后动作消失',
  )
  await h.host.dispose().catch(() => {})
})

// ---------------------------------------------------------------------------
// 跨重启持久（真实 createHelmx + faux provider 脚本化模型）
// ---------------------------------------------------------------------------

test('dream 真实组合层：faux 模型输出经 completeText 写回 MEMORY.md', { timeout: 60_000 }, async (t) => {
  const { createHelmx } = await import('../../hub/src/app.js')
  const { fauxAssistantMessage } = await import('@earendil-works/pi-ai/providers/faux')
  const { useTempDir, makeFauxProvider } = await import('./helpers/plugin-test-env.js')
  const dir = useTempDir(t, 'helmx-memory-dream-e2e-')
  const build = async () => {
    const faux = makeFauxProvider()
    return {
      faux,
      app: await createHelmx({
        buildProvider: createPluginBuildProvider(),
        dataDir: dir,
        cwd: dir,
        model: 'faux/faux-1',
        providers: [faux.provider],
      }),
    }
  }
  const { faux, app } = await build()
  try {
    const plugins = app.kernel.plugins!
    await plugins.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: '# Memory\n旧偏好。' })
    // 真实输入一个回合产生候选（faux 模型正常回合；确定性等待回合结算）
    faux.setResponses([fauxAssistantMessage('好的。')])
    const conversation = await app.kernel.createConversation({ profileId: 'assistant', title: '偏好' })
    await app.kernel.submitInput(conversation.id, '以后都用中文回复我，回答保持简洁。', { origin: 'human' })
    await app.kernel.waitForIdle(conversation.id)
    await waitFor(
      async () => {
        const status = (await plugins.invokeAction('builtin:memory', 'dream_status', {})) as {
          profiles: Array<{ candidateCount: number }>
        }
        return (status.profiles.find((p) => p.profileId === 'assistant')?.candidateCount ?? 0) > 0
      },
      { timeoutMs: 20_000, message: 'turn_settled 应采集到候选（真实组合层）' },
    )
    // 脚本化梦境输出
    faux.setResponses([fauxAssistantMessage('{"memory":"# Memory\\n- 以后都用中文回复我，回答保持简洁。"}')])
    const result = (await plugins.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })) as {
      ran: boolean
      applied: boolean
    }
    assert.equal(result.ran, true)
    assert.equal(result.applied, true)
    const got = (await plugins.invokeAction('builtin:memory', 'get', { profileId: 'assistant' })) as { content: string }
    assert.ok(got.content.includes('以后都用中文回复我'), '梦境结果写回 MEMORY.md')
  } finally {
    await app.close()
  }
})
