/**
 * 纯内存 SecretStash：秘密只存在进程内存，绝不落盘、绝不进模型上下文。
 * 模型与持久层只看到 `[REDACTED:stash:<uuid>]` 占位符。
 *
 * 生命周期（停止注入 != 停止脱敏）：
 * - put 可选 SecretLifetime：ttlMs 到期或 scope 'turn' 的回合结算后，秘密从
 *   active env bucket（envFor/has）移除，但 byUuid 永久保留旧值用于全部输出
 *   脱敏（含跨 chunk 流式）；同名覆盖的旧值同样继续脱敏；只有 clear(conversationId)
 *   （会话删除/全清）才回收；
 * - TTL 惰性判定：put 时算 expiresAt，读路径（envFor/has/stats）对表 clock，
 *   不设额外定时器；clock 可注入（测试用 fake clock）；
 * - turn 作用域按「出生结算序」精确归属：put 记录当时已完成的回合结算数，
 *   settleTurn 先推进计数再清除出生序小于新计数的秘密——run 存续期登记的
 *   属本回合，结算后登记的（异步审批落地/late hook）属下一回合，绝不误扫；
 * idle 不清扫（无定时器）；
 * - 诚实边界：TTL/回合结束无法从已启动的子进程撤回已注入的环境变量，
 *   只保证后续 spawn 不再注入。
 *
 * addRedaction 登记全局逐值脱敏（如内核受管 HELM_TOKEN）：非环境变量、
 * 不计入 stats、不随 clear(conversationId) 清除；多个登记可叠放同一值，
 * 全部解除后才停止脱敏；clear() 全清时一并移除。
 *
 * 诚实边界（如实声明）：stash 无法防御同进程内的 shell 命令与插件代码
 * 读取环境变量或进程内存——那是可信代码的固有权限，本模块不承诺零泄漏。
 */
import { randomUUID } from 'node:crypto'
import { HelmError, type SecretLifetime } from '@helm/protocol'

export const REDACTED_PREFIX = '[REDACTED:stash:'
export const REDACTED_MARKER = '[REDACTED]'

/** TTL 上限：24 小时（安全上限，防手滑配置成永不过期量级）。 */
export const MAX_SECRET_TTL_MS = 24 * 60 * 60 * 1000

export interface StashedSecret {
  readonly conversationId: number
  readonly uuid: string
  readonly placeholder: string
  readonly value: string
  readonly name: string
  /** TTL 到期时刻（epoch ms；put 时按注入 clock 算出，读路径惰性判定）。 */
  readonly expiresAt?: number
  /** scope 'turn' 的出生结算序（当时已完成的回合结算数；undefined = 会话级）。 */
  readonly bornSettlement?: number
}

/** 合法环境变量名：字母或下划线开头，仅字母数字下划线，非空且不太长。 */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
}

/**
 * SecretLifetime 边界校验（AskDoc spec 与 stash.put 共用）：
 * 平面对象、仅允许 ttlMs/scope 两个键（拼写错漏必须显式拒绝而非静默无 TTL）、
 * ttlMs 为有限正 safe integer 且不超上限、scope 仅两种枚举。
 */
export function validateSecretLifetime(lifetime: SecretLifetime, context: string): SecretLifetime {
  if (
    lifetime === null || typeof lifetime !== 'object' || Array.isArray(lifetime) ||
    (Object.getPrototypeOf(lifetime) !== Object.prototype && Object.getPrototypeOf(lifetime) !== null)
  ) {
    throw new HelmError('validation_error', `${context} 需为对象（收到 ${typeof lifetime}）`, 400)
  }
  const keys = Object.keys(lifetime)
  for (const key of keys) {
    if (key !== 'ttlMs' && key !== 'scope') {
      throw new HelmError('validation_error', `${context} 含未知键 '${key}'（仅允许 ttlMs / scope）`, 400, { key })
    }
  }
  const ttlMs = (lifetime as { ttlMs?: unknown }).ttlMs
  if (ttlMs !== undefined) {
    if (
      typeof ttlMs !== 'number' ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_SECRET_TTL_MS
    ) {
      throw new HelmError(
        'validation_error',
        `${context}.ttlMs 需为不超 ${MAX_SECRET_TTL_MS} 的正 safe integer（收到 ${String(ttlMs)}）`,
        400,
        { ttlMs },
      )
    }
  }
  const scope = (lifetime as { scope?: unknown }).scope
  if (scope !== undefined && scope !== 'conversation' && scope !== 'turn') {
    throw new HelmError(
      'validation_error',
      `${context}.scope 仅允许 'conversation' | 'turn'（收到 ${String(scope)}）`,
      400,
      { scope },
    )
  }
  return { ...(ttlMs !== undefined ? { ttlMs } : {}), ...(scope !== undefined ? { scope } : {}) } as SecretLifetime
}

/** 占位符 ↔ 文本互转工具（ArtifactService spill 脱敏复用）。 */
export function makePlaceholder(uuid: string): string {
  return `${REDACTED_PREFIX}${uuid}]`
}

export function parsePlaceholder(text: string): string | null {
  if (!text.startsWith(REDACTED_PREFIX) || !text.endsWith(']')) return null
  const uuid = text.slice(REDACTED_PREFIX.length, -1)
  return /^[0-9a-f-]{36}$/.test(uuid) ? uuid : null
}

export class SecretStash {
  /** key: conversationId → envName → secret。按会话隔离，防跨会话串用。 */
  private readonly byConversation = new Map<number, Map<string, StashedSecret>>()
  /** key: uuid → secret（redact 快速索引；含已停止注入的旧值，脱敏永不停止）。 */
  private readonly byUuid = new Map<string, StashedSecret>()
  /** 会话 → 已完成的回合结算数（turn 作用域出生序基准）。 */
  private readonly turnSettlements = new Map<number, number>()
  /** 全局逐值脱敏登记：value → 引用计数（多登记叠放，全解除才停止）。 */
  private readonly globalRedactions = new Map<string, number>()
  private redactionEpoch = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 存入秘密，返回 `[REDACTED:stash:<uuid>]` 占位符。
   * 同一 (conversationId, name) 重复 put 会覆盖环境变量，旧值仍保留用于脱敏。
   * lifetime 可选：ttlMs 到期 / scope 'turn' 回合结算后仅停止注入，脱敏继续。
   */
  put(conversationId: number, name: string, value: string, lifetime?: SecretLifetime): string {
    if (!isValidEnvName(name)) {
      throw new Error(`秘密名称必须是合法环境变量名: ${name}`)
    }
    const normalized = lifetime !== undefined ? validateSecretLifetime(lifetime, `秘密 '${name}' 的 lifetime`) : undefined
    let bucket = this.byConversation.get(conversationId)
    if (bucket === undefined) {
      bucket = new Map()
      this.byConversation.set(conversationId, bucket)
    }
    const uuid = randomUUID()
    const secret: StashedSecret = {
      conversationId,
      uuid,
      placeholder: makePlaceholder(uuid),
      value,
      name,
      ...(normalized?.ttlMs !== undefined ? { expiresAt: this.now() + normalized.ttlMs } : {}),
      ...(normalized?.scope === 'turn' ? { bornSettlement: this.turnSettlements.get(conversationId) ?? 0 } : {}),
    }
    bucket.set(name, secret)
    this.byUuid.set(uuid, secret)
    return secret.placeholder
  }

  /** TTL 惰性失效：到期即从 active bucket 移除（byUuid 保留旧值用于脱敏）。 */
  private isExpired(secret: StashedSecret): boolean {
    return secret.expiresAt !== undefined && this.now() >= secret.expiresAt
  }

  /**
   * 汇出该会话的全部活跃秘密为环境变量（注入子进程用）；每次调用只采样一次
   * clock，全部条目按同一时刻判定（TTL 边界内不会同批跨界）。TTL 到期的在此
   * 惰性回收。可选 names 只取指定名（显式授予外部运行时用；缺席的名字静默
   * 跳过，存在性判定由调用方基于实际返回键负责）。
   */
  envFor(conversationId: number, names?: readonly string[]): Record<string, string> {
    const now = this.now()
    const bucket = this.byConversation.get(conversationId)
    const env: Record<string, string> = {}
    if (bucket === undefined) return env
    for (const [name, secret] of bucket) {
      if (secret.expiresAt !== undefined && now >= secret.expiresAt) {
        bucket.delete(name)
        continue
      }
      if (names !== undefined && !names.includes(name)) continue
      // 环境变量名可合法地为 __proto__；定义自有字段，避免触发 Object 原型 setter。
      Object.defineProperty(env, name, { value: secret.value, enumerable: true, writable: true, configurable: true })
    }
    return env
  }

  /**
   * 回合结算钩子（completed | failed | aborted 统一）：先推进结算计数，再回收
   * 出生序早于新计数的 turn 作用域秘密（byUuid 保留旧值用于脱敏）。结算后新
   * 登记的 turn 秘密出生序 = 新计数，属下一回合，不受本次清除影响。
   */
  settleTurn(conversationId: number): void {
    const next = (this.turnSettlements.get(conversationId) ?? 0) + 1
    this.turnSettlements.set(conversationId, next)
    const bucket = this.byConversation.get(conversationId)
    if (bucket === undefined) return
    for (const [name, secret] of bucket) {
      if (secret.bornSettlement !== undefined && secret.bornSettlement < next) bucket.delete(name)
    }
  }

  /**
   * 登记全局逐值脱敏：redact() 将该值替换为 `[REDACTED]`（任意会话上下文均
   * 生效）。非环境变量、不进 envFor/stats；同一值可重复登记，返回的解除
   * 函数引用计数归零后才停止脱敏。
   */
  addRedaction(value: string): () => void {
    if (typeof value !== 'string' || value === '') throw new Error('addRedaction 需要非空字符串')
    this.globalRedactions.set(value, (this.globalRedactions.get(value) ?? 0) + 1)
    const epoch = this.redactionEpoch
    let removed = false
    return () => {
      if (removed || epoch !== this.redactionEpoch) return
      removed = true
      const count = this.globalRedactions.get(value) ?? 0
      if (count <= 1) this.globalRedactions.delete(value)
      else this.globalRedactions.set(value, count - 1)
    }
  }

  /** 是否存在该活跃秘密（按会话隔离判定；TTL 到期惰性回收后为 false）。 */
  has(conversationId: number, name: string): boolean {
    const bucket = this.byConversation.get(conversationId)
    const secret = bucket?.get(name)
    if (secret === undefined) return false
    if (this.isExpired(secret)) {
      bucket!.delete(name)
      return false
    }
    return true
  }

  /** 将已登记的秘密替换为占位符；已有占位符始终保持脱敏。 */
  redact(text: string, conversationId?: number): string {
    const values = new Map<string, string>()
    // 全局逐值脱敏优先于 stash 占位符：受管 token 等宿主秘密不可被任何会话回显
    for (const value of this.globalRedactions.keys()) {
      values.set(value, REDACTED_MARKER)
    }
    for (const secret of this.byUuid.values()) {
      if (secret.value && !values.has(secret.value) && (conversationId === undefined || secret.conversationId === conversationId)) {
        values.set(secret.value, secret.placeholder)
      }
    }
    if (values.size === 0) return text
    const escaped = [...values.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`\\[REDACTED(?::stash:[0-9a-f-]{36})?\\]|${escaped.join('|')}`, 'g')
    return text.replace(pattern, (value) => values.get(value) ?? value)
  }

  /** 增量脱敏：只保留仍可能组成秘密的后缀，不按固定长度切开完整匹配。 */
  createStreamingRedactor(): { push(text: string): string; flush(): string } {
    let pending = ''
    const prefixes = new Map<string, number[]>()
    const overlap = (value: string, text: string): number => {
      let prefix = prefixes.get(value)
      if (!prefix) {
        prefix = new Array<number>(value.length).fill(0)
        for (let i = 1, j = 0; i < value.length; i++) {
          while (j > 0 && value[i] !== value[j]) j = prefix[j - 1]!
          if (value[i] === value[j]) j++
          prefix[i] = j
        }
        prefixes.set(value, prefix)
      }
      let matched = 0
      const tail = text.slice(-Math.max(value.length - 1, 0))
      for (let index = 0; index < tail.length; index++) {
        const char = tail[index]!
        while (matched > 0 && char !== value[matched]) matched = prefix[matched - 1]!
        if (char === value[matched]) matched++
        if (matched === value.length) matched = prefix[matched - 1]!
      }
      return matched
    }
    return {
      push: (text) => {
        pending += text
        let keep = 0
        const values = new Set([...this.globalRedactions.keys(), ...[...this.byUuid.values()].map((secret) => secret.value)])
        for (const value of values) if (value) keep = Math.max(keep, overlap(value, pending))
        const last = pending.charCodeAt(pending.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) keep = Math.max(keep, 1)
        let cut = pending.length - keep
        const escaped = [...values].filter(Boolean).sort((a, b) => b.length - a.length)
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        if (escaped.length) {
          const pattern = new RegExp(`\\[REDACTED(?::stash:[0-9a-f-]{36})?\\]|${escaped.join('|')}`, 'g')
          for (const match of pending.matchAll(pattern)) {
            if (match.index < cut && match.index + match[0].length > cut) { cut = match.index; break }
            if (match.index >= cut) break
          }
        }
        const safe = this.redact(pending.slice(0, cut))
        pending = pending.slice(cut)
        return safe
      },
      flush: () => {
        const safe = this.redact(pending)
        pending = ''
        return safe
      },
    }
  }

  /** 清空指定会话的全部秘密（含脱敏旧值）；省略 conversationId 则清空整个 stash（含全局脱敏登记）。 */
  clear(conversationId?: number): void {
    if (conversationId === undefined) {
      this.byConversation.clear()
      this.byUuid.clear()
      this.turnSettlements.clear()
      this.globalRedactions.clear()
      this.redactionEpoch += 1
      return
    }
    for (const [uuid, secret] of this.byUuid) {
      if (secret.conversationId === conversationId) this.byUuid.delete(uuid)
    }
    this.byConversation.delete(conversationId)
    this.turnSettlements.delete(conversationId)
  }

  /** 调试统计：会话数与活跃秘密总数（单次 clock 采样判定；绝不输出值本身）。 */
  stats(): { conversations: number; secrets: number } {
    const now = this.now()
    let secrets = 0
    for (const bucket of this.byConversation.values()) {
      for (const [name, secret] of bucket) {
        if (secret.expiresAt !== undefined && now >= secret.expiresAt) bucket.delete(name)
        else secrets += 1
      }
    }
    return { conversations: this.byConversation.size, secrets }
  }
}
