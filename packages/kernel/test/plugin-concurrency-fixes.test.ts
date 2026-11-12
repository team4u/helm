/**
 * 插件并发缺陷修复专项回归（fix/concurrency-plugins）。
 *
 * 覆盖（与修复一一对应）：
 * 1. disable 门禁 TOCTOU：collectPluginInUse 异步窗口内进入的在途任务必须被
 *    二次门禁 409 拦截（不与 teardown 并发拆注册表）；plugin_in_use 拒绝后
 *    状态保持 enabled+idle 可继续服务。
 * 2. 启动屏障读写门：屏障期并发 register(enable) 的服务不被漏启动；并发
 *    disable 不复活（stop 后于 start）；stop() 等屏障完成后再停止（不空跑）。
 * 3. HookPipeline 遍历隔离：run 遍历期间并发 add + 触发排序不重排正被遍历
 *    数组（不跳过、不重复执行）。
 * 4. nodeFetch 包装失败不泄漏计数（body 锁定异常路径）。
 * 5. setConfig 读-合-写串行：并发 patch 不丢更新。
 * 6. register 提交点后置：provider 挂载完成前列表不暴露能力（清单与
 *    可执行性不撕裂）。
 * 7. 包管理回滚诚实性：update 恢复性 reload 失败不再谎报 rolledBack；
 *    install store.save 失败且回滚注销 409 时绝不 rm 活实例目录；
 *    install 注册失败遇并发同名已注册实例时保留目录。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type HelmHostApi, type PluginDefinition, type PluginPackageRecord } from '@helm/protocol'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { HookPipeline } from '../src/plugins/hooks.js'
import { PluginPackageManager, type PackageManagerHost } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import type { PluginConfigStore, PluginDocStore, PluginHostBackend, PluginProviderPort } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import type { Provider } from '@earendil-works/pi-ai'

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
  deletePlugin(pluginId: string): void {
    this.store.delete(pluginId)
  }
  async flush(): Promise<void> {}
}

/** 受控延迟门（确定性时序，不 sleep 竞速）。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHost(overrides: { deferServices?: boolean; backend?: PluginHostBackend; providers?: PluginProviderPort } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-conc-fix-'))
  const host = new PluginHost({
    dataDir,
    host: {
      ...createPluginHostBackendFixture(),
      // 插件生命周期事件收集（fixture 底座对 emitEvent 显式 unsupported）
      emitEvent: () => {},
      ...(overrides.backend ? overrides.backend : {}),
    },
    docs: new MemoryDocStore(),
    ...(overrides.deferServices === true ? { deferServices: true } : {}),
    ...(overrides.providers !== undefined ? { providers: overrides.providers } : {}),
  })
  return {
    host,
    dataDir,
    async close() {
      try {
        await host.dispose()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
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
// 1. disable 门禁 TOCTOU
// ---------------------------------------------------------------------------

test('disable 门禁 TOCTOU：inUse 收集窗口内进入的在途任务被二次门禁 409 拦截', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    let releaseInUse!: () => void
    let inUsePending = true
    const actionGate = deferred<void>()
    await host.register({
      id: 'p:toctou',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          // inUse 异步挂起一次（制造 collectPluginInUse 的 await 窗口）；
          // 释放后后续调用立即返回空，避免测试尾部的再次停用被门挂死
          inUse: () => {
            if (!inUsePending) return []
            return new Promise<void>((resolve) => {
              releaseInUse = () => { inUsePending = false; resolve() }
            }).then(() => [])
          },
        })
        ctx.action({
          id: 'hang',
          description: '挂起动作',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: () => actionGate.promise.then(() => ({ ok: true })),
        })
      },
    }, { enabled: true })

    // 先启动 disable（挂起在 inUse 收集），再在窗口内放入一个在途 action
    const disabling = host.disable('p:toctou')
    // 让 disable 先推进到 inUse await：微任务排空
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 窗口内进入的 action：tracker 计数在案（handler 挂起不返回）
    const invoking = host.invokeAction('p:toctou', 'hang', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(host.activeTaskCount('p:toctou') >= 1, true, '窗口内 action 应计入在途任务')

    // 释放 inUse（返回空占用）：二次门禁必须抓住窗口内进入的 action → 409
    releaseInUse()
    await rejectsCode(disabling, 'plugin_has_live_tasks', 409)
    // 状态未被破坏：仍启用且 idle，action 正常收敛
    const summary = host.get('p:toctou')
    assert.equal(summary?.enabled, true)
    actionGate.resolve()
    await invoking
    // 收敛后停用成功
    await host.disable('p:toctou')
    assert.equal(host.get('p:toctou')?.enabled, false)
  } finally {
    await close()
  }
})

test('disable 门禁 plugin_in_use 拒绝后状态保持 enabled+idle，后续调用不受影响', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    await host.register({
      id: 'p:inuse',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          inUse: () => [{ kind: 'job', id: 'j1', label: '占用中' }],
        })
        ctx.action({
          id: 'ping',
          description: '探针',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    await rejectsCode(host.disable('p:inuse'), 'plugin_in_use', 409)
    assert.equal(host.get('p:inuse')?.enabled, true)
    // 门禁拒绝不是终态：插件继续可用
    const out = await host.invokeAction('p:inuse', 'ping', {})
    assert.deepEqual(out, { pong: true })
    await host.disable('p:inuse', { force: true })
    assert.equal(host.get('p:inuse')?.enabled, false)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 2. 启动屏障读写门
// ---------------------------------------------------------------------------

test('屏障期并发 register(enabled)：服务不被漏启动（读门等待屏障完成）', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:a',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-a',
          prepare: () => prepareGate.promise,
          start: () => { events.push('a-start') },
          stop: () => { events.push('a-stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 屏障进行中（A 的 prepare 挂起）：并发注册并启用 B
    const registeringB = host.register({
      id: 'p:b',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-b',
          start: () => { events.push('b-start') },
          stop: () => { events.push('b-stop') },
        })
      },
    }, { enabled: true })

    prepareGate.resolve()
    await starting
    await registeringB
    // B 的服务必须已启动（旧缺陷：activateServices 见 servicesStarted=false 跳过
    // 且 B 不在屏障快照 → 永不启动）
    assert.deepEqual(events, ['a-start', 'b-start'])
    assert.equal(host.get('p:b')?.enabled, true)
  } finally {
    await close()
  }
})

test('屏障期并发 disable：不复活（stop 后于屏障 start 执行）', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:revive',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { events.push('start') },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const disabling = host.disable('p:revive')
    prepareGate.resolve()
    await starting
    await disabling
    // 旧缺陷：disable 在屏障 prepare 期先完成（svc.started=false 跳过 stop），
    // 屏障随后 start 已停插件服务 → events 只有 ['start'] 且复活
    assert.deepEqual(events, ['start', 'stop'])
    assert.equal(host.get('p:revive')?.enabled, false)
  } finally {
    await close()
  }
})

test('屏障期 stop()：等待屏障完成后再停止（不空跑返回）', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:stopwait',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { events.push('start') },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const stopping = host.stop()
    // stop 尚未返回（等待屏障）；释放屏障后 stop 真正停止
    prepareGate.resolve()
    await starting
    await stopping
    // 旧缺陷：stop 见 servicesStarted=false 直接 return，屏障随后拉起服务
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 3. HookPipeline 遍历隔离（遍历中原地 sort）
// ---------------------------------------------------------------------------

test('HookPipeline：run 遍历期间并发 add+排序不重排正被遍历数组（不跳过不重复）', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline('input')
  const calls: string[] = []
  const payload = {
    conversationId: 1,
    input: { id: 'i1', text: 'x', origin: 'human' as const, createdAt: 1 },
  }

  pipeline.add('p:a', async () => {
    calls.push('a')
    // 遍历中并发注册高优先级钩子并触发排序路径（另一路 runHook 的 entries()）
    pipeline.add('p:c', () => { calls.push('c') }, 10)
    pipeline.entries()
    return { action: 'continue' as const }
  })
  pipeline.add('p:b', () => {
    calls.push('b')
    return { action: 'continue' as const }
  })

  await pipeline.run(payload)
  // 旧缺陷：entries() 返回活数组，原地 sort 使本轮 a 重复执行 / 顺序错乱
  assert.deepEqual(calls, ['a', 'b'])

  // 下一轮：高优先级 c 先执行
  await pipeline.run(payload)
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'b'])
})

// ---------------------------------------------------------------------------
// 4. nodeFetch 包装失败不泄漏计数
// ---------------------------------------------------------------------------

test('nodeFetch：响应 body 包装失败（已锁定流）结束计数不悬挂泄漏', { timeout: 60_000 }, async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)) },
  })
  const raw = (async () => {
    const response = new Response(source, { status: 200 })
    // 预锁 response.body：包装层 getReader() 必抛（确定性触发包装失败路径）
    void response.body!.getReader()
    return response
  }) as typeof fetch
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    nodeFetch: () => raw,
  }
  const { host, close } = makeHost({ backend })
  let api!: HelmHostApi
  await host.register({
    id: 'p:fetch-wrap-fail',
    definePlugin: (ctx) => { api = ctx.host },
  }, { enabled: true })
  try {
    await assert.rejects(api.nodeFetch('remote-1')('http://example.test'))
    // 旧缺陷：包装异常路径不 end 计数 → 停用永久 409 悬挂
    await host.disable('p:fetch-wrap-fail')
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 5. setConfig 读-合-写串行
// ---------------------------------------------------------------------------

test('setConfig：并发 patch 串行读合写，后写不覆盖前写', { timeout: 60_000 }, async () => {
  const captured: Record<string, unknown> = {}
  const firstWriteGate = deferred<void>()
  let backendCalls = 0
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    setPluginConfig: async (_id, value) => {
      backendCalls += 1
      // 首次写挂起：制造读-合-写交叠窗口（旧缺陷下两次并发读合写交叠）
      if (backendCalls === 1) await firstWriteGate.promise
      Object.assign(captured, value)
    },
  }
  const { host, close } = makeHost({ backend })
  let api!: HelmHostApi
  await host.register({
    id: 'p:cfg',
    definePlugin: (ctx) => { api = ctx.host },
  }, { enabled: true })
  try {
    const w1 = api.setConfig({ a: 1 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const w2 = api.setConfig({ b: 2 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    firstWriteGate.resolve()
    await Promise.all([w1, w2])
    // 旧缺陷：w2 读到 w1 落盘前的快照 {}，整值写覆盖丢 a
    assert.deepEqual(captured, { a: 1, b: 2 })
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 6. register 提交点后置（清单与可执行性不撕裂）
// ---------------------------------------------------------------------------

test('register：provider 挂载完成前列表不暴露能力（enabled 与 idle 同步提交）', { timeout: 60_000 }, async () => {
  const mountGate = deferred<void>()
  const port: PluginProviderPort = {
    register: async () => {
      await mountGate.promise
      return async () => {}
    },
  }
  const { host, close } = makeHost({ providers: port })
  try {
    const registering = host.register({
      id: 'p:late-mount',
      definePlugin: (ctx) => {
        ctx.provider({
          id: 'late-provider',
          name: 'Late Provider',
          auth: { apiKey: { name: 'k', resolve: async () => undefined } },
          getModels: () => [],
          stream: () => { throw new Error('不执行') },
          streamSimple: () => { throw new Error('不执行') },
        } as unknown as Provider)
        ctx.action({
          id: 'ping',
          description: '探针',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 挂载未完成：清单不得暴露（旧缺陷：enabled 先置 → 清单有而执行 409）
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:late-mount'), [])
    assert.equal(host.get('p:late-mount')?.enabled, false)
    mountGate.resolve()
    await registering
    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:late-mount').length, 1)
    const out = await host.invokeAction('p:late-mount', 'ping', {})
    assert.deepEqual(out, { pong: true })
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 7. 包管理回滚诚实性
// ---------------------------------------------------------------------------

const PLUGIN_SRC = (id: string, version: string) => `export default {
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

function writeLocalPlugin(parent: string, id: string, version: string): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

interface MiniPkgEnv {
  dataDir: string
  cwd: string
  manager: PluginPackageManager
  close(): void
}

/**
 * 最小包管理环境：真实 local 拷贝 + doctor + 目录事务；host 端口与 store
 * 注入故障（按需覆写）。失败注入由调用方在创建后直接改写 hostStub 方法。
 */
/** 真实 store（config.json 持久化）+ 可注入的 save 失败开关。 */
class FaultInjectingStore extends PluginPackageManagerStore {
  failNextSave = false
  override async save(
    record: Omit<PluginPackageRecord, 'id'> & { id?: string },
  ): Promise<PluginPackageRecord> {
    if (this.failNextSave) throw new Error('模拟磁盘写失败')
    return super.save(record)
  }
}

function makePkgEnv(
  setup: (host: PackageManagerHost & { registered: Map<string, boolean> }) => void,
): MiniPkgEnv & { store: FaultInjectingStore } {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-conc-'))
  const cwd = mkdtempSync(join(tmpdir(), 'helm-pkg-cwd-'))
  const store = new FaultInjectingStore(new ConfigService(dataDir))
  const registered = new Map<string, boolean>()
  const summaries = new Map<string, { id: string; enabled: boolean }>()
  const hostStub = {
    registered,
    async registerManagedPlugin(dir: string) {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      registered.set(manifest.id, false)
      summaries.set(manifest.id, { id: manifest.id, enabled: false })
      return { summary: summaryOf(summaries, manifest.id), pluginId: manifest.id }
    },
    async enableManagedPlugin(pluginId: string) {
      registered.set(pluginId, true)
      summaries.set(pluginId, { id: pluginId, enabled: true })
      return { summary: summaryOf(summaries, pluginId) }
    },
    assertManagedPluginUpdateSafe() {},
    async updateManagedPlugin(pluginId: string) {
      if (!registered.has(pluginId)) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId })
      return { summary: summaryOf(summaries, pluginId) }
    },
    async removeManagedPlugin(pluginId: string) {
      if (!registered.has(pluginId)) return { wasEnabled: false }
      const wasEnabled = registered.get(pluginId) === true
      registered.delete(pluginId)
      summaries.delete(pluginId)
      return { wasEnabled }
    },
    listSummaries: () => [...summaries.keys()].map((id) => summaryOf(summaries, id)),
  }
  const host = hostStub as unknown as PackageManagerHost & { registered: Map<string, boolean> }
  setup(host)
  const manager = new PluginPackageManager({ dataDir, cwd, store, host })
  return {
    dataDir,
    cwd,
    store,
    manager,
    close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function summaryOf(summaries: Map<string, { id: string; enabled: boolean }>, id: string) {
  const s = summaries.get(id) ?? { id, enabled: false }
  return {
    id: s.id,
    name: s.id,
    locked: false,
    enabled: s.enabled,
    hooks: [] as never[],
    actions: s.enabled ? ['ping'] : [],
    tools: [] as string[],
  }
}

test('update 回滚诚实性：恢复性 reload 失败不再谎报「已回滚旧版本继续可用」', { timeout: 60_000 }, async () => {
  let updateCalls = 0
  const env = makePkgEnv((hostStub) => {
    hostStub.updateManagedPlugin = async (pluginId: string) => {
      updateCalls += 1
      // 两次 reload 全失败：首次切换失败 + 恢复性 reload 也失败（实例已注销）
      throw new HelmError('plugin_reload_failed_simulated', `模拟 reload 失败 #${updateCalls}`, 500, { pluginId })
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'honest-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'honest-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('honest-rollback', '2.0.0'))

    const err = await rejectsCode(env.manager.update('honest-rollback'), 'plugin_package_update_failed', 500)
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, '恢复性 reload 失败必须如实 rolledBack:false')
    assert.match(err.message, /旧目录已恢复，但旧实例重载失败/, '错误信息必须说明目录已恢复但实例未恢复')
    assert.equal(updateCalls, 2, '回滚路径必须真实尝试恢复性 reload')
    // 目录确实已恢复到旧版本（rename 链完成）
    const manifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'honest-rollback', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '1.0.0')
  } finally {
    env.close()
  }
})

test('update 回滚成功路径：恢复性 reload 成功时仍如实 rolledBack:true', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    const original = hostStub.updateManagedPlugin
    let calls = 0
    hostStub.updateManagedPlugin = async (pluginId: string, dir: string, options: { keepEnabled: boolean }) => {
      calls += 1
      if (calls === 1) throw new HelmError('plugin_reload_failed_simulated', '首次 reload 失败', 500, { pluginId })
      return original(pluginId, dir, options)
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'ok-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'ok-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('ok-rollback', '2.0.0'))
    const err = await rejectsCode(env.manager.update('ok-rollback'), 'plugin_package_update_failed', 500)
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.match(err.message, /已回滚到更新前目录与实例/)
  } finally {
    env.close()
  }
})

test('install 记录持久化失败且回滚注销失败：目录与实例保留、rolledBack:false（全链）', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.removeManagedPlugin = async () => {
      // 模拟在途任务导致注销被 409 拒绝：实例仍注册运行
      throw new HelmError('plugin_has_live_tasks', '模拟在途任务拒绝卸载', 409, { pluginId: 'keep-dir' })
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'keep-dir', '1.0.0')
    env.store.failNextSave = true
    const err = await rejectsCode(env.manager.install(userSrc, { enable: true }), 'plugin_package_install_failed', 500)
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, '回滚注销失败必须如实 rolledBack:false')
    assert.match(err.message, /目录与实例已保留/, '错误信息必须说明保留现状待人工处理')
    const target = join(env.dataDir, 'plugins', 'keep-dir')
    assert.ok(existsSync(join(target, 'index.mjs')), '不得 rm 仍注册实例的源目录（旧缺陷：目录被掏空）')
    assert.ok(env.manager !== undefined)
    assert.ok(!env.store.getRecord('keep-dir'), '安装记录未持久化')
  } finally {
    env.close()
  }
})

test('install 注册失败遇并发同名已注册实例：目录保留给该实例，rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    let registerAttempted = false
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      // 模拟并发 rescan 已从同目录抢先注册：register 收 409。此后 listSummaries
      // 报告该实例（时序上与真实竞态一致：register 尝试前清单里没有它）
      registerAttempted = true
      throw new HelmError('plugin_already_registered', `插件已注册：${manifest.id}`, 409, { pluginId: manifest.id })
    }
    const original = hostStub.listSummaries.bind(hostStub)
    hostStub.listSummaries = () => {
      const base = original()
      return registerAttempted && !base.some((s) => s.id === 'raced-plugin')
        ? [...base, summaryOf(new Map([['raced-plugin', { id: 'raced-plugin', enabled: true }]]), 'raced-plugin')]
        : base
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'raced-plugin', '1.0.0')
    const err = await rejectsCode(env.manager.install(userSrc), 'plugin_package_install_failed', 500)
    const details = err.details as { rolledBack?: boolean }
    assert.equal(details.rolledBack, false)
    assert.match(err.message, /同名插件已注册/)
    const target = join(env.dataDir, 'plugins', 'raced-plugin')
    assert.ok(existsSync(join(target, 'index.mjs')), '目录必须保留给并发注册的活实例（旧缺陷：rm 掏空源目录）')
  } finally {
    env.close()
  }
})

test('install 注册失败且无同名实例：仍删目录回滚（既有语义不回退）', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      throw new HelmError('plugin_register_failed_simulated', `模拟注册失败：${manifest.id}`, 500)
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'plain-fail', '1.0.0')
    const err = await rejectsCode(env.manager.install(userSrc), 'plugin_package_install_failed', 500)
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'plain-fail')), '无并发实例时按原语义删目录回滚')
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// 10. start() 单飞失败不残留（identity-guarded 清缓存：失败后可重试）
// ---------------------------------------------------------------------------

test('start() 单飞失败不残留陈旧拒绝：失败清缓存后重试可成功', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    let failNextStart = true
    await host.register({
      id: 'p:barrier-retry',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start: () => {
            if (failNextStart) {
              failNextStart = false
              throw new Error('首次启动失败')
            }
            events.push('start')
          },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    await assert.rejects(host.start(), /首次启动失败/)
    // 失败后重试：不得收到缓存的陈旧拒绝（identity-guarded 清缓存允许重试）
    await host.start()
    assert.deepEqual(events, ['start'])
    await host.stop()
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 11. 拆毁期插件从清单即时消失（getActiveEnabledPluginIds 收紧为 enabled+idle）
// ---------------------------------------------------------------------------

test('拆毁期插件从动作清单即时消失：teardown 窗口内 enabled 仍 true 也不再暴露', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    const stopGate = deferred<void>()
    await host.register({
      id: 'p:tearing-down',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          // stop 挂起：制造 teardown 拆毁窗口（enabled 仍 true、phase=deactivating）
          stop: () => stopGate.promise,
        })
        ctx.action({
          id: 'ping',
          description: '探针',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:tearing-down').length, 1)
    const disabling = host.disable('p:tearing-down', { force: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 拆毁窗口：enabled 尚未落 false（禁用仍在 stop 中），但清单必须已消失，
    // 不再向已停服务派发新请求
    assert.equal(host.get('p:tearing-down')?.enabled, true, '窗口内 enabled 仍 true（拆毁期语义）')
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:tearing-down'), [], '拆毁期清单必须即时消失')
    stopGate.resolve()
    await disabling
    assert.equal(host.get('p:tearing-down')?.enabled, false)
  } finally {
    await close()
  }
})
