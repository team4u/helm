/**
 * node domain routing:/api/nodes(manifest/sign/remove/upgrade/port forwarding) and
 * POST /api/env/exec(across node command execute,NDJSON streaming or JSON once).
 */
import { HelmError, isStrictSemver, stripSemverVPrefix } from '@helm/protocol'
import type { EnvExecStreamFrame, JsonSchema } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { isAbsoluteTargetPath } from '@helm/protocol'
import { jsonOk, errorResponse, readJsonBody, type JsonRedactor } from './http-utils.js'
import { decodeSegment } from './route-match.js'
import type { KernelRuntimeLike } from './contracts.js'
import { assertBodySchema, NODE_ID_PATTERN_SOURCE, requireUtf16LengthAtMost, ValidationError } from './validate.js'
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
    // plaintext token only this time response once return (this after any JSON output all cannot again see plaintext:
    // token already out station redaction register). this where cannot via unify redactor(will token swap into
    // [REDACTED]): manually write response body, only through out contract field.
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
  // ---- node upgrade:GET /:id/upgrade/check,POST /:id/upgrade -----------------
  if (second !== undefined && third === 'upgrade') {
    const nodeId = requireNodeSegment(second)
    if (fourth === 'check' && method === 'GET') {
      if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', 'routing missing')
      if (kernel.checkNodeUpgrade === undefined) {
        throw new HelmError('not_implemented', 'when before runtime not provide node upgrade check', 501)
      }
      return jsonOk(redactor, await kernel.checkNodeUpgrade(nodeId, parseNodeUpgradeCheckQuery(ctx.url)))
    }
    if (fourth === undefined && method === 'POST') {
      if (kernel.upgradeNode === undefined) {
        throw new HelmError('not_implemented', 'when before runtime not provide node upgrade', 501)
      }
      const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeUpgradeBody)
      return jsonOk(redactor, await kernel.upgradeNode(nodeId, body))
    }
    return errorResponse(redactor, 404, 'not_found', 'routing missing')
  }
  // ---- foreground port forwarding:POST /:id/forward,forward manifest/detail situation/event/stop ----------
  if (second !== undefined && third === 'forward' && fourth === undefined && method === 'POST') {
    if (kernel.startNodeForward === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide node port forwarding', 501)
    }
    const nodeId = requireNodeSegment(second)
    const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeForwardBody)
    return jsonOk(redactor, await kernel.startNodeForward(nodeId, body), { status: 201 })
  }
  if (second === 'forward') {
    return handleForwardSubtree(ctx, kernel, redactor)
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

/** GET /api/nodes/forward manifest / :id detail situation / :id/events event stream / DELETE :id stop. */
async function handleForwardSubtree(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]
  // GET /api/nodes/forward: activity forwarding manifest.
  if (third === undefined && method === 'GET') {
    if (kernel.listNodeForwards === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide node port forwarding', 501)
    }
    return jsonOk(redactor, kernel.listNodeForwards())
  }
  const forwardId = third
  if (forwardId !== undefined && fourth === undefined && method === 'GET') {
    if (kernel.getNodeForward === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide node port forwarding', 501)
    }
    const session = kernel.getNodeForward(requireForwardSegment(forwardId))
    if (session === undefined) {
      return errorResponse(redactor, 404, 'not_found', 'forwarding missing or already stop')
    }
    return jsonOk(redactor, session)
  }
  // GET /api/nodes/forward/:id/events:NDJSON event stream (monitor; disconnect do not automatically stop).
  if (forwardId !== undefined && fourth === 'events' && fifth === undefined && method === 'GET') {
    return getNodeForwardEvents(ctx, kernel, requireForwardSegment(forwardId))
  }
  // DELETE /api/nodes/forward/:id: stop forwarding (close Hub side listener and all tunnel).
  if (forwardId !== undefined && fourth === undefined && method === 'DELETE') {
    if (kernel.stopNodeForward === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide node port forwarding', 501)
    }
    // idempotent semantics by 404 express: already missing forwarding stop when report 404(do not damage second exit).
    if (kernel.getNodeForward !== undefined && kernel.getNodeForward(requireForwardSegment(forwardId)) === undefined) {
      return errorResponse(redactor, 404, 'not_found', 'forwarding missing or already stop')
    }
    await kernel.stopNodeForward(requireForwardSegment(forwardId))
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
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

// version also must strictly SemVer validate (pure ASCII, length opening path consistent),registryUrl must can parse and contains host name.
const NODE_UPGRADE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    targetVersion: { type: 'string', maxLength: 64 },
    registryUrl: { type: 'string' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

// host name forbid whitespace and control character,UTF-16 length cap in parse when verify.
const HOST_FIELD = { type: 'string', minLength: 1, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$' } as const

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
        // string command must contains at least a non-empty blank character (= trim after non-empty); array must non-empty and one by one items string.
        { type: 'string', pattern: '\\S' },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    nodeId: { type: 'string', pattern: NODE_ID_PATTERN_SOURCE },
    // cwd across platform absolute (POSIX/symbol/UNC) is semantics rule,handler inside manually write validate.
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

/** node ID path segment: character parent number open head, can contains . _ -(and issue validate the same rule). */
function requireNodeSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!new RegExp(`^${NODE_ID_PATTERN_SOURCE}$`).test(decoded)) {
    throw new ValidationError('nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/(character parent number open head, can contains . _ -)')
  }
  return decoded
}

/** http(s) URL validate: protocol limit set + can parse + contains hostname. */
function requireHttpUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${field} must be http(s) URL string`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} must be legal http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must be http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} must contains host name`)
  }
  return raw
}

/** boundary validate target version:trim after allows single v/V prefix, remaining under must strictly SemVer(parse/decide unique implement:@helm/protocol/semver). */
function requireVersionField(raw: string): string {
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strictly SemVer(can carries single v prefix, such as 1.2.3 / v1.2.3)')
  }
  return raw
}

/** GET /api/nodes/:id/upgrade/check query parameter: only registryUrl. */
function parseNodeUpgradeCheckQuery(url: URL): { registryUrl?: string } {
  const raw = url.searchParams.get('registryUrl')
  return raw === null ? {} : { registryUrl: requireHttpUrl(raw, 'registryUrl') }
}

/**
 * POST /api/nodes/:id/upgrade body: optional targetVersion / registryUrl / force,
 * strictly refuse unknown field (attemptId belong server side internal, never accept user control);
 * explicit null and default different - - enter field validate and 400, do not when default static default ignore.
 */
function parseNodeUpgradeBody(body: Record<string, unknown>): { targetVersion?: string; registryUrl?: string; force?: boolean } {
  assertBodySchema(NODE_UPGRADE_BODY_SCHEMA, body, 'node upgrade body')
  const out: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
  if (body.targetVersion !== undefined) {
    const target = body.targetVersion as string
    if (target.trim() === '') throw new ValidationError('targetVersion must be non-empty version (empty means upgrade to latest)')
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

/** POST /api/nodes/:id/forward body:listenHost/listenPort/targetPort required,
 * targetHost optional; shape (contains host name without whitespace/control character) already by schema guarantee,
 * length cap (UTF-16 code meta ≤ 255) by guard keep original manually write opening path. */
function parseNodeForwardBody(
  body: Record<string, unknown>,
): { listenHost: string; listenPort: number; targetHost?: string; targetPort: number } {
  assertBodySchema(NODE_FORWARD_BODY_SCHEMA, body, 'node forward body')
  requireUtf16LengthAtMost('listenHost', body.listenHost as string, 255)
  if (body.targetHost !== undefined) requireUtf16LengthAtMost('targetHost', body.targetHost as string, 255)
  return {
    listenHost: body.listenHost as string,
    listenPort: body.listenPort as number,
    ...(body.targetHost !== undefined ? { targetHost: body.targetHost as string } : {}),
    targetPort: body.targetPort as number,
  }
}

/**
 * POST /api/env/exec:
 * - stream=true:application/x-ndjson streaming; each row {"type":"output","stream":...,"text":...}
 *   (text via StreamingRedactor across chunk redaction), end row {"type":"exit",...};
 * - otherwise JSON once return EnvExecResponse(all text aggregate after unify redaction).
 */
export async function handleEnvExecDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.segments[1] !== 'exec' || ctx.method !== 'POST' || ctx.segments[2] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'routing missing')
  }
  const body = await readJsonBody(ctx.request)
  assertBodySchema(ENV_EXEC_BODY_SCHEMA, body, 'env exec body')
  // cwd absolute by target shape decide:POSIX / and Windows symbol absolute/UNC all legal;
  // symbol each other for (C:relative) and relative path reject (and CLI string cwd the same rule).
  if (body.cwd !== undefined && !isAbsoluteTargetPath(body.cwd as string)) {
    throw new ValidationError(
      'cwd must be absolute path (POSIX / open head or Windows symbol/UNC; reject symbol each other for and relative path)',
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
    // streaming:StreamingRedactor keep tail part guard against across chunk split leak leak; end flush.
    // frame protocol and @helm/protocol EnvExecStreamFrame align (eventually collection into unify type reference):
    // - one by one chunk {type:'output',stream,text}(text via across chunk redaction);
    // - succeeded final frame {type:'exit',ok,exitCode,timedOut}(must in tail part redaction flush after);
    // - in route exception {type:'error',error:{code,message,details?}}(never fabricate exit).
    const encoder = new TextEncoder()
    let buffered = ''
    const streamRedactor = kernel.stash?.createStreamingRedactor?.() ?? {
      push(text: string) { buffered += text; return '' },
      flush() { const safe = redactText(buffered); buffered = ''; return safe },
    }
    const streamAbort = new AbortController()
    const executionSignal = AbortSignal.any([ctx.request.signal, streamAbort.signal])
    // naming readableStream: avoid obscure outside layer request body in stream flag.
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
          // final frame must in tail part flush after: concatenate after NDJSON text still without stash/token.
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
          // in route exception:error frame such as carry error code and message (via redaction), do not fabricate exit.
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
            /* already closure */
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
// node foreground port forwarding event stream
// ---------------------------------------------------------------------------

/** forwardId path segment:fwd-<uuid>. */
function requireForwardSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!/^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded)) {
    throw new ValidationError('forwardId must be fwd-<uuid> form')
  }
  return decoded
}

/** GET /api/nodes/forward/:id/events:NDJSON event stream. event stream i.e. foreground lease holder:
 * establish (start) i.e. acquire, disconnect/cancel (abort/cancel) i.e. release- - finally a
 * holder leave i.e. stop forwarding (Hub leaves no residue listener);stop terminal state stopped frame after normal
 * close stream (monitor do not pending); subscribe when forwarding already stop then first back put stopped frame again end. */
async function getNodeForwardEvents(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  forwardId: string,
): Promise<Response> {
  // aborted preflight (compare events.ts two where SSE same style): client may in authentication await
  //(verifyToken) during disconnected - - for already aborted  signal register abort listen forever do not
  // trigger, after continue finish do not execute, lease forever do not release. this function body inside without await, entry
  // preflight after to ReadableStream construct (start sync execute) between without hand over wrong window; this where
  // not acquire any asset, directly reject i.e. can, no need to clean up.
  if (ctx.request.signal.aborted) {
    return errorResponse(undefined, 409, 'client_disconnected', 'client disconnected, do not establish forwarding monitor stream')
  }
  if (kernel.getNodeForward === undefined || kernel.onNodeForwardEvent === undefined) {
    throw new HelmError('not_implemented', 'when before runtime not provide node port forwarding', 501)
  }
  const session = kernel.getNodeForward(forwardId)
  if (session === undefined) {
    return errorResponse(undefined, 404, 'not_found', 'forwarding missing or already stop')
  }
  const encoder = new TextEncoder()
  // start/cancel sharing release reference (cancel take fewer than start closed package, via this bridge;
  // each stream instance independent, without concurrency string disturb).
  const teardown = { run: (): void => undefined }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // finished single one semantics: clean up completed (idempotent terminal state).send failed no longer only placement
      // flag - - that will let finish short route guard skip clean up, lease/subscribe/terminate notify all
      // leftover; failed must directly away complete finish clean up path.
      let finished = false
      let releaseLease: (() => void) | undefined
      let offEvents: (() => void) | undefined
      const offStops: (() => void)[] = []
      const send = (event: unknown): void => {
        if (finished) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // enqueue failed (stream already by downstream errored): etc. price disconnect, away complete clean up.
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
        try { controller.close() } catch { /* already close */ }
      }
      teardown.run = finish
      // first register terminate notify (contains already stop race: immediately micro task call back), again bind set lease/back put first frame/
      // subscribe event - - order guarantee stop and subscribe hand over wrong when want particle receives stopped frame, want particle terminate
      // call back wrap-up, two path all will release lease.
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
      // client actively cancel (body.cancel()): same release lease (finally one holder i.e. stop).
      teardown.run()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
