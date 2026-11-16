/**
 * HTTP layer conversation document contract test:GET /api/plugins/:id/docs/:name?conversationId=N,
 * dedicated use SSE(/events?conversationId=N),404 stop semantics, authentication and global stream isolated.
 * real PluginHost + real SessionDocEventHub + real routing layer.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HelmError,
  type HelmEventFrame,
  type PluginSessionDocHandle,
  type PublicPluginSessionDoc,
} from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { SessionDocEventHub } from '../src/runtime/events.js'
import { AuthService } from '../src/services/index.js'
import { createHubHandler, startHub, type KernelRuntimeLike, type SessionDocEventPort } from '../src/http/index.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js'

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' })
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
    if (!existing.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
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
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human'
  },
  spawnAgent: async () => ({}),
  runGate: async () => ({ ok: true, output: '' }),
  execEnv: async () => {
    throw new HelmError('unsupported', 'this fixture do not execute node command', 501)
  },
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
  dataDir = await makeTempDir('helm-http-sd-')
  sessionDocHub = new SessionDocEventHub()
  globalFrames = []
  metricsHandle = undefined
  memorySessionStore.clear()
  const auth = new AuthService(dataDir)
  const setup = await auth.setup('test-password-123')
  token = setup.token
  pluginHost = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    sessionDocs: {
      get: (p, n, c) => memorySessionStore.get(`${p}\0${n}\0${c}`),
      put: (p, n, c, v) => memorySessionStore.set(`${p}\0${n}\0${c}`, v),
      delete: (p, n, c) => memorySessionStore.delete(`${p}\0${n}\0${c}`),
      deletePlugin: (p) => {
        const prefix = `${p}\0`
        for (const k of [...memorySessionStore.keys()]) {
          if (k.startsWith(prefix)) memorySessionStore.delete(k)
        }
      },
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
      if (!existing.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return { ...makeConversation(id), entries: [] } as never
    },
    getConversationEntry: async (id, entryId) => {
      if (!existing.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404)
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
      throw new HelmError('unsupported', 'this fixture do not execute node command', 501)
    },
  }
  const handle = await startHub({ kernel, port: 0 })
  hubUrl = handle.url
  closeHub = () => handle.close()
})

afterEach(async () => {
  await closeHub?.()
  await cleanupDir(dataDir)
})

function authInit(): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } }
}

test('GET docs?conversationId read conversation document; private/missing/deactivate 404; global document name 400', { timeout: 60_000 }, async () => {
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
  // sessionDoc name do not carries conversationId:400 session_doc_requires_conversation
  const noConv = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics`, authInit())
  assert.equal(noConv.status, 400)
  // illegal conversationId
  const badConv = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics?conversationId=abc`, authInit())
  assert.equal(badConv.status, 400)
})

test('dedicated use SSE: first frame snapshot + incremental; authentication failed 401; event does not enter global stream', { timeout: 60_000 }, async () => {
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
      assert.ok(!done, 'stream unexpected end')
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
  // global stream zero frame (emitEvent stream verify)
  assert.equal(globalFrames.filter((f) => (f.event as { type: string }).type === 'plugin.session_doc.updated').length, 0)
  controller.abort()

  // authentication failed:401(explicit error, do not create stream)
  const unauth = await fetch(`${hubUrl}/api/plugins/p%3Asd/docs/metrics/events?conversationId=1`, {
    headers: { accept: 'text/event-stream' },
  })
  assert.equal(unauth.status, 401)
  await unauth.arrayBuffer()
})

test('dedicated use SSE: plugin deactivate/conversation delete return 404(client stop retry based on)', { timeout: 60_000 }, async () => {
  await pluginHost.disable('p:sd')
  const res = await fetch(
    `${hubUrl}/api/plugins/p%3Asd/docs/metrics/events?conversationId=1`,
    { ...authInit(), headers: { ...authInit().headers, accept: 'text/event-stream' } },
  )
  assert.equal(res.status, 404)
  const err = (await res.json()) as { error: { code: string } }
  assert.equal(err.error.code, 'plugin_doc_not_found')
})
