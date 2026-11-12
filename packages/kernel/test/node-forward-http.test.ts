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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeKernel(over: {
  sessions: Map<string, NodeForwardSession>
  events: ((event: NodeForwardEvent) => void)[]
  /** 租约记录（可选注入：acquire/release 计数与最后释放回调）。 */
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
              // 简化模拟：首 holder 释放即视为最后持有者（单 holder 测试）。
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

test('GET events：stop 终态 stopped 帧后流正常结束（监控不悬挂）', { timeout: 60_000 }, async () => {
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[] }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)
  // 订阅终止通知（模拟 runtime 的 onNodeForwardStopped 接线）。
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
  // 模拟 stop：先经事件通道发终态 stopped 帧（makeKernel 登记的 listener），
  // 再触发终止通知——流应正常 close（done=true），不悬挂。
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
  assert.equal(drained, true, '终止通知后事件流应正常结束（done）')
})

test('GET events：事件流即持有者——建立 acquire、断开/取消 release（不泄漏租约）', { timeout: 60_000 }, async () => {
  const lease = { acquisitions: 0, releases: 0, onLastRelease: undefined as (() => void) | undefined }
  const over = { sessions: new Map<string, NodeForwardSession>(), events: [] as ((event: NodeForwardEvent) => void)[], lease }
  const kernel = makeKernel(over)
  const created = await post(kernel, '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 8080 })
  assert.equal(created.status, 201)

  // 1) abort 断开：acquire 一次、release 一次。
  const controller = new AbortController()
  const response = await handleApi(new Request('http://hub/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events', {
    headers: { accept: 'application/x-ndjson' },
    signal: controller.signal,
  }), kernel)
  assert.equal(response.status, 200)
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  await reader.read() // started 首帧
  await delay(30)
  assert.equal(lease.acquisitions, 1, '事件流建立即 acquire 租约')
  assert.equal(lease.releases, 0, '持有期间未释放')
  controller.abort()
  await delay(30)
  assert.equal(lease.releases, 1, '断开后释放租约（最后一持有者触发停止回调链）')

  // 2) cancel（body.cancel）断开：同样释放。
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
  assert.equal(lease2.releases, 1, '客户端主动 cancel 同样释放租约')
})
