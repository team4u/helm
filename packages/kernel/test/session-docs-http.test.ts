/**
 * HTTP 层会话文档契约测试：GET /api/plugins/:id/docs/:name?conversationId=N、
 * 专用 SSE（/events?conversationId=N）、404 停止语义、鉴权与全局流隔离。
 * 真实 PluginHost + 真实 SessionDocEventHub + 真实路由层。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type HelmEventFrame,
  type PluginSessionDocHandle,
  type PublicPluginSessionDoc,
} from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { SessionDocEventHub } from '../src/runtime/events.js'
import { AuthService } from '../src/services/index.js'
import { createHubHandler, startHub, type KernelRuntimeLike, type SessionDocEventPort } from '../src/http/index.js'

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

let dataDir: string
let pluginHost: PluginHost
let sessionDocHub: SessionDocEventHub
let handler: ReturnType<typeof createHubHandler>
let hubUrl: string
let closeHub: (() => Promise<void>) | undefined
let token: string
const existing = new Set<number>([1, 2])
let metricsHandle: PluginSessionDocHandle<{ n: number }> | undefined
let globalFrames: HelmEventFrame[] = []

const backend: PluginHostBackend = {
  ...createPluginHostBackendFixture(),
  dispatchTrigger: async () => {},
  submitInput: async () => {},
  createConversation: async () => makeConversation(42),
  listConversations: () => [...existing].map(makeConversation),
  getConversation: (id) => {
    if (!existing.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return makeConversation(id)
  },
  updateConversation: async (id) => makeConversation(id),
  manageConversation: () => () => {},
  markConversationOwnership: () => {},
  createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
  cancelAsk: async () => {},
  registerAskSeqResolver: () => () => {},
  onEvent: () => () => {},
  abortConversation: async () => {},
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
  },
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human'
  },
  spawnAgent: async () => ({}),
  runGate: async () => ({ ok: true, output: '' }),
  prepareInterruptedConversations: async () => {},
  invokeAction: async () => ({}),
  prepareAction: () => ({ idempotent: false }),
  execEnv: async () => {
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  },
  listActions: () => [],
  emitEvent: (type, payload) => {
    if (type === 'plugin.session_doc.updated') {
      sessionDocHub.dispatch(payload)
      return
    }
    globalFrames.push({ seq: 0, event: { type, ...(payload as object) } as never })
  },
}

const memorySessionStore = new Map<string, string>()

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-http-sd-'))
  sessionDocHub = new SessionDocEventHub()
  globalFrames = []
  metricsHandle = undefined
  memorySessionStore.clear()
  const auth = new AuthService(dataDir)
  const setup = await auth.setup('test-password-123')
  token = setup.token
  pluginHost = new PluginHost({
    dataDir,
    host: backend,
    docs: {
      get: <T>(key: string, initial: T) => initial,
      set: () => {},
      flush: async () => {},
    },
    sessionDocs: {
      get: (p, n, c) => memorySessionStore.get(`${p}\0${n}\0${c}`),
      put: (p, n, c, v) => memorySessionStore.set(`${p}\0${n}\0${c}`, v),
      delete: (p, n, c) => memorySessionStore.delete(`${p}\0${n}\0${c}`),
      listConversationIds: (p, n) => [...memorySessionStore.keys()].filter((k) => k.startsWith(`${p}\0${n}\0`)).map((k) => Number(k.split('\0')[2])),
      flush: async () => {},
    },
  })
  await pluginHost.register({
    id: 'p:sd',
    definePlugin: (ctx) => {
      metricsHandle = ctx.sessionDoc('metrics', { n: 0 }, { public: true })
      ctx.sessionDoc('priv', { n: 0 })
      ctx.doc('global', { g: 1 }, { public: true })
    },
  })
  const sessionDocEvents: SessionDocEventPort = sessionDocHub
  const kernel: KernelRuntimeLike = {
    dataDir,
    auth,
    events: { response: () => new Response('') },
    sessionDocEvents,
    profiles: new Proxy({}, { get: () => async () => [] }) as never,
    skills: new Proxy({}, { get: () => async () => [] }) as never,
    credentials: new Proxy({}, { get: () => async () => [] }) as never,
    providers: new Proxy({}, { get: () => async () => [] }) as never,
    artifacts: new Proxy({}, { get: () => { throw new HelmError('not_found', 'x', 404) } }) as never,
    plugins: pluginHost,
    listConversations: async () => [...existing].map(makeConversation),
    getConversationDetail: async (id) => {
      if (!existing.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return { ...makeConversation(id), entries: [] } as never
    },
    createConversation: async () => makeConversation(3),
    updateConversation: async (id) => makeConversation(id),
    deleteConversation: async () => {},
    submitInput: async () => ({ submissionId: 's' }),
    waitForInput: async (id) => ({ conversationId: id, submissionId: 's', text: '', entry: { id: 'e', kind: 'user' } }) as never,
    abortConversation: async () => {},
    resetConversation: async (id) => makeConversation(id),
    compactConversation: async (id) => ({ taskId: 1, conversation: makeConversation(id) }) as never,
    forkConversation: async (id) => makeConversation(id + 100),
    listAsks: async () => [],
    answerAsk: async () => {},
    cancelAsk: async () => {},
    search: async () => [],
    listModels: async () => ({ models: [], thinkingLevels: {} }),
    listModelProviders: async () => [],
    listNodes: async () => [],
    issueNodeToken: async () => ({ nodeId: 'local', token: 't', createdAt: 0 }),
    removeNode: async () => {},
    execEnv: async () => {
      throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
    },
  }
  const handle = await startHub({ kernel, port: 0 })
  hubUrl = handle.url
  closeHub = () => handle.close()
})

afterEach(async () => {
  await closeHub?.()
  rmSync(dataDir, { recursive: true, force: true })
})

function authInit(): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } }
}

test('GET docs?conversationId 读取会话文档；私有/不存在/停用 404；全局文档名 400', { timeout: 60_000 }, async () => {
  metricsHandle!.set(1, { n: 5 })
  const ok = await fetch(
    `${hubUrl}/api/plugins/p%3Asd/docs/metrics?conversationId=1`,
    authInit(),
  )
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as PublicPluginSessionDoc
  assert.deepEqual(body, { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 5 } })

  const priv = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/priv?conversationId=1`, authInit())
  assert.equal(priv.status, 404)
  const missing = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/nope?conversationId=1`, authInit())
  assert.equal(missing.status, 404)
  const convMissing = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics?conversationId=999`, authInit())
  assert.equal(convMissing.status, 404)
  const globalDoc = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/global?conversationId=1`, authInit())
  assert.equal(globalDoc.status, 400)
  // sessionDoc 名不带 conversationId：400 session_doc_requires_conversation
  const noConv = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics`, authInit())
  assert.equal(noConv.status, 400)
  // 非法 conversationId
  const badConv = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics?conversationId=abc`, authInit())
  assert.equal(badConv.status, 400)
})

test('专用 SSE：首帧 snapshot + 增量；鉴权失败 401；事件不进全局流', { timeout: 60_000 }, async () => {
  metricsHandle!.set(1, { n: 1 })
  const controller = new AbortController()
  const res = await fetch(
    `${hubUrl}/api/plugins/p%3Asd/docs/metrics/events?conversationId=1`,
    { ...authInit(), signal: controller.signal, headers: { ...authInit().headers, accept: 'text/event-stream' } },
  )
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type')!, /text\/event-stream/)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  async function readFrame(): Promise<string> {
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      assert.ok(!done, '流意外结束')
      out += decoder.decode(value, { stream: true })
      if (out.includes('\n\n')) return out
    }
  }
  const snap = await readFrame()
  assert.match(snap, /event: snapshot/)
  assert.match(snap, /"n":1/)
  metricsHandle!.set(1, { n: 2 })
  const update = await readFrame()
  assert.match(update, /event: plugin\.session_doc\.updated/)
  assert.match(update, /"n":2/)
  // 全局流零帧（emitEvent 分流验证）
  assert.equal(globalFrames.filter((f) => (f.event as { type: string }).type === 'plugin.session_doc.updated').length, 0)
  controller.abort()

  // 鉴权失败：401（显式错误，不建流）
  const unauth = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics/events?conversationId=1`, {
    headers: { accept: 'text/event-stream' },
  })
  assert.equal(unauth.status, 401)
  await unauth.arrayBuffer()
})

test('专用 SSE：插件停用/会话删除返回 404（客户端停止重试依据）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('p:sd')
  const res = await fetch(
    `${hubUrl}/api/plugins/p%3Asd/docs/metrics/events?conversationId=1`,
    { ...authInit(), headers: { ...authInit().headers, accept: 'text/event-stream' } },
  )
  assert.equal(res.status, 404)
  const err = (await res.json()) as { error: { code: string } }
  assert.equal(err.error.code, 'plugin_doc_not_found')
})
