/**
 * 插件治理与故障隔离增强专项测试（设计文档 20261111）。
 *
 * 覆盖四项能力：
 * 1. 外部插件故障隔离状态机：scan/load/define/enable 阶段失败降级登记为
 *    status:'failed'（含结构化 error 诊断），不阻断 createHelm；loadFailed
 *    占位条目 enable 直接 409 plugin_load_failed；修复源码后 reload 恢复；
 *    define 阶段失败修复后 enable 自愈为 active；
 * 2. 持久资源占用（inUse）与停用预检：服务自声明 + 宿主通用引用探测
 *    （profile_runtime / profile_model / conversation_model）；409 plugin_in_use
 *    + force 强制停用；liveTasks 硬阻断 force 也不跳过；inUse 检查异常显式
 *    plugin_in_use_check_failed 绝不静默当空；
 * 3. turn_settled 单插件异常隔离：单处理器抛错或非法产物不阻断下游、发
 *    warning notification 告警；transform 保留上一合法载荷；
 * 4. 插件配置分层溯源：磁盘只存显式覆写值（不固化 default）、getConfig 合成
 *    default、getConfigSources 区分 configured/default/unset、null 重置。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type ConversationSummary, type Profile } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { PluginHost } from '../src/plugins/plugin-host.js'
import {
  ConfigService,
  CredentialService,
} from '../src/services/index.js'
import { HelmPluginConfigStore } from '../src/runtime/plugin-config-store.js'
import {
  type PluginConfigStore,
  type PluginDocStore,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

async function createApp(dataDir: string) {
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
}

function makeConversation(id: number, model = ''): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model,
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
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
  async flush(): Promise<void> {}
}

/** 内存配置 store：支持 null 删除语义（与 HelmPluginConfigStore 契约一致）。 */
class MemoryConfigStore implements PluginConfigStore {
  store = new Map<string, Record<string, unknown>>()
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.store.get(pluginId) ?? {}) }
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    const current = this.store.get(pluginId) ?? {}
    const next = { ...current }
    for (const [key, v] of Object.entries(value)) {
      if (v === null) delete next[key]
      else next[key] = v
    }
    if (Object.keys(next).length === 0) this.store.delete(pluginId)
    else this.store.set(pluginId, next)
  }
}

interface HostFixture {
  host: PluginHost
  events: string[]
  payloads: Array<{ type: string; payload: unknown }>
  backend: PluginHostBackend & { profileStore: Map<string, Profile>; conversationStore: ConversationSummary[] }
  dataDir: string
  close(): Promise<void>
}

/** 带受控 Profile / 会话存储的后端夹具（宿主引用探测断言用）。 */
function makeBackend(): HostFixture['backend'] {
  const payloads: Array<{ type: string; payload: unknown }> = []
  const events: string[] = []
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
      events.push(`event:${type}`)
      payloads.push({ type, payload })
    },
  } as HostFixture['backend']
  // 把共享收集器挂到 backend 上（fixture 内部通信，不参与契约）
  Object.assign(backend, { __events: events, __payloads: payloads })
  return backend
}

function makeHostFixture(overrides: { config?: PluginConfigStore } = {}): HostFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-test-'))
  const backend = makeBackend()
  const events = (backend as unknown as { __events: string[] }).__events
  const payloads = (backend as unknown as { __payloads: Array<{ type: string; payload: unknown }> }).__payloads
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    ...(overrides.config ? { config: overrides.config } : {}),
  })
  return {
    host,
    events,
    payloads,
    backend,
    dataDir,
    async close() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 在磁盘写入一个外部插件目录（index.mjs 形态）。 */
function writeExternalPlugin(
  pluginsDir: string,
  dir: string,
  entrySource: string,
  manifest?: Record<string, unknown>,
): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), entrySource)
  if (manifest !== undefined) {
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify(manifest))
  }
  return dirPath
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<HelmError> {
  let caught: HelmError | undefined
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    caught = err
    return true
  })
  assert.ok(caught instanceof HelmError)
  return caught
}

// ---------------------------------------------------------------------------
// 1. 外部插件故障隔离状态机（failed 态与恢复）
// ---------------------------------------------------------------------------

test('外部插件混合故障目录：createHelm 正常启动，好插件可用，坏插件逐个登记为 failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-mixed-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // 好插件
    writeExternalPlugin(
      pluginsDir,
      'good-plugin',
      `export default {\n  id: 'good-plugin',\n  name: '好插件',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: '探活',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    // 坏 plugin.json（scan 阶段）
    const badJson = join(pluginsDir, 'bad-json')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'plugin.json'), '{ broken !!')
    // 入口缺失（scan 阶段）
    const missingEntry = join(pluginsDir, 'missing-entry')
    mkdirSync(missingEntry, { recursive: true })
    writeFileSync(join(missingEntry, 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))
    // definePlugin 抛错（define 阶段，经 isolateFailure 吸收）
    writeExternalPlugin(
      pluginsDir,
      'bad-define',
      `export default {\n  id: 'bad-define',\n  name: '定义崩溃',\n  definePlugin() { throw new Error('define 阶段崩溃') },\n}\n`,
    )

    app = await createApp(dataDir)
    const list = app.kernel.plugins.list()

    // 好插件正常注册且可用
    const good = list.find((p) => p.id === 'good-plugin')
    assert.ok(good, '好插件应被注册')
    assert.equal(good.enabled, false)
    await app.kernel.plugins.enable('good-plugin')
    const ping = (await app.kernel.plugins.invokeAction('good-plugin', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)

    // 坏 plugin.json：failed + plugin_manifest_invalid
    const broken = list.find((p) => p.id === 'bad-json')
    assert.ok(broken, '坏 manifest 插件应登记为 failed 条目')
    assert.equal(broken.enabled, false)
    assert.equal(broken.status, 'failed')
    assert.equal(broken.error!.code, 'plugin_manifest_invalid')

    // 入口缺失：failed + plugin_entry_missing
    const missing = list.find((p) => p.id === 'missing-entry')
    assert.ok(missing)
    assert.equal(missing.status, 'failed')
    assert.equal(missing.error!.code, 'plugin_entry_missing')

    // definePlugin 抛错：failed + stage 'define'
    const bad = list.find((p) => p.id === 'bad-define')
    assert.ok(bad, 'define 崩溃插件应登记为 failed 条目（不整体阻断）')
    assert.equal(bad.status, 'failed')
    assert.equal(bad.enabled, false)
    assert.equal(bad.error!.stage, 'define')
    assert.match(bad.error!.message, /define 阶段崩溃/)
    // failed 插件无任何能力注册
    assert.deepEqual(bad.hooks, [])
    assert.deepEqual(bad.actions, [])
    assert.deepEqual(bad.tools, [])

    // 内置插件不受影响
    assert.ok(list.some((p) => p.id === 'builtin:profile' && p.enabled))
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadFailed 占位条目：enable 直接 409 plugin_load_failed；修复源码后 reload 恢复可用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'fix-me')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ broken')

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'fix-me')
    assert.ok(failed, '坏 manifest 登记为目录名占位条目')
    assert.equal(failed.status, 'failed')

    // loadFailed 条目 enable 拒绝：无有效 definition，重 enable 无法自愈
    await rejectsCode(app.kernel.plugins.enable('fix-me'), 'plugin_load_failed', 409)

    // 修复源码：写入合法入口
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'fix-me',\n  name: '修复后插件',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: '探活',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    rmSync(join(dirPath, 'plugin.json'))

    const result = await app.kernel.plugins.reloadExternalPlugin('fix-me')
    assert.equal(result.pluginId, 'fix-me')
    assert.equal(result.summary.status, 'disabled', '重载后恢复为正常 disabled 条目（error 清空）')
    assert.equal(result.summary.error, undefined)

    // reload 后 enable 成功，动作可用
    await app.kernel.plugins.enable('fix-me')
    const ping = (await app.kernel.plugins.invokeAction('fix-me', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('define 阶段失败的外部插件（有效 definition）：修复后 enable 自愈为 active，error 清空', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-heal-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'self-heal')
    mkdirSync(dirPath, { recursive: true })
    // 模块加载成功但 definePlugin 抛错（受配置控制：state 文件存在时失败）
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `import { existsSync } from 'node:fs'\nexport default {\n  id: 'self-heal',\n  name: '自愈插件',\n  async definePlugin(ctx) {\n    if (existsSync(new URL('./broken.flag', import.meta.url))) throw new Error('外部依赖未就绪')\n    ctx.action({\n      id: 'ping',\n      description: '探活',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    writeFileSync(join(dirPath, 'broken.flag'), '1')

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'self-heal')
    assert.ok(failed)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error!.stage, 'define')

    // 修复外部条件后 enable 自愈（definition 有效，重跑 definePlugin）
    rmSync(join(dirPath, 'broken.flag'))
    await app.kernel.plugins.enable('self-heal')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'self-heal')!
    assert.equal(healed.enabled, true)
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined, 'enable 成功后 lastError 清空')
    const ping = (await app.kernel.plugins.invokeAction('self-heal', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('持久化 pluginEnabled=true 的外部插件服务启动失败：降级 failed（stage enable）且不覆写磁盘开关', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-enfail-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'svc-fail')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `import { existsSync } from 'node:fs'\nexport default {\n  id: 'svc-fail',\n  name: '服务启动失败',\n  async definePlugin(ctx) {\n    ctx.service({\n      id: 'daemon',\n      start() {\n        if (existsSync(new URL('./fail.flag', import.meta.url))) throw new Error('外部服务未就绪')\n      },\n      stop() {},\n    })\n  },\n}\n`,
    )
    writeFileSync(join(dirPath, 'fail.flag'), '1')

    // 预持久化 pluginEnabled['svc-fail'] = true（模拟用户曾启用）
    const configPath = join(dataDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ pluginEnabled: { 'svc-fail': true } }))

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')
    assert.ok(failed, '恢复启用失败的插件应保留为 failed 条目')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')
    assert.match(failed.error!.message, /外部服务未就绪/)

    // 磁盘 pluginEnabled 原值不动（不覆写用户意图）
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { pluginEnabled: Record<string, boolean> }
    assert.equal(raw.pluginEnabled['svc-fail'], true, '恢复失败不得覆写磁盘开关')

    // 修复后 enable 自愈
    rmSync(join(dirPath, 'fail.flag'))
    await app.kernel.plugins.enable('svc-fail')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')!
    assert.equal(healed.status, 'active')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('内置插件注册失败保持严格阻断（不降级 failed）', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    await rejectsCode(
      fixture.host.register({
        id: 'builtin:broken',
        definePlugin() {
          throw new Error('内置插件代码缺陷')
        },
      }),
      'plugin_registration_failed',
    )
    // 不出现在清单（无 failed 条目）
    assert.equal(fixture.host.list().some((p) => p.id === 'builtin:broken'), false)
  } finally {
    await fixture.close()
  }
})

test('手动 enable 外部插件失败：409/500 错误如实上抛，同时列表反映 failed', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let shouldFail = true
    await fixture.host.register(
      {
        id: 'ext:manual',
        name: '手动启用失败',
        definePlugin: (ctx) => {
          ctx.service({
            id: 'svc',
            start() {
              if (shouldFail) throw new Error('启动失败')
            },
            stop() {},
          })
        },
      },
      { enabled: false, isolateFailure: true },
    )
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:manual')!.status, 'disabled')

    // 手动 enable 失败：错误上抛（HTTP/CLI 收到明确错误响应）
    const err = await rejectsCode(fixture.host.enable('ext:manual'), 'plugin_service_start_failed', 500)
    assert.match(err.message, /启动失败/)
    // 列表状态反映 failed
    const failed = fixture.host.list().find((p) => p.id === 'ext:manual')!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')

    // 修复后 enable 成功
    shouldFail = false
    await fixture.host.enable('ext:manual')
    const healed = fixture.host.list().find((p) => p.id === 'ext:manual')!
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined)
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// 2. 持久资源占用（inUse）与停用预检
// ---------------------------------------------------------------------------

test('服务声明 inUse：默认 409 plugin_in_use 携带 usages；force 后停用成功', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let jobs: Array<{ id: string; schedule: string }> = [{ id: 'j1', schedule: '0 * * * *' }]
    await fixture.host.register({
      id: 'ext:scheduler',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'sched',
          start() {},
          stop() {},
          inUse() {
            return jobs.map((j) => ({ kind: 'cron_job', id: j.id, label: `定时任务 "${j.id}" (${j.schedule})` }))
          },
        })
      },
    })

    // 有占用：默认 409 拦截
    const err = await rejectsCode(fixture.host.disable('ext:scheduler'), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
    assert.deepEqual(usages, [{ kind: 'cron_job', id: 'j1', label: '定时任务 "j1" (0 * * * *)' }])
    // 拒绝路径无副作用：保持启用
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, true)

    // force：知情停用
    await fixture.host.disable('ext:scheduler', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)

    // 占用清空后默认停用也直接成功
    await fixture.host.enable('ext:scheduler')
    jobs = []
    await fixture.host.disable('ext:scheduler')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('inUse 检查抛异常或返回非法形状：显式 plugin_in_use_check_failed，绝不静默当空', { timeout: 60_000 }, async () => {
  for (const bad of ['throw', 'not-array', 'missing-label'] as const) {
    const fixture = await makeHostFixture()
    try {
      await fixture.host.register({
        id: 'ext:bad-inuse',
        definePlugin: (ctx) => {
          ctx.service({
            id: 'svc',
            start() {},
            stop() {},
            inUse: () => {
              if (bad === 'throw') throw new Error('对账崩了')
              if (bad === 'not-array') return 'nope' as unknown as never
              return [{ kind: 'x', id: 'y' }] as never
            },
          })
        },
      })
      const err = await rejectsCode(fixture.host.disable('ext:bad-inuse'), 'plugin_in_use_check_failed', 500)
      assert.equal((err.details as { serviceId: string }).serviceId, 'svc')
      assert.equal(fixture.host.list().find((p) => p.id === 'ext:bad-inuse')!.enabled, true, '检查失败不改变状态')
    } finally {
      await fixture.close()
    }
  }
})

test('宿主引用探测：profile_runtime / profile_model / conversation_model 三类占用', { timeout: 60_000 }, async () => {
  const base = await makeHostFixture()
  // 带 provider 挂载端口的 fixture（引用探测需要 provider 声明真实注册）。
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-rt-'))
  const backend = makeBackend()
  const events = (backend as unknown as { __events: string[] }).__events
  const payloads = (backend as unknown as { __payloads: Array<{ type: string; payload: unknown }> }).__payloads
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    providers: {
      register: async (provider) => async () => {},
      assertIdle: () => {},
    },
  })
  const fixture: HostFixture = {
    host,
    events,
    payloads,
    backend,
    dataDir,
    async close() {
      await host.dispose()
      await base.host.dispose().catch(() => {})
      rmSync(base.dataDir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  try {
    // 占用型插件：声明 profileRuntime kind + 两个 provider
    await fixture.host.register({
      id: 'ext:runtime',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'rt', kind: 'myrt', label: '外部运行时' })
        ctx.provider({
          id: 'prov-a',
          name: 'Prov A',
          auth: { apiKey: { name: 'k', resolve: async () => undefined } },
          getModels: () => [],
          stream: () => {
            throw new Error('no')
          },
          streamSimple: () => {
            throw new Error('no')
          },
        } as never)
        ctx.service({ id: 'svc', start() {}, stop() {} })
      },
    })

    // 无引用时（fixture profiles.list / listConversations 可用但无命中）：直接停用成功
    await fixture.host.disable('ext:runtime')
    await fixture.host.enable('ext:runtime')

    // Profile 绑定 runtime.kind
    fixture.backend.profileStore.set('coder', {
      id: 'coder',
      name: '编码角色',
      runtime: { kind: 'myrt', agent: 'pi' },
    })
    // Profile 默认模型指向 prov-a
    fixture.backend.profileStore.set('writer', { id: 'writer', name: '写作角色', model: 'prov-a/some-model' })
    // 会话模型指向 prov-a
    fixture.backend.conversationStore.push(makeConversation(9, 'prov-a/another'))

    const err = await rejectsCode(fixture.host.disable('ext:runtime'), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
    const kinds = usages.map((u) => `${u.kind}:${u.id}`).sort()
    assert.deepEqual(kinds, ['conversation_model:9', 'profile_model:writer', 'profile_runtime:coder'])
    const rt = usages.find((u) => u.kind === 'profile_runtime')!
    assert.match(rt.label, /编码角色.*myrt/)
    const pm = usages.find((u) => u.kind === 'profile_model')!
    assert.match(pm.label, /写作角色.*prov-a\/some-model/)
    const cm = usages.find((u) => u.kind === 'conversation_model')!
    assert.match(cm.label, /会话 #9.*prov-a\/another/)

    // force 后停用成功
    await fixture.host.disable('ext:runtime', { force: true })
  } finally {
    await fixture.close()
  }
})

test('liveTasks 硬阻断：force 也绝不跳过（状态一致性优先）', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    const panes = new Set<string>()
    await fixture.host.register({
      id: 'ext:busy',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          liveTasks: () => [...panes].map((p) => `pane:${p}`),
          inUse: () => [{ kind: 'pane', id: 'p1', label: '终端面板' }],
        })
      },
    })
    panes.add('win-1')
    // liveTasks 硬阻断：force 也拒绝
    await rejectsCode(fixture.host.disable('ext:busy', { force: true }), 'plugin_has_live_tasks', 409)
    // 收敛后 force 停用成功（inUse 知情放行）
    panes.clear()
    await fixture.host.disable('ext:busy', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:busy')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('builtin:triggers inUse：启用的 cron 任务与 webhook 端点阻塞停用，force 放行', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-triggers-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    const TRIGGERS = 'builtin:triggers'
    await app.kernel.plugins.enable(TRIGGERS)

    // 初始无任务：停用成功（随后重新启用）
    await app.kernel.plugins.disable(TRIGGERS)
    await app.kernel.plugins.enable(TRIGGERS)

    // 创建启用的 cron 任务 + webhook 端点
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'daily', schedule: '0 9 * * *', text: '晨报' })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'off', schedule: '0 9 * * *', text: 'x', enabled: false })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'webhook_create', { id: 'hook1', secret: 'whsec_gov' })

    const err = await rejectsCode(app.kernel.plugins.disable(TRIGGERS), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
    // 只含启用的 cron（off 不算）+ webhook 端点
    const ids = usages.map((u) => `${u.kind}:${u.id}`).sort()
    assert.deepEqual(ids, ['cron_job:daily', 'webhook_endpoint:hook1'])

    await app.kernel.plugins.disable(TRIGGERS, { force: true })
    assert.equal(app.kernel.plugins.list().find((p) => p.id === TRIGGERS)!.enabled, false)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. turn_settled 单插件异常隔离
// ---------------------------------------------------------------------------

test('turn_settled：高优先级插件抛错被隔离告警，下游 superagent 风格处理器照常执行且收到上一合法载荷', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    const seen: Array<{ by: string; outcome: string; error?: string }> = []
    // 高优先级坏插件：抛异常
    await fixture.host.register({
      id: 'broken-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => {
          throw new Error('boom in settler')
        }, { priority: 10 })
      },
    })
    // 中优先级坏插件：非法动作
    await fixture.host.register({
      id: 'bad-action-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'nope' }) as never, { priority: 5 })
      },
    })
    // 低优先级好插件：读 transform 后的载荷继续结算（superagent 风格）
    await fixture.host.register({
      id: 'good-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled((payload) => {
          seen.push({ by: 'good', outcome: payload.outcome, error: payload.error })
          return { action: 'continue' }
        })
      },
    })
    // 合法 transform 插件（介于好坏之间）：确认隔离后载荷不回退
    await fixture.host.register({
      id: 'transform-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(
          (payload) => ({ action: 'transform', value: { ...payload, error: 'transformed-note' } }),
          { priority: 2 },
        )
      },
    })

    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'failed',
      settledAt: 100,
    })
    // 管道整体不抛错：正常返回 transform（最终载荷）
    assert.equal(result.action, 'transform')
    if (result.action === 'transform') {
      assert.equal(result.value.error, 'transformed-note')
    }
    // 下游好插件照常执行，收到 transform 后的载荷
    assert.deepEqual(seen, [{ by: 'good', outcome: 'failed', error: 'transformed-note' }])

    // 两个坏插件各收到一条 warning notification
    const notes = fixture.payloads
      .filter((e) => e.type === 'notification')
      .map((e) => e.payload as { level: string; title: string; body: string })
    assert.equal(notes.length, 2, `应有两条告警，实际 ${notes.length}`)
    for (const note of notes) {
      assert.equal(note.level, 'warning')
      assert.match(note.title, /回合结算钩子异常/)
    }
    const titles = notes.map((n) => n.title).sort()
    assert.match(titles[0]!, /bad-action-settler/)
    assert.match(titles[1]!, /broken-settler/)
    assert.match(notes.find((n) => n.title.includes('broken-settler'))!.body, /boom in settler/)
  } finally {
    await fixture.close()
  }
})

test('turn_settled：拦截型钩子（before_turn）仍 fail-closed；turn_settled 隔离 transform 破坏载荷不阻断', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    await fixture.host.register({
      id: 'strict:before',
      definePlugin: (ctx) => {
        ctx.hook.onBeforeTurn(() => {
          throw new Error('before_turn 崩溃')
        })
      },
    })
    await rejectsCode(
      fixture.host.runHook('before_turn', {
        conversation: makeConversation(1),
        inputs: [],
        tools: [],
        sections: [],
        messages: [],
      }),
      'hook_execution_failed',
      500,
    )

    // turn_settled transform 破坏必要字段：隔离该插件，载荷保持上一合法值
    let downstreamSeen: string | undefined
    await fixture.host.register({
      id: 'break:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(
          () => ({ action: 'transform', value: { broken: true } as never }),
          { priority: 5 },
        )
      },
    })
    await fixture.host.register({
      id: 'read:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled((payload) => {
          downstreamSeen = payload.outcome
          return { action: 'continue' }
        })
      },
    })
    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: 1,
    })
    assert.equal(result.action, 'transform')
    assert.equal(downstreamSeen, 'completed', '下游收到上一合法载荷（未被破坏值污染）')
  } finally {
    await fixture.close()
  }
})

test('turn_settled handled 正常短路；入口载荷非法仍显式抛错（内核 bug 不静默）', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let downstreamRan = false
    await fixture.host.register({
      id: 'handled:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => ({ action: 'handled', result: { settled: true } }), { priority: 10 })
      },
    })
    await fixture.host.register({
      id: 'after:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => {
          downstreamRan = true
          return { action: 'continue' }
        })
      },
    })
    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: 1,
    })
    assert.deepEqual(result, { action: 'handled', result: { settled: true } })
    assert.equal(downstreamRan, false)

    // 入口初始载荷非法：直接抛错（不进入隔离模式）
    await rejectsCode(
      fixture.host.runHook('turn_settled', {
        conversation: makeConversation(1),
        inputs: [],
        outcome: 'weird' as never,
        settledAt: 1,
      }),
      'invalid_hook_result',
    )
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// 4. 插件配置分层溯源（sources）、不固化 default 与 null 重置
// ---------------------------------------------------------------------------

/** 建立带 configSchema 的插件 host fixture（真实 HelmPluginConfigStore）。 */
async function makeConfigFixture(): Promise<{
  host: PluginHost
  store: HelmPluginConfigStore
  dataDir: string
  credentialsDir: string
  close(): Promise<void>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-cfg-'))
  const credentialsDir = join(dataDir, 'cred')
  mkdirSync(credentialsDir, { recursive: true })
  const config = new ConfigService(dataDir)
  const credentials = new CredentialService(credentialsDir)
  const store = new HelmPluginConfigStore({ config, credentials })
  await store.load()
  const backend = makeBackend()
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore(), config: store })
  await host.register({
    id: 'ext:cfg',
    definePlugin: (ctx) => {
      ctx.configSchema({
        endpoint: { type: 'string', label: '端点', default: 'http://127.0.0.1:3425' },
        timeout: { type: 'number', label: '超时', default: 5000 },
        apiKey: { type: 'string', label: '密钥', secret: true },
      })
    },
  })
  return {
    host,
    store,
    dataDir,
    credentialsDir,
    async close() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('配置不固化 default：磁盘只存显式覆写值；getConfig 合成 default；sources 三态溯源', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // 未配置：全部回退（endpoint/timeout 有 default，apiKey unset）
    let values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425')
    assert.equal(values.timeout, 5000)
    assert.equal('apiKey' in values, false)
    let sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })

    // 显式配置 timeout + apiKey
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    // 磁盘只含 timeout: 8000（不含 endpoint 固化默认值）
    assert.deepEqual(rawConfig.plugins?.['ext:cfg'], { timeout: 8000 })

    values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425', '未配置字段动态合成 default')
    assert.equal(values.timeout, 8000)
    assert.equal(values.apiKey, 'sk-123')
    sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'configured', apiKey: 'configured' })
  } finally {
    await f.close()
  }
})

test('null 重置：timeout 回退 default、apiKey 清除 secret；磁盘键删除', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    // null 重置两个字段
    await f.host.setConfig('ext:cfg', { timeout: null, apiKey: null })

    // 磁盘显式键被删除（桶为空时整体移除 plugins['ext:cfg'] 条目）
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    assert.equal(
      rawConfig.plugins?.['ext:cfg'],
      undefined,
      'null 重置后磁盘插件桶被清理',
    )
    // credentials.json 对应 secret 键被删除
    const credRaw = JSON.parse(readFileSync(join(f.credentialsDir, 'credentials.json'), 'utf8')) as {
      pluginSecrets?: Record<string, Record<string, string>>
    }
    assert.equal(credRaw.pluginSecrets?.['ext:cfg'], undefined, 'secret 键被删除')

    // 有效值与来源恢复回退态
    const values = f.host.getConfig('ext:cfg')
    assert.equal(values.timeout, 5000, '重置后回退 schema.default')
    assert.equal('apiKey' in values, false)
    const sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })
  } finally {
    await f.close()
  }
})

test('required 校验：必填且无 default 的字段缺失或被 null 清除时 400 validation_error', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-req-'))
  const credentialsDir = join(dataDir, 'cred')
  mkdirSync(credentialsDir, { recursive: true })
  const store = new HelmPluginConfigStore({
    config: new ConfigService(dataDir),
    credentials: new CredentialService(credentialsDir),
  })
  await store.load()
  const schema: Record<string, import('@helm/protocol').PluginConfigFieldSchema> = {
    token: { type: 'string', required: true },
    optional: { type: 'string' },
  }
  try {
    // 完全未配置：required 缺失报错
    await rejectsCode(store.set('ext:req', {}, schema), 'validation_error', 400)
    // 配置后成功
    await store.set('ext:req', { token: 't1' }, schema)
    assert.equal(store.get('ext:req').token, 't1')
    // null 清除必填字段：报错（必填且无 default 不可清除）
    await rejectsCode(store.set('ext:req', { token: null }, schema), 'validation_error', 400)
    // 未知字段拒绝
    await rejectsCode(store.set('ext:req', { nope: 'x' }, schema), 'validation_error', 400)
    // 非 secret 类型校验
    await rejectsCode(store.set('ext:req', { token: 42 }, schema), 'validation_error', 400)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('null 重置未知字段：validation_error；插件 schema 调整 default 后回退值动态跟随', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // 未知字段（即使 null）也拒绝
    await rejectsCode(f.host.setConfig('ext:cfg', { unknown: null }), 'validation_error', 400)

    // schema.default 升级后：磁盘无固化值，get 动态反映新默认（通过第二个 host 模拟升级）
    await f.host.setConfig('ext:cfg', { timeout: 9000 })
    await f.host.setConfig('ext:cfg', { timeout: null })
    // 未配置时 get 合成的是当前 schema 的 default（5000）
    assert.equal(f.host.getConfig('ext:cfg').timeout, 5000)

    // 未注册插件的 getConfig：无 schema 时只返回存储值（不合成）
    assert.deepEqual(f.host.getConfig('ext:unknown'), {})
  } finally {
    await f.close()
  }
})

test('PluginSummary status 语义：active/disabled/failed 三态与 error 附带', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    // active：正常启用
    await fixture.host.register({
      id: 'ext:alive',
      definePlugin: () => {},
    })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:alive')!.status, 'active')

    // disabled：停用（无故障）
    await fixture.host.disable('ext:alive')
    const disabled = fixture.host.list().find((p) => p.id === 'ext:alive')!
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.error, undefined)

    // failed：外部插件 define 失败降级
    await fixture.host.register(
      {
        id: 'ext:dead',
        definePlugin() {
          throw new Error('挂了')
        },
      },
      { isolateFailure: true },
    )
    const failed = fixture.host.list().find((p) => p.id === 'ext:dead')!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.code, 'plugin_execution_failed')
    assert.equal(failed.error!.stage, 'define')

    // failed 后 unregister + 重新注册（修复后的同名插件）：落位为正常状态
    await fixture.host.unregister('ext:dead')
    await fixture.host.register(
      {
        id: 'ext:dead',
        definePlugin: () => {},
      },
      { enabled: false, isolateFailure: true },
    )
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.status, 'disabled')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.error, undefined, '重新注册后 error 清空')
  } finally {
    await fixture.close()
  }
})
