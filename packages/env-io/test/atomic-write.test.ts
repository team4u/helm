import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
} from '../src/index.js'

const isPosix = process.platform !== 'win32'

function makeTempDir(): string {
  return fs.mkdtempSync(join(tmpdir(), 'helm-env-io-atomic-'))
}

function errnoError(code: string, message = `simulated system error (${code})`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -4048, syscall: 'rename' })
}

async function assertNoTmpLeftovers(dir: string): Promise<void> {
  const tmps = (await fsp.readdir(dir)).filter((name) => name.includes('.tmp'))
  assert.deepEqual(tmps, [], `must not leave temporary files behind: ${tmps.join(', ')}`)
}

describe('env-io atomic-write: unified atomic write primitives (fsync + 0600 + bounded rename retry)', () => {
  it('atomicWriteFile writes content, defaults to 0600, creates missing directories, and leaves no tmp files', { timeout: 60_000 }, async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, 'deep', 'nested', 'target.txt')
      await atomicWriteFile(target, 'hello 世界')
      assert.equal(await fsp.readFile(target, 'utf8'), 'hello 世界')
      if (isPosix) {
        const mode = (await fsp.stat(target)).mode & 0o777
        assert.equal(mode, 0o600, `default mode must be 0600, got ${mode.toString(8)}`)
      }
      // Overwrite in place: the rename flip replaces the previous content atomically.
      await atomicWriteFile(target, 'second')
      assert.equal(await fsp.readFile(target, 'utf8'), 'second')
      await assertNoTmpLeftovers(join(dir, 'deep', 'nested'))
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFile honors an explicit mode override', { timeout: 60_000 }, async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, 'shared.txt')
      await atomicWriteFile(target, 'shared', { mode: 0o644 })
      assert.equal(await fsp.readFile(target, 'utf8'), 'shared')
      if (isPosix) {
        assert.equal((await fsp.stat(target)).mode & 0o777, 0o644)
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteJson persists deterministic 2-space JSON with a trailing newline', { timeout: 60_000 }, async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, 'record.json')
      await atomicWriteJson(target, { b: 1, a: 'x' })
      assert.equal(await fsp.readFile(target, 'utf8'), '{\n  "b": 1,\n  "a": "x"\n}\n')
      await assertNoTmpLeftovers(dir)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFileSync (compiler hot path) handles strings and binaries with 0600 default and no tmp leftovers', { timeout: 60_000 }, async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, 'artifact.mjs')
      atomicWriteFileSync(target, 'export const x = 1;\n')
      assert.equal(await fsp.readFile(target, 'utf8'), 'export const x = 1;\n')
      if (isPosix) {
        assert.equal((await fsp.stat(target)).mode & 0o777, 0o600)
      }
      const bin = join(dir, 'artifact.mjs.gz')
      atomicWriteFileSync(bin, new Uint8Array([1, 2, 3, 0xff]))
      assert.deepEqual(new Uint8Array(await fsp.readFile(bin)), new Uint8Array([1, 2, 3, 0xff]))
      atomicWriteFileSync(target, 'replaced')
      assert.equal(await fsp.readFile(target, 'utf8'), 'replaced')
      await assertNoTmpLeftovers(dir)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFile retries transient EPERM/EACCES/EBUSY rename locks and commits cleanly', { timeout: 60_000 }, async (t) => {
    const realRename = fsp.rename.bind(fsp)
    let attempts = 0
    const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
      attempts += 1
      if (attempts === 1) throw errnoError('EPERM')
      if (attempts === 2) throw errnoError('EACCES')
      if (attempts === 3) throw errnoError('EBUSY')
      return realRename(...args)
    })
    const dir = makeTempDir()
    try {
      const target = join(dir, 'config.json')
      await fsp.writeFile(target, '{"old":true}\n', 'utf8')
      await atomicWriteFile(target, '{"new":true}\n')
      assert.equal(await fsp.readFile(target, 'utf8'), '{"new":true}\n')
      assert.equal(stub.mock.callCount(), 4)
      await assertNoTmpLeftovers(dir)
    } finally {
      stub.mock.restore()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFile bounded exhaustion on persistent EPERM: preserves code, attaches diagnostics, cleans tmp, keeps old value intact', { timeout: 60_000 }, async (t) => {
    const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
      void args
      throw errnoError('EPERM', 'EPERM: operation not permitted, rename')
    })
    const dir = makeTempDir()
    const startedAt = Date.now()
    try {
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
      assert.ok(stub.mock.callCount() >= 20, `should keep retrying until the budget is exhausted, actual ${stub.mock.callCount()} calls`)
      assert.equal(await fsp.readFile(target, 'utf8'), '{"stable":true}\n')
      await assertNoTmpLeftovers(dir)
    } finally {
      stub.mock.restore()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFile fails immediately on non-retryable rename errors without retries', { timeout: 60_000 }, async (t) => {
    const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
      void args
      throw errnoError('EXDEV', 'cross-device link not permitted')
    })
    const dir = makeTempDir()
    try {
      const target = join(dir, 'config.json')
      await assert.rejects(
        atomicWriteFile(target, 'abc'),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === 'EXDEV' &&
          !err.message.includes('still failed after'),
      )
      assert.equal(stub.mock.callCount(), 1)
      await assertNoTmpLeftovers(dir)
    } finally {
      stub.mock.restore()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFileSync retries transient EBUSY via synchronous Atomics.wait backoff and still commits', { timeout: 60_000 }, async (t) => {
    const realRenameSync = fs.renameSync.bind(fs)
    let attempts = 0
    const stub = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      attempts += 1
      if (attempts === 1) throw errnoError('EBUSY')
      return realRenameSync(...args)
    })
    const dir = makeTempDir()
    try {
      const target = join(dir, 'bundle.mjs')
      atomicWriteFileSync(target, 'sync-hot-path')
      assert.equal(await fsp.readFile(target, 'utf8'), 'sync-hot-path')
      assert.equal(stub.mock.callCount(), 2)
      await assertNoTmpLeftovers(dir)
    } finally {
      stub.mock.restore()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('atomicWriteFileSync propagates the original error and cleans the temp file on non-retryable failure', { timeout: 60_000 }, async (t) => {
    const boom = errnoError('EIO', 'simulated disk I/O error')
    const stub = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      void args
      throw boom
    })
    const dir = makeTempDir()
    try {
      const target = join(dir, 'bundle.mjs')
      assert.throws(() => atomicWriteFileSync(target, 'payload'), (err: unknown) => err === boom)
      assert.equal(stub.mock.callCount(), 1)
      assert.equal(fs.existsSync(target), false, 'failed write must not leave a target behind')
      await assertNoTmpLeftovers(dir)
    } finally {
      stub.mock.restore()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
