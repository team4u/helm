/**
 * 会话领域路由：/api/conversations（列表/创建/详情/更新/删除/input/
 * withdraw/abort/reset/compact/fork/artifacts）、/api/asks（审批队列）、
 * /api/search（全文检索）。
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
    return jsonOk(redactor, await kernel.waitForInput(id, submissionId))
  }
  if (third === 'withdraw' && method === 'POST' && fourth === undefined) {
    if (kernel.withdrawQueuedInput === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供排队输入撤回', 501)
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
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

// ---------------------------------------------------------------------------
// /api/asks（审批队列，与会话同属会话领域）
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
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
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
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }
  const q = ctx.url.searchParams.get('q') ?? ''
  if (q.trim().length === 0) throw new ValidationError('q 不能为空')
  return jsonOk(redactor, await kernel.search(q))
}

// ---------------------------------------------------------------------------
// 领域内辅助
// ---------------------------------------------------------------------------

function parseConversationFilter(url: URL): ConversationListFilter {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
    throw new ValidationError('status 需为 working|blocked|done|idle|error')
  }
  // 降噪缺省：未显式指定 parent/all 时仅顶层会话；子会话经 ?parent=<id> 精确查看
  // 或 ?all=1 全量列出。两者互斥，组合请求直接 400（不猜测优先级）。
  const parentRaw = url.searchParams.get('parent')
  const all = parseOptionalBooleanFlag(url, 'all')
  if (parentRaw !== null && all === true) {
    throw new ValidationError('all 与 parent 互斥：全量列出与精确于会话过滤不可同时指定')
  }
  let parentConversationId: number | undefined
  if (parentRaw !== null) {
    if (!/^\d+$/.test(parentRaw) || !Number.isSafeInteger(Number(parentRaw)) || Number(parentRaw) < 1) {
      throw new ValidationError('parent 需为正整数会话 ID')
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

/** ?wait=1 查询参数：仅接受字面 '1'（true 同义）；其他值 400。 */
function parseWaitFlag(url: URL): boolean {
  const raw = url.searchParams.get('wait')
  if (raw === null) return false
  if (raw === '1' || raw === 'true') return true
  throw new ValidationError('wait 需为 1（如 ?wait=1）')
}
