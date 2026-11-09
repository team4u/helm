/**
 * 会话服务：CRUD / 详情分页 / 输入提交（submitInput）/ 原地覆盖重发
 * （rewrite）/ fork / reset / compact / 模型继承链对齐 / 附件内容拼装。
 *
 * 从 runtime.ts 拆出（上帝类最大职责簇）。对外行为与原 KernelRuntime 方法
 * 逐一致；KernelRuntime 退回组合根后按方法委托到本服务。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { InboxDoc, LiveDoc, type Harness, type AgentChange } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationDetail,
  ConversationEntry,
  ConversationInit,
  ConversationInput,
  ConversationInputResult,
  ConversationPatch,
  ConversationSummary,
  ConversationWithdrawResponse,
  InputOrigin,
  WhenBusy,
} from '@helm/protocol'
import { HelmError, ROOT_CONVERSATION_ID as PROTO_ROOT } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FileNotFoundError } from '../services/index.js'
import type { ArtifactService as SvcArtifactService, ProfileService, SecretStash } from '../services/index.js'
import type { Profile } from '../services/index.js'
import { deriveTitle, type ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { requireModelRef } from './models.js'
import { assertEditableHumanInput, assistantTextOfModel, coveredByRewind, entryModelText, normalizeBusyError, PROTO_ROOT as _P, requireConv, rewindIntervalOf, RewindInterval, safeResultText } from './runtime-helpers.js'
import { toConversationEntry } from './entries.js'
import { THINKING_LEVELS } from './spawn.js'
import type { HelmStore } from './store.js'
import { redactJsonValue } from '../redact.js'

void _P

/** 图片类 mime：附件拼装多模态 ImageContent 的判定集。 */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** cursor 最大编码长度（base64url 后；超长拒绝防滥用）。 */
const DETAIL_CURSOR_MAX_LENGTH = 2048

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
  /** 会话删除时的工作树回收（宿主注入 cleanupWorktree）。 */
  readonly cleanupWorktree: (request: { worktreeId: string }) => Promise<unknown>
  readonly worktrees: { getForConversation(id: number): { id: string; path: string; status: string } | undefined }
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
  /** 关闭守卫（isClosing）。 */
  readonly isClosed: () => boolean
  /** turn_settled 后等待（waitForIdle 组合用）。 */
  /** 模型解析链（默认模型）。 */
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
}

/** 提交输入的可选参数（HTTP/CLI/内部同构）。 */
export interface SubmitInputOptions {
  origin?: InputOrigin
  whenBusy?: WhenBusy
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  /** 内部完成回报的持久幂等键；HTTP 输入不开放此字段。 */
  requestId?: string
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
  /** 同一会话的配置变更串行提交，避免继承刷新与显式覆盖互相覆盖。 */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()
  private readonly historyEditsInFlight = new Set<number>()

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
  }

  // ------------------------------------------------------------------
  // 摘要与归属投射
  // ------------------------------------------------------------------

  /** 摘要 + 实时归属投射：tracker 摘要不读 ownership doc，此处统一附加（缺省 human）。 */
  summaryWithOwnership(id: number): ConversationSummary {
    return { ...this.tracker.summaryOf(id), ownedBy: this.o.ownershipOf(id) }
  }

  /** 已构造摘要沿用权威归属；删除后的 tracker 回调在发布前丢弃。 */
  withOwnership(summary: ConversationSummary): ConversationSummary {
    return { ...summary, ownedBy: this.o.ownershipOf(summary.id) }
  }

  listConversations(filter?: { profileId?: string; tag?: string; status?: string }): ConversationSummary[] {
    return this.store
      .listConvs()
      .map((meta) => this.summaryWithOwnership(meta.id))
      .filter((s) => (filter?.profileId ? s.profileId === filter.profileId : true))
      .filter((s) => (filter?.tag ? s.tags.includes(filter.tag) : true))
      .filter((s) => (filter?.status ? s.status === filter.status : true))
  }

  getConversation(id: number): ConversationSummary {
    requireConv(this.store, id)
    return this.summaryWithOwnership(id)
  }

  // ------------------------------------------------------------------
  // 详情分页
  // ------------------------------------------------------------------

  /**
   * 会话详情（摘要 + 分页时间线）：
   * - 服务端统一过滤被 helm.rewind 覆盖的旧条目（闭区间 [fromEntryId,
   *   throughEntryId]），但保留 helm.rewind 元数据条目本身（前端 SSE 与
   *   分页过滤共用同一区间公式）；
   * - 每次详情读时扫描汇总全部 rewind 区间（简单实现，不加新持久表/缓存），
   *   再从 SDK raw cursor 分页读取，过滤覆盖条目直到满足 limit 或无更多；
   * - cursor 是 base64url(JSON{conversationId,cursor:SDK next})：绑定会话、
   *   长度/JSON 合法性校验、limit 钳制 1..500；不静默截断；
   * - entry 保留 model 消息与 data，出界前经事件同源脱敏（发布路径统一）。
   */
  async getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const summary = this.getConversation(id)
    const limit = options?.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HelmError('validation_error', `limit 必须是 1..500 的整数（收到 ${limit}）`, 400, {
        limit,
      })
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    const rewindCuts = await this.collectRewindIntervals(conversation)
    const { collected, nextCursor } = await this.pageVisibleEntries(conversation, id, limit, sdkCursor, rewindCuts)

    const entries = collected
      .reverse()
      .map((raw) => toConversationEntry(raw as { id: number; kind: string }))
    return {
      ...summary,
      entries,
      ...(nextCursor !== undefined ? { nextCursor: this.encodeDetailCursor(id, nextCursor as Readonly<Record<string, unknown>>) } : {}),
    }
  }

  /** SDK descending 分页读取 + rewind 过滤（详情主体循环；每页精确取 remaining）。 */
  private async pageVisibleEntries(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    limit: number,
    initialCursor: unknown,
    rewindCuts: RewindInterval[],
  ): Promise<{
    collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }>
    nextCursor: unknown
  }> {
    const collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }> = []
    let sdkCursor = initialCursor
    let nextCursor: unknown = undefined
    for (;;) {
      const remaining = limit - collected.length
      const page = await conversation.entries(
        { order: 'descending' },
        remaining,
        sdkCursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const raw of page.items as never as Array<{
        id: number
        kind: string
        model?: readonly unknown[]
        data?: unknown
      }>) {
        // rewind 标记自身保留（SSE 一致性与前端区间去重需要），其余落入
        // 覆盖区间的旧条目全部隐藏。
        const numericId = Number(raw.id)
        if (raw.kind !== 'helm.rewind' && coveredByRewind(numericId, rewindCuts)) continue
        collected.push(raw)
      }
      if (page.next === undefined) {
        nextCursor = undefined
        break
      }
      if (collected.length >= limit) {
        nextCursor = page.next
        break
      }
      sdkCursor = page.next
    }
    void id
    return { collected, nextCursor }
  }

  /** 扫描会话全量 raw entries，汇总全部 rewind 覆盖区间（详情投影用）。 */
  async collectRewindIntervals(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    const intervals: RewindInterval[] = []
    let cursor: unknown = undefined
    for (;;) {
      const page = await conversation.entries({ order: 'ascending' }, 100, cursor as never, BACKGROUND_CONTEXT)
      for (const raw of page.items as never as Array<{ id: number | string; kind: string; data?: unknown }>) {
        if (raw.kind !== 'helm.rewind') continue
        const interval = rewindIntervalOf(raw)
        if (interval !== undefined) intervals.push(interval)
      }
      if (page.next === undefined) break
      cursor = page.next
    }
    return intervals
  }

  /** 编码分页 cursor：base64url(JSON{conversationId,cursor})。 */
  private encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** 解码并校验分页 cursor：绑定会话、长度与 JSON 合法性（非法显式拒绝）。 */
  private decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmError('validation_error', 'cursor 超过最大长度', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmError('validation_error', 'cursor 不是合法的 base64url JSON', 400)
    }
    const shape = decoded as { conversationId?: unknown; cursor?: unknown }
    if (
      shape === null ||
      typeof shape !== 'object' ||
      Number(shape.conversationId) !== conversationId ||
      typeof shape.cursor !== 'object' ||
      shape.cursor === null
    ) {
      throw new HelmError(
        'validation_error',
        `cursor 不属于会话 ${conversationId} 或结构非法`,
        400,
      )
    }
    return shape.cursor
  }

  // ------------------------------------------------------------------
  // Profile / 模型继承链
  // ------------------------------------------------------------------

  /** Profile 读取失败与不存在分开报告，避免损坏文件被当成缺少模型配置。 */
  async readProfile(profileId: string): Promise<Profile | undefined> {
    const { assertProfileId } = await import('../services/index.js')
    try {
      assertProfileId(profileId)
    } catch (error) {
      throw new HelmError('validation_error', error instanceof Error ? error.message : String(error), 400)
    }
    try {
      return await this.profilesSvc.get(profileId)
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
    return override || profile.model || this.o.defaultModel()
  }

  /** 思考档位覆盖 > Profile.thinkingLevel > 全局默认。 */
  async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (!profile) throw new HelmError('profile_not_found', `会话引用的 Profile 不存在：${profileId}`, 404, { profileId })
    return override || profile.thinkingLevel || this.o.defaultThinkingLevel()
  }

  private async withConversationChange<T>(id: number, change: () => Promise<T>): Promise<T> {
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
      const meta = this.store.getConv(id)
      if (!meta) return
      const effective = await this.resolveEffectiveModel(meta.modelOverride, meta.profileId)
      const thinking = await this.resolveEffectiveThinkingLevel(meta.thinkingLevelOverride, meta.profileId)
      const ref = effective ? this.o.parseModelRefOrThrow(effective) : undefined
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
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
      if (!sdkChanged && meta.model === (effective ?? '') && meta.thinkingLevel === (thinking ?? '')) return
      const latest = this.store.getConv(id)
      if (!latest) return
      this.store.upsertConv({
        ...latest,
        model: effective ?? '',
        thinkingLevel: thinking ?? '',
        stateChangeSeq: latest.stateChangeSeq + 1,
        updatedAt: Date.now(),
      })
      if (emitEvent) this.events.publish('conversation.upsert', this.summaryWithOwnership(id))
    })
  }

  /** Profile 保存后的即时继承刷新（覆盖值由各自的解析链保护）。 */
  async alignProfileConversations(profileId: string): Promise<void> {
    for (const meta of this.store.listConvs()) {
      if (meta.profileId === profileId) await this.alignConversationModel(meta.id, true)
    }
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  /** 仅省略 profileId 时选择 assistant；显式 ID 必须对应真实 Profile。 */
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
    // init.model 是显式覆盖（非全局继承）：仅在提供时校验并落 override。
    if (init.model !== undefined && init.model !== '') this.o.parseModelRefOrThrow(init.model)
    const effectiveModel = await this.resolveEffectiveModel(init.model, profileId)
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    // nodeId 解析链：init.nodeId > profile.nodeId > parent.nodeId > 'local'。
    const parentMeta =
      init.parentConversationId !== undefined ? this.store.getConv(init.parentConversationId) : undefined
    const nodeId =
      init.nodeId ?? profile?.nodeId ?? parentMeta?.nodeId ?? 'local'
    // cwd 解析链（只算一次，SDK agent.cwd 与 store 镜像同一个值）：
    // init.cwd > profile.cwd > parent.cwd > local 用 Hub 缺省 cwd；
    // 远端节点两者皆无时显式拒绝（节点守护进程目录非用户意图靶点，拒绝盲跑）。
    // 注：不对继承 cwd 做 Hub realpath/resolve 污染——目标节点可能与 Hub
    // 异平台（如 Windows C:\workspace），保持原样交给目标节点语义。
    const inheritedCwd = init.cwd ?? profile?.cwd ?? parentMeta?.cwd
    let effectiveCwd: string
    if (inheritedCwd !== undefined) {
      effectiveCwd = inheritedCwd
    } else if (nodeId === 'local') {
      effectiveCwd = this.o.toolDeps.defaultCwd
    } else {
      throw new HelmError(
        'validation_error',
        `会话绑定远端节点 ${nodeId} 但未提供 cwd（Profile.cwd / 父会话 cwd / init.cwd 均缺失；拒绝盲跑节点默认目录）`,
        400,
        { nodeId },
      )
    }
    const effectiveThinking = await this.resolveEffectiveThinkingLevel(undefined, profileId)
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
    return this.withConversationChange(id, () => this.updateConversationConfiguration(id, patch))
  }

  private async updateConversationConfiguration(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    const meta = requireConv(this.store, id)
    if (patch.profileId !== undefined) {
      const found = await this.readProfile(patch.profileId)
      if (!found) {
        throw new HelmError('validation_error', `profile 不存在：${patch.profileId}`, 400)
      }
    }
    // model 语义：'' = 清除显式覆盖（重算继承链）；非空 = 显式覆盖（校验格式）。
    let nextOverride: string | undefined
    if (patch.model === undefined) {
      nextOverride = meta.modelOverride
    } else if (patch.model !== '') {
      this.o.parseModelRefOrThrow(patch.model)
      nextOverride = patch.model
    }
    // thinkingLevel：'' = 清除（跟随缺省）；非空必须在枚举内（拒绝任意字符串）。
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
    // 换 profile 且无 override 时重算生效模型（跨 profile 隔离不残留旧模型）。
    const effectiveModel = await this.resolveEffectiveModel(nextOverride, nextProfileId)
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    const nextThinking = await this.resolveEffectiveThinkingLevel(nextThinkingOverride, nextProfileId)
    // SDK null 删除字段；undefined 保持原值。先提交 SDK，再发布生效镜像。
    const configureChange: AgentChange = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
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
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      model: effectiveModel ?? '',
      thinkingLevel: nextThinking ?? '',
      thinkingLevelOverride: nextThinkingOverride,
      ...(nextOverride !== undefined ? { modelOverride: nextOverride } : { modelOverride: undefined }),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      // unread 仅人类显式 PATCH 清零；API 读取不清零。
      ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
      stateChangeSeq: latest.stateChangeSeq + 1,
      updatedAt: Date.now(),
    }
    this.store.upsertConv(updated)
    // 靶点（nodeId/cwd）变更即释放旧靶点底座缓存：旧实例上的在途 exec/reader
    // 不受影响（evict 只移缓存不杀进程），后续 exec 落在新靶点新实例。
    if (patch.nodeId !== undefined || patch.cwd !== undefined) {
      this.o.evictConversationBase(id)
    }
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /**
   * 删除会话：root 保护；abort 在途 -> 取消 asks -> 清 artifacts（物理文件）->
   * FTS 行 -> Helm 索引移除 + tombstone。
   * 注：SDK 无 deleteConversation 写 API，pi_* 内部历史由 SDK 保留，
   * helm 侧重启后凭 tombstone 不再重新导入（逻辑删除）。
   */
  async deleteConversation(id: number): Promise<void> {
    if (id === PROTO_ROOT) {
      throw new HelmError('root_conversation_protected', '根会话 #1 不可删除', 403)
    }
    requireConv(this.store, id)
    // 插件管理权保护：任何活跃 owner 持有时拒绝（在一切清理副作用之前）。
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
    const worktree = this.o.worktrees.getForConversation(id)
    if (worktree?.status === 'active') {
      try {
        await this.o.cleanupWorktree({ worktreeId: worktree.id })
      } catch (error) {
        this.events.publish('notification', {
          level: 'warning', title: '工作树已保留',
          body: this.stash.redact(`会话 ${id} 删除时未回收工作树 ${worktree.path}：${error instanceof Error ? error.message : String(error)}。检视后可调用 cleanup_worktree({ worktreeId: ${JSON.stringify(worktree.id)} })。`),
        })
      }
    }
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
    // 删除兑底：清理该会话的 handled 接管残留与 EnvFabric 会话靶点缓存
    //（bases 中该 conversationId 的 env 与其输出 sink 注册）。
    this.o.evictHandledToolCalls(id)
    this.o.evictConversationBase(id)
    // 清除归属登记，防止重建同号会话时继承已删除会话的自动化权限。
    this.o.markOwnership(id, 'human')
    this.events.publish('conversation.deleted', { conversationId: id })
  }

  // ------------------------------------------------------------------
  // 产物授权与附件
  // ------------------------------------------------------------------

  /** 产物授权：当前会话或其父链（子会话可读父会话产物）；最多 32 层防环。 */
  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    if (conversationId === artifactConversationId) return true
    let current: number | undefined = conversationId
    const seen = new Set<number>()
    for (let depth = 0; depth < 32 && current !== undefined && !seen.has(current); depth += 1) {
      seen.add(current)
      if (current === artifactConversationId) return true
      current = this.store.getConv(current)?.parentConversationId
    }
    return false
  }

  /**
   * 解析并授权校验附件产物 ID 列表：
   * - 产物必须存在（FileNotFoundError -> 404 not_found，附 artifactId）；
   * - 产物会话必须是当前会话或其父链（越权挂载 403 artifact_forbidden）；
   * - 返回轻量指针（ref）+ 完整元数据 + 绝对路径（供提示词与多模态拼装）。
   */
  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<
    Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>
  > {
    const unique = [...new Set(attachmentIds)]
    const out: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> = []
    for (const artifactId of unique) {
      const metadata = await this.artifactsSvc.get(artifactId).catch((error: unknown) => {
        if (error instanceof FileNotFoundError) {
          throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmError(
          'artifact_forbidden',
          `产物 ${artifactId} 不属于会话 ${conversationId} 或其父会话链，拒绝越权挂载`,
          403,
          { conversationId, artifactId, artifactConversationId: metadata.conversationId },
        )
      }
      out.push({
        ref: { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size },
        metadata,
        absPath: join(this.dataDir, metadata.path),
      })
    }
    return out
  }

  /** 单附件授权解析（app 组合层/herdr 插件依赖注入用；错误语义同上）。 */
  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    const [resolved] = await this.resolveAuthorizedAttachments(conversationId, [artifactId])
    if (resolved === undefined) {
      throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
    }
    return { ...resolved.ref, absPath: resolved.absPath }
  }

  /** [Attached Files] 纯文本清单块（spawn 任务提示词用；无正文前缀）。 */
  buildAttachmentBlock(
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): string {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    return `[Attached Files]\n${lines.join('\n')}`
  }

  /**
   * 构造带附件的模型可见内容：
   * - [Attached Files] 清单（含拉取指引）拼在正文后；
   * - 存在图片附件时返回多模态块数组（文本块 + 图片 ImageContent base64）；
   * - 无图片附件时返回拼接后的纯文本。
   */
  async buildAttachmentContent(
    effectiveText: string,
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): Promise<
    string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  > {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    const attachedBlock = `[Attached Files]\n${lines.join('\n')}`
    const modelText = effectiveText.length > 0 ? `${effectiveText}\n\n${attachedBlock}` : attachedBlock
    const hasImage = resolved.some(({ ref }) => IMAGE_MIMES.has(ref.mimeType))
    if (!hasImage) return modelText
    const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: modelText },
    ]
    for (const item of resolved) {
      if (!IMAGE_MIMES.has(item.ref.mimeType)) continue
      const bytes = await this.artifactsSvc.readBuffer(item.ref.id)
      contentParts.push({
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: item.ref.mimeType,
      })
    }
    return contentParts
  }

  // ------------------------------------------------------------------
  // submitInput
  // ------------------------------------------------------------------

  /**
   * 提交输入：input hook（transform 生效——text/origin/whenBusy/id 全部取最终
   * payload；conversationId 被 transform 视为身份违规拒绝）-> SDK submit。
   * whenBusy 省略时在钩子链之后应用有效默认 steer（插话引导）。
   *
   * replaceFromEntryId：从指定历史条目起原地覆盖重发——先做边界校验（存在/
   * 活跃上下文内/未被覆盖），abort 在途回合后写入 helm.rewind 截断标记
   *（EntryDraft.edits omit 被覆盖条目，保留 baseline pi.system），清理 FTS
   * 派生索引，再提交新输入（此时会话已 idle，followUp 安全）。绝不直接
   * DELETE pi_entries：截断全部经 pi-durable 原生 edits 语义。
   */
  async submitInput(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
  ): Promise<{ submissionId: string }> {
    this.assertOpen()
    const convMeta = requireConv(this.store, id)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    // 跨重启幂等提交（requestId）：同一 requestId 重复提交直接返回既有
    // submission（崩溃后补发场景不产生第二条输入）。查询先于 input hook——
    // 已成功落库的提交不再重复执行钩子副作用。
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
    // 模型解析链统一入口：全部缺失时只在提交时显式拒绝（其他读路径不报错）。
    const effectiveModelRef = await this.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmError(
        'model_not_configured',
        `会话 ${id}（profile ${convMeta.profileId}）与全局均未配置模型：请在 Profile、HELM_MODEL、config.json.model 或会话中配置 model`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    // 原地覆盖前置边界校验（先于 abort 与 input hook：非法参数不得误杀在途回合）。
    const replaceFromEntryId = await this.validateReplaceTarget(conversation, id, opts?.replaceFromEntryId)
    // 初始附件：提交时先解析存在性与父链授权（越权 403 / 不存在 404）。
    const initialAttachments =
      opts?.attachments !== undefined && opts.attachments.length > 0
        ? await this.resolveAuthorizedAttachments(id, opts.attachments)
        : undefined
    const prepared = await this.applyInputHook(id, text, opts, initialAttachments)
    if (prepared.kind === 'handled') return { submissionId: prepared.submissionId }
    // input Hook 可能执行异步 IO；期间开始关停时不得继续写入或创建 SDK 回合。
    this.assertOpen()
    this.applyFirstInputTitle(convMeta, prepared.effectiveText)
    // 模型可见内容：无附件保持纯文本；有附件拼接 [Attached Files] 清单，
    // 图片附件额外构造多模态 ImageContent 块（字节 base64 进模型上下文）。
    const content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> =
      prepared.resolvedAttachments !== undefined
        ? await this.buildAttachmentContent(prepared.effectiveText, prepared.resolvedAttachments)
        : prepared.effectiveText

    // 原地覆盖重发：异步准备（abort 在途回合 + 挂起 Ask 销单）后，rewind 截断
    // 与新输入在同一个 SDK commit 内原子落库（成则俱成、败则俱败，绝无半完成
    // 的 rewind 或排队变体）。事务内核实空闲后以 whenBusy:'reject' 提交，
    // 任何并发进入显式 409 拒绝，绝不悄悄排队。
    if (replaceFromEntryId !== undefined) {
      const finalInput = { ...prepared.finalInput, whenBusy: 'reject' as const }
      const targetId = replaceFromEntryId
      return this.withHistoryEdit(id, async () => {
        // input 钩子可能挂起很久；陈旧编辑不得先中止另一编辑刚启动的新回合。
        await this.assertTargetStillCurrent(conversation, id, targetId)
        return this.rewriteConversationFrom(id, conversation, targetId, {
          finalInput,
          effectiveText: prepared.effectiveText,
          resolvedAttachments: prepared.resolvedAttachments,
          content,
        })
      })
    }
    return this.submitFreshInput(conversation, id, {
      finalInput: prepared.finalInput,
      finalWhenBusy: prepared.finalWhenBusy,
      effectiveText: prepared.effectiveText,
      resolvedAttachments: prepared.resolvedAttachments,
      content,
      requestId: opts?.requestId,
    })
  }

  /** 原地覆盖目标的提交前边界校验（存在 / 活跃上下文内 / 未被覆盖 / 人类输入）。 */
  private async validateReplaceTarget(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    raw: number | undefined,
  ): Promise<number | undefined> {
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError(
        'validation_error',
        `replaceFromEntryId 需为安全正整数（收到 ${String(raw)}）`,
        400,
        { conversationId: id, replaceFromEntryId: raw },
      )
    }
    // 条目存在性精确校验（min=max=entryId 取 1 条；不存在 404）。
    const page = await conversation.entries(
      { minEntryId: raw as never, maxEntryId: raw as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || Number((page.items[0] as { id: number }).id) !== raw) {
      throw new HelmError('not_found', `条目 ${raw} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: raw,
      })
    }
    // 编辑目标限定人类输入：agent/trigger 注入、assistant/控制条目不可编辑。
    assertEditableHumanInput(page.items[0] as { kind: string; data?: unknown }, id, raw)
    const preCtx = await conversation.context(BACKGROUND_CONTEXT)
    if (!preCtx.entries.some((e) => Number(e.id) === raw)) {
      throw new HelmError(
        'entry_before_context_head',
        `条目 ${raw} 位于最近一次重置或压缩之前，无法原地覆盖，请使用分叉（fork）`,
        409,
        { conversationId: id, entryId: raw },
      )
    }
    const rewound = preCtx.entries.some((e) => {
      const interval = rewindIntervalOf(e as unknown as { id: number | string; kind: string; data?: unknown })
      return interval !== undefined && raw >= interval.from && raw <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `条目 ${raw} 已被此前的重发覆盖`, 409, {
        conversationId: id,
        entryId: raw,
      })
    }
    return raw
  }

  /**
   * input 钩子应用 + 最终输入固化（submitInput 拆出的阶段函数）。
   * 返回 handled（接管）或最终 { finalInput, finalWhenBusy, effectiveText,
   * resolvedAttachments }。
   */
  private async applyInputHook(
    id: number,
    text: string,
    opts: SubmitInputOptions | undefined,
    initialAttachments: Awaited<ReturnType<ConversationService['resolveAuthorizedAttachments']>> | undefined,
  ): Promise<
    | { kind: 'handled'; submissionId: string }
    | {
        kind: 'final'
        finalInput: ConversationInput
        finalWhenBusy: WhenBusy
        effectiveText: string
        resolvedAttachments: Awaited<ReturnType<ConversationService['resolveAuthorizedAttachments']>> | undefined
      }
  > {
    const origin: InputOrigin = opts?.origin ?? 'human'
    if (opts?.requestId !== undefined && (typeof opts.requestId !== 'string' || opts.requestId.trim() === '')) {
      throw new HelmError('validation_error', '内部 requestId 必须为非空字符串', 400)
    }
    const inputId = opts?.requestId ?? randomUUID()
    const createdAt = Date.now()
    // 边界脱敏：meta 值经 stash redact 后入库（受管 Token 等绝不经 meta 透传）。
    // text 原样交给 input 钩子（hook 可感知/改写原始输入），最终消费前统一脱敏。
    const safeMeta =
      opts?.meta !== undefined
        ? (redactJsonValue(opts.meta, (t) => this.stash.redact(t)) as Record<string, unknown>)
        : undefined
    const payload: { conversationId: number; input: ConversationInput } = {
      conversationId: id,
      input: {
        id: inputId,
        text,
        origin,
        whenBusy: opts?.whenBusy,
        createdAt,
        ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
        ...(initialAttachments !== undefined
          ? { attachments: initialAttachments.map((r) => r.ref) }
          : {}),
      },
    }
    const hookOutcome = await this.o.runInputHook(payload)
    if (hookOutcome?.action === 'block') {
      throw new HelmError('input_blocked', hookOutcome.reason ?? '输入被 input 钩子拦截')
    }
    if (hookOutcome?.action === 'handled') {
      return { kind: 'handled', submissionId: `handled:${randomUUID()}` }
    }
    let finalInput: ConversationInput = payload.input
    let finalWhenBusy: WhenBusy | undefined = opts?.whenBusy
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as typeof payload
      if (value.conversationId !== id) {
        throw new HelmError(
          'input_identity_changed',
          `input 钩子不得改写 conversationId（${id} -> ${String(value.conversationId)}）`,
          400,
        )
      }
      finalInput = value.input
      finalWhenBusy = finalInput.whenBusy ?? finalWhenBusy
    }
    // 有效默认 steer：省略 whenBusy 的提交（HTTP/CLI/生成式 UI）统一按插话
    // 引导处理。这里一次性固化到最终输入，后续 SDK 提交、helm.input entry
    // 落库与 turn_settled 重建均看到同一有效值（落库反映真正执行）。
    finalWhenBusy = finalWhenBusy ?? 'steer'
    finalInput = { ...finalInput, whenBusy: finalWhenBusy }
    // transform 可能改写 attachments：对最终 ID 列表再次校验并取权威元数据
    //（钩子产物与直接输入同权，绝不让 transform 绕过授权门禁）。
    const finalIds = finalInput.attachments?.map((a) => a.id) ?? []
    const resolvedAttachments =
      finalIds.length > 0
        ? await this.resolveAuthorizedAttachments(id, finalIds)
        : finalIds.length === 0 && initialAttachments !== undefined
          ? undefined
          : initialAttachments
    // 最终输入统一脱敏（直接输入与 transform 产物同权）：text/effectiveText 与
    // meta 均不得携带已登记秘密明文（受管 Token、SecretStash 秘密）。此后的
    // 自动标题、tracker、helm.input entry、SDK content 与持久化全部使用脱敏值。
    if (finalInput.meta !== undefined) {
      finalInput = {
        ...finalInput,
        meta: redactJsonValue(finalInput.meta, (t) => this.stash.redact(t)) as Record<string, unknown>,
      }
    }
    const effectiveText = this.stash.redact(finalInput.text)
    // SQLite 零膨胀：helm.input entry 的 attachments 仅存轻量指针
    //（{id,name,mimeType,size}），绝不含 base64 字节。
    finalInput = {
      ...finalInput,
      text: effectiveText,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }
    return { kind: 'final', finalInput, finalWhenBusy, effectiveText, resolvedAttachments }
  }

  /** 首输入自动标题（派生自脱敏后文本；stateChangeSeq 同步推进）。 */
  private applyFirstInputTitle(meta: { id: number; title: string; stateChangeSeq: number }, effectiveText: string): void {
    if (meta.title !== '') return
    const title = deriveTitle(effectiveText)
    this.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() } as never)
  }

  /** 新输入 SDK 提交（非 rewind 路径；tracker 登记与失败撤销）。 */
  private async submitFreshInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    prepared: {
      finalInput: ConversationInput
      finalWhenBusy: WhenBusy
      effectiveText: string
      resolvedAttachments: Awaited<ReturnType<ConversationService['resolveAuthorizedAttachments']>> | undefined
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
      requestId: string | undefined
    },
  ): Promise<{ submissionId: string }> {
    const { finalInput, finalWhenBusy, effectiveText, resolvedAttachments, content } = prepared
    const key = this.tracker.registerInput(id, finalInput)
    try {
      const submission = await conversation.submit(
        {
          type: 'input',
          content: content as never,
          whenBusy: finalWhenBusy,
          // 最终 payload 的 origin/id/meta 落入 helm.input entry（模型可见来源标记）；
          // whenBusy 同步落库（快照/重建路径与在内存登记一致）。
          entry: {
            kind: 'helm.input',
            data: {
              id: finalInput.id,
              text: effectiveText,
              origin: finalInput.origin,
              createdAt: finalInput.createdAt,
              whenBusy: finalWhenBusy,
              ...(finalInput.meta !== undefined ? { meta: finalInput.meta } : {}),
              ...(resolvedAttachments !== undefined
                ? { attachments: resolvedAttachments.map((r) => r.ref) }
                : {}),
            } as unknown as JsonValue,
          },
          requestId: prepared.requestId ?? finalInput.id,
        },
        BACKGROUND_CONTEXT,
      )
      this.tracker.bindSubmission(id, key, submission.id as number)
      return { submissionId: String(submission.id) }
    } catch (error) {
      this.tracker.dropInput(id, key)
      throw normalizeBusyError(error)
    }
  }

  // ------------------------------------------------------------------
  // 原地覆盖重发（rewrite）
  // ------------------------------------------------------------------

  private async withHistoryEdit<T>(id: number, operation: () => Promise<T>): Promise<T> {
    if (this.historyEditsInFlight.has(id)) {
      throw new HelmError('conversation_busy', `会话 ${id} 正在更新历史消息，请稍后重试`, 409)
    }
    this.historyEditsInFlight.add(id)
    try {
      return await operation()
    } finally {
      this.historyEditsInFlight.delete(id)
    }
  }

  /** 陈旧编辑守卫：钩子挂起期间目标可能被并发改写（离开上下文 / 已被覆盖）。 */
  private async assertTargetStillCurrent(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    targetId: number,
  ): Promise<void> {
    const current = await conversation.context(BACKGROUND_CONTEXT)
    if (!current.entries.some((entry) => Number(entry.id) === targetId)) {
      throw new HelmError('entry_before_context_head', '编辑目标已离开当前上下文，请重新选择消息', 409)
    }
    if (current.entries.some((entry) => {
      const cut = rewindIntervalOf(entry as unknown as { id: number | string; kind: string; data?: unknown })
      return cut !== undefined && targetId >= cut.from && targetId <= cut.through
    })) {
      throw new HelmError('entry_already_rewound', `条目 ${targetId} 已被此前的重发覆盖`, 409)
    }
  }

  /**
   * 原地覆盖重发的原子提交（submitInput replaceFromEntryId 路径）：
   * 1. 异步准备：abort 在途回合（SDK abort 同时撤回其他 queued inputs，
   *    为本次明确语义）并等待 idle，挂起 Ask 逐个销单 superseded（错误如实
   *    上抛，绝不吞错伪成功）；
   * 2. 单个 SDK commit 内完成全部核验与写入（见 rewriteTransaction）；
   * 3. 事务后清理：精确删除被覆盖条目的 FTS 键并等待落盘（错误传播）、
   *    失效落入覆盖区间的 lastAssistant 缓存、推进 stateChangeSeq。
   *
   * 区间契约：helm.rewind.data 声明闭区间 [fromEntryId, throughEntryId]，
   * throughEntryId 为本事务前尾部（PRE_TRANSACTION_TAIL_ID）；新输入条目
   * ID 必然更大，绝不会被自家区间误删。既有 rewind 标记与 baseline
   * pi.system 保留（不 omit）；model messages 被省略由 SDK 原生 edits 负责。
   */
  async rewriteConversationFrom(
    id: number,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    replaceFromEntryId: number,
    newInput: {
      finalInput: ConversationInput
      effectiveText: string
      resolvedAttachments?: Array<{ ref: ConversationAttachmentRef; absPath: string }>
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    },
  ): Promise<{ submissionId: string }> {
    // 异步准备阶段（事务外）：用户已授权历史编辑中止当前回合。
    if (this.tracker.hasLiveWork(id)) {
      await this.abortConversation(id)
      await conversation.waitForIdle(BACKGROUND_CONTEXT)
      await this.tracker.waitTurnSettled(id)
    }
    // 挂起 Ask 销单为 superseded：被覆盖回合的审批卡不再有效；
    // 取消失败如实上抛（诚实纪律：绝不 .catch 吞错）。
    await this.o.cancelPendingAsksForRewrite(id)

    const createdAt = Date.now()
    // coveredRange 从事务内返回：事务外精确清理 FTS 旧键并失效落入区间的
    // lastAssistant 缓存（绝不触碰新输入/新回答的键）。
    const { submissionId, covered, ftsKeys } = await conversation.commit(
      (tx) => this.rewriteTransaction(conversation, tx, id, replaceFromEntryId, createdAt, newInput),
      BACKGROUND_CONTEXT,
    )
    this.registerRewoundInput(id, newInput.finalInput, submissionId)
    this.cleanupRewindSideEffects(id, covered, ftsKeys)
    return { submissionId: String(submissionId) }
  }

  /**
   * rewind 事务主体（commit 回调内；禁止 conversation.context()/harness 读等
   * 会死锁的接口）。阶段化拆分：核实空闲 -> 采集尾部 -> 计算 omit 清单 ->
   * 提交新输入 -> 追加 rewind 标记。
   */
  private async rewriteTransaction(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
    createdAt: number,
    newInput: {
      finalInput: ConversationInput
      effectiveText: string
      resolvedAttachments?: Array<{ ref: ConversationAttachmentRef; absPath: string }>
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    },
  ): Promise<{ submissionId: string; covered: { from: number; through: number }; ftsKeys: string[] }> {
    // —— 事务内重新核实（全部 tx reads，先于任何 table write）——
    const { tailId, headLowerBound } = await this.assertRewriteIdle(tx, id, replaceFromEntryId)
    const tailEntries = await this.scanTailEntries(tx, id, replaceFromEntryId)
    const target = tailEntries.find((e) => Number(e.id) === replaceFromEntryId)
    if (target === undefined) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    assertEditableHumanInput(target, id, replaceFromEntryId)
    // 既有 rewind 区间重核（异步准备期间可能有并发写入）。
    const rewound = tailEntries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && replaceFromEntryId >= interval.from && replaceFromEntryId <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `条目 ${replaceFromEntryId} 已被此前的重发覆盖`, 409, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const baselineSystemNumericId = await this.findBaselineSystemId(tx, id, headLowerBound)
    const { omittedEntryIds, omittedInputIds, ftsKeys } = this.collectRewindOmissions(tailEntries, baselineSystemNumericId)
    // 提交新输入（whenBusy 'reject'：任何并发进入在此显式失败，绝不排队）。
    // submit(tx, draft) 必须先于本事务首个 table write。
    const submissionId = await this.submitRewoundInput(conversation, tx, newInput)
    // rewind 截断标记：闭区间 [replaceFromEntryId, tailId]，新输入条目 ID
    // 已由上方 submit 分配（必然 > tailId），不会被自家 edits 误删。
    const edits = omittedEntryIds.map((target2) => ({ target: target2 as never, action: 'omit' as const }))
    await tx.appendEntry(id as never, {
      kind: 'helm.rewind',
      data: {
        fromEntryId: replaceFromEntryId,
        throughEntryId: tailId,
        omittedEntryIds,
        omittedInputIds,
        createdAt,
      } as unknown as JsonValue,
      ...(edits.length > 0 ? { edits } : {}),
    })
    return {
      submissionId,
      covered: { from: replaceFromEntryId, through: tailId },
      ftsKeys,
    }
  }

  /** 事务内空闲核实：活跃 run / 压缩 / 排队 / 目标越界（含上下文头）。 */
  private async assertRewriteIdle(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
  ): Promise<{ tailId: number; headLowerBound: number }> {
    const live = await tx.doc(LiveDoc, id as never)
    if (live.run !== undefined) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在活跃回合，拒绝原地覆盖重发（不排队）`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    if ((live.compactions?.length ?? 0) > 0) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在进行中的压缩任务，拒绝原地覆盖重发`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const inbox = await tx.doc(InboxDoc, id as never)
    if (inbox.items.length > 0) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在 ${inbox.items.length} 项排队提交，拒绝原地覆盖重发（不排队）`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const headMarker = await tx.latestHeadMarker(id as never)
    const latestIdRaw = await tx.latestEntryId(id as never)
    if (latestIdRaw === undefined) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const tailId = Number(latestIdRaw)
    if (replaceFromEntryId > tailId) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const headLowerBound = headMarker !== undefined ? Number(headMarker.head) : 0
    if (replaceFromEntryId < headLowerBound) {
      throw new HelmError(
        'entry_before_context_head',
        `条目 ${replaceFromEntryId} 位于最近一次重置或压缩之前，无法原地覆盖，请使用分叉（fork）`,
        409,
        { conversationId: id, entryId: replaceFromEntryId },
      )
    }
    return { tailId, headLowerBound }
  }

  /** 采集目标及之后的 raw entries（fork 可见范围；分页 scan，无深嵌套）。 */
  private async scanTailEntries(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
  ): Promise<Array<{ id: number | string; kind: string; data?: unknown }>> {
    const tailEntries: Array<{ id: number | string; kind: string; data?: unknown }> = []
    let scanCursor: unknown = undefined
    for (;;) {
      const page = await tx.scanEntries(
        {
          conversationId: id as never,
          minEntryId: replaceFromEntryId as never,
          order: 'ascending',
        },
        200,
        scanCursor as never,
      )
      for (const raw of page.items as never as Array<{ id: number | string; kind: string; data?: unknown }>) {
        tailEntries.push(raw)
      }
      if (page.next === undefined) break
      scanCursor = page.next
    }
    return tailEntries
  }

  /** baseline pi.system 定位：head 标记之后首条（保持 messages[0] 系统提示词）。 */
  private async findBaselineSystemId(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    headMarkerId: number,
  ): Promise<number | undefined> {
    let baselineSystemNumericId: number | undefined
    let baselineCursor: unknown = undefined
    for (;;) {
      const page = await tx.scanEntries(
        { conversationId: id as never, minEntryId: (headMarkerId + 1) as never, order: 'ascending' },
        200,
        baselineCursor as never,
      )
      const baseline = page.items.find((entry) => entry.kind === 'pi.system')
      if (baseline !== undefined) {
        baselineSystemNumericId = Number(baseline.id)
        break
      }
      if (page.next === undefined) break
      baselineCursor = page.next
    }
    return baselineSystemNumericId
  }

  /** omit 清单与精确 FTS 键采集（覆盖区间；baseline system 与 rewind 标记保留）。 */
  private collectRewindOmissions(
    tailEntries: ReadonlyArray<{ id: number | string; kind: string; data?: unknown }>,
    baselineSystemNumericId: number | undefined,
  ): { omittedEntryIds: number[]; omittedInputIds: string[]; ftsKeys: string[] } {
    const omittedEntryIds: number[] = []
    const omittedInputIds: string[] = []
    const ftsKeys: string[] = []
    for (const e of tailEntries) {
      const numericId = Number(e.id)
      // 覆盖区间内全部旧条目的精确 FTS 键（含被保留的 baseline system 与
      // rewind 标记本身——它们本就无索引文本，删不删都不影响，但统一采集
      // 避免 tailEntries 与清理清单两套逻辑）。
      ftsKeys.push(`entry:${String(e.id)}`)
      if (e.kind === 'helm.input') {
        const inputId = (e.data as { id?: unknown } | undefined)?.id
        if (typeof inputId === 'string' && inputId !== '') {
          ftsKeys.push(`input:${inputId}`)
          omittedInputIds.push(inputId)
        }
      }
      // 编辑目标本身必须 omit（闭区间含 from 边界）；既有 rewind 标记与
      // baseline pi.system 保留。
      if (e.kind === 'helm.rewind') continue
      if (numericId === baselineSystemNumericId) continue
      omittedEntryIds.push(numericId)
    }
    return { omittedEntryIds, omittedInputIds, ftsKeys }
  }

  /** rewind 新输入提交（whenBusy 'reject'；helm.input entry 全量脱敏后落库）。 */
  private async submitRewoundInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    newInput: {
      finalInput: ConversationInput
      effectiveText: string
      resolvedAttachments?: Array<{ ref: ConversationAttachmentRef; absPath: string }>
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    },
  ): Promise<string> {
    const inputDraft = {
      type: 'input' as const,
      content: newInput.content,
      whenBusy: 'reject' as const,
      entry: {
        kind: 'helm.input',
        data: {
          id: newInput.finalInput.id,
          text: newInput.effectiveText,
          origin: newInput.finalInput.origin,
          createdAt: newInput.finalInput.createdAt,
          whenBusy: 'reject',
          ...(newInput.finalInput.meta !== undefined ? { meta: newInput.finalInput.meta } : {}),
          ...(newInput.resolvedAttachments !== undefined
            ? { attachments: newInput.resolvedAttachments.map((r) => r.ref) }
            : {}),
        } as unknown as JsonValue,
      },
      requestId: newInput.finalInput.id,
    }
    return conversation.submit(tx, inputDraft) as unknown as Promise<string>
  }

  /** 事务后 tracker 登记（bindSubmission 合并 commit 观察路径的先行登记）。 */
  private registerRewoundInput(id: number, finalInput: ConversationInput, submissionId: unknown): void {
    // 事务已落库：登记 tracker（commit 观察路径可能已按 req: 键先行登记，
    // bindSubmission 会合并为唯一记录，失败则 drop 撤销，绝不留下孤儿登记）。
    const key = this.tracker.registerInput(id, finalInput)
    try {
      this.tracker.bindSubmission(id, key, Number(submissionId))
    } catch (error) {
      this.tracker.dropInput(id, key)
      throw error
    }
  }

  /** 事务外清理：FTS 精确旧键删除 + lastAssistant 缓存失效 + stateChangeSeq 推进。 */
  private cleanupRewindSideEffects(id: number, covered: { from: number; through: number }, ftsKeys: string[]): void {
    // 事务外清理：只删事务内核实的精确旧 FTS 键（entry:<id> / input:<requestId>），
    // 观察者新输入/新回答入索引不受影响（遇 helm.rewind 停止回扫，旧回答不复燃）；
    // 落盘错误由尾链统一冲刷传播（flushPublic / search 读路径如实抛出）。
    // 失效落入覆盖区间的 lastAssistant 缓存：新回答失败时
    // getLastAssistantText 不得返回已被覆盖的旧答案。
    this.store.removeFtsEntries(id, ftsKeys)
    this.tracker.invalidateLastAssistantWithin(id, covered.from, covered.through)
    const meta = this.store.getConv(id)
    if (meta) {
      this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
  }

  // ------------------------------------------------------------------
  // waitForInput / withdraw / abort
  // ------------------------------------------------------------------

  /**
   * 等待单次提交的精确结果（send --wait / POST ?wait=1）：
   * - 以 harness.submission 核对身份（conversationId/id/type）后 await wait；
   * - done 后按 answer entryId 精确读取条目（minEntryId=maxEntryId），保留 model
   *   消息，assistant 文本逐值脱敏；
   * - failed/aborted 显式抛错（turn_failed/turn_aborted），绝不伪造回答；
   * - handled:* 的提交没有真实 SDK submission，显式不适用而非造成功。
   */
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
      // 终态未获回答：按 reason 区分失败/中止（aborted/faulted/model_error 等），
      // 绝不伪造回答文本。
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
      // 理论不可达（wait 只回终态）；防御性显式报错而非吞。
      throw new HelmError('turn_failed', `提交 ${submissionId} 结算为非终态 ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    // 精确读取 answer entry（保留 model；文本逐值脱敏）。
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

  /**
   * 撤回排队中的输入（POST /api/conversations/:id/withdraw）：先经
   * harness.submission status 核实身份（属于本会话且 type=input——write
   * 提交的撤回副作用不属于本接口语义），再复用 SDK abortSubmission 原生
   * 语义（queued -> unanswered(aborted) 并移出 pi.inbox）；placed/settled
   * 如实返回，不伪装撤回成功。
   */
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
    // 身份先于 abort：核实提交存在、属于本会话且为 input 提交。
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
    // 提交可能在首次读取后刚进入执行，以撤回判定后的权威状态返回 entryId。
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
    // 仅在途会话结算 aborted；空闲 abort 不伪造终态（已完成/已失败回合不覆盖）。
    if (wasBusy) this.tracker.settleAborted(id)
    // abort 兑底：未被 execute 消费的 handled 接管残留一并清理。
    this.o.evictHandledToolCalls(id)
  }

  // ------------------------------------------------------------------
  // reset / compact / fork / waitForIdle
  // ------------------------------------------------------------------

  /** 内核关闭守卫（上下文操作共用）。 */
  private assertOpen(): void {
    if (this.o.isClosed()) throw new HelmError('runtime_closed', '内核正在关闭，拒绝提交新输入', 503)
  }

  /** 取已存在的会话元数据与 SDK 句柄（不存在统一 404）。 */
  private async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = requireConv(this.store, id)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    return { meta, conversation }
  }

  /** 重置会话上下文：SDK reset(handoff) 后推进 stateChangeSeq 并广播摘要。 */
  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeHandoff =
      opts?.handoff !== undefined && opts.handoff !== '' ? this.stash.redact(opts.handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /** 手动压缩：SDK compact(instructions) 返回后台任务 ID；返回 { taskId, conversation }。 */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeInstructions =
      opts?.instructions !== undefined && opts.instructions !== ''
        ? this.stash.redact(opts.instructions)
        : undefined
    const taskId = await conversation.compact(safeInstructions, BACKGROUND_CONTEXT)
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * 从指定条目分叉新会话：SDK fork(entryId) 后登记 helm 镜像
   *（继承 profile/tags/cwd/model/override；父链指向源会话）并对齐模型。
   */
  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    if (!Number.isSafeInteger(opts.entryId) || opts.entryId <= 0) {
      throw new HelmError('validation_error', `entryId 需为安全正整数（收到 ${String(opts.entryId)}）`, 400, {
        entryId: opts.entryId,
      })
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // 条目存在性精确校验（min=max=entryId 取 1 条；不存在 404）。
    const page = await sourceConv.entries(
      { minEntryId: opts.entryId as never, maxEntryId: opts.entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || (page.items[0] as { id: number }).id !== opts.entryId) {
      throw new HelmError('not_found', `条目 ${opts.entryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: opts.entryId,
      })
    }
    const forked = await sourceConv.fork(
      opts.entryId as never,
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `会话 ${id}`
    const title =
      opts.title !== undefined && opts.title.trim() !== ''
        ? this.stash.redact(opts.title.trim())
        : `${baseTitle} (分叉)`
    this.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: id,
      nodeId: sourceMeta.nodeId ?? 'local',
      cwd: sourceMeta.cwd,
      model: sourceMeta.model,
      thinkingLevel: sourceMeta.thinkingLevel,
      thinkingLevelOverride: sourceMeta.thinkingLevelOverride,
      ...(sourceMeta.modelOverride !== undefined ? { modelOverride: sourceMeta.modelOverride } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.alignConversationModel(newId)
    await this.tracker.observe(newId)
    const summary = this.tracker.summaryOf(newId)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /** 等待会话空闲（含本会话 turn_settled 钩子异步执行完成）。 */
  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    await this.tracker.waitTurnSettled(id)
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.tracker.getLastAssistantText(id) ?? ''
  }

  /** FTS 重建（宿主 rebuildFts 委托；rewind 覆盖条目绝不重新索引）。 */
  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    await this.store.rebuildFts(async (index) => {
      for (const conv of listConversationIds()) {
        const conversation = await this.harness.conversation(conv.id as never, BACKGROUND_CONTEXT)
        if (!conversation) continue
        // 全量扫描后按 helm.rewind 闭区间 [from, through] 过滤被覆盖条目：
        // 它们已不再活跃，重建 FTS 时绝不重新索引；同一区间公式与
        // collectRewindIntervals / 详情投影共用闭区间。
        const rewindCuts: RewindInterval[] = []
        const indexed: Array<{ id: number; text: string }> = []
        let cursor: unknown = undefined
        for (;;) {
          const page = await conversation.entries(
            { order: 'ascending' },
            50,
            cursor as never,
            BACKGROUND_CONTEXT,
          )
          for (const entry of page.items) {
            const record = entry as { id: number; kind: string; data?: unknown }
            if (record.kind === 'helm.rewind') {
              const interval = rewindIntervalOf(record)
              if (interval !== undefined) rewindCuts.push(interval)
              continue
            }
            const text = entryModelText(entry as never)
            if (text) indexed.push({ id: Number(record.id), text })
          }
          if (!page.next) break
          cursor = page.next
        }
        for (const item of indexed) {
          if (coveredByRewind(item.id, rewindCuts)) continue
          index(conv.id, `entry:${item.id}`, conv.title, this.stash.redact(item.text))
        }
      }
    })
  }

  async search(query: string): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    return this.store.search(query)
  }

  /** 恢复观察（启动路径；元数据缺失的会话按 SDK 现状重建镜像）。 */
  async recover(onMissingMirror: (id: number, parentConversationId: number | undefined) => Promise<void>): Promise<void> {
    // 真实分页扫描（page.next 翻页）：未删除会话全部 observe——重启后凭 store
    // 元件即可定位，但观察者必须重建（否则永久 idle/丢 assistant 文本）。
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
        // 启动对齐：无显式 override 的会话按 profile/全局重算生效模型，
        // SDK 配置与镜像同步（profile 文件改动后重启即生效）。
        await this.alignConversationModel(id)
        await this.tracker.observe(id)
      }
      if (!page.next) break
      cursor = page.next
    }
  }
}
