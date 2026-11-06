/**
 * 纯内存 SecretStash：秘密只存在进程内存，绝不落盘、绝不进模型上下文。
 * 模型与持久层只看到 `[REDACTED:stash:<uuid>]` 占位符。
 *
 * addRedaction 登记全局逐值脱敏（如内核受管 HELM_TOKEN）：非环境变量、
 * 不计入 stats、不随 clear(conversationId) 清除；多个登记可叠放同一值，
 * 全部解除后才停止脱敏；clear() 全清时一并移除。
 *
 * 诚实边界（如实声明）：stash 无法防御同进程内的 shell 命令与插件代码
 * 读取环境变量或进程内存——那是可信代码的固有权限，本模块不承诺零泄漏。
 */
import { randomUUID } from 'node:crypto'

export const REDACTED_PREFIX = '[REDACTED:stash:'
export const REDACTED_MARKER = '[REDACTED]'

export interface StashedSecret {
  readonly conversationId: number
  readonly uuid: string
  readonly placeholder: string
  readonly value: string
  readonly name: string
}

/** 合法环境变量名：字母或下划线开头，仅字母数字下划线，非空且不太长。 */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
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
  /** key: uuid → secret（redact 快速索引）。 */
  private readonly byUuid = new Map<string, StashedSecret>()
  /** 全局逐值脱敏登记：value → 引用计数（多登记叠放，全解除才停止）。 */
  private readonly globalRedactions = new Map<string, number>()

  /**
   * 存入秘密，返回 `[REDACTED:stash:<uuid>]` 占位符。
   * 同一 (conversationId, name) 重复 put 会覆盖环境变量，旧值仍保留用于脱敏。
   */
  put(conversationId: number, name: string, value: string): string {
    if (!isValidEnvName(name)) {
      throw new Error(`秘密名称必须是合法环境变量名: ${name}`)
    }
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
    }
    bucket.set(name, secret)
    this.byUuid.set(uuid, secret)
    return secret.placeholder
  }

  /** 汇出该会话的全部秘密为环境变量（注入子进程用）。 */
  envFor(conversationId: number): Record<string, string> {
    const bucket = this.byConversation.get(conversationId)
    const env: Record<string, string> = {}
    if (bucket === undefined) return env
    for (const secret of bucket.values()) env[secret.name] = secret.value
    return env
  }

  /**
   * 登记全局逐值脱敏：redact() 将该值替换为 `[REDACTED]`（任意会话上下文均
   * 生效）。非环境变量、不进 envFor/stats；同一值可重复登记，返回的解除
   * 函数引用计数归零后才停止脱敏。返回 `[REDACTED]` 占位供调用方留存。
   */
  addRedaction(value: string): () => void {
    if (typeof value !== 'string' || value === '') throw new Error('addRedaction 需要非空字符串')
    this.globalRedactions.set(value, (this.globalRedactions.get(value) ?? 0) + 1)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const count = this.globalRedactions.get(value) ?? 0
      if (count <= 1) this.globalRedactions.delete(value)
      else this.globalRedactions.set(value, count - 1)
    }
  }

  /** 是否存在该秘密（按会话隔离判定）。 */
  has(conversationId: number, name: string): boolean {
    return this.byConversation.get(conversationId)?.has(name) ?? false
  }

  /** 将已登记的秘密替换为占位符；已有占位符始终保持脱敏。 */
  redact(text: string, conversationId?: number): string {
    const values = new Map<string, string>()
    // 全局逐值脱敏优先于 stash 占位符：受管 token 等宿主秘密不可被任何会话回显
    for (const value of this.globalRedactions.keys()) {
      values.set(value, REDACTED_MARKER)
    }
    for (const secret of this.byUuid.values()) {
      if (secret.value && (conversationId === undefined || secret.conversationId === conversationId)) {
        values.set(secret.value, secret.placeholder)
      }
    }
    if (values.size === 0) return text
    const escaped = [...values.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`\\[REDACTED:stash:[0-9a-f-]{36}\\]|${escaped.join('|')}`, 'g')
    return text.replace(pattern, (value) => values.get(value) ?? value)
  }

  /** 清空指定会话的全部秘密；省略 conversationId 则清空整个 stash（含全局脱敏登记）。 */
  clear(conversationId?: number): void {
    if (conversationId === undefined) {
      this.byConversation.clear()
      this.byUuid.clear()
      this.globalRedactions.clear()
      return
    }
    for (const [uuid, secret] of this.byUuid) {
      if (secret.conversationId === conversationId) this.byUuid.delete(uuid)
    }
    this.byConversation.delete(conversationId)
  }

  /** 调试统计：会话数与秘密总数（绝不输出值本身）。 */
  stats(): { conversations: number; secrets: number } {
    let secrets = 0
    for (const bucket of this.byConversation.values()) secrets += bucket.size
    return { conversations: this.byConversation.size, secrets }
  }
}
