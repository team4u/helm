/**
 * builtin:memory 每日 Dream（记忆整理）测试。
 *
 * 覆盖（与需求逐项映射）：
 * - 纯函数：parseDreamModelOutput 严格 JSON/形状/空白/上限/预算（围栏拒绝）、stripExcerptNoise
 *   围栏代码/命令/日志剥离、低价值输入过滤、nextDailyRunAt 每日/时区、
 *   extractFinalAssistantText 只取文本块并剥离代码/日志噪声、dreamBudgetChars；
 * - MemoryStore CAS：成功写回、内容变更冲突不写、文件消失冲突不写、64k 锁内拒绝；
 * - 引擎：0 候选零 completeText、模型成功 CAS 应用并消费候选、坏 JSON 零写回保留候选、
 *   预算超限拒绝、无模型会话合法跳过、disabled Profile 403、CAS 冲突放弃写回；
 * - 复核切片：模型在途/等锁期间关闭记忆绝不写回（锁内 guard）、采集 enrichment 在途
 *   关闭不落候选、失败错误/通知/快照全链 redact、坏候选文件不清空且显式报错、
 *   focused status 只读目标 Profile；
 * - 采集：turn_settled 只收 human/top-level/completed/启用 Profile，脱敏 + 有界 + 去重，
 *   非 human/子会话/失败回合/低价值输入不落盘，围栏代码对 human/assistant 都剥离；
 * - 调度：首启排下一低峰点、claim 先行、nextRunAt 过期补跑一次、重启不重跑、
 *   每日推进、暂停后零调用、TTL 每日 sweep 实际清除、stop abort + 追踪 sweep 收敛、
 *   stop 返回后零 doc 写/零 timer、liveTasks 拦截停用。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；可控时钟驱动真实 timer 流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type ConversationDetail, type ConversationSummary, type PluginDocHandle, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { PluginHost, type PluginDocStore } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { withFileLock } from '../../kernel/src/services/file-lock.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary, waitFor, type Deferred, deferred } from './helpers/plugin-test-env.js'
import { MAX_MEMORY_CHARS, MemoryStore, MEMORY_DEFAULT } from '../src/memory/store.js'
import {
  DREAM_CANDIDATE_SEND_BUDGET_CHARS,
  DREAM_MAX_TOKENS,
  DREAM_TARGET_CHARS,
  MAX_CANDIDATE_HUMAN_CHARS,
  candidatePayloadChars,
  createDreamEngine,
  dreamBudgetChars,
  entriesUpToSettledTurn,
  extractFinalAssistantText,
  looksLikeLowValueHumanInput,
  nextDailyRunAt,
  parseDreamModelOutput,
  selectCandidatesForDream,
  stripExcerptNoise,
  stripFencedCodeBlocks,
  type DreamCandidate,
  type DreamClock,
  type DreamDoc,
  type DreamHostPorts,
} from '../src/memory/dream.js'
import { createMemoryPlugin } from '../src/memory.js'

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('dream 纯函数：parseDreamModelOutput 严格校验（单一裸 JSON 对象，围栏拒绝）', { timeout: 60_000 }, () => {
  // 合法：裸 JSON
  assert.equal(parseDreamModelOutput('{"memory":"# Memory\\n偏好中文"}', 8000).memory, '# Memory\n偏好中文')
  // 围栏 / 包裹回复一律拒绝（not_json）：严格单一裸 JSON 对象契约
  const fenced: Array<[string, string]> = [
    ['```json\n{"memory":"x"}\n```', 'json 围栏'],
    ['```\n{"memory":"x"}\n```', '裸围栏'],
    ['Here is the result: {"memory":"x"}', '散文包裹'],
  ]
  for (const [raw, message] of fenced) {
    assert.throws(
      () => parseDreamModelOutput(raw, 8000),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'dream_output_invalid' &&
        (err.details as { reason?: string } | undefined)?.reason === 'not_json',
      `${message} 应被拒绝`,
    )
  }
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
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'dream_output_invalid' &&
        (err.details as { reason?: string } | undefined)?.reason === reason,
      `${reason} 应被拒绝：${raw.slice(0, 40)}`,
    )
  }
  // 预算边界：目标预算 max(2x 目标, 当前 + 1000)
  assert.equal(dreamBudgetChars(0), DREAM_TARGET_CHARS * 2)
  assert.equal(dreamBudgetChars(60_000), 61_000)
})

test('dream 纯函数：selectCandidatesForDream 新近优先选整条、按时间送出、预算内有界', { timeout: 60_000 }, () => {
  const make = (id: string, collectedAt: number, human: string, assistant?: string): DreamCandidate => ({
    id,
    conversationId: 1,
    conversationTitle: 't',
    humanText: human,
    ...(assistant !== undefined ? { assistantText: assistant } : {}),
    collectedAt,
  })
  // 大小 = human + assistant + title
  const a = make('a', 1, 'x'.repeat(1_000))
  assert.equal(candidatePayloadChars(a), 1_000 + 't'.length)
  const b = make('b', 2, 'y'.repeat(2_000), 'z'.repeat(500))
  const c = make('c', 3, 'w'.repeat(3_000))
  const d = make('d', 4, 'v'.repeat(4_000))
  // 预算 5_500：新近优先 d(4000+t) -> 剩 ~1_499 -> c/b 放不下 -> a(1000+t) 放得下
  const chosen = selectCandidatesForDream([a, b, c, d], 5_500)
  assert.deepEqual(chosen.map((x) => x.id), ['a', 'd'], '新近优先整条选取，放不下的跳过但更旧更小的仍可入选')
  assert.ok(
    chosen.reduce((sum, x) => sum + candidatePayloadChars(x), 0) <= 5_500,
    '总发送字符在预算内',
  )
  // 同预算再验证输出按时间升序（oldest first）
  assert.ok(chosen[0]!.collectedAt <= chosen[1]!.collectedAt, '送出顺序为时间序')
  // 全部放得下：保持文件顺序（同 collectedAt 也保持原顺序）
  const all = selectCandidatesForDream([a, b, c, d], 100_000)
  assert.deepEqual(all.map((x) => x.id), ['a', 'b', 'c', 'd'])
  const sameTime = [make('n1', 7, 'one'), make('n2', 7, 'two'), make('n3', 7, 'three')]
  assert.deepEqual(selectCandidatesForDream(sameTime, 100_000).map((x) => x.id), ['n1', 'n2', 'n3'], '同时间戳保持文件顺序')
  // 首条（最新）超预算也必须入选（进度保证；正常候选受单条上限不会触发）
  const huge = make('huge', 9, 'h'.repeat(30_000))
  assert.deepEqual(selectCandidatesForDream([a, huge], 5_000).map((x) => x.id), ['huge'])
  // 空列表
  assert.deepEqual(selectCandidatesForDream([], 20_000), [])
})

test('dream 纯函数：stripExcerptNoise 剥离围栏代码块与命令/日志行', { timeout: 60_000 }, () => {
  // 围栏代码块剥离（闭合与悬空）
  const fenced = '请记住偏好深色主题\n```ts\nconst a = 1\n```\n以上代码不用记'
  assert.equal(stripExcerptNoise(fenced), '请记住偏好深色主题\n\n以上代码不用记')
  assert.equal(stripExcerptNoise('先说结论\n```json\n{"a":1}\n'), '先说结论', '悬空围栏剥离到结尾')
  // 命令 / 日志 / 堆栈行剥离，散文保留
  const noisy = [
    '结论：以后用中文回复',
    '$ pnpm test',
    '2026-01-15T03:00:00.123Z server started',
    'ERROR something failed',
    'at foo (bar.js:1:1)',
    '偏好简洁回答',
  ].join('\n')
  assert.equal(stripExcerptNoise(noisy), '结论：以后用中文回复\n偏好简洁回答')
  // 纯代码文本剥离后为空
  assert.equal(stripExcerptNoise('```\nls -la\n```'), '')
  // stripFencedCodeBlocks 只剥围栏，不动其他行
  assert.equal(stripFencedCodeBlocks('a\n```x\ny\n```\nb'), 'a\n\nb')
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

test('dream 纯函数：extractFinalAssistantText 只取最后一个 assistant 条目，绝不回退更早回复', { timeout: 60_000 }, () => {
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'inner' }, { type: 'text', text: 'early' }] }] },
    { id: '2', kind: 'pi.tool_result', data: {} },
    { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }, { type: 'text', text: 'final answer' }] }] },
  ]
  assert.equal(extractFinalAssistantText(entries as never), 'final answer')
  // 最终 assistant 条目无文本（工具调用结尾）-> 不回退 tool-call 前的更早回复
  const toolOnlyEnd = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'pre-tool reply' }] }] },
    { id: '2', kind: 'pi.tool_result', data: {} },
    { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] }] },
  ]
  assert.equal(extractFinalAssistantText(toolOnlyEnd as never), undefined, '无最终 assistant 文本时不回落 pre-tool 回复')
  // 无 assistant 文本
  assert.equal(extractFinalAssistantText([{ id: '1', kind: 'pi.user' }]), undefined)
  // 助理复述工具输出/代码块：围栏与命令/日志行剥离后才持久化
  const quoted = [
    '已记好你的偏好：默认使用中文回复。',
    '```bash',
    'pnpm test',
    '```',
    '$ helmx nodes list',
    '2026-01-15T03:00:00Z done in 3s',
  ].join('\n')
  const quotedEntries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: quoted }] }] },
  ]
  assert.equal(extractFinalAssistantText(quotedEntries as never), '已记好你的偏好：默认使用中文回复。')
  // 剥离后为空 -> 无摘录（同样不回退更早条目）
  const codeOnly = [{ id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '```\nls -la\n```' }] }] }]
  assert.equal(extractFinalAssistantText(codeOnly as never), undefined, '纯代码回复无摘录')
})

test('dream 纯函数：entriesUpToSettledTurn 按 lastEntryId 截断（下一回合条目排除）', { timeout: 60_000 }, () => {
  const entries = [
    { id: '1', kind: 'pi.user' },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '本回合回复' }] }] },
    { id: '3', kind: 'pi.user' },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '下一回合回复' }] }] },
  ]
  assert.equal(entriesUpToSettledTurn(entries as never, 2).length, 2, '越过水位的条目被排除')
  assert.equal(extractFinalAssistantText(entriesUpToSettledTurn(entries as never, 2)), '本回合回复', '取结算回合的最终回复')
  // 水位缺失（旧内核/缺省）：不过滤
  assert.equal(entriesUpToSettledTurn(entries as never, undefined).length, 4)
  // 非数字 id 无排序信息：保守放行
  assert.equal(entriesUpToSettledTurn([{ id: 'x', kind: 'pi.user' }] as never, 2).length, 1)
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
  completeTextCalls: Array<{ conversationId: number; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }>
  completeTextImpl: (input: { conversationId: number; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }) => Promise<string>
  conversations: Map<number, ConversationSummary>
  detailEntries: Map<number, ConversationDetail['entries']>
  /** 可选注入：接管 getConversationDetail（测试采集期竞态窗口）。 */
  detailImpl?: (id: number) => Promise<ConversationDetail>
  /** 可选注入：接管原子写（测试候选串行临界区窗口）。 */
  atomicWriteImpl?: (path: string, content: string) => Promise<void>
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
    atomicWriteFile: async (path: string, content: string) => {
      if (fixture.atomicWriteImpl !== undefined) {
        await fixture.atomicWriteImpl(path, content)
        return
      }
      writeFileSync(path, content, 'utf8')
    },
    completeText: async (input: { conversationId: number; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }) => {
      fixture.completeTextCalls.push(input)
      return fixture.completeTextImpl(input)
    },
    listConversations: (filter?: { profileId?: string; topLevelOnly?: boolean }) =>
      [...conversations.values()].filter(
        (c) =>
          (filter?.profileId === undefined || c.profileId === filter.profileId) &&
          (!filter?.topLevelOnly || c.parentConversationId === undefined),
      ),
    getConversationDetail: async (id: number) =>
      fixture.detailImpl !== undefined
        ? fixture.detailImpl(id)
        : {
            ...makeConversationSummary({ id, profileId: conversations.get(id)?.profileId ?? 'assistant' }),
            entries: fixture.detailEntries.get(id) ?? [],
          },
    emitEvent: (type: string, payload: unknown) => {
      if (type === 'notification') fixture.events.push(payload as { title: string; body: string })
    },
  }

  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    // backend (fixture-gated writes / scripted model ports) wins over the profile file host's
    // same-name atomicWriteFile; the profile host fills in profiles/skills/withFileLock.
    host: { ...createProfileFileHost(dataDir, profiles), ...backend } as never,
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

  // 脱敏先于截断：秘密跨截断点时不得以剖开片段存活（placeholder 起点在 1498，跨越 1500 截断点）
  const straddling = `${'偏好铺垫。'.repeat(299)}密钥 sk-secret-123`
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: straddling, origin: 'human' }]) as never)
  const straddlingCandidates = readCandidates(h, 'assistant')
  const straddlingCandidate = straddlingCandidates[straddlingCandidates.length - 1]!
  assert.ok(!straddlingCandidate.humanText.includes('{{SE'), '先脱敏再截断：跨点秘密不残留剖开片段')
  assert.ok(!straddlingCandidate.humanText.includes('sk-secret-123'), '秘密全文不出现')

  // 人类输入中的围栏代码块剥离后才入候选（散文保留）
  const withCode = '以后回复都用中文。\n```bash\nrm -rf /tmp/x\n```\n另外偏好深色主题。'
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: withCode, origin: 'human' }]) as never)
  const withCodeCandidates = readCandidates(h, 'assistant')
  const lastWithCode = withCodeCandidates[withCodeCandidates.length - 1]!
  assert.ok(!lastWithCode.humanText.includes('```') && !lastWithCode.humanText.includes('rm -rf'), '人类输入围栏代码剥离')
  assert.ok(lastWithCode.humanText.includes('以后回复都用中文') && lastWithCode.humanText.includes('深色主题'), '散文保留')

  // assistant 摘要剥离复述的代码块
  h.backend.detailEntries.set(1, makeDetailEntries('已记录。\n```\nSELECT * FROM users;\n```'))
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: '顺便记住偏好简洁回答', origin: 'human' }]) as never)
  const lastCandidates = readCandidates(h, 'assistant')
  const last = lastCandidates[lastCandidates.length - 1]!
  assert.ok(last.assistantText !== undefined && !last.assistantText.includes('```'), 'assistant 摘要剥离代码块')
  assert.ok(last.assistantText!.includes('已记录。'))

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
  assert.equal(h.backend.completeTextCalls[0]!.maxTokens, DREAM_MAX_TOKENS, '模型调用显式输出预算')
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

test('dream 调度：首启排下一低峰点、claim 先行、每日推进（可控时钟）', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = await makeHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)

  h.backend.completeTextImpl = async () => '{"memory":"# Memory\\n- 偏好深色主题"}'
  // 注册即 start：nextRunAt 缺失 -> 排下一个低峰点（不再立即 catch-up；时区取宿主缺省，只断言未来点）
  const seeded = h.docs.peek<{ nextRunAt?: number }>('builtin:memory:dream')
  assert.ok(seeded?.nextRunAt !== undefined && seeded.nextRunAt > t0, '首启排下一个每日低峰点（不立即整理）')
  // 显式切到 UTC 保持确定性，然后推进到点
  await h.host.invokeAction('builtin:memory', 'dream_configure', { timezone: 'UTC' })
  const scheduled = h.docs.peek<{ nextRunAt?: number }>('builtin:memory:dream')!
  assert.equal(scheduled.nextRunAt, Date.parse('2026-01-15T03:00:00Z'), 'UTC 03:00 排程')
  await h.clock.advance(scheduled.nextRunAt! - t0 + 10)
  await waitFor(() => h.backend.completeTextCalls.length === 1, { timeoutMs: 10_000, message: '到点应触发一次整理' })
  await waitFor(() => h.clock.activeTimers() >= 1, { timeoutMs: 10_000, message: '整理收敛后应排下次 timer' })
  // claim 先行：模型调用已发生（在途/已完成），nextRunAt 已推进到下一个点
  const duringOrAfter = h.docs.peek<{ nextRunAt?: number }>('builtin:memory:dream')
  assert.ok(duringOrAfter!.nextRunAt! > Date.parse('2026-01-15T03:00:00Z'), 'claim 在执行前推进 nextRunAt')

  // 次日到点再触发：候选为空（已消费） -> 零模型调用
  await h.clock.advance(duringOrAfter!.nextRunAt! - (t0 + 10) + 10)
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
    atomicWriteFile: async (path, content) => {
      writeFileSync(path, content, 'utf8')
    },
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
// 复核与收敛修复切片：开关复核 / stop 追踪 sweep / 调度恢复 / TTL 清理 / 腐败文件 / 脱敏
// ---------------------------------------------------------------------------

test('dream 复核：模型在途关闭记忆 -> 不写回、候选保留、memory_disabled', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)
  const gate = deferred()
  h.backend.completeTextImpl = async () => {
    // 模型在途时关闭该 Profile 记忆（写回前复核窗口）
    await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'assistant', enabled: false })
    gate.resolve()
    return '{"memory":"# Memory\\n- 偏好深色主题"}'
  }
  const result = (await h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })) as {
    ran: boolean; applied?: boolean; reason?: string
  }
  await gate.promise
  assert.equal(result.ran, true)
  assert.equal(result.reason, 'memory_disabled')
  assert.notEqual(result.applied, true)
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '关闭后绝不 CAS 写回')
  assert.equal(readCandidates(h, 'assistant').length, 1, '候选保留')
  const doc = h.docs.peek<{ runs: Record<string, { reason?: string; applied?: boolean }> }>('builtin:memory:dream')
  assert.equal(doc!.runs.assistant!.reason, 'memory_disabled')
  assert.notEqual(doc!.runs.assistant!.applied, true)
  await h.host.dispose().catch(() => {})
})

test('dream 复核：等锁期间关闭记忆 -> 锁内 guard 拒绝写回', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)
  const memoryPath = join(h.dataDir, 'profiles', 'assistant', 'MEMORY.md')
  const lockHeld = deferred()
  const releaseLock = deferred()
  void withFileLock(memoryPath, async () => {
    lockHeld.resolve()
    await releaseLock.promise
  })
  await lockHeld.promise
  h.backend.completeTextImpl = async () => '{"memory":"# Memory\\n- 偏好深色主题"}'
  const pending = h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })
  await waitFor(() => h.backend.completeTextCalls.length === 1, { timeoutMs: 10_000, message: '模型调用完成' })
  await new Promise((resolve) => setImmediate(resolve)) // dream 已进入 commit 的等锁队列
  await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'assistant', enabled: false })
  releaseLock.resolve()
  const result = (await pending) as { ran: boolean; applied?: boolean; reason?: string }
  assert.equal(result.reason, 'memory_disabled')
  assert.notEqual(result.applied, true)
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '锁内 guard 拒绝写回')
  assert.equal(readCandidates(h, 'assistant').length, 1, '候选保留')
  await h.host.dispose().catch(() => {})
})

test('dream 复核：采集 enrichment 在途期间关闭记忆 -> 不落候选', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  const conversation = makeConversationSummary({ id: 1, profileId: 'assistant' })
  h.backend.conversations.set(1, conversation)
  const entered = deferred()
  const release = deferred()
  h.backend.detailImpl = async (id) => {
    entered.resolve()
    await release.promise
    return { ...makeConversationSummary({ id, profileId: 'assistant' }), entries: makeDetailEntries('好的，已了解。') }
  }
  const settling = h.host.runHook('turn_settled', makeSettled(conversation, [{ text: '以后都用中文回复我', origin: 'human' }]) as never)
  await entered.promise
  await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'assistant', enabled: false })
  release.resolve()
  await settling
  assert.equal(existsSync(dreamDirOf(h, 'assistant')), false, '关闭期间已开始的采集不落候选')
  await h.host.dispose().catch(() => {})
})

test('dream 采集：lastEntryId 过滤下一回合条目；无最终文本不回退 pre-tool 回复', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  // 结算回合水位 = 2：3/4 是已提交的下一回合条目，不得进入摘录
  const conversation = makeConversationSummary({ id: 1, profileId: 'assistant', lastEntryId: 2 })
  h.backend.conversations.set(1, conversation)
  h.backend.detailEntries.set(1, [
    { id: '1', kind: 'pi.user' },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '本回合最终回复' }] }] },
    { id: '3', kind: 'pi.user' },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '下一回合回复' }] }] },
  ] as ConversationDetail['entries'])
  await h.host.runHook('turn_settled', makeSettled(conversation, [{ text: '以后都用中文回复我', origin: 'human' }]) as never)
  let candidates = readCandidates(h, 'assistant')
  assert.equal(candidates[0]!.assistantText, '本回合最终回复', '摘录取结算回合的最终回复（越过水位的下一回合条目排除）')

  // 无最终 assistant 文本（工具调用结尾）：不回退 tool-call 前的更早回复
  const conversation2 = makeConversationSummary({ id: 2, profileId: 'assistant', lastEntryId: 3 })
  h.backend.conversations.set(2, conversation2)
  h.backend.detailEntries.set(2, [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'tool 之前的回复' }] }] },
    { id: '2', kind: 'pi.tool_result', data: {} },
    { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] }] },
  ] as ConversationDetail['entries'])
  await h.host.runHook('turn_settled', makeSettled(conversation2, [{ text: '另外偏好深色主题', origin: 'human' }]) as never)
  candidates = readCandidates(h, 'assistant')
  const second = candidates.find((c) => c.conversationId === 2)!
  assert.equal(second.assistantText, undefined, '无最终 assistant 文本不回落 pre-tool 回复')
  assert.ok(second.humanText.includes('深色主题'), 'human 输入照常落候选')
  await h.host.dispose().catch(() => {})
})

test('dream 复核：等候选串行临界区期间关闭记忆 -> 临界区内复核不落候选', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  const first = makeConversationSummary({ id: 1, profileId: 'assistant' })
  const second = makeConversationSummary({ id: 2, profileId: 'assistant' })
  h.backend.conversations.set(1, first)
  h.backend.conversations.set(2, second)
  h.backend.detailEntries.set(1, makeDetailEntries('第一条回复'))
  h.backend.detailEntries.set(2, makeDetailEntries('第二条回复'))
  // 第一个采集者占据临界区（原子写挂起）；第二个采集者外层复核通过后在链上排队
  const enteredWrite = deferred()
  const releaseWrite = deferred()
  let heldFirst = false
  h.backend.atomicWriteImpl = async (path, content) => {
    if (!heldFirst) {
      heldFirst = true
      enteredWrite.resolve()
      await releaseWrite.promise
    }
    writeFileSync(path, content, 'utf8')
  }
  const settlingFirst = h.host.runHook('turn_settled', makeSettled(first, [{ text: '第一条：以后都用中文回复', origin: 'human' }]) as never)
  await enteredWrite.promise
  const settlingSecond = h.host.runHook('turn_settled', makeSettled(second, [{ text: '第二条：偏好深色主题', origin: 'human' }]) as never)
  await new Promise((resolve) => setImmediate(resolve))
  // 排队期间关闭记忆：临界区内紧邻写入的复核必须拦下第二个候选
  await h.host.invokeAction('builtin:memory', 'configure', { profileId: 'assistant', enabled: false })
  releaseWrite.resolve()
  await Promise.all([settlingFirst, settlingSecond])
  const candidates = readCandidates(h, 'assistant')
  assert.equal(candidates.length, 1, '只落临界区内已过复核的第一条')
  assert.ok(candidates[0]!.humanText.includes('第一条'), '占据临界区的候选正常落盘')
  assert.ok(!candidates.some((c) => c.humanText.includes('第二条')), '等链期间关闭的候选不落盘')
  await h.host.dispose().catch(() => {})
})

test('dream 诊断：失败错误/通知/快照全链过 redact，通知接线可见', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)
  h.backend.completeTextImpl = async () => {
    throw new HelmxError('model_provider_failed', 'upstream leaked sk-secret-123 in request', 502)
  }
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_provider_failed',
  )
  const doc = h.docs.peek<{ runs: Record<string, { error?: string }> }>('builtin:memory:dream')
  const recorded = doc!.runs.assistant!.error ?? ''
  assert.ok(recorded.includes('[redacted]') && !recorded.includes('sk-secret-123'), 'lastError 落盘前过 redact')
  assert.ok(
    h.backend.events.some((e) => e.title.includes('memory dream') && e.body.includes('[redacted]') && !e.body.includes('sk-secret-123')),
    '失败通知接线可见且脱敏',
  )
  const snapshotFiles = readdirSync(join(dreamDirOf(h, 'assistant'), 'snapshots'))
  const snapshot = JSON.parse(
    readFileSync(join(dreamDirOf(h, 'assistant'), 'snapshots', snapshotFiles[0]!), 'utf8'),
  ) as { error?: string }
  assert.ok(snapshot.error !== undefined && snapshot.error.includes('[redacted]') && !snapshot.error.includes('sk-secret-123'), '快照诊断脱敏')
  await h.host.dispose().catch(() => {})
})

test('dream 诊断：坏输出快照零 raw dump，parse 错误不回显原始内容', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  await seedCandidate(h, 'assistant', '偏好深色主题', 5)
  // 非 JSON 输出内嵌「秘密」：诊断只能给限长脱敏短文本，绝不含原始内容
  h.backend.completeTextImpl = async () => 'leaked raw sk-secret-123 marker — definitely not JSON'
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && (err.details as { reason?: string })?.reason === 'not_json',
  )
  const raw = readFileSync(join(dreamDirOf(h, 'assistant'), 'snapshots', readdirSync(join(dreamDirOf(h, 'assistant'), 'snapshots'))[0]!), 'utf8')
  assert.ok(!raw.includes('modelOutput'), '快照不再持久化 raw model output')
  assert.ok(!raw.includes('leaked raw') && !raw.includes('{{SECRET'), '快照零原始内容')
  const doc = h.docs.peek<{ runs: Record<string, { error?: string }> }>('builtin:memory:dream')
  const recorded = doc!.runs.assistant!.error ?? ''
  assert.ok(!recorded.includes('leaked raw') && !recorded.includes('{{SECRET'), '运行记录错误不回显原始内容')
  assert.ok(recorded.includes('not_json'), '机器可读 reason 保留')
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '零写回')
  assert.equal(readCandidates(h, 'assistant').length, 1, '候选保留')
  await h.host.dispose().catch(() => {})
})

test('dream 腐败文件：读取不清空、显式报错；focused status 只读目标', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  const corrupt = '{ not json !!!'
  mkdirSync(dreamDirOf(h, 'assistant'), { recursive: true })
  writeFileSync(join(dreamDirOf(h, 'assistant'), 'candidates.json'), corrupt, 'utf8')
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_candidates_corrupt',
    '坏候选文件显式报错',
  )
  assert.equal(readFileSync(join(dreamDirOf(h, 'assistant'), 'candidates.json'), 'utf8'), corrupt, '读取失败绝不重置/清空文件')
  // 聚焦查询只读目标 Profile：另一个 Profile 的坏文件不影响
  mkdirSync(dreamDirOf(h, 'coder'), { recursive: true })
  writeFileSync(
    join(dreamDirOf(h, 'coder'), 'candidates.json'),
    JSON.stringify({ version: 1, candidates: [{ id: 'c1', conversationId: 9, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: Date.now() }] }),
    'utf8',
  )
  const focused = (await h.host.invokeAction('builtin:memory', 'dream_status', { profileId: 'coder' })) as {
    profileId: string; profiles: Array<{ profileId: string; candidateCount: number }>
  }
  assert.equal(focused.profileId, 'coder')
  assert.equal(focused.profiles.length, 1, '聚焦只读目标')
  assert.equal(focused.profiles[0]!.candidateCount, 1)
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream_status', { profileId: 'assistant' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_candidates_corrupt',
    '聚焦目标坏文件显式报错（不显示为 0）',
  )
  await assert.rejects(
    () => h.host.invokeAction('builtin:memory', 'dream_status', {}),
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_candidates_corrupt',
    '全局视图遇坏文件也显式报错（不显示为 0）',
  )
  await h.host.dispose().catch(() => {})
})

// ---------------------------------------------------------------------------
// 引擎级调度（MemoryDocStore 真实 doc + 可控时钟）：过期补跑 / claim 先行 / stop 追踪 / TTL
// ---------------------------------------------------------------------------

interface EngineHarness {
  engine: ReturnType<typeof createDreamEngine>
  docs: MemoryDocStore
  clock: FakeClock
  dir: string
  store: MemoryStore
  calls: Array<{ conversationId: number; text: string; maxTokens?: number; signal?: AbortSignal }>
  events: Array<{ title: string; detail: string }>
  setCompleteText(impl: (input: { signal?: AbortSignal }) => Promise<string>): void
  setMemoryEnabled(enabled: boolean): void
  setProfilesList(impl: () => Promise<Array<{ id: string }>>): void
}

const ENGINE_DOC_KEY = 'builtin:memory:dream'

function makeEngineDoc(docs: MemoryDocStore): PluginDocHandle<DreamDoc> {
  const initial: DreamDoc = { version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {} }
  return {
    get: () => docs.get<DreamDoc>(ENGINE_DOC_KEY, initial),
    set: (value) => docs.set(ENGINE_DOC_KEY, value),
    update: (fn) => docs.set(ENGINE_DOC_KEY, fn(docs.get<DreamDoc>(ENGINE_DOC_KEY, initial))),
    flush: async () => {
      await docs.flush()
    },
  }
}

function seedEngineCandidates(
  dir: string,
  profileId: string,
  candidates: Array<{ id: string; conversationId: number; conversationTitle: string; humanText: string; collectedAt: number }>,
): void {
  const profileDir = join(dir, 'plugins', 'builtin%3Amemory', 'dream', profileId)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'candidates.json'), JSON.stringify({ version: 1, candidates }), 'utf8')
}

function makeEngineHarness(
  t: test.TestContext,
  options: { startMs?: number; memoryEnabled?: boolean; modelTimeoutMs?: number; reuse?: { dir: string; docs: MemoryDocStore; clock: FakeClock } } = {},
): EngineHarness {
  const dir = options.reuse?.dir ?? scratchDir(t, 'memory-dream-engine')
  const docs = options.reuse?.docs ?? new MemoryDocStore()
  const clock = options.reuse?.clock ?? new FakeClock(options.startMs ?? Date.parse('2026-01-15T00:00:00Z'))
  let memoryEnabled = options.memoryEnabled ?? true
  let completeTextImpl: (input: { signal?: AbortSignal }) => Promise<string> = async () => '{"memory":"# Memory"}'
  let profilesListImpl: () => Promise<Array<{ id: string }>> = async () => [{ id: 'assistant' }]
  const calls: EngineHarness['calls'] = []
  const events: EngineHarness['events'] = []
  const store = new MemoryStore(createProfileFileHost(dir, new ProfileService(dir)))
  const engine = createDreamEngine(
    {
      dataDir: join(dir, 'plugins', 'builtin%3Amemory'),
      doc: makeEngineDoc(docs),
      redact: (text) => text.replaceAll('sk-secret-123', '[redacted]'),
      atomicWriteFile: async (path, content) => {
        writeFileSync(path, content, 'utf8')
      },
      completeText: async (input) => {
        calls.push(input)
        return completeTextImpl(input)
      },
      listConversations: () => [makeConversationSummary({ id: 1, profileId: 'assistant' })],
      getConversationDetail: async () => ({ entries: [] }) as never,
      store,
      profiles: { list: () => profilesListImpl() },
      isMemoryEnabled: () => memoryEnabled,
      emitError: (title, detail) => {
        events.push({ title, detail: detail instanceof Error ? detail.message : String(detail) })
      },
    },
    { clock: clock.api, ...(options.modelTimeoutMs !== undefined ? { modelTimeoutMs: options.modelTimeoutMs } : {}) },
  )
  return {
    engine,
    docs,
    clock,
    dir,
    store,
    calls,
    events,
    setCompleteText: (impl) => {
      completeTextImpl = impl
    },
    setMemoryEnabled: (enabled) => {
      memoryEnabled = enabled
    },
    setProfilesList: (impl) => {
      profilesListImpl = impl
    },
  }
}

/** 进入模型后可被 abort 中止的脚本化 completeText（进入即通知 entered）。 */
function gatedModelCall(entered: Deferred<void>): (input: { signal?: AbortSignal }) => Promise<string> {
  return (input) =>
    new Promise<string>((resolve, reject) => {
      entered.resolve()
      const timer = setTimeout(() => resolve('{"memory":"# Memory"}'), 60_000)
      timer.unref?.()
      input.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new HelmxError('aborted', 'cancelled', 409))
        },
        { once: true },
      )
    })
}

test('dream 调度（引擎级）：过期补跑一次、claim 先行、重启不重跑', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  seedEngineCandidates(h.dir, 'assistant', [
    { id: 'c1', conversationId: 1, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: t0 },
  ])
  // 停机错过的已过期调度点
  h.docs.set(ENGINE_DOC_KEY, { version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {}, nextRunAt: t0 - 60_000 })
  const entered = deferred()
  h.setCompleteText(gatedModelCall(entered))
  await h.engine.start()
  const catchUp = h.docs.peek<{ nextRunAt?: number }>(ENGINE_DOC_KEY)
  assert.ok(catchUp?.nextRunAt !== undefined && catchUp.nextRunAt <= t0 + 10, '过期点启动即补跑（now+1）')
  await h.clock.advance(5)
  await entered.promise
  // claim 先行：模型仍在途，nextRunAt 已推进到下一个每日点（午夜后的下一个 03:00 即当日；
  // 崩溃窗口不重跑）
  const claimed = h.docs.peek<{ nextRunAt?: number }>(ENGINE_DOC_KEY)
  assert.equal(claimed!.nextRunAt, Date.parse('2026-01-15T03:00:00Z'), '执行前 claim 已推进')
  assert.equal(h.calls[0]!.maxTokens, DREAM_MAX_TOKENS, '模型调用显式输出预算')
  // 模拟崩溃后重启：同一 doc/文件上重建引擎，不得重跑已 claim 的点
  await h.engine.stop()
  const restarted = makeEngineHarness(t, { reuse: { dir: h.dir, docs: h.docs, clock: h.clock } })
  await restarted.engine.start()
  const afterRestart = h.docs.peek<{ nextRunAt?: number }>(ENGINE_DOC_KEY)
  assert.equal(afterRestart!.nextRunAt, Date.parse('2026-01-15T03:00:00Z'), '重启不回退/不重跑已 claim 的点')
  await restarted.clock.advance(60_000)
  assert.equal(restarted.calls.length, 0, '重启后短窗内零补跑')
  await restarted.engine.stop()
})

test('dream 调度（引擎级）：stop 追踪已触发 sweep，返回后零 doc 写零 timer', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  seedEngineCandidates(h.dir, 'assistant', [
    { id: 'c1', conversationId: 1, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: t0 },
  ])
  h.docs.set(ENGINE_DOC_KEY, { version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {}, nextRunAt: t0 + 10 })
  const entered = deferred()
  h.setCompleteText(gatedModelCall(entered))
  await h.engine.start()
  await h.clock.advance(20)
  await entered.promise
  const tasks = h.engine.liveTasks()
  assert.ok(tasks.includes('memory-dream:assistant'), '在途整理可见')
  assert.ok(tasks.includes('memory-dream:sweep'), '已触发 sweep 对 liveTasks 可见')
  await h.engine.stop()
  const writesAfterStop = h.docs.writes.filter((k) => k === ENGINE_DOC_KEY).length
  assert.equal(h.clock.activeTimers(), 0, 'stop 后零 timer')
  // stop 返回后推进时间：不得再有任何 doc 写或 timer
  await h.clock.advance(3 * 24 * 3600 * 1_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.clock.activeTimers(), 0)
  assert.equal(h.docs.writes.filter((k) => k === ENGINE_DOC_KEY).length, writesAfterStop, 'stop 返回后零 doc 写')
  assert.deepEqual(h.engine.liveTasks(), [], '收敛后 liveTasks 清空')
})

test('dream 调度（引擎级）：TTL 过期候选在每日 sweep 实际清除；关闭记忆零模型调用', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0, memoryEnabled: false })
  seedEngineCandidates(h.dir, 'assistant', [
    { id: 'stale', conversationId: 1, conversationTitle: 't', humanText: '过期候选', collectedAt: t0 - 15 * 24 * 3600 * 1_000 },
    { id: 'fresh', conversationId: 2, conversationTitle: 't', humanText: '新鲜候选', collectedAt: t0 },
  ])
  h.docs.set(ENGINE_DOC_KEY, { version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {}, nextRunAt: t0 + 10 })
  await h.engine.start()
  await h.clock.advance(20)
  await h.engine.settle()
  const raw = JSON.parse(
    readFileSync(join(h.dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'candidates.json'), 'utf8'),
  ) as { candidates: Array<{ id: string }> }
  assert.deepEqual(raw.candidates.map((c) => c.id), ['fresh'], 'TTL 过期候选被实际清除，新鲜候选保留')
  assert.equal(h.calls.length, 0, '关闭记忆的 Profile 持候选零模型调用')
  await h.engine.stop()
})

test('dream 发送预算（引擎级）：~20k 整条新近优先、按时间送出、仅消费已发送候选', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  // 30 条 x ~1500 字符 = ~45k：远超 20k 预算；collectedAt 递增（越后越新）
  const seeded = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    conversationId: 1,
    conversationTitle: 't',
    humanText: `候选 ${i}：${'x'.repeat(1_490)}`,
    collectedAt: t0 + i * 1_000,
  }))
  seedEngineCandidates(h.dir, 'assistant', seeded)
  h.setCompleteText(async () => '{"memory":"# Memory\\n- 整理完成"}')
  const result = (await h.engine.dreamFor('assistant')) as {
    ran: boolean; applied: boolean; candidateCount: number; sentCount?: number; consumed?: number
  }
  assert.equal(result.ran, true)
  assert.equal(result.applied, true)
  assert.equal(result.candidateCount, 30, 'candidateCount 如实报告全部在场候选')
  assert.ok(result.sentCount !== undefined && result.sentCount < 30, '发送子集（预算内）')
  assert.equal(result.consumed, result.sentCount, '仅消费实际发送的候选')
  // 单次发送的候选摘录总量在预算内（text 里 candidates 段 = 预算内整条）
  const sentText = h.calls[0]!.text
  const sentMarkers = [...sentText.matchAll(/候选 (\d+)[：:]/g)].map((m) => Number(m[1]))
  assert.equal(sentMarkers.length, result.sentCount, '送出的候选条数与 sentCount 一致')
  // 新近优先：sentMarkers 应是最新的一段（升序送出，但集合来自最新侧）
  assert.deepEqual(sentMarkers, Array.from({ length: sentMarkers.length }, (_, k) => 30 - sentMarkers.length + k), '新近优先选整条、按时间序送出')
  // 预算核算：送出候选的摘录字符总量 ≤ 20k（human + title）
  const sentPayload = seeded
    .filter((c) => sentMarkers.includes(Number(c.id.slice(1))))
    .reduce((sum, c) => sum + c.humanText.length + c.conversationTitle.length, 0)
  assert.ok(sentPayload <= DREAM_CANDIDATE_SEND_BUDGET_CHARS, `发送总量 ${sentPayload} 在预算内`)
  // 只消费已发送：最旧的候选留在盘上等待下次整理
  const left = (
    JSON.parse(readFileSync(join(h.dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'candidates.json'), 'utf8')) as {
      candidates: Array<{ id: string }>
    }
  ).candidates.map((c) => c.id)
  assert.equal(left.length, 30 - result.sentCount!, '未发送候选保留')
  assert.deepEqual(left, Array.from({ length: left.length }, (_, k) => `c${k}`), '留下的恰是最旧一侧')
  // 快照 candidateIds = 实际发送的候选（保留既有元数据语义）
  const snapshot = JSON.parse(
    readFileSync(join(h.dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'snapshots', readdirSync(join(h.dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'snapshots'))[0]!), 'utf8'),
  ) as { candidateCount: number; candidateIds: string[] }
  assert.equal(snapshot.candidateCount, 30)
  assert.equal(snapshot.candidateIds.length, result.sentCount)
  await h.engine.stop()
})

test('dream 取消（引擎级）：port 无视 signal 时 stop/deadline 有界返回、迟到结果永不写回', { timeout: 60_000 }, async (t) => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
  })
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory\n旧偏好。', 'replace')
  seedEngineCandidates(h.dir, 'assistant', [
    { id: 'c1', conversationId: 1, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: t0 },
  ])
  // 无视 abort signal、只在手动放行才返回的模型端口（迟到结果为完全合法的 JSON）
  let lateResolve: ((value: string) => void) | undefined
  h.setCompleteText(
    () =>
      new Promise<string>((resolve) => {
        lateResolve = resolve
      }),
  )
  const pending = h.engine.dreamFor('assistant')
  await new Promise((resolve) => setImmediate(resolve))
  await h.engine.stop()
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_aborted',
    'stop 无须等待模型即有界拒绝',
  )
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', 'stop 路径零写回')
  assert.equal(readFileSync(join(h.dir, 'plugins', 'builtin%3Amemory', 'dream', 'assistant', 'candidates.json'), 'utf8').includes('c1'), true, '候选保留')
  // 迟到结果放行：合法 JSON 也绝不写回，且不产生未处理拒绝
  lateResolve?.('{"memory":"# Memory\\n- 不该写回"}')
  await h.engine.settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await h.store.getMemory('assistant'), '# Memory\n旧偏好。', '迟到结果永不写回')

  // deadline 路径共用同一竞速：modelTimeoutMs 到点 abort，即使端口不响应 signal 也必须返回
  const h2 = makeEngineHarness(t, { startMs: t0, modelTimeoutMs: 60, reuse: { dir: h.dir, docs: h.docs, clock: h.clock } })
  let lateResolve2: ((value: string) => void) | undefined
  h2.setCompleteText(
    () =>
      new Promise<string>((resolve) => {
        lateResolve2 = resolve
      }),
  )
  const pending2 = h2.engine.dreamFor('assistant')
  await assert.rejects(
    () => pending2,
    (err: unknown) => err instanceof HelmxError && err.code === 'dream_aborted',
    'deadline 到点有界拒绝（无视 signal 的端口）',
  )
  assert.equal(await h2.store.getMemory('assistant'), '# Memory\n旧偏好。', 'deadline 路径零写回')
  lateResolve2?.('{"memory":"# Memory\\n- 同样不该写回"}')
  await h2.engine.settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await h2.store.getMemory('assistant'), '# Memory\n旧偏好。', '迟到结果同样永不写回')
  await h2.engine.stop()
  assert.deepEqual(unhandled, [], '全程无未处理拒绝')
})

test('dream 调度（引擎级）：claim 后瞬时报错也必须重挂下次排程', { timeout: 60_000 }, async (t) => {
  const t0 = Date.parse('2026-01-15T00:00:00Z')
  const h = makeEngineHarness(t, { startMs: t0 })
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  seedEngineCandidates(h.dir, 'assistant', [
    { id: 'c1', conversationId: 1, conversationTitle: 't', humanText: '偏好深色主题', collectedAt: t0 },
  ])
  h.docs.set(ENGINE_DOC_KEY, { version: 1, config: { enabled: true, hour: 3, timezone: 'UTC' }, runs: {}, nextRunAt: t0 + 10 })
  const entered = deferred()
  h.setCompleteText(gatedModelCall(entered))
  // 第一次扫掠：claim 成功后 profiles.list 瞬时报错（此前会静默死掉 timer，直到重启）
  let failFirst = true
  h.setProfilesList(async () => {
    if (failFirst) {
      failFirst = false
      throw new Error('transient profile store hiccup')
    }
    return [{ id: 'assistant' }]
  })
  await h.engine.start()
  await h.clock.advance(20)
  await waitFor(() => h.clock.activeTimers() >= 1, { timeoutMs: 10_000, message: '瞬时报错后仍重挂下次排程' })
  assert.ok(
    h.events.some((e) => e.title.includes('memory dream sweep failed')),
    '扫掠失败显式报告',
  )
  const claimed = h.docs.peek<{ nextRunAt?: number }>(ENGINE_DOC_KEY)
  assert.ok(claimed?.nextRunAt !== undefined && claimed.nextRunAt > t0 + 20, 'claim 已推进（该点不重跑）')
  // 恢复后到点正常整理
  await h.clock.advance(claimed!.nextRunAt! - h.clock.api.now() + 10)
  await entered.promise
  await waitFor(() => h.calls.length === 1, { timeoutMs: 10_000, message: '下个调度点正常整理' })
  await h.engine.stop()
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
          profiles: Array<{ profileId: string; candidateCount: number }>
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

test('dream 配置：dreamModel 声明为 format="model" 且显式设置后透传给 completeText', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness(t)
  const schema = h.host.getConfigSchema('builtin:memory')
  assert.equal(schema.dreamModel?.type, 'string')
  assert.equal(schema.dreamModel?.format, 'model')

  // 默认未配置：不传 model 字段（沿用会话模型）
  await h.store.updateMemory('assistant', '# Memory', 'replace')
  await seedCandidate(h, 'assistant', '偏好简洁输出', 11)
  h.backend.completeTextImpl = async () => '{"memory":"# Memory\\n- 偏好简洁输出"}'
  await h.host.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })
  assert.equal((h.backend.completeTextCalls[0] as { model?: string }).model, undefined)

  // 配置 dreamModel：透传到 completeText
  const dreamCfg = new Map<string, Record<string, unknown>>([['builtin:memory', { dreamModel: 'openai/gpt-5-mini' }]])
  const hostWithConfig = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir: h.dataDir,
    docs: h.docs,
    config: {
      get: (id) => dreamCfg.get(id) ?? {},
      set: async (id, val) => { dreamCfg.set(id, val) },
    },
    host: (h.host as unknown as { options: { host: unknown } }).options.host as never,
  })
  await hostWithConfig.register(createMemoryPlugin({ dream: { clock: h.clock.api } }), { enabled: true })
  await seedCandidate(h, 'assistant', '使用 pnpm', 11)
  h.backend.completeTextCalls.length = 0
  await hostWithConfig.invokeAction('builtin:memory', 'dream', { profileId: 'assistant' })
  assert.equal((h.backend.completeTextCalls[0] as { model?: string }).model, 'openai/gpt-5-mini')
  await hostWithConfig.dispose().catch(() => {})
  await h.host.dispose().catch(() => {})
})
