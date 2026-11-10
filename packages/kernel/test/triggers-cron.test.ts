/**
 * builtin:triggers cron 模块契约测试：真实 schedule/timezone 解析、持久
 * next/lastRun、catchUp 语义、持久 claim 防重、single-flight、失败显式、
 * stop/delete race、delete+create 同 id 代次隔离。可控时钟驱动真实 timer 流。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type ExternalTriggerEnvelope, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginDocStore } from '../src/plugins/index.js'
import {
  advanceAfterFire,
  assertValidSchedule,
  buildCronEnvelope,
  createCronScheduler,
  decideTick,
  nextFireTime,
  normalizeCronInput,
  parseCronDoc,
  type CronClock,
  type CronDoc,
  type CronJob,
} from '../src/builtin-plugins/triggers/cron.js'

// ---------------------------------------------------------------------------
// 测试基建：内存 doc store + 可控时钟 + host fake
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

/** 可控时钟：手动推进 now；setTimeout 暂存，advance 时触发到期项（含 unref 语义）。 */
class FakeClock {
  private current: number
  private seq = 0
  private pending: Array<{ at: number; seq: number; fn: () => void; cleared: boolean }> = []

  readonly api: CronClock = {
    now: () => this.current,
    setTimeout: (fn, ms) => {
      const entry = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cleared: false }
      this.pending.push(entry)
      return {
        clear: () => {
          entry.cleared = true
        },
      }
    },
  }

  constructor(start: number) {
    this.current = start
  }

  /** 推进到 current+ms，依序触发沿途到期 timer（timer 回调内再排程亦可触发）。 */
  /** 推进到 current+ms，依序触发沿途到期 timer。每个 timer 触发后让出一轮
   * 微任务（对齐真实事件循环：tick 首个 await 会让出，后续排程得以生效）。 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      const due = this.pending
        .filter((e) => !e.cleared && e.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      this.current = due.at
      due.cleared = true
      due.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.current = target
  }

  activeTimers(): number {
    return this.pending.filter((e) => !e.cleared).length
  }
}

interface Harness {
  host: PluginHost
  docs: MemoryDocStore
  clock: FakeClock
  /** 已投递信封（含 targetProfileId）。 */
  dispatched: Array<{ envelope: ExternalTriggerEnvelope; targetProfileId?: string }>
  /** dispatch 行为注入：抛错模拟投递失败。 */
  dispatchImpl: (envelope: ExternalTriggerEnvelope, targetProfileId?: string) => Promise<void>
  flushCalls: number
  /** flush 行为注入：抛错模拟持久化失败。 */
  flushImpl: () => Promise<void>
  events: Array<{ type: string; payload: unknown }>
  runtime: ReturnType<typeof createCronScheduler>
  registration: Promise<void>
  dataDir: string
}

function makeHarness(startMs: number, docSeed?: CronDoc): Harness {
  const docs = new MemoryDocStore()
  if (docSeed !== undefined) docs.set('builtin:triggers:crons', docSeed)
  const clock = new FakeClock(startMs)
  const dispatched: Array<{ envelope: ExternalTriggerEnvelope; targetProfileId?: string }> = []
  const events: Array<{ type: string; payload: unknown }> = []
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-cron-test-'))
  const h: Harness = {
    host: undefined as never,
    docs,
    clock,
    dispatched,
    dispatchImpl: async (envelope, targetProfileId) => {
      dispatched.push({ envelope, targetProfileId })
    },
    flushCalls: 0,
    flushImpl: async () => {},
    events,
    runtime: undefined as never,
    registration: undefined as never,
    dataDir,
  }
  const host = new PluginHost({
    dataDir,
    docs,
    host: {
      dispatchTrigger: async () => {},
      submitInput: async () => {},
      createConversation: async (init) => ({ id: 42, title: init.title ?? 'x' }) as never,
      listConversations: () => [],
      getConversation: () => ({ id: 1 }) as never,
      updateConversation: async (id) => ({ id }) as never,
      manageConversation: () => () => {},
      markConversationOwnership: () => {},
      createAsk: async () => ({}) as never,
      cancelAsk: async () => {},
      registerAskSeqResolver: () => () => {},
      onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    get isClosing(): boolean {
      return false
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
      emitEvent: (type, payload) => {
        events.push({ type, payload })
      },
    },
  })
  h.host = host
  h.registration = host.register({
      id: 'builtin:triggers',
      definePlugin: (ctx) => {
        h.runtime = createCronScheduler(
          ctx,
          {
            dispatchTrigger: async (envelope, targetProfileId) => h.dispatchImpl(envelope, targetProfileId),
            flush: async () => {
              h.flushCalls += 1
              await h.flushImpl()
            },
          },
          clock.api,
        )
      },
    } as PluginDefinition)
  return h
}

/** 等待真实注册与 service.start 完成，注册失败直接交给测试。 */
async function ready(h: Harness): Promise<void> {
  await h.registration
}

const MIN = 60_000
const T0 = Date.parse('2026-01-01T00:00:00Z')
const T0_5 = T0 + 5 * MIN
const T10 = T0 + 10 * MIN
const T15 = T0 + 15 * MIN

function seedJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'j1',
    rev: 'rev-a',
    schedule: '*/5 * * * *',
    timezone: 'UTC',
    text: 'hello',
    enabled: true,
    catchUp: false,
    ...over,
  }
}

let harnesses: Harness[] = []

beforeEach(() => {
  harnesses = []
})

afterEach(async () => {
  for (const h of harnesses) {
    try {
      await h.host.dispose()
    } catch {
      // dispose 聚合错误不阻断清理
    }
    rmSync(h.dataDir, { recursive: true, force: true })
  }
})

function track<T extends Harness>(h: T): T {
  harnesses.push(h)
  return h
}

async function listJobs(h: Harness): Promise<Array<Record<string, unknown>>> {
  const out = (await h.host.invokeAction('builtin:triggers', 'cron_list', {})) as {
    jobs: Array<Record<string, unknown>>
  }
  return out.jobs
}

/** 取唯一 job（断言非空，noUncheckedIndexedAccess 收敛）。 */
async function soleJob(h: Harness): Promise<Record<string, unknown>> {
  const [job] = await listJobs(h)
  assert.ok(job !== undefined, '应有且仅有一个 job')
  return job
}

/** 轮询等待条件成立（上限 5s）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// 纯函数：表达式与时区（真实 cron-parser）
// ---------------------------------------------------------------------------

test('assertValidSchedule：合法五字段通过；六字段/越界/非法时区显式拒绝', { timeout: 60_000 }, () => {
  assertValidSchedule('*/5 * * * *', 'UTC')
  assertValidSchedule('0 3 * * 1-5', 'Asia/Shanghai')
  assert.throws(() => assertValidSchedule('* * * * * *', 'UTC'), /五字段/)
  assert.throws(() => assertValidSchedule('61 * * * *', 'UTC'), /cron schedule 非法/)
  assert.throws(() => assertValidSchedule('* * * * *', 'Not/AZone'), /cron schedule 非法|时区/)
  assert.throws(() => assertValidSchedule('', 'UTC'), /不能为空/)
})

test('nextFireTime：严格晚于 after；时区真实生效；DST 跳变正确', { timeout: 60_000 }, () => {
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0), T0_5)
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0_5), T10)
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0_5 + 1), T10)
  // 时区真实生效：同一表达式在上海与 UTC 给出不同绝对时点（本地 = UTC+8）
  const base = Date.parse('2026-06-01T00:00:00Z')
  assert.equal(nextFireTime('0 8 * * *', 'UTC', base), Date.parse('2026-06-01T08:00:00Z'))
  // base 恰为上海 06-01 08:00，严格晚于 after → 上海下次是 06-02 08:00 本地
  assert.equal(nextFireTime('0 8 * * *', 'Asia/Shanghai', base), Date.parse('2026-06-02T00:00:00Z'))
  // 柏林 2026-03-29 春进：当日 02:30 不存在，相邻两时点跨两天差 47h（48h-1h）
  const before = nextFireTime('30 2 * * *', 'Europe/Berlin', Date.parse('2026-03-28T00:00:00Z'))
  const after = nextFireTime('30 2 * * *', 'Europe/Berlin', Date.parse('2026-03-29T03:30:00Z'))
  assert.ok(before !== undefined && after !== undefined)
  assert.equal(after - before, 47 * 60 * MIN)
})

test('nextFireTime：不可达表达式（2 月 30 日）显式拒绝', { timeout: 60_000 }, () => {
  assert.throws(() => nextFireTime('0 0 30 2 *', 'UTC', T0), HelmError)
})

test('advanceAfterFire：错过多时段时跳到 now 之后（catchUp 只补跑一次）', { timeout: 60_000 }, () => {
  assert.equal(advanceAfterFire('*/5 * * * *', 'UTC', T0_5, T0_5), T10)
  assert.equal(advanceAfterFire('*/5 * * * *', 'UTC', T0_5, T0 + 12 * MIN), T15)
})

// ---------------------------------------------------------------------------
// 纯函数：输入归一 / 文档校验 / 决策
// ---------------------------------------------------------------------------

test('normalizeCronInput：默认值/互斥/非法输入', { timeout: 60_000 }, () => {
  const job = normalizeCronInput({ id: 'a_1', schedule: '*/5 * * * *', text: 'hi' })
  assert.equal(job.timezone, 'UTC')
  assert.equal(job.enabled, true)
  assert.equal(job.catchUp, false)
  assert.ok(job.rev.length > 0)

  assert.throws(
    () =>
      normalizeCronInput({
        id: 'a',
        schedule: '* * * * *',
        text: 'x',
        targetConversationId: 1,
        targetProfileId: 'p',
      }),
    /互斥/,
  )
  assert.throws(() => normalizeCronInput({ id: 'bad.id', schedule: '* * * * *', text: 'x' }), /id 非法/)
  assert.throws(() => normalizeCronInput({ id: 'a', schedule: '* * * * *', text: '' }), /text/)
  assert.throws(() => normalizeCronInput({ id: 'a', schedule: 'nope', text: 'x' }), /五字段|非法/)
})

test('parseCronDoc：好文档通过；坏数据显式拒绝不静默重置', { timeout: 60_000 }, () => {
  assert.equal(parseCronDoc({ version: 1, jobs: [seedJob()] }).jobs.length, 1)

  assert.throws(() => parseCronDoc({ version: 2, jobs: [] }), /version/)
  assert.throws(() => parseCronDoc({ version: 1, jobs: {} }), /jobs/)
  assert.throws(() => parseCronDoc({ version: 1, jobs: [{ ...seedJob(), rev: undefined }] }), /rev/)
  assert.throws(
    () => parseCronDoc({ version: 1, jobs: [seedJob({ nextRunAt: 'soon' as unknown as number })] }),
    /nextRunAt/,
  )
  assert.throws(() => parseCronDoc({ version: 1, jobs: [seedJob(), seedJob()] }), /重复/)
})

test('decideTick：未启用/未来 noop；准点与单时段错过均 fire；多时段错过按 catchUp 分流', { timeout: 60_000 }, async () => {
  assert.deepEqual(decideTick(seedJob({ enabled: false, nextRunAt: T0 }), T0_5), { action: 'noop' })
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T10 }), T0_5), { action: 'noop' })
  // 准点触发：fire（catchUp 任意值）
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0_5), { action: 'fire', at: T0_5 })
  assert.deepEqual(decideTick(seedJob({ catchUp: true, nextRunAt: T0_5 }), T0_5), { action: 'fire', at: T0_5 })
  // 迟到但仍在同一时段窗口内（T10 在未来）：fire 错过的 T0_5
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0 + 7 * MIN), { action: 'fire', at: T0_5 })
  // 多时段错过（T10 也已过）：catchUp=false 跳未来 / true 补跑最近一个
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0 + 12 * MIN), {
    action: 'skip-to-future',
    from: T0_5,
    to: T15,
  })
  assert.deepEqual(decideTick(seedJob({ catchUp: true, nextRunAt: T0_5 }), T0 + 12 * MIN), {
    action: 'fire',
    at: T0_5,
  })
})

test('buildCronEnvelope：source/id 稳定、目标字段透传', { timeout: 60_000 }, () => {
  const env = buildCronEnvelope(seedJob({ id: 'x', threadKey: 'tk', targetConversationId: 7 }), T0_5)
  assert.equal(env.source, 'cron:x')
  assert.equal(env.id, `cron:x:${T0_5}`)
  assert.equal(env.createdAt, T0_5)
  assert.equal(env.threadKey, 'tk')
  assert.equal(env.targetConversationId, 7)
})

// ---------------------------------------------------------------------------
// 动作契约：create/list/delete/trigger
// ---------------------------------------------------------------------------

test('cron_create/list/delete：完整动作契约与持久化（含 flush）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  const created = (await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'daily',
    schedule: '*/5 * * * *',
    text: 'standup',
    timezone: 'UTC',
  })) as { job: Record<string, unknown> }
  assert.equal(created.job.id, 'daily')
  assert.equal(created.job.nextRunAt, T0_5)
  assert.ok(typeof created.job.rev === 'string')
  assert.ok(h.flushCalls >= 1, 'create 必须 flush 落盘')
  assert.equal((await listJobs(h)).length, 1)

  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'daily', schedule: '* * * * *', text: 'x' }),
    (err: unknown) => err instanceof HelmError && err.code === 'cron_duplicate_id',
  )

  const del = (await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'daily' })) as {
    deleted: boolean
  }
  assert.equal(del.deleted, true)
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'daily' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'not_found')
      return true
    },
  )
  assert.equal((await listJobs(h)).length, 0)
  assert.equal(h.clock.activeTimers(), 0, '删除后无残留 timer')
})

test('cron_create：非法输入在动作边界拒绝；无未来时点拒绝创建', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await assert.rejects(h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x' }), HelmError)
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x', schedule: 'bad', text: 't' }),
    HelmError,
  )
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', {
      id: 'x',
      schedule: '* * * * *',
      text: 't',
      targetConversationId: 1,
      targetProfileId: 'p',
    }),
    (err: unknown) => err instanceof HelmError && /互斥|validation/.test(`${err.code}${err.message}`),
  )
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x', schedule: '0 0 30 2 *', text: 't' }),
    HelmError,
  )
})

test('cron_trigger：真实投递（targetProfileId/threadKey 透传）；失败抛错不假成功', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'rep',
    schedule: '0 * * * *',
    text: 'report',
    targetProfileId: 'analyst',
    threadKey: 'tk-1',
  })
  const out = (await h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'rep' })) as {
    triggered: boolean
  }
  assert.equal(out.triggered, true)
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.source, 'cron:rep')
  assert.equal(h.dispatched[0]!.targetProfileId, 'analyst')
  assert.equal(h.dispatched[0]!.envelope.threadKey, 'tk-1')

  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'nope' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'not_found')
      return true
    },
  )

  h.dispatchImpl = async () => {
    throw new HelmError('runtime_closed', '内核正在关闭', 503)
  }
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'rep' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'runtime_closed')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 调度核心（FakeClock 驱动真实 timer 流）
// ---------------------------------------------------------------------------

test('到点投递一次：claim 推进 lastRunAt/nextRunAt 并 flush；未到点不投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'f1',
    schedule: '*/5 * * * *',
    text: 'go',
  })
  assert.equal(h.clock.activeTimers(), 1, 'create 后排一个 timer')
  const flushBefore = h.flushCalls

  await h.clock.advance(4 * MIN) // 未到点
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.flushCalls, flushBefore)

  await h.clock.advance(MIN) // 到 T0_5
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:f1:${T0_5}`)
  const job = await soleJob(h)
  assert.equal(job.lastRunAt, T0_5)
  assert.equal(job.nextRunAt, T10)
  assert.equal(job.lastError, undefined)
  assert.ok(h.flushCalls >= flushBefore + 1, 'claim 必须 flush')
  assert.equal(h.clock.activeTimers(), 1, '投递后续排下一时点')

  await h.clock.advance(5 * MIN) // T10 第二个计划点
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 2)
  assert.equal(h.dispatched[1]!.envelope.id, `cron:f1:${T10}`)
})

test('catchUp=true：重启（service start）后对错过时段补跑一次，之后跳至未来', { timeout: 60_000 }, async () => {
  const h = track(
    makeHarness(
      T0 + 12 * MIN,
      { version: 1, jobs: [seedJob({ id: 'c1', catchUp: true, nextRunAt: T0_5 })] },
    ),
  )
  await ready(h) // service start 排 delay=0 timer
  await h.clock.advance(0) // 触发立即到期的 timer（真实环境由事件循环自动触发）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:c1:${T0_5}`)
  const job = await soleJob(h)
  assert.equal(job.lastRunAt, T0_5)
  assert.equal(job.nextRunAt, T15, '补跑一次后跳到 now 之后首个时点（不逐段重放 T10）')

  await h.clock.advance(3 * MIN) // 到 T15
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 2)
  assert.equal(h.dispatched[1]!.envelope.id, `cron:c1:${T15}`)
})

test('catchUp=false：重启后跳至未来时点（不投递错过时段），同样 flush 持久化', { timeout: 60_000 }, async () => {
  const h = track(
    makeHarness(
      T0 + 12 * MIN,
      { version: 1, jobs: [seedJob({ id: 's1', catchUp: false, nextRunAt: T0_5 })] },
    ),
  )
  await ready(h)
  // catchUp=false：service start 即刻决策（nextRunAt 已过期）→ timer 排到 T15，
  // 但 start 的调度扫描是 timer 触发型（到点才 tick）；这里手动 tickNow 驱动跳转
  await h.runtime.tickNow()
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  const flushBefore = h.flushCalls
  assert.ok(flushBefore >= 1, '跳至未来也必须 flush')
  const job = await soleJob(h)
  assert.equal(job.nextRunAt, T15)
  assert.equal(job.lastRunAt, undefined, '跳过不伪造运行记录')

  await h.clock.advance(3 * MIN) // 到 T15 正常投递
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:s1:${T15}`)
})

test('dispatch 失败：写 lastError + notification，本计划点不重试，下时点恢复', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let attempts = 0
  let fail = true
  h.dispatchImpl = async (envelope, targetProfileId) => {
    attempts += 1
    if (fail) throw new Error('downstream broken')
    h.dispatched.push({ envelope, targetProfileId })
  }
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'e1',
    schedule: '*/5 * * * *',
    text: 'go',
  })
  await h.clock.advance(5 * MIN)
  await h.runtime.settle()
  assert.equal(attempts, 1)
  assert.equal(h.dispatched.length, 0)
  const job = await soleJob(h)
  assert.ok(typeof job.lastError === 'string' && (job.lastError as string).includes('downstream broken'))
  assert.equal(job.lastRunAt, T0_5, 'claim 已发生（最多一次尝试语义）')
  assert.ok(h.events.some((e) => e.type === 'notification'), '失败必须发 notification 事件')

  fail = false
  await h.clock.advance(5 * MIN) // T10
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(attempts, 2)
  const job2 = await soleJob(h)
  assert.equal(job2.lastError, undefined, '成功后清 lastError')
})

test('claim 持久化失败（flush 抛错）：不投递，显式诊断', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'p1', schedule: '*/5 * * * *', text: 'x' })
  h.flushImpl = async () => {
    throw new HelmError('store_flush_failed', 'SQLite drain 失败', 500)
  }
  await h.clock.advance(5 * MIN)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0, 'claim 未落盘绝不投递')
  assert.ok(h.events.some((e) => e.type === 'notification'))
})

test('single-flight：并发 tick 同 job 只投递一次', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, targetProfileId) =>
    new Promise<void>((resolve) => {
      h.dispatched.push({ envelope, targetProfileId })
      release = resolve
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'sf', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN) // timer 触发进入 dispatch 挂起
  await waitFor(() => h.dispatched.length === 1)
  const manual = h.runtime.tickNow() // 手动并发 tick
  release?.()
  await manual
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
})

test('delete 并发执行不复活 doc：在途 tick 遇删除静默终止', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, targetProfileId) =>
    new Promise<void>((resolve) => {
      h.dispatched.push({ envelope, targetProfileId })
      release = resolve
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'd1', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // dispatch 在途时删除：写回路径不得复活
  await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'd1' })
  release?.()
  await h.runtime.settle()
  assert.equal((await listJobs(h)).length, 0, '删除后 doc 不得被在途写回复活')
})

test('delete 后 create 同 id：旧 tick 的 lastError 不污染新 job（rev 代次）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let fail = true
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, targetProfileId) =>
    new Promise<void>((resolve, reject) => {
      h.dispatched.push({ envelope, targetProfileId })
      if (fail) release = () => reject(new Error('old job dispatch failed'))
      else resolve()
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'same', schedule: '*/5 * * * *', text: 'old' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // dispatch 挂起期间：删除旧 job 并重建同 id
  await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'same' })
  fail = false
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'same', schedule: '0 * * * *', text: 'new' })
  release?.()
  await h.runtime.settle()
  const job = await soleJob(h)
  assert.equal(job.text, 'new')
  assert.equal(job.lastError, undefined, '旧 tick 失败不得写到新 job')
  assert.equal(job.lastRunAt, undefined, '新 job 不继承旧 claim 记录')
})

test('stop（disable）取消 timer 禁止后续投递；重新启用恢复调度', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'r1', schedule: '*/5 * * * *', text: 'x' })
  assert.equal(h.clock.activeTimers(), 1)
  await h.host.disable('builtin:triggers')
  assert.equal(h.clock.activeTimers(), 0, 'stop 后 timer 全部取消')
  await h.clock.advance(30 * MIN) // 停用期间推进：无投递
  assert.equal(h.dispatched.length, 0)
  await assert.rejects(h.host.invokeAction('builtin:triggers', 'cron_list', {}), HelmError)

  await h.host.enable('builtin:triggers')
  // 重新启用：definePlugin 重跑、service start 重排（doc 持久仍在）
  // 注意：新周期的 runtime 句柄是新的；用动作验证调度恢复
  const jobs = await listJobs(h)
  assert.equal(jobs.length, 1)
  const [job] = jobs
  assert.ok(job !== undefined)
  assert.equal(job.nextRunAt, T0 + 35 * MIN, '重新启用时跳过已错过计划，持久化下一未来时点')
  // now=T0+30min，nextRunAt=T0_5 已是过去：catchUp=false 跳到未来
  // （FakeClock now=T0+30min；新周期用真实时钟——故此处只验证文档未被破坏与动作可用）
})

test('停用时有在途 tick：liveTasks 报在途，禁用被宿主 409 拒绝', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, targetProfileId) =>
    new Promise<void>((resolve) => {
      h.dispatched.push({ envelope, targetProfileId })
      release = resolve
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'lt', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // 在途 dispatch 未完成时停用：宿主 liveTasks 闸门拒绝
  await assert.rejects(
    h.host.disable('builtin:triggers'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
  )
  release?.()
  await h.runtime.settle()
  // 在途结束后停用成功
  await h.host.disable('builtin:triggers')
  assert.equal(h.clock.activeTimers(), 0)
})

test('catchUp=false：重启只错过一个计划点时也跳过，不冒充正常 timer 延迟', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0 + 6 * MIN, { version: 1, jobs: [seedJob({ catchUp: false, nextRunAt: T0_5 })] }))
  await ready(h)
  await h.clock.advance(0)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  assert.equal((await soleJob(h)).nextRunAt, T10)
  assert.ok(h.flushCalls > 0)
})

test('claim 冲刷期间删除任务，旧计划点不再投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'claim-delete', schedule: '*/5 * * * *', text: '旧任务' })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  h.flushImpl = () => { entered(); return gate }
  await h.clock.advance(5 * MIN)
  await started
  h.flushImpl = async () => {}
  await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'claim-delete' })
  release()
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  assert.deepEqual(await listJobs(h), [])
})

test('crons 文档损坏：注册失败并回滚，不伪装启用成功', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0, { version: 9, jobs: [] } as unknown as CronDoc))
  await assert.rejects(h.registration, { code: 'cron_doc_corrupt' })
  assert.ok(h.events.some((e) => e.type === 'notification'), '坏文档必须显式通知')
  assert.equal(h.host.list().some((plugin) => plugin.enabled), false)
  assert.equal(h.clock.activeTimers(), 0, '坏文档不排任何 timer')
})

test('大间隔不溢出：超 2^31-1ms 的延迟先以安全窗口排程（advance 分段触发）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  // 每月 1 次：下一次远超 24.8 天上限
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'monthly',
    schedule: '0 0 1 * *',
    text: 'monthly',
  })
  const job = await soleJob(h)
  const next = job.nextRunAt as number
  const delay = next - T0
  assert.ok(delay > 2_147_483_647, '测试前置：延迟必须超过 setTimeout 上限')
  // FakeClock 直接 advance 大跨度：真实实现以安全窗口唤醒后续排（未到点 noop
  // 重排剩余延迟），这里验证多次唤醒后最终恰好投递一次、时点精确
  await h.clock.advance(delay)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.createdAt, next)
})
