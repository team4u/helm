/**
 * conversation role and model inherit chain align module.
 *
 * responsibility:
 * - Profile config read and format validate;
 * - takes effect model parse chain (conversation override > Profile.model > global by default);
 * - takes effect think Profile parse chain (conversation override > Profile.thinkingLevel > global by default);
 * - single conversation config change serial (withConversationChange);
 * - SDK conversation model/think Profile config core for and store mirror sync (alignConversationModel);
 * - Profile save after level join batch amount inherit refresh (alignProfileConversations).
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

export interface ConversationProfileHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly events: EventHub
  readonly profilesSvc: ProfileService
  /** when before Models set (capability converge use; hot reload after read to most new set). */
  readonly models: () => Models
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  readonly summaryWithOwnership: (id: number) => ConversationSummary
  /** model/Profile align after trigger context use amount heavy compute (window/threshold may change); default does not trigger. */
  readonly scheduleContextUsageRefresh?: (id: number) => void
}

export class ConversationProfileService {
  /** the same conversation config change serial commit, avoid inherit refresh and explicit override mutual each other override. */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()

  constructor(private readonly host: ConversationProfileHost) {}

  /** Profile failed to read and missing open report, avoid corrupt file by when into missing model config. */
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
        `read Profile ${profileId} failed:${error instanceof Error ? error.message : String(error)}`,
        500,
        { profileId },
      )
    }
  }

  /** conversation override > Profile.model > global;Profile file each time real-time read. */
  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('profile_not_found', `conversation reference Profile missing:${profileId}`, 404, { profileId })
    }
    return override || profile.model || this.host.defaultModel()
  }

  /**
   * think Profile override > Profile.thinkingLevel > global by default; again by takes effect model capability
   * converge to SDK available Profile (unsupported Profile then near take available Profile).
   * not config (undefined/empty string) original return, do not mistakenly becomes explicit off.
   */
  async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string, modelRef?: { provider: string; modelId: string }): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (!profile) throw new HelmError('profile_not_found', `conversation reference Profile missing:${profileId}`, 404, { profileId })
    const inherited = override || profile.thinkingLevel || this.host.defaultThinkingLevel()
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

  /** model and think Profile respectively inherit; always core for SDK, with fix restart or fork history snapshot. */
  async alignConversationModel(id: number, emitEvent = false): Promise<void> {
    await this.withConversationChange(id, async () => {
      const meta = this.host.store.getConv(id)
      if (!meta) return
      const effective = await this.resolveEffectiveModel(meta.modelOverride, meta.profileId)
      const ref = effective ? this.host.parseModelRefOrThrow(effective) : undefined
      // align same want persist explicit override converge result. otherwise SDK/summary although already converge,
      // mirror still keep original override value, under once align will again appear takes effect value and override value inconsistent.
      const clampedOverride = clampThinkingLevelForModel(this.host.models(), ref, meta.thinkingLevelOverride)
      const thinking = await this.resolveEffectiveThinkingLevel(clampedOverride, meta.profileId, ref)
      const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
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
      // takes effect model change after context window/threshold follow of change: trigger use amount heavy compute (dedupe;forks
      // and profile level join refresh all via this align, first time observe path another has adoptInitial honor bottom).
      this.host.scheduleContextUsageRefresh?.(id)
      if (emitEvent) this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
    })
  }

  /** Profile save after i.e. when inherit refresh (override value by each parse chain protect). */
  async alignProfileConversations(profileId: string): Promise<void> {
    for (const meta of this.host.store.listConvs()) {
      if (meta.profileId === profileId) await this.alignConversationModel(meta.id, true)
    }
  }
}
