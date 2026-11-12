/**
 * 节点端口转发 HTTP 路由测试：handleApi 直接驱动（无真实 daemon——
 * 转发服务的真实字节链路见 node-forward.test.ts）。
 * 覆盖：POST 校验（缺字段/坏端口/坏 host/未知字段）、创建成功、
 * GET 清单/详情（404）、DELETE 停止（幂等 404）、events NDJSON。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleApi } from '../src/http/routes.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'
import type { NodeForwardEvent, NodeForwardSession } from '../src/env/forward.js'

function makeKernel(over: {
  sessions: Map<string, NodeForwardSession>
  events: ((event: NodeForwardEvent) => void)[]
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
    // ValidationError（HelmError 子类）直接抛出（生产由 hub.ts 统一映射 400）。
    if (error instanceof Error && 'status' in error) {
      return { status: (error as { status: number }).status, json: undefined }
    }
    throw error
  }
}

test('POST /api/nodes/:id/forward：校验与创建', { timeout: 60_000 }, async () => {
  const kernel = makeKernel({ sessions: new Map(), events: [] })
  // 合法创建。
  const ok = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
  assert.equal(ok.status, 201)
  // 缺字段。
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
    assert.equal(result.status, 400, `应 400 拒绝 ${JSON.stringify(bad)}`)
  }
})

test('GET 清单/详情与 DELETE 停止（含 404）', { timeout: 60_000 }, async () => {
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
  // 非法 forwardId 形式：ValidationError 直抛（hub.ts 映射 400）。
  await assert.rejects(
    handleApi(new Request('http://hub/api/nodes/forward/not-a-uuid'), kernel),
    (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400,
  )
})

test('GET events：NDJSON 首帧 started，断开关闭流', { timeout: 60_000 }, async () => {
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
  // 流式读取首帧（流保持开启——监控生命周期由客户端控制；读完首帧即取消）。
  assert.ok(eventsResponse.body !== null)
  const reader = eventsResponse.body.getReader()
  const { value } = await reader.read()
  const first = JSON.parse(new TextDecoder().decode(value).trim()) as { type?: string }
  assert.equal(first.type, 'started')
  controller.abort()
  await reader.cancel().catch(() => undefined)
  // 未知 forwardId 的 events：404。
  const kernel2 = makeKernel({ sessions: new Map(), events: [] })
  const missing = await handleApi(new Request('http://hub/api/nodes/forward/fwd-99999999-2222-3333-4444-555555555555/events'), kernel2)
  assert.equal(missing.status, 404)
})
