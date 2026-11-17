/**
 * triggers/webhook.ts: the inbound webhook connector.
 *
 * Contract (§4.4):
 * - Public route POST /webhook/:id (host full path /api/plugins/builtin%3Atriggers/
 *   routes/webhook/:id; public:true skips token auth -- the plugin verifies signatures itself);
 * - HMAC-SHA256: header x-helm-signature: sha256=<hex>, the signature covering the raw body
 *   bytes; timingSafeEqual constant-time comparison; missing/wrong signature 401, unknown id 404, success 202
 *   {accepted:true}；
 * - The secret lands only in credentials.json pluginSecrets['builtin:triggers']
 *   ['webhook:<id>'] (0600, bound to this plugin's ID via ctx.host.secrets) plus
 *   secrets.addRedaction global redaction; the doc stores metadata only;
 * - webhook_create rejects calling contexts carrying a conversationId: the raw secret has
 *   already entered the model tool history via the run_action parameter (a handler rejection
 *   cannot clean a secret already in context) -- the secret is configurable only via manual
 *   HTTP/CLI, as the docs honestly state;
 * - create/delete are serialized (mutationChain); the secret file and the doc have no
 *   cross-store transaction: create writes the doc first (incl. hasSecret:true), really flushes
 *   via doc.flush(), then writes the secret; a secret write failure rolls back the doc entry;
 *   delete removes the doc first (idempotent-tolerant) then the secret, a secret deletion
 *   failure erroring explicitly; both paths await flush before success -- never returning fake persistence;
 * - Successful delivery goes through the shared dispatchTrigger helper (the isClosing check is
 *   inside the helper), with text as the raw utf8 body and source as webhook:<id>; the body cap is 256 KiB
 *   (reusing the http readBody streaming limit, cancel + 413 when exceeded; the signature is over the raw bytes,
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type { HelmPluginContext, PluginActionContext } from '@helm/protocol'
import { BodyError, readBody } from '@helm/protocol'
import {
  MAX_DESCRIPTION,
  TRIGGERS_PLUGIN_ID,
  assertDescription,
  assertThreadKey,
  assertTriggerId,
  assertWebhookSecret,
  assertWebhooksDoc,
  webhookPublicMeta,
  webhookSecretKey,
  type WebhookMeta,
  type WebhooksDoc,
} from './contracts.js'
import type { DispatchTriggerHelper } from './delivery.js'

/** Public webhook request body cap (raw bytes; exceeding gives an explicit 413). */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

/**
 * The bound for stop waiting on in-flight public-route requests: slow clients reading the body have no read timeout
 * (protocol/src/http-body.ts is not this plugin's to change); unbounded waiting would hang dispose;
 * after the timeout, honestly record the unconverged request count and continue disabling (the same bounded approach as the watchdog stop).
 */
export const STOP_REQUEST_WAIT_MS = 10_000

const SIGNATURE_HEADER = 'x-helm-signature'
const SIGNATURE_PREFIX = 'sha256='

/** Uniform 404/401/413 JSON error body (public routes carry no internal detail). */
function webhookError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

const acceptedResponse = (): Response =>
  new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** Hex decode + constant-time comparison: both sides are 64-char hex ASCII bytes (length always 64);
 * the regex format check guarantees equal length before timingSafeEqual, leaking no timing through length branches. */
function verifySignature(secret: string, body: Uint8Array, header: string): boolean {
  if (!header.startsWith(SIGNATURE_PREFIX)) return false
  const hex = header.slice(SIGNATURE_PREFIX.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex')
  const provided = Buffer.from(hex.toLowerCase(), 'utf8')
  const expected = Buffer.from(expectedHex, 'utf8')
  return timingSafeEqual(provided, expected)
}

interface RegisterWebhookResult {
  /** Action-handler reuse (the same implementation as ctx.action; consistent across five ends). */
  createWebhook(input: CreateWebhookInput, context: PluginActionContext): Promise<{ webhook: WebhookMeta }>
  listWebhooks(): { webhooks: WebhookMeta[] }
  deleteWebhook(input: { id: string }): Promise<{ deleted: true }>
}

interface CreateWebhookInput {
  id: string
  description?: string
  secret: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
}

/**
 * Register the webhook connector: the public doc 'webhooks', the public route, and lifecycle actions.
 * secrets / profiles / isClosing consume the ctx.host public ports directly (zero-arg factory,
 * no injected dependencies); the returned handler face is reused (tests/management UI share one implementation).
 */
export function registerWebhook(
  ctx: HelmPluginContext,
  shared: { dispatch: DispatchTriggerHelper },
): RegisterWebhookResult {
  const host = ctx.host
  const doc = ctx.doc<WebhooksDoc>('webhooks', { webhooks: [] }, { public: true })

  const readDoc = (): WebhooksDoc => assertWebhooksDoc(doc.get())
  const writeDoc = (next: WebhooksDoc): void => {
    doc.set(assertWebhooksDoc(next))
  }

  /** Handle releasing this enable cycle's secret redaction registrations (stop releases them together). */
  let secretRedactions: Array<() => void> = []

  // ---- Service liveness gate: public routes have no host tracker wrapper; maintain the in-flight request set ourselves ----
  // After active=false: requests already inside the handler keep converging (stop waits), but requests
  // re-checking active before dispatch no longer deliver; stale handlers (leftover calls after disable) are rejected outright.
  let active = false
  const activeRequests = new Set<Promise<unknown>>()
  const idleWaiters: Array<() => void> = []

  const trackRequest = <T>(run: () => Promise<T>): Promise<T> => {
    let tracked!: Promise<T>
    tracked = (async () => {
      try {
        return await run()
      } finally {
        activeRequests.delete(tracked)
        if (!active && activeRequests.size === 0) {
          for (const notify of idleWaiters.splice(0)) notify()
        }
      }
    })()
    activeRequests.add(tracked)
    return tracked
  }

  /** Reject leftover calls after disable (old handler handles may still be held externally). */
  const assertActive = (): void => {
    if (!active) {
      throw new HelmError(
        'plugin_disabled',
        'the builtin:triggers webhook service is disabled; refusing to handle the request',
        409,
        { pluginId: TRIGGERS_PLUGIN_ID },
      )
    }
  }

  /** Read one doc entry live (not_found when absent). */
  const requireWebhook = (id: string): WebhookMeta => {
    const found = readDoc().webhooks.find((w) => w.id === id)
    if (found === undefined) {
      throw new HelmError('not_found', `webhook '${id}' does not exist`, 404, { id })
    }
    return found
  }

  /** Start: read the doc (corruption errors explicitly), register existing secret redactions, and open the liveness gate. */
  async function start(): Promise<void> {
    readDoc()
    const metas = readDoc().webhooks
    for (const meta of metas) {
      const secret = await host.secrets.get(webhookSecretKey(meta.id))
      if (secret !== undefined) secretRedactions.push(host.secrets.addRedaction(secret))
    }
    active = true
  }

  /** Stop: close the gate first (new requests rejected / re-rejected before dispatch), then boundedly wait for admitted
   * requests to converge naturally; on timeout do not forcibly tear down requests (we cannot: the response may already be
   * committed to the connection); record honestly and continue releasing plugin resources. */
  async function stop(): Promise<void> {
    active = false
    if (activeRequests.size > 0) {
      let giveUpTimer: NodeJS.Timeout | undefined
      const idle = new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
      const deadline = new Promise<void>((resolve) => {
        giveUpTimer = setTimeout(resolve, STOP_REQUEST_WAIT_MS)
        giveUpTimer.unref?.()
      })
      await Promise.race([idle, deadline])
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer)
      if (activeRequests.size > 0) {
        // Record honestly (never pretend convergence): when leftover requests converge by themselves, trackRequest's finally
        // idempotently resolves finished waiters, affecting no later cycle.
        console.error(
          `[triggers] webhook stop exceeded ${STOP_REQUEST_WAIT_MS}ms waiting for in-flight requests; ${activeRequests.size} unconverged (slow clients may still be reading the body); continuing disable`,
        )
      }
    }
    for (const release of secretRedactions) release()
    secretRedactions = []
  }

  /** Disable-gate label: normal disable/unregister gets 409 plugin_has_live_tasks from this;
   * on a forced dispose-time stop, active is already false and this returns empty to allow teardown. */
  function liveTasks(): string[] {
    if (!active) return []
    const count = activeRequests.size
    return count > 0 ? [`webhook:inflight:${count}`] : []
  }

  /** create/delete serialization chain: preventing concurrent read-modify-write races between the secret file and the doc. */
  let mutationChain: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const task = mutationChain.then(run, run)
    mutationChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async function createWebhook(
    input: CreateWebhookInput,
    context: PluginActionContext,
  ): Promise<{ webhook: WebhookMeta }> {
    // Secret boundary: a call carrying a conversationId (run_action / workflow) means the raw
    // secret has entered that conversation's model context -- this handler cannot clean it; reject outright;
    // the secret is configurable only via manual HTTP/CLI (as the docs honestly state).
    if (context.conversationId !== undefined) {
      throw new HelmError(
        'webhook_secret_context_forbidden',
        'webhook_create carries a plaintext secret; calling from a conversation context (run_action/workflow) is forbidden; configure it via manual HTTP/CLI (helm webhook create)',
        403,
        { pluginId: TRIGGERS_PLUGIN_ID, conversationId: context.conversationId },
      )
    }
    const id = assertTriggerId('webhook', input.id)
    const secret = assertWebhookSecret(input.secret)
    const description = input.description === undefined ? undefined : assertDescription(input.description)
    if (input.targetConversationId !== undefined && input.targetProfileId !== undefined) {
      throw new HelmError('validation_error', 'targetConversationId and targetProfileId must not both be provided', 400, {})
    }
    if (input.targetConversationId !== undefined && (!Number.isInteger(input.targetConversationId) || input.targetConversationId <= 0)) {
      throw new HelmError('validation_error', `targetConversationId is not a positive integer (${String(input.targetConversationId)})`, 400, {})
    }
    if (input.targetProfileId !== undefined && (typeof input.targetProfileId !== 'string' || input.targetProfileId.length === 0)) {
      throw new HelmError('validation_error', 'targetProfileId must be a non-empty string', 400, {})
    }
    const threadKey = input.threadKey === undefined ? undefined : assertThreadKey(input.threadKey)
    // targetProfileId is existence-checked at creation (fail-fast: no dead endpoint pointing at a
    // nonexistent role; delivery still live-checks, guarding against post-creation Profile deletion).
    if (input.targetProfileId !== undefined) {
      const profileId = input.targetProfileId
      if (await host.profiles.get(profileId) === undefined) {
        throw new HelmError(
          'validation_error',
          `targetProfileId does not exist: ${profileId} (refusing to point at the wrong role)`,
          400,
          { targetProfileId: profileId },
        )
      }
    }
    const meta: WebhookMeta = {
      id,
      hasSecret: true,
      ...(description !== undefined ? { description } : {}),
      ...(input.targetConversationId !== undefined ? { targetConversationId: input.targetConversationId } : {}),
      ...(input.targetProfileId !== undefined ? { targetProfileId: input.targetProfileId } : {}),
      ...(threadKey !== undefined ? { threadKey } : {}),
      createdAt: Date.now(),
    }
    return enqueueMutation(async () => {
      if (readDoc().webhooks.some((w) => w.id === id)) {
        throw new HelmError('webhook_exists', `webhook '${id}' already exists`, 409, { id })
      }
      // Order: write the doc (the entry metadata) and flush first, then write the secret; on secret
      // write failure, roll back by removing the doc entry and flushing (the entry never went live); a rollback failure aggregates and propagates.
      try {
        writeDoc({ webhooks: [...readDoc().webhooks, meta] })
        await doc.flush()
        await host.secrets.set(webhookSecretKey(id), secret)
      } catch (secretError) {
        try {
          writeDoc({ webhooks: readDoc().webhooks.filter((w) => w.id !== id) })
          await doc.flush()
        } catch (rollbackError) {
          throw new HelmError(
            'webhook_create_rollback_failed',
            `webhook '${id}' secret write failed and the doc rollback also failed (a doc entry without a secret remains; the next request will explicitly report the inconsistency -- please verify manually): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
            {
              id,
              secretError: secretError instanceof Error ? secretError.message : String(secretError),
            },
          )
        }
        throw secretError
      }
      const release = host.secrets.addRedaction(secret)
      secretRedactions.push(release)
      return { webhook: webhookPublicMeta(meta) }
    })
  }

  function listWebhooks(): { webhooks: WebhookMeta[] } {
    return { webhooks: readDoc().webhooks.map((w) => webhookPublicMeta(w)) }
  }

  async function deleteWebhook(input: { id: string }): Promise<{ deleted: true }> {
    const id = assertTriggerId('webhook', input.id)
    return enqueueMutation(async () => {
      const current = readDoc()
      const existing = current.webhooks.find((w) => w.id === id)
      if (existing === undefined) {
        throw new HelmError('not_found', `webhook '${id}' does not exist`, 404, { id })
      }
      // Order: doc first (taking the entry offline), then secret; a secret deletion failure errors
      // explicitly (a leftover secret has no entry and is unusable; humans can clean credentials.json).
      writeDoc({ webhooks: current.webhooks.filter((w) => w.id !== id) })
      try {
        await doc.flush()
        await host.secrets.delete(webhookSecretKey(id))
      } catch (err) {
        throw new HelmError(
          'webhook_delete_secret_failed',
          `webhook '${id}' metadata deleted, but secret cleanup failed (left in credentials.json, unusable without an entry -- please verify manually): ${err instanceof Error ? err.message : String(err)}`,
          500,
          { id },
        )
      }
      return { deleted: true }
    })
  }

  // ---- Public route: HMAC verification + delivery ----
  ctx.route({
    method: 'POST',
    path: '/webhook/:id',
    public: true,
    handler(request) {
      return trackRequest(async () => handleWebhookRequest(request)).catch((err: unknown) => {
        if (err instanceof HelmError) {
          // Doc corruption and post-disable leftover calls both pass through their original codes (not lumped into a generic 500).
          if (err.code === 'triggers_doc_corrupt') {
            return webhookError(500, err.code, err.message)
          }
          if (err.code === 'plugin_disabled') {
            return webhookError(409, err.code, err.message)
          }
        }
        // Other exceptions honestly 500 (never swallowed, never disguised as success).
        return webhookError(500, 'webhook_internal_error', `webhook handling failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
  })

  async function handleWebhookRequest(request: Request): Promise<Response> {
      assertActive()
      // Accept POST only (the host route layer matches by method; the same check applies when called directly).
      if (request.method !== 'POST') {
        return webhookError(404, 'not_found', `the webhook route supports POST only (got ${request.method})`)
      }
      // Full path /api/plugins/builtin%3Atriggers/routes/webhook/:id;
      // the route layer already matches decoded segments; here take the raw trailing segment from the URL and decode it strictly.
      const rawId = request.url.split('?')[0]!.split('/').filter(Boolean).pop()
      let id: string
      try {
        id = rawId === undefined ? '' : decodeURIComponent(rawId)
      } catch {
        return webhookError(400, 'invalid_path_encoding', 'the webhook id path segment has invalid encoding')
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        return webhookError(404, 'not_found', `webhook does not exist: ${id || '(empty)'}`)
      }
      const meta = readDoc().webhooks.find((w) => w.id === id)
      if (meta === undefined) {
        return webhookError(404, 'not_found', `webhook does not exist: ${id}`)
      }
      const secret = await host.secrets.get(webhookSecretKey(id))
      if (secret === undefined || secret === '') {
        // A doc entry with a missing secret is a persistence-layer inconsistency: an explicit 500
        // diagnostic (honesty discipline); never silently admit unsigned requests.
        return webhookError(500, 'webhook_secret_missing', `webhook '${id}' is missing its secret (credentials.json and the doc are inconsistent -- please verify manually)`)
      }
      const signature = request.headers.get(SIGNATURE_HEADER)
      if (signature === null) {
        return webhookError(401, 'unauthorized', `missing the ${SIGNATURE_HEADER} header`)
      }
      let body: Uint8Array
      try {
        // Reuse the http-boundary readBody: content-length precheck + streaming accumulation; over the
        // limit, cancel the reader immediately (never buffering the whole body into memory) and throw body_too_large 413.
        body = await readBody(request, MAX_WEBHOOK_BODY_BYTES)
      } catch (err) {
        if (err instanceof BodyError && err.code === 'body_too_large') {
          return webhookError(413, 'payload_too_large', `webhook body over the cap (${MAX_WEBHOOK_BODY_BYTES} bytes)`)
        }
        return webhookError(400, 'invalid_body', `webhook body read failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!verifySignature(secret, body, signature)) {
        return webhookError(401, 'unauthorized', 'signature verification failed (expected x-helm-signature: sha256=<hex>, the signature covering the raw body bytes)')
      }
      // Verify the signature (over raw bytes) before decoding: fatal:true makes bad UTF-8 throw an explicit 400,
      // never silently replacing characters (the replacement's semantics differ from the raw bytes).
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      } catch {
        return webhookError(400, 'invalid_body', 'the webhook body is not valid UTF-8')
      }
      // The endpoint may be deleted or rebuilt while the body is being read; refuse delivering to a new configuration with the old key.
      const secretAtDispatch = await host.secrets.get(webhookSecretKey(id))
      if (!active) {
        return webhookError(409, 'plugin_disabled', 'the builtin:triggers webhook service is disabled; refusing delivery')
      }
      const metaAtDispatch = readDoc().webhooks.find((w) => w.id === id)
      if (metaAtDispatch === undefined) {
        return webhookError(404, 'not_found', `webhook does not exist: ${id}`)
      }
      if (secretAtDispatch !== secret || metaAtDispatch.createdAt !== meta.createdAt) {
        return webhookError(409, 'webhook_changed', 'the webhook configuration changed; please resend with the current secret')
      }
      try {
        await shared.dispatch(
          {
            id: `webhook:${id}:${randomUUID()}`,
            source: `webhook:${id}`,
            text,
            ...(metaAtDispatch.threadKey !== undefined ? { threadKey: metaAtDispatch.threadKey } : {}),
            ...(metaAtDispatch.targetConversationId !== undefined ? { targetConversationId: metaAtDispatch.targetConversationId } : {}),
            createdAt: Date.now(),
          },
          metaAtDispatch.targetProfileId,
        )
      } catch (err) {
        if (err instanceof HelmError && (err.code === 'runtime_closing' || err.code === 'not_found')) {
          return webhookError(err.status, err.code, err.message)
        }
        // Delivery failure is an explicit 500 (never swallowed; never silently truncating text as fake success).
        return webhookError(500, 'webhook_dispatch_failed', `trigger delivery failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return acceptedResponse()
  }

  // ---- Lifecycle actions (HTTP/CLI/tool reuse the same schema across five ends) ----
  ctx.action({
    id: 'webhook_create',
    description: 'Create a webhook inbound endpoint (HMAC-SHA256 verified); the secret is configurable only via manual HTTP/CLI, rejecting conversation-context calls',
    promptGuidelines: [
      'The secret is configured by humans only: have the user run helm webhook create or call HTTP directly; do not generate, fill in, or echo the secret inside a conversation -- conversation-context calls are rejected by the server (403 webhook_secret_context_forbidden)',
      'After creation, hand the user the endpoint URL and the signing method: x-helm-signature: sha256=<hex>, an HMAC-SHA256 signature over the raw body bytes',
    ],
    cli: { command: ['webhook', 'create'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        description: { type: 'string', maxLength: MAX_DESCRIPTION },
        secret: { type: 'string', minLength: 1, maxLength: 512 },
        targetConversationId: { type: 'integer', minimum: 1 },
        targetProfileId: { type: 'string', minLength: 1, maxLength: 64 },
        threadKey: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['id', 'secret'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: {
        webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            hasSecret: { type: 'boolean' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'hasSecret', 'createdAt'],
        },
      },
      required: ['webhook'],
      additionalProperties: false,
    } as never,
    handler: (input, context) => createWebhook(input as CreateWebhookInput, context),
  })

  ctx.action({
    id: 'webhook_list',
    description: 'List all webhook endpoint metadata (no secrets)',
    idempotent: true,
    cli: { command: ['webhook', 'list'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as never,
    outputSchema: {
      type: 'object',
      properties: { webhooks: { type: 'array' } },
      required: ['webhooks'],
      additionalProperties: false,
    } as never,
    handler: () => listWebhooks(),
  })

  ctx.action({
    id: 'webhook_delete',
    description: 'Delete a webhook endpoint (incl. secret cleanup)',
    cli: { command: ['webhook', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    } as never,
    handler: (input) => deleteWebhook(input as { id: string }),
  })

  // ---- Service lifecycle: doc read-in validation + secret redaction registration tied to enablement + in-flight request gate ----
  ctx.service({
    id: 'triggers-webhooks',
    start,
    stop,
    liveTasks,
    /** Persistent occupancy declaration: configured webhook endpoints are occupancy items of the disable precheck (plugin_in_use). */
    inUse() {
      return readDoc().webhooks.map((w) => ({
        kind: 'webhook_endpoint',
        id: w.id,
        label: `Webhook endpoint "${w.id}"`,
      }))
    },
  })

  return { createWebhook, listWebhooks, deleteWebhook }
}