/**
 * RuntimeTriggerDispatcher: station trigger and message seal guard against escape handle orchestration (from KernelRuntime split out).
 *
 * responsibility:
 * - defang guard against escape message seal escaping (guard against </external_event> inject);
 * - without explicit target trigger default delivery target parse (resolveDefaultTriggerTarget concurrency merge);
 * - external trigger pipeline orchestration (dispatchTrigger validate original explicit target -> trigger hook -> submitInput).
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
  /** trigger by default entry conversation concurrency on demand create Promise. */
  private defaultTriggerTargetCreation: Promise<number> | undefined

  constructor(private readonly deps: RuntimeTriggerDispatcherDeps) {}

  /** defang guard against escape message seal: all motion state field XML escaping (guard against </external_event> inject). */
  defang(envelope: ExternalTriggerEnvelope): string {
    const id = escapeXml(envelope.id)
    const source = escapeXml(envelope.source)
    const body = escapeXml(envelope.text)
    return `<external_event id="${id}" source="${source}" untrusted="true">\n${body}\n</external_event>`
  }

  /**
   * without explicit target trigger default delivery target parse:
   * - without targetConversationId message seal (transform may already change write) enter this method;
   * - choose assistant Profile under most new without parent chain human-owned conversation;ownership only read right threat
   *   conversation-ownership document, do not from tags/parent or summary throw shadow push assert;
   * - no choose when on demand creates new ordinary assistant conversation, and merge same process concurrency create;Promise after completion
   *   i.e. clean up, do not cache can by delete conversation ID, failed after can retry.
   * explicit designate target in trigger hook run before already validate store in, will not enter this method.
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
        title: 'person assist',
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

  /** external trigger: first validate original explicit target, again run can change write routing trigger hook. */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    if (envelope.targetConversationId !== undefined) {
      // Hook(including ThreadKey direct throw) must not invalid explicit target change write into valid target come mask error.
      this.deps.getConversation(envelope.targetConversationId)
    }
    const initial: ExternalTriggerEnvelope = { ...envelope, text: this.defang(envelope) }
    const outcome = await this.deps.hookBridge.runHookChain('trigger', initial)
    if (outcome?.action === 'handled') return
    let final = initial
    if (outcome?.action === 'transform') {
      final = outcome.value as ExternalTriggerEnvelope
      // transform after text again guard against once (plugin may replace original text).
      final = { ...final, text: this.defang({ ...final, text: stripEnvelope(final.text) }) }
    }
    if (final.targetConversationId !== undefined) {
      // explicit target (contains hook change write): expires deputy target by submitInput  requireConv honor bottom
      // explicit not_found(honest reject; expires explicit target must not by heavy routing mask).
      await this.deps.submitInput(final.targetConversationId, final.text, { origin: 'trigger', whenBusy: 'followUp' })
      return
    }
    // default target:resolve and submitInput between target conversation may by delete (TOCTOU window,
    // cannot atomic close).submitInput first row requireConv first at any side effect,not_found
    // reject when for default path heavy parse once again delivery - - this is complete routing decide policy, is not for the same target
    // delivery retry (do not break cronthis plan point do not retry semantics); again failed such as on throw
    // (the time trigger payload lose, semantics and fix before consistent).
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
