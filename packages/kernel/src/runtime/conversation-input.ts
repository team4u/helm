/**
 * Conversation input pipeline: hook scheduling, input redaction, title derivation, and fresh submission execution.
 *
 * Responsibilities:
 * - Run input hooks (supporting block interception, handled takeover, and transform rewriting);
 * - Globally redact submission metadata and body text (SecretStash);
 * - Pin default whenBusy to 'steer';
 * - Re-authorize artifact attachments added/modified by hooks;
 * - Auto-derive conversation title from first input;
 * - Submit new inputs to SDK harness and correlate bindings with tracker.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { copyJson, type JsonRepresentation } from '@earendil-works/chord/json'
import { InboxDoc, LiveDoc, type Harness, type UserInput } from '@earendil-works/pi-durable'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationInput,
  GuardedMutationExpectation,
  WhenBusy,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { randomUUID } from 'node:crypto'
import { redactJsonValue } from '../redact.js'
import type { SecretStash } from '../services/index.js'
import { deriveTitle, type ConversationTracker } from './conversations.js'
import { normalizeBusyError } from './runtime-helpers.js'
import { asConversationId } from './sdk-ids.js'
import type { SubmitInputOptions } from './conversation-service.js'
import type { ConvMeta, HelmxStore } from './store.js'

interface ConversationInputPipelineHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly stash: SecretStash
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  readonly resolveAuthorizedAttachments: (
    conversationId: number,
    attachmentIds: readonly string[],
  ) => Promise<Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>>
  /** Commit-point re-check for guarded mutations (synchronous, zero awaits; ConversationService.assertMutationGuard). */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
}

type PreparedInputResult =
  | { kind: 'handled'; submissionId: string }
  | {
      kind: 'final'
      finalInput: ConversationInput
      finalWhenBusy: WhenBusy
      effectiveText: string
      resolvedAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined
    }

export class ConversationInputPipeline {
  constructor(private readonly host: ConversationInputPipelineHost) {}

  /**
   * Apply input hooks and finalize input shape:
   * returns either handled (taken over) or finalized { finalInput, finalWhenBusy, effectiveText, resolvedAttachments }.
   */
  async prepareInput(
    id: number,
    text: string,
    opts: SubmitInputOptions | undefined,
    initialAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined,
  ): Promise<PreparedInputResult> {
    const origin = opts?.origin ?? 'human'
    if (opts?.requestId !== undefined && (typeof opts.requestId !== 'string' || opts.requestId.trim() === '')) {
      throw new HelmxError('validation_error', 'internal requestId must be a non-empty string', 400)
    }
    const inputId = opts?.requestId ?? randomUUID()
    const createdAt = Date.now()
    const safeMeta =
      opts?.meta !== undefined
        ? (redactJsonValue(opts.meta, (t) => this.host.stash.redact(t)) as Record<string, unknown>)
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
    const hookOutcome = await this.host.runInputHook(payload)
    if (hookOutcome?.action === 'block') {
      throw new HelmxError('input_blocked', hookOutcome.reason ?? 'input blocked by input hook')
    }
    if (hookOutcome?.action === 'handled') {
      return { kind: 'handled', submissionId: `handled:${randomUUID()}` }
    }
    let finalInput: ConversationInput = payload.input
    let finalWhenBusy: WhenBusy | undefined = opts?.whenBusy
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as typeof payload
      if (value.conversationId !== id) {
        throw new HelmxError(
          'input_identity_changed',
          `input hook must not change conversationId (${id} -> ${String(value.conversationId)})`,
          400,
        )
      }
      finalInput = value.input
      finalWhenBusy = finalInput.whenBusy ?? finalWhenBusy
    }
    finalWhenBusy = finalWhenBusy ?? 'steer'
    finalInput = { ...finalInput, whenBusy: finalWhenBusy }
    const finalIds = finalInput.attachments?.map((a) => a.id) ?? []
    const resolvedAttachments =
      finalIds.length > 0
        ? await this.host.resolveAuthorizedAttachments(id, finalIds)
        : finalIds.length === 0 && initialAttachments !== undefined
          ? undefined
          : initialAttachments

    if (finalInput.meta !== undefined) {
      finalInput = {
        ...finalInput,
        meta: redactJsonValue(finalInput.meta, (t) => this.host.stash.redact(t)) as Record<string, unknown>,
      }
    }
    const effectiveText = this.host.stash.redact(finalInput.text)
    finalInput = {
      ...finalInput,
      text: effectiveText,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }
    return { kind: 'final', finalInput, finalWhenBusy, effectiveText, resolvedAttachments }
  }

  /** Auto-title on first input (derived from redacted text; advances stateChangeSeq synchronously). */
  applyFirstInputTitle(meta: ConvMeta, effectiveText: string): void {
    if (meta.title !== '') return
    const title = deriveTitle(effectiveText)
    this.host.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
  }

  /** Submit fresh input to SDK (non-rewind path; handles tracker registration and rollback on failure). */
  async submitFreshInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    prepared: {
      finalInput: ConversationInput
      finalWhenBusy: WhenBusy
      effectiveText: string
      resolvedAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
      requestId: string | undefined
      whenIdle?: 'reject'
      /** Guarded mutation commit-point atomic re-check payload (omitted for normal submissions). */
      mutationGuard?: GuardedMutationExpectation
    },
  ): Promise<{ submissionId: string }> {
    const { finalInput, finalWhenBusy, effectiveText, resolvedAttachments, content, mutationGuard } = prepared
    const requestId = prepared.requestId ?? finalInput.id
    const entryData = copyJson(
      {
        id: finalInput.id,
        text: effectiveText,
        origin: finalInput.origin,
        createdAt: finalInput.createdAt,
        whenBusy: finalWhenBusy,
        ...(finalInput.meta !== undefined ? { meta: finalInput.meta } : {}),
        ...(resolvedAttachments !== undefined
          ? { attachments: resolvedAttachments.map((r) => r.ref) }
          : {}),
      },
      { omitUndefinedProperties: true },
    )
    this.host.tracker.registerInput(id, finalInput)
    try {
      // Atomically check pi.live: SDK admitSubmission inspects live.run but not live.compactions;
      // when idle with an active compaction task, enqueue into pi.inbox (or reject) inside this transaction
      // so the new turn does not race ahead on uncompacted context.
      const convId = asConversationId(id)
      const queueResult = await conversation.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, convId)
        const inbox = await tx.doc(InboxDoc, convId)
        const existing = await tx.submissionByRequest(convId, requestId)
        if (existing !== undefined) {
          if (existing.type !== 'input') {
            throw new Error(`Request ${requestId} already identifies a submission of type ${existing.type}`)
          }
          return { handled: true as const, submissionId: existing.id as number }
        }
        if (live.run === undefined && (live.compactions?.length ?? 0) > 0 && prepared.whenIdle !== 'reject') {
          if (finalWhenBusy === 'reject') {
            throw new HelmxError(
              'conversation_busy',
              `conversation ${id} is currently compacting context; rejecting submission (whenBusy=reject)`,
              409,
              { conversationId: id },
            )
          }
          if (mutationGuard !== undefined) {
            this.host.assertMutationGuard(id, mutationGuard)
          }
          const sub = await tx.createSubmission({
            conversationId: convId,
            requestId,
            type: 'input',
            status: 'queued',
          })
          inbox.items.push({
            id: sub.id,
            mode: finalWhenBusy === 'steer' ? 'steer' : 'followUp',
            content: copyJson(content, { omitUndefinedProperties: true }) as JsonRepresentation<UserInput>,
            entry: {
              kind: 'helmx.input',
              data: entryData,
            },
          })
          return { handled: true as const, submissionId: sub.id as number }
        }
        return { handled: false as const }
      }, BACKGROUND_CONTEXT)
      if (queueResult.handled) {
        this.host.tracker.bindSubmission(id, finalInput.id, queueResult.submissionId)
        return { submissionId: String(queueResult.submissionId) }
      }

      // Final commit-point re-check: zero awaits before the subsequent SDK submit call,
      // catching any ownership shift during preparation without producing a submission.
      if (mutationGuard !== undefined) {
        this.host.assertMutationGuard(id, mutationGuard)
      }
      const submission = await conversation.submit(
        {
          type: 'input',
          content,
          whenBusy: finalWhenBusy,
          ...(prepared.whenIdle !== undefined ? { whenIdle: prepared.whenIdle } : {}),
          entry: {
            kind: 'helmx.input',
            data: entryData,
          },
          requestId,
        },
        BACKGROUND_CONTEXT,
      )
      this.host.tracker.bindSubmission(id, finalInput.id, submission.id as number)
      return { submissionId: String(submission.id) }
    } catch (error) {
      this.host.tracker.dropInput(id, finalInput.id)
      throw normalizeBusyError(error)
    }
  }
}
