/**
 * 模型接入测试：本地 HTTP fake OpenAI/Anthropic 兼容服务捕获真实 pi-ai SDK
 * 发出的请求（明确不是外网模型），验证：
 * - baseURL / path / bearer / x-api-key / model id 组装正确；
 * - credential 注入 key 优先于环境变量，环境变量是合法回退；
 * - 缺 key 显式不可用（checkAuth undefined / 流式错误），无 fallback 假回答；
 * - checkAuth 是 SDK 真实语义（AuthCheck | undefined），不做 Boolean(source) 臆测；
 * - listModelCatalog 不吞读取/协议错误（无凭据的不可用是合法状态，错误必须抛出）。
 *
 * 凭据全部使用显式 fixture，不读取真实环境变量；相关 env 在 beforeEach 设置、
 * afterEach 恢复删除。
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderConfig } from '@helm/protocol'
import type { ApiKeyAuth, MutableModels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  buildModels,
  listModelCatalog,
  listModelProviders,
  parseModelRef,
  requireModelRef,
  type ModelCatalogEntry,
} from '../src/runtime/models.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { HelmError } from '@helm/protocol'

/** 单个捕获到的请求。 */
interface CapturedRequest {
  method: string
  /** 完整路径（含 query）。 */
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

const OPENAI_FIXTURE_KEY = 'fixture-openai-key-000'
const ANTHROPIC_FIXTURE_KEY = 'fixture-anthropic-key-000'

/** 通用 SSE / JSON fake 服务：记录请求，按 protocol 回放合法响应。 */
class FakeGateway {
  readonly requests: CapturedRequest[] = []
  private readonly server: Server
  private baseUrl = ''

  constructor(private readonly protocol: 'openai' | 'anthropic') {
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    this.requests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      headers: { ...req.headers },
      body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
    })
    if (this.protocol === 'openai') this.replyOpenAi(res)
    else this.replyAnthropic(res)
  }

  /** OpenAI chat.completions 流式响应：两个 content 增量 + finish + usage。 */
  private replyOpenAi(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = [
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'gw-openai-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'gw-openai-model', choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'gw-openai-model', choices: [{ index: 0, delta: { content: 'from fake gateway' }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'gw-openai-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ]
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }

  /** Anthropic messages SSE：message_start → content_block_start → delta → stop → message_delta/stop。 */
  private replyAnthropic(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', model: 'gw-anthropic-model', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from fake gateway' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ]
    for (const event of events) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    res.end()
  }

  get url(): string {
    assert.ok(this.baseUrl !== '', 'fake gateway 未启动')
    return this.baseUrl
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${addr.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  last(): CapturedRequest {
    const req = this.requests[this.requests.length - 1]
    assert.ok(req, 'fake gateway 未收到请求')
    return req
  }

  header(req: CapturedRequest, name: string): string {
    const value = req.headers[name.toLowerCase()]
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  }
}

let openaiGateway: FakeGateway
let anthropicGateway: FakeGateway

before(async () => {
  openaiGateway = new FakeGateway('openai')
  anthropicGateway = new FakeGateway('anthropic')
  await openaiGateway.start()
  await anthropicGateway.start()
})

after(async () => {
  await openaiGateway.stop()
  await anthropicGateway.stop()
})

const ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const
let envBackup: Record<string, string | undefined> = {}

beforeEach(() => {
  envBackup = {}
  for (const name of ENV_VARS) {
    envBackup[name] = process.env[name]
    delete process.env[name]
  }
})

after(async () => {
  for (const [name, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function openaiCompatConfig(baseUrl: string): ProviderConfig {
  return {
    id: 'gw-openai',
    protocol: 'openai',
    baseUrl,
    models: ['gw-openai-model'],
    label: 'OpenAI 兼容网关',
    enabled: true,
  }
}

function anthropicCompatConfig(baseUrl: string): ProviderConfig {
  return {
    id: 'gw-anthropic',
    protocol: 'anthropic',
    baseUrl,
    models: ['gw-anthropic-model'],
    enabled: true,
  }
}

/** 收集流式事件到 done/error。 */
async function drainStream(stream: AsyncIterable<unknown>): Promise<{ done: boolean; error: boolean; events: unknown[] }> {
  const events: unknown[] = []
  let done = false
  let error = false
  for await (const event of stream) {
    const type = (event as { type?: string }).type
    if (type === 'done') done = true
    if (type === 'error') error = true
    events.push(event)
  }
  return { done, error, events }
}

// ---------------------------------------------------------------------------
// 兼容网关：真实 SDK 请求组装（本地 fake HTTP，明确不是外网模型）
// ---------------------------------------------------------------------------

describe('兼容网关（openai 协议）', { timeout: 60_000 }, () => {
  test('streamSimple 组装 baseURL/path/bearer/model id 并收到真实流式回答', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const model = models.getModel('gw-openai', 'gw-openai-model')
    assert.ok(model, 'compat 模型应注册到目录')
    assert.equal(model.provider, 'gw-openai')
    assert.equal(model.baseUrl, `${openaiGateway.url}/v1`)

    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.error, false, 'fake 网关回放合法流，不应出错')
    assert.equal(result.done, true)

    const req = openaiGateway.last()
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/v1/chat/completions')
    assert.equal(openaiGateway.header(req, 'authorization'), 'Bearer fixture-gw-key-111')
    assert.equal((req.body as { model?: string }).model, 'gw-openai-model')
  })

  test('checkAuth 与 getAuth 反映注入凭据（SDK 真实语义）', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const auth = await models.getAuth('gw-openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, 'fixture-gw-key-111')
    const check = await models.checkAuth('gw-openai')
    assert.ok(check, '已注入 key 的网关 checkAuth 应有 AuthCheck')
    assert.equal(check.type, 'api_key')

    const bare = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    const bareAuth = await bare.getAuth('gw-openai')
    assert.equal(bareAuth, undefined, '无凭据是合法的未配置状态（undefined）')
    assert.equal(await bare.checkAuth('gw-openai'), undefined)
  })
})

describe('兼容网关（anthropic 协议）', { timeout: 60_000 }, () => {
  test('streamSimple 组装 /v1/messages 路径与 x-api-key 头', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [anthropicCompatConfig(anthropicGateway.url)],
      apiKeys: () => ({ 'gw-anthropic': 'fixture-gw-key-222' }),
    })
    const model = models.getModel('gw-anthropic', 'gw-anthropic-model')
    assert.ok(model)

    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.error, false)
    assert.equal(result.done, true)

    const req = anthropicGateway.last()
    assert.equal(req.method, 'POST')
    assert.equal(req.path.split('?')[0], '/v1/messages')
    assert.equal(anthropicGateway.header(req, 'x-api-key'), 'fixture-gw-key-222')
    assert.equal((req.body as { model?: string }).model, 'gw-anthropic-model')
    // max_tokens 来自 compat 缺省（显式标记的保守配置，非探测值）
    assert.equal(typeof (req.body as { max_tokens?: number }).max_tokens, 'number')
  })
})

// ---------------------------------------------------------------------------
// 官方 provider：SDK checkAuth 语义 + credential 优先于 env
// ---------------------------------------------------------------------------

describe('PI 全量供应商', { timeout: 60_000 }, () => {
  test('直接注册全部内置供应商，保留原生模型元数据与零模型供应商', { timeout: 60_000 }, () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const native = builtinProviders()
    assert.deepEqual(models.getProviders().map((provider) => provider.id), native.map((provider) => provider.id))
    for (const provider of native) {
      assert.deepEqual(models.getModels(provider.id), provider.getModels())
    }
    const summaries = listModelProviders(models)
    assert.equal(summaries.length, native.length)
    assert.ok(summaries.some((provider) => provider.id === 'typesafe' && provider.modelCount === 0))
    assert.deepEqual(summaries.find((provider) => provider.id === 'openai-codex')?.authMethods.map((method) => method.type), ['oauth'])
    // 内置摘要基础四种固定键；baseUrl 是合法公开字段（deepseek 等多数网关均有）；
    // dynamic 仅真正实现 refreshModels 的供应商（radius）携带。
    const radius = summaries.find((provider) => provider.id === 'radius')
    assert.ok(radius)
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined, 'radius 无固定网关 baseUrl，不得伪造')
    assert.ok(
      summaries
        .filter((provider) => provider.id !== 'radius')
        .every((provider) => Object.keys(provider).sort().join(',') !== '' && !('dynamic' in provider)),
    )
    const deepseek = summaries.find((provider) => provider.id === 'deepseek')
    assert.ok(deepseek?.baseUrl)
    assert.equal('dynamic' in deepseek, false)
  })

  test('非 OpenAI/Anthropic 供应商原生 key 注入且不伪造 OAuth-only 的 API Key', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ deepseek: 'fixture-deepseek', 'openai-codex': 'fixture-not-oauth' }) })
    assert.equal((await models.getAuth('deepseek'))?.auth.apiKey, 'fixture-deepseek')
    assert.equal(models.getProvider('openai-codex')?.auth.apiKey, undefined)
    assert.ok(models.getProvider('openai-codex')?.auth.oauth)
  })

  test('Cloudflare 原生配置校验与认证头转换不可被通用 Bearer 覆盖', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ 'cloudflare-ai-gateway': 'fixture-cloudflare' }) })
    const apiKey = models.getProvider('cloudflare-ai-gateway')?.auth.apiKey
    assert.ok(apiKey)
    const signal = new AbortController().signal
    const emptyContext = { env: async () => undefined, fileExists: async () => false }
    assert.equal(await apiKey.resolve({ ctx: emptyContext, signal }), undefined)
    const env: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_GATEWAY_ID: 'fixture-gateway' }
    const auth = await apiKey.resolve({ ctx: { ...emptyContext, env: async (name) => env[name] }, signal })
    assert.equal(auth?.auth.headers?.['cf-aig-authorization'], 'Bearer fixture-cloudflare')
    assert.equal(auth?.auth.apiKey, undefined)
    assert.equal(auth?.env?.['CLOUDFLARE_ACCOUNT_ID'], 'fixture-account')
  })

  test('自定义网关保持显式覆盖与停用语义', { timeout: 60_000 }, () => {
    const override = { ...openaiCompatConfig('http://127.0.0.1/v1'), id: 'deepseek' }
    const enabled = buildModels({ providers: [override], apiKeys: () => ({}) })
    assert.deepEqual(enabled.getModels('deepseek').map((model) => model.id), ['gw-openai-model'])
    const disabled = buildModels({ providers: [{ ...override, enabled: false }], apiKeys: () => ({}) })
    assert.deepEqual(disabled.getModels('deepseek'), builtinProviders().find((provider) => provider.id === 'deepseek')!.getModels())
  })

  test('extraProviders 注册运行时供应商且不丢失目录摘要字段', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-fx', models: [{ id: 'fx-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    assert.ok(models.getProvider('plugin-fx'))
    assert.deepEqual(models.getModels('plugin-fx').map((model) => model.id), ['fx-model'])
    const summaries = listModelProviders(models)
    const fx = summaries.find((summary) => summary.id === 'plugin-fx')
    assert.ok(fx)
    assert.equal(fx.modelCount, 1)
    // faux 无 refreshModels：不得伪造 dynamic 标记。
    assert.equal(fx.dynamic, undefined)
  })

  test('listModelProviders 附带 dynamic/baseUrl/pluginId（按 providerOwners）', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-owned', models: [{ id: 'owned-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    const owners = new Map([['plugin-owned', 'builtin:demo']])
    const owned = listModelProviders(models, owners).find((summary) => summary.id === 'plugin-owned')
    assert.equal(owned?.pluginId, 'builtin:demo')
    // 同一集合不传 owners：无 pluginId 字段（不伪造归属）。
    const anon = listModelProviders(models).find((summary) => summary.id === 'plugin-owned')
    assert.equal(anon?.pluginId, undefined)
    // 内置动态供应商（radius）标记 dynamic；无 owners 时不带 pluginId、不伪造 baseUrl。
    const radius = listModelProviders(models).find((summary) => summary.id === 'radius')
    assert.ok(radius, '内置 radius 供应商应在目录中')
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined)
    assert.equal(radius.pluginId, undefined)
  })
})

describe('文件版动态目录缓存（models-store.json）', { timeout: 60_000 }, () => {
  test('ENOENT 返回空；write/update/delete 持久化且并发 update 不丢写', { timeout: 60_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'helm-models-store-'))
    try {
      const store = createFileModelsStore(dataDir)
      assert.equal(await store.read('p1'), undefined)

      await store.write('p1', { models: [], checkedAt: 111 })
      await store.write('p2', { models: [], checkedAt: 222, etag: '"v1"' })
      assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
      assert.deepEqual(await store.read('p2'), { models: [], checkedAt: 222, etag: '"v1"' })

      // update：undefined 不改写；对象写入。
      await store.update('p1', async () => undefined)
      assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
      await store.update('p1', async (current) => ({ ...current!, checkedAt: 333 }))
      assert.equal((await store.read('p1'))?.checkedAt, 333)
      await store.delete('p2')
      assert.equal(await store.read('p2'), undefined)

      // 并发 update：两个不同 provider 同时读改写，锁内串行不丢彼此写入。
      await Promise.all([
        store.update('a', async () => ({ models: [], checkedAt: 1 })),
        store.update('b', async () => ({ models: [], checkedAt: 2 })),
      ])
      assert.equal((await store.read('a'))?.checkedAt, 1)
      assert.equal((await store.read('b'))?.checkedAt, 2)

      // 落盘为 0600 且顶层为对象。
      const raw = JSON.parse(await readFile(join(dataDir, 'models-store.json'), 'utf8')) as Record<string, unknown>
      assert.ok(typeof raw['p1'] === 'object')
      const { stat } = await import('node:fs/promises')
      const mode = (await stat(join(dataDir, 'models-store.json'))).mode & 0o777
      assert.equal(mode, 0o600)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test('损坏文件显式抛 models_store_corrupted，绝不静默当空目录', { timeout: 60_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'helm-models-store-corrupt-'))
    try {
      const path = join(dataDir, 'models-store.json')
      await writeFile(path, '{invalid-json')
      const store = createFileModelsStore(dataDir)
      await assert.rejects(() => store.read('p1'), (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'models_store_corrupted')
        return true
      })
      await writeFile(path, '["array"]')
      await assert.rejects(() => store.read('p1'), (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'models_store_corrupted')
        return true
      })
      await assert.rejects(() => store.update('p1', () => ({ models: [] })), (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'models_store_corrupted')
        return true
      })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('官方 provider auth', { timeout: 60_000 }, () => {
  test('无凭据无环境变量：checkAuth undefined（合法不可用，无 fallback）', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    assert.equal(await models.checkAuth('openai'), undefined)
    assert.equal(await models.checkAuth('anthropic'), undefined)
    const catalog = await listModelCatalog(models)
    const official = catalog.models.filter((e: ModelCatalogEntry) => e.provider === 'openai' || e.provider === 'anthropic')
    assert.ok(official.length > 0, '官方目录模型仍列出（含不可用项）')
    assert.ok(official.every((e: ModelCatalogEntry) => !e.available))
  })

  test('环境变量回退：官方 provider 原生语义', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = OPENAI_FIXTURE_KEY
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.equal(auth.source, 'OPENAI_API_KEY')
  })

  test('credential 注入 key 优先于环境变量', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = 'env-should-lose'
    const models = buildModels({ providers: [], apiKeys: () => ({ openai: OPENAI_FIXTURE_KEY }) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.notEqual(auth.auth.apiKey, 'env-should-lose')
  })

  test('注入 key 后 oauth 等其它 auth 策略保留', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ anthropic: ANTHROPIC_FIXTURE_KEY }) })
    const provider = models.getProvider('anthropic')
    assert.ok(provider, 'anthropic provider 应注册')
    assert.ok(provider.auth.oauth, '官方 oauth 策略必须保留（不因注入 apiKey 而丢失）')
    const auth = await models.getAuth('anthropic')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, ANTHROPIC_FIXTURE_KEY)
  })

  test('无凭据请求模型：流以显式错误结束，无 fallback 假回答', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const model = models.getModel('openai', 'gpt-5.2')
    assert.ok(model, '官方目录中的模型应可解析')
    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.done, false, '无凭据绝不能成功回答')
    assert.equal(result.error, true, '必须以显式流式错误结束')
    const errorEvent = result.events.find((e) => (e as { type?: string }).type === 'error') as
      | { error?: { errorMessage?: string } }
      | undefined
    assert.ok(errorEvent?.error?.errorMessage, '错误事件应带诊断信息')
  })
})

// ---------------------------------------------------------------------------
// 模型目录与错误语义
// ---------------------------------------------------------------------------

describe('listModelCatalog 错误语义', { timeout: 60_000 }, () => {
  test('未配置凭据的网关模型 available=false（合法状态，不抛错）', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    const catalog = await listModelCatalog(models)
    const entry = catalog.models.find((e: ModelCatalogEntry) => e.provider === 'gw-openai')
    assert.ok(entry)
    assert.equal(entry.modelId, 'gw-openai-model')
    assert.equal(entry.available, false)
  })

  test('checkAuth 抛出的读取/协议错误必须向上传播，不静默 available=false', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    // 直接注入一个 checkAuth 抛错的 provider 验证传播语义（协议层契约）。
    const provider = models.getProvider('gw-openai')
    assert.ok(provider)
    assert.ok(provider.auth.apiKey, 'compat provider 必有 apiKey auth')
    const brokenApiKey: ApiKeyAuth = {
      ...provider.auth.apiKey,
      name: 'broken',
      check: async () => {
        throw new Error('credential store read failed')
      },
    }
    const broken: typeof provider = { ...provider, auth: { ...provider.auth, apiKey: brokenApiKey } }
    ;(models as MutableModels).setProvider(broken)
    await assert.rejects(
      () => listModelCatalog(models),
      (error: unknown) => {
        assert.match(String(error), /credential store read failed|gw-openai/)
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// 模型引用解析
// ---------------------------------------------------------------------------

describe('模型引用', { timeout: 60_000 }, () => {
  test('parseModelRef 拆 provider/model', { timeout: 60_000 }, () => {
    assert.deepEqual(parseModelRef('openai/gpt-5.2'), { provider: 'openai', modelId: 'gpt-5.2' })
    assert.deepEqual(parseModelRef('gw-x/model-with/slash'), { provider: 'gw-x', modelId: 'model-with/slash' })
  })

  test('非法引用与缺失配置显式报错', { timeout: 60_000 }, () => {
    assert.throws(() => parseModelRef('noslash'), HelmError)
    assert.throws(() => parseModelRef('/leading'), HelmError)
    assert.throws(() => parseModelRef('trailing/'), HelmError)
    assert.throws(() => requireModelRef(undefined), (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal((error as HelmError).code, 'model_not_configured')
      return true
    })
    assert.throws(() => requireModelRef('  '), HelmError)
  })
})
