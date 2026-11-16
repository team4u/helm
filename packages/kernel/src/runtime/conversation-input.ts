/**
 * 会话输入管道模块：钩子调度、输入脱敏、标题派生与新提交执行。
 *
 * 职责：
 * - input 钩子应用（支持 block 拦截、handled 接管、transform 改写）；
 * - 提交元数据与正文全局脱敏（SecretStash）；
 * - 缺省 whenBusy 插话（steer）有效默认固化；
 * - 钩子产物附件二次授权校验；
 * - 会话首条输入自动派生标题；
 * - 全新输入提交到 SDK harness 并与 tracker 登记绑定。
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
  /** guarded mutation 提交点复核（同步、零 await；宿主即 ConversationService.assertMutationGuard）。 */
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
   * input 钩子应用 + 最终输入固化：
   * 返回 handled（接管）或最终 { finalInput, finalWhenBusy, effectiveText, resolvedAttachments }。
   */
  async prepareInput(
    id: number,
    text: string,
    opts: SubmitInputOptions | undefined,
    initialAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined,
  ): Promise<PreparedInputResult> {
    const origin = opts?.origin ?? 'human'
    if (opts?.requestId !== undefined && (typeof opts.requestId !== 'string' || opts.requestId.trim() === '')) {
      throw new HelmError('validation_error', '内部 requestId 必须为非空字符串', 400)
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

  /** 首输入自动标题（派生自脱敏后文本；stateChangeSeq 同步推进）。 */
  applyFirstInputTitle(meta: ConvMeta, effectiveText: string): void {
    if (meta.title !== '') return
    const title = deriveTitle(effectiveText)
    this.host.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
  }

  /** 新输入 SDK 提交（非 rewind 路径；tracker 登记与失败撤销）。 */
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
      /** guarded mutation：提交点原子复核载荷（普通提交缺省）。 */
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
      // 原子核对 pi.live：SDK admitSubmission 只看 live.run 而不看 live.compactions，
      // 在无活跃 run 但存在进行中压缩任务时，在此事务内把输入排入 pi.inbox（或 reject），
      // 避免新回合在未精简的旧上下文上抢跑。
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
              `会话 ${id} 正在精简上下文，拒绝提交（whenBusy=reject）`,
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

      // 提交点最终复核：与下方 SDK submit 调用（第一个不可逆动作）之间零
      // await——上方全部准备工作窗口内的归属翻转在此拦截，绝不产生提交。
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
