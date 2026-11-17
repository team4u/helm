/**
 * RuntimeTriggerDispatcher: orchestrates external trigger routing and defanged message envelope handling (extracted from KernelRuntime).
 *
 * Responsibilities:
 * - Defang external message envelopes via XML escaping (prevents `</external_event>` tag injection);
 * - Busy policy: trigger deliveries submit with `whenBusy = 'steer'` (`followUp` remains available to explicit callers);
 * - Resolve the default delivery target when no explicit target is specified (deduplicating concurrent resolution via `resolveDefaultTriggerTarget`);
 * - Orchestrate the external trigger pipeline (`dispatchTrigger`: validate original explicit target -> run `trigger` hook -> `submitInput`).
 */

import { HelmError } from '@helm/protocol'
import type { ConversationInit, ConversationSummary, ExternalTriggerEnvelope } from '@helm/protocol'
import type { HookBridge } from './hook-bridge.js'
import { escapeXml, stripEnvelope } from './runtime-helpers.js'
import type { HelmStore } from './store.js'

interface RuntimeTriggerDispatcherDeps {
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
  /** Coalesced in-flight Promise for creating the default trigger target conversation on demand. */
  private defaultTriggerTargetCreation: Promise<number> | undefined

  constructor(private readonly deps: RuntimeTriggerDispatcherDeps) {}

  /** Defang an external message envelope: XML-escape all dynamic fields to prevent `</external_event>` injection. */
  defang(envelope: ExternalTriggerEnvelope): string {
    const id = escapeXml(envelope.id)
    const source = escapeXml(envelope.source)
    const body = escapeXml(envelope.text)
    return `<external_event id="${id}" source="${source}" untrusted="true">\n${body}\n</external_event>`
  }

  /**
   * Resolve the default delivery target for a trigger without an explicit target:
   * - Entered only when `targetConversationId` is unset on the envelope (post-hook transforms may rewrite it);
   * - Selects the newest non-child human-owned conversation under the assistant Profile; ownership is read solely
   *   from the authoritative `conversation-ownership` document rather than inferred from tags/parent or summaries;
   * - Creates a normal assistant conversation on demand if none matches, coalescing concurrent in-process creations;
   *   the Promise is cleared immediately upon settlement so deletable IDs are not cached and failures can retry.
   * Explicitly designated targets are validated before the `trigger` hook runs and never enter this method.
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

  /** External trigger delivery: validate any original explicit target before running hooks that may rewrite routing. */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    if (envelope.targetConversationId !== undefined) {
      // Hooks (including ThreadKey mapping) must not mask an invalid explicit target by rewriting it to a valid one.
      this.deps.getConversation(envelope.targetConversationId)
    }
    const initial: ExternalTriggerEnvelope = { ...envelope, text: this.defang(envelope) }
    const outcome = await this.deps.hookBridge.runHookChain('trigger', initial)
    if (outcome?.action === 'handled') return
    let final = initial
    if (outcome?.action === 'transform') {
      final = outcome.value as ExternalTriggerEnvelope
      // Re-defang post-transform text in case a plugin replaced the original payload.
      final = { ...final, text: this.defang({ ...final, text: stripEnvelope(final.text) }) }
    }
    if (final.targetConversationId !== undefined) {
      // Explicit target (including hook rewrites): deleted targets fall through to submitInput's requireConv
      // and throw not_found (honest rejection; an expired explicit target must not be masked by re-routing).
      await this.deps.submitInput(final.targetConversationId, final.text, { origin: 'trigger', whenBusy: 'steer' })
      return
    }
    // Default target: the target conversation may be deleted during the TOCTOU window between resolve and
    // submitInput (cannot be closed atomically). submitInput validates requireConv before any side effect;
    // on not_found for the default path, resolve and deliver once more — this re-evaluates routing rather than
    // retrying delivery to the same target (preserving cron fire-once semantics); a second failure propagates
    // cleanly (dropping that trigger payload, matching pre-fix behavior).
    const target = await this.resolveDefaultTriggerTarget()
    try {
      await this.deps.submitInput(target, final.text, { origin: 'trigger', whenBusy: 'steer' })
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'not_found')) throw err
      const resolved = await this.resolveDefaultTriggerTarget()
      await this.deps.submitInput(resolved, final.text, { origin: 'trigger', whenBusy: 'steer' })
    }
  }
}
