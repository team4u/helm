/**
 * Conversation service: CRUD / paginated details / input submission (submitInput) / in-place overwrite & resend
 * (rewrite) / fork / reset / compact / model inheritance alignment / attachment content assembly.
 *
 * Extracted from runtime.ts (splitting the largest responsibility cluster out of an oversized class). External behavior
 * matches the original KernelRuntime methods identically; internally delegates history rewrites, context operations,
 * attachment resolution, detail pagination, profile alignment, and the input pipeline to dedicated submodules.
 */
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Harness, AgentChange } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationDetail,
  ConversationEntry,
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
import { ConversationRewind } from './conversation-rewind.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric, type TrustedNodePlatformSource } from './target-cwd.js'

interface ConversationServiceOptions {
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
  /** Release stale backend cache when conversation target changes (host injects envFabric.evictConversation). */
  readonly evictConversationBase: (conversationId: number) => void
  /** Plugin conversation management guard (deletion protection; host-injected). */
  readonly managedConversations: Map<number, Set<string>>
  /** Cascade-cancel pending asks (on conversation deletion; host injects asks.cancelByConversation). */
  readonly cancelAsksByConversation: (id: number) => Promise<void>
  /** Supersede pending asks before in-place rewrite+resend (host injects asks.listPendingByConversation + cancelAsk). */
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  /** Clean up leftover handled tool calls (backstop on delete/abort). */
  readonly evictHandledToolCalls: (conversationId: number) => void
  /** Ownership annotation (restores 'human' as backstop on delete; host-injected). */
  readonly markOwnership: (id: number, owner: 'helm' | 'bot' | 'human') => void
  /** Current ownership lookup (for summary projection). */
  readonly ownershipOf: (id: number) => 'helm' | 'bot' | 'human'
  /** Input hook pipeline (host HookBridge.runHookChain). */
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  /** Shutdown guard (isClosed). */
  readonly isClosed: () => boolean
  /**
   * Startup lifecycle fact (read-only projection of KernelRuntime.started): set synchronously right after
   * start() completes harness.resume. abortConversationGuarded uses this as a fast-path gate—only paying for a
   * read-only harness.inspect authoritative phase re-check before startup completes (covers the prepare barrier window
   * for persistent markers; manual submissions during autoResume:false pre-startup follow normal abort per authoritative inspect),
   * never maintaining a second mirror state.
   */
  readonly isStarted: () => boolean
  /** Model resolution chain (default model). */
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** Per-model thinking defaults lookup (`config.json.modelThinkingLevels`, keyed by full `'provider/modelId'`). */
  readonly modelThinkingLevelOf: (ref: { provider: string; modelId: string }) => string | undefined
  /** Current Models collection (used to clamp thinking levels to model capabilities). */
  readonly models: () => Models
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** Disabled-model preflight check (ModelRegistry.assertModelEnabled; rejects selection and submission of disabled models). */
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  /**
   * Trusted node platform source (reported by EnvFabric.registry; defaults to local-only resolution).
   * Used to normalize create/update cwd against the target node platform (see runtime/target-cwd.ts).
   */
  readonly trustedPlatformOf?: TrustedNodePlatformSource
}

/** Optional parameters for input submission (shared shape across HTTP/CLI/internal). */
export interface SubmitInputOptions {
  origin?: InputOrigin
  whenBusy?: WhenBusy
  /** @internal Guarded submissions may ask the SDK to atomically reject idle conversations; never exposed on HTTP/CLI. */
  whenIdle?: 'reject'
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  /** Internal durable idempotency key for completion callbacks; never exposed on HTTP input. */
  requestId?: string
  /**
   * @internal Kernel guarded mutation channel (injected by submitInputGuarded; never exposed on host API
   * or HTTP/CLI): synchronously re-checks ownership and watermark at commit point (right before SDK submit after the last await),
   * failing 409/404 with zero submission side effects.
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
  private fatalErrorProvider: (() => Error | undefined) | undefined

  /** Attach host fatal store error reader (used to reject mutating requests without altering normal shutdown). */
  setFatalErrorProvider(provider: () => Error | undefined): void {
    this.fatalErrorProvider = provider
  }

  private assertWritable(): void {
    const fatal = this.fatalErrorProvider?.()
    if (fatal !== undefined) throw fatal
  }

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
      ensureContextUsage: (id) => this.tracker.ensureContextUsage(id),
    })

    this.profileAlignment = new ConversationProfileService({
      harness: this.harness,
      store: this.store,
      events: this.events,
      profilesSvc: this.profilesSvc,
      models: this.o.models,
      defaultModel: this.o.defaultModel,
      defaultThinkingLevel: this.o.defaultThinkingLevel,
      modelThinkingLevelOf: this.o.modelThinkingLevelOf,
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      // Context window and thresholds may change after model/Profile alignment: trigger context usage recalculation.
      scheduleContextUsageRefresh: (id) => this.tracker.scheduleContextUsageRefresh(id),
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
  // Guarded mutations (kernel-enforced automation invariants)
  // ------------------------------------------------------------------

  /** Per-conversation serial gate for guarded mutations (promise tail chain): ensures re-check + irreversible
   * action in automated abort/submit runs sequentially per conversation without blocking other conversations. */
  private readonly mutationGates = new Map<number, Promise<unknown>>()

  private withMutationGate<T>(id: number, op: () => Promise<T>): Promise<T> {
    const prev = this.mutationGates.get(id) ?? Promise.resolve()
    // Prior failure must not block subsequent queued operations (tail swallows errors; op runs cleanly each time).
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

  /** Boundary validation for guard payload (throws 400 synchronously): expectedOwnership strictly forbids 'human'. */
  private assertGuardShape(guard: GuardedMutationExpectation): void {
    if (typeof guard !== 'object' || guard === null) {
      throw new HelmError('validation_error', 'guarded mutation requires a guard object', 400)
    }
    if (
      guard.expectedOwnership !== undefined &&
      guard.expectedOwnership !== 'bot' &&
      guard.expectedOwnership !== 'helm'
    ) {
      throw new HelmError(
        'validation_error',
        `expectedOwnership only allows 'bot' | 'helm' (automation invariant forbids human): got ${String(guard.expectedOwnership)}`,
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
        `expectedStateSeq must be a non-negative safe integer: got ${String(guard.expectedStateSeq)}`,
        400,
        { expectedStateSeq: guard.expectedStateSeq },
      )
    }
  }

  /**
   * Synchronous guard re-check (zero awaits): verifies conversation existence, ownership (always rejects 'human'),
   * and optional CAS watermark. Callers guarantee zero event-loop yields between this check and the irreversible
   * SDK abort/submit call—in single-threaded JS, markOwnership cannot interleave, closing the human-ownership race window.
   */
  assertMutationGuard(id: number, guard: GuardedMutationExpectation): void {
    // getOwnership throws explicit not_found for missing or tombstoned conversations—never let default routing mask stale targets.
    const ownedBy = this.o.ownershipOf(id)
    if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
      throw new HelmError(
        'ownership_conflict',
        `conversation ${id} is currently owned by ${ownedBy}${guard.expectedOwnership !== undefined ? ` (expected ${guard.expectedOwnership})` : ''}; refusing automated mutation (human-ownership invariant)`,
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
        throw new HelmError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
      }
      if (meta.stateChangeSeq !== guard.expectedStateSeq) {
        throw new HelmError(
          'state_seq_conflict',
          `conversation ${id} authoritative watermark ${meta.stateChangeSeq} does not match expected ${guard.expectedStateSeq} (stale probe snapshot; must not act on newer turn)`,
          409,
          { conversationId: id, currentSeq: meta.stateChangeSeq, expectedSeq: guard.expectedStateSeq },
        )
      }
    }
  }

  /**
   * Automated guarded abort: executes guard re-check and irreversible SDK abort back-to-back inside the same
   * conversation serial domain (zero await gap); if re-check fails, abort never fires.
   * Normal abortConversation semantics remain unchanged (human/CLI paths do not bind automation guards).
   *
   * Phase adaptation (replaces the old dedicated prepareInterruptedConversations helper):
   * - While SDK scheduler is running: SDK Conversation.abort + wait for idle (preserves existing behavior with
   *   zero extra awaits on the hot path so live cancellations are never slowed by extra phase probes);
   * - While scheduler is paused (within service prepare barrier, before resume): commits durable abort markers
   *   task-by-task under this conversation via harness.abortTask (no resume, no settlement wait), synchronously re-checking
   *   ownership before each irreversible call (enforcing human-ownership invariant across recovery orchestration).
   */
  async abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, async () => {
      // Recovery barrier path: only pay for a read-only inspect authoritative phase check while kernel is not yet started
      // (lifecycle fact, not a mirror state); re-check synchronously before marking each task so human ownership holds across recovery.
      if (!this.o.isStarted()) {
        const inspection = await this.harness.inspect(BACKGROUND_CONTEXT)
        if (inspection.scheduling === 'paused') {
          let matched = false
          for (const task of inspection.tasks) {
            if (task.record.conversationId !== (id as never)) continue
            matched = true
            // Zero awaits between check and subsequent abortTask call (markOwnership cannot interleave on single thread).
            this.assertMutationGuard(id, guard)
            await this.harness.abortTask(task.record.id, BACKGROUND_CONTEXT)
          }
          if (!matched) {
            // Still verify existence + ownership even with zero queued SDK tasks: missing -> not_found, human -> rejected,
            // never returning false success for human/missing targets.
            this.assertMutationGuard(id, guard)
          }
          return
        }
        // Unexpectedly running (e.g. post-manual submit during autoResume:false before start): fall through to normal path.
      }
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      // Final re-check immediately before abort (zero await gap, catching any ownership change during lookup await).
      this.assertMutationGuard(id, guard)
      const wasBusy = this.tracker.hasLiveWork(id)
      await conversation.abort(BACKGROUND_CONTEXT)
      if (wasBusy) this.tracker.settleAborted(id)
      else this.tracker.clearQueuedTracking(id)
      this.o.evictHandledToolCalls(id)
    })
  }

  /**
   * Automated guarded submission: runs synchronous fast check at entry (fail-fast, zero side effects), then traverses
   * the full input pipeline; after hook/model resolution completes, atomically re-checks right at commit point before
   * invoking SDK submit (see ConversationInputPipeline.submitFreshInput). Failed checks leave zero side effects.
   */
  async submitInputGuarded(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
    guard: GuardedMutationExpectation = {},
  ): Promise<{ submissionId: string }> {
    this.assertWritable()
    this.assertGuardShape(guard)
    if (opts?.whenIdle !== undefined && opts.whenIdle !== 'reject') {
      throw new HelmError('validation_error', 'guarded submission whenIdle only allows reject', 400)
    }
    if (opts?.replaceFromEntryId !== undefined) {
      throw new HelmError(
        'validation_error',
        'automated guarded submission does not support replaceFromEntryId (automation must not rewrite history)',
        400,
        { conversationId: id, replaceFromEntryId: opts.replaceFromEntryId },
      )
    }
    this.contextOps.assertOpen()
    // Fast pre-check before any durable side effects (hook observations, title derivation, or commit).
    this.assertMutationGuard(id, guard)
    return this.submitInput(id, text, { ...opts, mutationGuard: guard })
  }

  // ------------------------------------------------------------------
  // Summary and ownership projection
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
  // Detail pagination & FTS rebuild (delegated to detailOps)
  // ------------------------------------------------------------------

  async getConversationDetail(id: number, options?: { limit?: number; cursor?: string }): Promise<ConversationDetail> {
    // contextUsage refresh and timeline pagination run in parallel inside detailOps; once both settle,
    // re-fetch authoritative summary before merging (see conversation-detail.ts); failure on either leg rejects.
    return this.detailOps.getConversationDetail(id, options)
  }

  /** Fetch a single timeline entry (untruncated, already redacted; rewind visibility matches detail pagination). */
  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    return this.detailOps.getConversationEntry(id, entryId)
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
  // Profile / model inheritance chain (delegated to profileAlignment)
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
      throw new HelmError('validation_error', `profile not found: ${requested} (create profiles/${requested} first)`, 400)
    }
    return requested
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    this.assertWritable()
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
    /** Normalize cwd for the target node platform consistently (zero disk IO; prevents invalid POSIX paths from entering DB). */
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
        `conversation targets remote node ${nodeId} without a cwd (Profile.cwd / parent conversation cwd / init.cwd are all unset; blind execution in node default directory is rejected)`,
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
    this.assertWritable()
    return this.profileAlignment.withConversationChange(id, () => this.updateConversationConfiguration(id, patch))
  }

  private async updateConversationConfiguration(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    const meta = requireConv(this.store, id)
    if (patch.profileId !== undefined) {
      const found = await this.readProfile(patch.profileId)
      if (!found) {
        throw new HelmError('validation_error', `profile not found: ${patch.profileId}`, 400)
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
    const nextProfileId = patch.profileId ?? meta.profileId
    const effectiveModel = await this.resolveEffectiveModel(nextOverride, nextProfileId)
    // A model switch without a simultaneous explicit thinking change clears the stale conversation override:
    // the override was chosen for the previous model and must not shadow the new model's own default chain
    // (per-model default > Profile > global). Re-selecting the same effective model keeps the override.
    const modelSwitched = patch.model !== undefined && (effectiveModel ?? '') !== meta.model
    let nextThinkingOverride: string | undefined
    if (patch.thinkingLevel === undefined) {
      nextThinkingOverride = modelSwitched ? undefined : meta.thinkingLevelOverride
    } else {
      const level = patch.thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `invalid thinkingLevel '${level}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinkingOverride = level || undefined
    }
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    // After model/Profile changes, clamp any explicit thinking override to what the target model supports
    // (single clampThinkingLevelForModel helper; unknown capabilities pass through to keep the contract intact).
    const clampedOverride = effectiveRef
      ? clampThinkingLevelForModel(this.o.models(), effectiveRef, nextThinkingOverride)
      : nextThinkingOverride
    const nextThinking = await this.resolveEffectiveThinkingLevel(clampedOverride, nextProfileId, effectiveRef)
    // Explicit cwd, or existing cwd when migrating nodeId, is normalized for the target node platform before SDK
    // configure and mirror persistence; invalid POSIX roots are rejected explicitly.
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
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
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
    // Context window and thresholds may change after model/thinking changes: schedule usage refresh (deduplicated).
    if (patch.model !== undefined || patch.profileId !== undefined || patch.thinkingLevel !== undefined) {
      this.tracker.scheduleContextUsageRefresh(id)
    }
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  async deleteConversation(id: number): Promise<void> {
    this.assertWritable()
    requireConv(this.store, id)
    const owners = [...(this.o.managedConversations.get(id) ?? [])]
    if (owners.length > 0) {
      throw new HelmError(
        'conversation_managed_by_plugin',
        `conversation ${id} is currently managed by plugin(s) (${owners.join(', ')}); release management before deleting`,
        409,
        { conversationId: id, owners },
      )
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    // Cascade-cancel asks and wait for completion; IO errors must propagate (blocking further deletion side effects)
    // rather than being swallowed into fake success.
    await this.o.cancelAsksByConversation(id)
    await this.artifactsSvc.deleteConversation(id)
    // Reclaim in-memory secrets synchronously (including old values retained for redaction): deleted conversations free everything.
    this.stash.clear(id)
    this.tracker.stopObserving(id)
    this.store.deleteConv(id)
    this.o.evictHandledToolCalls(id)
    this.o.evictConversationBase(id)
    this.o.markOwnership(id, 'human')
    this.events.publish('conversation.deleted', { conversationId: id })
  }

  // ------------------------------------------------------------------
  // Artifact authorization and attachments (delegated to attachments)
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
    this.assertWritable()
    this.contextOps.assertOpen()
    const convMeta = requireConv(this.store, id)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)

    if (opts?.requestId !== undefined) {
      if (typeof opts.requestId !== 'string' || opts.requestId.trim() === '') {
        throw new HelmError('validation_error', 'internal requestId must be a non-empty string', 400)
      }
      const previous = await this.harness.commit(
        (tx) => tx.submissionByRequest(id as never, opts.requestId!),
        BACKGROUND_CONTEXT,
      )
      if (previous !== undefined) return { submissionId: String(previous.id) }
    }
    // Shape gate at the shared submission entry (HTTP callers are schema-validated upstream;
    // in-process/plugin callers land here): rejects non-array or non-string attachment lists before
    // they can surface as opaque TypeErrors inside attachment resolution.
    if (opts?.attachments !== undefined) {
      if (
        !Array.isArray(opts.attachments) ||
        opts.attachments.some((a) => typeof a !== 'string' || a.length === 0)
      ) {
        throw new HelmError(
          'validation_error',
          'attachments must be an array of non-empty artifact ID strings',
          400,
          { conversationId: id },
        )
      }
    }

    const effectiveModelRef = await this.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmError(
        'model_not_configured',
        `no model configured for conversation ${id} (profile ${convMeta.profileId}) or globally: configure a model on the Profile, HELM_MODEL, config.json.model, or conversation`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    // Effective model disabled (e.g., disabled after being configured as default): reject at submission entry rather than silently falling back.
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
    // Guarded submission: re-check after hooks before any durable side effects (handled return / title derivation /
    // commit); final atomic re-check executes at commit point inside submitFreshInput.
    if (opts?.mutationGuard !== undefined) {
      this.assertMutationGuard(id, opts.mutationGuard)
    }
    if (prepared.kind === 'handled') return { submissionId: prepared.submissionId }

    this.contextOps.assertOpen()
    // Re-read metadata after prepareInput so mutations performed by onInput hooks (e.g. tags) are preserved.
    this.inputPipeline.applyFirstInputTitle(requireConv(this.store, id), prepared.effectiveText)

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
      // Guarded submission serial gate: wraps only the commit-point re-check + SDK submit critical section;
      // input hooks execute outside the gate so re-entrant guarded mutations inside hooks will not deadlock.
      return this.withMutationGate(id, () => this.inputPipeline.submitFreshInput(conversation, id, freshSubmission))
    }
    return this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
  }

  // ------------------------------------------------------------------
  // waitForInput / withdraw / abort
  // ------------------------------------------------------------------

  async waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> {
    if (submissionId.startsWith('handled:')) {
      throw new HelmError(
        'wait_not_applicable',
        `submission ${submissionId} was handled by an input hook and has no real turn to wait for`,
        409,
        { conversationId: id, submissionId },
      )
    }
    const numericId = Number(submissionId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new HelmError('validation_error', `invalid submissionId: ${submissionId}`, 400)
    }
    requireConv(this.store, id)
    const waitContext = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
    const waitAbortedError = (): HelmError =>
      new HelmError('aborted', `waiting for result of submission ${submissionId} in conversation ${id} was cancelled`, 499, {
        conversationId: id,
        submissionId,
      })
    const runWaitOp = async <T>(op: () => Promise<T>): Promise<T> => {
      if (signal?.aborted) throw waitAbortedError()
      try {
        return await awaitWithContext(op(), waitContext)
      } catch (error) {
        if (signal?.aborted) throw waitAbortedError()
        throw error
      }
    }
    const submission = await runWaitOp(() => this.harness.submission(numericId as never, waitContext))
    if (!submission) {
      throw new HelmError('not_found', `submission not found: ${submissionId}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const status = (await runWaitOp(() => submission.status(waitContext))) as unknown as {
      conversationId?: unknown
      id?: unknown
      type?: string
    }
    if (
      String(status.conversationId) !== String(id) ||
      String(status.id) !== submissionId ||
      status.type !== 'input'
    ) {
      throw new HelmError('not_found', `submission ${submissionId} does not belong to conversation ${id}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const settled = (await runWaitOp(() => submission.wait(waitContext))) as unknown as {
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
        `conversation ${id} turn produced no answer (${reason}${settled.detail !== undefined ? `: ${String(settled.detail)}` : ''})`,
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
      throw new HelmError('turn_failed', `submission ${submissionId} settled in non-terminal state ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    const conversation = await runWaitOp(() => this.harness.conversation(id as never, waitContext))
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
    const page = await runWaitOp(() =>
      conversation.entries(
        { minEntryId: settled.answer as never, maxEntryId: settled.answer as never, order: 'ascending' },
        1,
        undefined,
        waitContext,
      ),
    )
    const raw = page.items[0] as
      | { id: number; kind: string; data?: unknown; model?: unknown[] }
      | undefined
    if (raw === undefined || raw.id !== settled.answer) {
      throw new HelmError('not_found', `answer entry missing: ${settled.answer}`, 502, {
        conversationId: id,
        submissionId,
      })
    }
    const entry = toConversationEntry(raw)
    const text = this.stash.redact(assistantTextOfModel(entry.model))
    return { conversationId: id, submissionId, text, entry }
  }

  async withdrawQueuedInput(id: number, opts: { submissionId: number }): Promise<ConversationWithdrawResponse> {
    this.assertWritable()
    if (this.o.isClosed()) throw new HelmError('runtime_closed', 'kernel is closing; rejecting withdrawal', 503)
    requireConv(this.store, id)
    const raw = opts.submissionId
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError('validation_error', `submissionId must be a positive safe integer (received ${String(raw)})`, 400, {
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
      throw new HelmError('not_found', `submission ${raw} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    const outcome = await this.harness.abortSubmission(raw as never, BACKGROUND_CONTEXT, id as never)
    if (outcome === 'not_found') {
      throw new HelmError('not_found', `submission ${raw} does not exist in conversation ${id}`, 404, {
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
    this.assertWritable()
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
    const wasBusy = this.tracker.hasLiveWork(id)
    await conversation.abort(BACKGROUND_CONTEXT)
    if (wasBusy) this.tracker.settleAborted(id)
    else this.tracker.clearQueuedTracking(id)
    this.o.evictHandledToolCalls(id)
  }

  // ------------------------------------------------------------------
  // reset / compact / fork (delegated to contextOps)
  // ------------------------------------------------------------------

  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertWritable()
    return this.contextOps.resetConversation(id, opts)
  }

  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertWritable()
    return this.contextOps.compactConversation(id, opts)
  }

  async forkConversation(
    id: number,
    opts?: { entryId?: number; title?: string; parentConversationId?: number },
  ): Promise<ConversationSummary> {
    this.assertWritable()
    return this.contextOps.forkConversation(id, opts)
  }

  // ------------------------------------------------------------------
  // waitForIdle / getLastAssistantText / search / recover
  // ------------------------------------------------------------------

  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
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
