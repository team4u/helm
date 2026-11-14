/**
 * 节点领域路由：/api/nodes（清单/签发/移除/升级/端口转发）与
 * POST /api/env/exec（跨节点命令执行，NDJSON 流式或 JSON 一次性）。
 */
import { HelmError } from '@helm/protocol'
import type { EnvExecStreamFrame, JsonSchema } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { isAbsoluteTargetPath } from '@helm/protocol'
import { jsonOk, errorResponse, readJsonBody, type JsonRedactor } from './http-utils.js'
import { decodeSegment } from './route-match.js'
import type { KernelRuntimeLike } from './contracts.js'
import { assertBodySchema, NODE_ID_PATTERN_SOURCE, ValidationError } from './validate.js'
import type { RouteContext } from './route-context.js'
import { parseOptionalJsonObjectBody, readOptionalJsonBody } from './route-context.js'

export async function handleNodeDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]

  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listNodes())
  }
  if (second === 'issue' && method === 'POST' && third === undefined) {
    const body = await readJsonBody(ctx.request)
    assertBodySchema(NODE_ISSUE_BODY_SCHEMA, body, 'nodes issue body')
    const issued = await kernel.issueNodeToken(body.nodeId as string)
    // 明文 token 仅本次响应一次性返回（此后任何 JSON 输出都不可再见明文：
    // token 已入出站脱敏登记）。此处不能经统一 redactor（会把 token 换成
    // [REDACTED]）：手写响应体，只透出契约字段。
    return new Response(
      JSON.stringify({ nodeId: issued.nodeId, token: issued.token, createdAt: issued.createdAt }),
      {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }
  if (second !== undefined && third === undefined && method === 'DELETE') {
    const nodeId = requireNodeSegment(second)
    await kernel.removeNode(nodeId)
    return jsonOk(redactor, { ok: true })
  }
  // ---- 节点升级：GET /:id/upgrade/check、POST /:id/upgrade -----------------
  if (second !== undefined && third === 'upgrade') {
    const nodeId = requireNodeSegment(second)
    if (fourth === 'check' && method === 'GET') {
      if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')
      if (kernel.checkNodeUpgrade === undefined) {
        throw new HelmError('not_implemented', '当前 runtime 未提供节点升级检查', 501)
      }
      return jsonOk(redactor, await kernel.checkNodeUpgrade(nodeId, parseNodeUpgradeCheckQuery(ctx.url)))
    }
    if (fourth === undefined && method === 'POST') {
      if (kernel.upgradeNode === undefined) {
        throw new HelmError('not_implemented', '当前 runtime 未提供节点升级', 501)
      }
      const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeUpgradeBody)
      return jsonOk(redactor, await kernel.upgradeNode(nodeId, body))
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }
  // ---- 前台端口转发：POST /:id/forward、forward 清单/详情/事件/停止 ----------
  if (second !== undefined && third === 'forward' && fourth === undefined && method === 'POST') {
    if (kernel.startNodeForward === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供节点端口转发', 501)
    }
    const nodeId = requireNodeSegment(second)
    const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeForwardBody)
    return jsonOk(redactor, await kernel.startNodeForward(nodeId, body), { status: 201 })
  }
  if (second === 'forward') {
    return handleForwardSubtree(ctx, kernel, redactor)
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

/** GET /api/nodes/forward 清单 / :id 详情 / :id/events 事件流 / DELETE :id 停止。 */
async function handleForwardSubtree(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]
  // GET /api/nodes/forward：活动转发清单。
  if (third === undefined && method === 'GET') {
    if (kernel.listNodeForwards === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供节点端口转发', 501)
    }
    return jsonOk(redactor, kernel.listNodeForwards())
  }
  const forwardId = third
  if (forwardId !== undefined && fourth === undefined && method === 'GET') {
    if (kernel.getNodeForward === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供节点端口转发', 501)
    }
    const session = kernel.getNodeForward(requireForwardSegment(forwardId))
    if (session === undefined) {
      return errorResponse(redactor, 404, 'not_found', '转发不存在或已停止')
    }
    return jsonOk(redactor, session)
  }
  // GET /api/nodes/forward/:id/events：NDJSON 事件流（监控；断开不自动停止）。
  if (forwardId !== undefined && fourth === 'events' && fifth === undefined && method === 'GET') {
    return getNodeForwardEvents(ctx, kernel, requireForwardSegment(forwardId))
  }
  // DELETE /api/nodes/forward/:id：停止转发（关闭 Hub 侧监听器与全部隧道）。
  if (forwardId !== undefined && fourth === undefined && method === 'DELETE') {
    if (kernel.stopNodeForward === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供节点端口转发', 501)
    }
    // 幂等语义由 404 表达：已不存在的转发停止时报 404（不伤二次退出）。
    if (kernel.getNodeForward !== undefined && kernel.getNodeForward(requireForwardSegment(forwardId)) === undefined) {
      return errorResponse(redactor, 404, 'not_found', '转发不存在或已停止')
    }
    await kernel.stopNodeForward(requireForwardSegment(forwardId))
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

// ---------------------------------------------------------------------------
// /api/env/exec
// ---------------------------------------------------------------------------

const NODE_ISSUE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { nodeId: { type: 'string', minLength: 1 } },
  required: ['nodeId'],
  additionalProperties: false,
}

// 升级 body 机械形状（类型/长度/未知字段）走 schema；targetVersion 的
// trim + 严格 SemVer、registryUrl 的可解析 + 含主机名语义保留手写。
const NODE_UPGRADE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    targetVersion: { type: 'string', maxLength: 64 },
    registryUrl: { type: 'string' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

// 主机名：非空、≤255、无空白、无控制字符（与原逐字符检查同语义）。
const HOST_FIELD = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$' } as const

const NODE_FORWARD_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    listenHost: HOST_FIELD,
    listenPort: { type: 'integer', minimum: 1, maximum: 65535 },
    targetHost: HOST_FIELD,
    targetPort: { type: 'integer', minimum: 1, maximum: 65535 },
  },
  required: ['listenHost', 'listenPort', 'targetPort'],
  additionalProperties: false,
}

const ENV_EXEC_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      anyOf: [
        // 字符串命令须含至少一个非空白字符（= trim 后非空）；数组须非空且逐项字符串。
        { type: 'string', pattern: '\\S' },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    nodeId: { type: 'string', pattern: NODE_ID_PATTERN_SOURCE },
    // cwd 跨平台绝对性（POSIX/盘符/UNC）是语义规则，handler 内手写校验。
    cwd: { type: 'string' },
    conversationId: { type: 'integer', minimum: 1 },
    env: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      additionalProperties: { type: 'string', pattern: '^[^\\u0000]*$' },
    },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
    stream: { type: 'boolean' },
  },
  required: ['command'],
  additionalProperties: false,
}

/** 节点 ID 路径段：字母数字开头，可含 . _ -（与 issue 校验同一规则）。 */
function requireNodeSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!new RegExp(`^${NODE_ID_PATTERN_SOURCE}$`).test(decoded)) {
    throw new ValidationError('nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）')
  }
  return decoded
}

/** http(s) URL 校验：协议限定 + 可解析 + 含 hostname。 */
function requireHttpUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${field} 需为 http(s) URL 字符串`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} 需为合法 http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} 需为 http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} 需含主机名`)
  }
  return raw
}

/** 严格 SemVer（与 runtime 同一规则）。 */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** 边界校验目标版本：trim 后允许单个 v/V 前缀，余下必须严格 SemVer。 */
function requireVersionField(raw: string): string {
  const trimmed = raw.trim()
  const bare = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
  if (!STRICT_SEMVER_RE.test(bare)) {
    throw new ValidationError('targetVersion 需为严格 SemVer（可带单个 v 前缀，如 1.2.3 / v1.2.3）')
  }
  return raw
}

/** GET /api/nodes/:id/upgrade/check 查询参数：仅 registryUrl。 */
function parseNodeUpgradeCheckQuery(url: URL): { registryUrl?: string } {
  const raw = url.searchParams.get('registryUrl')
  return raw === null ? {} : { registryUrl: requireHttpUrl(raw, 'registryUrl') }
}

/**
 * POST /api/nodes/:id/upgrade body：可选 targetVersion / registryUrl / force，
 * 严格拒未知字段（attemptId 属服务端内部，绝不接受用户控制）；
 * 显式 null 与缺省不同——进入字段校验并 400，不当缺省静默忽略。
 */
function parseNodeUpgradeBody(body: Record<string, unknown>): { targetVersion?: string; registryUrl?: string; force?: boolean } {
  assertBodySchema(NODE_UPGRADE_BODY_SCHEMA, body, 'node upgrade body')
  const out: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
  if (body.targetVersion !== undefined) {
    const target = body.targetVersion as string
    if (target.trim() === '') throw new ValidationError('targetVersion 需为非空版本（留空表示升级到 latest）')
    out.targetVersion = requireVersionField(target)
  }
  if (body.registryUrl !== undefined) {
    out.registryUrl = requireHttpUrl(body.registryUrl, 'registryUrl')
  }
  if (body.force !== undefined) {
    out.force = body.force as boolean
  }
  return out
}

/** POST /api/nodes/:id/forward body：listenHost/listenPort/targetPort 必填，
 * targetHost 可选；形状（含主机名无空白/控制字符）已由 schema 保证。 */
function parseNodeForwardBody(
  body: Record<string, unknown>,
): { listenHost: string; listenPort: number; targetHost?: string; targetPort: number } {
  assertBodySchema(NODE_FORWARD_BODY_SCHEMA, body, 'node forward body')
  return {
    listenHost: body.listenHost as string,
    listenPort: body.listenPort as number,
    ...(body.targetHost !== undefined ? { targetHost: body.targetHost as string } : {}),
    targetPort: body.targetPort as number,
  }
}

/**
 * POST /api/env/exec：
 * - stream=true：application/x-ndjson 流式；每行 {"type":"output","stream":...,"text":...}
 *   （text 经 StreamingRedactor 跨 chunk 脱敏），结束行 {"type":"exit",...}；
 * - 否则 JSON 一次性返回 EnvExecResponse（全文聚合后统一脱敏）。
 */
export async function handleEnvExecDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.segments[1] !== 'exec' || ctx.method !== 'POST' || ctx.segments[2] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }
  const body = await readJsonBody(ctx.request)
  assertBodySchema(ENV_EXEC_BODY_SCHEMA, body, 'env exec body')
  // cwd 绝对性按目标形状判定：POSIX / 与 Windows 盘符绝对/UNC 均合法；
  // 盘符相对（C:relative）与相对路径拒绝（与 CLI 字符串 cwd 同一规则）。
  if (body.cwd !== undefined && !isAbsoluteTargetPath(body.cwd as string)) {
    throw new ValidationError(
      'cwd 需为绝对路径（POSIX / 开头或 Windows 盘符/UNC；拒绝盘符相对与相对路径）',
    )
  }
  const request = {
    command: body.command as string | string[],
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId as string } : {}),
    ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}),
    ...(body.conversationId !== undefined ? { conversationId: body.conversationId as number } : {}),
    ...(body.env !== undefined ? { env: { ...(body.env as Record<string, string>) } } : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs as number } : {}),
    ...(body.stream !== undefined ? { stream: body.stream as boolean } : {}),
  }
  const redactText = (text: string): string =>
    kernel.stash !== undefined ? kernel.stash.redact(text) : text

  if (body.stream === true) {
    // 流式：StreamingRedactor 保尾部防跨 chunk 拆分泄漏；结束 flush。
    // 帧协议与 @helm/protocol EnvExecStreamFrame 对齐（最终集成统一类型引用）：
    // - 逐块 {type:'output',stream,text}（text 经跨 chunk 脱敏）；
    // - 成功终帧 {type:'exit',ok,exitCode,timedOut}（必在尾部 redaction flush 之后）；
    // - 中途异常 {type:'error',error:{code,message,details?}}（绝不伪造 exit）。
    const encoder = new TextEncoder()
    let buffered = ''
    const streamRedactor = kernel.stash?.createStreamingRedactor?.() ?? {
      push(text: string) { buffered += text; return '' },
      flush() { const safe = redactText(buffered); buffered = ''; return safe },
    }
    const streamAbort = new AbortController()
    const executionSignal = AbortSignal.any([ctx.request.signal, streamAbort.signal])
    // 命名 readableStream：避免遮蔽外层请求体里的 stream 标志。
    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
        const write = (payload: EnvExecStreamFrame): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          } catch {
            streamAbort.abort()
          }
        }
        try {
          const result = await kernel.execEnv(request, (chunk) => {
            const safe = streamRedactor.push(chunk.text)
            if (safe !== '') write({ type: 'output', stream: chunk.stream, text: safe })
          }, executionSignal)
          // 终帧必在尾部 flush 之后：拼接后的 NDJSON text 仍无 stash/token。
          const tail = streamRedactor.flush()
          if (tail !== '') {
            write({ type: 'output', stream: 'stdout' as const, text: tail })
          }
          write({
            type: 'exit',
            ok: result.ok,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          })
        } catch (error) {
          // 中途异常：error 帧如实携带错误码与消息（经脱敏），不伪造 exit。
          if (error instanceof HelmError) {
            write({
              type: 'error',
              error: {
                code: error.code,
                message: redactText(error.message),
                ...(error.details !== undefined ? { details: redactJsonValue(error.details, redactText) } : {}),
              },
            })
          } else {
            const message = error instanceof Error ? error.message : String(error)
            write({ type: 'error', error: { code: 'internal_error', message: redactText(message) } })
          }
        } finally {
          try {
            controller.close()
          } catch {
            /* 已关 */
          }
        }
        })()
      },
      cancel() { streamAbort.abort() },
    })
    return new Response(readableStream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
      },
    })
  }
  return jsonOk(redactor, await kernel.execEnv(request, undefined, ctx.request.signal))
}

// ---------------------------------------------------------------------------
// 节点前台端口转发事件流
// ---------------------------------------------------------------------------

/** forwardId 路径段：fwd-<uuid>。 */
function requireForwardSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!/^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded)) {
    throw new ValidationError('forwardId 需为 fwd-<uuid> 形式')
  }
  return decoded
}

/** GET /api/nodes/forward/:id/events：NDJSON 事件流。事件流即前台租约持有者：
 * 建立（start）即 acquire、断开/取消（abort/cancel）即 release——最后一个
 * 持有者离开即停止转发（Hub 不残留监听器）；stop 终态 stopped 帧后正常
 * 关闭流（监控不悬挂）；订阅时转发已停止则先回放 stopped 帧再结束。 */
async function getNodeForwardEvents(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  forwardId: string,
): Promise<Response> {
  // aborted 预检（对照 events.ts 两处 SSE 同款）：客户端可能在鉴权 await
  //（verifyToken）期间已断开——对已 aborted 的 signal 注册 abort 监听永不
  // 触发，后续 finish 不执行、租约永不释放。本函数体内无 await，入口
  // 预检后到 ReadableStream 构造（start 同步执行）之间无交错窗口；此处
  // 未取得任何资源，直接拒绝即可，无需清理。
  if (ctx.request.signal.aborted) {
    return errorResponse(undefined, 409, 'client_disconnected', '客户端已断开，不建立转发监控流')
  }
  if (kernel.getNodeForward === undefined || kernel.onNodeForwardEvent === undefined) {
    throw new HelmError('not_implemented', '当前 runtime 未提供节点端口转发', 501)
  }
  const session = kernel.getNodeForward(forwardId)
  if (session === undefined) {
    return errorResponse(undefined, 404, 'not_found', '转发不存在或已停止')
  }
  const encoder = new TextEncoder()
  // start/cancel 共享的释放引用（cancel 拿不到 start 闭包，经此桥接；
  // 每个流实例独立，无并发串扰）。
  const teardown = { run: (): void => undefined }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // finished 单一语义：清理已完成（幂等终态）。send 失败不再只置
      // 标志——那会让 finish 的短路守卫跳过清理，租约/订阅/终止通知全部
      // 残留；失败必须直接走完整 finish 清理路径。
      let finished = false
      let releaseLease: (() => void) | undefined
      let offEvents: (() => void) | undefined
      const offStops: (() => void)[] = []
      const send = (event: unknown): void => {
        if (finished) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // enqueue 失败（流已被下游 errored）：等价断开，走完整清理。
          finish()
        }
      }
      const finish = (): void => {
        if (finished) return
        finished = true
        releaseLease?.()
        releaseLease = undefined
        offEvents?.()
        offEvents = undefined
        for (const stop of offStops.splice(0)) stop()
        try { controller.close() } catch { /* 已关闭 */ }
      }
      teardown.run = finish
      // 先登记终止通知（含已停止竞态：立即微任务回调），再绑定租约/回放首帧/
      // 订阅事件——顺序保证 stop 与订阅交错时要么收到 stopped 帧、要么终止
      // 回调收尾，两条路径都会释放租约。
      if (kernel.onNodeForwardStopped !== undefined) {
        offStops.push(kernel.onNodeForwardStopped(forwardId, () => finish()))
      }
      if (kernel.acquireNodeForwardLease !== undefined) {
        releaseLease = kernel.acquireNodeForwardLease(forwardId)
      }
      offEvents = kernel.onNodeForwardEvent!(forwardId, send)
      send({ type: 'started', listenHost: session.listenHost, listenPort: session.listenPort })
      ctx.request.signal.addEventListener('abort', finish, { once: true })
    },
    cancel() {
      // 客户端主动取消（body.cancel()）：同样释放租约（最后一持有者即停止）。
      teardown.run()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
