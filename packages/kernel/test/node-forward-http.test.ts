/**
 * HTTP routing tests for node port forwarding: drives `handleApi` directly without a real daemon
 * (see `node-forward.test.ts` for real end-to-end byte forwarding).
 * Covers: POST validation (missing fields / bad port / bad host / unknown fields), creation success,
 * GET list/detail (including 404), DELETE stop (idempotent 404), and events NDJSON.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTimeout } from '@helm/test-kit'
import { handleApi } from '../src/http/routes.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'
import type { NodeForwardEvent, NodeForwardSession } from '../src/env/forward.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeKernel(over: {
  sessions: Map<string, NodeForwardSession>
  events: ((event: NodeForwardEvent) => void)[]
  /** Lease telemetry (optional injection: acquire/release counters and last-release callback). */
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
              // Simplified stub: first holder releasing is treated as the last holder (single-holder test).
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
    // ValidationError (HelmError subclass) is thrown directly (mapped to 400 uniformly by hub.ts).
    if (error instanceof Error && 'status' in error) {
      return { status: (error as { status: number }).status, json: undefined }
    }
    throw error
  }
}

test('POST /api/nodes/:id/forward validates and creates session', { timeout: 60_000 }, async () => {
  const kernel = makeKernel({ sessions: new Map(), events: [] })
  // Valid creation.
  const ok = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
  assert.equal(ok.status, 201)
  // Missing / invalid fields.
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
    assert.equal(result.status, 400, `should reject 400 for ${JSON.stringify(bad)}`)
  }
})

test('GET list/detail and DELETE stop (including 404 cases)', { timeout: 60_000 }, async () => {
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
  // Invalid forwardId format: throws ValidationError directly (mapped to 400 by hub.ts).
  await assert.rejects(
    handleApi(new Request('http://hub/api/nodes/forward/not-a-uuid'), kernel),
    (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400,
  )
})

test('GET events emits NDJSON started frame first and closes stream on disconnect', { timeout: 60_000 }, async () => {
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
  // Read first streamed frame (stream stays open while monitoring; cancel immediately after reading first frame).
  assert.ok(eventsResponse.body !== null)
  const reader = eventsResponse.body.getReader()
  const { value } = await reader.read()
  const first = JSON.parse(new TextDecoder().decode(value).trim()) as { type?: string }
  assert.equal(first.type, 'started')
  controller.abort()
  await reader.cancel().catch(() => undefined)
  // events on unknown forwardId returns 404.
  const kernel2 = makeKernel({ sessions: new Map(), events: [] })
  const missing = await handleApi(new Request('http://hub/api/nodes/forward/fwd-99999999-2222-3333-4444-555555555555/events'), kernel2)
  assert.equal(missing.status, 404)
})

test('GET events ends stream cleanly after terminal stopped frame without hanging listeners', { timeout: 60_000 }, async () => {
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[] }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)
  // Subscribe to termination notifications (simulates runtime onNodeForwardStopped wiring).
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
  // Simulate stop: emit terminal stopped frame on event channel, then fire stop waiters — stream must close cleanly (done=true).
  for (const listener of [...over.events]) listener({ type: 'stopped' })
  for (const waiter of [...stopWaiters]) waiter()
  const drain = async () => {
    while (!(await reader.read()).done) { /* consume through EOF */ }
  }
  try {
    await withTimeout(drain(), 5_000, 'event stream must terminate cleanly after stop notification')
  } finally {
    await reader.cancel()
  }
})

test('GET events acts as lease holder: acquires on attach and releases on abort/cancel without leaks', { timeout: 60_000 }, async () => {
  const lease = { acquisitions: 0, releases: 0, onLastRelease: undefined as (() => void) | undefined }
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[], lease }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)

  // 1) Disconnect via abort: acquire once, release once.
  const controller = new AbortController()
  const response = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller.signal,
  }), kernel)
  assert.equal(response.status, 200)
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  await reader.read() // initial started frame
  await delay(30)
  assert.equal(lease.acquisitions, 1, 'event stream acquires lease upon attaching')
  assert.equal(lease.releases, 0, 'lease stays held while connected')
  controller.abort()
  await delay(30)
  assert.equal(lease.releases, 1, 'lease released on disconnect (last holder triggers stop callback chain)')

  // 2) Disconnect via body.cancel: releases identically.
  const lease2 = { acquisitions: 0, releases: 0, onLastRelease: undefined as (() => void) | undefined }
  const over2 = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[], lease: lease2 }
  const kernel2 = makeKernel(over2)
  const created2 = await post(kernel2, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created2.status, 201)
  const controller2 = new AbortController()
  const response2 = await handleApi(new Request('http://hub/api/nodes/node-a/forward/fwd-11111111-2222-3333-4444-555555555555/events'.replace('/nodes/node-a/', '/nodes/'), {
    headers: { accept: 'application/x-ndjson' },
    signal: controller2.signal,
  }), kernel2)
  assert.ok(response2.body !== null)
  const reader2 = response2.body.getReader()
  await reader2.read()
  await reader2.cancel()
  await delay(30)
  assert.equal(lease2.acquisitions, 1)
  assert.equal(lease2.releases, 1, 'client cancel releases lease identically')
})
