/**
 * Regression tests for transient Windows rename contention: while AV/indexer scans `cli-token`,
 * `fs.rename` fails briefly with EPERM/EACCES/EBUSY (observed on CI round 3 of concurrent logins).
 * Verifies: transient failures back off and succeed; persistent failures exhaust bounded backoff,
 * preserve the previous credentials, clean up temp files, and throw `credentials_write_failed`
 * (never delete the target or drop atomicity).
 * Mock boundary: `t.mock.method` injects errno per call (same style as credentials lock tests);
 * `process.platform` is temporarily overridden via `Object.defineProperty` and restored in finally.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'
import { useTempDir } from './helpers/cli-harness.js'

/** Construct an ErrnoException (simulating OS failure when a Windows reader holds the target file). */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated Windows transient contention (${code})`), { code })
}

/** Override process.platform to win32 to exercise the Windows backoff branch; returns a restore callback. */
function fakeWin32Platform(): () => void {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: real, configurable: true })
}

/** After writing completes, dataDir must not retain any .tmp or .lock leftovers. */
async function assertNoWriteLeftovers(dir: string): Promise<void> {
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp') || f.includes('.lock'))
  assert.deepEqual(leftovers, [])
}

test('Windows rename transient contention (alternating EPERM/EACCES) backs off and succeeds without leaving tmp files', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-rename-retry-')
  const restorePlatform = fakeWin32Platform()
  const rename = fsp.rename.bind(fsp)
  let occupied = 0
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    // First two attempts hit transient reader locks (distinct errno codes); third attempt succeeds
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
    assert.equal(stub.mock.callCount(), 3, 'transient contention should back off and succeed on third attempt')
    await assertNoWriteLeftovers(dir)
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})

test('Windows rename persistent EPERM: bounded backoff exhausts, throws credentials_write_failed, preserves old value, cleans tmp', { timeout: 60_000 }, async (t) => {
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
    // Atomicity: target remains untouched (old login intact), failed tmp cleaned up, lock released
    assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), original)
    await assertNoWriteLeftovers(dir)
    // Bounded backoff: gives up after ~1.5s (neither fails immediately nor hangs indefinitely)
    const waited = Date.now() - startedAt
    assert.ok(waited >= 1_400, `expected ~1.5s backoff before failing, waited ${waited}ms`)
    assert.ok(waited < 10_000, `backoff must converge within seconds, waited ${waited}ms`)
    assert.ok(stub.mock.callCount() >= 20, `expected continuous retries until exhausted, got ${stub.mock.callCount()}`)
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})
