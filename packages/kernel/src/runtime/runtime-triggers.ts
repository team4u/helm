/**
 * RuntimeTriggerDispatcher：入站触发器与信封防逃逸处理编排（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - defang 防逃逸信封转义（防止 </external_event> 注入）；
 * - 无显式目标 trigger 的缺省投递靶点解析（resolveDefaultTriggerTarget 并发合并）；
 * - 外部触发管道编排（dispatchTrigger 校验原始显式目标 -> trigger hook -> submitInput）。
 */

import { HelmError } from '@helm/protocol'
import type { ConversationInit, ConversationSummary, ExternalTriggerEnvelope } from '@helm/protocol'
import type { HookBridge } from './hook-bridge.js'
import { escapeXml, stripEnvelope } from './runtime-helpers.js'
import type { HelmStore } from './store.js'

export interface RuntimeTriggerDispatcherDeps {
  readonly store: HelmStore
  readonly hookBridge: HookBridge
  getConversation(id: number): ConversationSummary
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  submitInput(
    id: number,
    text: string,
    opts?: { origin?: 'human' | 'agent' | 'trigger'; whenBusy?: 'steer' | 'followUp' | 'reject' },
  ): Promise<unknown>
}

export class RuntimeTriggerDispatcher {
  /** 触发器默认入口会话的并发按需创建 Promise。 */
  private defaultTriggerTargetCreation: Promise<number> | undefined

  constructor(private readonly deps: RuntimeTriggerDispatcherDeps) {}

  /** defang 防逃逸信封：所有动态字段 XML 转义（防 </external_event> 注入）。 */
  defang(envelope: ExternalTriggerEnvelope): string {
    const id = escapeXml(envelope.id)
    const source = escapeXml(envelope.source)
    const body = escapeXml(envelope.text)
    return `<external_event id="${id}" source="${source}" untrusted="true">\n${body}\n</external_event>`
  }

  /**
   * 无显式目标 trigger 的缺省投递靶点解析：
   * - 无 targetConversationId 的信封（transform 可能已改写）进入本方法；
   * - 选择 assistant Profile 下最新的无父链 human-owned 会话；ownership 只读权威
   *   conversation-ownership 文档，不从 tags/parent 或摘要投影推断；
   * - 没有候选时按需新建普通 assistant 会话，并合并同进程并发创建；Promise 完成后
   *   即清理，不缓存可被删除的会话 ID，失败后可重试。
   * 显式指定的目标在 trigger hook 运行前已校验存在，不会进入本方法。
   */
  async resolveDefaultTriggerTarget(): Promise<number> {
    const candidates = this.deps.store
      .listConvs()
      .filter((c) =>
        c.profileId === 'assistant' &&
        c.parentConversationId === undefined &&
        this.deps.getConversationOwnership(c.id) === 'human',
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    if (candidates[0] !== undefined) return candidates[0].id

    if (this.defaultTriggerTargetCreation !== undefined) return this.defaultTriggerTargetCreation
    const creation = this.deps
      .createConversation({
        title: '个人助理',
        profileId: 'assistant',
        tags: ['assistant'],
      })
      .then((created) => created.id)
    this.defaultTriggerTargetCreation = creation
    try {
      return await creation
    } finally {
      if (this.defaultTriggerTargetCreation === creation) this.defaultTriggerTargetCreation = undefined
    }
  }

  /** 外部触发：先校验原始显式目标，再运行可改写路由的 trigger hook。 */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    if (envelope.targetConversationId !== undefined) {
      // Hook（包括 ThreadKey 直投）不得把无效的显式目标改写成有效目标来掩盖错误。
      this.deps.getConversation(envelope.targetConversationId)
    }
    const initial: ExternalTriggerEnvelope = { ...envelope, text: this.defang(envelope) }
    const outcome = await this.deps.hookBridge.runHookChain('trigger', initial)
    if (outcome?.action === 'handled') return
    let final = initial
    if (outcome?.action === 'transform') {
      final = outcome.value as ExternalTriggerEnvelope
      // transform 后的 text 再防一次（插件可能替换了原文）。
      final = { ...final, text: this.defang({ ...final, text: stripEnvelope(final.text) }) }
    }
    if (final.targetConversationId !== undefined) {
      // 显式目标（含 hook 改写）：失效副目标由 submitInput 的 requireConv 兑底
      // 显式 not_found（诚实拒绝；失效的显式目标不得被重路由掩盖）。
      await this.deps.submitInput(final.targetConversationId, final.text, { origin: 'trigger', whenBusy: 'followUp' })
      return
    }
    // 缺省目标：resolve 与 submitInput 之间目标会话可能被删除（TOCTOU 窗口，
    // 无法原子关闭）。submitInput 首行 requireConv 先于任何副作用，not_found
    // 拒绝时对缺省路径重解析一次再投递——这是完成路由决策，不是对同一目标
    // 的投递重试（不破坏 cron「本计划点不重试」语义）；再失败如实上抛
    // （该次触发载荷丢失，语义与修复前一致）。
    const target = await this.resolveDefaultTriggerTarget()
    try {
      await this.deps.submitInput(target, final.text, { origin: 'trigger', whenBusy: 'followUp' })
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'not_found')) throw err
      const resolved = await this.resolveDefaultTriggerTarget()
      await this.deps.submitInput(resolved, final.text, { origin: 'trigger', whenBusy: 'followUp' })
    }
  }
}
