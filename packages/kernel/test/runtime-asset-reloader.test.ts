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

describe('AssetReloader unit test', { timeout: 60_000 }, () => {
  it('config.json change refresh plugin config mirror, failed explicit on report notify', { timeout: 60_000 }, async () => {
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
    assert.equal(notifications[0]!.title, 'plugin config hot reload failed')
    assert.ok(String(notifications[0]!.error).includes('config syntax error'))

    await reloader.close()
  })

  it('providers/credentials change via 200ms guard against jitter merge trigger single time reloadModels', { timeout: 60_000 }, async (t) => {
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

    // t = 0: first time change trigger guard against jitter count when
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(100)
    await Promise.resolve()
    assert.equal(reloadCount, 0, '100ms when guard against jitter not yet trigger')

    // t = 100: second time change reset 200ms guard against jitter window
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(150)
    await Promise.resolve()
    assert.equal(reloadCount, 0, 'distance second time change only 150ms, still must not trigger')

    // t = 300: reach second time change after 200ms
    t.mock.timers.tick(50)
    await reloader.waitForInflight()
    assert.equal(reloadCount, 1, 'guard against jitter window full after should and only should trigger 1 time reload')

    await reloader.close()
  })

  it('serial two time reloadModels most large concurrency is 1', { timeout: 60_000 }, async (t) => {
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

    // trigger first time reload
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await gate1Started.promise
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1)

    // in first time reload block during trigger second time reload
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(200)
    // timer already trigger and add reloadChain, but because pre- reload block, second time reload not start
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)

    // let through first time reload
    gate1.resolve()
    // wait for second time reload start and block in gate2
    await gate2Started.promise
    assert.equal(startedCount, 2)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1, 'two time reload serial execute, most large concurrency must is 1')

    // let through second time reload
    gate2.resolve()
    await reloader.waitForInflight()
    assert.equal(concurrency, 0)
    assert.equal(maxConcurrency, 1)
    assert.equal(startedCount, 2)

    await reloader.close()
  })

  it('externalModels is true when keep external ownership, does not trigger reloadModels', { timeout: 60_000 }, async (t) => {
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

    assert.equal(reloadCount, 0, 'external model inject when never automatically trigger reloadModels replace')

    await reloader.close()
  })

  it('profiles and skills etc. non- static config path does not trigger model or config hot reload', { timeout: 60_000 }, async (t) => {
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

  it('stop closure stop one phase cancel await trigger guard against jitter (timer by cancel, does not trigger reload)', { timeout: 60_000 }, async (t) => {
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

    // in 200ms guard against jitter expires before stop
    reloader.stop()
    t.mock.timers.tick(500)

    assert.equal(reloadCount, 0, 'stop should cancel await trigger guard against jitter timer, do not occur reload')
    await reloader.waitForInflight()
    assert.equal(reloadCount, 0)
  })

  it('stop after do not accept new event', { timeout: 60_000 }, async (t) => {
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

    assert.equal(reloadModelsCount, 0, 'stop after static model asset event should by discard')
    assert.equal(reloadConfigCount, 0, 'stop after config event should by discard')

    await reloader.waitForInflight()
  })

  it('stop after wait for in-flight reload succeeded converge (waitForInflight wait for succeeded)', { timeout: 60_000 }, async (t) => {
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
    assert.equal(finished, false, 'reload is now execute in')

    reloader.stop()
    gate.resolve()
    await reloader.waitForInflight()

    assert.equal(finished, true, 'in-flight reload must by waitForInflight fully wait for succeeded converge')
  })

  it('reload start and block,stop, let through reject,await waitForInflight, core for notify has original error and do not under unhandled', { timeout: 60_000 }, async (t) => {
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

    // reload already start and in-flight run, now execute stop
    reloader.stop()

    // let through reject, simulated hot reload execute phase failed
    const failure = new Error('simulated reload failure during shutdown')
    gate.reject(failure)

    // waitForInflight wait for in-flight link converge; error by internal catch catch and notify, do not legacy unhandled rejection
    await reloader.waitForInflight()

    assert.equal(notifications.length, 1, 'in-flight reload failed must explicit notify, must not because stop static default swallow')
    assert.equal(notifications[0]!.title, 'model config hot reload failed')
    assert.equal(notifications[0]!.error, failure)
  })

  it('stop after same wait for already start config mirror refresh, avoid persist close after continue write', { timeout: 60_000 }, async () => {
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
    assert.equal(drained, false, 'config refresh not yet complete when cannot end closure stop screen fault')

    gate.resolve()
    await waiting
    assert.equal(drained, true)
  })

  it('error notify publish itself on failure, closure stop screen fault explicit reject, do not smoke fill succeeded', { timeout: 60_000 }, async (t) => {
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
        assert.equal(title, 'model config hot reload failed')
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

  it('watcher exception explicit on report notify (not silently fall back)', { timeout: 60_000 }, async () => {
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
    assert.equal(notifications[0]!.title, 'asset hot reload listen failed')
    assert.equal(notifications[0]!.error, watcherErr)

    await reloader.close()
  })
})
