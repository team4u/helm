/**
 * HTTP/SSE transport layer tests: real temporary directory + real services (auth/credentials/
 * profiles/skills/providers/artifacts/SecretStash) + real PluginHost route registration
 * (ctx.route full path declaration) + simulated runtime conversation layer.
 *
 * Covers: auth boundaries (status faithfully reflects token), setup/login, initial conversation deletion,
 * conversation CRUD and origins, path segment decoding (encoded pluginId / invalid encoding 400 / extra
 * segment 404), plugin dynamic routes (real registration, public exemption, raw URL passthrough),
 * raw null action returns / 500 on undefined schema violations, outbound JSON stash redaction (including quoted/
 * multiline secrets), raw array on providers PUT, plugin config { values },
 * profile delete 409, fake artifact metadata / symlink escape rejection & raw bytes,
 * skills traversal, body size caps, SSE initial snapshot & disconnect cleanup, graceful shutdown with zero leaks.
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { writeFile, mkdir, symlink, chmod, readFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import {
  AuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SkillService,
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  FileNotFoundError,
} from '../src/services/index.js'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { HelmError, type ConversationDetail, type ConversationEntry, type ConversationInputResult, type ConversationPatch, type ConversationSummary, type AskSpec, type PluginSummary, type HelmPluginContext } from '@helm/protocol'
import { createHubHandler, startHub } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike } from '../src/http/index.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js'

/** Initial conversation ID (SDK anchors #1 as default entry; normal conversation semantics, no special privileges). */
const ROOT_CONVERSATION_ID = 1 as const

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let dataDir: string
let auth: AuthService
let credentials: CredentialService
let profiles: ProfileService
let skills: SkillService
let providers: ProviderService
let artifacts: ArtifactService
let stash: SecretStash
let pluginHost: PluginHost
let handler0: ReturnType<typeof createHubHandler>
let token: string | undefined

/** Simulated EventHub: real subscription semantics + SSE response (initial snapshot frame + deltas). */
class TestEventHub implements EventHub {
  seq = 0
  private listeners = new Set<(event: { type: string; payload: unknown }) => void>()
  listenerCount(): number {
    return this.listeners.size
  }
  subscribe(listener: (event: { type: string; payload: unknown }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  publish(type: string, payload: unknown): void {
    this.seq += 1
    for (const listener of this.listeners) listener({ type, payload })
  }
  response(request: Request): Response {
    let unsubscribe: (() => void) | undefined
    let closed = false
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
          }
        }
        send('snapshot', { seq: 0, conversations: [], pendingAsks: [], plugins: [] })
        unsubscribe = hub0.subscribe((e) => send(e.type, { seq: ++hub0.seq, event: e }))
        request.signal.addEventListener('abort', () => {
          closed = true
          unsubscribe?.()
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        })
      },
      cancel() {
        closed = true
        unsubscribe?.()
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }
}

let hub0: TestEventHub

function summary(id: number, title: string): ConversationSummary {
  const now = Date.now()
  return makeConversationSummary({ id, title, model: 'faux/model', createdAt: now, updatedAt: now })
}

/** In-memory conversation layer: real services + simulated conversation/ask/search handlers. */
const conversations = new Map<number, ConversationSummary>()
const asks = new Map<string, AskSpec>()
const submitted: Array<{ id: number; text: string; opts?: Record<string, unknown> }> = []
const aborted: number[] = []
const withdrawn: Array<{ id: number; submissionId: number }> = []
let detailFixture: ConversationDetail | undefined
const detailCalls: Array<{ id: number; opts?: { limit?: number; cursor?: string } }> = []
const updateCalls: Array<{ id: number; patch: ConversationPatch }> = []
let entryFixture: ConversationEntry | undefined
const entryCalls: Array<{ id: number; entryId: number }> = []
let waitForInputResult: ConversationInputResult | undefined
let waitForInputError: HelmError | undefined
const waitForInputCalls: Array<{ id: number; submissionId: string }> = []
const setHubUrlCalls: string[] = []

function detailOf(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  const base = summary(1, 'Personal Assistant')
  return {
    ...base,
    entries: [
      { id: 'e2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }], createdAt: 2 },
      { id: 'e1', kind: 'helm.input', data: { id: 'i1', text: 'question', origin: 'human', createdAt: 1 } },
    ],
    nextCursor: '{"order":"descending","after":5}',
    ...overrides,
  }
}

function makeKernel(): KernelRuntimeLike {
  return {
    listNodes() { throw new Error('this HTTP fixture does not support node management') },
    async issueNodeToken() { throw new Error('this HTTP fixture does not issue node tokens') },
    async removeNode() { throw new Error('this HTTP fixture does not remove nodes') },
    async execEnv() { throw new Error('this HTTP fixture does not execute node commands') },
    dataDir,
    auth,
    events: hub0,
    profiles,
    skills,
    credentials,
    providers,
    artifacts,
    plugins: pluginHost,
    stash,
    setHubUrl(url: string) {
      setHubUrlCalls.push(url)
    },
    async listConversations(filter) {
      let out = [...conversations.values()]
      if (filter?.profileId) out = out.filter((c) => c.profileId === filter.profileId)
      if (filter?.tag) out = out.filter((c) => c.tags.includes(filter.tag!))
      if (filter?.status) out = out.filter((c) => c.status === filter.status)
      if (filter?.parentConversationId !== undefined) {
        out = out.filter((c) => c.parentConversationId === filter.parentConversationId)
      }
      if (filter?.topLevelOnly) out = out.filter((c) => c.parentConversationId === undefined)
      return out
    },
    async getConversationDetail(id: number, opts?: { limit?: number; cursor?: string }) {
      detailCalls.push({ id, opts })
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      if (detailFixture !== undefined) {
        return { ...detailFixture, id }
      }
      return { ...conversations.get(id)!, entries: [] }
    },
    async getConversationEntry(id: number, entryId: number) {
      entryCalls.push({ id, entryId })
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      if (entryFixture !== undefined) return { ...entryFixture, id: String(entryId) }
      throw new HelmError('not_found', `entry ${entryId} not found in conversation ${id}`, 404, { conversationId: id, entryId })
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const created = summary(id, init?.title ?? `conversation ${id}`)
      if (init?.profileId !== undefined) created.profileId = init.profileId
      if (init?.model !== undefined) created.model = init.model
      conversations.set(id, created)
      return created
    },
    async updateConversation(id, patch) {
      updateCalls.push({ id, patch: { ...patch } })
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    async deleteConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      conversations.delete(id)
    },
    async submitInput(id, text, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      submitted.push({ id, text, opts })
      return { submissionId: 'sub-mock' }
    },
    async withdrawQueuedInput(id, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      withdrawn.push({ id, submissionId: opts.submissionId })
      return { status: 'withdrawn' }
    },
    async waitForInput(id: number, submissionId: string) {
      waitForInputCalls.push({ id, submissionId })
      if (waitForInputError) throw waitForInputError
      if (waitForInputResult !== undefined) return waitForInputResult
      return { conversationId: id, submissionId, text: '', entry: { id: 'e', kind: 'pi.assistant' } }
    },
    async abortConversation(id) {
      aborted.push(id)
    },
    async resetConversation(id) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return found
    },
    async compactConversation(id) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return { taskId: 1, conversation: found }
    },
    async forkConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return summary(id + 100, `conversation ${id} (fork)`)
    },
    async listAsks() {
      return [...asks.values()]
    },
    async answerAsk(id, answers, expectedStateSeq) {
      const ask = asks.get(id)
      if (ask === undefined) throw new HelmError('not_found', `ask not found: ${id}`, 404)
      if (expectedStateSeq !== undefined && ask.expectedStateSeq !== undefined && expectedStateSeq < ask.expectedStateSeq) {
        throw new HelmError('superseded', 'already handled on terminal', 409)
      }
      void answers
      asks.delete(id)
    },
    async cancelAsk(id) {
      if (!asks.has(id)) throw new HelmError('not_found', `ask not found: ${id}`, 404)
      asks.delete(id)
    },
    async search(q) {
      return [{ conversationId: 1, snippet: `hit:${q}` }]
    },
    listModels: () => ({ models: [{ provider: 'faux', modelId: 'model', available: true }], thinkingLevels: {} }),
    listModelProviders: () => [{ id: 'faux', name: 'Faux', modelCount: 1, authMethods: [{ type: 'api_key', label: 'API Key' }] }],
    refreshModels: undefined,
  }
}

/** Builds a mock kernel with injectable refreshModels (to test 501 when unset). */
function makeKernelWithRefresh(refreshImpl?: KernelRuntimeLike['refreshModels']): KernelRuntimeLike {
  const kernel = makeKernel()
  if (refreshImpl !== undefined) kernel.refreshModels = refreshImpl
  return kernel
}

function makeHandlers(kernel = makeKernel()) {
  return { kernel, handler: createHubHandler(kernel) }
}

async function call(handler: (req: Request) => Promise<Response>, method: string, path: string, opts?: { body?: unknown; auth?: boolean; raw?: string; contentType?: string; origin?: string }): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const headers: Record<string, string> = {}
  if (opts?.body !== undefined || opts?.raw !== undefined) headers['content-type'] = opts?.contentType ?? 'application/json'
  else if (opts?.contentType !== undefined) headers['content-type'] = opts.contentType
  if (opts?.origin !== undefined) headers.origin = opts.origin
  if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
  const body = opts?.raw !== undefined ? opts.raw : opts?.body !== undefined ? JSON.stringify(opts.body) : undefined
  const request = new Request(`http://127.0.0.1:3202${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  })
  const response = await handler(request)
  const text = await response.text()
  let parsed: any
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, headers: response.headers, text }
}

// ---------------------------------------------------------------------------
// Real PluginHost route registration (definePlugin(ctx) ctx.route full declaration)
// ---------------------------------------------------------------------------

let publicHandlerCalls: Request[] = []
let privateHandlerCalls: Request[] = []

function hostApiForPluginHost(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => summary(99, 'x'),
    listConversations: () => [...conversations.values()],
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return found
    },
    updateConversation: async (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return found
    },
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture does not execute node commands', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture does not support file mutation queue') },
    emitEvent: () => {},
  }
}

/** Registers a real plugin with both public and private routes plus an action. */
async function registerRoutePlugin(host: PluginHost): Promise<void> {
  publicHandlerCalls = []
  privateHandlerCalls = []
  await host.register({
    id: 'builtin:triggers',
    name: 'triggers',
    async definePlugin(ctx: HelmPluginContext) {
      // PluginHost declares relative paths and mounts them under /api/plugins/<enc id>/routes/...
      ctx.route({
        method: 'POST',
        path: '/webhook/:hookId',
        public: true,
        handler: (req) => {
          publicHandlerCalls.push(req)
          return Response.json({ got: new URL(req.url).pathname })
        },
      })
      ctx.route({
        method: 'GET',
        path: '/status',
        handler: (req) => {
          privateHandlerCalls.push(req)
          return Response.json({ ok: true })
        },
      })
      ctx.action({
        id: 'echo',
        description: 'echo text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        outputSchema: { type: 'object' },
        async handler(input) {
          const text = (input as { text?: unknown }).text
          if (typeof text !== 'string') throw new HelmError('validation_error', 'text must be a string', 400)
          return { echoed: text }
        },
      })
    },
  })
}

async function registerDocPlugin(host: PluginHost): Promise<void> {
  await host.register({
    id: 'builtin:statusboard',
    name: 'statusboard',
    async definePlugin(ctx: HelmPluginContext) {
      const pub = ctx.doc('board', { count: 0 }, { public: true })
      pub.set({ count: 42 })
      ctx.doc('secret-board', { hidden: true })
    },
  })
  await host.enable('builtin:statusboard')
}

before(async () => {
  dataDir = await makeTempDir('helm-http-test-')
  auth = new AuthService(dataDir)
  credentials = new CredentialService(dataDir)
  profiles = new ProfileService(dataDir)
  skills = new SkillService(dataDir)
  providers = new ProviderService(dataDir)
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  pluginHost = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: hostApiForPluginHost(), docs: new MemoryDocStore() })
  await registerRoutePlugin(pluginHost)
  await registerDocPlugin(pluginHost)
  hub0 = new TestEventHub()
  handler0 = createHubHandler(makeKernel())
  conversations.set(ROOT_CONVERSATION_ID, summary(1, 'Personal Assistant'))
  conversations.set(2, { ...summary(2, 'Worker'), profileId: 'worker', tags: ['worker'] })
  conversations.set(3, {
    ...summary(3, 'subagent 3'),
    parentConversationId: ROOT_CONVERSATION_ID,
    parentToolCallId: 'call-1',
    ownedBy: 'helm',
  })
  conversations.set(4, { ...summary(4, 'fork 4'), parentConversationId: 2 })
})

after(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// Auth boundaries
// ---------------------------------------------------------------------------

test('unconfigured before setup: all private endpoints return 401 (no anonymous setup bypass)', { timeout: 60_000 }, async () => {
  token = undefined
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations', { auth: false })
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'unauthorized')
})

test('GET /api/auth/status faithfully reflects Bearer token: unconfigured / no token / wrong token all return false', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // unconfigured + no token
  const noSetup = await call(handler, 'GET', '/api/auth/status', { auth: false })
  assert.equal(noSetup.status, 200)
  assert.deepEqual(noSetup.body, { configured: false, authenticated: false })
  // unconfigured + invalid token: configured and authenticated reported independently
  const saved = token
  token = 'deadbeef-token'
  const badToken = await call(handler, 'GET', '/api/auth/status')
  assert.deepEqual(badToken.body, { configured: false, authenticated: false })
  token = saved
})

test('status after setup: no token false; wrong token false; valid token true', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const setup = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'hunter2hunter2' } })
  assert.equal(setup.status, 200)
  token = setup.body.token
  const noToken = await call(handler, 'GET', '/api/auth/status', { auth: false })
  assert.deepEqual(noToken.body, { configured: true, authenticated: false })
  const saved = token
  token = 'deadbeef'.repeat(8)
  const bad = await call(handler, 'GET', '/api/auth/status')
  assert.deepEqual(bad.body, { configured: true, authenticated: false })
  token = saved
  const ok = await call(handler, 'GET', '/api/auth/status')
  assert.deepEqual(ok.body, { configured: true, authenticated: true })
})

test('prevents cross-site pre-setup hijack: non-JSON text/plain gets 415 without writing config; valid JSON succeeds', { timeout: 60_000 }, async () => {
  // Isolated dataDir: verify malicious cross-origin form POST cannot hijack initial password setup
  const evilDir = await makeTempDir('helm-http-evil-')
  try {
    const evilAuth = new AuthService(evilDir)
    const evilKernel = makeKernel()
    ;(evilKernel as { auth: AuthService }).auth = evilAuth
    const handler = createHubHandler(evilKernel)
    // Non-JSON simple POST (allowed by cross-site form) -> 415, never reaches setup
    const malicious = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-123' }),
    })
    assert.equal(malicious.status, 415)
    assert.equal(malicious.body.error.code, 'unsupported_media_type')
    // Config untouched: remains unconfigured
    assert.deepEqual(await evilAuth.status(), { configured: false })
    // Legitimate origin + JSON sets up normally
    const ok = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'http://192.168.31.26:3201',
      body: { password: 'legit-password-123' },
    })
    assert.equal(ok.status, 200)
    assert.equal(typeof ok.body.token, 'string')
    // Already configured: subsequent non-JSON still rejected
    const again = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-456' }),
    })
    assert.equal(again.status, 415)
    // CLI call without Origin: text/plain still rejected (JSON endpoint), JSON passes
    const cliBad = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'legit-password-789' }),
    })
    assert.equal(cliBad.status, 415)
    const cliOk = await call(handler, 'POST', '/api/auth/login', {
      auth: false,
      body: { password: 'legit-password-123' },
    })
    assert.equal(cliOk.status, 200)
  } finally {
    await cleanupDir(evilDir)
  }
})

test('POST /api/auth/setup weak password returns 400 weak_password; repeat setup returns 409', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'short' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'weak_password')
  const dup = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'another-pass-123' } })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error.code, 'already_setup')
})

test('POST /api/auth/login before setup returns 409 not_setup', { timeout: 60_000 }, async () => {
  // Isolated dataDir: shared fixture completed setup in first auth test, which would otherwise mask unconfigured branch
  const freshDir = await makeTempDir('helm-http-nosetup-')
  try {
    const freshKernel = makeKernel()
    ;(freshKernel as { auth: AuthService }).auth = new AuthService(freshDir)
    const handler = createHubHandler(freshKernel)
    const res = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: '{{SECRET_nsetup9q}}' } })
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'not_setup')
    assert.equal(res.body.error.message, 'authentication is not configured yet; run setup first')
  } finally {
    await cleanupDir(freshDir)
  }
})

test('POST /api/auth/login valid password returns 200 / wrong password returns 401 invalid_credentials', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'hunter2hunter2' } })
  assert.equal(ok.status, 200)
  assert.equal(typeof ok.body.token, 'string')
  const bad = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'wrong-password-9' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.body.error.code, 'invalid_credentials')
})

test('invalid token returns 401; valid token passes', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const bad = await call(handler, 'GET', '/api/conversations', { auth: false })
  assert.equal(bad.status, 401)
  const saved = token
  token = 'deadbeef'.repeat(8)
  const invalid = await call(handler, 'GET', '/api/conversations')
  assert.equal(invalid.status, 401)
  token = saved
  const ok = await call(handler, 'GET', '/api/conversations')
  assert.equal(ok.status, 200)
  assert.ok(Array.isArray(ok.body))
})

// ---------------------------------------------------------------------------
// Conversation lifecycle
// ---------------------------------------------------------------------------

test('POST /api/conversations create; PATCH update; DELETE conversation 200 (no ID-level exemption)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/conversations', { body: { title: 'test conversation', cwd: '/tmp', tags: ['worker'] } })
  assert.equal(created.status, 201)
  assert.equal(created.body.title, 'test conversation')
  const id = created.body.id
  const patched = await call(handler, 'PATCH', `/api/conversations/${id}`, { body: { title: 'renamed', pinned: true } })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.title, 'renamed')
  assert.equal(patched.body.pinned, true)
  const deleted = await call(handler, 'DELETE', `/api/conversations/${id}`)
  assert.equal(deleted.status, 200)
  const gone = await call(handler, 'GET', `/api/conversations/${id}`)
  assert.equal(gone.status, 404)
})

test('POST /api/conversations rejects empty string model on creation: must be provider/model', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/conversations', { body: { model: '' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
  const bad = await call(handler, 'POST', '/api/conversations', { body: { model: 'gpt-4o' } })
  assert.equal(bad.status, 400)
  const ok = await call(handler, 'POST', '/api/conversations', { body: { model: 'openai/gpt-4o' } })
  assert.equal(ok.status, 201)
})

test('PATCH /:id model override and empty-string clearing boundary; other fields unaffected', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // Valid provider/model override passes through
  const set = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: 'openai/gpt-4o' },
  })
  assert.equal(set.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: 'openai/gpt-4o' })

  // Empty string = clear override (accepted and forwarded at HTTP boundary; semantics handled by kernel.updateConversation)
  const clear = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: '' },
  })
  assert.equal(clear.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: '' })

  // Model ID may contain slashes (e.g. dynamic routing groups); first segment remains provider.
  const nested = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: 'gateway/group/smart' } })
  assert.equal(nested.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: 'gateway/group/smart' })

  // Malformed values still return 400: missing provider, contains spaces, whitespace only
  for (const bad of ['gpt-4o', 'openai /gpt', 'openai/ gpt', ' ']) {
    const res = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: bad } })
    assert.equal(res.status, 400, `model=${JSON.stringify(bad)} should return 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
  // Non-string rejects
  const num = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: 42 } })
  assert.equal(num.status, 400)
})

test('GET /api/conversations?profileId filter passes through (combines with tag/status in kernel)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations?profileId=worker')
  assert.equal(res.status, 200)
  assert.equal(res.body.length, 1)
  assert.equal(res.body[0].profileId, 'worker')
  const none = await call(handler, 'GET', '/api/conversations?profileId=nobody')
  assert.deepEqual(none.body, [])
})

test('conversation list noise-reduction contract: top-level by default, all=1 returns all, parent=<id> direct children, invalid params 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // Default: top-level conversations only (no parentConversationId)
  const top = await call(handler, 'GET', '/api/conversations')
  assert.equal(top.status, 200)
  assert.ok(top.body.every((c: ConversationSummary) => c.parentConversationId === undefined), 'default list must exclude child conversations')
  assert.ok(top.body.some((c: ConversationSummary) => c.id === ROOT_CONVERSATION_ID), 'top-level entry conversation must be listed')
  // --all: full list (including subagents and forks)
  const all = await call(handler, 'GET', '/api/conversations?all=1')
  assert.equal(all.status, 200)
  assert.ok(all.body.some((c: ConversationSummary) => c.id === 3), 'all=1 should include subagent child')
  assert.ok(all.body.some((c: ConversationSummary) => c.id === 4), 'all=1 should include fork child')
  // parent=<id>: exact direct children
  const children = await call(handler, 'GET', `/api/conversations?parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(children.status, 200)
  assert.deepEqual(
    children.body.map((c: ConversationSummary) => c.id),
    [3],
    'parent=1 returns only direct children',
  )
  const noneChildren = await call(handler, 'GET', '/api/conversations?parent=999')
  assert.equal(noneChildren.status, 200)
  assert.deepEqual(noneChildren.body, [])
  // Combines via AND with other filters (fork 4 defaults to assistant profile: verifies parent sub-dimension stacks)
  const workerChild = await call(handler, 'GET', '/api/conversations?parent=2&profileId=assistant')
  assert.equal(workerChild.status, 200)
  assert.deepEqual(workerChild.body.map((c: ConversationSummary) => c.id), [4])
  // Strict input validation: invalid parent / all+parent mutual exclusion / invalid all
  for (const bad of ['abc', '0', '-1', '1.5', '999999999999999999999']) {
    const res = await call(handler, 'GET', `/api/conversations?parent=${bad}`)
    assert.equal(res.status, 400, `parent=${bad} should return 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
  const conflict = await call(handler, 'GET', `/api/conversations?all=1&parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(conflict.status, 400)
  assert.equal(conflict.body.error.code, 'validation_error')
  const badAll = await call(handler, 'GET', '/api/conversations?all=yes')
  assert.equal(badAll.status, 400)
  assert.equal(badAll.body.error.code, 'validation_error')
  // all=0 resets to default (top-level only) and may combine with parent without triggering mutual-exclusion conflict
  const allOff = await call(handler, 'GET', `/api/conversations?all=0&parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(allOff.status, 200)
  assert.deepEqual(allOff.body.map((c: ConversationSummary) => c.id), [3])
})

test('invalid conversationId and invalid fields return 400 validation_error', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const badId = await call(handler, 'GET', '/api/conversations/abc')
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error.code, 'validation_error')
  const badBody = await call(handler, 'POST', '/api/conversations', { body: { title: 123 } })
  assert.equal(badBody.status, 400)
  const unknownField = await call(handler, 'POST', '/api/conversations', { body: { title: 'x', bogus: true } })
  assert.equal(unknownField.status, 400)
})

test('GET /:id returns details (top-level summary fields + entries + nextCursor)', { timeout: 60_000 }, async () => {
  detailFixture = detailOf()
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}`)
  assert.equal(res.status, 200)
  // Top-level summary fields remain directly accessible (id/title/status...), with entries/nextCursor flat at root
  assert.equal(res.body.id, ROOT_CONVERSATION_ID)
  assert.equal(res.body.title, 'Personal Assistant')
  assert.equal(res.body.status, 'idle')
  assert.ok(Array.isArray(res.body.entries))
  assert.equal(res.body.entries.length, 2)
  assert.equal(res.body.entries[0].kind, 'pi.assistant')
  assert.ok(Array.isArray(res.body.entries[0].model))
  assert.equal(res.body.entries[1].kind, 'helm.input')
  assert.deepEqual(res.body.entries[1].data, { id: 'i1', text: 'question', origin: 'human', createdAt: 1 })
  assert.equal(typeof res.body.nextCursor, 'string')
})

test('GET /:id?limit/cursor forwards to kernel.getConversationDetail; invalid values return 400', { timeout: 60_000 }, async () => {
  detailFixture = detailOf()
  const { handler } = makeHandlers()
  const ok = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?limit=10&cursor=${encodeURIComponent('{"a":1}')}`)
  assert.equal(ok.status, 200)
  const last = detailCalls.at(-1)!
  assert.equal(last.id, ROOT_CONVERSATION_ID)
  assert.deepEqual(last.opts, { limit: 10, cursor: '{"a":1}' })

  for (const bad of ['limit=0', 'limit=-1', 'limit=abc', 'limit=501']) {
    const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?${bad}`)
    assert.equal(res.status, 400, bad)
    assert.equal(res.body.error.code, 'validation_error')
  }
  const emptyCursor = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?cursor=`)
  assert.equal(emptyCursor.status, 400)
})

test('GET /:id returns 404 on missing conversation and 404 on extra segments', { timeout: 60_000 }, async () => {
  detailFixture = undefined
  const { handler } = makeHandlers()
  const missing = await call(handler, 'GET', '/api/conversations/999')
  assert.equal(missing.status, 404)
  const extra = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries`)
  assert.equal(extra.status, 404)
})

test('GET /:id/entries/:entryId single-entry endpoint: passthrough / 404 / 400 / extra segments', { timeout: 60_000 }, async () => {
  entryFixture = {
    id: '7',
    kind: 'pi.tool-result',
    model: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(4000) }] }],
  }
  const { handler } = makeHandlers()
  const ok = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries/7`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.kind, 'pi.tool-result')
  assert.equal(ok.body.id, '7')
  assert.equal(ok.body.model[0].content[0].text, 'x'.repeat(4000))
  assert.deepEqual(entryCalls.at(-1), { id: ROOT_CONVERSATION_ID, entryId: 7 })

  const missingConv = await call(handler, 'GET', '/api/conversations/999/entries/7')
  assert.equal(missingConv.status, 404)
  entryFixture = undefined // conversation exists, entry missing -> 404
  const missingEntry = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries/8`)
  assert.equal(missingEntry.status, 404)
  assert.equal(missingEntry.body.error.code, 'not_found')

  for (const bad of ['0', '-1', 'abc', '1.5', '999999999999999999999999']) {
    const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries/${bad}`)
    assert.equal(res.status, 400, bad)
    assert.equal(res.body.error.code, 'validation_error', bad)
  }
  const extraSeg = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries/7/extra`)
  assert.equal(extraSeg.status, 404)
  const wrongMethod = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/entries/7`, { body: {} })
  assert.equal(wrongMethod.status, 404)
})

test('JSON response gzip: threshold / negotiation / Vary merge / Content-Length / round-trip integrity', { timeout: 60_000 }, async () => {
  detailFixture = detailOf({
    entries: [
      {
        id: 'big',
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(8192) }] }],
      },
    ],
  })
  const { handler } = makeHandlers()
  // Origin + Accept-Encoding: gzip -> compressed + Vary merges Origin and Accept-Encoding
  const direct = new Request(`http://127.0.0.1:3202/api/conversations/${ROOT_CONVERSATION_ID}?limit=50`, {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip, br', origin: 'http://x' },
  })
  const res = await handler(direct)
  assert.equal(res.headers.get('content-encoding'), 'gzip')
  const vary = res.headers.get('vary') ?? ''
  const varyTokens = vary.toLowerCase().split(',').map((s) => s.trim())
  assert.ok(varyTokens.includes('accept-encoding'), vary)
  assert.ok(varyTokens.includes('origin'), vary)
  const compressed = new Uint8Array(await res.arrayBuffer())
  assert.equal(Number(res.headers.get('content-length')), compressed.byteLength)
  const decompressed = gunzipSync(compressed).toString('utf8')
  const parsed = JSON.parse(decompressed)
  assert.equal(parsed.entries[0].model[0].content[0].text, 'y'.repeat(8192))

  // Small responses (<1KiB) stay uncompressed yet still include Vary; full body readable (not consumed by clone)
  const smallReq = new Request('http://127.0.0.1:3202/api/conversations', {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const small = await handler(smallReq)
  assert.equal(small.headers.get('content-encoding'), null)
  assert.ok(
    (small.headers.get('vary') ?? '').toLowerCase().split(',').map((t) => t.trim()).includes('accept-encoding'),
    'identity small response should still include Vary: Accept-Encoding',
  )
  const smallBody = await small.text()
  assert.ok(Array.isArray(JSON.parse(smallBody)), 'identity response body must not be consumed by clone')

  // Client without gzip acceptance gets identity
  const identity = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?limit=50`)
  assert.equal(identity.headers.get('content-encoding'), null)

  // q=0 treated as rejection
  const q0 = new Request(`http://127.0.0.1:3202/api/conversations/${ROOT_CONVERSATION_ID}?limit=50`, {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip;q=0, br' },
  })
  const q0res = await handler(q0)
  assert.equal(q0res.headers.get('content-encoding'), null)
  await q0res.text()

  // SSE stays uncompressed (text/event-stream)
  const sseReq = new Request('http://127.0.0.1:3202/api/events', {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const sse = await handler(sseReq)
  assert.equal(sse.headers.get('content-type'), 'text/event-stream')
  assert.equal(sse.headers.get('content-encoding'), null)
  await sse.body?.cancel() // mock SSE stream stays open: cancel directly rather than awaiting full body read

  // HEAD stays uncompressed
  const headReq = new Request(`http://127.0.0.1:3202/api/conversations/${ROOT_CONVERSATION_ID}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const head = await handler(headReq)
  assert.equal(head.headers.get('content-encoding'), null)
  await head.text()
})

test('POST /:id/input validates origin/whenBusy enums and forwards to kernel.submitInput', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: '你好', origin: 'human', whenBusy: 'followUp' },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(ok.body, { submissionId: 'sub-mock' })
  assert.equal(submitted.at(-1)?.text, '你好')
  assert.deepEqual(submitted.at(-1)?.opts, { origin: 'human', whenBusy: 'followUp' })
  const badOrigin = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', origin: 'alien' },
  })
  assert.equal(badOrigin.status, 400)
  const badWhenBusy = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', whenBusy: 'wait' },
  })
  assert.equal(badWhenBusy.status, 400)
})

test('POST input meta: plain JSON objects pass through opts.meta; arrays/scalars/unknown fields return 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', meta: { source: 'cron', extra: { nested: [1, 2] } } },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(submitted.at(-1)?.opts, { meta: { source: 'cron', extra: { nested: [1, 2] } } })

  const asArray = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', meta: [1, 2] },
  })
  assert.equal(asArray.status, 400)
  const asScalar = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', meta: 'cron' },
  })
  assert.equal(asScalar.status, 400)
  const unknown = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', meta: {}, extra: true },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'validation_error')
})

test('POST input?wait=1 invokes waitForInput and returns ConversationInputResult; invalid wait returns 400', { timeout: 60_000 }, async () => {
  waitForInputResult = {
    conversationId: ROOT_CONVERSATION_ID,
    submissionId: 'sub-1',
    text: '你好',
    entry: { id: 'e9', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }] },
  }
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=1`, {
    body: { text: '你好' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.submissionId, 'sub-1')
  assert.equal(res.body.conversationId, ROOT_CONVERSATION_ID)
  assert.equal(res.body.entry.kind, 'pi.assistant')
  assert.deepEqual(waitForInputCalls.at(-1), { id: ROOT_CONVERSATION_ID, submissionId: 'sub-mock' })

  const bad = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=yes`, {
    body: { text: 'x' },
  })
  assert.equal(bad.status, 400)

  // HelmError thrown by waitForInput (aborted etc.) passes status/code through cleanly
  waitForInputError = new HelmError('input_unanswered', 'input received no answer (aborted)', 409, { reason: 'aborted' })
  const failed = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=1`, {
    body: { text: 'x' },
  })
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error.code, 'input_unanswered')
  waitForInputError = undefined
  waitForInputResult = undefined
})

test('POST /:id/input validates replaceFromEntryId and passes through; default preserves opts shape', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'rewrite prompt', replaceFromEntryId: 5 },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(submitted.at(-1)?.opts, { replaceFromEntryId: 5 })
  // Default: replaceFromEntryId key omitted to keep existing opts shape invariant
  const plain = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'normal submission' },
  })
  assert.equal(plain.status, 202)
  assert.equal(
    submitted.at(-1)?.opts && 'replaceFromEntryId' in (submitted.at(-1)!.opts as object),
    false,
    'opts must omit replaceFromEntryId key by default',
  )
  // Invalid values: 0, negative, float, unsafe integer, string all return 400
  for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, '5']) {
    const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
      body: { text: 'x', replaceFromEntryId: bad },
    })
    assert.equal(res.status, 400, `replaceFromEntryId=${String(bad)} should return 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
})

test('POST /:id/withdraw validates submissionId and calls withdrawQueuedInput', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 42 },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { status: 'withdrawn' })
  assert.deepEqual(withdrawn.at(-1), { id: ROOT_CONVERSATION_ID, submissionId: 42 })
  // Invalid body: missing field / 0 / decimal / unknown key
  const missing = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, { body: {} })
  assert.equal(missing.status, 400)
  const zero = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 0 },
  })
  assert.equal(zero.status, 400)
  const float = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 1.5 },
  })
  assert.equal(float.status, 400)
  const unknown = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 1, extra: true },
  })
  assert.equal(unknown.status, 400)
  // Missing conversation 404 (mock throws not_found)
  const nf = await call(handler, 'POST', '/api/conversations/88888/withdraw', { body: { submissionId: 1 } })
  assert.equal(nf.status, 404)
  // Extra segment 404
  const extra = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw/x`, {
    body: { submissionId: 1 },
  })
  assert.equal(extra.status, 404)
})

test('POST /:id/abort invokes abortConversation', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/abort`)
  assert.equal(res.status, 200)
  assert.ok(aborted.includes(ROOT_CONVERSATION_ID))
})

// ---------------------------------------------------------------------------
// Path segment decoding
// ---------------------------------------------------------------------------

test('encoded pluginId decodes cleanly: builtin%3Atriggers equals builtin:triggers', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const encoded = await call(handler, 'GET', '/api/plugins/builtin%3Atriggers/config')
  assert.equal(encoded.status, 200)
  const plain = await call(handler, 'GET', '/api/plugins/builtin:triggers/config')
  assert.equal(plain.status, 200)
  // Encoded and unencoded segments return identical responses
  assert.deepEqual(encoded.body, plain.body)
})

test('invalid percent-encoding returns 400 invalid_path_encoding', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/plugins/builtin%3Aassistant%zz/config')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_path_encoding')
})

test('extra path segments return 404: never fall into shorter routes (auth/status/foo, workflows abort/extra, etc.)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const statusFoo = await call(handler, 'GET', '/api/auth/status/foo')
  assert.equal(statusFoo.status, 404)
  const abortExtra = await call(handler, 'POST', '/api/workflows/runs/run-1/abort/extra')
  assert.equal(abortExtra.status, 404)
  const runExtra = await call(handler, 'POST', '/api/workflows/run/x/extra/deep')
  assert.equal(runExtra.status, 404)
  const artifactsExtra = await call(handler, 'GET', `/api/artifacts/some-id/content/extra`)
  assert.equal(artifactsExtra.status, 404)
})

test('encoded slash (%2F) does not re-split segments: stays single segment after decode', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // After decoding %2F becomes part of a single segment ('a/b') without re-splitting the route;
  // invalid profileId is then rejected with 400 by single-segment param validation.
  const res = await call(handler, 'GET', '/api/profiles/a%2Fb')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('SSE initial snapshot + incremental events + unsubscription on disconnect (no leaked listeners)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const controller = new AbortController()
  const request = new Request('http://127.0.0.1:3202/api/events', {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  const response = await handler(request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  const firstText = decoder.decode(first.value)
  assert.ok(firstText.includes('event: snapshot'))
  assert.ok(firstText.includes('"conversations"'))
  assert.ok(hub0.listenerCount() >= 1)
  hub0.publish('conversation.upsert', { type: 'conversation.upsert', conversation: summary(9, 'event conversation') })
  const second = await reader.read()
  assert.ok(decoder.decode(second.value).includes('conversation.upsert'))
  const before = hub0.listenerCount()
  controller.abort()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(hub0.listenerCount(), before - 1)
})

test('SSE unauthenticated returns 401', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const request = new Request('http://127.0.0.1:3202/api/events')
  const response = await handler(request)
  assert.equal(response.status, 401)
})

// ---------------------------------------------------------------------------
// Profiles / Providers / Credentials / Skills / Models
// ---------------------------------------------------------------------------

test('profiles CRUD (real ProfileService + system online read/write; memory contract removed)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'researcher',
      name: 'Researcher',
      runtime: { kind: 'herdr', agent: 'agy' },
      system: '# Researcher system prompt\nBe rigorous.',
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.id, 'researcher')
  assert.equal(created.body.system, '# Researcher system prompt\nBe rigorous.')
  assert.equal(created.body.memory, undefined, 'Profile contract no longer includes memory field')
  const list = await call(handler, 'GET', '/api/profiles')
  assert.ok(list.body.some((p: any) => p.id === 'researcher'))
  const put = await call(handler, 'PUT', '/api/profiles/researcher', {
    body: { name: 'Senior Researcher', system: '# Senior Researcher prompt\nUpdated edition.' },
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.name, 'Senior Researcher')
  assert.equal(put.body.system, '# Senior Researcher prompt\nUpdated edition.')
  const got = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(got.status, 200)
  assert.equal(got.body.system, '# Senior Researcher prompt\nUpdated edition.')
  // Requests carrying legacy memory field reject at boundary (no compatibility fallback)
  const rejected = await call(handler, 'PUT', '/api/profiles/researcher', {
    body: { memory: '# old memory' },
  })
  assert.equal(rejected.status, 400)
  assert.match(String(rejected.body?.error?.message ?? ''), /memory/)
  const del = await call(handler, 'DELETE', '/api/profiles/researcher')
  assert.equal(del.status, 200)
  const gone = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(gone.status, 404)
})

test('profiles detail read failure throws explicitly rather than returning blank body that overwrites file', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await profiles.save({ id: 'missing-system', name: 'Missing Body' })
  await rm(join(dataDir, 'profiles', 'missing-system', 'SYSTEM.md'))
  const result = await call(handler, 'GET', '/api/profiles/missing-system')
  assert.equal(result.status, 404)
  assert.ok(result.body.error)
  assert.equal(result.body.system, undefined)
})

test('profiles POST/PUT rejects disabled model binding pre-flight (409 model_disabled); non-blocking when port absent', { timeout: 60_000 }, async () => {
  // Fixture kernel omitting assertModelEnabled port: save stays unblocked (optional port semantics).
  {
    const { handler } = makeHandlers()
    const created = await call(handler, 'POST', '/api/profiles', {
      body: { id: 'no-port-profile', name: 'no port', model: 'faux/model' },
    })
    assert.equal(created.status, 201)
  }
  // When port is provided: both POST and PUT reject disabled models with 409 without persisting.
  const kernel = makeKernel()
  kernel.assertModelEnabled = (provider, modelId) => {
    if (provider === 'faux' && modelId === 'disabled-model') {
      throw new HelmError('model_disabled', `model ${provider}/${modelId} is disabled`, 409)
    }
  }
  const handler = createHubHandler(kernel)
  const rejected = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'disabled-bind', name: 'bind disabled model', model: 'faux/disabled-model' },
  })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'model_disabled')
  assert.equal(await profiles.get('disabled-bind'), undefined, 'must not write to disk after POST rejection')

  // Same for PUT: changing an existing profile to a disabled model rejects.
  await profiles.save({ id: 'put-target', name: 'existing role' })
  const putRejected = await call(handler, 'PUT', '/api/profiles/put-target', {
    body: { name: 'rebind disabled model', model: 'faux/disabled-model' },
  })
  assert.equal(putRejected.status, 409)
  assert.equal(putRejected.body.error.code, 'model_disabled')
  assert.equal((await profiles.get('put-target'))?.model, undefined, 'original value must remain unchanged after PUT rejection')

  // Valid models save normally; clearing (omitting model field) skips preflight.
  const ok = await call(handler, 'PUT', '/api/profiles/put-target', {
    body: { name: 'rebind valid model', model: 'faux/model' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.model, 'faux/model')
})

test('profiles DELETE still bound by a conversation returns 409 profile_in_use', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bound-profile', name: 'in use', runtime: { kind: 'herdr', agent: 'agy' } },
  })
  const created = await call(handler, 'POST', '/api/conversations', {
    body: { title: 'bound conversation', profileId: 'bound-profile' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.profileId, 'bound-profile')
  const rejected = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'profile_in_use')
  // Can delete once unbound
  await call(handler, 'PATCH', `/api/conversations/${created.body.id}`, { body: { profileId: 'assistant' } })
  // Fixture PATCH does not mutate profileId automatically; update in-memory directly to test deletion path
  const conv = conversations.get(created.body.id)!
  conv.profileId = 'assistant'
  const ok = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(ok.status, 200)
})

test('profiles skills allowlist HTTP round-trip: three states (create/update/readback); invalid ID and wrong types reject', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // Create: deduplicates allowlist + permits temporarily absent IDs (for later installation)
  const created = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'skills-profile', name: 'skills allowlist', skills: ['helm-cli', 'future-skill', 'helm-cli'] },
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.skills, ['helm-cli', 'future-skill'], 'duplicate entries deduplicated on return')

  // PUT sets empty array (disable all) -- full-replacement contract, not treated as default
  const put = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: 'skills allowlist', skills: [] },
  })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body.skills, [], 'empty array must persist intact')
  const onDisk = JSON.parse(
    await readFile(join(dataDir, 'profiles', 'skills-profile', 'profile.json'), 'utf8'),
  ) as { skills?: string[] }
  assert.deepEqual(onDisk.skills, [], 'HTTP write preserves empty array')

  // PUT omits skills (full-replacement semantics: resets to default allow-all)
  const put2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: 'skills allowlist' },
  })
  assert.equal(put2.status, 200)
  assert.equal(put2.body.skills, undefined, 'PUT omitting skills resets to default (omits key)')

  // GET reads real service state
  const got = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(got.status, 200)
  assert.equal(got.body.skills, undefined)

  // Invalid skill ID (path injection form) rejects without partial write
  const bad = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bad-skills', skills: ['../profiles/assistant'] },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'validation_error')
  const bad2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { skills: 'helm-cli' },
  })
  assert.equal(bad2.status, 400)
  // Previously saved state remains untouched after rejection (stays default)
  const after = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(after.body.skills, undefined)
})

test('profiles hosting protection: managedByPlugin blocks delete/tamper; POST cannot spoof managed identity', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // Trusted plugin asset writes directly (bypassing HTTP): ProfileService.save with managedByPlugin
  await profiles.save({
    id: 'hub-managed',
    name: 'managed hub',
    managedByPlugin: 'builtin:superagent',
    humanSelectable: false,
  })
  // DELETE: managed Profile -> 403 (even without conversation binding; pure hosting protection)
  const del = await call(handler, 'DELETE', '/api/profiles/hub-managed')
  assert.equal(del.status, 403)
  assert.equal(del.body.error.code, 'profile_managed_by_plugin')

  // PUT omits managedByPlugin (full-replacement treats omission as stripping): 403
  const putStrip = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'renamed' },
  })
  assert.equal(putStrip.status, 403)
  assert.equal(putStrip.body.error.code, 'profile_managed_by_plugin')

  // PUT attempts changing owner to another plugin: 403
  const putFake = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'renamed', managedByPlugin: 'builtin:other' },
  })
  assert.equal(putFake.status, 403)

  // PUT preserving exact managedByPlugin value: allowed (keeps editing other fields intact)
  const putKeep = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'managed hub renamed', managedByPlugin: 'builtin:superagent', humanSelectable: false },
  })
  assert.equal(putKeep.status, 200)
  assert.equal(putKeep.body.name, 'managed hub renamed')
  assert.equal(putKeep.body.managedByPlugin, 'builtin:superagent')

  // POST creating with managedByPlugin: 403 (only trusted internal plugin host may declare managed ownership)
  const post = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'fake-managed', name: 'spoofed', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(post.status, 403)
  assert.equal(post.body.error.code, 'profile_managed_by_plugin')

  const overwrite = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'hub-managed', name: 'overwrite and strip protection' },
  })
  assert.equal(overwrite.status, 403, 'POST must not bypass PUT hosting protection')
  assert.equal((await profiles.get('hub-managed'))?.managedByPlugin, 'builtin:superagent')

  await profiles.save({ id: 'ordinary', name: 'ordinary profile' })
  const inject = await call(handler, 'PUT', '/api/profiles/ordinary', {
    body: { name: 'spoof managed', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(inject.status, 403, 'PUT must not attach managedByPlugin to ordinary profiles')
  assert.equal((await profiles.get('ordinary'))?.managedByPlugin, undefined)

  for (const invalid of [{ managedByPlugin: '' }, { managedByPlugin: '  ' }, { managedByPlugin: 42 }, { humanSelectable: 'false' }]) {
    const bad = await call(handler, 'POST', '/api/profiles', { body: { id: 'bad-metadata', ...invalid } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'validation_error')
  }
})

test('profiles runtime nodeId/workspace/env: valid round-trip persists; malformed shapes return 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'ops-runner',
      name: 'Ops Runner',
      runtime: {
        kind: 'herdr',
        agent: 'pi',
        nodeId: 'ops-box',
        workspace: '/srv/ops',
        env: { HELM_ENV_ROLE: 'worker', LANG: 'C' },
      },
    },
  })
  assert.equal(ok.status, 201)
  const got = await call(handler, 'GET', '/api/profiles/ops-runner')
  assert.deepEqual(got.body.runtime, {
    kind: 'herdr',
    agent: 'pi',
    nodeId: 'ops-box',
    workspace: '/srv/ops',
    env: { HELM_ENV_ROLE: 'worker', LANG: 'C' },
  })

  const cases: Array<{ runtime: unknown; why: string }> = [
    { runtime: { kind: 'herdr', agent: 'pi', nodeId: '' }, why: 'empty nodeId string' },
    { runtime: { kind: 'herdr', agent: 'pi', workspace: '' }, why: 'empty workspace string' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { K: 1 } }, why: 'non-string env value' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { '': 'v' } }, why: 'empty env key' },
    { runtime: { kind: 'herdr', agent: 'pi', env: ['a'] }, why: 'array env' },
    { runtime: { kind: 'herdr', agent: 'pi', bogus: 1 }, why: 'unknown runtime key' },
    { runtime: { kind: 'herdr', agent: 'pi', nodeId: 42 }, why: 'non-string nodeId' },
  ]
  for (const c of cases) {
    const res = await call(handler, 'POST', '/api/profiles', { body: { id: 'bad-profile', runtime: c.runtime } })
    assert.equal(res.status, 400, `${c.why} should return 400`)
    assert.equal(res.body.error.code, 'validation_error', c.why)
  }
})

test('profiles DELETE protects default assistant profile (rejects via bound conversation or default lock, never 200)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const del = await call(handler, 'DELETE', '/api/profiles/assistant')
  // Hits kernel DEFAULT_PROFILE_ID guard (403) when unbound, or conversation-in-use (409) when bound -- never allows 200.
  assert.ok(del.status === 403 || del.status === 409, `assistant deletion must be rejected (actual ${del.status})`)
})

test('providers PUT accepts raw array (CLI convention) and { providers } wrapper', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const array = [
    { id: 'groq', protocol: 'openai', baseUrl: 'https://api.groq.com/v1', models: ['llama-3.3-70b'], enabled: true },
  ]
  const putRaw = await call(handler, 'PUT', '/api/providers', { body: array })
  assert.equal(putRaw.status, 200)
  const list1 = await call(handler, 'GET', '/api/providers')
  assert.ok(Array.isArray(list1.body))
  assert.equal(list1.body[0].id, 'groq')
  const putWrapped = await call(handler, 'PUT', '/api/providers', { body: { providers: array } })
  assert.equal(putWrapped.status, 200)
  // Invalid entries inside raw array still return 400 (no relaxed validation for array shorthand)
  const bad = await call(handler, 'PUT', '/api/providers', {
    body: [{ id: 'x', protocol: 'grpc', baseUrl: 'ftp://x', models: [], enabled: true }],
  })
  assert.equal(bad.status, 400)
  // Non-array and non-object return 400
  const notObj = await call(handler, 'PUT', '/api/providers', { body: 'nope' })
  assert.equal(notObj.status, 400)
})

test('credentials expose only id/configured with zero plaintext; PUT/DELETE take effect', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const put = await call(handler, 'PUT', '/api/credentials/groq', { body: { value: 'sk-super-secret' } })
  assert.equal(put.status, 200)
  const list = await call(handler, 'GET', '/api/credentials')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body, [{ id: 'groq', configured: true }])
  assert.ok(!JSON.stringify(list.body).includes('sk-super-secret'))
  const del = await call(handler, 'DELETE', '/api/credentials/groq')
  assert.equal(del.status, 200)
  const list2 = await call(handler, 'GET', '/api/credentials')
  assert.deepEqual(list2.body, [])
})

test('skills list + read {text}; path traversal rejected', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const skillDir = join(dataDir, 'skills', 'demo-skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n# Demo\n')
  await writeFile(join(skillDir, 'references', 'guide.md'), '# Guide\ncontent')
  const list = await call(handler, 'GET', '/api/skills')
  assert.ok(Array.isArray(list.body))
  assert.ok(list.body.some((s: any) => s.id === 'demo-skill'))
  const read = await call(handler, 'GET', '/api/skills/demo-skill')
  assert.equal(read.status, 200)
  assert.ok(typeof read.body.text === 'string')
  assert.ok(read.body.text.includes('# Demo'))
  const sub = await call(handler, 'GET', '/api/skills/demo-skill?path=references/guide.md')
  assert.equal(sub.status, 200)
  assert.ok(sub.body.text.includes('# Guide'))
  const traversal = await call(handler, 'GET', '/api/skills/demo-skill?path=../../../etc/passwd')
  assert.equal(traversal.status, 400)
  assert.equal(traversal.body.error.code, 'path_traversal')
})

test('models/providers returns public provider metadata; mismatched path does not leak catalog', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models/providers')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, [{ id: 'faux', name: 'Faux', modelCount: 1, authMethods: [{ type: 'api_key', label: 'API Key' }] }])
  assert.equal((await call(handler, 'GET', '/api/models/providers/extra')).status, 404)
})

test('default config partial update supports omitting model field and rejects empty/invalid bodies', { timeout: 60_000 }, async () => {
  const calls: Array<[string | undefined, string | undefined] | [string | undefined, string | undefined, string | undefined]> = []
  const kernel = makeKernel()
  kernel.setDefaultModel = async (model, level, compaction) => {
    calls.push(compaction !== undefined ? [model, level, compaction] : [model, level])
  }
  const { handler } = makeHandlers(kernel)
  const levelOnly = await call(handler, 'PUT', '/api/models/default', { body: { thinkingLevel: 'high' } })
  assert.equal(levelOnly.status, 200)
  assert.deepEqual(calls.at(-1), [undefined, 'high'])
  assert.equal((await call(handler, 'PUT', '/api/models/default', { body: { model: '' } })).status, 200)
  assert.deepEqual(calls.at(-1), ['', undefined])
  assert.equal((await call(handler, 'PUT', '/api/models/default', { body: { compactionModel: 'faux/compact' } })).status, 200)
  assert.deepEqual(calls.at(-1), [undefined, undefined, 'faux/compact'])
  for (const body of [{}, { model: null }, { compactionModel: 123 }, { thinkingLevel: 3 }, { other: 'high' }]) {
    assert.equal((await call(handler, 'PUT', '/api/models/default', { body })).status, 400)
  }
  assert.equal(calls.length, 3)
})

test('models returns catalog object (models array + thinkingLevels)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.models))
})

test('POST /api/models/refresh: empty/{} refreshes all, provider/providers/force pass through; invalid fields 400; unimplemented 501', { timeout: 60_000 }, async () => {
  // 1) Mock implementation provided: empty body / {} / single provider / multi-provider + force passthrough.
  const calls: Array<{ providers?: string[]; force?: boolean } | undefined> = []
  const refreshResult = {
    providers: [],
    aborted: false,
    errors: {},
    models: [{ provider: 'faux', modelId: 'm', available: true }],
    providerCatalog: [],
  }
  const kernel = makeKernelWithRefresh(async (options) => {
    calls.push(options)
    return refreshResult
  })
  const { handler } = makeHandlers(kernel)

  const empty = await call(handler, 'POST', '/api/models/refresh', { raw: '' })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, refreshResult)
  assert.deepEqual(calls.at(-1), {})

  const emptyObj = await call(handler, 'POST', '/api/models/refresh', { body: {} })
  assert.equal(emptyObj.status, 200)
  assert.deepEqual(calls.at(-1), {})

  const single = await call(handler, 'POST', '/api/models/refresh', { body: { provider: 'magpie' } })
  assert.equal(single.status, 200)
  assert.deepEqual(calls.at(-1), { providers: ['magpie'] })

  const multi = await call(handler, 'POST', '/api/models/refresh', { body: { providers: ['magpie', 'radius'], force: false } })
  assert.equal(multi.status, 200)
  assert.deepEqual(calls.at(-1), { providers: ['magpie', 'radius'], force: false })

  const badProvider = await call(handler, 'POST', '/api/models/refresh', { body: { provider: 42 } })
  assert.equal(badProvider.status, 400)
  assert.equal(badProvider.body.error.code, 'validation_error')

  const badForce = await call(handler, 'POST', '/api/models/refresh', { body: { force: 'yes' } })
  assert.equal(badForce.status, 400)

  const unknownKey = await call(handler, 'POST', '/api/models/refresh', { body: { unknown: 1 } })
  assert.equal(unknownKey.status, 400)

  const badJson = await call(handler, 'POST', '/api/models/refresh', { raw: '{oops' })
  assert.equal(badJson.status, 400)

  // 2) Mock omits implementation: 501 not_implemented.
  const bare = makeHandlers(makeKernelWithRefresh())
  const notImpl = await call(bare.handler, 'POST', '/api/models/refresh', { body: {} })
  assert.equal(notImpl.status, 501)
  assert.equal(notImpl.body.error.code, 'not_implemented')
})

// ---------------------------------------------------------------------------
// Artifacts (security boundaries + raw bytes)
// ---------------------------------------------------------------------------

test('artifacts list + content exact content-type/disposition/bytes; unknown 404', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const source = join(dataDir, 'note.md')
  await writeFile(source, '# artifact\ncontent')
  const meta = await artifacts.register(ROOT_CONVERSATION_ID, source, { name: 'note.md' })
  const list = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/artifacts`)
  assert.equal(list.status, 200)
  assert.ok(list.body.some((a: any) => a.id === meta.id && a.kind === 'registered'))
  const content = await call(handler, 'GET', `/api/artifacts/${meta.id}/content?inline=1`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'text/markdown')
  assert.equal(content.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(content.headers.get('content-disposition'), 'inline; filename="note.md"; filename*=UTF-8\'\'note.md')
  assert.ok(content.text.includes('# artifact'))
  const missing = await call(handler, 'GET', '/api/artifacts/no-such-id/content')
  assert.equal(missing.status, 404)
})

test('non-ASCII artifact filename uses UTF-8 Content-Disposition without failing 500 on header encoding', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const metadata = await artifacts.writeUploaded(1, { name: '验收说明.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# 中文文件') })
  for (const suffix of ['', '?inline=1']) {
    const response = await call(handler, 'GET', `/api/artifacts/${metadata.id}/content${suffix}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E9/)
    assert.equal(response.text, '# 中文文件')
  }
})

test('artifacts return binary payloads byte-for-byte verbatim (never decoded to string)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 8 bytes with 0xFF/0x81 sequences that UTF-8 decoding would corrupt
  const source = join(dataDir, 'blob.bin')
  const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0xff, 0xfe, 0x00, 0x81])
  await writeFile(source, raw)
  const meta = await artifacts.register(ROOT_CONVERSATION_ID, source, { name: 'blob.bin' })
  const res = await call(handler, 'GET', `/api/artifacts/${meta.id}/content`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), '8')
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  // Request raw bytes directly (bypassing call()'s text/JSON decoding path)
  const direct = await handler(new Request(`http://127.0.0.1:3202/api/artifacts/${meta.id}/content`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  const bytes = new Uint8Array(await direct.arrayBuffer())
  assert.deepEqual([...bytes], [...raw])
})

test('artifacts reject forged metadata (path=credentials.json) without leaking', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({ providers: { x: { value: 'leak-me' } } }), { mode: 0o600 })
  const fakeMeta = {
    id: 'evil-1',
    conversationId: ROOT_CONVERSATION_ID,
    kind: 'registered' as const,
    name: 'credentials.json',
    path: 'credentials.json',
    mimeType: 'application/json',
    size: 1,
    createdAt: Date.now(),
  }
  evilRepo.put(fakeMeta)
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = evilArtifacts
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', `/api/artifacts/evil-1/content`)
  assert.equal(res.status, 500)
  assert.equal(res.body.error.code, 'artifact_metadata_illegal')
  assert.ok(!res.text.includes('leak-me'))
})

test('artifacts reject forged metadata (artifacts/<convId>/../../escape)', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const secretFile = join(dataDir, 'escape-secret.txt')
  await writeFile(secretFile, 'TOP-SECRET')
  const fakeMeta = {
    id: 'evil-2',
    conversationId: ROOT_CONVERSATION_ID,
    kind: 'registered' as const,
    name: 'escape',
    path: 'artifacts/1/../../escape-secret.txt',
    mimeType: 'text/plain',
    size: 1,
    createdAt: Date.now(),
  }
  evilRepo.put(fakeMeta)
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = evilArtifacts
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', `/api/artifacts/evil-2/content`)
  assert.equal(res.status, 500)
  assert.equal(res.body.error.code, 'artifact_metadata_illegal')
  assert.ok(!res.text.includes('TOP-SECRET'))
})

test('artifacts reject symlink escape (file segment symlink outside artifacts dir)', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const secretFile = join(dataDir, 'symlink-secret.txt')
  await writeFile(secretFile, 'SYMLINK-SECRET')
  const convDir = await artifacts.ensureConversationDir(ROOT_CONVERSATION_ID)
  const linkPath = join(convDir, 'link.txt')
  await symlink(secretFile, linkPath)
  const fakeMeta = {
    id: 'evil-3',
    conversationId: ROOT_CONVERSATION_ID,
    kind: 'registered' as const,
    name: 'link.txt',
    path: `artifacts/${ROOT_CONVERSATION_ID}/link.txt`,
    mimeType: 'text/plain',
    size: 1,
    createdAt: Date.now(),
  }
  evilRepo.put(fakeMeta)
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = evilArtifacts
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', `/api/artifacts/evil-3/content`)
  assert.equal(res.status, 500)
  assert.equal(res.body.error.code, 'artifact_path_illegal')
  assert.ok(!res.text.includes('SYMLINK-SECRET'))
})

test('artifacts reject conversation directory symlink escape', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const outsideDir = join(dataDir, 'outside')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'loot.txt'), 'CONV-SYMLINK-SECRET')
  // artifacts/777777 itself is a symlink pointing outside the sandbox (pre-seeded attack)
  const artifactsRoot = join(dataDir, 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  const convLink = join(artifactsRoot, '777777')
  await rm(convLink, { force: true }).catch(() => {})
  await symlink(outsideDir, convLink)
  const fakeMeta = {
    id: 'evil-4',
    conversationId: 777777,
    kind: 'registered' as const,
    name: 'loot.txt',
    path: 'artifacts/777777/loot.txt',
    mimeType: 'text/plain',
    size: 1,
    createdAt: Date.now(),
  }
  evilRepo.put(fakeMeta)
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = evilArtifacts
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', `/api/artifacts/evil-4/content`)
  assert.equal(res.status, 500)
  assert.equal(res.body.error.code, 'artifact_path_illegal')
  assert.ok(!res.text.includes('CONV-SYMLINK-SECRET'))
})

test('artifacts reject invalid or missing kind in metadata (500 artifact_metadata_illegal)', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const valid = await evilArtifacts.writeUploaded(ROOT_CONVERSATION_ID, {
    name: 'ok.txt',
    bytes: new TextEncoder().encode('OK'),
  })
  const fileSegment = valid.path.split('/')[2]!
  evilRepo.put({
    ...valid,
    id: 'evil-bad-kind',
    path: `artifacts/${ROOT_CONVERSATION_ID}/${fileSegment}`,
    kind: 'bogus' as never,
  })
  evilRepo.put({
    ...valid,
    id: 'evil-missing-kind',
    path: `artifacts/${ROOT_CONVERSATION_ID}/${fileSegment}`,
    kind: undefined as never,
  })
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = evilArtifacts
  const handler = createHubHandler(kernel)
  for (const id of ['evil-bad-kind', 'evil-missing-kind']) {
    const res = await call(handler, 'GET', `/api/artifacts/${id}/content`)
    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'artifact_metadata_illegal')
  }
})

test('artifacts permission error is not disguised as missing file (non-ENOENT stays 500)', { timeout: 60_000 }, async () => {
  const repo = new InMemoryArtifactRepository()
  const artifactsNoPerm = new ArtifactService(dataDir, repo, stash)
  const source = join(dataDir, 'perm.md')
  await writeFile(source, 'perm')
  const meta = await artifactsNoPerm.register(ROOT_CONVERSATION_ID, source, { name: 'perm.md' })
  const target = join(dataDir, 'artifacts', String(ROOT_CONVERSATION_ID), meta.path.split('/')[2]!)
  await chmod(target, 0o000)
  const kernel = makeKernel()
  ;(kernel as { artifacts: ArtifactService }).artifacts = artifactsNoPerm
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', `/api/artifacts/${meta.id}/content`)
  // When running as root, chmod 000 files remain readable: succeed and reflect actual readability
  if (process.getuid?.() === 0) {
    assert.equal(res.status, 200)
  } else {
    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'internal_error')
    assert.ok(!res.text.includes('artifact_file_missing'))
  }
  await chmod(target, 0o644)
})

// ---------------------------------------------------------------------------
// Search / Workflows
// ---------------------------------------------------------------------------

test('search?q= passes through; empty q returns 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/search?q=hello')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const empty = await call(handler, 'GET', '/api/search?q=')
  assert.equal(empty.status, 400)
})

test('hardcoded workflow/worktree routes removed: all return 404 (orchestration moved to /api/actions)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/workflows')
  assert.equal(list.status, 404)
  const run = await call(handler, 'POST', '/api/workflows/run', { body: { name: 'demo' } })
  assert.equal(run.status, 404)
  const runs = await call(handler, 'GET', '/api/workflows/runs')
  assert.equal(runs.status, 404)
  const cleanup = await call(handler, 'POST', '/api/worktrees/cleanup', { body: { worktreeId: 'w1' } })
  assert.equal(cleanup.status, 404)
})

// ---------------------------------------------------------------------------
// Plugins (real PluginHost) / Actions
// ---------------------------------------------------------------------------

test('real PluginHost routes: public webhook bypasses auth; private requires token; handler sees original URL', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  publicHandlerCalls = []
  // Public exemption (reachable without token)
  const pub = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  // URL passed to handler preserves full original path (including colons and param segments) unmodified
  assert.equal(pub.body.got, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  assert.equal(publicHandlerCalls.length, 1)
  assert.equal(new URL(publicHandlerCalls[0]!.url).pathname, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  // Plugin raw routes accept non-JSON payloads; signature verification is up to the plugin.
  const raw = await handler(new Request('http://localhost/api/plugins/builtin:triggers/routes/webhook/hook-raw', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'raw webhook example',
  }))
  assert.equal(raw.status, 200)
  // Non-public route returns 401 when unauthenticated
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status', { auth: false })
  assert.equal(noAuth.status, 401)
  assert.equal(privateHandlerCalls.length, 0)
  // Accessible after auth
  const ok = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true })
  // Unknown plugin route returns 404
  const missing = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/nothing')
  assert.equal(missing.status, 404)
  // Mismatched param segment (extra segment): unauthenticated hits auth gate 401; authenticated returns 404
  const extraNoAuth = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { auth: false, body: {} })
  assert.equal(extraNoAuth.status, 401)
  const extra = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { body: {} })
  assert.equal(extra.status, 404)
})

test('real PluginHost routes: encoded pluginId also matches (consistent across full-path matchers)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const pub = await call(handler, 'POST', '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  assert.equal(pub.body.got, '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2')
})

test('plugins list; config PUT enforces { values } wrapper', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/plugins')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body))
  assert.ok(list.body.some((p: any) => p.id === 'builtin:triggers'))
  // setConfig returns explicit 501 config_store_unavailable when no persistent PluginConfigStore is wired
  // (honest unsupported rather than faking write success; wired kernel returns 200).
  const set = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { values: { retries: 3 } } })
  assert.ok(set.status === 200 || set.status === 501, `unexpected ${set.status}`)
  if (set.status === 501) assert.equal(set.body.error.code, 'config_store_unavailable')
  // Unwrapped payload without { values } returns 400 (validated at boundary first)
  const badShape = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { retries: 3 } })
  assert.equal(badShape.status, 400)
  assert.equal(badShape.body.error.code, 'validation_error')
})

test('GET /api/plugins/:id/docs/:name returns {pluginId,name,value}; private/undeclared/disabled/unknown return 404', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } })

  const priv = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/secret-board')
  assert.equal(priv.status, 404)
  assert.ok(!JSON.stringify(priv.body).includes('hidden'))

  const undeclared = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/nope')
  assert.equal(undeclared.status, 404)
  const unknownPlugin = await call(handler, 'GET', '/api/plugins/builtin:ghost/docs/board')
  assert.equal(unknownPlugin.status, 404)

  // Auth cannot be bypassed: unauthenticated gets 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board', { auth: false })
  assert.equal(noAuth.status, 401)

  // Invalid doc name (leading dot) 400; valid name but undeclared 404; extra segment 404
  const badName = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/.hidden')
  assert.equal(badName.status, 400)
  const extra = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board/extra')
  assert.equal(extra.status, 404)
})

test('real actions: invocation 200; raw null return is not wrapped into {ok:true}', { timeout: 60_000 }, async () => {
  // Append an action returning null (null is a valid output)
  await pluginHost.register({
    id: 'builtin:nullish',
    name: 'nullish',
    async definePlugin(ctx: HelmPluginContext) {
      ctx.action({
        id: 'get-null',
        description: 'returns null',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'null' },
        handler: () => null,
      })
      ctx.action({
        id: 'get-undefined',
        description: 'returns undefined (violates output contract)',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => undefined,
      })
    },
  })
  const { handler } = makeHandlers()
  const invoked = await call(handler, 'POST', '/api/actions/builtin:nullish/get-null', { body: { input: {} } })
  assert.equal(invoked.status, 200)
  // Raw null: response body is literally "null", never fabricated into {ok:true}
  assert.deepEqual(invoked.body, null)
  assert.equal(invoked.text, 'null')
  const undef = await call(handler, 'POST', '/api/actions/builtin:nullish/get-undefined', { body: { input: {} } })
  assert.equal(undef.status, 500)
  assert.ok(['invalid_output', 'invalid_plugin_output'].includes(undef.body.error.code))
  assert.notEqual(undef.text, '{"ok":true}')
  // Real echo action works normally
  const echo = await call(handler, 'POST', '/api/actions/builtin:triggers/echo', { body: { input: { text: 'hi' } } })
  assert.equal(echo.status, 200)
  assert.deepEqual(echo.body, { echoed: 'hi' })
})

// ---------------------------------------------------------------------------
// Outbound JSON stash redaction
// ---------------------------------------------------------------------------

test('outbound JSON recursive redaction: catches quoted/multiline secrets without unredacting markers', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const trickySecret = 'sk-"quoted"\nline-break\ttab'
  const placeholder = stash.put(ROOT_CONVERSATION_ID, 'TRICKY_KEY', trickySecret)
  // search result contains both raw secret and nested marker structures
  ;(kernel as { search: (q: string) => Promise<unknown[]> }).search = async () => [
    { conversationId: 1, snippet: `prefix ${trickySecret} middle [marker]${placeholder} end` },
    { nested: { list: [trickySecret, { deep: trickySecret }] } },
  ]
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/search?q=leak')
  assert.equal(res.status, 200)
  assert.ok(!res.text.includes('sk-"quoted"'))
  assert.ok(!res.text.includes('line-break\\ttab'.replace('\\\\', '\\')))
  // Markers keep redacted representation (never converted back to plaintext)
  assert.ok(res.text.includes(placeholder))
  assert.ok(res.text.includes('[REDACTED:stash:'))
})

test('error.details also redacted', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const secret = 'err-detail-secret-123'
  stash.put(ROOT_CONVERSATION_ID, 'ERR_KEY', secret)
  ;(kernel as { search: (q: string) => Promise<unknown[]> }).search = async () => {
    throw new HelmError('search_failed', 'search failed', 500, { trace: secret })
  }
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/search?q=x')
  assert.equal(res.status, 500)
  assert.ok(!res.text.includes(secret))
})

// ---------------------------------------------------------------------------
// Request body bounds
// ---------------------------------------------------------------------------

test('invalid JSON returns 400 invalid_json', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/login', { auth: false, raw: '{not-json' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_json')
})

test('body exceeding 1MiB returns 413 body_too_large', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const big = 'x'.repeat(1024 * 1024 + 100)
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: big },
  })
  assert.equal(res.status, 413)
  assert.equal(res.body.error.code, 'body_too_large')
})

test('unknown route 404; unsupported method 405', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const nf = await call(handler, 'GET', '/api/no-such-thing')
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'not_found')
  const mna = await call(handler, 'PUT', '/api/conversations')
  assert.equal(mna.status, 405)
})

test('non-/api prefix returns 404 (with webDistDir:false pure API mode; static hosting covered in static-web.test.ts)', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handler = createHubHandler({ kernel, webDistDir: false })
  const res = await call(handler, 'GET', '/favicon.ico')
  assert.equal(res.status, 404)
})

test('FileNotFoundError maps to 404 while other errors map to 500', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  ;(kernel as { plugins: unknown }).plugins = {
    ...(pluginHost as unknown as object),
    getConfig: () => {
      throw new FileNotFoundError('config.json')
    },
  }
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/plugins/builtin:triggers/config')
  assert.equal(res.status, 404)
})

// ---------------------------------------------------------------------------
// startHub: real Node listener + graceful close
// ---------------------------------------------------------------------------

test('startHub port:0 binds 127.0.0.1, serves real HTTP requests, closes promptly without leaking SSE listeners', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handle = await startHub({ kernel, port: 0 })
  try {
    assert.ok(handle.url.startsWith('http://127.0.0.1:'))
    assert.ok((handle.port as number) > 0)
    const unauth = await fetch(`${handle.url}/api/conversations`)
    assert.equal(unauth.status, 401)
    const ok = await fetch(`${handle.url}/api/conversations`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(ok.status, 200)
    const sseController = new AbortController()
    const sse = await fetch(`${handle.url}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: sseController.signal,
    })
    assert.equal(sse.status, 200)
    const reader = sse.body!.getReader()
    const first = await reader.read()
    assert.ok(new TextDecoder().decode(first.value).includes('snapshot'))
    const listenersBefore = hub0.listenerCount()
    const start = Date.now()
    await handle.close()
    const elapsed = Date.now() - start
    assert.ok(elapsed < 5_000, `close should finish promptly, actual ${elapsed}ms`)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(hub0.listenerCount(), listenersBefore - 1)
  } finally {
    await handle.close().catch(() => {})
  }
})

test('startHub real request: encoded pluginId hits action through node HTTP server', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handle = await startHub({ kernel, port: 0 })
  try {
    const res = await fetch(`${handle.url}/api/actions/builtin%3Atriggers/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text: 'real-http' } }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { echoed: 'real-http' })
  } finally {
    await handle.close().catch(() => {})
  }
})

test('startHub(port:0) passes concrete URL to kernel.setHubUrl after listening', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  setHubUrlCalls.length = 0
  const handle = await startHub({ kernel, port: 0 })
  try {
    assert.equal(setHubUrlCalls.length, 1)
    assert.equal(setHubUrlCalls[0], handle.url)
    // Actual HTTP responses still work
    const res = await fetch(`${handle.url}/api/conversations`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
  } finally {
    await handle.close()
  }
  // Does not error when kernel omits setHubUrl
  const bare = makeKernel()
  delete (bare as { setHubUrl?: unknown }).setHubUrl
  const handle2 = await startHub({ kernel: bare, port: 0 })
  await handle2.close()
})

test('CORS: reflects any Origin and carries credentials header', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const allowed = await handler(
    new Request('http://127.0.0.1:3202/api/conversations', {
      headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:3201' },
    }),
  )
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3201')
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true')
  const foreign = await handler(
    new Request('http://127.0.0.1:3202/api/conversations', {
      headers: { authorization: `Bearer ${token}`, origin: 'http://192.168.31.26:3201' },
    }),
  )
  assert.equal(foreign.headers.get('access-control-allow-origin'), 'http://192.168.31.26:3201')
  assert.equal(foreign.headers.get('access-control-allow-credentials'), 'true')
  const preflight = await handler(
    new Request('http://127.0.0.1:3202/api/conversations', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3201' },
    }),
  )
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3201')
})
