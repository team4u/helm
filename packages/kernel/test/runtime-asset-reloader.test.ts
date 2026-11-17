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

describe('AssetReloader unit tests', { timeout: 60_000 }, () => {
  it('refreshes plugin config mirror on config.json change and explicitly reports errors via notifyError', { timeout: 60_000 }, async () => {
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
    assert.equal(notifications[0]!.title, 'Plugin config hot reload failed')
    assert.ok(String(notifications[0]!.error).includes('config syntax error'))

    await reloader.close()
  })

  it('debounces providers/credentials changes over 200ms into a single reloadModels call', { timeout: 60_000 }, async (t) => {
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

    // t = 0: first change starts the debounce timer
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(100)
    await Promise.resolve()
    assert.equal(reloadCount, 0, 'debounce window must not trigger at 100ms')

    // t = 100: second change resets the 200ms debounce window
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(150)
    await Promise.resolve()
    assert.equal(reloadCount, 0, 'only 150ms since second change; must not trigger yet')

    // t = 300: 200ms elapsed since second change
    t.mock.timers.tick(50)
    await reloader.waitForInflight()
    assert.equal(reloadCount, 1, 'should trigger exactly one reload after debounce window completes')

    await reloader.close()
  })

  it('serializes two reloadModels calls so max concurrency is 1', { timeout: 60_000 }, async (t) => {
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

    // Trigger first reload
    reloader.onAssetsChanged(['providers.json'])
    t.mock.timers.tick(200)
    await gate1Started.promise
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1)

    // Trigger second reload while first reload is blocked
    reloader.onAssetsChanged(['credentials.json'])
    t.mock.timers.tick(200)
    // Timer fired and queued onto reloadChain, but blocked behind first reload
    assert.equal(startedCount, 1)
    assert.equal(concurrency, 1)

    // Unblock first reload
    gate1.resolve()
    // Wait for second reload to start and block on gate2
    await gate2Started.promise
    assert.equal(startedCount, 2)
    assert.equal(concurrency, 1)
    assert.equal(maxConcurrency, 1, 'two reloads execute serially with max concurrency 1')

    // Unblock second reload
    gate2.resolve()
    await reloader.waitForInflight()
    assert.equal(concurrency, 0)
    assert.equal(maxConcurrency, 1)
    assert.equal(startedCount, 2)

    await reloader.close()
  })

  it('respects external ownership when externalModels is true and never triggers reloadModels', { timeout: 60_000 }, async (t) => {
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

    assert.equal(reloadCount, 0, 'when external models are injected, reloadModels must not overwrite them')

    await reloader.close()
  })

  it('ignores non-hot-reloadable paths such as profiles and skills', { timeout: 60_000 }, async (t) => {
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

  it('cancels pending debounce timer on stop without triggering reload', { timeout: 60_000 }, async (t) => {
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

    // Stop before the 200ms debounce expires
    reloader.stop()
    t.mock.timers.tick(500)

    assert.equal(reloadCount, 0, 'stop should cancel pending debounce timer without reloading')
    await reloader.waitForInflight()
    assert.equal(reloadCount, 0)
  })

  it('ignores new asset events after stop', { timeout: 60_000 }, async (t) => {
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

    assert.equal(reloadModelsCount, 0, 'model asset events after stop must be discarded')
    assert.equal(reloadConfigCount, 0, 'config events after stop must be discarded')

    await reloader.waitForInflight()
  })

  it('waits for in-flight reload completion after stop via waitForInflight', { timeout: 60_000 }, async (t) => {
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
    assert.equal(finished, false, 'reload is currently in progress')

    reloader.stop()
    gate.resolve()
    await reloader.waitForInflight()

    assert.equal(finished, true, 'waitForInflight must await full convergence of in-flight reloads')
  })

  it('notifies original error without unhandled rejections when in-flight reload fails after stop', { timeout: 60_000 }, async (t) => {
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

    // Reload has started and is in-flight; call stop now
    reloader.stop()

    // Unblock rejection, simulating a hot-reload execution failure
    const failure = new Error('simulated reload failure during shutdown')
    gate.reject(failure)

    // waitForInflight awaits in-flight chain convergence; error is caught and reported without leaving unhandled rejections
    await reloader.waitForInflight()

    assert.equal(notifications.length, 1, 'in-flight reload failure must notify explicitly instead of being swallowed on stop')
    assert.equal(notifications[0]!.title, 'Model config hot reload failed')
    assert.equal(notifications[0]!.error, failure)
  })

  it('also awaits already-started plugin config mirror refresh after stop to avoid writes after closing persistence', { timeout: 60_000 }, async () => {
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
    assert.equal(drained, false, 'shutdown barrier must not resolve before config refresh finishes')

    gate.resolve()
    await waiting
    assert.equal(drained, true)
  })

  it('explicitly rejects shutdown barrier instead of pretending success if notifyError throws', { timeout: 60_000 }, async (t) => {
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
        assert.equal(title, 'Model config hot reload failed')
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

  it('explicitly reports watcher errors via notifyError rather than failing silently', { timeout: 60_000 }, async () => {
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
    assert.equal(notifications[0]!.title, 'Asset hot-reload watcher failed')
    assert.equal(notifications[0]!.error, watcherErr)

    await reloader.close()
  })
})
