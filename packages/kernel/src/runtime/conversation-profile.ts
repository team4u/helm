/**
 * Conversation profile and model inheritance chain alignment module.
 *
 * Responsibilities:
 * - Read and validate Profile configurations;
 * - Resolve effective model chain (conversation override > Profile.model > global default);
 * - Resolve effective thinking level chain (conversation override > per-model default > Profile.thinkingLevel > global fallback);
 * - Serialize per-conversation configuration updates (withConversationChange);
 * - Reconcile SDK conversation model/thinkingLevel against store mirror (alignConversationModel);
 * - Cascade inheritance updates after Profile save (alignProfileConversations).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Harness } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { assertProfileId, type Profile, type ProfileService } from '../services/index.js'
import { clampThinkingLevelForModel } from './models.js'
import type { EventHub } from './events.js'
import type { HelmStore } from './store.js'

interface ConversationProfileHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly events: EventHub
  readonly profilesSvc: ProfileService
  /** Current Models collection (for capability clamping; reads latest collection after hot reload). */
  readonly models: () => Models
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** Per-model thinking defaults lookup (`config.json.modelThinkingLevels`, keyed by full `'provider/modelId'`). */
  readonly modelThinkingLevelOf: (ref: { provider: string; modelId: string }) => string | undefined
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  readonly summaryWithOwnership: (id: number) => ConversationSummary
  /** Schedule context usage recalculation after model/thinking alignment (window/threshold may change); omitted skips. */
  readonly scheduleContextUsageRefresh?: (id: number) => void
}

export class ConversationProfileService {
  /** Serialize configuration mutations per conversation so inheritance refreshes and explicit overrides do not clobber each other. */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()

  constructor(private readonly host: ConversationProfileHost) {}

  /** Report Profile read failures separately from missing profiles so corrupt files aren't mistaken for unconfigured models. */
  async readProfile(profileId: string): Promise<Profile | undefined> {
    try {
      assertProfileId(profileId)
    } catch (error) {
      throw new HelmError('validation_error', error instanceof Error ? error.message : String(error), 400)
    }
    try {
      return await this.host.profilesSvc.get(profileId)
    } catch (error) {
      throw new HelmError(
        'profile_read_failed',
        `failed to read Profile ${profileId}: ${error instanceof Error ? error.message : String(error)}`,
        500,
        { profileId },
      )
    }
  }

  /** Conversation override > Profile.model > global default; Profile files are read live on each lookup. */
  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('profile_not_found', `Profile referenced by conversation does not exist: ${profileId}`, 404, { profileId })
    }
    return override || profile.model || this.host.defaultModel()
  }

  /**
   * Thinking level inheritance: conversation override > per-model default for the effective model >
   * Profile.thinkingLevel > global fallback; then clamped to levels supported by the effective model
   * (nearest supported level if unsupported).
   * Unconfigured values (undefined / empty string) are returned unchanged rather than coerced into explicit 'off'.
   */
  async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string, modelRef?: { provider: string; modelId: string }): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (!profile) throw new HelmError('profile_not_found', `Profile referenced by conversation does not exist: ${profileId}`, 404, { profileId })
    const perModel = modelRef !== undefined ? this.host.modelThinkingLevelOf(modelRef) : undefined
    const inherited = override || perModel || profile.thinkingLevel || this.host.defaultThinkingLevel()
    return clampThinkingLevelForModel(this.host.models(), modelRef, inherited)
  }

  async withConversationChange<T>(id: number, change: () => Promise<T>): Promise<T> {
    const previous = this.conversationChanges.get(id) ?? Promise.resolve()
    const run = previous.then(change, change)
    this.conversationChanges.set(id, run)
    try {
      return await run
    } finally {
      if (this.conversationChanges.get(id) === run) this.conversationChanges.delete(id)
    }
  }

  /** Inherit model and thinking level separately; always reconcile against SDK to heal restarts and historical fork snapshots. */
  async alignConversationModel(id: number, emitEvent = false): Promise<void> {
    await this.withConversationChange(id, async () => {
      const meta = this.host.store.getConv(id)
      if (!meta) return
      const effective = await this.resolveEffectiveModel(meta.modelOverride, meta.profileId)
      const ref = effective ? this.host.parseModelRefOrThrow(effective) : undefined
      // Also persist the clamped result of an explicit override; otherwise SDK/summary converge while the mirror keeps
      // the raw override, causing the next alignment pass to still see "effective != override".
      const clampedOverride = clampThinkingLevelForModel(this.host.models(), ref, meta.thinkingLevelOverride)
      const thinking = await this.resolveEffectiveThinkingLevel(clampedOverride, meta.profileId, ref)
      const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      const agent = await conversation.agent(BACKGROUND_CONTEXT)
      const change: AgentChange = {
        ...(agent.model?.provider !== ref?.provider || agent.model?.modelId !== ref?.modelId
          ? { model: ref ?? null } : {}),
        ...(agent.thinkingLevel !== (thinking ?? 'off')
          ? { thinkingLevel: (thinking as ModelThinkingLevel | undefined) ?? null } : {}),
      }
      const sdkChanged = Object.keys(change).length > 0
      if (sdkChanged) await conversation.configure(change, BACKGROUND_CONTEXT)
      if (
        !sdkChanged &&
        meta.model === (effective ?? '') &&
        meta.thinkingLevel === (thinking ?? '') &&
        meta.thinkingLevelOverride === clampedOverride
      ) return
      const latest = this.host.store.getConv(id)
      if (!latest) return
      this.host.store.upsertConv({
        ...latest,
        model: effective ?? '',
        thinkingLevel: thinking ?? '',
        thinkingLevelOverride: clampedOverride,
        stateChangeSeq: latest.stateChangeSeq + 1,
        updatedAt: Date.now(),
      })
      // Effective model changes also change context window/thresholds: trigger usage recalculation (deduplicated;
      // covers forks and profile cascade refreshes, while initial observe uses adoptInitial as backstop).
      this.host.scheduleContextUsageRefresh?.(id)
      if (emitEvent) this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
    })
  }

  /** Immediate inheritance cascade after saving a Profile (explicit overrides stay protected by each resolution chain). */
  async alignProfileConversations(profileId: string): Promise<void> {
    for (const meta of this.host.store.listConvs()) {
      if (meta.profileId === profileId) await this.alignConversationModel(meta.id, true)
    }
  }
}
