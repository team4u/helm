/**
 * conversation input pipeline module: hook scheduling, input redaction, title derive and new commit execute.
 *
 * responsibility:
 * - input hook should use (support block intercept,handled take over,transform change write);
 * - commit metadata and body text global redaction (SecretStash);
 * - default whenBusy insert speech (steer) valid by default solid;
 * - hook artifact attachment second authorization validate;
 * - conversation first input automatically derive title;
 * - all new input commit to SDK harness and and tracker register bind set.
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
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { redactJsonValue } from '../redact.js'
import type { SecretStash } from '../services/index.js'
import { deriveTitle, type ConversationTracker } from './conversations.js'
import { normalizeBusyError } from './runtime-helpers.js'
import { asConversationId } from './sdk-ids.js'
import type { SubmitInputOptions } from './conversation-service.js'
import type { ConvMeta, HelmStore } from './store.js'

export interface ConversationInputPipelineHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly stash: SecretStash
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  readonly resolveAuthorizedAttachments: (
    conversationId: number,
    attachmentIds: readonly string[],
  ) => Promise<Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>>
  /** guarded mutation commit point re-check (sync, zero await; host i.e. ConversationService.assertMutationGuard). */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
}

export type PreparedInputResult =
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
   * input hook should use + eventually input solid:
   * return handled(take over) or eventually { finalInput, finalWhenBusy, effectiveText, resolvedAttachments }.
   */
  async prepareInput(
    id: number,
    text: string,
    opts: SubmitInputOptions | undefined,
    initialAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined,
  ): Promise<PreparedInputResult> {
    const origin = opts?.origin ?? 'human'
    if (opts?.requestId !== undefined && (typeof opts.requestId !== 'string' || opts.requestId.trim() === '')) {
      throw new HelmError('validation_error', 'internal requestId must is non-empty string', 400)
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
      throw new HelmError('input_blocked', hookOutcome.reason ?? 'input by input hook intercept')
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
          `input hook must not change write conversationId(${id} -> ${String(value.conversationId)})`,
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

  /** first input automatically title (derive self redaction after text;stateChangeSeq sync push enter). */
  applyFirstInputTitle(meta: ConvMeta, effectiveText: string): void {
    if (meta.title !== '') return
    const title = deriveTitle(effectiveText)
    this.host.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
  }

  /** new input SDK commit (non- rewind path;tracker register and failed undo). */
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
      /** guarded mutation: commit point atomic re-check payload (ordinary commit default). */
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
      // atomic core for pi.live:SDK admitSubmission only see live.run while do not see live.compactions,
      // in without leap run but store in in progress compress task when, in this transaction inside input arrange pi.inbox(or reject),
      // avoid new turn in not streamline old context on grab run.
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
            throw new HelmError(
              'conversation_busy',
              `conversation ${id} is now streamline context, reject commit (whenBusy=reject)`,
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
              kind: 'helm.input',
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

      // commit point eventually re-check: and under way SDK submit invoke (a cannot inverse action) between zero
      // await- - on way all prepare work window inside ownership translate rotate in this intercept, never produce commit.
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
            kind: 'helm.input',
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
