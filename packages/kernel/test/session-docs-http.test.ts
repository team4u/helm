/**
 * HTTP layer conversation document contract test:GET /api/plugins/:id/docs/:name?conversationId=N,
 * dedicated use SSE(/events?conversationId=N),404 stop semantics, authentication and global stream isolated.
 * real PluginHost + real SessionDocEventHub + real routing layer.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HelmError,
  encodeSessionDocSubParam,
  type HelmEventFrame,
  type PluginSessionDocHandle,
  type PublicPluginSessionDoc,
  type SessionDocMultiplexFrame,
} from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { SessionDocEventHub } from '../src/runtime/events.js'
import { AuthService } from '../src/services/index.js'
import { createHubHandler, startHub, type KernelRuntimeLike, type SessionDocEventPort } from '../src/http/index.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir, waitFor } from './helpers.js'

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' })
}

let dataDir: string
let pluginHost: PluginHost
let sessionDocHub: SessionDocEventHub
let testKernel: KernelRuntimeLike
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
  testKernel = kernel
  const handle = await startHub({ kernel, port: 0 })
  hubUrl = handle.url
  closeHub = () => handle.close()
})

afterEach(async () => {
  sessionDocHub?.close()
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

// ---------------------------------------------------------------------------
// GET /api/session-docs/events: multiplexed SessionDoc SSE endpoint
// ---------------------------------------------------------------------------

function parseMultiplexBlocks(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '' || block.trimStart().startsWith(':')) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data += line.slice('data: '.length)
    }
    frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
  }
  return frames
}

test('GET /api/session-docs/events enforces auth, strict ?sub= 400 validation, doc/plugin 404/400, routing parity, and 501 port checks', { timeout: 60_000 }, async () => {
  // 1. Unauthenticated -> 401
  const unauth = await fetch(`${hubUrl}/api/session-docs/events?sub=p%3Asd/metrics/1`, {
    headers: { accept: 'text/event-stream' },
  })
  assert.equal(unauth.status, 401)
  await unauth.arrayBuffer()

  // 2. Empty / malformed / duplicate / over-limit (?sub= > 64) -> 400 validation_error
  const badSubQueries = [
    '',
    '?sub=',
    '?sub=only-one-part',
    '?sub=a/b',
    '?sub=a/b/1/extra',
    '?sub=a/b/0',
    '?sub=a/b/-1',
    '?sub=a/b/abc',
    '?sub=p%3Asd/metrics/1&sub=p%3Asd/metrics/1',
  ]
  for (const qs of badSubQueries) {
    const res = await fetch(`${hubUrl}/api/session-docs/events${qs}`, authInit())
    assert.equal(res.status, 400, `expected 400 for query ${qs}`)
    const err = (await res.json()) as { error: { code: string } }
    assert.equal(err.error.code, 'validation_error')
  }
  const overLimit = Array.from({ length: 65 }, (_, i) => `sub=p%3Asd/metrics/${i + 1}`).join('&')
  const overRes = await fetch(`${hubUrl}/api/session-docs/events?${overLimit}`, authInit())
  assert.equal(overRes.status, 400)
  assert.equal(((await overRes.json()) as { error: { code: string } }).error.code, 'validation_error')

  // 3. Domain errors: private/missing/disabled plugin doc -> 404; missing conv -> 404; global doc -> 400; zero leaked subscribers.
  const priv = await fetch(`${hubUrl}/api/session-docs/events?sub=p%3Asd/priv/1`, authInit())
  assert.equal(priv.status, 404)
  assert.equal(((await priv.json()) as { error: { code: string } }).error.code, 'plugin_doc_not_found')

  const missingConv = await fetch(`${hubUrl}/api/session-docs/events?sub=p%3Asd/metrics/1&sub=p%3Asd/metrics/999`, authInit())
  assert.equal(missingConv.status, 404)
  assert.equal(((await missingConv.json()) as { error: { code: string } }).error.code, 'not_found')

  const globalDoc = await fetch(`${hubUrl}/api/session-docs/events?sub=p%3Asd/global/1`, authInit())
  assert.equal(globalDoc.status, 400)
  assert.equal(((await globalDoc.json()) as { error: { code: string } }).error.code, 'global_doc_unexpected_conversation')
  assert.equal(sessionDocHub.subscriberCount, 0)

  // 4. Extra path segment / wrong HTTP method -> 404 not_found
  const extraSeg = await fetch(`${hubUrl}/api/session-docs/events/extra?sub=p%3Asd/metrics/1`, authInit())
  assert.equal(extraSeg.status, 404)
  const wrongMethod = await fetch(`${hubUrl}/api/session-docs/events?sub=p%3Asd/metrics/1`, {
    ...authInit(),
    method: 'POST',
  })
  assert.equal(wrongMethod.status, 404)

  // 5. Missing sessionDocEvents port -> 501 not_implemented
  const noPortHandler = createHubHandler({ ...testKernel, sessionDocEvents: undefined })
  const noPortRes = await noPortHandler(
    new Request('http://localhost/api/session-docs/events?sub=p%3Asd/metrics/1', {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(noPortRes.status, 501)
  assert.equal(((await noPortRes.json()) as { error: { code: string } }).error.code, 'not_implemented')
})

test('GET /api/session-docs/events multiplexes snapshots, incremental updates/deletes across plugins, and closes on abort or disable', { timeout: 60_000 }, async () => {
  let runsHandle: PluginSessionDocHandle<{ status: string }> | undefined
  await pluginHost.register({
    id: 'p:wf',
    definePlugin: (ctx) => {
      runsHandle = ctx.sessionDoc('runs', { status: 'idle' }, { public: true })
    },
  })
  metricsHandle!.set(1, { n: 10 })
  runsHandle!.set(1, { status: 'running' })

  const qs = [
    encodeSessionDocSubParam({ pluginId: 'p:sd', name: 'metrics', conversationId: 1 }),
    encodeSessionDocSubParam({ pluginId: 'p:wf', name: 'runs', conversationId: 1 }),
  ]
    .map((s) => `sub=${encodeURIComponent(s)}`)
    .join('&')

  const ctrl = new AbortController()
  const res = await fetch(`${hubUrl}/api/session-docs/events?${qs}`, {
    ...authInit(),
    signal: ctrl.signal,
    headers: { ...authInit().headers, accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(sessionDocHub.subscriberCount, 2)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames: SessionDocMultiplexFrame[] = []
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parsed = parseMultiplexBlocks(buf)
      frames.length = 0
      for (const f of parsed) {
        if (f.event === 'session_doc' && f.data !== null) frames.push(f.data as SessionDocMultiplexFrame)
      }
    }
  })()

  try {
    await waitFor(() => frames.length >= 2)
    assert.deepEqual(
      frames.slice(0, 2).map((f) => ({
        action: f.action,
        pluginId: f.pluginId,
        name: f.name,
        conversationId: f.conversationId,
        value: f.doc.value,
      })),
      [
        { action: 'snapshot', pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 10 } },
        { action: 'snapshot', pluginId: 'p:wf', name: 'runs', conversationId: 1, value: { status: 'running' } },
      ],
    )

    // Unsubscribed conversation 2 update must NOT leak onto this multiplexed stream.
    metricsHandle!.set(2, { n: 999 })
    metricsHandle!.set(1, { n: 11 })
    runsHandle!.delete(1)
    await waitFor(() => frames.length >= 4)

    assert.equal(frames.length, 4, 'unsubscribed conversationId=2 must be isolated')
    assert.deepEqual(
      frames.slice(2).map((f) => ({
        action: f.action,
        pluginId: f.pluginId,
        name: f.name,
        conversationId: f.conversationId,
        value: f.doc.value,
        deleted: f.doc.deleted,
      })),
      [
        { action: 'updated', pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 11 }, deleted: undefined },
        { action: 'deleted', pluginId: 'p:wf', name: 'runs', conversationId: 1, value: { status: 'idle' }, deleted: true },
      ],
    )
    assert.equal(
      globalFrames.filter((f) => (f.event as { type: string }).type === 'plugin.session_doc.updated').length,
      0,
      'session doc events must never leak into global event stream',
    )

    // Disabling one subscribed plugin triggers closeForPlugin -> terminates multiplexed stream cleanly.
    sessionDocHub.closeForPlugin('p:wf')
    await reading
    assert.equal(sessionDocHub.subscriberCount, 0)
  } finally {
    ctrl.abort()
    await reader.cancel().catch(() => {})
    await reading.catch(() => {})
  }
})
