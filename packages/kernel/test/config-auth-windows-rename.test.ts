/**
 * Windows config.json rename EPERM 防护与 AuthService 零读盘缓存回归：
 * 1. atomicWriteFile / copyFilePrivate 在 Windows 瞬时 EPERM/EACCES/EBUSY 下有界退避重试；
 *    耗尽时保留原始 errno code、补充重试次数诊断、清理 tmp 且保留旧目标文件；非 Windows 立即失败。
 * 2. ConfigService.get 与 updateBy 共享进程内文件锁且无重入死锁（同进程读写互斥，不撞 rename）。
 * 3. AuthService 按规范路径共享进程内缓存与 singleflight：稳态 verifyToken/status 零 readFile、
 *    跨实例与软链同步失效、外部改盘 invalidateCache 生效、损坏不缓存、并发读不回填旧快照。
 * 4. 并发模拟：Windows 句柄冲突语义下高频 verifyToken/status 与 setEnabled 交错落盘零失败。
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

function errnoError(code: string, message = `模拟系统错误 (${code})`): NodeJS.ErrnoException {
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
  assert.deepEqual(tmps, [], `不应残留临时文件: ${tmps.join(', ')}`)
}

test('Windows atomicWriteJson 遇瞬时 EPERM/EACCES/EBUSY 退避后成功提交，无 tmp 残留', { timeout: 60_000 }, async (t) => {
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

test('Windows atomicWriteFile 与 copyFilePrivate 持续 EPERM 有界耗尽：保留 code、附重试诊断、清 tmp、旧值完好', { timeout: 60_000 }, async (t) => {
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
          err.message.includes('Windows 目标文件瞬时占用') &&
          err.message.includes('已重试'),
      )
      const waited = Date.now() - startedAt
      assert.ok(waited >= 1_400, `应有界退避约 1.5s 再失败，实际 ${waited}ms`)
      assert.ok(waited < 10_000, `退避时间必须有界收敛，实际 ${waited}ms`)
      assert.ok(stub.mock.callCount() >= 20, `应持续重试直至耗尽，实际 ${stub.mock.callCount()} 次`)
      assert.equal(await fsp.readFile(target, 'utf8'), '{"stable":true}\n')
      await assertNoTmpLeftovers(dir)

      // copyFilePrivate 同样走有界重试并清理 tmp
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
          err.message.includes('Windows 目标文件瞬时占用'),
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

test('非 Windows 平台遇到 EPERM 立即失败不做退避重试', { timeout: 60_000 }, async (t) => {
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
          !err.message.includes('Windows 目标文件瞬时占用'),
      )
      assert.equal(stub.mock.callCount(), 1)
      await assertNoTmpLeftovers(dir)
    })
  } finally {
    stub.mock.restore()
    restore()
  }
})

test('ConfigService.get 与 updateBy 共享文件锁：无重入死锁，且同进程读写严格互斥不撞 rename', { timeout: 60_000 }, async (t) => {
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
      // 确定性等到写入进入 rename 窗口后再发起并发读，验证读必须排队到写完成
      await renameEntered
      const readPromise = cfgOther.get()
      const [written, readAfter] = await Promise.all([writePromise, readPromise])
      assert.equal(written['step'], 1)
      assert.equal(readAfter['step'], 1, '同进程读应排队到写完成后读到最新值')
      assert.equal(overlapDetected, false, '同进程内 readFile 与 rename 绝不可并发重叠')
    })
  } finally {
    readStub.mock.restore()
    renameStub.mock.restore()
  }
})

test('AuthService 进程内快照：稳态零 readFile、跨实例与软链同步、invalidateCache 生效、损坏不缓存', { timeout: 60_000 }, async (t) => {
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
      // 首次冷读：读盘 1 次
      assert.equal(await authA.verifyToken(token), true)
      assert.equal(configReadCount, 1)

      // 稳态多次 verifyToken + status + 跨实例 + 软链实例：全部命中缓存，0 次 readFile
      for (let i = 0; i < 20; i++) {
        assert.equal(await authA.verifyToken(token), true)
        assert.equal(await authB.verifyToken(token), true)
        assert.equal(await authLink.verifyToken(token), true)
        assert.equal(await authB.verifyToken('invalid-token'), false)
        assert.deepEqual(await authLink.status(), { configured: true })
      }
      assert.equal(configReadCount, 1, '稳态下任何 AuthService 实例都不应重复读盘')

      // 其他模块经 ConfigService 修改 config.json 后，自动失效并触发重读一次
      await cfgSvc.update({ pluginEnabled: { magpie: true } })
      const readsBeforePostUpdate = configReadCount
      assert.equal(await authB.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)
      assert.equal(await authLink.verifyToken(token), true)
      assert.equal(configReadCount, readsBeforePostUpdate + 1)

      // login 签发新 token 后，跨实例立即识别
      const { token: token2 } = await authA.login('strong-password-123')
      assert.equal(await authLink.verifyToken(token2), true)
      assert.equal(await authB.verifyToken(token), true)

      // 外部直接改盘删掉 auth 后经 invalidateCache 失效（模拟 AssetReloader 触发）
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
      assert.equal(await authB.verifyToken(token), false)
      assert.equal(await authLink.verifyToken(token2), false)

      // 损坏的 auth 字段显式抛错且不被缓存；修复后恢复正常
      await fsp.writeFile(join(dataDir, 'config.json'), JSON.stringify({ auth: 'corrupt' }), 'utf8')
      await cfgSvc.invalidateCache()
      await assert.rejects(() => authA.verifyToken(token), /结构非法/)
      await assert.rejects(() => authB.status(), /结构非法/)
      await fsp.writeFile(join(dataDir, 'config.json'), '{}\n', 'utf8')
      await cfgSvc.invalidateCache()
      assert.deepEqual(await authA.status(), { configured: false })
    } finally {
      readStub.mock.restore()
    }
  })
})

test('AuthService 冷读与并发 setup 交错（防 ABA 脏回填）：缓存绝不保留旧未配置态', { timeout: 60_000 }, async (t) => {
  await withTempDir('helm-auth-aba-', async (dir) => {
    const auth = new AuthService(dir)
    const realReadFile = fsp.readFile.bind(fsp)
    let injectedSetup = false
    let setupPromise: Promise<{ token: string }> | undefined

    const readStub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]).endsWith('config.json') && !injectedSetup) {
        injectedSetup = true
        // 在首次冷读窗口期间让 setup 入队等待文件锁，验证锁释放与 generation 校验协同
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

test('Windows 句柄冲突模拟下高频 verifyToken/status 与 setEnabled 并发交错零失败', { timeout: 60_000 }, async (t) => {
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
    // 若同时存在任意 config.json 读取句柄（模拟外部读取方占用），按 Windows 真实行为抛 EPERM
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

test('HTTP E2E 复现：Windows 冲突模拟下并发 GET /api/plugins + GET /api/auth/status 与插件启停零 500', { timeout: 60_000 }, async (t) => {
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
        // 并发打高密度鉴权读取与顺序启停插件（复现原报告 3/3 500 场景）
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
          // 最终留在 enabled=true
          const finalEnable = await callHttp('POST', '/api/plugins/builtin:magpie/enable')
          statuses.push(finalEnable.status)
          return statuses
        })()

        const [readResponses, toggleStatuses] = await Promise.all([readBurst, toggleLoop])
        for (const res of readResponses) {
          assert.equal(res.status, 200, `并发读应全部 200，实际 ${res.status}`)
        }
        assert.deepEqual(
          toggleStatuses,
          [200, 200, 200, 200, 200, 200, 200],
          '全部启停持久化应全部 200 成功',
        )
        const persisted = JSON.parse(await realReadFile(join(dir, 'config.json'), 'utf8')) as {
          pluginEnabled?: Record<string, boolean>
        }
        assert.equal(persisted.pluginEnabled?.['builtin:magpie'], true)
        // 验证 AuthService 缓存显著减少读盘次数（60 次并发读取 + 7 次切换远少于 67+ 次）
        assert.ok(configReadCount - readsBeforeBurst < 25, `读盘次数应大幅降低，实际 ${configReadCount - readsBeforeBurst}`)
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
