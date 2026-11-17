/**
 * Conversation domain routes: /api/conversations (list/create/detail/update/delete/input/
 * withdraw/abort/reset/compact/fork/entries/:entryId/artifacts), /api/asks
 * (approval queue), and /api/search (full-text index search).
 */
import type { ConversationListFilter, ConversationStatus } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { buildContentDisposition, errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
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
      throw new HelmError('not_implemented', 'current runtime does not support reading a single entry', 501)
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
      throw new HelmError('not_implemented', 'current runtime does not support withdrawing queued input', 501)
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
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationForkBody)
    return jsonOk(redactor, await kernel.forkConversation(id, opts), { status: 201 })
  }
  if (third === 'artifacts' && method === 'GET' && fourth === undefined) {
    return jsonOk(redactor, await kernel.artifacts.list(id))
  }
  if (third === 'artifacts' && method === 'POST' && fourth === undefined) {
    return postConversationArtifact(ctx, kernel, id, redactor)
  }
  if (third === 'files' && fourth === 'content' && ctx.segments[4] === undefined) {
    if (method !== 'GET') return methodNotAllowed(redactor, method)
    const rawPath = ctx.url.searchParams.get('path')
    if (rawPath === null || rawPath.trim() === '') {
      throw new ValidationError('path query parameter cannot be empty')
    }
    const inline = parseOptionalBooleanFlag(ctx.url, 'inline') === true
    if (kernel.readConversationFile === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support reading conversation workspace files', 501)
    }
    const result = await kernel.readConversationFile(id, rawPath, ctx.request.signal)
    const headers: Record<string, string> = {
      'content-type': result.mimeType,
      'content-length': String(result.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': buildContentDisposition(result.name, inline),
    }
    if (inline && (result.mimeType.startsWith('text/html') || result.mimeType.startsWith('image/svg+xml'))) {
      headers['content-security-policy'] = 'sandbox'
    }
    return new Response(result.bytes as unknown as BodyInit, { headers })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/asks (approval queue, belongs to conversation domain alongside conversations)
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
  return errorResponse(redactor, 404, 'not_found', 'route not found')
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
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  const q = ctx.url.searchParams.get('q') ?? ''
  if (q.trim().length === 0) throw new ValidationError('q cannot be empty')
  return jsonOk(redactor, await kernel.search(q))
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function parseConversationFilter(url: URL): ConversationListFilter {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
    throw new ValidationError('status must be working|blocked|done|idle|error')
  }
  // Low-noise default: only top-level conversations when neither parent nor all is specified;
  // child conversations are queried explicitly via ?parent=<id> or listed together via ?all=1.
  // The two are mutually exclusive—return 400 rather than guessing precedence.
  const parentRaw = url.searchParams.get('parent')
  const all = parseOptionalBooleanFlag(url, 'all')
  if (parentRaw !== null && all === true) {
    throw new ValidationError('all and parent are mutually exclusive: cannot specify both full listing and parent conversation filter')
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

/** ?wait=1 query parameter: only accepts '1' (or 'true'); any other value fails with 400. */
function parseWaitFlag(url: URL): boolean {
  const raw = url.searchParams.get('wait')
  if (raw === null) return false
  if (raw === '1' || raw === 'true') return true
  throw new ValidationError('wait must be 1 (e.g. ?wait=1)')
}
