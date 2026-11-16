/**
 * conversation domain routing:/api/conversations(list/create/detail situation/update/delete/input/
 * withdraw/abort/reset/compact/fork/entries/:entryId/artifacts),/api/asks
 * (approval queue),/api/search(all text inspect index).
 */
import type { ConversationListFilter, ConversationStatus } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import type { KernelRuntimeLike } from './contracts.js'
import {
  parseAskAnswerBody,
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseConversationWithdrawBody,
  parseDetailPagination,
  parseIdParam,
  parseInputBody,
  requireIdParam,
  ValidationError,
} from './validate.js'
import { methodNotAllowed, parseOptionalBooleanFlag, parseOptionalJsonObjectBody, type RouteContext } from './route-context.js'
import { postConversationArtifact } from './asset-routes.js'

export async function handleConversationsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]

  if (second === undefined) {
    if (method === 'GET') {
      return jsonOk(redactor, await kernel.listConversations(parseConversationFilter(ctx.url)))
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx.request)
      return jsonOk(redactor, await kernel.createConversation(parseConversationInit(body)), { status: 201 })
    }
    return methodNotAllowed(redactor, method)
  }
  const id = parseIdParam(second)
  if (third === undefined) {
    if (method === 'GET') {
      return jsonOk(redactor, await kernel.getConversationDetail(id, parseDetailPagination(ctx.url)))
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx.request)
      return jsonOk(redactor, await kernel.updateConversation(id, parseConversationPatch(body)))
    }
    if (method === 'DELETE') {
      await kernel.deleteConversation(id)
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  if (third === 'entries' && method === 'GET' && fourth !== undefined && ctx.segments[4] === undefined) {
    if (kernel.getConversationEntry === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide single item read', 501)
    }
    return jsonOk(redactor, await kernel.getConversationEntry(id, parseIdParam(fourth, 'entryId')))
  }
  if (third === 'input' && method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { text, whenBusy, origin, meta, attachments, replaceFromEntryId } = parseInputBody(body)
    const wait = parseWaitFlag(ctx.url)
    const { submissionId } = await kernel.submitInput(id, text, {
      ...(origin !== undefined ? { origin } : {}),
      ...(whenBusy !== undefined ? { whenBusy } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(replaceFromEntryId !== undefined ? { replaceFromEntryId } : {}),
    })
    if (!wait) return jsonOk(redactor, { submissionId }, { status: 202 })
    return jsonOk(redactor, await kernel.waitForInput(id, submissionId, ctx.request.signal))
  }
  if (third === 'withdraw' && method === 'POST' && fourth === undefined) {
    if (kernel.withdrawQueuedInput === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide queue up input withdraw back', 501)
    }
    const body = await readJsonBody(ctx.request)
    const parsed = parseConversationWithdrawBody(body)
    return jsonOk(redactor, await kernel.withdrawQueuedInput(id, parsed))
  }
  if (third === 'abort' && method === 'POST' && fourth === undefined) {
    await kernel.abortConversation(id)
    return jsonOk(redactor, { ok: true })
  }
  if (third === 'reset' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationResetBody)
    return jsonOk(redactor, await kernel.resetConversation(id, opts))
  }
  if (third === 'compact' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationCompactBody)
    return jsonOk(redactor, await kernel.compactConversation(id, opts), { status: 202 })
  }
  if (third === 'fork' && method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    return jsonOk(redactor, await kernel.forkConversation(id, parseConversationForkBody(body)), { status: 201 })
  }
  if (third === 'artifacts' && method === 'GET' && fourth === undefined) {
    return jsonOk(redactor, await kernel.artifacts.list(id))
  }
  if (third === 'artifacts' && method === 'POST' && fourth === undefined) {
    return postConversationArtifact(ctx, kernel, id, redactor)
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

// ---------------------------------------------------------------------------
// /api/asks(approval queue, and conversation same belong conversation domain)
// ---------------------------------------------------------------------------

export async function handleAsksDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listAsks())
  }
  const askId = requireIdParam(second ?? '', 'askId')
  if (third === 'answer' && method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { answers, expectedStateSeq } = parseAskAnswerBody(body)
    await kernel.answerAsk(askId, answers, expectedStateSeq)
    return jsonOk(redactor, { ok: true })
  }
  if (third === 'cancel' && method === 'POST' && fourth === undefined) {
    await kernel.cancelAsk(askId)
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

// ---------------------------------------------------------------------------
// /api/search
// ---------------------------------------------------------------------------

export async function handleSearchDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.method !== 'GET' || ctx.segments[1] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'routing missing')
  }
  const q = ctx.url.searchParams.get('q') ?? ''
  if (q.trim().length === 0) throw new ValidationError('q cannot be empty')
  return jsonOk(redactor, await kernel.search(q))
}

// ---------------------------------------------------------------------------
// domain inside auxiliary
// ---------------------------------------------------------------------------

function parseConversationFilter(url: URL): ConversationListFilter {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
    throw new ValidationError('status must be working|blocked|done|idle|error')
  }
  // drop noise default: not explicit designate parent/all when only top-level conversation; sub-conversation via ?parent=<id> precise view
  // or ?all=1 all amount column out. two mutual exclusion, combine request directly 400(do not guess priority).
  const parentRaw = url.searchParams.get('parent')
  const all = parseOptionalBooleanFlag(url, 'all')
  if (parentRaw !== null && all === true) {
    throw new ValidationError('all and parent mutual exclusion: all amount column out and precise at conversation filter cannot also designate')
  }
  let parentConversationId: number | undefined
  if (parentRaw !== null) {
    if (!/^\d+$/.test(parentRaw) || !Number.isSafeInteger(Number(parentRaw)) || Number(parentRaw) < 1) {
      throw new ValidationError('parent must be a positive integer conversation ID')
    }
    parentConversationId = Number(parentRaw)
  }
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(status !== undefined ? { status: status as ConversationStatus } : {}),
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(parentConversationId === undefined && all !== true ? { topLevelOnly: true } : {}),
  }
}

/** ?wait=1 query parameter: only accept literal '1'(true same meaning); other value 400. */
function parseWaitFlag(url: URL): boolean {
  const raw = url.searchParams.get('wait')
  if (raw === null) return false
  if (raw === '1' || raw === 'true') return true
  throw new ValidationError('wait must be 1(such as ?wait=1)')
}
