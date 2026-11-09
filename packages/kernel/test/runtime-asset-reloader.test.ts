import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AssetReloader } from '../src/runtime/asset-reloader.js'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AssetReloader 单元测试', { timeout: 60_000 }, () => {
  it('config.json 变更刷新插件配置镜像，失败显式上报通知', { timeout: 60_000 }, async () => {
    const notifications: Array<{ title: string; error: unknown }> = []
    const errorDeferred = createDeferred<void>()

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {},
      reloadPluginConfig: async () => {
        throw new Error('config syntax error')
      },
      notifyError: (title, error) => {
        notifications.push({ title, error })
        errorDeferred.resolve()
      },
    })

    reloader.onAssetsChanged(['config.json'])
    await errorDeferred.promise

    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, '插件配置热重载失败')
    assert.ok(String(notifications[0]!.error).includes('config syntax error'))

    await reloader.close()
  })

  it('providers/credentials 变更经 200ms 防抖合并触发单次 reloadModels', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let reloadCount = 0
    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        reloadCount++
      },
      reloadPluginConfig: async () => {},
      notifyError: () => {},
    })

    // t = 0: 首次变更触发防抖计时
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(100)
    await Promise.resolve()
    assert.equal(reloadCount, 0, '100ms 时防抖尚未触发')

    // t = 100: 第二次变更重置 200ms 防抖窗口
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(150)
    await Promise.resolve()
    assert.equal(reloadCount, 0, '距离第二次变更仅 150ms，仍不应触发')

    // t = 300: 达到第二次变更后的 200ms
    t.mock.timers.tick(50)
    await reloader.waitForInflight()
    assert.equal(reloadCount, 1, '防抖窗口满后应且仅应触发 1 次 reload')

    await reloader.close()
  })

  it('串行两次 reloadModels 的最大并发为 1', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let concurrency = 0
    let maxConcurrency = 0
    let startedCount = 0
    const gate1Started = createDeferred<void>()
    const gate1 = createDeferred<void>()
    const gate2Started = createDeferred<void>()
    const gate2 = createDeferred<void>()

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        const idx = startedCount++
        concurrency++
        maxConcurrency = Math.max(maxConcurrency, concurrency)
        if (idx === 0) {
          gate1Started.resolve()
          await gate1.promise
        } else {
          gate2Started.resolve()
          await gate2.promise
        }
        concurrency--
      },
      reloadPluginConfig: async () => {},
      notifyError: () => {},
    })

    // 触发第一次 reload
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await gate1Started.promise
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1)

    // 在第一次 reload 阻塞期间触发第二次 reload
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(200)
    // 定时器已触发并加入 reloadChain，但由于前置 reload 阻塞，第二次 reload 未开始
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)

    // 放行第一次 reload
    gate1.resolve()
    // 等待第二次 reload 启动并阻塞在 gate2
    await gate2Started.promise
    assert.equal(startedCount, 2)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1, '两次 reload 串行执行，最大并发度必须为 1')

    // 放行第二次 reload
    gate2.resolve()
    await reloader.waitForInflight()
    assert.equal(concurrency, 0)
    assert.equal(maxConcurrency, 1)
    assert.equal(startedCount, 2)

    await reloader.close()
  })

  it('externalModels 为 true 时保持外部所有权，不触发 reloadModels', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let reloadCount = 0
    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      externalModels: true,
      reloadModels: async () => {
        reloadCount++
      },
      reloadPluginConfig: async () => {},
      notifyError: () => {},
    })

    reloader.onAssetsChanged(['providers.json'])
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(500)

    assert.equal(reloadCount, 0, '外部模型注入时绝不自动触发 reloadModels 替换')

    await reloader.close()
  })

  it('profiles 与 skills 等非静态配置路径不触发模型或配置热重载', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let reloadModelsCount = 0
    let reloadConfigCount = 0

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        reloadModelsCount++
      },
      reloadPluginConfig: async () => {
        reloadConfigCount++
      },
      notifyError: () => {},
    })

    reloader.onAssetsChanged([
      'profiles/assistant/MEMORY.md',
      'skills/web/SKILL.md',
      'state.sqlite',
      'other.txt',
    ])
    t.mock.timers.tick(500)

    assert.equal(reloadModelsCount, 0)
    assert.equal(reloadConfigCount, 0)

    await reloader.close()
  })

  it('stop 关停第一阶段取消待触发防抖（定时器被取消，不触发 reload）', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let reloadCount = 0
    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        reloadCount++
      },
      reloadPluginConfig: async () => {},
      notifyError: () => {},
    })

    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(100)

    // 在 200ms 防抖到期前 stop
    reloader.stop()
    t.mock.timers.tick(500)

    assert.equal(reloadCount, 0, 'stop 应取消待触发防抖定时器，不发生 reload')
    await reloader.waitForInflight()
    assert.equal(reloadCount, 0)
  })

  it('stop 后不接受新事件', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    let reloadModelsCount = 0
    let reloadConfigCount = 0

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        reloadModelsCount++
      },
      reloadPluginConfig: async () => {
        reloadConfigCount++
      },
      notifyError: () => {},
    })

    reloader.stop()
    reloader.onAssetsChanged(['providers.json', 'credentials.json', 'config.json'])
    t.mock.timers.tick(500)

    assert.equal(reloadModelsCount, 0, 'stop 后静态模型资产事件应被丢弃')
    assert.equal(reloadConfigCount, 0, 'stop 后配置事件应被丢弃')

    await reloader.waitForInflight()
  })

  it('stop 后等待在途 reload 成功收敛（waitForInflight 等待成功）', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    const gateStarted = createDeferred<void>()
    const gate = createDeferred<void>()
    let finished = false

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        gateStarted.resolve()
        await gate.promise
        finished = true
      },
      reloadPluginConfig: async () => {},
      notifyError: () => {},
    })

    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await gateStarted.promise
    assert.equal(finished, false, 'reload 正在执行中')

    reloader.stop()
    gate.resolve()
    await reloader.waitForInflight()

    assert.equal(finished, true, '在途 reload 必须被 waitForInflight 完全等待成功收敛')
  })

  it('reload 开始并阻塞，stop，放行 reject，await waitForInflight，核对通知有原错误且不留下 unhandled', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())

    const notifications: Array<{ title: string; error: unknown }> = []
    const gateStarted = createDeferred<void>()
    const gate = createDeferred<void>()

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        gateStarted.resolve()
        await gate.promise
      },
      reloadPluginConfig: async () => {},
      notifyError: (title, error) => {
        notifications.push({ title, error })
      },
    })

    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await gateStarted.promise

    // reload 已启动并在途运行，此时执行 stop
    reloader.stop()

    // 放行 reject，模拟热重载执行期失败
    const failure = new Error('simulated reload failure during shutdown')
    gate.reject(failure)

    // waitForInflight 等待在途链路收敛；错误被内部 catch 捕获并通知，不遗留 unhandled rejection
    await reloader.waitForInflight()

    assert.equal(notifications.length, 1, '在途 reload 失败必须显式通知，不得因 stop 静默吞掉')
    assert.equal(notifications[0]!.title, '模型配置热重载失败')
    assert.equal(notifications[0]!.error, failure)
  })

  it('stop 后同样等待已开始的配置镜像刷新，避免持久化关闭后继续写入', { timeout: 60_000 }, async () => {
    const started = createDeferred()
    const gate = createDeferred()
    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {},
      reloadPluginConfig: async () => {
        started.resolve()
        await gate.promise
      },
      notifyError: () => {},
    })

    reloader.onAssetsChanged(['config.json'])
    await started.promise
    reloader.stop()
    let drained = false
    const waiting = reloader.waitForInflight().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false, '配置刷新尚未完成时不可结束关停屏障')

    gate.resolve()
    await waiting
    assert.equal(drained, true)
  })

  it('错误通知发布自身失败时，关停屏障显式拒绝，不冒充成功', { timeout: 60_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())
    const started = createDeferred()
    const gate = createDeferred()
    const reloadFailure = new Error('reload failed')
    const reportFailure = new Error('notification publish failed')
    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {
        started.resolve()
        await gate.promise
      },
      reloadPluginConfig: async () => {},
      notifyError: (title, error) => {
        assert.equal(title, '模型配置热重载失败')
        assert.equal(error, reloadFailure)
        throw reportFailure
      },
    })

    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await started.promise
    reloader.stop()
    const rejected = assert.rejects(reloader.waitForInflight(), (error) => error === reportFailure)
    gate.reject(reloadFailure)
    await rejected
  })

  it('watcher 异常显式上报通知（不静默降级）', { timeout: 60_000 }, async () => {
    const notifications: Array<{ title: string; error: unknown }> = []
    let watcherOnError: ((err: Error) => void) | undefined

    const reloader = new AssetReloader({
      dataDir: '/mock/data-dir',
      reloadModels: async () => {},
      reloadPluginConfig: async () => {},
      notifyError: (title, error) => {
        notifications.push({ title, error })
      },
      createWatcher: (_dir, _onChange, opts) => {
        watcherOnError = opts.onError
        return {
          start() {},
          close() {},
        }
      },
    })

    reloader.start()
    assert.ok(watcherOnError)
    const watcherErr = new Error('inotify watch limit reached')
    watcherOnError!(watcherErr)

    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, '资产热重载监听失败')
    assert.equal(notifications[0]!.error, watcherErr)

    await reloader.close()
  })
})
