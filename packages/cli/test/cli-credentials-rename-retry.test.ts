/**
 * Windows rename instantaneous occupy regression: kill toxic/index scan read cli-token during,fs.rename atomic replace
 * target will short temporary EPERM/EACCES/EBUSY(CI real log: concurrency login 3 round rename report EPERM).
 * verify: short temporary failed after backoff retry succeeded commit; continuous on failure backoff has boundary exhausted, old credentials original keep,tmp clean up,
 * still throw credentials_write_failed(do not delete old target, do not change non- atomic write).
 * simulated boundary:t.mock.method by time inject errno(and credentials lock permission test the same style); platform window use
 * Object.defineProperty override process.platform(Node guarantee the property configurable),finally restore.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'
import { useTempDir } from './helpers/cli-harness.js'

/** construct carries errno code error (simulated Windows target by read way occupy when OS return failed). */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated Windows instantaneous occupy (${code})`), { code })
}

/** override process.platform is win32(trigger produce code Windows backoff branch), return restore function. */
function fakeWin32Platform(): () => void {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: real, configurable: true })
}

/** write after completion dataDir must not leftover any tmp / lock artifact (credentials directory only eventually file). */
async function assertNoWriteLeftovers(dir: string): Promise<void> {
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp') || f.includes('.lock'))
  assert.deepEqual(leftovers, [])
}

test('Windows rename instantaneous occupy (EPERM/EACCES hand over replace) after backoff succeeded: commit new value, without tmp leftover', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-rename-retry-')
  const restorePlatform = fakeWin32Platform()
  const rename = fsp.rename.bind(fsp)
  let occupied = 0
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    // before two time replace target by read way short temporary occupy (different code simulated different occupy source), third time let route after succeeded
    if (occupied < 2) {
      occupied += 1
      throw errnoError(occupied === 1 ? 'EPERM' : 'EACCES')
    }
    return rename(...args)
  })
  try {
    await fsp.writeFile(
      path.join(dir, 'cli-token'),
      JSON.stringify({ hubUrl: 'http://127.0.0.1:1', token: 'tok-old' }),
      { mode: 0o600 },
    )
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' })
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, string>
    assert.deepEqual(saved, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' })
    assert.equal(stub.mock.callCount(), 3, 'instantaneous occupy should backoff retry to third time commit succeeded')
    await assertNoWriteLeftovers(dir)
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})

test('Windows rename continuous EPERM: backoff has boundary exhausted after still throw credentials_write_failed, old value keep,tmp clean up', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-rename-busy-')
  const restorePlatform = fakeWin32Platform()
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM')
  })
  const startedAt = Date.now()
  try {
    const original = `${JSON.stringify({ hubUrl: 'http://127.0.0.1:1', token: 'tok-old' }, null, 2)}\n`
    await fsp.writeFile(path.join(dir, 'cli-token'), original, { mode: 0o600 })
    await assert.rejects(
      updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' }),
      (error: unknown) => error instanceof CliError && error.code === 'credentials_write_failed',
    )
    // atomicity: target from not by trigger touch (old login state completely well), failed tmp already clean up, lock already release
    assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), original)
    await assertNoWriteLeftovers(dir)
    // has boundary backoff: about 1.5 second amount level exhausted after abandon (do not immediately abandon, also do not without boundary suspended)
    const waited = Date.now() - startedAt
    assert.ok(waited >= 1_400, `should backoff about 1.5s again failed, actual ${waited}ms`)
    assert.ok(waited < 10_000, `backoff must converge in second level, actual ${waited}ms`)
    assert.ok(stub.mock.callCount() >= 20, `should continuous retry direct until exhausted, actual ${stub.mock.callCount()} time`)
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})
