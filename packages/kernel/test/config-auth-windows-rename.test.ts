/**
 * Windows config.json rename EPERM protect and AuthService zero read cache regression:
 * 1. atomicWriteFile / copyFilePrivate in Windows instantaneous EPERM/EACCES/EBUSY under has boundary backoff retry;
 *    exhausted when keep original errno code, patch fill retry time count diagnose, clean up tmp and keep old target file; non- Windows immediately failed.
 * 2. ConfigService.get and updateBy sharing process inside file lock and without heavy deadlock (same process read write mutual exclusion, do not collide rename).
 * 3. AuthService by canonical path sharing process inside cache and singleflight: steady state verifyToken/status zero readFile,
 *    across instance and symlink sync expires, external change invalidateCache takes effect, corrupt do not cache, concurrency read do not back fill old snapshot.
 * 4. concurrency simulated:Windows handle conflict semantics under high frequency verifyToken/status and setEnabled hand over wrong zero failed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHubHandler, type EventHub, type KernelRuntimeLike } from '../src/http/index.js'
import { PluginHost } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import {
  AuthService,
  ConfigService,
  CredentialService,
  atomicWriteFile,
  atomicWriteJson,
  copyFilePrivate,
} from '../src/services/index.js'
import { HelmPluginConfigStore } from '../src/runtime/plugin-config-store.js'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

function errnoError(code: string, message = `simulated system error (${code})`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -4048, syscall: 'rename' })
}

function fakePlatform(platform: NodeJS.Platform): () => void {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: real, configurable: true })
}

async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir(prefix)
  try {
    await fn(dir)
  } finally {
    await cleanupDir(dir).catch(() => {})
  }
}

async function assertNoTmpLeftovers(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir)
  const tmps = entries.filter((name) => name.includes('.tmp'))
  assert.deepEqual(tmps, [], `must not leftover temp file: ${tmps.join(', ')}`)
}

test('Windows atomicWriteJson encounter instantaneous EPERM/EACCES/EBUSY backoff after succeeded commit, without tmp leftover', { timeout: 60_000 }, async (t) => {
  const restore = fakePlatform('win32')
  const realRename = fsp.rename.bind(fsp)
  let attempts = 0
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    attempts += 1
    if (attempts === 1) throw errnoError('EPERM')
    if (attempts === 2) throw errnoError('EACCES')
    if (attempts === 3) throw errnoError('EBUSY')
    return realRename(...args)
  })
  try {
    await withTempDir('helm-atomic-retry-', async (dir) => {
      const target = join(dir, 'config.json')
      await fsp.writeFile(target, JSON.stringify({ keep: 1 }), 'utf8')
      await atomicWriteJson(target, { keep: 1, updated: true })
      const saved = JSON.parse(await fsp.readFile(target, 'utf8')) as Record<string, unknown>
      assert.deepEqual(saved, { keep: 1, updated: true })
      assert.equal(stub.mock.callCount(), 4)
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
    restore()
  }
})

test('Windows atomicWriteFile and copyFilePrivate continuous EPERM has boundary exhausted: keep code, attach retry diagnose, clean tmp, old value completely well', { timeout: 60_000 }, async (t) => {
  const restore = fakePlatform('win32')
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM', 'EPERM: operation not permitted, rename')
  })
  const startedAt = Date.now()
  try {
    await withTempDir('helm-atomic-exhaust-', async (dir) => {
      const target = join(dir, 'config.json')
      await fsp.writeFile(target, '{"stable":true}\n', 'utf8')
      await assert.rejects(
        atomicWriteFile(target, '{"stable":false}\n'),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EPERM' &&
          err.message.includes('Windows target file instantaneous occupy') &&
          err.message.includes('already retry'),
      )
      const waited = Date.now() - startedAt
      assert.ok(waited >= 1_400, `should has boundary backoff about 1.5s again failed, actual ${waited}ms`)
      assert.ok(waited < 10_000, `backoff time must has boundary converge, actual ${waited}ms`)
      assert.ok(stub.mock.callCount() >= 20, `should continuous retry direct until exhausted, actual ${stub.mock.callCount()} time`)
      assert.equal(await fsp.readFile(target, 'utf8'), '{"stable":true}\n')
      await assertNoTmpLeftovers(dir)

      // copyFilePrivate same away has boundary retry and clean up tmp
      const callsBeforeCopy = stub.mock.callCount()
      const src = join(dir, 'src.txt')
      const dest = join(dir, 'dest.txt')
      await fsp.writeFile(src, 'new-content', 'utf8')
      await fsp.writeFile(dest, 'old-content', 'utf8')
      await assert.rejects(
        copyFilePrivate(src, dest),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EPERM' &&
          err.message.includes('Windows target file instantaneous occupy'),
      )
      assert.ok(stub.mock.callCount() - callsBeforeCopy >= 20)
      assert.equal(await fsp.readFile(dest, 'utf8'), 'old-content')
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
    restore()
  }
})

test('non- Windows platform encounters EPERM immediately failed does not backoff retry', { timeout: 60_000 }, async (t) => {
  const restore = fakePlatform('linux')
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM', 'EPERM: operation not permitted')
  })
  try {
    await withTempDir('helm-atomic-posix-', async (dir) => {
      const target = join(dir, 'config.json')
      await assert.rejects(
        atomicWriteFile(target, 'abc'),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EPERM' &&
          !err.message.includes('Windows target file instantaneous occupy'),
      )
      assert.equal(stub.mock.callCount(), 1)
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
    restore()
  }
})

test('ConfigService.get and updateBy sharing file lock: without heavy deadlock, and same process read write strictly mutual exclusion do not collide rename', { timeout: 60_000 }, async (t) => {
  const realRename = fsp.rename.bind(fsp)
  const realReadFile = fsp.readFile.bind(fsp)
  let inRename = false
  let overlapDetected = false
  let notifyRenameEntered: (() => void) | undefined
  const renameEntered = new Promise<void>((resolve) => {
    notifyRenameEntered = resolve
  })

  const renameStub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    if (String(args[1]).endsWith('config.json')) {
      inRename = true
      notifyRenameEntered?.()
      await new Promise((r) => setTimeout(r, 40))
      try {
        return await realRename(...args)
      } finally {
        inRename = false
      }
    }
    return realRename(...args)
  })
  const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    if (String(args[0]).endsWith('config.json') && inRename) {
      overlapDetected = true
    }
    return realReadFile(...args)
  })

  try {
    await withTempDir('helm-config-rw-lock-', async (dir) => {
      const cfg = new ConfigService(dir)
      const cfgOther = new ConfigService(dir)
      const writePromise = cfg.update({ step: 1 })
      // determinism etc. to write enter rename window after again start concurrency read, verify read must queue up to write complete
      await renameEntered
      const readPromise = cfgOther.get()
      const [written, readAfter] = await Promise.all([writePromise, readPromise])
      assert.equal(written['step'], 1)
      assert.equal(readAfter['step'], 1, 'same process read should queue up to write after completion read to most new value')
      assert.equal(overlapDetected, false, 'same process inside readFile and rename never can concurrency overlap')
    })
  } finally {
    readStub.mock.restore()
    renameStub.mock.restore()
  }
})

test('AuthService process inside snapshot: steady state zero readFile, across instance and symlink sync,invalidateCache takes effect, corrupt do not cache', { timeout: 60_000 }, async (t) => {
  await withTempDir('helm-auth-cache-', async (root) => {
    const dataDir = join(root, 'data')
    const linkDir = join(root, 'data-link')
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.symlink(await fsp.realpath(dataDir), linkDir)

    const authA = new AuthService(dataDir)
    const authB = new AuthService(dataDir)
    const authLink = new AuthService(linkDir)
    const cfgSvc = new ConfigService(dataDir)

    const { token } = await authA.setup('strong-password-123')

    const realReadFile = fsp.readFile.bind(fsp)
    let configReadCount = 0
    const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]).endsWith('config.json')) configReadCount += 1
      return realReadFile(...args)
    })

    try {
      // first time cold read: read 1 time
      assert.equal(await authA.verifyToken(token), true)
      assert.equal(configReadCount, 1)

      // steady state many time verifyToken + status + across instance + symlink instance: all hit cache,0 time readFile
      for (let i = 0; i < 20; i++) {
        assert.equal(await authA.verifyToken(token), true)
        assert.equal(await authB.verifyToken(token), true)
        assert.equal(await authLink.verifyToken(token), true)
        assert.equal(await authB.verifyToken('invalid-token'), false)
        assert.deepEqual(await authLink.status(), { configured: true })
      }
      assert.equal(configReadCount, 1, 'steady state under any AuthService instance all must not duplicate read')

      // other module via ConfigService modify config.json after, automatically expires and trigger heavy read once
      await cfgSvc.update({ pluginEnabled: { magpie: true } })
      const readsBeforePostUpdate = configReadCount
      assert.equal(await authB.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)
      assert.equal(await authLink.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)

      // login sign new token after, across instance immediately identify
      const { token: token2 } = await authA.login('strong-password-123')
      assert.equal(await authLink.verifyToken(token2), true)
      assert.equal(await authB.verifyToken(token), true)

      // external directly change delete auth after via invalidateCache expires (simulated AssetReloader trigger)
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
      assert.equal(await authB.verifyToken(token), false)
      assert.equal(await authLink.verifyToken(token2), false)

      // corrupt auth field explicit throws and do not by cache; fix after restore normal
      await fsp.writeFile(join(dataDir, 'config.json'), JSON.stringify({ auth: 'corrupt' }), 'utf8')
      await cfgSvc.invalidateCache()
      await assert.rejects(() => authA.verifyToken(token), /structure illegal/)
      await assert.rejects(() => authB.status(), /structure illegal/)
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
    } finally {
      readStub.mock.restore()
    }
  })
})

test('AuthService cold read and concurrency setup hand over wrong (guard against ABA dirty back fill): cache never keep old not config state', { timeout: 60_000 }, async (t) => {
  await withTempDir('helm-auth-aba-', async (dir) => {
    const auth = new AuthService(dir)
    const realReadFile = fsp.readFile.bind(fsp)
    let injectedSetup = false
    let setupPromise: Promise<{ token: string }> | undefined

    const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]).endsWith('config.json') && !injectedSetup) {
        injectedSetup = true
        // in first time cold read window during let setup queue wait for file lock, verify lock release and generation validate coordinate same
        setupPromise = auth.setup('aba-race-password-123')
      }
      return realReadFile(...args)
    })

    try {
      const [statusBefore] = await Promise.all([auth.status()])
      assert.equal(statusBefore.configured, false)
      assert.ok(setupPromise !== undefined)
      const { token } = await setupPromise
      assert.deepEqual(await auth.status(), { configured: true })
      assert.equal(await auth.verifyToken(token), true)
    } finally {
      readStub.mock.restore()
    }
  })
})

test('Windows handle conflict simulated under high frequency verifyToken/status and setEnabled concurrency hand over wrong zero failed', { timeout: 60_000 }, async (t) => {
  const restore = fakePlatform('win32')
  const realReadFile = fsp.readFile.bind(fsp)
  const realRename = fsp.rename.bind(fsp)
  let activeConfigReaders = 0

  const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    const isConfig = String(args[0]).endsWith('config.json')
    if (isConfig) activeConfigReaders += 1
    try {
      if (isConfig) await new Promise((r) => setTimeout(r, 2))
      return await realReadFile(...args)
    } finally {
      if (isConfig) activeConfigReaders -= 1
    }
  })
  const renameStub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    // if also store in any config.json read handle (simulated external read way occupy), by Windows real behavior throw EPERM
    if (String(args[1]).endsWith('config.json') && activeConfigReaders > 0) {
      throw errnoError('EPERM', 'EPERM: operation not permitted (active handle)')
    }
    return realRename(...args)
  })

  try {
    await withTempDir('helm-concurrent-win-', async (dir) => {
      const auth = new AuthService(dir)
      const { token } = await auth.setup('win-concurrent-pw-123')
      const cfg = new ConfigService(dir)
      const cred = new CredentialService(dir)
      const store = new HelmPluginConfigStore({ config: cfg, credentials: cred })
      await store.load()

      const toggles = Array.from({ length: 15 }, (_, i) =>
        store.setEnabled('builtin:magpie', i % 2 === 0),
      )
      const verifications = Array.from({ length: 80 }, () =>
        Promise.all([auth.verifyToken(token), auth.status()]),
      )

      const [, verifyResults] = await Promise.all([
        Promise.all(toggles),
        Promise.all(verifications),
      ])

      for (const [ok, st] of verifyResults) {
        assert.equal(ok, true)
        assert.equal(st.configured, true)
      }
      assert.equal(store.getEnabled('builtin:magpie'), true)
      const persisted = JSON.parse(await realReadFile(join(dir, 'config.json'), 'utf8')) as {
        pluginEnabled?: Record<string, boolean>
      }
      assert.equal(persisted.pluginEnabled?.['builtin:magpie'], true)
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    renameStub.mock.restore()
    readStub.mock.restore()
    restore()
  }
})

test('HTTP E2E re- now:Windows conflict simulated under concurrency GET /api/plugins + GET /api/auth/status and plugin start stop zero 500', { timeout: 60_000 }, async (t) => {
  const restore = fakePlatform('win32')
  const realReadFile = fsp.readFile.bind(fsp)
  const realRename = fsp.rename.bind(fsp)
  let activeConfigReaders = 0
  let configReadCount = 0

  const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    const isConfig = String(args[0]).endsWith('config.json')
    if (isConfig) {
      activeConfigReaders += 1
      configReadCount += 1
    }
    try {
      if (isConfig) await new Promise((r) => setTimeout(r, 2))
      return await realReadFile(...args)
    } finally {
      if (isConfig) activeConfigReaders -= 1
    }
  })
  const renameStub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    if (String(args[1]).endsWith('config.json') && activeConfigReaders > 0) {
      throw errnoError('EPERM', 'EPERM: operation not permitted (active handle)')
    }
    return realRename(...args)
  })

  try {
    await withTempDir('helm-http-win-toggle-', async (dir) => {
      const auth = new AuthService(dir)
      const { token } = await auth.setup('http-e2e-password-123')
      const cfg = new ConfigService(dir)
      const cred = new CredentialService(dir)
      const configStore = new HelmPluginConfigStore({ config: cfg, credentials: cred })
      await configStore.load()

      const fixture = createPluginHostBackendFixture()
      fixture.emitEvent = () => {}
      const host = new PluginHost({
        dataDir: dir,
        host: fixture,
        docs: new MemoryDocStore(),
        config: configStore,
        buildProvider: createPluginBuildProvider(),
      })
      try {
        await host.register({
          id: 'builtin:magpie',
          name: 'magpie',
          version: '0.1.0',
          definePlugin: () => {},
        }, { enabled: false })
        await host.start()

        const events: EventHub = { response: () => new Response(null, { status: 204 }) }
        const kernel = {
          dataDir: dir,
          auth,
          events,
          plugins: host,
        } as unknown as KernelRuntimeLike
        const handler = createHubHandler(kernel)

        const authHeaders = { authorization: `Bearer ${token}` }
        const callHttp = (method: string, path: string): Promise<Response> =>
          handler(new Request(`http://127.0.0.1:3202${path}`, { method, headers: authHeaders }))

        const readsBeforeBurst = configReadCount
        // concurrency hit high authentication read and order start stop plugin (re- now original report 3/3 500 scenario)
        const readBurst = Promise.all(
          Array.from({ length: 60 }, (_, i) =>
            callHttp('GET', i % 2 === 0 ? '/api/plugins' : '/api/auth/status'),
          ),
        )
        const toggleLoop = (async () => {
          const statuses: number[] = []
          for (let i = 0; i < 6; i++) {
            const res = await callHttp(
              'POST',
              i % 2 === 0 ? '/api/plugins/builtin:magpie/enable' : '/api/plugins/builtin:magpie/disable',
            )
            statuses.push(res.status)
          }
          // eventually in enabled=true
          const finalEnable = await callHttp('POST', '/api/plugins/builtin:magpie/enable')
          statuses.push(finalEnable.status)
          return statuses
        })()

        const [readResponses, toggleStatuses] = await Promise.all([readBurst, toggleLoop])
        for (const res of readResponses) {
          assert.equal(res.status, 200, `concurrency read should all 200, actual ${res.status}`)
        }
        assert.deepEqual(
          toggleStatuses,
          [200, 200, 200, 200, 200, 200, 200],
          'all start stop persist should all 200 succeeded',
        )
        const persisted = JSON.parse(await realReadFile(join(dir, 'config.json'), 'utf8')) as {
          pluginEnabled?: Record<string, boolean>
        }
        assert.equal(persisted.pluginEnabled?.['builtin:magpie'], true)
        // verify AuthService cache notable reduce read time count (60 time concurrency read + 7 time switch far fewer than 67+ time)
        assert.ok(configReadCount - readsBeforeBurst < 25, `read time count should large width drop low, actual ${configReadCount - readsBeforeBurst}`)
        await assertNoTmpLeftovers(dir)
      } finally {
        await host.dispose().catch(() => {})
      }
    })
  } finally {
    renameStub.mock.restore()
    readStub.mock.restore()
    restore()
  }
})
