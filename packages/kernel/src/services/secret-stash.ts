/**
 * 纯内存 SecretStash：秘密只存在进程内存，绝不落盘、绝不进模型上下文。
 * 模型与持久层只看到 `[REDACTED:stash:<uuid>]` 占位符。
 *
 * 诚实边界（如实声明）：stash 无法防御同进程内的 shell 命令与插件代码
 * 读取环境变量或进程内存——那是可信代码的固有权限，本模块不承诺零泄漏。
 */
import { randomUUID } from 'node:crypto'

export const REDACTED_PREFIX = '[REDACTED:stash:'

export interface StashedSecret {
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

  /**
   * 存入秘密，返回 `[REDACTED:stash:<uuid>]` 占位符。
   * 同一 (conversationId, name) 重复 put 会覆盖旧值并作废旧占位符。
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
    const existing = bucket.get(name)
    if (existing !== undefined) this.byUuid.delete(existing.uuid)
    const uuid = randomUUID()
    const secret: StashedSecret = {
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

  /** 是否存在该秘密（按会话隔离判定）。 */
  has(conversationId: number, name: string): boolean {
    return this.byConversation.get(conversationId)?.has(name) ?? false
  }

  /**
   * 将文本中的已知占位符还原为秘密值。
   * - 指定 conversationId 时仅还原该会话的秘密（跨会话占位符保持原样，防泄漏）；
   * - 未指定时还原任意已知占位符（仅限进程内可信调用方）。
   */
  redact(text: string, conversationId?: number): string {
    return text.replace(
      /\[REDACTED:stash:[0-9a-f-]{36}\]/g,
      (matched) => {
        const uuid = parsePlaceholder(matched)
        if (uuid === null) return matched
        const secret = this.byUuid.get(uuid)
        if (secret === undefined) return matched
        if (
          conversationId !== undefined &&
          !this.byConversation.get(conversationId)?.has(secret.name)
        ) {
          // 占位符属于其他会话：保持脱敏，绝不跨会话还原。
          return matched
        }
        return secret.value
      },
    )
  }

  /** 清空指定会话的全部秘密；省略 conversationId 则清空整个 stash。 */
  clear(conversationId?: number): void {
    if (conversationId === undefined) {
      this.byConversation.clear()
      this.byUuid.clear()
      return
    }
    const bucket = this.byConversation.get(conversationId)
    if (bucket === undefined) return
    for (const secret of bucket.values()) this.byUuid.delete(secret.uuid)
    this.byConversation.delete(conversationId)
  }

  /** 调试统计：会话数与秘密总数（绝不输出值本身）。 */
  stats(): { conversations: number; secrets: number } {
    let secrets = 0
    for (const bucket of this.byConversation.values()) secrets += bucket.size
    return { conversations: this.byConversation.size, secrets }
  }
}
