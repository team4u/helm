/**
 * HTTP/SSE transfer layer test: real temp directory + real services(auth/credentials/
 * profiles/skills/providers/artifacts/SecretStash)+ real PluginHost routing
 * register (ctx.route complete path declaration)+ simulated runtime conversation side.
 *
 * override: authentication boundary (status such as reverse reflect token),setup/login, initial conversation delete,
 * conversation CRUD and origin, path segment decode (encode pluginId / illegal encode 400 / redundant
 * segment 404), plugin motion state routing (real register,public exemption, original URL pass-through),
 * action null original / undefined violate about 500, out station JSON stash redaction (contains quotes/
 * newline secret),providers PUT original array,plugin config {values},
 * profiles delete 409,artifacts fabricate meta/symlink out of bounds reject and real byte,
 * skills traversal,body cap,SSE first frame and disconnect clean up, closure stop without legacy.
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

/** initial conversation id(SDK keep #1 bear load; ordinary conversation semantics, without produce product level special right). */
const ROOT_CONVERSATION_ID = 1 as const

// ---------------------------------------------------------------------------
// test base seat
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

/** simulated EventHub: real subscribe semantics + SSE response(first frame snapshot + incremental). */
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
            /* already closure */
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

/** memory conversation side: real service + simulated conversation/ask/search. */
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
  const base = summary(1, 'person assist')
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
    listNodes() { throw new Error('this HTTP fixture do not provide node manage') },
    async issueNodeToken() { throw new Error('this HTTP fixture do not sign node identity') },
    async removeNode() { throw new Error('this HTTP fixture do not remove node') },
    async execEnv() { throw new Error('this HTTP fixture do not execute node command') },
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
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      if (detailFixture !== undefined) {
        return { ...detailFixture, id }
      }
      return { ...conversations.get(id)!, entries: [] }
    },
    async getConversationEntry(id: number, entryId: number) {
      entryCalls.push({ id, entryId })
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      if (entryFixture !== undefined) return { ...entryFixture, id: String(entryId) }
      throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404, { conversationId: id, entryId })
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
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    async deleteConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      conversations.delete(id)
    },
    async submitInput(id, text, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      submitted.push({ id, text, opts })
      return { submissionId: 'sub-mock' }
    },
    async withdrawQueuedInput(id, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
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
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return found
    },
    async compactConversation(id) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return { taskId: 1, conversation: found }
    },
    async forkConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return summary(id + 100, `conversation ${id} (fork)`)
    },
    async listAsks() {
      return [...asks.values()]
    },
    async answerAsk(id, answers, expectedStateSeq) {
      const ask = asks.get(id)
      if (ask === undefined) throw new HelmError('not_found', `mention question missing: ${id}`, 404)
      if (expectedStateSeq !== undefined && ask.expectedStateSeq !== undefined && expectedStateSeq < ask.expectedStateSeq) {
        throw new HelmError('superseded', 'already in terminal handle', 409)
      }
      void answers
      asks.delete(id)
    },
    async cancelAsk(id) {
      if (!asks.has(id)) throw new HelmError('not_found', `mention question missing: ${id}`, 404)
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

/** can inject refreshModels  mock kernel(verify 501 branch when placement undefined). */
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
// real PluginHost routing register (definePlugin(ctx) ctx.route complete path declaration)
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
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return found
    },
    updateConversation: async (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
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
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture do not execute node command', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture do not bear load file mutual exclusion queue') },
    emitEvent: () => {},
  }
}

/** real register a contains public/private routing and action plugin. */
async function registerRoutePlugin(host: PluginHost): Promise<void> {
  publicHandlerCalls = []
  privateHandlerCalls = []
  await host.register({
    id: 'builtin:triggers',
    name: 'triggers',
    async definePlugin(ctx: HelmPluginContext) {
      // PluginHost declaration relative path, host automatically concatenate to /api/plugins/<enc id>/routes/...
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
        description: 'back sound',
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
  conversations.set(ROOT_CONVERSATION_ID, summary(1, 'person assist'))
  conversations.set(2, { ...summary(2, 'work person'), profileId: 'worker', tags: ['worker'] })
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
// authentication boundary
// ---------------------------------------------------------------------------

test('not config when setup before all private end point 401(without anonymous initialize loophole)', { timeout: 60_000 }, async () => {
  token = undefined
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations', { auth: false })
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'unauthorized')
})

test('GET /api/auth/status such as reverse reflect Bearer token: not config/without token/wrong token all false', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // not config + without token
  const noSetup = await call(handler, 'GET', '/api/auth/status', { auth: false })
  assert.equal(noSetup.status, 200)
  assert.deepEqual(noSetup.body, { configured: false, authenticated: false })
  // not config + error token:configured and authenticated independent gather report
  const saved = token
  token = 'deadbeef-token'
  const badToken = await call(handler, 'GET', '/api/auth/status')
  assert.deepEqual(badToken.body, { configured: false, authenticated: false })
  token = saved
})

test('config after status: without token false; error token false; valid token true', { timeout: 60_000 }, async () => {
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

test('malicious network page grab first setup protect: malicious Origin 403 and do not write config;text/plain smoke fill 415', { timeout: 60_000 }, async () => {
  // independent dataDir: verify malicious request never write auth config (grab first settings password failed)
  const evilDir = await makeTempDir('helm-http-evil-')
  try {
    const evilAuth = new AuthService(evilDir)
    const evilKernel = makeKernel()
    ;(evilKernel as { auth: AuthService }).auth = evilAuth
    const handler = createHubHandler(evilKernel)
    // non- JSON simple POST(across station table single can)→ 415, does not enter setup
    const malicious = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-123' }),
    })
    assert.equal(malicious.status, 415)
    assert.equal(malicious.body.error.code, 'unsupported_media_type')
    // config not by write: still is not config state
    assert.deepEqual(await evilAuth.status(), { configured: false })
    // any source + JSON normal setup
    const ok = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'http://192.168.31.26:3201',
      body: { password: 'legit-password-123' },
    })
    assert.equal(ok.status, 200)
    assert.equal(typeof ok.body.token, 'string')
    // already config after again come non- JSON also by refuse
    const again = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-456' }),
    })
    assert.equal(again.status, 415)
    // without Origin  CLI invoke:text/plain still refuse (JSON end point),JSON via
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

test('POST /api/auth/setup weak password 400 weak_password; duplicate setup 409', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'short' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'weak_password')
  const dup = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'another-pass-123' } })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error.code, 'already_setup')
})

test('POST /api/auth/login not setup when 409 not_setup', { timeout: 60_000 }, async () => {
  // independent dataDir: global base seat in first authentication test before completed setup, cannot override not config branch
  const freshDir = await makeTempDir('helm-http-nosetup-')
  try {
    const freshKernel = makeKernel()
    ;(freshKernel as { auth: AuthService }).auth = new AuthService(freshDir)
    const handler = createHubHandler(freshKernel)
    const res = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: '{{SECRET_nsetup9q}}' } })
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'not_setup')
    assert.equal(res.body.error.message, 'not yet complete setup, please first execute initialize')
  } finally {
    await cleanupDir(freshDir)
  }
})

test('POST /api/auth/login correct password 200 / error password 401 invalid_credentials', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'hunter2hunter2' } })
  assert.equal(ok.status, 200)
  assert.equal(typeof ok.body.token, 'string')
  const bad = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'wrong-password-9' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.body.error.code, 'invalid_credentials')
})

test('invalid token 401; valid token via', { timeout: 60_000 }, async () => {
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
// conversation lifecycle
// ---------------------------------------------------------------------------

test('POST /api/conversations create;PATCH update;DELETE conversation 200(without id level exemption)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/conversations', { body: { title: 'test conversation', cwd: '/tmp', tags: ['worker'] } })
  assert.equal(created.status, 201)
  assert.equal(created.body.title, 'test conversation')
  const id = created.body.id
  const patched = await call(handler, 'PATCH', `/api/conversations/${id}`, { body: { title: 'change name', pinned: true } })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.title, 'change name')
  assert.equal(patched.body.pinned, true)
  const deleted = await call(handler, 'DELETE', `/api/conversations/${id}`)
  assert.equal(deleted.status, 200)
  const gone = await call(handler, 'GET', `/api/conversations/${id}`)
  assert.equal(gone.status, 404)
})

test('POST /api/conversations(create)model do not accept empty string: still must provider/model', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/conversations', { body: { model: '' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
  const bad = await call(handler, 'POST', '/api/conversations', { body: { model: 'gpt-4o' } })
  assert.equal(bad.status, 400)
  const ok = await call(handler, 'POST', '/api/conversations', { body: { model: 'openai/gpt-4o' } })
  assert.equal(ok.status, 201)
})

test('PATCH /:id model override and empty string clean override boundary; other field do not subject to empty string affect', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // legal provider/model override pass-through
  const set = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: 'openai/gpt-4o' },
  })
  assert.equal(set.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: 'openai/gpt-4o' })

  // empty string = clear override (boundary accept and pass-through; semantics by kernel.updateConversation )
  const clear = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: '' },
  })
  assert.equal(clear.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: '' })

  // model ID can contains slash (e.g. motion state routing group); first segment still is provider.
  const nested = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: 'gateway/group/smart' } })
  assert.equal(nested.status, 200)
  assert.deepEqual(updateCalls.at(-1)?.patch, { model: 'gateway/group/smart' })

  // error shape still 400: missing provider, contains whitespace, pure space
  for (const bad of ['gpt-4o', 'openai /gpt', 'openai/ gpt', ' ']) {
    const res = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: bad } })
    assert.equal(res.status, 400, `model=${JSON.stringify(bad)} should 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
  // non- string type reject
  const num = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: 42 } })
  assert.equal(num.status, 400)
})

test('GET /api/conversations?profileId filter pass-through (and tag/status can combine semantics in kernel side)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations?profileId=worker')
  assert.equal(res.status, 200)
  assert.equal(res.body.length, 1)
  assert.equal(res.body[0].profileId, 'worker')
  const none = await call(handler, 'GET', '/api/conversations?profileId=nobody')
  assert.deepEqual(none.body, [])
})

test('conversation list drop noise contract: default only top-level,all=1 all amount,parent=<id> directly sub-conversation, illegal parameter 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // default: only top-level conversation (without parentConversationId)
  const top = await call(handler, 'GET', '/api/conversations')
  assert.equal(top.status, 200)
  assert.ok(top.body.every((c: ConversationSummary) => c.parentConversationId === undefined), 'default must not contains sub-conversation')
  assert.ok(top.body.some((c: ConversationSummary) => c.id === ROOT_CONVERSATION_ID), 'top-level entry conversation must in column')
  // --all: all amount (contains subagent and fork)
  const all = await call(handler, 'GET', '/api/conversations?all=1')
  assert.equal(all.status, 200)
  assert.ok(all.body.some((c: ConversationSummary) => c.id === 3), 'all=1 should contains subagent sub-conversation')
  assert.ok(all.body.some((c: ConversationSummary) => c.id === 4), 'all=1 should contains fork sub-conversation')
  // parent=<id>: precise directly sub-conversation
  const children = await call(handler, 'GET', `/api/conversations?parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(children.status, 200)
  assert.deepEqual(
    children.body.map((c: ConversationSummary) => c.id),
    [3],
    'parent=1 only return directly sub-conversation',
  )
  const noneChildren = await call(handler, 'GET', '/api/conversations?parent=999')
  assert.equal(noneChildren.status, 200)
  assert.deepEqual(noneChildren.body, [])
  // and other filter dimension AND combine (fork 4 inherit worker profile: verify parent sub- dimension stack add)
  const workerChild = await call(handler, 'GET', '/api/conversations?parent=2&profileId=assistant')
  assert.equal(workerChild.status, 200)
  assert.deepEqual(workerChild.body.map((c: ConversationSummary) => c.id), [4])
  // strictly input validate: illegal parent / all and parent mutual exclusion / illegal all
  for (const bad of ['abc', '0', '-1', '1.5', '999999999999999999999']) {
    const res = await call(handler, 'GET', `/api/conversations?parent=${bad}`)
    assert.equal(res.status, 400, `parent=${bad} should 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
  const conflict = await call(handler, 'GET', `/api/conversations?all=1&parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(conflict.status, 400)
  assert.equal(conflict.body.error.code, 'validation_error')
  const badAll = await call(handler, 'GET', '/api/conversations?all=yes')
  assert.equal(badAll.status, 400)
  assert.equal(badAll.body.error.code, 'validation_error')
  // all=0 explicit back default (only top-level), and parent also can combine (all=0 do not construct into mutual exclusion conflict)
  const allOff = await call(handler, 'GET', `/api/conversations?all=0&parent=${ROOT_CONVERSATION_ID}`)
  assert.equal(allOff.status, 200)
  assert.deepEqual(allOff.body.map((c: ConversationSummary) => c.id), [3])
})

test('illegal conversationId and illegal field 400 validation_error', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const badId = await call(handler, 'GET', '/api/conversations/abc')
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error.code, 'validation_error')
  const badBody = await call(handler, 'POST', '/api/conversations', { body: { title: 123 } })
  assert.equal(badBody.status, 400)
  const unknownField = await call(handler, 'POST', '/api/conversations', { body: { title: 'x', bogus: true } })
  assert.equal(unknownField.status, 400)
})

test('GET /:id return detail(summary field + entries + nextCursor top-level structure)', { timeout: 60_000 }, async () => {
  detailFixture = detailOf()
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}`)
  assert.equal(res.status, 200)
  // top-level summary field still directly can access (id/title/status...),entries/nextCursor flat spread
  assert.equal(res.body.id, ROOT_CONVERSATION_ID)
  assert.equal(res.body.title, 'person assist')
  assert.equal(res.body.status, 'idle')
  assert.ok(Array.isArray(res.body.entries))
  assert.equal(res.body.entries.length, 2)
  assert.equal(res.body.entries[0].kind, 'pi.assistant')
  assert.ok(Array.isArray(res.body.entries[0].model))
  assert.equal(res.body.entries[1].kind, 'helm.input')
  assert.deepEqual(res.body.entries[1].data, { id: 'i1', text: 'question', origin: 'human', createdAt: 1 })
  assert.equal(typeof res.body.nextCursor, 'string')
})

test('GET /:id?limit/cursor pass-through kernel.getConversationDetail; illegal value 400', { timeout: 60_000 }, async () => {
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

test('GET /:id conversation missing 404; redundant segment 404', { timeout: 60_000 }, async () => {
  detailFixture = undefined
  const { handler } = makeHandlers()
  const missing = await call(handler, 'GET', '/api/conversations/999')
  assert.equal(missing.status, 404)
  const extra = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries`)
  assert.equal(extra.status, 404)
})

test('GET /:id/entries/:entryId single item end point: pass-through/404/400/redundant segment', { timeout: 60_000 }, async () => {
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
  entryFixture = undefined // conversation store in but item missing:404
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

test('JSON response gzip: threshold/negotiate/Vary merge/Content-Length/decompress consistent', { timeout: 60_000 }, async () => {
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
  // carries Origin + Accept-Encoding: gzip: compress + Vary merge (Origin and Accept-Encoding and store)
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

  // small response (<1KiB) do not compress but still merge Vary;body complete can read (clone unconsumed original body)
  const smallReq = new Request('http://127.0.0.1:3202/api/conversations', {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const small = await handler(smallReq)
  assert.equal(small.headers.get('content-encoding'), null)
  assert.ok(
    (small.headers.get('vary') ?? '').toLowerCase().split(',').map((t) => t.trim()).includes('accept-encoding'),
    'identity small response also want carries Vary: Accept-Encoding',
  )
  const smallBody = await small.text()
  assert.ok(Array.isArray(JSON.parse(smallBody)), 'identity response body not by clone consume')

  // client do not accept gzip:identity
  const identity = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?limit=50`)
  assert.equal(identity.headers.get('content-encoding'), null)

  // q=0 treated as reject
  const q0 = new Request(`http://127.0.0.1:3202/api/conversations/${ROOT_CONVERSATION_ID}?limit=50`, {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip;q=0, br' },
  })
  const q0res = await handler(q0)
  assert.equal(q0res.headers.get('content-encoding'), null)
  await q0res.text()

  // SSE do not compress (text/event-stream)
  const sseReq = new Request('http://127.0.0.1:3202/api/events', {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const sse = await handler(sseReq)
  assert.equal(sse.headers.get('content-type'), 'text/event-stream')
  assert.equal(sse.headers.get('content-encoding'), null)
  await sse.body?.cancel() // mock SSE stream keep open: read all text will pending, directly cancel

  // HEAD do not compress
  const headReq = new Request(`http://127.0.0.1:3202/api/conversations/${ROOT_CONVERSATION_ID}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  })
  const head = await handler(headReq)
  assert.equal(head.headers.get('content-encoding'), null)
  await head.text()
})

test('POST /:id/input validate origin/whenBusy enumeration and pass-through kernel.submitInput', { timeout: 60_000 }, async () => {
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

test('POST input meta: pure JSON object pass-through opts.meta; array/mark amount/unknown field 400', { timeout: 60_000 }, async () => {
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

test('POST input?wait=1 invoke waitForInput and return ConversationInputResult; illegal wait 400', { timeout: 60_000 }, async () => {
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

  // wait in kernel throw HelmError(aborted etc.)→ error message seal such as pass-through
  waitForInputError = new HelmError('input_unanswered', 'input not obtain answer (aborted)', 409, { reason: 'aborted' })
  const failed = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=1`, {
    body: { text: 'x' },
  })
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error.code, 'input_unanswered')
  waitForInputError = undefined
  waitForInputResult = undefined
})

test('POST /:id/input replaceFromEntryId validate and pass-through; default when opts shape do not change', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'override heavy', replaceFromEntryId: 5 },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(submitted.at(-1)?.opts, { replaceFromEntryId: 5 })
  // default: does not carry replaceFromEntryId key (opts shape and since has contract consistent).
  const plain = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'ordinary commit' },
  })
  assert.equal(plain.status, 202)
  assert.equal(
    submitted.at(-1)?.opts && 'replaceFromEntryId' in (submitted.at(-1)!.opts as object),
    false,
    'default when opts must not carry replaceFromEntryId key',
  )
  // illegal value:0, negative number, decimal, non- security integer all 400.
  for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, '5']) {
    const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
      body: { text: 'x', replaceFromEntryId: bad },
    })
    assert.equal(res.status, 400, `replaceFromEntryId=${String(bad)} should 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
})

test('POST /:id/withdraw validate submissionId and invoke withdrawQueuedInput', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 42 },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { status: 'withdrawn' })
  assert.deepEqual(withdrawn.at(-1), { id: ROOT_CONVERSATION_ID, submissionId: 42 })
  // illegal body: missing field / 0 / decimal / unknown field.
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
  // missing conversation 404(mock throw not_found).
  const nf = await call(handler, 'POST', '/api/conversations/88888/withdraw', { body: { submissionId: 1 } })
  assert.equal(nf.status, 404)
  // redundant segment 404.
  const extra = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw/x`, {
    body: { submissionId: 1 },
  })
  assert.equal(extra.status, 404)
})

test('POST /:id/abort invoke abortConversation', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/abort`)
  assert.equal(res.status, 200)
  assert.ok(aborted.includes(ROOT_CONVERSATION_ID))
})

// ---------------------------------------------------------------------------
// path segment decode
// ---------------------------------------------------------------------------

test('encode pluginId correct decode:builtin%3Atriggers etc. price builtin:triggers', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const encoded = await call(handler, 'GET', '/api/plugins/builtin%3Atriggers/config')
  assert.equal(encoded.status, 200)
  const plain = await call(handler, 'GET', '/api/plugins/builtin:triggers/config')
  assert.equal(plain.status, 200)
  // encode segment and plaintext segment return consistent content
  assert.deepEqual(encoded.body, plain.body)
})

test('illegal hundred number encode 400 invalid_path_encoding', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/plugins/builtin%3Aassistant%zz/config')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_path_encoding')
})

test('redundant path segment 404: do not operation branch (auth/status/foo,workflows abort/extra etc.)', { timeout: 60_000 }, async () => {
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

test('encode slash(%2F) do not re- segment: decode after still is a segment', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // %2F decode after is segment content one part ('a/b'), will not re- cut routing; the value is not
  // legal profileId, by single segment parameter validate reject 400.
  const res = await call(handler, 'GET', '/api/profiles/a%2Fb')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('SSE first frame snapshot + incremental event + disconnect cancel subscribe (without legacy listener)', { timeout: 60_000 }, async () => {
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

test('SSE unauthenticated 401', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const request = new Request('http://127.0.0.1:3202/api/events')
  const response = await handler(request)
  assert.equal(response.status, 401)
})

// ---------------------------------------------------------------------------
// Profiles / Providers / Credentials / Skills / Models
// ---------------------------------------------------------------------------

test('profiles CRUD(real ProfileService + system online read write;memory contract already delete)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'researcher',
      name: 'research member',
      runtime: { kind: 'herdr', agent: 'agy' },
      system: '# research member system prompt\nkeep severe careful.',
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.id, 'researcher')
  assert.equal(created.body.system, '# research member system prompt\nkeep severe careful.')
  assert.equal(created.body.memory, undefined, 'Profile contract no longer contains memory field')
  const list = await call(handler, 'GET', '/api/profiles')
  assert.ok(list.body.some((p: any) => p.id === 'researcher'))
  const put = await call(handler, 'PUT', '/api/profiles/researcher', {
    body: { name: 'resource deep research member', system: '# resource deep research member prompt\nupgrade edition.' },
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.name, 'resource deep research member')
  assert.equal(put.body.system, '# resource deep research member prompt\nupgrade edition.')
  const got = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(got.status, 200)
  assert.equal(got.body.system, '# resource deep research member prompt\nupgrade edition.')
  // old memory field request by boundary reject (does not compatibility read)
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

test('profiles detail situation failed to read explicit errors, do not return can override original file whitespace body text', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await profiles.save({ id: 'missing-system', name: 'missing body text' })
  await rm(join(dataDir, 'profiles', 'missing-system', 'SYSTEM.md'))
  const result = await call(handler, 'GET', '/api/profiles/missing-system')
  assert.equal(result.status, 404)
  assert.ok(result.body.error)
  assert.equal(result.body.system, undefined)
})

test('profiles POST/PUT bind set disable model in before reject (409 model_disabled), not provide port when non-blocking', { timeout: 60_000 }, async () => {
  // base seat kernel not provide assertModelEnabled port: save non-blocking (optional port semantics).
  {
    const { handler } = makeHandlers()
    const created = await call(handler, 'POST', '/api/profiles', {
      body: { id: 'no-port-profile', name: 'without port', model: 'faux/model' },
    })
    assert.equal(created.status, 201)
  }
  // provide port:POST and PUT bind set disable model all 409, and do not.
  const kernel = makeKernel()
  kernel.assertModelEnabled = (provider, modelId) => {
    if (provider === 'faux' && modelId === 'disabled-model') {
      throw new HelmError('model_disabled', `model ${provider}/${modelId} already by disable`, 409)
    }
  }
  const handler = createHubHandler(kernel)
  const rejected = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'disabled-bind', name: 'bind set disable model', model: 'faux/disabled-model' },
  })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'model_disabled')
  assert.equal(await profiles.get('disabled-bind'), undefined, 'POST reject after must not')

  // PUT same rule: since has profile change bind disable model reject.
  await profiles.save({ id: 'put-target', name: 'since has role' })
  const putRejected = await call(handler, 'PUT', '/api/profiles/put-target', {
    body: { name: 'change bind disable model', model: 'faux/disabled-model' },
  })
  assert.equal(putRejected.status, 409)
  assert.equal(putRejected.body.error.code, 'model_disabled')
  assert.equal((await profiles.get('put-target'))?.model, undefined, 'PUT reject after original value do not change')

  // legal model still can normal save; clear (missing model field) does not trigger preflight.
  const ok = await call(handler, 'PUT', '/api/profiles/put-target', {
    body: { name: 'change bind available model', model: 'faux/model' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.model, 'faux/model')
})

test('profiles DELETE still by conversation bind set return 409 profile_in_use', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bound-profile', name: 'bind set in', runtime: { kind: 'herdr', agent: 'agy' } },
  })
  const created = await call(handler, 'POST', '/api/conversations', {
    body: { title: 'bind set conversation', profileId: 'bound-profile' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.profileId, 'bound-profile')
  const rejected = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'profile_in_use')
  // solve bind after can delete
  await call(handler, 'PATCH', `/api/conversations/${created.body.id}`, { body: { profileId: 'assistant' } })
  // simulated conversation side PATCH do not change profileId, directly change memory with verify delete path
  const conv = conversations.get(created.body.id)!
  conv.profileId = 'assistant'
  const ok = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(ok.status, 200)
})

test('profiles skills blank name single HTTP roundtrip: create/update/read back three state, illegal id and unknown field reject', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // create: blank name single dedupe + allows temporary missing id(runtime can after install)
  const created = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'skills-profile', name: 'skill blank name single', skills: ['helm-cli', 'future-skill', 'helm-cli'] },
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.skills, ['helm-cli', 'future-skill'], 'duplicate items dedupe after return')

  // PUT update is empty array (disable all) - - whole replace contract, non- default
  const put = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: 'skill blank name single', skills: [] },
  })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body.skills, [], 'empty array must pass-through persist')
  const onDisk = JSON.parse(
    await readFile(join(dataDir, 'profiles', 'skills-profile', 'profile.json'), 'utf8'),
  ) as { skills?: string[] }
  assert.deepEqual(onDisk.skills, [], 'HTTP write path keep empty array')

  // PUT do not carries skills(whole replace semantics: back to default all available)
  const put2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: 'skill blank name single' },
  })
  assert.equal(put2.status, 200)
  assert.equal(put2.body.skills, undefined, 'PUT omit skills back to default (do not write key)')

  // GET read back service layer real state
  const got = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(got.status, 200)
  assert.equal(got.body.skills, undefined)

  // illegal skill id(path inject form) reject, produces no part write
  const bad = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bad-skills', skills: ['../profiles/assistant'] },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'validation_error')
  const bad2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { skills: 'helm-cli' },
  })
  assert.equal(bad2.status, 400)
  // on state reject does not change already save state (still is default)
  const after = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(after.body.skills, undefined)
})

test('profiles hosting protect:managedByPlugin reject delete and tamper,POST cannot fabricate hosting identity', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // can message plugin self raise asset direct write (do not via HTTP):ProfileService.save carries managedByPlugin
  await profiles.save({
    id: 'hub-managed',
    name: 'managed router hub',
    managedByPlugin: 'builtin:superagent',
    humanSelectable: false,
  })
  // DELETE: hosting Profile 403(without conversation bind set occupy, purely four hosting protect)
  const del = await call(handler, 'DELETE', '/api/profiles/hub-managed')
  assert.equal(del.status, 403)
  assert.equal(del.body.error.code, 'profile_managed_by_plugin')

  // PUT remove managedByPlugin(whole replace contract under missing i.e. remove):403
  const putStrip = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'change name' },
  })
  assert.equal(putStrip.status, 403)
  assert.equal(putStrip.body.error.code, 'profile_managed_by_plugin')

  // PUT change write is other plugin:403
  const putFake = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'change name', managedByPlugin: 'builtin:other' },
  })
  assert.equal(putFake.status, 403)

  // PUT original carry identical value: legal (keep the rest field edit capability)
  const putKeep = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: 'managed router hub change name', managedByPlugin: 'builtin:superagent', humanSelectable: false },
  })
  assert.equal(putKeep.status, 200)
  assert.equal(putKeep.body.name, 'managed router hub change name')
  assert.equal(putKeep.body.managedByPlugin, 'builtin:superagent')

  // POST create carries managedByPlugin:403(hosting identity only can message plugin self raise can declaration)
  const post = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'fake-managed', name: 'fabricate hosting', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(post.status, 403)
  assert.equal(post.body.error.code, 'profile_managed_by_plugin')

  const overwrite = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'hub-managed', name: 'override and remove hosting' },
  })
  assert.equal(overwrite.status, 403, 'POST must not bypass PUT hosting protect')
  assert.equal((await profiles.get('hub-managed'))?.managedByPlugin, 'builtin:superagent')

  await profiles.save({ id: 'ordinary', name: 'ordinary config' })
  const inject = await call(handler, 'PUT', '/api/profiles/ordinary', {
    body: { name: 'fabricate managed config', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(inject.status, 403, 'PUT must not to ordinary config fabricate hosting identity')
  assert.equal((await profiles.get('ordinary'))?.managedByPlugin, undefined)

  for (const invalid of [{ managedByPlugin: '' }, { managedByPlugin: '  ' }, { managedByPlugin: 42 }, { humanSelectable: 'false' }]) {
    const bad = await call(handler, 'POST', '/api/profiles', { body: { id: 'bad-metadata', ...invalid } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'validation_error')
  }
})

test('profiles runtime nodeId/workspace/env: legal save back read; illegal shape 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'ops-runner',
      name: 'transport dimension',
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
    { runtime: { kind: 'herdr', agent: 'pi', nodeId: '' }, why: 'nodeId empty string' },
    { runtime: { kind: 'herdr', agent: 'pi', workspace: '' }, why: 'workspace empty string' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { K: 1 } }, why: 'env value non- string' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { '': 'v' } }, why: 'env key empty string' },
    { runtime: { kind: 'herdr', agent: 'pi', env: ['a'] }, why: 'env array' },
    { runtime: { kind: 'herdr', agent: 'pi', bogus: 1 }, why: 'runtime unknown key' },
    { runtime: { kind: 'herdr', agent: 'pi', nodeId: 42 }, why: 'nodeId non- string' },
  ]
  for (const c of cases) {
    const res = await call(handler, 'POST', '/api/profiles', { body: { id: 'bad-profile', runtime: c.runtime } })
    assert.equal(res.status, 400, `${c.why} should 400`)
    assert.equal(res.body.error.code, 'validation_error', c.why)
  }
})

test('profiles DELETE by default assistant subject to protect (by conversation bind set or kernel by default protect, cannot via HTTP delete)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const del = await call(handler, 'DELETE', '/api/profiles/assistant')
  // fixture not create conversation when hit kernel DEFAULT_PROFILE_ID protect (403);
  // already create conversation when hit conversation bind set protect (409) - - two all is reject, never allows 200.
  assert.ok(del.status === 403 || del.status === 409, `assistant delete should by reject (actual ${del.status})`)
})

test('providers PUT accept complete original array (CLI convention) and { providers } package wrap', { timeout: 60_000 }, async () => {
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
  // original array inside illegal items same 400(do not because form put wide)
  const bad = await call(handler, 'PUT', '/api/providers', {
    body: [{ id: 'x', protocol: 'grpc', baseUrl: 'ftp://x', models: [], enabled: true }],
  })
  assert.equal(bad.status, 400)
  // non- array non- object 400
  const notObj = await call(handler, 'PUT', '/api/providers', { body: 'nope' })
  assert.equal(notObj.status, 400)
})

test('credentials only id/configured key, absolute without plaintext;PUT/DELETE takes effect', { timeout: 60_000 }, async () => {
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

test('skills list + read {text};path traversal reject', { timeout: 60_000 }, async () => {
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

test('models/providers return public provider metadata; path does not match do not mistakenly directory', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models/providers')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, [{ id: 'faux', name: 'Faux', modelCount: 1, authMethods: [{ type: 'api_key', label: 'API Key' }] }])
  assert.equal((await call(handler, 'GET', '/api/models/providers/extra')).status, 404)
})

test('by default config part update keep not provide model field and reject empty/illegal body', { timeout: 60_000 }, async () => {
  const calls: Array<[string | undefined, string | undefined]> = []
  const kernel = makeKernel()
  kernel.setDefaultModel = async (model, level) => { calls.push([model, level]) }
  const { handler } = makeHandlers(kernel)
  const levelOnly = await call(handler, 'PUT', '/api/models/default', { body: { thinkingLevel: 'high' } })
  assert.equal(levelOnly.status, 200)
  assert.deepEqual(calls.at(-1), [undefined, 'high'])
  assert.equal((await call(handler, 'PUT', '/api/models/default', { body: { model: '' } })).status, 200)
  assert.deepEqual(calls.at(-1), ['', undefined])
  for (const body of [{}, { model: null }, { thinkingLevel: 3 }, { other: 'high' }]) {
    assert.equal((await call(handler, 'PUT', '/api/models/default', { body })).status, 400)
  }
  assert.equal(calls.length, 2)
})

test('models return directory object (models array + thinkingLevels)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.models))
})

test('POST /api/models/refresh: empty/{} all amount,provider/providers/force pass-through; illegal field 400; not implemented 501', { timeout: 60_000 }, async () => {
  // 1) mock provide implement: empty body / {} / single choose / many choose + force pass-through.
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

  // 2) mock do not provide implement:501 not_implemented.
  const bare = makeHandlers(makeKernelWithRefresh())
  const notImpl = await call(bare.handler, 'POST', '/api/models/refresh', { body: {} })
  assert.equal(notImpl.status, 501)
  assert.equal(notImpl.body.error.code, 'not_implemented')
})

// ---------------------------------------------------------------------------
// Artifacts(security boundary + real byte)
// ---------------------------------------------------------------------------

test('artifacts list + content real content-type/disposition/byte; unknown 404', { timeout: 60_000 }, async () => {
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

test('Chinese artifact filename use UTF-8 disposition, preview and download do not because response head encode report 500', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const metadata = await artifacts.writeUploaded(1, { name: '验收说明.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# 中文文件') })
  for (const suffix of ['', '?inline=1']) {
    const response = await call(handler, 'GET', `/api/artifacts/${metadata.id}/content${suffix}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E9/)
    assert.equal(response.text, '# 中文文件')
  }
})

test('artifacts two enter system by byte original return (do not rotate string)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 8  0xFF byte:UTF-8 decode will corrupt
  const source = join(dataDir, 'blob.bin')
  const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0xff, 0xfe, 0x00, 0x81])
  await writeFile(source, raw)
  const meta = await artifacts.register(ROOT_CONVERSATION_ID, source, { name: 'blob.bin' })
  const res = await call(handler, 'GET', `/api/artifacts/${meta.id}/content`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), '8')
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  // directly request original byte (do not via call()  text/JSON parse path)
  const direct = await handler(new Request(`http://127.0.0.1:3202/api/artifacts/${meta.id}/content`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  const bytes = new Uint8Array(await direct.arrayBuffer())
  assert.deepEqual([...bytes], [...raw])
})

test('artifacts fabricate metadata(path=credentials.json) must not leak', { timeout: 60_000 }, async () => {
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

test('artifacts fake metadata(artifacts/<convId>/../../escape) reject', { timeout: 60_000 }, async () => {
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

test('artifacts symlink out of bounds reject (filename segment symlink escape)', { timeout: 60_000 }, async () => {
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

test('artifacts conversation directory symlink escape reject', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const outsideDir = join(dataDir, 'outside')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'loot.txt'), 'CONV-SYMLINK-SECRET')
  // artifacts/777777 itself is points to boundary outside directory symlink (attack pre- placement)
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

test('artifacts illegal or missing kind metadata gate reject (500 artifact_metadata_illegal)', { timeout: 60_000 }, async () => {
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

test('artifacts read permission error do not fake call missing(non- ENOENT original 500)', { timeout: 60_000 }, async () => {
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
  // process is root when chmod 000 still can read: now should succeeded return content (such as reverse reflect can read)
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

test('search?q= pass-through; empty q 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/search?q=hello')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const empty = await call(handler, 'GET', '/api/search?q=')
  assert.equal(empty.status, 400)
})

test('workflows / worktrees hard encode routing deleted: one rule 404(orchestration via plugin action /api/actions)', { timeout: 60_000 }, async () => {
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
// Plugins(real PluginHost)/ Actions
// ---------------------------------------------------------------------------

test('real PluginHost routing:public webhook exemption authentication; non- public must token;handler receives original URL', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  publicHandlerCalls = []
  // public exemption (without token direct reach)
  const pub = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  // handler receives URL keep complete original path (contains : and parameter segment), not by change write
  assert.equal(pub.body.got, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  assert.equal(publicHandlerCalls.length, 1)
  assert.equal(new URL(publicHandlerCalls[0]!.url).pathname, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  // plugin original routing can receive non- JSON body text; signature verification policy by plugin declaration.
  const raw = await handler(new Request('http://localhost/api/plugins/builtin:triggers/routes/webhook/hook-raw', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'raw webhook example',
  }))
  assert.equal(raw.status, 200)
  // non- public unauthenticated 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status', { auth: false })
  assert.equal(noAuth.status, 401)
  assert.equal(privateHandlerCalls.length, 0)
  // recognize verify after can access
  const ok = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true })
  // missing plugin routing 404
  const missing = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/nothing')
  assert.equal(missing.status, 404)
  // parameter segment does not match (many one segment): unauthenticated first collide authentication gate 401; carries token after such as 404
  const extraNoAuth = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { auth: false, body: {} })
  assert.equal(extraNoAuth.status, 401)
  const extra = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { body: {} })
  assert.equal(extra.status, 404)
})

test('real PluginHost routing: encode pluginId also can hit (complete path match two where consistent)', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const pub = await call(handler, 'POST', '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  assert.equal(pub.body.got, '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2')
})

test('plugins list;config PUT keep { values } package wrap', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/plugins')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body))
  assert.ok(list.body.some((p: any) => p.id === 'builtin:triggers'))
  // setConfig in without persist PluginConfigStore when explicit 501 config_store_unavailable
  //(honest unsupported, do not fabricate write succeeded; real kernel install match store after i.e. is 200).
  const set = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { values: { retries: 3 } } })
  assert.ok(set.status === 200 || set.status === 501, `unexpected ${set.status}`)
  if (set.status === 501) assert.equal(set.body.error.code, 'config_store_unavailable')
  // non- { values } package wrap form 400(boundary validate first row)
  const badShape = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { retries: 3 } })
  assert.equal(badShape.status, 400)
  assert.equal(badShape.body.error.code, 'validation_error')
})

test('GET /api/plugins/:id/docs/:name return {pluginId,name,value}; private/not declaration/deactivate/unknown 404', { timeout: 60_000 }, async () => {
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

  // authentication cannot bypass: without token 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board', { auth: false })
  assert.equal(noAuth.status, 401)

  // illegal doc name(with point open head)400; legal shape but not declaration 404; redundant segment 404
  const badName = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/.hidden')
  assert.equal(badName.status, 400)
  const extra = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board/extra')
  assert.equal(extra.status, 404)
})

test('real action:invoke 200;null original return do not fabricate succeeded object', { timeout: 60_000 }, async () => {
  // append a return null action (null is legal output)
  await pluginHost.register({
    id: 'builtin:nullish',
    name: 'nullish',
    async definePlugin(ctx: HelmPluginContext) {
      ctx.action({
        id: 'get-null',
        description: 'return null',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'null' },
        handler: () => null,
      })
      ctx.action({
        id: 'get-undefined',
        description: 'return undefined(violate about output)',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => undefined,
      })
    },
  })
  const { handler } = makeHandlers()
  const invoked = await call(handler, 'POST', '/api/actions/builtin:nullish/get-null', { body: { input: {} } })
  assert.equal(invoked.status, 200)
  // original null: response body is "null", never fabricate into {ok:true}
  assert.deepEqual(invoked.body, null)
  assert.equal(invoked.text, 'null')
  const undef = await call(handler, 'POST', '/api/actions/builtin:nullish/get-undefined', { body: { input: {} } })
  assert.equal(undef.status, 500)
  assert.ok(['invalid_output', 'invalid_plugin_output'].includes(undef.body.error.code))
  assert.notEqual(undef.text, '{"ok":true}')
  // real echo action normal
  const echo = await call(handler, 'POST', '/api/actions/builtin:triggers/echo', { body: { input: { text: 'hi' } } })
  assert.equal(echo.status, 200)
  assert.deepEqual(echo.body, { echoed: 'hi' })
})

// ---------------------------------------------------------------------------
// out station JSON stash redaction
// ---------------------------------------------------------------------------

test('out station JSON recursion redaction: contains quotes/newline secret also without leaking,marker do not restore', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const trickySecret = 'sk-"quoted"\nline-break\ttab'
  const placeholder = stash.put(ROOT_CONVERSATION_ID, 'TRICKY_KEY', trickySecret)
  // search return contains secret plaintext and marker embed set structure
  ;(kernel as { search: (q: string) => Promise<unknown[]> }).search = async () => [
    { conversationId: 1, snippet: `prefix ${trickySecret} middle [marker]${placeholder} end` },
    { nested: { list: [trickySecret, { deep: trickySecret }] } },
  ]
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/search?q=leak')
  assert.equal(res.status, 200)
  assert.ok(!res.text.includes('sk-"quoted"'))
  assert.ok(!res.text.includes('line-break\\ttab'.replace('\\\\', '\\')))
  // marker keep redaction form (do not restore is plaintext)
  assert.ok(res.text.includes(placeholder))
  assert.ok(res.text.includes('[REDACTED:stash:'))
})

test('error.details same redaction', { timeout: 60_000 }, async () => {
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
// request body boundary
// ---------------------------------------------------------------------------

test('illegal JSON 400 invalid_json', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/login', { auth: false, raw: '{not-json' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_json')
})

test('body over 1MiB 413 body_too_large', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const big = 'x'.repeat(1024 * 1024 + 100)
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: big },
  })
  assert.equal(res.status, 413)
  assert.equal(res.body.error.code, 'body_too_large')
})

test('unknown routing 404; unknown method 405', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const nf = await call(handler, 'GET', '/api/no-such-thing')
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'not_found')
  const mna = await call(handler, 'PUT', '/api/conversations')
  assert.equal(mna.status, 405)
})

test('non- /api prefix 404(explicit webDistDir:false pure API behavior; by default static hosting by static-web.test.ts override)', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handler = createHubHandler({ kernel, webDistDir: false })
  const res = await call(handler, 'GET', '/favicon.ico')
  assert.equal(res.status, 404)
})

test('FileNotFoundError mapping 404 while non- 500', { timeout: 60_000 }, async () => {
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
// startHub: real node listen + closure stop
// ---------------------------------------------------------------------------

test('startHub port:0 listen 127.0.0.1, real HTTP to return,close rapid complete and SSE without legacy', { timeout: 60_000 }, async () => {
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
    assert.ok(elapsed < 5_000, `close should rapid complete, actual ${elapsed}ms`)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(hub0.listenerCount(), listenersBefore - 1)
  } finally {
    await handle.close().catch(() => {})
  }
})

test('startHub real to return: encode pluginId via node server hit action', { timeout: 60_000 }, async () => {
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

test('startHub(port:0) listen after kernel.setHubUrl receives real URL', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  setHubUrlCalls.length = 0
  const handle = await startHub({ kernel, port: 0 })
  try {
    assert.equal(setHubUrlCalls.length, 1)
    assert.equal(setHubUrlCalls[0], handle.url)
    // real to return still through
    const res = await fetch(`${handle.url}/api/conversations`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
  } finally {
    await handle.close()
  }
  // do not provide setHubUrl  kernel also do not errors
  const bare = makeKernel()
  delete (bare as { setHubUrl?: unknown }).setHubUrl
  const handle2 = await startHub({ kernel: bare, port: 0 })
  await handle2.close()
})

test('CORS: any source all reflection and carries credentials head', { timeout: 60_000 }, async () => {
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
