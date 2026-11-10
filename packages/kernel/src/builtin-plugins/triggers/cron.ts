/**
 * builtin:triggers —— cron 调度模块。
 *
 * 职责：标准五字段 cron 表达式（cron-parser）驱动的定时投递。
 * - 运行态持久化于公共 doc `crons`（纯 JSON；lastRunAt/nextRunAt 随 claim 推进）；
 * - 持久 claim：调度点触发时先推进 nextRunAt 并 await doc.flush() 真实落盘，
 *   再投递。同一计划点最多一次投递尝试；claim 落盘后、投递完成前崩溃则该次
 *   丢失（诚实语义：持久 claim 与异步输入提交不构成原子事务，不承诺 exactly-once）；
 * - catchUp:true 重启后将错过的时段合并补跑一次；
 *   false 跳至未来时点（跳过同样 claim+flush，防重启后回跳重算）；
 * - single-flight：同一 job 并发 tick 只允许一个在途；
 * - dispatch 失败如实写 lastError 并发 notification 事件，绝不假成功；
 *   本计划点不重试（最多一次尝试语义），下个时点正常调度；
 * - 大间隔 timer 先以 <=2^31-1 安全窗口触发再续排（规避 32 位溢出），unref。
 *
 * 定时器只经 ctx.service 生命周期管理，不触碰内核。
 */

import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { HelmError, type ExternalTriggerEnvelope, type HelmPluginContext } from '@helm/protocol'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

export const CRON_DOC_NAME = 'crons'

/** 五字段 cron；ID 字符集收紧（禁点号，防与全限定动作名歧义）。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** setTimeout 上限（2^31-1 ms ≈ 24.8 天）；更大延迟先触发再续排。 */
const MAX_TIMEOUT_MS = 2_147_483_647

export interface CronJob {
  id: string
  /**
   * 创建代次（randomUUID）：claim/lastError 写回按 (id, rev) 校验，
   * 防止在途 tick 污染 delete 后重建的同 id 新 job。重建即换代。
   */
  rev: string
  description?: string
  /** 标准五字段 cron 表达式（分 时 日 月 周）。 */
  schedule: string
  /** IANA 时区，默认 'UTC'。 */
  timezone: string
  /** 触发时投递的文本载荷。 */
  text: string
  enabled: boolean
  /** true：重启后对错过时段补跑一次；false：跳至未来时点。 */
  catchUp: boolean
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  /** 最近一次 claim 的计划时点（调度点，非投递完成时刻）。 */
  lastRunAt?: number
  /** 下一个待触发计划时点（epoch ms）。 */
  nextRunAt?: number
  /** 最近一次投递失败的显式诊断。 */
  lastError?: string
}

export interface CronDoc {
  version: 1
  jobs: CronJob[]
}

export interface CronDeps {
  /** 投递入口（共享 dispatch helper：校验 Profile、解析/创建会话后进 trigger 管道）。 */
  dispatchTrigger(event: ExternalTriggerEnvelope, targetProfileId?: string): Promise<void>
}

/** 定时原语抽象（测试注入可控时钟；缺省 Date.now/setTimeout+unref）。 */
export interface CronClock {
  now(): number
  setTimeout(fn: () => void, ms: number): CronTimerHandle
}

export interface CronTimerHandle {
  clear(): void
}

/** 注册返回的内部句柄（测试用；业务不应依赖）。 */
export interface CronRuntime {
  /** 立即对全部启用 job 执行一次调度扫描（不等待 timer）。 */
  tickNow(): Promise<void>
  /** 等待全部在途 tick 完成（测试驱动 timer 后收尾）。 */
  settle(): Promise<void>
}

// ---------------------------------------------------------------------------
// 纯函数：校验 / 时点计算 / 文档解析（导出供测试）
// ---------------------------------------------------------------------------

/** 校验五字段 cron 表达式与 IANA 时区；非法抛 HelmError（cron-parser 消息透传）。 */
export function assertValidSchedule(schedule: string, timezone: string): void {
  if (typeof schedule !== 'string' || schedule.trim().length === 0) {
    throw new HelmError('validation_error', 'cron schedule 不能为空（标准五字段：分 时 日 月 周）', 400, {
      field: 'schedule',
    })
  }
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new HelmError(
      'validation_error',
      `cron schedule 必须是标准五字段（分 时 日 月 周），实际 ${fields.length} 字段：${schedule}`,
      400,
      { field: 'schedule', schedule },
    )
  }
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new HelmError('validation_error', 'cron timezone 不能为空（IANA 区域名，默认 UTC）', 400, {
      field: 'timezone',
    })
  }
  try {
    // cron-parser 对非法时区延迟到求值时才抛（CronDate Invalid Date），且
    // hasNext() 对坏时区静默返回 false——校验边界必须直接求值一次时点
    CronExpressionParser.parse(schedule, { tz: timezone }).next()
  } catch (err) {
    throw new HelmError(
      'validation_error',
      `cron schedule 非法：${err instanceof Error ? err.message : String(err)}`,
      400,
      { field: 'schedule', schedule, timezone },
    )
  }
}

/** 计算严格晚于 afterMs 的下一个计划时点；无未来时点返回 undefined。 */
export function nextFireTime(schedule: string, timezone: string, afterMs: number): number | undefined {
  try {
    const iter = CronExpressionParser.parse(schedule, { currentDate: new Date(afterMs), tz: timezone })
    if (!iter.hasNext()) return undefined
    return iter.next().getTime()
  } catch (err) {
    throw new HelmError(
      'cron_next_time_unavailable',
      `计算 cron 下次时点失败（schedule=${schedule} tz=${timezone}）：${err instanceof Error ? err.message : String(err)}`,
      500,
      { schedule, timezone, afterMs },
    )
  }
}

/** 归一化创建输入为 CronJob（纯函数；不含 doc 写入与时点计算）。 */
export function normalizeCronInput(input: {
  id: string
  schedule: string
  text: string
  description?: string
  timezone?: string
  enabled?: boolean
  catchUp?: boolean
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
}): CronJob {
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    throw new HelmError(
      'validation_error',
      `cron id 非法（1..64 位，允许字母数字 _ -，禁点号）：${String(input.id)}`,
      400,
      { field: 'id' },
    )
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new HelmError('validation_error', 'cron text 不能为空（触发时投递的载荷文本）', 400, { field: 'text' })
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
    throw new HelmError('validation_error', 'cron description 必须是不超过 500 字的字符串', 400, {
      field: 'description',
    })
  }
  const timezone = input.timezone ?? 'UTC'
  assertValidSchedule(input.schedule, timezone)

  const hasConv = input.targetConversationId !== undefined
  const hasProfile = input.targetProfileId !== undefined
  if (hasConv && hasProfile) {
    throw new HelmError(
      'validation_error',
      'targetConversationId 与 targetProfileId 互斥：会话直投与按 Profile 解析不可同时指定',
      400,
      { field: 'targetConversationId/targetProfileId' },
    )
  }
  if (hasConv && (!Number.isInteger(input.targetConversationId) || (input.targetConversationId as number) <= 0)) {
    throw new HelmError('validation_error', 'targetConversationId 必须是正整数会话 ID', 400, {
      field: 'targetConversationId',
    })
  }
  if (hasProfile && (typeof input.targetProfileId !== 'string' || input.targetProfileId.length === 0)) {
    throw new HelmError('validation_error', 'targetProfileId 必须是非空字符串', 400, { field: 'targetProfileId' })
  }
  if (input.threadKey !== undefined && (typeof input.threadKey !== 'string' || input.threadKey.length === 0)) {
    throw new HelmError('validation_error', 'threadKey 必须是非空字符串', 400, { field: 'threadKey' })
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new HelmError('validation_error', 'enabled 必须是布尔值', 400, { field: 'enabled' })
  }
  if (input.catchUp !== undefined && typeof input.catchUp !== 'boolean') {
    throw new HelmError('validation_error', 'catchUp 必须是布尔值', 400, { field: 'catchUp' })
  }

  return {
    id: input.id,
    rev: randomUUID(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    schedule: input.schedule.trim(),
    timezone,
    text: input.text,
    enabled: input.enabled ?? true,
    catchUp: input.catchUp ?? false,
    ...(hasConv ? { targetConversationId: input.targetConversationId } : {}),
    ...(hasProfile ? { targetProfileId: input.targetProfileId } : {}),
    ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
  }
}

/**
 * 严格校验持久文档：坏数据显式抛 HelmError（cron_doc_corrupt），绝不静默重置。
 * 未知字段忽略（向前演进），已知字段类型/约束错误必须拒绝。
 */
export function parseCronDoc(raw: unknown): CronDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('cron_doc_corrupt', 'crons 文档损坏：根必须是对象', 500, { actual: String(raw) })
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) {
    throw new HelmError('cron_doc_corrupt', `crons 文档 version 非法：${String(doc.version)}（期望 1）`, 500, {
      version: doc.version,
    })
  }
  if (!Array.isArray(doc.jobs)) {
    throw new HelmError('cron_doc_corrupt', 'crons 文档损坏：jobs 必须是数组', 500, { actual: typeof doc.jobs })
  }
  const seen = new Set<string>()
  const jobs = doc.jobs.map((rawJob, index) => parseCronJob(rawJob, index, seen))
  return { version: 1, jobs }
}

function parseCronJob(rawJob: unknown, index: number, seen: Set<string>): CronJob {
  const where = `jobs[${index}]`
  if (rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where} 必须是对象`, 500, { index })
  }
  const job = rawJob as Record<string, unknown>
  if (typeof job.id !== 'string' || !ID_PATTERN.test(job.id)) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}.id 非法：${String(job.id)}`, 500, { index })
  }
  if (typeof job.rev !== 'string' || job.rev.length === 0) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）缺少创建代次 rev`, 500, {
      index,
      id: job.id,
    })
  }
  if (seen.has(job.id)) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}.id 重复：${job.id}`, 500, { index })
  }
  seen.add(job.id)
  if (typeof job.schedule !== 'string' || typeof job.text !== 'string') {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）缺少 schedule/text`, 500, {
      index,
      id: job.id,
    })
  }
  if (typeof job.timezone !== 'string' || job.timezone.length === 0) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）timezone 非法`, 500, {
      index,
      id: job.id,
    })
  }
  if (typeof job.enabled !== 'boolean' || typeof job.catchUp !== 'boolean') {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）enabled/catchUp 必须是布尔值`, 500, {
      index,
      id: job.id,
    })
  }
  for (const field of ['description', 'targetProfileId', 'threadKey', 'lastError'] as const) {
    if (job[field] !== undefined && typeof job[field] !== 'string') {
      throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）${field} 类型非法`, 500, {
        index,
        id: job.id,
        field,
      })
    }
  }
  if (
    job.targetConversationId !== undefined &&
    (!Number.isInteger(job.targetConversationId) || (job.targetConversationId as number) <= 0)
  ) {
    throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）targetConversationId 非法`, 500, {
      index,
      id: job.id,
    })
  }
  if (job.targetConversationId !== undefined && job.targetProfileId !== undefined) {
    throw new HelmError(
      'cron_doc_corrupt',
      `crons 文档损坏：${where}（${job.id}）targetConversationId 与 targetProfileId 互斥`,
      500,
      { index, id: job.id },
    )
  }
  for (const field of ['lastRunAt', 'nextRunAt'] as const) {
    if (job[field] !== undefined && (typeof job[field] !== 'number' || !Number.isFinite(job[field]))) {
      throw new HelmError('cron_doc_corrupt', `crons 文档损坏：${where}（${job.id}）${field} 必须是有限数值`, 500, {
        index,
        id: job.id,
        field,
      })
    }
  }
  return {
    id: job.id,
    rev: job.rev,
    ...(job.description !== undefined ? { description: job.description as string } : {}),
    schedule: job.schedule,
    timezone: job.timezone,
    text: job.text,
    enabled: job.enabled,
    catchUp: job.catchUp,
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId as number } : {}),
    ...(job.targetProfileId !== undefined ? { targetProfileId: job.targetProfileId as string } : {}),
    ...(job.threadKey !== undefined ? { threadKey: job.threadKey as string } : {}),
    ...(job.lastRunAt !== undefined ? { lastRunAt: job.lastRunAt as number } : {}),
    ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt as number } : {}),
    ...(job.lastError !== undefined ? { lastError: job.lastError as string } : {}),
  }
}

// ---------------------------------------------------------------------------
// 纯函数：调度决策与信封构造（导出供测试）
// ---------------------------------------------------------------------------

/** 单个 job 在一次 tick 中的决策。 */
export type TickDecision =
  | { action: 'fire'; at: number }
  | { action: 'skip-to-future'; from: number; to: number }
  | { action: 'noop' }

/**
 * 判定 job 在 now 的动作：
 * - 未启用 / nextRunAt 缺失或在未来：noop；
 * - 到期（nextRunAt <= now）：
 *   - 仅错过单个时段（nextRunAt 之后下一个时点仍在未来，含准点触发）→ fire
 *     该计划点（catchUp 语义下同样 fire）；
 *   - 错过多个时段（停机）且 catchUp=false → 跳至 now 之后首个时点；
 *   - 错过多个时段且 catchUp=true → 仍只补跑最近一个（at=nextRunAt），
 *     补跑后由 advanceAfterFire 跳至未来，不逐段重放。
 */
export function decideTick(job: CronJob, now: number): TickDecision {
  if (!job.enabled) return { action: 'noop' }
  const next = job.nextRunAt
  if (next === undefined || next > now) return { action: 'noop' }
  const subsequent = nextFireTime(job.schedule, job.timezone, next)
  const missedMultiple = subsequent !== undefined && subsequent <= now
  if (!missedMultiple || job.catchUp) return { action: 'fire', at: next }
  const future = nextFireTime(job.schedule, job.timezone, now)
  if (future === undefined || future <= now) {
    // nextFireTime 严格递增，理论上不可达；防御性显式报错而非静默
    throw new HelmError(
      'cron_schedule_stalled',
      `cron job ${job.id} 无法跳至未来时点（schedule=${job.schedule} tz=${job.timezone}）`,
      500,
      { id: job.id, schedule: job.schedule, timezone: job.timezone },
    )
  }
  return { action: 'skip-to-future', from: next, to: future }
}

/**
 * fire 之后的下一个计划时点：候选 = fireAt 之后首个时点；若仍落在 now 之前
 * （停机错过多个时段），则跳到 now 之后首个时点——catchUp 只补跑一次，
 * 不逐段重放历史。
 */
export function advanceAfterFire(schedule: string, timezone: string, fireAt: number, now: number): number | undefined {
  const candidate = nextFireTime(schedule, timezone, fireAt)
  if (candidate === undefined) return undefined
  if (candidate > now) return candidate
  return nextFireTime(schedule, timezone, now)
}

/** 信封构造（纯函数）：source 固定 'cron:<id>'，id 含计划点（同点稳定）。 */
export function buildCronEnvelope(job: CronJob, fireAt: number): ExternalTriggerEnvelope {
  return {
    id: `cron:${job.id}:${fireAt}`,
    source: `cron:${job.id}`,
    text: job.text,
    createdAt: fireAt,
    ...(job.threadKey !== undefined ? { threadKey: job.threadKey } : {}),
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId } : {}),
  }
}

/** 清除 lastError 字段（不能赋 undefined：doc 存储层拒绝未定义值键）。 */
function clearLastError(job: CronJob): CronJob {
  const { lastError: _ignored, ...rest } = job
  void _ignored
  return rest as CronJob
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/**
 * 注册 cron 调度：公共 doc + 4 个 action（cron_list/create/delete/trigger）+
 * 定时 service。主插件在 definePlugin 内调用；deps.dispatchTrigger 为共享
 * delivery helper（校验 Profile、解析/创建会话后进 ctx.host.dispatchTrigger，
 * 内核已 defang）。
 */
export function registerCron(ctx: HelmPluginContext, deps: CronDeps): CronRuntime {
  return createCronScheduler(ctx, deps, defaultClock())
}

/** 内部测试入口：可控时钟注入（运行时无注入需求，缺省真实时钟）。 */
export function createCronScheduler(ctx: HelmPluginContext, deps: CronDeps, clock: CronClock): CronRuntime {
  const doc = ctx.doc<CronDoc>(CRON_DOC_NAME, { version: 1, jobs: [] }, { public: true })

  let stopping = false
  /** single-flight：job id -> 在途调度 Promise。 */
  const inflight = new Map<string, Promise<void>>()
  const timers = new Map<string, CronTimerHandle>()

  const logDiagnostic = (message: string): void => {
    console.error(`[cron] ${message}`)
  }

  /** 显式错误上报：notification 事件 + stderr（各尽力，失败不递归）。 */
  const emitError = (title: string, detail: unknown): void => {
    const message = detail instanceof Error ? detail.message : String(detail)
    try {
      ctx.host.emitEvent('notification', { type: 'notification', level: 'error', title, body: `[cron] ${message}` })
    } catch (eventErr) {
      logDiagnostic(`notification 事件发布失败：${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
    }
    logDiagnostic(`${title}：${message}`)
  }

  /** 读取并严格校验 doc；坏数据显式抛错，绝不静默重置。 */
  const readDoc = (): CronDoc => parseCronDoc(doc.get())

  /** 写回 + 真实落盘（doc.flush 冲刷本 store 排队写）；持久化失败显式抛错。 */
  const writeDoc = async (next: CronDoc): Promise<void> => {
    doc.set(next)
    await doc.flush()
  }

  /**
   * 按 (id, rev) 写回单个 job 并落盘：id 不存在或 rev 不匹配（被 delete 后
   * 重建换代）均拒绝写入，返回 false——旧 tick 的 claim/lastError 绝不
   * 污染或复活新 job。读-改-写在同步段内完成（doc.set 前 await），
   * 事件循环内天然串行。
   */
  const tryUpdateJob = async (
    id: string,
    rev: string,
    mutate: (job: CronJob) => CronJob,
  ): Promise<boolean> => {
    const current = readDoc()
    const index = current.jobs.findIndex((j) => j.id === id)
    if (index < 0 || current.jobs[index]!.rev !== rev) return false
    const jobs = [...current.jobs]
    jobs[index] = mutate(jobs[index]!)
    await writeDoc({ version: 1, jobs })
    return true
  }

  /**
   * 单个 job 的一次调度处理（single-flight 由 tickJob 保证）。
   * 顺序：持久 claim（推进 lastRunAt/nextRunAt + flush）→ dispatch；
   * claim 落盘失败绝不投递（否则崩溃窗口产生重复投递）。
   */
  const runJobTick = async (id: string): Promise<void> => {
    if (stopping) return
    let job: CronJob | undefined
    let decision: TickDecision
    try {
      job = readDoc().jobs.find((j) => j.id === id)
      if (!job) return
      decision = decideTick(job, clock.now())
    } catch (err) {
      emitError(`cron job ${id} 调度决策失败`, err)
      return
    }
    if (decision.action === 'noop') {
      scheduleJob(id)
      return
    }
    if (decision.action === 'skip-to-future') {
      // catchUp=false：错过时段直接跳至未来；同样 claim+flush 防重启回跳。
      // lastRunAt 不动（没有真实投递发生，不伪造运行记录）。
      const written = await tryUpdateJob(id, job.rev, (j) => ({ ...j, nextRunAt: decision.to }))
      if (written) scheduleJob(id)
      return
    }
    // fire：claim（清 lastError、记 lastRunAt、推进 nextRunAt）→ flush → dispatch
    const fireAt = decision.at
    let claimed: boolean
    try {
      claimed = await tryUpdateJob(
        id,
        job.rev,
        (j) =>
          clearLastError({
            ...j,
            lastRunAt: fireAt,
            nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
          }),
      )
    } catch (err) {
      // claim 未落盘：绝不能投递（否则崩溃窗口产生重复投递）
      emitError(`cron job ${id} claim 持久化失败，本次不投递`, err)
      scheduleJob(id)
      return
    }
    if (!claimed || stopping) return
    // flush 让出执行权期间任务可能被删除或重建，投递前复核创建代次。
    if (!readDoc().jobs.some((current) => current.id === id && current.rev === job.rev && current.enabled)) return
    try {
      await deps.dispatchTrigger(buildCronEnvelope(job, fireAt), job.targetProfileId)
    } catch (err) {
      // 投递失败：如实写 lastError + notification；本计划点不重试，下个时点照常。
      // (id, rev) 校验：dispatch 期间 job 若被删除重建，不把旧失败写到新 job 上。
      const message = err instanceof Error ? err.message : String(err)
      const written = await tryUpdateJob(id, job.rev, (j) => ({
        ...j,
        lastError: `投递失败 @${new Date(fireAt).toISOString()}：${message}`,
      }))
      if (!written) {
        logDiagnostic(`cron job ${id} 投递失败，但 job 已被删除/重建，lastError 不写回（rev 换代）`)
      }
      emitError(`cron job ${id} 投递失败`, err)
    }
    scheduleJob(id)
  }

  /** single-flight：同 job 并发 tick 只跑一个，后到者直接复用在途 Promise。 */
  const tickJob = (id: string): Promise<void> => {
    const existing = inflight.get(id)
    if (existing) return existing
    const task = runJobTick(id).finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  /** 重排单个 job 的 timer；未启用/已删除不排。 */
  const scheduleJob = (id: string): void => {
    if (stopping) return
    timers.get(id)?.clear()
    timers.delete(id)
    let job: CronJob | undefined
    try {
      job = readDoc().jobs.find((j) => j.id === id)
    } catch (err) {
      emitError(`cron job ${id} 读取调度状态失败`, err)
      return
    }
    if (!job || !job.enabled) return
    if (job.nextRunAt === undefined) {
      emitError(
        `cron job ${id} 无下次时点`,
        new HelmError('cron_no_next_time', `schedule=${job.schedule} 在 ${job.timezone} 无未来匹配时点`, 500, {
          id,
          schedule: job.schedule,
        }),
      )
      return
    }
    const delayMs = Math.max(0, job.nextRunAt - clock.now())
    // 超长延迟先以安全窗口唤醒再续排（决策时未到点即 noop 重排），unref 不阻退出
    const handle = clock.setTimeout(() => {
      timers.delete(id)
      void tickJob(id).catch((err) => emitError(`cron job ${id} tick 异常`, err))
    }, Math.min(delayMs, MAX_TIMEOUT_MS))
    timers.set(id, handle)
  }

  // ---- actions：HTTP / CLI / Agent Tool / Workflow 五端同权 ----

  ctx.action({
    id: 'cron_list',
    description: '列出全部 cron 定时任务（含 lastRunAt/nextRunAt/lastError 调度状态）',
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { jobs: { type: 'array', items: { type: 'object' } } },
      required: ['jobs'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'list'] },
    handler: () => ({ jobs: readDoc().jobs.map((job) => jsonClone(job)) }),
  })

  ctx.action({
    id: 'cron_create',
    description: '创建 cron 定时任务（标准五字段：分 时 日 月 周；id/schedule/text 必填，timezone 默认 UTC）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        schedule: { type: 'string' },
        text: { type: 'string', minLength: 1 },
        description: { type: 'string', maxLength: 500 },
        timezone: { type: 'string' },
        enabled: { type: 'boolean' },
        catchUp: { type: 'boolean' },
        targetConversationId: { type: 'integer', minimum: 1 },
        targetProfileId: { type: 'string', minLength: 1 },
        threadKey: { type: 'string', minLength: 1 },
      },
      required: ['id', 'schedule', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { job: { type: 'object' } },
      required: ['job'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'create'] },
    handler: async (input: Record<string, unknown>) => {
      const job = normalizeCronInput(input as Parameters<typeof normalizeCronInput>[0])
      const now = clock.now()
      const nextRunAt = nextFireTime(job.schedule, job.timezone, now)
      if (nextRunAt === undefined) {
        throw new HelmError(
          'cron_no_next_time',
          `cron schedule 在 ${job.timezone} 无未来匹配时点，拒绝创建：${job.schedule}`,
          400,
          { id: job.id, schedule: job.schedule, timezone: job.timezone },
        )
      }
      const current = readDoc()
      if (current.jobs.some((j) => j.id === job.id)) {
        throw new HelmError('cron_duplicate_id', `cron job 已存在：${job.id}`, 409, { id: job.id })
      }
      const created: CronJob = { ...job, nextRunAt }
      await writeDoc({ version: 1, jobs: [...current.jobs, created] })
      if (created.enabled) scheduleJob(created.id)
      return { job: jsonClone(created) }
    },
  })

  ctx.action({
    id: 'cron_delete',
    description: '删除 cron 定时任务（在途投递自然终止，不复活）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'delete'] },
    handler: async (input: { id: string }) => {
      const current = readDoc()
      if (!current.jobs.some((j) => j.id === input.id)) {
        throw new HelmError('not_found', `cron job 不存在：${input.id}`, 404, { id: input.id })
      }
      // 先停 timer 再落盘删除；并发 tick 的 (id, rev) 校验发现换代即静默终止，
      // 被 删 job 不可能复活
      timers.get(input.id)?.clear()
      timers.delete(input.id)
      await writeDoc({ version: 1, jobs: current.jobs.filter((j) => j.id !== input.id) })
      return { deleted: true }
    },
  })

  ctx.action({
    id: 'cron_trigger',
    description: '手动立即触发一次 cron 任务（真实投递；失败抛错，不影响后续计划调度）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { triggered: { type: 'boolean' } },
      required: ['triggered'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'trigger'] },
    handler: async (input: { id: string }) => {
      // 手动触发只读快照 + 真实投递，不写 doc：不存在 claim/lastError 写回，
      // 天然无 delete+create 同 id 污染面；删除竞态由读时存在性兜底。
      const job = readDoc().jobs.find((j) => j.id === input.id)
      if (!job) throw new HelmError('not_found', `cron job 不存在：${input.id}`, 404, { id: input.id })
      const envelope = { ...buildCronEnvelope(job, clock.now()), id: `cron:${job.id}:manual:${randomUUID()}` }
      await deps.dispatchTrigger(envelope, job.targetProfileId)
      return { triggered: true }
    },
  })

  // ---- service：定时器生命周期（stop 取消 timer 并等待在途投递） ----

  ctx.service({
    id: 'cron-scheduler',
    liveTasks() {
      return [...inflight.keys()].map((id) => `cron-dispatch:${id}`)
    },
    async start() {
      stopping = false
      try {
        const current = readDoc()
        // 启动边界校验全部计划，失败时不发布任何 timer，也不伪装启用成功。
        for (const job of current.jobs) {
          assertValidSchedule(job.schedule, job.timezone)
          if (job.enabled && job.nextRunAt === undefined) {
            throw new HelmError('cron_doc_corrupt', `启用的 cron job ${job.id} 缺少 nextRunAt`, 500, { id: job.id })
          }
        }
        const now = clock.now()
        for (const job of current.jobs) {
          // 重启与普通 timer 抖动分开处理：catchUp=false 不补跑任何已错过的计划点。
          if (job.enabled && !job.catchUp && job.nextRunAt !== undefined && job.nextRunAt < now) {
            const nextRunAt = nextFireTime(job.schedule, job.timezone, now)
            if (nextRunAt === undefined) {
              throw new HelmError('cron_no_next_time', `cron job ${job.id} 无未来匹配时点`, 500, { id: job.id })
            }
            await tryUpdateJob(job.id, job.rev, (value) => ({ ...value, nextRunAt }))
          }
        }
        for (const job of current.jobs) scheduleJob(job.id)
      } catch (err) {
        emitError('cron 调度启动失败', err)
        throw err
      }
    },
    async stop() {
      stopping = true
      for (const handle of timers.values()) handle.clear()
      timers.clear()
      // 等待在途 dispatch 有限完成（liveTasks 已让宿主在停用前 409 拦截，
      // 此处兜底等待，杜绝 stop 后新投递）
      const pending = [...inflight.values()]
      if (pending.length > 0) await Promise.allSettled(pending)
    },
  })

  return {
    async tickNow() {
      const current = readDoc()
      await Promise.all(current.jobs.filter((j) => j.enabled).map((j) => tickJob(j.id)))
    },
    async settle() {
      // 循环等待直至无在途（每轮后让出一轮宏任务，覆盖失败路径里
      // dispatch→lastError 写回→重排的链式异步段）
      for (let i = 0; i < 100 && inflight.size > 0; i++) {
        await Promise.allSettled([...inflight.values()])
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultClock(): CronClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return { clear: () => clearTimeout(timer) }
    },
  }
}
