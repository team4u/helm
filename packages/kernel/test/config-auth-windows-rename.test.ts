/**
 * Windows config.json rename EPERM protection and AuthService zero-read cache regression tests:
 * 1. atomicWriteFile / copyFilePrivate (delegating to the shared `@helmx/env-io` primitive) perform bounded
 *    backoff retries on transient EPERM/EACCES/EBUSY on every platform (merged unified semantics); when
 *    exhausted, they preserve the original errno code, attach retry count diagnostics, clean tmp files,
 *    and keep the old target intact; non-retryable codes fail immediately without retries.
 * 2. ConfigService.get and update share the in-process file lock without deadlocking (read/write mutual exclusion within the same process prevents rename collisions).
 * 3. AuthService shares an in-process cache and singleflight per canonical path: steady-state verifyToken/status do zero readFile calls,
 *    cross-instance and symlink caches sync invalidation, external edits take effect via invalidateCache, corrupt auth is not cached, and concurrent reads never backfill stale snapshots.
 * 4. Concurrency simulation: under simulated Windows handle contention, high-frequency verifyToken/status interleaved with setEnabled achieves zero failures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginBuildProvider } from '@helmx/plugin-build'
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
import { HelmxPluginConfigStore } from '../src/runtime/plugin-config-store.js'
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
  assert.deepEqual(tmps, [], `must not leave temporary files behind: ${tmps.join(', ')}`)
}

test('atomicWriteJson backs off on transient EPERM/EACCES/EBUSY and commits cleanly without tmp leftovers', { timeout: 60_000 }, async (t) => {
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
    await withTempDir('helmx-atomic-retry-', async (dir) => {
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
  }
})

test('atomicWriteFile and copyFilePrivate bounded exhaustion on persistent EPERM: preserve code, attach retry diagnostics, clean tmp, keep old value intact', { timeout: 60_000 }, async (t) => {
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM', 'EPERM: operation not permitted, rename')
  })
  const startedAt = Date.now()
  try {
    await withTempDir('helmx-atomic-exhaust-', async (dir) => {
      const target = join(dir, 'config.json')
      await fsp.writeFile(target, '{"stable":true}\n', 'utf8')
      await assert.rejects(
        atomicWriteFile(target, '{"stable":false}\n'),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EPERM' &&
          err.message.includes('rename target transiently locked') &&
          err.message.includes('still failed after'),
      )
      const waited = Date.now() - startedAt
      assert.ok(waited >= 1_400, `should perform bounded backoff around 1.5s before failing, actual ${waited}ms`)
      assert.ok(waited < 10_000, `backoff must be bounded and converge quickly, actual ${waited}ms`)
      assert.ok(stub.mock.callCount() >= 20, `should continue retrying until budget exhausted, actual ${stub.mock.callCount()} calls`)
      assert.equal(await fsp.readFile(target, 'utf8'), '{"stable":true}\n')
      await assertNoTmpLeftovers(dir)

      // copyFilePrivate similarly performs bounded retries and cleans tmp leftovers
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
          err.message.includes('rename target transiently locked'),
      )
      assert.ok(stub.mock.callCount() - callsBeforeCopy >= 20)
      assert.equal(await fsp.readFile(dest, 'utf8'), 'old-content')
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
  }
})

test('POSIX persistent EPERM (unified all-platform retry) still fails honestly after bounded backoff: code preserved, diagnostics attached, tmp cleaned, no target fabricated', { timeout: 60_000 }, async (t) => {
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM', 'EPERM: operation not permitted')
  })
  const startedAt = Date.now()
  try {
    await withTempDir('helmx-atomic-posix-', async (dir) => {
      const target = join(dir, 'config.json')
      await assert.rejects(
        atomicWriteFile(target, 'abc'),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EPERM' &&
          err.message.includes('rename target transiently locked') &&
          err.message.includes('still failed after'),
      )
      const waited = Date.now() - startedAt
      assert.ok(waited >= 1_400, `unified semantics retry transient codes on POSIX too, bounded around 1.5s, actual ${waited}ms`)
      assert.ok(waited < 10_000, `backoff must be bounded and converge quickly, actual ${waited}ms`)
      assert.ok(stub.mock.callCount() >= 20, `should keep retrying until the budget is exhausted, actual ${stub.mock.callCount()} calls`)
      assert.equal(await fsp.readFile(target, 'utf8').then(() => 'exists', () => 'missing'), 'missing', 'failed write must not fabricate a target')
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
  }
})

test('ConfigService.get and update share file lock without re-entrant deadlock, and in-process read/write strictly exclude rename collisions', { timeout: 60_000 }, async (t) => {
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
    await withTempDir('helmx-config-rw-lock-', async (dir) => {
      const cfg = new ConfigService(dir)
      const cfgOther = new ConfigService(dir)
      const writePromise = cfg.update({ step: 1 })
      // Deterministically wait until the write enters its rename window before launching a concurrent read,
      // verifying the read queues until the write completes.
      await renameEntered
      const readPromise = cfgOther.get()
      const [written, readAfter] = await Promise.all([writePromise, readPromise])
      assert.equal(written['step'], 1)
      assert.equal(readAfter['step'], 1, 'in-process read should queue behind write completion and observe latest value')
      assert.equal(overlapDetected, false, 'in-process readFile and rename must never overlap concurrently')
    })
  } finally {
    readStub.mock.restore()
    renameStub.mock.restore()
  }
})

test('AuthService in-process snapshot: steady-state zero readFile, cross-instance & symlink sync, invalidateCache works, corrupt not cached', { timeout: 60_000 }, async (t) => {
  await withTempDir('helmx-auth-cache-', async (root) => {
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
      // Initial cold read: reads once
      assert.equal(await authA.verifyToken(token), true)
      assert.equal(configReadCount, 1)

      // Steady state: repeated verifyToken + status + cross-instance + symlink instance all hit cache (0 readFile calls)
      for (let i = 0; i < 20; i++) {
        assert.equal(await authA.verifyToken(token), true)
        assert.equal(await authB.verifyToken(token), true)
        assert.equal(await authLink.verifyToken(token), true)
        assert.equal(await authB.verifyToken('invalid-token'), false)
        assert.deepEqual(await authLink.status(), { configured: true })
      }
      assert.equal(configReadCount, 1, 'steady state across any AuthService instance must not re-read disk')

      // After another module updates config.json via ConfigService, cache automatically expires and triggers one re-read
      await cfgSvc.update({ pluginEnabled: { magpie: true } })
      const readsBeforePostUpdate = configReadCount
      assert.equal(await authB.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)
      assert.equal(await authLink.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)

      // After login issues a new token, cross-instance sees it immediately
      const { token: token2 } = await authA.login('strong-password-123')
      assert.equal(await authLink.verifyToken(token2), true)
      assert.equal(await authB.verifyToken(token), true)

      // External direct edit removing auth is invalidated via invalidateCache (simulating AssetReloader trigger)
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
      assert.equal(await authB.verifyToken(token), false)
      assert.equal(await authLink.verifyToken(token2), false)

      // Corrupt auth field explicitly throws without being cached; recovers once fixed
      await fsp.writeFile(join(dataDir, 'config.json'), JSON.stringify({ auth: 'corrupt' }), 'utf8')
      await cfgSvc.invalidateCache()
      await assert.rejects(() => authA.verifyToken(token), /invalid auth field structure/)
      await assert.rejects(() => authB.status(), /invalid auth field structure/)
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
    } finally {
      readStub.mock.restore()
    }
  })
})

test('AuthService cold-read vs concurrent setup race (prevent ABA stale backfill): cache never preserves stale unconfigured state', { timeout: 60_000 }, async (t) => {
  await withTempDir('helmx-auth-aba-', async (dir) => {
    const auth = new AuthService(dir)
    const realReadFile = fsp.readFile.bind(fsp)
    let injectedSetup = false
    let setupPromise: Promise<{ token: string }> | undefined

    const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]).endsWith('config.json') && !injectedSetup) {
        injectedSetup = true
        // Wait for the file lock during the cold-read window to verify lock release and generation checks coordinate properly
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

test('Windows handle contention simulation: high-frequency verifyToken/status concurrent with setEnabled yields zero failures', { timeout: 60_000 }, async (t) => {
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
    // If any config.json read handle is still open (simulating external reader handle lock), mimic Windows EPERM
    if (String(args[1]).endsWith('config.json') && activeConfigReaders > 0) {
      throw errnoError('EPERM', 'EPERM: operation not permitted (active handle)')
    }
    return realRename(...args)
  })

  try {
    await withTempDir('helmx-concurrent-win-', async (dir) => {
      const auth = new AuthService(dir)
      const { token } = await auth.setup('win-concurrent-pw-123')
      const cfg = new ConfigService(dir)
      const cred = new CredentialService(dir)
      const store = new HelmxPluginConfigStore({ config: cfg, credentials: cred })
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

test('HTTP E2E reproduction: under Windows handle contention, concurrent GET /api/plugins + GET /api/auth/status and plugin toggles yield zero 500s', { timeout: 60_000 }, async (t) => {
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
    await withTempDir('helmx-http-win-toggle-', async (dir) => {
      const auth = new AuthService(dir)
      const { token } = await auth.setup('http-e2e-password-123')
      const cfg = new ConfigService(dir)
      const cred = new CredentialService(dir)
      const configStore = new HelmxPluginConfigStore({ config: cfg, credentials: cred })
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
        // Concurrently burst authenticated reads alongside sequential plugin toggles (reproducing original 3/3 500 report)
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
          // End in enabled=true
          const finalEnable = await callHttp('POST', '/api/plugins/builtin:magpie/enable')
          statuses.push(finalEnable.status)
          return statuses
        })()

        const [readResponses, toggleStatuses] = await Promise.all([readBurst, toggleLoop])
        for (const res of readResponses) {
          assert.equal(res.status, 200, `concurrent read must return 200, got ${res.status}`)
        }
        assert.deepEqual(
          toggleStatuses,
          [200, 200, 200, 200, 200, 200, 200],
          'all toggle persistence calls must succeed with 200',
        )
        const persisted = JSON.parse(await realReadFile(join(dir, 'config.json'), 'utf8')) as {
          pluginEnabled?: Record<string, boolean>
        }
        assert.equal(persisted.pluginEnabled?.['builtin:magpie'], true)
        // Verify AuthService cache drastically reduces disk reads (60 concurrent reads + 7 toggles << 67+ reads)
        assert.ok(configReadCount - readsBeforeBurst < 25, `read count should drop sharply, got ${configReadCount - readsBeforeBurst}`)
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
