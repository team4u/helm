/**
 * Regressions for HTTP layer concurrency bugs (fix/concurrency-http):
 * - Plugin dynamic route dispatch guard: handler execution counts toward liveTasks (visible to
 *   disable gate, returning 409 plugin_has_live_tasks rather than tearing down mid-execution);
 *   post-disable dispatch rejects (404/409);
 * - NDJSON forwarding monitor stream: aborted preflight at entry (never opens stream or acquires
 *   lease if client already disconnected), idempotent cleanup on abort/cancel (late listener
 *   callbacks never double-release);
 * - Profile deletion TOCTOU: service layer re-checks bindings before deletion (closing the race
 *   window between fast route check and delete);
 * - Artifact upload TOCTOU: writeUploaded re-checks conversation existence before writing (closing the
 *   race window between entry validation and write without leaving orphan artifacts/<deletedId>/ dirs).
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { join } from 'node:path'
import { stat, writeFile } from 'node:fs/promises'
import { HelmError, type PluginSummary, type HelmPluginContext } from '@helm/protocol'
import type { ConversationSummary, NodeForwardEvent, NodeForwardSession } from '@helm/protocol'
import { ArtifactService, InMemoryArtifactRepository, ProfileService } from '../src/services/index.js'
import { PluginHost } from '../src/plugins/index.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import { handleApi } from '../src/http/routes.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir, sleep as delay } from './helpers.js'

let dataDir: string
let host: PluginHost

before(async () => {
  dataDir = await makeTempDir('helm-http-conc-')
  host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: hostBackendStub(), docs: new MemoryDocStore() })
})

after(async () => {
  await host.dispose().catch(() => undefined)
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// 1. Plugin dynamic route dispatch guard
// ---------------------------------------------------------------------------

test('plugin route handler execution counts as liveTasks: disabling mid-flight returns 409 plugin_has_live_tasks', { timeout: 60_000 }, async () => {
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
  // In-flight route request must be visible to the disable gate (previously missed completely).
  assert.equal(host.activeTaskCount('builtin:probe-route'), 1, 'liveTasks increments during handler execution')
  await assert.rejects(
    host.disable('builtin:probe-route'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    'disable gate must observe the in-flight route request and fail 409 rather than tearing down mid-execution',
  )
  releaseHandler!()
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(host.activeTaskCount('builtin:probe-route'), 0, 'counter drops to zero after handler finishes')
  // Once disabled succeeds: route table is empty and dispatch returns 404 (never invokes torn-down plugin).
  await host.disable('builtin:probe-route')
  const rejected = await handleApi(
    new Request('http://hub/api/plugins/builtin:probe-route/routes/slow'),
    kernel,
  )
  assert.equal(rejected.status, 404)
  const body = (await rejected.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'route_not_found')
})

test('pre-dispatch summary re-check: rejects 409 when listRoutes snapshot includes a disabled plugin', { timeout: 60_000 }, async () => {
  // Simulates race between listRoutes snapshot and plugin's current state: manifest still returns route
  // (stale enabled snapshot), while summary now reports disabled -> dispatch must reject 409 plugin_disabled
  // without entering handler.
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
    'dispatching to disabled plugin route must reject with 409',
  )
  assert.equal(handlerCalled, false, 'handler must not execute mid-teardown')
})

test('lightweight test host omitting get/withTask preserves dispatch behavior (optional port)', { timeout: 60_000 }, async () => {
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
// 2. NDJSON forwarding monitor stream: aborted preflight and finish idempotency
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

test('monitor stream entry aborted preflight: skips stream and lease if client disconnected during auth', { timeout: 60_000 }, async () => {
  const over: ForwardFixture = { sessions: new Map(), events: [], lease: { acquisitions: 0, releases: 0 } }
  const kernel = forwardKernel(over)
  // Simulates res close aborting signal during await on hub auth (AbortSignal.abort() is pre-aborted).
  const response = await handleApi(
    new Request(`http://hub${FORWARD_EVENTS_PATH}`, { signal: AbortSignal.abort() }),
    kernel,
  )
  assert.equal(response.status, 409)
  const body = (await response.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'client_disconnected')
  assert.equal(over.lease.acquisitions, 0, 'never acquires lease without opening stream (listener on pre-aborted signal never fires)')
  assert.equal(over.lease.releases, 0)
})

test('monitor stream abort releases lease once; late listener callbacks do not double-release', { timeout: 60_000 }, async () => {
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
  assert.equal(over.lease.releases, 1, 'disconnection immediately releases lease (last holder leaving stops session)')
  // Simulate late event delivery (real host already unsubscribed; verifies finished guard idempotency):
  // does not crash, double-release, or resurrect stream.
  over.events[0]!({ type: 'stopped' })
  await delay(20)
  assert.equal(over.lease.releases, 1, 'finish idempotency: late callback must not double-release')
})

test('monitor stream explicit client cancel also releases lease idempotently', { timeout: 60_000 }, async () => {
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
  assert.equal(over.lease.releases, 1, 'cancel path releases lease identically')
})

// ---------------------------------------------------------------------------
// 3. Profile deletion TOCTOU: service layer re-checks bindings first
// ---------------------------------------------------------------------------

test('ProfileService.delete service re-check: returns 409 and preserves directory when isProfileInUse is true', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-profile-del-')
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'bound-profile', name: 'bound' })
    await writeFile(join(dir, 'profiles', 'bound-profile', 'SYSTEM.md'), '# sys')
    await assert.rejects(
      profiles.delete('bound-profile', { isProfileInUse: async () => true }),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_in_use' && err.status === 409,
    )
    assert.notEqual(await profiles.get('bound-profile'), undefined, 'profile stays intact when deletion is rejected')
    // Re-check false: deletion proceeds.
    await profiles.delete('bound-profile', { isProfileInUse: async () => false })
    assert.equal(await profiles.get('bound-profile'), undefined)
  } finally {
    await cleanupDir(dir)
  }
})

test('DELETE /api/profiles/:id TOCTOU: concurrent binding after fast path is caught by service re-check', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-profile-tou-')
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'race-profile', name: 'race' })
    const bound = { ...summaryOf(7), profileId: 'race-profile' }
    // First listConversations (route fast path) returns empty; second (service re-check) returns bound
    // conversation -- simulates check-passed -> concurrent POST binding -> delete race.
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
      'service layer re-check must catch bindings added during the race window',
    )
    assert.equal(listCalls, 2, 'fast path and service layer re-check each inspect once')
    assert.notEqual(await profiles.get('race-profile'), undefined, 'profile was not deleted')
  } finally {
    await cleanupDir(dir)
  }
})

// ---------------------------------------------------------------------------
// 4. Artifact upload TOCTOU: re-check conversation existence before writeUploaded
// ---------------------------------------------------------------------------

test('writeUploaded service re-check: returns 404 without orphan dir when conversation is missing', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-artifact-del-')
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
      'deleted conversation artifact directory must not be recreated as an orphan',
    )
    // Re-check true: succeeds normally.
    const meta = await artifacts.writeUploaded(
      99,
      { name: 'ok.bin', bytes: new Uint8Array([4, 5]) },
      { conversationExists: async () => true },
    )
    assert.equal(meta.conversationId, 99)
    assert.equal((await artifacts.listFiles(99)).length, 1)
  } finally {
    await cleanupDir(dir)
  }
})

test('POST /api/conversations/:id/artifacts TOCTOU: conversation deleted after entry check is rejected 404 pre-write', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-artifact-tou-')
  try {
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository())
    // First getConversationDetail (route fast path) succeeds; second (service re-check) throws not_found --
    // simulates entry-validated -> DELETE completes -> upload write race.
    let detailCalls = 0
    const kernel = {
      dataDir: dir,
      plugins: host,
      artifacts,
      getConversationDetail: async (id: number) => {
        detailCalls += 1
        if (detailCalls === 1) return { ...summaryOf(id), entries: [] }
        throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      },
      getConversationEntry: async (id: number, entryId: number) => {
        throw new HelmError('not_found', `entry ${entryId} not found in conversation ${id}`, 404)
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
      'pre-write re-check must block uploads for concurrently deleted conversations',
    )
    assert.equal(detailCalls, 2, 'entry validation and service layer re-check each inspect once')
    await assert.rejects(
      () => stat(join(dir, 'artifacts', '5')),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
      'must not leave orphan artifacts/<deletedId>/ directories',
    )
  } finally {
    await cleanupDir(dir)
  }
})

// ---------------------------------------------------------------------------

function summaryOf(id: number): ConversationSummary {
  const now = Date.now()
  return makeConversationSummary({ id, model: 'faux/model', createdAt: now, updatedAt: now })
}
