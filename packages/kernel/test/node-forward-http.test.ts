/**
 * node port forwarding HTTP routing test:handleApi directly drive (without real daemon- -
 * forwarding service real byte link see node-forward.test.ts).
 * override:POST validate (missing field/broken port/broken host/unknown field), create succeeded,
 * GET manifest/detail situation (404),DELETE stop (idempotent 404),events NDJSON.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleApi } from '../src/http/routes.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'
import type { NodeForwardEvent, NodeForwardSession } from '../src/env/forward.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeKernel(over: {
  sessions: Map<string, NodeForwardSession>
  events: ((event: NodeForwardEvent) => void)[]
  /** lease record (optional inject:acquire/release counter and finally release call back). */
  lease?: { acquisitions: number; releases: number; onLastRelease?: () => void }
}): KernelRuntimeLike {
  return {
    listNodes() { return [] },
    async issueNodeToken() { throw new Error('unused') },
    async removeNode() { throw new Error('unused') },
    async execEnv() { throw new Error('unused') },
    dataDir: '/tmp/helm-forward-http-test',
    auth: { status: async () => ({ configured: false }), verifyToken: async () => false, setup: async () => ({ token: 'x' }), login: async () => ({ token: 'x' }) } as never,
    async startNodeForward(nodeId: string, input: { listenHost: string; listenPort: number; targetHost?: string; targetPort: number }) {
      const forwardId = 'fwd-11111111-2222-3333-4444-555555555555'
      const session: NodeForwardSession = {
        forwardId,
        nodeId,
        listenHost: input.listenHost,
        listenPort: input.listenPort,
        targetHost: input.targetHost ?? '127.0.0.1',
        targetPort: input.targetPort,
        activeConnections: 0,
        totalConnections: 0,
      }
      over.sessions.set(forwardId, session)
      return session
    },
    async stopNodeForward(forwardId: string) { over.sessions.delete(forwardId) },
    getNodeForward: (forwardId: string) => over.sessions.get(forwardId),
    listNodeForwards: () => [...over.sessions.values()],
    onNodeForwardEvent: (forwardId: string, listener: (event: NodeForwardEvent) => void) => {
      over.events.push(listener)
      return () => undefined
    },
    ...(over.lease !== undefined
      ? {
          acquireNodeForwardLease: (forwardId: string) => {
            over.lease!.acquisitions += 1
            return () => {
              over.lease!.releases += 1
              // simplify simulated: first holder release i.e. treated as finally holder (single holder test).
              over.lease!.onLastRelease?.()
            }
          },
        }
      : {}),
  } as unknown as KernelRuntimeLike
}

const post = async (kernel: KernelRuntimeLike, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
  try {
    const response = await handleApi(new Request(`http://hub${path}`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }), kernel)
    return { status: response.status, json: await response.json().catch(() => undefined) }
  } catch (error) {
    // ValidationError(HelmError sub- class) directly throw (produce by hub.ts unify mapping 400).
    if (error instanceof Error && 'status' in error) {
      return { status: (error as { status: number }).status, json: undefined }
    }
    throw error
  }
}

test('POST /api/nodes/:id/forward: validate and create', { timeout: 60_000 }, async () => {
  const kernel = makeKernel({ sessions: new Map(), events: [] })
  // legal create.
  const ok = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
  assert.equal(ok.status, 201)
  // missing field.
  for (const bad of [
    {},
    { listenHost: '127.0.0.1', listenPort: 18080 },
    { listenPort: 18080, targetPort: 80 },
    { listenHost: '', listenPort: 18080, targetPort: 80 },
    { listenHost: '127.0.0.1', listenPort: 0, targetPort: 80 },
    { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 70000 },
    { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 80, targetHost: 'bad host' },
    { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 80, extra: true },
  ]) {
    const kernel2 = makeKernel({ sessions: new Map(), events: [] })
    const result = await post(kernel2, '/api/nodes/node-b/forward', bad)
    assert.equal(result.status, 400, `should 400 reject ${JSON.stringify(bad)}`)
  }
})

test('GET manifest/detail situation and DELETE stop (contains 404)', { timeout: 60_000 }, async () => {
  const kernel = makeKernel({ sessions: new Map(), events: [] })
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)
  const list = await handleApi(new Request('http://hub/api/nodes/forward'), kernel)
  assert.equal(list.status, 200)
  const listJson = await list.json() as NodeForwardSession[]
  assert.equal(listJson.length, 1)
  const detail = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555'), kernel)
  assert.equal(detail.status, 200)
  const stopped = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555', { method: 'DELETE' }), kernel)
  assert.equal(stopped.status, 200)
  const gone = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555'), kernel)
  assert.equal(gone.status, 404)
  const delAgain = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555', { method: 'DELETE' }), kernel)
  assert.equal(delAgain.status, 404)
  // illegal forwardId form:ValidationError direct throw (hub.ts mapping 400).
  await assert.rejects(
    handleApi(new Request('http://hub/api/nodes/forward/not-a-uuid'), kernel),
    (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400,
  )
})

test('GET events:NDJSON first frame started, disconnect close stream', { timeout: 60_000 }, async () => {
  const kernel = makeKernel({ sessions: new Map(), events: [] })
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)
  const controller = new AbortController()
  const eventsResponse = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller.signal,
  }), kernel)
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  // streaming read first frame (stream keep open start - - monitor lifecycle by client control; read completely first frame i.e. cancel).
  assert.ok(eventsResponse.body !== null)
  const reader = eventsResponse.body.getReader()
  const { value } = await reader.read()
  const first = JSON.parse(new TextDecoder().decode(value).trim()) as { type?: string }
  assert.equal(first.type, 'started')
  controller.abort()
  await reader.cancel().catch(() => undefined)
  // unknown forwardId  events:404.
  const kernel2 = makeKernel({ sessions: new Map(), events: [] })
  const missing = await handleApi(new Request('http://hub/api/nodes/forward/fwd-99999999-2222-3333-4444-555555555555/events'), kernel2)
  assert.equal(missing.status, 404)
})

test('GET events:stop terminal state stopped frame after stream normal end (monitor do not pending)', { timeout: 60_000 }, async () => {
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[] }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)
  // subscribe terminate notify (simulated runtime  onNodeForwardStopped connect line).
  const stopWaiters = new Set<() => void>()
  ;(kernel as { onNodeForwardStopped?: unknown }).onNodeForwardStopped = (_id: string, listener: () => void) => {
    stopWaiters.add(listener)
    return () => stopWaiters.delete(listener)
  }
  const controller = new AbortController()
  const response = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller.signal,
  }), kernel)
  assert.equal(response.status, 200)
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  const readFirst = await reader.read()
  const first = JSON.parse(new TextDecoder().decode(readFirst.value).trim()) as { type?: string }
  assert.equal(first.type, 'started')
  // simulated stop: first via event channel terminal state stopped frame (makeKernel register listener),
  // again trigger terminate notify - - stream should normal close(done=true), do not pending.
  for (const listener of [...over.events]) listener({ type: 'stopped' })
  for (const waiter of [...stopWaiters]) waiter()
  const drained = await new Promise<boolean>((resolve) => {
    void (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) { resolve(true); return }
      }
    })().catch(() => resolve(false))
    setTimeout(() => resolve(false), 5_000)
  })
  assert.equal(drained, true, 'terminate notify after event stream should normal end (done)')
})

test('GET events: event stream i.e. holder - - establish acquire, disconnect/cancel release(without leaking lease)', { timeout: 60_000 }, async () => {
  const lease = { acquisitions: 0, releases: 0, onLastRelease: undefined as (() => void) | undefined }
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[], lease }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)

  // 1) abort disconnect:acquire once,release once.
  const controller = new AbortController()
  const response = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller.signal,
  }), kernel)
  assert.equal(response.status, 200)
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  await reader.read() // started first frame
  await delay(30)
  assert.equal(lease.acquisitions, 1, 'event stream establish i.e. acquire lease')
  assert.equal(lease.releases, 0, 'hold has during not release')
  controller.abort()
  await delay(30)
  assert.equal(lease.releases, 1, 'after disconnect release lease (finally one holder trigger stop call back chain)')

  // 2) cancel(body.cancel) disconnect: same release.
  const lease2 = { acquisitions: 0, releases: 0, onLastRelease: undefined as (() => void) | undefined }
  const over2 = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[], lease: lease2 }
  const kernel2 = makeKernel(over2)
  const created2 = await post(kernel2, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created2.status, 201)
  const controller2 = new AbortController()
  const response2 = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller2.signal,
  }), kernel2)
  assert.ok(response2.body !== null)
  const reader2 = response2.body.getReader()
  await reader2.read()
  await reader2.cancel()
  await delay(30)
  assert.equal(lease2.acquisitions, 1)
  assert.equal(lease2.releases, 1, 'client actively cancel same release lease')
})
