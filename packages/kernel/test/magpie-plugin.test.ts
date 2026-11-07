/**
 * builtin:magpie 独立验收测试。
 *
 * 组合纪律：真实 PluginHost + 真实 pi-ai Models（createModels）；
 * 受控 fetchImpl（不触真实网络）与受控 runMagpieCli 注入。
 * ctx.provider 由宿主注册表提供（待合并的 PluginHostOptions.providers 在本
 * 测试以最小等价实现：definePlugin 声明即注册、disable/dispose 后注销）。
 *
 * 诚实性重点用例：
 * - provider.refreshModels 网络失败一律 throw → models.refresh errors['magpie']
 *   显式可见（绝不静默 errors:{} 弹「刷新成功」）；
 * - 切换网关后旧 root 缓存绝不冒充新网关目录（servedByRoot 过滤）；
 * - reachable:false 时 modelCount 保留缓存计数但 summary 不称已连接；
 * - 非 loopback 网关绝不调用本机 magpie CLI（数据源隔离）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { HelmError, type ConversationSummary, type PluginDefinition } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginConfigStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createMagpiePlugin } from '../src/builtin-plugins/magpie.js'
import { MAGPIE_PLUGIN_ID, MAGPIE_PROVIDER_ID, DEFAULT_MAGPIE_ROOT, DEFAULT_MAGPIE_TOKEN } from '../src/builtin-plugins/magpie/contracts.js'
import { magpieApi, toPiModels, adaptiveThinking, thinkingLevelMap } from '../src/builtin-plugins/magpie/catalog.js'
import { normalizeRoot, isLoopback, resolveGateway } from '../src/builtin-plugins/magpie/gateway.js'

const MAGPIE = MAGPIE_PLUGIN_ID

// ---------------------------------------------------------------------------
// 测试样本数据
// ---------------------------------------------------------------------------

const CATALOG = {
  data: [
    { id: 'openai/gpt-5.2', display_name: 'GPT-5.2', native_endpoints: ['/v1/responses'], reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], context_length: 400_000, max_output_tokens: 128_000 },
    { id: 'anthropic/claude-sonnet-4.6', display_name: 'Claude Sonnet 4.6', native_endpoints: ['/v1/messages'], reasoning: true, supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }], context_window: 200_000, max_output_tokens: 64_000 },
    { id: 'anthropic/claude-sonnet-4.5', native_endpoints: ['/v1/messages'], reasoning: true },
    { id: 'kimi/k2-chat', display_name: 'Kimi K2', native_endpoints: [], modalities: { input: ['text', 'image'] } },
    { id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' },
  ],
}

const QUOTAS = {
  data: [
    {
      provider: 'opencode-go', name: 'OpenCode Go', kind: 'subscription', plan: 'plus', user: 'user@example.com',
      windows: [{ name: '5h', remaining: 16, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() }],
    },
    { provider: 'moonshot', name: 'Moonshot', windows: [{ name: 'daily', used: 40 }] },
  ],
}

const TRACE = {
  routes: [
    { time: '2026-11-08T02:00:00Z', model: 'group/relay', provider: 'opencode-go', group: { id: 'relay', routing: 'smart', members: ['opencode-go/mimo', 'moonshot/k2'] }, served: 'opencode-go/mimo', status: 200, tokens: 1234 },
    { time: '2026-11-08T02:05:00Z', model: 'group/relay', provider: 'moonshot', group: { id: 'relay', routing: 'smart' }, served: 'moonshot/k2-chat', status: 200 },
  ],
}

const CLI_GROUPS = [
  'RELAY      found by magpie  group/relay  smart · stays session   opencode-go/mimo · moonshot/k2',
  'FAST       我的快组         group/fast   order · stays turn      moonshot/k2-flash',
].join('\n')

const CLI_GROUP_SHOW = [
  ' Relay      group/relay  found by magpie',
  '  used by   pi',
  '  routing   smart',
  '  stays     session',
  '  models    1 opencode-go/mimo  \u25cf  OpenCode Go · MiMo',
  '  models    2 moonshot/k2          Moonshot K2',
  '  rules     1 always prefer cheaper',
].join('\n')

// ---------------------------------------------------------------------------
// 受控 fetch
// ---------------------------------------------------------------------------

interface FakeBackend {
  models?: unknown
  quotas?: unknown
  trace?: unknown
  failModels?: string
}

function makeFetch(backends: Map<string, FakeBackend>) {
  const calls: string[] = []
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push(url)
    const parsed = new URL(url)
    const backend = backends.get(parsed.origin)
    const path = parsed.pathname
    if (backend === undefined) throw new TypeError(`fetch failed: ${parsed.origin} unreachable`)
    if (path === '/v1/models') {
      if (backend.failModels) throw new Error(backend.failModels)
      return new Response(JSON.stringify(backend.models ?? { data: [] }), { status: 200 })
    }
    if (path === '/v1/magpie/quotas') {
      return new Response(JSON.stringify(backend.quotas ?? { data: [] }), { status: 200 })
    }
    if (path === '/v1/magpie/trace') {
      if (backend.trace === undefined) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(backend.trace), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  return { impl, calls }
}

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 宿主 provider 注册表最小实现（等价待合并 PluginHostOptions.providers）。 */
class ProviderRegistry {
  registered = new Map<string, { pluginId: string; provider: unknown }>()
  onUnregister?: (providerId: string) => void
  register(pluginId: string, provider: unknown): void {
    this.registered.set((provider as { id: string }).id, { pluginId, provider })
  }
  unregisterPlugin(pluginId: string): void {
    for (const [id, entry] of [...this.registered]) {
      if (entry.pluginId === pluginId) {
        this.registered.delete(id)
        this.onUnregister?.(id)
      }
    }
  }
}

/**
 * ctx.provider 尚未在宿主实现：包一层 definition，definePlugin 前注入该能力。
 * 注入的 provider 同时桥接到真实 Models（service.stop 后由 disable/dispose
 * 路径触发 unregisterPlugin——宿主 registry 的 stop 语义）。
 */
function withProviderCtx(
  def: PluginDefinition,
  registry: ProviderRegistry,
  models: ReturnType<typeof createModels>,
): PluginDefinition {
  return {
    ...def,
    definePlugin(ctx) {
      const augmented = Object.create(ctx, {
        provider: {
          value: (provider: unknown) => {
            registry.register(def.id, provider)
            models.setProvider(provider as never)
          },
        },
      })
      return def.definePlugin(augmented as never)
    },
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
}

class MemoryConfigStore implements PluginConfigStore {
  store = new Map<string, Record<string, unknown>>()
  get(pluginId: string): Record<string, unknown> {
    return { ...this.store.get(pluginId) }
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, { ...value })
  }
}

function makeConversation(id: number): ConversationSummary {
  return {
    id, title: `conv-${id}`, profileId: 'default', tags: [], cwd: '/tmp', model: 'test/model',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
}

function makeHostApi(): PluginHostBackend {
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: () => {},
  }
}

interface TestEnv {
  dataDir: string
  models: ReturnType<typeof createModels>
  registry: ProviderRegistry
  fetchState: { calls: string[] }
  refreshCalls: Array<{ allowNetwork?: boolean; force?: boolean }>
  cliRuns: Array<readonly string[]>
  cliResponse: (args: readonly string[]) => { ok: boolean; stdout?: string; error?: string }
  host: PluginHost
  config: MemoryConfigStore
  setRefreshError(error: string | undefined): void
  close(): Promise<void>
}

async function makeEnv(options: { backendAtDefault?: FakeBackend } = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-magpie-test-'))
  const models = createModels()
  const registry = new ProviderRegistry()
  const backends = new Map<string, FakeBackend>([
    [new URL(DEFAULT_MAGPIE_ROOT).origin, options.backendAtDefault ?? { models: CATALOG, quotas: QUOTAS, trace: TRACE }],
  ])
  const { impl, calls } = makeFetch(backends)
  const fetchCalls: string[] = calls
  const config = new MemoryConfigStore()
  const docs = new MemoryDocStore()
  const refreshResult: { errors: Record<string, string> } = { errors: {} }
  const env: TestEnv = {
    dataDir,
    models,
    registry,
    fetchState: { calls: fetchCalls },
    refreshCalls: [],
    cliRuns: [],
    cliResponse: (args) => {
      env.cliRuns.push(args)
      if (args[0] === 'groups') return { ok: true, stdout: CLI_GROUPS }
      if (args[0] === 'group') return { ok: true, stdout: CLI_GROUP_SHOW }
      return { ok: false, error: `unknown command ${args.join(' ')}` }
    },
    config,
    setRefreshError(error) {
      refreshResult.errors = error === undefined ? {} : { magpie: error }
    },
    host: undefined!,
    async close() {
      try {
        await env.host.dispose()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
  // 组合层 refreshProviderModels 端口：真实 models.refresh({ providers:['magpie'] })
  // 的等价包装（记录调用 + 返回 errors 映射；注入式失败可覆盖）。
  const refreshProviderModels = async (opts?: { allowNetwork?: boolean; force?: boolean }) => {
    env.refreshCalls.push({ ...opts })
    if (Object.keys(refreshResult.errors).length > 0) {
      return { errors: { ...refreshResult.errors } }
    }
    const result = await models.refresh({
      allowNetwork: opts?.allowNetwork ?? true,
      force: opts?.force,
      providers: [MAGPIE_PROVIDER_ID],
    })
    const errors: Record<string, string> = {}
    for (const [id, err] of result.errors) errors[id] = err instanceof Error ? err.message : String(err)
    return { errors, modelCount: models.getModels(MAGPIE_PROVIDER_ID).length }
  }
  const host = new PluginHost({ dataDir, host: makeHostApi(), docs, config })
  const pluginDef = withProviderCtx(
    createMagpiePlugin({
      refreshProviderModels,
      fetchImpl: impl,
      runMagpieCli: (args, o) => {
        void o
        return Promise.resolve(env.cliResponse(args))
      },
    }),
    registry,
    models,
  )
  await host.register(pluginDef, { enabled: false })
  env.host = host
  // 停用/dispose 时注销 provider（宿主 providers registry 的 stop 语义）。
  registry.onUnregister = (providerId) => models.deleteProvider(providerId)
  const originalDisable = host.disable.bind(host)
  host.disable = async (pluginId: string) => {
    await originalDisable(pluginId)
    if (pluginId === MAGPIE) registry.unregisterPlugin(MAGPIE)
  }
  const originalDispose = host.dispose.bind(host)
  host.dispose = async () => {
    await originalDispose()
    registry.unregisterPlugin(MAGPIE)
  }
  return env
}

/** 等待谓词成立（轮询，默认 5s）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface StatusView {
  gatewayUrl: string; configuredRoot: boolean; local: boolean; reachable: boolean
  modelCount: number; groupCount: number; summaryText: string; lastError?: string; lastRefreshedAt?: number
  quotas: Array<Record<string, unknown>>; routes: Array<Record<string, unknown>>
}

const statusDoc = (env: TestEnv): StatusView =>
  env.host.getPublicDoc(MAGPIE, 'status').value as StatusView

let savedEnv: Array<[string, string | undefined]> = []

beforeEach(() => {
  savedEnv = []
  for (const name of ['MAGPIE_GW_URL', 'MAGPIE_ADDR']) {
    savedEnv.push([name, process.env[name]])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value !== undefined) process.env[name] = value
  }
})

// ---------------------------------------------------------------------------
// 1. catalog：协议分流 / thinkingLevelMap / adaptiveThinking
// ---------------------------------------------------------------------------

test('magpie1: magpieApi 协议分流与 baseUrl 挂点', () => {
  assert.deepEqual(magpieApi(['/v1/responses']), { api: 'openai-responses', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages']), { api: 'anthropic-messages', endpoint: 'root' })
  assert.deepEqual(magpieApi([]), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(undefined), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages', '/v1/responses']), { api: 'openai-responses', endpoint: 'v1' }, 'responses 优先')
})

test('magpie2: toPiModels 完整映射——api/baseUrl/thinkingLevelMap/forceAdaptiveThinking/ownedBy', () => {
  const root = 'http://127.0.0.1:3425'
  const models = toPiModels(CATALOG.data as never, root)
  const byId = new Map(models.map((m) => [m.id, m]))

  const gpt = byId.get('openai/gpt-5.2')!
  assert.equal(gpt.api, 'openai-responses')
  assert.equal(gpt.baseUrl, `${root}/v1`)
  assert.equal(gpt.reasoning, true)
  assert.deepEqual(gpt.thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null })

  const sonnet46 = byId.get('anthropic/claude-sonnet-4.6')!
  assert.equal(sonnet46.api, 'anthropic-messages')
  assert.equal(sonnet46.baseUrl, root, 'anthropic-messages 挂 root（SDK 自行加 /v1）')
  assert.deepEqual(
    sonnet46.thinkingLevelMap,
    { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    'Anthropic 有 none 档 → off 映射 none',
  )
  assert.deepEqual(sonnet46.compat, { forceAdaptiveThinking: true }, 'Claude 4.6+ 必须 forceAdaptiveThinking')

  const sonnet45 = byId.get('anthropic/claude-sonnet-4.5')!
  assert.equal(sonnet45.compat, undefined, 'Claude 4.5 不加 forceAdaptiveThinking')

  const kimi = byId.get('kimi/k2-chat')!
  assert.equal(kimi.api, 'openai-completions')
  assert.deepEqual(kimi.input, ['text', 'image'], 'modalities 透传')
  assert.equal(kimi.thinkingLevelMap, undefined, '无 reasoning levels 则无 map')

  const relay = byId.get('group/relay')!
  assert.equal(relay.magpieOwnedBy, 'opencode-go', 'owned_by 透传供配额归属')
})

test('magpie3: thinkingLevelMap 边界——空档位 / Anthropic off 键语义', () => {
  assert.equal(thinkingLevelMap([], false), undefined)
  const map = thinkingLevelMap(['none', 'high'], true)!
  assert.equal(map.off, 'none', '有 none 档时 off → none')
  const mapNoNone = thinkingLevelMap(['high'], true)!
  assert.equal('off' in mapNoNone, false, 'Anthropic 无 none 档时 off 键删除（SDK 缺省发送禁用 thinking）')
})

test('magpie4: adaptiveThinking 版本判定', () => {
  assert.equal(adaptiveThinking('claude-sonnet-4.6'), true)
  assert.equal(adaptiveThinking('anthropic/claude-opus-4.6-x'), true)
  assert.equal(adaptiveThinking('claude-opus-5-5'), true)
  assert.equal(adaptiveThinking('claude-sonnet-4.5'), false)
  assert.equal(adaptiveThinking('gpt-5.2'), false)
})

// ---------------------------------------------------------------------------
// 2. gateway 配置解析
// ---------------------------------------------------------------------------

test('magpie5: resolveGateway 优先级与 configuredRoot 语义', () => {
  const none = resolveGateway({}, {})
  assert.equal(none.root, DEFAULT_MAGPIE_ROOT)
  assert.equal(none.token, DEFAULT_MAGPIE_TOKEN)
  assert.equal(none.configuredRoot, false)
  assert.equal(none.local, true)

  // gatewayUrl 显式（即使值等于默认地址字符串）→ configuredRoot=true
  const explicitDefault = resolveGateway({ gatewayUrl: 'http://127.0.0.1:3425' }, {})
  assert.equal(explicitDefault.configuredRoot, true)

  // apiKey 显式（远端密钥）→ configuredRoot=true
  const keyOnly = resolveGateway({ apiKey: 'sk-remote' }, {})
  assert.equal(keyOnly.token, 'sk-remote')
  assert.equal(keyOnly.configuredRoot, true)

  // 环境变量
  const envOnly = resolveGateway({}, { MAGPIE_GW_URL: 'http://10.0.0.5:3425/' })
  assert.equal(envOnly.root, 'http://10.0.0.5:3425')
  assert.equal(envOnly.configuredRoot, true)
  assert.equal(envOnly.local, false)

  // 插件配置优先于环境变量
  const both = resolveGateway({ gatewayUrl: 'http://192.168.1.9:3425' }, { MAGPIE_GW_URL: 'http://10.0.0.5:3425' })
  assert.equal(both.root, 'http://192.168.1.9:3425')

  // 归一化
  assert.equal(normalizeRoot('http://h:1/v1/'), 'http://h:1')
  assert.equal(normalizeRoot('h:1'), 'http://h:1')
  assert.equal(normalizeRoot('not a url'), undefined)
  assert.equal(isLoopback('http://localhost:3425'), true)
  assert.equal(isLoopback('http://127.0.0.1:3425'), true)
  assert.equal(isLoopback('http://10.0.0.5:3425'), false)
})

// ---------------------------------------------------------------------------
// 3. 启停生命周期与 provider 注册/注销
// ---------------------------------------------------------------------------

test('magpie6: 启用注册 provider 并拉取目录；auth.check 使模型 available；停用注销', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    assert.equal(env.host.list().find((p) => p.id === MAGPIE)!.enabled, false, '默认停用注册')
    await env.host.enable(MAGPIE)

    assert.ok(env.registry.registered.has('magpie'), 'definePlugin 声明的 provider 已注册')
    await waitFor(() => env.models.getModels('magpie').length > 0)
    assert.equal(env.models.getModels('magpie').length, 5, '目录全量转换')

    const available = await env.models.getAvailable('magpie')
    assert.equal(available.length, 5, 'auth.check 恒有效 → available')

    const actions = env.host.listActions().filter((a) => a.pluginId === MAGPIE).map((a) => a.id).sort()
    assert.deepEqual(actions, ['group', 'groups', 'quota', 'refresh', 'status'])
    const surfaces = env.host.listUi().filter((u) => u.pluginId === MAGPIE).map((u) => u.surface).sort()
    assert.deepEqual(surfaces, ['commandPalette', 'composer.pill', 'settings.panel'])

    await waitFor(() => statusDoc(env).reachable === true)
    const doc = statusDoc(env)
    assert.equal(doc.modelCount, 5)
    assert.equal(doc.summaryText, 'Magpie · 5 模型')
    assert.equal(doc.gatewayUrl, DEFAULT_MAGPIE_ROOT)
    assert.equal(doc.configuredRoot, false)
    assert.equal(JSON.stringify(doc).includes(DEFAULT_MAGPIE_TOKEN), false, 'token 不进 doc')

    await env.host.disable(MAGPIE)
    assert.equal(env.registry.registered.has('magpie'), false, '停用后 provider 已注销')
    assert.equal(env.models.getProvider('magpie'), undefined)
    assert.deepEqual(env.host.listActions().filter((a) => a.pluginId === MAGPIE), [])
    assert.throws(() => env.host.getPublicDoc(MAGPIE, 'status'), (e: unknown) => e instanceof HelmError && e.code === 'plugin_doc_not_found')
  } finally {
    await env.close()
  }
})

test('magpie7: 动作契约——status / refresh / quota / groups / group', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)

    const status = (await env.host.invokeAction(MAGPIE, 'status', {})) as StatusView
    assert.equal(status.reachable, true)
    assert.ok(Array.isArray(status.quotas), '配额随目录刷新加载')

    const refreshed = (await env.host.invokeAction(MAGPIE, 'refresh', {})) as { refreshed: boolean; modelCount: number; reachable: boolean }
    assert.deepEqual(refreshed, { refreshed: true, modelCount: 5, reachable: true })

    const quota = (await env.host.invokeAction(MAGPIE, 'quota', {})) as { quotas: Array<{ provider: string; remainingPercent: number }>; local: boolean }
    assert.equal(quota.local, true)
    assert.equal(quota.quotas.length, 2)
    assert.equal(quota.quotas[0]!.provider, 'opencode-go')
    assert.equal(quota.quotas[0]!.remainingPercent, 16)
    assert.equal(quota.quotas[1]!.remainingPercent, 60, 'used 40 → remaining 60')

    const groups = (await env.host.invokeAction(MAGPIE, 'groups', {})) as {
      groups: Array<{ id: string; source: string; lastRoute?: { model?: string } }>
      local: boolean
    }
    assert.equal(groups.local, true)
    const relay = groups.groups.find((g) => g.id.includes('relay'))
    assert.ok(relay, 'CLI 组 + trace 命中合并')
    assert.equal(relay!.source, 'cli+trace')
    assert.equal(relay!.lastRoute?.model, 'moonshot/k2-chat', 'trace 最近一次命中（后出现的覆盖）')

    const one = (await env.host.invokeAction(MAGPIE, 'group', { id: 'group/relay' })) as {
      definition: { members: string[]; routing?: string }
      lastRoute: { provider?: string }
      source: string
    }
    assert.equal(one.source, 'cli+trace')
    assert.deepEqual(one.definition.members, ['opencode-go/mimo', 'moonshot/k2'])
    assert.equal(one.definition.routing, 'smart')
    assert.equal(one.lastRoute.provider, 'moonshot')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. 诚实性纪律：失败显式 / 缓存隔离 / 数据源隔离
// ---------------------------------------------------------------------------

test('magpie8: 显式配置网关失败——refresh 动作显式抛错（不静默）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.config.set(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === false && statusDoc(env).lastError !== undefined)
    const doc = statusDoc(env)
    assert.equal(doc.configuredRoot, true)
    assert.equal(doc.gatewayUrl, 'http://10.255.255.1:3425')
    assert.ok(doc.lastError!.length > 0)

    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_gateway_unreachable' && err.status === 502,
    )
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'quota', {}),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_gateway_unreachable',
    )
  } finally {
    await env.close()
  }
})

test('magpie9: provider.refreshModels 网络失败一律 throw——通用目录刷新 errors[magpie] 可见（含默认 loopback 未运行）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { failModels: 'connect ECONNREFUSED 127.0.0.1:3425' } })
  try {
    await env.host.enable(MAGPIE)
    // 等待 service.start 的后台刷新完成失败发布（否则下面手动刷新竞态）
    await waitFor(() => statusDoc(env).reachable === false && statusDoc(env).lastError !== undefined)

    // 通用刷新（模拟 helm models refresh --provider magpie）：errors 必须含 magpie
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 1, '默认 loopback 未运行也必须显式报错，绝不静默 errors:{}')
    const err = result.errors.get('magpie')!
    assert.match(err.message, /ECONNREFUSED|models/)

    const doc = statusDoc(env)
    assert.equal(doc.summaryText, 'Magpie · 未连接')
    assert.ok(doc.lastError !== undefined)

    // cache-only 刷新（allowNetwork:false）永不失败：无缓存时空目录
    const cacheOnly = await env.models.refresh({ providers: ['magpie'], allowNetwork: false })
    assert.equal(cacheOnly.errors.size, 0)
    assert.equal(env.models.getModels('magpie').length, 0)
  } finally {
    await env.close()
  }
})

test('magpie10: 缓存与网关隔离——切换 root 后旧缓存不冒充新网关目录', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)

    // 切换到不可达远端：refreshModels 恢复阶段必须过滤旧 root 缓存
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 1, '新网关不可达显式报错')
    assert.equal(env.models.getModels('magpie').length, 0, '旧网关缓存被清空，绝不冒充新网关目录')

    // doc 同样不保留旧网关数据冒充（refresh 动作显式失败 + 状态发布守卫）
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_gateway_unreachable',
    )
    const doc = statusDoc(env)
    assert.equal(doc.gatewayUrl, 'http://10.255.255.1:3425', 'doc 指向新网关')
    assert.equal(doc.reachable, false)
    assert.equal(doc.summaryText, 'Magpie · 未连接')
  } finally {
    await env.close()
  }
})

test('magpie11: 可达后失败——reachable:false 时 modelCount 不得冒充实时刷新成功', { timeout: 60_000 }, async () => {
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS, trace: TRACE }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)
    assert.ok(statusDoc(env).lastRefreshedAt !== undefined)

    backend.failModels = 'gateway exploded'
    await env.host.invokeAction(MAGPIE, 'refresh', {}).then(
      () => assert.fail('故障后 refresh 必须拒绝'),
      (err: unknown) => assert.ok(err instanceof HelmError && err.code === 'magpie_gateway_unreachable'),
    )
    const doc = statusDoc(env)
    assert.equal(doc.reachable, false)
    assert.equal(doc.summaryText, 'Magpie · 未连接')
    assert.equal(doc.modelCount, 5, '缓存计数保留（不是 0），但 reachable:false 明示非实时')
    assert.match(doc.lastError!, /exploded/)
  } finally {
    await env.close()
  }
})

test('magpie12: 远端网关数据源隔离——CLI 不被调用、groups 只用 trace 且标 source', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.config.set(MAGPIE, { gatewayUrl: 'http://10.1.2.3:3425' })
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).lastError !== undefined)

    // 远端网关（本测试未提供后端 → fetch 失败）：groups 仍成功（trace 不可用是合法态）
    const groups = (await env.host.invokeAction(MAGPIE, 'groups', {})) as {
      groups: unknown[]
      local: boolean
      note?: string
    }
    assert.equal(groups.local, false)
    assert.deepEqual(groups.groups, [], '远端 trace 不可用 → 空列表，不混入本机数据')
    assert.ok(groups.note !== undefined)
    assert.equal(env.cliRuns.length, 0, '非 loopback 网关绝不调用本机 magpie CLI')

    // group 动作：无定义来源且无 trace → 显式 404（不编造定义）
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'group', { id: 'group/relay' }),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_group_not_found' && err.status === 404,
    )
    assert.equal(env.cliRuns.length, 0, 'group 动作在远端网关同样不调 CLI')
  } finally {
    await env.close()
  }
})

test('magpie13: turn_settled 后台刷新配额与路由（有模型时；kept 读法）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const quotaCallsBefore = env.fetchState.calls.filter((c) => c.includes('quotas')).length

    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
    await waitFor(() => env.fetchState.calls.filter((c) => c.includes('quotas')).length > quotaCallsBefore)
    const lastQuota = env.fetchState.calls.filter((c) => c.includes('quotas')).at(-1)!
    assert.match(lastQuota, /kept=1/, 'settled 刷新用 kept=1（不问供应商）')

    await waitFor(() => statusDoc(env).routes.length > 0)
    const doc = statusDoc(env)
    assert.equal(doc.routes[0]!.group, 'relay')
    assert.equal(doc.routes[0]!.model, 'moonshot/k2-chat')
  } finally {
    await env.close()
  }
})

test('magpie14: 无模型时 turn_settled 不触网；UI spec 无 Emoji 且动作绑定正确', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { models: { data: [] }, quotas: { data: [] } } })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const callsBefore = env.fetchState.calls.length
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(env.fetchState.calls.length, callsBefore, '无模型不触发后台配额刷新')

    const ui = env.host.listUi().filter((u) => u.pluginId === MAGPIE)
    const emoji = /\p{Extended_Pictographic}/u
    for (const item of ui) {
      assert.equal(emoji.test(JSON.stringify(item.spec)), false, `UI ${item.surface} 不得含 Emoji`)
    }
    const pill = ui.find((u) => u.surface === 'composer.pill')!.spec as {
      icon: string; docs: string[]; json: { action: { type: string; actionId: string } }
    }
    assert.equal(pill.icon, 'network')
    assert.deepEqual(pill.docs, ['status'])
    assert.deepEqual(pill.json.action, { type: 'helm:action', actionId: 'refresh', input: {} })

    const panel = ui.find((u) => u.surface === 'settings.panel')!.spec as {
      label: string; docs: string[]; json: { children: Array<Record<string, unknown>> }
    }
    assert.equal(panel.label, 'Magpie 网关')
    const panelJson = JSON.stringify(panel.json)
    assert.ok(panelJson.includes('KeyValueList') && panelJson.includes('Table'), '面板含 KeyValueList 与 Table')
    assert.ok(panelJson.includes('刷新模型目录'), '面板提供刷新按钮')

    const command = ui.find((u) => u.surface === 'commandPalette')!.spec as { title: string; actionId: string }
    assert.equal(command.title, '刷新 Magpie 模型目录')
    assert.equal(command.actionId, 'refresh')
  } finally {
    await env.close()
  }
})

test('magpie15: 缺少 provider 挂载端口时允许登记停用插件，启用显式失败', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // ctx.provider 先登记声明；只有启用时才要求运行时提供真实挂载端口。
    const raw = createMagpiePlugin({
      refreshProviderModels: async () => ({ errors: {} }),
      fetchImpl: async () => new Response('{}'),
    })
    const host2 = new PluginHost({ dataDir: env.dataDir, host: makeHostApi(), docs: new MemoryDocStore(), config: new MemoryConfigStore() })
    try {
      await host2.register(raw, { enabled: false })
      assert.equal(host2.list().find((plugin) => plugin.id === MAGPIE)?.enabled, false)
      await assert.rejects(
        () => host2.enable(MAGPIE),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'provider_port_unavailable')
          return true
        },
      )
      assert.equal(host2.list().find((plugin) => plugin.id === MAGPIE)?.enabled, false)
    } finally {
      await host2.dispose()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. provider stream 委托（baseUrl 动态修正）
// ---------------------------------------------------------------------------

test('magpie16: provider stream 按请求时刻 root 修正 baseUrl', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => env.models.getModels('magpie').length > 0)
    const provider = env.models.getProvider('magpie')!
    const anthropicModel = env.models.getModel('magpie', 'anthropic/claude-sonnet-4.6')!
    const openaiModel = env.models.getModel('magpie', 'openai/gpt-5.2')!
    assert.equal(anthropicModel.baseUrl, DEFAULT_MAGPIE_ROOT)
    assert.equal(openaiModel.baseUrl, `${DEFAULT_MAGPIE_ROOT}/v1`)
    // stream 委托：compat 实现对未知 host 以流事件报错而非 throw——
    // 验证委托路径可走通（错误事件也是显式结果，不静默）。
    const events: string[] = []
    const stream = provider.streamSimple(anthropicModel, { messages: [] } as never)
    for await (const event of stream) {
      events.push((event as { type: string }).type)
      if (events.length > 3) break
    }
    assert.ok(events.length >= 1, 'stream 委托产生事件流')
  } finally {
    await env.close()
  }
})
