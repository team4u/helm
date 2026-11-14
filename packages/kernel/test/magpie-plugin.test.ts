/**
 * builtin:magpie 独立验收测试。
 *
 * 组合纪律：真实 PluginHost + 真实 providers 挂载端口（service.start 前
 * 注册 / stop 后注销，与 runtime 相同生命周期）+ 真实 pi-ai Models
 * （createModels）；零参工厂（无 DI 后门）：网络经 mock.method(globalThis,
 * 'fetch')（结束恢复），本机 CLI 经 PATH 前置真实可执行 fixture（execFile
 * 公开环境端口解析），绝不触真实外网 / 真实 magpie。
 *
 * 诚实性重点用例：
 * - provider.refreshModels 网络失败一律 throw → models.refresh errors['magpie']
 *   显式可见（绝不静默 errors:{} 弹「刷新成功」）；
 * - 切换网关后旧 root 缓存绝不冒充新网关目录（servedByRoot 过滤 +
 *   sameGateway 发布守卫：fetch 期间切 root 的挂起结果不发布）；
 * - auth.resolve 冻结 root+token 同一快照（env 携带 MAGPIE_GW_URL）；
 * - reachable:false 时 modelCount 保留缓存计数但 summary 不称已连接；
 * - 非 loopback 网关绝不调用本机 magpie CLI（数据源隔离）；
 * - 配额 / 轨迹读取失败不吞：diagnostics 明确记录不可用原因；
 * - turn_settled 只对 magpie/ 模型会话触发侧读，不阻塞结算。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { mock, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import type { Provider } from '@earendil-works/pi-ai'
import { HelmError, type ConversationSummary } from '@helm/protocol'
import {
  PluginHost,
  type PluginDocStore,
  type PluginConfigStore,
  type PluginHostBackend,
  type PluginProviderPort,
} from '../src/plugins/index.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import { createMagpiePlugin } from '../src/builtin-plugins/magpie.js'
import { compilePluginClientModule } from '../src/plugins/client-compiler.js'
import {
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  DEFAULT_MAGPIE_ROOT,
  DEFAULT_MAGPIE_TOKEN,
} from '../src/builtin-plugins/magpie/contracts.js'
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
// 受控网络（mock.method(globalThis,'fetch')，结束恢复）与真实 CLI fixture
// ---------------------------------------------------------------------------

interface FakeBackend {
  models?: unknown
  quotas?: unknown
  trace?: unknown
  failModels?: string
  failQuotas?: string
  /** 挂起 models 请求（等待 gate 释放）：验证切 root 后旧结果不发布。 */
  gateModels?: Promise<void>
}

/** mock globalThis.fetch：按 origin 分发受控后端（未知 origin 显式 unreachable）。 */
function installFetchMock(backends: Map<string, FakeBackend>): { calls: string[]; restore(): void } {
  const calls: string[] = []
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push(url)
    const parsed = new URL(url)
    const backend = backends.get(parsed.origin)
    const path = parsed.pathname
    if (backend === undefined) throw new TypeError(`fetch failed: ${parsed.origin} unreachable`)
    if (path === '/v1/models') {
      if (backend.gateModels) await backend.gateModels
      if (backend.failModels) throw new Error(backend.failModels)
      return new Response(JSON.stringify(backend.models ?? { data: [] }), { status: 200 })
    }
    if (path === '/v1/magpie/quotas') {
      if (backend.failQuotas) throw new Error(backend.failQuotas)
      return new Response(JSON.stringify(backend.quotas ?? { data: [] }), { status: 200 })
    }
    if (path === '/v1/magpie/trace') {
      if (backend.trace === undefined) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(backend.trace), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const mocked = mock.method(globalThis, 'fetch', impl)
  return { calls, restore: () => mocked.mock.restore() }
}

/**
 * PATH 前置真实可执行 magpie fixture：node 脚本回放固定输出并把每次调用
 * 参数追加到日志文件（execFile 经 PATH 解析，与生产同一公开环境端口）。
 */
function makeCliFixture(binDir: string): { binDir: string; logPath: string } {
  mkdirSync(binDir, { recursive: true })
  const logPath = join(binDir, 'cli-invocations.log')
  const script = [
    '#!/usr/bin/env node',
    `const GROUPS = ${JSON.stringify(CLI_GROUPS)}`,
    `const SHOW = ${JSON.stringify(CLI_GROUP_SHOW)}`,
    'const args = process.argv.slice(2)',
    'const log = process.env.HELM_MAGPIE_CLI_LOG',
    "if (log) require('node:fs').appendFileSync(log, JSON.stringify(args) + '\\n')",
    "if (args[0] === 'groups') { process.stdout.write(GROUPS + '\\n'); process.exit(0) }",
    "if (args[0] === 'group') { process.stdout.write(SHOW + '\\n'); process.exit(0) }",
    "process.stderr.write('unknown command ' + args.join(' '))",
    'process.exit(1)',
  ].join('\n')
  const bin = join(binDir, 'magpie')
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
  return { binDir, logPath }
}

// ---------------------------------------------------------------------------
// 测试基建：真实 providers 端口（挂载即 setProvider，卸载即 deleteProvider）
// ---------------------------------------------------------------------------

/** 真实端口实现：与 runtime 相同语义（register→unregister，禁止伪造）。 */
class ModelsProviderPort implements PluginProviderPort {
  constructor(private readonly models: ReturnType<typeof createModels>) {}
  async register(provider: Provider, _pluginId: string): Promise<() => Promise<void>> {
    this.models.setProvider(provider)
    return async () => {
      this.models.deleteProvider(provider.id)
    }
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
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }

  async flush(): Promise<void> {}
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

function makeConversation(id: number, model = 'test/model'): ConversationSummary {
  return {
    id, title: `conv-${id}`, profileId: 'default', tags: [], cwd: '/tmp', model, thinkingLevel: '',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
}

function makeHostApi(overrides: Partial<PluginHostBackend> = {}): PluginHostBackend {
  return {
    ...hostBackendStub(),
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
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    isClosing: () => false,
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
    emitEvent: () => {},
    ...overrides,
  }
}

interface TestEnv {
  dataDir: string
  models: ReturnType<typeof createModels>
  fetchState: { calls: string[] }
  backends: Map<string, FakeBackend>
  refreshCalls: Array<{ providers?: string[]; allowNetwork?: boolean; force?: boolean }>
  /** 真实 CLI fixture 的调用参数序列（读日志文件）。 */
  cliRuns: Array<readonly string[]>
  host: PluginHost
  config: MemoryConfigStore
  setRefreshError(error: string | undefined): void
  close(): Promise<void>
}

/** makeEnv 内部形态：close 在 host 构建后补挂（返回前已就位）。 */
interface TestEnvInit extends Omit<TestEnv, 'close'> {
  close?(): Promise<void>
}

async function makeEnv(options: { backendAtDefault?: FakeBackend; hostApi?: Partial<PluginHostBackend> } = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-magpie-test-'))
  const models = createModels()
  const backends = new Map<string, FakeBackend>([
    [new URL(DEFAULT_MAGPIE_ROOT).origin, options.backendAtDefault ?? { models: CATALOG, quotas: QUOTAS, trace: TRACE }],
  ])
  const fetchMock = installFetchMock(backends)
  const fetchCalls = fetchMock.calls
  const { binDir, logPath } = makeCliFixture(join(dataDir, 'bin'))
  // PATH 前置 fixture bin：execFile('magpie') 解析到受控脚本（公开环境端口，
  // 无 DI 后门）；调用记录经 HELM_MAGPIE_CLI_LOG 追加到日志文件。
  const savedPath = process.env.PATH
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
  process.env.HELM_MAGPIE_CLI_LOG = logPath
  const readCliRuns = (): Array<readonly string[]> => {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as string[])
    } catch {
      return []
    }
  }
  const config = new MemoryConfigStore()
  const docs = new MemoryDocStore()
  const refreshResult: { errors: Record<string, string> } = { errors: {} }
  const env: TestEnvInit = {
    dataDir,
    models,
    backends,
    fetchState: { calls: fetchCalls },
    refreshCalls: [],
    cliRuns: [],
    config,
    setRefreshError(error) {
      refreshResult.errors = error === undefined ? {} : { magpie: error }
    },
    host: undefined as unknown as PluginHost,
  }
  Object.defineProperty(env, 'cliRuns', {
    get: () => readCliRuns(),
  })
  // 宿主 refreshModels 后端端口：真实 models.refresh({ providers:['magpie'] })
  // 同链路（记录调用 + 返回 errors 映射；注入式失败可覆盖）。
  const hostRefreshModels = async (opts?: { providers?: string[]; allowNetwork?: boolean; force?: boolean }) => {
    env.refreshCalls.push({ ...opts })
    if (Object.keys(refreshResult.errors).length > 0) {
      return { providers: opts?.providers ?? [], aborted: false, errors: { ...refreshResult.errors }, models: [], providerCatalog: [] }
    }
    const result = await models.refresh({
      allowNetwork: opts?.allowNetwork ?? true,
      force: opts?.force,
      providers: opts?.providers ?? [MAGPIE_PROVIDER_ID],
    })
    const errors: Record<string, string> = {}
    for (const [id, err] of result.errors) errors[id] = err instanceof Error ? err.message : String(err)
    return { providers: opts?.providers ?? [MAGPIE_PROVIDER_ID], aborted: result.aborted, errors, models: [], providerCatalog: [] }
  }
  const host = new PluginHost({
    dataDir,
    host: makeHostApi({
      ...options.hostApi,
      refreshModels: hostRefreshModels as never,
      isClosing: () => false,
    }),
    docs,
    config,
    providers: new ModelsProviderPort(models),
  })
  await host.register(
    createMagpiePlugin(),
    { enabled: false },
  )
  env.host = host
  env.close = async () => {
    try {
      await host.dispose()
    } finally {
      fetchMock.restore()
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      delete process.env.HELM_MAGPIE_CLI_LOG
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
  return env as TestEnv
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
  quotas: Array<Record<string, unknown>>; routes: Array<Record<string, unknown>>; diagnostics: string[]
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

test('magpie1: magpieApi 协议分流与 baseUrl 挂点', { timeout: 60_000 }, () => {
  assert.deepEqual(magpieApi(['/v1/responses']), { api: 'openai-responses', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages']), { api: 'anthropic-messages', endpoint: 'root' })
  assert.deepEqual(magpieApi([]), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(undefined), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages', '/v1/responses']), { api: 'openai-responses', endpoint: 'v1' }, 'responses 优先')
})

test('magpie2: toPiModels 完整映射——api/baseUrl/thinkingLevelMap/forceAdaptiveThinking/ownedBy', { timeout: 60_000 }, () => {
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

test('magpie3: thinkingLevelMap 边界——空档位 / Anthropic off 键语义', { timeout: 60_000 }, () => {
  assert.equal(thinkingLevelMap([], false), undefined)
  const map = thinkingLevelMap(['none', 'high'], true)!
  assert.equal(map.off, 'none', '有 none 档时 off → none')
  const mapNoNone = thinkingLevelMap(['high'], true)!
  assert.equal('off' in mapNoNone, false, 'Anthropic 无 none 档时 off 键删除（SDK 缺省发送禁用 thinking）')
})

test('magpie4: adaptiveThinking 版本判定', { timeout: 60_000 }, () => {
  assert.equal(adaptiveThinking('claude-sonnet-4.6'), true)
  assert.equal(adaptiveThinking('anthropic/claude-opus-4.6-x'), true)
  assert.equal(adaptiveThinking('claude-opus-5-5'), true)
  assert.equal(adaptiveThinking('claude-sonnet-4.5'), false)
  assert.equal(adaptiveThinking('gpt-5.2'), false)
})

// ---------------------------------------------------------------------------
// 2. gateway 配置解析
// ---------------------------------------------------------------------------

test('magpie5: resolveGateway 优先级 / configuredRoot 语义 / 非法显式 URL 显式报错', { timeout: 60_000 }, () => {
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

  // 诚实性：非法显式 gatewayUrl / 非法环境变量显式报错，绝不静默回退默认
  assert.throws(
    () => resolveGateway({ gatewayUrl: 'not a url' }, {}),
    (err: unknown) => err instanceof HelmError && err.code === 'magpie_invalid_gateway_url' && err.status === 400,
  )
  assert.throws(
    () => resolveGateway({}, { MAGPIE_GW_URL: '::bad::' }),
    (err: unknown) => err instanceof HelmError && err.code === 'magpie_invalid_gateway_url',
  )
  assert.throws(
    () => resolveGateway({}, { MAGPIE_ADDR: 'ftp://only' }),
    (err: unknown) => err instanceof HelmError && err.code === 'magpie_invalid_gateway_url',
    '非 http(s) scheme 同样显式拒绝',
  )
  // 无配置（全空）永不抛：默认回环是合法回落
  assert.equal(resolveGateway({}, {}).root, DEFAULT_MAGPIE_ROOT)
})

// ---------------------------------------------------------------------------
// 3. 真实宿主生命周期：providers 端口挂载 / 缺端口 501 / 默认停用不挂载
// ---------------------------------------------------------------------------

test('magpie6: 启用经 providers 端口挂载并拉取目录；停用后注销；baseUrl getter 跟随配置', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    assert.equal(env.host.list().find((p) => p.id === MAGPIE)!.enabled, false, '默认停用注册')
    assert.equal(env.models.getProvider('magpie'), undefined, '停用态 provider 不挂载（零副作用）')

    await env.host.enable(MAGPIE)
    const provider = env.models.getProvider('magpie')!
    assert.ok(provider, 'enable 经 providers 端口真实挂载（service.start 前）')
    await waitFor(() => env.models.getModels('magpie').length > 0)
    assert.equal(env.models.getModels('magpie').length, 5, '目录全量转换')

    const available = await env.models.getAvailable('magpie')
    assert.equal(available.length, 5, 'auth.check 恒有效 → available')

    // baseUrl getter 投影当前 root；切配置后即时跟随（无需重新挂载）
    assert.equal(provider.baseUrl, `${DEFAULT_MAGPIE_ROOT}/v1`)
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://127.0.0.1:9999' })
    assert.equal(provider.baseUrl, 'http://127.0.0.1:9999/v1', 'baseUrl getter 动态投影新 root')
    await env.host.setConfig(MAGPIE, {})

    const actions = env.host.listActions().filter((a) => a.pluginId === MAGPIE).map((a) => a.id).sort()
    assert.deepEqual(actions, ['group', 'groups', 'quota', 'refresh', 'status'])
    const surfaces = env.host.listUi().filter((u) => u.pluginId === MAGPIE).map((u) => u.surface).sort()
    assert.deepEqual(surfaces, ['commandPalette', 'settings.panel'])

    await waitFor(() => statusDoc(env).reachable === true)
    const doc = statusDoc(env)
    assert.equal(doc.modelCount, 5)
    assert.equal(doc.summaryText, 'Magpie · 5 模型')
    assert.equal(doc.gatewayUrl, DEFAULT_MAGPIE_ROOT)
    assert.equal(doc.configuredRoot, false)
    assert.equal(JSON.stringify(doc).includes(DEFAULT_MAGPIE_TOKEN), false, 'token 不进 doc')

    await env.host.disable(MAGPIE)
    assert.equal(env.models.getProvider('magpie'), undefined, '停用后 provider 真实注销')
    assert.deepEqual(env.host.listActions().filter((a) => a.pluginId === MAGPIE), [])
    assert.throws(() => env.host.getPublicDoc(MAGPIE, 'status'), (e: unknown) => e instanceof HelmError && e.code === 'plugin_doc_not_found')
  } finally {
    await env.close()
  }
})

test('magpie7: 宿主缺 providers 端口时启用显式 501（不静默降级）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-magpie-test-'))
  const backends = new Map<string, FakeBackend>()
  const fetchMock = installFetchMock(backends)
  try {
    const host = new PluginHost({
      dataDir,
      host: makeHostApi({
        refreshModels: (async () => ({ providers: [], aborted: false, errors: {}, models: [], providerCatalog: [] })) as never,
      }),
      docs: new MemoryDocStore(),
      config: new MemoryConfigStore(),
    })
    await host.register(createMagpiePlugin(), { enabled: false })
    // 注册（停用探测）成功：只收集声明零挂载；启用阶段才显式拒绝
    assert.equal(host.list().find((p) => p.id === MAGPIE)!.enabled, false)
    await assert.rejects(
      () => host.enable(MAGPIE),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'provider_port_unavailable')
        assert.equal(err.status, 501)
        return true
      },
    )
    // 回滚后插件回到停用形态，可再次注册探测
    assert.equal(host.list().find((p) => p.id === MAGPIE)!.enabled, false)
    await host.dispose()
  } finally {
    fetchMock.restore()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 动作契约
// ---------------------------------------------------------------------------

test('magpie8: 动作契约——status / refresh / quota / groups / group', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)

    const status = (await env.host.invokeAction(MAGPIE, 'status', {})) as StatusView
    assert.equal(status.reachable, true)
    assert.ok(Array.isArray(status.quotas), '配额随目录刷新加载')
    assert.deepEqual(status.diagnostics, [], '配额与轨迹均可用时无诊断')

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
// 5. 诚实性纪律：失败显式 / 缓存与网关隔离 / 数据源隔离
// ---------------------------------------------------------------------------

test('magpie9: 显式配置网关失败——refresh 动作显式抛错（不静默）', { timeout: 60_000 }, async () => {
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

test('magpie10: provider.refreshModels 网络失败一律 throw；cache-only 永不失败', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { failModels: 'connect ECONNREFUSED 127.0.0.1:3425' } })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === false && statusDoc(env).lastError !== undefined)

    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 1, '默认 loopback 未运行也必须显式报错，绝不静默 errors:{}')
    const err = result.errors.get('magpie')!
    assert.match(err.message, /ECONNREFUSED|models/)

    // 网络失败经 onCatalogChange 通知插件：doc lastError 同步刷新
    await waitFor(() => (statusDoc(env).lastError ?? '').includes('ECONNREFUSED'))

    // cache-only 刷新（allowNetwork:false）永不失败：无缓存时空目录，且不触发网络成功伪装
    const cacheOnly = await env.models.refresh({ providers: ['magpie'], allowNetwork: false })
    assert.equal(cacheOnly.errors.size, 0)
    assert.equal(env.models.getModels('magpie').length, 0)
    assert.equal(statusDoc(env).reachable, false, 'cache-only 不推进 reachable')
  } finally {
    await env.close()
  }
})

test('magpie11: 通用 models.refresh 触发 status 更新（onCatalogChange 端口）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)

    // 直接走通用 models.refresh（不经插件 refresh 动作）：插件 status 必须同步
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 0)
    const doc = statusDoc(env)
    assert.equal(doc.reachable, true)
    assert.equal(doc.modelCount, 5)
    assert.ok(doc.lastRefreshedAt !== undefined)

    // 网关随后故障：通用刷新的失败同样反映到 status（lastError 更新，成功时先清除旧错误）
    env.backends.get(new URL(DEFAULT_MAGPIE_ROOT).origin)!.failModels = 'gateway exploded'
    const failed = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(failed.errors.size, 1)
    await waitFor(() => statusDoc(env).reachable === false)
    const failedDoc = statusDoc(env)
    assert.match(failedDoc.lastError!, /exploded/)
    assert.equal(failedDoc.modelCount, 5, '缓存计数保留')

    // 恢复后再成功：lastError 清除（成功清除旧失败结论）
    env.backends.get(new URL(DEFAULT_MAGPIE_ROOT).origin)!.failModels = undefined
    await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    await waitFor(() => statusDoc(env).reachable === true)
    assert.equal(statusDoc(env).lastError, undefined, '成功刷新清除旧 lastError')
  } finally {
    await env.close()
  }
})

test('magpie12: 缓存与网关隔离——切 root 后旧缓存不冒充；挂起请求结果不发布', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)

    // 切换到不可达远端：refreshModels 恢复阶段必须过滤旧 root 缓存
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 1, '新网关不可达显式报错')
    assert.equal(env.models.getModels('magpie').length, 0, '旧网关缓存被清空，绝不冒充新网关目录')

    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_gateway_unreachable',
    )
    const doc = statusDoc(env)
    assert.equal(doc.gatewayUrl, 'http://10.255.255.1:3425', 'doc 指向新网关')
    assert.equal(doc.reachable, false)
    assert.equal(doc.summaryText, 'Magpie · 未连接')
    await env.host.setConfig(MAGPIE, {})
    // 回切默认网关：正确 root 的缓存经 cache-only 也可恢复
    await env.models.refresh({ providers: ['magpie'], allowNetwork: false })
    assert.equal(env.models.getModels('magpie').length, 5, 'cache-only 恢复当前 root 的持久缓存')
  } finally {
    await env.close()
  }
})

test('magpie13: fetch 期间切 root——旧网关挂起结果不发布到新网关名下', { timeout: 60_000 }, async () => {
  // 第二次目录刷新挂起（gate）；发起刷新后切 root，释放 gate：
  // 挂起的旧 root 目录绝不 install / persist / 更新 status。
  let releaseGate: (() => void) | undefined
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS, trace: TRACE }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    // 启动刷新完成（无 gate）后才挂上下一次刷新的 gate
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)
    backend.gateModels = new Promise<void>((r) => { releaseGate = r })
    env.fetchState.calls.length = 0

    const pending = env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    await waitFor(() => env.fetchState.calls.some((c) => c.includes('/v1/models') && c.includes(DEFAULT_MAGPIE_ROOT)))
    // fetch 挂起期间切换网关
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    releaseGate!()
    const result = await pending
    assert.equal(result.errors.size, 1, '结果未采用必须显式返回诊断，不能提示刷新成功')
    assert.match(result.errors.get('magpie')?.message ?? '', /网关配置已变化/)
    // 但结果不得发布：内存目录与持久缓存都不被旧 root 目录污染
    assert.equal(env.models.getModels('magpie').length, 0, '挂起结果未 install（切 root 后被 sameGateway 守卫拦下）')
    const status = (await env.host.invokeAction(MAGPIE, 'status', {})) as StatusView
    assert.equal(status.gatewayUrl, 'http://10.255.255.1:3425', 'status 读取时投影当前生效网关')
    assert.equal(status.modelCount, 0, '旧网关 5 模型不写成新网关目录')
    assert.equal(status.reachable, false, '挂起结果不推进 reachable')
  } finally {
    await env.close()
  }
})

test('magpie14: 可达后失败——reachable:false 时 modelCount 不冒充实时成功', { timeout: 60_000 }, async () => {
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

test('magpie15: 远端网关数据源隔离——CLI 不被调用、groups 只用 trace 且标 source', { timeout: 60_000 }, async () => {
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

    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'group', { id: 'group/relay' }),
      (err: unknown) => err instanceof HelmError && err.code === 'magpie_group_not_found' && err.status === 404,
    )
    assert.equal(env.cliRuns.length, 0, 'group 动作在远端网关同样不调 CLI')
  } finally {
    await env.close()
  }
})

test('magpie16: 显式其它 loopback 端口——无法证明 CLI 指向同一实例时只用所选 root trace', { timeout: 60_000 }, async () => {
  // 另一个 loopback 端口有真实后端：groups 可用 trace，但本机默认 CLI 绝不被混入
  const altRoot = 'http://127.0.0.1:3525'
  const env = await makeEnv()
  try {
    env.backends.set(new URL(altRoot).origin, { models: CATALOG, quotas: QUOTAS, trace: TRACE })
    await env.config.set(MAGPIE, { gatewayUrl: altRoot })
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)

    const groups = (await env.host.invokeAction(MAGPIE, 'groups', {})) as {
      groups: Array<{ id: string; source: string }>
      local: boolean
      note?: string
    }
    assert.equal(groups.local, true, 'loopback 但非默认端口')
    assert.ok(groups.groups.length > 0, '所选 root 的 trace 提供组列表')
    assert.equal(groups.groups.every((g) => g.source === 'gateway-trace'), true, '只标 gateway-trace，不冒充 cli+trace')
    assert.equal(env.cliRuns.length, 0, '无法证明 CLI 目标一致 → 不读本机默认实例 CLI')
    assert.ok(groups.note !== undefined, '输出明确说明 CLI 数据源不可混入的原因')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. turn_settled：会话过滤 + 诊断
// ---------------------------------------------------------------------------

test('magpie17: turn_settled 只刷新 magpie/ 模型会话（kept 读法；不阻塞结算）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const quotaCallsBefore = env.fetchState.calls.filter((c) => c.includes('quotas')).length

    // 非 magpie 会话 settled：不触发任何网关读
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'anthropic/claude-sonnet-4.6'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(
      env.fetchState.calls.filter((c) => c.includes('quotas')).length,
      quotaCallsBefore,
      '其它 Provider 会话 settled 不触发配额读',
    )

    // magpie 会话 settled：kept=1 侧读（不问供应商），runHook 立即返回（不阻塞）
    const start = Date.now()
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(2, 'magpie/anthropic/claude-sonnet-4.6'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    assert.ok(Date.now() - start < 500, 'turn_settled 不被侧读 await 阻塞')
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

test('magpie18: 配额失败不清空成「没有配额」——diagnostics 明确记录原因', { timeout: 60_000 }, async () => {
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS, trace: TRACE }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).quotas.length > 0)
    assert.deepEqual(statusDoc(env).diagnostics, [])

    // 配额接口故障：settled 侧读后 quotas 区清空但 diagnostics 记录原因
    backend.failQuotas = 'quota endpoint exploded'
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'magpie/group/relay'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await waitFor(() => statusDoc(env).diagnostics.length > 0)
    const doc = statusDoc(env)
    assert.deepEqual(doc.quotas, [], '配额区清空（旧数据不冒充当前读数）')
    assert.ok(doc.diagnostics.some((d) => d.includes('配额不可用') && d.includes('exploded')), `诊断含原因：${JSON.stringify(doc.diagnostics)}`)

    // trace 同步不可用：诊断同样记录（不是静默空列表）
    backend.trace = undefined
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'magpie/group/relay'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await waitFor(() => statusDoc(env).diagnostics.some((d) => d.includes('路由轨迹不可用')))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. UI spec：无 Emoji / 求值表达式真实可取值 / scope 绑定
// ---------------------------------------------------------------------------

test('magpie19: UI spec 无 Emoji、scope 绑定 magpie、client 轨道组件导出真实可用', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { models: { data: [] }, quotas: { data: [] } } })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const ui = env.host.listUi().filter((u) => u.pluginId === MAGPIE)
    const emoji = /\p{Extended_Pictographic}/u
    for (const item of ui) {
      assert.equal(emoji.test(JSON.stringify(item.spec)), false, `UI ${item.surface} 不得含 Emoji`)
    }
    assert.equal(ui.some((u) => u.surface === 'composer.pill'), false, 'magpie 不再向 composer 注册占位胶囊')

    // settingsPanel：client 轨道（不再声明 json；真实编译产物可编译且导出组件函数）
    const panel = ui.find((u) => u.surface === 'settings.panel')!.spec as {
      label: string; json?: unknown; docs?: unknown; client?: { module: string; export: string }
    }
    assert.equal(panel.label, 'Magpie 网关')
    assert.equal(panel.json, undefined, 'settingsPanel 不再声明 JSON Spec（单轨 client）')
    assert.equal(panel.docs, undefined, 'settingsPanel 不再声明 docs（组件 usePluginDoc 自主订阅）')
    assert.equal(panel.client!.module, 'index.tsx')
    assert.equal(panel.client!.export, 'MagpieSettingsPanel')

    // 真实编译：clientRoot 内 index.tsx 可编译为浏览器 ESM（面板含刷新按钮由 web 端 DOM 测试覆盖）
    const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'builtin-plugins', 'magpie', 'client')
    const cacheDir = mkdtempSync(join(tmpdir(), 'helm-magpie-client-'))
    try {
      const { code } = await compilePluginClientModule(MAGPIE, clientRoot, 'index.tsx', cacheDir)
      assert.ok(code.length > 0, '编译产物非空')
      assert.doesNotMatch(code, /\p{Extended_Pictographic}/u, '编译产物不含 Emoji')
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }

    const command = ui.find((u) => u.surface === 'commandPalette')!.spec as { title: string; actionId: string }
    assert.equal(command.title, '刷新 Magpie 模型目录')
    assert.equal(command.actionId, 'refresh')

    // 无模型目录时非 magpie 会话 settled 不触网（保持原行为回归）
    const callsBefore = env.fetchState.calls.length
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'other/model'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(env.fetchState.calls.length, callsBefore, '无关会话 settled 不读网关')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 8. provider 请求路径：auth 快照冻结 / stream 委托 baseUrl 修正
// ---------------------------------------------------------------------------

test('magpie20: auth.resolve 携带冻结 root 的 env；apiKey 与 root 同次快照', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => env.models.getModels('magpie').length > 0)
    const provider = env.models.getProvider('magpie')!

    const resolved = await provider.auth.apiKey!.resolve({ signal: new AbortController().signal } as never)
    assert.ok(resolved, 'auth.resolve 返回有效结果')
    assert.equal(resolved!.auth.apiKey, DEFAULT_MAGPIE_TOKEN)
    assert.equal(resolved!.env?.MAGPIE_GW_URL, DEFAULT_MAGPIE_ROOT, 'auth 快照冻结 root 进 env')

    // Models.getAuth 走 credential store：resolve 结果同样携带 env
    const viaModels = await env.models.getAuth('magpie')
    assert.ok(viaModels)
    assert.equal(viaModels.env?.MAGPIE_GW_URL, DEFAULT_MAGPIE_ROOT)
  } finally {
    await env.close()
  }
})

test('magpie21: provider stream 按请求时刻 root 修正 baseUrl（委托产生事件流）', { timeout: 60_000 }, async () => {
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
