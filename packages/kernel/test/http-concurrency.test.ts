/**
 * HTTP layer concurrency defect regression (fix/concurrency-http):
 * - plugin motion state routing dispatch gate:handler execute count liveTasks(disable gate visible,
 *   409 plugin_has_live_tasks while non- half execute); deactivate after dispatch by refuse (404/409);
 * - NDJSON forwarding monitor stream: entry aborted preflight (disconnected do not create stream, do not take lease),
 *   abort/cancel after finish idempotent (late to listener call back does not repeat release);
 * - Profile delete TOCTOU: service layer delete before bind set re-check (routing fast path and
 *   delete between hand over wrong window closed together);
 * - artifact upload TOCTOU:writeUploaded before conversation store in re-check (entry validate and write
 *   between hand over wrong window closed together, do not artifacts/<already delete conversation>/ orphan child directory).
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
// 1. plugin motion state routing dispatch gate
// ---------------------------------------------------------------------------

test('plugin routing handler execute count liveTasks: in-flight when disable 409 plugin_has_live_tasks', { timeout: 60_000 }, async () => {
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
  // in-flight route request for deactivate gate visible (this before fully lose).
  assert.equal(host.activeTaskCount('builtin:probe-route'), 1, 'handler execute during count liveTasks')
  await assert.rejects(
    host.disable('builtin:probe-route'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    'deactivate gate should see see in-flight route request and 409, while non- half execute split destroy',
  )
  releaseHandler!()
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(host.activeTaskCount('builtin:probe-route'), 0, 'handler after completion counter reset to zero')
  // deactivate after success: routing manifest already empty, dispatch 404(do not dispatch to already split destroy plugin).
  await host.disable('builtin:probe-route')
  const rejected = await handleApi(
    new Request('http://hub/api/plugins/builtin:probe-route/routes/slow'),
    kernel,
  )
  assert.equal(rejected.status, 404)
  const body = (await rejected.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'route_not_found')
})

test('dispatch before summary re- inspect:listRoutes snapshot contains deactivated plugin when by get summary 409 reject', { timeout: 60_000 }, async () => {
  // construct listRoutes snapshot and plugin now state hand over wrong host: manifest still return routing (enabled snapshot
  // stale), summary now read is deactivated - - dispatch must 409 plugin_disabled, does not enter handler.
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
    'deactivated plugin routing dispatch should 409 reject',
  )
  assert.equal(handlerCalled, false, 'handler must not execute (half execute)')
})

test('light amount test host not provide get/withTask when dispatch behavior do not change (optional port)', { timeout: 60_000 }, async () => {
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
// 2. NDJSON forwarding monitor stream:aborted preflight and finish idempotent
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

test('monitor stream entry aborted preflight: client already in authentication during disconnect then do not create stream, do not take lease', { timeout: 60_000 }, async () => {
  const over: ForwardFixture = { sessions: new Map(), events: [], lease: { acquisitions: 0, releases: 0 } }
  const kernel = forwardKernel(over)
  // simulated hub authentication await during res close already abort signal(AbortSignal.abort i.e. already terminal state).
  const response = await handleApi(
    new Request(`http://hub${FORWARD_EVENTS_PATH}`, { signal: AbortSignal.abort() }),
    kernel,
  )
  assert.equal(response.status, 409)
  const body = (await response.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'client_disconnected')
  assert.equal(over.lease.acquisitions, 0, 'do not establish stream i.e. do not take lease (for already aborted  signal register listen forever does not trigger)')
  assert.equal(over.lease.releases, 0)
})

test('monitor stream abort disconnect release lease once; late to listener call back does not repeat release', { timeout: 60_000 }, async () => {
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
  assert.equal(over.lease.releases, 1, 'disconnect i.e. release (finally holder leave i.e. stop)')
  // simulated late to event delivery (real host already unsubscribe; this where verify finished guard idempotent):
  // do not crash, do not second release, does not resurrect stream.
  over.events[0]!({ type: 'stopped' })
  await delay(20)
  assert.equal(over.lease.releases, 1, 'finish idempotent: late to call back must not duplicate release')
})

test('monitor stream client actively cancel same release lease (finish idempotent)', { timeout: 60_000 }, async () => {
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
  assert.equal(over.lease.releases, 1, 'cancel path same release lease')
})

// ---------------------------------------------------------------------------
// 3. Profile delete TOCTOU: service layer before bind set re-check
// ---------------------------------------------------------------------------

test('ProfileService.delete service layer re-check:isProfileInUse is true when 409 and directory do not delete', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-profile-del-')
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'bound-profile', name: 'bind set in' })
    await writeFile(join(dir, 'profiles', 'bound-profile', 'SYSTEM.md'), '# sys')
    await assert.rejects(
      profiles.delete('bound-profile', { isProfileInUse: async () => true }),
      (err: unknown) => err instanceof HelmError && err.code === 'profile_in_use' && err.status === 409,
    )
    assert.notEqual(await profiles.get('bound-profile'), undefined, 'reject delete when profile complete keep')
    // re-check is false: normal delete.
    await profiles.delete('bound-profile', { isProfileInUse: async () => false })
    assert.equal(await profiles.get('bound-profile'), undefined)
  } finally {
    await cleanupDir(dir)
  }
})

test('DELETE /api/profiles/:id TOCTOU: fast path via after concurrency bind set in service layer re-check where by refuse', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-profile-tou-')
  try {
    const profiles = new ProfileService(dir)
    await profiles.save({ id: 'race-profile', name: 'race' })
    const bound = { ...summaryOf(7), profileId: 'race-profile' }
    // first time listConversations(routing fast path) return empty; second time (service layer before
    // re-check) return bind set conversation - - simulated check via → concurrency POST bind set → delete.
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
      'service layer re-check should intercept window inside through bind set',
    )
    assert.equal(listCalls, 2, 'fast path and service layer re-check each inspect once')
    assert.notEqual(await profiles.get('race-profile'), undefined, 'profile not by delete')
  } finally {
    await cleanupDir(dir)
  }
})

// ---------------------------------------------------------------------------
// 4. artifact upload TOCTOU:writeUploaded before conversation store in re-check
// ---------------------------------------------------------------------------

test('writeUploaded service layer re-check: conversation missing when 404 and do not orphan child directory', { timeout: 60_000 }, async () => {
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
      'already delete conversation artifact directory must not by rebuild (orphan child)',
    )
    // re-check is true: normal.
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

test('POST /api/conversations/:id/artifacts TOCTOU: entry validate via after conversation by delete, write before re-check 404', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-artifact-tou-')
  try {
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository())
    // first time getConversationDetail(entry fast path) succeeded; second time (service layer before
    // re-check)not_found- - simulated validate via → DELETE complete → upload hand over wrong.
    let detailCalls = 0
    const kernel = {
      dataDir: dir,
      plugins: host,
      artifacts,
      getConversationDetail: async (id: number) => {
        detailCalls += 1
        if (detailCalls === 1) return { ...summaryOf(id), entries: [] }
        throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      },
      getConversationEntry: async (id: number, entryId: number) => {
        throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404)
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
      'write before re-check should intercept already delete conversation upload',
    )
    assert.equal(detailCalls, 2, 'entry validate and service layer re-check each inspect once')
    await assert.rejects(
      () => stat(join(dir, 'artifacts', '5')),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
      'do not artifacts/<already delete conversation>/ orphan child directory',
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
