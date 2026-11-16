/**
 * model access test: local HTTP fake OpenAI/Anthropic compatibility service catch real pi-ai SDK
 * out request (explicit is not outside network model), verify:
 * - baseURL / path / bearer / x-api-key / model id group install correct;
 * - credential inject key takes precedence at environment variable, environment variable is legal fall back;
 * - missing key explicit unavailable (checkAuth undefined / streaming error), without fallback false answer;
 * - checkAuth is SDK real semantics (AuthCheck | undefined), does not Boolean(source) conjecture;
 * - listModelCatalog do not swallow read/protocol error (without credentials unavailable is legal state, error must throw).
 *
 * credentials all use explicit fixture, do not read real environment variable; related env in beforeEach settings,
 * afterEach restore delete.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import type { ProviderConfig } from '@helm/protocol'
import type { ApiKeyAuth, MutableModels, Models, Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  buildModels,
  knownContextWindowOf,
  listModelCatalog,
  listModelProviders,
  parseModelRef,
  requireModelRef,
  type HelmModelSourceMeta,
  type ModelCatalogEntry,
} from '../src/runtime/models.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { HelmError } from '@helm/protocol'
import { useTempDir } from './helpers.js'

/** single catch to request. */
interface CapturedRequest {
  method: string
  /** complete path (contains query). */
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

const OPENAI_FIXTURE_KEY = 'fixture-openai-key-000'
const ANTHROPIC_FIXTURE_KEY = 'fixture-anthropic-key-000'

/** through use SSE / JSON fake service: record request, by protocol back put legal response. */
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

  /** OpenAI chat.completions streaming response: two content incremental + finish + usage. */
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

  /** Anthropic messages SSE:message_start → content_block_start → delta → stop → message_delta/stop. */
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
    assert.ok(this.baseUrl !== '', 'fake gateway not start')
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
    assert.ok(req, 'fake gateway not received request')
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
    label: 'OpenAI compatibility gateway',
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

/** collect streaming event to done/error. */
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
// compatibility gateway: real SDK request group install (local fake HTTP, explicit is not outside network model)
// ---------------------------------------------------------------------------

describe('compatibility gateway (openai protocol)', { timeout: 60_000 }, () => {
  test('static model window explicit mark record unknown (helmContextWindowKnown via setProvider/getModel keep)', { timeout: 60_000 }, () => {
    const models = buildModels({
      providers: [openaiCompatConfig('http://127.0.0.1:9/v1')],
      apiKeys: () => ({}),
    })
    const model = models.getModel('gw-openai', 'gw-openai-model')
    assert.ok(model, 'compat model should register to directory')
    // request contract default still in (send request need to), but must not when act real known window.
    assert.equal(model.contextWindow, 128_000)
    assert.equal((model as typeof model & HelmModelSourceMeta).helmContextWindowKnown, false, 'compat static model must carry unknown mark record')
    assert.equal(knownContextWindowOf(model), undefined, 'known window parse must omit static default')
    // inside placement provider model default treated as known: window is policy expand data.
    const builtin = models.getModels().find((entry) => entry.contextWindow > 0)
    assert.ok(builtin, 'inside placement provider directory should store in carries window model')
    assert.equal(knownContextWindowOf(builtin), builtin.contextWindow, 'inside placement model window such as known')
    assert.equal(knownContextWindowOf(undefined), undefined)
  })

  test('listModelCatalog only throw shadow real known window: static default/non- correct/non- finite one rule omit', { timeout: 60_000 }, async () => {
    const models = createModels()
    const base = {
      name: 'w',
      provider: 'win',
      api: 'openai-completions',
      baseUrl: 'http://win.local',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      maxTokens: 4_096,
    }
    // form align Magpie directory artifact (toPiModel): known window without mark record, unknown carry
    // helmContextWindowKnown:false + keep guard default 128k.
    const list = [
      { ...base, id: 'known', contextWindow: 400_000 },
      { ...base, id: 'static-default', contextWindow: 128_000, helmContextWindowKnown: false },
      { ...base, id: 'infinite', contextWindow: Number.POSITIVE_INFINITY },
      { ...base, id: 'zero', contextWindow: 0 },
    ]
    const provider = {
      id: 'win',
      name: 'win',
      baseUrl: 'http://win.local',
      auth: {},
      getModels: () => list,
      getAllModels: () => list,
    } as unknown as Provider
    models.setProvider(provider)

    const catalog = await listModelCatalog(models)
    const byId = new Map(catalog.models.map((entry) => [entry.modelId, entry]))
    assert.equal(byId.get('known')!.contextWindow, 400_000, 'real known window such as throw shadow')
    assert.equal('contextWindow' in (byId.get('static-default') ?? {}), false, 'static default window must omit')
    assert.equal('contextWindow' in (byId.get('infinite') ?? {}), false, 'non- finite window must omit')
    assert.equal('contextWindow' in (byId.get('zero') ?? {}), false, 'non- correct window must omit')
    assert.equal(knownContextWindowOf(list[2] as never), undefined, 'Infinity must not pass-through')
  })

  test('streamSimple group install baseURL/path/bearer/model id and receives real streaming answer', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const model = models.getModel('gw-openai', 'gw-openai-model')
    assert.ok(model, 'compat model should register to directory')
    assert.equal(model.provider, 'gw-openai')
    assert.equal(model.baseUrl, `${openaiGateway.url}/v1`)

    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.error, false, 'fake gateway back put legal stream, must not fails')
    assert.equal(result.done, true)

    const req = openaiGateway.last()
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/v1/chat/completions')
    assert.equal(openaiGateway.header(req, 'authorization'), 'Bearer fixture-gw-key-111')
    assert.equal((req.body as { model?: string }).model, 'gw-openai-model')
  })

  test('checkAuth and getAuth reverse reflect inject credentials (SDK real semantics)', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const auth = await models.getAuth('gw-openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, 'fixture-gw-key-111')
    const check = await models.checkAuth('gw-openai')
    assert.ok(check, 'already inject key gateway checkAuth should has AuthCheck')
    assert.equal(check.type, 'api_key')

    const bare = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    const bareAuth = await bare.getAuth('gw-openai')
    assert.equal(bareAuth, undefined, 'without credentials is legal not config state (undefined)')
    assert.equal(await bare.checkAuth('gw-openai'), undefined)
  })
})

describe('compatibility gateway (anthropic protocol)', { timeout: 60_000 }, () => {
  test('streamSimple group install /v1/messages path and x-api-key head', { timeout: 60_000 }, async () => {
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
    // max_tokens from compat default (explicit mark record keep guard config, non- probe value)
    assert.equal(typeof (req.body as { max_tokens?: number }).max_tokens, 'number')
  })
})

// ---------------------------------------------------------------------------
// official provider:SDK checkAuth semantics + credential takes precedence at env
// ---------------------------------------------------------------------------

describe('PI all amount provider', { timeout: 60_000 }, () => {
  test('directly register all inside placement provider, keep original generate model metadata and zero model provider', { timeout: 60_000 }, () => {
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
    // inside placement summary basis four fixed key;baseUrl is legal public field (deepseek etc. many count gateway all has);
    // dynamic only truly implement refreshModels provider (radius) carry.
    const radius = summaries.find((provider) => provider.id === 'radius')
    assert.ok(radius)
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined, 'radius without fixed gateway baseUrl, must not fabricate')
    assert.ok(
      summaries
        .filter((provider) => provider.id !== 'radius')
        .every((provider) => Object.keys(provider).sort().join(',') !== '' && !('dynamic' in provider)),
    )
    const deepseek = summaries.find((provider) => provider.id === 'deepseek')
    assert.ok(deepseek?.baseUrl)
    assert.equal('dynamic' in deepseek, false)
  })

  test('non- OpenAI/Anthropic provider original generate key inject and do not fabricate OAuth-only  API Key', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ deepseek: 'fixture-deepseek', 'openai-codex': 'fixture-not-oauth' }) })
    assert.equal((await models.getAuth('deepseek'))?.auth.apiKey, 'fixture-deepseek')
    assert.equal(models.getProvider('openai-codex')?.auth.apiKey, undefined)
    assert.ok(models.getProvider('openai-codex')?.auth.oauth)
  })

  test('Cloudflare original generate config validate and recognize verify head convert cannot by through use Bearer override', { timeout: 60_000 }, async () => {
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

  test('self define gateway keep explicit override and deactivate semantics', { timeout: 60_000 }, () => {
    const override = { ...openaiCompatConfig('http://127.0.0.1/v1'), id: 'deepseek' }
    const enabled = buildModels({ providers: [override], apiKeys: () => ({}) })
    assert.deepEqual(enabled.getModels('deepseek').map((model) => model.id), ['gw-openai-model'])
    const disabled = buildModels({ providers: [{ ...override, enabled: false }], apiKeys: () => ({}) })
    assert.deepEqual(disabled.getModels('deepseek'), builtinProviders().find((provider) => provider.id === 'deepseek')!.getModels())
  })

  test('extraProviders register runtime provider and without losing directory summary field', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-fx', models: [{ id: 'fx-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    assert.ok(models.getProvider('plugin-fx'))
    assert.deepEqual(models.getModels('plugin-fx').map((model) => model.id), ['fx-model'])
    const summaries = listModelProviders(models)
    const fx = summaries.find((summary) => summary.id === 'plugin-fx')
    assert.ok(fx)
    assert.equal(fx.modelCount, 1)
    // faux without refreshModels: must not fabricate dynamic mark record.
    assert.equal(fx.dynamic, undefined)
  })

  test('listModelProviders attach carries dynamic/baseUrl/pluginId(by providerOwners)', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-owned', models: [{ id: 'owned-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    const owners = new Map([['plugin-owned', 'builtin:demo']])
    const owned = listModelProviders(models, owners).find((summary) => summary.id === 'plugin-owned')
    assert.equal(owned?.pluginId, 'builtin:demo')
    // the same set do not pass owners: without pluginId field (do not fabricate ownership).
    const anon = listModelProviders(models).find((summary) => summary.id === 'plugin-owned')
    assert.equal(anon?.pluginId, undefined)
    // inside placement motion state provider (radius) mark record dynamic; without owners when do not carries pluginId, do not fabricate baseUrl.
    const radius = listModelProviders(models).find((summary) => summary.id === 'radius')
    assert.ok(radius, 'inside placement radius provider should in directory in')
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined)
    assert.equal(radius.pluginId, undefined)
  })
})

describe('file edition motion state directory cache (models-store.json)', { timeout: 60_000 }, () => {
  test('ENOENT return empty;write/update/delete persist and concurrency update do not lose write', { timeout: 60_000 }, async (t) => {
    const dataDir = useTempDir(t, 'helm-models-store-')
    const store = createFileModelsStore(dataDir)
    assert.equal(await store.read('p1'), undefined)

    await store.write('p1', { models: [], checkedAt: 111 })
    await store.write('p2', { models: [], checkedAt: 222, etag: '"v1"' })
    assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
    assert.deepEqual(await store.read('p2'), { models: [], checkedAt: 222, etag: '"v1"' })

    // update:undefined do not change write; object write.
    await store.update('p1', async () => undefined)
    assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
    await store.update('p1', async (current) => ({ ...current!, checkedAt: 333 }))
    assert.equal((await store.read('p1'))?.checkedAt, 333)
    await store.delete('p2')
    assert.equal(await store.read('p2'), undefined)

    // concurrency update: two different provider also read change write, lock inside serial do not lose each other write.
    await Promise.all([
      store.update('a', async () => ({ models: [], checkedAt: 1 })),
      store.update('b', async () => ({ models: [], checkedAt: 2 })),
    ])
    assert.equal((await store.read('a'))?.checkedAt, 1)
    assert.equal((await store.read('b'))?.checkedAt, 2)

    // is 0600 and top-level is object (Windows without POSIX mode, skip pattern validate).
    const raw = JSON.parse(await readFile(join(dataDir, 'models-store.json'), 'utf8')) as Record<string, unknown>
    assert.ok(typeof raw['p1'] === 'object')
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      const mode = (await stat(join(dataDir, 'models-store.json'))).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  test('corrupt file explicit throw models_store_corrupted, never static default when empty directory', { timeout: 60_000 }, async (t) => {
    const dataDir = useTempDir(t, 'helm-models-store-corrupt-')
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
  })
})

describe('official provider auth', { timeout: 60_000 }, () => {
  test('without credentials without environment variable:checkAuth undefined(legal unavailable, without fallback)', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    assert.equal(await models.checkAuth('openai'), undefined)
    assert.equal(await models.checkAuth('anthropic'), undefined)
    const catalog = await listModelCatalog(models)
    const official = catalog.models.filter((e: ModelCatalogEntry) => e.provider === 'openai' || e.provider === 'anthropic')
    assert.ok(official.length > 0, 'official directory model still column out (contains unavailable items)')
    assert.ok(official.every((e: ModelCatalogEntry) => !e.available))
  })

  test('environment variable fall back: official provider original generate semantics', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = OPENAI_FIXTURE_KEY
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.equal(auth.source, 'OPENAI_API_KEY')
  })

  test('credential inject key takes precedence at environment variable', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = 'env-should-lose'
    const models = buildModels({ providers: [], apiKeys: () => ({ openai: OPENAI_FIXTURE_KEY }) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.notEqual(auth.auth.apiKey, 'env-should-lose')
  })

  test('inject key after oauth etc. other auth policy keep', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ anthropic: ANTHROPIC_FIXTURE_KEY }) })
    const provider = models.getProvider('anthropic')
    assert.ok(provider, 'anthropic provider should register')
    assert.ok(provider.auth.oauth, 'official oauth policy must keep (do not because inject apiKey while lose)')
    const auth = await models.getAuth('anthropic')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, ANTHROPIC_FIXTURE_KEY)
  })

  test('without credentials request model: stream with explicit error end, without fallback false answer', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const model = models.getModel('openai', 'gpt-5.2')
    assert.ok(model, 'official directory in model should can parse')
    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.done, false, 'without credentials never can succeeded answer')
    assert.equal(result.error, true, 'must with explicit streaming error end')
    const errorEvent = result.events.find((e) => (e as { type?: string }).type === 'error') as
      | { error?: { errorMessage?: string } }
      | undefined
    assert.ok(errorEvent?.error?.errorMessage, 'error event should carries diagnose information')
  })
})

// ---------------------------------------------------------------------------
// model directory and error semantics
// ---------------------------------------------------------------------------

describe('listModelCatalog error semantics', { timeout: 60_000 }, () => {
  test('not config credentials gateway model available=false(legal state, do not throws)', { timeout: 60_000 }, async () => {
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

  test('checkAuth throw read/protocol error must to upload broadcast, not silently available=false', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    // directly inject a checkAuth throws provider verify pass broadcast semantics (protocol layer contract).
    const provider = models.getProvider('gw-openai')
    assert.ok(provider)
    assert.ok(provider.auth.apiKey, 'compat provider must has apiKey auth')
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
// model reference parse
// ---------------------------------------------------------------------------

describe('model reference', { timeout: 60_000 }, () => {
  test('parseModelRef split provider/model', { timeout: 60_000 }, () => {
    assert.deepEqual(parseModelRef('openai/gpt-5.2'), { provider: 'openai', modelId: 'gpt-5.2' })
    assert.deepEqual(parseModelRef('gw-x/model-with/slash'), { provider: 'gw-x', modelId: 'model-with/slash' })
  })

  test('illegal reference and missing config explicit errors', { timeout: 60_000 }, () => {
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
