/**
 * 插件依赖契约与生命周期测试：
 * - 依赖声明边界（形状/去重/自依赖）与摘要透出（PluginSummary.dependencies）；
 * - enable / 注册即启用 的依赖满足性校验（缺失 plugin_dependency_missing、
 *   未启用 plugin_dependency_not_enabled；仅注册未启用的依赖不满足）；
 * - 依赖图环路显式拒绝（plugin_dependency_cycle），不静默不死锁；
 * - 全局服务启动屏障按依赖拓扑序 prepare/start，stop 按逆拓扑序；
 *   同层保持注册序；
 * - 依赖者保护：非 force 停用/注销被 plugin_in_use 拦截（占用项
 *   kind=plugin_dependency，含传递依赖者）；force 停用后依赖者显式标记
 *   （status=failed + plugin.changed），不留静默错误态；
 * - 注册/启用并发队列无死锁（全部 promise 收敛）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import {
  PluginHost,
  type PluginDocStore,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

// ---------------------------------------------------------------------------
// 测试基建
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

let dataDir: string
let docs: MemoryDocStore
let events: Array<{ type: string; payload: unknown }>

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    emitEvent: (type, payload) => {
      events.push({ type, payload })
    },
  }
}

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({
    dataDir,
    host: makeBackend(),
    docs,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<HelmError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `期望 HelmError，实际：${String(caught)}`)
  assert.equal(caught.code, code)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

function def(id: string, dependencies?: string[], define?: PluginDefinition['definePlugin']): PluginDefinition {
  return {
    id,
    ...(dependencies !== undefined && dependencies.length > 0 ? { dependencies } : {}),
    definePlugin: define ?? (() => {}),
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugin-deps-'))
  docs = new MemoryDocStore()
  events = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 声明边界与摘要
// ---------------------------------------------------------------------------

test('依赖声明：非法形状拒绝；重复项去重；摘要透出 dependencies', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await rejectsCode(host.register(def('bad', ['ok-id', 'bad@^1.0'])), 'invalid_plugin_definition', 400)
  await rejectsCode(host.register(def('bad2', ['x', 42 as unknown as string])), 'invalid_plugin_definition', 400)
  await rejectsCode(host.register(def('bad3', 'nope' as unknown as string[])), 'invalid_plugin_definition', 400)

  await host.register(def('dep-base'))
  await host.register(def('user', ['dep-base', 'dep-base']))
  const summary = host.get('user')
  assert.ok(summary)
  assert.deepEqual(summary.dependencies, ['dep-base'])

  const plain = host.get('dep-base')
  assert.ok(plain)
  assert.equal(plain.dependencies, undefined, '无依赖声明时摘要不携带空数组字段')
})

test('自依赖与两插件环路：注册边界显式 plugin_dependency_cycle', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await rejectsCode(host.register(def('self', ['self'])), 'plugin_dependency_cycle', 409)

  // 先注册 b（依赖 a，a 未注册——停用态注册允许，启用时才校验满足性）；再注册 a（依赖 b）成环。
  await host.register(def('b', ['a']), { enabled: false })
  const err = await rejectsCode(host.register(def('a', ['b'])), 'plugin_dependency_cycle', 409)
  assert.deepEqual((err.details as { cycle: string[] }).cycle, ['a', 'b', 'a'])
  assert.equal(host.list().some((s) => s.id === 'a'), false, '成环插件不进入注册表')
})

// ---------------------------------------------------------------------------
// 启用满足性
// ---------------------------------------------------------------------------

test('enable 依赖校验：缺失 / 仅注册未启用 / 启用后成功', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('user', ['missing-dep']), { enabled: false })
  await host.register(def('user2', ['disabled-dep']), { enabled: false })
  await host.register(def('user3', ['enabled-dep']), { enabled: false })

  const missingErr = await rejectsCode(host.enable('user'), 'plugin_dependency_missing', 409)
  assert.equal((missingErr.details as { dependency: string }).dependency, 'missing-dep')

  await host.register(def('disabled-dep'), { enabled: false })
  const notEnabledErr = await rejectsCode(host.enable('user2'), 'plugin_dependency_not_enabled', 409)
  assert.equal((notEnabledErr.details as { dependency: string }).dependency, 'disabled-dep')
  assert.equal(host.get('user2')?.enabled, false, '启用失败保持停用')

  await host.register(def('enabled-dep'), { enabled: true })
  await host.enable('user3')
  assert.equal(host.get('user3')?.enabled, true)
  assert.equal(host.get('user3')?.status, 'active')
})

test('注册即启用同样校验依赖；依赖启用后可恢复', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await rejectsCode(host.register(def('eager', ['not-there']), { enabled: true }), 'plugin_dependency_missing', 409)
  assert.equal(host.list().some((s) => s.id === 'eager'), false)

  const host2 = makeHost()
  await host2.register(def('late-dep'), { enabled: true })
  await host2.register(def('eager', ['late-dep']), { enabled: true })
  assert.equal(host2.get('eager')?.enabled, true)
  await host2.dispose()
})

// ---------------------------------------------------------------------------
// 拓扑序启动 / 停止
// ---------------------------------------------------------------------------

test('全局屏障按依赖拓扑序 prepare/start，stop 逆拓扑序；同层保持注册序', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const svc = (label: string) => ({
    id: `svc-${label}`,
    async prepare() {
      order.push(`prepare:${label}`)
    },
    async start() {
      order.push(`start:${label}`)
    },
    async stop() {
      order.push(`stop:${label}`)
    },
  })
  const host = makeHost({ deferServices: true })
  // 注册序：first, mid, last（last -> mid -> first 依赖链）
  await host.register({
    id: 'first',
    definePlugin: (ctx) => {
      ctx.service(svc('first'))
    },
  })
  await host.register({
    id: 'mid',
    dependencies: ['first'],
    definePlugin: (ctx) => {
      ctx.service(svc('mid'))
    },
  })
  await host.register({
    id: 'independent-a',
    definePlugin: (ctx) => {
      ctx.service(svc('ia'))
    },
  })
  await host.register({
    id: 'independent-b',
    definePlugin: (ctx) => {
      ctx.service(svc('ib'))
    },
  })
  await host.register({
    id: 'last',
    dependencies: ['mid'],
    definePlugin: (ctx) => {
      ctx.service(svc('last'))
    },
  })
  await host.start()

  const prepareIdx = (label: string) => order.indexOf(`prepare:${label}`)
  const startIdx = (label: string) => order.indexOf(`start:${label}`)
  // 屏障语义保持：全部 prepare 先于全部 start。
  assert.ok(order.slice(0, 5).every((e) => e.startsWith('prepare:')))
  // 依赖拓扑：被依赖者先 prepare / start。
  assert.ok(prepareIdx('first') < prepareIdx('mid') && prepareIdx('mid') < prepareIdx('last'))
  assert.ok(startIdx('first') < startIdx('mid') && startIdx('mid') < startIdx('last'))
  // 同层（无依赖关系）保持注册序。
  assert.ok(prepareIdx('ia') < prepareIdx('ib'))

  await host.stop()
  const stops = order.filter((e) => e.startsWith('stop:')).map((e) => e.slice(5))
  // 拓扑序 [first, ia, ib, mid, last] 的逆序：依赖者先停。
  assert.deepEqual(stops, ['last', 'mid', 'ib', 'ia', 'first'])
  await host.dispose()
})

test('热启用：依赖已运行时直接启用（服务即时 prepare+start）', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const host = makeHost()
  await host.register({
    id: 'base',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('base-start') }, async stop() {} })
    },
  })
  await host.register({
    id: 'top',
    dependencies: ['base'],
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('top-start') }, async stop() {} })
    },
  })
  await host.enable('top')
  assert.deepEqual(order, ['base-start', 'top-start'])
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 依赖者保护
// ---------------------------------------------------------------------------

test('非 force 停用被依赖插件：plugin_in_use 拦截（含传递依赖者）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('mid', ['base']), { enabled: true })
  await host.register(def('top', ['mid']), { enabled: true })

  const err = await rejectsCode(host.disable('base'), 'plugin_in_use', 409)
  const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
  assert.deepEqual(
    usages.map((u) => u.id).sort(),
    ['mid', 'top'],
    '直接与传递依赖者都进入占用清单',
  )
  assert.ok(usages.every((u) => u.kind === 'plugin_dependency'))
  assert.equal(host.get('base')?.enabled, true)
  await host.dispose()
})

test('force 停用：成功且依赖者显式标记（status=failed + plugin.changed），不留静默错误态', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  events.length = 0
  await host.disable('base', { force: true })

  assert.equal(host.get('base')?.enabled, false)
  const user = host.get('user')
  assert.ok(user)
  assert.equal(user.enabled, true, 'force 只作用于目标插件，不自动停用依赖者')
  assert.equal(user.status, 'failed', '依赖不满足显式可见')
  assert.equal(user.error?.code, 'plugin_dependency_not_enabled')
  assert.ok(
    events.some(
      (e) =>
        e.type === 'plugin.changed' &&
        (e.payload as { plugin?: { id: string } }).plugin?.id === 'user',
    ),
    '依赖者状态变更被广播',
  )

  // 恢复路径：停用依赖者 -> 启用 base -> 重新启用 user 成功且错误清除。
  await host.disable('user')
  await host.enable('base')
  await host.enable('user')
  const recovered = host.get('user')
  assert.ok(recovered)
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.error, undefined)

  // force 停用后遗留的故障态依赖者同样保护注销：必须先停用依赖者。
  await host.disable('base', { force: true })
  await rejectsCode(host.unregister('base'), 'plugin_in_use', 409)
  await host.disable('user')
  await host.unregister('base')
  await host.dispose()
})

test('注销被依赖插件：依赖者在启用态时拒绝；停用依赖者后放行', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  await rejectsCode(host.unregister('base'), 'plugin_in_use', 409)

  await host.disable('user')
  await host.unregister('base')
  assert.equal(host.get('base'), undefined)
  // base 移除后 user 的依赖缺失：enable 显式失败。
  await rejectsCode(host.enable('user'), 'plugin_dependency_missing', 409)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 并发无死锁
// ---------------------------------------------------------------------------

test('并发注册/启用/停用混合操作全部收敛（无死锁）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const ops: Array<Promise<unknown>> = []
  for (let i = 0; i < 6; i++) {
    ops.push(host.register(def(`p${i}`, [`p${(i + 1) % 6}`]), { enabled: false }))
  }
  // 6 个插件首尾相连成环：逐个拒绝，绝不悬挂。
  const results = await Promise.allSettled(ops)
  const rejected = results.filter((r) => r.status === 'rejected').length
  assert.ok(rejected >= 1, '环路注册被显式拒绝')
  assert.equal(results.length, 6)

  const host2 = makeHost()
  await host2.register(def('a0'), { enabled: false })
  await host2.register(def('b0', ['a0']), { enabled: false })
  await host2.register(def('c0', ['b0']), { enabled: false })
  // 并发启用链 + 与停用交错：允许部分失败（依赖未就绪 / in-use），但必须全部返回。
  const settled = await Promise.allSettled([
    host2.enable('a0'),
    host2.enable('b0'),
    host2.enable('c0'),
    host2.disable('a0'),
  ])
  assert.equal(settled.length, 4)
  await host.dispose()
  await host2.dispose()
})
