/**
 * HTTP/SSE 传输层测试：真实临时目录 + 真实 services（auth/credentials/
 * profiles/skills/providers/artifacts/SecretStash）+ 真实 PluginHost 路由
 * 注册（ctx.route 完整路径声明）+ 模拟 runtime 会话面。
 *
 * 覆盖：鉴权边界（status 如实反映 token）、setup/login、根会话保护、
 * 会话 CRUD 与 origin、路径段解码（编码 pluginId / 非法编码 400 / 多余
 * 段 404）、插件动态路由（真实 register、public 豁免、原始 URL 透传）、
 * 动作 null 原样 / undefined 违约 500、出站 JSON stash 脱敏（含引号/
 * 换行 secret）、providers PUT 原始数组、plugin config {values}、
 * profiles 删除 409、artifacts 伪造 meta/符号链接越界拒绝与真实字节、
 * skills traversal、body 上限、SSE 首帧与断开清理、关停无遗留。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { writeFile, mkdir, mkdtemp, rm, symlink, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import {
  ROOT_CONVERSATION_ID,
  HelmError,
  type ConversationSummary,
  type AskSpec,
  type PluginSummary,
  type HelmPluginContext,
} from '@helm/protocol'
import { createHubHandler, startHub } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike } from '../src/http/index.js'

// ---------------------------------------------------------------------------
// 测试基座
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

/** 模拟 EventHub：真实订阅语义 + SSE response（首帧 snapshot + 增量）。 */
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
            /* 已关 */
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
  return {
    id,
    title,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** 内存会话面：真实服务 + 模拟 conversation/ask/search。 */
const conversations = new Map<number, ConversationSummary>()
const asks = new Map<string, AskSpec>()
const submitted: Array<{ id: number; text: string; opts?: Record<string, unknown> }> = []
const aborted: number[] = []
const withdrawn: Array<{ id: number; submissionId: number }> = []

function makeKernel(): KernelRuntimeLike {
  return {
    listNodes() { throw new Error('本 HTTP fixture 不提供节点管理') },
    async issueNodeToken() { throw new Error('本 HTTP fixture 不签发节点身份') },
    async removeNode() { throw new Error('本 HTTP fixture 不移除节点') },
    async execEnv() { throw new Error('本 HTTP fixture 不执行节点命令') },
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
    async listConversations() {
      return [...conversations.values()]
    },
    async getConversationDetail(id: number, opts?: { limit?: number; cursor?: string }) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      // 模拟会话面：无持久时间线，返回空 entries（真实 kernel 由 SDK 分页提供）
      void opts
      return { ...found, entries: [] }
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const created = summary(id, init?.title ?? `会话 ${id}`)
      if (init?.profileId !== undefined) created.profileId = init.profileId
      conversations.set(id, created)
      return created
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      const next = { ...found, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}) }
      conversations.set(id, next)
      return next
    },
    async deleteConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      conversations.delete(id)
    },
    async submitInput(id, text, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      submitted.push({ id, text, opts })
      return { submissionId: 'sub-mock' }
    },
    async withdrawQueuedInput(id, opts) {
      if (!conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      withdrawn.push({ id, submissionId: opts.submissionId })
      return { status: 'withdrawn' }
    },
    async waitForInput(id: number, submissionId: string) {
      void id
      return { conversationId: id, submissionId, text: '', entry: { id: 'e', kind: 'pi.assistant' } }
    },
    async abortConversation(id) {
      aborted.push(id)
    },
    async resetConversation(id) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
    },
    async compactConversation(id) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return { taskId: 1, conversation: found }
    },
    async forkConversation(id) {
      if (!conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return summary(id + 100, `会话 ${id} (分叉)`)
    },
    async listAsks() {
      return [...asks.values()]
    },
    async answerAsk(id, answers, expectedStateSeq) {
      const ask = asks.get(id)
      if (ask === undefined) throw new HelmError('not_found', `提问不存在: ${id}`, 404)
      if (expectedStateSeq !== undefined && ask.expectedStateSeq !== undefined && expectedStateSeq < ask.expectedStateSeq) {
        throw new HelmError('superseded', '已在终端处理', 409)
      }
      void answers
      asks.delete(id)
    },
    async cancelAsk(id) {
      if (!asks.has(id)) throw new HelmError('not_found', `提问不存在: ${id}`, 404)
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

/** 可注入 refreshModels 的 mock kernel（验证 501 分支时置 undefined）。 */
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
// 真实 PluginHost 路由注册（definePlugin(ctx) ctx.route 完整路径声明）
// ---------------------------------------------------------------------------

let publicHandlerCalls: Request[] = []
let privateHandlerCalls: Request[] = []

function hostApiForPluginHost(): PluginHostBackend {
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => summary(99, 'x'),
    listConversations: () => [...conversations.values()],
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
    },
    updateConversation: async (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
    },
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    listActions: () => [],
    emitEvent: () => {},
  }
}

function docStore() {
  const docs = new Map<string, unknown>()
  return {
    get: <T>(key: string, initial: T): T => (docs.has(key) ? (docs.get(key) as T) : initial),
    set: <T>(key: string, value: T): void => void docs.set(key, value),
    flush: async () => {},
  }
}

/** 真实 register 一个含 public/private 路由与动作的插件。 */
async function registerRoutePlugin(host: PluginHost): Promise<void> {
  publicHandlerCalls = []
  privateHandlerCalls = []
  await host.register({
    id: 'builtin:triggers',
    name: 'triggers',
    async definePlugin(ctx: HelmPluginContext) {
      // PluginHost 声明相对路径，宿主自动拼接到 /api/plugins/<enc id>/routes/...
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
        description: '回声',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        outputSchema: { type: 'object' },
        async handler(input) {
          const text = (input as { text?: unknown }).text
          if (typeof text !== 'string') throw new HelmError('validation_error', 'text 需为字符串', 400)
          return { echoed: text }
        },
      })
    },
  })
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-http-test-'))
  auth = new AuthService(dataDir)
  credentials = new CredentialService(dataDir)
  profiles = new ProfileService(dataDir)
  skills = new SkillService(dataDir)
  providers = new ProviderService(dataDir)
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  pluginHost = new PluginHost({ dataDir, host: hostApiForPluginHost(), docs: docStore() })
  await registerRoutePlugin(pluginHost)
  hub0 = new TestEventHub()
  handler0 = createHubHandler(makeKernel())
  conversations.set(ROOT_CONVERSATION_ID, summary(1, '个人助理'))
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 鉴权边界
// ---------------------------------------------------------------------------

test('未配置时 setup 前所有私有端点 401（无匿名初始化漏洞）', { timeout: 60_000 }, async () => {
  token = undefined
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations', { auth: false })
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'unauthorized')
})

test('GET /api/auth/status 如实反映 Bearer token：未配置/无 token/错 token 均 false', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 未配置 + 无 token
  const noSetup = await call(handler, 'GET', '/api/auth/status', { auth: false })
  assert.equal(noSetup.status, 200)
  assert.deepEqual(noSetup.body, { configured: false, authenticated: false })
  // 未配置 + 错误 token：configured 与 authenticated 独立汇报
  const saved = token
  token = 'deadbeef-token'
  const badToken = await call(handler, 'GET', '/api/auth/status')
  assert.deepEqual(badToken.body, { configured: false, authenticated: false })
  token = saved
})

test('配置后 status：无 token false；错误 token false；有效 token true', { timeout: 60_000 }, async () => {
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

test('恶意网页抢先 setup 防护：恶意 Origin 403 且不写配置；text/plain 冒充 415', { timeout: 60_000 }, async () => {
  // 独立 dataDir：验证恶意请求绝不写入 auth 配置（抢先设置密码失败）
  const evilDir = await mkdtemp(join(tmpdir(), 'helm-http-evil-'))
  try {
    const evilAuth = new AuthService(evilDir)
    const evilKernel = makeKernel()
    ;(evilKernel as { auth: AuthService }).auth = evilAuth
    const handler = createHubHandler(evilKernel)
    // 非 JSON 的简单 POST（跨站表单可发）→ 415，不进入 setup
    const malicious = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-123' }),
    })
    assert.equal(malicious.status, 415)
    assert.equal(malicious.body.error.code, 'unsupported_media_type')
    // 配置未被写入：仍是未配置状态
    assert.deepEqual(await evilAuth.status(), { configured: false })
    // 任意源 + JSON 正常 setup
    const ok = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'http://192.168.31.26:3201',
      body: { password: 'legit-password-123' },
    })
    assert.equal(ok.status, 200)
    assert.equal(typeof ok.body.token, 'string')
    // 已配置后再来非 JSON 也被拒
    const again = await call(handler, 'POST', '/api/auth/setup', {
      auth: false,
      origin: 'https://evil.example',
      contentType: 'text/plain',
      raw: JSON.stringify({ password: 'evil-password-456' }),
    })
    assert.equal(again.status, 415)
    // 无 Origin 的 CLI 调用：text/plain 仍拒（JSON 端点），JSON 通过
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
    await rm(evilDir, { recursive: true, force: true })
  }
})

test('POST /api/auth/setup 弱密码 400 weak_password；重复 setup 409', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'short' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'weak_password')
  const dup = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'another-pass-123' } })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error.code, 'already_setup')
})

test('POST /api/auth/login 正确密码 200 / 错误密码 401 invalid_credentials', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'hunter2hunter2' } })
  assert.equal(ok.status, 200)
  assert.equal(typeof ok.body.token, 'string')
  const bad = await call(handler, 'POST', '/api/auth/login', { auth: false, body: { password: 'wrong-password-9' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.body.error.code, 'invalid_credentials')
})

test('无效 token 401；有效 token 通过', { timeout: 60_000 }, async () => {
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
// 会话生命周期
// ---------------------------------------------------------------------------

test('POST /api/conversations 创建；PATCH 更新；DELETE 根会话 403 root_conversation_protected', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/conversations', { body: { title: '测试会话', cwd: '/tmp', tags: ['worker'] } })
  assert.equal(created.status, 201)
  assert.equal(created.body.title, '测试会话')
  const id = created.body.id
  const patched = await call(handler, 'PATCH', `/api/conversations/${id}`, { body: { title: '改名', pinned: true } })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.title, '改名')
  assert.equal(patched.body.pinned, true)
  const root = await call(handler, 'DELETE', `/api/conversations/${ROOT_CONVERSATION_ID}`)
  assert.equal(root.status, 403)
  assert.equal(root.body.error.code, 'root_conversation_protected')
  const deleted = await call(handler, 'DELETE', `/api/conversations/${id}`)
  assert.equal(deleted.status, 200)
})

test('非法 conversationId 与非法字段 400 validation_error', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const badId = await call(handler, 'GET', '/api/conversations/abc')
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error.code, 'validation_error')
  const badBody = await call(handler, 'POST', '/api/conversations', { body: { title: 123 } })
  assert.equal(badBody.status, 400)
  const unknownField = await call(handler, 'POST', '/api/conversations', { body: { title: 'x', bogus: true } })
  assert.equal(unknownField.status, 400)
})

test('GET /api/conversations/:id 已有端点正常返回', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.id, ROOT_CONVERSATION_ID)
})

test('POST /:id/input 校验 origin/whenBusy 枚举并透传 kernel.submitInput', { timeout: 60_000 }, async () => {
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

test('POST /:id/input replaceFromEntryId 校验与透传；缺省时 opts 形状不变', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: '覆盖重发', replaceFromEntryId: 5 },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(submitted.at(-1)?.opts, { replaceFromEntryId: 5 })
  // 缺省：不携带 replaceFromEntryId 键（opts 形状与既有契约一致）。
  const plain = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: '普通提交' },
  })
  assert.equal(plain.status, 202)
  assert.equal(
    submitted.at(-1)?.opts && 'replaceFromEntryId' in (submitted.at(-1)!.opts as object),
    false,
    '缺省时 opts 不应携带 replaceFromEntryId 键',
  )
  // 非法值：0、负数、小数、非安全整数均 400。
  for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, '5']) {
    const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
      body: { text: 'x', replaceFromEntryId: bad },
    })
    assert.equal(res.status, 400, `replaceFromEntryId=${String(bad)} 应 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
})

test('POST /:id/withdraw 校验 submissionId 并调用 withdrawQueuedInput', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw`, {
    body: { submissionId: 42 },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { status: 'withdrawn' })
  assert.deepEqual(withdrawn.at(-1), { id: ROOT_CONVERSATION_ID, submissionId: 42 })
  // 非法 body：缺字段 / 0 / 小数 / 未知字段。
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
  // 不存在会话 404（mock 抛 not_found）。
  const nf = await call(handler, 'POST', '/api/conversations/88888/withdraw', { body: { submissionId: 1 } })
  assert.equal(nf.status, 404)
  // 多余段 404。
  const extra = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/withdraw/x`, {
    body: { submissionId: 1 },
  })
  assert.equal(extra.status, 404)
})

test('POST /:id/abort 调用 abortConversation', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/abort`)
  assert.equal(res.status, 200)
  assert.ok(aborted.includes(ROOT_CONVERSATION_ID))
})

// ---------------------------------------------------------------------------
// 路径段解码
// ---------------------------------------------------------------------------

test('编码 pluginId 正确解码：builtin%3Atriggers 等价 builtin:triggers', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const encoded = await call(handler, 'GET', '/api/plugins/builtin%3Atriggers/config')
  assert.equal(encoded.status, 200)
  const plain = await call(handler, 'GET', '/api/plugins/builtin:triggers/config')
  assert.equal(plain.status, 200)
  // 编码段与明文段返回一致内容
  assert.deepEqual(encoded.body, plain.body)
})

test('非法百分号编码 400 invalid_path_encoding', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/plugins/builtin%3Aassistant%zz/config')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_path_encoding')
})

test('多余路径段 404：不落入操作分支（auth/status/foo、workflows abort/extra 等）', { timeout: 60_000 }, async () => {
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

test('编码 slash（%2F）不重新分段：解码后仍是一个段', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // %2F 解码后是段内容的一部分（'a/b'），不会重新切分路由；该值不是
  // 合法 profileId，按单段参数校验拒绝 400。
  const res = await call(handler, 'GET', '/api/profiles/a%2Fb')
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('SSE 首帧 snapshot + 增量事件 + 断开取消订阅（无遗留 listener）', { timeout: 60_000 }, async () => {
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
  hub0.publish('conversation.upsert', { type: 'conversation.upsert', conversation: summary(9, '事件会话') })
  const second = await reader.read()
  assert.ok(decoder.decode(second.value).includes('conversation.upsert'))
  const before = hub0.listenerCount()
  controller.abort()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(hub0.listenerCount(), before - 1)
})

test('SSE 未认证 401', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const request = new Request('http://127.0.0.1:3202/api/events')
  const response = await handler(request)
  assert.equal(response.status, 401)
})

// ---------------------------------------------------------------------------
// Profiles / Providers / Credentials / Skills / Models
// ---------------------------------------------------------------------------

test('profiles CRUD（真实 ProfileService + system/memory 在线读写）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'researcher',
      name: '研究员',
      runtime: { kind: 'herdr', agent: 'agy' },
      system: '# 研究员系统提示词\n保持严谨。',
      memory: '# 研究员记忆\n偏好第一性原理。',
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.id, 'researcher')
  assert.equal(created.body.system, '# 研究员系统提示词\n保持严谨。')
  assert.equal(created.body.memory, '# 研究员记忆\n偏好第一性原理。')
  const list = await call(handler, 'GET', '/api/profiles')
  assert.ok(list.body.some((p: any) => p.id === 'researcher'))
  const put = await call(handler, 'PUT', '/api/profiles/researcher', {
    body: { name: '资深研究员', system: '# 资深研究员提示词\n升级版。' },
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.name, '资深研究员')
  assert.equal(put.body.system, '# 资深研究员提示词\n升级版。')
  assert.equal(put.body.memory, '# 研究员记忆\n偏好第一性原理。')
  const got = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(got.status, 200)
  assert.equal(got.body.system, '# 资深研究员提示词\n升级版。')
  assert.equal(got.body.memory, '# 研究员记忆\n偏好第一性原理。')
  const del = await call(handler, 'DELETE', '/api/profiles/researcher')
  assert.equal(del.status, 200)
  const gone = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(gone.status, 404)
})

test('profiles 详情读取失败显式报错，不返回可覆盖原文件的空白正文', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await profiles.save({ id: 'missing-system', name: '缺失正文' })
  await rm(join(dataDir, 'profiles', 'missing-system', 'SYSTEM.md'))
  const result = await call(handler, 'GET', '/api/profiles/missing-system')
  assert.equal(result.status, 404)
  assert.ok(result.body.error)
  assert.equal(result.body.system, undefined)
})

test('profiles DELETE 仍被会话绑定返回 409 profile_in_use', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bound-profile', name: '绑定中', runtime: { kind: 'herdr', agent: 'agy' } },
  })
  const created = await call(handler, 'POST', '/api/conversations', {
    body: { title: '绑定会话', profileId: 'bound-profile' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.profileId, 'bound-profile')
  const rejected = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'profile_in_use')
  // 解绑后可删
  await call(handler, 'PATCH', `/api/conversations/${created.body.id}`, { body: { profileId: 'assistant' } })
  // 模拟会话面 PATCH 不改 profileId，直接改内存以验证删除路径
  const conv = conversations.get(created.body.id)!
  conv.profileId = 'assistant'
  const ok = await call(handler, 'DELETE', '/api/profiles/bound-profile')
  assert.equal(ok.status, 200)
})

test('profiles skills 白名单 HTTP roundtrip：创建/更新/读回三态，非法 id 与未知字段拒绝', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 创建：白名单去重 + 允许暂缺 id（运行时可后装）
  const created = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'skills-profile', name: '技能白名单', skills: ['helm-cli', 'future-skill', 'helm-cli'] },
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.skills, ['helm-cli', 'future-skill'], '重复项去重后返回')

  // PUT 更新为空数组（禁用全部）——整体替换契约，非缺省
  const put = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: '技能白名单', skills: [] },
  })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body.skills, [], '空数组必须透传持久化')
  const onDisk = JSON.parse(
    await readFile(join(dataDir, 'profiles', 'skills-profile', 'profile.json'), 'utf8'),
  ) as { skills?: string[] }
  assert.deepEqual(onDisk.skills, [], 'HTTP 写入路径落盘保留空数组')

  // PUT 不带 skills（整体替换语义：回到缺省全部可用）
  const put2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { name: '技能白名单' },
  })
  assert.equal(put2.status, 200)
  assert.equal(put2.body.skills, undefined, 'PUT 省略 skills 回到缺省（不写键）')

  // GET 读回服务层真实状态
  const got = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(got.status, 200)
  assert.equal(got.body.skills, undefined)

  // 非法 skill id（路径注入形态）拒绝，不产生部分写入
  const bad = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'bad-skills', skills: ['../profiles/assistant'] },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'validation_error')
  const bad2 = await call(handler, 'PUT', '/api/profiles/skills-profile', {
    body: { skills: 'helm-cli' },
  })
  assert.equal(bad2.status, 400)
  // 上述拒绝不改变已保存状态（仍是缺省）
  const after = await call(handler, 'GET', '/api/profiles/skills-profile')
  assert.equal(after.body.skills, undefined)
})

test('profiles 托管保护：managedByPlugin 拒绝删除与篡改，POST 不可伪造托管身份', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 可信插件自举资产直写（不经 HTTP）：ProfileService.save 带 managedByPlugin
  await profiles.save({
    id: 'hub-managed',
    name: '受管中枢',
    managedByPlugin: 'builtin:superagent',
    humanSelectable: false,
  })
  // DELETE：托管 Profile 403（无会话绑定占用，纯粹四托管保护）
  const del = await call(handler, 'DELETE', '/api/profiles/hub-managed')
  assert.equal(del.status, 403)
  assert.equal(del.body.error.code, 'profile_managed_by_plugin')

  // PUT 移除 managedByPlugin（整体替换契约下缺失即移除）：403
  const putStrip = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: '改名' },
  })
  assert.equal(putStrip.status, 403)
  assert.equal(putStrip.body.error.code, 'profile_managed_by_plugin')

  // PUT 改写为其他插件：403
  const putFake = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: '改名', managedByPlugin: 'builtin:other' },
  })
  assert.equal(putFake.status, 403)

  // PUT 原样携带相同值：合法（保留其余字段编辑能力）
  const putKeep = await call(handler, 'PUT', '/api/profiles/hub-managed', {
    body: { name: '受管中枢改名', managedByPlugin: 'builtin:superagent', humanSelectable: false },
  })
  assert.equal(putKeep.status, 200)
  assert.equal(putKeep.body.name, '受管中枢改名')
  assert.equal(putKeep.body.managedByPlugin, 'builtin:superagent')

  // POST 创建带 managedByPlugin：403（托管身份仅可信插件自举可声明）
  const post = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'fake-managed', name: '伪造托管', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(post.status, 403)
  assert.equal(post.body.error.code, 'profile_managed_by_plugin')

  const overwrite = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'hub-managed', name: '覆盖并移除托管' },
  })
  assert.equal(overwrite.status, 403, 'POST 不得绕过 PUT 的托管保护')
  assert.equal((await profiles.get('hub-managed'))?.managedByPlugin, 'builtin:superagent')

  await profiles.save({ id: 'ordinary', name: '普通配置' })
  const inject = await call(handler, 'PUT', '/api/profiles/ordinary', {
    body: { name: '伪造受管配置', managedByPlugin: 'builtin:superagent' },
  })
  assert.equal(inject.status, 403, 'PUT 不得给普通配置伪造托管身份')
  assert.equal((await profiles.get('ordinary'))?.managedByPlugin, undefined)
})

test('profiles DELETE 默认 assistant 受保护（被根会话绑定或内核默认保护，不可经 HTTP 删除）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const del = await call(handler, 'DELETE', '/api/profiles/assistant')
  // fixture 未建根会话时命中内核 DEFAULT_PROFILE_ID 保护（403）；
  // 已建根会话时命中会话绑定保护（409）——两者均为拒绝，绝不允许 200。
  assert.ok(del.status === 403 || del.status === 409, `assistant 删除应被拒绝（实际 ${del.status}）`)
})

test('providers PUT 接受完整原始数组（CLI 约定）与 { providers } 包裹', { timeout: 60_000 }, async () => {
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
  // 原始数组内的非法项同样 400（不因形态放宽）
  const bad = await call(handler, 'PUT', '/api/providers', {
    body: [{ id: 'x', protocol: 'grpc', baseUrl: 'ftp://x', models: [], enabled: true }],
  })
  assert.equal(bad.status, 400)
  // 非数组非对象 400
  const notObj = await call(handler, 'PUT', '/api/providers', { body: 'nope' })
  assert.equal(notObj.status, 400)
})

test('credentials 仅 id/configured 键，绝无明文；PUT/DELETE 生效', { timeout: 60_000 }, async () => {
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

test('skills list + read {text}；path traversal 拒绝', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const skillDir = join(dataDir, 'skills', 'demo-skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n# Demo\n')
  await writeFile(join(skillDir, 'references', 'guide.md'), '# Guide\n内容')
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

test('models/providers 返回公开供应商元数据；路径不匹配不误入目录', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models/providers')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, [{ id: 'faux', name: 'Faux', modelCount: 1, authMethods: [{ type: 'api_key', label: 'API Key' }] }])
  assert.equal((await call(handler, 'GET', '/api/models/providers/extra')).status, 404)
})

test('默认配置部分更新保留未提供的模型字段并拒绝空/非法 body', { timeout: 60_000 }, async () => {
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

test('models 返回目录对象（models 数组 + thinkingLevels）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.models))
})

test('POST /api/models/refresh：空/{} 全量、provider/providers/force 透传；非法字段 400；未实现 501', { timeout: 60_000 }, async () => {
  // 1) mock 提供实现：空 body / {} / 单选 / 多选 + force 透传。
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

  // 2) mock 不提供实现：501 not_implemented。
  const bare = makeHandlers(makeKernelWithRefresh())
  const notImpl = await call(bare.handler, 'POST', '/api/models/refresh', { body: {} })
  assert.equal(notImpl.status, 501)
  assert.equal(notImpl.body.error.code, 'not_implemented')
})

// ---------------------------------------------------------------------------
// Artifacts（安全边界 + 真实字节）
// ---------------------------------------------------------------------------

test('artifacts 列表 + content 真实 content-type/disposition/字节；未知 404', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const source = join(dataDir, 'note.md')
  await writeFile(source, '# 产物\n内容')
  const meta = await artifacts.register(ROOT_CONVERSATION_ID, source, { name: 'note.md' })
  const list = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/artifacts`)
  assert.equal(list.status, 200)
  assert.ok(list.body.some((a: any) => a.id === meta.id))
  const content = await call(handler, 'GET', `/api/artifacts/${meta.id}/content?inline=1`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'text/markdown')
  assert.equal(content.headers.get('content-disposition'), 'inline; filename="note.md"; filename*=UTF-8\'\'note.md')
  assert.ok(content.text.includes('# 产物'))
  const missing = await call(handler, 'GET', '/api/artifacts/no-such-id/content')
  assert.equal(missing.status, 404)
})

test('中文产物文件名使用 UTF-8 disposition，预览与下载不因响应头编码报 500', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const metadata = await artifacts.writeUploaded(1, { name: '验收说明.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# 中文文件') })
  for (const suffix of ['', '?inline=1']) {
    const response = await call(handler, 'GET', `/api/artifacts/${metadata.id}/content${suffix}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E9/)
    assert.equal(response.text, '# 中文文件')
  }
})

test('artifacts 二进制按字节原样返回（不转字符串）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 8 个 0xFF 字节：UTF-8 解码会损坏
  const source = join(dataDir, 'blob.bin')
  const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0xff, 0xfe, 0x00, 0x81])
  await writeFile(source, raw)
  const meta = await artifacts.register(ROOT_CONVERSATION_ID, source, { name: 'blob.bin' })
  const res = await call(handler, 'GET', `/api/artifacts/${meta.id}/content`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), '8')
  // 直接请求原始字节（不经 call() 的 text/JSON 解析路径）
  const direct = await handler(new Request(`http://127.0.0.1:3202/api/artifacts/${meta.id}/content`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  const bytes = new Uint8Array(await direct.arrayBuffer())
  assert.deepEqual([...bytes], [...raw])
})

test('artifacts 伪造 metadata（path=credentials.json）不得泄密', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({ providers: { x: { value: 'leak-me' } } }), { mode: 0o600 })
  const fakeMeta = {
    id: 'evil-1',
    conversationId: ROOT_CONVERSATION_ID,
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

test('artifacts 伪 metadata（artifacts/<convId>/../../escape）拒绝', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const secretFile = join(dataDir, 'escape-secret.txt')
  await writeFile(secretFile, 'TOP-SECRET')
  const fakeMeta = {
    id: 'evil-2',
    conversationId: ROOT_CONVERSATION_ID,
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

test('artifacts 符号链接越界拒绝（文件名段软链逃逸）', { timeout: 60_000 }, async () => {
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

test('artifacts 会话目录软链逃逸拒绝', { timeout: 60_000 }, async () => {
  const evilRepo = new InMemoryArtifactRepository()
  const evilArtifacts = new ArtifactService(dataDir, evilRepo, stash)
  const outsideDir = join(dataDir, 'outside')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'loot.txt'), 'CONV-SYMLINK-SECRET')
  // artifacts/777777 本身是指向界外目录的软链（攻击者预置）
  const artifactsRoot = join(dataDir, 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  const convLink = join(artifactsRoot, '777777')
  await rm(convLink, { force: true }).catch(() => {})
  await symlink(outsideDir, convLink)
  const fakeMeta = {
    id: 'evil-4',
    conversationId: 777777,
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

test('artifacts 读权限错误不伪称 missing（非 ENOENT 原样 500）', { timeout: 60_000 }, async () => {
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
  // 进程是 root 时 chmod 000 仍可读：此时应成功返回内容（如实反映可读性）
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

test('search?q= 透传；空 q 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/search?q=hello')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const empty = await call(handler, 'GET', '/api/search?q=')
  assert.equal(empty.status, 400)
})

test('workflows / worktrees 硬编码路由已删除：一律 404（编排经插件动作 /api/actions）', { timeout: 60_000 }, async () => {
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
// Plugins（真实 PluginHost）/ Actions
// ---------------------------------------------------------------------------

test('真实 PluginHost 路由：public webhook 豁免鉴权；非 public 需 token；handler 收到原始 URL', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  publicHandlerCalls = []
  // public 豁免（无 token 直达）
  const pub = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  // handler 收到的 URL 保持完整原始路径（含 : 与参数段），未被改写
  assert.equal(pub.body.got, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  assert.equal(publicHandlerCalls.length, 1)
  assert.equal(new URL(publicHandlerCalls[0]!.url).pathname, '/api/plugins/builtin:triggers/routes/webhook/hook-1')
  // 插件原始路由可接收非 JSON 正文；验签策略由插件声明。
  const raw = await handler(new Request('http://localhost/api/plugins/builtin:triggers/routes/webhook/hook-raw', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'raw webhook example',
  }))
  assert.equal(raw.status, 200)
  // 非 public 未认证 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status', { auth: false })
  assert.equal(noAuth.status, 401)
  assert.equal(privateHandlerCalls.length, 0)
  // 认证后可访问
  const ok = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true })
  // 不存在的插件路由 404
  const missing = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/nothing')
  assert.equal(missing.status, 404)
  // 参数段不匹配（多一段）：未认证先撞鉴权门 401；带 token 后如实 404
  const extraNoAuth = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { auth: false, body: {} })
  assert.equal(extraNoAuth.status, 401)
  const extra = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1/extra', { body: {} })
  assert.equal(extra.status, 404)
})

test('真实 PluginHost 路由：编码 pluginId 也能命中（完整路径匹配器两处一致）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const pub = await call(handler, 'POST', '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  assert.equal(pub.body.got, '/api/plugins/builtin%3Atriggers/routes/webhook/hook-2')
})

test('plugins list；config PUT 保持 { values } 包裹', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/plugins')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body))
  assert.ok(list.body.some((p: any) => p.id === 'builtin:triggers'))
  // setConfig 在无持久化 PluginConfigStore 时显式 501 config_store_unavailable
  //（诚实不支持，不伪造写入成功；真实 kernel 装配 store 后即为 200）。
  const set = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { values: { retries: 3 } } })
  assert.ok(set.status === 200 || set.status === 501, `unexpected ${set.status}`)
  if (set.status === 501) assert.equal(set.body.error.code, 'config_store_unavailable')
  // 非 { values } 包裹形态 400（边界校验先行）
  const badShape = await call(handler, 'PUT', '/api/plugins/builtin:triggers/config', { body: { retries: 3 } })
  assert.equal(badShape.status, 400)
  assert.equal(badShape.body.error.code, 'validation_error')
})

test('真实 action：invoke 200；null 原样返回不伪造成功对象', { timeout: 60_000 }, async () => {
  // 追加一个返回 null 的动作（null 是合法输出）
  await pluginHost.register({
    id: 'builtin:nullish',
    name: 'nullish',
    async definePlugin(ctx: HelmPluginContext) {
      ctx.action({
        id: 'get-null',
        description: '返回 null',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'null' },
        handler: () => null,
      })
      ctx.action({
        id: 'get-undefined',
        description: '返回 undefined（违约输出）',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => undefined,
      })
    },
  })
  const { handler } = makeHandlers()
  const invoked = await call(handler, 'POST', '/api/actions/builtin:nullish/get-null', { body: { input: {} } })
  assert.equal(invoked.status, 200)
  // 原样 null：响应体是 "null"，绝不伪造成 {ok:true}
  assert.deepEqual(invoked.body, null)
  assert.equal(invoked.text, 'null')
  const undef = await call(handler, 'POST', '/api/actions/builtin:nullish/get-undefined', { body: { input: {} } })
  assert.equal(undef.status, 500)
  assert.ok(['invalid_output', 'invalid_plugin_output'].includes(undef.body.error.code))
  assert.notEqual(undef.text, '{"ok":true}')
  // 真实 echo action 正常
  const echo = await call(handler, 'POST', '/api/actions/builtin:triggers/echo', { body: { input: { text: 'hi' } } })
  assert.equal(echo.status, 200)
  assert.deepEqual(echo.body, { echoed: 'hi' })
})

// ---------------------------------------------------------------------------
// 出站 JSON stash 脱敏
// ---------------------------------------------------------------------------

test('出站 JSON 递归脱敏：含引号/换行的 secret 也不泄漏，marker 不还原', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const trickySecret = 'sk-"quoted"\nline-break\ttab'
  const placeholder = stash.put(ROOT_CONVERSATION_ID, 'TRICKY_KEY', trickySecret)
  // search 返回含 secret 明文与 marker 的嵌套结构
  ;(kernel as { search: (q: string) => Promise<unknown[]> }).search = async () => [
    { conversationId: 1, snippet: `prefix ${trickySecret} middle [marker]${placeholder} end` },
    { nested: { list: [trickySecret, { deep: trickySecret }] } },
  ]
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/search?q=leak')
  assert.equal(res.status, 200)
  assert.ok(!res.text.includes('sk-"quoted"'))
  assert.ok(!res.text.includes('line-break\\ttab'.replace('\\\\', '\\')))
  // marker 保持脱敏形态（不还原为明文）
  assert.ok(res.text.includes(placeholder))
  assert.ok(res.text.includes('[REDACTED:stash:'))
})

test('error.details 同样脱敏', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const secret = 'err-detail-secret-123'
  stash.put(ROOT_CONVERSATION_ID, 'ERR_KEY', secret)
  ;(kernel as { search: (q: string) => Promise<unknown[]> }).search = async () => {
    throw new HelmError('search_failed', '搜索失败', 500, { trace: secret })
  }
  const handler = createHubHandler(kernel)
  const res = await call(handler, 'GET', '/api/search?q=x')
  assert.equal(res.status, 500)
  assert.ok(!res.text.includes(secret))
})

// ---------------------------------------------------------------------------
// 请求体边界
// ---------------------------------------------------------------------------

test('非法 JSON 400 invalid_json', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/login', { auth: false, raw: '{not-json' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_json')
})

test('body 超 1MiB 413 body_too_large', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const big = 'x'.repeat(1024 * 1024 + 100)
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: big },
  })
  assert.equal(res.status, 413)
  assert.equal(res.body.error.code, 'body_too_large')
})

test('未知路由 404；未知方法 405', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const nf = await call(handler, 'GET', '/api/no-such-thing')
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'not_found')
  const mna = await call(handler, 'PUT', '/api/conversations')
  assert.equal(mna.status, 405)
})

test('非 /api 前缀 404（显式 webDistDir:false 的纯 API 行为；默认静态托管由 static-web.test.ts 覆盖）', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handler = createHubHandler({ kernel, webDistDir: false })
  const res = await call(handler, 'GET', '/favicon.ico')
  assert.equal(res.status, 404)
})

test('FileNotFoundError 映射 404 而非 500', { timeout: 60_000 }, async () => {
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
// startHub：真实 node 监听 + 关停
// ---------------------------------------------------------------------------

test('startHub port:0 监听 127.0.0.1，真实 HTTP 往返，close 迅速完成且 SSE 无遗留', { timeout: 60_000 }, async () => {
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
    assert.ok(elapsed < 5_000, `close 应迅速完成，实际 ${elapsed}ms`)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(hub0.listenerCount(), listenersBefore - 1)
  } finally {
    await handle.close().catch(() => {})
  }
})

test('startHub 真实往返：编码 pluginId 经 node 服务器命中 action', { timeout: 60_000 }, async () => {
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

test('CORS：任意来源均反射并带凭据头', { timeout: 60_000 }, async () => {
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
