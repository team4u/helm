/**
 * 插件治理与故障隔离专项测试（共享 createHelmx 实例覆盖外部故障恢复与 triggers 占用，配合内存 PluginHost 治理验证）：
 * 1. 外部插件故障隔离状态机：scan/load/define/enable 失败降级为 failed、loadFailed 409 与 reload 自愈、define/enable 修复后自愈且不覆盖磁盘开关；
 * 2. 持久资产占用（inUse）与停用预检：服务自报 + 宿主通用引用探针（profile_runtime / profile_model / conversation_model）+ liveTasks 硬阻断 + builtin:triggers 占用；
 * 3. turn_settled 单插件异常隔离 vs before_turn 严格 fail-closed vs handled 短路；
 * 4. 插件配置分层溯源（sources）、不固化 default、null 重置与 required 校验。
 */
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { HelmxError, type ConversationSummary, type Profile } from '@helmx/protocol'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { PluginHost } from '../../kernel/src/plugins/plugin-host.js'
import { HelmxPluginConfigStore } from '../../kernel/src/runtime/plugin-config-store.js'
import { ConfigService, CredentialService } from '../../kernel/src/services/index.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  createHubTestApp,
  makeConversationSummary,
  MemoryDocStore,
  useTempDir,
} from './helpers/hub-test-env.js'

function makeConversation(id: number, model = ''): ConversationSummary {
  return makeConversationSummary({ id, model })
}

interface HostFixture {
  host: PluginHost
  payloads: Array<{ type: string; payload: unknown }>
  backend: PluginHostBackend & { profileStore: Map<string, Profile>; conversationStore: ConversationSummary[] }
  close(): Promise<void>
}

function makeHostFixture(dataDir: string): HostFixture {
  const payloads: Array<{ type: string; payload: unknown }> = []
  const backend = {
    ...createPluginHostBackendFixture(),
    profileStore: new Map<string, Profile>(),
    conversationStore: [makeConversation(1)] as ConversationSummary[],
    profiles: {
      list: async () => [...backend.profileStore.values()],
      get: async (id: string) => backend.profileStore.get(id),
    },
    listConversations: () => [...backend.conversationStore],
    emitEvent: (type: string, payload: unknown) => {
      payloads.push({ type, payload })
    },
  } as HostFixture['backend']
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    providers: {
      register: async () => async () => {},
      assertIdle: () => {},
    },
  })
  return {
    host,
    payloads,
    backend,
    async close() {
      await host.dispose()
    },
  }
}

function writeExternalPlugin(pluginsDir: string, dir: string, entrySource: string): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), entrySource)
  return dirPath
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<HelmxError> {
  let caught: HelmxError | undefined
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    caught = err
    return true
  })
  return caught!
}

// ---------------------------------------------------------------------------
// 1. createHelmx 端到端故障隔离、自愈恢复与 builtin:triggers inUse（共享单次 createHelmx 启动）
// ---------------------------------------------------------------------------

test('createHelmx 外部插件混合故障隔离、reload/enable 自愈恢复与 builtin:triggers 占用预检', { timeout: 60_000 }, async (t) => {
  const dataDir = join(useTempDir(t, 'helmx-gov-app-'), 'hub')
  const pluginsDir = join(dataDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })

  const PING_PLUGIN = (id: string) =>
    `export default { id: '${id}', name: '${id}', async definePlugin(ctx) {
      ctx.action({ id: 'ping', description: 'probe', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
    } }\n`

  // 1. 混合健康与故障目录
  writeExternalPlugin(pluginsDir, 'good-plugin', PING_PLUGIN('good-plugin'))
  mkdirSync(join(pluginsDir, 'bad-json'), { recursive: true })
  writeFileSync(join(pluginsDir, 'bad-json', 'plugin.json'), '{ broken !!')
  mkdirSync(join(pluginsDir, 'missing-entry'), { recursive: true })
  writeFileSync(join(pluginsDir, 'missing-entry', 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))
  writeExternalPlugin(pluginsDir, 'bad-define', "export default { id: 'bad-define', name: 'define crash', definePlugin() { throw new Error('define phase crash') } }\n")

  // 2. loadFailed 占位待 reload 修复
  const fixDir = join(pluginsDir, 'fix-me')
  mkdirSync(fixDir, { recursive: true })
  writeFileSync(join(fixDir, 'plugin.json'), '{ broken')

  // 3. define 阶段失败待 enable 自愈
  const healDir = writeExternalPlugin(
    pluginsDir,
    'self-heal',
    `import { existsSync } from 'node:fs'
export default { id: 'self-heal', name: 'self-heal', async definePlugin(ctx) {
  if (existsSync(new URL('./broken.flag', import.meta.url))) throw new Error('external dependency not ready')
  ctx.action({ id: 'ping', description: 'probe', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
} }\n`,
  )
  writeFileSync(join(healDir, 'broken.flag'), '1')

  // 4. 持久化 pluginEnabled=true 服务启动失败（不覆盖磁盘开关）待修复自愈
  const svcFailDir = writeExternalPlugin(
    pluginsDir,
    'svc-fail',
    `import { existsSync } from 'node:fs'
export default { id: 'svc-fail', name: 'svc-fail', async definePlugin(ctx) {
  ctx.service({ id: 'daemon', start() { if (existsSync(new URL('./fail.flag', import.meta.url))) throw new Error('external service not ready') }, stop() {} })
} }\n`,
  )
  writeFileSync(join(svcFailDir, 'fail.flag'), '1')
  const configPath = join(dataDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: { 'svc-fail': true } }))

  const { app, kernel } = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    const list = kernel.plugins.list()
    assert.ok(list.some((p) => p.id === 'builtin:profile' && p.enabled))

    await kernel.plugins.enable('good-plugin')
    assert.deepEqual(await kernel.plugins.invokeAction('good-plugin', 'ping', {}), { ok: true })

    assert.equal(list.find((p) => p.id === 'bad-json')?.error?.code, 'plugin_manifest_invalid')
    assert.equal(list.find((p) => p.id === 'missing-entry')?.error?.code, 'plugin_entry_missing')
    const badDef = list.find((p) => p.id === 'bad-define')!
    assert.equal(badDef.status, 'failed')
    assert.equal(badDef.error?.stage, 'define')
    assert.deepEqual([badDef.hooks, badDef.actions, badDef.tools], [[], [], []])

    // loadFailed 占位直接 enable 409，修复源码后 reload + enable 恢复
    await rejectsCode(kernel.plugins.enable('fix-me'), 'plugin_load_failed', 409)
    writeFileSync(join(fixDir, 'index.mjs'), PING_PLUGIN('fix-me'))
    rmSync(join(fixDir, 'plugin.json'))
    const reloaded = await kernel.plugins.reloadExternalPlugin('fix-me')
    assert.equal(reloaded.summary.status, 'disabled')
    assert.equal(reloaded.summary.error, undefined)
    await kernel.plugins.enable('fix-me')
    assert.deepEqual(await kernel.plugins.invokeAction('fix-me', 'ping', {}), { ok: true })

    // define 阶段失败修复外部条件后直接 enable 自愈为 active
    assert.equal(list.find((p) => p.id === 'self-heal')?.error?.stage, 'define')
    rmSync(join(healDir, 'broken.flag'))
    await kernel.plugins.enable('self-heal')
    const healed = kernel.plugins.list().find((p) => p.id === 'self-heal')!
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined)
    assert.deepEqual(await kernel.plugins.invokeAction('self-heal', 'ping', {}), { ok: true })

    // 持久化启用恢复失败保持磁盘开关原值，修复后自愈
    const svcFailed = list.find((p) => p.id === 'svc-fail')!
    assert.equal(svcFailed.status, 'failed')
    assert.equal(svcFailed.error?.stage, 'enable')
    assert.equal(
      (JSON.parse(readFileSync(configPath, 'utf8')) as { pluginEnabled: Record<string, boolean> }).pluginEnabled['svc-fail'],
      true,
    )
    rmSync(join(svcFailDir, 'fail.flag'))
    await kernel.plugins.enable('svc-fail')
    assert.equal(kernel.plugins.list().find((p) => p.id === 'svc-fail')?.status, 'active')

    // builtin:triggers inUse：仅启用态 cron 与 webhook 阻断停用，--force 放行
    const TRIGGERS = 'builtin:triggers'
    await kernel.plugins.enable(TRIGGERS)
    await kernel.plugins.disable(TRIGGERS)
    await kernel.plugins.enable(TRIGGERS)
    await kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'daily', schedule: '0 9 * * *', text: 'morning report' })
    await kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'off', schedule: '0 9 * * *', text: 'x', enabled: false })
    await kernel.plugins.invokeAction(TRIGGERS, 'webhook_create', { id: 'hook1', secret: 'whsec_gov' })
    const inUseErr = await rejectsCode(kernel.plugins.disable(TRIGGERS), 'plugin_in_use', 409)
    const ids = ((inUseErr.details as { usages: Array<{ kind: string; id: string }> }).usages).map((u) => `${u.kind}:${u.id}`).sort()
    assert.deepEqual(ids, ['cron_job:daily', 'webhook_endpoint:hook1'])
    await kernel.plugins.disable(TRIGGERS, { force: true })
    assert.equal(kernel.plugins.list().find((p) => p.id === TRIGGERS)?.enabled, false)
  } finally {
    await app.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 2. PluginHost 治理契约：内置严格失败、手动启用失败、inUse/liveTasks 门禁与状态语义
// ---------------------------------------------------------------------------

test('PluginHost 治理：内置注册严格抛错、手动启用失败透传、inUse/引用探针/liveTasks 门禁与三态语义', { timeout: 60_000 }, async (t) => {
  const fixture = makeHostFixture(useTempDir(t, 'helmx-gov-host-'))
  t.after(() => fixture.close())

  // 1. 内置插件注册失败严格阻断（不降级 failed）
  await rejectsCode(
    fixture.host.register({ id: 'builtin:broken', definePlugin() { throw new Error('defect') } }),
    'plugin_registration_failed',
  )
  assert.equal(fixture.host.list().some((p) => p.id === 'builtin:broken'), false)

  // 2. 手动启用外部插件失败如实上抛且列表反映 failed，修复后恢复 active
  let shouldFail = true
  await fixture.host.register(
    { id: 'ext:manual', definePlugin: (ctx) => { ctx.service({ id: 'svc', start() { if (shouldFail) throw new Error('failed to start') }, stop() {} }) } },
    { enabled: false, isolateFailure: true },
  )
  await rejectsCode(fixture.host.enable('ext:manual'), 'plugin_service_start_failed', 500)
  assert.equal(fixture.host.list().find((p) => p.id === 'ext:manual')?.status, 'failed')
  shouldFail = false
  await fixture.host.enable('ext:manual')
  assert.equal(fixture.host.list().find((p) => p.id === 'ext:manual')?.status, 'active')

  // 3. 服务自报 inUse 与异常形状防护
  let jobs = [{ id: 'j1', schedule: '0 * * * *' }]
  await fixture.host.register({
    id: 'ext:scheduler',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'sched',
        start() {},
        stop() {},
        inUse: () => jobs.map((j) => ({ kind: 'cron_job', id: j.id, label: `cron job "${j.id}" (${j.schedule})` })),
      })
    },
  })
  const schedErr = await rejectsCode(fixture.host.disable('ext:scheduler'), 'plugin_in_use', 409)
  assert.deepEqual((schedErr.details as { usages: unknown }).usages, [{ kind: 'cron_job', id: 'j1', label: 'cron job "j1" (0 * * * *)' }])
  await fixture.host.disable('ext:scheduler', { force: true })
  await fixture.host.enable('ext:scheduler')
  jobs = []
  await fixture.host.disable('ext:scheduler')

  for (const [idx, bad] of (['throw', 'not-array', 'missing-label'] as const).entries()) {
    const id = `ext:bad-inuse-${idx}`
    await fixture.host.register({
      id,
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          inUse: () => {
            if (bad === 'throw') throw new Error('crash')
            if (bad === 'not-array') return 'nope' as never
            return [{ kind: 'x', id: 'y' }] as never
          },
        })
      },
    })
    const err = await rejectsCode(fixture.host.disable(id), 'plugin_in_use_check_failed', 500)
    assert.equal((err.details as { serviceId: string }).serviceId, 'svc')
  }

  // 4. 宿主通用引用探针（profile_runtime / profile_model / conversation_model）与 liveTasks 硬阻断
  const livePanes = new Set<string>(['win-1'])
  await fixture.host.register({
    id: 'ext:runtime',
    definePlugin: (ctx) => {
      ctx.ui.profileRuntime({ id: 'rt', kind: 'myrt', label: 'external runtime' })
      ctx.provider({
        id: 'prov-a',
        name: 'Prov A',
        auth: { apiKey: { name: 'k', resolve: async () => undefined } },
        getModels: () => [],
        stream: () => { throw new Error('no') },
        streamSimple: () => { throw new Error('no') },
      } as never)
      ctx.service({
        id: 'svc',
        start() {},
        stop() {},
        liveTasks: () => [...livePanes].map((p) => `pane:${p}`),
      })
    },
  })
  // liveTasks 硬阻断：force 也不得跳过
  await rejectsCode(fixture.host.disable('ext:runtime', { force: true }), 'plugin_has_live_tasks', 409)
  livePanes.clear()

  fixture.backend.profileStore.set('coder', { id: 'coder', name: 'encode role', runtime: { kind: 'myrt', agent: 'pi' } })
  fixture.backend.profileStore.set('writer', { id: 'writer', name: 'write act role', model: 'prov-a/some-model' })
  fixture.backend.conversationStore.push(makeConversation(9, 'prov-a/another'))

  const refErr = await rejectsCode(fixture.host.disable('ext:runtime'), 'plugin_in_use', 409)
  const usages = (refErr.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
  assert.deepEqual(usages.map((u) => `${u.kind}:${u.id}`).sort(), ['conversation_model:9', 'profile_model:writer', 'profile_runtime:coder'])
  await fixture.host.disable('ext:runtime', { force: true })

  // 5. PluginSummary active / disabled / failed 与重注册清空错误
  await fixture.host.register({ id: 'ext:dead', definePlugin() { throw new Error('hang') } }, { isolateFailure: true })
  assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')?.status, 'failed')
  await fixture.host.unregister('ext:dead')
  await fixture.host.register({ id: 'ext:dead', definePlugin: () => {} }, { enabled: false, isolateFailure: true })
  const revived = fixture.host.list().find((p) => p.id === 'ext:dead')!
  assert.equal(revived.status, 'disabled')
  assert.equal(revived.error, undefined)
})

// ---------------------------------------------------------------------------
// 3. turn_settled 单插件异常隔离 vs before_turn 严格 fail-closed
// ---------------------------------------------------------------------------

test('Hook 隔离契约：turn_settled 隔离单插件抛错/坏返回并保留最新合法载荷，before_turn 严格 fail-closed，handled 正常短路', { timeout: 60_000 }, async (t) => {
  const f1 = makeHostFixture(useTempDir(t, 'helmx-gov-hook1-'))
  t.after(() => f1.close())

  const seen: Array<{ outcome: string; error?: string }> = []
  await f1.host.register({ id: 'broken-settler', definePlugin: (ctx) => { ctx.hook.onTurnSettled(() => { throw new Error('boom in settler') }, { priority: 10 }) } })
  await f1.host.register({ id: 'bad-action-settler', definePlugin: (ctx) => { ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'nope' }) as never, { priority: 5 }) } })
  await f1.host.register({ id: 'transform-settler', definePlugin: (ctx) => { ctx.hook.onTurnSettled((p) => ({ action: 'transform', value: { ...p, error: 'transformed-note' } }), { priority: 3 }) } })
  await f1.host.register({ id: 'break-transform', definePlugin: (ctx) => { ctx.hook.onTurnSettled(() => ({ action: 'transform', value: { broken: true } as never }), { priority: 2 }) } })
  await f1.host.register({ id: 'good-settler', definePlugin: (ctx) => { ctx.hook.onTurnSettled((p) => { seen.push({ outcome: p.outcome, error: p.error }); return { action: 'continue' } }) } })
  await f1.host.register({ id: 'strict:before', definePlugin: (ctx) => { ctx.hook.onBeforeTurn(() => { throw new Error('before_turn crash') }) } })

  await rejectsCode(
    f1.host.runHook('before_turn', { conversation: makeConversation(1), inputs: [], tools: [], sections: [], messages: [] }),
    'hook_execution_failed',
    500,
  )

  const settled = await f1.host.runHook('turn_settled', { conversation: makeConversation(1), inputs: [], outcome: 'failed', settledAt: 100 })
  assert.equal(settled.action, 'transform')
  assert.deepEqual(seen, [{ outcome: 'failed', error: 'transformed-note' }])
  const warnings = f1.payloads.filter((e) => e.type === 'notification').map((e) => e.payload as { level: string; title: string })
  assert.equal(warnings.length, 3)

  // handled 短路与非法初始载荷直接报错
  const f2 = makeHostFixture(useTempDir(t, 'helmx-gov-hook2-'))
  t.after(() => f2.close())
  let downstreamRan = false
  await f2.host.register({ id: 'handled:settle', definePlugin: (ctx) => { ctx.hook.onTurnSettled(() => ({ action: 'handled', result: { settled: true } }), { priority: 10 }) } })
  await f2.host.register({ id: 'after:settle', definePlugin: (ctx) => { ctx.hook.onTurnSettled(() => { downstreamRan = true; return { action: 'continue' } }) } })
  assert.deepEqual(
    await f2.host.runHook('turn_settled', { conversation: makeConversation(1), inputs: [], outcome: 'completed', settledAt: 1 }),
    { action: 'handled', result: { settled: true } },
  )
  assert.equal(downstreamRan, false)
  await rejectsCode(
    f2.host.runHook('turn_settled', { conversation: makeConversation(1), inputs: [], outcome: 'weird' as never, settledAt: 1 }),
    'invalid_hook_result',
  )
})

// ---------------------------------------------------------------------------
// 4. 插件配置分层溯源、不固化 default、null 重置与 required 校验
// ---------------------------------------------------------------------------

test('插件配置分层：磁盘不固化 default、sources 三态溯源、null 重置删除磁盘与机密桶、required 与未知字段校验', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-gov-cfg-')
  const credentialsDir = join(dataDir, 'cred')
  mkdirSync(credentialsDir, { recursive: true })
  const store = new HelmxPluginConfigStore({
    config: new ConfigService(dataDir),
    credentials: new CredentialService(credentialsDir),
  })
  await store.load()
  const base = makeHostFixture(dataDir)
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: base.backend,
    docs: new MemoryDocStore(),
    config: store,
  })
  t.after(async () => {
    await host.dispose()
    await base.close()
  })

  await host.register({
    id: 'ext:cfg',
    definePlugin: (ctx) => {
      ctx.configSchema({
        endpoint: { type: 'string', label: 'end point', default: 'http://127.0.0.1:3425' },
        timeout: { type: 'number', label: 'timeout', default: 5000 },
        apiKey: { type: 'string', label: 'secret key', secret: true },
      })
    },
  })

  assert.deepEqual(host.getConfig('ext:cfg'), { endpoint: 'http://127.0.0.1:3425', timeout: 5000 })
  assert.deepEqual(host.getConfigSources('ext:cfg'), { endpoint: 'default', timeout: 'default', apiKey: 'unset' })

  await host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
  assert.deepEqual(
    (JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.['ext:cfg'],
    { timeout: 8000 },
  )
  assert.deepEqual(host.getConfig('ext:cfg'), { endpoint: 'http://127.0.0.1:3425', timeout: 8000, apiKey: 'sk-123' })
  assert.deepEqual(host.getConfigSources('ext:cfg'), { endpoint: 'default', timeout: 'configured', apiKey: 'configured' })

  // null 重置两个字段：磁盘配置桶与机密桶均被清理
  await host.setConfig('ext:cfg', { timeout: null, apiKey: null })
  assert.equal((JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.['ext:cfg'], undefined)
  assert.equal(
    (JSON.parse(readFileSync(join(credentialsDir, 'credentials.json'), 'utf8')) as { pluginSecrets?: Record<string, unknown> }).pluginSecrets?.['ext:cfg'],
    undefined,
  )
  assert.equal(host.getConfig('ext:cfg').timeout, 5000)
  assert.deepEqual(host.getConfigSources('ext:cfg'), { endpoint: 'default', timeout: 'default', apiKey: 'unset' })

  await rejectsCode(host.setConfig('ext:cfg', { unknown: null }), 'validation_error', 400)
  assert.deepEqual(host.getConfig('ext:unknown'), {})

  // required 字段缺失/清空/类型与未知字段校验
  const reqSchema = { token: { type: 'string' as const, required: true }, optional: { type: 'string' as const } }
  await rejectsCode(store.set('ext:req', {}, reqSchema), 'validation_error', 400)
  await store.set('ext:req', { token: 't1' }, reqSchema)
  assert.equal(store.get('ext:req').token, 't1')
  await rejectsCode(store.set('ext:req', { token: null }, reqSchema), 'validation_error', 400)
  await rejectsCode(store.set('ext:req', { nope: 'x' }, reqSchema), 'validation_error', 400)
  await rejectsCode(store.set('ext:req', { token: 42 }, reqSchema), 'validation_error', 400)
})
