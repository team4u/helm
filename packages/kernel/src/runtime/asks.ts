/**
 * AskService：AskDoc 生命周期 + CAS 乐观锁 + secret 入 stash + 外部 seq resolver 注册。
 *
 * 关键语义（诚实性优先）：
 * - createAsk 先完整校验（字段类型/name 唯一/secret env 名合法/预分配 id 形状与
 *   唯一性/会话存在经 validateConversation 端口），非法输入在写库前拒绝；
 * - createAsk 返回 AskResult：answered/cancelled/superseded 三态均 resolve
 *   （cancel/superseded 的 answers 为 {}，取消绝不冒充用户批准）；只有
 *   验证/IO/宿主失败才 reject；
 * - waiter 先于一切可见副作用（putAsk/publish）注册：ask.upsert 订阅者在
 *   事件回调内同步 cancel/answer 时 promise 也能结算（曾因先 publish 后注册
 *   导致库已 settled 而 promise 永久悬挂）；发布/写入失败同步回收 waiter，
 *   不留悬挂等待者、不假成功；
 * - 真实持久化边界在 store 尾链：创建与终态结算在 resolve/发布终态事件前
 *   await store.flushPublic()，SQL 失败（镜像已写但落盘失败）以显式
 *   store_flush_failed reject 结算 createAsk——绝不返回假 answered；
 *   终态 putAsk（含同步镜像拒绝）/落盘/回调/事件发布任一失败，均取出并
 *   清空 waiters 逐一 {failure} 结算（不悬挂、不假终态）后如实上抛；
 *   cancelByConversation 尝试取消全部，任一失败如实 reject（不静默吞 IO）；
 * - envName 保留声明原样（不 toUpperCase 合并折叠），同会话内映射后碰撞明确拒绝；
 * - answer 校验未知字段/非 string/select 越界/confirm 非法值；secret 空值不 stash
 *   （空值 stash 会产生无效脱敏条目）；
 * - CAS 以持久 spec.expectedStateSeq 为准：客户端提供的不同 seq 返回 409
 *   （不静默覆盖水位），目标当前 seq 任何不一致（含回退）都 superseded；
 *   有 CAS 水位但无 resolver 注册 -> ask_state_unavailable（不装作校验通过）；
 * - 重启后 pending asks 保留并发出诊断通知；secret stash 引用跨重启失效，
 *   通知中如实说明（不伪装仍可取回明文）。
 */

import type { AskCreateSpec, AskFieldSpec, AskResult, AskSpec } from '@helm/protocol'
import { HelmError, type MaybePromise } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { isValidEnvName, validateSecretLifetime } from '../services/secret-stash.js'
import type { HelmStore } from './store.js'
import type { SecretStash } from '../services/secret-stash.js'

/** 外部目标 seq 解析器（如 herdr 插件注册）：askId -> 目标当前 seq。可为异步（真实水位需远端 IO）。 */
export type AskSeqResolver = (askId: string) => MaybePromise<number | undefined>

export interface AskSettled {
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers?: Record<string, string>
}

/** waiter 结算通道：正常终态或宿主侧失败（IO/持久化），失败时 createAsk reject。 */
type WaiterOutcome = AskSettled | { failure: unknown }

export class AskService {
  private readonly store: HelmStore
  private readonly stash: SecretStash
  private readonly seqResolvers = new Set<AskSeqResolver>()
  private readonly waiters = new Map<string, Array<(outcome: WaiterOutcome) => void>>()
  private readonly onEvent: (type: string, payload: unknown) => void
  private readonly onConvPendingChanged: (conversationId: number) => void
  /** 会话存在性校验端口（宿主注入；缺省跳过——纯 AskService 单测用）。 */
  private readonly validateConversation?: (conversationId: number) => boolean | Promise<boolean>

  constructor(options: {
    store: HelmStore
    stash: SecretStash
    onEvent: (type: string, payload: unknown) => void
    onConvPendingChanged: (conversationId: number) => void
    validateConversation?: (conversationId: number) => boolean | Promise<boolean>
  }) {
    this.store = options.store
    this.stash = options.stash
    this.onEvent = options.onEvent
    this.onConvPendingChanged = options.onConvPendingChanged
    this.validateConversation = options.validateConversation
  }

  /** herdr 等外部组件注册 CAS 目标 seq 解析器。 */
  registerSeqResolver(resolver: AskSeqResolver): () => void {
    this.seqResolvers.add(resolver)
    return () => this.seqResolvers.delete(resolver)
  }

  listAsks(status?: string): AskSpec[] {
    return this.store.listAsks(status).map((row) => JSON.parse(row.specJson) as AskSpec)
  }

  listPendingByConversation(conversationId: number): AskSpec[] {
    return this.listAsks('pending').filter((a) => a.conversationId === conversationId)
  }

  pendingCount(conversationId: number): AskSpec[]['length'] {
    return this.listPendingByConversation(conversationId).length
  }

  getAsk(id: string): AskSpec | undefined {
    const row = this.store.getAsk(id)
    return row ? (JSON.parse(row.specJson) as AskSpec) : undefined
  }

  /**
   * 创建 AskDoc 并等待终态。三态均 resolve 为 AskResult（answered 的 answers 中
   * secret 字段为 stash marker；cancel/superseded 的 answers 为 {}，调用方以
   * status 区分，取消绝不冒充批准）。只有验证/IO/宿主失败 reject。
   *
   * spec.id 可预分配（外部关联与去重），不覆盖任何已有 ID（含已结算审批）。
   */
  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    validateAskSpec(spec)
    if (this.validateConversation) {
      const ok = await this.validateConversation(spec.conversationId)
      if (!ok) {
        throw new HelmError('not_found', `会话不存在：${spec.conversationId}`, 404)
      }
    }
    const id = spec.id ?? randomUUID()
    // 预分配 ID 不得覆盖任何已有 AskDoc（含 pending 与已结算审批）。
    if (this.store.getAsk(id) !== undefined) {
      const existing = this.store.getAsk(id)!
      throw new HelmError(
        'ask_id_conflict',
        `AskDoc ID '${id}' 已存在（状态 ${existing.status}），不能覆盖旧审批`,
        409,
        { askId: id, existingStatus: existing.status },
      )
    }
    const createdAt = Date.now()
    const full: AskSpec = {
      ...spec,
      id,
      status: 'pending',
      createdAt,
      expectedStateSeq: spec.expectedStateSeq,
    }

    // waiter 必须先于一切可见副作用注册：ask.upsert 订阅者可能在事件回调内
    // 同步 cancel/answer（settle 即刻排队通知），晚注册会让 promise 永久悬挂。
    // push 一次性自移除：正常终态 resolve、failure（put/落盘/发布失败）reject
    // 同一错误——不吞调用方错误，也不产生未观察 rejection。
    let push!: (outcome: WaiterOutcome) => void
    const settled = new Promise<AskResult>((resolve, reject) => {
      let done = false
      push = (outcome: WaiterOutcome) => {
        if (done) return
        done = true
        const current = this.waiters.get(id)
        if (current) {
          const index = current.indexOf(push)
          if (index >= 0) current.splice(index, 1)
          if (current.length === 0) this.waiters.delete(id)
        }
        if ('failure' in outcome) {
          reject(outcome.failure)
          return
        }
        resolve({
          id,
          status: outcome.status,
          answers: outcome.status === 'answered' ? (outcome.answers ?? {}) : {},
        })
      }
      const list = this.waiters.get(id) ?? []
      list.push(push)
      this.waiters.set(id, list)
    })

    // 异步初始化失败以同一错误 reject settled（调用方从 createAsk 返回的
    // promise 收到失败，不悬挂、不假成功）；settled 被 return 观察不泄漏。
    void (async () => {
      try {
        this.store.putAsk({
          id,
          conversationId: spec.conversationId,
          ownerPluginId: spec.ownerPluginId,
          specJson: JSON.stringify(full),
          status: 'pending',
          expectedStateSeq: spec.expectedStateSeq,
          createdAt,
        })
        // 真实落盘边界：putAsk 只写镜像 + 入队 SQL；flushPublic 失败时镜像已写
        // 但数据不保证完整，必须显式失败（不发布 ask.upsert、不假成功）。
        await this.store.flushPublic()
        this.onConvPendingChanged(spec.conversationId)
        this.onEvent('ask.upsert', full)
      } catch (error) {
        push({ failure: error })
      }
    })()
    return settled
  }

  /**
   * 提交答案：CAS 检查 -> 值校验 -> secret 入 stash -> 结算。
   * resolver 可为异步（真实水位需远端 IO）：等待返回后、写入任何终态副作用前
   * 重读行，等待期间被并发结算/改写则按当前权威状态拒绝或重估。
   */
  async answerAsk(
    id: string,
    answers: Record<string, string>,
    expectedStateSeq?: number,
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc 不存在：${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc 已处于 ${row.status} 状态`, 409)
    }

    // 客户端携带的 seq 与持久水位不同 -> 409 过期视图，不静默覆盖绕过 CAS。
    if (expectedStateSeq !== undefined && row.expectedStateSeq !== undefined && expectedStateSeq !== row.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `expectedStateSeq=${expectedStateSeq} 与 AskDoc 持久水位 ${row.expectedStateSeq} 不一致（客户端视图过期）`,
        409,
        { askId: id, clientSeq: expectedStateSeq, storedSeq: row.expectedStateSeq },
      )
    }

    // CAS：以持久 spec.expectedStateSeq 为准查目标当前 seq。resolver 可能异步，
    // 等待期间存在真实并发窗口：返回后必须重读行，一切以当前权威状态为准。
    let spec: AskSpec
    if (row.expectedStateSeq !== undefined) {
      const current = await this.resolveTargetSeq(id)
      const fresh = this.recheckPendingRow(id, row)
      if (fresh.expectedStateSeq !== undefined) {
        if (current === undefined) {
          // 有 CAS 水位但无 resolver 命中：目标状态不可知，不能装作校验通过。
          throw new HelmError(
            'ask_state_unavailable',
            `AskDoc ${id} 声明 expectedStateSeq=${fresh.expectedStateSeq} 但无已注册的 seq resolver 命中，无法校验目标状态`,
            409,
            { askId: id, expectedStateSeq: fresh.expectedStateSeq },
          )
        }
        // 目标 seq 任何不一致（含回退）都 superseded：目标状态已偏离创建时假设。
        if (current !== fresh.expectedStateSeq) {
          return this.settle(id, 'superseded')
        }
      }
      spec = JSON.parse(fresh.specJson) as AskSpec
    } else {
      // 无 CAS ask 且全同步 resolver 时无任何 await 间隙：保持原同步行为。
      spec = JSON.parse(row.specJson) as AskSpec
    }

    validateAnswersAgainstFields(spec, answers)

    // secret 值入 stash（空值不入：stash 空明文会让脱敏失效）；持久与事件只存 marker。
    // secretLifetime 原样透传：TTL/turn 作用域由 stash 统一执行（停止注入后旧值仍脱敏）。
    const stored: Record<string, string> = {}
    for (const field of spec.fields) {
      const value = answers[field.name] ?? ''
      stored[field.name] =
        field.secret && value !== ''
          ? this.stash.put(spec.conversationId, envNameOf(field), value, field.secretLifetime)
          : value
    }
    return this.settle(id, 'answered', { answers: stored })
  }

  cancelAsk(id: string, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc 不存在：${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc 已处于 ${row.status} 状态`, 409)
    }
    return this.settle(id, reason)
  }

  /** 重启诊断：遗留 pending asks 发 notification（不静默吞）；secret 引用失效如实说明。 */
  reportOrphans(): void {
    const pending = this.listAsks('pending')
    for (const ask of pending) {
      const hasSecret = ask.fields.some((f) => f.secret)
      this.onEvent('notification', {
        level: 'warning',
        title: '重启后遗留待答 AskDoc',
        body:
          `AskDoc ${ask.id}（会话 ${ask.conversationId}）在进程重启前未结算，保持 pending 供人工处理` +
          (hasSecret ? '；注意：其 secret 字段答案的 stash 引用随重启失效，重新作答前旧 marker 无法取回明文' : ''),
        conversationId: ask.conversationId,
      })
    }
  }

  /**
   * 按会话取消全部 pending（删除会话级联用）：尝试取消全部，任一失败如实
   * reject（不静默吞 IO 失败）；失败 ask 的 waiter 已被 settle 以 failure 结算。
   */
  async cancelByConversation(conversationId: number, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<void> {
    const pending = this.listPendingByConversation(conversationId)
    await Promise.all(pending.map((ask) => this.settle(ask.id, reason)))
  }

  /** 等待异步 resolver 之后的行重读：行被删 -> 404；已非 pending -> 409。 */
  private recheckPendingRow(id: string, stale: { expectedStateSeq?: number }): { expectedStateSeq?: number; specJson: string } {
    const now = this.store.getAsk(id)
    if (!now) throw new HelmError('not_found', `AskDoc 不存在：${id}`, 404)
    if (now.status !== 'pending') {
      throw new HelmError('ask_already_settled', `等待 seq resolver 期间 AskDoc 已被结算为 ${now.status}`, 409, {
        askId: id,
        settledStatus: now.status,
      })
    }
    if (stale.expectedStateSeq !== now.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `等待 seq resolver 期间 AskDoc 持久水位已从 ${stale.expectedStateSeq} 变为 ${now.expectedStateSeq}，以新权威条件为准`,
        409,
        { askId: id, previousSeq: stale.expectedStateSeq, storedSeq: now.expectedStateSeq },
      )
    }
    return now
  }

  private async resolveTargetSeq(askId: string): Promise<number | undefined> {
    for (const resolver of this.seqResolvers) {
      // resolver 返回非法值（NaN/负/小数/unsafe/坏类型）显式失败：seq 是 CAS 的
      // 权威事实，绝不截断、不默认 0、不静默跳过装作无解析。
      const value = await resolver(askId)
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
        throw new HelmError(
          'ask_seq_resolver_invalid',
          `seq resolver 对 AskDoc ${askId} 返回非法水位（需非负 safe integer）`,
          500,
          { askId, resolvedType: value === null ? 'null' : typeof value },
        )
      }
      return value
    }
    return undefined
  }

  private async settle(
    id: string,
    status: 'answered' | 'cancelled' | 'superseded',
    options: { answers?: Record<string, string> } = {},
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc 不存在：${id}`, 404)
    try {
      const spec = JSON.parse(row.specJson) as AskSpec
      const settledSpec: AskSpec = { ...spec, status }
      // cancel/superseded 不写假 answers（result 仅 answered 有值）。
      const answers = status === 'answered' ? (options.answers ?? {}) : undefined
      this.store.putAsk({
        ...row,
        status,
        specJson: JSON.stringify(settledSpec),
        resultJson: answers !== undefined ? JSON.stringify(answers) : undefined,
        settledAt: Date.now(),
      })
      // 终态必须真实落盘后才发布事件/通知 waiter：SQL 失败时绝不返回假终态。
      await this.store.flushPublic()
      this.onConvPendingChanged(spec.conversationId)
      this.onEvent('ask.resolved', { askId: id, status })
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ askId: id, status, answers })
      return settledSpec
    } catch (error) {
      // putAsk（含同步镜像拒绝）/落盘/回调/事件发布任一失败：取出并清空
      // waiters 逐一 failure 结算（不悬挂、不假终态），错误如实上抛。
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ failure: error })
      throw error
    }
  }
}

/** secret 字段的环境变量名：保留声明原样（field.name）；不合法即拒绝（不静默规范化合并）。 */
function envNameOf(field: AskFieldSpec): string {
  if (!isValidEnvName(field.name)) {
    throw new HelmError(
      'validation_error',
      `secret 字段 '${field.name}' 的名称不是合法环境变量名（需 [A-Za-z_][A-Za-z0-9_]*，不静默转大写合并）`,
      400,
    )
  }
  return field.name
}

/** AskCreateSpec 完整边界校验（写库前拒绝一切非法形状）。 */
function validateAskSpec(spec: AskCreateSpec): void {
  if (spec === null || typeof spec !== 'object') {
    throw new HelmError('validation_error', 'AskDoc spec 需为对象')
  }
  // 调用方 ID 必须是非空字符串，不静默规范化。
  if (spec.id !== undefined) {
    if (typeof spec.id !== 'string' || spec.id === '' || spec.id.trim() === '') {
      throw new HelmError('validation_error', 'AskDoc id 需为非空字符串')
    }
  }
  if (!Number.isInteger(spec.conversationId) || (spec.conversationId ?? 0) <= 0) {
    throw new HelmError('validation_error', 'AskDoc 需要 conversationId（正整数）')
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    throw new HelmError('validation_error', 'AskDoc 需要 title（非空字符串）')
  }
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    throw new HelmError('validation_error', 'AskDoc description 需为字符串')
  }
  if (spec.ownerPluginId !== undefined && typeof spec.ownerPluginId !== 'string') {
    throw new HelmError('validation_error', 'AskDoc ownerPluginId 需为字符串')
  }
  if (spec.expectedStateSeq !== undefined) {
    if (!Number.isInteger(spec.expectedStateSeq) || (spec.expectedStateSeq as number) < 0) {
      throw new HelmError('validation_error', 'expectedStateSeq 需为非负整数')
    }
  }
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new HelmError('validation_error', 'AskDoc 需要至少一个 field')
  }
  const names = new Set<string>()
  for (const field of spec.fields) {
    if (field === null || typeof field !== 'object') {
      throw new HelmError('validation_error', 'field 需为对象')
    }
    if (typeof field.name !== 'string' || field.name.trim() === '') {
      throw new HelmError('validation_error', 'field.name 需为非空字符串')
    }
    if (names.has(field.name)) {
      throw new HelmError('validation_error', `field.name 重复：${field.name}`)
    }
    names.add(field.name)
    if (typeof field.label !== 'string' || field.label === '') {
      throw new HelmError('validation_error', `field '${field.name}' label 需为非空字符串`)
    }
    if (field.type !== 'text' && field.type !== 'select' && field.type !== 'confirm') {
      throw new HelmError(
        'validation_error',
        `field '${field.name}' type 非法：${String(field.type)}（仅 text | select | confirm）`,
      )
    }
    if (field.type === 'select') {
      if (
        !Array.isArray(field.options) ||
        field.options.length === 0 ||
        field.options.some((o) => o === null || typeof o !== 'object' || typeof o.value !== 'string' || o.value === '')
      ) {
        throw new HelmError('validation_error', `select 字段 '${field.name}' 需要非空 options（value 均为非空字符串）`)
      }
    }
    if (field.secret === true) {
      // 声明边界即校验 env 名可用（envName 或 name 二者取一）。
      envNameOf(field)
    }
    // secretLifetime 仅 secret 字段允许；形状/枚举/上限在边界显式拒绝（不静默降级）。
    if (field.secretLifetime !== undefined) {
      if (field.secret !== true) {
        throw new HelmError(
          'validation_error',
          `field '${field.name}' 声明 secretLifetime 但未标记 secret: true（生命周期仅约束机密字段）`,
          400,
        )
      }
      validateSecretLifetime(field.secretLifetime, `field '${field.name}' 的 secretLifetime`)
    }
  }
  // 同会话 secret env 名碰撞明确拒绝（保留声明原样时 'api_key' 与 'API_KEY' 是两个名字）。
  const secretEnvNames = new Map<string, string>()
  for (const field of spec.fields) {
    if (field.secret !== true) continue
    const env = envNameOf(field)
    const existing = secretEnvNames.get(env)
    if (existing !== undefined) {
      throw new HelmError(
        'validation_error',
        `secret 字段 '${existing}' 与 '${field.name}' 映射同一环境变量名 '${env}'：拒绝合并覆盖`,
      )
    }
    secretEnvNames.set(env, field.name)
  }
}

/** 答案边界校验：未知字段 / 非 string / select 越界 / confirm 非法值。 */
function validateAnswersAgainstFields(spec: AskSpec, answers: Record<string, string>): void {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new HelmError('validation_error', 'answers 需为对象')
  }
  const byName = new Map(spec.fields.map((f) => [f.name, f]))
  for (const key of Object.keys(answers)) {
    const value = answers[key]
    if (!byName.has(key)) {
      throw new HelmError('validation_error', `未知答案字段：${key}（AskDoc 未声明）`)
    }
    if (typeof value !== 'string') {
      throw new HelmError('validation_error', `答案字段 ${key} 需为 string（实际 ${typeof value}）`)
    }
  }
  for (const field of spec.fields) {
    const value = answers[field.name]
    if (field.required && (value === undefined || value === '')) {
      throw new HelmError('validation_error', `必填字段缺失：${field.name}`)
    }
    if (value === undefined || value === '') continue
    if (field.type === 'select') {
      const valid = (field.options ?? []).some((o) => o.value === value)
      if (!valid) {
        throw new HelmError(
          'validation_error',
          `select 字段 '${field.name}' 答案 '${value}' 不在候选内`,
        )
      }
    }
    if (field.type === 'confirm' && value !== 'true' && value !== 'false') {
      throw new HelmError(
        'validation_error',
        `confirm 字段 '${field.name}' 答案需为 'true' | 'false'（实际 '${value}'）`,
      )
    }
  }
}
