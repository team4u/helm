/**
 * ctx.host.plugins 宿主插件治理端口专项测试：
 * - 端口转发：真实 PluginHost + 真实 PluginPackageManager（local 源真实拷贝、
 *   doctor 全链真实执行）经插件内部调用 doctor/install/update/enable/disable/remove；
 * - 自指生命周期拒绝：插件 A 在自身运行任务中调用 update/remove/disable(A)
 *   立即 409 plugin_self_lifecycle_forbidden（同步抛出，不进入后端队列自等待）；
 * - 错误边界：未知插件 404 / 非法 doctor 路径 400 / 后端未接线端口 501；
 * - 周期守卫：停用后旧 ctx.host.plugins 句柄一律失效（409）；
 * - 脱敏边界：doctor/install 结果携带的构建诊断经宿主 redactText 出站。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type HelmHostApi, type PluginDefinition, type PluginSummary } from '@helm/protocol'
import {
  PluginHost,
  PluginPackageManager,
  PluginPackageManagerStore,
  type PluginDocStore,
} from '../src/plugins/index.js'
import { ConfigService } from '../src/services/config.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

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

/** 最小合法外部插件源（约定入口形态；与 plugin-package-manager.test 同构）。 */
const PLUGIN_SRC = (id: string, version = '1.0.0') => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

function writeLocalPlugin(parent: string, id: string, version = '1.0.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

interface Env {
  host: PluginHost
  dataDir: string
  srcParent: string
  close(): void
}

/** 真实 PluginHost + 真实 PluginPackageManager（local 源；无网络依赖）。 */
async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-host-plugins-'))
  const srcParent = mkdtempSync(join(tmpdir(), 'helm-host-plugins-src-'))
  // 后端 plugins 端口接线：与 runtime createPluginHostBackend 同一委托面
  //（直接转发 PluginHost 既有公共方法，复用同一生命周期队列与任务跟踪）。
  const backend = hostBackendStub()
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
  backend.plugins = {
    doctorPlugin: (target) => host.doctorExternalPlugin(target),
    installPlugin: (source, options) => host.installPluginPackage(source, options),
    updatePlugin: (pluginId) => host.updatePluginPackage(pluginId),
    removePlugin: (pluginId) => host.removePluginPackage(pluginId),
    enablePlugin: async (pluginId) => {
      await host.enable(pluginId)
      return requireSummary(host, pluginId)
    },
    disablePlugin: async (pluginId, options) => {
      await host.disable(pluginId, options)
      return requireSummary(host, pluginId)
    },
  }
  const store = new PluginPackageManagerStore(new ConfigService(dataDir))
  await store.load()
  host.attachPackageManager(
    new PluginPackageManager({ dataDir, cwd: dataDir, store, host: host.asPackageManagerHost() }),
    store,
  )
  return {
    host,
    dataDir,
    srcParent,
    close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(srcParent, { recursive: true, force: true })
    },
  }
}

function requireSummary(host: PluginHost, pluginId: string): PluginSummary {
  const summary = host.list().find((s) => s.id === pluginId)
  if (!summary) throw new HelmError('plugin_enable_failed', `插件 ${pluginId} 操作后未在宿主清单中发现（内部状态不一致）`, 500, { pluginId })
  return summary
}

/** 注册一个捕获 ctx.host 的内建探针插件（enabled，真实生命周期）。 */
async function registerProbe(
  host: PluginHost,
  id = 'p:probe',
): Promise<HelmHostApi> {
  let captured: HelmHostApi | undefined
  const def: PluginDefinition = {
    id,
    definePlugin(ctx) {
      captured = ctx.host
    },
  }
  await host.register(def, { enabled: true })
  assert.ok(captured, 'ctx.host 应在 definePlugin 期间捕获')
  return captured!
}

/** 期望指定 code/status 的 HelmError（同步抛出也兼容）。 */
async function expectHelmError(p: () => unknown, code: string, status: number): Promise<HelmError> {
  try {
    await p()
  } catch (err) {
    assert.ok(err instanceof HelmError, `期望 HelmError(${code})，实际：${String(err)}`)
    assert.equal(err.code, code, `期望 code=${code}，实际=${err.code}`)
    assert.equal(err.status, status, `期望 status=${status}，实际=${err.status}`)
    return err
  }
  throw new Error(`期望抛出 HelmError(${code})，实际正常返回`)
}

// ---------------------------------------------------------------------------
// 端口转发全链（真实 doctor / install / update / enable / disable / remove）
// ---------------------------------------------------------------------------

test('host.plugins 端口转发：doctor/install/update/enable/disable/remove 全链（真实宿主）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    const src = writeLocalPlugin(env.srcParent, 'port-demo', '1.0.0')

    // doctor（dir 模式，真实四阶段自检）
    const report = await api.plugins.doctor({ dir: src })
    assert.equal(report.ok, true)
    assert.equal(report.pluginId, 'port-demo')

    // install（默认 disabled）
    const installed = await api.plugins.install(src)
    assert.equal(installed.record.pluginId, 'port-demo')
    assert.equal(installed.summary.enabled, false)

    // enable -> list / listUi 同源快照
    const enabledSummary = await api.plugins.enable('port-demo')
    assert.equal(enabledSummary.enabled, true)
    assert.equal(enabledSummary.id, 'port-demo')
    const listed = api.plugins.list()
    assert.ok(listed.some((s) => s.id === 'port-demo' && s.enabled))
    assert.deepEqual(api.listPlugins().map((s) => s.id), listed.map((s) => s.id), 'list 与 listPlugins 同源')

    // update（local 源编辑后重同步：版本推进、保持启用）
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'port-demo', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('port-demo', '2.0.0'))
    const updated = await api.plugins.update('port-demo')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.summary.version, '2.0.0')
    assert.equal(updated.summary.enabled, true, '更新保持启用状态')
    assert.equal(updated.previousVersion, '1.0.0')

    // remove（受管目录与记录清理；用户源完好）
    const removed = await api.plugins.remove('port-demo')
    assert.equal(removed.pluginId, 'port-demo')
    assert.equal(removed.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'port-demo')), '受管目录应删除')
    assert.ok(existsSync(join(src, 'index.mjs')), '用户源目录完好')
    assert.ok(!api.plugins.list().some((s) => s.id === 'port-demo'), '清单中应已移除')
  } finally {
    await env.host.dispose()
    env.close()
  }
})

test('host.plugins.disable 停用其他插件（经端口）与 disable(force) 语义', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:operator')
    const src = writeLocalPlugin(env.srcParent, 'port-target')
    await api.plugins.install(src)
    await api.plugins.enable('port-target')

    const disabled = await api.plugins.disable('port-target')
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.id, 'port-target')

    // 再启用一次并直接经端口停用（无 inUse 占用，无需 force）
    await api.plugins.enable('port-target')
    const again = await api.plugins.disable('port-target', { force: true })
    assert.equal(again.enabled, false)
  } finally {
    await env.host.dispose()
    env.close()
  }
})

// ---------------------------------------------------------------------------
// 自指生命周期拒绝
// ---------------------------------------------------------------------------

test('自指生命周期拒绝：插件对自身 update/remove/disable 立即 409，enable/doctor 不受限', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:self')
    // 对自身 enable 是幂等无害操作（已启用时直接返回清单），不在自指禁止面。
    const selfEnabled = await api.plugins.enable('p:self')
    assert.equal(selfEnabled.id, 'p:self')

    await expectHelmError(() => api.plugins.update('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.remove('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.disable('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.disable('p:self', { force: true }), 'plugin_self_lifecycle_forbidden', 409)

    // 拒绝后插件仍在册且可用（未进入后端队列、无副作用）
    const summary = env.host.get('p:self')
    assert.ok(summary)
    assert.equal(summary.enabled, true)
    await api.plugins.list()
  } finally {
    await env.host.dispose()
    env.close()
  }
})

test('自指拒绝在动作执行中也成立：handler 内调用 self disable 不会死锁', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    let api: HelmHostApi | undefined
    const def: PluginDefinition = {
      id: 'p:selfaction',
      definePlugin(ctx) {
        api = ctx.host
        ctx.action({
          id: 'self_disable',
          description: '自指停用探针',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: async () => {
            await expectHelmError(() => ctx.host.plugins.disable('p:selfaction'), 'plugin_self_lifecycle_forbidden', 409)
            return { ok: true }
          },
        })
      },
    }
    await env.host.register(def, { enabled: true })
    const result = await env.host.invokeAction('p:selfaction', 'self_disable', {})
    assert.deepEqual(result, { ok: true })
    // 动作收敛后插件仍启用（在途任务计数归零）
    const labels = (env.host as unknown as { tracker: { activeLabels(id: string): string[] } }).tracker.activeLabels('p:selfaction')
    assert.equal(labels.length, 0)
    assert.ok(api)
  } finally {
    await env.host.dispose()
    env.close()
  }
})

// ---------------------------------------------------------------------------
// 错误边界
// ---------------------------------------------------------------------------

test('错误边界：未知插件/非法路径/互斥目标', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)

    // 未知插件：enable/update/remove 均 404（后端 PluginHost 真实语义）
    await expectHelmError(() => api.plugins.enable('never-registered'), 'unknown_plugin', 404)
    await expectHelmError(() => api.plugins.update('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmError(() => api.plugins.remove('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmError(() => api.plugins.doctor({ id: 'never-registered' }), 'plugin_source_missing', 404)

    // doctor 非法路径：相对路径与 .. 穿越段拒绝（与 HTTP parseDoctorTarget 同约束）
    await expectHelmError(() => api.plugins.doctor({ dir: 'relative/path' }), 'validation_error', 400)
    await expectHelmError(() => api.plugins.doctor({ dir: '/abs/../escape' }), 'validation_error', 400)
    // id 与 dir 互斥 / 空目标
    await expectHelmError(() => api.plugins.doctor({ id: 'x', dir: '/abs' }), 'validation_error', 400)
    await expectHelmError(() => api.plugins.doctor({}), 'validation_error', 400)

    // 非法 source grammar（本地不存在路径 -> 404 事实错误）
    await expectHelmError(() => api.plugins.install('/nonexistent/plugin/dir'), 'plugin_package_install_failed', 404)
  } finally {
    await env.host.dispose()
    env.close()
  }
})

test('后端未接线 plugins 端口：修改操作显式 501，读面照常可用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-host-plugins-noport-'))
  // 显式不接线 plugins 端口（undefined）：与轻量测试宿主同形态。
  const backend = hostBackendStub()
  backend.plugins = undefined
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
  try {
    const api = await registerProbe(host)
    // 读面（同源宿主清单）可用
    assert.ok(Array.isArray(api.plugins.list()))
    assert.ok(Array.isArray(api.plugins.listUi()))
    // 写面显式 501（不静默降级）
    await expectHelmError(() => api.plugins.doctor({ dir: '/tmp' }), 'not_supported', 501)
    await expectHelmError(() => api.plugins.install('/tmp'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.update('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.remove('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.enable('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.disable('x'), 'not_supported', 501)
    // 自指守卫先于 501：即便未接线，自指目标仍被 409 拒绝（同步防御不变）
    await expectHelmError(() => api.plugins.disable('p:probe'), 'plugin_self_lifecycle_forbidden', 409)
  } finally {
    await host.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 周期守卫与脱敏
// ---------------------------------------------------------------------------

test('周期守卫：停用后旧句柄 plugins 全方法一律 409 plugin_context_expired', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:expired')
    await env.host.disable('p:expired')
    const expired: Array<() => unknown> = [
      () => api.plugins.list(),
      () => api.plugins.listUi(),
      () => api.plugins.doctor({ dir: '/tmp' }),
      () => api.plugins.install('/tmp'),
      () => api.plugins.update('x'),
      () => api.plugins.remove('x'),
      () => api.plugins.enable('x'),
      () => api.plugins.disable('x'),
    ]
    for (const call of expired) {
      await expectHelmError(call, 'plugin_context_expired', 409)
    }
  } finally {
    await env.host.dispose()
    env.close()
  }
})

test('脱敏边界：doctor 失败诊断中的机密经宿主 redactText 出站', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-host-plugins-redact-'))
  const srcParent = mkdtempSync(join(tmpdir(), 'helm-host-plugins-redact-src-'))
  // 构造带机密的宿主：redactText 把明文机密替换为标记（模拟 SecretStash）。
  const SECRET = 'sk-helm-super-secret-token'
  const stub = hostBackendStub()
  stub.redactText = (text: string) => text.split(SECRET).join('[REDACTED]')
  const host = new PluginHost({
    dataDir,
    host: stub,
    docs: new MemoryDocStore(),
    redactText: (text) => text.split(SECRET).join('[REDACTED]'),
  })
  // doctor 无需包管理器：直接接线 doctor 面（与 runtime 同一委托）。
  stub.plugins = {
    doctorPlugin: (target) => host.doctorExternalPlugin(target),
    installPlugin: () => Promise.reject(new HelmError('unsupported', '本测试仅接线 doctor', 501)),
    updatePlugin: () => Promise.reject(new HelmError('unsupported', '本测试仅接线 doctor', 501)),
    removePlugin: () => Promise.reject(new HelmError('unsupported', '本测试仅接线 doctor', 501)),
    enablePlugin: () => Promise.reject(new HelmError('unsupported', '本测试仅接线 doctor', 501)),
    disablePlugin: () => Promise.reject(new HelmError('unsupported', '本测试仅接线 doctor', 501)),
  }
  try {
    const api = await registerProbe(host)
    // 破损插件：入口 TS 内嵌机密（编译失败诊断携带源码行 -> 必须脱敏出站）。
    const broken = join(srcParent, 'redact-broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({ id: 'redact-broken', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(broken, 'index.mjs'), `const TOKEN = '${SECRET}';\nexport default { id: 'redact-broken', definePlugin() { void TOKEN; throw new Error('boom ' + TOKEN) } }\n`)

    const report = await api.plugins.doctor({ dir: broken })
    assert.equal(report.ok, false, '破损插件应 ok:false')
    const text = JSON.stringify(report)
    assert.ok(!text.includes(SECRET), '诊断输出不得包含机密明文')
    assert.ok(text.includes('[REDACTED]'), '机密应被替换为脱敏标记')
  } finally {
    await host.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcParent, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 端口在途任务跟踪（停用预检可见）
// ---------------------------------------------------------------------------

test('在途任务跟踪：port 调用计入调用方插件 tracker（disable 调用方被 409 保护）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // operator 安装 target 并在自身动作中停用 target：operator 的 tracker
    // 在动作期间持有 host.plugins.disable 任务；此处验证另一个插件试图停用
    // operator 时被在途任务 409 拒绝（任务标签 host.plugins.disable 可见）。
    const src = writeLocalPlugin(env.srcParent, 'track-target')
    let operatorApi: HelmHostApi | undefined
    let gate: (() => void) | undefined
    const gatePromise = new Promise<void>((resolve) => { gate = resolve })
    const operatorDef: PluginDefinition = {
      id: 'p:operator',
      definePlugin(ctx) {
        operatorApi = ctx.host
        ctx.action({
          id: 'hold_disable',
          description: '长停用探针',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: async () => {
            const pending = ctx.host.plugins.disable('track-target').catch(() => undefined)
            void pending
            await gatePromise
            return { ok: true }
          },
        })
      },
    }
    await env.host.register(operatorDef, { enabled: true })
    await operatorApi!.plugins.install(src)
    await operatorApi!.plugins.enable('track-target')

    const actionPromise = env.host.invokeAction('p:operator', 'hold_disable', {})
    await new Promise((r) => setTimeout(r, 30))
    // 在途期间：停用 operator 被 409 拒绝（host.plugins.disable 任务在途）
    await expectHelmError(() => env.host.disable('p:operator'), 'plugin_has_live_tasks', 409)
    gate!()
    await actionPromise
    // 动作收敛后可正常停用
    await env.host.disable('p:operator')
    assert.equal(env.host.get('p:operator')?.enabled, false)
  } finally {
    await env.host.dispose()
    env.close()
  }
})

/** 编译期辅助：PluginSummary 形状沿用既有模型（无重复定义）。 */
type _AssertSummaryShape = PluginSummary extends { id: string; enabled: boolean; locked: boolean } ? true : never
const _assertSummaryShape: _AssertSummaryShape = true
void _assertSummaryShape
