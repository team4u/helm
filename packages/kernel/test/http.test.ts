/**
 * HTTP/SSE 传输层测试：真实临时目录 + 真实 services（auth/credentials/
 * profiles/skills/providers/artifacts）+ 模拟 runtime 会话面与 EventHub。
 *
 * 覆盖：鉴权边界、setup/login、根会话保护、会话 CRUD 与 origin、SSE 首帧
 * 与断开清理、schema action 非法 400、插件动态路由（public 豁免/命名空间）、
 * 配置脱敏、skills traversal、invalid JSON、body 上限、关停无遗留。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import {
  ROOT_CONVERSATION_ID,
  HelmError,
  type ConversationSummary,
  type AskSpec,
  type PluginSummary,
} from '@helm/protocol'
import { createHubHandler, startHub } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike, PluginHost, PluginRouteInfo, WorkflowServiceLike } from '../src/http/index.js'

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
let hub: ReturnType<typeof createHubHandler>
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
        // 首帧 snapshot
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
  snapshotResponse(): Response {
    return new Response('event: snapshot\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
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

/** 内存会话面：真实服务 + 模拟 conversation/ask/search/plugins。 */
const conversations = new Map<number, ConversationSummary>()
const asks = new Map<string, AskSpec>()
const submitted: Array<{ id: number; text: string; opts?: Record<string, unknown> }> = []
const aborted: number[] = []

function makeKernel(pluginsOverride?: Partial<PluginHost>): KernelRuntimeLike {
  const basePlugins: PluginHost = {
    list: (): PluginSummary[] => [
      { id: 'builtin:assistant', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
    ],
    enable: () => {},
    disable: () => {},
    listActions: () => [],
    invokeAction: () => {
      throw new HelmError('unknown_action', '动作不存在', 404)
    },
    getConfig: () => ({}),
    getConfigSchema: () => ({
      token: { type: 'string', secret: true },
      retries: { type: 'number' },
    }),
    setConfig: () => {},
    listRoutes: (): PluginRouteInfo[] => [
      {
        pluginId: 'builtin:triggers',
        method: 'POST',
        path: 'webhook/:id',
        public: true,
        handler: (req: Request) => new Response(JSON.stringify({ got: new URL(req.url).pathname }), { headers: { 'content-type': 'application/json' } }),
      },
      {
        pluginId: 'builtin:triggers',
        method: 'GET',
        path: 'status',
        handler: () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      },
    ],
  }
  return {
    dataDir,
    auth,
    events: hub0,
    profiles,
    skills,
    credentials,
    providers,
    models: { list: () => [{ id: 'faux/model' }] },
    artifacts,
    plugins: pluginsOverride !== undefined ? { ...basePlugins, ...pluginsOverride } : basePlugins,
    async listConversations() {
      return [...conversations.values()]
    },
    async getConversation(id: number) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
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
    },
    async abortConversation(id) {
      aborted.push(id)
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
    listModels: () => [{ id: 'faux/model' }],
  }
}

const workflows: WorkflowServiceLike = {
  list: () => [{ name: 'demo' }],
  run: async (request) => ({
    id: 'run-1',
    name: request.name ?? 'inline',
    conversationId: request.conversationId ?? ROOT_CONVERSATION_ID,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  getRun: async (runId) =>
    runId === 'run-1'
      ? { id: 'run-1', name: 'demo', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }
      : undefined,
  abort: () => {},
}

function makeHandlers(kernel = makeKernel()) {
  return { kernel, handler: createHubHandler(kernel, workflows) }
}

async function call(handler: (req: Request) => Promise<Response>, method: string, path: string, opts?: { body?: unknown; auth?: boolean; raw?: string }): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {}
  if (opts?.body !== undefined || opts?.raw !== undefined) headers['content-type'] = 'application/json'
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
  return { status: response.status, body: parsed, headers: response.headers }
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-http-test-'))
  auth = new AuthService(dataDir)
  credentials = new CredentialService(dataDir)
  profiles = new ProfileService(dataDir)
  skills = new SkillService(dataDir)
  providers = new ProviderService(dataDir)
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), new SecretStash())
  hub0 = new TestEventHub()
  hub = createHubHandler(makeKernel(), workflows)
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

test('GET /api/auth/status 公开返回 configured=false', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/auth/status', { auth: false })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { configured: false, authenticated: true })
})

test('POST /api/auth/setup 弱密码 400 weak_password', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'short' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'weak_password')
})

test('POST /api/auth/setup 首次成功返回 token；重复 setup 409 already_setup', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'hunter2hunter2' } })
  assert.equal(ok.status, 200)
  assert.equal(typeof ok.body.token, 'string')
  token = ok.body.token
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

test('POST /:id/input 校验 origin/whenBusy 枚举并透传 kernel.submitInput', { timeout: 60_000 }, async () => {
  const { kernel, handler } = makeHandlers()
  const h2 = createHubHandler(kernel, workflows)
  void h2
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: '你好', origin: 'human', whenBusy: 'followUp' },
  })
  assert.equal(ok.status, 200)
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

test('POST /:id/abort 调用 abortConversation', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/abort`)
  assert.equal(res.status, 200)
  assert.deepEqual(aborted, [ROOT_CONVERSATION_ID])
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
  // 首帧
  const first = await reader.read()
  const firstText = decoder.decode(first.value)
  assert.ok(firstText.includes('event: snapshot'))
  assert.ok(firstText.includes('"conversations"'))
  // 订阅已生效
  assert.ok(hub0.listenerCount() >= 1)
  // 发布增量事件
  hub0.publish('conversation.upsert', { type: 'conversation.upsert', conversation: summary(9, '事件会话') })
  const second = await reader.read()
  assert.ok(decoder.decode(second.value).includes('conversation.upsert'))
  // 断开：取消订阅
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

test('profiles CRUD（真实 ProfileService）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const created = await call(handler, 'POST', '/api/profiles', {
    body: { id: 'researcher', name: '研究员', runtime: { kind: 'herdr', agent: 'agy' } },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.id, 'researcher')
  const list = await call(handler, 'GET', '/api/profiles')
  assert.ok(list.body.some((p: any) => p.id === 'researcher'))
  const put = await call(handler, 'PUT', '/api/profiles/researcher', { body: { name: '资深研究员' } })
  assert.equal(put.status, 200)
  assert.equal(put.body.name, '资深研究员')
  const del = await call(handler, 'DELETE', '/api/profiles/researcher')
  assert.equal(del.status, 200)
  const gone = await call(handler, 'GET', '/api/profiles/researcher')
  assert.equal(gone.status, 404)
})

test('providers GET/PUT 完整数组（真实 ProviderService）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const put = await call(handler, 'PUT', '/api/providers', {
    body: {
      providers: [{ id: 'groq', protocol: 'openai', baseUrl: 'https://api.groq.com/v1', models: ['llama-3.3-70b'], enabled: true }],
    },
  })
  assert.equal(put.status, 200)
  const list = await call(handler, 'GET', '/api/providers')
  assert.ok(Array.isArray(list.body))
  assert.equal(list.body[0].id, 'groq')
  const bad = await call(handler, 'PUT', '/api/providers', {
    body: { providers: [{ id: 'x', protocol: 'grpc', baseUrl: 'ftp://x', models: [], enabled: true }] },
  })
  assert.equal(bad.status, 400)
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

test('models 返回数组', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/models')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
})

// ---------------------------------------------------------------------------
// Artifacts / Search
// ---------------------------------------------------------------------------

test('artifacts 列表 + content 真实 content-type/disposition；未知 404', { timeout: 60_000 }, async () => {
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
  assert.equal(content.headers.get('content-disposition'), 'inline; filename="note.md"')
  assert.ok(content.body.includes('# 产物'))
  const missing = await call(handler, 'GET', '/api/artifacts/no-such-id/content')
  assert.equal(missing.status, 404)
})

test('search?q= 透传；空 q 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/search?q=hello')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const empty = await call(handler, 'GET', '/api/search?q=')
  assert.equal(empty.status, 400)
})

// ---------------------------------------------------------------------------
// Plugins / Actions
// ---------------------------------------------------------------------------

test('plugins list / enable / config 脱敏', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/plugins')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body))
  assert.ok(list.body.some((p: any) => p.id === 'builtin:assistant' && p.locked))
  const kernelWithSecret = makeKernel({
    getConfig: () => ({ token: 'sk-live-plaintext', retries: 3 }),
  })
  const h = createHubHandler(kernelWithSecret, workflows)
  const config = await call(h, 'GET', '/api/plugins/builtin:assistant/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.values.token, '******')
  assert.equal(config.body.values.retries, 3)
  assert.ok(!JSON.stringify(config.body).includes('sk-live-plaintext'))
})

test('actions list 空数组；invoke 非法入参 schema 400 / 未知动作 404', { timeout: 60_000 }, async () => {
  const kernelWithAction = makeKernel({
    listActions: () => [
      {
        pluginId: 'builtin:demo',
        id: 'echo',
        description: '回声',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        outputSchema: { type: 'object' },
      },
    ],
    invokeAction: (_pluginId, actionId, input) => {
      if (actionId !== 'echo') {
        throw new HelmError('unknown_action', `动作不存在: ${actionId}`, 404)
      }
      if (typeof (input as any)?.text !== 'string') {
        throw new HelmError('validation_error', 'text 需为字符串', 400)
      }
      return { echoed: (input as any).text }
    },
  })
  const handler = createHubHandler(kernelWithAction, workflows)
  const list = await call(handler, 'GET', '/api/actions')
  assert.equal(list.status, 200)
  assert.equal(list.body[0].id, 'echo')
  const ok = await call(handler, 'POST', '/api/actions/builtin:demo/echo', { body: { input: { text: 'hi' } } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { echoed: 'hi' })
  const bad = await call(handler, 'POST', '/api/actions/builtin:demo/echo', { body: { input: { text: 42 } } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'validation_error')
  const missing = await call(handler, 'POST', '/api/actions/builtin:demo/nope', { body: { input: {} } })
  assert.equal(missing.status, 404)
})

test('插件动态路由：public webhook 豁免鉴权；非 public 需 token；强制 routes 命名空间', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // public 豁免
  const pub = await call(handler, 'POST', '/api/plugins/builtin:triggers/routes/webhook/hook-1', { auth: false, body: {} })
  assert.equal(pub.status, 200)
  assert.equal(pub.body.got, '/webhook/hook-1')
  // 非 public 未认证 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status', { auth: false })
  assert.equal(noAuth.status, 401)
  // 认证后可访问
  const ok = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/status')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true })
  // 不存在的插件路由 404
  const missing = await call(handler, 'GET', '/api/plugins/builtin:triggers/routes/nothing')
  assert.equal(missing.status, 404)
})

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

test('workflows list / run 202 / getRun / abort；run body 恰一 source', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const list = await call(handler, 'GET', '/api/workflows')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body))
  const run = await call(handler, 'POST', '/api/workflows/run', { body: { name: 'demo', args: { x: 1 } } })
  assert.equal(run.status, 202)
  assert.equal(run.body.id, 'run-1')
  const got = await call(handler, 'GET', '/api/workflows/runs/run-1')
  assert.equal(got.status, 200)
  assert.equal(got.body.status, 'running')
  const abort = await call(handler, 'POST', '/api/workflows/runs/run-1/abort')
  assert.equal(abort.status, 200)
  const missing = await call(handler, 'GET', '/api/workflows/runs/none')
  assert.equal(missing.status, 404)
  const multi = await call(handler, 'POST', '/api/workflows/run', { body: { name: 'a', script: 'x' } })
  assert.equal(multi.status, 400)
  const zero = await call(handler, 'POST', '/api/workflows/run', { body: { args: {} } })
  assert.equal(zero.status, 400)
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

test('workflow body 超 512KiB 413', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const big = 'x'.repeat(512 * 1024 + 100)
  const res = await call(handler, 'POST', '/api/workflows/run', { body: { script: big } })
  assert.equal(res.status, 413)
})

test('未知路由 404；未知方法 405', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const nf = await call(handler, 'GET', '/api/no-such-thing')
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'not_found')
  const mna = await call(handler, 'PUT', '/api/conversations')
  assert.equal(mna.status, 405)
})

test('非 /api 前缀 404', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/favicon.ico')
  assert.equal(res.status, 404)
})

test('FileNotFoundError 映射 404 而非 500', { timeout: 60_000 }, async () => {
  const kernelThrowing = makeKernel({
    getConfig: () => {
      throw new FileNotFoundError('config.json')
    },
  })
  const handler = createHubHandler(kernelThrowing, workflows)
  const res = await call(handler, 'GET', '/api/plugins/builtin:assistant/config')
  assert.equal(res.status, 404)
})

// ---------------------------------------------------------------------------
// startHub：真实 node 监听 + 关停
// ---------------------------------------------------------------------------

test('startHub port:0 监听 127.0.0.1，真实 HTTP 往返，close 迅速完成且 SSE 无遗留', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  const handle = await startHub({ kernel, workflows, port: 0 })
  try {
    assert.ok(handle.url.startsWith('http://127.0.0.1:'))
    assert.ok((handle.port as number) > 0)
    // 未认证
    const unauth = await fetch(`${handle.url}/api/conversations`)
    assert.equal(unauth.status, 401)
    // 认证往返
    const ok = await fetch(`${handle.url}/api/conversations`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(ok.status, 200)
    // SSE 打开不断开（模拟挂起长连接）
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
    // close：主动 abort 全部在途请求（含 SSE）+ 销毁连接 + server.close
    const start = Date.now()
    await handle.close()
    const elapsed = Date.now() - start
    assert.ok(elapsed < 5_000, `close 应迅速完成，实际 ${elapsed}ms`)
    // SSE 订阅已被 close 主动断开（不依赖客户端取消）
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(hub0.listenerCount(), listenersBefore - 1)
  } finally {
    // 幂等关闭兜底（已关则忽略错误）
    await handle.close().catch(() => {})
  }
})

test('CORS：允许源带凭据头；未知源无 CORS 头', { timeout: 60_000 }, async () => {
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
      headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example' },
    }),
  )
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
  const preflight = await handler(
    new Request('http://127.0.0.1:3202/api/conversations', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3201' },
    }),
  )
  assert.equal(preflight.status, 204)
})
