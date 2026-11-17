/**
 * SecretStash 生命周期、最小授权派生与插件配置动态机密隔离回归测试：
 * - SecretStash：TTL 惰性过期停止注入但保持脱敏（含跨 chunk KMP 流式脱敏）、24h 上界与 SecretLifetime 形状校验、
 *   turn 作用域按结算代数精确回收（含结算后注册归下一回合）与 clear 全清；
 * - AskService secretLifetime 接线与校验；
 * - buildSpawnEnv 最小授权（默认零业务机密、显式 secretNames 含 __proto__、缺失/过期 404、单次采样防竞态空注入）；
 * - HerdrExecutor 窗格与 Gate 机密授权（不缓存旧值、轮换生效、运行期过期 404、不跨任务沿用）与 agentJournalKey 指纹；
 * - createHelm 真实回合结算（completed/failed/aborted + late hook）、原生执行行显式拒绝非空 secretNames 与插件配置 HTTP 隐藏动态机密。
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition, type Profile } from '@helm/protocol'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHubHandler } from '../../kernel/src/http/hub.js'
import { AskService } from '../../kernel/src/runtime/asks.js'
import { RuntimeAgentSpawn } from '../../kernel/src/runtime/runtime-agent-spawn.js'
import { openHelmDatabase } from '../../kernel/src/runtime/sqlite.js'
import { HelmStore } from '../../kernel/src/runtime/store.js'
import {
  CredentialService,
  MAX_SECRET_TTL_MS,
  SecretStash,
  validateSecretLifetime,
} from '../../kernel/src/services/index.js'
import { AskCoordinator } from '../../plugins/src/herdr/asks.js'
import type { HerdrTarget, HerdrTransport } from '../../plugins/src/herdr/contracts.js'
import { HerdrExecutor, type ExecutorHost } from '../../plugins/src/herdr/executor.js'
import { MetadataProjector } from '../../plugins/src/herdr/metadata.js'
import { EMPTY_MANAGED_DOC, PaneRegistry, type ManagedDoc } from '../../plugins/src/herdr/panes.js'
import { agentJournalKey } from '../../plugins/src/workflow/engine/journal.js'
import { createHubTestApp, openHubTestEnv, useTempDir, waitFor } from './helpers/hub-test-env.js'

function fakeClockStash(): { stash: SecretStash; now: { ms: number } } {
  const now = { ms: 1_000_000 }
  return { stash: new SecretStash({ now: () => now.ms }), now }
}

function spawnEnvBackend(stash: SecretStash, options: { token?: string; nodeHubUrl?: string } = {}) {
  return new RuntimeAgentSpawn({
    store: { getConv: () => ({ nodeId: 'local' }) } as never,
    toolDeps: {
      dataDir: '/tmp/helm-spawnenv-data',
      defaultCwd: '/tmp/helm-spawnenv-default',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id: number) => stash.envFor(id),
      redact: (t: string) => stash.redact(t),
      ...(options.token !== undefined ? { processToken: () => options.token } : {}),
      envFabric: {
        getNodeHubUrl: (nodeId: string) => (nodeId === 'node-a' ? options.nodeHubUrl : undefined),
      } as never,
    } as never,
    harness: {} as never,
    registry: {} as never,
    tracker: {} as never,
    conversations: {} as never,
    events: {} as never,
    envFabric: {} as never,
    modelsRegistry: {} as never,
    hookBridge: {} as never,
    stashService: stash,
    updateConversation: (() => { throw new Error('unused') }) as never,
    markConversationOwnership: () => undefined,
  })
}

// ---------------------------------------------------------------------------
// 1. SecretStash TTL / SecretLifetime / turn 作用域 / clear
// ---------------------------------------------------------------------------

test('SecretStash TTL 与形状校验：惰性过期停止注入但保持脱敏（含流式跨 chunk 与同名覆盖）、24h 上界与非法形状拒绝', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-abc-123', { ttlMs: 5_000 })
  assert.deepEqual(stash.envFor(7), { DEPLOY_TOKEN: 'tok-abc-123' })
  now.ms += 4_999
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true)
  now.ms += 1
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), false)
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 0 })
  assert.ok(stash.redact('leak: tok-abc-123').startsWith('leak: [REDACTED:stash:'))

  const stream = stash.createStreamingRedactor()
  const out = stream.push('prefix tok-abc-') + stream.push('123 tail') + stream.flush()
  assert.ok(!out.includes('tok-abc-123') && out.includes('[REDACTED:stash:'))

  // 同名覆盖后旧值继续脱敏
  stash.put(7, 'KEY', 'old-value', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'KEY', 'new-value')
  assert.deepEqual(stash.envFor(7), { KEY: 'new-value' })
  const both = stash.redact('old-value / new-value')
  assert.ok(!both.includes('old-value') && !both.includes('new-value'))

  // 上界与形状边界
  stash.put(7, 'OK_TTL', 'v', { ttlMs: MAX_SECRET_TTL_MS })
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER * 2, Infinity, NaN, '3000', null]) {
    assert.throws(
      () => stash.put(7, 'BAD_TTL', 'v', { ttlMs: bad as number }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
  assert.throws(
    () => validateSecretLifetime({ ttlMs: MAX_SECRET_TTL_MS + 1 }, 't'),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
  for (const badShape of [{ scope: 'session' }, { ttl: 5_000 }, null, [1], new Date(), new Map()]) {
    assert.throws(
      () => stash.put(7, 'S', 'v', badShape as never),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
  stash.put(7, 'S', 'v', {})
  assert.equal(stash.has(7, 'S'), true)
})

test('SecretStash turn 作用域与 clear：按结算代数精确回收、跨会话隔离、clear 全量释放', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'TURN_KEY', 'turn-secret', { scope: 'turn' })
  stash.put(7, 'SESSION_KEY', 'session-secret')
  stash.put(8, 'OTHER_TURN', 'v8', { scope: 'turn' })
  stash.settleTurn(7)

  assert.equal(stash.has(7, 'TURN_KEY'), false)
  assert.equal(stash.has(7, 'SESSION_KEY'), true)
  assert.equal(stash.has(8, 'OTHER_TURN'), true)
  assert.equal(stash.redact('turn-secret').includes('turn-secret'), false)

  // 结算后注册归下一回合，下一次 settleTurn 才回收
  stash.put(7, 'NEXT_TURN', 'next-val', { scope: 'turn' })
  assert.equal(stash.envFor(7)['NEXT_TURN'], 'next-val')
  stash.settleTurn(7)
  assert.equal(stash.has(7, 'NEXT_TURN'), false)
  assert.equal(stash.redact('next-val').includes('next-val'), false)

  // clear 彻底释放该会话注入与历史脱敏值
  stash.clear(7)
  stash.clear(8)
  assert.equal(stash.redact('turn-secret session-secret').includes('turn-secret'), true)
  assert.deepEqual(stash.stats(), { conversations: 0, secrets: 0 })
})

// ---------------------------------------------------------------------------
// 2. AskService secretLifetime 与 buildSpawnEnv 最小授权
// ---------------------------------------------------------------------------

test('AskService secretLifetime 校验与透传，以及 buildSpawnEnv 最小授权与单次采样防竞态', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-secret-ask-')
  const db = await openHelmDatabase(join(root, 'state.db'))
  const store = new HelmStore(db)
  await store.load()
  const askStash = new SecretStash()
  const service = new AskService({
    store,
    stash: askStash,
    onEvent: () => {},
    onConvPendingChanged: () => {},
    validateConversation: () => true,
  })
  t.after(async () => {
    await store.close()
    await db.close()
  })

  for (const fields of [
    [{ name: 'plain', label: 'p', type: 'text' as const, secretLifetime: { scope: 'turn' as const } }],
    [{ name: 'tok', label: 't', type: 'text' as const, secret: true, secretLifetime: { ttlMs: 0 } }],
    [{ name: 'tok', label: 't', type: 'text' as const, secret: true, secretLifetime: { scopes: 'turn' } as never }],
  ]) {
    await assert.rejects(
      service.createAsk({ conversationId: 1, ownerPluginId: 't', title: 'x', fields }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }

  const nextPendingId = async () => {
    await waitFor(() => service.listPendingByConversation(1).length > 0, { timeoutMs: 3_000, intervalMs: 5 })
    return service.listPendingByConversation(1).at(-1)!.id
  }
  const turnAsk = service.createAsk({
    conversationId: 1,
    ownerPluginId: 't',
    title: 'x',
    fields: [{ name: 'TURN_TOKEN', label: 't', type: 'text', secret: true, secretLifetime: { scope: 'turn' } }],
  })
  await service.answerAsk(await nextPendingId(), { TURN_TOKEN: 'turn-tok' })
  const sessionAsk = service.createAsk({
    conversationId: 1,
    ownerPluginId: 't',
    title: 'y',
    fields: [{ name: 'SESSION_TOKEN', label: 's', type: 'text', secret: true }],
  })
  await service.answerAsk(await nextPendingId(), { SESSION_TOKEN: 'session-tok' })
  assert.equal((await turnAsk).status, 'answered')
  assert.equal((await sessionAsk).status, 'answered')
  assert.deepEqual(askStash.envFor(1), { TURN_TOKEN: 'turn-tok', SESSION_TOKEN: 'session-tok' })
  askStash.settleTurn(1)
  assert.deepEqual(askStash.envFor(1), { SESSION_TOKEN: 'session-tok' })
  assert.equal(askStash.redact('turn-tok').includes('turn-tok'), false)

  // buildSpawnEnv：默认零机密、显式按名注入（含 __proto__）、过期/未知 404、非法形状 400、单次采样
  const { stash, now } = fakeClockStash()
  stash.put(7, 'A_KEY', 'va')
  stash.put(7, 'B_KEY', 'vb')
  stash.put(7, '__proto__', 'prototype-named-secret')
  const backend = spawnEnvBackend(stash, { token: 'managed-token' })

  const defaultEnv = backend.buildSpawnEnv(7, '/w', 'local')
  assert.equal(defaultEnv['A_KEY'], undefined)
  assert.equal(defaultEnv['HELM_TOKEN'], 'managed-token')

  const grantedEnv = backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['A_KEY', '__proto__'] })
  assert.equal(grantedEnv['A_KEY'], 'va')
  assert.equal(grantedEnv['B_KEY'], undefined)
  assert.equal(Object.hasOwn(grantedEnv, '__proto__'), true)
  assert.equal(grantedEnv['__proto__'], 'prototype-named-secret')

  stash.put(7, 'GONE_TTL', 'v', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'GONE_TURN', 'v', { scope: 'turn' })
  stash.settleTurn(7)
  for (const name of ['NOPE', 'GONE_TTL', 'GONE_TURN', 'toString', 'constructor']) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: [name] }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
    )
  }
  for (const bad of [['A', 'A'], ['bad-name!'], [''], 42]) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: bad as string[] }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }

  const counter = { ms: 1_000 }
  const edgeStash = new SecretStash({ now: () => (counter.ms += 1) })
  edgeStash.put(7, 'EDGE_KEY', 'edge-value', { ttlMs: 2 })
  const edgeBackend = spawnEnvBackend(edgeStash)
  assert.equal(edgeBackend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] })['EDGE_KEY'], 'edge-value')
  assert.throws(
    () => edgeBackend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
})

// ---------------------------------------------------------------------------
// 3. Herdr 窗格与 Gate 机密授权及 workflow journal 指纹
// ---------------------------------------------------------------------------

class SecretPaneFakeTransport implements HerdrTransport {
  panes = new Map<string, { paneId: string; tabId: string; status: string; seq: number; cwd: string; name?: string }>()
  tabEnvs: Array<Record<string, string>> = []
  gateEnvs: Array<Record<string, string>> = []
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  onPrompted?: () => void

  private infoOf(p: { paneId: string; tabId: string; status: string; seq: number; cwd: string; name?: string }) {
    return {
      pane_id: p.paneId,
      tab_id: p.tabId,
      workspace_id: 'ws',
      agent_status: p.status,
      interactive_ready: p.status !== 'unknown',
      state_change_seq: p.seq,
      cwd: p.cwd,
      ...(p.name !== undefined ? { name: p.name } : {}),
    }
  }

  async call(_target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'tab.create') {
      const n = this.panes.size + 1
      const paneId = `ws:p${n}`
      this.panes.set(paneId, { paneId, tabId: `ws:t${n}`, status: 'idle', seq: 1, cwd: (params['cwd'] as string) ?? '/tmp' })
      this.tabEnvs.push((params['env'] as Record<string, string>) ?? {})
      return { type: 'tab_created', tab: { tab_id: `ws:t${n}`, workspace_id: 'ws' }, root_pane: { pane_id: paneId, workspace_id: 'ws', tab_id: `ws:t${n}` } }
    }
    const id = String(params['pane_id'] ?? params['target'] ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    if (method === 'agent.start') {
      pane.name = params['name'] as string
      pane.status = 'idle'
      return { type: 'agent_started', argv: [], agent: this.infoOf(pane) }
    }
    if (method === 'agent.wait' || method === 'agent.get') return { type: 'agent_info', agent: this.infoOf(pane) }
    if (method === 'agent.prompt') {
      pane.status = 'done'
      pane.seq += 1
      this.onPrompted?.()
      const fileName = (params['text'] as string).match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
      mkdirSync(join(pane.cwd, '.helm'), { recursive: true })
      writeFileSync(join(pane.cwd, '.helm', fileName), 'herdr-done')
      return { type: 'agent_prompted', agent: this.infoOf(pane) }
    }
    if (method === 'agent.read') return { type: 'pane_read', read: { pane_id: pane.paneId, text: 'tail' } }
    if (method === 'tab.close') return { type: 'ok' }
    throw new HelmError('method_not_found', `fake: ${method}`, 400)
  }
  async readOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    return readFileSync(join(cwd, '.helm', fileName), 'utf8')
  }
  async removeOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    rmSync(join(cwd, '.helm', fileName), { force: true })
  }
  async runGate(_t: HerdrTarget, _cmd: string, _cwd: string, _sig: AbortSignal | undefined, env?: Record<string, string>) {
    this.gateEnvs.push(env ?? {})
    return { ok: true, output: 'gate ok' }
  }
  async subscribe() { return () => {} }
}

function makePaneEnv(dataDir: string, options: { clock?: () => number; onPrompted?: () => void } = {}) {
  const transport = new SecretPaneFakeTransport()
  transport.onPrompted = options.onPrompted
  const stash = options.clock !== undefined ? new SecretStash({ now: options.clock }) : new SecretStash()
  stash.put(7, 'DEPLOY_TOKEN', 'secret-deploy-7')
  stash.put(7, 'API_KEY', 'secret-api-7')
  const spawnBackend = spawnEnvBackend(stash, { token: 'managed-token', nodeHubUrl: 'http://10.0.0.5:3202' })
  const profiles = new Map<string, Profile>([[
    'ci-runner',
    { id: 'ci-runner', runtime: { kind: 'herdr', agent: 'agy', nodeId: 'node-a', env: { CI_FLAG: 'profile-yes', DEPLOY_TOKEN: 'profile-deploy', HELM_CWD: '/hijack' } } } as Profile,
  ]])
  let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [] }
  const registry = new PaneRegistry({ get: () => doc, set: (next) => { doc = next } }, doc)
  const host: ExecutorHost = {
    parentCwdOf: () => dataDir,
    parentNodeIdOf: () => undefined,
    askConversationId: (id) => id,
    notify: () => undefined,
    startupTimeoutMs: () => 5_000,
    createAsk: (() => { throw new Error('unused') }) as never,
    cancelAsk: (() => { throw new Error('unused') }) as never,
  }
  const executor = new HerdrExecutor(
    {
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (id, cwd, nodeId, opts) => spawnBackend.buildSpawnEnv(id, cwd, nodeId, opts),
      redact: (t) => stash.redact(t),
      runLocalGate: async () => ({ ok: true, output: 'gate ok' }),
      nodeChannel: {
        isOnline: () => true,
        getNodeHubUrl: () => 'http://10.0.0.5:3202',
        ipcCall: () => { throw new Error('unused') },
        envFor: () => { throw new Error('unused') },
      },
      transport,
    },
    registry,
    new AskCoordinator(() => undefined),
    new MetadataProjector(async () => ({}), () => undefined),
    host,
    transport,
    {},
    10,
  )
  return { executor, transport, stash }
}

test('Herdr 窗格与 Gate 机密最小授权、轮换重取、TTL 过期拒跑、跨任务隔离与 workflow journal 指纹', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-herdr-paneenv-')
  const env = makePaneEnv(dir)

  // 1. 默认无业务机密，保留 Profile 同名值与受管 HELM_*（含节点可达 hubUrl），建窗前拒绝缺失机密
  await assert.rejects(
    env.executor.handle({ parentConversationId: 7, prompt: 'deploy', agentType: 'ci-runner', secretNames: ['NOT_IN_STASH'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
  assert.equal(env.transport.calls.length, 0)

  await env.executor.handle({ parentConversationId: 7, prompt: 'deploy', agentType: 'ci-runner' })
  const env0 = env.transport.tabEnvs[0]!
  assert.equal(env0['API_KEY'], undefined)
  assert.equal(env0['DEPLOY_TOKEN'], 'profile-deploy')
  assert.equal(env0['CI_FLAG'], 'profile-yes')
  assert.notEqual(env0['HELM_CWD'], '/hijack')
  assert.equal(env0['HELM_DATA_DIR'], undefined)
  assert.equal(env0['HELM_HUB_URL'], 'http://10.0.0.5:3202')
  assert.equal(env0['HELM_TOKEN'], 'managed-token')

  // 2. 显式授权覆盖 Profile 同名值（含 __proto__）+ Gate 轮换重取 + 后续任务不沿用旧授权
  env.stash.put(7, '__proto__', 'pane-prototype-named-secret')
  env.transport.onPrompted = () => {
    env.stash.put(7, 'DEPLOY_TOKEN', 'rotated-value')
    env.transport.onPrompted = undefined
  }
  await env.executor.handle({
    parentConversationId: 7,
    prompt: 'deploy with grant',
    agentType: 'ci-runner',
    gate: 'true',
    secretNames: ['DEPLOY_TOKEN', '__proto__'],
  })
  const env1 = env.transport.tabEnvs[1]!
  assert.equal(env1['DEPLOY_TOKEN'], 'secret-deploy-7')
  assert.equal(env1['API_KEY'], undefined)
  assert.equal(Object.hasOwn(env1, '__proto__'), true)
  assert.equal(env.transport.gateEnvs[0]!['DEPLOY_TOKEN'], 'rotated-value')
  assert.equal(env.transport.gateEnvs[0]!['CI_FLAG'], 'profile-yes')

  await env.executor.handle({ parentConversationId: 7, prompt: 'deploy without grant', agentType: 'ci-runner', gate: 'true' })
  assert.equal(env.transport.gateEnvs[1]!['DEPLOY_TOKEN'], 'profile-deploy')

  // 3. 任务期间 TTL 过期时 Gate 启动前 404 拒绝（零 Gate 副作用）
  const clock = { ms: 10_000 }
  const ttlEnv = makePaneEnv(useTempDir(t, 'helm-herdr-panettl-'), {
    clock: () => clock.ms,
    onPrompted: () => { clock.ms += 100 },
  })
  ttlEnv.stash.put(7, 'SHORT_TTL', 'short-lived', { ttlMs: 50 })
  await assert.rejects(
    ttlEnv.executor.handle({ parentConversationId: 7, prompt: 'deploy', agentType: 'ci-runner', gate: 'true', secretNames: ['SHORT_TTL'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
  assert.equal(ttlEnv.transport.gateEnvs.length, 0)

  // 4. workflow journal 指纹感知 secretNames
  const base = { prompt: 'p', agentType: 'ci-runner' }
  const without = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base, secretNames: undefined }), without)
  const withDeploy = agentJournalKey({ ...base, secretNames: ['DEPLOY_TOKEN'] })
  assert.notEqual(withDeploy, without)
  assert.notEqual(agentJournalKey({ ...base, secretNames: ['API_KEY'] }), withDeploy)
})

// ---------------------------------------------------------------------------
// 4. createHelm 真实回合结算、原生执行行诚实拒绝与插件配置 HTTP 动态机密隔离
// ---------------------------------------------------------------------------

test('createHelm 真实回合结算（completed/failed/aborted + late hook）与原生 spawn 非空 secretNames 诚实拒绝', { timeout: 60_000 }, async () => {
  const env = await openHubTestEnv({
    prefix: 'helm-secret-turnsettle-',
    fauxOptions: { tokensPerSecond: 1, tokenSize: { min: 4, max: 4 } },
  })
  try {
    const { kernel, faux } = env
    const stash = kernel.services.stash
    const outcomes: string[] = []
    let latePut = false
    await kernel.plugins.register({
      id: 'test:secret-settle-probe',
      name: 'secret compute probe needle',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          outcomes.push(payload.outcome)
          if (!latePut) {
            latePut = true
            stash.put(payload.conversation.id, 'LATE_HOOK_KEY', `late-${payload.conversation.id}`, { scope: 'turn' })
          }
        })
      },
    } satisfies PluginDefinition)

    const conv = await kernel.createConversation({ title: 'secret turn' })
    stash.put(conv.id, 'TURN_TOKEN', 'turn-tok-value', { scope: 'turn' })
    stash.put(conv.id, 'SESSION_TOKEN', 'session-tok-value')
    faux.setResponses([fauxAssistantMessage('complete')])
    await kernel.submitInput(conv.id, 'q1')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 1, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(outcomes[0], 'completed')
    assert.equal(stash.has(conv.id, 'TURN_TOKEN'), false)
    assert.equal(stash.has(conv.id, 'SESSION_TOKEN'), true)
    assert.equal(stash.envFor(conv.id)['LATE_HOOK_KEY'], `late-${conv.id}`)
    assert.equal(stash.redact('turn-tok-value').includes('turn-tok-value'), false)

    faux.setResponses([fauxAssistantMessage('ok2')])
    await kernel.submitInput(conv.id, 'q2')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 2, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(conv.id, 'LATE_HOOK_KEY'), false)

    const failed = await kernel.createConversation({ title: 'failed turn' })
    stash.put(failed.id, 'FAIL_TURN', 'fail-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('boom', { stopReason: 'error' })])
    await kernel.submitInput(failed.id, 'fail')
    await kernel.waitForIdle(failed.id)
    await waitFor(() => outcomes.includes('failed'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(failed.id, 'FAIL_TURN'), false)
    assert.equal(stash.redact('fail-secret').includes('fail-secret'), false)

    const abortedConv = await kernel.createConversation({ title: 'abort turn' })
    stash.put(abortedConv.id, 'ABORT_TURN', 'abort-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('long streaming text to ensure abort happens while turn is still streaming in flight')])
    await kernel.submitInput(abortedConv.id, 'abort')
    await kernel.abortConversation(abortedConv.id)
    await kernel.waitForIdle(abortedConv.id)
    await waitFor(() => outcomes.includes('aborted'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(abortedConv.id, 'ABORT_TURN'), false)
    assert.equal(stash.redact('abort-secret').includes('abort-secret'), false)

    // 原生执行行：非空 secretNames 显式 unsupported_secret_grant，空数组等价未授权正常执行
    stash.put(1, 'NATIVE_KEY', 'native-secret')
    await assert.rejects(
      kernel.spawnAgent({ parentConversationId: 1, prompt: 'grant', agentType: 'assistant', secretNames: ['NATIVE_KEY'] }),
      (e: unknown) => e instanceof HelmError && e.code === 'unsupported_secret_grant',
    )
    faux.setResponses([fauxAssistantMessage('ok')])
    assert.equal(await kernel.spawnAgent({ parentConversationId: 1, prompt: 'empty grant', secretNames: [] }), 'ok')
  } finally {
    await env.close()
  }
})

test('插件配置 HTTP 在重启与停用时均隐藏动态机密并保持已声明配置掩码', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-config-namespace-')
  const pluginId = 'test:dynamic-credentials'
  const dynamicSecret = 'dynamic-hook-signing-key-7e4a'
  const configSecret = 'declared-config-key-94b2'
  const credentials = new CredentialService(dataDir)
  await credentials.setPluginSecret(pluginId, 'webhook:demo', dynamicSecret)
  await credentials.setPluginSecret(pluginId, 'apiKey', configSecret)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    try {
      await app.kernel.plugins.register({
        id: pluginId,
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true },
            retries: { type: 'number', default: 3 },
          })
        },
      }, { enabled: false })
      const credential = app.kernel.auth.createProcessToken()
      try {
        const handler = createHubHandler(app.kernel)
        const response = await handler(new Request(`http://localhost/api/plugins/${encodeURIComponent(pluginId)}/config`, {
          headers: { authorization: `Bearer ${credential.token}` },
        }))
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.ok(!body.includes(dynamicSecret) && !body.includes('webhook:demo') && !body.includes(configSecret))
        const parsed = JSON.parse(body) as { values: Record<string, unknown> }
        assert.equal(parsed.values.apiKey, '******')
        assert.equal(Object.hasOwn(parsed.values, 'webhook:demo'), false)
      } finally {
        credential.dispose()
      }
    } finally {
      await app.close()
    }
  }
})
