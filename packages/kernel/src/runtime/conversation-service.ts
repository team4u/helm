/**
 * 会话服务：CRUD / 详情分页 / 输入提交（submitInput）/ 原地覆盖重发
 * （rewrite）/ fork / reset / compact / 模型继承链对齐 / 附件内容拼装。
 *
 * 从 runtime.ts 拆出（上帝类最大职责簇）。对外行为与原 KernelRuntime 方法
 * 逐一致；内部将历史重写、上下文操作、附件解析、详情分页、角色对齐和输入管道委托给专门子模块。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, AgentChange } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationDetail,
  ConversationInit,
  ConversationInputResult,
  ConversationListFilter,
  ConversationPatch,
  ConversationSummary,
  ConversationWithdrawResponse,
  GuardedMutationExpectation,
  InputOrigin,
  WhenBusy,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ArtifactService as SvcArtifactService, ProfileService, SecretStash, Profile } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import {
  assistantTextOfModel,
  requireConv,
  type RewindInterval,
} from './runtime-helpers.js'
import { toConversationEntry } from './entries.js'
import { clampThinkingLevelForModel } from './models.js'
import { THINKING_LEVELS } from './spawn.js'
import type { HelmStore } from './store.js'
import { ConversationAttachments } from './conversation-attachments.js'
import { ConversationContextOps } from './conversation-context-ops.js'
import { ConversationDetailService } from './conversation-detail.js'
import { ConversationInputPipeline } from './conversation-input.js'
import { ConversationProfileService } from './conversation-profile.js'
import { ConversationRewind, type RewindNewInput } from './conversation-rewind.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric, type TrustedNodePlatformSource } from './target-cwd.js'

export interface ConversationServiceOptions {
  readonly harness: Harness
  readonly storage: { scanConversations(query: never, limit: number, cursor: never, context: unknown): Promise<{ readonly items: ReadonlyArray<{ id: number | string; parent?: { conversationId?: number } }>; next?: unknown }> }
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly profilesSvc: ProfileService
  readonly artifactsSvc: SvcArtifactService
  readonly stash: SecretStash
  readonly dataDir: string
  readonly toolDeps: { defaultCwd: string }
  /** 会话靶点变更时释放旧靶点底座缓存（宿主注入 envFabric.evictConversation）。 */
  readonly evictConversationBase: (conversationId: number) => void
  /** 插件会话管理权（删除保护；宿主注入）。 */
  readonly managedConversations: Map<number, Set<string>>
  /** 挂起 Ask 级联取消（删除会话时；宿主注入 asks.cancelByConversation）。 */
  readonly cancelAsksByConversation: (id: number) => Promise<void>
  /** 原地覆盖重发前挂起 Ask 销单 superseded（宿主注入 asks.listPendingByConversation + cancelAsk）。 */
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  /** handled 接管残留清理（删除/abort 兑底）。 */
  readonly evictHandledToolCalls: (conversationId: number) => void
  /** 归属标记（删除兑底恢复 human；宿主注入）。 */
  readonly markOwnership: (id: number, owner: 'helm' | 'bot' | 'human') => void
  /** 归属现读（摘要投射用）。 */
  readonly ownershipOf: (id: number) => 'helm' | 'bot' | 'human'
  /** input hook 管道（宿主 HookBridge.runHookChain）。 */
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  /** 关闭守卫（isClosed）。 */
  readonly isClosed: () => boolean
  /** 模型解析链（默认模型）。 */
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** 当前 Models 集合（思考档位能力收敛用）。 */
  readonly models: () => Models
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** 模型禁用预检（ModelRegistry.assertModelEnabled；禁用模型拒绝选用与提交）。 */
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  /**
   * 可信节点平台来源（EnvFabric.registry 上报；缺省仅 local 可解析）。
   * create/update cwd 按目标节点平台规范化用（见 runtime/target-cwd.ts）。
   */
  readonly trustedPlatformOf?: TrustedNodePlatformSource
}

/** 提交输入的可选参数（HTTP/CLI/内部同构）。 */
export interface SubmitInputOptions {
  origin?: InputOrigin
  whenBusy?: WhenBusy
  /** @internal guarded 提交可要求 SDK 原子拒绝空闲会话；HTTP/CLI 不开放。 */
  whenIdle?: 'reject'
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  /** 内部完成回报的持久幂等键；HTTP 输入不开放此字段。 */
  requestId?: string
  /**
   * @internal 内核 guarded mutation 通道（submitInputGuarded 注入；宿主 API
   * 与 HTTP/CLI 均不暴露）：在提交点（SDK submit 调用前、最后一个 await
   * 之后）同步复核归属与水位，失败 409/404 且不产生提交副作用。
   */
  mutationGuard?: GuardedMutationExpectation
}

export class ConversationService {
  private readonly harness: Harness
  private readonly storage: ConversationServiceOptions['storage']
  private readonly store: HelmStore
  private readonly tracker: ConversationTracker
  private readonly events: EventHub
  private readonly profilesSvc: ProfileService
  private readonly artifactsSvc: SvcArtifactService
  private readonly stash: SecretStash
  private readonly dataDir: string
  private readonly o: ConversationServiceOptions

  private readonly attachments: ConversationAttachments
  private readonly rewind: ConversationRewind
  private readonly contextOps: ConversationContextOps
  private readonly detailOps: ConversationDetailService
  private readonly profileAlignment: ConversationProfileService
  private readonly inputPipeline: ConversationInputPipeline

  constructor(options: ConversationServiceOptions) {
    this.o = options
    this.harness = options.harness
    this.storage = options.storage
    this.store = options.store
    this.tracker = options.tracker
    this.events = options.events
    this.profilesSvc = options.profilesSvc
    this.artifactsSvc = options.artifactsSvc
    this.stash = options.stash
    this.dataDir = options.dataDir

    this.attachments = new ConversationAttachments({
      store: this.store,
      artifactsSvc: this.artifactsSvc,
      dataDir: this.dataDir,
    })

    this.rewind = new ConversationRewind({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      cancelPendingAsksForRewrite: this.o.cancelPendingAsksForRewrite,
      abortConversation: (id) => this.abortConversation(id),
    })

    this.contextOps = new ConversationContextOps({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      events: this.events,
      stash: this.stash,
      isClosed: this.o.isClosed,
      alignConversationModel: (id) => this.alignConversationModel(id),
      withOwnership: (summary) => this.withOwnership(summary),
    })

    this.detailOps = new ConversationDetailService({
      harness: this.harness,
      store: this.store,
      stash: this.stash,
      getConversation: (id) => this.getConversation(id),
      collectRewindIntervals: (conv) => this.rewind.collectRewindIntervals(conv),
    })

    this.profileAlignment = new ConversationProfileService({
      harness: this.harness,
      store: this.store,
      events: this.events,
      profilesSvc: this.profilesSvc,
      models: this.o.models,
      defaultModel: this.o.defaultModel,
      defaultThinkingLevel: this.o.defaultThinkingLevel,
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
    })

    this.inputPipeline = new ConversationInputPipeline({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      stash: this.stash,
      runInputHook: this.o.runInputHook,
      resolveAuthorizedAttachments: (convId, ids) => this.attachments.resolveAuthorizedAttachments(convId, ids),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
    })
  }

  // ------------------------------------------------------------------
  // guarded mutation（自动化红线内核执行层）
  // ------------------------------------------------------------------

  /** 会话级 guarded 变更串行门（promise 尾链）：同一会话的自动化中止/提交
   * 在「复核 + 第一个不可逆动作」临界区上完全有序，不同会话互不阻塞。 */
  private readonly mutationGates = new Map<number, Promise<unknown>>()

  private withMutationGate<T>(id: number, op: () => Promise<T>): Promise<T> {
    const prev = this.mutationGates.get(id) ?? Promise.resolve()
    // 前序失败不阻断后续（尾链吸收错误；op 每次真实执行）。
    const run = prev.then(op, op)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.mutationGates.set(id, tail)
    void tail.then(() => {
      if (this.mutationGates.get(id) === tail) this.mutationGates.delete(id)
    })
    return run
  }

  /** 守卫载荷边界校验（同步抛 400）：expectedOwnership 严禁 'human'。 */
  private assertGuardShape(guard: GuardedMutationExpectation): void {
    if (typeof guard !== 'object' || guard === null) {
      throw new HelmError('validation_error', 'guarded mutation 需要 guard 对象', 400)
    }
    if (
      guard.expectedOwnership !== undefined &&
      guard.expectedOwnership !== 'bot' &&
      guard.expectedOwnership !== 'helm'
    ) {
      throw new HelmError(
        'validation_error',
        `expectedOwnership 仅允许 'bot' | 'helm'（自动化红线严禁 human）：收到 ${String(guard.expectedOwnership)}`,
        400,
        { expectedOwnership: guard.expectedOwnership },
      )
    }
    if (
      guard.expectedStateSeq !== undefined &&
      (!Number.isSafeInteger(guard.expectedStateSeq) || guard.expectedStateSeq < 0)
    ) {
      throw new HelmError(
        'validation_error',
        `expectedStateSeq 需为非负安全整数：收到 ${String(guard.expectedStateSeq)}`,
        400,
        { expectedStateSeq: guard.expectedStateSeq },
      )
    }
  }

  /**
   * 守卫复核（同步、零 await）：会话存在性 + 归属（human 永远拒绝）+
   * 可选 CAS 水位。调用方保证本复核与第一个不可逆动作（SDK abort/submit
   * 调用）之间无任何事件循环让出——单线程内 markOwnership 无法插入，
   * 这是 human 红线竞态窗口的真正关闭点。
   */
  assertMutationGuard(id: number, guard: GuardedMutationExpectation): void {
    // getOwnership 对缺失/已删（tombstone）会话显式 not_found——显式目标
    // 失效直接拒绝，绝不被缺省路由掩盖。
    const ownedBy = this.o.ownershipOf(id)
    if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
      throw new HelmError(
        'ownership_conflict',
        `会话 ${id} 当前归属 ${ownedBy}${guard.expectedOwnership !== undefined ? `（期望 ${guard.expectedOwnership}）` : ''}，拒绝自动化变更（human 红线）`,
        409,
        {
          conversationId: id,
          currentOwnership: ownedBy,
          ...(guard.expectedOwnership !== undefined ? { expectedOwnership: guard.expectedOwnership } : {}),
        },
      )
    }
    if (guard.expectedStateSeq !== undefined) {
      const meta = this.store.getConv(id)
      if (meta === undefined || this.store.isDeleted(id)) {
        throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      }
      if (meta.stateChangeSeq !== guard.expectedStateSeq) {
        throw new HelmError(
          'state_seq_conflict',
          `会话 ${id} 权威水位 ${meta.stateChangeSeq} 与期望 ${guard.expectedStateSeq} 不一致（探针事实已过期，不得作用于新回合）`,
          409,
          { conversationId: id, currentSeq: meta.stateChangeSeq, expectedSeq: guard.expectedStateSeq },
        )
      }
    }
  }

  /**
   * 自动化 guarded 中止：守卫复核与 SDK abort 调用（第一个不可逆动作）在
   * 同一串行域内背靠背执行（零 await 间隔）；复核失败绝不发起中止。
   * 普通 abortConversation 语义不变（人类/CLI 路径不绑定自动化守卫）。
   */
  async abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void> {
    this.assertGuardShape(guard)
    return this.withMutationGate(id, async () => {
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      // 最终复核：与下方 abort 调用之间零 await（上方 await 窗口内的归属翻转在此拦截）。
      this.assertMutationGuard(id, guard)
      const wasBusy = this.tracker.hasLiveWork(id)
      await conversation.abort(BACKGROUND_CONTEXT)
      if (wasBusy) this.tracker.settleAborted(id)
      this.o.evictHandledToolCalls(id)
    })
  }

  /**
   * 自动化 guarded 提交：入口同步快检（fail-fast，零副作用）后走完整输入管道；
   * 钩子/模型解析等准备工作完成后，在提交点（SDK submit 调用前）原子复核
   * （见 ConversationInputPipeline.submitFreshInput）。复核失败不产生提交副作用。
   */
  async submitInputGuarded(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
    guard: GuardedMutationExpectation = {},
  ): Promise<{ submissionId: string }> {
    this.assertGuardShape(guard)
    if (opts?.whenIdle !== undefined && opts.whenIdle !== 'reject') {
      throw new HelmError('validation_error', 'guarded 提交的 whenIdle 仅允许 reject', 400)
    }
    if (opts?.replaceFromEntryId !== undefined) {
      throw new HelmError(
        'validation_error',
        '自动化 guarded 提交不支持 replaceFromEntryId（自动化不重写历史）',
        400,
        { conversationId: id, replaceFromEntryId: opts.replaceFromEntryId },
      )
    }
    this.contextOps.assertOpen()
    // 入口快检：任何持久副作用（钩子观察/标题派生/提交）之前拒绝。
    this.assertMutationGuard(id, guard)
    return this.submitInput(id, text, { ...opts, mutationGuard: guard })
  }

  // ------------------------------------------------------------------
  // 摘要与归属投射
  // ------------------------------------------------------------------

  summaryWithOwnership(id: number): ConversationSummary {
    return { ...this.tracker.summaryOf(id), ownedBy: this.o.ownershipOf(id) }
  }

  withOwnership(summary: ConversationSummary): ConversationSummary {
    return { ...summary, ownedBy: this.o.ownershipOf(summary.id) }
  }

  listConversations(filter?: ConversationListFilter): ConversationSummary[] {
    return this.store
      .listConvs()
      .map((meta) => this.summaryWithOwnership(meta.id))
      .filter((s) => (filter?.profileId ? s.profileId === filter.profileId : true))
      .filter((s) => (filter?.tag ? s.tags.includes(filter.tag) : true))
      .filter((s) => (filter?.status ? s.status === filter.status : true))
      .filter((s) =>
        filter?.parentConversationId !== undefined
          ? s.parentConversationId === filter.parentConversationId
          : true,
      )
      .filter((s) => (filter?.topLevelOnly ? s.parentConversationId === undefined : true))
  }

  getConversation(id: number): ConversationSummary {
    requireConv(this.store, id)
    return this.summaryWithOwnership(id)
  }

  // ------------------------------------------------------------------
  // 详情分页与 FTS 重建（委托给 detailOps）
  // ------------------------------------------------------------------

  async getConversationDetail(id: number, options?: { limit?: number; cursor?: string }): Promise<ConversationDetail> {
    return this.detailOps.getConversationDetail(id, options)
  }

  async collectRewindIntervals(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    return this.rewind.collectRewindIntervals(conversation)
  }

  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    return this.detailOps.rebuildFts(listConversationIds)
  }

  // ------------------------------------------------------------------
  // Profile / 模型继承链（委托给 profileAlignment）
  // ------------------------------------------------------------------

  async readProfile(profileId: string): Promise<Profile | undefined> {
    return this.profileAlignment.readProfile(profileId)
  }

  async resolveEffectiveModel(override: string | undefined, profileId: string): Promise<string | undefined> {
    return this.profileAlignment.resolveEffectiveModel(override, profileId)
  }

  async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string, modelRef?: { provider: string; modelId: string }): Promise<string | undefined> {
    return this.profileAlignment.resolveEffectiveThinkingLevel(override, profileId, modelRef)
  }

  async alignConversationModel(id: number, emitEvent = false): Promise<void> {
    return this.profileAlignment.alignConversationModel(id, emitEvent)
  }

  async alignProfileConversations(profileId: string): Promise<void> {
    return this.profileAlignment.alignProfileConversations(profileId)
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  private async resolveProfileForCreate(init: ConversationInit): Promise<string> {
    const requested = init.profileId ?? 'assistant'
    const found = await this.readProfile(requested)
    if (!found) {
      throw new HelmError('validation_error', `profile 不存在：${requested}（先创建 profiles/${requested}）`, 400)
    }
    return requested
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    const profileId = await this.resolveProfileForCreate(init)
    const profile = await this.readProfile(profileId)
    if (init.model !== undefined && init.model !== '') {
      const ref = this.o.parseModelRefOrThrow(init.model)
      this.o.assertModelEnabled(ref.provider, ref.modelId)
    }
    const effectiveModel = await this.resolveEffectiveModel(init.model, profileId)
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    const parentMeta =
      init.parentConversationId !== undefined ? this.store.getConv(init.parentConversationId) : undefined
    const nodeId =
      init.nodeId ?? profile?.nodeId ?? parentMeta?.nodeId ?? 'local'

    const inheritedCwd = init.cwd ?? profile?.cwd ?? parentMeta?.cwd
    /** cwd 按目标节点平台统一收口（词法规范化；零磁盘访问；坏 POSIX cwd 不落库）。 */
    const platformSource = this.o.trustedPlatformOf ?? trustedPlatformFromEnvFabric(undefined)
    const normalizeCwd = (raw: string): string =>
      normalizeSessionCwd(raw, { nodeId, trustedPlatform: platformSource, entry: 'conversation.create' })
    let effectiveCwd: string
    if (inheritedCwd !== undefined) {
      effectiveCwd = normalizeCwd(inheritedCwd)
    } else if (nodeId === 'local') {
      effectiveCwd = normalizeCwd(this.o.toolDeps.defaultCwd)
    } else {
      throw new HelmError(
        'validation_error',
        `会话绑定远端节点 ${nodeId} 但未提供 cwd（Profile.cwd / 父会话 cwd / init.cwd 均缺失；拒绝盲跑节点默认目录）`,
        400,
        { nodeId },
      )
    }
    const effectiveThinking = await this.resolveEffectiveThinkingLevel(undefined, profileId, effectiveRef)
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          cwd: effectiveCwd,
          ...(effectiveRef ? { model: { provider: effectiveRef.provider, modelId: effectiveRef.modelId } } : {}),
          ...(effectiveThinking ? { thinkingLevel: effectiveThinking as ModelThinkingLevel } : {}),
        },
      },
      BACKGROUND_CONTEXT,
    )
    const id = conv.id as number
    const now = Date.now()
    this.store.upsertConv({
      id,
      title: init.title ?? '',
      profileId,
      tags: init.tags ?? [],
      parentConversationId: init.parentConversationId,
      nodeId,
      cwd: effectiveCwd,
      model: effectiveModel ?? '',
      thinkingLevel: effectiveThinking ?? '',
      ...(init.model !== undefined && init.model !== '' ? { modelOverride: init.model } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.tracker.observe(id)
    const summary = this.summaryWithOwnership(id)
    this.events.publish('conversation.upsert', summary)
    return summary
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    return this.profileAlignment.withConversationChange(id, () => this.updateConversationConfiguration(id, patch))
  }

  private async updateConversationConfiguration(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    const meta = requireConv(this.store, id)
    if (patch.profileId !== undefined) {
      const found = await this.readProfile(patch.profileId)
      if (!found) {
        throw new HelmError('validation_error', `profile 不存在：${patch.profileId}`, 400)
      }
    }
    let nextOverride: string | undefined
    if (patch.model === undefined) {
      nextOverride = meta.modelOverride
    } else if (patch.model !== '') {
      const ref = this.o.parseModelRefOrThrow(patch.model)
      this.o.assertModelEnabled(ref.provider, ref.modelId)
      nextOverride = patch.model
    }
    let nextThinkingOverride: string | undefined
    if (patch.thinkingLevel === undefined) {
      nextThinkingOverride = meta.thinkingLevelOverride
    } else {
      const level = patch.thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `thinkingLevel '${level}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinkingOverride = level || undefined
    }
    const nextProfileId = patch.profileId ?? meta.profileId
    const effectiveModel = await this.resolveEffectiveModel(nextOverride, nextProfileId)
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    // 模型/Profile 变化后：显式思考覆盖同样按目标模型能力收敛到 SDK
    // 可用档位（单一收口 clampThinkingLevelForModel；能力未知时透传不破坏契约）。
    const clampedOverride = effectiveRef
      ? clampThinkingLevelForModel(this.o.models(), effectiveRef, nextThinkingOverride)
      : nextThinkingOverride
    const nextThinking = await this.resolveEffectiveThinkingLevel(clampedOverride, nextProfileId, effectiveRef)
    // 显式 cwd，或 nodeId 迁移时的既有 cwd，均按新目标节点平台统一收口，
    // 再进入 SDK configure 与镜像持久化；坏 POSIX cwd 显式拒绝。
    const nextNodeId = patch.nodeId ?? meta.nodeId
    const cwdToNormalize =
      patch.cwd !== undefined ? patch.cwd : patch.nodeId !== undefined ? meta.cwd : undefined
    const effectivePatchCwd =
      cwdToNormalize === undefined
        ? undefined
        : normalizeSessionCwd(cwdToNormalize, {
            nodeId: nextNodeId,
            trustedPlatform: this.o.trustedPlatformOf ?? trustedPlatformFromEnvFabric(undefined),
            entry: 'conversation.update',
          })
    const configureChange: AgentChange = {
      ...(effectivePatchCwd !== undefined ? { cwd: effectivePatchCwd } : {}),
      model: effectiveRef ?? null,
      thinkingLevel: (nextThinking as ModelThinkingLevel | undefined) ?? null,
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.configure(configureChange, BACKGROUND_CONTEXT)
    const latest = requireConv(this.store, id)
    const updated: typeof meta = {
      ...latest,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.profileId !== undefined ? { profileId: patch.profileId } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
      ...(effectivePatchCwd !== undefined ? { cwd: effectivePatchCwd } : {}),
      model: effectiveModel ?? '',
      thinkingLevel: nextThinking ?? '',
      thinkingLevelOverride: clampedOverride,
      ...(nextOverride !== undefined ? { modelOverride: nextOverride } : { modelOverride: undefined }),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
      stateChangeSeq: latest.stateChangeSeq + 1,
      updatedAt: Date.now(),
    }
    this.store.upsertConv(updated)
    if (patch.nodeId !== undefined || patch.cwd !== undefined) {
      this.o.evictConversationBase(id)
    }
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  async deleteConversation(id: number): Promise<void> {
    requireConv(this.store, id)
    const owners = [...(this.o.managedConversations.get(id) ?? [])]
    if (owners.length > 0) {
      throw new HelmError(
        'conversation_managed_by_plugin',
        `会话 ${id} 正被插件管理（${owners.join(', ')}），先释放管理权再删除`,
        409,
        { conversationId: id, owners },
      )
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    // 级联取消等待真实落盘；IO 失败必须向上 reject（阻止后续删除副作用），
    // 绝不吞错很成功。
    await this.o.cancelAsksByConversation(id)
    await this.artifactsSvc.deleteConversation(id)
    this.events.publish('notification', {
      level: 'info',
      title: '会话已删除',
      body: `会话 ${id} 及其产物/待答 AskDoc 已清理`,
      conversationId: id,
    })
    this.tracker.stopObserving(id)
    this.store.deleteConv(id)
    this.o.evictHandledToolCalls(id)
    this.o.evictConversationBase(id)
    this.o.markOwnership(id, 'human')
    this.events.publish('conversation.deleted', { conversationId: id })
  }

  // ------------------------------------------------------------------
  // 产物授权与附件（委托给 attachments）
  // ------------------------------------------------------------------

  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    return this.attachments.isArtifactAuthorized(conversationId, artifactConversationId)
  }

  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>> {
    return this.attachments.resolveAuthorizedAttachments(conversationId, attachmentIds)
  }

  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    return this.attachments.resolveAuthorizedAttachment(conversationId, artifactId)
  }

  buildAttachmentBlock(resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>): string {
    return this.attachments.buildAttachmentBlock(resolved)
  }

  async buildAttachmentContent(
    effectiveText: string,
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): Promise<string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>> {
    return this.attachments.buildAttachmentContent(effectiveText, resolved)
  }

  // ------------------------------------------------------------------
  // submitInput
  // ------------------------------------------------------------------

  async submitInput(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
  ): Promise<{ submissionId: string }> {
    this.contextOps.assertOpen()
    const convMeta = requireConv(this.store, id)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    if (opts?.requestId !== undefined) {
      if (typeof opts.requestId !== 'string' || opts.requestId.trim() === '') {
        throw new HelmError('validation_error', '内部 requestId 必须为非空字符串', 400)
      }
      const previous = await this.harness.commit(
        (tx) => tx.submissionByRequest(id as never, opts.requestId!),
        BACKGROUND_CONTEXT,
      )
      if (previous !== undefined) return { submissionId: String(previous.id) }
    }

    const effectiveModelRef = await this.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmError(
        'model_not_configured',
        `会话 ${id}（profile ${convMeta.profileId}）与全局均未配置模型：请在 Profile、HELM_MODEL、config.json.model 或会话中配置 model`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    // 生效模型被禁用（如默认模型事后被禁用）：提交入口拒绝，绝不静默回退其它模型。
    {
      const effectiveRef = this.o.parseModelRefOrThrow(effectiveModelRef)
      this.o.assertModelEnabled(effectiveRef.provider, effectiveRef.modelId)
    }

    const replaceFromEntryId = await this.rewind.validateReplaceTarget(conversation, id, opts?.replaceFromEntryId)
    const initialAttachments =
      opts?.attachments !== undefined && opts.attachments.length > 0
        ? await this.resolveAuthorizedAttachments(id, opts.attachments)
        : undefined
    const prepared = await this.inputPipeline.prepareInput(id, text, opts, initialAttachments)
    // guarded 提交：钩子执行后、任何持久副作用（handled 接管返回/标题派生/
    // 提交）之前复核；最终原子复核在提交点（submitFreshInput）执行。
    if (opts?.mutationGuard !== undefined) {
      this.assertMutationGuard(id, opts.mutationGuard)
    }
    if (prepared.kind === 'handled') return { submissionId: prepared.submissionId }

    this.contextOps.assertOpen()
    this.inputPipeline.applyFirstInputTitle(convMeta, prepared.effectiveText)

    const content =
      prepared.resolvedAttachments !== undefined
        ? await this.buildAttachmentContent(prepared.effectiveText, prepared.resolvedAttachments)
        : prepared.effectiveText

    if (replaceFromEntryId !== undefined) {
      const finalInput = { ...prepared.finalInput, whenBusy: 'reject' as const }
      const targetId = replaceFromEntryId
      return this.rewind.withHistoryEdit(id, async () => {
        await this.rewind.assertTargetStillCurrent(conversation, id, targetId)
        return this.rewind.rewriteConversationFrom(id, conversation, targetId, {
          finalInput,
          effectiveText: prepared.effectiveText,
          resolvedAttachments: prepared.resolvedAttachments,
          content,
        })
      })
    }
    const freshSubmission = {
      finalInput: prepared.finalInput,
      finalWhenBusy: prepared.finalWhenBusy,
      effectiveText: prepared.effectiveText,
      resolvedAttachments: prepared.resolvedAttachments,
      content,
      requestId: opts?.requestId,
      ...(opts?.whenIdle !== undefined ? { whenIdle: opts.whenIdle } : {}),
      ...(opts?.mutationGuard !== undefined ? { mutationGuard: opts.mutationGuard } : {}),
    }
    if (opts?.mutationGuard !== undefined) {
      // guarded 提交串行门：只覆盖「提交点复核 + SDK submit 调用」临界区，
      // input 钩子在门外执行（钩子内再入 guarded 变更不会死锁）。
      return this.withMutationGate(id, () => this.inputPipeline.submitFreshInput(conversation, id, freshSubmission))
    }
    return this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
  }

  // ------------------------------------------------------------------
  // 原地覆盖重发委托（直接调用/测试兼容）
  // ------------------------------------------------------------------

  async withHistoryEdit<T>(id: number, operation: () => Promise<T>): Promise<T> {
    return this.rewind.withHistoryEdit(id, operation)
  }

  async rewriteConversationFrom(
    id: number,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    replaceFromEntryId: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: string }> {
    return this.rewind.rewriteConversationFrom(id, conversation, replaceFromEntryId, newInput)
  }

  // ------------------------------------------------------------------
  // waitForInput / withdraw / abort
  // ------------------------------------------------------------------

  async waitForInput(id: number, submissionId: string): Promise<ConversationInputResult> {
    if (submissionId.startsWith('handled:')) {
      throw new HelmError(
        'wait_not_applicable',
        `提交 ${submissionId} 被 input 钩子接管，无真实回合可等待`,
        409,
        { conversationId: id, submissionId },
      )
    }
    const numericId = Number(submissionId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new HelmError('validation_error', `非法 submissionId：${submissionId}`, 400)
    }
    requireConv(this.store, id)
    const submission = await this.harness.submission(numericId as never, BACKGROUND_CONTEXT)
    if (!submission) {
      throw new HelmError('not_found', `提交不存在：${submissionId}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const status = (await submission.status(BACKGROUND_CONTEXT)) as unknown as {
      conversationId?: unknown
      id?: unknown
      type?: string
    }
    if (
      String(status.conversationId) !== String(id) ||
      String(status.id) !== submissionId ||
      status.type !== 'input'
    ) {
      throw new HelmError('not_found', `提交 ${submissionId} 不属于会话 ${id}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const settled = (await submission.wait(BACKGROUND_CONTEXT)) as unknown as {
      status: 'queued' | 'placed' | 'done' | 'unanswered'
      answer?: number
      reason?: string
      detail?: unknown
    }
    if (settled.status === 'unanswered') {
      const reason = settled.reason ?? 'unknown'
      const aborted = reason === 'aborted' || reason === 'interrupted' || reason === 'reset'
      throw new HelmError(
        aborted ? 'turn_aborted' : 'turn_failed',
        `会话 ${id} 本轮未获回答（${reason}${settled.detail !== undefined ? `：${String(settled.detail)}` : ''}）`,
        aborted ? 499 : 502,
        {
          conversationId: id,
          submissionId,
          reason,
          detail: settled.detail,
        },
      )
    }
    if (settled.status !== 'done' || settled.answer === undefined) {
      throw new HelmError('turn_failed', `提交 ${submissionId} 结算为非终态 ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const page = await conversation.entries(
      { minEntryId: settled.answer as never, maxEntryId: settled.answer as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    const raw = page.items[0] as
      | { id: number; kind: string; data?: unknown; model?: unknown[] }
      | undefined
    if (raw === undefined || raw.id !== settled.answer) {
      throw new HelmError('not_found', `回答条目缺失：${settled.answer}`, 502, {
        conversationId: id,
        submissionId,
      })
    }
    const entry = toConversationEntry(raw)
    const text = this.stash.redact(assistantTextOfModel(entry.model))
    return { conversationId: id, submissionId, text, entry }
  }

  async withdrawQueuedInput(id: number, opts: { submissionId: number }): Promise<ConversationWithdrawResponse> {
    if (this.o.isClosed()) throw new HelmError('runtime_closed', '内核正在关闭，拒绝撤回', 503)
    requireConv(this.store, id)
    const raw = opts.submissionId
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError('validation_error', `submissionId 需为安全正整数（收到 ${String(raw)}）`, 400, {
        conversationId: id,
        submissionId: raw,
      })
    }
    const sub = await this.harness.submission(raw as never, BACKGROUND_CONTEXT)
    const rec = sub ? ((await sub.status(BACKGROUND_CONTEXT)) as { conversationId?: unknown; type?: string; entry?: number; requestId?: string }) : undefined
    if (
      rec === undefined ||
      String(rec.conversationId) !== String(id) ||
      rec.type !== 'input'
    ) {
      throw new HelmError('not_found', `提交 ${raw} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    const outcome = await this.harness.abortSubmission(raw as never, BACKGROUND_CONTEXT, id as never)
    if (outcome === 'not_found') {
      throw new HelmError('not_found', `提交 ${raw} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    if (outcome === 'aborted') {
      this.tracker.dropSubmission(id, raw, rec.requestId)
      return { status: 'withdrawn' }
    }
    const latest = await sub!.status(BACKGROUND_CONTEXT)
    return {
      status: outcome,
      ...('entry' in latest && typeof latest.entry === 'number' ? { entryId: latest.entry } : {}),
    }
  }

  async abortConversation(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const wasBusy = this.tracker.hasLiveWork(id)
    await conversation.abort(BACKGROUND_CONTEXT)
    if (wasBusy) this.tracker.settleAborted(id)
    this.o.evictHandledToolCalls(id)
  }

  // ------------------------------------------------------------------
  // reset / compact / fork（委托给 contextOps）
  // ------------------------------------------------------------------

  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    return this.contextOps.resetConversation(id, opts)
  }

  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    return this.contextOps.compactConversation(id, opts)
  }

  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    return this.contextOps.forkConversation(id, opts)
  }

  // ------------------------------------------------------------------
  // waitForIdle / getLastAssistantText / search / recover
  // ------------------------------------------------------------------

  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    await this.tracker.waitTurnSettled(id)
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.tracker.getLastAssistantText(id) ?? ''
  }

  async search(query: string): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    return this.store.search(query)
  }

  async recover(onMissingMirror: (id: number, parentConversationId: number | undefined) => Promise<void>): Promise<void> {
    let cursor: unknown = undefined
    for (;;) {
      const page = await this.storage.scanConversations(
        {} as never,
        500,
        cursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const record of page.items) {
        const id = record.id as number
        if (this.store.isDeleted(id)) continue
        if (!this.store.getConv(id)) {
          const parent = (record as { parent?: { conversationId?: number } }).parent?.conversationId
          await onMissingMirror(id, parent)
        }
        await this.alignConversationModel(id)
        await this.tracker.observe(id)
      }
      if (!page.next) break
      cursor = page.next
    }
  }
}
