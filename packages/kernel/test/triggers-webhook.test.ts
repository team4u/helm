/**
 * builtin:triggers webhook 连接器测试（不依赖 cron 模块）。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 *
 * 覆盖：PluginHost 真实注册 + actions 调用 + 公开路由 HTTP 语义 +
 * secret 持久化与脱敏 + 目标解析（conversationId 优先 / profileId 最低 ID /
 * profileId 不存在拒绝）+ 会话上下文拒绝 + isClosing 拒绝 + doc 损坏报错。
 * cron 调度使用工厂真实注册路径；本文件聚焦 webhook 与投递契约。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import {
  HelmError,
  type ConversationSummary,
  type MaybePromise,
  type PluginDefinition,
  type WorkflowRunSummary,
  type ExternalTriggerEnvelope,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { CredentialService, credentialsPath } from '../src/services/index.js'
import { SecretStash } from '../src/services/secret-stash.js'
import { createTriggersPlugin } from '../src/builtin-plugins/triggers.js'
import { TRIGGERS_PLUGIN_ID, webhookSecretKey } from '../src/builtin-plugins/triggers/contracts.js'
import { STOP_REQUEST_WAIT_MS } from '../src/builtin-plugins/triggers/webhook.js'

/** POSIX 0600 断言：Windows 无 POSIX mode（NTFS 走 ACL），跳过模式位校验。 */
async function assertCredentialsMode0600(dataDir: string): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await import('node:fs/promises').then((f) => f.stat(credentialsPath(dataDir)))).mode & 0o777
  assert.equal(mode, 0o600)
}

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

class FakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  events: Array<{ type: string; payload: unknown }> = []
  dispatched: ExternalTriggerEnvelope[] = []
  nextId = 100
  closing = false
  /** 插件私有 secrets 后端存储（backend 契约带 pluginId 首参）。 */
  secretsStore = new Map<string, string>()
  redactions = new Set<string>()
  /** 存在的 Profile id 集合（旧名 profiles 与新 profiles 端口重名，改 profileIds）。 */
  profileIds = new Set(['assistant', 'worker', 'watchdog'])
  /** 可控门：dispatchTrigger 在此 pending，resolve 后才返回（并发门禁测试）。 */
  dispatchGate: Promise<void> | null = null
  /** body 读取门：首 chunk 已可读、第二 chunk 挂起（流式超限测试）。 */

  constructor() {
    this.conversations.set(1, makeConversation(1, { tags: ['root'] }))
    this.conversations.set(7, makeConversation(7, { profileId: 'worker' }))
    this.conversations.set(4, makeConversation(4, { profileId: 'worker' }))
  }

  dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void> {
    this.dispatched.push(event)
    if (this.dispatchGate !== null) {
      const gate = this.dispatchGate
      return gate.then(() => {})
    }
    return Promise.resolve()
  }
  submitInput(): Promise<void> {
    return Promise.resolve()
  }
  createConversation(init: { title?: string; profileId?: string }): Promise<ConversationSummary> {
    const created = makeConversation(this.nextId++, { profileId: init.profileId ?? 'assistant', title: init.title })
    this.conversations.set(created.id, created)
    return Promise.resolve(created)
  }
  listConversations(filter?: { profileId?: string }): ConversationSummary[] {
    const all = [...this.conversations.values()]
    return filter?.profileId === undefined ? all : all.filter((c) => c.profileId === filter.profileId)
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id))
  }
  manageConversation(): () => void {
    return () => {}
  }
  markConversationOwnership(): void {}
  createAsk(): Promise<{ id: string; status: 'answered'; answers: Record<string, string> }> {
    return Promise.resolve({ id: 'ask-1', status: 'answered', answers: {} })
  }
  cancelAsk(): Promise<void> {
    return Promise.resolve()
  }
  registerAskSeqResolver(): () => void {
    return () => {}
  }
  onEvent(): () => void {
    return () => {}
  }
  async abortConversation(): Promise<void> {}
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human'
  }
  async spawnAgent(): Promise<unknown> {
    return {}
  }
  async runGate(): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: '' }
  }
  async prepareInterruptedConversations(): Promise<void> {}
  async invokeAction(): Promise<unknown> {
    return {}
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  async execEnv(): Promise<import('@helm/protocol').EnvExecResponse> {
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  listActions(): [] {
    return []
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
  }
  // ---- 零参工厂消费的宿主公共端口（与 kernel-host 后端同形；backend 契约
  // 为 isClosing() 方法，PluginHost 归一为插件侧 getter） ----
  isClosing(): boolean {
    return this.closing
  }
  skills = {
    list: async () => [],
    readFile: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
    directory: async (id: string) => `/tmp/triggers-fixture-skills/${id}`,
    ensureSkill: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
  }
  setPluginConfig(): Promise<void> { return Promise.resolve() }
  async getConversationDetail(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无详情', 501) }
  async listArtifacts(): Promise<never[]> { return [] }
  async getArtifact(): Promise<never> { throw new HelmError('not_found', '无产物', 404) }
  redact(text: string): string { return text }
  redactText(text: string): string { return text }
  async completeText(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型', 501) }
  executionEnv(): never { throw new HelmError('unsupported', '本 fixture 无执行环境', 501) }
  withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() }
  async atomicWriteFile(): Promise<void> { throw new HelmError('unsupported', '本 fixture 无原子写', 501) }
  buildSpawnEnv(): Record<string, string> { return {} }
  async refreshModels(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async probeNodeFs(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不探测节点 fs', 501) }
  secrets = {
    get: async (pluginId: string, key: string) => this.secretsStore.get(`${pluginId}:${key}`),
    set: async (pluginId: string, key: string, value: string) => {
      this.secretsStore.set(`${pluginId}:${key}`, value)
    },
    delete: async (pluginId: string, key: string) => {
      this.secretsStore.delete(`${pluginId}:${key}`)
    },
    addRedaction: (value: string) => {
      this.redactions.add(value)
      return () => {
        this.redactions.delete(value)
      }
    },
  }
  profiles = {
    list: async () => [...this.profileIds].map((id) => ({ id })),
    get: async (id: string) => (this.profileIds.has(id) ? { id } : undefined),
    getSystem: async () => {
      throw new HelmError('unsupported', '本 fixture 不提供 profiles.getSystem', 501)
    },
    save: async () => {
      throw new HelmError('unsupported', '本 fixture 不提供 profiles.save', 501)
    },
    directory: async () => {
      throw new HelmError('unsupported', '本 fixture 不提供 profiles.directory', 501)
    },
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  flushCount = 0
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
  async flush(): Promise<void> {
    this.flushCount += 1
  }
}

interface Harness {
  host: PluginHost
  backend: FakeBackend
  docs: MemoryDocStore
  credentials: CredentialService
  stash: SecretStash
  dataDir: string
}

async function makeHarness(over: Partial<{ closing: boolean }> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-triggers-test-'))
  const backend = new FakeBackend()
  backend.closing = over.closing ?? false
  const docs = new MemoryDocStore()
  const credentials = new CredentialService(dataDir)
  const stash = new SecretStash()
  // 零参工厂：直接注册（secrets/profiles/isClosing/doc.flush 全走宿主端口）。
  // secrets 后端镜像写入真实 CredentialService 供落盘断言（0600 / 精确键 /
  // 跨重启）——生产链路由 runtime 后端直连 credentialsSvc（见 kernel-host）。
  const innerSecrets = backend.secrets
  const host = new PluginHost({ dataDir, host: backend, docs })
  backend.secrets = {
    get: (pluginId, key) => {
      void innerSecrets
      return credentials.getPluginSecret(pluginId, key)
    },
    set: async (pluginId, key, value) => {
      await credentials.setPluginSecret(pluginId, key, value)
      await innerSecrets.set(pluginId, key, value)
    },
    delete: async (pluginId, key) => {
      await credentials.deletePluginSecret(pluginId, key)
      await innerSecrets.delete(pluginId, key)
    },
    addRedaction: (value) => {
      const release = stash.addRedaction(value)
      return () => release()
    },
  }
  await host.register(createTriggersPlugin())
  return { host, backend, docs, credentials, stash, dataDir }
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    return true
  })
}

const WEBHOOK_URL = (id: string): string =>
  `/api/plugins/${encodeURIComponent(TRIGGERS_PLUGIN_ID)}/routes/webhook/${encodeURIComponent(id)}`

/** 从路由清单直接调用 webhook handler（测试/集成用）。 */
async function callWebhookRoute(
  host: PluginHost,
  id: string,
  body: string,
  secret: string | null,
  over: { method?: string; rawBytes?: Uint8Array } = {},
): Promise<Response> {
  const routes = host.listRoutes().filter((r) => r.path.endsWith(`/webhook/${id}`) || r.path.endsWith('/webhook/:id'))
  const route = routes[0]
  if (route === undefined) throw new Error('webhook 路由未注册')
  const headers: Record<string, string> = {}
  const rawBytes = over.rawBytes
  if (secret !== null) {
    const signed = rawBytes ?? new TextEncoder().encode(body)
    headers['x-helm-signature'] = `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`
  }
  const method = over.method ?? 'POST'
  const request = new Request(`http://hub${WEBHOOK_URL(id)}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: rawBytes !== undefined ? new Blob([rawBytes as BlobPart]) : body }),
    duplex: 'half',
  } as RequestInit)
  return route.handler(request) as Promise<Response>
}

// ---------------------------------------------------------------------------
// 组装契约
// ---------------------------------------------------------------------------

test('工厂注册：cron/webhook 动作、路由与声明式贡献完整注册', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  assert.ok(h.host.listActions().some((action) => action.id === 'cron_list'))
  const routes = h.host.listRoutes()
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.method, 'POST')
  assert.equal(routes[0]!.public, true)
  assert.equal(routes[0]!.path, `/api/plugins/builtin%3Atriggers/routes/webhook/:id`)
  const actions = h.host.listActions().filter((a) => a.pluginId === TRIGGERS_PLUGIN_ID).map((a) => a.id).sort()
  // cron 与 webhook 共用工厂，确认 webhook 侧动作完整注册。
  for (const id of ['webhook_create', 'webhook_delete', 'webhook_list']) {
    assert.ok(actions.includes(id), `缺少动作 ${id}`)
  }
  const ui = h.host.listUi().filter((u) => u.pluginId === TRIGGERS_PLUGIN_ID)
  assert.ok(ui.some((u) => u.surface === 'sidebar.item'))
  assert.ok(ui.some((u) => u.surface === 'screen'))
  assert.ok(ui.some((u) => u.surface === 'settings.panel'))
  // screen 贡献指向 client.tsx 组件（doc 订阅由插件 client 经 plugin-client-sdk 完成）
  const screen = ui.find((u) => u.surface === 'screen')!.spec as { client: { module: string; export: string } }
  assert.equal(screen.client.module, 'index.tsx')
  assert.equal(screen.client.export, 'TriggersManagerScreen')
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// webhook 生命周期动作
// ---------------------------------------------------------------------------

test('webhook_create：secret 落 credentials.json 0600 + stash 脱敏 + doc 无 secret + flush 生效', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  const secret = 's3cret-value-不上-model'
  const created = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
    id: 'deploy',
    description: '部署回调',
    secret,
  })) as { webhook: { id: string; hasSecret: boolean; createdAt: number } }
  assert.equal(created.webhook.id, 'deploy')
  assert.equal(created.webhook.hasSecret, true, '元数据必须以 hasSecret 布尔表达，绝不含 secret 原文')
  assert.ok(Number.isFinite(created.webhook.createdAt))
  assert.ok(!JSON.stringify(created).includes('secret:'), 'action 输出不得含 secret 原文')

  // credentials.json：精确键 + 0600（Windows 无 POSIX mode）
  const stored = await h.credentials.getPluginSecret(TRIGGERS_PLUGIN_ID, webhookSecretKey('deploy'))
  assert.equal(stored, secret)
  await assertCredentialsMode0600(h.dataDir)

  // doc：元数据无 secret 明文且携带 hasSecret；public doc 可读
  const doc = h.host.getPublicDoc(TRIGGERS_PLUGIN_ID, 'webhooks')
  const raw = JSON.stringify(doc.value)
  assert.ok(!raw.includes(secret), 'public doc 不得含 secret 明文')
  assert.ok(raw.includes('deploy'))
  assert.match(raw, /"hasSecret"\s*:\s*true/, '公开 doc 元数据必须携带 hasSecret:true')

  // stash 脱敏生效
  assert.ok(h.stash.redact(`prefix ${secret} suffix`).includes('[REDACTED]'))

  // flush 在 create 成功前被调用（假持久防护）
  assert.ok(h.docs.flushCount >= 1)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('webhook_create 校验：id/secret 形状、两目标互斥、重复 409、会话上下文 403', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'bad id', secret: 'x'.repeat(32) }),
    'validation_error',
    400,
  )
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'a\u0000b' }),
    'validation_error',
    400,
  )
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'x'.repeat(600) }),
    'validation_error',
    400,
  )
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
      id: 'ok',
      secret: 'x'.repeat(32),
      targetConversationId: 1,
      targetProfileId: 'worker',
    }),
    'validation_error',
    400,
  )
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
      id: 'ok',
      secret: 'x'.repeat(32),
      targetConversationId: 0,
    }),
    'validation_error',
    400,
  )
  // 会话上下文（run_action 路径）：拒绝（secret 已入模型历史的边界纪律）
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'x'.repeat(32) }, { conversationId: 1 }),
    'webhook_secret_context_forbidden',
    403,
  )
  // schema 层拒绝（inputSchema additionalProperties:false）
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'x'.repeat(32), extra: 1 }),
    'validation_error',
    400,
  )
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'x'.repeat(32) })
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'y'.repeat(32) }),
    'webhook_exists',
    409,
  )
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('webhook_list / webhook_delete：删除清理 secret 与 doc 条目；再删 404', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'a', secret: 'sa' })
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'b', secret: 'sb' })
  const list = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {})) as { webhooks: Array<{ id: string; hasSecret: boolean }> }
  assert.deepEqual(list.webhooks.map((w) => w.id), ['a', 'b'])
  assert.ok(list.webhooks.every((w) => w.hasSecret === true), 'list 输出每条元数据带 hasSecret:true')
  const deleted = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_delete', { id: 'a' })) as { deleted: boolean }
  assert.deepEqual(deleted, { deleted: true })
  assert.equal(await h.credentials.getPluginSecret(TRIGGERS_PLUGIN_ID, webhookSecretKey('a')), undefined)
  assert.equal(await h.credentials.getPluginSecret(TRIGGERS_PLUGIN_ID, webhookSecretKey('b')), 'sb')
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_delete', { id: 'a' }), 'not_found', 404)
  const after = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {})) as { webhooks: Array<{ id: string }> }
  assert.deepEqual(after.webhooks.map((w) => w.id), ['b'])
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 公开路由 HTTP 语义
// ---------------------------------------------------------------------------

test('公开路由：无签名 401 / 错签名 401 / 不存在 404 / 正确签名 202 且原始 text 投递', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })

  const noSig = await callWebhookRoute(h.host, 'hook', 'hello', null)
  assert.equal(noSig.status, 401)

  // 错误签名：直接构造
  const routes = h.host.listRoutes()
  const route = routes.find((r) => r.path.endsWith('/webhook/:id'))!
  const bad = new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': 'sha256=' + '0'.repeat(64) },
    body: 'hello',
  })
  assert.equal((await (route.handler(bad) as Promise<Response>)).status, 401)

  const missing = await callWebhookRoute(h.host, 'ghost', 'hello', 'topsecret')
  assert.equal(missing.status, 404)

  const ok = await callWebhookRoute(h.host, 'hook', 'hello raw body', 'topsecret')
  assert.equal(ok.status, 202)
  assert.deepEqual(await ok.json(), { accepted: true })
  assert.equal(h.backend.dispatched.length, 1)
  const envelope = h.backend.dispatched[0]!
  assert.equal(envelope.source, 'webhook:hook')
  // 原始 utf8 body 直投（runtime defang 在 dispatchTrigger 内统一包裹）
  assert.equal(envelope.text, 'hello raw body')
  assert.equal(envelope.targetConversationId, undefined)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('公开路由：签名覆盖原始字节（utf8 多字节）+ body 超限 413 + GET 404', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  const text = '你好 webhook中文载荷'
  const ok = await callWebhookRoute(h.host, 'hook', text, 'topsecret')
  assert.equal(ok.status, 202)
  assert.equal(h.backend.dispatched[0]!.text, text)

  // body 超限（无 content-length 的分块流）：首 chunk 已可读、第二 chunk 挂起，
  // readBody 流式累计超限后 cancel 并 413（不吞完整 body 到内存）
  const routes = h.host.listRoutes()
  const route = routes.find((r) => r.path.endsWith('/webhook/:id'))!
  const firstChunk = new Uint8Array(200 * 1024).fill(0x61)
  const overflowGate = new Promise<void>(() => {}) // 永不 resolve：验证 cancel 语义
  const streamed = new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': 'sha256=' + '0'.repeat(64) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk)
        // 第二块超过 256KiB 上限：readBody 读到即超限 cancel，不会拉取本块
        controller.enqueue(new Uint8Array(100 * 1024).fill(0x62))
        void overflowGate
      },
    }),
    duplex: 'half',
  } as RequestInit)
  assert.equal((await (route.handler(streamed) as Promise<Response>)).status, 413)

  // 声明超长 content-length 的请求：头部预检直接 413
  const huge = new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': 'sha256=' + '0'.repeat(64), 'content-length': String(300 * 1024) },
    body: 'x',
  })
  assert.equal((await (route.handler(huge) as Promise<Response>)).status, 413)

  const get = await callWebhookRoute(h.host, 'hook', '', 'topsecret', { method: 'GET' })
  assert.equal(get.status, 404)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('公开路由：threadKey/targetConversationId 元数据生效（投递 envelope 携带）', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
    id: 'hook',
    secret: 'topsecret',
    threadKey: 'deploy-42',
    targetConversationId: 7,
  })
  const ok = await callWebhookRoute(h.host, 'hook', 'payload', 'topsecret')
  assert.equal(ok.status, 202)
  assert.equal(h.backend.dispatched[0]!.threadKey, 'deploy-42')
  assert.equal(h.backend.dispatched[0]!.targetConversationId, 7)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('公开路由：runtime 关闭中拒绝投递（runtime_closing 409）；目标会话不存在 404', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret', targetConversationId: 7 })
  h.backend.closing = true
  const closing = await callWebhookRoute(h.host, 'hook', 'payload', 'topsecret')
  assert.equal(closing.status, 409)
  h.backend.closing = false

  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'gone', secret: 'topsecret', targetConversationId: 999 })
  const gone = await callWebhookRoute(h.host, 'gone', 'payload', 'topsecret')
  assert.equal(gone.status, 404)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 目标解析（targetProfileId 路径）
// ---------------------------------------------------------------------------

test('targetProfileId：现有会话取最低 ID；无会话校验 Profile 后创建；不存在 Profile 拒绝', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  // worker Profile 现有 #4 与 #7 → 最低 ID 4
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
    id: 'to-worker',
    secret: 'topsecret',
    targetProfileId: 'worker',
  })
  const res1 = await callWebhookRoute(h.host, 'to-worker', 'p', 'topsecret')
  assert.equal(res1.status, 202)
  assert.equal(h.backend.dispatched[0]!.targetConversationId, 4)

  // watchdog Profile 无会话 → 创建并投递新 ID
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
    id: 'to-watchdog',
    secret: 'topsecret',
    targetProfileId: 'watchdog',
  })
  const res2 = await callWebhookRoute(h.host, 'to-watchdog', 'p', 'topsecret')
  assert.equal(res2.status, 202)
  const created = h.backend.dispatched[1]!.targetConversationId
  assert.ok(created !== undefined && created >= 100, `应创建新会话，实际 ${String(created)}`)
  assert.equal(h.backend.conversations.get(created!)!.profileId, 'watchdog')

  // 不存在的 Profile：创建时校验拒绝
  await rejectsCode(
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
      id: 'to-ghost',
      secret: 'topsecret',
      targetProfileId: 'ghost',
    }),
    'validation_error',
    400,
  )
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// doc 损坏与 secret 不一致（诚实性纪律）
// ---------------------------------------------------------------------------

test('doc 损坏：条目含 secret 字段 / 重复 id / 缺 hasSecret / 结构非法 → 显式 error，不静默重建', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // 直接篡改底层 doc store（模拟持久层污染）
  h.docs.store.set('builtin:triggers:webhooks', { webhooks: [{ id: 'hook', secret: 'leak', hasSecret: true, createdAt: 1 }] })
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  const res = await callWebhookRoute(h.host, 'hook', 'p', 'topsecret')
  assert.equal(res.status, 500)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('doc 边界：旧开发 doc 缺 hasSecret / 双目标 / 越界字段 → 读入即拒，不静默修复', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  const key = 'builtin:triggers:webhooks'
  const seed = (webhooks: unknown[]): void => {
    h.docs.store.set(key, { webhooks })
  }
  // 旧开发 doc（无 hasSecret）：不兼容、不迁移，显式报错
  seed([{ id: 'old', createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // hasSecret 非严格 true 同样拒绝（布尔字段不可为 false/其他值）
  seed([{ id: 'x', hasSecret: false, createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // 双目标互斥
  seed([{ id: 'x', hasSecret: true, targetConversationId: 1, targetProfileId: 'worker', createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // description 超长（> 500）
  seed([{ id: 'x', hasSecret: true, description: 'd'.repeat(501), createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // threadKey 越界（> 200）
  seed([{ id: 'x', hasSecret: true, threadKey: 'k'.repeat(201), createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // targetProfileId 空串
  seed([{ id: 'x', hasSecret: true, targetProfileId: '', createdAt: 1 }])
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  // 修复后正常通过（合法形状）
  seed([{ id: 'ok', hasSecret: true, createdAt: 1 }])
  const list = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {})) as { webhooks: Array<{ id: string; hasSecret: boolean }> }
  assert.equal(list.webhooks[0]!.id, 'ok')
  assert.equal(list.webhooks[0]!.hasSecret, true)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('doc 与 secret 不一致：入口存在但 secret 缺失 → 显式 500（绝不静默放行无签名）', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // doc 与 secret 不一致：入口存在但 secret 缺失（模拟 credentials.json 损坏）
  await h.credentials.deletePluginSecret(TRIGGERS_PLUGIN_ID, webhookSecretKey('hook'))
  const res = await callWebhookRoute(h.host, 'hook', 'p', 'topsecret')
  assert.equal(res.status, 500)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'webhook_secret_missing')
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// CredentialService.deletePluginSecret 精确删除（独立验证）
// ---------------------------------------------------------------------------

test('credentials.deletePluginSecret：精确删单键、空桶回收、幂等、其他键不受影响、恒 0600', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-credentials-del-'))
  const svc = new CredentialService(dataDir)
  await svc.setPluginSecret('builtin:triggers', 'webhook:a', 'sa')
  await svc.setPluginSecret('builtin:triggers', 'webhook:b', 'sb')
  await svc.setPluginSecret('builtin:other', 'keep', 'sk')

  await svc.deletePluginSecret('builtin:triggers', 'webhook:a')
  assert.equal(await svc.getPluginSecret('builtin:triggers', 'webhook:a'), undefined)
  assert.equal(await svc.getPluginSecret('builtin:triggers', 'webhook:b'), 'sb')
  assert.equal(await svc.getPluginSecret('builtin:other', 'keep'), 'sk')

  // 幂等：再删不报错
  await svc.deletePluginSecret('builtin:triggers', 'webhook:a')

  // 删最后一个键后：空桶整体回收
  await svc.deletePluginSecret('builtin:triggers', 'webhook:b')
  const raw = JSON.parse(readFileSync(credentialsPath(dataDir), 'utf8')) as {
    pluginSecrets: Record<string, Record<string, string>>
  }
  assert.equal(raw.pluginSecrets['builtin:triggers'], undefined)
  assert.equal(raw.pluginSecrets['builtin:other']!['keep'], 'sk')

  await assertCredentialsMode0600(dataDir)
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// service 生命周期：停用解除 secret 脱敏登记
// ---------------------------------------------------------------------------

test('停用/启用周期：secret 脱敏登记随 service stop 解除、重启后重新登记', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  assert.ok(h.stash.redact('x topsecret y').includes('[REDACTED]'))
  // webhook 端点为持久占用（inUse）：知情后 force 停用。
  await h.host.disable(TRIGGERS_PLUGIN_ID, { force: true })
  assert.equal(h.stash.redact('x topsecret y'), 'x topsecret y', '停用后脱敏登记应解除')
  await h.host.enable(TRIGGERS_PLUGIN_ID)
  assert.ok(h.stash.redact('x topsecret y').includes('[REDACTED]'), '重启后按持久 secret 重新登记')
  const ok = await callWebhookRoute(h.host, 'hook', 'after-restart', 'topsecret')
  assert.equal(ok.status, 202)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 边界加固：坏 UTF8 显式拒绝 / 已删入口不投递 / 停用门禁（真实 PluginHost）
// ---------------------------------------------------------------------------

test('无效 UTF8：签名正确（覆盖原始字节）但 body 非法 UTF8 → 400 invalid_body，不静默替换', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // 0xff 为非法 UTF8 序列；签名按原始字节计算（正确）
  const badBytes = new TextEncoder().encode('ok:').slice()
  const raw = new Uint8Array([...badBytes, 0xff, 0xfe])
  const res = await callWebhookRoute(h.host, 'hook', '', 'topsecret', { rawBytes: raw })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_body')
  // 绝不发生投递（解码失败先于 dispatch）
  assert.equal(h.backend.dispatched.length, 0)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('投递开始后删除：已在途事件完成，新请求 404', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // 用 dispatch 门禁阻塞在 handler 内部：body 已读、dispatch 未完时删除入口
  let releaseGate!: () => void
  h.backend.dispatchGate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const pending = callWebhookRoute(h.host, 'hook', 'first', 'topsecret')
  // 等待 dispatch 已被调用（事件已入 dispatched），此时删除 webhook
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (h.backend.dispatched.length > 0) resolve()
      else setTimeout(check, 1)
    }
    check()
  })
  // 注意：旧实现 dispatch 已过 doc 重查点；此请求是门内旧事件（dispatch 已开始）。
  // 释放后重新发新请求：此时入口已删 → 404，且不再新增投递。
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_delete', { id: 'hook' })
  releaseGate()
  assert.equal((await pending).status, 202)
  const after = await callWebhookRoute(h.host, 'hook', 'second', 'topsecret')
  assert.equal(after.status, 404)
  assert.equal(h.backend.dispatched.length, 1, '已删入口不得再投递新事件')
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('读取请求体期间删除或重建端点，旧请求不再投递', { timeout: 60_000 }, async () => {
  for (const recreate of [false, true]) {
    const h = await makeHarness()
    await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'old-secret' })
    const bytes = new TextEncoder().encode('旧端点的请求')
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(bytes.slice(0, 2))
          entered()
        } else {
          await gate
          controller.enqueue(bytes.slice(2))
          controller.close()
        }
      },
    }, { highWaterMark: 0 })
    const handler = h.host.listRoutes().find((route) => route.path.endsWith('/webhook/:id'))!.handler
    const pending = Promise.resolve(handler(new Request(`http://hub${WEBHOOK_URL('hook')}`, {
      method: 'POST',
      headers: { 'x-helm-signature': `sha256=${createHmac('sha256', 'old-secret').update(bytes).digest('hex')}` },
      body,
      duplex: 'half',
    } as RequestInit)))
    try {
      await reading
      await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_delete', { id: 'hook' })
      if (recreate) await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'new-secret' })
      release()
      assert.equal((await pending).status, recreate ? 409 : 404)
      assert.equal(h.backend.dispatched.length, 0)
    } finally {
      release()
      await pending
      await h.host.dispose()
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  }
})

test('停用门禁：dispatch 挂起时 disable 得 409 plugin_has_live_tasks；release 后 disable 成功；旧 handler 拒绝', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  let releaseGate!: () => void
  h.backend.dispatchGate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  // 预先捕获旧 handler 句柄（停用后 listRoutes 不再列出，用残留句柄验证拒绝）
  const staleHandler = h.host.listRoutes().find((r) => r.path.endsWith('/webhook/:id'))!.handler
  const pending = callWebhookRoute(h.host, 'hook', 'blocked', 'topsecret')
  // 等 dispatch 真正进入门内（事件已记录）——无 sleep 碰运气
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (h.backend.dispatched.length > 0) resolve()
      else setTimeout(check, 1)
    }
    check()
  })
  // 在途请求未收敛：disable 被 liveTasks 闸门拒绝（409 plugin_has_live_tasks）
  await rejectsCode(h.host.disable(TRIGGERS_PLUGIN_ID), 'plugin_has_live_tasks', 409)
  releaseGate()
  assert.equal((await pending).status, 202)
  // 收敛后 disable 成功（webhook 端点持久占用 → force）
  await h.host.disable(TRIGGERS_PLUGIN_ID, { force: true })
  assert.equal(h.stash.redact('x topsecret y'), 'x topsecret y', '停用后脱敏登记解除')
  // 停用后旧 handler 残留调用：显式拒绝（409），不再投递
  const staleSig = `sha256=${createHmac('sha256', 'topsecret').update('after-disable').digest('hex')}`
  const stale = (await staleHandler(new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': staleSig },
    body: 'after-disable',
    duplex: 'half',
  } as RequestInit))) as Response
  assert.equal(stale.status, 409)
  const staleBody = (await stale.json()) as { error: { code: string } }
  assert.equal(staleBody.error.code, 'plugin_disabled')
  assert.equal(h.backend.dispatched.length, 1, '停用后不得新投递')
  // 重启后恢复服务（新周期新 handler）
  await h.host.enable(TRIGGERS_PLUGIN_ID)
  const ok = await callWebhookRoute(h.host, 'hook', 'after-enable', 'topsecret')
  assert.equal(ok.status, 202)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('stop 有界等待：在途请求永不收敛时超时放行并如实记录（不挂死停用）', { timeout: 60_000 }, async (t) => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  const handler = h.host.listRoutes().find((r) => r.path.endsWith('/webhook/:id'))!.handler
  // 慢客户端：首块可读、尾块永不到达（body 读取永久挂起，不 enqueue 不 close）
  void (handler(
    new Request(`http://hub${WEBHOOK_URL('hook')}`, {
      method: 'POST',
      headers: { 'x-helm-signature': 'sha256=' + '0'.repeat(64) },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
        },
      }),
      duplex: 'half',
    } as RequestInit),
  ) as Promise<Response>)
  // 前置：在途请求计入 liveTasks，非 force 停用被拒（同时验证登记已生效）
  let blocked = false
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
    try {
      await h.host.disable(TRIGGERS_PLUGIN_ID)
      break
    } catch (err) {
      if (err instanceof HelmError && err.code === 'plugin_has_live_tasks') blocked = true
      else throw err
    }
  }
  assert.equal(blocked, true, '前置：慢客户端请求应阻塞停用')

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '))
  }
  // 有界等待用 mock timers 驱动（真实 10s 不进测试）；仅 mock setTimeout。
  // 注：force disable 仍受 liveTasks 闸门拦截（保护不拆除在途请求）；无界等待
  // 的真实风险面是 dispose（close 语义无条件 stop），故性此路径验证。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const disposing = h.host.dispose()
    await new Promise<void>((resolve) => setImmediate(resolve))
    t.mock.timers.tick(STOP_REQUEST_WAIT_MS)
    await disposing
  } finally {
    t.mock.timers.reset()
    console.error = originalError
  }
  assert.ok(errors.some((line) => line.includes('未收敛')), '超时必须如实记录未收敛请求数')
  rmSync(h.dataDir, { recursive: true, force: true })
})

test('停用门禁：body 读取阶段（凭据已查、body 未读完）disable 同样 409；release 后停用成功', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // 预捕获旧 handler（停用后用残留句柄验证拒绝）
  const staleHandler = h.host.listRoutes().find((r) => r.path.endsWith('/webhook/:id'))!.handler
  // 构造首 chunk 可读、尾 chunk 挂起的流：handler 停在 body 读取（凭据已查）
  let releaseBody!: () => void
  const bodyHeld = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
  const pending = new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': 'sha256=' + '0'.repeat(64) },
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        await bodyHeld
        controller.enqueue(new TextEncoder().encode('-tail'))
        controller.close()
      },
    }),
    duplex: 'half',
  } as RequestInit)
  const inflight = staleHandler(pending) as Promise<Response>
  // 轮询 disable 探测在途登记生效（409 即在途；成功则说明尚未进入 handler，重试）
  let blockedAtBody = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await h.host.disable(TRIGGERS_PLUGIN_ID)
      break
    } catch (err) {
      if (err instanceof HelmError && err.code === 'plugin_has_live_tasks') {
        blockedAtBody = true
        break
      }
      throw err
    }
  }
  assert.equal(blockedAtBody, true, 'body 读取阶段的在途请求必须阻塞 disable（liveTasks 生效）')
  releaseBody()
  assert.equal((await inflight).status, 401, '签名不匹配（占位签名）→ 401')
  // 收敛后 disable 成功（webhook 端点持久占用 → force）
  await h.host.disable(TRIGGERS_PLUGIN_ID, { force: true })
  // 停用后旧 handler 残留调用：拒绝
  const staleSig = `sha256=${createHmac('sha256', 'topsecret').update('after').digest('hex')}`
  const stale = (await staleHandler(new Request(`http://hub${WEBHOOK_URL('hook')}`, {
    method: 'POST',
    headers: { 'x-helm-signature': staleSig },
    body: 'after',
    duplex: 'half',
  } as RequestInit))) as Response
  assert.equal(stale.status, 409)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})
