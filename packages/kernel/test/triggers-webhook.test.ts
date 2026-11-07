/**
 * builtin:triggers webhook 连接器测试（不依赖 cron 模块）。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 *
 * 覆盖：PluginHost 真实注册 + actions 调用 + 公开路由 HTTP 语义 +
 * secret 持久化与脱敏 + 目标解析（conversationId 优先 / profileId 最低 ID /
 * profileId 不存在拒绝）+ 会话上下文拒绝 + isClosing 拒绝 + doc 损坏报错。
 * cron 由并行模块实现（deps.registerCron 注入空实现，验证组装契约即可）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
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

  constructor() {
    this.conversations.set(1, makeConversation(1, { tags: ['root'] }))
    this.conversations.set(7, makeConversation(7, { profileId: 'worker' }))
    this.conversations.set(4, makeConversation(4, { profileId: 'worker' }))
  }

  dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void> {
    this.dispatched.push(event)
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
  onWorkflowSettled(): () => void {
    return () => {}
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
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
}

interface Harness {
  host: PluginHost
  backend: FakeBackend
  docs: MemoryDocStore
  credentials: CredentialService
  stash: SecretStash
  dataDir: string
  cronRegistered: boolean
}

async function makeHarness(over: Partial<{ closing: boolean }> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-triggers-test-'))
  const backend = new FakeBackend()
  backend.closing = over.closing ?? false
  const docs = new MemoryDocStore()
  const host = new PluginHost({ dataDir, host: backend, docs })
  const credentials = new CredentialService(dataDir)
  const stash = new SecretStash()
  let cronRegistered = false
  const plugin = createTriggersPlugin({
    credentials,
    stash,
    profiles: {
      get: async (id: string) =>
        id === 'assistant' || id === 'worker' || id === 'watchdog' ? { id } : undefined,
    },
    isClosing: () => backend.closing,
    flushDocs: async () => {
      docs.flushCount += 1
    },
    registerCron: () => {
      cronRegistered = true
    },
  })
  await host.register(plugin)
  return { host, backend, docs, credentials, stash, dataDir, cronRegistered }
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
  over: { method?: string } = {},
): Promise<Response> {
  const routes = host.listRoutes().filter((r) => r.path.endsWith(`/webhook/${id}`) || r.path.endsWith('/webhook/:id'))
  const route = routes[0]
  if (route === undefined) throw new Error('webhook 路由未注册')
  const headers: Record<string, string> = {}
  if (secret !== null) {
    headers['x-helm-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  }
  const method = over.method ?? 'POST'
  const request = new Request(`http://hub${WEBHOOK_URL(id)}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  })
  return route.handler(request) as Promise<Response>
}

// ---------------------------------------------------------------------------
// 组装契约
// ---------------------------------------------------------------------------

test('工厂注册：registerCron 收到共享 dispatch/flush 端口；路由/actions/UI 完整注册', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  assert.equal(h.cronRegistered, true)
  const routes = h.host.listRoutes()
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.method, 'POST')
  assert.equal(routes[0]!.public, true)
  assert.equal(routes[0]!.path, `/api/plugins/builtin%3Atriggers/routes/webhook/:id`)
  const actions = h.host.listActions().filter((a) => a.pluginId === TRIGGERS_PLUGIN_ID).map((a) => a.id).sort()
  // 仅断言 webhook 侧动作（cron 动作由并行模块经 registerCron 注册）
  for (const id of ['webhook_create', 'webhook_delete', 'webhook_list']) {
    assert.ok(actions.includes(id), `缺少动作 ${id}`)
  }
  const ui = h.host.listUi().filter((u) => u.pluginId === TRIGGERS_PLUGIN_ID)
  assert.ok(ui.some((u) => u.surface === 'sidebar.item'))
  assert.ok(ui.some((u) => u.surface === 'screen'))
  assert.ok(ui.some((u) => u.surface === 'settings.panel'))
  // screen 订阅 crons + webhooks 两个公共 doc
  const screen = ui.find((u) => u.surface === 'screen')!.spec as { docs: string[] }
  assert.deepEqual([...screen.docs].sort(), ['crons', 'webhooks'])
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
  })) as { webhook: { id: string; createdAt: number } }
  assert.equal(created.webhook.id, 'deploy')
  assert.ok(Number.isFinite(created.webhook.createdAt))
  assert.ok(!JSON.stringify(created).includes('secret'), 'action 输出不得含 secret 字段')

  // credentials.json：精确键 + 0600
  const stored = await h.credentials.getPluginSecret(TRIGGERS_PLUGIN_ID, webhookSecretKey('deploy'))
  assert.equal(stored, secret)
  const mode = (await import('node:fs/promises').then((f) => f.stat(credentialsPath(h.dataDir)))).mode & 0o777
  assert.equal(mode, 0o600)

  // doc：元数据无 secret 明文；public doc 可读
  const doc = h.host.getPublicDoc(TRIGGERS_PLUGIN_ID, 'webhooks')
  const raw = JSON.stringify(doc.value)
  assert.ok(!raw.includes(secret), 'public doc 不得含 secret 明文')
  assert.ok(raw.includes('deploy'))

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
    h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'ok', secret: 'a b' }),
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
  const list = (await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {})) as { webhooks: Array<{ id: string }> }
  assert.deepEqual(list.webhooks.map((w) => w.id), ['a', 'b'])
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

  // body 超限：构造声明超长 content-length 的请求（handler 按头部预检拒绝）
  const routes = h.host.listRoutes()
  const route = routes.find((r) => r.path.endsWith('/webhook/:id'))!
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

test('doc 损坏：条目含 secret 字段 / 重复 id / 结构非法 → 显式 error，不静默重建', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  // 直接篡改底层 doc store（模拟持久层污染）
  h.docs.store.set('builtin:triggers:webhooks', { webhooks: [{ id: 'hook', secret: 'leak', createdAt: 1 }] })
  await rejectsCode(h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_list', {}), 'triggers_doc_corrupt', 500)
  const res = await callWebhookRoute(h.host, 'hook', 'p', 'topsecret')
  assert.equal(res.status, 500)
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

  const mode = (await import('node:fs/promises').then((f) => f.stat(credentialsPath(dataDir)))).mode & 0o777
  assert.equal(mode, 0o600)
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// service 生命周期：停用解除 secret 脱敏登记
// ---------------------------------------------------------------------------

test('停用/启用周期：secret 脱敏登记随 service stop 解除、重启后重新登记', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.host.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', { id: 'hook', secret: 'topsecret' })
  assert.ok(h.stash.redact('x topsecret y').includes('[REDACTED]'))
  await h.host.disable(TRIGGERS_PLUGIN_ID)
  assert.equal(h.stash.redact('x topsecret y'), 'x topsecret y', '停用后脱敏登记应解除')
  await h.host.enable(TRIGGERS_PLUGIN_ID)
  assert.ok(h.stash.redact('x topsecret y').includes('[REDACTED]'), '重启后按持久 secret 重新登记')
  const ok = await callWebhookRoute(h.host, 'hook', 'after-restart', 'topsecret')
  assert.equal(ok.status, 202)
  await h.host.dispose()
  rmSync(h.dataDir, { recursive: true, force: true })
})
