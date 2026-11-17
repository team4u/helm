/**
 * Node domain routes: /api/nodes (list/issue/remove/upgrade/port-forwarding) and
 * POST /api/env/exec (cross-node command execution, NDJSON streaming or single JSON response).
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
    // Plaintext token is returned once in this response (afterward no JSON output ever exposes
    // it again because the token is registered for outbound redaction). Bypass the standard redactor here
    // and serialize only the contract fields manually so it isn't masked as [REDACTED].
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
  // ---- Node upgrade: GET /:id/upgrade/check, POST /:id/upgrade -----------------
  if (second !== undefined && third === 'upgrade') {
    const nodeId = requireNodeSegment(second)
    if (fourth === 'check' && method === 'GET') {
      if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')
      if (kernel.checkNodeUpgrade === undefined) {
        throw new HelmError('not_implemented', 'current runtime does not support node upgrade check', 501)
      }
      return jsonOk(redactor, await kernel.checkNodeUpgrade(nodeId, parseNodeUpgradeCheckQuery(ctx.url)))
    }
    if (fourth === undefined && method === 'POST') {
      if (kernel.upgradeNode === undefined) {
        throw new HelmError('not_implemented', 'current runtime does not support node upgrade', 501)
      }
      const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeUpgradeBody)
      return jsonOk(redactor, await kernel.upgradeNode(nodeId, body))
    }
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  // ---- Foreground port forwarding: POST /:id/forward, forward list/detail/events/stop ----------
  if (second !== undefined && third === 'forward' && fourth === undefined && method === 'POST') {
    if (kernel.startNodeForward === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support node port forwarding', 501)
    }
    const nodeId = requireNodeSegment(second)
    const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeForwardBody)
    return jsonOk(redactor, await kernel.startNodeForward(nodeId, body), { status: 201 })
  }
  if (second === 'forward') {
    return handleForwardSubtree(ctx, kernel, redactor)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

/** GET /api/nodes/forward list / :id detail / :id/events stream / DELETE :id stop. */
async function handleForwardSubtree(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]
  // GET /api/nodes/forward: active forwarding sessions.
  if (third === undefined && method === 'GET') {
    if (kernel.listNodeForwards === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support node port forwarding', 501)
    }
    return jsonOk(redactor, kernel.listNodeForwards())
  }
  const forwardId = third
  if (forwardId !== undefined && fourth === undefined && method === 'GET') {
    if (kernel.getNodeForward === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support node port forwarding', 501)
    }
    const session = kernel.getNodeForward(requireForwardSegment(forwardId))
    if (session === undefined) {
      return errorResponse(redactor, 404, 'not_found', 'forwarding session not found or already stopped')
    }
    return jsonOk(redactor, session)
  }
  // GET /api/nodes/forward/:id/events: NDJSON event stream (monitoring only; disconnect does not auto-stop).
  if (forwardId !== undefined && fourth === 'events' && fifth === undefined && method === 'GET') {
    return getNodeForwardEvents(ctx, kernel, requireForwardSegment(forwardId))
  }
  // DELETE /api/nodes/forward/:id: stop forwarding (closes Hub listener and all tunnels).
  if (forwardId !== undefined && fourth === undefined && method === 'DELETE') {
    if (kernel.stopNodeForward === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support node port forwarding', 501)
    }
    // Idempotency expressed via 404: stopping an absent forward returns 404 (prevents duplicate exit errors).
    if (kernel.getNodeForward !== undefined && kernel.getNodeForward(requireForwardSegment(forwardId)) === undefined) {
      return errorResponse(redactor, 404, 'not_found', 'forwarding session not found or already stopped')
    }
    await kernel.stopNodeForward(requireForwardSegment(forwardId))
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
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

// targetVersion also requires strict SemVer validation (pure ASCII, consistent length bounds);
// registryUrl must be parseable and include a hostname.
const NODE_UPGRADE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    targetVersion: { type: 'string', maxLength: 64 },
    registryUrl: { type: 'string' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

// Hostnames forbid whitespace and control chars; UTF-16 length cap is verified during parsing.
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
        // String command must contain at least one non-whitespace char; array must be non-empty string[].
        { type: 'string', pattern: '\\S' },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    nodeId: { type: 'string', pattern: NODE_ID_PATTERN_SOURCE },
    // Cross-platform cwd absoluteness (POSIX/drive/UNC) is a semantic rule validated explicitly in the handler.
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

/** Node ID path segment: starts with ASCII alphanumeric, may contain . _ - (matches issue validation). */
function requireNodeSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!new RegExp(`^${NODE_ID_PATTERN_SOURCE}$`).test(decoded)) {
    throw new ValidationError('nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (starts with an alphanumeric character, may contain . _ -)')
  }
  return decoded
}

/** Validate http(s) URL: restricted scheme, parseable, non-empty hostname. */
function requireHttpUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${field} must be an http(s) URL string`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} must be a valid http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must be an http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} must contain a hostname`)
  }
  return raw
}

/** Boundary validation for targetVersion: optional single v/V prefix after trim, remainder must be strict SemVer (single implementation in @helm/protocol/semver). */
function requireVersionField(raw: string): string {
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strict SemVer (optional single v prefix, e.g. 1.2.3 or v1.2.3)')
  }
  return raw
}

/** GET /api/nodes/:id/upgrade/check query params: only registryUrl. */
function parseNodeUpgradeCheckQuery(url: URL): { registryUrl?: string } {
  const raw = url.searchParams.get('registryUrl')
  return raw === null ? {} : { registryUrl: requireHttpUrl(raw, 'registryUrl') }
}

/**
 * POST /api/nodes/:id/upgrade body: optional targetVersion / registryUrl / force;
 * strictly rejects unknown fields (`attemptId` is server-internal and never caller-controlled);
 * explicit `null` differs from omitted—validated and rejected with 400 rather than silently ignored.
 */
function parseNodeUpgradeBody(body: Record<string, unknown>): { targetVersion?: string; registryUrl?: string; force?: boolean } {
  assertBodySchema(NODE_UPGRADE_BODY_SCHEMA, body, 'node upgrade body')
  const out: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
  if (body.targetVersion !== undefined) {
    const target = body.targetVersion as string
    if (target.trim() === '') throw new ValidationError('targetVersion must be a non-empty version (omit to upgrade to latest)')
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

/**
 * POST /api/nodes/:id/forward body: listenHost/listenPort/targetPort required,
 * targetHost optional; shape (hostname without whitespace/control chars) is enforced by schema,
 * and UTF-16 length cap (<= 255 code units) is kept hand-written to match existing rules.
 */
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
 * - stream=true: application/x-ndjson stream; each line is `{"type":"output","stream":...,"text":...}`
 *   (text redacted across chunks via StreamingRedactor), followed by `{"type":"exit",...}`;
 * - otherwise returns JSON EnvExecResponse once (all text redacted after aggregation).
 */
export async function handleEnvExecDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.segments[1] !== 'exec' || ctx.method !== 'POST' || ctx.segments[2] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  const body = await readJsonBody(ctx.request)
  assertBodySchema(ENV_EXEC_BODY_SCHEMA, body, 'env exec body')
  // Cross-platform cwd absoluteness: POSIX / and Windows drive-absolute/UNC are valid;
  // drive-relative (e.g. C:relative) and relative paths are rejected (matches CLI string cwd rules).
  if (body.cwd !== undefined && !isAbsoluteTargetPath(body.cwd as string)) {
    throw new ValidationError(
      'cwd must be an absolute path (POSIX /..., Windows drive, or UNC; drive-relative and relative paths are rejected)',
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
    // Streaming: StreamingRedactor retains tail buffer to prevent secrets split across chunk boundaries from leaking; flushed on finish.
    // Frame protocol aligns with @helm/protocol EnvExecStreamFrame:
    // - per chunk `{ type: 'output', stream, text }` (redacted across chunks);
    // - final frame on completion `{ type: 'exit', ok, exitCode, timedOut }` (must follow tail flush);
    // - mid-stream error `{ type: 'error', error: { code, message, details? } }` (never fabricate exit).
    const encoder = new TextEncoder()
    let buffered = ''
    const streamRedactor = kernel.stash?.createStreamingRedactor?.() ?? {
      push(text: string) { buffered += text; return '' },
      flush() { const safe = redactText(buffered); buffered = ''; return safe },
    }
    const streamAbort = new AbortController()
    const executionSignal = AbortSignal.any([ctx.request.signal, streamAbort.signal])
    // Named `readableStream` to avoid shadowing the outer `stream` boolean flag in request body.
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
          // Final frame must come after flushing tail buffer so no stash/token survives concatenation.
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
          // Mid-stream exception: emit redacted error frame without fabricating an exit frame.
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
            /* already closed */
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
// Node foreground port-forwarding event stream
// ---------------------------------------------------------------------------

/** forwardId path segment: `fwd-<uuid>`. */
function requireForwardSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!/^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded)) {
    throw new ValidationError('forwardId must be in fwd-<uuid> format')
  }
  return decoded
}

/**
 * GET /api/nodes/forward/:id/events: NDJSON event stream, which itself holds a foreground lease:
 * acquired on start, released on abort/cancel—so forwarding stops when the last holder leaves (Hub
 * leaves no orphaned listeners). Emits a terminal `stopped` frame then closes cleanly (no hanging monitors);
 * if already stopped at subscribe time, emits `stopped` and closes immediately.
 */
async function getNodeForwardEvents(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  forwardId: string,
): Promise<Response> {
  // Abort preflight (mirrors SSE streams in events.ts): the client may have disconnected while awaiting
  // auth (verifyToken)—adding an abort listener to an already-aborted signal never fires, so `finish`
  // would never run and the lease would leak. This body has no awaits, so there is no interleaving window
  // between this preflight and ReadableStream construction (`start` runs synchronously); no resources are
  // acquired yet, so returning immediately requires no cleanup.
  if (ctx.request.signal.aborted) {
    return errorResponse(undefined, 409, 'client_disconnected', 'client disconnected; refusing to open forwarding monitor stream')
  }
  if (kernel.getNodeForward === undefined || kernel.onNodeForwardEvent === undefined) {
    throw new HelmError('not_implemented', 'current runtime does not support node port forwarding', 501)
  }
  const session = kernel.getNodeForward(forwardId)
  if (session === undefined) {
    return errorResponse(undefined, 404, 'not_found', 'forwarding session not found or already stopped')
  }
  const encoder = new TextEncoder()
  // Shared teardown bridge between start and cancel (cancel cannot see variables closed over inside start;
  // each stream instance is independent so there is no concurrency interference).
  const teardown = { run: (): void => undefined }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Single idempotent `finished` terminal flag: failed sends must NOT merely set a flag
      // (which would make `finish` short-circuit and leak the lease/subscriptions/stop hooks);
      // failures must always run the full `finish` cleanup path.
      let finished = false
      let releaseLease: (() => void) | undefined
      let offEvents: (() => void) | undefined
      const offStops: (() => void)[] = []
      const send = (event: unknown): void => {
        if (finished) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // Enqueue failed (downstream closed/errored): equivalent to disconnect, run full cleanup.
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
        try { controller.close() } catch { /* already closed */ }
      }
      teardown.run = finish
      // Register stop listener first (handles already-stopped race via immediate microtask callback), then
      // bind lease / emit initial frame / subscribe—guarantees either the `stopped` frame or stop callback
      // closes the stream on race, and both paths release the lease.
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
      // Client cancelled stream (`body.cancel()`): release lease too (stops forwarding once last holder leaves).
      teardown.run()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
