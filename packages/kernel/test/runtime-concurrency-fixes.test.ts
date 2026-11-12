/**
 * 并发缺陷修复回归测试（runtime / model-registry 层）。
 *
 * 覆盖：
 * - turn 结算链毒化：插件 turn_settled transform 产出非法事件载荷时，
 *   dispatchTurnSettled 不得 reject（否则 settledInflight 聚合链被毒化，
 *   close 的 teardown 中断、SQLite 句柄泄漏）；
 * - dispatchInternalEvent 逐监听器隔离（调用方语句调用不 await）；
 * - start() 单飞失败后可重试（startPromise 不残留陈旧拒绝）；
 * - close() 等待在途 start() 收敛（teardown 不与插件启动交错）；
 * - plugin.changed 的 refreshPluginTools 失败不丢事件；
 * - 运行时供应商注销 TOCTOU：rebuild await 窗口内新 stream acquire 显式失败。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime, ModelRegistry } from '../src/runtime/index.js'
import { createFileModelsStore } from '../src/runtime/models-store.js'
import { CredentialService, ConfigService, ProviderService, SecretStash, ensureDataDir } from '../src/services/index.js'

function makeFauxModels() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: ReturnType<typeof fauxProvider> }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
  return Object.assign(runtime, { __faux: faux })
}

test('turn_settled transform 产出非法事件载荷：结算链吸收错误，close 不被毒化中断', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-settle-poison-'))
  const kernel = await openRuntime(dataDir)
  try {
    await kernel.plugins.register({
      id: 'test:poison',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          // 钩子载荷校验只查必要字段：合法载荷 + 额外 BigInt 字段可穿过
          // transform 管道，到 events.publish 的 JSON 脱敏处才显式抛错
          return { action: 'transform', value: { ...payload, poisoned: 10n } } as never
        })
      },
    })
    kernel.__faux.setResponses([fauxAssistantMessage('答一'), fauxAssistantMessage('答二')])
    await kernel.submitInput(1, '第一回合')
    await kernel.waitForIdle(1)
    await kernel.submitInput(1, '第二回合')
    await kernel.waitForIdle(1)
    // 两回合都完成且结算链不为 rejected：close 内部三次 await settledInflight，
    // 修复前首次 reject 即中断 teardown（store/database/events close 被跳过）。
    await kernel.close()
    assert.equal(kernel.getConversation(1).completionSeq, 2)
  } finally {
    await kernel.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('dispatchInternalEvent 逐监听器隔离：抛错不阻断后续监听器，也不产生 unhandledRejection', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-internal-event-'))
  const kernel = await openRuntime(dataDir)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    let secondRan = false
    kernel.onEvent('test:probe', async () => { throw new Error('第一个监听器失败') })
    kernel.onEvent('test:probe', async () => { secondRan = true })
    // 调用方语句调用（不 await 不 catch）——与 plugin-host emitEvent 同姿势
    void kernel.emitHostEvent('test:probe', { a: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await kernel.emitHostEvent('test:probe', { a: 2 })
    assert.equal(secondRan, true, '前一个监听器抛错不得阻断后续监听器')
    assert.equal(unhandled.length, 0, 'dispatchInternalEvent 返回的 promise 不得 reject')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('start() 失败清除单飞句柄：重试发起全新尝试，而非永远收到陈旧拒绝', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-start-retry-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    let startCalls = 0
    // 注：pluginHost.start 自身也有单飞残留（不在本次修复白名单内），这里
    // 替换实例方法以隔离验证 KernelRuntime 层的重试语义。
    const host = kernel.plugins as unknown as { start: () => Promise<void> }
    host.start = async () => {
      startCalls += 1
      if (startCalls === 1) throw new Error('第一次启动失败')
    }
    await assert.rejects(kernel.start(), /第一次启动失败/)
    assert.equal(startCalls, 1)
    await kernel.start()
    assert.equal(startCalls, 2, '重试必须重新调用 pluginHost.start，而不是返回缓存的陈旧拒绝')
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('close() 等待在途 start() 收敛：服务 stop 在 start 完成之后，teardown 不与启动交错', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-close-waits-start-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
  try {
    const order: string[] = []
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    await kernel.plugins.register({
      id: 'test:slow-start',
      definePlugin(ctx) {
        ctx.service({
          id: 'svc',
          async start() { order.push('start-begin'); await startGate; order.push('start-end') },
          stop() { order.push('stop') },
        })
      },
    })
    const starting = kernel.start()
    await new Promise((resolve) => setTimeout(resolve, 25))
    // start 仍在途（服务 start 被门闩挂起）时发起 close
    const closing = kernel.close()
    releaseStart()
    await Promise.all([starting, closing])
    assert.deepEqual(order, ['start-begin', 'start-end', 'stop'], 'teardown 必须等 start 完成后再停服务')
  } finally {
    await kernel.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('plugin.changed：refreshPluginTools 抛错不阻断事件发布', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-plugin-changed-'))
  const kernel = await openRuntime(dataDir)
  try {
    ;(kernel as unknown as { refreshPluginTools: () => void }).refreshPluginTools = () => {
      throw new Error('工具热装失败')
    }
    const seen: string[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string }
      if (event.type === 'plugin.changed') seen.push(event.type)
    })
    kernel.emitHostEvent('plugin.changed', { plugin: { id: 'test:hot', version: '1.0.0', enabled: true, locked: false } })
    assert.equal(seen.length, 1, '热装失败仍必须发布 plugin.changed（客户端不能丢失插件状态变化）')
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('供应商注销 rebuild 窗口内：新 stream acquire 显式失败（runtime_provider_retiring），不再产生不可检测的在途流', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-provider-retiring-'))
  try {
    await ensureDataDir(dataDir)
    const providersSvc = new ProviderService(dataDir)
    const credentialsSvc = new CredentialService(dataDir)
    const configSvc = new ConfigService(dataDir)
    // 门闩 providersSvc.list：第 2 次（注销的 rebuild）在窗口内挂起，制造
    // 「usage 检查已过、rebuild 未完」的 await 窗口
    let listCalls = 0
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => { releaseList = resolve })
    const gatedProviders = Object.create(providersSvc) as ProviderService
    ;(gatedProviders as unknown as { list: () => ReturnType<ProviderService['list']> }).list = async () => {
      listCalls += 1
      if (listCalls >= 2) await listGate
      return providersSvc.list()
    }
    // get 显式指向原实例：其内部 this.list() 否则会误计入门控次数
    ;(gatedProviders as unknown as { get: ProviderService['get'] }).get = (id) => providersSvc.get(id)

    let current = createModels()
    const published: string[] = []
    const registry = new ModelRegistry(
      {
        dataDir,
        providersSvc: gatedProviders,
        credentialsSvc,
        configSvc,
        stash: new SecretStash(),
        modelsStore: createFileModelsStore(dataDir),
        setModels: (m) => { current = m as typeof current },
        externalModels: false,
        events: { publish: (type) => { published.push(type) } },
        pluginHost: () => undefined,
        alignAllConversations: async () => {},
      },
      createModels(),
      {},
    )
    const faux = fauxProvider({ provider: 'retire-p', models: [{ id: 'm1' }] })
    const unregister = await registry.registerRuntimeProvider(faux.provider, 'test:retire')
    assert.ok(published.includes('models.changed'))

    // 发起注销并在 rebuild 窗口内停留
    const unregistering = unregister()
    const deadline = Date.now() + 10_000
    while (listCalls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.equal(listCalls, 2, '注销的 rebuild 应进入门闩窗口')

    // 窗口内：旧集合仍含该供应商，但新 stream acquire 必须显式失败
    const wrapped = current.getProvider('retire-p')
    assert.ok(wrapped, '窗口内旧集合仍可寻址该供应商')
    assert.throws(
      () => (wrapped as unknown as { stream: () => void }).stream(),
      (err: unknown) => err instanceof HelmError && err.code === 'runtime_provider_retiring' && err.status === 409,
    )

    releaseList()
    await unregistering
    assert.ok(!registry.listModelProviders().some((p) => p.id === 'retire-p'), '注销完成后目录移除')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
