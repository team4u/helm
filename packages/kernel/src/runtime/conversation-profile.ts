/**
 * 会话角色与模型继承链对齐模块。
 *
 * 职责：
 * - Profile 配置读取与格式校验；
 * - 生效模型解析链（会话覆盖 > Profile.model > 全局默认）；
 * - 生效思考档位解析链（会话覆盖 > Profile.thinkingLevel > 全局默认）；
 * - 单会话配置变更串行化（withConversationChange）；
 * - SDK 会话模型/思考档位配置核对与 store 镜像同步（alignConversationModel）；
 * - Profile 保存后的级联批量继承刷新（alignProfileConversations）。
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
  /** 当前 Models 集合（能力收敛用；热重载后读到最新集合）。 */
  readonly models: () => Models
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  readonly summaryWithOwnership: (id: number) => ConversationSummary
}

export class ConversationProfileService {
  /** 同一会话的配置变更串行提交，避免继承刷新与显式覆盖互相覆盖。 */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()

  constructor(private readonly host: ConversationProfileHost) {}

  /** Profile 读取失败与不存在分开报告，避免损坏文件被当成缺少模型配置。 */
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
        `读取 Profile ${profileId} 失败：${error instanceof Error ? error.message : String(error)}`,
        500,
        { profileId },
      )
    }
  }

  /** 会话覆盖 > Profile.model > 全局；Profile 文件每次实时读取。 */
  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('profile_not_found', `会话引用的 Profile 不存在：${profileId}`, 404, { profileId })
    }
    return override || profile.model || this.host.defaultModel()
  }

  /**
   * 思考档位覆盖 > Profile.thinkingLevel > 全局默认；再按生效模型能力
   * 收敛到 SDK 可用档位（不支持的档位就近取可用档）。
   * 未配置（undefined/空串）原样返回，不误变成显式 off。
   */
  async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string, modelRef?: { provider: string; modelId: string }): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (!profile) throw new HelmError('profile_not_found', `会话引用的 Profile 不存在：${profileId}`, 404, { profileId })
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

  /** 模型与思考档位分别继承；始终核对 SDK，以修复重启或 fork 的历史快照。 */
  async alignConversationModel(id: number, emitEvent = false): Promise<void> {
    await this.withConversationChange(id, async () => {
      const meta = this.host.store.getConv(id)
      if (!meta) return
      const effective = await this.resolveEffectiveModel(meta.modelOverride, meta.profileId)
      const ref = effective ? this.host.parseModelRefOrThrow(effective) : undefined
      // 对齐同样要持久化显式覆盖的收敛结果。否则 SDK/摘要虽已收敛，
      // 镜像仍保留原覆盖值，下一次对齐会再次出现「生效值与覆盖值不一致」。
      const clampedOverride = clampThinkingLevelForModel(this.host.models(), ref, meta.thinkingLevelOverride)
      const thinking = await this.resolveEffectiveThinkingLevel(clampedOverride, meta.profileId, ref)
      const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
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
      if (emitEvent) this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
    })
  }

  /** Profile 保存后的即时继承刷新（覆盖值由各自的解析链保护）。 */
  async alignProfileConversations(profileId: string): Promise<void> {
    for (const meta of this.host.store.listConvs()) {
      if (meta.profileId === profileId) await this.alignConversationModel(meta.id, true)
    }
  }
}
