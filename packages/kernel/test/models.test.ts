/**
 * Model integration tests: local fake HTTP OpenAI/Anthropic-compatible servers intercept real pi-ai SDK
 * outbound requests (explicitly avoiding external network models), verifying:
 * - baseURL / path / bearer / x-api-key / model ID assembly is correct;
 * - credential-injected keys override env vars while env vars remain valid fallbacks;
 * - missing keys are explicitly unavailable (checkAuth undefined / stream error) with no fake fallback answer;
 * - checkAuth reflects real SDK semantics (AuthCheck | undefined), never guessing with Boolean(source);
 * - listModelCatalog never swallows read/protocol errors (missing credentials is a valid state; real errors throw).
 *
 * Credentials always use explicit fixtures without reading real env vars; relevant env vars are cleared
 * in beforeEach and restored in after.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import type { ProviderConfig } from '@helmx/protocol'
import type { ApiKeyAuth, MutableModels, Models, Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  buildModels,
  knownContextWindowOf,
  listModelCatalog,
  listModelProviders,
  parseModelRef,
  requireModelRef,
  wrapModelsForCompaction,
  type HelmxModelSourceMeta,
  type ModelCatalogEntry,
} from '../src/runtime/models.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { HelmxError } from '@helmx/protocol'
import { useTempDir } from './helpers.js'

/** Single captured request. */
interface CapturedRequest {
  method: string
  /** Full path including query string. */
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

const OPENAI_FIXTURE_KEY = 'fixture-openai-key-000'
const ANTHROPIC_FIXTURE_KEY = 'fixture-anthropic-key-000'

/** Generic SSE / JSON fake server: records requests and responds per protocol. */
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

  /** OpenAI chat.completions streaming response: two text deltas + stop + usage. */
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

  /** Anthropic messages SSE: message_start -> content_block_start -> delta -> stop -> message_delta/stop. */
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
    assert.ok(this.baseUrl !== '', 'fake gateway not started')
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
    assert.ok(req, 'fake gateway received no request')
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

/** Collects stream events until done or error. */
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
// Compatible gateways: real SDK request assembly (local fake HTTP, explicitly not external models)
// ---------------------------------------------------------------------------

describe('compatible gateway (openai protocol)', { timeout: 60_000 }, () => {
  test('static model window is explicitly marked unknown (helmxContextWindowKnown preserved across setProvider/getModel)', { timeout: 60_000 }, () => {
    const models = buildModels({
      providers: [openaiCompatConfig('http://127.0.0.1:9/v1')],
      apiKeys: () => ({}),
    })
    const model = models.getModel('gw-openai', 'gw-openai-model')
    assert.ok(model, 'compat model should be registered in catalog')
    // Request schema default stays present (needed to send requests), yet is not treated as a real known window.
    assert.equal(model.contextWindow, 128_000)
    assert.equal((model as typeof model & HelmxModelSourceMeta).helmxContextWindowKnown, false, 'compat static model must carry unknown marker')
    assert.equal(knownContextWindowOf(model), undefined, 'known-window extraction must omit static default')
    // Built-in provider models are treated as known: windows come from curated data.
    const builtin = models.getModels().find((entry) => entry.contextWindow > 0)
    assert.ok(builtin, 'built-in provider catalog should contain models with contextWindow')
    assert.equal(knownContextWindowOf(builtin), builtin.contextWindow, 'built-in model window should be recognized as known')
    assert.equal(knownContextWindowOf(undefined), undefined)
  })

  test('listModelCatalog projects only real known windows: omits static default / non-positive / non-finite', { timeout: 60_000 }, async () => {
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
    // Format matches Magpie catalog output (toPiModel): known window has no marker; unknown carries
    // helmxContextWindowKnown: false + defensive 128k default.
    const list = [
      { ...base, id: 'known', contextWindow: 400_000 },
      { ...base, id: 'static-default', contextWindow: 128_000, helmxContextWindowKnown: false },
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
    assert.equal(byId.get('known')!.contextWindow, 400_000, 'real known window should be projected as-is')
    assert.equal('contextWindow' in (byId.get('static-default') ?? {}), false, 'static default window must be omitted')
    assert.equal('contextWindow' in (byId.get('infinite') ?? {}), false, 'non-finite window must be omitted')
    assert.equal('contextWindow' in (byId.get('zero') ?? {}), false, 'non-positive window must be omitted')
    assert.equal(knownContextWindowOf(list[2] as never), undefined, 'Infinity must not pass through')
  })

  test('streamSimple assembles baseURL/path/bearer/modelId and receives live streaming response', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const model = models.getModel('gw-openai', 'gw-openai-model')
    assert.ok(model, 'compat model should be registered in catalog')
    assert.equal(model.provider, 'gw-openai')
    assert.equal(model.baseUrl, `${openaiGateway.url}/v1`)

    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.error, false, 'fake gateway returns a valid stream and must not fail')
    assert.equal(result.done, true)

    const req = openaiGateway.last()
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/v1/chat/completions')
    assert.equal(openaiGateway.header(req, 'authorization'), 'Bearer fixture-gw-key-111')
    assert.equal((req.body as { model?: string }).model, 'gw-openai-model')
  })

  test('checkAuth and getAuth reflect injected credentials (real SDK semantics)', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({ 'gw-openai': 'fixture-gw-key-111' }),
    })
    const auth = await models.getAuth('gw-openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, 'fixture-gw-key-111')
    const check = await models.checkAuth('gw-openai')
    assert.ok(check, 'gateway with injected key should return AuthCheck')
    assert.equal(check.type, 'api_key')

    const bare = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    const bareAuth = await bare.getAuth('gw-openai')
    assert.equal(bareAuth, undefined, 'missing credentials is a valid unconfigured state (undefined)')
    assert.equal(await bare.checkAuth('gw-openai'), undefined)
  })
})

describe('compatible gateway (anthropic protocol)', { timeout: 60_000 }, () => {
  test('streamSimple assembles /v1/messages path and x-api-key header', { timeout: 60_000 }, async () => {
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
    // max_tokens comes from compat defaults (explicitly marked defensive config, not fabricated)
    assert.equal(typeof (req.body as { max_tokens?: number }).max_tokens, 'number')
  })
})

// ---------------------------------------------------------------------------
// Official providers: SDK checkAuth semantics + credentials override env vars
// ---------------------------------------------------------------------------

describe('PI full provider suite', { timeout: 60_000 }, () => {
  test('registers all built-in providers cleanly, preserving native metadata and zero-model providers', { timeout: 60_000 }, () => {
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
    // Built-in summary has four base keys; baseUrl is a valid public field (shared by many gateways like deepseek);
    // dynamic is set only for providers actually implementing refreshModels (radius).
    const radius = summaries.find((provider) => provider.id === 'radius')
    assert.ok(radius)
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined, 'radius has no fixed gateway baseUrl and must not fabricate one')
    assert.ok(
      summaries
        .filter((provider) => provider.id !== 'radius')
        .every((provider) => Object.keys(provider).sort().join(',') !== '' && !('dynamic' in provider)),
    )
    const deepseek = summaries.find((provider) => provider.id === 'deepseek')
    assert.ok(deepseek?.baseUrl)
    assert.equal('dynamic' in deepseek, false)
  })

  test('injects keys for non-OpenAI/Anthropic native providers without inventing API Keys for OAuth-only ones', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ deepseek: 'fixture-deepseek', 'openai-codex': 'fixture-not-oauth' }) })
    assert.equal((await models.getAuth('deepseek'))?.auth.apiKey, 'fixture-deepseek')
    assert.equal(models.getProvider('openai-codex')?.auth.apiKey, undefined)
    assert.ok(models.getProvider('openai-codex')?.auth.oauth)
  })

  test('preserves Cloudflare native config validation and auth header conversion without raw Bearer override', { timeout: 60_000 }, async () => {
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

  test('custom gateways preserve explicit override and disablement semantics', { timeout: 60_000 }, () => {
    const override = { ...openaiCompatConfig('http://127.0.0.1/v1'), id: 'deepseek' }
    const enabled = buildModels({ providers: [override], apiKeys: () => ({}) })
    assert.deepEqual(enabled.getModels('deepseek').map((model) => model.id), ['gw-openai-model'])
    const disabled = buildModels({ providers: [{ ...override, enabled: false }], apiKeys: () => ({}) })
    assert.deepEqual(disabled.getModels('deepseek'), builtinProviders().find((provider) => provider.id === 'deepseek')!.getModels())
  })

  test('extraProviders registers runtime providers without dropping catalog summary fields', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-fx', models: [{ id: 'fx-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    assert.ok(models.getProvider('plugin-fx'))
    assert.deepEqual(models.getModels('plugin-fx').map((model) => model.id), ['fx-model'])
    const summaries = listModelProviders(models)
    const fx = summaries.find((summary) => summary.id === 'plugin-fx')
    assert.ok(fx)
    assert.equal(fx.modelCount, 1)
    // faux lacks refreshModels: must not fabricate dynamic marker.
    assert.equal(fx.dynamic, undefined)
  })

  test('listModelProviders attaches dynamic/baseUrl/pluginId (via providerOwners)', { timeout: 60_000 }, () => {
    const faux = fauxProvider({ provider: 'plugin-owned', models: [{ id: 'owned-model' }] })
    const models = buildModels({ providers: [], apiKeys: () => ({}), extraProviders: [faux.provider] })
    const owners = new Map([['plugin-owned', 'builtin:demo']])
    const owned = listModelProviders(models, owners).find((summary) => summary.id === 'plugin-owned')
    assert.equal(owned?.pluginId, 'builtin:demo')
    // Same collection without owners: pluginId is omitted (ownership is never fabricated).
    const anon = listModelProviders(models).find((summary) => summary.id === 'plugin-owned')
    assert.equal(anon?.pluginId, undefined)
    // Built-in dynamic provider (radius) carries dynamic flag; omits pluginId without owners and avoids fabricating baseUrl.
    const radius = listModelProviders(models).find((summary) => summary.id === 'radius')
    assert.ok(radius, 'built-in radius provider should appear in catalog')
    assert.equal(radius.dynamic, true)
    assert.equal(radius.baseUrl, undefined)
    assert.equal(radius.pluginId, undefined)
  })
})

describe('file-backed dynamic catalog cache (models-store.json)', { timeout: 60_000 }, () => {
  test('ENOENT returns undefined; write/update/delete persist and concurrent updates never lose writes', { timeout: 60_000 }, async (t) => {
    const dataDir = useTempDir(t, 'helmx-models-store-')
    const store = createFileModelsStore(dataDir)
    assert.equal(await store.read('p1'), undefined)

    await store.write('p1', { models: [], checkedAt: 111 })
    await store.write('p2', { models: [], checkedAt: 222, etag: '"v1"' })
    assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
    assert.deepEqual(await store.read('p2'), { models: [], checkedAt: 222, etag: '"v1"' })

    // update: undefined keeps existing entry; object updates it.
    await store.update('p1', async () => undefined)
    assert.deepEqual(await store.read('p1'), { models: [], checkedAt: 111 })
    await store.update('p1', async (current) => ({ ...current!, checkedAt: 333 }))
    assert.equal((await store.read('p1'))?.checkedAt, 333)
    await store.delete('p2')
    assert.equal(await store.read('p2'), undefined)

    // Concurrent updates: two different providers read-modify-write concurrently; lock serializes writes safely.
    await Promise.all([
      store.update('a', async () => ({ models: [], checkedAt: 1 })),
      store.update('b', async () => ({ models: [], checkedAt: 2 })),
    ])
    assert.equal((await store.read('a'))?.checkedAt, 1)
    assert.equal((await store.read('b'))?.checkedAt, 2)

    // Permissions are 0600 and top-level is an object (Windows lacks POSIX mode bits, skip check there).
    const raw = JSON.parse(await readFile(join(dataDir, 'models-store.json'), 'utf8')) as Record<string, unknown>
    assert.ok(typeof raw['p1'] === 'object')
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      const mode = (await stat(join(dataDir, 'models-store.json'))).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  test('corrupt file explicitly throws models_store_corrupted rather than silently acting empty', { timeout: 60_000 }, async (t) => {
    const dataDir = useTempDir(t, 'helmx-models-store-corrupt-')
    const path = join(dataDir, 'models-store.json')
    await writeFile(path, '{invalid-json')
    const store = createFileModelsStore(dataDir)
    await assert.rejects(() => store.read('p1'), (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'models_store_corrupted')
      return true
    })
    await writeFile(path, '["array"]')
    await assert.rejects(() => store.read('p1'), (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'models_store_corrupted')
      return true
    })
    await assert.rejects(() => store.update('p1', () => ({ models: [] })), (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'models_store_corrupted')
      return true
    })
  })
})

describe('official provider auth', { timeout: 60_000 }, () => {
  test('no credentials and no env vars: checkAuth returns undefined (validly unavailable, no fallback)', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    assert.equal(await models.checkAuth('openai'), undefined)
    assert.equal(await models.checkAuth('anthropic'), undefined)
    const catalog = await listModelCatalog(models)
    const official = catalog.models.filter((e: ModelCatalogEntry) => e.provider === 'openai' || e.provider === 'anthropic')
    assert.ok(official.length > 0, 'official catalog models are still listed (including unavailable entries)')
    assert.ok(official.every((e: ModelCatalogEntry) => !e.available))
  })

  test('env var fallback: official provider native semantics', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = OPENAI_FIXTURE_KEY
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.equal(auth.source, 'OPENAI_API_KEY')
  })

  test('injected credential key overrides env var', { timeout: 60_000 }, async () => {
    process.env['OPENAI_API_KEY'] = 'env-should-lose'
    const models = buildModels({ providers: [], apiKeys: () => ({ openai: OPENAI_FIXTURE_KEY }) })
    const auth = await models.getAuth('openai')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, OPENAI_FIXTURE_KEY)
    assert.notEqual(auth.auth.apiKey, 'env-should-lose')
  })

  test('oauth and other auth strategies remain intact after key injection', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({ anthropic: ANTHROPIC_FIXTURE_KEY }) })
    const provider = models.getProvider('anthropic')
    assert.ok(provider, 'anthropic provider should be registered')
    assert.ok(provider.auth.oauth, 'official oauth strategy must be preserved (never lost when injecting apiKey)')
    const auth = await models.getAuth('anthropic')
    assert.ok(auth)
    assert.equal(auth.auth.apiKey, ANTHROPIC_FIXTURE_KEY)
  })

  test('requesting model without credentials terminates stream with explicit error, never fake answer', { timeout: 60_000 }, async () => {
    const models = buildModels({ providers: [], apiKeys: () => ({}) })
    const model = models.getModel('openai', 'gpt-5.2')
    assert.ok(model, 'model in official catalog should resolve')
    const result = await drainStream(
      models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    )
    assert.equal(result.done, false, 'request without credentials must never succeed')
    assert.equal(result.error, true, 'must terminate with explicit stream error')
    const errorEvent = result.events.find((e) => (e as { type?: string }).type === 'error') as
      | { error?: { errorMessage?: string } }
      | undefined
    assert.ok(errorEvent?.error?.errorMessage, 'error event should carry diagnostic details')
  })
})

// ---------------------------------------------------------------------------
// Model catalog and error semantics
// ---------------------------------------------------------------------------

describe('listModelCatalog error semantics', { timeout: 60_000 }, () => {
  test('unconfigured gateway model reports available=false (valid state, does not throw)', { timeout: 60_000 }, async () => {
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

  test('read/protocol error thrown by checkAuth must propagate upward instead of silently reporting available=false', { timeout: 60_000 }, async () => {
    const models = buildModels({
      providers: [openaiCompatConfig(`${openaiGateway.url}/v1`)],
      apiKeys: () => ({}),
    })
    // Directly inject a provider whose checkAuth throws to verify propagation semantics (protocol layer contract).
    const provider = models.getProvider('gw-openai')
    assert.ok(provider)
    assert.ok(provider.auth.apiKey, 'compat provider must have apiKey auth')
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
// Model ref parsing
// ---------------------------------------------------------------------------

describe('model references', { timeout: 60_000 }, () => {
  test('parseModelRef splits provider/model', { timeout: 60_000 }, () => {
    assert.deepEqual(parseModelRef('openai/gpt-5.2'), { provider: 'openai', modelId: 'gpt-5.2' })
    assert.deepEqual(parseModelRef('gw-x/model-with/slash'), { provider: 'gw-x', modelId: 'model-with/slash' })
  })

  test('invalid references and missing config error explicitly', { timeout: 60_000 }, () => {
    assert.throws(() => parseModelRef('noslash'), HelmxError)
    assert.throws(() => parseModelRef('/leading'), HelmxError)
    assert.throws(() => parseModelRef('trailing/'), HelmxError)
    assert.throws(() => requireModelRef(undefined), (error: unknown) => {
      assert.ok(error instanceof HelmxError)
      assert.equal((error as HelmxError).code, 'model_not_configured')
      return true
    })
    assert.throws(() => requireModelRef('  '), HelmxError)
  })
})

describe('compaction thinking resolution (wrapModelsForCompaction)', { timeout: 60_000 }, () => {
  interface CapturedCall {
    provider: string
    modelId: string
    reasoning: string | undefined
  }

  /** Models set with two faux providers; a response factory records the effective model + reasoning per call. */
  async function fixtureCompaction() {
    const models = createModels()
    // Reasoning-capable faux models so SDK thinking-level clamping keeps levels like 'high' intact.
    const main = fauxProvider({ provider: 'fx-main', models: [{ id: 'main-model', reasoning: true }] })
    const compaction = fauxProvider({ provider: 'fx-sum', models: [{ id: 'sum-model', reasoning: true }] })
    models.setProvider(main.provider)
    models.setProvider(compaction.provider)
    const captured: CapturedCall[] = []
    const respond = (text: string): import('@earendil-works/pi-ai/providers/faux').FauxResponseFactory => (
      (_context, options, _state, model) => {
        captured.push({
          provider: model.provider,
          modelId: model.id,
          reasoning: (options as { reasoning?: string } | undefined)?.reasoning,
        })
        return fauxAssistantMessage(text)
      }
    )
    return { models, main, compaction, captured, respond }
  }

  const compactionContext = () => ({
    messages: [
      { role: 'system' as const, content: 'You are a context summarization assistant. Be concise.', timestamp: Date.now() },
      { role: 'user' as const, content: 'summarize the conversation', timestamp: Date.now() },
    ],
  })

  test('per-model default applies when no explicit compaction level is set; explicit level still wins', { timeout: 60_000 }, async () => {
    const { models, main, compaction, captured, respond } = await fixtureCompaction()
    main.setResponses([respond('main passthrough')])
    compaction.setResponses([respond('summary'), respond('summary'), respond('summary')])

    const summarize = async (
      resolution: { model?: string; thinkingLevel?: string; modelThinkingLevel?: (p: string, m: string) => string | undefined },
    ) => {
      const wrapped = wrapModelsForCompaction(models, () => ({
        model: resolution.model,
        thinkingLevel: resolution.thinkingLevel,
        modelThinkingLevel: resolution.modelThinkingLevel,
        isDisabled: () => false,
      }))
      return wrapped.completeSimple(
        models.getModel('fx-main', 'main-model')!,
        compactionContext(),
        { cacheRetention: 'none', reasoning: 'low', maxTokens: 4096 },
      )
    }

    // 1. Per-model default for the compaction model outranks the conversation-carried reasoning.
    await summarize({ model: 'fx-sum/sum-model', modelThinkingLevel: () => 'high' })
    assert.deepEqual(captured.at(-1), { provider: 'fx-sum', modelId: 'sum-model', reasoning: 'high' })

    // 2. No per-model entry: the caller reasoning passes through unchanged (compaction on the current model).
    await summarize({ model: 'fx-sum/sum-model', modelThinkingLevel: () => undefined })
    assert.deepEqual(captured.at(-1), { provider: 'fx-sum', modelId: 'sum-model', reasoning: 'low' })

    // 3. Explicit compaction thinking level outranks the per-model default.
    await summarize({ model: 'fx-sum/sum-model', thinkingLevel: 'minimal', modelThinkingLevel: () => 'high' })
    assert.deepEqual(captured.at(-1), { provider: 'fx-sum', modelId: 'sum-model', reasoning: 'minimal' })
  })

  test('without a compaction model the conversation request passes through untouched', { timeout: 60_000 }, async () => {
    const { models, main, captured, respond } = await fixtureCompaction()
    main.setResponses([respond('main passthrough')])
    const wrapped = wrapModelsForCompaction(models, () => ({
      model: undefined,
      modelThinkingLevel: (p, m) => (p === 'fx-main' && m === 'main-model' ? 'max' : undefined),
      isDisabled: () => false,
    }))
    await wrapped.completeSimple(
      models.getModel('fx-main', 'main-model')!,
      compactionContext(),
      { cacheRetention: 'none', reasoning: 'low' },
    )
    // Per-model lookup must not fire for the conversation model: its level already flowed through conversation resolution.
    assert.deepEqual(captured, [{ provider: 'fx-main', modelId: 'main-model', reasoning: 'low' }])
  })
})
