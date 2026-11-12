/**
 * HTTP 层并发缺陷回归（fix/concurrency-http）：
 * - 插件动态路由派发门禁：handler 执行计入 liveTasks（disable 闸门可见，
 *   409 plugin_has_live_tasks 而非半执行）；停用后派发被拒（404/409）；
 * - NDJSON 转发监控流：入口 aborted 预检（已断开不建流、不取租约）、
 *   abort/cancel 后 finish 幂等（迟到的监听器回调不重复释放）；
 * - Profile 删除 TOCTOU：服务层 delete 落盘前绑定复核（路由快速路径与
 *   删除之间的交错窗口闭合）；
 * - 产物上传 TOCTOU：writeUploaded 落盘前会话存在性复核（入口校验与写盘
 *   之间的交错窗口闭合，不留 artifacts/<已删会话>/ 孤儿目录）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { HelmError, type PluginSummary, type HelmPluginContext } from '@helm/protocol'
import type { ConversationSummary, NodeForwardEvent, NodeForwardSession } from '@helm/protocol'
import { ArtifactService, InMemoryArtifactRepository, ProfileService } from '../src/services/index.js'
import { PluginHost } from '../src/plugins/index.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import type { PluginDocStore } from '../src/plugins/index.js'
import { handleApi } from '../src/http/routes.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    this.store.delete(pluginId)
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let host: PluginHost

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-http-conc-'))
  host = new PluginHost({ dataDir, host: hostBackendStub(), docs: new MemoryDocStore() })
})

after(async () => {
  await host.dispose().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 插件动态路由派发门禁
// ---------------------------------------------------------------------------

test('插件路由 handler 执行计入 liveTasks：在途时 disable 409 plugin_has_live_tasks', { timeout: 60_000 }, async () => {
  let releaseHandler: (() => void) | undefined
  await host.register(
    {
      id: 'builtin:probe-route',
      name: 'probe-route',
      async definePlugin(ctx: HelmPluginContext) {
        ctx.route({
          method: 'GET',
          path: '/slow',
          handler: () =>
            new Promise<Response>((resolve) => {
              releaseHandler = () => resolve(Response.json({ ok: true }))
            }),
        })
      },
    },
    { enabled: true },
  )
  const kernel = { plugins: host } as unknown as KernelRuntimeLike
  const pending = handleApi(
    new Request('http://hub/api/plugins/builtin:probe-route/routes/slow'),
    kernel,
  )
  await delay(30)
  // 在途 route 请求对停用闸门可见（此前完全失明）。
  assert.equal(host.activeTaskCount('builtin:probe-route'), 1, 'handler 执行期间计入 liveTasks')
  await assert.rejects(
    host.disable('builtin:probe-route'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    '停用闸门应看见在途 route 请求并 409，而非半执行拆毁',
  )
  releaseHandler!()
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(host.activeTaskCount('builtin:probe-route'), 0, 'handler 完成后计数归零')
  // 停用成功后：路由清单已空，派发 404（不派发到已拆毁插件）。
  await host.disable('builtin:probe-route')
  const rejected = await handleApi(
    new Request('http://hub/api/plugins/builtin:probe-route/routes/slow'),
    kernel,
  )
  assert.equal(rejected.status, 404)
  const body = (await rejected.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'route_not_found')
})

test('派发前摘要复查：listRoutes 快照含已停用插件时按 get 摘要 409 拒绝', { timeout: 60_000 }, async () => {
  // 构造 listRoutes 快照与插件现状交错的宿主：清单仍返回路由（enabled 快照
  // 陈旧），摘要现读为已停用——派发必须 409 plugin_disabled，不进入 handler。
  let handlerCalled = false
  const summary: PluginSummary = {
    id: 'stale-plugin',
    name: 'stale-plugin',
    enabled: false,
    status: 'disabled',
    locked: false,
    hooks: [],
    actions: [],
    tools: [],
  }
  const kernel = {
    plugins: {
      listRoutes: () => [
        {
          pluginId: 'stale-plugin',
          method: 'GET' as const,
          path: '/api/plugins/stale-plugin/routes/thing',
          handler: () => {
            handlerCalled = true
            return Response.json({ ok: true })
          },
        },
      ],
      get: (id: string) => (id === 'stale-plugin' ? summary : undefined),
    },
  } as unknown as KernelRuntimeLike
  await assert.rejects(
    handleApi(new Request('http://hub/api/plugins/stale-plugin/routes/thing'), kernel),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_disabled' && err.status === 409,
    '已停用插件的路由派发应 409 拒绝',
  )
  assert.equal(handlerCalled, false, 'handler 不得执行（半执行）')
})

test('轻量测试宿主未提供 get/withTask 时派发行为不变（可选端口）', { timeout: 60_000 }, async () => {
  const kernel = {
    plugins: {
      listRoutes: () => [
        {
          pluginId: 'lite-plugin',
          method: 'GET' as const,
          path: '/api/plugins/lite-plugin/routes/ping',
          handler: () => Response.json({ pong: true }),
        },
      ],
    },
  } as unknown as KernelRuntimeLike
  const response = await handleApi(new Request('http://hub/api/plugins/lite-plugin/routes/ping'), kernel)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { pong: true })
})

// ---------------------------------------------------------------------------
// 2. NDJSON 转发监控流：aborted 预检与 finish 幂等
// ---------------------------------------------------------------------------

interface ForwardFixture {
  sessions: Map<string, NodeForwardSession>
  events: ((event: NodeForwardEvent) => void)[]
  lease: { acquisitions: number; releases: number }
}

function forwardKernel(over: ForwardFixture): KernelRuntimeLike {
  const session: NodeForwardSession = {
    forwardId: 'fwd-11111111-2222-3333-4444-555555555555',
    nodeId: 'node-a',
    listenHost: '127.0.0.1',
    listenPort: 18080,
    targetHost: '127.0.0.1',
    targetPort: 8080,
    activeConnections: 0,
    totalConnections: 0,
  }
  over.sessions.set(session.forwardId, session)
  return {
    listNodes: () => [],
    async issueNodeToken() { throw new Error('unused') },
    async removeNode() { throw new Error('unused') },
    async execEnv() { throw new Error('unused') },
    dataDir: '/tmp/helm-forward-conc-test',
    auth: { status: async () => ({ configured: false }), verifyToken: async () => false, setup: async () => ({ token: 'x' }), login: async () => ({ token: 'x' }) } as never,
    getNodeForward: (id: string) => over.sessions.get(id),
    listNodeForwards: () => [...over.sessions.values()],
    onNodeForwardEvent: (_id: string, listener: (event: NodeForwardEvent) => void) => {
      over.events.push(listener)
      return () => undefined
    },
    acquireNodeForwardLease: (_id: string) => {
      over.lease.acquisitions += 1
      return () => {
        over.lease.releases += 1
      }
    },
  } as unknown as KernelRuntimeLike
}

const FORWARD_EVENTS_PATH = '/api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events'

test('监控流入口 aborted 预检：客户端已在鉴权期间断开则不建流、不取租约', { timeout: 60_000 }, async () => {
  const over: ForwardFixture = { sessions: new Map(), events: [], lease: { acquisitions: 0, releases: 0 } }
  const kernel = forwardKernel(over)
  // 模拟 hub 鉴权 await 期间 res close 已 abort signal（AbortSignal.abort 即已终态）。
  const response = await handleApi(
    new Request(`http://hub${FORWARD_EVENTS_PATH}`, { signal: AbortSignal.abort() }),
    kernel,
  )
  assert.equal(response.status, 409)
  const body = (await response.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'client_disconnected')
  assert.equal(over.lease.acquisitions, 0, '不建立流即不取租约（对已 aborted 的 signal 注册监听永不触发）')
  assert.equal(over.lease.releases, 0)
})

test('监控流 abort 断开释放租约一次；迟到的监听器回调不重复释放', { timeout: 60_000 }, async () => {
  const over: ForwardFixture = { sessions: new Map(), events: [], lease: { acquisitions: 0, releases: 0 } }
  const kernel = forwardKernel(over)
  const controller = new AbortController()
  const response = await handleApi(
    new Request(`http://hub${FORWARD_EVENTS_PATH}`, { signal: controller.signal }),
    kernel,
  )
  assert.equal(response.status, 200)
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal((JSON.parse(new TextDecoder().decode(first.value!).trim()) as { type: string }).type, 'started')
  await delay(20)
  assert.equal(over.lease.acquisitions, 1)
  assert.equal(over.lease.releases, 0)
  controller.abort()
  await delay(20)
  assert.equal(over.lease.releases, 1, '断开即释放（最后持有者离开即停止）')
  // 模拟迟到的事件投递（真实宿主已退订；此处验证 finished 守卫幂等）：
  // 不崩溃、不二次释放、不复活流。
  over.events[0]!({ type: 'stopped' })
  await delay(20)
  assert.equal(over.lease.releases, 1, 'finish 幂等：迟到回调不得重复释放')
})

test('监控流客户端主动 cancel 同样释放租约（finish 幂等）', { timeout: 60_000 }, async () => {
  const over: ForwardFixture = { sessions: new Map(), events: [], lease: { acquisitions: 0, releases: 0 } }
  const kernel = forwardKernel(over)
  const controller = new AbortController()
  const response = await handleApi(
    new Request(`http://hub${FORWARD_EVENTS_PATH}`, { signal: controller.signal }),
    kernel,
  )
  assert.ok(response.body !== null)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await delay(20)
  assert.equal(over.lease.acquisitions, 1)
  assert.equal(over.lease.releases, 1, 'cancel 路径同样释放租约')
})

// ---------------------------------------------------------------------------
// 3. Profile 删除 TOCTOU：服务层落盘前绑定复核
// ---------------------------------------------------------------------------

test('ProfileService.delete 服务层复核：isProfileInUse 为真时 409 且目录不删', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-del-'))
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'bound-profile', name: '绑定中' })
    await writeFile(join(dir, 'profiles', 'bound-profile', 'SYSTEM.md'), '# sys')
    await assert.rejects(
      profiles.delete('bound-profile', { isProfileInUse: async () => true }),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_in_use' && err.status === 409,
    )
    assert.notEqual(await profiles.get('bound-profile'), undefined, '拒绝删除时 profile 完整保留')
    // 复核为假：正常删除。
    await profiles.delete('bound-profile', { isProfileInUse: async () => false })
    assert.equal(await profiles.get('bound-profile'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DELETE /api/profiles/:id TOCTOU：快速路径通过后并发绑定在服务层复核处被拒', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-tou-'))
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'race-profile', name: '竞态' })
    const bound = { ...summaryOf(7), profileId: 'race-profile' }
    // 第一次 listConversations（路由快速路径）返回空；第二次（服务层落盘前
    // 复核）返回绑定会话——模拟「检查通过 → 并发 POST 绑定 → 删除落盘」。
    let listCalls = 0
    const kernel = {
      dataDir: dir,
      profiles,
      plugins: host,
      listConversations: () => {
        listCalls += 1
        return listCalls === 1 ? [] : [bound]
      },
    } as unknown as KernelRuntimeLike
    await assert.rejects(
      handleApi(new Request('http://hub/api/profiles/race-profile', { method: 'DELETE' }), kernel),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_in_use' && err.status === 409,
      '服务层复核应拦截窗口内穿过的绑定',
    )
    assert.equal(listCalls, 2, '快速路径与服务层复核各查一次')
    assert.notEqual(await profiles.get('race-profile'), undefined, 'profile 未被删除')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 产物上传 TOCTOU：writeUploaded 落盘前会话存在性复核
// ---------------------------------------------------------------------------

test('writeUploaded 服务层复核：会话不存在时 404 且不留孤儿目录', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-artifact-del-'))
  try {
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository())
    await assert.rejects(
      artifacts.writeUploaded(
        99,
        { name: 'orphan.bin', bytes: new Uint8Array([1, 2, 3]) },
        { conversationExists: async () => false },
      ),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
    )
    await assert.rejects(
      () => stat(join(dir, 'artifacts', '99')),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
      '已删会话的产物目录不得被重建（孤儿）',
    )
    // 复核为真：正常落盘。
    const meta = await artifacts.writeUploaded(
      99,
      { name: 'ok.bin', bytes: new Uint8Array([4, 5]) },
      { conversationExists: async () => true },
    )
    assert.equal(meta.conversationId, 99)
    assert.equal((await artifacts.listFiles(99)).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /api/conversations/:id/artifacts TOCTOU：入口校验通过后会话被删，写盘前复核 404', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-artifact-tou-'))
  try {
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository())
    // 第一次 getConversationDetail（入口快速路径）成功；第二次（服务层落盘前
    // 复核）not_found——模拟「校验通过 → DELETE 完成 → 上传落盘」交错。
    let detailCalls = 0
    const kernel = {
      dataDir: dir,
      plugins: host,
      artifacts,
      getConversationDetail: async (id: number) => {
        detailCalls += 1
        if (detailCalls === 1) return { ...summaryOf(id), entries: [] }
        throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      },
    } as unknown as KernelRuntimeLike
    await assert.rejects(
      handleApi(
        new Request('http://hub/api/conversations/5/artifacts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'late.bin', contentBase64: Buffer.from([9, 9]).toString('base64') }),
        }),
        kernel,
      ),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
      '写盘前复核应拦截已删会话的上传',
    )
    assert.equal(detailCalls, 2, '入口校验与服务层复核各查一次')
    await assert.rejects(
      () => stat(join(dir, 'artifacts', '5')),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
      '不留 artifacts/<已删会话>/ 孤儿目录',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------

function summaryOf(id: number): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conv-${id}`,
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
