/**
 * HTTP 核心对齐测试：detail 分页 / input meta+wait / workflows runs /
 * plugins public doc / profile runtime 扩展字段 / profileId 过滤 /
 * startHub setHubUrl。
 *
 * 基座与 http.test.ts 同构：真实 services + 真实 PluginHost（含 public/private
 * doc 声明）+ 模拟会话面（实现全部新必需方法，不用缺省空数据掩盖契约）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
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
} from '../src/services/index.js'
import { PluginHost } from '../src/plugins/index.js'
import {
  HelmError,
  ROOT_CONVERSATION_ID,
  type ConversationDetail,
  type ConversationInputResult,
  type ConversationPatch,
  type ConversationSummary,
  type HelmPluginContext,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { createHubHandler, startHub } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike, WorkflowServiceLike } from '../src/http/index.js'

// ---------------------------------------------------------------------------
// 基座
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
let token: string | undefined

class NoopEventHub implements EventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

function summary(id: number, title: string, profileId = 'assistant'): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title,
    profileId,
    tags: profileId === 'worker' ? ['worker'] : [],
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

/** 可编程会话面：记录调用参数，逐用例设置返回。 */
const state = {
  conversations: new Map<number, ConversationSummary>(),
  detail: undefined as ConversationDetail | undefined,
  detailCalls: [] as Array<{ id: number; opts?: { limit?: number; cursor?: string } }>,
  submitted: [] as Array<{ id: number; text: string; opts?: Record<string, unknown> }>,
  updateCalls: [] as Array<{ id: number; patch: ConversationPatch }>,
  waitForInputCalls: [] as Array<{ id: number; submissionId: string }>,
  waitForInputResult: undefined as ConversationInputResult | undefined,
  waitForInputError: undefined as HelmError | undefined,
  setHubUrlCalls: [] as string[],
}

function makeKernel(): KernelRuntimeLike {
  return {
    dataDir,
    auth,
    events: new NoopEventHub(),
    profiles,
    skills,
    credentials,
    providers,
    artifacts,
    plugins: pluginHost,
    stash,
    setHubUrl(url) {
      state.setHubUrlCalls.push(url)
    },
    listConversations(filter) {
      let out = [...state.conversations.values()]
      if (filter?.profileId) out = out.filter((c) => c.profileId === filter.profileId)
      if (filter?.tag) out = out.filter((c) => c.tags.includes(filter.tag!))
      if (filter?.status) out = out.filter((c) => c.status === filter.status)
      return out
    },
    getConversationDetail(id, opts) {
      state.detailCalls.push({ id, opts })
      if (!state.conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      if (state.detail === undefined) {
        throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      }
      return { ...state.detail, id }
    },
    async createConversation(init) {
      const id = Math.max(0, ...state.conversations.keys()) + 1
      const created = summary(id, init?.title ?? `会话 ${id}`, init?.profileId)
      state.conversations.set(id, created)
      return created
    },
    async updateConversation(id, patch) {
      state.updateCalls.push({ id, patch: { ...patch } })
      const found = state.conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      const next = { ...found, ...patch }
      state.conversations.set(id, next)
      return next
    },
    async deleteConversation(id) {
      state.conversations.delete(id)
    },
    async submitInput(id, text, opts) {
      state.submitted.push({ id, text, opts: opts as Record<string, unknown> | undefined })
      return { submissionId: 'sub-1' }
    },
    async waitForInput(id, submissionId) {
      state.waitForInputCalls.push({ id, submissionId })
      if (state.waitForInputError) throw state.waitForInputError
      if (state.waitForInputResult === undefined) {
        throw new HelmError('test_fixture_missing', '测试基座缺少 waitForInputResult fixture（用例需先设置 state.waitForInputResult）', 500)
      }
      return state.waitForInputResult
    },
    async abortConversation() {},
    async listAsks() {
      return []
    },
    async answerAsk() {},
    async cancelAsk() {},
    async search() {
      return []
    },
    listModels: () => [],
  }
}

const workflowRuns: WorkflowRunSummary[] = [
  // service 契约：listRuns 按创建时间倒序（新→旧）
  { id: 'wf_b', name: 'demo', conversationId: 2, status: 'running', createdAt: 300, updatedAt: 300 },
  { id: 'wf_a', name: 'demo', conversationId: 1, status: 'completed', createdAt: 200, updatedAt: 200 },
]

const workflows: WorkflowServiceLike & { waitCalls: string[] } = {
  list: () => [],
  listRuns: () => [...workflowRuns],
  run: async () => ({ id: 'wf_new', name: 'x', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }),
  getRun: async (runId) => workflowRuns.find((r) => r.id === runId),
  waitCalls: [],
  async wait(runId) {
    this.waitCalls.push(runId)
  },
  abort: async () => {},
}

function makeHandlers() {
  const kernel = makeKernel()
  return { kernel, handler: createHubHandler(kernel, workflows) }
}

async function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts?: { body?: unknown; auth?: boolean; raw?: string },
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {}
  if (opts?.body !== undefined || opts?.raw !== undefined) headers['content-type'] = 'application/json'
  if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
  const body = opts?.raw !== undefined ? opts.raw : opts?.body !== undefined ? JSON.stringify(opts.body) : undefined
  const response = await handler(new Request(`http://127.0.0.1:3202${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }))
  const text = await response.text()
  let parsed: any
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, text }
}

function detailOf(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  const base = summary(1, '个人助理')
  return {
    ...base,
    entries: [
      { id: 'e2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '回答' }] }], createdAt: 2 },
      { id: 'e1', kind: 'helm.input', data: { id: 'i1', text: '问', origin: 'human', createdAt: 1 } },
    ],
    nextCursor: '{"order":"descending","after":5}',
    ...overrides,
  }
}

function docStore() {
  const docs = new Map<string, unknown>()
  return {
    get: <T>(key: string, initial: T): T => (docs.has(key) ? (docs.get(key) as T) : initial),
    set: <T>(key: string, value: T): void => void docs.set(key, value),
  }
}

/** 真实插件：public doc + private doc + public doc 动作。 */
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
  dataDir = await mkdtemp(join(tmpdir(), 'helm-http-align-'))
  auth = new AuthService(dataDir)
  credentials = new CredentialService(dataDir)
  profiles = new ProfileService(dataDir)
  skills = new SkillService(dataDir)
  providers = new ProviderService(dataDir)
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  pluginHost = new PluginHost({
    dataDir,
    host: {
      dispatchTrigger: async () => {},
      submitInput: async () => {},
      createConversation: async () => summary(99, 'x'),
      listConversations: () => [...state.conversations.values()],
      getConversation: (id: number) => {
        const found = state.conversations.get(id)
        if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
        return found
      },
      createAsk: async () => ({}) as never,
      cancelAsk: async () => {},
      emitEvent: () => {},
    } as never,
    docs: docStore(),
  })
  await registerDocPlugin(pluginHost)
  const { handler } = makeHandlers()
  const setup = await call(handler, 'POST', '/api/auth/setup', { auth: false, body: { password: 'align-test-pw-1' } })
  token = setup.body.token
  state.conversations.set(ROOT_CONVERSATION_ID, summary(1, '个人助理'))
  state.conversations.set(2, summary(2, '工人', 'worker'))
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// GET /api/conversations/:id → ConversationDetail
// ---------------------------------------------------------------------------

test('GET /:id 返回 detail（summary 字段 + entries + nextCursor 顶层结构）', { timeout: 60_000 }, async () => {
  state.detail = detailOf()
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}`)
  assert.equal(res.status, 200)
  // 顶层 summary 字段仍直接可访问（id/title/status...），entries/nextCursor 平铺
  assert.equal(res.body.id, ROOT_CONVERSATION_ID)
  assert.equal(res.body.title, '个人助理')
  assert.equal(res.body.status, 'idle')
  assert.ok(Array.isArray(res.body.entries))
  assert.equal(res.body.entries.length, 2)
  assert.equal(res.body.entries[0].kind, 'pi.assistant')
  assert.ok(Array.isArray(res.body.entries[0].model))
  assert.equal(res.body.entries[1].kind, 'helm.input')
  assert.deepEqual(res.body.entries[1].data, { id: 'i1', text: '问', origin: 'human', createdAt: 1 })
  assert.equal(typeof res.body.nextCursor, 'string')
})

test('GET /:id?limit/cursor 透传 kernel.getConversationDetail；非法值 400', { timeout: 60_000 }, async () => {
  state.detail = detailOf()
  const { handler } = makeHandlers()
  const ok = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}?limit=10&cursor=${encodeURIComponent('{"a":1}')}`)
  assert.equal(ok.status, 200)
  const last = state.detailCalls.at(-1)!
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

test('GET /:id 会话不存在 404；多余段 404', { timeout: 60_000 }, async () => {
  state.detail = undefined
  const { handler } = makeHandlers()
  const missing = await call(handler, 'GET', '/api/conversations/999')
  assert.equal(missing.status, 404)
  const extra = await call(handler, 'GET', `/api/conversations/${ROOT_CONVERSATION_ID}/entries`)
  assert.equal(extra.status, 404)
})

test('GET /api/conversations?profileId 过滤透传（与 tag/status 可组合语义在 kernel 侧）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'GET', '/api/conversations?profileId=worker')
  assert.equal(res.status, 200)
  assert.equal(res.body.length, 1)
  assert.equal(res.body[0].profileId, 'worker')
  const none = await call(handler, 'GET', '/api/conversations?profileId=nobody')
  assert.deepEqual(none.body, [])
})

test('PATCH /:id model 覆盖与空串清覆盖边界；其他字段不受空串影响', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  // 合法 provider/model 覆盖透传
  const set = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: 'openai/gpt-4o' },
  })
  assert.equal(set.status, 200)
  assert.deepEqual(state.updateCalls.at(-1)?.patch, { model: 'openai/gpt-4o' })

  // 空串 = 清除覆盖（边界接受并透传；语义由 kernel.updateConversation 落实）
  const clear = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, {
    body: { model: '' },
  })
  assert.equal(clear.status, 200)
  assert.deepEqual(state.updateCalls.at(-1)?.patch, { model: '' })

  // 错误形状仍 400：缺 provider、含空白、多斜杠、纯空格
  for (const bad of ['gpt-4o', 'openai /gpt', 'openai/gpt/4o', 'openai/ gpt', ' ']) {
    const res = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: bad } })
    assert.equal(res.status, 400, `model=${JSON.stringify(bad)} 应 400`)
    assert.equal(res.body.error.code, 'validation_error')
  }
  // 非字符串类型拒绝
  const num = await call(handler, 'PATCH', `/api/conversations/${ROOT_CONVERSATION_ID}`, { body: { model: 42 } })
  assert.equal(num.status, 400)
})

test('POST /api/conversations（create）model 不接受空串：仍需 provider/model', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', '/api/conversations', { body: { model: '' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
  const bad = await call(handler, 'POST', '/api/conversations', { body: { model: 'gpt-4o' } })
  assert.equal(bad.status, 400)
  const ok = await call(handler, 'POST', '/api/conversations', { body: { model: 'openai/gpt-4o' } })
  assert.equal(ok.status, 201)
})

// ---------------------------------------------------------------------------
// POST /:id/input：meta 边界 + submissionId + wait=1
// ---------------------------------------------------------------------------

test('POST input 默认 202 返回 {submissionId}（不再伪 {ok:true}）', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: '你好' },
  })
  assert.equal(res.status, 202)
  assert.deepEqual(res.body, { submissionId: 'sub-1' })
  assert.deepEqual(state.submitted.at(-1)?.opts, {})
})

test('POST input meta：纯 JSON 对象透传 opts.meta；数组/标量/未知字段 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input`, {
    body: { text: 'x', meta: { source: 'cron', extra: { nested: [1, 2] } } },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(state.submitted.at(-1)?.opts, { meta: { source: 'cron', extra: { nested: [1, 2] } } })

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

test('POST input?wait=1 调用 waitForInput 并返回 ConversationInputResult；非法 wait 400', { timeout: 60_000 }, async () => {
  state.waitForInputResult = {
    conversationId: ROOT_CONVERSATION_ID,
    submissionId: 'sub-1',
    text: '你好',
    entry: { id: 'e9', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '答' }] }] },
  }
  const { handler } = makeHandlers()
  const res = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=1`, {
    body: { text: '你好' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.submissionId, 'sub-1')
  assert.equal(res.body.conversationId, ROOT_CONVERSATION_ID)
  assert.equal(res.body.entry.kind, 'pi.assistant')
  assert.deepEqual(state.waitForInputCalls.at(-1), { id: ROOT_CONVERSATION_ID, submissionId: 'sub-1' })

  const bad = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=yes`, {
    body: { text: 'x' },
  })
  assert.equal(bad.status, 400)

  // wait 中 kernel 抛 HelmError（aborted 等）→ 错误信封如实透传
  state.waitForInputError = new HelmError('input_unanswered', '输入未获回答（aborted）', 409, { reason: 'aborted' })
  const failed = await call(handler, 'POST', `/api/conversations/${ROOT_CONVERSATION_ID}/input?wait=1`, {
    body: { text: 'x' },
  })
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error.code, 'input_unanswered')
  state.waitForInputError = undefined
})

// ---------------------------------------------------------------------------
// GET /api/workflows/runs
// ---------------------------------------------------------------------------

test('GET /api/workflows/runs 返回 listRuns（新→旧）；?conversationId 过滤；非法 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const all = await call(handler, 'GET', '/api/workflows/runs')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.map((r: any) => r.id), ['wf_b', 'wf_a']) // createdAt 倒序
  const filtered = await call(handler, 'GET', '/api/workflows/runs?conversationId=2')
  assert.deepEqual(filtered.body.map((r: any) => r.id), ['wf_b'])
  const bad = await call(handler, 'GET', '/api/workflows/runs?conversationId=abc')
  assert.equal(bad.status, 400)
  // 旧路径不受影响：inspect / abort / run
  const inspect = await call(handler, 'GET', '/api/workflows/runs/wf_a')
  assert.equal(inspect.status, 200)
  const run = await call(handler, 'POST', '/api/workflows/run', { body: { name: 'demo' } })
  assert.equal(run.status, 202)
  assert.equal(run.body.id, 'wf_new')
  const abort = await call(handler, 'POST', '/api/workflows/runs/wf_a/abort')
  assert.equal(abort.status, 200)
})

test('POST /api/workflows/run?wait=1 等待终态返回 200 summary；failed/aborted 错误信封', { timeout: 60_000 }, async () => {
  // run 返回 running summary；wait 后 getRun 返回 completed
  const wfOk: WorkflowServiceLike = {
    list: () => [],
    listRuns: () => [],
    run: async () => ({ id: 'wf_w', name: 'x', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }),
    getRun: async (id) => ({ id, name: 'x', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2, result: { ok: true } }),
    wait: async () => {},
    abort: async () => {},
  }
  const kernel = makeKernel()
  const handler = createHubHandler(kernel, wfOk)
  const ok = await call(handler, 'POST', '/api/workflows/run?wait=1', { body: { name: 'demo' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.status, 'completed')
  assert.deepEqual(ok.body.result, { ok: true })

  const wfFail: WorkflowServiceLike = {
    list: () => [],
    listRuns: () => [],
    run: async () => ({ id: 'wf_f', name: 'x', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }),
    getRun: async (id) => ({ id, name: 'x', conversationId: 1, status: 'failed', createdAt: 1, updatedAt: 2, error: 'boom' }),
    wait: async () => {},
    abort: async () => {},
  }
  const failHandler = createHubHandler(makeKernel(), wfFail)
  const failed = await call(failHandler, 'POST', '/api/workflows/run?wait=1', { body: { name: 'demo' } })
  assert.equal(failed.status, 500)
  assert.equal(failed.body.error.code, 'workflow_failed')
  assert.equal(failed.body.error.details.status, 'failed')
})

// ---------------------------------------------------------------------------
// GET /api/plugins/:id/docs/:name（真实 PluginHost）
// ---------------------------------------------------------------------------

test('GET /api/plugins/:id/docs/:name 返回 {pluginId,name,value}；私有/未声明/停用/未知 404', { timeout: 60_000 }, async () => {
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

  // 鉴权不能绕过：无 token 401
  const noAuth = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board', { auth: false })
  assert.equal(noAuth.status, 401)

  // 非法 doc name（以点开头）400；合法形状但未声明 404；多余段 404
  const badName = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/.hidden')
  assert.equal(badName.status, 400)
  const extra = await call(handler, 'GET', '/api/plugins/builtin:statusboard/docs/board/extra')
  assert.equal(extra.status, 404)
})

// ---------------------------------------------------------------------------
// Profile runtime 扩展字段（machine/workspace/env 严校验）
// ---------------------------------------------------------------------------

test('profiles runtime machine/workspace/env：合法保存回读；非法形状 400', { timeout: 60_000 }, async () => {
  const { handler } = makeHandlers()
  const ok = await call(handler, 'POST', '/api/profiles', {
    body: {
      id: 'ops-runner',
      name: '运维',
      runtime: {
        kind: 'herdr',
        agent: 'pi',
        machine: 'ops-box',
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
    machine: 'ops-box',
    workspace: '/srv/ops',
    env: { HELM_ENV_ROLE: 'worker', LANG: 'C' },
  })

  const cases: Array<{ runtime: unknown; why: string }> = [
    { runtime: { kind: 'herdr', agent: 'pi', machine: '' }, why: 'machine 空串' },
    { runtime: { kind: 'herdr', agent: 'pi', workspace: '' }, why: 'workspace 空串' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { K: 1 } }, why: 'env 值非字符串' },
    { runtime: { kind: 'herdr', agent: 'pi', env: { '': 'v' } }, why: 'env 键空串' },
    { runtime: { kind: 'herdr', agent: 'pi', env: ['a'] }, why: 'env 数组' },
    { runtime: { kind: 'herdr', agent: 'pi', bogus: 1 }, why: 'runtime 未知键' },
    { runtime: { kind: 'herdr', agent: 'pi', machine: 42 }, why: 'machine 非字符串' },
  ]
  for (const c of cases) {
    const res = await call(handler, 'POST', '/api/profiles', { body: { id: 'bad-profile', runtime: c.runtime } })
    assert.equal(res.status, 400, `${c.why} 应 400`)
    assert.equal(res.body.error.code, 'validation_error', c.why)
  }
})

// ---------------------------------------------------------------------------
// startHub：setHubUrl 回写真实 URL
// ---------------------------------------------------------------------------

test('startHub(port:0) 监听后 kernel.setHubUrl 收到真实 URL', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  state.setHubUrlCalls = []
  const handle = await startHub({ kernel, workflows, port: 0 })
  try {
    assert.equal(state.setHubUrlCalls.length, 1)
    assert.equal(state.setHubUrlCalls[0], handle.url)
    // 真实往返仍通
    const res = await fetch(`${handle.url}/api/conversations`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
  } finally {
    await handle.close()
  }
  // 不提供 setHubUrl 的 kernel 也不报错
  const bare = makeKernel()
  delete (bare as { setHubUrl?: unknown }).setHubUrl
  const handle2 = await startHub({ kernel: bare, workflows, port: 0 })
  await handle2.close()
})
