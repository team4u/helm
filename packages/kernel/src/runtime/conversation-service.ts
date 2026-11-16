/**
 * conversation service:CRUD / detail situation page / input commit (submitInput)/ original ground override heavy
 * (rewrite)/ fork / reset / compact / model inherit chain align / attachment content piece together install.
 *
 * from runtime.ts split out (on emperor class most large responsibility cluster). for outside behavior and original KernelRuntime method
 * one by one lead to; internal history heavy write, context operation, attachment parse, detail situation page, role align and input pipeline delegate to dedicated sub- module.
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
  /** conversation target change when release old target bottom seat cache (host inject envFabric.evictConversation). */
  readonly evictConversationBase: (conversationId: number) => void
  /** plugin conversation manage right (delete protect; host inject). */
  readonly managedConversations: Map<number, Set<string>>
  /** suspended Ask level join cancel (delete conversation when; host inject asks.cancelByConversation). */
  readonly cancelAsksByConversation: (id: number) => Promise<void>
  /** original ground override heavy before suspended Ask deregister single superseded(host inject asks.listPendingByConversation + cancelAsk). */
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  /** handled take over leftover clean up (delete/abort honor bottom). */
  readonly evictHandledToolCalls: (conversationId: number) => void
  /** ownership mark record (delete honor bottom restore human; host inject). */
  readonly markOwnership: (id: number, owner: 'helm' | 'bot' | 'human') => void
  /** ownership now read (summary throw shoot use). */
  readonly ownershipOf: (id: number) => 'helm' | 'bot' | 'human'
  /** input hook pipeline (host HookBridge.runHookChain). */
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  /** close guard (isClosed). */
  readonly isClosed: () => boolean
  /**
   * start lifecycle fact (KernelRuntime.started only read throw shoot):start() complete i.e.
   * harness.resume after sync segment placement.abortConversationGuarded use it do fast path
   * gate - - not at startup only then pay once only read harness.inspect right threat each other re-check (prepare
   * screen fault window durable mark record;autoResume:false manually after commit not start window by inspect
   * right threat result away common rule abort), never maintain second mirror state.
   */
  readonly isStarted: () => boolean
  /** model parse chain (by default model). */
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** when before Models set (think Profile capability converge use). */
  readonly models: () => Models
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** model disable preflight (ModelRegistry.assertModelEnabled; disable model reject choose use and commit). */
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  /**
   * can message node platform source (EnvFabric.registry on report; default only local can parse).
   * create/update cwd by target node platform specification use (see runtime/target-cwd.ts).
   */
  readonly trustedPlatformOf?: TrustedNodePlatformSource
}

/** commit input optional parameter (HTTP/CLI/internal same construct). */
export interface SubmitInputOptions {
  origin?: InputOrigin
  whenBusy?: WhenBusy
  /** @internal guarded commit can want seek SDK atomic reject idle conversation;HTTP/CLI do not open put. */
  whenIdle?: 'reject'
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  /** internal complete back report durable idempotent key;HTTP input do not open put this field. */
  requestId?: string
  /**
   * @internal kernel guarded mutation channel (submitInputGuarded inject; host API
   * and HTTP/CLI all do not expose): in commit point (SDK submit invoke before, finally a await
   * after) sync re-check ownership and watermark, failed 409/404 and produces no commit side effect.
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

  /** mount host lead to life store fault read (only write/change new request reject use, does not change normal closure stop semantics). */
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
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      // model/Profile align after context window and threshold may change: trigger use amount heavy compute.
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
  // guarded mutation(automatically hard rule kernel execute layer)
  // ------------------------------------------------------------------

  /** conversation level guarded change serial gate (promise tail chain): the same conversation automatically abort/commit
   * in re-check + a cannot inverse action critical zone on fully has order, different conversation mutual non-blocking. */
  private readonly mutationGates = new Map<number, Promise<unknown>>()

  private withMutationGate<T>(id: number, op: () => Promise<T>): Promise<T> {
    const prev = this.mutationGates.get(id) ?? Promise.resolve()
    // before order failed do not block assert after continue (tail chain absorb error;op each time real execute).
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

  /** guard payload boundary validate (sync throw 400):expectedOwnership strictly forbidden 'human'. */
  private assertGuardShape(guard: GuardedMutationExpectation): void {
    if (typeof guard !== 'object' || guard === null) {
      throw new HelmError('validation_error', 'guarded mutation need to guard object', 400)
    }
    if (
      guard.expectedOwnership !== undefined &&
      guard.expectedOwnership !== 'bot' &&
      guard.expectedOwnership !== 'helm'
    ) {
      throw new HelmError(
        'validation_error',
        `expectedOwnership only allows 'bot' | 'helm'(automatically hard rule strictly forbidden human): receives ${String(guard.expectedOwnership)}`,
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
        `expectedStateSeq must be non- negative security integer: receives ${String(guard.expectedStateSeq)}`,
        400,
        { expectedStateSeq: guard.expectedStateSeq },
      )
    }
  }

  /**
   * guard re-check (sync, zero await): conversation store in + ownership (human forever reject)+
   * optional CAS watermark. caller guarantee this re-check and a cannot inverse action (SDK abort/submit
   * invoke) between without any event loop let out - - single thread inside markOwnership cannot insert,
   * this is human hard rule race window truly close point.
   */
  assertMutationGuard(id: number, guard: GuardedMutationExpectation): void {
    // getOwnership for missing/already delete (tombstone) conversation explicit not_found- - explicit target
    // expires directly reject, never by default routing mask.
    const ownedBy = this.o.ownershipOf(id)
    if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
      throw new HelmError(
        'ownership_conflict',
        `conversation ${id} when before ownership ${ownedBy}${guard.expectedOwnership !== undefined ? `(expectation ${guard.expectedOwnership})` : ''}, reject automatically change (human hard rule)`,
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
        throw new HelmError('not_found', `conversation missing:${id}`, 404, { conversationId: id })
      }
      if (meta.stateChangeSeq !== guard.expectedStateSeq) {
        throw new HelmError(
          'state_seq_conflict',
          `conversation ${id} right threat watermark ${meta.stateChangeSeq} and expectation ${guard.expectedStateSeq} inconsistent (probe needle fact expired, must not effect at new turn)`,
          409,
          { conversationId: id, currentSeq: meta.stateChangeSeq, expectedSeq: guard.expectedStateSeq },
        )
      }
    }
  }

  /**
   * automatically guarded abort: guard re-check and SDK abort invoke (a cannot inverse action) in
   * the same serial domain inside back rely back execute (zero await interval); re-check failed never start abort.
   * ordinary abortConversation semantics do not change (person class/CLI path do not bind set automatically guard).
   *
   * each other self fit should (take proxy old dedicated use prepareInterruptedConversations):
   * - SDK scheduler running:SDK Conversation.abort + wait for idle (since has semantics,
   *   hot path zero extra await- - run in cancel must not because each other probe while change slow);
   * - scheduler paused(service prepare screen fault,resume before): for conversation name under all store
   *   SDK task one by one commit durable abort mark record (harness.abortTask: do not resume,
   *   do not etc. compute), each cannot inverse action before sync re-check ownership (human one rule reject) - -
   *   restore orchestration based on this in scheduler start before durable cancel itself register interrupt sub-conversation.
   */
  async abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, async () => {
      // restore screen fault path: only when kernel not yet complete start(lifecycle fact, non- mirror state) when
      // only then pay once only read inspect right threat each other re-check; mark record before one by one task sync re-check (human
      // hard rule override restore window, optimal at old dedicated use method without guard batch amount cancel).
      if (!this.o.isStarted()) {
        const inspection = await this.harness.inspect(BACKGROUND_CONTEXT)
        if (inspection.scheduling === 'paused') {
          let matched = false
          for (const task of inspection.tasks) {
            if (task.record.conversationId !== (id as never)) continue
            matched = true
            // and under way abortTask invoke between zero await(single thread inside ownership cannot insert).
            this.assertMutationGuard(id, guard)
            await this.harness.abortTask(task.record.id, BACKGROUND_CONTEXT)
          }
          if (!matched) {
            // conversation name under without store task also must verify conversation store in + ownership: missing not_found,
            // human reject, never to human/idle target return succeeded.
            this.assertMutationGuard(id, guard)
          }
          return
        }
        // unexpected running(autoResume:false process first commit after, not yet start): back common rule path.
      }
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
      // eventually re-check: and under way abort invoke between zero await(on way await window inside ownership translate rotate in this intercept).
      this.assertMutationGuard(id, guard)
      const wasBusy = this.tracker.hasLiveWork(id)
      await conversation.abort(BACKGROUND_CONTEXT)
      if (wasBusy) this.tracker.settleAborted(id)
      else this.tracker.clearQueuedTracking(id)
      this.o.evictHandledToolCalls(id)
    })
  }

  /**
   * automatically guarded commit: entry sync fast inspect (fail-fast, zero side effect) after away complete input pipeline;
   * hook/model parse etc. prepare work after completion, in commit point (SDK submit invoke before) atomic re-check
   * (see ConversationInputPipeline.submitFreshInput). re-check failed produces no commit side effect.
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
      throw new HelmError('validation_error', 'guarded commit whenIdle only allows reject', 400)
    }
    if (opts?.replaceFromEntryId !== undefined) {
      throw new HelmError(
        'validation_error',
        'automatically guarded commit unsupported replaceFromEntryId(automatically do not heavy write history)',
        400,
        { conversationId: id, replaceFromEntryId: opts.replaceFromEntryId },
      )
    }
    this.contextOps.assertOpen()
    // entry fast inspect: any durable side effect (hook observe/title derive/commit) before reject.
    this.assertMutationGuard(id, guard)
    return this.submitInput(id, text, { ...opts, mutationGuard: guard })
  }

  // ------------------------------------------------------------------
  // summary and ownership throw shoot
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
  // detail situation page and FTS rebuild (delegate to detailOps)
  // ------------------------------------------------------------------

  async getConversationDetail(id: number, options?: { limit?: number; cursor?: string }): Promise<ConversationDetail> {
    // contextUsage refresh and timeline page in detailOps inside parallel, two leg after completion heavy take
    // right threat summary merge (see conversation-detail.ts); any one leg failed whole reject.
    return this.detailOps.getConversationDetail(id, options)
  }

  /** single timeline item (not truncate, already redaction;rewind visible and detail situation page consistent). */
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
  // Profile / model inherit chain (delegate to profileAlignment)
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
      throw new HelmError('validation_error', `profile missing:${requested}(first create profiles/${requested})`, 400)
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
    /** cwd by target node platform unify consolidate (term method specification; zero disk access; broken POSIX cwd do not written to the database). */
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
        `conversation bind set remote node ${nodeId} but not provide cwd(Profile.cwd / parent conversation cwd / init.cwd all missing; reject blind run node by default directory)`,
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
        throw new HelmError('validation_error', `profile missing:${patch.profileId}`, 400)
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
          `thinkingLevel '${level}' illegal; legal value:${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinkingOverride = level || undefined
    }
    const nextProfileId = patch.profileId ?? meta.profileId
    const effectiveModel = await this.resolveEffectiveModel(nextOverride, nextProfileId)
    const effectiveRef = effectiveModel ? this.o.parseModelRefOrThrow(effectiveModel) : undefined
    // model/Profile change after: explicit think override same by target model capability converge to SDK
    // available Profile (single one consolidate clampThinkingLevelForModel; capability unknown when pass-through do not break contract).
    const clampedOverride = effectiveRef
      ? clampThinkingLevelForModel(this.o.models(), effectiveRef, nextThinkingOverride)
      : nextThinkingOverride
    const nextThinking = await this.resolveEffectiveThinkingLevel(clampedOverride, nextProfileId, effectiveRef)
    // explicit cwd, or nodeId migration when since has cwd, all by new target node platform unify consolidate,
    // again enter SDK configure and mirror persist; broken POSIX cwd explicit reject.
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
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
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
    // model/think Profile change after window and threshold may change: trigger context use amount heavy compute (dedupe).
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
        `conversation ${id} correct by plugin manage (${owners.join(', ')}), first release manage right again delete`,
        409,
        { conversationId: id, owners },
      )
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    // level join cancel wait for real;IO failed must to on reject(block stop after continue delete side effect),
    // never swallow wrong very succeeded.
    await this.o.cancelAsksByConversation(id)
    await this.artifactsSvc.deleteConversation(id)
    // in-memory secret sync reclaim (contains only used to redaction old value): conversation delete i.e. completely release.
    this.stash.clear(id)
    this.events.publish('notification', {
      level: 'info',
      title: 'conversation deleted',
      body: `conversation ${id} and its artifact/await answer AskDoc/memory secret already clean up`,
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
  // artifact authorization and attachment (delegate to attachments)
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
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)

    if (opts?.requestId !== undefined) {
      if (typeof opts.requestId !== 'string' || opts.requestId.trim() === '') {
        throw new HelmError('validation_error', 'internal requestId must is non-empty string', 400)
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
        `conversation ${id}(profile ${convMeta.profileId}) and global all not config model: please in Profile,HELM_MODEL,config.json.model or conversation in config model`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    // takes effect model by disable (such as by default model matter after by disable): commit entry reject, never static default fall back other model.
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
    // guarded commit: hook execute after, any durable side effect (handled take over return/title derive/
    // commit) before re-check; eventually atomic re-check in commit point (submitFreshInput) execute.
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
      // guarded commit serial gate: only override commit point re-check + SDK submit invoke critical zone,
      // input hook in gate outside execute (hook inside again guarded change will not deadlock).
      return this.withMutationGate(id, () => this.inputPipeline.submitFreshInput(conversation, id, freshSubmission))
    }
    return this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
  }

  // ------------------------------------------------------------------
  // original ground override heavy delegate (directly invoke/test compatibility)
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

  async waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> {
    if (submissionId.startsWith('handled:')) {
      throw new HelmError(
        'wait_not_applicable',
        `commit ${submissionId} by input hook take over, without real turn can wait for`,
        409,
        { conversationId: id, submissionId },
      )
    }
    const numericId = Number(submissionId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new HelmError('validation_error', `illegal submissionId:${submissionId}`, 400)
    }
    requireConv(this.store, id)
    const waitContext = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
    const waitAbortedError = (): HelmError =>
      new HelmError('aborted', `wait for conversation ${id} commit ${submissionId} result cancelled`, 499, {
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
      throw new HelmError('not_found', `commit missing:${submissionId}`, 404, {
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
      throw new HelmError('not_found', `commit ${submissionId} do not belongs to conversation ${id}`, 404, {
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
        `conversation ${id} this round not obtain answer (${reason}${settled.detail !== undefined ? `:${String(settled.detail)}` : ''})`,
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
      throw new HelmError('turn_failed', `commit ${submissionId} compute is non- terminal state ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    const conversation = await runWaitOp(() => this.harness.conversation(id as never, waitContext))
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
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
      throw new HelmError('not_found', `answer item missing:${settled.answer}`, 502, {
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
    if (this.o.isClosed()) throw new HelmError('runtime_closed', 'kernel is now close, reject withdraw back', 503)
    requireConv(this.store, id)
    const raw = opts.submissionId
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError('validation_error', `submissionId must be security positive integer (receives ${String(raw)})`, 400, {
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
      throw new HelmError('not_found', `commit ${raw} in conversation ${id} in missing`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    const outcome = await this.harness.abortSubmission(raw as never, BACKGROUND_CONTEXT, id as never)
    if (outcome === 'not_found') {
      throw new HelmError('not_found', `commit ${raw} in conversation ${id} in missing`, 404, {
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
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
    const wasBusy = this.tracker.hasLiveWork(id)
    await conversation.abort(BACKGROUND_CONTEXT)
    if (wasBusy) this.tracker.settleAborted(id)
    else this.tracker.clearQueuedTracking(id)
    this.o.evictHandledToolCalls(id)
  }

  // ------------------------------------------------------------------
  // reset / compact / fork(delegate to contextOps)
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

  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertWritable()
    return this.contextOps.forkConversation(id, opts)
  }

  // ------------------------------------------------------------------
  // waitForIdle / getLastAssistantText / search / recover
  // ------------------------------------------------------------------

  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
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
