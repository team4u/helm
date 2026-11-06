/**
 * AskService：AskDoc 生命周期 + CAS 乐观锁 + secret 入 stash + 外部 seq resolver 注册。
 *
 * 关键语义：
 * - pendingCount 影响 blocked 派生；answer/cancel/supersede 均结算并推事件；
 * - secret 字段答案只入内存 SecretStash，持久层与事件仅存 [REDACTED:stash:<uuid>]；
 * - expectedStateSeq CAS：answer 时向已注册的 resolver 查询目标当前 seq，
 *   已推进则流转 superseded（不重复发送回车）；
 *   注意 ask 创建本身引发的 conversation seq 递增不算 stale——比较对象是
 *   外部目标（herdr 终端窗格），与 helm 会话 seq 无关；
 * - 重启后 pending asks 保留并发出诊断通知（不伪装已处理）。
 */

import type { AskCreateSpec, AskSpec } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import type { HelmStore } from './store.js'
import type { SecretStash } from '../services/secret-stash.js'

/** 外部目标 seq 解析器（后续 herdr 插件注册：askId -> 目标当前 seq）。 */
export type AskSeqResolver = (askId: string) => number | undefined

export interface AskSettled {
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers?: Record<string, string>
}

export class AskService {
  private readonly store: HelmStore
  private readonly stash: SecretStash
  private readonly seqResolvers = new Set<AskSeqResolver>()
  private readonly waiters = new Map<string, Array<(settled: AskSettled) => void>>()
  private readonly onEvent: (type: string, payload: unknown) => void
  private readonly onConvPendingChanged: (conversationId: number) => void

  constructor(options: {
    store: HelmStore
    stash: SecretStash
    onEvent: (type: string, payload: unknown) => void
    onConvPendingChanged: (conversationId: number) => void
  }) {
    this.store = options.store
    this.stash = options.stash
    this.onEvent = options.onEvent
    this.onConvPendingChanged = options.onConvPendingChanged
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

  pendingCount(conversationId: number): number {
    return this.listPendingByConversation(conversationId).length
  }

  getAsk(id: string): AskSpec | undefined {
    const row = this.store.getAsk(id)
    return row ? (JSON.parse(row.specJson) as AskSpec) : undefined
  }

  /**
   * 创建 AskDoc 并等待答案。resolve 的 answers 中 secret 字段为 stash marker
   * （宿主可用 stash.resolve 取回明文）。
   */
  async createAsk(spec: AskCreateSpec): Promise<Record<string, string>> {
    if (!spec.conversationId || !spec.title || !Array.isArray(spec.fields) || spec.fields.length === 0) {
      throw new HelmError('validation_error', 'AskDoc 需要 conversationId、title 与至少一个 field')
    }
    const id = randomUUID()
    const createdAt = Date.now()
    const full: AskSpec = {
      ...spec,
      id,
      status: 'pending',
      createdAt,
      expectedStateSeq: spec.expectedStateSeq,
    }
    this.store.putAsk({
      id,
      conversationId: spec.conversationId,
      ownerPluginId: spec.ownerPluginId,
      specJson: JSON.stringify(full),
      status: 'pending',
      expectedStateSeq: spec.expectedStateSeq,
      createdAt,
    })
    this.onConvPendingChanged(spec.conversationId)
    this.onEvent('ask.upsert', full)
    return new Promise<Record<string, string>>((resolve) => {
      const push = (settled: AskSettled) => {
        if (settled.status === 'answered' && settled.answers) resolve(settled.answers)
        else if (settled.status === 'superseded' && settled.answers) resolve(settled.answers)
        else
          resolve(
            Object.fromEntries(
              spec.fields.map((f) => [f.name, '']),
            ) as Record<string, string>,
          )
      }
      const list = this.waiters.get(id) ?? []
      list.push(push)
      this.waiters.set(id, list)
    })
  }

  /** 提交答案：CAS 检查 -> secret 入 stash -> 结算。 */
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
    const spec = JSON.parse(row.specJson) as AskSpec

    // CAS：外部目标 seq 已超过 ask 创建时水位则 superseded。
    const casSeq = expectedStateSeq ?? row.expectedStateSeq
    if (casSeq !== undefined) {
      const current = this.resolveTargetSeq(id)
      if (current !== undefined && current > casSeq) {
        return this.settle(id, 'superseded', { keepEmptyAnswers: true })
      }
    }

    // 必填校验（secret 字段以非空 marker 为准）。
    for (const field of spec.fields) {
      if (field.required) {
        const value = answers[field.name]
        if (value === undefined || value === '') {
          throw new HelmError('validation_error', `必填字段缺失：${field.name}`)
        }
      }
    }
    // secret 值入 stash；持久与事件只存 marker。
    const stored: Record<string, string> = {}
    for (const field of spec.fields) {
      const value = answers[field.name] ?? ''
      stored[field.name] = field.secret
        ? this.stash.put(spec.conversationId, field.name.toUpperCase(), value)
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
    return Promise.resolve(this.settle(id, reason, { keepEmptyAnswers: true }))
  }

  /** 重启诊断：遗留 pending asks 发 notification（不静默吞）。 */
  reportOrphans(): void {
    const pending = this.listAsks('pending')
    for (const ask of pending) {
      this.onEvent('notification', {
        level: 'warning',
        title: '重启后遗留待答 AskDoc',
        body: `AskDoc ${ask.id}（会话 ${ask.conversationId}）在进程重启前未结算，保持 pending 供人工处理`,
        conversationId: ask.conversationId,
      })
    }
  }

  /** 按会话取消全部 pending（删除会话级联用）。 */
  cancelByConversation(conversationId: number, reason: 'cancelled' | 'superseded' = 'cancelled'): void {
    for (const ask of this.listPendingByConversation(conversationId)) {
      void this.settle(ask.id, reason, { keepEmptyAnswers: true })
    }
  }

  private resolveTargetSeq(askId: string): number | undefined {
    for (const resolver of this.seqResolvers) {
      const value = resolver(askId)
      if (value !== undefined) return value
    }
    return undefined
  }

  private settle(
    id: string,
    status: 'answered' | 'cancelled' | 'superseded',
    options: { answers?: Record<string, string>; keepEmptyAnswers?: boolean },
  ): AskSpec {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc 不存在：${id}`, 404)
    const spec = JSON.parse(row.specJson) as AskSpec
    const settledSpec: AskSpec = { ...spec, status }
    const answers = options.keepEmptyAnswers
      ? Object.fromEntries(spec.fields.map((f) => [f.name, '']))
      : (options.answers ?? {})
    this.store.putAsk({
      ...row,
      status,
      specJson: JSON.stringify(settledSpec),
      resultJson: status === 'answered' ? JSON.stringify(answers) : undefined,
      settledAt: Date.now(),
    })
    this.onConvPendingChanged(spec.conversationId)
    this.onEvent('ask.resolved', { askId: id, status })
    const waiters = this.waiters.get(id) ?? []
    this.waiters.delete(id)
    for (const waiter of waiters) waiter({ askId: id, status, answers })
    return settledSpec
  }
}
